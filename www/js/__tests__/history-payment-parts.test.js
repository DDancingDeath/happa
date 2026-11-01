/**
 * @fileoverview Bill details split the money the way Today's "By bill type" does
 * (#141, T18): paid at save, paid later, written off and still due, adding up to
 * the total, so tapping a row on Today shows matching parts.
 */
jest.mock('../firebase/firestore-service.js', () => ({
    FirebaseService: { db: null, voidedBills: jest.fn(() => []), loadBillEdits: jest.fn(async () => []), calculateStock: jest.fn(async () => ({})) }
}));
jest.mock('../services/printer.js', () => ({ PrinterService: {} }));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(async () => {}), ACTIONS: {} } }));
jest.mock('../ui/infinite-scroll.js', () => ({ attachOlderHistoryScroll: jest.fn() }));

import fs from 'fs';
import path from 'path';
import { AppState } from '../utils/state.js';
import { HistoryManager } from '../modules/history.js';
import { setLang } from '../i18n/index.js';

const MODALS = fs.readFileSync(path.resolve(__dirname, '../../templates/modals.html'), 'utf8');
const NOW = Date.now();
const sale = (extra) => ({
    id: 'w1', billNumber: 'W-1', type: 'wholesale', userId: 'u1', createdAt: NOW, timestamp: NOW, date: new Date(NOW).toISOString(),
    customerName: 'Trader', items: [{ name: 'Maize', qty: 200, rate: 25, total: 5000 }], total: 5000, ...extra
});
const lines = () => {
    const h4 = [...document.querySelectorAll('#billDetailsContent h4')].find(h => h.textContent === 'Payment Details');
    return [...h4.parentElement.children].slice(1).map(d => d.textContent.replace(/\s+/g, ' ').trim());
};

beforeEach(() => {
    setLang('en');
    document.body.innerHTML = MODALS;
    AppState.currentUser = { uid: 'u1' };
    AppState.userRole = 'owner';
    AppState.settings = {};
});

test('paid later: save-time cash/online, then the later payments, then the due', async () => {
    AppState.salesHistory = [sale({
        payment: { cash: 2500, online: 500, due: 2000, total: 5000 },
        payments: [{ id: 'p1', cash: 1500, online: 500, at: NOW }]
    })];
    await HistoryManager.viewBill('id:w1', 'wholesale');
    expect(lines()).toEqual(['Cash at save: ₹1,000', 'Paid later:cash ₹1,500 · online ₹500 ₹2,000', 'Due: ₹2,000']);
});

test('no later payment: plain Cash / Online labels, as before', async () => {
    AppState.salesHistory = [sale({ payment: { cash: 4000, online: 1000, due: 0, total: 5000 } })];
    await HistoryManager.viewBill('id:w1', 'wholesale');
    expect(lines()).toEqual(['Online: ₹1,000', 'Cash: ₹4,000']);
});

test('written off later', async () => {
    AppState.salesHistory = [sale({ cleared: true, payment: { cash: 3000, online: 0, due: 2000, total: 5000 }, payments: [{ id: 'p2', kind: 'writeOff', amount: 2000, at: NOW }] })];
    await HistoryManager.viewBill('id:w1', 'wholesale');
    expect(lines()).toEqual(['Cash at save: ₹3,000', 'Written off: ₹2,000']);
});

test('a voided bill still shows what was paid', async () => {
    AppState.salesHistory = [sale({ voided: true, voidReason: 'Entered twice', payment: { cash: 4500, online: 500, due: 0, total: 5000 } })];
    await HistoryManager.viewBill('id:w1', 'wholesale');
    expect(lines()).toEqual(['Online: ₹500', 'Cash: ₹4,500']);
});
