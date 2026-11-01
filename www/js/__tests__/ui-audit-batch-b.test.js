/**
 * @fileoverview UI audit batch B (numbers and data): shared ₹ and date
 * formats (F08, F27, F33), old-app opening records in History (F06), item
 * names in low-stock alerts (F03), party names that differ only in case
 * (F16), the "cost not known" margin note (F14), opening stock and oversell
 * checks for never-stocked items (F15) and the cash prediction card (F11).
 */
import { formatAmount, formatRupees } from '../utils/money.js';
import { formatDay, formatDayTime, formatTimeOfDay } from '../utils/dates.js';
import { buildAging, partyDisplayNames, pickPartyName } from '../utils/aging.js';
import { lowStockItems, stockedItemKeys, firstStockTimes } from '../utils/stock-check.js';
import { buildCheckContext, evaluateBill } from '../utils/bill-checks.js';
import { planStockAdjustment } from '../utils/stock-adjust.js';
import { Helpers } from '../utils/helpers.js';
import { HistoryManager } from '../modules/history.js';
import { StockManager } from '../modules/stock.js';
import { AppState } from '../utils/state.js';
import { setLang, resetLangForTests } from '../i18n/index.js';

const ITEMS = [
    { id: 'fakeItemId0000000001', name: 'Test Item', hindiName: 'टेस्ट आइटम' },
    { id: 'i-gond', name: 'Gond', hindiName: 'गोंद' },
    { id: 'i-never', name: 'Chironji', hindiName: 'चिरौंजी' }
];

beforeEach(() => {
    localStorage.clear();
    resetLangForTests();
});
afterEach(() => {
    localStorage.clear();
    resetLangForTests();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

describe('F08 / F27: one ₹ format with Indian grouping', () => {
    test('whole rupees, grouped; paise only when asked', () => {
        expect(formatRupees(250000)).toBe('₹2,50,000');
        expect(formatAmount(250000)).toBe('2,50,000');
        expect(formatRupees(123456.78, { decimals: 2 })).toBe('₹1,23,456.78');
        expect(formatRupees(-500)).toBe('-₹500');
        expect(formatRupees(-0.2)).toBe('₹0');
        expect(formatRupees('x')).toBe('₹0');
        expect(Helpers.formatCurrency(1234567.89)).toBe('₹12,34,568');
    });
    test('small: paise below ₹100 so ₹0.40 is not ₹0; whole amounts stay whole', () => {
        expect(formatRupees(10 / 25, { small: true })).toBe('₹0.40');
        expect(formatRupees(10, { small: true })).toBe('₹10');
        expect(formatRupees(150.4, { small: true })).toBe('₹150');
    });
});

describe('F33: one date format', () => {
    const at = new Date(2026, 9, 25, 20, 59);
    test('date, time and date-time in English and Hindi', () => {
        expect(formatDay(at)).toBe('25 Oct 2026');
        expect(formatDay(at, { year: false })).toBe('25 Oct');
        expect(formatTimeOfDay(at)).toBe('8:59 pm');
        expect(formatTimeOfDay(new Date(2026, 0, 1, 0, 5))).toBe('12:05 am');
        expect(formatDayTime(at, { now: new Date(2026, 9, 26) })).toBe('25 Oct, 8:59 pm');
        expect(formatDayTime(at, { now: new Date(2027, 0, 2) })).toBe('25 Oct 2026, 8:59 pm');
        expect(formatDay(at, { lang: 'hi' })).toBe('25 अक्तू॰ 2026');
        expect(formatDayTime(at, { lang: 'hi', now: at })).toBe('25 अक्तू॰, 8:59 अपराह्न');
        expect(formatDay('25/10/2026')).toBe('25 Oct 2026');
        expect(formatDay('nope')).toBe('');
    });
    test('Helpers.formatDate / formatDateTime follow the app language', () => {
        expect(Helpers.formatDate('2026-10-25')).toBe('25 Oct 2026');
        setLang('hi');
        expect(Helpers.formatDate('2026-10-25')).toBe('25 अक्तू॰ 2026');
        expect(Helpers.formatTime(at)).toBe('8:59 अपराह्न');
    });
});

describe('F16: party names that differ only in case are one party', () => {
    test('the most used spelling is shown; a tie goes to the capitalised one', () => {
        expect(partyDisplayNames(['test party', 'Test Party ', 'Sita']).get('test party')).toBe('Test Party');
        expect(partyDisplayNames(['test party', 'test  party', 'Test Party']).get('test party')).toBe('test party');
        expect(pickPartyName(new Map())).toBe('');
        const aging = buildAging([
            { id: 'a', customerName: 'test party', timestamp: new Date(2026, 9, 24).getTime(), payment: { due: 480 } },
            { id: 'b', customerName: 'Test Party', timestamp: new Date(2026, 9, 23).getTime(), payment: { due: 100 } }
        ], { today: new Date(2026, 9, 25) });
        expect(aging.parties).toHaveLength(1);
        expect(aging.parties[0]).toMatchObject({ name: 'Test Party', total: 580 });
    });

});

describe('F06: old-app opening records in History', () => {
    test('the card shows the carried amount with an "Old app" chip, grouped, and no "0 packets"', () => {
        const card = HistoryManager.buildHistoryCard({
            id: 'opening-retail-x', billNumber: 'S-TEST-1', customerName: 'Test Party A', type: 'retail',
            date: '2026-10-25', timestamp: new Date(2026, 9, 25, 17, 35).getTime(), items: [], total: 0,
            payment: { cash: 0, online: 0, due: 250000, total: 0 }, dueAmount: 250000,
            openingBalance: { migrated: true, amount: 250000, billTotal: 250000, paidBefore: 0 }
        });
        const text = card.textContent.replace(/\s+/g, ' ');
        expect(card.querySelector('.old-app-chip').textContent).toBe('Old app');
        expect(text).toContain('₹2,50,000');
        expect(text).toContain('Due: ₹2,50,000');
        expect(text).toContain('Due carried from the old app');
        expect(text).not.toMatch(/₹ ?0\b|0 packets/);
    });
    test('an ordinary card groups its amounts too', () => {
        const card = HistoryManager.buildHistoryCard({
            id: 'r1', billNumber: 'S1', type: 'retail', date: '2026-10-25', items: [{ name: 'Gond' }], totalPackets: 2,
            total: 123456, payment: { cash: 0, online: 0, due: 123456 }
        });
        expect(card.textContent).toContain('₹1,23,456');
        expect(card.textContent).toContain('2 packets');
    });
});

describe('F03 / F15: stock that was never set', () => {
    const purchases = [{ id: 'p1', timestamp: 100, items: [{ itemId: 'i-gond', name: 'Gond', qty: 5, rate: 100 }] }];
    const adjustments = [{ itemId: 'fakeItemId0000000001', itemName: 'Test Item', adjustType: 'set', quantity: 20, rate: 40, timestamp: 50 }];

    test('stock counts as set by a purchase, an add / set adjustment (opening stock) or stock on hand', () => {
        expect([...stockedItemKeys({ purchases, stockAdjustments: adjustments }, ITEMS)].sort()).toEqual(['fakeItemId0000000001', 'i-gond']);
        expect(firstStockTimes({ purchases, stockAdjustments: adjustments }, ITEMS).get('i-gond')).toBe(100);
        expect(stockedItemKeys({}, ITEMS, { 'i-never': { quantity: 3, rate: 0 } }).has('i-never')).toBe(true);
        expect(stockedItemKeys({ purchases: [{ openingBalance: {}, items: [{ itemId: 'i-never', qty: 5 }] }] }, ITEMS).size).toBe(0);
    });

    test('low stock alert: item names in the app language, never raw ids, never-stocked items left out', () => {
        const stock = { fakeItemId0000000001: { quantity: 4 }, 'i-gond': { quantity: 50 }, 'i-never': { quantity: -2 }, 'ghost-id': { quantity: 1 } };
        const stocked = stockedItemKeys({ purchases, stockAdjustments: adjustments }, ITEMS);
        expect(lowStockItems(stock, ITEMS, stocked)).toEqual([{ key: 'fakeItemId0000000001', name: 'Test Item', quantity: 4, level: 10 }]);
        expect(lowStockItems(stock, ITEMS, stocked, { lang: 'hi' })[0].name).toBe('टेस्ट आइटम');
    });

    test('a sale of an item whose stock was never set raises no "more than stock" warning or block', () => {
        const state = { items: ITEMS, stock: { 'i-never': { quantity: 0, rate: 0 }, 'i-gond': { quantity: 1, rate: 100 } }, stockReady: true,
            purchaseHistory: purchases, salesHistory: [], retailSalesHistory: [], stockAdjustments: [], settings: {} };
        const draft = (itemId, name) => ({ kind: 'wholesale', items: [{ itemId, name, qty: 10, rate: 150, total: 1500 }], total: 1500, payment: { cash: 1500, online: 0, due: 0 }, partyName: 'A' });
        const oversell = (d) => evaluateBill(d, buildCheckContext(state, 'wholesale')).filter(i => i.id === 'oversell');
        expect(oversell(draft('i-never', 'Chironji'))).toEqual([]);
        expect(oversell(draft('i-gond', 'Gond'))).toHaveLength(1);
    });

    test('opening stock needs the cost per kg (so cost of goods sold can be worked out)', () => {
        const base = { adjustType: 'set', quantity: 20, currentStock: 0, reasonCode: 'opening' };
        expect(planStockAdjustment(base)).toEqual({ ok: false, error: 'Enter the cost per kg of the opening stock, so profit can be worked out' });
        expect(planStockAdjustment({ ...base, rate: 40 })).toMatchObject({ ok: true, newStock: 20, reason: 'Opening stock' });
    });

    test('empty Stock page explains and offers "Set opening stock"', () => {
        AppState.userRole = 'owner';
        document.body.innerHTML = '<div id="stockList"></div>';
        document.getElementById('stockList').innerHTML = StockManager.emptyStockHtml();
        const btn = document.querySelector('#stockList button');
        expect(btn.textContent).toBe('Set opening stock');
        expect(btn.getAttribute('onclick')).toBe('window.app.stock.startOpeningStock()');
        AppState.userRole = 'staff';
        expect(StockManager.emptyStockHtml()).not.toContain('<button');
    });
});
