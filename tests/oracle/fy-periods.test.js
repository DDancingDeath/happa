/**
 * @fileoverview Oracle for the financial-year periods (docs/calculations.md
 * PERIOD-FY): for any day, an independent April–March year agrees with
 * periodRange('this-fy' | 'last-fy').
 */
import fc from 'fast-check';
import { periodRange } from '../../www/js/utils/business-metrics.js';

describe('PERIOD-FY: April to March', () => {
    test('this FY starts on the last 1 April on or before today; last FY is the year before it', () => {
        fc.assert(fc.property(fc.integer({ min: 2020, max: 2035 }), fc.integer({ min: 0, max: 11 }), fc.integer({ min: 1, max: 28 }), (y, m, d) => {
            const now = new Date(y, m, d, 12, 0);
            const startYear = m >= 3 ? y : y - 1;
            const thisFy = periodRange('this-fy', now);
            const lastFy = periodRange('last-fy', now);
            expect(thisFy.from).toBe(new Date(startYear, 3, 1).getTime());
            expect(thisFy.to).toBe(new Date(y, m, d + 1).getTime());
            expect(lastFy.from).toBe(new Date(startYear - 1, 3, 1).getTime());
            expect(lastFy.to).toBe(new Date(startYear, 3, 1).getTime());
            expect([thisFy.fy, lastFy.fy]).toEqual([startYear, startYear - 1]);
        }), { numRuns: 300, seed: 140 });
    });
});
