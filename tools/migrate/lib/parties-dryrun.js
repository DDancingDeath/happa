/**
 * `parties` (#139 phase 2 proposal): decrypted backup JSON -> the parties the
 * migration would create, possible duplicates to merge (suggestions only) and
 * each party's bills and dues. Pure and offline: never talks to Firebase and
 * writes nothing. See docs/parties-migration-plan.md.
 *
 * partyId = 'p-' + the first 16 hex digits of SHA-256(salt + '\u0000' + PARTY key)
 * (docs/parties-design.md section 8): the side is not part of it, the spelling
 * shown is not part of it, and the same salt gives the same ids on every run.
 */
import { createHash, randomBytes } from 'crypto';
import backupLib from '../../backup/backup-lib.js';
import { buildPlan, carriedDueSets, parseOptions, revive } from './plan.js';
import { partyNameKey, partyNameSpelling, pickPartyName } from '../../../www/js/utils/parties.js';
import { closeParty, editDistance, partyEntries } from '../../../www/js/utils/party-match.js';
import { latinToDevanagari } from '../../../www/js/utils/item-name-autofill.js';
import { buildAging } from '../../../www/js/utils/aging.js';
import { billDateOf } from '../../../www/js/utils/history-filters.js';
import { isActiveBill, round2 } from '../../../www/js/utils/money.js';
import { canonicalDueBill } from '../../../www/js/firebase/repos/bill-due.js';

export const DRYRUN_FORMAT = 'aadhat-parties-dryrun-v1';
export const PARTY_ID_RE = /^p-[0-9a-f]{16}$/;
export const MAX_ALIASES = 20;
export const MAX_NAME = 60;
export const SCOPES = Object.freeze(['due', 'all']);
/** Bill collection -> list name and the side its party serves. */
export const BILL_LISTS = Object.freeze({
    purchases: { list: 'purchase', side: 'supplier' },
    retailSales: { list: 'retail', side: 'customer' },
    wholesaleSales: { list: 'wholesale', side: 'customer' }
});
const DUE_EPSILON = 0.005;
const DEVANAGARI = /[\u0900-\u097F]/;
const HONORIFICS = new Set(['ji', 'bhai', 'bhaiya', 'seth', 'sethji', 'sahab', 'saheb', 'shri', 'sri']);
const HONORIFIC_HI = new Set(['जी', 'भाई', 'भैया', 'सेठ', 'सेठजी', 'साहब', 'साहेब', 'श्री']);

/** A new random salt (32 hex digits). Kept with the private output, never in the repo. */
export function newSalt() {
    return randomBytes(16).toString('hex');
}

/**
 * The stable id of a party.
 * @param {string} salt
 * @param {*} name any spelling; only its PARTY key counts
 * @returns {string} '' for a blank name
 */
export function partyIdOf(salt, name) {
    if (typeof salt !== 'string' || !/^[0-9a-f]{16,}$/.test(salt)) throw new Error('salt must be at least 16 hex digits');
    const key = partyNameKey(name);
    if (!key) return '';
    return `p-${createHash('sha256').update(`${salt}\u0000${key}`, 'utf8').digest('hex').slice(0, 16)}`;
}

/** The salt of an earlier dry run or migration bundle (`--salt-from`). */
export function saltFrom(previous) {
    const salt = previous?.salt ?? previous?.partySalt ?? previous?.parties?.salt;
    if (typeof salt !== 'string' || !/^[0-9a-f]{16,}$/.test(salt)) throw new Error('No party salt in that file');
    return salt;
}

/** Hindi spelling offered for a Latin name (open question 10): spelled word by word, never translated. */
export function hindiSuggestion(name) {
    const text = partyNameSpelling(name);
    if (!text || DEVANAGARI.test(text) || !/[A-Za-z]/.test(text)) return '';
    return clip(text.replace(/[A-Za-z]+/g, w => latinToDevanagari(w.toLowerCase())));
}

const typeOf = (sides) => (sides.has('customer') && sides.has('supplier') ? 'both' : sides.has('supplier') ? 'supplier' : 'customer');
const clip = (s) => s.slice(0, MAX_NAME);

/**
 * Groups the backup's bills into proposed parties (one per PARTY key). Dues are the ones
 * `plan` carries as opening records (plan.js carriedDueSets: the same page rules and options).
 * @param {Object} backup decrypted backup (tools/backup/export-firestore.js)
 * @param {{salt: string, scope?: 'due'|'all', options?: Object}} opts scope due: only names with a
 *   carried due; all: every named bill. options: the `plan` options (mode, carryPayables,
 *   includeHiddenWholesaleDues)
 */
export function proposeParties(backup, { salt, scope = 'due', options = {} } = {}) {
    if (!backup || backup.format !== backupLib.BACKUP_FORMAT) {
        throw new Error(`Not a decrypted backup (format ${backup?.format}); expected ${backupLib.BACKUP_FORMAT}`);
    }
    if (!SCOPES.includes(scope)) throw new Error(`scope must be one of ${SCOPES.join(', ')}`);
    const opts = parseOptions(options);
    const exportedAt = Date.parse(backup.exportedAt);
    const today = Number.isFinite(exportedAt) ? new Date(exportedAt) : new Date(0);
    const groups = new Map();
    const unnamed = { bills: 0, dueBills: 0, dues: { purchase: 0, retail: 0, wholesale: 0 } };
    const records = { purchase: [], retail: [], wholesale: [] };
    const active = { purchase: [], retail: [], wholesale: [] };
    let voided = 0;
    let order = 0;
    const groupOf = (key) => {
        let g = groups.get(key);
        if (!g) {
            g = { key, spellings: new Map(), sides: new Set(), bills: { purchase: 0, retail: 0, wholesale: 0 },
                dueBills: 0, dues: { purchase: 0, retail: 0, wholesale: 0 }, last: 0, phone: '', phoneAt: -Infinity };
            groups.set(key, g);
        }
        return g;
    };

    Object.entries(BILL_LISTS).forEach(([coll, { list, side }]) => {
        (backup.collections?.[coll] || []).forEach(d => {
            const bill = { id: d.id, ...revive(d.data) };
            Object.defineProperty(bill, '__docId', { value: d.id, enumerable: false });
            records[list].push(bill);
            if (!isActiveBill(bill)) { voided++; return; }
            // Read as the old app read it (#126: the app reads payment.due only), as plan's dueSet does
            active[list].push(canonicalDueBill(bill));
            const name = partyNameSpelling(bill.customerName || bill.supplierName);
            const key = partyNameKey(name);
            if (!key) { unnamed.bills++; return; }
            const g = groupOf(key);
            const time = billDateOf(bill)?.getTime();
            const t = Number.isFinite(time) ? time : 0;
            const seen = g.spellings.get(name) || { count: 0, last: 0 };
            g.spellings.set(name, { count: seen.count + 1, last: Math.max(seen.last, t, ++order) });
            g.sides.add(side);
            g.bills[list]++;
            g.last = Math.max(g.last, t);
            const phone = String(bill.customerPhone || bill.phone || bill.mobile || '').trim();
            if (phone && t >= g.phoneAt) { g.phone = phone; g.phoneAt = t; }
        });
    });

    const carried = { purchase: 0, retail: 0, wholesale: 0 };
    let hiddenWholesale = 0;
    carriedDueSets(records, today, opts).forEach(({ billType, hidden, set }) => set.entries.forEach(({ entry, src }) => {
        const due = round2(entry.due);
        carried[billType] = round2(carried[billType] + due);
        if (hidden) hiddenWholesale = round2(hiddenWholesale + due);
        const key = partyNameKey(src?.customerName || src?.supplierName);
        if (!key) {
            unnamed.dueBills++;
            unnamed.dues[billType] = round2(unnamed.dues[billType] + due);
            return;
        }
        const g = groupOf(key);
        g.dueBills++;
        g.dues[billType] = round2(g.dues[billType] + due);
    }));

    const parties = [...groups.values()]
        .filter(g => scope === 'all' || g.dueBills > 0)
        .map(g => {
            const name = clip(pickPartyName(g.spellings));
            const aliases = [...g.spellings.keys()].filter(s => s !== name).map(clip).slice(0, MAX_ALIASES);
            const receivable = round2(g.dues.retail + g.dues.wholesale);
            return {
                partyId: partyIdOf(salt, g.key),
                key: g.key,
                name,
                hindiSuggestion: hindiSuggestion(name),
                type: typeOf(g.sides),
                aliases,
                legacyPhone: g.phone || null,
                bills: { ...g.bills, total: g.bills.purchase + g.bills.retail + g.bills.wholesale },
                dueBills: g.dueBills,
                dues: { ...g.dues, receivable, payable: g.dues.purchase },
                lastBillAt: g.last || null
            };
        })
        .sort((a, b) => b.dues.receivable + b.dues.payable - (a.dues.receivable + a.dues.payable)
            || b.bills.total - a.bills.total || a.key.localeCompare(b.key));

    const outstanding = Object.fromEntries(Object.keys(active).map(l => [l, buildAging(active[l], { today }).total]));
    return { parties, unnamed, voided, outstanding, carried, hiddenWholesale, options: opts, today, allParties: groups.size };
}
/** The words of a name with honorifics in either script left out. */
const plainWords = (name) => partyNameKey(name).split(' ').filter(w => w && !HONORIFICS.has(w) && !HONORIFIC_HI.has(w));
const honorificCount = (name) => partyNameKey(name).split(' ').length - plainWords(name).length;

/**
 * Why two close names may be one party, and how sure: high = the same name in a loose
 * spelling (script, "ji", spacing, doubled letters); medium = 1 letter apart;
 * low = one name starts the other, or 2 letters apart (can be two people).
 */
function closeness(a, b, ea, eb) {
    const reasons = [];
    if (DEVANAGARI.test(a.name) !== DEVANAGARI.test(b.name)) reasons.push('script');
    if (honorificCount(a.name) !== honorificCount(b.name)) reasons.push('honorific');
    if (plainWords(a.name).length !== plainWords(b.name).length) reasons.push('spacing');
    if (ea.core === eb.core) {
        if (!reasons.length) reasons.push('spelling');
        return { confidence: 0.95, level: 'high', reasons };
    }
    const shorter = Math.min(ea.core.length, eb.core.length);
    if (shorter >= 4 && (ea.core.startsWith(eb.core) || eb.core.startsWith(ea.core))) {
        return { confidence: 0.5, level: 'low', reasons: [...reasons.filter(r => r !== 'spacing'), 'prefix'] };
    }
    if (editDistance(ea.core, eb.core, 2) === 1) return { confidence: 0.7, level: 'medium', reasons: [...reasons, 'typo'] };
    return { confidence: 0.4, level: 'low', reasons: [...reasons, 'typo'] };
}

/** Cheap pre-check before the matcher: only cores that could be close at all. */
const mayBeClose = (x, y) => Math.abs(x.length - y.length) <= 2 || x.startsWith(y) || y.startsWith(x);
/**
 * Possible duplicates among the proposed parties, through the billing "Did you mean"
 * matcher (utils/party-match.js closeParty), most likely first. Suggestions only: the
 * proposals are never changed here.
 * @param {Array<Object>} parties proposeParties().parties
 */
export function mergeSuggestions(parties) {
    const entries = partyEntries(parties.map((p, i) => ({ id: i, customerName: p.name })));
    const byKey = new Map(entries.map(e => [e.key, e]));
    const out = [];
    for (let i = 0; i < parties.length; i++) {
        for (let j = i + 1; j < parties.length; j++) {
            const a = parties[i];
            const b = parties[j];
            const ea = byKey.get(partyNameKey(a.name));
            const eb = byKey.get(partyNameKey(b.name));
            if (!ea || !eb || !ea.core || !eb.core || !mayBeClose(ea.core, eb.core)) continue;
            if (!closeParty([eb], a.name) && !closeParty([ea], b.name)) continue;
            const c = closeness(a, b, ea, eb);
            const owed = (p) => p.dues.receivable + p.dues.payable;
            const bFirst = b.bills.total - a.bills.total || owed(b) - owed(a) || (b.partyId < a.partyId ? 1 : -1);
            const [keep, merge] = bFirst > 0 ? [b, a] : [a, b];
            out.push({
                keep: keep.partyId,
                merge: merge.partyId,
                names: [keep.name, merge.name],
                confidence: c.confidence,
                level: c.level,
                reasons: c.reasons,
                sameType: keep.type === merge.type || keep.type === 'both' || merge.type === 'both',
                after: {
                    bills: keep.bills.total + merge.bills.total,
                    receivable: round2(keep.dues.receivable + merge.dues.receivable),
                    payable: round2(keep.dues.payable + merge.dues.payable)
                },
                autoMerge: false
            });
        }
    }
    return out.sort((x, y) => y.confidence - x.confidence || y.after.bills - x.after.bills
        || x.names[0].localeCompare(y.names[0]) || x.names[1].localeCompare(y.names[1]));
}

/**
 * The whole dry run.
 * @param {Object} backup
 * @param {{salt?: string, scope?: 'due'|'all', options?: Object, now?: number}} [opts] options: the `plan` options
 */
export function partiesDryRun(backup, { salt = newSalt(), scope = 'due', options = {}, now = Date.now() } = {}) {
    const { parties, unnamed, voided, outstanding, carried, hiddenWholesale, options: opts, allParties } = proposeParties(backup, { salt, scope, options });
    const suggestions = mergeSuggestions(parties);
    const sum = (f) => round2(parties.reduce((a, p) => a + f(p), 0));
    const dues = { purchase: sum(p => p.dues.purchase), retail: sum(p => p.dues.retail), wholesale: sum(p => p.dues.wholesale) };
    // Independent check: the opening records `plan` itself would write with the same options
    const planDues = buildPlan(backup, opts, { now }).summary;
    const opening = (s) => (s && s.carried ? s.openingTotal || 0 : 0);
    const planTotals = {
        purchase: opening(planDues.dues.purchase),
        retail: opening(planDues.dues.retail),
        wholesale: round2(opening(planDues.dues.wholesale) + opening(planDues.hiddenWholesaleDues))
    };
    const check = Object.fromEntries(Object.keys(outstanding).map(l => {
        const parts = round2(dues[l] + unnamed.dues[l]);
        return [l, {
            parties: dues[l], unnamed: unnamed.dues[l], plan: planTotals[l], matches: Math.abs(parts - planTotals[l]) < DUE_EPSILON,
            outstanding: outstanding[l], notCarried: round2(outstanding[l] - carried[l])
        }];
    }));
    return {
        format: DRYRUN_FORMAT,
        generatedAt: new Date(now).toISOString(),
        source: { exportedAt: backup.exportedAt, project: backup.project || null },
        scope,
        options: { mode: opts.mode, carryPayables: opts.carryPayables, includeHiddenWholesaleDues: opts.includeHiddenWholesaleDues },
        salt,
        idScheme: "'p-' + first 16 hex digits of SHA-256(salt + U+0000 + PARTY key)",
        writes: { parties: parties.length, directory: parties.length ? 1 : 0, bills: 0 },
        totals: {
            parties: parties.length,
            namesInBackup: allParties,
            customers: parties.filter(p => p.type === 'customer').length,
            suppliers: parties.filter(p => p.type === 'supplier').length,
            both: parties.filter(p => p.type === 'both').length,
            withPhone: parties.filter(p => p.legacyPhone).length,
            withAliases: parties.filter(p => p.aliases.length).length,
            bills: parties.reduce((a, p) => a + p.bills.total, 0),
            voidedBillsSkipped: voided,
            suggestions: { high: suggestions.filter(s => s.level === 'high').length, medium: suggestions.filter(s => s.level === 'medium').length, low: suggestions.filter(s => s.level === 'low').length },
            unnamed: { bills: unnamed.bills, dueBills: unnamed.dueBills, due: round2(unnamed.dues.purchase + unnamed.dues.retail + unnamed.dues.wholesale) },
            dues,
            hiddenWholesale,
            check,
            matchesPlan: Object.values(check).every(c => c.matches)
        },
        parties,
        suggestions
    };
}

const csvCell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Private review sheet (names and phones: keep it outside the repo). */
export function toCsv(result) {
    const rows = [['partyId', 'name', 'hindiSuggestion', 'type', 'aliases', 'bills', 'dueBills', 'receivable', 'payable', 'retail', 'wholesale', 'hasPhone', 'possibleDuplicateOf']];
    const dupOf = new Map();
    result.suggestions.forEach(s => {
        [[s.keep, s.merge], [s.merge, s.keep]].forEach(([a, b]) => dupOf.set(a, [...(dupOf.get(a) || []), `${b} (${s.level})`]));
    });
    result.parties.forEach(p => rows.push([p.partyId, p.name, p.hindiSuggestion, p.type, p.aliases.join(' | '), p.bills.total, p.dueBills,
        p.dues.receivable, p.dues.payable, p.dues.retail, p.dues.wholesale, p.legacyPhone ? 'yes' : 'no', (dupOf.get(p.partyId) || []).join(' ; ')]));
    return `${rows.map(r => r.map(csvCell).join(',')).join('\n')}\n`;
}

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/**
 * Console summary. Names appear only when `names` is set (the output is private either way).
 * @param {Object} result partiesDryRun()
 * @param {{names?: boolean, top?: number}} [opts]
 */
export function formatSummary(result, { names = true, top = 15 } = {}) {
    const t = result.totals;
    const lines = [
        `Parties dry run (${result.scope === 'due' ? 'names with a carried due' : 'every named bill'}): NO WRITES`,
        `Backup exported ${result.source.exportedAt}`,
        `Proposed parties: ${t.parties} (${t.customers} customers, ${t.suppliers} suppliers, ${t.both} both) of ${t.namesInBackup} names in the backup; ${t.withAliases} with other spellings, ${t.withPhone} with an old-app phone`,
        `Bills of these parties: ${t.bills}; voided bills left out: ${t.voidedBillsSkipped}; bills with no name: ${t.unnamed.bills} (${t.unnamed.dueBills} with ${money(t.unnamed.due)} due, stay under "No name")`,
        `Dues carried as opening records (plan options: mode ${result.options.mode}, payables ${result.options.carryPayables ? 'carried' : 'NOT carried'}, wholesale not made on the Wholesale page ${result.options.includeHiddenWholesaleDues ? 'carried' : 'NOT carried'}):`,
    ];
    Object.entries(t.check).forEach(([l, c]) => lines.push(`  ${l.padEnd(9)} parties ${money(c.parties)} + no name ${money(c.unnamed)} = ${money(round2(c.parties + c.unnamed))}; plan opening records ${money(c.plan)} ${c.matches ? 'OK' : 'MISMATCH'}; Outstanding of these bills ${money(c.outstanding)}, not carried ${money(c.notCarried)}`));
    lines.push(`Possible duplicates (suggestions, never merged automatically): ${t.suggestions.high} high, ${t.suggestions.medium} medium, ${t.suggestions.low} low`);
    if (names) {
        result.suggestions.slice(0, top).forEach(s => lines.push(`  [${s.level} ${s.confidence}] keep "${s.names[0]}" (${s.keep}) + "${s.names[1]}" (${s.merge}): ${s.reasons.join(', ')}; after: ${s.after.bills} bills, receive ${money(s.after.receivable)}, pay ${money(s.after.payable)}`));
        lines.push('Parties (largest due first):');
        result.parties.slice(0, top).forEach(p => lines.push(`  ${p.partyId}  ${p.name}${p.aliases.length ? ` (also ${p.aliases.join(', ')})` : ''}  ${p.type}  bills ${p.bills.total}  due bills ${p.dueBills}  receive ${money(p.dues.receivable)}  pay ${money(p.dues.payable)}`));
        if (result.parties.length > top) lines.push(`  … ${result.parties.length - top} more in the CSV / JSON`);
    }
    lines.push(`Would write: ${result.writes.parties} party docs + ${result.writes.directory} directory doc; bills rewritten: 0`);
    return lines.join('\n');
}