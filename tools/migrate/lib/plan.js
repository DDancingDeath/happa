/**
 * `plan`: decrypted backup JSON (tools/backup/export-firestore.js) -> migration
 * bundle (documents to write in the new project) + a summary with counts and
 * totals only. Pure and offline: never talks to Firebase.
 *
 * Money, dues, dates and rate lines are read with the app's own utils so the
 * numbers match what the Outstanding, Wholesale and Rate trends pages show.
 */
import backupLib from '../../backup/backup-lib.js';
import { readPayment, round2, wholesaleOutstanding } from '../../../www/js/utils/money.js';
import { buildAging } from '../../../www/js/utils/aging.js';
import { addBillToAcc, createCatalogueResolver, istDayKey, lineKg, lineRate, RATE_KINDS } from '../../../www/js/utils/rate-trends.js';
import { buildRateStatsDocs, rateStatsMeta } from './rate-stats.js';

export const BUNDLE_FORMAT = 'aadhat-migration-bundle-v1';
export const OLD_PROJECT_ID = 'aadhat-management';
/** Must equal CLIENT_VERSION in www/js/firebase/firestore-service.js (a test checks). */
export const CLIENT_VERSION = 3;
export const SPARK_DAILY_WRITES = 20000;
/** Writes kept free for the shop's own first day in the new project. */
export const SHOP_RESERVE_WRITES = 8000;
export const MIGRATION_DAILY_WRITES = SPARK_DAILY_WRITES - SHOP_RESERVE_WRITES;
/** Write order: what the shop needs to start first, bulk history last. */
const GROUP_ORDER = ['settings', 'counters', 'copy:users', 'opening', 'copy:items'];
const BULK_LAST = ['copy:rateHistory', 'copy:itemFrequency', 'rateStats', 'rateStatsMeta'];

export const DEFAULT_OPTIONS = Object.freeze({
    mode: 'fresh',
    billNumbers: 'continue',
    carryPayables: false,
    includeHiddenWholesaleDues: false,
    settings: true,
    rateStats: true,
    copy: ['items', 'users', 'rateHistory', 'itemFrequency']
});

/** Not copied in --mode full: rebuilt by the new app, or device/runtime data. */
const FULL_MODE_SKIP = new Set(['stockCheckpoints', 'rateStats', 'telemetry', 'tipHealth', 'tipFailures', 'autoSaves', 'drafts', 'anomalies']);
const SETTINGS_APP_STRIP = ['minClientVersion', 'enforceClientVersion'];
const BILL_COLLS = { purchase: 'purchases', retail: 'retailSales', wholesale: 'wholesaleSales' };
const BILL_PREFIX = { purchase: 'P', retail: 'S', wholesale: 'W' };

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

const compactDay = (dayKey) => dayKey.replace(/-/g, '');

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
 * One opening record per old unpaid bill: same bill number, date, party name
 * and phone, with the open amount as its due. No lines and no bill total, so
 * sales, profit and stock are untouched; the due sits in payment.due /
 * dueAmount, where Outstanding, reminders, statements, payments and write-offs
 * already read it.
 */
function openingDoc({ billType, kind, entry, party, src, cutoff, fromProject, warnings }) {
    const amount = round2(entry.due);
    const pay = readPayment(src);
    const total = billType === 'wholesale' ? round2(src.total || 0) : pay.total;
    let timestamp = entry.date ? entry.date.getTime() : null;
    if (timestamp === null) {
        timestamp = cutoff;
        warnings.push(`${billType}: a bill with ₹${amount} due has no usable date; its opening record is dated the cutoff`);
    }
    const doc = {
        billNumber: String(src.billNumber || entry.billNumber || ''),
        customerName: String(src.customerName ?? '').trim().replace(/\s+/g, ' '),
        date: src.date ?? istDayKey(timestamp),
        timestamp,
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
        openingBalance: {
            migrated: true, kind, billType, amount, billTotal: total, paidBefore: round2(Math.max(0, total - amount)),
            asOf: cutoff, fromProject, sourceBillId: src.__docId
        }
    };
    const phone = String(src.customerPhone || src.phone || src.mobile || party.phone || '').trim();
    if (phone) doc.customerPhone = phone;
    if (billType === 'wholesale') doc.source = 'sales-tab';
    if (billType === 'purchase' && src.supplierName) doc.supplierName = src.supplierName;
    return { coll: BILL_COLLS[billType], id: `opening-${billType}-${src.__docId}`, data: doc };
}

/** Open bills of one page, grouped and aged exactly as that page does. */
function dueSet(billType, bills, today, { hidden = false } = {}) {
    let open;
    if (billType === 'wholesale' && !hidden) {
        // Wholesale page rule (wholesale-sales.js renderSalesOutstanding): sales-tab bills only.
        open = bills.filter(b => b && b.source === 'sales-tab' && wholesaleOutstanding(b) > 0)
            .map(b => withDue(b, wholesaleOutstanding(b)));
    } else if (hidden) {
        // Wholesale bills not made on the Wholesale page: no page lists them.
        open = bills.filter(b => b && b.source !== 'sales-tab' && !b.cleared && readPayment(b).due > 0);
    } else {
        open = bills;
    }
    const aging = buildAging(open, { today });
    const byId = new Map(open.map(b => [String(b.id), b]));
    const entries = [];
    [...aging.parties].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .forEach(party => party.bills.forEach(entry => entries.push({ party, entry, src: byId.get(String(entry.id)) })));
    return { aging, entries };
}

function withDue(bill, due) {
    const out = { ...bill, payment: { ...(bill.payment || {}), due: round2(due) }, dueAmount: round2(due) };
    Object.defineProperty(out, '__docId', { value: bill.__docId, enumerable: false });
    return out;
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

/**
 * Independent check of the year docs: kg per kind from the bill lines the
 * app counts must equal the monthly and the weekly bucket totals.
 */
function crossCheckRateStats(docs, sources, items) {
    const resolve = createCatalogueResolver(items);
    const lineKgByKind = {};
    let lines = 0;
    let skippedLines = 0;
    let bills = 0;
    RATE_KINDS.forEach(kind => (sources[kind] || []).forEach(bill => {
        if (addBillToAcc({}, bill, kind, resolve)) bills++;
        if (!bill || bill.deleted === true || bill.isDeleted === true || !Array.isArray(bill.items)) return;
        bill.items.forEach(line => {
            if (!line) return;
            const kg = lineKg(line);
            if (kg > 0 && lineRate(line, kg) > 0 && resolve(line)) {
                lines++;
                lineKgByKind[kind] = (lineKgByKind[kind] || 0) + kg;
            } else {
                skippedLines++;
            }
        });
    }));
    const sum = (group) => {
        const out = {};
        Object.values(docs).forEach(d => Object.values(d[group] || {}).forEach(b => RATE_KINDS.forEach(k => { out[k] = (out[k] || 0) + (b[k]?.kg || 0); })));
        return out;
    };
    const months = sum('months');
    const weeks = sum('weeks');
    const near = (a, b) => Math.abs((a || 0) - (b || 0)) < 0.05;
    return {
        bills,
        lines,
        skippedLines,
        monthsMatchLines: RATE_KINDS.every(k => near(months[k], lineKgByKind[k])),
        weeksMatchMonths: RATE_KINDS.every(k => near(weeks[k], months[k])),
        kgByKind: Object.fromEntries(RATE_KINDS.map(k => [k, round2(months[k] || 0)]))
    };
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

    const toRecords = (name) => (collections[name] || []).map(d => {
        const rec = { id: d.id, ...revive(d.data) };
        Object.defineProperty(rec, '__docId', { value: d.id, enumerable: false });
        return rec;
    });
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
        const docs = buildRateStatsDocs(bills, items, now);
        const check = crossCheckRateStats(docs, bills, items);
        if (!check.monthsMatchLines) warnings.push('rate stats: monthly kg totals differ from the bill lines');
        if (!check.weeksMatchMonths) warnings.push('rate stats: weekly kg totals differ from monthly kg totals');
        add('rateStats', Object.entries(docs).map(([id, data]) => ({ coll: 'rateStats', id, data })));
        rate = { docs: Object.keys(docs).length, months: Object.values(docs).reduce((n, d) => n + Object.keys(d.months).length, 0), weeks: Object.values(docs).reduce((n, d) => n + Object.keys(d.weeks).length, 0), ...check };
    }

    const dues = {};
    const openingWrites = [];
    const sameBuckets = (a, b) => a.buckets.every((x, i) => x.total === b.buckets[i].total && x.count === b.buckets[i].count);
    const summarize = (set, kind, carried) => ({
        kind,
        carried,
        parties: set.aging.parties.length,
        bills: set.aging.count,
        total: set.aging.total,
        buckets: set.aging.buckets.map(b => ({ key: b.key, total: b.total, count: b.count })),
        noName: set.aging.parties.some(p => p.key === '')
    });
    const carryInto = (summary, set, billType, kind) => {
        const docs = set.entries.map(e => openingDoc({ billType, kind, ...e, cutoff, fromProject, warnings }));
        openingWrites.push(...docs);
        const after = buildAging(docs.map(d => revive(d.data)), { today });
        summary.records = docs.length;
        summary.openingTotal = sumAmounts(docs);
        summary.matches = after.total === set.aging.total && after.count === set.aging.count
            && sameBuckets(after, set.aging)
            && set.aging.parties.every(p => after.parties.find(q => q.key === p.key)?.total === p.total);
        if (!summary.matches) warnings.push(`${billType}: opening records do not match the old page (totals, age groups or parties)`);
    };
    [['retail', 'receivable'], ['wholesale', 'receivable'], ['purchase', 'payable']].forEach(([billType, kind]) => {
        const set = dueSet(billType, bills[billType], today);
        const carry = options.mode === 'fresh' && (kind === 'receivable' || options.carryPayables);
        dues[billType] = summarize(set, kind, carry);
        if (carry) carryInto(dues[billType], set, billType, kind);
    });
    const hiddenSet = dueSet('wholesale', bills.wholesale, today, { hidden: true });
    const carryHidden = options.mode === 'fresh' && options.includeHiddenWholesaleDues;
    const hiddenDues = summarize(hiddenSet, 'receivable', carryHidden);
    if (carryHidden) carryInto(hiddenDues, hiddenSet, 'wholesale', 'receivable');
    if (dues.purchase.total > 0) {
        warnings.push(`payables: ₹${dues.purchase.total} is still due to suppliers (${dues.purchase.bills} bills)`
            + (options.carryPayables ? '; carried as opening records' : '; NOT carried (the owner said none are due). Use --carry-payables to carry them'));
    }
    const retailOutstanding = round2(bills.retail.filter(b => !b.cleared && readPayment(b).due > 0).reduce((a, b) => a + readPayment(b).due, 0));
    if (Math.abs(retailOutstanding - dues.retail.total) > 0.01) {
        warnings.push(`retail: list total ₹${retailOutstanding} vs aging total ₹${dues.retail.total} (tiny dues below ₹0.005 are hidden by Outstanding)`);
    }
    add('opening', openingWrites);

    if (rate) {
        const built = writes.filter(w => w.group === 'rateStats');
        const docs = Object.fromEntries(built.map(w => [w.id, w.data]));
        add('rateStatsMeta', [{ coll: 'rateStats', id: '_meta', data: rateStatsMeta({ bills: rate.bills, docs, cutoff }) }]);
    }

    const bad = writes.filter(w => w.coll.startsWith('dev_'));
    if (bad.length) throw new Error('internal: a dev_ collection reached the bundle');

    const rank = (g) => {
        const first = GROUP_ORDER.indexOf(g);
        if (first !== -1) return first;
        const last = BULK_LAST.indexOf(g);
        return last !== -1 ? GROUP_ORDER.length + 1 + last : GROUP_ORDER.length;
    };
    const ordered = writes.map((w, i) => ({ w, i })).sort((a, b) => (rank(a.w.group) - rank(b.w.group)) || (a.i - b.i)).map(x => x.w);
    writes.length = 0;
    writes.push(...ordered);
    const firstBulk = writes.findIndex(w => BULK_LAST.includes(w.group));
    const essential = firstBulk === -1 ? writes.length : firstBulk;
    const days = Math.max(1, Math.ceil(writes.length / MIGRATION_DAILY_WRITES));
    const lastDay = writes.length - (days - 1) * MIGRATION_DAILY_WRITES;

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
        hiddenWholesaleDues: hiddenDues,
        rateStats: rate,
        writes: {
            total: writes.length,
            essential,
            byCollection: byColl,
            dailyQuota: SPARK_DAILY_WRITES,
            shopReserve: SHOP_RESERVE_WRITES,
            perDay: MIGRATION_DAILY_WRITES,
            days,
            leftForShopOnLastDay: SPARK_DAILY_WRITES - lastDay
        },
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
