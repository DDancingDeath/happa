/**
 * @fileoverview Oracle for Today's udhaar reminders (docs/calculations.md REM-1):
 * an independent per-party sum of dues older than 30 days, in chase-first
 * order, agrees with utils/reminders.js overdueReminder.
 */
import fc from 'fast-check';
import { overdueReminder } from '../../www/js/utils/reminders.js';
import { drillReminder, recordDrill } from '../../www/js/utils/backup-verify.js';

const TODAY = new Date(2026, 10, 15, 10, 0, 0);
const dmy = (age) => {
    const d = new Date(2026, 10, 15 - age);
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};
const bucketOf = (days) => (days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3);

describe('REM-1: who to collect from / pay', () => {
    test('parties with a due older than 30 days, oldest bucket then biggest, top 3', () => {
        fc.assert(fc.property(
            fc.array(fc.record({ name: fc.constantFrom('A', 'B', 'C', 'D', 'E'), due: fc.integer({ min: 1, max: 9999 }), age: fc.integer({ min: 0, max: 150 }) }), { maxLength: 25 }),
            (raw) => {
                const bills = raw.map((b, i) => ({ id: i, customerName: b.name, date: dmy(b.age), grandTotal: b.due, payment: { cash: 0, online: 0, due: b.due } }));
                const parties = {};
                for (const b of raw) {
                    const p = (parties[b.name] = parties[b.name] || { total: 0, oldest: 0 });
                    p.total += b.due;
                    p.oldest = Math.max(p.oldest, b.age);
                }
                const overdue = Object.entries(parties).filter(([, p]) => p.oldest > 30)
                    .sort(([, a], [, b]) => (bucketOf(b.oldest) - bucketOf(a.oldest)) || (b.total - a.total) || (b.oldest - a.oldest));
                const r = overdueReminder(bills, { today: TODAY });
                const top = overdue.slice(0, 3);
                expect(r.parties.map(p => [p.name, p.total, p.oldestDays])).toEqual(top.map(([n, p]) => [n, p.total, p.oldest]));
                expect(r.more).toBe(Math.max(0, overdue.length - 3));
                expect(r.total).toBe(overdue.reduce((s, [, p]) => s + p.total, 0));
            }
        ), { numRuns: 200, seed: 86 });
    });
});

describe('REM-3: backup check reminder (#63)', () => {
    test('due with no check, or when the last one is 30 or more whole days old; N = whole days', () => {
        fc.assert(fc.property(fc.integer({ min: 0, max: 90 * 24 * 60 }), (minutesAgo) => {
            const now = TODAY.getTime();
            const store = new Map();
            const s = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
            recordDrill(s, { uid: 'o', at: now - minutesAgo * 60000, exportedAt: null, docs: 1 });
            let days = 0;
            for (let left = minutesAgo; left >= 24 * 60; left -= 24 * 60) days++;
            const r = drillReminder(s, 'o', now);
            return r.days === days && r.due === (days >= 30) && drillReminder(s, 'other', now).due === true;
        }), { numRuns: 200 });
    });
});