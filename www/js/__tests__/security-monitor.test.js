/**
 * @fileoverview Misuse review flags (#124): refused writes, new phones and tries on
 * old bills become audit entries on the phone and flags in the owner's daily scan.
 */
import {
    SECURITY_ACTIONS, deniedWriteSource, planDeniedNote, deviceCheck, deniedClusters, DENIED_NOTE_LIMITS
} from '../utils/security-flags.js';
import { detectAnomalies } from '../utils/anomalies.js';
import { DEFAULT_THRESHOLDS } from '../utils/bill-checks.js';
import { SecurityMonitor } from '../services/security-monitor.js';
import { AuditService } from '../services/audit.js';
import { emit, FIRESTORE_DENIED } from '../utils/events.js';
import { AppState } from '../utils/state.js';
import * as users from '../firebase/repos/users.js';

const MIN = 60000;

describe('which refused calls are recorded', () => {
    test.each([
        ['dev_purchases (doc) update', 'purchases update'],
        ['withdrawals add', 'withdrawals add'],
        ['dev_settings (doc) set', 'settings set'],
        ['purchases/b1/edits (doc) set', 'purchases/b1/edits set'],
        ['batch commit', 'batch commit'],
        ['transaction', 'transaction'],
        ['purchases get', null],
        ['dev_users listen', null],
        ['dev_counters (doc) transaction', null],
        ['dev_auditLogs add', null],
        ['telemetry (doc) set', null],
        ['dev_tipHealth (doc) set', null],
        ['stockCheckpoints (doc) set', null],
        ['', null]
    ])('%s → %s', (source, out) => {
        expect(deniedWriteSource(source)).toBe(out);
    });

    test('one entry per kind and at most 5 per 10 minutes per phone', () => {
        let recent = [];
        const note = (s, at) => { const p = planDeniedNote(recent, s, at); recent = p.recent; return p.note; };
        expect(note('a set', 0)).toBe(true);
        expect(note('a set', MIN)).toBe(false);
        ['b', 'c', 'd', 'e'].forEach((k, i) => expect(note(`${k} set`, 2 * MIN + i)).toBe(true));
        expect(note('f set', 3 * MIN)).toBe(false);
        expect(note('a set', DENIED_NOTE_LIMITS.windowMs + 1)).toBe(true);
    });

    test('new phone: the first ever is remembered without a flag; another one is flagged; the list keeps 10', () => {
        expect(deviceCheck(undefined, 'p1')).toEqual({ isNew: true, flag: false, next: ['p1'] });
        expect(deviceCheck(['p1'], 'p1')).toEqual({ isNew: false, flag: false, next: ['p1'] });
        expect(deviceCheck(['p1'], 'p2')).toEqual({ isNew: true, flag: true, next: ['p1', 'p2'] });
        const ten = Array.from({ length: 10 }, (_, i) => `d${i}`);
        expect(deviceCheck(ten, 'new').next).toEqual([...ten.slice(1), 'new']);
    });
});

describe('owner daily scan flags (detectAnomalies)', () => {
    const t0 = Date.UTC(2026, 9, 21, 6, 0);
    const denied = (id, userId, at, source = 'purchases update') =>
        ({ id, action: SECURITY_ACTIONS.DENIED, userId, userName: 'Ram', timestamp: at, details: { source } });
    const scan = (auditLogs, thresholds = {}) => detectAnomalies({ auditLogs, thresholds, from: t0 - 86400000, to: t0 + 86400000 });

    test('3 refused changes by one person within 10 minutes raise one high flag; spread out or other people do not', () => {
        const logs = [
            denied('a1', 'u1', t0), denied('a2', 'u1', t0 + 4 * MIN, 'withdrawals add'), denied('a3', 'u1', t0 + 9 * MIN),
            denied('b1', 'u2', t0), denied('b2', 'u2', t0 + 11 * MIN), denied('b3', 'u2', t0 + 22 * MIN),
            denied('c1', 'u3', t0), denied('c2', 'u3', t0 + MIN)
        ];
        const flags = scan(logs).filter(a => a.type === 'access-denied');
        expect(flags).toHaveLength(1);
        expect(flags[0]).toMatchObject({ severity: 'high', userId: 'u1', user: 'Ram', refId: 'a1', at: t0 });
        expect(flags[0].en).toBe('3 changes refused within 9 min (purchases update, withdrawals add)');
        expect(flags[0].hi).toBe('9 मिनट में 3 बदलाव मना हुए (purchases update, withdrawals add)');
        // the same entries give the same id (no second record on the next scan)
        expect(scan(logs).find(a => a.type === 'access-denied').id).toBe(flags[0].id);
    });

    test('thresholds come from Settings › bill checks (deniedCount, deniedWindowMin)', () => {
        expect(DEFAULT_THRESHOLDS).toMatchObject({ deniedCount: 3, deniedWindowMin: 10 });
        const logs = [denied('c1', 'u3', t0), denied('c2', 'u3', t0 + 15 * MIN)];
        expect(scan(logs).some(a => a.type === 'access-denied')).toBe(false);
        expect(scan(logs, { deniedCount: 2, deniedWindowMin: 20 }).some(a => a.type === 'access-denied')).toBe(true);
    });

    test('a new phone is a low flag; a try on an old bill a medium one', () => {
        const flags = scan([
            { id: 'n1', action: SECURITY_ACTIONS.NEW_DEVICE, userId: 'u1', userName: 'Ram', timestamp: t0, details: { device: 'abc' } },
            { id: 'o1', action: SECURITY_ACTIONS.OLD_BILL_TRY, userId: 'u1', userName: 'Ram', timestamp: t0, details: { what: 'void', billNumber: 'P1', billType: 'purchase' } }
        ]);
        expect(flags.find(a => a.type === 'new-device')).toMatchObject({ severity: 'low', userId: 'u1' });
        expect(flags.find(a => a.type === 'old-bill-edit-try')).toMatchObject({
            severity: 'medium', billNumber: 'P1', en: 'Tried to void bill #P1 after its edit window'
        });
    });

    test('deniedClusters starts a new run after a flagged one', () => {
        const logs = [0, 1, 2, 3, 4, 5].map(i => denied(`x${i}`, 'u1', t0 + i * MIN));
        expect(deniedClusters(logs, { deniedCount: 3, deniedWindowMin: 10 }).map(c => c.entries.length)).toEqual([6]);
        expect(deniedClusters(logs, { deniedCount: 3, deniedWindowMin: 2 }).map(c => c.first.id)).toEqual(['x0', 'x3']);
    });
});

describe('SecurityMonitor on the phone', () => {
    let note;
    beforeEach(() => {
        note = jest.spyOn(AuditService, 'log').mockResolvedValue();
        AppState.currentUser = { uid: 'u1' };
        AppState.userRole = 'staff';
        SecurityMonitor.stop();
        SecurityMonitor.start();
    });
    afterEach(() => {
        SecurityMonitor.stop();
        jest.restoreAllMocks();
    });

    test('a refused write (meter event) writes PERMISSION_DENIED once; reads and the audit log itself never', () => {
        emit(FIRESTORE_DENIED, 'dev_purchases (doc) update');
        emit(FIRESTORE_DENIED, 'dev_purchases (doc) update');
        emit(FIRESTORE_DENIED, 'dev_purchases get');
        emit(FIRESTORE_DENIED, 'dev_auditLogs add');
        expect(note).toHaveBeenCalledTimes(1);
        expect(note).toHaveBeenCalledWith('PERMISSION_DENIED', { source: 'purchases update' });
        AppState.currentUser = null;
        emit(FIRESTORE_DENIED, 'dev_items (doc) set');
        expect(note).toHaveBeenCalledTimes(1);
    });

    test('checkDevice saves a new phone and flags it only when others were used before', async () => {
        const save = jest.spyOn(users, 'setOwnDevices').mockResolvedValue();
        expect(await SecurityMonitor.checkDevice('u1', { name: 'Ram' })).toBe(true);
        expect(save).toHaveBeenCalledTimes(1);
        const [, first] = save.mock.calls[0];
        expect(note).not.toHaveBeenCalled();
        expect(await SecurityMonitor.checkDevice('u1', { devices: first })).toBe(false);
        expect(await SecurityMonitor.checkDevice('u1', { devices: ['otherphone1'] })).toBe(true);
        expect(note).toHaveBeenCalledWith('NEW_DEVICE', expect.objectContaining({ known: 1 }));
    });

    test('a try on an old bill is recorded for everyone but the owner', () => {
        SecurityMonitor.noteOldBillTry({ id: 'b1', billNumber: 'P7' }, 'purchase', 'edit');
        expect(note).toHaveBeenCalledWith('OLD_BILL_EDIT_TRY', { what: 'edit', billType: 'purchase', billId: 'b1', billNumber: 'P7' });
        AppState.userRole = 'owner';
        SecurityMonitor.noteOldBillTry({ id: 'b2' }, 'purchase', 'edit');
        expect(note).toHaveBeenCalledTimes(1);
    });
});
