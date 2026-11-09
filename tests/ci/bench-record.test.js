// Multi-year benchmark trend, budget warnings (#59) and the hard-limit gate (#120), tools/bench/record.js.
const fs = require('fs');
const { COLUMNS, trendRow, appendRow, overBudget, summary, regressions, main } = require('../../tools/bench/record.js');
const BUDGETS = require('../../tools/bench/budgets.json');

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

// The nightly trend from 2 to 9 Nov 2026 (bench-trend branch): firstTodayMs 4.0-8.2 s and
// historyLoadMs 5.6-14.0 s on the same code. A gate at 1.25x the median would have failed
// on 9 Nov (historyLoadMs 1.34x, then 1.26x).
const REAL = `at,sha,docs,firstSignInMs,appShownMs,todayOpenMs,firstTodayMs,startupReads,historyLoadMs,historyReads,bills
d1,a,8256,6528,4485,40,4525,2936,5582,5833,5943
d2,a,8303,8004,5928,56,5982,3017,10466,5831,6026
d3,a,8303,6592,5851,64,5906,1607,8298,7241,6026
d4,a,8049,10631,8160,59,8219,1542,13963,6981,5794
d5,a,8258,6714,6044,50,6094,1683,9716,7186,5940
d6,a,8283,4340,3995,44,4033,1604,7045,7213,5987
d7,a,8110,4609,5186,52,5240,1546,9392,7046,5864
d8,a,8288,10751,7895,68,7969,1655,12612,7221,6015
d9,a,8266,7970,5771,50,5821,1647,12246,7215,5967
`;
const prefix = (n) => `${REAL.trim().split('\n').slice(0, n + 1).join('\n')}\n`;
const withRow = (trend, over) => appendRow(trend, trendRow({ ...RESULT, firstTodayMs: 5900, historyLoadMs: 9700, startupReads: 1650, ...over }, 's'));

test('the real noisy trend never fails the gate', () => {
    for (let n = 1; n <= 9; n++) expect(regressions(prefix(n), BUDGETS, BUDGETS._gate).failed).toEqual([]);
    expect(regressions(prefix(9), BUDGETS, { ...BUDGETS._gate, trendRatio: 1.25 }).failed.map(b => b.name)).toEqual(['historyLoadMs']);
});

test('one slow run warns; two in a row over 1.5x the median fail', () => {
    const once = regressions(withRow(REAL, { firstTodayMs: 9500 }), BUDGETS, BUDGETS._gate);
    expect(once.slow).toEqual([expect.objectContaining({ name: 'firstTodayMs', value: 9500, limit: 8859 })]);
    expect(once.failed).toEqual([]);
    const twice = regressions(withRow(withRow(REAL, { firstTodayMs: 9500 }), { firstTodayMs: 9400 }), BUDGETS, BUDGETS._gate);
    expect(twice.failed.map(b => b.name)).toEqual(['firstTodayMs']);
    expect(summary(withRow(REAL, {}), [], 10, twice)).toContain('❌ firstTodayMs 9400 ms is over its hard limit');
    // slow, then back to normal: no failure
    expect(regressions(withRow(withRow(REAL, { firstTodayMs: 9500 }), {}), BUDGETS, BUDGETS._gate).failed).toEqual([]);
});

test('with too short a trend only 1.5x the budget counts', () => {
    const short = withRow(withRow('', { startupReads: 3800 }), { startupReads: 3900, firstTodayMs: 12500 });
    const res = regressions(short, BUDGETS, BUDGETS._gate);
    expect(res.failed.map(b => b.name)).toEqual(['startupReads']);
    expect(res.slow.map(b => b.name)).toEqual(['firstTodayMs', 'startupReads']);
});

describe('main', () => {
    const files = {};
    beforeEach(() => {
        for (const k of Object.keys(files)) delete files[k];
        jest.spyOn(fs, 'existsSync').mockImplementation((p) => p in files);
        jest.spyOn(fs, 'readFileSync').mockImplementation((p) => files[p]);
        jest.spyOn(fs, 'writeFileSync').mockImplementation((p, d) => { files[p] = d; });
        jest.spyOn(fs, 'appendFileSync').mockImplementation((p, d) => { files[p] = (files[p] || '') + d; });
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());
    const run = (extra = []) => {
        files['r.json'] = JSON.stringify({ ...RESULT, firstTodayMs: 5900, historyLoadMs: 9700, startupReads: 1650 });
        files['b.json'] = JSON.stringify(BUDGETS);
        files['t.csv'] = REAL;
        main(['--result', 'r.json', '--trend', 't.csv', '--budgets', 'b.json', ...extra], { GITHUB_OUTPUT: 'out' });
        return files.out;
    };

    test('a normal run passes and records the row', () => {
        expect(run()).toBe('regressed=false\n');
        expect(files['t.csv'].trim().split('\n')).toHaveLength(11);
    });

    test('--simulate-slowdown 2 slows this run and the last row, and fails', () => {
        expect(run(['--simulate-slowdown', '2'])).toBe('regressed=true\n');
        const rows = files['t.csv'].trim().split('\n');
        expect(rows[9].split(',')[6]).toBe('11642');
        expect(rows[10].split(',')[6]).toBe('11800');
        expect(rows[10].split(',')[7]).toBe('1650');
    });
});
