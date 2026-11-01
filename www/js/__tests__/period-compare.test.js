/**
 * Period A vs period B (#140): chosen days, the shared context's period B,
 * saved ranges on this phone, the compare bar and Money's period summary.
 */
import { periodRange, customRangePreset } from '../utils/business-metrics.js';
import { getInsightsContext, setInsightsContext, resetInsightsContextForTests } from '../utils/insights-context.js';
import { readSavedRanges, addSavedRange, removeSavedRange, MAX_SAVED_RANGES, SAVED_RANGES_KEY } from '../utils/saved-ranges.js';
import {
    compareBarHtml, compareTableHtml, choosePreset, chooseCompare, presetSelectValue, summaryLines, summaryText,
    periodText, resetPeriodCompareForTests
} from '../ui/period-compare.js';
import { periodCompare } from '../utils/business-metrics.js';

const memStore = () => {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
};

beforeEach(() => {
    resetInsightsContextForTests();
    resetPeriodCompareForTests();
    localStorage.clear();
});

describe('PERIOD-CUSTOM', () => {
    test('invalid days are refused', () => {
        expect(customRangePreset('2026-02-30', '2026-03-01')).toBeNull();
        expect(customRangePreset('', '2026-03-01')).toBeNull();
        expect(customRangePreset('2026-03-05', '2026-03-01')).toBe('range:2026-03-01:2026-03-05');
        const now = new Date(2026, 10, 1, 12);
        expect(customRangePreset('2026-11-02', '2026-11-05', now)).toBeNull();
        expect(customRangePreset('2026-10-30', '2026-11-05', now)).toBe('range:2026-10-30:2026-11-05');
    });
    test('label: both days, one year when they share it', () => {
        const now = new Date(2026, 10, 1, 12);
        expect(periodText(periodRange('range:2026-10-05:2026-10-20', now), 'x', 'en')).toBe('5 Oct – 20 Oct 2026');
        expect(periodText(periodRange('range:2025-12-30:2026-01-02', now), 'x', 'en')).toBe('30 Dec 2025 – 2 Jan 2026');
        expect(periodText(periodRange('range:2026-10-05:2026-10-05', now), 'x', 'en')).toBe('5 Oct 2026');
    });
});

describe('period B in the shared context', () => {
    test('kept for the session; invalid values switch it off', () => {
        setInsightsContext({ compare: 'last-year' });
        expect(getInsightsContext().compare).toBe('last-year');
        setInsightsContext({ compare: 'nonsense' });
        expect(getInsightsContext().compare).toBeNull();
        setInsightsContext({ preset: 'range:2026-10-01:2026-10-10', compare: 'range:2025-10-01:2025-10-10' });
        resetInsightsContextForTests.call(null);
    });
    test('"Choose dates…" shows the date boxes before changing anything', () => {
        choosePreset('custom');
        expect(getInsightsContext().preset).toBe('this-month');
        expect(presetSelectValue('this-month')).toBe('custom');
        document.body.innerHTML = `<div id="b">${compareBarHtml('money')}</div>`;
        expect(document.getElementById('moneyCmpAFrom')).not.toBeNull();
        chooseCompare('custom');
        document.body.innerHTML = `<div id="b">${compareBarHtml('money')}</div>`;
        expect(document.getElementById('moneyCmpBFrom')).not.toBeNull();
        chooseCompare('last-month');
        expect(getInsightsContext().compare).toBe('last-month');
    });
});

describe('saved ranges (this phone only)', () => {
    test('newest first, same pair once, at most 10, bad entries dropped', () => {
        const s = memStore();
        addSavedRange(s, 'this-month', 'last-year');
        addSavedRange(s, 'this-fy', null);
        addSavedRange(s, 'this-month', 'last-year');
        expect(readSavedRanges(s).map(x => x.id)).toEqual(['this-month|last-year', 'this-fy|']);
        for (let i = 1; i <= 12; i++) addSavedRange(s, `month:2025-${String(i).padStart(2, '0')}`, null);
        expect(readSavedRanges(s)).toHaveLength(MAX_SAVED_RANGES);
        expect(addSavedRange(s, 'bad').ok).toBe(false);
        s.setItem(SAVED_RANGES_KEY, JSON.stringify([{ a: 'x' }, { a: 'last-30', b: 'last-month' }]));
        expect(readSavedRanges(s).map(x => x.id)).toEqual(['last-30|last-month']);
        expect(removeSavedRange(s, 'last-30|last-month')).toEqual([]);
    });
    test('storage full: not saved, says so', () => {
        const s = { getItem: () => null, setItem: () => { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } };
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(addSavedRange(s, 'this-month', null)).toMatchObject({ ok: false, full: true });
    });
    test('the bar lists them and offers Remove for the pair shown', () => {
        addSavedRange(localStorage, 'this-month', 'last-month');
        setInsightsContext({ preset: 'this-month', compare: 'last-month' });
        const html = compareBarHtml('insights');
        expect(html).toContain('removeRange()');
        expect(html).toContain('value="this-month|last-month"');
    });
});

describe('CMP-AB card and summary', () => {
    const rows = periodCompare({ M1: 1500, M16: 900, M4: 100, M6: 300, M14: 200 }, { M1: 1000, M16: 900, M4: 0, M6: null, M14: 250 });
    test('table: A, B, ₹ change and %; "—" when not known', () => {
        document.body.innerHTML = compareTableHtml(rows, { a: 'Oct 2026', b: 'Sep 2026' });
        const row = (id) => [...document.querySelectorAll(`[data-cmp-row="${id}"] td`)].map(td => td.textContent);
        expect(row('M1')).toEqual(['Sales', '₹1,500', '₹1,000', '+₹500', '▲ 50%']);
        expect(row('M4')).toEqual(['Business expenses', '₹100', '₹0', '+₹100', '—']);
        expect(row('M6')).toEqual(['Profit', '₹300', '—', '—', '—']);
        expect(row('M14')[3]).toBe('-₹50');
    });
    test('WhatsApp text: A, then B and % per figure', () => {
        const text = summaryText(summaryLines(rows.slice(0, 1), { a: 'Oct 2026', b: 'Sep 2026', shop: 'Shop' }));
        expect(text).toBe('*Shop*\n*Summary: Oct 2026*\n*vs Sep 2026*\nSales: ₹1,500\n  Sep 2026: ₹1,000  ▲ 50%');
    });
});
