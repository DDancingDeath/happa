/**
 * @fileoverview DUE-BACKFILL (#126): the owner's check (a dry run) and backfill of each bill's
 * stored due, against the fake Firestore: what it lists, what it writes (re-read in a
 * transaction, so a payment recorded meanwhile is kept), that a second run writes nothing,
 * that only the owner runs it, and its record in stockCheckpoints/legacyScan.
 */
import { createFakeFirestore } from './__mocks__/fake-firestore.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { legacyDue, readPayment } from '../utils/money.js';
import { dueBackfillFields } from '../firebase/repos/bill-due.js';
import { describeEdit } from '../utils/bill-edits.js';
import { legacyBill } from '../../../tests/fixtures/due-shapes.js';

let fake;
const user = { uid: 'o1', email: 'o@x' };

beforeEach(() => {
    fake = createFakeFirestore();
    global.firebase = { firestore: Object.assign(() => fake.db, fake.firebase.firestore), auth: () => ({ currentUser: user }) };
    jest.spyOn(FirebaseService, 'db', 'get').mockReturnValue(fake.db);
    window.getCollection = (n) => `dev_${n}`;
    window.COLLECTION_PREFIX = 'dev_';
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    AppState.currentUser = user;
    AppState.userRole = 'owner';
    AppState.userName = 'Owner';
    const bill = (id, type, shape, extra = {}) => ({ ...legacyBill({ id, type, shape, total: 1000, cash: 300, online: 100 }), ...extra });
    fake.seed('dev_retailSales', [bill('r-modern', 'retail', 'modern'), bill('r-top', 'retail', 'topOnly'), bill('r-str', 'retail', 'stringDue'),
        bill('r-void', 'retail', 'topOnly', { voided: true }), bill('r-due', 'retail', 'dueOnly')]);
    fake.seed('dev_purchases', [bill('p-drift', 'purchase', 'drift'), bill('p-null', 'purchase', 'nullDue'), bill('p-open', 'purchase', 'opening')]);
    fake.seed('dev_wholesaleSales', [bill('w-paid', 'wholesale', 'amountPaid'), bill('w-pay', 'wholesale', 'paymentOnly')]);
});

afterEach(() => {
    jest.restoreAllMocks();
    delete global.firebase;
    delete window.getCollection;
    delete window.COLLECTION_PREFIX;
});

const stored = (coll) => [...fake.raw(`dev_${coll}`).entries()].map(([id, d]) => ({ id, ...d }));
const all = () => ['retailSales', 'purchases', 'wholesaleSales'].flatMap(stored);

test('check lists the bills to fix and writes nothing; the backfill stores each due once; a second run writes nothing', async () => {
    // What the old app showed (#126: the app now reads payment.due only; r-due shows ₹0 until it is backfilled)
    const shown = (b) => (b.voided ? readPayment(b) : { ...readPayment(b), due: legacyDue(b) });
    const before = all().map(b => [b.id, shown(b)]);
    expect(readPayment(fake.raw('dev_retailSales').get('r-due')).due).toBe(0);
    const check = await FirebaseService.checkDueFields();
    expect(check.checked).toBe(10);
    expect(check.todo.map(t => [t.id, t.reason]).sort()).toEqual([
        ['p-null', 'notNumber'], ['r-due', 'missing'], ['r-str', 'missing'], ['r-top', 'missing'], ['w-paid', 'missing']]);
    expect(check.byReason).toEqual({ missing: 4, notNumber: 1 });
    expect(check.changes).toEqual([]);
    expect(all().map(b => [b.id, shown(b)])).toEqual(before);

    expect(await FirebaseService.backfillDueFields(check.todo, check.checked)).toEqual({ written: 5, failed: 0 });
    const after = all();
    expect(after.map(b => [b.id, readPayment(b)])).toEqual(before);
    expect(fake.raw('dev_retailSales').get('r-top')).toMatchObject({ payment: { due: 600 }, clientVersion: 5 });
    expect(fake.raw('dev_retailSales').get('r-str')).toMatchObject({ payment: { due: 600 }, cashPayment: '300' });
    expect(fake.raw('dev_retailSales').get('r-due')).toMatchObject({ payment: { due: 600 }, editCount: 1 });
    // A drifted dueAmount is read by nothing any more: left as it is
    expect(fake.raw('dev_purchases').get('p-drift')).not.toHaveProperty('editCount');
    // What was replaced stays on the bill: its edit record (#121), payment only (the rules take no dueAmount)
    expect(fake.raw('dev_retailSales/r-due/edits').get('1')).toMatchObject({
        n: 1, by: 'o1', reason: 'Due stored in one place; no amount changed', fields: { payment: { before: null, after: { due: 600 } } }
    });
    expect(Object.keys(fake.raw('dev_retailSales/r-due/edits').get('1').fields)).toEqual(['payment']);
    expect(describeEdit(fake.raw('dev_retailSales/r-due/edits').get('1'), 'en')).toEqual(['Due: — → ₹600']);
    expect(fake.raw('dev_purchases/p-null/edits').get('1').fields.payment).toEqual({
        before: { cash: 300, online: 100, due: null }, after: { cash: 300, online: 100, due: 600 } });
    expect(fake.raw('dev_wholesaleSales').get('w-paid').payment).toEqual({ due: 600 });
    expect(fake.raw('dev_wholesaleSales').get('w-paid')).not.toHaveProperty('dueAmount');
    expect(fake.raw('dev_retailSales').get('r-void')).not.toHaveProperty('payment');
    after.forEach(b => expect(dueBackfillFields(b)).toBeNull());
    expect(fake.raw('dev_stockCheckpoints').get('legacyScan').dueFields).toMatchObject({ v: 1, checked: 10, written: 5, failed: 0, complete: true, byUserId: 'o1' });
    expect(FirebaseService.dueBackfillState()).toMatchObject({ written: 5 });

    expect((await FirebaseService.checkDueFields()).todo).toEqual([]);
    expect(await FirebaseService.backfillDueFields(check.todo, check.checked)).toEqual({ written: 0, failed: 0 });
    expect(all()).toEqual(after);
    expect(fake.raw('dev_retailSales/r-due/edits').size).toBe(1);
});

test('a payment recorded after the check is kept: the bill is re-read and left alone when it no longer needs it', async () => {
    const check = await FirebaseService.checkDueFields();
    // Another phone records ₹100 on r-top (the payment path writes payment.due and keeps dueAmount equal)
    fake.raw('dev_retailSales').set('r-top', { ...fake.raw('dev_retailSales').get('r-top'), payment: { cash: 400, online: 100, due: 500, total: 500 }, dueAmount: 500 });
    expect(await FirebaseService.backfillDueFields(check.todo, check.checked)).toEqual({ written: 4, failed: 0 });
    expect(readPayment(fake.raw('dev_retailSales').get('r-top'))).toMatchObject({ cash: 400, due: 500 });
});

test('only the owner checks or writes', async () => {
    AppState.userRole = 'manager';
    await expect(FirebaseService.checkDueFields()).rejects.toMatchObject({ code: 'owner-only' });
    await expect(FirebaseService.backfillDueFields([{ collKey: 'retailSales', id: 'r-top' }])).rejects.toMatchObject({ code: 'owner-only' });
    expect(fake.raw('dev_retailSales').get('r-top')).not.toHaveProperty('payment');
});
