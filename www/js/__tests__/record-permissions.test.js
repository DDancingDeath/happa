<<<<<<< HEAD
import { canDeleteItem, isPermissionDenied } from '../utils/record-permissions.js';
import { canVoidExpenseWith } from '../utils/role-access.js';
=======
import { canChangeExpense, canArchiveItem, isPermissionDenied, MEMBER_EDIT_WINDOW_MS } from '../utils/record-permissions.js';
>>>>>>> origin/main
import { buildTelemetryDoc, mergeTelemetryReports } from '../services/telemetry.js';

const NOW = 1_800_000_000_000;

describe('canVoidExpenseWith (mirrors firestore.rules expenseVoidOk, #99)', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const own = { userId: 'u1', timestamp: NOW - 60 * 60 * 1000 };

    test('owner any expense, however old; never one already voided', () => {
        expect(canVoidExpenseWith({ userId: 'u2', timestamp: NOW - 400 * DAY }, { uid: 'o', role: 'owner', now: NOW })).toBe(true);
        expect(canVoidExpenseWith({ ...own, voided: true }, { uid: 'o', role: 'owner', now: NOW })).toBe(false);
    });

    test('manager any expense, member only their own, inside the role edit window (default 2 days)', () => {
        const others = { userId: 'u2', timestamp: NOW - DAY };
        expect(canVoidExpenseWith(others, { uid: 'm', role: 'manager', now: NOW })).toBe(true);
        expect(canVoidExpenseWith(others, { uid: 'u1', role: 'staff', now: NOW })).toBe(false);
        expect(canVoidExpenseWith(own, { uid: 'u1', role: 'staff', now: NOW })).toBe(true);
        expect(canVoidExpenseWith({ ...own, timestamp: NOW - 2 * DAY - 1 }, { uid: 'u1', role: 'staff', now: NOW })).toBe(false);
        expect(canVoidExpenseWith({ ...others, timestamp: NOW - 2 * DAY - 1 }, { uid: 'm', role: 'manager', now: NOW })).toBe(false);
        expect(canVoidExpenseWith(own, { uid: 'u1', role: 'staff', now: NOW, raw: { staff: { editDays: 0 } } })).toBe(false);
    });

    test('falls back to createdBy; no numeric timestamp = outside the window', () => {
        expect(canVoidExpenseWith({ createdBy: 'u1', timestamp: NOW }, { uid: 'u1', role: 'staff', now: NOW })).toBe(true);
        expect(canVoidExpenseWith({ userId: 'u1', date: '01/10/2026' }, { uid: 'u1', role: 'staff', now: NOW })).toBe(false);
        expect(canVoidExpenseWith(own, { role: 'staff', now: NOW })).toBe(false);
    });
});

test('owners and managers archive items, members do not', () => {
    expect(canArchiveItem('owner')).toBe(true);
    expect(canArchiveItem('manager')).toBe(true);
    expect(canArchiveItem('staff')).toBe(false);
});

test('isPermissionDenied recognises rules refusals only', () => {
    expect(isPermissionDenied({ code: 'permission-denied' })).toBe(true);
    expect(isPermissionDenied(new Error('Missing or insufficient permissions.'))).toBe(true);
    expect(isPermissionDenied({ code: 'unavailable' })).toBe(false);
    expect(isPermissionDenied(undefined)).toBe(false);
});

describe('telemetry reports are create-only documents (#122)', () => {
    test('buildTelemetryDoc keeps only allowed fields, clips text and uses the caller uid', () => {
        const doc = buildTelemetryDoc({
            type: 'uncaught', message: { not: 'a string' }, stack: 'at x '.repeat(1000), context: { top: [1, 2] },
            fingerprint: 'abc', count: 250, occurrences: Array.from({ length: 12 }, (_, i) => ({ timestamp: i })),
            timestamp: 5, lastSeen: 9, userId: 'anonymous', line: 3, extraField: 'dropped', source: undefined
        }, 'uid1');
        expect(doc.userId).toBe('uid1');
        expect(doc.message).toBe('[object Object]');
        expect(doc.stack).toHaveLength(4000);
        expect(doc.context).toBe('{"top":[1,2]}');
        expect(doc.count).toBe(100);
        expect(doc.occurrences).toHaveLength(10);
        expect(doc.firstSeen).toBe(5);
        expect(doc).not.toHaveProperty('extraField');
        expect(doc).not.toHaveProperty('source');
    });

    test('mergeTelemetryReports adds up reports of one error and keeps legacy docs apart', () => {
        const merged = mergeTelemetryReports([
            { id: 'a-2', fingerprint: 'a', count: 2, firstSeen: 20, lastSeen: 30, message: 'new', occurrences: [{ timestamp: 30 }] },
            { id: 'a-1', fingerprint: 'a', count: 3, firstSeen: 5, lastSeen: 10, message: 'old', occurrences: [{ timestamp: 10 }] },
            { id: 'legacyFp', count: 7, lastSeen: 20, message: 'legacy' }
        ]);
        expect(merged.map(e => e.id)).toEqual(['a', 'legacyFp']);
        expect(merged[0]).toMatchObject({ count: 5, firstSeen: 5, lastSeen: 30, message: 'new', docIds: ['a-2', 'a-1'] });
        expect(merged[0].occurrences.map(o => o.timestamp)).toEqual([10, 30]);
        expect(merged[1]).toMatchObject({ count: 7, docIds: ['legacyFp'] });
    });
});
