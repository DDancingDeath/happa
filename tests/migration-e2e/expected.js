/**
 * Expected state after the migration, from the OLD backup alone (no tool
 * output): written to <out>/expected.json for the browser checks
 * (app.spec.js). For a real backup <out> is outside the repo.
 */
import { oldOutstanding } from './old-outstanding.js';

const BILL_PREFIX = { purchases: 'P', retailSales: 'S', wholesaleSales: 'W' };
const pad = (v) => String(v).padStart(2, '0');
export const istDay = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
};

/** Plain bill objects ({id, ...data}) of one backup collection. */
export const billsOf = (backup, coll) => (backup.collections[coll] || []).map(d => ({ id: d.id, ...d.data }));

/** Counters the new project should hold for the cutoff day: the last number issued per prefix. */
export function expectedCounters(backup, cutoff) {
    const day = istDay(cutoff);
    const out = {};
    (backup.collections.counters || []).forEach(({ id, data }) => {
        if (data && String(data.date || '') >= day) out[id] = Number(data.next) || 0;
    });
    Object.entries(BILL_PREFIX).forEach(([coll, prefix]) => {
        const re = new RegExp(`^${prefix}${day}-(\\d+)$`);
        billsOf(backup, coll).forEach(b => {
            const m = re.exec(String(b.billNumber || ''));
            if (m) out[`${prefix}${day}`] = Math.max(out[`${prefix}${day}`] || 0, Number(m[1]));
        });
    });
    return out;
}

const active = (u) => !u.status || ['active', 'approved'].includes(u.status);

export function buildExpected(backup) {
    const cutoff = Date.parse(backup.exportedAt);
    const dues = oldOutstanding({ retailSales: billsOf(backup, 'retailSales'), wholesaleSales: billsOf(backup, 'wholesaleSales') }, cutoff);
    const users = Object.fromEntries((backup.collections.users || []).map(({ id, data }) => [id, { email: data.email || '', role: data.role || '', status: data.status || '' }]));
    const pick = (role) => Object.keys(users).sort().find(uid => users[uid].role === role && active(users[uid])) || null;
    return {
        cutoff,
        cutoffDay: istDay(cutoff),
        dues: {
            retail: { total: dues.retail.total, count: dues.retail.count, parties: Object.keys(dues.retail.parties).length },
            wholesale: { total: dues.wholesale.total, count: dues.wholesale.count, parties: Object.keys(dues.wholesale.parties).length },
            receivable: Math.round((dues.retail.total + dues.wholesale.total) * 100) / 100,
            // per bill: what the app's rows must show (age is worked out again in the browser's today)
            bills: dues.bills.map(b => ({ id: b.id, billType: b.billType, billNumber: b.billNumber, due: b.due, time: b.time, partyKey: b.partyKey }))
        },
        items: (backup.collections.items || []).map(({ id, data }) => ({ id, name: data.name || '' })),
        users,
        loginPick: { owner: pick('owner'), member: pick('staff') || pick('manager') },
        counters: expectedCounters(backup, cutoff),
        hasRateStats: (backup.collections.items || []).length > 0
    };
}
