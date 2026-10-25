/**
 * `plan`: decrypted backup JSON (tools/backup/export-firestore.js) -> migration
 * bundle (documents to write in the new project) + a summary with counts and
 * totals only. Pure and offline: never talks to Firebase.
 *
 * Money, dues, dates and rate lines are read with the app's own utils so the
 * numbers match what the Outstanding, Wholesale and Rate trends pages show.
 */
import { createHash } from 'crypto';
import backupLib from '../../backup/backup-lib.js';
import { readPayment, round2, wholesaleOutstanding } from '../../../www/js/utils/money.js';
import { buildAging } from '../../../www/js/utils/aging.js';
import { aggregateBills, finalizeStats, istDayKey, RATE_KINDS } from '../../../www/js/utils/rate-trends.js';
import { buildRateStatsDocs, rateStatsMeta } from './rate-stats.js';

export const BUNDLE_FORMAT = 'aadhat-migration-bundle-v1';
export const OLD_PROJECT_ID = 'aadhat-management';
/** Must equal CLIENT_VERSION in www/js/firebase/firestore-service.js (a test checks). */
export const CLIENT_VERSION = 3;
export const SPARK_DAILY_WRITES = 20000;

export const DEFAULT_OPTIONS = Object.freeze({
    mode: 'fresh',
    billNumbers: 'continue',
    carryPayables: false,
    settings: true,
    rateStats: true,
    copy: ['items', 'users', 'rateHistory', 'itemFrequency']
});

/** Not copied in --mode full: rebuilt by the new app, or device/runtime data. */
const FULL_MODE_SKIP = new Set(['stockCheckpoints', 'rateStats', 'telemetry', 'tipHealth', 'tipFailures', 'autoSaves', 'drafts', 'anomalies']);
const SETTINGS_APP_STRIP = ['minClientVersion', 'enforceClientVersion'];
const BILL_COLLS = { purchase: 'purchases', retail: 'retailSales', wholesale: 'wholesaleSales' };
const BILL_PREFIX = { purchase: 'P', retail: 'S', wholesale: 'W' };
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Tagged backup values -> shapes the app utils read (Timestamp-like objects). */
export function revive(value) {
    if (Array.isArray(value)) return value.map(revive);
    if (!isPlainObject(value)) return value;
    if (value.__type === 'timestamp') {
        const millis = typeof value.millis === 'number' ? value.millis
            : value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
        return {
            seconds: Math.floor(millis / 1000),
            nanoseconds: (millis % 1000) * 1e6,
            toMillis: () => millis,
            toDate: () => new Date(millis)
        };
    }
    if (value.__type) return value;
    const out = {};
    Object.keys(value).forEach(k => { out[k] = revive(value[k]); });
    return out;
}

const hashId = (s) => createHash('sha1').update(String(s), 'utf8').digest('hex').slice(0, 16);
const compactDay = (dayKey) => dayKey.replace(/-/g, '');
/** IST noon of 'YYYY-MM-DD' as ms (a daytime timestamp for that calendar day). */
const istNoonMs = (dayKey) => {
    const [y, m, d] = dayKey.split('-').map(Number);
    return Date.UTC(y, m - 1, d, 12) - IST_OFFSET_MS;
};

export function parseOptions(raw = {}) {
    const o = { ...DEFAULT_OPTIONS, ...Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)) };
    if (!['fresh', 'full'].includes(o.mode)) throw new Error(`--mode must be fresh or full (got ${o.mode})`);
    if (!['continue', 'restart'].includes(o.billNumbers)) throw new Error(`--bill-numbers must be continue or restart (got ${o.billNumbers})`);
    o.copy = [...new Set((o.copy || []).map(s => String(s).trim()).filter(Boolean))];
    const dev = o.copy.filter(c => c.startsWith('dev_'));
    if (dev.length) throw new Error(`dev_ collections are never migrated: ${dev.join(', ')}`);
    return o;
}

/**
 * One opening-balance bill per party. No lines and no bill total (so sales,
 * profit and stock are untouched); the due sits in payment.due / dueAmount,
 * where Outstanding, payments and write-offs already read it.
 */
function openingDoc({ billType, kind, party, index, cutoff, fromProject, byId }) {
    const amount = round2(party.total);
    const dated = party.bills.find(b => b.date);
    const day = dated ? istDayKey(dated.date.getTime()) : istDayKey(cutoff);
    const sourceBills = party.bills.map(b => {
        const src = byId.get(String(b.id));
        return {
            id: String(b.id),
            billNumber: String(b.billNumber || ''),
            date: b.date ? istDayKey(b.date.getTime()) : null,
            total: src ? readPayment(src).total : 0,
            due: round2(b.due)
        };
    });
    const doc = {
        billNumber: `OB-${BILL_PREFIX[billType]}-${String(index).padStart(3, '0')}`,
        customerName: party.name,
        date: day,
        timestamp: istNoonMs(day),
        type: billType,
        isPurchase: billType === 'purchase',
        items: [],
        total: 0,
        cashPayment: 0,
        onlinePayment: 0,
        dueAmount: amount,
        payment: { cash: 0, online: 0, due: amount, total: 0 },
        openDue: true,
        cleared: false,
        clientVersion: CLIENT_VERSION,
        openingBalance: { migrated: true, kind, billType, amount, asOf: cutoff, fromProject, sourceBills }
    };
    if (party.phone) doc.customerPhone = party.phone;
    if (billType === 'wholesale') doc.source = 'sales-tab';
    if (billType === 'purchase') doc.supplierName = party.name;
    return { coll: BILL_COLLS[billType], id: `opening-${billType}-${hashId(party.key)}`, data: doc };
}

/** Parties with dues, in a stable order (oldest due first, then name key). */
function sortedParties(aging) {
    const time = (p) => {
        const d = p.bills.find(b => b.date);
        return d ? d.date.getTime() : -Infinity;
    };
    return [...aging.parties].sort((a, b) => (time(a) - time(b)) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function dueSet(billType, bills, today) {
    let open;
    if (billType === 'wholesale') {
        // Wholesale page rule (wholesale-sales.js renderSalesOutstanding): sales-tab bills only.
        open = bills.filter(b => b && b.source === 'sales-tab' && wholesaleOutstanding(b) > 0)
            .map(b => ({ ...b, payment: { ...(b.payment || {}), due: round2(wholesaleOutstanding(b)) }, dueAmount: round2(wholesaleOutstanding(b)) }));
    } else {
        open = bills;
    }
    const aging = buildAging(open, { today });
    return { aging, parties: sortedParties(aging), byId: new Map(bills.map(b => [String(b.id), b])) };
}

function countersToCarry(collections, bills, cutoff) {
    const day = compactDay(istDayKey(cutoff));
    const out = new Map();
    (collections.counters || []).forEach(({ id, data }) => {
        if (!data || String(data.date || '') < day) return;
        out.set(id, { next: Number(data.next) || 0, initialized: true, prefix: data.prefix, date: data.date });
    });
    Object.entries(BILL_PREFIX).forEach(([billType, prefix]) => {
        const re = new RegExp(`^${prefix}${day}-(\\d+)$`);
        let max = 0;
        (bills[billType] || []).forEach(b => {
            const m = re.exec(String(b.billNumber || ''));
            if (m) max = Math.max(max, Number(m[1]));
        });
        if (!max) return;
        const id = `${prefix}${day}`;
        const c = out.get(id) || { next: 0, initialized: true, prefix, date: day };
        c.next = Math.max(c.next, max);
        out.set(id, c);
    });
    return [...out.entries()].sort().map(([id, data]) => ({ coll: 'counters', id, data: { ...data, updatedAt: cutoff } }));
}

function cleanSettings(docs, oldProject) {
    const stripped = [];
    const out = (docs || []).map(({ id, data }) => {
        const copy = { ...(data || {}) };
        Object.keys(copy).forEach(k => {
            const projectSpecific = (id === 'app' && SETTINGS_APP_STRIP.includes(k))
                || (typeof copy[k] === 'string' && oldProject && copy[k].includes(oldProject));
            if (projectSpecific) {
                stripped.push(`${id}.${k}`);
                delete copy[k];
            }
        });
        return { coll: 'settings', id, data: copy };
    });
    return { writes: out, stripped };
}

function sameSection(a, b) {
    return ['kg', 'amount', 'min', 'max', 'avg', 'bills'].every(f => (a?.[f] ?? null) === (b?.[f] ?? null));
}

/** Monthly buckets must equal the app's own monthly aggregation (rate-trends.js). */
function crossCheckRateStats(docs, sources, items) {
    const monthly = finalizeStats(aggregateBills(sources, items));
    let mismatches = 0;
    let checked = 0;
    Object.values(monthly).forEach(m => {
        const doc = docs[`${m.itemId}_${m.month.slice(0, 4)}`];
        const b = doc?.[`m${m.month}`];
        checked++;
        if (!b || b.bills !== m.bills || !RATE_KINDS.every(k => sameSection(b[k], m[k]))) mismatches++;
    });
    const bucketCount = Object.values(docs).reduce((n, d) => n + Object.keys(d).filter(k => /^m/.test(k)).length, 0);
    if (bucketCount !== checked) mismatches += Math.abs(bucketCount - checked);
    const totals = { week: {}, month: {} };
    Object.values(docs).forEach(d => Object.keys(d).forEach(k => {
        const g = k[0] === 'w' ? 'week' : k[0] === 'm' ? 'month' : null;
        if (!g || !/^[wm]\d{4}-/.test(k)) return;
        RATE_KINDS.forEach(kind => { totals[g][kind] = round2((totals[g][kind] || 0) + (d[k][kind]?.kg || 0)); });
    }));
    const weeksMatchMonths = RATE_KINDS.every(k => Math.abs((totals.week[k] || 0) - (totals.month[k] || 0)) < 0.05);
    return { monthsChecked: checked, mismatches, weeksMatchMonths, kgByKind: totals.month };
}

const sumAmounts = (writes) => round2(writes.reduce((a, w) => a + w.data.openingBalance.amount, 0));

/**
 * @param {Object} backup decrypted backup JSON
 * @param {Object} [rawOptions] see DEFAULT_OPTIONS
 * @param {{now?: number}} [ctx]
 * @returns {{bundle: Object, summary: Object}}
 */
export function buildPlan(backup, rawOptions = {}, { now = Date.now() } = {}) {
    if (!backup || backup.format !== backupLib.BACKUP_FORMAT) {
        throw new Error(`Not a decrypted backup (format ${backup?.format}); expected ${backupLib.BACKUP_FORMAT}`);
    }
    const options = parseOptions(rawOptions);
    const cutoff = Date.parse(backup.exportedAt);
    if (!Number.isFinite(cutoff)) throw new Error('Backup has no valid exportedAt');
    const fromProject = backup.project || OLD_PROJECT_ID;
    const allNames = Object.keys(backup.collections || {});
    const devExcluded = allNames.filter(n => n.startsWith('dev_'));
    const collections = {};
    allNames.filter(n => !n.startsWith('dev_')).forEach(n => { collections[n] = backup.collections[n] || []; });

    const toRecords = (name) => (collections[name] || []).map(d => ({ id: d.id, ...revive(d.data) }));
    const bills = { purchase: toRecords('purchases'), retail: toRecords('retailSales'), wholesale: toRecords('wholesaleSales') };
    const items = toRecords('items');
    const today = new Date(cutoff);
    const warnings = [];
    const writes = [];
    const add = (group, list) => list.forEach(w => writes.push({ group, ...w }));

    if (options.settings && collections.settings) {
        const s = cleanSettings(collections.settings, fromProject);
        add('settings', s.writes);
        if (s.stripped.length) warnings.push(`settings fields left behind (project-specific): ${s.stripped.join(', ')}`);
    }

    const copied = {};
    let copyNames;
    if (options.mode === 'full') {
        copyNames = Object.keys(collections).filter(n => !FULL_MODE_SKIP.has(n) && n !== 'settings' && n !== 'counters');
    } else {
        copyNames = options.copy.filter(n => n !== 'settings');
    }
    copyNames.forEach(name => {
        const docs = collections[name] || [];
        if (!collections[name]) warnings.push(`collection ${name} is not in the backup`);
        copied[name] = docs.length;
        add(`copy:${name}`, docs.map(d => ({ coll: name, id: d.id, data: d.data })));
    });

    let counters = [];
    if (options.billNumbers === 'continue') {
        counters = options.mode === 'full'
            ? (collections.counters || []).map(d => ({ coll: 'counters', id: d.id, data: d.data }))
            : countersToCarry(collections, bills, cutoff);
        add('counters', counters);
    }

    let rate = null;
    if (options.rateStats) {
        const built = buildRateStatsDocs(bills, items);
        const check = crossCheckRateStats(built.docs, bills, items);
        if (check.mismatches) warnings.push(`rate stats: ${check.mismatches} monthly buckets differ from the app's monthly aggregation`);
        if (!check.weeksMatchMonths) warnings.push('rate stats: weekly kg totals differ from monthly kg totals');
        add('rateStats', Object.entries(built.docs).map(([id, data]) => ({ coll: 'rateStats', id, data })));
        rate = { docs: Object.keys(built.docs).length, bills: built.bills, lines: built.lines, skippedLines: built.skippedLines, ...check };
    }

    const dues = {};
    const openingWrites = [];
    const kinds = [['retail', 'receivable'], ['wholesale', 'receivable'], ['purchase', 'payable']];
    kinds.forEach(([billType, kind]) => {
        const set = dueSet(billType, bills[billType], today);
        const carry = options.mode === 'fresh' && (kind === 'receivable' || options.carryPayables);
        const docs = set.parties.map((party, i) => openingDoc({ billType, kind, party, index: i + 1, cutoff, fromProject, byId: set.byId }));
        const undated = set.parties.filter(p => !p.bills.some(b => b.date)).length;
        if (undated) warnings.push(`${billType}: ${undated} parties have no dated bill; their opening balance is dated the cutoff day`);
        dues[billType] = {
            kind,
            carried: carry,
            parties: set.parties.length,
            bills: set.aging.count,
            total: set.aging.total,
            buckets: set.aging.buckets.map(b => ({ key: b.key, total: b.total, count: b.count })),
            noName: set.parties.some(p => p.key === '')
        };
        if (carry) {
            openingWrites.push(...docs);
            const after = buildAging(docs.map(d => revive(d.data)), { today });
            dues[billType].openingTotal = sumAmounts(docs);
            dues[billType].matches = after.total === set.aging.total && after.parties.length === set.parties.length
                && set.parties.every(p => after.parties.find(q => q.key === p.key)?.total === p.total);
            if (!dues[billType].matches) warnings.push(`${billType}: opening balances do not add up to the old Outstanding total`);
        }
    });
    if (dues.purchase.total > 0) {
        warnings.push(`payables: ₹${dues.purchase.total} is still due to suppliers (${dues.purchase.bills} bills)`
            + (options.carryPayables ? '; carried as opening balances' : '; NOT carried (the owner said none are due). Use --carry-payables to carry them'));
    }
    const retailOutstanding = round2(bills.retail.filter(b => !b.cleared && readPayment(b).due > 0).reduce((a, b) => a + readPayment(b).due, 0));
    if (Math.abs(retailOutstanding - dues.retail.total) > 0.01) {
        warnings.push(`retail: list total ₹${retailOutstanding} vs aging total ₹${dues.retail.total} (tiny dues below ₹0.005 are hidden by Outstanding)`);
    }
    const hidden = bills.wholesale.filter(b => b.source !== 'sales-tab' && !b.cleared && readPayment(b).due > 0);
    if (hidden.length) {
        warnings.push(`wholesale: ${hidden.length} bills not made on the Wholesale page have ₹${round2(hidden.reduce((a, b) => a + readPayment(b).due, 0))} due; no page shows them, so they are not carried`);
    }
    add('opening', openingWrites);

    if (rate) {
        const built = writes.filter(w => w.group === 'rateStats');
        const docs = Object.fromEntries(built.map(w => [w.id, w.data]));
        add('rateStatsMeta', [{ coll: 'rateStats', id: '_meta', data: rateStatsMeta({ bills: rate.bills, docs, cutoff, now }) }]);
    }

    const bad = writes.filter(w => w.coll.startsWith('dev_'));
    if (bad.length) throw new Error('internal: a dev_ collection reached the bundle');

    const byColl = {};
    writes.forEach(w => { byColl[w.coll] = (byColl[w.coll] || 0) + 1; });
    const summary = {
        source: { exportedAt: backup.exportedAt, cutoff, project: fromProject, collections: Object.fromEntries(Object.entries(collections).map(([n, d]) => [n, d.length])) },
        devExcluded: devExcluded.map(n => ({ name: n, docs: (backup.collections[n] || []).length })),
        options,
        copied,
        counters: counters.length,
        settings: writes.filter(w => w.group === 'settings').length,
        dues,
        rateStats: rate,
        writes: { total: writes.length, byCollection: byColl, daysAtSparkQuota: Math.max(1, Math.ceil(writes.length / SPARK_DAILY_WRITES)) },
        warnings
    };
    const bundle = {
        format: BUNDLE_FORMAT,
        createdAt: new Date(now).toISOString(),
        source: { project: fromProject, exportedAt: backup.exportedAt, cutoff },
        options,
        writes: writes.map(({ group, coll, id, data }) => ({ group, coll, id, data })),
        summary
    };
    return { bundle, summary };
}
