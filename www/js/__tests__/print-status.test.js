/**
 * @fileoverview Per-bill print status in History (#132): kept on this phone,
 * recorded by the print path, shown as a chip and in the bill details with
 * Print again / Mark printed by hand.
 */
import { printKey, printStatusOf, prunePrintStatuses, recordPrint, resetPrintStatusCache } from '../utils/print-status.js';
import { buildBillRow, printStatusText } from '../ui/bill-row.js';
import { PrinterService } from '../services/printer.js';
import { HistoryManager } from '../modules/history.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 10, 1, 10, 42).getTime();

const bill = () => ({
    id: 'p1',
    billNumber: 'P20261101-007',
    type: 'purchase',
    customerName: 'Ram',
    date: '2026-11-01T10:30:00',
    items: [{ name: 'Rice', qty: 10, rate: 20, total: 200 }],
    grandTotal: 200,
    total: 200,
    payment: { cash: 200, online: 0, due: 0 }
});

beforeEach(() => {
    localStorage.clear();
    resetPrintStatusCache();
    document.body.innerHTML = '<div id="billDetailsContent"></div><input id="historySearch">';
    jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('stored on this phone', () => {
    test('keyed like the print job (bill number, else id); no key, no record', () => {
        expect(printKey({ billNumber: 'S-1', id: 'x' })).toBe('bill:S-1');
        expect(printKey({ id: 'x' })).toBe('bill:x');
        expect(printKey({})).toBeNull();
        expect(recordPrint({}, 'printed')).toBe(false);
    });

    test('outcome, time, tries and error survive an app restart', () => {
        recordPrint(bill(), 'failed', { error: 'Printer did not answer', now: NOW });
        recordPrint(bill(), 'printed', { now: NOW + 60000 });
        resetPrintStatusCache();
        expect(printStatusOf(bill(), { now: NOW + 60000 })).toEqual({ s: 'printed', at: NOW + 60000, n: 2 });
        recordPrint(bill(), 'hand', { now: NOW + 120000 });
        expect(printStatusOf(bill(), { now: NOW + 120000 })).toEqual({ s: 'hand', at: NOW + 120000, n: 2 });
        expect(recordPrint(bill(), 'bogus')).toBe(false);
    });

    test('kept 60 days, newest 1000', () => {
        const map = {};
        for (let i = 0; i < 1005; i++) map[`bill:${i}`] = { s: 'printed', at: NOW - i * 1000, n: 1 };
        map['bill:old'] = { s: 'printed', at: NOW - 61 * DAY, n: 1 };
        const kept = prunePrintStatuses(map, NOW);
        expect(Object.keys(kept)).toHaveLength(1000);
        expect(kept['bill:0']).toBeDefined();
        expect(kept['bill:1004']).toBeUndefined();
        expect(kept['bill:old']).toBeUndefined();
        recordPrint(bill(), 'printed', { now: NOW });
        expect(printStatusOf(bill(), { now: NOW + 61 * DAY })).toBeNull();
    });

    test('a full phone storage is reported, not thrown', () => {
        const store = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(recordPrint(bill(), 'printed', { store })).toBe(false);
    });
});

describe('the print path records the outcome', () => {
    beforeEach(() => {
        jest.spyOn(PrinterService, 'canPrint').mockReturnValue(true);
        jest.spyOn(PrinterService, 'showBillPreview').mockResolvedValue(true);
    });

    test.each([
        ['printed', { outcome: 'printed' }, { s: 'printed' }],
        ['failed', { outcome: 'failed', error: { kind: 'timeout_connect' } }, { s: 'failed', err: 'the printer did not connect in time' }],
        ['uncertain', { outcome: 'uncertain' }, { s: 'uncertain' }]
    ])('%s', async (name, result, want) => {
        jest.spyOn(PrinterService, 'runJob').mockResolvedValue(result);
        const b = bill();
        const before = JSON.stringify(b);
        await PrinterService.printBill(b);
        expect(printStatusOf(b)).toMatchObject(want);
        expect(JSON.stringify(b)).toBe(before);
    });

    test('a cancelled reprint and the image preview (no printer) record nothing', async () => {
        jest.spyOn(PrinterService, 'runJob').mockResolvedValue({ outcome: 'cancelled' });
        await PrinterService.printBill(bill());
        expect(printStatusOf(bill())).toBeNull();
        PrinterService.canPrint.mockReturnValue(false);
        await PrinterService.printBill(bill());
        expect(printStatusOf(bill())).toBeNull();
    });
});

describe('History', () => {
    beforeEach(() => {
        AppState.purchaseHistory = [bill()];
        AppState.retailSalesHistory = [];
        AppState.salesHistory = [];
        window.currentBillType = 'purchase';
        window.currentBillId = 'p1';
        window.currentBillIndex = 0;
        jest.spyOn(HistoryManager, 'refreshHistory').mockImplementation(() => {});
    });

    test('rows show a chip only for bills this phone printed or tried to', () => {
        expect(buildBillRow(bill(), { kind: 'purchase' }).querySelector('.print-chip')).toBeNull();
        recordPrint(bill(), 'failed');
        const chip = buildBillRow(bill(), { kind: 'purchase' }).querySelector('.print-chip');
        expect(chip.className).toContain('print-chip--failed');
        expect(chip.textContent).toBe('Print failed');
    });

    test('details: not printed → Print again (no COPY mark) and Mark printed by hand', async () => {
        HistoryManager.renderPrintStatus();
        const box = () => document.getElementById('billPrintStatus');
        expect(box().dataset.state).toBe('none');
        expect(box().textContent).toContain('Not printed from this phone');
        expect(box().querySelectorAll('button')).toHaveLength(2);

        const print = jest.spyOn(PrinterService, 'printBill').mockImplementation(async (b) => { recordPrint(b, 'printed'); return true; });
        await HistoryManager.retryPrint();
        expect(print.mock.calls[0][0]).toMatchObject({ billNumber: 'P20261101-007', isCopy: false });
        expect(box().dataset.state).toBe('printed');
        expect(box().querySelectorAll('button')).toHaveLength(0);
        expect(HistoryManager.refreshHistory).toHaveBeenCalled();
    });

    test('details: failed → Mark printed by hand', () => {
        recordPrint(bill(), 'failed', { error: 'Paper out' });
        HistoryManager.renderPrintStatus();
        expect(document.getElementById('billPrintStatus').textContent).toContain('Paper out');
        HistoryManager.markPrintedByHand();
        expect(printStatusOf(bill()).s).toBe('hand');
        expect(document.getElementById('billPrintStatus').textContent).toContain('Marked printed by hand');
        expect(UIManager.showToast).toHaveBeenCalledWith('Marked as printed');
    });

    test('voided bills get no print line', () => {
        AppState.purchaseHistory = [{ ...bill(), voided: true }];
        HistoryManager.renderPrintStatus();
        expect(document.getElementById('billPrintStatus')).toBeNull();
    });

    test('the text says when, in the app language, and escapes the error', () => {
        recordPrint(bill(), 'failed', { error: '<b>x</b>' });
        HistoryManager.renderPrintStatus();
        expect(document.getElementById('billPrintStatus').innerHTML).not.toContain('<b>x</b>');
        expect(printStatusText(bill())).toMatch(/^Print failed, .+: <b>x<\/b>$/);
    });
});
