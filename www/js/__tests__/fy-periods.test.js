/**
 * Financial-year periods on Money and Insights (#140, PERIOD-FY).
 */
import { periodRange, fiscalYearLabel, comparisonRanges } from '../utils/business-metrics.js';
import { getInsightsContext, setInsightsContext, resetInsightsContextForTests } from '../utils/insights-context.js';
import { MoneyManager } from '../modules/money.js';
import { InsightsManager } from '../modules/insights.js';
import { setLang } from '../i18n/index.js';

const ms = (y, m, d) => new Date(y, m, d).getTime();

describe('PERIOD-FY', () => {
    test('1 April to 31 March, this FY up to the end of today', () => {
        const may = new Date(2026, 4, 20, 15, 0);
        expect(periodRange('this-fy', may)).toMatchObject({ preset: 'this-fy', from: ms(2026, 3, 1), to: ms(2026, 4, 21), fy: 2026 });
        expect(periodRange('last-fy', may)).toMatchObject({ from: ms(2025, 3, 1), to: ms(2026, 3, 1), fy: 2025 });
        const feb = new Date(2027, 1, 10, 9, 0);
        expect(periodRange('this-fy', feb)).toMatchObject({ from: ms(2026, 3, 1), to: ms(2027, 1, 11), fy: 2026 });
        expect(periodRange('last-fy', feb)).toMatchObject({ from: ms(2025, 3, 1), to: ms(2026, 3, 1), fy: 2025 });
        const firstApril = new Date(2026, 3, 1, 0, 30);
        expect(periodRange('this-fy', firstApril)).toMatchObject({ from: ms(2026, 3, 1), fy: 2026 });
        // Whatever the owner's year setting
        expect(periodRange('this-fy', may, { yearStartMonth: 0 })).toMatchObject({ from: ms(2026, 3, 1) });
    });

    test('labels and comparisons', () => {
        expect(fiscalYearLabel(2026)).toBe('2026-27');
        expect(fiscalYearLabel(1999)).toBe('1999-00');
        const r = periodRange('last-fy', new Date(2026, 4, 20));
        expect(comparisonRanges(r).lastYear).toEqual({ from: ms(2024, 3, 1), to: ms(2025, 3, 1) });
    });
});

describe('Money and Insights use the FY presets', () => {
    beforeEach(() => resetInsightsContextForTests());
    afterEach(() => setLang('en'));

    test('the shared period keeps an FY choice; ‹ › move between this and last FY; label in the app language', () => {
        setInsightsContext({ preset: 'this-fy' });
        expect(getInsightsContext().preset).toBe('this-fy');
        const r = MoneyManager.range();
        expect(MoneyManager.periodLabel(r)).toBe(`FY ${fiscalYearLabel(r.fy)}`);
        expect(InsightsManager.periodLabel(InsightsManager.range())).toBe(`FY ${fiscalYearLabel(r.fy)}`);
        setLang('hi');
        expect(MoneyManager.periodLabel(r)).toBe(`वित्त वर्ष ${fiscalYearLabel(r.fy)}`);
        jestRender(() => MoneyManager.step(-1));
        expect(getInsightsContext().preset).toBe('last-fy');
        jestRender(() => InsightsManager.step(1));
        expect(getInsightsContext().preset).toBe('this-fy');
    });
});

/** step() re-renders the page; only the period change matters here. */
function jestRender(fn) {
    const m = jest.spyOn(MoneyManager, 'render').mockImplementation(() => {});
    const i = jest.spyOn(InsightsManager, 'render').mockImplementation(() => {});
    try { fn(); } finally { m.mockRestore(); i.mockRestore(); }
}
