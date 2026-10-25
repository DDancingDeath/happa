/**
 * @fileoverview Item rate/name history helpers (#82): diff at save time,
 * sanity-band warnings, entry building and sortable ids.
 */
import {
    snapshotItem, diffRateList, diffItemSnapshots, isRateOutOfBand, changeWarnings,
    buildHistoryEntries, historyDocId, formatHistoryValue
} from '../utils/rate-history.js';

describe('snapshotItem', () => {
    test('keeps names trimmed and only positive numeric rates', () => {
        expect(snapshotItem({ name: ' Gehu ', rates: ['40', '', 0, 45], saleRates: [50], wholesaleRates: undefined }))
            .toEqual({ name: 'Gehu', hindiName: '', purchase: [40, 45], wholesale: [], retail: [50] });
    });
});

describe('diffRateList', () => {
    test('edits in order with their list position; kept values (in order) are unchanged', () => {
        expect(diffRateList([40, 50], [40, 45])).toEqual([{ old: 50, new: 45, index: 1 }]);
        // first rate deleted, a new one added at the end
        expect(diffRateList([40, 50], [50, 45])).toEqual([{ old: 40, new: null, index: 0 }, { old: null, new: 45, index: 1 }]);
    });
    test('additions and removals', () => {
        expect(diffRateList([], [30])).toEqual([{ old: null, new: 30, index: 0 }]);
        expect(diffRateList([30, 35], [35])).toEqual([{ old: 30, new: null, index: 0 }]);
        expect(diffRateList([30], [30])).toEqual([]);
    });
    test('duplicate values: the edit is at the right position', () => {
        expect(diffRateList([30, 30], [30])).toEqual([{ old: 30, new: null, index: 1 }]);
        expect(diffRateList([10, 12], [10, 10])).toEqual([{ old: 12, new: 10, index: 1 }]);
    });
    test('applying the edits in order turns the old list into the new one', () => {
        const cases = [[[40, 50, 60], [45, 60, 70, 80]], [[10, 12, 10], [12]], [[], [1, 2]], [[5, 6, 7], [7, 6, 5]]];
        cases.forEach(([from, to]) => {
            const list = [...from];
            diffRateList(from, to).forEach(e => {
                if (e.old !== null && e.new !== null) list[e.index] = e.new;
                else if (e.new !== null) list.splice(e.index, 0, e.new);
                else list.splice(e.index, 1);
            });
            expect(list).toEqual(to);
        });
    });
});

describe('diffItemSnapshots', () => {
    test('reports name, Hindi name and each rate type', () => {
        const before = snapshotItem({ name: 'Gehu', hindiName: 'गेहूं', rates: [40], saleRates: [50], wholesaleRates: [45] });
        const after = snapshotItem({ name: 'Wheat', hindiName: 'गेहूं', rates: [42], saleRates: [50], wholesaleRates: [] });
        expect(diffItemSnapshots(before, after)).toEqual([
            { field: 'name', old: 'Gehu', new: 'Wheat' },
            { field: 'purchase', old: 40, new: 42, index: 0 },
            { field: 'wholesale', old: 45, new: null, index: 0 }
        ]);
    });
    test('new item: everything is an addition', () => {
        expect(diffItemSnapshots(snapshotItem(null), snapshotItem({ name: 'Chana', rates: [60] })))
            .toEqual([{ field: 'name', old: null, new: 'Chana' }, { field: 'purchase', old: null, new: 60, index: 0 }]);
    });
});

describe('sanity band (2×)', () => {
    test.each([
        [40, 80, false], [40, 80.01, true], [40, 20, false], [40, 19.99, true],
        [40, 45, false], [null, 400, false], [40, null, false], [0, 10, false]
    ])('%p → %p out of band: %p', (o, n, expected) => {
        expect(isRateOutOfBand(o, n)).toBe(expected);
    });

    test('changeWarnings: renames of existing items and big jumps only', () => {
        const changes = [
            { field: 'name', old: 'Gehu', new: 'Wheat' },
            { field: 'hindiName', old: null, new: 'गेहूं' },
            { field: 'retail', old: 50, new: 500 },
            { field: 'purchase', old: 40, new: 44 }
        ];
        const w = changeWarnings(changes);
        expect(w.rename).toEqual([changes[0]]);
        expect(w.outOfBand).toEqual([changes[2]]);
        expect(changeWarnings(changes, { isNew: true }).rename).toEqual([]);
    });
});

describe('buildHistoryEntries', () => {
    const meta = { itemId: 'i1', itemName: 'Gehu', by: 'Ram', byUserId: 'u1', at: 1_000_000 };
    test('one entry per change with who/when and flags', () => {
        const [a, b] = buildHistoryEntries(
            [{ field: 'purchase', old: 40, new: 100 }, { field: 'retail', old: 50, new: 52 }],
            { ...meta, lastChangeAt: { 'i1:retail': 1_000_000 - 59_000 } }
        );
        expect(a).toEqual({ itemId: 'i1', itemName: 'Gehu', field: 'purchase', old: 40, new: 100, by: 'Ram', byUserId: 'u1', at: 1_000_000, source: 'modal', flags: ['out-of-band'] });
        expect(b.flags).toEqual(['quick-repeat']);
    });
    test('rate entries keep a list position 0-20; name entries and larger positions have none', () => {
        const [a, b, c] = buildHistoryEntries([
            { field: 'purchase', old: 40, new: 41, index: 3 },
            { field: 'purchase', old: 40, new: 41, index: 21 },
            { field: 'name', old: 'A', new: 'B', index: 0 }
        ], { ...meta, source: 'import' });
        expect(a.index).toBe(3);
        expect(a.source).toBe('import');
        expect('index' in b).toBe(false);
        expect('index' in c).toBe(false);
    });
    test('a change 60 s or more after the previous one is not flagged', () => {
        const [a] = buildHistoryEntries([{ field: 'retail', old: 50, new: 52 }], { ...meta, lastChangeAt: { 'i1:retail': 1_000_000 - 60_000 } });
        expect(a.flags).toEqual([]);
    });
});

describe('historyDocId', () => {
    test('newer entries sort first within an item', () => {
        const older = historyDocId('i1', 1_700_000_000_000, 0);
        const newer = historyDocId('i1', 1_700_000_000_001, 0);
        expect(newer < older).toBe(true);
        expect(newer.startsWith('i1_')).toBe(true);
        expect(historyDocId('i1', 5, 1) > historyDocId('i1', 5, 0)).toBe(true);
    });
});

test('formatHistoryValue', () => {
    expect(formatHistoryValue('purchase', 40)).toBe('₹40');
    expect(formatHistoryValue('name', 'Gehu')).toBe('Gehu');
    expect(formatHistoryValue('retail', null)).toBe('—');
});
