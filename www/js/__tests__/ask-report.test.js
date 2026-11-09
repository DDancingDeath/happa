/**
 * Ask item reports (#415, ASK-5): the question → spec, which kinds are counted (Lahsun is not
 * Lah), the bill-by-bill rows and totals, and the Excel / CSV sheets. The totals are checked
 * against the independent oracle in tests/oracle/ask.test.js.
 */
import { answerQuestion, parseQuestion } from '../utils/ask.js';
import {
    estimateReportReads, ITEM_WORD_SYNONYMS, itemPurchaseReport, labourShares, matchKinds, mergeReportBills, reportCsv, reportDays,
    reportKinds, reportPeriod, reportSheets, sheetName, validateSpec
} from '../utils/ask-report.js';
import { purchaseItems } from '../utils/business-metrics.js';
import { formatMonth } from '../utils/dates.js';

const OWNER_QUESTION = 'What all kinds of Lah were bought, how much and at what average rate till today, as an Excel sheet with bill number, date, weight, rate, total, plus totals, one page per kind';

const R = (billType, subject, range, groupBy = 'item') => ({ intent: 'item_report', billType, subject, range, groupBy });

describe('parseQuestion: item reports', () => {
    test.each([
        [OWNER_QUESTION, R('purchase', 'lah', 'all')],
        ['lah kitna kharida ab tak excel', R('purchase', 'lah', 'all')],
        ['लाह की किस्में कितनी खरीदीं', R('purchase', 'लाह', 'this-month')],
        ['pichle mahine lah ki kharid', R('purchase', 'lah', 'last-month')],
        ['is mahine ab tak lah kitna kharida', R('purchase', 'lah', 'this-month')],
        ['is saal chawal kitna kharida', R('purchase', 'chawal', 'this-year')],
        ['last FY lah purchase report', R('purchase', 'lah', 'last-fy')],
        ['aaj lah kitna kharida', R('purchase', 'lah', 'today')],
        ['lah kitna kharida pichle saal se ab tak', R('purchase', 'lah', 'since-last-year')],
        ['pichle mahine se aaj tak lah ki kharid', R('purchase', 'lah', 'since-last-month')],
        ['Ramesh se lah kitna kharida', R('purchase', 'ramesh lah', 'this-month')],
        ['aaj kul kitna lah kharida', R('purchase', 'lah', 'today')],
        ['lah ki kul kharid', R('purchase', 'lah', 'all')],
        ['kal total lah kitna kharida', { intent: 'today_only' }],
        ['is hafte ab tak lah kitna kharida', { intent: 'today_only' }],
        ['pichle 3 mahine me lah kitna kharida', { intent: 'today_only' }],
        ['maine lah kitne kilo kharide the', R('purchase', 'lah', 'this-month')],
        ['मैंने लाह कितनी खरीदी', R('purchase', 'लाह', 'this-month')],
        ['kal lah kitna kharida', { intent: 'today_only' }],
        ["What's today's purchase", { intent: 'purchases_today' }],
        ['aaj kitna maal kharida', { intent: 'purchases_today' }],
        ['chawal kitna becha', R('sale', 'chawal', 'this-month')],
        ['Ramesh ko kya kya becha', R('sale', 'ramesh', 'this-month')],
        ['aaj kya kya becha', R('sale', '', 'today')],
        ['lah kisko becha is saal', R('sale', 'lah', 'this-year', 'party')],
        ['इस महीने लाह किसको बेची', R('sale', 'लाह', 'this-month', 'party')],
        ['kis kis ko lah becha', R('sale', 'lah', 'this-month', 'party')],
        ['is saal lah ki kharid mahine wise', R('purchase', 'lah', 'this-year', 'month')],
        ['lah ki bikri har mahine', R('sale', 'lah', 'since-last-month', 'month')],
        ['thok me chawal kitna becha pichle mahine', R('wholesale', 'chawal', 'last-month')],
        ['खुदरा में चावल कितना बिका', R('retail', 'चावल', 'this-month')],
        ['is mahine ki bikri item wise', R('sale', '', 'this-month')],
        ['pichle mahine ki kharid party wise', R('purchase', '', 'last-month', 'party')],
        ['kis bhav pe lah kharida', R('purchase', 'lah', 'this-month')],
        ['this month lah purchase', R('purchase', 'lah', 'this-month')],
        ['aaj ki bikri', { intent: 'sales_today' }],
        ['aaj kitna bika', { intent: 'sales_today' }],
        ['abhi tak ki bikri', { intent: 'sales_today' }],
        ['wholesale ki bikri', { intent: 'today_only' }],
        ['pichle hafte lah ki bikri', { intent: 'today_only' }]
    ])('%s', (text, want) => expect(parseQuestion(text)).toEqual(want));
});

const ITEMS = [
    { id: 'k', name: 'Lah Kusmi', hindiName: 'लाह कुसमी' },
    { id: 'r', name: 'Rangeeni Lah', hindiName: '' },
    { id: 'h', name: 'लाह', hindiName: '' },
    { id: 'old', name: 'Lah Old', hindiName: '', archived: true },
    { id: 'g', name: 'Garlic', hindiName: 'लहसुन' },
    { id: 'ls', name: 'Lahsun Desi', hindiName: '' },
    { id: 'd', name: 'Dates', hindiName: '' }
];
const line = (itemId, name, qty, rate, total = qty * rate) => ({ itemId, name, qty, rate, total });
const bill = (id, date, billNumber, items, labour = 0, extra = {}) => {
    const value = items.reduce((a, l) => a + l.total, 0);
    return { id, date, billNumber, items, billTotal: value, laborCharges: labour, grandTotal: value - labour, ...extra };
};
const PURCHASES = [
    bill('p2', '2026-11-03T10:00:00', '14', [line('k', 'Lah Kusmi', 50, 220)], 30),
    bill('p1', '2026-11-03T10:00:00', '9', [line('k', 'Lah Kusmi', 100, 200), line('g', 'Garlic', 10, 80), line(null, 'Lah Chhuri', 5, 300)], 60),
    bill('p3', '2026-10-20T09:00:00', '3', [line('old', 'Lah Old', 20, 100), line('d', 'Dates', 4, 150)]),
    bill('pv', '2026-11-04T09:00:00', '15', [line('k', 'Lah Kusmi', 1000, 1)], 0, { voided: true }),
    { id: 'po', date: '2026-11-01T09:00:00', openingBalance: { amount: 500 }, items: [], grandTotal: 0 }
];
const ALL = { from: -Infinity, to: Infinity };

describe('matchKinds: the kinds a word names', () => {
    const kinds = reportKinds(ITEMS, PURCHASES);
    const names = (r) => r.map(k => k.name).sort();
    test('every kind with the whole word Lah, Latin or Devanagari, archived and unmatched names too; Lahsun / लहसुन never', () => {
        const r = matchKinds(kinds, 'lah');
        expect(names(r.kinds)).toEqual(['Lah Chhuri', 'Lah Kusmi', 'Lah Old', 'Rangeeni Lah', 'लाह']);
        expect(names(r.near)).toEqual(['Garlic', 'Lahsun Desi']);
        expect(names(matchKinds(kinds, 'लाह').kinds)).toEqual(names(r.kinds));
        expect(names(matchKinds(kinds, 'laah').kinds)).toEqual(names(r.kinds));
    });
    test('two words narrow it down; a word that names nothing is left out', () => {
        expect(names(matchKinds(kinds, 'lah kusmi').kinds)).toEqual(['Lah Kusmi']);
        expect(matchKinds(kinds, 'lah ramesh')).toMatchObject({ unknown: ['ramesh'] });
    });
    test('a word that only starts a name is offered, never counted', () => {
        expect(matchKinds(kinds, 'lahs')).toEqual({ kinds: [], near: expect.arrayContaining([expect.objectContaining({ name: 'Lahsun Desi' })]), unknown: ['lahs'] });
    });
    test('synonyms (ITEM_WORD_SYNONYMS): lah = lakh = लाख, katki = कदकी; Lahsun still never counted', () => {
        const shop = reportKinds([{ id: 'lk', name: 'Lah Katki' }, { id: 'lp', name: 'Lakh Palash' }, { id: 'g', name: 'Garlic', hindiName: 'लहसुन' }, { id: 'lc', name: 'Lakhori Chilli' }],
            [bill('x', '2026-11-01T10:00:00', '1', [line(null, 'लाख कदकी', 10, 300)])]);
        const all = ['Lah Katki', 'Lakh Palash', 'लाख कदकी'];
        ['lah', 'lakh', 'लाख', 'लाह', 'laakh'].forEach(w => {
            const r = matchKinds(shop, w);
            expect(names(r.kinds)).toEqual(all);
            expect(names(r.near)).not.toContain('Lah Katki');
        });
        expect(names(matchKinds(shop, 'lah').near)).toEqual(['Garlic']);
        expect(names(matchKinds(shop, 'lakh').near)).toEqual(['Lakhori Chilli']);
        expect(names(matchKinds(shop, 'lah katki').kinds)).toEqual(['Lah Katki', 'लाख कदकी']);
        expect(names(matchKinds(shop, 'lah palash').kinds)).toEqual(['Lakh Palash']);
        expect(names(matchKinds(shop, 'lak').near)).toEqual(['Lakh Palash', 'Lakhori Chilli', 'लाख कदकी']);
    });
    test('each synonym word is in one group only, groups have two words or more', () => {
        const seen = new Set();
        ITEM_WORD_SYNONYMS.forEach(g => {
            expect(g.length).toBeGreaterThan(1);
            g.forEach(w => { expect(seen.has(w)).toBe(false); seen.add(w); });
        });
    });
    test('the item-name table: chawal = Rice', () => {
        expect(names(matchKinds(reportKinds([{ id: 'i', name: 'Rice' }], []), 'chawal').kinds)).toEqual(['Rice']);
    });
});

describe('itemPurchaseReport (ASK-5)', () => {
    const kinds = matchKinds(reportKinds(ITEMS, PURCHASES), 'lah').kinds;
    const report = itemPurchaseReport(PURCHASES, ITEMS, kinds, ALL);
    const kusmi = report.groups.find(g => g.key === 'k');
    test('bill by bill, sorted by date then bill number; voided bills and opening records left out', () => {
        expect(kusmi.rows.map(r => r.billNo)).toEqual(['9', '14']);
        expect(kusmi.rows[0]).toMatchObject({ qty: 100, rate: 200, amount: 20000 });
    });
    test('average rate is weighted by kg, not the mean of the rates', () => {
        expect(kusmi.totals).toMatchObject({ kg: 150, amount: 31000, bills: 2 });
        expect(kusmi.totals.avgRate).toBe(206.67);
        expect(kusmi.totals.avgRate).not.toBe(210);
    });
    test('labour shared by line value; per kind it equals Insights › Items (purchaseItems), which adds up to M16', () => {
        const byKey = Object.fromEntries(purchaseItems(PURCHASES, ITEMS, ALL).map(r => [r.itemKey, r]));
        report.groups.forEach(g => {
            const want = byKey[g.key] || { qty: 0, lineValue: 0, labour: 0, amount: 0 };
            expect([g.totals.kg, g.totals.amount]).toEqual([want.qty, want.lineValue]);
            expect(g.totals.labour).toBeCloseTo(want.labour, 1);
            expect(g.totals.net).toBeCloseTo(want.amount, 1);
        });
        expect(report.totals.bills).toBe(3);
        expect(report.rowCount).toBe(4);
    });
    test('a period leaves other days out', () => {
        const nov = reportPeriod('this-month', new Date(2026, 10, 9, 12));
        expect(itemPurchaseReport(PURCHASES, ITEMS, kinds, nov).groups.find(g => g.key === 'old').rows).toEqual([]);
    });
});

describe('labourShares: whole paise that add up to the bill\'s labour', () => {
    test('three equal lines share ₹100 as 33.34 + 33.33 + 33.33', () => {
        expect(labourShares(100, [1000, 1000, 1000])).toEqual([33.34, 33.33, 33.33]);
        expect(labourShares(60, [20000, 400, 1500])).toEqual([54.79, 1.1, 4.11]);
        expect(labourShares(0, [5, 5])).toEqual([0, 0]);
        expect(labourShares(10, [0, 0])).toEqual([0, 0]);
    });
    test('a kind\'s sheet column adds up to its totals row', () => {
        const items = [{ id: 'l', name: 'Lah' }, { id: 'x', name: 'Rice' }];
        const bills = [1, 2, 3].map(n => bill(`b${n}`, `2026-11-0${n}T10:00:00`, String(n), [line('l', 'Lah', 10, 100), line('x', 'Rice', 10, 100), line('x', 'Rice', 10, 100)], 100));
        const g = itemPurchaseReport(bills, items, [{ key: 'l', name: 'Lah', hindiName: '' }], ALL).groups[0];
        const sum = (k) => Math.round(g.rows.reduce((a, r) => a + r[k], 0) * 100) / 100;
        expect([sum('labour'), sum('net')]).toEqual([g.totals.labour, g.totals.net]);
        expect(g.totals.labour).toBe(100.02);
    });
});

describe('answerQuestion: item reports', () => {
    const src = { bills: { purchases: PURCHASES }, items: ITEMS };
    const today = new Date(2026, 10, 9, 12);
    test('a member, or a manager without Statements, gets nothing', () => {
        [['staff', true], ['manager', false]].forEach(([role, reports]) => expect(answerQuestion(parseQuestion('lah kitna kharida ab tak'), src, { role, reports, today })).toEqual(
            { intent: 'item_report', spec: 'ASK-5', page: null, notAllowed: true }));
    });
    test('a manager: kg and bill counts only, from the bills on the phone, never older ones', () => {
        const a = answerQuestion(parseQuestion('is mahine lah kitna kharida'), src, { role: 'manager', reports: true, today, limitFrom: new Date(2026, 9, 1).getTime() });
        expect(a.report.kgOnly).toBe(true);
        expect(a.report.groups.find(g => g.key === 'k')).toEqual({ key: 'k', name: 'Lah Kusmi', hindiName: 'लाह कुसमी', month: null, rows: [], totals: { kg: 150, bills: 2 } });
        expect(JSON.stringify(a.report)).not.toMatch(/amount|rate|labour|"net"/);
        const old = answerQuestion(parseQuestion('lah kitna kharida ab tak'), src, { role: 'manager', reports: true, today, limitFrom: new Date(2026, 9, 1).getTime() });
        expect(old).toMatchObject({ limited: new Date(2026, 9, 1).getTime() });
        expect(old.report).toBeUndefined();
        expect(old.needsOlder).toBeUndefined();
    });
    test('bills not all on the phone: no figures, only what is needed', () => {
        const a = answerQuestion(parseQuestion('lah kitna kharida ab tak'), src, { role: 'owner', today, covered: false });
        expect(a).toMatchObject({ needsOlder: true, spec: 'ASK-5', period: { preset: 'all', loadFrom: null } });
        expect(a.report).toBeUndefined();
    });
    test('a word that names no item and no party on these bills: no figure', () => {
        const a = answerQuestion(parseQuestion('Ramesh se lah kitna kharida'), src, { role: 'owner', today });
        expect(a.notItems).toEqual(['ramesh']);
        expect(a.report).toBeUndefined();
    });
    test('a name only on older bills: the older bills can still be loaded, also when a longer name matches', () => {
        expect(answerQuestion(parseQuestion('chhuri kitna kharida ab tak'), { bills: { purchases: [] }, items: ITEMS }, { role: 'owner', today, covered: false }))
            .toMatchObject({ kinds: [], needsOlder: true });
        expect(answerQuestion(parseQuestion('lahs kitna kharida ab tak'), { bills: { purchases: [] }, items: ITEMS }, { role: 'owner', today, covered: false }))
            .toMatchObject({ kinds: [], needsOlder: true, near: [expect.objectContaining({ name: 'Garlic' }), expect.objectContaining({ name: 'Lahsun Desi' })] });
    });
    test('no item of that name', () => {
        expect(answerQuestion(parseQuestion('Ramesh se kitna kharida'), src, { role: 'owner', today })).toMatchObject({ kinds: [], near: [], subject: 'ramesh' });
    });
});

describe('spec, reads, sheets', () => {
    test('validateSpec keeps known keys and values only', () => {
        expect(validateSpec({ v: 1, billType: 'purchase', item: { text: ' lah ', mode: 'x' }, range: { preset: 'all' }, collection: 'users', role: 'owner', measures: ['kg', 'profit'] }))
            .toEqual({ v: 1, billType: 'purchase', item: { text: 'lah', mode: 'family' }, party: null, keys: null, range: { preset: 'all' }, groupBy: 'item', measures: ['kg'] });
        expect(validateSpec({ v: 1, billType: 'sale', item: { text: '' }, party: { text: 'Ramesh' }, keys: ['k', 'k', 3, ''], range: { preset: 'this-month' }, groupBy: 'month' }))
            .toMatchObject({ billType: 'sale', item: null, party: { text: 'Ramesh' }, keys: ['k'], groupBy: 'month' });
        expect(validateSpec({ v: 1, billType: 'sale', range: { preset: 'all' }, groupBy: 'profit' }).groupBy).toBe('item');
        expect(validateSpec({ v: 1, billType: 'expenses', range: { preset: 'all' } })).toBeNull();
        expect(validateSpec({ v: 1, billType: 'purchase', item: { text: 'lah' }, range: { preset: 'forever' } })).toBeNull();
        expect(validateSpec({ v: 1, billType: 'purchase', range: { preset: 'all' }, keys: Array.from({ length: 500 }, (_, i) => `k${i}`) }).keys).toHaveLength(100);
    });
    test('the bills on the phone win over the copies read; bills voided on the phone go', () => {
        const merged = mergeReportBills([{ id: 'a', v: 'phone' }], [{ id: 'a', v: 'server' }, { id: 'b' }, { id: 'c' }], ['c']);
        expect(merged).toEqual([{ id: 'a', v: 'phone' }, { id: 'b' }]);
        // Inside the live window only the phone's bills count: one deleted on another phone stays out.
        expect(mergeReportBills([], [{ id: 'old', timestamp: 1000 }, { id: 'gone', timestamp: 5000 }, { id: 'legacy', date: '2026-10-15' }], [], 4000))
            .toEqual([{ id: 'old', timestamp: 1000 }, { id: 'legacy', date: '2026-10-15' }]);
    });
    test('read estimate: the window\'s bills per day over the older days', () => {
        const day = 86400000;
        const now = 61 * day;
        const loaded = Array.from({ length: 60 }, (_, i) => ({ timestamp: now - i * day - 1 }));
        expect(estimateReportReads({ loaded, windowFrom: now - 60 * day, now, oldest: now - 360 * day, from: null })).toBe(360);
        expect(estimateReportReads({ loaded, windowFrom: now - 60 * day, now, oldest: now - 360 * day, from: now - 120 * day })).toBe(120);
        expect(estimateReportReads({ loaded, windowFrom: now - 60 * day, now, oldest: undefined, from: null })).toBeNull();
    });
    test('reportDays: no first day for all time, never past today', () => {
        const now = new Date(2026, 10, 9, 12);
        expect(reportDays(reportPeriod('all', now), now)).toEqual({ from: null, to: '2026-11-09' });
        expect(reportDays(reportPeriod('last-month', now), now)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    });
    test('sheet names Excel accepts, unique', () => {
        const used = new Set(['summary']);
        expect(sheetName('Summary', used)).toBe('Summary (2)');
        expect(sheetName('Lah: [A/B]*?', used)).toBe('Lah A B');
        expect(sheetName('x'.repeat(40), used)).toHaveLength(31);
    });
    test('one Summary sheet, then one sheet per kind bought, each ending in a totals row; CSV neutralises formulas', () => {
        const items = [...ITEMS, { id: 'f', name: '=HYPERLINK("x") Lah' }];
        const purchases = [...PURCHASES, bill('pf', '2026-11-05T10:00:00', '16', [line('f', '=HYPERLINK("x") Lah', 1, 10)])];
        const kinds = matchKinds(reportKinds(items, purchases), 'lah').kinds;
        const report = itemPurchaseReport(purchases, items, kinds, ALL);
        const sheets = reportSheets(report, { lang: 'en', stamp: [['Shop', 'Gupta'], ['Period', 'all time']] });
        expect(sheets.map(s => s.name)).toEqual(['Summary', '=HYPERLINK("x") Lah', 'Lah Chhuri', 'Lah Kusmi', 'Lah Old']);
        const kusmi = sheets[3].rows;
        expect(kusmi[1]).toEqual(['Bill no.', 'Date', 'Weight (kg)', 'Rate (₹/kg)', 'Amount (₹)', 'Labour (₹)', 'After labour (₹)']);
        expect(kusmi[2].slice(0, 5)).toEqual(['9', '2026-11-03', 100, 200, 20000]);
        expect(kusmi[kusmi.length - 1]).toEqual(['Total', '', 150, 206.67, 31000, kusmi[kusmi.length - 1][5], kusmi[kusmi.length - 1][6]]);
        expect(sheets[0].rows.at(-1)[0]).toBe('All kinds');
        expect(reportCsv(sheets)).toContain(`"'=HYPERLINK(""x"") Lah"`);
        expect(reportSheets(report, { lang: 'hi', stamp: [] })[3].name).toBe('लाह कुसमी');
    });
});

describe('sales, parties and months (ASK-6, ASK-5)', () => {
    const items = [{ id: 'r', name: 'Rice', hindiName: 'चावल' }, { id: 'k', name: 'Lah Kusmi', hindiName: '' }, { id: 'g', name: 'Garlic', hindiName: 'लहसुन' }];
    const sale = (id, date, billNumber, customerName, items, total) => {
        const value = items.reduce((a, l) => a + l.total, 0);
        return { id, date, billNumber, customerName, items, billTotal: value, grandTotal: total ?? value };
    };
    const retail = [
        sale('s1', '2026-11-02T10:00:00', 'R1', 'Ramesh', [line('r', 'Rice', 10, 40), line('k', 'Lah Kusmi', 2, 250)], 895),
        sale('s2', '2026-11-04T10:00:00', 'R2', 'Suresh', [line('r', 'Rice', 5, 42)]),
        sale('s3', '2026-10-15T10:00:00', 'R3', 'ramesh ', [line('g', 'Garlic', 3, 90)]),
        sale('sv', '2026-11-05T10:00:00', 'R4', 'Ramesh', [line('r', 'Rice', 100, 1)], 100)
    ];
    retail[3].voided = true;
    const wholesale = [sale('w1', '2026-11-06T10:00:00', 'W1', 'Gupta Traders', [line('r', 'Rice', 100, 38)])];
    const src = { bills: { purchases: PURCHASES, retailSales: retail, wholesaleSales: wholesale }, items };
    const today = new Date(2026, 10, 9, 12);
    const ask = (q, opts = {}) => answerQuestion(parseQuestion(q), src, { role: 'owner', today, ...opts });

    test('sales of an item: retail and wholesale together, or one of them; amount = the line amounts (I1 / I2)', () => {
        const all = ask('chawal kitna becha is mahine');
        expect(all.spec).toBe('ASK-6');
        expect(all.report.groups[0].totals).toMatchObject({ kg: 115, amount: 4410, avgRate: 38.35, bills: 3, adjust: null, billsTotal: null });
        expect(all.report.groups[0].rows.map(r => [r.billNo, r.type])).toEqual([['R1', 'retail'], ['R2', 'retail'], ['W1', 'wholesale']]);
        expect(ask('thok me chawal kitna becha is mahine').report.totals).toMatchObject({ kg: 100, amount: 3800, bills: 1 });
        expect(ask('khudra chawal kitna becha is mahine').report.totals).toMatchObject({ kg: 15, amount: 610, bills: 2 });
    });
    test('one party: every item it bought, its bills\' discounts, and their own total (I3)', () => {
        const a = ask('Ramesh ko kya kya becha ab tak');
        expect(a).toMatchObject({ party: 'Ramesh', kinds: null });
        expect(a.report.groups.map(g => [g.name, g.totals.kg, g.totals.amount])).toEqual([['Rice', 10, 400], ['Garlic', 3, 270], ['Lah Kusmi', 2, 500]]);
        expect(a.report.totals).toMatchObject({ amount: 1170, adjust: -5, billsTotal: 1165, bills: 2 });
        expect(ask('Ramesh ko lah kitna becha ab tak').report.totals).toMatchObject({ kg: 2, amount: 500, bills: 1, billsTotal: null });
    });
    test('several parties match: which one; none: no figure', () => {
        const two = answerQuestion(parseQuestion('Ra ko kya becha'), { ...src, bills: { ...src.bills, retailSales: [...retail, sale('s9', '2026-11-03T10:00:00', 'R9', 'Rakesh', [line('r', 'Rice', 1, 40)])] } }, { role: 'owner', today });
        expect(two.partyMatches.sort()).toEqual(['Rakesh', 'Ramesh']);
        expect(two.report).toBeUndefined();
        expect(ask('Mohan ko kya becha')).toMatchObject({ kinds: [], subject: 'mohan' });
    });
    test('by party: one group per party (PARTY key), each with its bills\' own total; all parties = M1', () => {
        const a = ask('is mahine ki bikri party wise');
        expect(a.report.groups.map(g => [g.name, g.totals.billsTotal])).toEqual([['Gupta Traders', 3800], ['Ramesh', 895], ['Suresh', 210]]);
        expect(a.report.totals.billsTotal).toBe(4905);
        const lah = ask('lah kisko becha is mahine');
        expect(lah.report.groups.filter(g => g.totals.bills).map(g => [g.name, g.totals.kg])).toEqual([['Ramesh', 2]]);
        expect(lah.report.totals.billsTotal).toBeNull();
    });
    test('by month: months in order, each with its bills\' own total when every item counts', () => {
        const a = ask('ab tak ki bikri mahine wise');
        expect(a.report.groups.map(g => [toMonth(g.month), g.totals.billsTotal])).toEqual([['2026-10', 270], ['2026-11', 4905]]);
        const p = ask('is saal lah ki kharid mahine wise');
        expect(p.report.groups.map(g => [toMonth(g.month), g.totals.kg])).toEqual([['2026-10', 20], ['2026-11', 155]]);
    });
    test('kinds picked by hand: a "not counted" name can be added, none picked gives no figure', () => {
        const q = parseQuestion('lah kitna kharida ab tak');
        const s = { bills: { purchases: PURCHASES }, items: ITEMS };
        const picked = answerQuestion({ ...q, keys: ['k', 'g'] }, s, { role: 'owner', today });
        expect(picked.kinds.map(k => k.key).sort()).toEqual(['g', 'k']);
        expect(picked.report.groups.map(g => g.key).sort()).toEqual(['g', 'k']);
        expect(picked.picked).toBe(true);
        expect(answerQuestion({ ...q, keys: [] }, s, { role: 'owner', today })).toMatchObject({ noKinds: true, kinds: [] });
        expect(answerQuestion({ ...q, keys: ['users'] }, s, { role: 'owner', today }).noKinds).toBe(true);
    });
    test('without Wholesale: all sales are retail only, wholesale gives nothing', () => {
        const m = { role: 'manager', reports: true, wholesale: false };
        expect(ask('chawal kitna becha is mahine', m)).toMatchObject({ retailOnly: true, report: { totals: { kg: 15, bills: 2 } } });
        expect(ask('thok me chawal kitna becha is mahine', m)).toMatchObject({ notAllowed: true });
    });
    test('sheets: sales have a bill type column and no labour; by month the item and party; every item adds the bills\' total', () => {
        const byItem = reportSheets(ask('chawal kitna becha is mahine').report, { lang: 'en', stamp: [] });
        expect(byItem[1].rows[1]).toEqual(['Bill no.', 'Date', 'Bill type', 'Weight (kg)', 'Rate (₹/kg)', 'Amount (₹)']);
        expect(byItem[1].rows[4]).toEqual(['W1', '2026-11-06', 'Wholesale', 100, 38, 3800]);
        expect(byItem[1].rows.at(-1)).toEqual(['Total', '', '', 115, 38.35, 4410]);
        const monthly = reportSheets(ask('ab tak ki bikri mahine wise').report, { lang: 'hi', stamp: [] });
        expect(monthly.map(s => s.name)).toEqual(['सार', formatMonth(new Date(2026, 9, 1), { lang: 'hi' }), formatMonth(new Date(2026, 10, 1), { lang: 'hi' })]);
        expect(monthly[0].rows[2]).toEqual(['महीना', 'बिल', 'वज़न (kg)', 'औसत भाव (₹/kg)', 'रकम (₹)', 'छूट, राउंडिंग (₹)', 'बिलों का कुल (₹)']);
        // 10 + 2 + 5 + 3 + 100 kg for ₹5,180 of lines; R1's ₹5 discount: the bills' own ₹5,175
        expect(monthly[0].rows.at(-1)).toEqual(['सभी महीने', 4, 120, 43.17, 5180, -5, 5175]);
        expect(monthly[2].rows[1]).toEqual(['बिल नं.', 'तारीख', 'बिल का प्रकार', 'माल', 'पार्टी', 'वज़न (kg)', 'भाव (₹/kg)', 'रकम (₹)']);
        const party = reportSheets(ask('Ramesh ko kya kya becha ab tak').report, { lang: 'en', stamp: [['Shop', 'Gupta']] });
        expect(party[0].rows.slice(0, 3)).toEqual([['Item sales'], ['Shop', 'Gupta'], ['Party', 'Ramesh']]);
    });
});

const toMonth = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
