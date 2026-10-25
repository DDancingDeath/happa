import { canChangeExpense, canDeleteItem, isPermissionDenied, MEMBER_EDIT_WINDOW_MS } from '../utils/record-permissions.js';
import { buildTelemetryDoc, mergeTelemetryReports } from '../services/telemetry.js';

const NOW = 1_800_000_000_000;

describe('canChangeExpense (mirrors firestore.rules, #18)', () => {
    const own = { userId: 'u1', timestamp: NOW - 60 * 60 * 1000 };

    test('owner and manager may change any expense, however old', () => {
        const old = { userId: 'u2', timestamp: NOW - 90 * MEMBER_EDIT_WINDOW_MS };
        expect(canChangeExpense(old, { uid: 'o', role: 'owner', now: NOW })).toBe(true);
        expect(canChangeExpense(old, { uid: 'm', role: 'manager', now: NOW })).toBe(true);
    });

    test('a member may change only their own expense within 24 hours', () => {
        expect(canChangeExpense(own, { uid: 'u1', role: 'staff', now: NOW })).toBe(true);
        expect(canChangeExpense(own, { uid: 'u2', role: 'staff', now: NOW })).toBe(false);
        expect(canChangeExpense({ ...own, timestamp: NOW - MEMBER_EDIT_WINDOW_MS - 1 }, { uid: 'u1', role: 'staff', now: NOW })).toBe(false);
        expect(canChangeExpense({ ...own, timestamp: NOW + MEMBER_EDIT_WINDOW_MS + 1 }, { uid: 'u1', role: 'staff', now: NOW })).toBe(false);
    });

    test('falls back to createdBy; legacy expenses without a numeric timestamp are locked for members', () => {
        expect(canChangeExpense({ createdBy: 'u1', timestamp: NOW }, { uid: 'u1', role: 'staff', now: NOW })).toBe(true);
        expect(canChangeExpense({ userId: 'u1', date: '01/10/2026' }, { uid: 'u1', role: 'staff', now: NOW })).toBe(false);
        expect(canChangeExpense({ userId: 'u1', timestamp: String(NOW) }, { uid: 'u1', role: 'staff', now: NOW })).toBe(false);
        expect(canChangeExpense(own, { role: 'staff', now: NOW })).toBe(false);
    });
});

test('only the owner may delete items', () => {
    expect(canDeleteItem('owner')).toBe(true);
    expect(canDeleteItem('manager')).toBe(false);
    expect(canDeleteItem('staff')).toBe(false);
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
            type: 'uncaught', message: { not: 'a string' }, stack: 'x'.repeat(5000), context: { top: [1, 2] },
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
