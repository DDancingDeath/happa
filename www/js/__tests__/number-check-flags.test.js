/**
 * Number-check mismatches reach Anomalies (#160): one flag per failed check and
 * set of mismatches, the same set never twice (any day, any phone), a reviewed
 * flag keeps its review, passing or skipped checks write nothing.
 */
import { numberCheckFlags, fingerprint } from '../utils/number-check-flags.js';
import { planAnomalyWrites, typeLabel, istDayKey } from '../utils/anomalies.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AnomaliesManager } from '../modules/anomalies.js';
import { AppState } from '../utils/state.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';

const NOW = new Date('2026-11-01T10:00:00+05:30').getTime();
const bill = (id, number) => ({ ref: { kind: 'retail', id, number, party: 'Ram', day: '01/11/2026' }, expected: 500, actual: 450, diff: 50 });
const RESULTS = [
    { id: 'AC1', key: 'ui.numchecks.ac1', status: 'skip', checked: 0, problems: 0, rows: [] },
    { id: 'AC2', key: 'ui.numchecks.ac2', status: 'fail', checked: 9, problems: 4, rows: [bill('b1', 'R-1'), bill('b2', 'R-2'), bill('b3', 'R-3'), { ...bill('b4', 'R-4'), diff: -20 }] },
    { id: 'AC3', key: 'ui.numchecks.ac3', status: 'pass', checked: 3, problems: 0, rows: [] },
    { id: 'AC8', key: 'ui.numchecks.ac8', status: 'fail', checked: 5, problems: 1, rows: [{ ref: { item: 'Rice' }, expected: 0, actual: -3, diff: 3, unit: 'qty' }] }
];

describe('numberCheckFlags', () => {
    test('one flag per failed check, in both languages, with what failed and the money involved', () => {
        const flags = numberCheckFlags(RESULTS, NOW);
        expect(flags.map(f => [f.type, f.severity, f.refKind])).toEqual([['numcheck-ac2', 'high', 'check'], ['numcheck-ac8', 'medium', 'check']]);
        expect(flags[0].en).toBe('Bill total = cash + online + due: 4 found (R-1, R-2, R-3 …)');
        expect(flags[0].hi).toMatch(/^बिल का कुल = नकद \+ ऑनलाइन \+ उधार: 4 मिले \(R-1, R-2, R-3 …\)$/);
        expect(flags[0].amount).toBe(170);
        expect(flags[1]).toMatchObject({ amount: 0, en: 'No item below zero stock: 1 found (Rice)', dayKey: istDayKey(NOW), at: NOW, party: '' });
        expect(typeLabel('numcheck-ac2').en).toBe('Number check: bill split');
    });

    test('the same mismatches give the same id on any day; different ones a new id', () => {
        const a = numberCheckFlags(RESULTS, NOW)[0];
        const b = numberCheckFlags(RESULTS, NOW + 3 * 86400000)[0];
        expect(b.id).toBe(a.id);
        const fewer = RESULTS.map(r => (r.id === 'AC2' ? { ...r, problems: 3, rows: r.rows.slice(1) } : r));
        expect(numberCheckFlags(fewer, NOW)[0].id).not.toBe(a.id);
        const reordered = RESULTS.map(r => (r.id === 'AC2' ? { ...r, rows: [...r.rows].reverse() } : r));
        expect(numberCheckFlags(reordered, NOW)[0].id).toBe(a.id);
        expect(fingerprint('x')).toMatch(/^[0-9a-z]+$/);
    });

    test('nothing when every check passes or is skipped', () => {
        expect(numberCheckFlags(RESULTS.filter(r => r.status !== 'fail'), NOW)).toEqual([]);
        expect(numberCheckFlags(null, NOW)).toEqual([]);
    });
});

describe('recording them (AnomaliesManager.recordNumberChecks)', () => {
    let fake;
    beforeEach(() => {
        fake = createFakeFirestore();
        global.firebase = fake.firebase;
        FirebaseService.cleanup();
        AppState.userRole = 'owner';
        AppState.currentUser = { uid: 'u1' };
        jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
    });
    afterEach(() => {
        jest.restoreAllMocks();
        FirebaseService.cleanup();
    });
    const stored = () => [...fake.raw('dev_anomalies').entries(), ...fake.raw('anomalies').entries()];

    test('creates the flags once; a reviewed flag keeps its review the next day', async () => {
        expect(await AnomaliesManager.recordNumberChecks(RESULTS, NOW)).toBe(2);
        const docs = stored();
        expect(docs.length).toBe(2);
        const [id, data] = docs.find(([, d]) => d.type === 'numcheck-ac2');
        expect(data).toMatchObject({ status: 'open', note: '', reviewedBy: null, detectedBy: 'numchecks', refKind: 'check' });
        const coll = fake.raw('dev_anomalies').size ? 'dev_anomalies' : 'anomalies';
        fake.raw(coll).set(id, { ...data, status: 'ok', note: 'known', reviewedBy: 'u1' });
        expect(await AnomaliesManager.recordNumberChecks(RESULTS, NOW + 86400000)).toBe(0);
        expect(fake.raw(coll).get(id)).toMatchObject({ status: 'ok', note: 'known' });
    });

    test('members, offline phones and clean runs write nothing', async () => {
        AppState.userRole = 'staff';
        expect(await AnomaliesManager.recordNumberChecks(RESULTS, NOW)).toBe(0);
        AppState.userRole = 'manager';
        expect(await AnomaliesManager.recordNumberChecks(RESULTS.filter(r => r.status !== 'fail'), NOW)).toBe(0);
        jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
        expect(await AnomaliesManager.recordNumberChecks(RESULTS, NOW)).toBe(0);
        expect(stored().length).toBe(0);
    });

    test('the stored record is what a scan would store for a new anomaly', () => {
        const flags = numberCheckFlags(RESULTS, NOW);
        const [w] = planAnomalyWrites(flags, [], NOW);
        expect(Object.keys(w.data).sort()).toEqual(expect.arrayContaining(['type', 'severity', 'dayKey', 'status', 'detectedAt']));
    });
});
