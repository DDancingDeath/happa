/**
 * @fileoverview Rule engine for save-time / live bill checks (#37, #188).
 * Pure: every test passes the draft and context in; TZ is pinned to IST
 * in jest.config.js so the date rules are tested on Indian calendar days.
 */
import {
    DEFAULT_THRESHOLDS, normalizeThresholds, evaluateBill, saveGate, bannerText, canOverride,
    toFlags, toOverrides, buildCheckContext, stockCreditFor, evaluateCashCount, evaluateStockAdjustment, isEntryIssue
} from '../utils/bill-checks.js';

const NOW = new Date(2026, 9, 22, 12, 0, 0).getTime(); // 22 Oct 2026 12:00 IST
const RICE = { id: 'rice', name: 'Rice', hindiName: 'चावल', saleRates: [40], wholesaleRates: [38], rates: [30] };
const DAL = { id: 'dal', name: 'Dal' };

function ctx(over = {}) {
    return {
        kind: 'retail',
        now: NOW,
        thresholds: {},
        catalogue: [RICE, DAL],
        stock: { rice: { quantity: 100, rate: 30 }, dal: { quantity: 100, rate: 80 } },
        stockReady: true,
        credit: [],
        recentBills: [],
        oversellCanBlock: false,
        showCost: true,
        ...over
    };
}

function draft(over = {}) {
    return {
        kind: 'retail',
        isEdit: false,
        id: 'new1',
        items: [{ itemId: 'rice', name: 'Rice', rate: 40, qty: 10, total: 400 }],
        total: 400,
        payment: { cash: 400, online: 0, due: 0 },
        partyName: '',
        date: null,
        entry: null,
        ...over
    };
}

const ids = (issues) => issues.map(i => i.id);
const find = (issues, id) => issues.find(i => i.id === id);

describe('thresholds', () => {
    test('defaults are the #106 answers (2× rate, 5 kg oversell, 120 s duplicate, 60 min / 1 day dates, ₹50/₹200, 20 kg)', () => {
        expect(DEFAULT_THRESHOLDS).toEqual({
            oversellBlockKg: 5, rateMultiple: 2, duplicateWindowSec: 120, maxFutureMin: 60,
            backdateDays: 1, cashOkRs: 50, cashHighRs: 200, stockAdjustFlagKg: 20,
            deniedCount: 3, deniedWindowMin: 10
        });
    });

    test('blank, zero, negative or junk values fall back; valid ones win', () => {
        expect(normalizeThresholds({ rateMultiple: '3', oversellBlockKg: 0, cashOkRs: -1, maxFutureMin: 'x' }))
            .toEqual({ ...DEFAULT_THRESHOLDS, rateMultiple: 3 });
        expect(normalizeThresholds(undefined)).toEqual(DEFAULT_THRESHOLDS);
    });
});

describe('clean bill', () => {
    test('no issues', () => {
        expect(evaluateBill(draft(), ctx())).toEqual([]);
    });

    test('empty new bill shows nothing (no red banner before anything is typed)', () => {
        expect(evaluateBill(draft({ items: [], total: 0, payment: {} }), ctx())).toEqual([]);
    });
});

describe('line values', () => {
    test('rate 0 and qty 0 block and cannot be overridden', () => {
        const issues = evaluateBill(draft({ items: [{ itemId: 'rice', name: 'Rice', rate: 0, qty: 0, total: 0 }], total: 0, payment: { cash: 0 } }), ctx());
        expect(find(issues, 'rate-invalid')).toMatchObject({ field: 'items.0', severity: 'block', overridable: false, line: 0 });
        expect(find(issues, 'qty-invalid')).toMatchObject({ field: 'items.0', severity: 'block', overridable: false });
    });

    test('legacy lines without a stored rate/qty are not judged (item/quantity/amount shapes)', () => {
        const legacy = { item: 'Rice', amount: 400 };
        expect(ids(evaluateBill(draft({ items: [legacy] }), ctx()))).toEqual([]);
        const legacyQty = { item: 'Rice', quantity: '10', rate: '40', amount: 400 };
        expect(ids(evaluateBill(draft({ items: [legacyQty] }), ctx()))).toEqual([]);
    });
});

describe('rate sanity (2× / ½× the usual rate, owner-confirmed 2×)', () => {
    const line = (rate) => [{ itemId: 'rice', name: 'Rice', rate, qty: 10, total: rate * 10 }];
    const bill = (rate) => draft({ items: line(rate), total: rate * 10, payment: { cash: rate * 10 } });

    test('usual = item saved rate for the bill kind when there is no history', () => {
        expect(ids(evaluateBill(bill(80), ctx()))).toEqual([]); // exactly 2× is fine
        const high = find(evaluateBill(bill(81), ctx()), 'rate-high');
        expect(high).toMatchObject({ severity: 'warn', field: 'items.0', overridable: false });
        expect(high.en).toBe('Rate ₹81.00 is 2.0× the usual ₹40.00');
        expect(high.hi).toContain('गुना');
        const cheap = ctx({ stock: { rice: { quantity: 100, rate: 1 } } });
        expect(ids(evaluateBill(bill(20), cheap))).toEqual([]); // exactly ½ is fine
        expect(ids(evaluateBill(bill(19), cheap))).toEqual(['rate-low']);
    });

    test('purchase uses the purchase rate list, wholesale the wholesale list', () => {
        const p = draft({ kind: 'purchase', items: line(61), total: 610, payment: { cash: 610 } });
        expect(ids(evaluateBill(p, ctx({ kind: 'purchase' })))).toEqual(['rate-high']);
        const w = draft({ kind: 'wholesale', items: line(77), total: 770, payment: { cash: 770 } });
        expect(ids(evaluateBill(w, ctx()))).toEqual(['rate-high']);
    });

    test('the last billed rate of this kind wins over the saved rate (newest by timestamp, any line shape)', () => {
        const recentBills = [
            { id: 'old', timestamp: NOW - 86400000 * 5, items: [{ itemId: 'rice', rate: 100, qty: 1 }] },
            { id: 'new', timestamp: NOW - 86400000, items: [{ itemId: 'rice', rate: 90, quantity: 2, total: 180 }] }
        ];
        expect(ids(evaluateBill(bill(80), ctx({ recentBills })))).toEqual([]);
        expect(find(evaluateBill(bill(181), ctx({ recentBills })), 'rate-high').en).toContain('usual ₹90.00');
    });

    test('an edited bill is not its own "usual" rate', () => {
        const recentBills = [{ id: 'e1', timestamp: NOW, items: [{ itemId: 'rice', rate: 200, qty: 1 }] }];
        const d = bill(200);
        expect(ids(evaluateBill({ ...d, isEdit: true, id: 'e1' }, ctx({ recentBills })))).toEqual(['rate-high']);
    });
});

describe('sale below average cost', () => {
    const below = draft({ items: [{ itemId: 'dal', name: 'Dal', rate: 70, qty: 1, total: 70 }], total: 70, payment: { cash: 70 } });

    test('retail and wholesale warn; purchase never', () => {
        expect(find(evaluateBill(below, ctx()), 'below-cost')).toMatchObject({ severity: 'warn', en: 'Selling below average cost ₹80.00' });
        expect(ids(evaluateBill({ ...below, kind: 'wholesale' }, ctx()))).toContain('below-cost');
        expect(ids(evaluateBill({ ...below, kind: 'purchase' }, ctx({ kind: 'purchase' })))).not.toContain('below-cost');
    });

    test('cost figure only for owner/manager (#84 open)', () => {
        const issue = find(evaluateBill(below, ctx({ showCost: false })), 'below-cost');
        expect(issue.en).toBe('Selling below cost — check the rate');
        expect(issue.en + issue.hi).not.toMatch(/80/);
    });
});

describe('oversell', () => {
    const sale = (qty, over = {}) => draft({
        items: [{ itemId: 'rice', name: 'Rice', rate: 40, qty: qty / 2, total: qty * 20 }, { name: 'चावल', rate: 40, qty: qty / 2, total: qty * 20 }],
        total: qty * 40, payment: { cash: qty * 40 }, ...over
    });

    test('wholesale: up to the 5 kg limit warns, beyond it blocks (overridable); lines aggregate by item incl. Hindi name', () => {
        const warn = find(evaluateBill(sale(105, { kind: 'wholesale' }), ctx({ oversellCanBlock: true })), 'oversell');
        expect(warn).toMatchObject({ severity: 'warn', field: 'items', lines: [0, 1] });
        expect(warn.en).toBe('Rice: selling 105 kg, only 100 kg in stock (short 5 kg)');
        const block = find(evaluateBill(sale(106, { kind: 'wholesale' }), ctx({ oversellCanBlock: true })), 'oversell');
        expect(block).toMatchObject({ severity: 'block', overridable: true });
    });

    test('stock from data the server has not confirmed yet only warns, with a note (#59)', () => {
        const c = ctx({ oversellCanBlock: true, stockUnconfirmed: true });
        const issue = find(evaluateBill(sale(200, { kind: 'wholesale' }), c), 'oversell');
        expect(issue.severity).toBe('warn');
        expect(issue.en).toBe('Rice: selling 200 kg, only 100 kg in stock (short 100 kg) — stock not yet confirmed by the server');
        expect(issue.hi).toMatch(/स्टॉक अभी सर्वर से पक्का नहीं हुआ$/);
        expect(buildCheckContext({ dataFreshness: 'cache' }, 'wholesale').stockUnconfirmed).toBe(true);
        expect(buildCheckContext({ dataFreshness: 'server' }, 'wholesale').stockUnconfirmed).toBe(false);
        expect(buildCheckContext({}, 'wholesale').stockUnconfirmed).toBe(false);
    });

    test('retail only warns however big the shortfall (retail reduces stock, #33; no block limit)', () => {
        expect(find(evaluateBill(sale(500), ctx()), 'oversell').severity).toBe('warn');
    });

    test('limit comes from the thresholds', () => {
        const c = ctx({ oversellCanBlock: true, thresholds: { oversellBlockKg: 10 } });
        expect(find(evaluateBill(sale(108, { kind: 'wholesale' }), c), 'oversell').severity).toBe('warn');
    });

    test('editing: the saved copy of the bill is counted back into stock', () => {
        const credit = [{ itemId: 'rice', quantity: 20 }];
        expect(ids(evaluateBill(sale(110, { isEdit: true }), ctx({ credit })))).not.toContain('oversell');
    });

    test('no check while stock is still being calculated', () => {
        expect(ids(evaluateBill(sale(500), ctx({ stockReady: false })))).not.toContain('oversell');
    });

    test('purchase never oversells', () => {
        expect(ids(evaluateBill(sale(500, { kind: 'purchase' }), ctx({ kind: 'purchase' })))).not.toContain('oversell');
    });
});

describe('payment and name (moved from the save paths, behaviour unchanged)', () => {
    test('no payment at all blocks a new bill (and hides the split message)', () => {
        const issues = evaluateBill(draft({ payment: {} }), ctx());
        expect(ids(issues)).toEqual(['payment-none']);
        expect(issues[0]).toMatchObject({ field: 'payment', severity: 'block', overridable: false });
        expect(issues[0].en).toBe('Please enter at least one payment method (Cash, Online, or Due)');
    });

    test('edits are not checked for "no payment" but still for the split, even with no lines', () => {
        expect(ids(evaluateBill(draft({ isEdit: true, items: [], total: 0, payment: {} }), ctx()))).toEqual([]);
        expect(ids(evaluateBill(draft({ isEdit: true, items: [], total: 0, payment: { cash: 50 } }), ctx()))).toEqual(['payment-split']);
    });

    test('Due without a name blocks with the #68 message split into EN / HI', () => {
        const issue = find(evaluateBill(draft({ payment: { due: 400 }, partyName: '  ' }), ctx()), 'party-required');
        expect(issue).toMatchObject({ field: 'party', severity: 'block', overridable: false });
        expect(issue.en).toBe('Enter the name — a bill with Due needs a customer/supplier name.');
        expect(issue.hi).toMatch(/^नाम लिखें/);
    });

    test('split off by more than ₹1 blocks with the #23 message; ₹1 is tolerated', () => {
        expect(ids(evaluateBill(draft({ payment: { cash: 399 } }), ctx()))).toEqual([]);
        const issue = find(evaluateBill(draft({ payment: { cash: 300 } }), ctx()), 'payment-split');
        expect(issue.en).toBe('Cash + Online + Due is ₹100 less than the bill total. Add ₹100 to Cash, Online or Due.');
        expect(issue.hi).toContain('₹100 कम');
    });

    test('blocks come before warnings, in the old save order', () => {
        const issues = evaluateBill(draft({
            items: [{ itemId: 'rice', name: 'Rice', rate: 90, qty: 10, total: 900 }], total: 900,
            payment: { cash: 100, due: 100 }
        }), ctx());
        expect(ids(issues)).toEqual(['party-required', 'payment-split', 'rate-high']);
    });
});

describe('duplicate bill (same party + items + total within 120 s)', () => {
    const saved = (over = {}) => ({
        id: 's1', billNumber: 'S1', customerName: 'Sita ', timestamp: NOW - 60000, total: 400,
        items: [{ itemId: 'rice', name: 'Rice', rate: 40, quantity: 10, total: 400 }], ...over
    });
    const d = draft({ partyName: 'sita' });

    test('warns within the window, naming the earlier bill', () => {
        const issue = find(evaluateBill(d, ctx({ recentBills: [saved()] })), 'duplicate');
        expect(issue).toMatchObject({ field: 'bill', severity: 'warn' });
        expect(issue.en).toBe('Same bill was saved 60 s ago (S1) — is this a duplicate?');
    });

    test('no warning outside the window, for a different total/items/party, for the same id or for an edit', () => {
        expect(ids(evaluateBill(d, ctx({ recentBills: [saved({ timestamp: NOW - 121000 })] })))).toEqual([]);
        expect(ids(evaluateBill(d, ctx({ recentBills: [saved({ total: 401 })] })))).toEqual([]);
        expect(ids(evaluateBill(d, ctx({ recentBills: [saved({ items: [{ itemId: 'rice', rate: 40, qty: 9 }] })] })))).toEqual([]);
        expect(ids(evaluateBill(d, ctx({ recentBills: [saved({ customerName: 'Gita' })] })))).toEqual([]);
        expect(ids(evaluateBill(d, ctx({ recentBills: [saved({ id: 'new1' })] })))).toEqual([]);
        expect(ids(evaluateBill({ ...d, isEdit: true }, ctx({ recentBills: [saved()] })))).toEqual([]);
    });

    test('purchase bills compare grandTotal', () => {
        const p = draft({ kind: 'purchase', partyName: 'sita' });
        const bill = saved({ total: undefined, grandTotal: 400, items: [{ itemId: 'rice', rate: 40, qty: 10, total: 400 }] });
        expect(ids(evaluateBill(p, ctx({ kind: 'purchase', recentBills: [bill] })))).toEqual(['duplicate']);
    });
});

describe('bill date vs entry time (IST)', () => {
    const at = (date, enteredAt = NOW) => ids(evaluateBill(draft({ date, enteredAt }), ctx()));

    test('more than 60 min ahead warns; 59 min does not', () => {
        expect(at(new Date(NOW + 59 * 60000).toISOString())).toEqual([]);
        expect(at(new Date(NOW + 61 * 60000).toISOString())).toEqual(['date-future']);
    });

    test('more than 1 calendar day back warns, by IST day (late night entry is not a day back)', () => {
        expect(at('21/10/2026, 11:59:00 pm')).toEqual([]);
        expect(at('20/10/2026, 11:59:00 pm')).toEqual(['date-backdated']);
        expect(at('2026-10-20')).toEqual(['date-backdated']);
        // 00:30 IST on the 22nd is still the 21st in UTC — must count as the same day
        expect(at('2026-10-21T19:00:00.000Z', new Date(2026, 9, 22, 1, 0).getTime())).toEqual([]);
    });

    test('#147: anyone but the owner is flagged from 1 day back', () => {
        const by = (ownerEntry, date) => ids(evaluateBill(draft({ date, enteredAt: NOW }), ctx({ ownerEntry })));
        expect(by(false, '21/10/2026, 11:59:00 pm')).toEqual(['date-backdated']);
        expect(by(true, '21/10/2026, 11:59:00 pm')).toEqual([]);
        expect(by(false, new Date(NOW).toISOString())).toEqual([]);
    });

    test('a stored bill is judged against when it was entered (for the anomaly list)', () => {
        expect(at('2026-10-10', new Date(2026, 9, 10, 18, 0).getTime())).toEqual([]);
    });
});

describe('line being typed (entry)', () => {
    test('typed rate is checked live but never gates Save', () => {
        const issues = evaluateBill(draft({ entry: { itemId: 'rice', name: 'Rice', rate: 0, qty: null } }), ctx());
        expect(issues).toEqual([expect.objectContaining({ id: 'rate-invalid', field: 'entry.rate' })]);
        expect(isEntryIssue(issues[0])).toBe(true);
        expect(saveGate(issues)).toEqual({ blocks: [], hardBlocks: [], warns: [] });
    });

    test('blank typed values are "not entered yet"', () => {
        expect(evaluateBill(draft({ entry: { itemId: 'rice', rate: null, qty: null } }), ctx())).toEqual([]);
    });

    test('wholesale: typed quantity over stock (with lines already on the bill) is flagged on the quantity box', () => {
        const d = draft({ kind: 'wholesale', entry: { itemId: 'rice', name: 'Rice', rate: 40, qty: 96 } });
        const issue = find(evaluateBill(d, ctx({ oversellCanBlock: true })), 'oversell');
        expect(issue).toMatchObject({ field: 'entry.qty', severity: 'block' });
    });
});

describe('save helpers', () => {
    const issues = [
        { id: 'payment-split', severity: 'block', overridable: false, field: 'payment', en: 'a', hi: 'b' },
        { id: 'oversell', severity: 'block', overridable: true, field: 'items', en: 'c', hi: 'd' },
        { id: 'oversell', severity: 'block', overridable: true, field: 'items', en: 'e', hi: 'f' },
        { id: 'rate-high', severity: 'warn', field: 'items.0', en: 'g', hi: 'h' },
        { id: 'rate-low', severity: 'warn', field: 'entry.rate', en: 'i', hi: 'j' }
    ];

    test('saveGate splits hard blocks, overridable blocks and warnings; entry issues ignored', () => {
        const gate = saveGate(issues);
        expect(gate.blocks).toHaveLength(3);
        expect(ids(gate.hardBlocks)).toEqual(['payment-split']);
        expect(ids(gate.warns)).toEqual(['rate-high']);
    });

    test('flags and overrides (one override per rule)', () => {
        expect(toFlags([issues[3]], 'u1', 5)).toEqual([{ rule: 'rate-high', en: 'g', hi: 'h', by: 'u1', at: 5 }]);
        expect(toOverrides([issues[1], issues[2]], '  truck arriving ', 'u1', 7))
            .toEqual([{ rule: 'oversell', reason: 'truck arriving', by: 'u1', at: 7 }]);
    });

    test('banner text, singular and plural, EN + HI', () => {
        expect(bannerText(1)).toEqual({ en: '1 problem — check before saving', hi: '1 समस्या — सेव करने से पहले देखें' });
        expect(bannerText(2)).toEqual({ en: '2 problems — check before saving', hi: '2 समस्याएँ — सेव करने से पहले देखें' });
    });

    test('only owner and manager may save past a block', () => {
        expect([canOverride('owner'), canOverride('manager'), canOverride('staff'), canOverride(undefined)])
            .toEqual([true, true, false, false]);
    });
});

describe('buildCheckContext', () => {
    const state = {
        items: [RICE], stock: { rice: { quantity: 1 } }, stockReady: false, userRole: 'staff',
        purchaseHistory: ['p'], retailSalesHistory: ['r'], salesHistory: ['w'],
        settings: { checkThresholds: { rateMultiple: 3 } }
    };

    test('history per kind, wholesale-only oversell block, cost hidden from members, thresholds from settings', () => {
        const r = buildCheckContext(state, 'retail', { now: 1 });
        expect(r).toMatchObject({ now: 1, recentBills: ['r'], oversellCanBlock: false, showCost: false, stockReady: false, credit: [] });
        expect(r.thresholds.rateMultiple).toBe(3);
        expect(buildCheckContext(state, 'purchase').recentBills).toEqual(['p']);
        const w = buildCheckContext({ ...state, userRole: 'manager' }, 'wholesale', { editingBill: { items: ['x'] } });
        expect(w).toMatchObject({ recentBills: ['w'], oversellCanBlock: true, showCost: true, credit: ['x'] });
    });

    test('a retried new bill already in history (and stock) is credited by its id; others are not', () => {
        const s = { ...state, stock: { rice: { quantity: 20, rate: 30 } }, stockReady: true, salesHistory: [
            { id: 'other', items: [{ itemId: 'rice', qty: 5 }] },
            { id: 'pend1', items: [{ itemId: 'rice', quantity: 30 }] }
        ] };
        expect(stockCreditFor(s, 'wholesale', { draftId: 'pend1' })).toEqual([{ itemId: 'rice', quantity: 30 }]);
        expect(stockCreditFor(s, 'wholesale', { draftId: 'nope' })).toEqual([]);
        expect(stockCreditFor(s, 'retail', { draftId: 'pend1' })).toEqual([]);
        const sale = draft({ kind: 'wholesale', id: 'pend1', items: [{ itemId: 'rice', name: 'Rice', rate: 40, qty: 30, total: 1200 }], total: 1200, payment: { cash: 1200 } });
        expect(ids(evaluateBill(sale, buildCheckContext(s, 'wholesale', { now: NOW, draftId: 'pend1' })))).toEqual([]);
        expect(find(evaluateBill(sale, buildCheckContext(s, 'wholesale', { now: NOW })), 'oversell').severity).toBe('block');
    });

    test('#129 approximate stock (stale checkpoint on a member device): wholesale oversell only warns and says so', () => {
        const s = { ...state, stock: { rice: { quantity: 20, rate: 30 } }, stockReady: true, salesHistory: [] };
        const sale = draft({ kind: 'wholesale', items: [{ itemId: 'rice', name: 'Rice', rate: 40, qty: 50, total: 2000 }], total: 2000, payment: { cash: 2000 } });
        expect(find(evaluateBill(sale, buildCheckContext(s, 'wholesale', { now: NOW })), 'oversell').severity).toBe('block');
        const approx = { ...s, stockApprox: { builtAt: NOW - 3600000, asOf: 0 } };
        const o = find(evaluateBill(sale, buildCheckContext(approx, 'wholesale', { now: NOW })), 'oversell');
        expect(o.severity).toBe('warn');
        expect(o.en).toContain('approximate stock (updated');
        expect(o.hi).toContain('अनुमानित स्टॉक');
    });
});

describe('cash count bands (Q19) and stock adjustment size (Q17)', () => {
    test('≤ ₹50 fine, up to ₹200 mismatch, above ₹200 high; never blocks', () => {
        expect(evaluateCashCount({ expected: 1000, counted: 950 })).toEqual([]);
        expect(ids(evaluateCashCount({ expected: 1000, counted: 949 }))).toEqual(['cash-mismatch']);
        const high = evaluateCashCount({ expected: 1000, counted: 1201 });
        expect(high).toEqual([expect.objectContaining({ id: 'cash-mismatch-high', severity: 'warn' })]);
        expect(high[0].en).toBe('Cash is ₹201 extra — big difference, count again');
    });

    test('expected drawer below ₹0 is flagged', () => {
        expect(ids(evaluateCashCount({ expected: -10, counted: -10 }))).toEqual(['cash-expected-negative']);
    });

    test('adjustments above 20 kg (either direction) are flagged', () => {
        expect(evaluateStockAdjustment(20)).toEqual([]);
        expect(ids(evaluateStockAdjustment(-20.5))).toEqual(['stock-adjust-large']);
        expect(evaluateStockAdjustment(25, { stockAdjustFlagKg: 30 })).toEqual([]);
    });
});

test('no message ever says "staff" (owner wording rule)', () => {
    const all = [
        ...evaluateBill(draft({ payment: { due: 1 }, items: [{ itemId: 'dal', rate: 0, qty: 0 }] }), ctx({ showCost: false })),
        ...evaluateCashCount({ expected: -500, counted: 0 }),
        ...evaluateStockAdjustment(100)
    ];
    expect(all.length).toBeGreaterThan(3);
    all.forEach(i => expect(`${i.en} ${i.hi}`).not.toMatch(/staff|स्टाफ/i));
});

describe('cost-unknown (#102, Q58): wholesale lines need an average cost', () => {
    const ws = (items, over = {}) => evaluateBill(draft({ kind: 'wholesale', items, total: 400, payment: { cash: 400, online: 0, due: 0 }, ...over }),
        ctx({ kind: 'wholesale', oversellCanBlock: true, ...over.ctx }));

    test('a line whose item has no rate in stock asks for a confirm (one warning per line); known lines and other kinds do not', () => {
        const issues = ws([{ itemId: 'rice', name: 'Rice', rate: 40, qty: 1, total: 40 }, { itemId: 'gone', name: 'Maize', rate: 20, qty: 18, total: 360 }]);
        expect(find(issues, 'cost-unknown')).toMatchObject({ severity: 'warn', field: 'items.1', line: 1 });
        expect(find(issues, 'cost-unknown').en).toBe('Maize: average cost not known (no stock) — this bill is saved without a profit');
        expect(issues.filter(i => i.id === 'cost-unknown')).toHaveLength(1);
        expect(ids(evaluateBill(draft({ items: [{ itemId: 'gone', name: 'Maize', rate: 20, qty: 1, total: 20 }] }), ctx()))).not.toContain('cost-unknown');
    });

    test('found by name / Hindi name like the stock replay; wording for stock without a rate and while stock loads; none on an edit', () => {
        expect(ids(ws([{ name: 'चावल', rate: 40, qty: 10, total: 400 }]))).not.toContain('cost-unknown');
        const unknown = [{ itemId: 'dal', name: 'Dal', rate: 90, qty: 1, total: 90 }];
        expect(find(ws(unknown, { ctx: { stock: { dal: { quantity: 50, rate: 0 } } } }), 'cost-unknown').en).toContain('(its stock has no rate)');
        expect(find(ws(unknown, { ctx: { stock: { dal: { quantity: 0, rate: 0 } } } }), 'cost-unknown').en).toContain('(no stock)');
        // While stock loads nothing has a cost yet: every line warns, even one with a rate
        expect(find(ws([{ itemId: 'rice', name: 'Rice', rate: 40, qty: 1, total: 40 }], { ctx: { stockReady: false } }), 'cost-unknown'))
            .toMatchObject({ severity: 'warn', en: 'Rice: average cost not known yet (stock is still loading) — this bill is saved without a profit' });
        expect(ids(ws(unknown, { isEdit: true, ctx: { stock: {} } }))).not.toContain('cost-unknown');
    });
});
// Edge cases the mutation run (#160) showed no test pinned: each one fails if a
// comparison, a fallback or a filter in bill-checks.js is changed.
describe('rule edges (mutation score, #160)', () => {
    const dalLine = (rate, over = {}) => ({ itemId: 'dal', name: 'Dal', rate, qty: 1, total: rate, ...over });
    const dalBill = (rate, over = {}) => draft({ items: [dalLine(rate)], total: rate, payment: { cash: rate }, ...over });
    const billOf = (id, ts, lines) => ({ id, timestamp: ts, items: lines });

    test('no usual rate (no history, no saved rate) means no rate warning', () => {
        expect(ids(evaluateBill(dalBill(100), ctx()))).not.toContain('rate-high');
    });

    test('usual rate: newest bill wins, the first of equal times wins, rate-0 and nameless lines are skipped', () => {
        const recent = [billOf('a', 2, [dalLine(80)]), billOf('b', 1, [dalLine(300)])];
        expect(ids(evaluateBill(dalBill(200), ctx({ recentBills: recent })))).toContain('rate-high');
        const same = [billOf('a', 5, [dalLine(80)]), billOf('b', 5, [dalLine(300)])];
        expect(ids(evaluateBill(dalBill(200), ctx({ recentBills: same })))).toContain('rate-high');
        const zero = [billOf('a', 1, [dalLine(80)]), billOf('b', 2, [dalLine(0)])];
        expect(ids(evaluateBill(dalBill(200), ctx({ recentBills: zero })))).toContain('rate-high');
        const nameless = [billOf('a', 1, [{ rate: 10, qty: 1, total: 10 }])];
        const d = draft({ items: [{ rate: 100, qty: 1, total: 100 }], total: 100, payment: { cash: 100 } });
        expect(ids(evaluateBill(d, ctx({ recentBills: nameless })))).not.toContain('rate-high');
    });

    test('usual rate is per item, never another item\'s', () => {
        const recent = [billOf('a', 1, [{ itemId: 'rice', name: 'Rice', rate: 40, qty: 1, total: 40 }]), billOf('b', 2, [dalLine(200)])];
        expect(evaluateBill(draft(), ctx({ recentBills: recent }))).toEqual([]);
    });

    test('an edit skips only its own old copy', () => {
        const recent = [billOf('e1', 2, [dalLine(80)]), billOf('e2', 1, [dalLine(80)])];
        const d = dalBill(200, { isEdit: true, id: 'e1' });
        expect(ids(evaluateBill(d, ctx({ recentBills: recent })))).toContain('rate-high');
    });

    test('catalogue lookup: by id first, then by name or Hindi name; an unknown id falls back to the name', () => {
        const rate100 = (line) => ids(evaluateBill(draft({ items: [{ rate: 100, qty: 1, total: 100, ...line }], total: 100, payment: { cash: 100 } }), ctx()));
        expect(rate100({ itemId: 'rice', name: 'Chawal typo' })).toContain('rate-high');
        expect(rate100({ itemId: 'ghost', name: 'Rice' })).toContain('rate-high');
        expect(rate100({ name: 'चावल' })).toContain('rate-high');
        const catalogue = [{ name: 'Other', saleRates: [100] }, { id: 'salt', name: 'Salt', saleRates: [10] }];
        expect(ids(evaluateBill(draft({ items: [{ name: 'Salt', rate: 30, qty: 1, total: 30 }], total: 30, payment: { cash: 30 } }), ctx({ catalogue }))))
            .toContain('rate-high');
    });

    test('saved rate list: the first positive, finite rate counts', () => {
        const d = draft({ items: [{ itemId: 'x', name: 'X', rate: 100, qty: 1, total: 100 }], total: 100, payment: { cash: 100 } });
        for (const saleRates of [[0, 40], [Infinity, 40], [-5, 40]]) {
            expect(ids(evaluateBill(d, ctx({ catalogue: [{ id: 'x', name: 'X', saleRates }] })))).toContain('rate-high');
        }
    });

    test('average cost: the first positive stock rate by id or name; selling at cost is not below cost', () => {
        const byName = ctx({ stock: { Rice: { quantity: 100, rate: 50 } } });
        expect(ids(evaluateBill(draft(), byName))).toContain('below-cost');
        const negativeFirst = ctx({ stock: { rice: { quantity: 100, rate: -5 }, Rice: { quantity: 100, rate: 50 } } });
        expect(ids(evaluateBill(draft(), negativeFirst))).toContain('below-cost');
        const atCost = draft({ items: [{ itemId: 'rice', name: 'Rice', rate: 30, qty: 10, total: 300 }], total: 300, payment: { cash: 300 } });
        expect(ids(evaluateBill(atCost, ctx()))).not.toContain('below-cost');
    });

    test('a legacy line with quantity 0 (no qty field) is still a bad quantity', () => {
        const d = draft({ items: [{ itemId: 'rice', name: 'Rice', rate: 40, quantity: 0, total: 0 }], total: 0, payment: { cash: 0 }, isEdit: true });
        expect(find(evaluateBill(d, ctx()), 'qty-invalid')).toMatchObject({ field: 'items.0', line: 0 });
    });

    test('line numbers: qty issue on its own line; oversell names only the oversold lines; empty lines are dropped first', () => {
        const d = draft({ items: [{ itemId: 'dal', name: 'Dal', rate: 90, qty: 1, total: 90 }, { itemId: 'rice', name: 'Rice', rate: 40, qty: 0, total: 0 }], total: 90, payment: { cash: 90 } });
        expect(find(evaluateBill(d, ctx()), 'qty-invalid')).toMatchObject({ field: 'items.1', line: 1 });
        const over = draft({ items: [null, { itemId: 'rice', name: 'Rice', rate: 40, qty: 150, total: 6000 }, { itemId: 'dal', name: 'Dal', rate: 90, qty: 1, total: 90 }], total: 6090, payment: { cash: 6090 } });
        expect(find(evaluateBill(over, ctx()), 'oversell')).toMatchObject({ field: 'items', lines: [0] });
    });

    test('oversell: items never stocked are skipped; a negative stock shows as 0 kg; approximate stock names its time', () => {
        const big = draft({ items: [{ itemId: 'rice', name: 'Rice', rate: 40, qty: 150, total: 6000 }], total: 6000, payment: { cash: 6000 } });
        expect(ids(evaluateBill(big, ctx({ stocked: new Set() })))).not.toContain('oversell');
        expect(ids(evaluateBill(big, ctx({ stocked: new Set(['rice']) })))).toContain('oversell');
        const negative = find(evaluateBill(big, ctx({ stock: { rice: { quantity: -3, rate: 30 } } })), 'oversell');
        expect(negative.en).toContain('only 0 kg in stock');
        const approx = find(evaluateBill(big, ctx({ stockApproximate: true, stockApprox: { builtAt: NOW } })), 'oversell');
        expect(approx.en).not.toContain('updated —');
    });

    test('typed line: only a wholesale quantity over stock is flagged on the box, never the bill\'s own oversell', () => {
        const over = { items: [{ itemId: 'rice', name: 'Rice', rate: 40, qty: 150, total: 6000 }], total: 6000, payment: { cash: 6000 } };
        const entryField = (d, c) => evaluateBill(d, c).filter(i => i.field === 'entry.qty').map(i => i.id);
        const dal = { itemId: 'dal', name: 'Dal', rate: 90, qty: 1 };
        expect(entryField(draft({ ...over, kind: 'wholesale', entry: dal }), ctx({ oversellCanBlock: true }))).toEqual([]);
        expect(ids(evaluateBill(draft({ ...over, kind: 'wholesale', entry: dal }), ctx({ oversellCanBlock: true }))).filter(id => id === 'oversell')).toHaveLength(1);
        expect(entryField(draft({ ...over, kind: 'wholesale', entry: { itemId: 'rice', name: 'Rice', rate: 40, qty: 0 } }), ctx())).toEqual(['qty-invalid']);
        expect(entryField(draft({ kind: 'retail', entry: { itemId: 'rice', name: 'Rice', rate: 40, qty: 200 } }), ctx())).toEqual([]);
    });

    test('typed line: needs an item; a name alone is enough; quantity 0 is a bad quantity', () => {
        expect(evaluateBill(draft({ entry: { rate: 0, qty: 0 } }), ctx())).toEqual([]);
        expect(find(evaluateBill(draft({ entry: { name: 'Rice', rate: 0 } }), ctx()), 'rate-invalid')).toMatchObject({ field: 'entry.rate' });
        expect(find(evaluateBill(draft({ entry: { itemId: 'rice', name: 'Rice', qty: 0 } }), ctx()), 'qty-invalid')).toMatchObject({ field: 'entry.qty' });
    });

    test('a new bill with no lines is not checked for dates or duplicates', () => {
        const empty = draft({ items: [], total: 0, payment: {}, date: new Date(NOW + 5 * 86400000).toISOString() });
        expect(evaluateBill(empty, ctx({ recentBills: [{ id: 'z', timestamp: NOW, items: [], customerName: '', grandTotal: 0 }] }))).toEqual([]);
    });

    test('cost-unknown while stock loads names its line', () => {
        const d = draft({ kind: 'wholesale', items: [{ itemId: 'dal', name: 'Dal', rate: 90, qty: 1, total: 90 }, { itemId: 'rice', name: 'Rice', rate: 40, qty: 1, total: 40 }], total: 130, payment: { cash: 130 } });
        expect(evaluateBill(d, ctx({ stockReady: false })).filter(i => i.id === 'cost-unknown').map(i => i.line)).toEqual([0, 1]);
        expect(ids(evaluateBill(d, ctx()))).not.toContain('cost-unknown');
    });

    test('duplicates: the same lines in another order still match; exactly at the window edge still warns; no name never matches "undefined"', () => {
        const lines = [{ itemId: 'rice', name: 'Rice', rate: 40, qty: 10, total: 400 }, { itemId: 'dal', name: 'Dal', rate: 90, qty: 1, total: 90 }];
        const d = draft({ items: lines, total: 490, payment: { cash: 490 }, partyName: 'Ram' });
        const prev = (over) => ({ id: 'p', customerName: 'Ram', grandTotal: 490, items: [lines[1], lines[0]], timestamp: NOW - 60000, ...over });
        expect(ids(evaluateBill(d, ctx({ recentBills: [prev()] })))).toContain('duplicate');
        expect(ids(evaluateBill(d, ctx({ recentBills: [prev({ timestamp: NOW - 120000 })] })))).toContain('duplicate');
        const noName = draft({ items: lines, total: 490, payment: { cash: 490 }, partyName: undefined });
        expect(ids(evaluateBill(noName, ctx({ recentBills: [prev({ customerName: 'Undefined' })] })))).not.toContain('duplicate');
    });

    test('a date exactly 60 min ahead is fine', () => {
        expect(ids(evaluateBill(draft({ date: new Date(NOW + 60 * 60000).toISOString() }), ctx()))).not.toContain('date-future');
    });

    test('online-only or due-only is a payment', () => {
        expect(ids(evaluateBill(draft({ payment: { cash: 0, online: 400, due: 0 } }), ctx()))).not.toContain('payment-none');
        expect(ids(evaluateBill(draft({ payment: { cash: 0, online: 0, due: 400 }, partyName: 'Ram' }), ctx()))).not.toContain('payment-none');
    });

    test('warnings keep the order they were found in', () => {
        const line = { itemId: 'rice', name: 'Rice', rate: 20, qty: 1, total: 20 };
        const d = draft({ items: [line], total: 20, payment: { cash: 20 }, date: new Date(NOW + 2 * 3600000).toISOString(), partyName: 'Ram' });
        const prev = { id: 'p', customerName: 'Ram', grandTotal: 20, items: [line], timestamp: NOW - 1000 };
        expect(ids(evaluateBill(d, ctx({ recentBills: [prev] })))).toEqual(['below-cost', 'duplicate', 'date-future']);
    });

    test('stock credit: a bill without an id is never taken for a draft without one', () => {
        expect(stockCreditFor({ salesHistory: [{ id: null, items: [{ itemId: 'rice', quantity: 5 }] }] }, 'wholesale', { draftId: null })).toEqual([]);
    });

    test('context: approximate stock kept as given, purchases skip the stocked set, owner entry only for the owner', () => {
        const s = { items: [RICE], purchaseHistory: [{ id: 'p', items: [{ itemId: 'rice', quantity: 5, rate: 30 }] }], stock: {} };
        expect(buildCheckContext(s, 'retail').stockApprox).toBeNull();
        const approx = { builtAt: 1 };
        expect(buildCheckContext({ ...s, stockApprox: approx }, 'retail').stockApprox).toBe(approx);
        expect(buildCheckContext(s, 'purchase').stocked).toBeNull();
        expect(buildCheckContext(s, 'retail').stocked.has('rice')).toBe(true);
        expect(buildCheckContext({ ...s, userRole: 'owner' }, 'retail').ownerEntry).toBe(true);
        expect(buildCheckContext({ ...s, userRole: 'manager' }, 'retail').ownerEntry).toBe(false);
    });

    test('cash count: expected ₹0 is fine; exactly ₹200 off is not "high"; short vs extra in both languages', () => {
        expect(evaluateCashCount({ expected: 0, counted: 0 })).toEqual([]);
        expect(ids(evaluateCashCount({ expected: 1000, counted: 800 }))).toEqual(['cash-mismatch']);
        const short = evaluateCashCount({ expected: 1000, counted: 900 })[0];
        expect(short.en).toContain('short');
        expect(short.hi).toContain('कम');
        const extra = evaluateCashCount({ expected: 1000, counted: 1100 })[0];
        expect(extra.en).toContain('extra');
        expect(extra.hi).toContain('ज़्यादा');
    });
});
