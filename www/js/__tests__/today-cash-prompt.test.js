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
