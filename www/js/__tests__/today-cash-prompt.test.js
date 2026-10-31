/** Today: the "Open cash" prompt (#141, Q41) shows only when today has bills, the day's sessions are loaded and none is open. */
import fs from 'fs';
import path from 'path';
import { DayManager } from '../modules/day.js';
import { CashManagementManager } from '../modules/cash-management.js';
import { todayLocalISO } from '../utils/dates.js';

const prompt = () => document.getElementById('todayCashPrompt');

beforeEach(() => {
    document.body.innerHTML = fs.readFileSync(path.resolve(__dirname, '../../templates/day.html'), 'utf8');
    CashManagementManager.todaySession = null;
    DayManager.daySessions = { date: null, list: [] };
});
afterEach(() => {
    CashManagementManager.todaySession = null;
    DayManager.daySessions = { date: null, list: [] };
});

test('hidden until the day\'s sessions are loaded', () => {
    DayManager.renderCashPrompt(true, todayLocalISO());
    expect(prompt().hidden).toBe(true);
});

test('shown with bills and no session; hidden without bills', () => {
    const day = todayLocalISO();
    DayManager.daySessions = { date: day, list: [] };
    DayManager.renderCashPrompt(true, day);
    expect(prompt().hidden).toBe(false);
    DayManager.renderCashPrompt(false, day);
    expect(prompt().hidden).toBe(true);
});

test('hidden once a session of today exists (loaded, or opened on this phone)', () => {
    const day = todayLocalISO();
    DayManager.daySessions = { date: day, list: [{ id: 's1', date: day }] };
    DayManager.renderCashPrompt(true, day);
    expect(prompt().hidden).toBe(true);
    DayManager.daySessions = { date: day, list: [] };
    CashManagementManager.todaySession = { id: 's2', date: day };
    DayManager.renderCashPrompt(true, day);
    expect(prompt().hidden).toBe(true);
});

test('members without the Wholesale page see no wholesale card or bills', () => {
    const { AppState } = require('../utils/state.js');
    const day = todayLocalISO();
    const now = new Date().toISOString();
    AppState.userRole = 'staff';
    AppState.settings = {};
    AppState.salesHistory = [{ id: 'w1', billNumber: 'W-1', date: now, total: 500, cashPayment: 500, payment: { cash: 500, online: 0, due: 0, total: 500 } }];
    AppState.retailSalesHistory = [{ id: 'r1', billNumber: 'S-1', date: now, total: 100, cashPayment: 100, payment: { cash: 100, online: 0, due: 0, total: 100 } }];
    AppState.purchaseHistory = [];
    AppState.expensesHistory = [];
    DayManager.daySessions = { date: day, list: [] };
    const { AnomaliesManager } = require('../modules/anomalies.js');
    const { HealthManager } = require('../modules/health.js');
    jest.spyOn(AnomaliesManager, 'renderDayReport').mockImplementation(() => {});
    jest.spyOn(HealthManager, 'renderTodayBanner').mockResolvedValue();
    DayManager.loadTodayData();
    expect(document.getElementById('todayChWholesale').hidden).toBe(true);
    const rows = [...document.querySelectorAll('.today-bill-row')].map(r => r.getAttribute('onclick'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("'retail'");
    expect(prompt().hidden).toBe(false);
    AppState.userRole = 'owner';
    DayManager.loadTodayData();
    expect(document.getElementById('todayChWholesale').hidden).toBe(false);
    expect(document.querySelectorAll('.today-bill-row')).toHaveLength(2);
    jest.restoreAllMocks();
    ['salesHistory', 'retailSalesHistory'].forEach(k => { AppState[k] = []; });
    AppState.userRole = null;
});
