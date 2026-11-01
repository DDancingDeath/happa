/**
 * @fileoverview Anomaly engine over saved data (#187, #40). Pure: data in,
 * anomaly records out. TZ is pinned to IST in jest.config.js.
 */
import {
    detectAnomalies, anomalyId, planAnomalyWrites, mergeAnomalies, summarizeAnomalies, buildDayReportText,
    filterAnomalies, presetRange, anomalyPatterns, istDayKey, istHour, addDaysToKey, istDayStartMs, summaryLine
} from '../utils/anomalies.js';

const T = (h, m = 0, d = 22) => new Date(2026, 9, d, h, m, 0).getTime(); // Oct 2026, IST
const DAY = { from: T(0, 0, 22), to: T(0, 0, 23) };
const RICE = { id: 'rice', name: 'Rice', saleRates: [40] };

function bill(over = {}) {
    const ts = 'timestamp' in over ? over.timestamp : T(11);
    return {
        id: 'b1', billNumber: 'R1', customerName: 'Ramesh', userId: 'u1', userName: 'Amit',
        items: [{ itemId: 'rice', name: 'Rice', rate: 40, qty: 10, total: 400 }],
        total: 400, payment: { cash: 400, online: 0, due: 0 },
        date: ts ? new Date(ts).toISOString() : '2026-10-22', timestamp: ts,
        ...over
    };
}

const run = (input) => detectAnomalies({ catalogue: [RICE], ...DAY, ...input });
const types = (list) => list.map(a => a.type).sort();

describe('IST day helpers', () => {
    test('day key and hour are IST', () => {
        expect(istDayKey(Date.UTC(2026, 9, 21, 19, 0))).toBe('2026-10-22'); // 00:30 IST
        expect(istHour(Date.UTC(2026, 9, 21, 19, 0))).toBe(0);
        expect(addDaysToKey('2026-11-01', -1)).toBe('2026-10-31');
        expect(istDayKey(istDayStartMs('2026-10-22'))).toBe('2026-10-22');
        expect(istDayKey(istDayStartMs('2026-10-22') - 1)).toBe('2026-10-21');
    });
});

describe('bill rules', () => {
    test('a clean bill has no anomalies', () => {
        expect(run({ bills: { retail: [bill()] } })).toEqual([]);
    });

    test('saved flags and overrides become anomalies with deterministic ids', () => {
        const b = bill({
            flags: [{ rule: 'oversell', en: 'Rice: selling 10 kg, only 2 kg', hi: 'h', by: 'u1', at: T(11) }],
            overrides: [{ rule: 'oversell', reason: 'truck unloading', by: 'own1', at: T(11) }]
        });
        const list = run({ bills: { retail: [b] }, stock: { rice: { quantity: 2, rate: 30 } } });
        expect(types(list)).toEqual(['override', 'oversell']);
        const ov = list.find(a => a.type === 'override');
        expect(ov.id).toBe(anomalyId('override', 'bill', 'b1'));
        expect(ov.severity).toBe('high');
        expect(ov.en).toContain('truck unloading');
        expect(ov).toEqual(expect.objectContaining({ refKind: 'bill', refId: 'b1', billType: 'retail', party: 'Ramesh', dayKey: '2026-10-22', hour: 11 }));
        expect(list.find(a => a.type === 'oversell').en).toBe('Rice: selling 10 kg, only 2 kg');
    });

    test('F15: "sold more than stock" is left out until stock of the item was first set', () => {
        const b = bill({ flags: [{ rule: 'oversell', en: 'Rice: selling 10 kg, only 0 kg', hi: 'h', by: 'u1', at: T(11) }] });
        expect(types(run({ bills: { retail: [b] } }))).toEqual([]);
        const opening = { id: 'a1', itemId: 'rice', itemName: 'Rice', adjustType: 'set', quantity: 50, rate: 30, reasonCode: 'opening', timestamp: T(12) };
        const oversells = (input) => types(run(input)).filter(x => x === 'oversell');
        expect(oversells({ bills: { retail: [b] }, adjustments: [opening] })).toEqual([]);
        const earlier = { ...opening, timestamp: T(9) };
        expect(oversells({ bills: { retail: [b] }, adjustments: [earlier] })).toEqual(['oversell']);
        const bought = { id: 'p1', items: [{ itemId: 'rice', name: 'Rice', qty: 5, rate: 30, total: 150 }], grandTotal: 150, total: 150, payment: { cash: 150 }, timestamp: T(8), date: new Date(T(8)).toISOString() };
        expect(oversells({ bills: { retail: [b], purchase: [bought] } })).toEqual(['oversell']);
    });
    test('re-check: payment that does not match the total (write-off still counts as paid)', () => {
        const bad = bill({ payment: { cash: 300, online: 0, due: 0 } });
        expect(types(run({ bills: { retail: [bad] } }))).toEqual(['payment-split']);
        const writtenOff = bill({ payment: { cash: 300, online: 0, due: 0, writtenOff: 100 } });
        expect(run({ bills: { retail: [writtenOff] } })).toEqual([]);
    });

    test('re-check: rate far from the usual rate of earlier bills; never against later bills', () => {
        const earlier = bill({ id: 'b0', timestamp: T(9), items: [{ itemId: 'rice', name: 'Rice', rate: 40, qty: 1, total: 40 }], total: 40, payment: { cash: 40 } });
        const high = bill({ id: 'b2', timestamp: T(12), items: [{ itemId: 'rice', name: 'Rice', rate: 100, qty: 1, total: 100 }], total: 100, payment: { cash: 100 } });
        const list = run({ bills: { retail: [high, earlier] } });
        expect(list.map(a => [a.type, a.refId, a.item])).toEqual([['rate-high', 'b2', 'Rice']]);
    });

    test('re-check: duplicate flags only the later of two identical bills', () => {
        const a = bill({ id: 'a', timestamp: T(11, 0) });
        const b = bill({ id: 'b', timestamp: T(11, 1) });
        expect(run({ bills: { retail: [a, b] } }).map(x => [x.type, x.refId])).toEqual([['duplicate', 'b']]);
    });

    test('stock-based rules are not re-run on saved bills (stock today ≠ stock then)', () => {
        const b = bill({ items: [{ itemId: 'rice', name: 'Rice', rate: 40, qty: 999, total: 39960 }], total: 39960, payment: { cash: 39960 } });
        expect(types(run({ bills: { retail: [b] } }))).not.toContain('oversell');
    });

    test('zero-rate line and round-number line', () => {
        const zero = bill({ id: 'z', items: [{ name: 'Rice', rate: 0, qty: 5, total: 0 }], total: 0, payment: { cash: 0 } });
        expect(types(run({ bills: { retail: [zero] } }))).toContain('rate-invalid');
        const round = bill({ id: 'r', items: [{ name: 'Dal', rate: 33.33, qty: 30, total: 1000 }], total: 1000, payment: { cash: 1000 } });
        expect(types(run({ bills: { retail: [round] } }))).toEqual(['rate-round']);
        const plain = bill({ id: 'p', items: [{ name: 'Dal', rate: 50, qty: 20, total: 1000 }], total: 1000, payment: { cash: 1000 } });
        expect(run({ bills: { retail: [plain] } })).toEqual([]);
    });

    test('night-time entry only from a real entry timestamp', () => {
        expect(types(run({ bills: { retail: [bill({ timestamp: T(23, 15) })] } }))).toEqual(['night-entry']);
        expect(types(run({ bills: { retail: [bill({ timestamp: T(3) })] } }))).toEqual(['night-entry']);
        expect(run({ bills: { retail: [bill({ timestamp: T(21, 59) })] } })).toEqual([]);
        expect(run({ bills: { retail: [bill({ timestamp: undefined, date: '2026-10-22' })] } })).toEqual([]);
    });

    test('old-bill edit and edit after payment are dated by the edit', () => {
        const old = bill({ timestamp: T(11, 0, 19), date: '19/10/2026, 11:00:00 am', editedAt: new Date(T(10)).toISOString(), editedBy: 'u2' });
        const list = run({ bills: { retail: [old] } });
        expect(types(list)).toEqual(['bill-old-edit']);
        expect(list[0]).toEqual(expect.objectContaining({ dayKey: '2026-10-22', userId: 'u2' }));

        const paid = bill({ editedAt: new Date(T(15)).toISOString(), payments: [{ id: 'p1', cash: 100, at: T(12) }] });
        expect(types(run({ bills: { retail: [paid] } }))).toEqual(['bill-edit-after-payment']);
        const paidLater = bill({ editedAt: new Date(T(12)).toISOString(), payments: [{ id: 'p1', cash: 100, at: T(15) }] });
        expect(run({ bills: { retail: [paidLater] } })).toEqual([]);
    });

    test('write-off (#104) on an older bill is reported on the write-off day', () => {
        const b = bill({
            timestamp: T(11, 0, 10), date: '10/10/2026',
            payment: { cash: 300, online: 0, due: 0, writtenOff: 100 },
            payments: [{ id: 'w', kind: 'writeOff', amount: 100, reason: 'party left town', at: T(14), recordedBy: 'Owner', recordedById: 'own1' }]
        });
        const list = run({ bills: { retail: [b] } });
        expect(list.map(a => [a.type, a.amount, a.user])).toEqual([['due-written-off', 100, 'Owner']]);
        expect(list[0].en).toContain('party left town');
    });

    test('bills outside the range are ignored; user names come from other loaded records', () => {
        const yesterday = bill({ timestamp: T(11, 0, 21), payment: { cash: 1, online: 0, due: 0 } });
        expect(run({ bills: { retail: [yesterday] } })).toEqual([]);
        const purchase = { ...bill({ id: 'p1', payment: { cash: 1, online: 0, due: 0 } }), userName: undefined, type: 'purchase' };
        const list = run({ bills: { purchase: [purchase], retail: [bill({ id: 'r9', timestamp: T(11, 0, 21) })] } });
        expect(list[0].user).toBe('Amit');
    });

    test('#147: a back-dated bill is found by when it was entered (enteredAt, else createdAt), not by its day', () => {
        const dated = (over) => bill({ timestamp: T(11, 0, 19), ...over });
        expect(run({ bills: { retail: [dated()] } })).toEqual([]);
        const byEntered = run({ bills: { retail: [dated({ enteredAt: T(11) })] } });
        expect(byEntered.map(a => [a.type, a.dayKey])).toEqual([['date-backdated', '2026-10-22']]);
        expect(types(run({ bills: { retail: [dated({ createdAt: { seconds: T(11) / 1000, nanoseconds: 0 } })] } }))).toEqual(['date-backdated']);
        // an old-app bill saved offline at 18:00 and synced at 01:00 (within 12 hours): its own time, nothing flagged
        const at = (ts, created) => bill({ timestamp: ts, createdAt: { seconds: created / 1000, nanoseconds: 0 } });
        const flags = (b) => types(run({ bills: { retail: [b] }, ownerIds: ['own1'], from: T(0, 0, 21), to: T(0, 0, 23) }));
        expect(flags(at(T(18, 0, 21), T(1, 0, 22)))).toEqual([]);
        // a bill without enteredAt dated a day back: the same time yesterday (even with the phone a second fast),
        // or yesterday evening entered this morning
        expect(flags(at(T(11, 0, 21) + 1000, T(11, 0, 22)))).toEqual(['date-backdated']);
        expect(flags(at(T(18, 0, 21), T(10, 0, 22)))).toEqual(['date-backdated']);
        // entered inside the range but dated today: nothing
        expect(run({ bills: { retail: [bill({ enteredAt: T(11), createdAt: { seconds: T(11) / 1000, nanoseconds: 0 } })] } })).toEqual([]);
    });

    test('#147: anyone but the owner is flagged from 1 day back; the owner (and unknown owners) from Q20', () => {
        const yesterday = bill({ timestamp: T(11, 0, 21), enteredAt: T(11), userId: 'u1' });
        expect(types(run({ bills: { retail: [yesterday] }, ownerIds: ['own1'] }))).toEqual(['date-backdated']);
        expect(run({ bills: { retail: [yesterday] }, ownerIds: ['u1'] })).toEqual([]);
        expect(run({ bills: { retail: [yesterday] } })).toEqual([]);
    });
});

describe('cash, stock and audit rules', () => {
    const session = (over) => ({ id: 's1', date: '2026-10-22', signedOut: true, counted: true, userId: 'u1', userName: 'Amit', signOutTime: new Date(T(20)).toISOString(), ...over });

    test('cash session mismatch beyond tolerance (Q19 bands)', () => {
        expect(run({ sessions: [session({ expectedBalance: 1000, closingBalance: 1030 })] })).toEqual([]);
        const mid = run({ sessions: [session({ expectedBalance: 1000, closingBalance: 900 })] });
        expect(mid.map(a => [a.type, a.amount, a.refKind])).toEqual([['cash-mismatch', -100, 'cash']]);
        expect(types(run({ sessions: [session({ expectedBalance: 1000, closingBalance: 500 })] }))).toEqual(['cash-mismatch-high']);
    });

    test('auto-closed uncounted session; open session ignored', () => {
        expect(types(run({ sessions: [session({ counted: false, signOutTime: undefined })] }))).toEqual(['cash-not-counted']);
        expect(run({ sessions: [session({ signedOut: false, expectedBalance: 1, closingBalance: 999 })] })).toEqual([]);
    });

    test('stock adjustments: large and without reason', () => {
        const adj = (over) => ({ id: 'a1', itemName: 'Rice', previousStock: 100, newStock: 70, reason: 'Physical count', timestamp: T(10), createdBy: 'u1', ...over });
        expect(types(run({ adjustments: [adj()] }))).toEqual(['stock-adjust-large']);
        expect(run({ adjustments: [adj({ newStock: 90 })] })).toEqual([]);
        expect(types(run({ adjustments: [adj({ newStock: 90, reason: ' ' })] }))).toEqual(['stock-adjust-no-reason']);
    });

    test('deletes from the audit log', () => {
        const logs = [
            { id: 'l1', action: 'DELETE_BILL', userId: 'u1', userName: 'Amit', timestamp: T(13), details: { billNumber: 'P7', amount: 500, customer: 'Shyam' } },
            { id: 'l2', action: 'CREATE_BILL', timestamp: T(13) },
            { id: 'l3', action: 'DELETE_EXPENSE', timestamp: T(14), details: { amount: 50 } }
        ];
        const list = run({ auditLogs: logs });
        expect(list.map(a => [a.type, a.refId, a.billNumber, a.party])).toEqual([
            ['bill-deleted', 'l1', 'P7', 'Shyam'], ['expense-deleted', 'l3', null, '']
        ]);
    });

    test('audit-based flags name the profile behind userId, not the stored name (#85)', () => {
        const logs = [{ id: 'l1', action: 'DELETE_BILL', userId: 'u1', userName: 'Owner', userRole: 'owner', timestamp: T(13), details: { amount: 500 } }];
        expect(run({ auditLogs: logs, people: [{ id: 'u1', name: 'Amit', role: 'staff' }] })[0]).toMatchObject({ userId: 'u1', user: 'Amit' });
        // no profiles (not the owner's scan): the stored name stays the fallback
        expect(run({ auditLogs: logs })[0].user).toBe('Owner');
    });

    test('a void is flagged (#75); deleting the voided bill afterwards is not flagged again', () => {
        const logs = [
            { id: 'l4', action: 'VOID_BILL', userId: 'u1', userName: 'Amit', timestamp: T(13), details: { billNumber: 'R9', billType: 'retail', amount: 500, customer: 'Shyam', reason: 'Entered twice' } },
            { id: 'l5', action: 'DELETE_SALE', userId: 'o', timestamp: T(14), details: { billNumber: 'R9', amount: 500, voided: true } }
        ];
        const list = run({ auditLogs: logs });
        expect(list.map(a => [a.type, a.refId, a.billNumber, a.party, a.severity])).toEqual([['bill-voided', 'l4', 'R9', 'Shyam', 'medium']]);
        expect([list[0].en, list[0].hi]).toEqual(['Bill #R9 voided (₹500) — Entered twice', 'बिल #R9 रद्द किया (₹500) — Entered twice']);
    });

    describe('voids by anyone but an owner are flagged, with the reason (#75)', () => {
        const voidedBill = (over = {}) => bill({
            id: 'v1', billNumber: 'R7', voided: true, voidedBy: 'u2', voidedByName: 'Ravi', voidedAt: { toDate: () => new Date(T(15)) },
            voidReason: '  Wrong   party ', ...over
        });
        const people = [{ id: 'o1', name: 'Owner', role: 'owner' }, { id: 'u2', name: 'Ravi K', role: 'staff' }];

        test('a loaded voided bill gives the flag at once, at the time of the void, without the audit log', () => {
            const [a, ...rest] = run({ voided: { retail: [voidedBill()] } });
            expect(rest).toEqual([]);
            expect(a).toMatchObject({
                id: 'bill-voided~bill~v1', type: 'bill-voided', severity: 'medium', refKind: 'bill', billType: 'retail',
                billNumber: 'R7', party: 'Ramesh', userId: 'u2', user: 'Ravi', amount: 400, at: T(15),
                en: 'Bill #R7 voided (₹400) — Wrong party', hi: 'बिल #R7 रद्द किया (₹400) — Wrong party'
            });
            expect(run({ voided: { retail: [voidedBill()] }, people })[0].user).toBe('Ravi K');
            // outside the scanned days: nothing
            expect(run({ voided: { retail: [voidedBill({ voidedAt: T(9, 0, 21) })] } })).toEqual([]);
        });

        test('an owner\'s void is no flag: from the profiles, the owners\' list, the owner looking, or the stored role', () => {
            const byOwner = { retail: [voidedBill({ voidedBy: 'o1' })] };
            expect(run({ voided: byOwner, people })).toEqual([]);
            expect(run({ voided: byOwner, ownerIds: ['o1'] })).toEqual([]);
            expect(run({ voided: byOwner, viewerOwnerId: 'o1' })).toEqual([]);
            expect(run({ voided: byOwner, ownerIds: ['o2'], viewerOwnerId: 'o1' })).toHaveLength(1);
            const log = { id: 'l6', action: 'VOID_BILL', userId: 'o1', userRole: 'owner', timestamp: T(13), details: { billNumber: 'R9', amount: 5, reason: 'x' } };
            expect(run({ auditLogs: [log] })).toEqual([]);
            expect(run({ auditLogs: [{ ...log, userRole: 'staff' }], people })).toEqual([]);
            expect(run({ auditLogs: [{ ...log, userRole: 'owner' }], people: [{ id: 'o1', name: 'M', role: 'manager' }] })).toHaveLength(1);
        });

        test('the bill and its audit entry give one flag', () => {
            const log = {
                id: 'l7', action: 'VOID_BILL', userId: 'u2', userRole: 'staff', timestamp: T(15),
                details: { billId: 'v1', billNumber: 'R7', billType: 'retail', amount: 400, customer: 'Ramesh', reason: 'Wrong party' }
            };
            const both = run({ voided: { retail: [voidedBill()] }, auditLogs: [log] });
            expect(both.map(a => a.id)).toEqual(['bill-voided~bill~v1']);
            // a bill outside the loaded history: the entry alone still flags it, under the bill's id
            expect(run({ auditLogs: [log] }).map(a => [a.id, a.refKind, a.billType, a.en]))
                .toEqual([['bill-voided~bill~v1', 'bill', 'retail', 'Bill #R7 voided (₹400) — Wrong party']]);
        });
    });
});

describe('storage: idempotent ids and daily scan dedupe', () => {
    const detected = () => run({ bills: { retail: [bill({ payment: { cash: 1, online: 0, due: 0 } }), bill({ id: 'b2', timestamp: T(23) })] } });

    test('the same data always gives the same ids', () => {
        expect(detected().map(a => a.id)).toEqual(detected().map(a => a.id));
        expect(anomalyId('rate-high', 'bill', 'a/b')).toBe('rate-high~bill~a_b');
    });

    test('first scan creates open records; re-scan writes nothing; review fields are never overwritten', () => {
        const first = planAnomalyWrites(detected(), [], 1000);
        expect(first).toHaveLength(2);
        expect(first.every(w => w.isNew && w.data.status === 'open' && w.data.detectedAt === 1000)).toBe(true);

        const stored = first.map(w => ({ id: w.id, ...w.data, status: 'ok', note: 'checked', reviewedBy: 'own1' }));
        expect(planAnomalyWrites(detected(), stored, 2000)).toEqual([]);

        const changed = detected().map(a => (a.type === 'payment-split' ? { ...a, amount: 999 } : a));
        const upd = planAnomalyWrites(changed, stored, 3000);
        expect(upd).toHaveLength(1);
        expect(upd[0].isNew).toBe(false);
        expect(upd[0].data).not.toHaveProperty('status');
        expect(upd[0].data).not.toHaveProperty('detectedAt');
    });

    test('merge keeps stored review status and adds new detections as open', () => {
        const [a, b] = detected();
        const merged = mergeAnomalies([a, b], [{ ...a, status: 'fixed', note: 'n' }]);
        expect(merged.find(x => x.id === a.id).status).toBe('fixed');
        expect(merged.find(x => x.id === b.id).status).toBe('open');
    });
});

describe('report, filters and patterns', () => {
    const A = (over) => ({ id: Math.random().toString(36), type: 'rate-high', severity: 'medium', dayKey: '2026-10-22', hour: 10, item: 'Rice', party: 'Ramesh', user: 'Amit', status: 'open', amount: 100, ...over });

    test('summary counts by severity/type and top items', () => {
        const s = summarizeAnomalies([A(), A({ type: 'payment-split', severity: 'high', item: 'Rice, Dal' }), A({ status: 'ok', item: 'Dal' })]);
        expect(s.total).toBe(3);
        expect(s.open).toBe(2);
        expect(s.bySeverity).toEqual({ high: 1, medium: 2, low: 0 });
        expect(s.byType[0]).toEqual(expect.objectContaining({ type: 'rate-high', count: 2 }));
        expect(s.topItems).toEqual([{ name: 'Dal', count: 2 }, { name: 'Rice', count: 2 }]);
        expect(summaryLine([])).toContain('none');
    });

    test('day report text: totals and today\'s counts only; names cleaned', () => {
        const text = buildDayReportText({
            dayKey: '2026-10-22',
            today: [A({ party: '*Bold*\nName' })],
            totals: { sales: 1200, saleCount: 3, purchases: 500, purchaseCount: 1, expenses: 50, totalIn: 1200, totalOut: 550, dueReceived: 0, duePaid: 0 },
            shopName: 'Gupta Traders'
        });
        expect(text).toContain('Day report* — 22/10/2026');
        expect(text).toContain('Sales: ₹1,200 (3 bills)');
        expect(text).toContain('Anomalies: 1 (High 0, Medium 1, Low 0)');
        expect(text).toContain('Top parties: Bold Name (1)');
        expect(text).not.toMatch(/[\u0900-\u097F]/);
        expect(text).not.toContain('Yesterday');
        expect(text).not.toMatch(/staff/i);
        expect(buildDayReportText({ dayKey: '2026-10-22' })).toContain('Anomalies: none');
    });

    test('presets and filters', () => {
        expect(presetRange('7d', '2026-10-22')).toEqual({ from: '2026-10-16', to: '2026-10-22' });
        expect(presetRange('yesterday', '2026-10-01')).toEqual({ from: '2026-09-30', to: '2026-09-30' });
        const list = [A({ id: '1' }), A({ id: '2', dayKey: '2026-10-10' }), A({ id: '3', severity: 'high', type: 'payment-split' }),
            A({ id: '4', status: 'ok' }), A({ id: '5', item: 'Moong Dal', user: 'Ravi' })];
        const ids = (f) => filterAnomalies(list, f).map(a => a.id);
        expect(ids({ from: '2026-10-16', to: '2026-10-22', status: 'open' })).toEqual(['1', '3', '5']);
        expect(ids({ severity: 'high' })).toEqual(['3']);
        expect(ids({ type: 'payment-split', status: 'all' })).toEqual(['3']);
        expect(ids({ item: 'dal' })).toEqual(['5']);
        expect(ids({ user: 'Ravi' })).toEqual(['5']);
        expect(ids({ status: 'ok' })).toEqual(['4']);
    });

    test('patterns: per day by type, heatmap, by user, by hour, repeat offenders', () => {
        const list = [A({ dayKey: '2026-10-21', hour: 9 }), A({ hour: 9 }), A({ type: 'night-entry', severity: 'low', hour: 23, item: 'Dal', user: 'Ravi', party: '' })];
        const p = anomalyPatterns(list);
        expect(p.days).toEqual([
            { dayKey: '2026-10-21', total: 1, byType: { 'rate-high': 1 } },
            { dayKey: '2026-10-22', total: 2, byType: { 'rate-high': 1, 'night-entry': 1 } }
        ]);
        expect(p.heat.cells.Rice).toEqual({ 'rate-high': 2 });
        expect(p.heat.cells.Dal).toEqual({ 'night-entry': 1 });
        expect(p.byUser[0]).toEqual(expect.objectContaining({ name: 'Amit', count: 2 }));
        expect(p.byHour[9]).toBe(2);
        expect(p.byHour[23]).toBe(1);
        expect(p.repeat.items).toEqual([{ name: 'Rice', count: 2, days: 2, types: ['rate-high'] }]);
        expect(p.repeat.users.map(u => u.name)).toEqual(['Amit']);
        expect(p.repeat.parties.map(u => u.name)).toEqual(['Ramesh']);
    });
});
