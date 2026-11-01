/**
 * @fileoverview Oracle for Today's udhaar reminders (docs/calculations.md REM-1):
 * an independent per-party sum of dues older than 30 days, in chase-first
 * order, agrees with utils/reminders.js overdueReminder.
 */
import fc from 'fast-check';
import { overdueReminder } from '../../www/js/utils/reminders.js';
import { groupReminders } from '../../www/js/utils/manual-reminders.js';

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

describe('REM-3: manual reminders on Today', () => {
    test('due = date today or earlier (most late first), next 7 days, later counted', () => {
        const iso = (n) => new Date(Date.UTC(2026, 10, 15 + n)).toISOString().slice(0, 10);
        fc.assert(fc.property(fc.array(fc.integer({ min: -40, max: 40 }), { maxLength: 30 }), (offsets) => {
            const list = offsets.map((n, i) => ({ id: String(i), title: `t${String(i).padStart(2, '0')}`, dueDate: iso(n) }));
            const g = groupReminders(list, iso(0));
            const byDays = (a, b) => a.n - b.n || a.title.localeCompare(b.title);
            const rows = offsets.map((n, i) => ({ id: String(i), n, title: list[i].title }));
            expect(g.due.map(r => [r.id, r.days])).toEqual(rows.filter(r => r.n <= 0).sort(byDays).map(r => [r.id, r.n]));
            expect(g.soon.map(r => [r.id, r.days])).toEqual(rows.filter(r => r.n > 0 && r.n <= 7).sort(byDays).map(r => [r.id, r.n]));
            expect(g.later).toBe(rows.filter(r => r.n > 7).length);
        }), { numRuns: 200, seed: 86 });
    });
});