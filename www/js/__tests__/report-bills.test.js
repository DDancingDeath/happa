/**
 * Ask item reports (#415): the older purchase bills are read once, from the server, and
 * kept for the session; all time reads every bill (also ones without a timestamp).
 */
import { FirebaseService } from '../firebase/firestore-service.js';
import { S } from '../firebase/core/session.js';
import { noteLocalRecordWrite } from '../firebase/core/history-window.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';

let fake;
beforeEach(() => {
    fake = createFakeFirestore();
    global.firebase = fake.firebase;
    window.getCollection = (n) => n;
    FirebaseService.forgetReportBills();
    fake.seed('purchases', [
        { id: 'a', timestamp: 1000, items: [] },
        { id: 'b', timestamp: 5000, items: [] },
        { id: 'legacy', date: '01/01/2020', items: [] }
    ]);
});

test('all time: every bill once; asking again reads nothing; a new session reads again', async () => {
    const first = await FirebaseService.readReportBills('purchases', null);
    expect(first.bills.map(b => b.id).sort()).toEqual(['a', 'b', 'legacy']);
    const reads = fake.stats.reads;
    expect(reads).toBe(3);
    await FirebaseService.readReportBills('purchases', 4000);
    expect(fake.stats.reads).toBe(reads);
    expect(FirebaseService.reportBillsInMemory('purchases', 4000)).toEqual(first);
    S.sessionGen++;
    expect(FirebaseService.reportBillsInMemory('purchases', null)).toBeNull();
});

test('from a day: only bills from then on; an all-time question still needs a read', async () => {
    const { bills } = await FirebaseService.readReportBills('purchases', 4000);
    expect(bills.map(b => b.id)).toEqual(['b']);
    expect(FirebaseService.reportBillsInMemory('purchases', null)).toBeNull();
    expect(FirebaseService.reportBillsInMemory('purchases', 4500)).not.toBeNull();
});

test('a bill this phone voids, edits or deletes changes in the bills held too', async () => {
    await FirebaseService.readReportBills('purchases', null);
    noteLocalRecordWrite('purchases', 'a', { id: 'a', timestamp: 1000, voided: true, items: [] });
    noteLocalRecordWrite('purchases', 'b', null);
    expect(FirebaseService.reportBillsInMemory('purchases', null).bills.map(b => [b.id, !!b.voided])).toEqual([['a', true], ['legacy', false]]);
});

test('the oldest bill from the phone\'s cache is refused (it would make the estimate far too low)', async () => {
    const cached = { docs: [{ data: () => ({ timestamp: 5000 }) }], metadata: { fromCache: true } };
    global.firebase = { firestore: () => ({ collection: () => ({ orderBy: () => ({ limit: () => ({ get: async () => cached }) }) }) }) };
    await expect(FirebaseService.oldestBillTime('purchases')).rejects.toMatchObject({ code: 'unavailable' });
});

test('oldest purchase time: one read; only bill collections', async () => {
    expect(await FirebaseService.oldestBillTime('purchases')).toBe(1000);
    await expect(FirebaseService.readReportBills('users', null)).rejects.toThrow('Not a bill collection');
});
