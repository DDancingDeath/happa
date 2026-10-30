/**
 * @jest-environment node
 */
const { summarize } = require('../../tools/ci/e2e-summary.js');
const { overBudget, limitFor } = require('../e2e/support/read-budget.js');

const BASE = { tolerance: 0.25, minSlack: 2, hardCap: 300, reads: { owner: { startup: 20, money: 4, day: 0 } } };

const report = (tests) => ({
    stats: { duration: 125000 },
    suites: [{ title: 'tabs-smoke.spec.js', specs: [{ title: 'owner (en) opens every page', tests }] }]
});

describe('read budget', () => {
    test('a page may read up to its baseline + 25%, never above the hard cap', () => {
        expect(limitFor(20, BASE)).toBe(25);
        expect(limitFor(0, BASE)).toBe(2);
        expect(limitFor(4, BASE)).toBe(6);
        expect(limitFor(280, BASE)).toBe(300);
        expect(overBudget('owner', { startup: 25, money: 6, day: 2 }, BASE)).toEqual([]);
        expect(overBudget('owner', { startup: 26, day: 3 }, BASE)).toEqual([
            'startup: 26 reads, baseline 20, limit 25',
            'day: 3 reads, baseline 0, limit 2'
        ]);
    });

    test('a page without a baseline or over the hard cap fails', () => {
        expect(overBudget('owner', { insights: 3 }, BASE)).toEqual([expect.stringMatching(/^insights: 3 reads and no baseline/)]);
        expect(overBudget('manager', { startup: 301 }, BASE)).toEqual(['startup: 301 reads, over the hard cap of 300']);
    });
});

describe('E2E job summary', () => {
    test('lists flaky tests with their first error and flags pages over their read budget', () => {
        const md = summarize(report([
            {
                projectName: 'phone', status: 'flaky',
                results: [{ status: 'failed', error: { message: '\u001b[31mError: timed out\u001b[39m\n  at x' } }, { status: 'passed' }],
                annotations: [{ type: 'reads', description: JSON.stringify({ role: 'owner', lang: 'en', reads: { startup: 30, money: 4 } }) }]
            },
            { projectName: 'desktop', status: 'expected', results: [{ status: 'passed' }], annotations: [] }
        ]), BASE);
        expect(md).toContain('**1 passed** · 1 flaky · 0 failed · 0 skipped · test time 2m 5s');
        expect(md).toContain('- `[phone]` tabs-smoke.spec.js › owner (en) opens every page — Error: timed out');
        expect(md).toContain('| startup | 30 / 20 ⚠️ |');
        expect(md).toContain('| money | 4 / 4 |');
        expect(md).not.toContain('### Failed');
    });
});
