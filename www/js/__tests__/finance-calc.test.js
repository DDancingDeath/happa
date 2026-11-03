/**
 * @fileoverview Finance engine (utils/finance-calc.js) behind Money: spec IDs
 * F1–F8, F11, COGS, AVG-COST, BILL-AT-SAVE, DUE-PAY, EXP-KIND, EXP-MODE, VOID,
 * OPENING and BILL-TIME in docs/calculations.md, worked by hand on a small week
 * (#160: these cases kill the mutants the oracle suites let through).
 */
import {
    billFields, billsInRange, computeFinanceSummary, pickReplayBase, profitByDay, stockMovement,
    STOCK_CHECK_TOLERANCE
} from '../utils/finance-calc.js';

const at = (day, hour = 10) => new Date(2026, 9, day, hour).getTime();
const FROM = at(5, 0);
const TO = at(10, 0);
const ITEMS = [{ id: 'rice', name: 'Rice', hindiName: 'चावल' }, { id: 'dal', name: 'Dal' }];
const line = (itemId, name, qty, rate, total = qty * rate) => ({ itemId, name, qty, rate, total });
const FULL = { state: {}, from: -Infinity };

describe('pickReplayBase: when the cost of goods sold (F2) can be worked out', () => {
    const checkpoint = { state: { rice: { quantity: 1, rate: 5, totalValue: 5 } }, asOf: at(3, 0) };

    test('a period starting at or after the stock checkpoint replays from it', () => {
        expect(pickReplayBase({ checkpoint, fullHistory: false, from: checkpoint.asOf }))
            .toEqual({ state: checkpoint.state, from: checkpoint.asOf });
        expect(pickReplayBase({ checkpoint, fullHistory: true, from: at(4) }))
            .toEqual({ state: checkpoint.state, from: checkpoint.asOf });
    });

    test('an earlier period needs the full history, replayed from empty stock', () => {
        expect(pickReplayBase({ checkpoint, fullHistory: true, from: checkpoint.asOf - 1 })).toEqual(FULL);
        expect(pickReplayBase({ checkpoint: null, fullHistory: true, from: at(1) })).toEqual(FULL);
    });

    test('otherwise the cost is not known yet', () => {
        expect(pickReplayBase({ checkpoint, fullHistory: false, from: checkpoint.asOf - 1 })).toBeNull();
        expect(pickReplayBase({ checkpoint: null, fullHistory: false, from: at(1) })).toBeNull();
    });
});

describe('billsInRange (BILL-TIME, VOID, OPENING)', () => {
    test('a bill counts from the first moment of the period up to, not including, its end', () => {
        const bills = [
            { id: 'start', timestamp: FROM, items: [] },
            { id: 'end', timestamp: TO, items: [] },
            { id: 'before', timestamp: FROM - 1, items: [] },
            { id: 'void', timestamp: at(6), voided: true, items: [] },
            { id: 'opening', timestamp: at(6), items: [], openingBalance: { amount: 500 } },
            { id: 'undated', items: [] }
        ];
        expect(billsInRange(bills, FROM, TO).map(b => b.id)).toEqual(['start']);
        expect(billsInRange(bills, -Infinity, Infinity).map(b => b.id)).toEqual(['start', 'end', 'before', 'undated']);
    });
});

describe('billFields: the bill a Money row comes from', () => {
    test('number, party and id, from current and older field names', () => {
        expect(billFields({ id: 0, billNo: 'W-9', customer: '  Ravi ', timestamp: at(3) }, 'wholesale'))
            .toEqual({ t: at(3), billId: '0', billType: 'wholesale', billNo: 'W-9', party: 'Ravi' });
        expect(billFields({ billNumber: 'P-1', billNo: 'old', customerName: '', supplierName: 'Mohan' }, 'purchase'))
            .toEqual({ t: null, billId: null, billType: 'purchase', billNo: 'P-1', party: 'Mohan' });
        expect(billFields({ id: 'r1', customerName: 'Asha', customer: 'old', supplierName: 'x', timestamp: at(4) }, 'retail').party)
            .toBe('Asha');
    });

    test('a missing bill gives an empty row', () => {
        expect(billFields(null, 'retail')).toEqual({ t: null, billId: null, billType: 'retail', billNo: '', party: '' });
    });
});

describe('stockMovement: F2 cost of goods sold, F6 stock value, F8 check line', () => {
    // Before the period: 10 kg rice at ₹100 and 4 kg dal at ₹80 (opening ₹1,320).
    // In it: 10 kg rice for ₹1,200 at its first moment (avg ₹110), 5 kg sold (COGS ₹550),
    // 2 kg added at ₹25 (+₹50, 17 kg for ₹1,700). At its end (so after it): 3 kg sold.
    const sources = () => ({
        purchases: [
            { id: 'p0', billNumber: 'P0', supplierName: 'Mohan', timestamp: at(1), items: [line('rice', 'Rice', 10, 100), line('dal', 'Dal', 4, 80)] },
            { id: 'p1', billNumber: 'P1', supplierName: 'Mohan', timestamp: FROM, items: [line('rice', 'Rice', 10, 120)] }
        ],
        wholesaleSales: [{ id: 'w1', billNumber: 'W-1', customerName: 'Asha', timestamp: at(7), items: [{ itemId: 'rice', name: 'Rice', quantity: 5, rate: 130, total: 650 }] }],
        retailSales: [{ id: 'r1', billNo: 'R-1', timestamp: TO, items: [line('rice', 'Rice', 3, 140)] }],
        stockAdjustments: [{ id: 'a1', itemId: 'rice', itemName: 'Rice', adjustType: 'add', quantity: 2, rate: 25, timestamp: at(8) }]
    });

    test('opening + purchases − COGS + adjustments = closing; "now" adds what came after', () => {
        const m = stockMovement({ base: FULL, sources: sources(), items: ITEMS, from: FROM, to: TO });
        expect(m).toEqual({
            opening: 1320, purchases: 1200, cogs: 550, adjustments: 50, closing: 2020, now: 1720, gap: 0, saleLines: 1,
            uncosted: { qty: 0, estimate: 0, unknownCost: 0 }, deficitRefilled: { qty: 0, value: 0 }
        });
    });

    test('with detail, every number comes with the rows it is made of', () => {
        const { detail } = stockMovement({ base: FULL, sources: sources(), items: ITEMS, from: FROM, to: TO, detail: true });
        const rice = { itemKey: 'rice', item: 'Rice', itemHi: 'चावल' };
        const dal = { itemKey: 'dal', item: 'Dal', itemHi: 'Dal' };
        expect(detail).toEqual({
            purchases: [{ key: 'p1', t: FROM, billId: 'p1', billType: 'purchase', billNo: 'P1', party: 'Mohan', ...rice, qty: 10, rate: 120, amount: 1200 }],
            cogs: [{ key: 'c2', t: at(7), billId: 'w1', billType: 'wholesale', billNo: 'W-1', party: 'Asha', ...rice, qty: 5, rate: 110, amount: 550 }],
            adjustments: [{ key: 'a3', t: at(8), ...rice, qty: 2, note: 'add', amount: 50 }],
            uncosted: [],
            opening: [
                { key: 'o:rice', t: null, ...rice, qty: 10, rate: 100, amount: 1000 },
                { key: 'o:dal', t: null, ...dal, qty: 4, rate: 80, amount: 320 }
            ],
            closing: [
                { key: 'z:rice', t: null, ...rice, qty: 17, rate: 100, amount: 1700 },
                { key: 'z:dal', t: null, ...dal, qty: 4, rate: 80, amount: 320 }
            ],
            now: [
                { key: 'n:rice', t: null, ...rice, qty: 14, rate: 100, amount: 1400 },
                { key: 'n:dal', t: null, ...dal, qty: 4, rate: 80, amount: 320 }
            ],
            gap: []
        });
    });

    test('without detail no rows are built', () => {
        expect(stockMovement({ base: FULL, sources: sources(), items: ITEMS, from: FROM, to: TO })).not.toHaveProperty('detail');
    });

    test('items with no value (none left, oversold, or added without a rate) are not stock value rows', () => {
        const s = {
            purchases: [], wholesaleSales: [],
            retailSales: [{ id: 'r', timestamp: at(1), items: [line('dal', 'Dal', 2, 50)] }],
            stockAdjustments: [{ itemId: 'rice', itemName: 'Rice', adjustType: 'add', quantity: 3, timestamp: at(1) }]
        };
        const m = stockMovement({ base: FULL, sources: s, items: ITEMS, detail: true });
        expect(m.closing).toBe(0);
        expect(m.detail.closing).toEqual([]);
        expect(m.detail.now).toEqual([]);
    });

    test('an undated correction counts only in "All" and has no time', () => {
        const s = { purchases: [], wholesaleSales: [], retailSales: [], stockAdjustments: [{ itemName: 'Dal', adjustType: 'set', quantity: 2, rate: 40 }] };
        const all = stockMovement({ base: FULL, sources: s, items: ITEMS, detail: true });
        expect(all.adjustments).toBe(80);
        expect(all.detail.adjustments).toEqual([{ key: 'a1', t: null, itemKey: 'dal', item: 'Dal', itemHi: 'Dal', qty: 2, note: 'set', amount: 80 }]);
        expect(stockMovement({ base: FULL, sources: s, items: ITEMS, from: FROM, to: TO }).adjustments).toBe(0);
    });

    test('a period starting before the replay base cannot be costed', () => {
        const base = { state: {}, from: at(3, 0) };
        expect(stockMovement({ base, sources: sources(), items: ITEMS, from: at(2) })).toBeNull();
        expect(stockMovement({ base: null, sources: sources(), items: ITEMS, from: FROM })).toBeNull();
        expect(stockMovement({ base, sources: sources(), items: ITEMS, from: base.from })).not.toBeNull();
    });

    test('goods sold before their purchase was entered: the gap is the refilled shortfall (F8)', () => {
        // 10 kg rice sold before the period with none in stock; in it 15 kg bought at ₹100
        // (10 refill the shortfall, ₹1,000 sunk), so the check line is off by ₹1,000.
        // Dal: 4 kg on hand, 8 sold in the period (4 uncosted), refilled after it at ₹90.
        // Moong (not in the catalogue) is sold without ever being bought: its cost is unknown.
        const s = {
            purchases: [
                { id: 'p0', timestamp: at(1), items: [line('dal', 'Dal', 4, 80)] },
                { id: 'p1', timestamp: at(6), items: [line('rice', 'Rice', 15, 100)] },
                { id: 'p2', timestamp: at(12), items: [line('dal', 'Dal', 10, 90)] }
            ],
            wholesaleSales: [],
            retailSales: [
                { id: 'r0', timestamp: at(2), items: [line('rice', 'Rice', 10, 120)] },
                { id: 'r1', billNo: 'R-1', customerName: 'Asha', timestamp: at(7), items: [line('dal', 'Dal', 8, 100)] },
                { id: 'r2', timestamp: at(8), items: [{ name: '  Moong ', qty: 3, rate: 90, total: 270 }] },
                { id: 'r3', timestamp: at(9), items: [{ name: 'MOONG', qty: 1, rate: 90, total: 90 }] }
            ],
            stockAdjustments: []
        };
        const m = stockMovement({ base: FULL, sources: s, items: ITEMS, from: FROM, to: TO, detail: true });
        expect(m).toMatchObject({
            opening: 320, purchases: 1500, cogs: 320, adjustments: 0, closing: 500, now: 1040, gap: 1000, saleLines: 3,
            uncosted: { qty: 8, estimate: 360, unknownCost: 4 }, deficitRefilled: { qty: 10, value: 1000 }
        });
        expect(m.detail.gap).toEqual([{ key: 'g:rice', t: null, itemKey: 'rice', item: 'Rice', itemHi: 'चावल', amount: 1000 }]);
        const moong = { itemKey: 'moong', item: 'Moong', itemHi: 'Moong' };
        expect(m.detail.uncosted).toEqual([
            { key: 'u3', t: at(7), billId: 'r1', billType: 'retail', billNo: 'R-1', party: 'Asha', itemKey: 'dal', item: 'Dal', itemHi: 'Dal', qty: 4, rate: 90, amount: 360 },
            { key: 'u4', t: at(8), billId: 'r2', billType: 'retail', billNo: '', party: '', ...moong, qty: 3, rate: 0, amount: 0 },
            { key: 'u5', t: at(9), billId: 'r3', billType: 'retail', billNo: '', party: '', ...moong, qty: 1, rate: 0, amount: 0 }
        ]);
        expect(m.detail.cogs.map(r => [r.key, r.item, r.qty, r.rate + 0, r.amount + 0])).toEqual([
            ['c2', 'Dal', 8, 40, 320], ['c3', 'Moong', 3, 0, 0], ['c4', 'Moong', 1, 0, 0]
        ]);
    });

    test('a purchase that only partly refills a shortfall: the refilled part is its kg', () => {
        const s = {
            purchases: [{ id: 'p', timestamp: at(6), items: [line('rice', 'Rice', 4, 100)] }],
            wholesaleSales: [], stockAdjustments: [],
            retailSales: [{ id: 'r', timestamp: at(2), items: [line('rice', 'Rice', 10, 120)] }]
        };
        const m = stockMovement({ base: FULL, sources: s, items: ITEMS, from: FROM, to: TO });
        expect(m.deficitRefilled).toEqual({ qty: 4, value: 400 });
        expect(m.gap).toBe(400);
    });

    test('uncosted kg are estimated at the next purchase rate of that item, else its last known cost', () => {
        // Chana: 10 kg sold with none in stock; then a ₹0 line, a dal purchase, and 4 kg at ₹50
        // (still 5 kg short); then 2 kg more sold, never refilled: last known cost ₹50.
        const s = {
            purchases: [
                { id: 'p1', timestamp: at(6, 11), items: [{ name: 'Chana', qty: 1, rate: 0, total: 0 }] },
                { id: 'p2', timestamp: at(6, 12), items: [line('dal', 'Dal', 1, 90)] },
                { id: 'p3', timestamp: at(6, 13), items: [{ name: 'Chana', qty: 4, rate: 50, total: 200 }] }
            ],
            wholesaleSales: [], stockAdjustments: [],
            retailSales: [
                { id: 'r1', timestamp: at(6, 10), items: [{ name: 'Chana', qty: 10, rate: 60, total: 600 }] },
                { id: 'r2', timestamp: at(7), items: [{ name: 'Chana', qty: 2, rate: 60, total: 120 }] }
            ]
        };
        const m = stockMovement({ base: FULL, sources: s, items: ITEMS, from: FROM, to: TO });
        expect(m.uncosted).toEqual({ qty: 12, estimate: 600, unknownCost: 0 });
    });

    test('from a stock checkpoint, uncosted kg take the average cost the checkpoint had', () => {
        const base = { state: { rice: { quantity: 5, rate: 100, totalValue: 500 }, dal: { quantity: 2, rate: 0, totalValue: 0 } }, from: at(3, 0) };
        const s = {
            purchases: [], wholesaleSales: [], stockAdjustments: [],
            retailSales: [{ id: 'r', timestamp: at(6), items: [line('rice', 'Rice', 8, 120), line('dal', 'Dal', 3, 90)] }]
        };
        const m = stockMovement({ base, sources: s, items: ITEMS, from: FROM, to: TO, detail: true });
        expect(m).toMatchObject({ opening: 500, cogs: 500, closing: 0, uncosted: { qty: 4, estimate: 300, unknownCost: 1 } });
        expect(m.detail.opening).toEqual([{ key: 'o:rice', t: null, itemKey: 'rice', item: 'Rice', itemHi: 'चावल', qty: 5, rate: 100, amount: 500 }]);
        expect(base.state.rice).toEqual({ quantity: 5, rate: 100, totalValue: 500 });
    });

    test('without a catalogue, rows are named by the first line name seen', () => {
        const s = {
            purchases: [{ id: 'p', timestamp: at(1), items: [{ name: ' Gur ', qty: 2, rate: 50, total: 100 }] }],
            wholesaleSales: [], stockAdjustments: [],
            retailSales: [{ id: 'r', timestamp: at(2), items: [{ name: 'GUR', qty: 1, rate: 60, total: 60 }] }]
        };
        const m = stockMovement({ base: FULL, sources: s, items: undefined, detail: true });
        expect(m.detail.now).toEqual([{ key: 'n:gur', t: null, itemKey: 'gur', item: 'Gur', itemHi: 'Gur', qty: 1, rate: 50, amount: 50 }]);
    });
});

describe('profitByDay: F4 per day', () => {
    test('sales − COGS − business expenses − bad debts on their own day; undated rows are left out', () => {
        const detail = {
            sales: [{ t: at(1), amount: 0.1 }, { t: at(1, 12), amount: 0.2 }, { t: at(2), amount: 500 }, { t: null, amount: 999 }],
            stock: { cogs: [{ t: at(2), amount: 300 }] },
            business: [{ t: at(3), amount: 40 }],
            badDebts: [{ t: at(2), amount: 50 }]
        };
        expect(profitByDay(detail, t => new Date(t).getDate())).toEqual({ 1: 0.3, 2: 150, 3: -40 });
    });

    test('no detail, no days', () => {
        expect(profitByDay(undefined, () => 'x')).toEqual({});
    });
});

describe('computeFinanceSummary: one week of a shop (F1–F8, F11)', () => {
    const iso = (t) => new Date(t).toISOString();
    const shop = () => ({
        purchases: [
            { id: 'p0', billNumber: 'P0', supplierName: 'Mohan', timestamp: at(1), items: [line('rice', 'Rice', 10, 100), line('dal', 'Dal', 4, 80)], grandTotal: 1320, payment: { cash: 1320, online: 0, due: 0 } },
            // ₹1,200 of rice less ₹30 labour; paid ₹500 cash + ₹300 online, ₹170 paid later
            { id: 'p1', billNumber: 'P1', supplierName: 'Mohan', timestamp: at(6), items: [line('rice', 'Rice', 10, 120)], laborCharges: 30, grandTotal: 1170,
                payment: { cash: 600, online: 370, due: 200 }, payments: [{ id: 'pp1', at: at(8), cash: 100, online: 70 }] },
            // all on due
            { id: 'p2', billNumber: 'P2', supplierName: 'Gopal', timestamp: at(9), items: [line('dal', 'Dal', 2, 80)], grandTotal: 160, payment: { cash: 0, online: 0, due: 160 } }
        ],
        wholesaleSales: [
            // ₹650 of rice with ₹10 off; ₹200 cash + ₹100 online at the sale, ₹100 paid later, ₹40 written off
            { id: 'w1', billNumber: 'W-1', customerName: 'Asha', timestamp: at(7), items: [{ itemId: 'rice', name: 'Rice', quantity: 5, rate: 130, total: 650 }], total: 640,
                payment: { cash: 240, online: 160, due: 200 },
                payments: [{ id: 'wp1', at: at(9), cash: 40, online: 60 }, { id: 'wo1', kind: 'writeOff', amount: 40, at: at(9, 12) }] },
            { id: 'wv', billNumber: 'W-V', customerName: 'Void', timestamp: at(7), voided: true, items: [line('rice', 'Rice', 1, 1000)], total: 1000, payment: { cash: 1000, online: 0, due: 0 } }
        ],
        retailSales: [
            { id: 'r1', billNo: 'R-1', timestamp: at(8), items: [line('dal', 'Dal', 1, 100)], total: 100, payment: { cash: 100, online: 0, due: 0 } },
            // nothing paid at the sale; ₹30 later
            { id: 'r2', billNo: 'R-2', customer: 'Ravi', timestamp: at(9), items: [line('rice', 'Rice', 1, 130)], total: 130,
                payment: { cash: 30, online: 0, due: 100 }, payments: [{ id: 'rp1', at: at(9, 15), cash: 30 }] },
            { id: 'ro', billNo: 'R-O', customerName: 'Old', timestamp: at(8), items: [], total: 0, payment: { cash: 0, online: 0, due: 5000 }, openingBalance: { amount: 5000 } },
            { id: 'r3', billNo: 'R-3', timestamp: TO, items: [line('rice', 'Rice', 2, 130)], total: 260, payment: { cash: 260, online: 0, due: 0 } }
        ],
        stockAdjustments: [{ id: 'a1', itemId: 'rice', itemName: 'Rice', adjustType: 'add', quantity: 2, rate: 25, timestamp: at(8) }]
    });
    const expenses = () => [
        { id: 'e1', date: iso(at(6)), amount: 300, category: 'business', type: 'Rent', remarks: 'Oct', paymentMode: 'online', personName: ' Landlord ' },
        { date: iso(at(7)), amount: 50, type: 'Tea' },
        { id: 'e3', date: iso(at(7)), amount: 200, category: 'Personal', type: 'Doctor' },
        { id: 'e4', date: iso(at(7)), amount: 999, category: 'business', voided: true },
        { id: 'e5', date: iso(at(2)), amount: 500, category: 'business' },
        { id: 'e6', amount: 70 }
    ];
    const withdrawals = () => [
        { date: iso(at(8)), amount: 1000, person: ' Owner ', purpose: 'Home', notes: 'cash' },
        { id: 'wd0', date: iso(at(2)), amount: 500 },
        { id: 'wd2', amount: 10 }
    ];
    // The Cash tab's legs: the same payment as w1's (counted once) and one on a bill no longer loaded
    const sessions = () => [{ id: 's1', duePayments: [
        { id: 'wp1', type: 'received', cash: 40, online: 60, at: at(9), billId: 'w1' },
        { id: 'leg2', type: 'received', cash: 50, at: at(8), customer: 'Old Party', billId: 'gone', billNumber: 'W-OLD' }
    ] }];
    const week = (over = {}) => computeFinanceSummary({
        sources: shop(), items: ITEMS, base: FULL, expenses: expenses(), withdrawals: withdrawals(), sessions: sessions(),
        from: FROM, to: TO, ...over
    });

    test('the headline figures, worked by hand', () => {
        const s = week();
        expect(s.sales).toEqual({ total: 870, count: 3, due: 300 });
        expect(s.purchases).toEqual({ total: 1330, count: 2, labour: 30 });
        expect(s.expenses).toEqual({ business: 350, businessCount: 2, personal: 200, personalCount: 1, uncategorised: 50, online: 300 });
        expect(s.withdrawn).toBe(1000);
        expect(s.cogs).toBe(730);
        expect(s.grossProfit).toBe(140);
        expect(s.badDebts).toBe(40);
        expect(s.profit).toBe(-250);
        expect(s.afterPersonal).toBe(-450);
        expect(s.afterWithdrawals).toBe(-1450);
        expect(s.cash).toEqual({ receivedAtSale: 400, dueReceived: 180, moneyIn: 580, paidAtPurchase: 800, duePaid: 170, moneyOut: 1520, net: -940 });
        expect(s.stock).toMatchObject({ opening: 1320, purchases: 1360, cogs: 730, adjustments: 50, closing: 2000, now: 1800, gap: 0 });
        expect(s).toMatchObject({ stockMismatch: false, mismatchFromEarlierSales: false, uncostedWarning: false, duesApproximate: false });
        expect(s).not.toHaveProperty('detail');
    });

    test('without a replay base the profit lines are not known, the rest still is', () => {
        const s = week({ base: null, duesComplete: false });
        expect(s).toMatchObject({ cogs: null, grossProfit: null, profit: null, afterPersonal: null, afterWithdrawals: null, stock: null });
        expect(s).toMatchObject({ stockMismatch: false, mismatchFromEarlierSales: false, uncostedWarning: false, duesApproximate: true });
        expect(s.sales.total).toBe(870);
        expect(s.cash.net).toBe(-940);
    });

    test('the rows behind every number add up to it', () => {
        const s = week({ detail: true });
        const d = s.detail;
        const asha = { t: at(7), billId: 'w1', billType: 'wholesale', billNo: 'W-1', party: 'Asha' };
        const p1 = { t: at(6), billId: 'p1', billType: 'purchase', billNo: 'P1', party: 'Mohan' };
        const r2 = { t: at(9), billId: 'r2', billType: 'retail', billNo: 'R-2', party: 'Ravi' };
        expect(d.sales).toEqual([
            { key: 's:wholesale:w1:0', ...asha, itemKey: 'rice', item: 'Rice', itemHi: 'चावल', qty: 5, rate: 130, amount: 650 },
            { key: 's:wholesale:w1:rest', ...asha, itemKey: '', item: '', itemHi: '', rest: true, amount: -10 },
            { key: 's:retail:r1:0', t: at(8), billId: 'r1', billType: 'retail', billNo: 'R-1', party: '', itemKey: 'dal', item: 'Dal', itemHi: 'Dal', qty: 1, rate: 100, amount: 100 },
            { key: 's:retail:r2:0', ...r2, itemKey: 'rice', item: 'Rice', itemHi: 'चावल', qty: 1, rate: 130, amount: 130 }
        ]);
        expect(d.business).toEqual([
            { key: 'e:e1', t: at(6), category: 'business', party: 'Landlord', note: 'Rent · Oct', amount: 300 },
            { key: 'e:1', t: at(7), category: '', party: '', note: 'Tea', amount: 50 }
        ]);
        expect(d.personal).toEqual([{ key: 'e:e3', t: at(7), category: 'personal', party: '', note: 'Doctor', amount: 200 }]);
        expect(d.withdrawn).toEqual([{ key: 'w:0', id: null, t: at(8), party: 'Owner', note: 'Home · cash', amount: 1000 }]);
        expect(d.receivedAtSale).toEqual([
            { key: 'pay:wholesale:w1', ...asha, cash: 200, online: 100, amount: 300 },
            { key: 'pay:retail:r1', t: at(8), billId: 'r1', billType: 'retail', billNo: 'R-1', party: '', cash: 100, online: 0, amount: 100 }
        ]);
        expect(d.paidAtPurchase).toEqual([{ key: 'pay:purchase:p1', ...p1, cash: 500, online: 300, amount: 800 }]);
        expect(d.dueReceived).toEqual([
            { key: 'due:rp1', ...r2, t: at(9, 15), cash: 30, online: 0, amount: 30 },
            { key: 'due:wp1', ...asha, t: at(9), cash: 40, online: 60, amount: 100 },
            { key: 'due:leg2', billId: null, billType: null, billNo: '', party: 'Old Party', t: at(8), cash: 50, online: 0, amount: 50 }
        ]);
        expect(d.duePaid).toEqual([{ key: 'due:pp1', ...p1, t: at(8), cash: 100, online: 70, amount: 170 }]);
        expect(d.badDebts).toEqual([{ key: 'wo:wo1', ...asha, t: at(9, 12), writeOff: true, amount: 40 }]);
        expect(d.labour).toEqual([{ key: 'lab:p1', ...p1, labour: true, amount: 30 }]);
        expect(d.stock).toBe(s.stock.detail);

        const sum = (rows) => rows.reduce((a, r) => a + r.amount, 0);
        expect(sum(d.sales)).toBe(s.sales.total);
        expect(sum(d.receivedAtSale) + sum(d.dueReceived)).toBe(s.cash.moneyIn);
        expect(sum(d.paidAtPurchase) + sum(d.duePaid) + sum(d.business) + sum(d.personal)).toBe(s.cash.moneyOut);
        const days = profitByDay(d, t => new Date(t).getDate());
        expect(days).toEqual({ 6: -300, 7: 40, 8: 20, 9: -10 });
        expect(Object.values(days).reduce((a, b) => a + b, 0)).toBe(s.profit);
    });

    test('a bill with no lines is one "rest" row of its whole total', () => {
        const sources = { purchases: [], wholesaleSales: [], stockAdjustments: [], retailSales: [{ id: 'old', timestamp: at(6), total: 75 }] };
        const s = computeFinanceSummary({ sources, items: ITEMS, base: FULL, from: FROM, to: TO, detail: true });
        expect(s.detail.sales).toEqual([
            { key: 's:retail:old:rest', t: at(6), billId: 'old', billType: 'retail', billNo: '', party: '', itemKey: '', item: '', itemHi: '', rest: true, amount: 75 }
        ]);
    });

    test('"All": open-ended by default, undated expenses and withdrawals count only there', () => {
        const all = week({ from: undefined, to: undefined });
        expect(all.sales.count).toBe(4);
        expect(all.expenses).toMatchObject({ business: 920, businessCount: 4 });
        expect(all.withdrawn).toBe(1510);
        const open = { sources: shop(), items: ITEMS, base: FULL, expenses: [{ amount: 70 }], withdrawals: [{ amount: 10 }] };
        expect(computeFinanceSummary({ ...open, to: TO }).expenses.business).toBe(0);
        expect(computeFinanceSummary({ ...open, from: FROM }).withdrawn).toBe(0);
    });

    test('no expenses, withdrawals or sessions given: nothing counted', () => {
        const s = computeFinanceSummary({ sources: shop(), items: ITEMS, base: FULL, detail: true });
        expect(s.expenses).toEqual({ business: 0, businessCount: 0, personal: 0, personalCount: 0, uncategorised: 0, online: 0 });
        expect(s.withdrawn).toBe(0);
        expect(s.detail.withdrawn).toEqual([]);
    });

    test('flags: stock check off by more than the tolerance, and why', () => {
        // 10 kg rice sold before the week with none in stock, refilled by 15 kg in it.
        const sources = {
            purchases: [{ id: 'p', timestamp: at(6), items: [line('rice', 'Rice', 15, 100)], grandTotal: 1500 }],
            wholesaleSales: [], stockAdjustments: [],
            retailSales: [{ id: 'r0', timestamp: at(2), items: [line('rice', 'Rice', 10, 120)], total: 1200 }]
        };
        const earlier = computeFinanceSummary({ sources, items: ITEMS, base: FULL, from: FROM, to: TO });
        expect(earlier.stock.gap).toBe(1000);
        expect(earlier).toMatchObject({ stockMismatch: true, mismatchFromEarlierSales: true, uncostedWarning: false });

        // The same shortfall sold inside the period: not "from earlier sales", and uncosted.
        const within = computeFinanceSummary({ sources, items: ITEMS, base: FULL, from: at(1), to: TO });
        expect(within).toMatchObject({ stockMismatch: true, mismatchFromEarlierSales: false, uncostedWarning: true });

        // A gap within the tolerance is not a mismatch.
        const small = {
            ...sources,
            purchases: [{ id: 'p', timestamp: at(6), items: [line('rice', 'Rice', 11, STOCK_CHECK_TOLERANCE)], grandTotal: 1100 }],
            retailSales: [{ id: 'r0', timestamp: at(2), items: [line('rice', 'Rice', 1, 120)], total: 120 }]
        };
        const s = computeFinanceSummary({ sources: small, items: ITEMS, base: FULL, from: FROM, to: TO });
        expect(s.stock.gap).toBe(STOCK_CHECK_TOLERANCE);
        expect(s).toMatchObject({ stockMismatch: false, mismatchFromEarlierSales: true });
    });
});
