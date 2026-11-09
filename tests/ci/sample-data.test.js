/**
 * @jest-environment node
 */
const { assertDevProject, sampleDocs } = require('../../tools/dev/sample-data');

describe('dev sample data (#72)', () => {
    test('refuses every project that is not *-dev', () => {
        expect(assertDevProject('bahi-happa-dev')).toBe('bahi-happa-dev');
        for (const id of ['bahi-happa', 'happa-bfc07', 'aadhat-management', 'bahi-dev-happa', '', undefined]) {
            expect(() => assertDevProject(id)).toThrow(/only a \*-dev project/);
        }
    });

    test('bills add up and use fixed sample_ ids, optionally in dev_ collections', () => {
        const docs = sampleDocs(Date.UTC(2026, 10, 9));
        expect(docs.every(([, id]) => id.startsWith('sample_'))).toBe(true);
        for (const [, , d] of docs.filter(([c]) => c !== 'items')) {
            expect(d.payment.cash + d.payment.due).toBe(d.grandTotal);
            expect(d.items.reduce((s, i) => s + i.total, 0)).toBe(d.billTotal);
        }
        expect(sampleDocs(0, 'dev_').map(([c]) => c)).toContain('dev_retailSales');
    });
});
