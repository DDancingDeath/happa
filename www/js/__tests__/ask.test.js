/**
 * Ask (#88): the word matcher and the answers' edge cases (names matching
 * several parties, Hindi ↔ Latin spellings, members' stock limit, archived
 * items). The figures themselves are checked against the oracle in tests/oracle/ask.test.js.
 */
import { answerQuestion, parseQuestion } from '../utils/ask.js';
import { AskManager } from '../modules/ask.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { Exporter } from '../services/exporter.js';
import { AuditService } from '../services/audit.js';
import * as meter from '../firebase/firestore-meter.js';
import { ensureXLSXWriter } from '../utils/lazy-scripts.js';
import { setLang } from '../i18n/index.js';

jest.mock('../utils/lazy-scripts.js', () => ({ ensureXLSX: jest.fn(async () => {}), ensureXLSXWriter: jest.fn(async () => {}) }));

describe('parseQuestion', () => {
    test.each([
        ['aaj ki bikri', { intent: 'sales_today' }],
        ['Aaj kitna becha?', { intent: 'sales_today' }],
        ['आज की बिक्री', { intent: 'sales_today' }],
        ["What's today's purchase", { intent: 'purchases_today' }],
        ['aaj ka kharcha kitna hai', { intent: 'expenses_today' }],
        ['Ramesh ka baaki', { intent: 'party_due', subject: 'ramesh' }],
        ['how much does Ram Lal owe?', { intent: 'party_due', subject: 'ram lal' }],
        ['रमेश का उधार', { intent: 'party_due', subject: 'रमेश' }],
        ['kul baaki', { intent: 'total_due' }],
        ['chawal ka stock', { intent: 'item_stock', subject: 'chawal' }],
        ['चावल कितना बचा है', { intent: 'item_stock', subject: 'चावल' }],
        ['stock', { intent: 'item_stock', subject: '' }],
        ['help', { intent: 'help' }],
        ['   ', { intent: 'help' }],
        ['weather kal', { intent: 'unknown' }],
        ["Ramesh's due", { intent: 'party_due', subject: 'ramesh' }],
        ['Ramesh ji ka kitna paisa baaki hai', { intent: 'party_due', subject: 'ramesh' }],
        ['रमेश जी का बाकी', { intent: 'party_due', subject: 'रमेश' }],
        ['bikri ka baaki', { intent: 'today_only' }],
        ['Abhi ka baaki', { intent: 'party_due', subject: 'abhi' }],
        ['Sara ka baaki', { intent: 'party_due', subject: 'sara' }],
        ['kal ki bikri', { intent: 'today_only' }],
        ['chawal kitna becha', { intent: 'item_report', billType: 'sale', subject: 'chawal' }],
        ['Ramesh ko kitna becha', { intent: 'item_report', billType: 'sale', subject: 'ramesh' }],
        ['wholesale ki bikri', { intent: 'today_only' }],
        ['१० तारीख की बिक्री', { intent: 'today_only' }],
        ['abhi tak ka baaki', { intent: 'total_due' }],
        ['ab tak ka baaki', { intent: 'total_due' }],
        ['अभी तक का बाकी', { intent: 'total_due' }],
        ['abhi tak ka kul baaki', { intent: 'total_due' }],
        ['kal ka baaki', { intent: 'today_only' }],
        ['कल का स्टॉक', { intent: 'today_only' }],
        ['Abhi ji ka kul baaki', { intent: 'party_due', subject: 'abhi' }],
        ['Sara ka total baaki', { intent: 'party_due', subject: 'sara' }],
        ['aaj ki udhaar bikri', { intent: 'today_only' }],
        ['kitna stock baaki hai', { intent: 'item_stock', subject: '' }],
        ['stock balance', { intent: 'item_stock', subject: '' }],
        ['maal kitna baaki hai', { intent: 'item_stock', subject: '' }],
        ['बाकी स्टॉक कितना है', { intent: 'item_stock', subject: '' }],
        ['chawal ka stock kitna baaki', { intent: 'item_stock', subject: 'chawal' }],
        ['aaj kitna udhaar hua', { intent: 'today_only' }],
        ['aaj tak ka baaki', { intent: 'total_due' }],
        ['kitna udhaar becha', { intent: 'today_only' }],
        ['kitna kharcha baaki hai', { intent: 'today_only' }],
        ['cash balance', { intent: 'unknown' }],
        ['Ramesh ka maal baaki', { intent: 'party_due', subject: 'ramesh' }],
        ['aaj to kitni bikri hui', { intent: 'sales_today' }],
        ['aaj kitna maal becha', { intent: 'sales_today' }],
        ['abhi chawal ka stock', { intent: 'item_stock', subject: 'chawal' }],
        ['chawal ka maal', { intent: 'item_stock', subject: 'chawal' }]
    ])('%s', (text, want) => expect(parseQuestion(text)).toMatchObject(want));

    test.each([
        ['abhi kitna baaki hai', { intent: 'total_due' }],
        ['अभी कितना बाकी है', { intent: 'total_due' }],
        ['sara baaki', { intent: 'total_due' }],
        ['Sara ji ka baaki', { intent: 'party_due', subject: 'sara' }],
        ['abhi stock kitna hai', { intent: 'item_stock', subject: '' }],
        ['aaj ki bikri kitni rahi', { intent: 'sales_today' }],
        ['आज की बिक्री कितनी रही', { intent: 'sales_today' }],
        ["today's sales so far", { intent: 'sales_today' }],
        ['abhi tak ki bikri', { intent: 'sales_today' }],
        ['aaj abhi tak kitna kharcha hua', { intent: 'expenses_today' }],
        ['pichle hafte ki bikri', { intent: 'today_only' }],
        ['1 tarikh ki bikri', { intent: 'today_only' }]
    ])('now / all / today phrasings: %s', (text, want) => expect(parseQuestion(text)).toMatchObject(want));
});

const TODAY = new Date(2026, 10, 15, 12, 0);
const sale = (id, name, due) => ({ id, customerName: name, date: '10/11/2026', grandTotal: due, payment: { cash: 0, online: 0, due } });
const src = {
    bills: {
        retailSales: [sale('r1', 'Ramesh', 500), sale('r2', 'Ramesh Kumar', 300), sale('r3', 'Suresh', 200)],
        wholesaleSales: [{ ...sale('w1', 'Ramesh', 1000), source: 'sales-tab' }],
        purchases: [sale('p1', 'Suresh', 700)]
    },
    items: [{ id: 'i1', name: 'Rice', hindiName: 'चावल' }, { id: 'i2', name: 'Old Dal', hindiName: '', archived: true }],
    stock: { i1: { quantity: 150, rate: 30 } }
};
const ask = (text, opts) => answerQuestion(parseQuestion(text), src, { role: 'owner', wholesale: true, today: TODAY, ...opts });

describe('answerQuestion', () => {
    test('an exact name wins over a longer one starting with it; wholesale counts with Wholesale on', () => {
        expect(ask('ramesh ka baaki')).toMatchObject({ name: 'Ramesh', receive: { total: 1500, count: 2 }, pay: null });
        expect(ask('ramesh ka baaki', { wholesale: false }).receive).toMatchObject({ total: 500, count: 1 });
    });
    test('a name typed in Devanagari finds the Latin one', () => {
        expect(ask('सुरेश का बाकी')).toMatchObject({ name: 'Suresh', receive: { total: 200 }, pay: { total: 700 } });
    });
    test('a partial name matching several parties offers them, no figure', () => {
        const a = ask('ram due');
        expect(a.name).toBeUndefined();
        expect(a.matches.sort()).toEqual(['Ramesh', 'Ramesh Kumar']);
    });
    test('no match', () => {
        expect(ask('Mohan ka baaki')).toMatchObject({ matches: [], more: 0 });
    });
    test('stock: romanised Hindi name; members see "available" above 100 kg', () => {
        expect(ask('chawal ka stock')).toMatchObject({ name: 'Rice', quantity: 150, limited: false });
        expect(ask('chawal ka stock', { role: 'staff' }).limited).toBe(true);
    });
    test('one item\'s sales are an item report, not today\'s total', () => {
        expect(ask('chawal kitna becha').intent).toBe('item_report');
        expect(ask('aaj ki sale kaisi rahi').intent).toBe('sales_today');
    });
    test('sign-out clears the answers on the page', async () => {
        AppState.currentUser = { uid: 'owner1' };
        document.body.innerHTML = '<div id="askAnswers"></div>';
        Object.assign(AppState, { purchaseHistory: [], retailSalesHistory: [], salesHistory: [], expensesHistory: [] });
        await AskManager.ask('kul baaki');
        AskManager.reset();
        expect(document.getElementById('askAnswers').innerHTML).toBe('');
        expect(AskManager.answers).toEqual([]);
    });
    test('stock: archived items are not offered; still updating says so', () => {
        expect(ask('dal ka stock').matches).toEqual([]);
        expect(ask('rice stock', { stockReady: false }).updating).toBe(true);
    });
});

describe('Ask page', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="askExamples"></div><div id="askAnswers"></div>';
        AskManager.answers = [];
        Object.assign(AppState, { purchaseHistory: [], retailSalesHistory: [], salesHistory: [], expensesHistory: [], items: [{ id: 'i1', name: 'Rice', hindiName: '' }], stock: { i1: { quantity: 20, rate: 30 } }, userRole: 'owner', stockReady: true, stockApprox: null });
    });
    test('answers stay with the person who asked: another sign-in on this phone sees none', async () => {
        AppState.currentUser = { uid: 'owner1' };
        await AskManager.ask('kul baaki');
        expect(document.querySelectorAll('.ask-answer')).toHaveLength(1);
        AppState.currentUser = { uid: 'member1' };
        AskManager.init();
        expect(document.querySelectorAll('.ask-answer')).toHaveLength(0);
    });
    test('stock that could not be worked out is not shown as "no stock"', async () => {
        AppState.currentUser = { uid: 'owner1' };
        jest.spyOn(FirebaseService, 'getStock').mockRejectedValueOnce(new Error('offline'));
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        await AskManager.ask('rice stock');
        expect(document.getElementById('askAnswers').textContent).toContain('could not be worked out');
    });
});
describe('Ask page: item reports (ASK-5)', () => {
    const items = [{ id: 'k', name: 'Lah Kusmi', hindiName: '' }, { id: 'g', name: 'Garlic', hindiName: 'लहसुन' }];
    const pb = (id, date, billNumber, qty, rate, labour = 0) => ({ id, date, timestamp: new Date(date).getTime(), billNumber, items: [{ itemId: 'k', name: 'Lah Kusmi', qty, rate, total: qty * rate }], billTotal: qty * rate, laborCharges: labour, grandTotal: qty * rate - labour });
    const recent = [pb('p2', '2026-11-03T10:00:00', '14', 50, 220, 30)];
    const older = [pb('p1', '2026-02-03T10:00:00', '9', 100, 200, 60)];
    const answers = () => document.getElementById('askAnswers').textContent;
    let held;
    afterAll(() => jest.useRealTimers());
    beforeEach(() => {
        jest.restoreAllMocks();
        jest.useFakeTimers({ now: new Date(2026, 10, 9, 12), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
        document.body.innerHTML = '<div id="askExamples"></div><div id="askAnswers"></div>';
        AskManager.reset();
        held = null;
        Object.assign(AppState, { currentUser: { uid: 'owner1' }, userRole: 'owner', purchaseHistory: recent, items, settings: {} });
        jest.spyOn(FirebaseService, 'isFullHistoryLoaded').mockReturnValue(false);
        jest.spyOn(FirebaseService, 'getHistoryWindowStart').mockReturnValue(new Date(2026, 9, 1).getTime());
        jest.spyOn(FirebaseService, 'oldestBillTime').mockResolvedValue(new Date(2026, 0, 1).getTime());
        jest.spyOn(FirebaseService, 'reportBillsInMemory').mockImplementation(() => held);
        jest.spyOn(FirebaseService, 'voidedBills').mockReturnValue([]);
        jest.spyOn(FirebaseService, 'readReportBills').mockImplementation(async () => { held = { bills: older, readAt: Date.now() }; return held; });
        jest.spyOn(FirebaseService, 'reportItemStats').mockResolvedValue(null);
        jest.spyOn(AuditService, 'note').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    test('inside the loaded window: the figures at once, with Excel and CSV', async () => {
        jest.spyOn(FirebaseService, 'isFullHistoryLoaded').mockReturnValue(true);
        await AskManager.ask('is mahine lah kitna kharida');
        expect(answers()).toContain('Lah Kusmi: 50 kg · average ₹220.00/kg · ₹11,000 (1 bill)');
        expect(answers()).toContain('Not counted (the name only starts the same): Garlic');
        expect(document.querySelectorAll('#askAnswers .ask-xlsx, #askAnswers .ask-csv')).toHaveLength(2);
        expect([...document.querySelectorAll('#askAnswers .ask-kind')].map(b => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['Lah Kusmi', 'true'], ['Garlic', 'false']]);
        expect([...document.querySelectorAll('#askAnswers select')].map(s => s.value)).toEqual(['purchase', 'this-month', 'item']);
        expect(FirebaseService.readReportBills).not.toHaveBeenCalled();
    });

    test('Change: another period or grouping answers again; a kind can be added by hand', async () => {
        jest.spyOn(FirebaseService, 'isFullHistoryLoaded').mockReturnValue(true);
        AppState.purchaseHistory = [...recent, { ...pb('p3', '2026-11-05T10:00:00', '20', 10, 90), customerName: 'Mohan', items: [{ itemId: 'g', name: 'Garlic', qty: 10, rate: 90, total: 900 }] }];
        await AskManager.ask('is mahine lah kitna kharida');
        const id = AskManager.answers[0].id;
        await AskManager.toggleKind(id, 'g');
        expect(answers()).toContain('Garlic: 10 kg · average ₹90.00/kg · ₹900 (1 bill)');
        expect(answers()).not.toContain('Not counted');
        await AskManager.changeReport(id, 'groupBy', 'month');
        expect(answers()).toContain('Nov 2026: 60 kg');
        await AskManager.changeReport(id, 'range', 'last-month');
        expect(answers()).toContain('No bills of these in this period.');
        await AskManager.changeReport(id, 'range', 'forever');
        await AskManager.changeReport(id, 'billType', 'users');
        expect(AskManager.answers[0].q).toMatchObject({ range: 'last-month', billType: 'purchase', groupBy: 'month', keys: ['k', 'g'] });
    });

    test('picking the offered kind when the word only started its name gives its report (no crash)', async () => {
        jest.spyOn(FirebaseService, 'isFullHistoryLoaded').mockReturnValue(true);
        AppState.purchaseHistory = [{ ...pb('p3', '2026-11-05T10:00:00', '20', 10, 90), items: [{ itemId: 'g', name: 'Garlic', qty: 10, rate: 90, total: 900 }] }];
        AppState.items = [items[1]];
        await AskManager.ask('is mahine lahs kitna kharida');
        expect(answers()).toContain('Which one? Garlic');
        await AskManager.toggleKind(AskManager.answers[0].id, 'g');
        expect(answers()).toContain('Garlic: 10 kg · average ₹90.00/kg · ₹900 (1 bill)');
        await AskManager.ask('help');
        expect(answers()).toContain('I can tell you');
    });

    test('a kind chip keeps the keyboard focus after it is turned on or off', async () => {
        jest.spyOn(FirebaseService, 'isFullHistoryLoaded').mockReturnValue(true);
        await AskManager.ask('is mahine lah kitna kharida');
        await AskManager.toggleKind(AskManager.answers[0].id, 'g');
        expect(document.activeElement.textContent).toBe('Garlic');
        expect(document.activeElement.getAttribute('aria-pressed')).toBe('true');
    });

    test('the estimate leaves out a bill type already read this session', async () => {
        Object.assign(AppState, { retailSalesHistory: [], salesHistory: [] });
        FirebaseService.reportBillsInMemory.mockImplementation((coll) => (coll === 'wholesaleSales' ? { bills: [], readAt: Date.now() } : null));
        await AskManager.ask('lah kitna becha ab tak');
        expect(AskManager.answers[0].answer.needsOlder).toBe(true);
        expect(FirebaseService.oldestBillTime.mock.calls.map(x => x[0])).toEqual(['retailSales']);
    });

    test('sales of all time: both sale collections are read after the one confirm', async () => {
        jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        Object.assign(AppState, { retailSalesHistory: [], salesHistory: [] });
        await AskManager.ask('lah kitna becha ab tak');
        await AskManager.loadOlder(AskManager.answers[0].id);
        expect(FirebaseService.oldestBillTime.mock.calls.map(x => x[0]).sort()).toEqual(['retailSales', 'wholesaleSales']);
        expect(FirebaseService.readReportBills.mock.calls).toEqual([['retailSales', null], ['wholesaleSales', null]]);
    });

    test('all time: no figures until the owner confirms the estimated reads; then one read', async () => {
        const modal = jest.spyOn(UIManager, 'showModal').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const a = await AskManager.ask('lah kitna kharida ab tak');
        expect(a).toMatchObject({ needsOlder: true });
        expect(answers()).toContain('not on this phone');
        expect(answers()).not.toContain('₹');
        await AskManager.loadOlder(AskManager.answers[0].id);
        expect(modal.mock.calls[0][0]).toMatch(/Load about \d+ bills/);
        expect(FirebaseService.readReportBills).not.toHaveBeenCalled();
        await AskManager.loadOlder(AskManager.answers[0].id);
        expect(FirebaseService.readReportBills).toHaveBeenCalledWith('purchases', null);
        expect(answers()).toContain('Lah Kusmi: 150 kg · average ₹206.67/kg · ₹31,000 (2 bills)');
        expect(answers()).toContain('Older bills as read at');
    });

    test('all time (ASK-7): a quick figure at once from the item stats, no bill read; the bill-by-bill one after the confirm', async () => {
        jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        const months = {
            'm2026-02': { purchase: { kg: 100, amount: 20000, bills: 1 }, bills: 1 },
            // months the phone has every bill of come from those bills, never from a stored copy
            'm2026-10': { purchase: { kg: 5, amount: 1000, bills: 1 }, bills: 1 },
            'm2026-11': { purchase: { kg: 1, amount: 1, bills: 1 }, bills: 1 }
        };
        FirebaseService.reportItemStats.mockResolvedValue({ meta: { backfillDone: true }, docs: [{ id: 'k_2026', itemId: 'k', year: '2026', months }] });
        await AskManager.ask('lah kitna kharida ab tak');
        await AskManager.quickPending;
        expect(FirebaseService.reportItemStats).toHaveBeenCalledWith(['k']);
        expect(answers()).toContain('Quick figure from Insights › Seasons (kg × rate, before labour; no bills read):');
        expect(answers()).toContain('Lah Kusmi: 150 kg · average ₹206.67/kg · ₹31,000 (2 bills)');
        expect(answers()).toContain('not on this phone');
        expect(answers()).toContain('Load the older bills for them and for Excel.');
        expect(document.querySelectorAll('#askAnswers .ask-load')).toHaveLength(1);
        expect(document.querySelectorAll('#askAnswers .ask-xlsx, #askAnswers .ask-csv')).toHaveLength(0);
        expect(FirebaseService.readReportBills).not.toHaveBeenCalled();
        await AskManager.loadOlder(AskManager.answers[0].id);
        expect(answers()).not.toContain('Quick figure');
        expect(answers()).toContain('Lah Kusmi: 150 kg · average ₹206.67/kg · ₹31,000 (2 bills)');
        expect(answers()).toContain('After labour: ₹30,910');
    });

    test('ASK-7: the answer and its Load button do not wait for the item stats; the quick figure is added when they come', async () => {
        let arrive;
        FirebaseService.reportItemStats.mockImplementation(() => new Promise((resolve) => { arrive = resolve; }));
        const stats = { meta: { backfillDone: true }, docs: [{ id: 'k_2026', itemId: 'k', year: '2026', months: { 'm2026-02': { purchase: { kg: 100, amount: 20000, bills: 1 } } } }] };
        await AskManager.ask('lah kitna kharida ab tak');
        expect(answers()).toContain('not on this phone');
        expect(document.querySelectorAll('#askAnswers .ask-load')).toHaveLength(1);
        expect(answers()).not.toContain('Quick figure');
        arrive(stats);
        await AskManager.quickPending;
        expect(answers()).toContain('Lah Kusmi: 150 kg · average ₹206.67/kg · ₹31,000 (2 bills)');
        // a quick figure for an answer already replaced (Change) or a person signed out is dropped
        await AskManager.changeReport(AskManager.answers[0].id, 'range', 'this-year');
        const replaced = arrive;
        await AskManager.changeReport(AskManager.answers[0].id, 'range', 'last-year');
        replaced(stats);
        await new Promise(r => setTimeout(r, 0));
        expect(AskManager.answers[0].answer.period.preset).toBe('last-year');
        expect(answers()).not.toContain('Quick figure');
        AskManager.reset();
        arrive(stats);
        await AskManager.quickPending;
        expect(document.getElementById('askAnswers').innerHTML).toBe('');
    });

    test('ASK-7 hi: the quick figure in Hindi, kg as kg', async () => {        await setLang('hi');
        try {
            FirebaseService.reportItemStats.mockResolvedValue({ meta: { backfillDone: true }, docs: [{ id: 'k_2026', itemId: 'k', year: '2026', months: { 'm2026-02': { purchase: { kg: 100, amount: 20000, bills: 1 } } } }] });
            await AskManager.ask('लाह कितना खरीदा अब तक');
            await AskManager.quickPending;
            expect(answers()).toContain('कारोबार › मौसम से झटपट आँकड़ा');
            expect(answers()).toContain('Lah Kusmi: 150 kg · औसत ₹206.67/kg · ₹31,000 (2 बिल)');
        } finally {
            await setLang('en');
        }
    });

    test('ASK-7 only for kinds named, by kind, with no party, for the owner, before a quota error', async () => {
        await AskManager.ask('Mohan se lah kitna kharida ab tak');
        await AskManager.ask('lah kitna kharida ab tak mahine wise');
        expect(FirebaseService.reportItemStats).not.toHaveBeenCalled();
        jest.spyOn(meter, 'getQuotaStatus').mockReturnValue({ quota: { count: 1 }, overCap: false });
        await AskManager.ask('lah kitna kharida ab tak');
        expect(FirebaseService.reportItemStats).not.toHaveBeenCalled();
        meter.getQuotaStatus.mockRestore();
        AppState.userRole = 'manager';
        await AskManager.ask('lah kitna kharida ab tak');
        expect(FirebaseService.reportItemStats).not.toHaveBeenCalled();
        AppState.userRole = 'owner';
        // the stats can't be read (offline, or never built): the answer is as before
        FirebaseService.reportItemStats.mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'unavailable' }));
        await AskManager.ask('lah kitna kharida ab tak');
        await AskManager.quickPending;
        expect(AskManager.answers[0].answer.quick).toBeUndefined();
        expect(answers()).not.toContain('₹');
    });

    test('after a quota error the older bills are not read', async () => {
        jest.spyOn(meter, 'getQuotaStatus').mockReturnValue({ quota: { count: 1 }, overCap: false });
        const modal = jest.spyOn(UIManager, 'showModal');
        await AskManager.ask('lah kitna kharida ab tak');
        await AskManager.loadOlder(AskManager.answers[0].id);
        expect(modal).not.toHaveBeenCalled();
        expect(answers()).toContain('free data limit');
    });

    test('two questions asked at once share the one oldest-purchase read', async () => {
        await Promise.all([AskManager.ask('lah kitna kharida ab tak'), AskManager.ask('chawal kitna kharida ab tak')]);
        expect(FirebaseService.oldestBillTime).toHaveBeenCalledTimes(1);
        AskManager.reset();
    });

    test('a manager: kg only, no Excel, and no read of older bills', async () => {
        AppState.userRole = 'manager';
        await AskManager.ask('lah kitna kharida ab tak');
        expect(answers()).toContain('Only the owner can load older bills');
        expect(document.querySelectorAll('#askAnswers .ask-load')).toHaveLength(0);
        await AskManager.ask('is mahine lah kitna kharida');
        expect(answers()).toContain('Lah Kusmi: 50 kg (1 bill)');
        expect(answers()).not.toContain('₹');
        expect(document.querySelectorAll('#askAnswers .ask-xlsx')).toHaveLength(0);
        expect(await AskManager.download(AskManager.answers[0].id, 'xlsx')).toBe(false);
        AppState.settings = { roleAccess: { manager: { reports: false } } };
        await AskManager.ask('is mahine lah kitna kharida');
        expect(answers()).toContain('Item reports are for the owner');
        expect(FirebaseService.oldestBillTime).not.toHaveBeenCalled();
        expect(FirebaseService.readReportBills).not.toHaveBeenCalled();
    });

    test('Excel: a Summary sheet and one per kind, saved through the share sheet / download; offline it is CSV', async () => {
        jest.spyOn(FirebaseService, 'isFullHistoryLoaded').mockReturnValue(true);
        const saved = jest.spyOn(Exporter, 'saveBlob').mockResolvedValue(true);
        const appended = [];
        global.XLSX = {
            utils: { book_new: () => ({}), aoa_to_sheet: (rows) => ({ rows }), book_append_sheet: (b, ws, name) => appended.push([name, ws.rows]) },
            write: () => new Uint8Array([1])
        };
        await AskManager.ask('is mahine lah kitna kharida excel');
        await AskManager.download(AskManager.answers[0].id, 'xlsx');
        expect(appended.map(x => x[0])).toEqual(['Summary', 'Lah Kusmi']);
        expect(appended[1][1].at(-1).slice(0, 5)).toEqual(['Total', '', 50, 220, 11000]);
        expect(saved.mock.calls[0][1]).toMatch(/_item-report_2026-11-01_.*\.xlsx$/);
        expect(AuditService.note).toHaveBeenLastCalledWith('EXPORT', expect.objectContaining({ exportKind: 'ask', format: 'xlsx', exportStatus: 'done' }));
        delete global.XLSX;
        ensureXLSXWriter.mockRejectedValueOnce(new Error('not cached'));
        await AskManager.download(AskManager.answers[0].id, 'xlsx');
        expect(saved.mock.calls[1][1]).toMatch(/\.csv$/);
    });
});
