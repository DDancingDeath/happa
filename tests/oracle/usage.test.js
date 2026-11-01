/**
 * @fileoverview Oracle for Settings › Usage (docs/calculations.md USE-1): an
 * independent day-by-day sum of generated counters agrees with topUsage.
 */
import fc from 'fast-check';
import { topUsage, USAGE_EVENTS } from '../../www/js/utils/usage-stats.js';

const day = (n) => `2026-10-${String(n).padStart(2, '0')}`;

describe('USE-1: uses per feature in a range', () => {
    test('equals the sum of the daily counts in the range, most used first', () => {
        const event = fc.constantFrom(...USAGE_EVENTS, 'page.billing', 'page.day');
        fc.assert(fc.property(
            fc.array(fc.record({ d: fc.integer({ min: 1, max: 31 }), event, count: fc.integer({ min: 1, max: 50 }) }), { maxLength: 60 }),
            fc.integer({ min: 1, max: 31 }), fc.integer({ min: 1, max: 31 }),
            (raw, a, b) => {
                const [from, to] = a <= b ? [a, b] : [b, a];
                const rows = raw.map(r => ({ day: day(r.d), event: r.event, count: r.count }));
                const sums = {};
                for (const r of raw) {
                    if (r.d >= from && r.d <= to) sums[r.event] = (sums[r.event] || 0) + r.count;
                }
                const expected = Object.keys(sums).sort((x, y) => sums[y] - sums[x] || (x < y ? -1 : 1))
                    .slice(0, 10).map(e => ({ event: e, count: sums[e] }));
                expect(topUsage(rows, { fromDay: day(from), toDay: day(to) })).toEqual(expected);
            }
        ), { numRuns: 200, seed: 136 });
    });
});
