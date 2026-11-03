// Multi-year benchmark trend and budget warnings (#59, tools/bench/record.js).
const { COLUMNS, trendRow, appendRow, overBudget, summary } = require('../../tools/bench/record.js');

const RESULT = {
    at: '2026-11-02T22:10:00.000Z', dataset: { docs: 9876 }, firstSignInMs: 9000, appShownMs: 2500, todayOpenMs: 600,
    firstTodayMs: 3100, startupReads: 140, historyLoadMs: 21000, historyReads: 9500, bills: 9100, samples: []
};

test('a row per result, in the header\'s order; the header only once', () => {
    const row = trendRow(RESULT, 'abcdef1234567890');
    expect(row).toBe('2026-11-02T22:10:00.000Z,abcdef123456,9876,9000,2500,600,3100,140,21000,9500,9100');
    const first = appendRow('', row);
    expect(first.split('\n')[0]).toBe(COLUMNS.join(','));
    const second = appendRow(first, trendRow({ ...RESULT, historyLoadMs: null }, 'x'));
    expect(second.trim().split('\n')).toHaveLength(3);
    expect(second.trim().split('\n')[2].split(',')[8]).toBe('');
});

test('over budget only for figures above it; unknown or missing ones are ignored', () => {
    expect(overBudget(RESULT, { _comment: 'x', firstTodayMs: 8000, historyLoadMs: 20000, missingMs: 1 }))
        .toEqual([{ name: 'historyLoadMs', value: 21000, budget: 20000 }]);
    expect(overBudget({ ...RESULT, historyLoadMs: null }, { historyLoadMs: 20000 })).toEqual([]);
});

test('the summary warns and shows the latest rows', () => {
    let trend = '';
    for (let i = 0; i < 12; i++) trend = appendRow(trend, trendRow({ ...RESULT, at: `day${i}` }, 's'));
    const text = summary(trend, overBudget(RESULT, { historyLoadMs: 20000 }));
    expect(text).toContain('⚠ historyLoadMs 21000 ms is over its budget of 20000 ms');
    expect(summary(trend, overBudget({ ...RESULT, startupReads: 2600 }, { startupReads: 2500 })))
        .toContain('⚠ startupReads 2600 is over its budget of 2500');
    expect(text).toContain('day11');
    expect(text).not.toContain('| day1 |');
    expect(summary(trend, [])).toContain('All figures within budget.');
});
