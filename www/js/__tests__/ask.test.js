/**
 * Ask (#88): the word matcher and the answers' edge cases (names matching
 * several parties, Hindi ↔ Latin spellings, members' stock limit, archived
 * items). The figures themselves are checked against the oracle in tests/oracle/ask.test.js.
 */
import { answerQuestion, parseQuestion } from '../utils/ask.js';

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
        ['weather kal', { intent: 'unknown' }]
    ])('%s', (text, want) => expect(parseQuestion(text)).toEqual(want));
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
    test('stock: archived items are not offered; still updating says so', () => {
        expect(ask('dal ka stock').matches).toEqual([]);
        expect(ask('rice stock', { stockReady: false }).updating).toBe(true);
    });
});
