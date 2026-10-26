/**
 * @fileoverview Single home across RENDERED pages (docs/insights-redesign.md §6,
 * AC13): each page is drawn in jsdom with real data; every ₹ on it sits in a
 * tagged element, and no spec ID is rendered as a value on two pages.
 */
import fs from 'fs';
import path from 'path';
import * as O from '../../../tests/oracle/oracle.js';
import { MoneyManager } from '../modules/money.js';
import { InsightsManager } from '../modules/insights.js';
import { StatementsManager } from '../modules/statements.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { resetInsightsContextForTests } from '../utils/insights-context.js';
import { unexplainedValues, renderedValueTags, registryProblems } from '../utils/metric-registry.js';

const ROOT = path.resolve(__dirname, '../../..');
const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/calculations/shop-month.json'), 'utf8'));
const copy = (v) => JSON.parse(JSON.stringify(v));
const template = (name) => fs.readFileSync(path.join(ROOT, 'www/templates', name), 'utf8');

/** page file → { root element id, draw(): renders every section and returns once per state worth checking } */
const PAGES = {
    'money.html': {
        root: 'money',
        states: [() => ['profit', 'cash', 'spending', 'worth'].forEach(s => MoneyManager.init(s))]
    },
    'insights.html': {
        root: 'insights',
        states: [
            () => ['actions', 'items', 'parties'].forEach(s => InsightsManager.init(s)),
            () => InsightsManager.setPartyKind('purchases')
        ]
    },
    'statements.html': {
        root: 'statements',
        states: ['day', 'month', 'party', 'item', 'csv'].map(k => () => StatementsManager.open(k))
    }
};

beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.setSystemTime(new Date(O.timeOf(FIX.now)));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    Object.assign(AppState, {
        items: copy(FIX.items), purchaseHistory: copy(FIX.purchases), salesHistory: copy(FIX.wholesaleSales),
        retailSalesHistory: copy(FIX.retailSales), stockAdjustments: copy(FIX.stockAdjustments),
        expensesHistory: copy(FIX.expenses), withdrawalsHistory: copy(FIX.withdrawals),
        historyLoadedFrom: 0, userRole: 'owner', settings: {}, stock: {}
    });
    resetInsightsContextForTests();
    jest.spyOn(FirebaseService, 'loadCashSessionsBetween').mockResolvedValue([{ date: '2026-10-20', signedOut: true, closingBalance: 250 }]);
    MoneyManager.snapshots = {};
    MoneyManager.snapshotsLoaded = true;
    MoneyManager.sessionCache = new Map();
    jest.spyOn(MoneyManager, 'loadSnapshots').mockResolvedValue();
    Object.assign(InsightsManager, { section: 'actions', seasonView: 'calendar', itemsType: 'both', partyKind: 'sales', seasonDocs: null, seasonLoading: null });
    Object.assign(StatementsManager, { kind: null, day: null, month: null, partyKind: 'customer', partyKey: null, itemKey: null, csvFrom: null, csvTo: null, current: null });
    document.body.innerHTML = Object.keys(PAGES).map(template).join('\n');
    Object.values(PAGES).forEach(p => document.getElementById(p.root).classList.add('active'));
});
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

test('every rendered ₹ is tagged, and no figure is rendered as a value on two pages', async () => {
    const tags = {};
    const unexplained = {};
    for (const [file, page] of Object.entries(PAGES)) {
        const root = document.getElementById(page.root);
        tags[file] = [];
        for (const draw of page.states) {
            draw();
            await Promise.resolve();
            unexplained[file] = [...(unexplained[file] || []), ...unexplainedValues(root)];
            tags[file].push(...renderedValueTags(root));
        }
    }
    expect(unexplained).toEqual(Object.fromEntries(Object.keys(PAGES).map(f => [f, []])));
    expect(registryProblems(tags)).toEqual([]);
    expect(tags['money.html'].length).toBeGreaterThan(0);
    expect(tags['insights.html'].length).toBeGreaterThan(0);
});
