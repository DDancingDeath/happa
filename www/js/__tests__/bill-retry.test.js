/**
 * @fileoverview Retrying a new bill save (#70 review): the retry reuses the bill
 * id, and must never undo a due payment recorded on another device in between.
 */
import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { readPayment } from '../utils/money.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';
import { tip } from '../tip/index.js';

let fake;

beforeEach(() => {
    fake = createFakeFirestore();
    global.firebase = fake.firebase;
    FirebaseService.cleanup();
    AppState.currentUser = { uid: 'u1' };
    AppState.userName = 'Owner';
    AppState.userRole = 'owner';
    jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
});

afterEach(() => {
    jest.restoreAllMocks();
    FirebaseService.cleanup();
});

const bill = (over = {}) => ({
    id: 'p1', billNumber: 'P20261022-001', type: 'purchase', isPurchase: true,
    date: '2026-10-22T10:00:00.000Z', timestamp: 1792663200000,
    items: [{ itemId: 'rice', name: 'Rice', qty: 10, rate: 10, total: 100, weights: [10] }],
    billTotal: 100, laborCharges: 0, grandTotal: 100, amountPayable: 100,
    cashPayment: 40, onlinePayment: 0, dueAmount: 60, customerName: 'Ramesh', comments: '',
    payment: { cash: 40, online: 0, due: 60, total: 100 },
    ...over
});
const doc = () => fake.raw('purchases').get('p1');

test('first save creates the bill', async () => {
    const saved = await FirebaseService.savePurchase(bill(), { retry: false });
    expect(fake.raw('purchases').size).toBe(1);
    expect(doc()).toMatchObject({ dueAmount: 60, payment: { due: 60, cash: 40 }, openDue: true, clientVersion: 3 });
    expect(FirebaseService.keptServerPayment(saved)).toBe(false);
});

test('a retry whose first attempt never reached the server creates the bill', async () => {
    const saved = await FirebaseService.savePurchase(bill(), { retry: true });
    expect(fake.raw('purchases').size).toBe(1);
    expect(doc()).toMatchObject({ dueAmount: 60, payment: { due: 60 } });
    expect(FirebaseService.keptServerPayment(saved)).toBe(false);
});

test('a retry after the first attempt succeeded, with nothing changed, writes nothing', async () => {
    await FirebaseService.savePurchase(bill(), { retry: false });
    const writes = fake.stats.writes;
    const saved = await FirebaseService.savePurchase(bill(), { retry: true });
    expect(fake.stats.writes).toBe(writes);
    expect(fake.raw('purchases').size).toBe(1);
    expect(FirebaseService.keptServerPayment(saved)).toBe(false);
});

test('a retry with changes made on this phone (no payment elsewhere) overwrites the bill', async () => {
    await FirebaseService.savePurchase(bill(), { retry: false });
    await FirebaseService.savePurchase(bill({ cashPayment: 100, dueAmount: 0, payment: { cash: 100, online: 0, due: 0, total: 100 } }), { retry: true });
    expect(doc()).toMatchObject({ cashPayment: 100, dueAmount: 0, payment: { due: 0 }, openDue: false });
});

test('a retry after another device recorded a due payment keeps that payment', async () => {
    await FirebaseService.savePurchase(bill(), { retry: false });
    // Another phone records ₹20 on Outstanding before this phone's retry
    const server = doc();
    fake.raw('purchases').set('p1', {
        ...server,
        payment: { cash: 60, online: 0, due: 40, total: 60 },
        dueAmount: 40,
        payments: [{ id: 'pay-1', amount: 20, recordedBy: 'Asha' }]
    });

    const saved = await FirebaseService.savePurchase(bill({ comments: 'GPay Ramesh' }), { retry: true });

    expect(FirebaseService.keptServerPayment(saved)).toBe(true);
    const after = doc();
    expect(after.comments).toBe('GPay Ramesh');
    expect(after.payment).toEqual({ cash: 60, online: 0, due: 40, total: 60 });
    expect(after.dueAmount).toBe(40);
    expect(after.cashPayment).toBe(40);
    expect(after.payments).toEqual([{ id: 'pay-1', amount: 20, recordedBy: 'Asha' }]);
    expect(after.openDue).toBe(true);
    expect(readPayment(after)).toMatchObject({ due: 40, cash: 60 });
    // The returned bill (printed / kept in memory) shows the server's money fields
    expect(saved.payment.due).toBe(40);
    expect(saved.payments).toHaveLength(1);
    expect(fake.raw('purchases').size).toBe(1);
});

describe('createdAt: server time of the first save (#87 edit window)', () => {
    test('a new bill is written with createdAt; a retry and a later edit keep the stored value', async () => {
        await FirebaseService.savePurchase(bill(), { retry: false });
        const created = doc().createdAt;
        expect(typeof created).toBe('number');
        await FirebaseService.savePurchase(bill({ createdAt: created + 99999 }), { retry: true });
        expect(doc().createdAt).toBe(created);
        await FirebaseService.updatePurchase({ ...doc(), id: 'p1', comments: 'edited', createdAt: undefined });
        expect(doc()).toMatchObject({ comments: 'edited', createdAt: created });
    });

    test('an edit of a bill saved before #87 does not add createdAt', async () => {
        fake.raw('purchases').set('p1', { ...bill() });
        await FirebaseService.updatePurchase({ ...bill(), comments: 'edited', createdAt: Date.now() });
        expect(doc().comments).toBe('edited');
        expect(doc().createdAt).toBeUndefined();
    });
});

describe('a late first attempt after a retry already saved the bill (#87 review)', () => {
    /** Holds the first set() of purchases/p1 until the test rejects it. */
    function holdFirstSet() {
        const held = {};
        const real = fake.db.collection;
        jest.spyOn(fake.db, 'collection').mockImplementation((name) => {
            const c = real(name);
            return {
                ...c,
                doc: (id) => {
                    const d = c.doc(id);
                    if (name !== 'purchases' || held.reject) return d;
                    return { ...d, set: () => new Promise((_, reject) => { held.reject = reject; }) };
                }
            };
        });
        return held;
    }
    const tipRuns = () => {
        const runs = [];
        jest.spyOn(tip, 'start').mockImplementation(() => {
            const r = { complete: jest.fn(), completeAndFail: jest.fn() };
            runs.push(r);
            return r;
        });
        return runs;
    };
    const flush = () => new Promise(r => setTimeout(r, 0));
    const denied = Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });

    test('its permission-denied is not a TIP failure, shows no error, and createdAt stays the retry\'s', async () => {
        const held = holdFirstSet();
        const runs = tipRuns();
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        const onLine = jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
        await FirebaseService.savePurchase(bill(), { retry: false });
        onLine.mockReturnValue(true);
        await FirebaseService.savePurchase(bill(), { retry: true });
        const created = doc().createdAt;
        held.reject(denied);
        await flush();
        expect(runs[0].completeAndFail).not.toHaveBeenCalled();
        expect(runs[0].complete).toHaveBeenCalledWith({ supersededByRetry: true });
        expect(error).not.toHaveBeenCalled();
        expect(doc().createdAt).toBe(created);
    });

    test('without a retry, a refused first save is still a TIP failure', async () => {
        const held = holdFirstSet();
        const runs = tipRuns();
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
        await FirebaseService.savePurchase(bill(), { retry: false });
        held.reject(denied);
        await flush();
        expect(runs[0].completeAndFail).toHaveBeenCalledWith('write_rejected', { code: 'permission-denied' });
    });
});
