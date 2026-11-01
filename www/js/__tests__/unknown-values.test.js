/**
 * @fileoverview Unknown is not zero (#80): a bill that stores no amount shows "—" in
 * History (rows, Table view, bill details), while a real ₹0 still shows ₹0; a bill
 * whose date can't be read keeps its stored text and gets a "Date?" badge.
 */
import { hasBillAmount, UNKNOWN_AMOUNT } from '../utils/money.js';
import { parseAnyBillDate } from '../utils/dates.js';
import { HistoryManager } from '../modules/history.js';
import { AppState } from '../utils/state.js';
import { buildBillRow, billTableHtml, billListAmountText, billRowDate } from '../ui/bill-row.js';
import { setLang } from '../i18n/index.js';

const at = new Date(2026, 9, 25, 20, 59).getTime();

afterEach(() => setLang('en'));

describe('hasBillAmount', () => {
    test('any BILL-TOTAL field present counts, a present 0 included', () => {
        expect(hasBillAmount({ grandTotal: 0 })).toBe(true);
        expect(hasBillAmount({ saleTotal: '120' })).toBe(true);
        expect(hasBillAmount({ total: 50 })).toBe(true);
    });
    test('no field, empty fields or no bill: unknown', () => {
        expect(hasBillAmount({ items: [] })).toBe(false);
        expect(hasBillAmount({ grandTotal: '', total: null })).toBe(false);
        expect(hasBillAmount(null)).toBe(false);
    });
});

describe('History rows', () => {
    const row = (bill) => buildBillRow(bill, { onclick: '' });

    test('no stored amount → "—"; a real 0 → ₹0', () => {
        expect(row({ id: 'a', timestamp: at, items: [] }).querySelector('.bill-row__amount').textContent).toBe(UNKNOWN_AMOUNT);
        expect(row({ id: 'b', timestamp: at, grandTotal: 0, items: [] }).querySelector('.bill-row__amount').textContent).toBe('₹0');
        expect(billListAmountText({ total: 1234 })).toBe('₹1,234');
    });

    test('an old-app opening record shows its carried due as before', () => {
        expect(billListAmountText({ openingBalance: { due: 500 }, dueAmount: 500 })).not.toBe(UNKNOWN_AMOUNT);
    });

    test('a date that can not be read keeps its text and gets the badge; a good one does not', () => {
        const bad = row({ id: 'c', date: '31/31/2025', total: 10, items: [] });
        expect(bad.querySelector('.bill-row__date').textContent).toContain('31/31/2025');
        expect(bad.querySelector('.bad-date-badge').textContent).toBe('Date?');
        const good = row({ id: 'd', timestamp: at, total: 10, items: [] });
        expect(good.querySelector('.bad-date-badge')).toBeNull();
        expect(good.querySelector('.bill-row__date').textContent).toContain('25 Oct');
    });

    test('a legacy DD/MM/YYYY date is read, no badge', () => {
        expect(billRowDate({ date: '05/10/2026' })).toEqual({ text: expect.stringContaining('5 Oct'), bad: false });
    });

    test('Table view: the same "—" and badge', () => {
        document.body.innerHTML = billTableHtml([{ id: 'e', date: 'garbage', items: [] }], { onclickFor: () => '' });
        expect(document.querySelector('td.bill-table__amount').textContent).toBe(UNKNOWN_AMOUNT);
        expect(document.querySelector('.bill-table__date .bad-date-badge')).not.toBeNull();
    });

    test('Hindi badge', () => {
        setLang('hi');
        expect(buildBillRow({ id: 'f', date: 'x', items: [] }, { onclick: '' }).querySelector('.bad-date-badge').textContent).toBe('तारीख?');
    });
});

describe('parseAnyBillDate: DD/MM/YYYY', () => {
    test('an impossible day or month is not a date', () => {
        expect(parseAnyBillDate('31/31/2025')).toBeNull();
        expect(parseAnyBillDate('31/04/2025')).toBeNull();
        expect(parseAnyBillDate('29/02/2025')).toBeNull();
    });
    test('real days parse, with their time; a time past the day still rolls over as before', () => {
        expect(parseAnyBillDate('29/02/2024')).toEqual(new Date(2024, 1, 29));
        expect(parseAnyBillDate('29/02/2024, 11:59:59 pm')).toEqual(new Date(2024, 1, 29, 23, 59, 59));
        expect(parseAnyBillDate('31/10/2026, 24:00')).toEqual(new Date(2026, 10, 1, 0, 0));
    });
});

describe('bill details', () => {
    test('a bill with no stored total shows "—" for its totals; labour still shows; an unreadable date gets the badge', async () => {
        document.body.innerHTML = '<div id="billDetailsOverlay"><div id="billDetailsContent"></div></div><div id="billDetailsActions"></div>';
        AppState.userRole = 'owner';
        AppState.purchaseHistory = [{ id: 'q1', billNumber: 'Q1', date: 'not a date', items: [], laborCharges: 30 }];
        await HistoryManager.viewBill('id:q1', 'purchase');
        const text = document.getElementById('billDetailsContent').textContent.replace(/\s+/g, ' ');
        expect(text).toContain('Purchase Total: —');
        expect(text).toContain('Total Payable: —');
        expect(text).toContain('₹30');
        expect(document.querySelector('#billDetailsContent .bad-date-badge')).not.toBeNull();
    });
});
