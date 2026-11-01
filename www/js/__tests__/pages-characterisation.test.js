/**
 * @fileoverview Characterisation of the Stock, Insights, Money, Outstanding
 * (aging) and Statements screens (docs/calculations.md S1–S4, I*, M*, O*, ST*),
 * pinned before their maths moved into utils/calc/stock.js,
 * utils/business-metrics.js and utils/dates.js. Each "today" is an edge of the
 * calendar (the 1st, 31 Jan, 29 Feb, 31 Mar, 1 Jan) with a generated two-year
 * shop ending that day; a hand-made stock case covers merged / unmatched
 * buckets, staff and legacy adjustments. A change here is a change on screen.
 * `PAGES_RECORD=1 npx jest pages-characterisation` rewrites
 * tests/fixtures/calculations/pages-pinned.expected.json (only for an intended
 * change; say why in the PR).
 */
import fs from 'fs';
import path from 'path';
import { generateShop } from '../../../tests/fixtures/generator.js';
import { StockManager } from '../modules/stock.js';
import { InsightsManager } from '../modules/insights.js';
import { MoneyManager } from '../modules/money.js';
import { OutstandingManager } from '../modules/outstanding.js';
import { StatementsManager } from '../modules/statements.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { computeStock } from '../utils/stock-replay.js';
import { setInsightsContext, resetInsightsContextForTests, getInsightsContext } from '../utils/insights-context.js';
import { moneySummary } from '../utils/business-metrics.js';
import { buildSnapshot, lastMonthKeys, monthBounds } from '../utils/month-snapshots.js';

const ROOT = path.resolve(__dirname, '../../..');
const EXPECTED_FILE = path.join(ROOT, 'tests/fixtures/calculations/pages-pinned.expected.json');
const RECORD = !!process.env.PAGES_RECORD;
const EXPECTED = RECORD ? {} : JSON.parse(fs.readFileSync(EXPECTED_FILE, 'utf8'));
const template = (name) => fs.readFileSync(path.join(ROOT, `www/templates/${name}.html`), 'utf8');
const TEMPLATES = {
    stock: template('stock'), insights: template('insights'), money: template('money'),
    due: template('due'), statements: template('statements')
};
const copy = (v) => JSON.parse(JSON.stringify(v));
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/** Edge "today"s (local IST). */
const NOWS = {
    first: '2026-11-01T10:00:00',
    jan31: '2027-01-31T15:30:00',
    leapDay: '2028-02-29T12:00:00',
    mar31: '2027-03-31T18:00:00',
    jan1: '2027-01-01T09:00:00'
};
const HISTORY_DAYS = 730;

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const shops = {};
/** Two years of generated shop ending the day after `now` (so "today" has bills). */
function shopFor(name) {
    if (shops[name]) return shops[name];
    const now = new Date(NOWS[name]);
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (HISTORY_DAYS - 1));
    const shop = generateShop({ seed: 7, years: HISTORY_DAYS / 365, start: isoDay(start), activity: 0.3, openingRate: 1 });
    shops[name] = shop;
    return shop;
}

/** rateStats-like year docs (RT4 months) with a fixed season shape per item. */
function seasonDocs(items, now) {
    const docs = [];
    const y = now.getFullYear();
    items.forEach((item, n) => {
        [y - 2, y - 1, y].forEach(year => {
            const months = {};
            for (let m = 0; m < 12; m++) {
                const kg = Math.round(40 + 30 * (n + 1) * (1 + Math.sin((m + n * 2) / 1.9)));
                months[`m${year}-${pad(m + 1)}`] = { retail: { kg: kg / 4 }, wholesale: { kg: (kg * 3) / 4 } };
            }
            docs.push({ itemId: item.id, year: String(year), months });
        });
    });
    return docs;
}

function loadShop(shop, { loadedFrom = 0 } = {}) {
    AppState.items = copy(shop.items);
    AppState.purchaseHistory = copy(shop.purchases);
    AppState.salesHistory = copy(shop.wholesaleSales);
    AppState.retailSalesHistory = copy(shop.retailSales);
    AppState.stockAdjustments = copy(shop.stockAdjustments);
    AppState.expensesHistory = copy(shop.expenses);
    AppState.withdrawalsHistory = copy(shop.withdrawals);
    AppState.historyLoadedFrom = loadedFrom;
    AppState.userRole = 'owner';
    AppState.settings = {};
    AppState.stockReady = true;
    AppState.stockApprox = null;
    AppState.stock = computeStock({
        purchases: AppState.purchaseHistory, wholesaleSales: AppState.salesHistory,
        retailSales: AppState.retailSalesHistory, stockAdjustments: AppState.stockAdjustments
    }, AppState.items);
}

/** id → squashed text of every element with an id that holds no other element with an id. */
function leafTexts(root) {
    const out = {};
    root.querySelectorAll('[id]').forEach(el => {
        if (el.querySelector('[id]')) return;
        const text = squash(el.textContent);
        if (text) out[el.id] = text;
    });
    return out;
}

function pin(key, got) {
    if (RECORD) EXPECTED[key] = got;
    else expect(got).toEqual(EXPECTED[key]);
}

beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(UIManager, 'withLoading').mockImplementation(async (fn) => fn());
    // an owner phone whose personal expense listener delivered its rows (#98)
    jest.spyOn(FirebaseService, 'personalRowsLoaded').mockReturnValue(true);
    localStorage.clear();
    resetInsightsContextForTests();
    MoneyManager.snapshots = {};
    MoneyManager.snapshotsLoaded = true;
    MoneyManager.sessionCache = new Map();
    MoneyManager.drawerCache = null;
    MoneyManager.summaryCache = { sig: null, map: new Map(), computed: 0 };
    MoneyManager.section = 'profit';
    MoneyManager.sharedAccounts = { state: 'idle', list: null, map: null };
    jest.spyOn(FirebaseService, 'loadWorthAccounts').mockResolvedValue({});
});
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete window.FirebaseService;
});
afterAll(() => {
    if (RECORD) fs.writeFileSync(EXPECTED_FILE, `${JSON.stringify(EXPECTED, null, 2)}\n`);
});

// ---------------------------------------------------------------- Stock (S1–S4)

const STOCK_ITEMS = [
    { id: 'i-rice', name: 'Rice', hindiName: 'चावल' },
    { id: 'i-wheat', name: 'Wheat', hindiName: 'गेहूं' },
    { id: 'i-dal', name: 'Dal', hindiName: '' },
    { id: 'i-zero', name: 'Zero', hindiName: '' },
    { id: 'i-salt', name: 'Salt', hindiName: '' }
];
const STOCK = {
    'i-rice': { quantity: 120.5, rate: 31.333333 },
    'rice ': { quantity: 12.4, rate: 33.5 },
    'गेहूं': { quantity: 40, rate: 26 },
    'i-dal': { quantity: 0.04, rate: 0 },
    'i-zero': { quantity: 0, rate: 50 },
    'i-salt': { quantity: 3.333, rate: 7.777 },
    'ghost item': { quantity: -3.5, rate: 0 },
    'old name': { quantity: 7.25, rate: 12.75 }
};
const T0 = new Date('2027-01-31T15:30:00').getTime();
const ADJUSTMENTS = [
    { id: 'a1', itemId: 'i-rice', itemName: 'Rice', adjustType: 'add', quantity: 10, rate: 30, previousStock: 110.5, newStock: 120.5, reason: 'found', date: '31/01/2027, 10:00:00 am', timestamp: T0 - 1000, createdByName: 'Owner' },
    { id: 'a2', itemId: 'i-wheat', itemName: 'Wheat', adjustType: 'remove', quantity: 2, rate: 0, previousStock: 42, newStock: 40, reason: 'spoiled', date: '30/01/2027', timestamp: T0 - 2000 },
    { id: 'a3', itemName: 'Dal', date: '2026-12-01', timestamp: T0 - 3000 },
    { id: 'a4', itemId: 'i-rice', itemName: 'Rice', adjustType: 'set', quantity: 0.01, rate: 30, previousStock: 0, newStock: 0.01, reason: 'count', date: '2026-11-30', timestamp: T0 - 4000 },
    { id: 'a5', itemId: 'i-dal', itemName: 'Dal', adjustType: 'remove', quantity: 5, rawQuantity: 8, rate: 0, previousStock: 5, newStock: 0, date: '2026-11-29', timestamp: T0 - 5000 },
    { id: 'a6', itemName: 'old name', adjustType: 'add', quantity: '3', rate: 0, previousStock: 4.25, newStock: 7.25, date: '2026-11-28', timestamp: T0 - 6000 },
    { id: 'a7', itemId: 'i-salt', itemName: 'Salt', adjustType: 'add', quantity: 1.111, rate: 7.777, previousStock: 2.222, newStock: 3.333, date: '2026-11-27', timestamp: T0 - 7000 }
];

function stockPage({ role = 'owner' } = {}) {
    document.body.innerHTML = TEMPLATES.stock;
    jest.setSystemTime(new Date(T0));
    AppState.items = copy(STOCK_ITEMS);
    AppState.userRole = role;
    AppState.settings = {};
    AppState.stockReady = true;
    AppState.stockApprox = null;
    AppState.stockAdjustments = copy(ADJUSTMENTS);
    AppState.purchaseHistory = [];
    AppState.salesHistory = [];
    AppState.retailSalesHistory = [];
    AppState.historyLoadedFrom = 0;
    jest.spyOn(FirebaseService, 'getStock').mockImplementation(async () => copy(STOCK));
}

async function stockScreen() {
    await StockManager.renderStock();
    const list = [...document.querySelectorAll('#stockList .stock-item')].map(el => squash(el.textContent));
    await StockManager.renderAdjustmentHistory();
    const adjustments = [...document.querySelectorAll('#adjustmentHistory .history-item')].map(el => squash(el.textContent));
    await StockManager.renderDeadStock();
    const dead = { summary: squash(document.getElementById('deadStockSummary').textContent), rows: [...document.querySelectorAll('#deadStockList .stock-item')].map(el => squash(el.textContent)) };
    const current = {};
    StockManager.loadAdjustItemsDropdown();
    for (const item of [...STOCK_ITEMS, { id: '' }]) {
        document.getElementById('adjustItem').value = item.id;
        StockManager.loadAdjustItemStock();
        const shown = document.getElementById('avgRateDisplay').style.display;
        current[item.id || '(none)'] = { stock: document.getElementById('currentStockDisplay').textContent, avgRate: shown === 'none' ? null : document.getElementById('avgRateValue').textContent };
    }
    return { list, adjustments, dead, current };
}

describe('Stock screen, pinned (S1–S4, adjustment value)', () => {
    test('owner: rows, value, average rate, adjustment values', async () => {
        stockPage();
        pin('stock.owner', await stockScreen());
    });

    test('staff: "Available" above 100 kg, rate shown', async () => {
        stockPage({ role: 'staff' });
        await StockManager.renderStock();
        pin('stock.staff', [...document.querySelectorAll('#stockList .stock-item')].map(el => squash(el.textContent)));
    });

    test.each(Object.keys(NOWS))('generated shop, %s: stock rows and dead stock', async (name) => {
        document.body.innerHTML = TEMPLATES.stock;
        jest.setSystemTime(new Date(NOWS[name]));
        loadShop(shopFor(name));
        const stock = copy(AppState.stock);
        jest.spyOn(FirebaseService, 'getStock').mockImplementation(async () => copy(stock));
        await StockManager.renderStock();
        const list = [...document.querySelectorAll('#stockList .stock-item')].map(el => squash(el.textContent));
        await StockManager.renderDeadStock();
        const dead = { summary: squash(document.getElementById('deadStockSummary').textContent), rows: [...document.querySelectorAll('#deadStockList .stock-item')].map(el => squash(el.textContent)) };
        AppState.stockAdjustments = AppState.stockAdjustments.slice(-8);
        await StockManager.renderAdjustmentHistory();
        const adjustments = [...document.querySelectorAll('#adjustmentHistory .history-item')].map(el => squash(el.textContent));
        pin(`stock.${name}`, { list, dead, adjustments });
    });
});

// ---------------------------------------------------------------- Insights (I*)

function insightsPage(name, { loadedFrom = 0 } = {}) {
    document.body.innerHTML = TEMPLATES.insights;
    document.getElementById('insights').classList.add('active');
    const now = new Date(NOWS[name]);
    jest.setSystemTime(now);
    const shop = shopFor(name);
    loadShop(shop, { loadedFrom });
    jest.spyOn(MoneyManager, 'loadSnapshots').mockResolvedValue();
    Object.assign(InsightsManager, { section: 'actions', seasonView: 'calendar', itemsType: 'both', partyKind: 'sales', seasonDocs: seasonDocs(shop.items, now), seasonLoading: null });
    return now;
}

const insightsTexts = () => leafTexts(document.getElementById('insights'));

describe('Insights screen, pinned (I1–I11, top-5 share, seasons)', () => {
    test.each(Object.keys(NOWS))('%s: every section', (name) => {
        insightsPage(name);
        const got = {};
        InsightsManager.init('actions');
        got.actions = insightsTexts();
        InsightsManager.setSection('items');
        got.items = insightsTexts();
        InsightsManager.setItemsType('retail');
        got.itemsRetail = squash(document.getElementById('insightsItemsTable').textContent);
        InsightsManager.setSection('parties');
        got.customers = insightsTexts();
        InsightsManager.setPartyKind('purchases');
        got.suppliers = { table: squash(document.getElementById('insightsSuppliersTable').textContent), takeaway: squash(document.getElementById('insightsPartiesTakeaway').textContent) };
        InsightsManager.setSection('seasons');
        got.seasons = { calendar: document.getElementById('insightsCalendar').innerHTML, takeaway: squash(document.getElementById('insightsSeasonTakeaway').textContent) };
        ['last-30', 'this-year', 'last-year'].forEach(preset => {
            InsightsManager.setPreset(preset);
            InsightsManager.setSection('items');
            got[`items.${preset}`] = { label: document.getElementById('insightsPeriodLabel').textContent, split: squash(document.getElementById('insightsSplit').textContent), checks: squash(document.getElementById('insightsChecks').textContent) };
        });
        pin(`insights.${name}`, got);
    });

    test.each(Object.keys(NOWS))('%s: month steps, calendar taps and "load older"', async (name) => {
        const now = insightsPage(name, { loadedFrom: 1 });
        InsightsManager.init('seasons');
        const got = { steps: [], taps: [] };
        setInsightsContext({ preset: 'this-month' });
        for (const dir of [-1, -1, -1, 1, 1, 1, 1]) {
            InsightsManager.step(dir);
            got.steps.push(getInsightsContext().preset);
        }
        setInsightsContext({ preset: 'this-year' });
        InsightsManager.step(-1);
        got.steps.push(getInsightsContext().preset);
        for (let m = 0; m < 12; m++) {
            InsightsManager.section = 'seasons';
            InsightsManager.seasonView = 'calendar';
            InsightsManager.render();
            const cell = document.querySelector(`#insightsCalendar [data-cal-month="${m}"]`);
            jest.spyOn(InsightsManager, 'render').mockImplementation(() => {});
            cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            InsightsManager.render.mockRestore();
            got.taps.push(getInsightsContext().preset);
        }
        const asked = [];
        window.FirebaseService = {
            getHistoryWindowStart: () => now.getTime(),
            isFullHistoryLoaded: () => false,
            ensureHistoryFrom: jest.fn(async (ms) => { asked.push(new Date(ms).toString()); return true; })
        };
        jest.spyOn(InsightsManager, 'render').mockImplementation(() => {});
        await InsightsManager.loadOlder();
        got.loadOlder = asked;
        pin(`insights.${name}.dates`, got);
    });

    test.each(Object.keys(NOWS))('%s: a phone\'s window, last year from month snapshots', (name) => {
        const now = insightsPage(name);
        const src = { purchases: AppState.purchaseHistory, wholesaleSales: AppState.salesHistory, retailSales: AppState.retailSalesHistory };
        lastMonthKeys(now.getTime(), 16).slice(0, 14).forEach(k => {
            const r = monthBounds(k);
            MoneyManager.snapshots[k] = buildSnapshot(k, moneySummary(InsightsManager.input(r.from), r, { detail: true }), src, now.getTime());
        });
        AppState.historyLoadedFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
        Object.values(AppState.stock).forEach((s, i) => { s.quantity = 3 + i * 7.5; });
        const got = {};
        InsightsManager.init('actions');
        got.actions = insightsTexts();
        setInsightsContext({ preset: 'last-month' });
        InsightsManager.setSection('items');
        got.items = squash(document.getElementById('insightsItemsTable').textContent);
        InsightsManager.setSection('parties');
        got.parties = { takeaway: squash(document.getElementById('insightsPartiesTakeaway').textContent), stopped: squash(document.getElementById('insightsStopped').textContent) };
        pin(`insights.${name}.window`, got);
    });
});

// ---------------------------------------------------------------- Money (M*)

function moneyPage(name, { loadedFrom = 0 } = {}) {
    document.body.innerHTML = TEMPLATES.money;
    document.getElementById('money').classList.add('active');
    const now = new Date(NOWS[name]);
    jest.setSystemTime(now);
    const shop = shopFor(name);
    loadShop(shop, { loadedFrom });
    const asked = [];
    jest.spyOn(FirebaseService, 'loadCashSessionsBetween').mockImplementation(async (a, b) => {
        asked.push(`${a}|${b}`);
        return copy(shop.sessions.filter(s => s.date >= a && s.date <= b));
    });
    return { now, asked, shop };
}

describe('Money screen, pinned (M1–M18, net worth, day chart)', () => {
    test.each(Object.keys(NOWS))('%s: every section, full history', async (name) => {
        const { asked } = moneyPage(name);
        // the shared accounts (#74, settings/accounts)
        FirebaseService.loadWorthAccounts.mockResolvedValue({
            a1: { name: 'Bank', balance: 12345.678, type: 'asset' }, a2: { name: 'Loan', balance: 5000.5, type: 'liability' }, a3: { name: 'Odd', balance: 'x', type: 'asset' }
        });
        const got = {};
        MoneyManager.init('profit');
        for (const section of ['profit', 'cash', 'spending', 'worth']) {
            MoneyManager.setSection(section);
            await flush();
            MoneyManager.render();
        }
        got.texts = leafTexts(document.getElementById('money'));
        got.cashChart = document.getElementById('moneyCashChart').innerHTML;
        got.profitChart = squash(document.getElementById('moneyProfitChart').textContent);
        got.accountsTotal = MoneyManager.accountsTotal();
        got.sessionsAsked = asked;
        pin(`money.${name}`, got);
    });

    test.each(Object.keys(NOWS))('%s: other periods, steps and the loaded window', async (name) => {
        const { now, asked } = moneyPage(name);
        const got = { presets: {}, steps: [] };
        MoneyManager.init('cash');
        for (const preset of ['last-30', 'this-year', 'last-year', 'last-month']) {
            MoneyManager.setPreset(preset);
            await flush();
            got.presets[preset] = {
                label: document.getElementById('moneyPeriodLabel').textContent,
                net: document.getElementById('moneyNetCash').textContent,
                chart: squash(document.getElementById('moneyCashChart').textContent)
            };
        }
        setInsightsContext({ preset: 'this-month' });
        for (const dir of [-1, -1, -1, 1, 1, 1, 1]) {
            MoneyManager.step(dir);
            got.steps.push(getInsightsContext().preset);
        }
        // A phone's window: from the 1st of the previous month; sessions are read for the period.
        AppState.historyLoadedFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
        MoneyManager.sessionCache = new Map();
        MoneyManager.summaryCache = { sig: null, map: new Map(), computed: 0 };
        setInsightsContext({ preset: 'this-month' });
        MoneyManager.render();
        await flush();
        got.windowed = { net: document.getElementById('moneyNetCash').textContent, in: document.getElementById('moneyIn').textContent };
        got.sessionsAsked = asked;
        pin(`money.${name}.periods`, got);
    });
});

// ---------------------------------------------------------------- Outstanding aging (O1–O4)

describe('Outstanding aging, pinned (O1–O4, ages)', () => {
    test.each(Object.keys(NOWS))('%s: payables and receivables (all, retail, wholesale; #125) with their ages', (name) => {
        document.body.innerHTML = TEMPLATES.due;
        jest.setSystemTime(new Date(NOWS[name]));
        loadShop(shopFor(name));
        const got = {};
        ['purchase', 'sale', 'retail', 'wholesale'].forEach(kind => {
            OutstandingManager.filterDue(kind);
            got[kind] = {
                aging: squash(document.getElementById('dueAging').textContent),
                ages: [...document.querySelectorAll('#dueList .history-item')].map(el => `${squash(el.querySelector('.history-header').textContent)} | ${squash(el.querySelector('.aging-age').textContent)}`)
            };
        });
        pin(`outstanding.${name}`, got);
    });
});

// ---------------------------------------------------------------- Statements periods (ST1, ST2, ST5)

describe('Statements periods, pinned (day book, month, CSV)', () => {
    const docOf = () => {
        const c = StatementsManager.current;
        return { title: c.title, share: c.share, text: squash(document.getElementById('statementsDoc').textContent).slice(0, 4000), rows: c.csvRows.length, first: c.csvRows.slice(0, 3), last: c.csvRows.slice(-3) };
    };
    test.each(Object.keys(NOWS))('%s: default periods, a month end and the month list', (name) => {
        document.body.innerHTML = TEMPLATES.statements;
        jest.setSystemTime(new Date(NOWS[name]));
        loadShop(shopFor(name));
        jest.spyOn(FirebaseService, 'loadCashSessionsBetween').mockResolvedValue([]);
        Object.assign(StatementsManager, { kind: null, day: null, month: null, partyKind: 'customer', partyKey: null, itemKey: null, csvFrom: null, csvTo: null, current: null });
        const got = {};
        StatementsManager.open('day');
        got.day = docOf();
        StatementsManager.set('day', '2027-02-28');
        got.dayFeb28 = docOf();
        StatementsManager.open('month');
        got.month = docOf();
        got.monthOptions = [...document.querySelectorAll('#statementsControls option')].map(o => `${o.value}=${o.textContent}`);
        StatementsManager.open('csv');
        got.csv = docOf();
        got.csvRange = [StatementsManager.csvFrom, StatementsManager.csvTo];
        StatementsManager.set('csvFrom', '2027-01-31');
        StatementsManager.set('csvTo', '2027-03-01');
        got.csvJanToMar = docOf();
        pin(`statements.${name}`, got);
    });
});
