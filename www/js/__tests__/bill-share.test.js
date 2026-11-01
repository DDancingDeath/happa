/**
 * @fileoverview #136: reprint/share a saved bill from History — printer
 * payload (bill's own date + COPY mark), receipt header, WhatsApp text, and
 * the History detail actions.
 * Timezone is pinned to Asia/Kolkata in jest.config.js.
 */

jest.mock('../firebase/firestore-service.js', () => ({ FirebaseService: { db: null } }));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(), ACTIONS: {} } }));
jest.mock('../ui/infinite-scroll.js', () => ({ attachOlderHistoryScroll: jest.fn() }));

import {
    copyMark, buildReprintPayload, buildBillShareText, receiptDateTime, formatReceiptDateTime
} from '../utils/bill-share.js';
import { BluetoothPrinterManager, PrinterService } from '../services/printer.js';
import { HistoryManager } from '../modules/history.js';
import { AppState } from '../utils/state.js';

const PURCHASE = {
    id: 'p1', billNumber: 'P20261003-001', type: 'purchase', isPurchase: true,
    customerName: 'Ram', comments: 'internal note', printComments: false,
    date: '2026-10-03T09:15:00.000Z', timestamp: new Date(2026, 9, 3, 14, 45).getTime(),
    items: [{ name: 'Wheat', rate: 25, qty: 40, total: 1000, weights: [20, 20] }],
    billTotal: 1000, laborCharges: 12, grandTotal: 988, amountPayable: 988,
    payment: { cash: 500, online: 0, due: 488 }
};

const WHOLESALE = {
    id: 'w1', billNumber: 'W20250915-004', type: 'wholesale', customerName: 'Shyam Traders',
    date: '15/09/2025, 6:05:00 pm', // legacy en-IN string, no timestamp
    items: [{ name: 'Rice', rate: 40, quantity: 100, total: 4000 }],
    total: 4000, expenses: 150, profit: 600,
    payment: { cash: 1000, online: 500, due: 2500 },
    createdByName: 'Owner'
};

describe('receipt date', () => {
    test('uses the bill date, not the print time', () => {
        const now = new Date(2026, 9, 22, 1, 0);
        expect(receiptDateTime(PURCHASE, now)).toBe('03/10/2026 02:45 pm');
        expect(receiptDateTime(WHOLESALE, now)).toBe('15/09/2025 06:05 pm');
        expect(receiptDateTime({}, now)).toBe(formatReceiptDateTime(now));
    });

    test('printer header draws the bill date and the COPY mark on reprints only', () => {
        const manager = new BluetoothPrinterManager();
        const drawn = [];
        const ctx = { fillText: (t) => drawn.push(t), measureText: () => ({ width: 50 }), font: '' };
        const utils = { drawCenter: (t, y) => { drawn.push(t); return y + 20; } };
        const config = { width: 384, padding: { side: 0 }, spacing: { line: 24, section: 12 }, fonts: { title: {}, header: {}, subtext: {} } };

        manager._drawReceiptHeader(ctx, buildReprintPayload(WHOLESALE, 'wholesale'), config, utils, 0);
        expect(drawn).toEqual(['Receipt', copyMark(), 'Bill: W20250915-004', '15/09/2025 06:05 pm']);

        drawn.length = 0;
        manager._drawReceiptHeader(ctx, PURCHASE, config, utils, 0);
        expect(drawn).not.toContain(copyMark());
        expect(drawn).toContain('03/10/2026 02:45 pm');
    });
});

describe('buildReprintPayload', () => {
    test('marks a copy, keeps the bill date and does not mutate the bill', () => {
        const before = JSON.stringify(WHOLESALE);
        const p = buildReprintPayload(WHOLESALE, 'wholesale');
        expect(JSON.stringify(WHOLESALE)).toBe(before);
        expect(p).toMatchObject({
            isCopy: true, isPurchase: false, type: 'wholesale', date: WHOLESALE.date,
            total: 4000, saleTotal: 4000, amountPayable: 4000,
            payment: { cash: 1000, online: 500, due: 2500 }, dueAmount: 2500
        });
        expect(p.items[0]).toMatchObject({ name: 'Rice', qty: 100, rate: 40, total: 4000 });
    });

    test('purchase keeps labour fields and reads top-level legacy payment', () => {
        const legacy = { ...PURCHASE, payment: undefined, cashPayment: 300, onlinePayment: 200, dueAmount: 488 };
        const p = buildReprintPayload(legacy);
        expect(p).toMatchObject({ isPurchase: true, laborCharges: 12, timestamp: PURCHASE.timestamp });
        expect(p.payment).toMatchObject({ cash: 300, online: 200, due: 488 });
    });
});

describe('buildBillShareText', () => {
    test('bilingual, bill date, COPY mark, no internal figures', () => {
        const text = buildBillShareText(WHOLESALE, 'wholesale');
        expect(text).toContain('*Wholesale Bill* (COPY)');
        expect(text).toContain('Date: 15/09/2025 06:05 pm');
        expect(text).toContain('Customer: Shyam Traders');
        expect(text).toContain('  ₹40 × 100.0kg = ₹4000');
        expect(text).toContain('*Total: ₹4000*');
        expect(text).toContain('Received: ₹1500');
        expect(text).toContain('Due: ₹2500');
        expect(text).not.toMatch(/[\u0900-\u097F]/);
        expect(text).not.toMatch(/profit|expense|owner|staff|स्टाफ/i);
    });

    test('purchase shows labour and payable; comments only when marked for print', () => {
        const text = buildBillShareText(PURCHASE, 'purchase');
        expect(text).toContain('*Purchase Bill*');
        expect(text).toContain('Date: 03/10/2026 02:45 pm');
        expect(text).toContain('Labour: ₹12');
        expect(text).toContain('*Payable: ₹988*');
        expect(text).toContain('Paid: ₹500');
        expect(text).not.toContain('internal note');
        expect(buildBillShareText({ ...PURCHASE, printComments: true })).toContain('Note: internal note');
        expect(buildBillShareText(PURCHASE, 'purchase', { copy: false })).not.toContain(copyMark());
    });
});

describe('History detail actions', () => {
    beforeEach(() => {
        AppState.purchaseHistory = [PURCHASE];
        AppState.salesHistory = [WHOLESALE];
        AppState.retailSalesHistory = [];
        window.currentBillType = 'wholesale';
        window.currentBillId = 'w1';
        window.currentBillIndex = 5; // stale index: resolved by id
    });

    test('Reprint sends the copy payload through the normal print path', async () => {
        const spy = jest.spyOn(PrinterService, 'printBill').mockResolvedValue(true);
        await HistoryManager.reprintBill();
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toMatchObject({ id: 'w1', isCopy: true, date: WHOLESALE.date });
        expect(AppState.salesHistory[0]).toBe(WHOLESALE);
        expect(WHOLESALE.isCopy).toBeUndefined();
    });

    test('Share opens WhatsApp with the bill text', () => {
        const open = jest.spyOn(window, 'open').mockReturnValue({});
        HistoryManager.shareBill();
        const url = open.mock.calls[0][0];
        expect(url.startsWith('https://wa.me/?text=')).toBe(true);
        expect(decodeURIComponent(url.split('text=')[1])).toBe(buildBillShareText(WHOLESALE, 'wholesale'));
    });
});

describe('receipt totals come from the shared money functions (BILL-TOTAL, BILL-PAY, BILL-DUE)', () => {
    function totals(bill) {
        const drawn = [];
        const ctx = { fillText: (txt) => drawn.push(txt), measureText: () => ({ width: 50 }), font: '', fillStyle: '', textAlign: '' };
        const config = { width: 384, padding: { left: 10 }, spacing: { line: 24 }, fonts: { body: { size: 20 }, total: { size: 24 } } };
        new BluetoothPrinterManager()._drawTotalsSection(ctx, bill, config, {}, 0);
        return drawn;
    }

    test('payment.cash 0 wins over a stale top-level cashPayment', () => {
        const bill = { ...WHOLESALE, cashPayment: 1000, payment: { cash: 0, online: 1500, due: 2500 } };
        expect(totals(bill).slice(4)).toEqual(['Total received:', '₹1500', 'Due:', '₹2500']);
    });
    test('a cleared bill prints no due; a legacy purchase prints its BILL-TOTAL as payable', () => {
        expect(totals({ ...WHOLESALE, cleared: true })).not.toContain('Due:');
        const legacy = { isPurchase: true, billTotal: 1000, total: 970, laborCharges: 30, items: [], cashPayment: 970, dueAmount: 0 };
        expect(totals(legacy)).toEqual(['Total:', '₹1000', 'Labour:', '₹30', 'Total:', '₹970', 'Total paid:', '₹970']);
        expect(buildBillShareText(legacy, 'purchase')).toContain('*Payable: ₹970*');
    });

    test('#80: a real ₹0 is shown as ₹0, not the next field; a purchase without billTotal shows its lines before labour', () => {
        const zero = { ...PURCHASE, billTotal: 0, laborCharges: 0, grandTotal: 0, amountPayable: 0, items: [], payment: { cash: 0, online: 0, due: 0 } };
        expect(totals({ ...zero, saleTotal: 50, total: 70 }).slice(0, 2)).toEqual(['Total:', '₹0']);
        expect(buildBillShareText({ ...zero, total: 70 }, 'purchase')).toContain('*Total: ₹0*');
        const noLines = { isPurchase: true, grandTotal: 950, laborCharges: 50, items: [], payment: { cash: 950, online: 0, due: 0 } };
        expect(totals(noLines).slice(0, 4)).toEqual(['Total:', '₹1000', 'Labour:', '₹50']);
        expect(buildBillShareText(noLines, 'purchase')).toContain('*Total: ₹1000*');
        expect(buildBillShareText(noLines, 'purchase')).toContain('*Payable: ₹950*');
        const oldLabour = { isPurchase: true, grandTotal: 950, labour: 30, items: [], payment: { cash: 950, online: 0, due: 0 } };
        expect(totals(oldLabour).slice(0, 6)).toEqual(['Total:', '₹980', 'Labour:', '₹30', 'Total:', '₹950']);
    });
});
