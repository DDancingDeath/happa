/**
 * @fileoverview Pure helpers for the offline real-data number audit
 * (tools/audit/real-data-audit.js). No data lives in this repo: everything here
 * works on a backup file the owner passes in. Nothing in here may print party
 * names or phone numbers; reports carry spec IDs, periods, counts and amounts.
 */
import * as O from '../../tests/oracle/oracle.js';

// ------------------------------------------------------------------ loading

/** Firestore Timestamps in a backup are `{__type: 'timestamp', seconds, nanoseconds}`; give them the SDK's methods back. */
export function revive(v) {
    if (Array.isArray(v)) return v.map(revive);
    if (!v || typeof v !== 'object') return v;
    if (v.__type === 'timestamp') {
        const ms = Number(v.seconds) * 1000 + Math.floor(Number(v.nanoseconds || 0) / 1e6);
        return { seconds: Number(v.seconds), nanoseconds: Number(v.nanoseconds || 0), toMillis: () => ms, toDate: () => new Date(ms) };
    }
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = revive(x);
    return out;
}

const docs = (collections, name) => {
    const list = collections?.[name];
    if (!list) return [];
    const arr = Array.isArray(list) ? list : Object.entries(list).map(([id, data]) => ({ id, data }));
    return arr.map(d => ({ id: d.id, ...revive(d.data || {}) }));
};

/**
 * A backup file (tools/backup format `aadhat-backup-v1`) as the shapes the app keeps in memory.
 * @returns {{exportedAt: number, data: Object}} data: items, purchases, wholesaleSales, retailSales,
 *   stockAdjustments, expenses, withdrawals, sessions
 */
export function loadBackup(json) {
    if (!json || !json.collections) throw new Error('Not a backup file: no "collections" (expected tools/backup format aadhat-backup-v1)');
    const c = json.collections;
    const data = {
        items: docs(c, 'items'),
        purchases: docs(c, 'purchases'),
        wholesaleSales: docs(c, 'wholesaleSales'),
        retailSales: docs(c, 'retailSales'),
        stockAdjustments: docs(c, 'stockAdjustments'),
        expenses: docs(c, 'expenses'),
        withdrawals: docs(c, 'withdrawals'),
        sessions: docs(c, 'cashManagement')
    };
    const exportedAt = Date.parse(json.exportedAt) || Date.now();
    return { exportedAt, data };
}

// ------------------------------------------------------------------ periods

const pad = (x) => String(x).padStart(2, '0');
export const isoDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/**
 * The audited periods, newest first: each local day of the last `days` days,
 * each calendar month of the last `months` months, and all time. `now` is the
 * moment the screens are looked at for that period (end of the period, or the
 * backup time for the current one).
 */
export function auditPeriods(nowMs, { days = 60, months = 24 } = {}) {
    const out = [];
    const d0 = new Date(nowMs);
    for (let i = 0; i < days; i++) {
        const from = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - i).getTime();
        const to = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - i + 1).getTime();
        out.push({ kind: 'day', label: isoDay(from), from, to, now: Math.min(to - 60000, nowMs) });
    }
    for (let i = 0; i < months; i++) {
        const from = new Date(d0.getFullYear(), d0.getMonth() - i, 1).getTime();
        const to = new Date(d0.getFullYear(), d0.getMonth() - i + 1, 1).getTime();
        out.push({ kind: 'month', label: isoDay(from).slice(0, 7), from, to, now: Math.min(to - 60000, nowMs) });
    }
    out.push({ kind: 'all', label: 'all time', from: -Infinity, to: Infinity, now: nowMs });
    return out;
}

// ------------------------------------------------------------------ comparing

/** Allowed differences: ₹1 for money, 0.01 kg for quantities, 0 for counts. */
export const TOL = { money: 1, kg: 0.01, count: 0 };

/**
 * Collects oracle-vs-app comparisons. A mismatch is a difference above the tolerance.
 */
export class Collector {
    constructor() {
        this.checked = {};
        this.mismatches = [];
    }

    /**
     * @param {{spec: string, page: string, period: string, oracle: number, app: number, unit?: 'money'|'kg'|'count', scope?: string}} c
     * @returns {boolean} true when they agree
     */
    compare({ spec, page, period, oracle, app, unit = 'money', scope = 'real' }) {
        const key = `${scope}|${spec}|${page}`;
        this.checked[key] = (this.checked[key] || 0) + 1;
        const a = Number(app);
        const o = Number(oracle);
        const diff = a - o;
        const ok = Number.isFinite(diff) ? Math.abs(diff) <= TOL[unit] + 1e-9 : (app === oracle);
        if (!ok) this.mismatches.push({ scope, spec, page, period, oracle: o, app: Number.isFinite(a) ? a : app, diff: Number.isFinite(diff) ? O.r2(diff) : null, unit });
        return ok;
    }

    /** A check with no app/oracle pair (identity or consistency): `ok` false records it. */
    check({ spec, page, period, ok, expected = null, actual = null, unit = 'money', scope = 'real' }) {
        const key = `${scope}|${spec}|${page}`;
        this.checked[key] = (this.checked[key] || 0) + 1;
        if (!ok) this.mismatches.push({ scope, spec, page, period, oracle: expected, app: actual, diff: expected !== null && actual !== null ? O.r2(actual - expected) : null, unit });
        return ok;
    }
}

/** Mismatches grouped by scope + spec + page, largest group first. */
export function groupMismatches(list) {
    const groups = new Map();
    for (const m of list) {
        const k = `${m.scope}|${m.spec}|${m.page}`;
        if (!groups.has(k)) groups.set(k, { scope: m.scope, spec: m.spec, page: m.page, rows: [] });
        groups.get(k).rows.push(m);
    }
    return [...groups.values()].sort((a, b) => a.scope.localeCompare(b.scope) * -1 || b.rows.length - a.rows.length || a.spec.localeCompare(b.spec));
}

// ------------------------------------------------------------------ data quality

const normName = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const num = (v) => { const x = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(x) ? x : null; };
const KINDS = [['purchases', 'purchase'], ['wholesaleSales', 'wholesale'], ['retailSales', 'retail']];

/**
 * Data-quality problems in a backup, as counts (never names). Uses the oracle's
 * readings of a bill, not the app's, so a quirk of the app can't hide a problem.
 * @returns {Array<{id: string, label: string, count: number, of?: number, note?: string}>}
 */
export function dataQuality(data, exportedAt) {
    const items = data.items || [];
    const ids = new Set(items.map(i => i.id));
    const names = new Set(items.flatMap(i => [normName(i.name), normName(i.hindiName)]).filter(Boolean));
    const rows = [];
    const add = (id, label, count, of, note) => rows.push({ id, label, count, ...(of !== undefined ? { of } : {}), ...(note ? { note } : {}) });
    const all = KINDS.flatMap(([f, kind]) => (data[f] || []).map(b => ({ b, kind })));
    const bills = all.length;

    add('bills', 'Bills in the backup (purchases + wholesale + retail)', bills);
    add('date-unreadable', 'Bills with an unreadable date', all.filter(({ b }) => !Number.isFinite(O.timeOf(b.date))).length, bills);
    add('date-ts-day', 'Bills whose `date` and numeric `timestamp` fall on different IST days (Today/Reports use the date, Finance uses the timestamp)',
        all.filter(({ b }) => typeof b.timestamp === 'number' && Number.isFinite(O.timeOf(b.date)) && isoDay(b.timestamp) !== isoDay(O.timeOf(b.date))).length, bills);
    add('date-future', 'Bills dated after the backup was taken', all.filter(({ b }) => O.timeOf(b.date) > exportedAt + 60000).length, bills);
    add('date-ddmm', 'Bills with a DD/MM/YYYY date (old app versions)', all.filter(({ b }) => /^\d{1,2}\/\d{1,2}\/\d{4}/.test(String(b.date ?? ''))).length, bills);

    const lines = all.flatMap(({ b, kind }) => (b.items || []).map(l => ({ l, b, kind })));
    add('lines', 'Bill lines', lines.length);
    add('line-no-itemid', 'Lines without itemId', lines.filter(({ l }) => !l.itemId).length, lines.length);
    add('line-unknown-itemid', 'Lines whose itemId is not in the catalogue', lines.filter(({ l }) => l.itemId && !ids.has(l.itemId)).length, lines.length);
    add('line-unmatched', 'Lines that match no catalogue item by id or name (stock keeps them under the raw name)',
        lines.filter(({ l }) => !(l.itemId && ids.has(l.itemId)) && !names.has(normName(l.name ?? l.itemName))).length, lines.length);
    add('line-qty-nonpositive', 'Lines with quantity ≤ 0', lines.filter(({ l }) => !(num(l.qty ?? l.quantity) > 0)).length, lines.length);
    add('line-rate-nonpositive', 'Lines with rate ≤ 0', lines.filter(({ l }) => !(num(l.rate) > 0)).length, lines.length);
    add('line-total-mismatch', 'Lines where total ≠ quantity × rate (over ₹1)', lines.filter(({ l }) => {
        const q = num(l.qty ?? l.quantity); const r = num(l.rate); const t = num(l.total ?? l.amount);
        return q !== null && r !== null && t !== null && Math.abs(q * r - t) > 1;
    }).length, lines.length);
    add('bill-lines-total', 'Bills whose total differs from the sum of their lines (over ₹1; purchases: lines − labour)', all.filter(({ b, kind }) => {
        if (!(b.items || []).length) return false;
        const sumLines = (b.items || []).reduce((a, l) => a + (num(l.total ?? l.amount) ?? 0), 0);
        const want = kind === 'purchase' ? sumLines - (num(b.laborCharges) || 0) : sumLines;
        return Math.abs(want - O.billValue(b)) > 1;
    }).length, bills);
    add('bill-zero-total', 'Bills with a total of 0 or no total', all.filter(({ b }) => !(O.billValue(b) > 0)).length, bills);
    add('bill-total-fallthrough', 'Bills whose first total field is 0 while a later one is not (`grandTotal: 0` but `billTotal` > 0, …)', all.filter(({ b }) => {
        const vals = ['grandTotal', 'amountPayable', 'total', 'billTotal', 'saleTotal'].map(f => num(b[f])).filter(v => v !== null);
        return vals.length > 1 && vals[0] === 0 && vals.some(v => v !== 0);
    }).length, bills);
    add('pay-over-total', 'Bills where cash + online is more than the bill total (over ₹1)', all.filter(({ b }) => {
        const p = O.payState(b);
        return p.cash + p.online > O.billValue(b) + 1;
    }).length, bills);
    add('pay-split', 'Bills where cash + online + due ≠ total (AC2, over ₹1)', all.filter(({ b }) => {
        const p = O.payState(b);
        return Math.abs(p.cash + p.online + p.due + (num(b.payment?.writtenOff) || 0) - O.billValue(b)) > 1;
    }).length, bills);
    add('due-negative', 'Bills with a negative due', all.filter(({ b }) => O.payState(b).due < -0.005).length, bills);
    add('due-drift', 'Bills where payment.due and dueAmount disagree (not cleared)', all.filter(({ b }) => !b.cleared && b.payment && b.payment.due !== undefined && b.dueAmount !== undefined
        && Math.abs((num(b.payment.due) || 0) - (num(b.dueAmount) || 0)) > 0.01).length, bills);
    add('cleared-with-due', 'Bills marked cleared that still carry a due amount', all.filter(({ b }) => b.cleared && O.payState(b).due > 0.005).length, bills);
    add('payments-entries', 'Later payment entries (`payments[]`)', all.reduce((a, { b }) => a + (b.payments || []).length, 0));
    add('payment-no-id', 'Later payments without an id (can\'t be de-duplicated against cash-drawer legs)', all.reduce((a, { b }) => a + (b.payments || []).filter(p => !p.id).length, 0));
    add('payment-date-unreadable', 'Later payments with an unreadable date', all.reduce((a, { b }) => a + (b.payments || []).filter(p => !Number.isFinite(p.at ?? O.timeOf(p.date))).length, 0));
    add('payment-split-legacy', 'Later payments with only `amount` (treated as cash)', all.reduce((a, { b }) => a + (b.payments || []).filter(p => p.cash === undefined && p.online === undefined && p.kind !== 'writeOff').length, 0));
    add('payments-over-paid', 'Bills whose later payments add up to more than cash + online on the bill (AC3)', all.filter(({ b }) => {
        if (!(b.payments || []).length) return false;
        const p = O.payState(b);
        const later = (b.payments || []).filter(x => x.kind !== 'writeOff')
            .reduce((a, x) => a + (x.cash !== undefined || x.online !== undefined ? (num(x.cash) || 0) + (num(x.online) || 0) : (num(x.amount) || 0)), 0);
        return later > p.cash + p.online + 0.01;
    }).length);

    const dupes = (list) => {
        const seen = new Map();
        list.forEach(b => { const k = String(b.billNumber ?? '').trim(); if (k) seen.set(k, (seen.get(k) || 0) + 1); });
        return [...seen.values()].filter(n => n > 1).reduce((a, n) => a + n, 0);
    };
    KINDS.forEach(([f, kind]) => add(`dup-billno-${kind}`, `${kind} bills sharing a bill number with another ${kind} bill`, dupes(data[f] || []), (data[f] || []).length));
    add('bill-no-number', 'Bills without a bill number', all.filter(({ b }) => !String(b.billNumber ?? '').trim()).length, bills);

    const variants = (list) => {
        const by = new Map();
        list.forEach(b => {
            const raw = String(b.customerName ?? b.supplierName ?? '');
            const k = normName(raw);
            if (!k) return;
            if (!by.has(k)) by.set(k, new Set());
            by.get(k).add(raw);
        });
        const groups = [...by.values()].filter(s => s.size > 1);
        return { groups: groups.length, spellings: groups.reduce((a, s) => a + s.size, 0), parties: by.size };
    };
    KINDS.forEach(([f, kind]) => {
        const v = variants(data[f] || []);
        add(`party-case-${kind}`, `${kind}: parties written in more than one case/spacing (groups)`, v.groups, v.parties, `${v.spellings} spellings`);
    });
    add('due-no-party', 'Bills with a due but no party name', all.filter(({ b }) => O.openDue(b) > 0 && !String(b.customerName ?? b.supplierName ?? '').trim()).length, bills);

    const stock = O.stockReplay(data);
    const negItems = Object.entries(stock.perItem).filter(([, s]) => s.qty < -1e-9);
    add('stock-negative-now', 'Items with stock below zero after every record', negItems.length, Object.keys(stock.perItem).length,
        negItems.length ? negItems.map(([k, s]) => `${itemLabel(items, k)}: ${O.r2(s.qty)} kg`).join('; ') : undefined);
    const dips = negativeDips(data);
    add('stock-negative-events', 'Sale lines that took an item\'s stock below zero (sold before the purchase was recorded)', dips.events, undefined,
        dips.items.length ? `items: ${dips.items.map(k => itemLabel(items, k)).join(', ')}` : undefined);

    const exp = data.expenses || [];
    add('expenses', 'Expenses', exp.length);
    add('exp-untagged', 'Expenses with no business/personal category (#219)', exp.filter(e => !['business', 'personal'].includes(e.category)).length, exp.length);
    add('exp-ddmm', 'Expenses with a D/M/YYYY date (Analytics misreads these, #49)', exp.filter(e => /^\d{1,2}\/\d{1,2}\/\d{4}/.test(String(e.date ?? ''))).length, exp.length);
    add('exp-date-unreadable', 'Expenses with an unreadable date', exp.filter(e => !Number.isFinite(O.timeOf(e.date))).length, exp.length);
    add('exp-nonpositive', 'Expenses with amount ≤ 0', exp.filter(e => !(num(e.amount) > 0)).length, exp.length);

    const sessions = data.sessions || [];
    const dayCount = new Map();
    sessions.forEach(s => dayCount.set(s.date, (dayCount.get(s.date) || 0) + 1));
    add('sessions', 'Cash sessions', sessions.length);
    add('session-dup-day', 'Cash sessions sharing a day with another session', [...dayCount.values()].filter(n => n > 1).reduce((a, n) => a + n, 0), sessions.length);
    add('session-legs', 'Due-payment legs in cash sessions', sessions.reduce((a, s) => a + (s.duePayments || []).length, 0));
    add('adjustments', 'Stock adjustments', (data.stockAdjustments || []).length);
    return rows;
}

function itemLabel(items, key) {
    const it = items.find(i => i.id === key);
    return it ? String(it.name) : String(key);
}

/** Sale lines that took stock below zero (time-ordered replay, same matching as the oracle); `firstDip` = item key → when it first went below zero. */
export function negativeDips(data) {
    const items = data.items || [];
    const keyOf = (l) => {
        if (l.itemId && items.some(i => i.id === l.itemId)) return l.itemId;
        const name = normName(l.name ?? l.itemName);
        const hit = items.find(i => normName(i.name) === name || normName(i.hindiName) === name);
        return hit ? hit.id : name;
    };
    const t = (b) => (typeof b.timestamp === 'number' ? b.timestamp : O.timeOf(b.date));
    const ev = [];
    (data.purchases || []).forEach(b => (b.items || []).forEach(l => ev.push({ t: t(b), o: 0, k: keyOf(l), q: num(l.qty ?? l.quantity) || 0 })));
    [...(data.wholesaleSales || []), ...(data.retailSales || [])].forEach(b => (b.items || []).forEach(l => ev.push({ t: t(b), o: 1, k: keyOf(l), q: -(num(l.qty ?? l.quantity) || 0) })));
    (data.stockAdjustments || []).forEach(a => ev.push({ t: t(a), o: 3, k: keyOf({ itemId: a.itemId, name: a.itemName }), adj: a }));
    ev.sort((a, b) => a.t - b.t || a.o - b.o);
    const q = {};
    let events = 0;
    const hit = new Set();
    const firstDip = {};
    for (const e of ev) {
        if (e.adj) {
            const n = num(e.adj.quantity) || 0;
            if (e.adj.adjustType === 'add') q[e.k] = (q[e.k] || 0) + n;
            else if (e.adj.adjustType === 'remove') q[e.k] = (q[e.k] || 0) - Math.min(n, Math.max(0, q[e.k] || 0));
            else if (e.adj.adjustType === 'set') q[e.k] = n;
            continue;
        }
        q[e.k] = (q[e.k] || 0) + e.q;
        if (e.q < 0 && q[e.k] < -1e-9) {
            events++;
            hit.add(e.k);
            if (!(e.k in firstDip)) firstDip[e.k] = e.t;
        }
    }
    return { events, items: [...hit], firstDip };
}

/** The data with every line and stock adjustment of the given item keys taken out (bill totals untouched). */
export function withoutItems(data, keys) {
    const drop = new Set(keys);
    const items = data.items || [];
    const keyOf = (l) => {
        if (l.itemId && items.some(i => i.id === l.itemId)) return l.itemId;
        const name = normName(l.name ?? l.itemName);
        const hit = items.find(i => normName(i.name) === name || normName(i.hindiName) === name);
        return hit ? hit.id : name;
    };
    const bills = (list) => (list || []).map(b => ({ ...b, items: (b.items || []).filter(l => !drop.has(keyOf(l))) }));
    return {
        ...data,
        purchases: bills(data.purchases),
        wholesaleSales: bills(data.wholesaleSales),
        retailSales: bills(data.retailSales),
        stockAdjustments: (data.stockAdjustments || []).filter(a => !drop.has(keyOf({ itemId: a.itemId, name: a.itemName })))
    };
}

// ------------------------------------------------------------------ report

const fmt = (v, unit = 'money') => {
    if (v === null || v === undefined) return '—';
    if (typeof v !== 'number') return String(v);
    if (unit === 'count') return String(v);
    if (unit === 'kg') return `${O.r2(v)} kg`;
    return `₹${O.r2(v).toLocaleString('en-IN')}`;
};

/**
 * The Markdown report: counts, spec IDs, periods and amounts only.
 * @param {Object} r {title, appRef, exportedAt, ms, periods, collector, causes, quality, numberChecks, migrated, notes}
 */
export function renderReport(r) {
    const L = [];
    const groups = groupMismatches(r.collector.mismatches);
    const real = groups.filter(g => g.scope === 'real');
    const mig = groups.filter(g => g.scope !== 'real');
    const totalChecks = Object.values(r.collector.checked).reduce((a, b) => a + b, 0);
    const causeOf = (g) => r.causes(g) || { cause: 'not yet explained', known: 'new' };
    const max = r.maxRows || 25;

    L.push(`# ${r.title}`, '');
    L.push(`Backup taken ${new Date(r.exportedAt).toISOString()} · app code: ${r.appRef} · ${totalChecks} comparisons in ${(r.ms / 1000).toFixed(1)} s.`);
    L.push('Counts, spec IDs (docs/calculations.md), periods and amounts only: no party names or phone numbers. Tolerance ₹1 / 0.01 kg / exact counts.', '');
    L.push(`Periods: each day of the last ${r.periods.days} days, each month of the last ${r.periods.months} months, all time.`, '');

    L.push('## Summary', '', '| Scope | Spec ID | Page | Mismatches | Checks | Known / new | Likely cause |', '|---|---|---|---|---|---|---|');
    for (const g of groups) {
        const c = causeOf(g);
        L.push(`| ${g.scope} | ${g.spec} | ${g.page} | ${g.rows.length} | ${r.collector.checked[`${g.scope}|${g.spec}|${g.page}`] || '?'} | ${c.known} | ${c.short || c.cause} |`);
    }
    if (!groups.length) L.push('| – | – | – | 0 | – | – | everything agrees |');
    L.push('');

    const detail = (title, list) => {
        L.push(`## ${title}`, '');
        if (!list.length) { L.push('None.', ''); return; }
        for (const g of list) {
            const c = causeOf(g);
            L.push(`### ${g.spec} · ${g.page} (${g.rows.length}, ${c.known})`, '', `Likely cause: ${c.cause}`, '');
            L.push('| Period | Oracle | App | Difference |', '|---|---|---|---|');
            const rows = [...g.rows].sort((a, b) => Math.abs(b.diff ?? 0) - Math.abs(a.diff ?? 0));
            rows.slice(0, max).forEach(m => L.push(`| ${m.period} | ${fmt(m.oracle, m.unit)} | ${fmt(m.app, m.unit)} | ${m.diff === null ? '—' : fmt(m.diff, m.unit)} |`));
            if (rows.length > max) L.push(`| … ${rows.length - max} more | | | |`);
            L.push('');
        }
    };
    detail('Mismatches: real data', real);
    detail('Mismatches: migrated state (opening records + synthetic bills)', mig);

    if (r.migrated && r.migrated.length) {
        L.push('## Opening records and period figures', '');
        r.migrated.forEach(x => L.push(`- ${x}`));
        L.push('');
    }

    if (r.compare) {
        const count = (list) => list.reduce((m, x) => { const k = `${x.scope}|${x.spec}|${x.page}`; m[k] = (m[k] || 0) + 1; return m; }, {});
        const other = count(r.compare.mismatches || []);
        const mine = count(r.collector.mismatches);
        const keys = [...new Set([...Object.keys(other), ...Object.keys(mine)])].sort();
        L.push(`## Compared with another run (mismatch counts)`, '', `| Scope | Spec ID | Page | ${r.compare.appRef || 'other'} | ${r.appRef} |`, '|---|---|---|---|---|');
        keys.forEach(k => { const [sc, sp, pg] = k.split('|'); L.push(`| ${sc} | ${sp} | ${pg} | ${other[k] || 0} | ${mine[k] || 0} |`); });
        L.push(`| **total** | | | **${(r.compare.mismatches || []).length}** | **${r.collector.mismatches.length}** |`, '');
    }

    L.push('## Number checks (www/js/utils/number-checks.js on the whole backup)', '', '| Check | Status | Checked | Problems |', '|---|---|---|---|');
    (r.numberChecks || []).forEach(c => L.push(`| ${c.id} | ${c.status} | ${c.checked} | ${c.problems} |`));
    L.push('');

    L.push('## Data quality', '', '| Problem | Count | Of | Note |', '|---|---|---|---|');
    (r.quality || []).forEach(q => L.push(`| ${q.label} | ${q.count} | ${q.of ?? ''} | ${q.note ?? ''} |`));
    L.push('');
    if (r.notes && r.notes.length) {
        L.push('## Notes', '');
        r.notes.forEach(n => L.push(`- ${n}`));
        L.push('');
    }
    return L.join('\n');
}
