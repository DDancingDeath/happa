/**
 * Property expenses (#157, RENT-17 / RENT-18): the maths, the store on the
 * in-memory Firestore, the Rent page summary (expenses and net this month, per
 * property and in all) and the Properties › 💸 Expenses dialog (lazy).
 */
import { createFakeFirestore } from './__mocks__/fake-firestore.js';

const fake = createFakeFirestore();
jest.mock('../firebase/firestore-service.js', () => ({ FirebaseService: { get db() { return global.__fakeDb; } } }));
global.__fakeDb = fake.db;

import { AppState } from '../utils/state.js';
import * as es from '../rentals/rent-expense-store.js';
import { expenseTotals, netOf } from '../rentals/rent-math.js';
import { expenseError } from '../rentals/rent-math-ledger.js';

const ex = (propertyId, amount, month = '2026-10') => ({ propertyId, amount, month });

describe('RENT-17 / RENT-18 math', () => {
    test('this month\'s expenses in all and per property; other months left out; net = collected − expenses', () => {
        const t = expenseTotals([ex('P1', 1500), ex('P1', 250.5), ex('P2', 4000), ex('P1', 9999, '2026-09')], '2026-10');
        expect(t).toEqual({ total: 5750.5, byProperty: { P1: 1750.5, P2: 4000 } });
        expect(expenseTotals([], '2026-10')).toEqual({ total: 0, byProperty: {} });
        expect(netOf(12000, 5750.5)).toBe(6249.5);
        expect(netOf(1000, 4000)).toBe(-3000);
    });

    test('form checks: a known category and mode, an amount above 0 (whole rupees), a real date', () => {
        const ok = { category: 'repairs', mode: 'cash', amount: 1500, date: '2026-10-05' };
        expect(expenseError(ok)).toBe('');
        expect(expenseError({ ...ok, category: 'party' })).toBe('msg.rent.bad_amount');
        expect(expenseError({ ...ok, mode: 'gold' })).toBe('msg.rent.bad_amount');
        expect(expenseError({ ...ok, amount: 0.4 })).toBe('msg.rent.bad_amount');
        expect(expenseError({ ...ok, date: '2026-02-30' })).toBe('msg.rent.bad_date');
    });
});

describe('expense store', () => {
    beforeEach(() => {
        fake.raw('rent_expenses').clear();
        AppState.currentUser = { uid: 'u1' };
        AppState.userName = 'Hitesh';
    });

    test('added with its month and who added it; listed newest first per property; owner edit and delete', async () => {
        await es.addExpense({ propertyId: 'P1', unitId: 'U1', category: 'repairs', amount: 1500, date: '2026-10-05', mode: 'cash', note: 'Tap' });
        await es.addExpense({ propertyId: 'P1', category: 'tax', amount: 9000, date: '2026-11-02', mode: 'bank', note: '' });
        await es.addExpense({ propertyId: 'P2', category: 'other', amount: 100, date: '2026-10-09', mode: 'upi', note: '' });
        const list = await es.listExpenses('P1');
        expect(list.map(e => [e.category, e.month, e.unitId])).toEqual([['tax', '2026-11', null], ['repairs', '2026-10', 'U1']]);
        expect(list[1]).toMatchObject({ amount: 1500, note: 'Tap', byName: 'Hitesh', createdBy: 'u1', updatedBy: 'u1' });
        await es.updateExpense(list[1].id, { ...list[1], amount: 1800, date: '2026-09-30' });
        expect(fake.raw('rent_expenses').get(list[1].id)).toMatchObject({ amount: 1800, month: '2026-09', createdBy: 'u1' });
        await es.deleteExpense(list[0].id);
        expect((await es.listExpenses('P1')).length).toBe(1);
    });
});
