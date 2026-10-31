/**
 * @fileoverview History screen for voided bills (#75) and edit records (#121):
 * voided bills hidden behind a toggle, greyed with a "Voided" chip and the
 * reason; the bill details banner and buttons; "Edited N× · View changes"
 * reading the records only when tapped; the Void flow (who, payments block it,
 * a reason) and the owner's delete for good.
 */
jest.mock('../firebase/firestore-service.js', () => ({
    FirebaseService: {
        db: null,
        voidedBills: jest.fn(() => []),
        voidBill: jest.fn(async () => ({})),
        deleteVoidedBill: jest.fn(async () => {}),
        loadBillEdits: jest.fn(async () => []),
        calculateStock: jest.fn(async () => ({}))
    }
}));
jest.mock('../services/printer.js', () => ({ PrinterService: {} }));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(async () => {}), ACTIONS: { VOID_BILL: 'VOID_BILL', DELETE_BILL: 'DELETE_BILL', DELETE_SALE: 'DELETE_SALE' } } }));
jest.mock('../ui/infinite-scroll.js', () => ({ attachOlderHistoryScroll: jest.fn() }));

import fs from 'fs';
import path from 'path';
import { AppState } from '../utils/state.js';
import { HistoryManager } from '../modules/history.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AuditService } from '../services/audit.js';
import { UIManager } from '../ui/ui-manager.js';
import { setLang } from '../i18n/index.js';

const MODALS = fs.readFileSync(path.resolve(__dirname, '../../templates/modals.html'), 'utf8');
const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const bill = (id, extra = {}) => ({
    id, billNumber: id, userId: 'u1', createdAt: NOW - HOUR, timestamp: NOW - HOUR, customerName: 'Ramesh',
    items: [{ name: 'Wheat', qty: 10, rate: 50, total: 500 }], grandTotal: 500, billTotal: 500,
    payment: { cash: 500, online: 0, due: 0 }, ...extra
});
const VOIDED = bill('P-void', { voided: true, voidReason: 'Entered twice', voidedByName: 'Ravi', voidedAt: NOW - 1000 });

const rows = () => [...document.querySelectorAll('#historyList .history-item')].map(r => [r.querySelector('.bill-row__link').textContent.replace('#', ''), r.classList.contains('is-voided')]);
const shown = (id) => document.getElementById(id).style.display !== 'none';
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function answerReason(text) {
    return jest.spyOn(UIManager, 'showModalWithHtml').mockImplementation(async (html) => {
        document.getElementById('modalMessage').innerHTML = html;
        if (text === null) return false;
        document.getElementById('reasonInput').value = text;
        return true;
    });
}

beforeEach(() => {
    setLang('en');
    document.body.innerHTML = `<div id="history"><input id="historySearch" value=""><div id="historyList"></div></div>${MODALS}`;
    sessionStorage.clear();
    localStorage.clear();
    HistoryManager.filter = null;
    HistoryManager.pageKey = '';
    HistoryManager.viewMode = 'card';
    HistoryManager.showVoided = { purchase: false, sale: false };
    AppState.historyLoadedFrom = 0;
    AppState.currentUser = { uid: 'u1' };
    AppState.userRole = 'owner';
    AppState.settings = {};
    AppState.purchaseHistory = [bill('P-1'), bill('P-2', { editCount: 2 })];
    AppState.retailSalesHistory = [];
    FirebaseService.voidedBills.mockImplementation((coll) => (coll === 'purchases' ? [VOIDED] : []));
    jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
    jest.spyOn(UIManager, 'showLoading').mockImplementation(() => {});
    jest.spyOn(UIManager, 'hideLoading').mockImplementation(() => {});
    window.app = {};
});

afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    delete window.app;
});

describe('voided bills in History (#75)', () => {
    test('hidden by default behind "Show voided bills (N)"; shown greyed with the chip and the reason', () => {
        HistoryManager.refreshHistory();
        expect(rows()).toEqual([['P-1', false], ['P-2', false]]);
        const chip = document.getElementById('historyVoidedToggle');
        expect(chip.textContent).toBe('Show voided bills (1)');
        chip.click();
        expect(rows()).toEqual([['P-void', true], ['P-1', false], ['P-2', false]]);
        expect(document.querySelector('.bill-group--voided .bill-group__title').textContent).toBe('Voided bills (not counted anywhere)');
        const row = document.querySelector('.history-item.is-voided');
        expect(row.querySelector('.voided-chip').textContent).toBe('Voided');
        expect(row.querySelector('.voided-reason').textContent).toBe('Entered twice');
        expect(document.getElementById('historyVoidedToggle').textContent).toBe('Hide voided bills (1)');
    });

    test('Table View lists them in their own group too', () => {
        HistoryManager.showVoided = { purchase: true, sale: false };
        HistoryManager.viewMode = 'table';
        HistoryManager.refreshHistory();
        expect([...document.querySelectorAll('.bill-table__row')].map(r => r.classList.contains('is-voided'))).toEqual([true, false, false]);
    });

    test('the details of a voided bill: banner with reason, who and when; no Edit, Void, Reprint or Share; the owner may delete it for good', async () => {
        await HistoryManager.viewBill('id:P-void', 'purchase');
        const banner = document.querySelector('.bill-voided-banner');
        expect(banner.textContent).toContain('Reason: Entered twice');
        expect(banner.textContent).toContain('Voided by Ravi');
        expect(['billEditBtn', 'billVoidBtn', 'billReprintBtn', 'billShareBtn', 'billDeleteBtn'].map(shown)).toEqual([false, false, false, false, true]);
        AppState.userRole = 'manager';
        await HistoryManager.viewBill('id:P-void', 'purchase');
        expect(shown('billDeleteBtn')).toBe(false);
    });

    test('Delete permanently (owner, voided bill) asks first, then deletes it with its records', async () => {
        await HistoryManager.viewBill('id:P-void', 'purchase');
        jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        await HistoryManager.confirmDeleteBill();
        expect(FirebaseService.deleteVoidedBill).toHaveBeenCalledWith('purchases', VOIDED);
        expect(AuditService.log).toHaveBeenCalledWith('DELETE_BILL', expect.objectContaining({ billNumber: 'P-void', voided: true }));
    });
});

describe('Void (#75)', () => {
    test('who sees Void: the owner; a member on their own bill inside the window, not on another\'s', async () => {
        await HistoryManager.viewBill('id:P-1', 'purchase');
        expect(['billEditBtn', 'billVoidBtn', 'billDeleteBtn'].map(shown)).toEqual([true, true, false]);
        AppState.userRole = 'staff';
        await HistoryManager.viewBill('id:P-1', 'purchase');
        expect(shown('billVoidBtn')).toBe(true);
        AppState.currentUser = { uid: 'u2' };
        await HistoryManager.viewBill('id:P-1', 'purchase');
        expect(shown('billVoidBtn')).toBe(false);
    });

    test('asks for a reason, voids, logs it and closes the details', async () => {
        AppState.userRole = 'staff';
        await HistoryManager.viewBill('id:P-1', 'purchase');
        answerReason('  Entered twice ');
        await HistoryManager.confirmVoidBill();
        await flush();
        expect(FirebaseService.voidBill).toHaveBeenCalledWith('purchases', AppState.purchaseHistory[0], 'Entered twice');
        expect(AuditService.log).toHaveBeenCalledWith('VOID_BILL', expect.objectContaining({ billNumber: 'P-1', billType: 'purchase', amount: 500, reason: 'Entered twice' }));
        expect(UIManager.showToast).toHaveBeenCalledWith('Bill voided');
        expect(document.getElementById('billDetailsOverlay').classList.contains('active')).toBe(false);
    });

    test('no reason, or a cancel: nothing is voided', async () => {
        await HistoryManager.viewBill('id:P-1', 'purchase');
        answerReason('ok');
        await HistoryManager.confirmVoidBill();
        expect(UIManager.showToast).toHaveBeenCalledWith('Write a reason (at least 3 letters).');
        answerReason(null);
        await HistoryManager.confirmVoidBill();
        expect(FirebaseService.voidBill).not.toHaveBeenCalled();
    });

    test('a bill with payments recorded after it was saved is not voided, and the user is told why', async () => {
        AppState.purchaseHistory = [bill('P-1', { payments: [{ amount: 100, cash: 100 }] })];
        await HistoryManager.viewBill('id:P-1', 'purchase');
        const modal = jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        const ask = answerReason('Entered twice');
        await HistoryManager.confirmVoidBill();
        expect(modal.mock.calls[0][0]).toMatch(/payments recorded after it was saved/);
        expect(ask).not.toHaveBeenCalled();
        expect(FirebaseService.voidBill).not.toHaveBeenCalled();
    });

    test('offline: needs the internet', async () => {
        jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
        await HistoryManager.viewBill('id:P-1', 'purchase');
        await HistoryManager.confirmVoidBill();
        expect(UIManager.showToast).toHaveBeenCalledWith('Voiding a bill needs the internet.');
        expect(FirebaseService.voidBill).not.toHaveBeenCalled();
    });
});

describe('edit history in the bill details (#121)', () => {
    const EDITS = [
        { n: 1, at: NOW - 3 * HOUR, byName: 'Ravi', reason: 'Wrong rate', fields: { grandTotal: { before: 450, after: 500 } }, lines: [] },
        { n: 2, at: NOW - 2 * HOUR, byName: 'Amit', reason: 'Name spelling', fields: { customerName: { before: 'Ramsh', after: 'Ramesh' } }, lines: [] }
    ];

    test('"Edited 2× · View changes" reads the records only when tapped, once', async () => {
        FirebaseService.loadBillEdits.mockResolvedValue(EDITS);
        await HistoryManager.viewBill('id:P-2', 'purchase');
        expect(document.querySelector('.bill-edits__count').textContent).toBe('Edited 2×');
        expect(FirebaseService.loadBillEdits).not.toHaveBeenCalled();
        await HistoryManager.showEdits();
        expect(FirebaseService.loadBillEdits).toHaveBeenCalledWith('purchases', AppState.purchaseHistory[1]);
        const list = document.getElementById('billEditsList');
        expect([...list.querySelectorAll('.bill-edit__reason')].map(e => e.textContent)).toEqual(['Reason: Wrong rate', 'Reason: Name spelling']);
        expect([...list.querySelectorAll('li')].map(e => e.textContent)).toEqual(['Total: ₹450 → ₹500', 'Party: Ramsh → Ramesh']);
        expect(document.getElementById('billEditsToggle').textContent).toBe('Hide changes');
        await HistoryManager.showEdits();
        expect(list.hidden).toBe(true);
        await HistoryManager.showEdits();
        expect(list.hidden).toBe(false);
        expect(FirebaseService.loadBillEdits).toHaveBeenCalledTimes(1);
    });

    test('never-edited bills show nothing; a failed read says so', async () => {
        await HistoryManager.viewBill('id:P-1', 'purchase');
        expect(document.getElementById('billEditsBox')).toBeNull();
        FirebaseService.loadBillEdits.mockRejectedValue(new Error('offline'));
        jest.spyOn(console, 'error').mockImplementation(() => {});
        await HistoryManager.viewBill('id:P-2', 'purchase');
        await HistoryManager.showEdits();
        expect(document.getElementById('billEditsList').textContent).toBe("Couldn't load the changes. Check the internet and try again.");
    });

    test('in Hindi', async () => {
        setLang('hi');
        FirebaseService.loadBillEdits.mockResolvedValue(EDITS.slice(0, 1));
        await HistoryManager.viewBill('id:P-2', 'purchase');
        expect(document.querySelector('.bill-edits__count').textContent).toBe('2 बार बदला गया');
        await HistoryManager.showEdits();
        expect(document.querySelector('.bill-edit__reason').textContent).toBe('कारण: Wrong rate');
        expect(document.querySelector('#billEditsList li').textContent).toBe('कुल: ₹450 → ₹500');
        setLang('en');
    });
});
