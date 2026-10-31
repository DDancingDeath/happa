/**
 * @fileoverview Characterisation of the Today page (docs/calculations.md T1–T16,
 * T-LAB-1..3 and the item cards): the exact screen text, item card HTML and
 * day-report figures for the days in tests/fixtures/calculations/today-days.json,
 * pinned before the figures moved out of modules/day.js. A change here is a
 * change on screen. `TODAY_RECORD=1 npx jest today-characterisation` rewrites
 * today-days.expected.json (only for an intended change; say why in the PR).
 */
import fs from 'fs';
import path from 'path';
import { DayManager } from '../modules/day.js';
import { AnomaliesManager } from '../modules/anomalies.js';
import { HealthManager } from '../modules/health.js';
import { CashManagementManager } from '../modules/cash-management.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { TODAY_SPEC, todaySummary } from '../utils/calc/today.js';

const FIXTURES = path.resolve(__dirname, '../../../tests/fixtures/calculations');
const FIX = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'today-days.json'), 'utf8'));
const EXPECTED_FILE = path.join(FIXTURES, 'today-days.expected.json');
const TEMPLATE = fs.readFileSync(path.resolve(__dirname, '../../templates/day.html'), 'utf8');
const RECORD = !!process.env.TODAY_RECORD;
const EXPECTED = RECORD ? {} : JSON.parse(fs.readFileSync(EXPECTED_FILE, 'utf8'));

const TEXT_IDS = [
    'todayTotalPurchases', 'todayPurchaseCount', 'todayTotalSales', 'todaySaleCount',
    'todayLaborCost', 'todayLabourDeductedBills', 'todayLabourToPay', 'todayLabourToPayCalc', 'todayLabourDiff',
    'todayBusinessExpenses', 'todayBusinessExpenseCount', 'todayPersonalExpenses', 'todayPersonalExpenseCount',
    'todayCashReceived', 'todayOnlineReceived', 'todayCashPaid', 'todayOnlinePaid',
    'todayTotalIn', 'todayTotalOut', 'todayCashFlowLabel', 'todayNetCashFlow', 'todayTotalCashFlow',
    'todayDueReceived', 'todayDuePaid', 'todayDueToReceive', 'todayDueToPay'
];
const copy = (v) => JSON.parse(JSON.stringify(v));

function renderToday(c) {
    // todayTotalCashFlow is not in the template; the page still fills it when present.
    document.body.innerHTML = `${TEMPLATE}<div id="todayTotalCashFlow"></div>`;
    jest.setSystemTime(new Date(c.now));
    AppState.purchaseHistory = copy(c.purchases);
    AppState.salesHistory = copy(c.wholesaleSales);
    AppState.retailSalesHistory = copy(c.retailSales);
    AppState.expensesHistory = copy(c.expenses);
    AppState.settings = copy(c.settings);
    CashManagementManager.todaySession = copy(c.liveSession);
    DayManager.daySessions = { date: c.now.slice(0, 10), list: copy(c.daySessions) };
    const report = jest.spyOn(AnomaliesManager, 'renderDayReport').mockImplementation(() => {});
    DayManager.loadTodayData();
    const [totals, session] = report.mock.calls[0];
    const modal = jest.spyOn(UIManager, 'showModalWithHtml').mockResolvedValue(true);
    DayManager.showLabourBreakdown();
    return {
        text: Object.fromEntries(TEXT_IDS.map(id => [id, document.getElementById(id).textContent])),
        netColor: document.getElementById('todayNetCashFlow').style.color,
        purchaseItems: document.getElementById('todayPurchaseItems').innerHTML,
        saleItems: document.getElementById('todaySaleItems').innerHTML,
        dayReport: copy(totals),
        dayReportSession: session ? session.id : null,
        labourBreakdown: modal.mock.calls[0][0]
    };
}

beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(HealthManager, 'renderTodayBanner').mockResolvedValue();
});
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    CashManagementManager.todaySession = null;
    DayManager.daySessions = { date: null, list: [] };
    ['purchaseHistory', 'salesHistory', 'retailSalesHistory', 'expensesHistory'].forEach(k => { AppState[k] = []; });
});
afterAll(() => {
    if (RECORD) fs.writeFileSync(EXPECTED_FILE, `${JSON.stringify(EXPECTED, null, 2)}\n`);
});

describe('Today screen, pinned (today-days.json)', () => {
    test.each(Object.keys(FIX.cases))('%s day', (name) => {
        const got = renderToday(FIX.cases[name]);
        if (RECORD) EXPECTED[name] = got;
        else expect(got).toEqual(EXPECTED[name]);
    });
});

describe('todaySummary() alone (utils/calc/today.js)', () => {
    const summaryOf = (c) => todaySummary({
        bills: { purchase: copy(c.purchases), wholesale: copy(c.wholesaleSales), retail: copy(c.retailSales) },
        expenses: copy(c.expenses),
        sessions: [c.liveSession, ...c.daySessions].filter(Boolean).map(copy),
        settings: copy(c.settings),
        today: new Date(c.now)
    });

    test.each(Object.keys(FIX.cases))('%s day: the pinned day-report figures', (name) => {
        if (RECORD) return;
        const s = summaryOf(FIX.cases[name]);
        expect({
            sales: s.sales, saleCount: s.saleCount, purchases: s.purchases, purchaseCount: s.purchaseCount,
            expenses: s.expenses, totalIn: s.totalIn, totalOut: s.totalOut, dueReceived: s.dueReceived, duePaid: s.duePaid,
            labourDeducted: s.labour.deducted.amount, labourDeductedBills: s.labour.deducted.bills, labourToPay: s.labour.toPay
        }).toEqual(EXPECTED[name].dayReport);
    });

    test('every figure has a spec ID that docs/calculations.md defines', () => {
        const s = summaryOf(FIX.cases.rich);
        expect(Object.keys(s).filter(k => k !== 'from' && k !== 'to').sort()).toEqual(Object.keys(TODAY_SPEC).sort());
        const doc = fs.readFileSync(path.resolve(__dirname, '../../../docs/calculations.md'), 'utf8');
        const ids = new Set(Object.values(TODAY_SPEC).flatMap(v => v.split(', ')));
        ids.forEach(id => expect(doc).toMatch(new RegExp(`^\\| ${id} \\|`, 'm')));
    });
});
