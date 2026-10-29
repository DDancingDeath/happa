/**
 * @fileoverview tools/audit/causes.js: "negative stock" is given as a cause only
 * for the periods where the audit's evidence confirms it, never by spec ID alone.
 */
import { CAUSES, causeFor } from '../../tools/audit/causes.js';
import { negativeDips } from '../../tools/audit/audit-lib.js';

const group = (spec, periods) => ({ scope: 'real', spec, page: 'Money (layer)', rows: periods.map(period => ({ spec, period })) });

describe('causeFor', () => {
    const evidence = { negativeStock: (row) => row.period === '2026-09' };

    test('negative stock: only when every period of the group really has it', () => {
        expect(causeFor(group('M2_cogs', ['2026-09']), CAUSES, evidence).known).toBe(CAUSES.M2_cogs.known);
        expect(causeFor(group('M6_profit', ['2026-08']), CAUSES, evidence)).toBeNull();
        const part = causeFor(group('M2_cogs', ['2026-09', '2026-08']), CAUSES, evidence);
        expect(part.known).toMatch(/^partly .*1 new$/);
        expect(part.cause).toMatch(/applies to 1 of 2/);
    });

    test('without evidence a checked cause is not claimed; other causes still match by key', () => {
        expect(causeFor(group('M2_cogs', ['2026-09']), CAUSES)).toBeNull();
        expect(causeFor(group('A6_receivable', ['2026-09']), CAUSES)).toBe(CAUSES.A6_receivable);
    });
});

test('negativeDips records when each item first went below zero', () => {
    const items = [{ id: 'i1', name: 'Gehu' }, { id: 'i2', name: 'Chana' }];
    const bill = (date, id, qty) => ({ date, timestamp: Date.parse(date), items: [{ itemId: id, qty }] });
    const d = negativeDips({
        items,
        purchases: [bill('2026-09-05T10:00:00Z', 'i1', 5), bill('2026-09-01T10:00:00Z', 'i2', 10)],
        retailSales: [bill('2026-09-03T10:00:00Z', 'i1', 2), bill('2026-09-06T10:00:00Z', 'i2', 3)],
        wholesaleSales: [],
        stockAdjustments: []
    });
    expect(d.items).toEqual(['i1']);
    expect(d.firstDip).toEqual({ i1: Date.parse('2026-09-03T10:00:00Z') });
});
