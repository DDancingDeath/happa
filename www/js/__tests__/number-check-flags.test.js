/**
 * Number-check mismatches reach Anomalies (#160): one flag per mismatch (check +
 * bill / item / day), the same mismatch never twice (any day, any phone), a
 * reviewed flag keeps its review, passing or skipped checks write nothing, and a
 * mismatch this phone already filed costs no read the next day.
 */
import { numberCheckFlags } from '../utils/number-check-flags.js';
import { planAnomalyWrites, typeLabel, istDayKey } from '../utils/anomalies.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AnomaliesManager } from '../modules/anomalies.js';
import { AppState } from '../utils/state.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';

const NOW = new Date('2026-11-01T10:00:00+05:30').getTime();
const bill = (id, number, diff = 50) => ({ ref: { kind: 'retail', id, number, party: 'Ram', day: '01/11/2026' }, expected: 500, actual: 500 - diff, diff });
const ac2 = (rows) => ({ id: 'AC2', key: 'ui.numchecks.ac2', status: 'fail', checked: 9, problems: rows.length, rows });
const RESULTS = [
    { id: 'AC1', key: 'ui.numchecks.ac1', status: 'skip', checked: 0, problems: 0, rows: [] },
    ac2([bill('b1', 'R-1'), bill('b2', 'R-2', -20)]),
    { id: 'AC3', key: 'ui.numchecks.ac3', status: 'pass', checked: 3, problems: 0, rows: [] },
    { id: 'AC6', key: 'ui.numchecks.ac6', status: 'fail', checked: 1, problems: 1, rows: [{ ref: { day: '2026-11-01' }, expected: 1200, actual: 1150, diff: 50 }] },
    { id: 'AC8', key: 'ui.numchecks.ac8', status: 'fail', checked: 5, problems: 1, rows: [{ ref: { item: 'Rice' }, expected: 0, actual: -3, diff: 3, unit: 'qty' }] }
];

describe('numberCheckFlags', () => {
    test('one flag per mismatch, filed under its bill / item / day, in both languages', () => {
        const flags = numberCheckFlags(RESULTS, NOW);
        expect(flags.map(f => [f.type, f.severity, f.refKind, f.refId])).toEqual([
            ['numcheck-ac2', 'high', 'bill', 'b1'], ['numcheck-ac2', 'high', 'bill', 'b2'],
            ['numcheck-ac6', 'high', 'cash', '2026-11-01'], ['numcheck-ac8', 'medium', 'stock', 'Rice']
        ]);
        expect(flags[0]).toMatchObject({ billType: 'retail', billNumber: 'R-1', party: 'Ram', amount: 50, at: NOW, dayKey: istDayKey(NOW), detectedBy: 'numchecks' });
        expect(flags[0].en).toBe('Bill total = cash + online + due: expected ₹500, found ₹450');
        expect(flags[0].hi).toBe('बिल का कुल = नकद + ऑनलाइन + उधार: होना था ₹500, मिला ₹450');
        expect(flags[1].amount).toBe(20);
        expect(flags[3]).toMatchObject({ item: 'Rice', amount: 0, en: 'No item below zero stock: expected 0 kg, found -3 kg' });
        expect(typeLabel('numcheck-ac2')).toEqual({ en: 'Number check: bill split', hi: 'आँकड़ों की जाँच: बिल का बँटवारा' });
    });

    test('a mismatch keeps its id on any day and whatever else fails with it', () => {
        const a = numberCheckFlags(RESULTS, NOW)[0];
        expect(numberCheckFlags(RESULTS, NOW + 3 * 86400000)[0].id).toBe(a.id);
        const more = RESULTS.map(r => (r.id === 'AC2' ? ac2([bill('b0', 'R-0'), ...r.rows]) : r));
        expect(numberCheckFlags(more, NOW).map(f => f.id)).toContain(a.id);
        expect(numberCheckFlags([ac2([{ ref: { kind: 'retail', number: 'R-9' }, expected: 1, actual: 0, diff: 1 }, { ref: { kind: 'retail' }, expected: 1, actual: 0, diff: 1 }])], NOW).map(f => f.refId)).toEqual(['R-9']);
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
        localStorage.clear();
        AppState.userRole = 'owner';
        AppState.currentUser = { uid: 'u1' };
        jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
    });
    afterEach(() => {
        jest.restoreAllMocks();
        FirebaseService.cleanup();
    });
    const coll = () => (fake.raw('dev_anomalies').size ? fake.raw('dev_anomalies') : fake.raw('anomalies'));

    test('creates each flag once; a reviewed flag keeps its review; a known mismatch costs no read', async () => {
        expect(await AnomaliesManager.recordNumberChecks(RESULTS, NOW)).toBe(4);
        expect(coll().size).toBe(4);
        const [id, data] = [...coll().entries()].find(([, d]) => d.refId === 'b1');
        expect(data).toMatchObject({ status: 'open', note: '', reviewedBy: null, refKind: 'bill', type: 'numcheck-ac2' });
        coll().set(id, { ...data, status: 'ok', note: 'known', reviewedBy: 'u1' });
        const get = jest.spyOn(FirebaseService, 'addAnomaliesIfMissing');
        expect(await AnomaliesManager.recordNumberChecks(RESULTS, NOW + 86400000)).toBe(0);
        expect(get).not.toHaveBeenCalled();
        localStorage.clear();
        expect(await AnomaliesManager.recordNumberChecks(RESULTS, NOW + 86400000)).toBe(0);
        expect(get).toHaveBeenCalledTimes(1);
        expect(coll().get(id)).toMatchObject({ status: 'ok', note: 'known' });
        const more = RESULTS.map(r => (r.id === 'AC2' ? ac2([bill('b9', 'R-9'), ...r.rows]) : r));
        expect(await AnomaliesManager.recordNumberChecks(more, NOW + 2 * 86400000)).toBe(1);
        expect(get.mock.calls[1][0].map(w => w.id)).toEqual([numberCheckFlags(more, NOW)[0].id]);
    });

    test('members, offline phones and clean runs write nothing', async () => {
        AppState.userRole = 'staff';
        expect(await AnomaliesManager.recordNumberChecks(RESULTS, NOW)).toBe(0);
        AppState.userRole = 'manager';
        expect(await AnomaliesManager.recordNumberChecks(RESULTS.filter(r => r.status !== 'fail'), NOW)).toBe(0);
        jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
        expect(await AnomaliesManager.recordNumberChecks(RESULTS, NOW)).toBe(0);
        expect(fake.raw('anomalies').size + fake.raw('dev_anomalies').size).toBe(0);
    });

    test('the stored record is what a scan would store for a new anomaly', () => {
        const [w] = planAnomalyWrites(numberCheckFlags(RESULTS, NOW), [], NOW);
        expect(Object.keys(w.data)).toEqual(expect.arrayContaining(['type', 'severity', 'dayKey', 'status', 'detectedAt', 'refKind', 'refId']));
    });
});
