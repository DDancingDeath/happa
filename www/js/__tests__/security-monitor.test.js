/**
 * @fileoverview Misuse review flags (#124): refused writes, new phones and tries on
 * old bills become audit entries on the phone and flags in the owner's daily scan.
 */
import {
    SECURITY_ACTIONS, deniedWriteSource, planDeniedNote, deviceCheck, deniedClusters, DENIED_NOTE_LIMITS, DEVICE_GRACE_DAYS
} from '../utils/security-flags.js';
import { detectAnomalies } from '../utils/anomalies.js';
import { DEFAULT_THRESHOLDS } from '../utils/bill-checks.js';
import { SecurityMonitor, DENIED_DECIDE_MS } from '../services/security-monitor.js';
import { refusedForClock } from '../utils/clock-skew.js';
import { AuditService } from '../services/audit.js';
import { emit, FIRESTORE_DENIED } from '../utils/events.js';
import { AppState } from '../utils/state.js';
import * as users from '../firebase/repos/users.js';
import { setBillActions } from '../ui/bill-status.js';

const MIN = 60000;

describe('which refused calls are recorded', () => {
    test.each([
        ['dev_purchases (doc) update', 'purchases update'],
        ['withdrawals add', 'withdrawals add'],
        ['dev_settings (doc) set', 'settings set'],
        ['purchases/b1/edits (doc) set', 'purchases/b1/edits set'],
        ['batch commit', null],
        ['transaction', null],
        ['purchases get', null],
        ['dev_users listen', null],
        ['dev_counters (doc) transaction', null],
        ['dev_auditLogs add', null],
        ['telemetry (doc) set', null],
        ['dev_tipHealth (doc) set', null],
        ['stockCheckpoints (doc) set', null],
        ['dev_deviceLog (doc) set', null],
        ['', null]
    ])('%s → %s', (source, out) => {
        expect(deniedWriteSource(source)).toBe(out);
    });

    test('one entry per kind every 2 minutes and at most 5 per 10 minutes per phone', () => {
        let recent = [];
        const note = (s, at) => { const p = planDeniedNote(recent, s, at); recent = p.recent; return p.note; };
        expect(note('a set', 0)).toBe(true);
        expect(note('a set', MIN)).toBe(false);
        expect(note('a set', 2 * MIN)).toBe(true);
        ['b', 'c', 'd'].forEach((k, i) => expect(note(`${k} set`, 3 * MIN + i)).toBe(true));
        expect(note('e set', 4 * MIN)).toBe(false);
        expect(note('e set', DENIED_NOTE_LIMITS.windowMs + 1)).toBe(true);
    });

    test('the same write refused every 30 s for 10 minutes still reaches the default flag', () => {
        let recent = [];
        const logs = [];
        for (let at = 0; at <= 10 * MIN; at += 30000) {
            const p = planDeniedNote(recent, 'purchases update', at);
            recent = p.recent;
            if (p.note) logs.push({ id: `l${at}`, action: SECURITY_ACTIONS.DENIED, userId: 'u1', timestamp: at });
        }
        expect(deniedClusters(logs, DEFAULT_THRESHOLDS)).toHaveLength(1);
    });

    test('new phone: remembered with its day; flagged only once the list is ' + DEVICE_GRACE_DAYS + ' days old; the list keeps 10', () => {
        expect(deviceCheck(undefined, 'p1', '2026-11-01')).toEqual({ isNew: true, flag: false, entry: 'p1:20261101', full: false, next: ['p1:20261101'] });
        expect(deviceCheck(['p1:20261101'], 'p1', '2026-12-01').isNew).toBe(false);
        // phones everyone already uses when this starts: no flag in the first 14 days
        expect(deviceCheck(['p1:20261101'], 'p2', '2026-11-10')).toMatchObject({ isNew: true, flag: false });
        expect(deviceCheck(['p1:20261101'], 'p2', '2026-11-15')).toMatchObject({ isNew: true, flag: true, next: ['p1:20261101', 'p2:20261115'] });
        // an old-style entry without a day never starts the clock
        expect(deviceCheck(['p1'], 'p2', '2027-01-01').flag).toBe(false);
        const ten = Array.from({ length: 10 }, (_, i) => `d${i}:20260101`);
        const full = deviceCheck(ten, 'new', '2026-11-01');
        expect(full).toMatchObject({ full: true, flag: true });
        expect(full.next).toEqual([...ten.slice(1), 'new:20261101']);
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
        expect(flags[0].hi).toBe('9 मिनट में 3 बदलाव मना हुए');
        // the same entries give the same id (no second record on the next scan)
        expect(scan(logs).find(a => a.type === 'access-denied').id).toBe(flags[0].id);
    });

    test('flags name the profile behind userId, not the name the phone stored (#85)', () => {
        const logs = [denied('a1', 'u1', t0), denied('a2', 'u1', t0 + MIN), denied('a3', 'u1', t0 + 2 * MIN)];
        const flag = detectAnomalies({ auditLogs: logs, people: [{ id: 'u1', name: 'Amit', role: 'staff' }], from: t0 - 86400000, to: t0 + 86400000 })
            .find(a => a.type === 'access-denied');
        expect(flag).toMatchObject({ userId: 'u1', user: 'Amit' });
    });

    test('thresholds come from Settings › bill checks (deniedCount, deniedWindowMin)', () => {
        expect(DEFAULT_THRESHOLDS).toMatchObject({ deniedCount: 3, deniedWindowMin: 10 });
        const logs = [denied('c1', 'u3', t0), denied('c2', 'u3', t0 + 15 * MIN)];
        expect(scan(logs).some(a => a.type === 'access-denied')).toBe(false);
        expect(scan(logs, { deniedCount: 2, deniedWindowMin: 20 }).some(a => a.type === 'access-denied')).toBe(true);
    });

    test('a new phone is a low flag; tries on old bills only once 3 different bills in a day', () => {
        const day = Date.UTC(2026, 9, 21, 4, 0); // 09:30 IST
        const tryOn = (id, billId, at, userId = 'u1') => ({
            id, action: SECURITY_ACTIONS.OLD_BILL_TRY, userId, userName: 'Ram', timestamp: at,
            details: { what: 'edit', billNumber: billId.toUpperCase(), billType: 'purchase', billId }
        });
        const flags = scan([
            { id: 'n1', action: SECURITY_ACTIONS.NEW_DEVICE, userId: 'u1', userName: 'Ram', timestamp: t0, details: { device: 'abc' } },
            tryOn('o1', 'b1', day), tryOn('o2', 'b1', day + MIN), tryOn('o3', 'b2', day + 2 * MIN)
        ]);
        expect(flags.find(a => a.type === 'new-device')).toMatchObject({ severity: 'low', userId: 'u1' });
        // two different bills (one tried twice): no flag
        expect(flags.some(a => a.type === 'old-bill-edit-try')).toBe(false);
        // three different bills by one person the same IST day: one low flag
        const three = [tryOn('o1', 'b1', day), tryOn('o2', 'b2', day + MIN), tryOn('o3', 'b3', day + 2 * MIN)];
        const tries = scan(three).filter(a => a.type === 'old-bill-edit-try');
        expect(tries).toHaveLength(1);
        expect(tries[0]).toMatchObject({ severity: 'low', userId: 'u1', refId: 'o1' });
        // spread over two people or two IST days: no flag
        expect(scan([three[0], three[1], tryOn('o3', 'b3', day + 2 * MIN, 'u2')]).some(a => a.type === 'old-bill-edit-try')).toBe(false);
        expect(scan([three[0], three[1], tryOn('o3', 'b3', day + 86400000)]).some(a => a.type === 'old-bill-edit-try')).toBe(false);
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
        jest.useFakeTimers();
        note = jest.spyOn(AuditService, 'log').mockResolvedValue();
        AppState.currentUser = { uid: 'u1' };
        AppState.userRole = 'staff';
        SecurityMonitor.stop();
        SecurityMonitor.start();
    });
    afterEach(() => {
        SecurityMonitor.stop();
        jest.useRealTimers();
        jest.restoreAllMocks();
        AppState.userRole = 'staff';
    });

    test('a refused write (meter event) writes PERMISSION_DENIED once, a few seconds later; reads and the audit log itself never', () => {
        emit(FIRESTORE_DENIED, 'dev_purchases (doc) update', { code: 'permission-denied' });
        emit(FIRESTORE_DENIED, 'dev_purchases (doc) update', { code: 'permission-denied' });
        emit(FIRESTORE_DENIED, 'dev_purchases get', { code: 'permission-denied' });
        emit(FIRESTORE_DENIED, 'dev_auditLogs add', { code: 'permission-denied' });
        expect(note).not.toHaveBeenCalled();
        jest.advanceTimersByTime(DENIED_DECIDE_MS);
        expect(note).toHaveBeenCalledTimes(1);
        expect(note).toHaveBeenCalledWith('PERMISSION_DENIED', { source: 'purchases update' });
    });

    test('refusals the app expects (marked by the caller meanwhile) and rentals-only people are not recorded', async () => {
        const clockErr = { code: 'permission-denied' };
        const supersededErr = { code: 'permission-denied' };
        emit(FIRESTORE_DENIED, 'dev_expenses add', clockErr);
        emit(FIRESTORE_DENIED, 'dev_purchases (doc) set', supersededErr);
        const user = { getIdTokenResult: async () => ({ issuedAtTime: new Date(Date.now() + 30 * MIN).toUTCString() }) };
        expect(await refusedForClock(clockErr, { user })).toBe(true);
        supersededErr.aadhatExpected = true;
        jest.advanceTimersByTime(DENIED_DECIDE_MS);
        expect(note).not.toHaveBeenCalled();
        AppState.userRole = 'none';
        emit(FIRESTORE_DENIED, 'dev_items (doc) set', { code: 'permission-denied' });
        AppState.currentUser = null;
        AppState.userRole = 'staff';
        emit(FIRESTORE_DENIED, 'dev_items (doc) set', { code: 'permission-denied' });
        jest.advanceTimersByTime(DENIED_DECIDE_MS);
        expect(note).not.toHaveBeenCalled();
    });

    test('checkDevice adds a new phone to deviceLog (arrayUnion), flags it once the list is old enough, and reads once per phone', async () => {
        localStorage.removeItem('happaDeviceKnown');
        const read = jest.spyOn(users, 'readOwnDevices').mockResolvedValue(null);
        const save = jest.spyOn(users, 'addOwnDevice').mockResolvedValue();
        expect(await SecurityMonitor.checkDevice('u1')).toBe(true);
        expect(save).toHaveBeenCalledTimes(1);
        const [uid, entry, replace] = save.mock.calls[0];
        expect(uid).toBe('u1');
        expect(entry).toMatch(/^[a-z0-9]{1,20}:\d{8}$/);
        expect(replace).toBeNull();
        expect(note).not.toHaveBeenCalled();
        // known on this phone: no read at all next time
        expect(await SecurityMonitor.checkDevice('u1')).toBe(false);
        expect(read).toHaveBeenCalledTimes(1);
        localStorage.removeItem('happaDeviceKnown');
        read.mockResolvedValue([entry]);
        expect(await SecurityMonitor.checkDevice('u1')).toBe(false);
        localStorage.removeItem('happaDeviceKnown');
        read.mockResolvedValue(['otherphone1:20200101']);
        expect(await SecurityMonitor.checkDevice('u1')).toBe(true);
        expect(note).toHaveBeenCalledWith('NEW_DEVICE', expect.objectContaining({ device: expect.any(String) }));
        localStorage.removeItem('happaDeviceKnown');
        AppState.userRole = 'none';
        expect(await SecurityMonitor.checkDevice('u1')).toBe(false);
        // a refused deviceLog write records nothing and is tried again only the next day
        AppState.userRole = 'staff';
        note.mockClear();
        read.mockClear();
        save.mockRejectedValue(Object.assign(new Error('denied'), { code: 'permission-denied' }));
        await expect(SecurityMonitor.checkDevice('u1')).rejects.toThrow('denied');
        expect(note).not.toHaveBeenCalled();
        expect(await SecurityMonitor.checkDevice('u1')).toBe(false);
        expect(read).toHaveBeenCalledTimes(1);
        localStorage.removeItem('happaDeviceTried');
        // the save queued but the app closed before the server confirmed it: the next start still flags
        localStorage.removeItem('happaDeviceKnown');
        note.mockClear();
        save.mockImplementation(() => new Promise(() => {}));
        SecurityMonitor.checkDevice('u1');
        await Promise.resolve();
        await Promise.resolve();
        expect(note).not.toHaveBeenCalled();
        save.mockResolvedValue();
        read.mockResolvedValue(['otherphone1:20200101', `${entry.split(':')[0]}:20261101`]);
        expect(await SecurityMonitor.checkDevice('u1')).toBe(false);
        expect(note).toHaveBeenCalledTimes(1);
        expect(note).toHaveBeenCalledWith('NEW_DEVICE', expect.objectContaining({ device: expect.any(String) }));
        localStorage.removeItem('happaDeviceKnown');
        expect(await SecurityMonitor.checkDevice('u1')).toBe(false);
        expect(note).toHaveBeenCalledTimes(1);
    });

    test('a try on an old bill is recorded for everyone but the owner, once per bill and action, never with editDays 0', () => {
        AppState.settings = { roleAccess: {} };
        SecurityMonitor.noteOldBillTry({ id: 'b1', billNumber: 'P7' }, 'purchase', 'edit');
        SecurityMonitor.noteOldBillTry({ id: 'b1', billNumber: 'P7' }, 'purchase', 'edit');
        expect(note).toHaveBeenCalledTimes(1);
        expect(note).toHaveBeenCalledWith('OLD_BILL_EDIT_TRY', { what: 'edit', billType: 'purchase', billId: 'b1', billNumber: 'P7' });
        AppState.settings = { roleAccess: { staff: { editDays: 0 } } };
        SecurityMonitor.noteOldBillTry({ id: 'b3' }, 'purchase', 'edit');
        AppState.settings = { roleAccess: {} };
        AppState.userRole = 'owner';
        SecurityMonitor.noteOldBillTry({ id: 'b2' }, 'purchase', 'edit');
        expect(note).toHaveBeenCalledTimes(1);
    });
});

describe('Edit / Void past the edit window (#124)', () => {
    test('stay visible for those who could act inside the window, so a try is explained and recorded', () => {
        document.body.innerHTML = ['billEditBtn', 'billVoidBtn', 'billDeleteBtn', 'billReprintBtn', 'billShareBtn']
            .map(id => `<button id="${id}"></button>`).join('');
        const shown = (id) => document.getElementById(id).style.display !== 'none';
        const old = { id: 'b1', userId: 'u1', createdAt: { toMillis: () => Date.now() - 30 * 86400000 } };
        setBillActions(old, { uid: 'u1', role: 'staff', raw: {} });
        expect([shown('billEditBtn'), shown('billVoidBtn')]).toEqual([true, true]);
        setBillActions(old, { uid: 'u2', role: 'staff', raw: {} });
        expect([shown('billEditBtn'), shown('billVoidBtn')]).toEqual([false, false]);
        setBillActions(old, { uid: 'u2', role: 'manager', raw: {} });
        expect([shown('billEditBtn'), shown('billVoidBtn')]).toEqual([true, false]);
        setBillActions({ ...old, voided: true }, { uid: 'u1', role: 'staff', raw: {} });
        expect([shown('billEditBtn'), shown('billVoidBtn')]).toEqual([false, false]);
        // editDays 0 = never: nothing to try, the buttons stay hidden
        setBillActions(old, { uid: 'u1', role: 'staff', raw: { staff: { editDays: 0 } } });
        expect([shown('billEditBtn'), shown('billVoidBtn')]).toEqual([false, false]);
    });

    test('are shown locked (greyed, "🔒 Edit window closed"); inside the window they are plain', () => {
        document.body.innerHTML = ['billEditBtn', 'billVoidBtn', 'billDeleteBtn', 'billReprintBtn', 'billShareBtn']
            .map(id => `<button id="${id}"></button>`).join('');
        const edit = () => document.getElementById('billEditBtn');
        const old = { id: 'b1', userId: 'u1', createdAt: { toMillis: () => Date.now() - 30 * 86400000 } };
        setBillActions(old, { uid: 'u1', role: 'staff', raw: {} });
        expect(edit().classList.contains('bill-action-locked')).toBe(true);
        expect(edit().getAttribute('aria-disabled')).toBe('true');
        expect(edit().dataset.lockedLabel).toBe('Edit window closed');
        expect(document.getElementById('billVoidBtn').classList.contains('bill-action-locked')).toBe(true);
        // other buttons keep their own tooltips
        document.getElementById('billShareBtn').title = 'Share on WhatsApp';
        setBillActions(old, { uid: 'u1', role: 'staff', raw: {} });
        expect(document.getElementById('billShareBtn').title).toBe('Share on WhatsApp');
        setBillActions({ ...old, createdAt: { toMillis: () => Date.now() } }, { uid: 'u1', role: 'staff', raw: {} });
        expect(edit().classList.contains('bill-action-locked')).toBe(false);
        expect(edit().hasAttribute('aria-disabled')).toBe(false);
        expect(edit().style.display).toBe('');
    });
});

describe('owner daily scan reads the audit log in pages (#124)', () => {
    test('reads every entry since the scan start, page by page, up to the cap', async () => {
        const { createFakeFirestore } = await import('./__mocks__/fake-firestore.js');
        const { FirebaseService } = await import('../firebase/firestore-service.js');
        const fake = createFakeFirestore();
        const db = jest.spyOn(FirebaseService, 'db', 'get').mockReturnValue(fake.db);
        fake.seed('auditLogs', Array.from({ length: 700 }, (_, i) => ({ id: `a${String(i).padStart(4, '0')}`, action: 'X', timestamp: 1000 + i })));
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const all = await FirebaseService.loadAuditLogsSince(1000, 1000, 300);
        expect(all).toHaveLength(700);
        expect(new Set(all.map(l => l.id)).size).toBe(700);
        expect(all[0].timestamp).toBe(1699);
        const since = await FirebaseService.loadAuditLogsSince(1600, 1000, 300);
        expect(since).toHaveLength(100);
        const capped = await FirebaseService.loadAuditLogsSince(1000, 450, 300);
        expect(capped).toHaveLength(450);
        expect(capped[449].timestamp).toBe(1250);
        db.mockRestore();
    });
});
