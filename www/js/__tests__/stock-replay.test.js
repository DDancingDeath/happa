/**
 * stock-replay.js, function by function, on hand-worked numbers (#160: the
 * mutation score of the stock replay was 62.5%; these pin each branch).
 */
import {
    purchaseLineValue, eventTime, createItemKeyResolver, itemsSignature, collectEvents, cloneState, replayEvents,
    replayWithValues, stateValue, finalizeStock, computeStockFrom, buildCheckpointState, resolutionsStillValid,
    serializeState, deserializeState, stockFingerprint, changeInvalidatesCheckpoint
} from '../utils/stock-replay.js';

const ITEMS = [{ id: 'rice', name: 'Rice', hindiName: 'चावल' }, { id: 'dal', name: 'Dal' }, { id: 'rice2', name: 'rice' }];
const key = createItemKeyResolver(ITEMS);
const ev = (kind, t, item, extra = {}) => ({ t, kind, item, ...extra });
const adj = (t, adjustType, quantity, rate, itemId = 'rice') => ({ t, kind: 'adjustment', adj: { itemId, adjustType, quantity, rate } });
const run = (events, state = {}) => replayEvents(state, events, key);

describe('purchaseLineValue (AVG-COST)', () => {
    test('the saved line amount is the value; the rate is value ÷ kg', () => {
        expect(purchaseLineValue({ qty: 12.4, rate: 33.5, total: 415 })).toEqual({ qty: 12.4, value: 415, rate: 415 / 12.4 });
        expect(purchaseLineValue({ quantity: '4', rate: '10', amount: 38 })).toEqual({ qty: 4, value: 38, rate: 9.5 });
    });
    test('no saved amount, or no kg: kg × rate at the line rate', () => {
        expect(purchaseLineValue({ qty: 2, rate: 3 })).toEqual({ qty: 2, value: 6, rate: 3 });
        expect(purchaseLineValue({ qty: 0, rate: 5, total: 10 })).toEqual({ qty: 0, value: 0, rate: 5 });
        expect(purchaseLineValue({ qty: -2, rate: 5, total: 10 })).toEqual({ qty: -2, value: -10, rate: 5 });
        expect(purchaseLineValue(null)).toEqual({ qty: 0, value: 0, rate: 0 });
    });
});

describe('eventTime', () => {
    test('numeric timestamp, then a Firestore timestamp, then the date; unknown sorts last', () => {
        expect(eventTime({ timestamp: 0, date: '2026-10-01' })).toBe(0);
        expect(eventTime({ timestamp: { toMillis: () => 1234 } })).toBe(1234);
        expect(eventTime({ timestamp: { seconds: 5 }, date: '21/10/2026' })).toBe(new Date(2026, 9, 21).getTime());
        expect(eventTime({ date: 'not a date' })).toBe(Number.MAX_SAFE_INTEGER);
        expect(eventTime(null)).toBe(Number.MAX_SAFE_INTEGER);
    });
});

describe('createItemKeyResolver and itemsSignature', () => {
    test('catalogue id first, then name or Hindi name (first entry wins), then the name itself', () => {
        expect(key({ itemId: 'dal', name: 'whatever' })).toBe('dal');
        expect(key({ itemId: 'gone', name: ' RICE ' })).toBe('rice');
        expect(key({ name: 'चावल' })).toBe('rice');
        expect(key({ name: 'Wheat' })).toBe('wheat');
        expect(key({ itemId: 'gone' })).toBe('gone');
        expect(key({})).toBe('__unknown__');
    });
    test('the signature changes with ids and names (not their case) and records the count', () => {
        const s = itemsSignature(ITEMS);
        expect(s).toMatch(/^3:[0-9a-z]+:[0-9a-z]+:\d+$/);
        expect(itemsSignature(ITEMS.map(i => ({ ...i, name: String(i.name).toUpperCase() })))).toBe(s);
        expect(itemsSignature([...ITEMS.slice(0, 2), { id: 'rice3', name: 'rice' }])).not.toBe(s);
        expect(itemsSignature([...ITEMS.slice(0, 2), { id: 'rice2', name: 'ricE2' }])).not.toBe(s);
        expect(itemsSignature(null)).toBe(itemsSignature([]));
        expect(itemsSignature([]).startsWith('0:')).toBe(true);
        expect(itemsSignature([]).endsWith(':2')).toBe(true);
    });
});

describe('collectEvents', () => {
    const p = { id: 'p', timestamp: 10, items: [{ name: 'Rice', qty: 5 }, { name: 'Dal', qty: 1 }] };
    const sources = {
        purchases: [p, { id: 'v', voided: true, timestamp: 1, items: [{ name: 'Rice', qty: 9 }] }, { id: 'o', timestamp: 2, items: [], openingBalance: { amount: 5 } }],
        wholesaleSales: [{ id: 'w', timestamp: 20, items: [{ name: 'Rice', qty: 2 }] }],
        retailSales: [{ id: 'r', timestamp: 10, items: [{ name: 'Rice', qty: 1 }] }, { id: 'x', timestamp: 5 }],
        stockAdjustments: [{ id: 'a', timestamp: 30, itemId: 'rice', adjustType: 'add', quantity: 1 }]
    };
    test('every line of every active bill and each adjustment, by time; ties keep purchases first', () => {
        const all = collectEvents(sources);
        expect(all.map(e => [e.t, e.kind, e.source || ''])).toEqual([
            [10, 'purchase', 'purchase'], [10, 'purchase', 'purchase'], [10, 'sale', 'retail'], [20, 'sale', 'wholesale'], [30, 'adjustment', '']
        ]);
        expect(all[0].bill).toBe(p);
    });
    test('from is included, to is not', () => {
        expect(collectEvents(sources, { from: 10, to: 30 }).map(e => e.t)).toEqual([10, 10, 10, 20]);
        expect(collectEvents(sources, { from: 11, to: 31 }).map(e => e.t)).toEqual([20, 30]);
        expect(collectEvents({})).toEqual([]);
    });
});

describe('replayEvents: purchases and sales', () => {
    test('average cost: a sale takes kg × the average cost; selling out leaves no value', () => {
        const s = run([
            ev('purchase', 1, { itemId: 'rice', qty: 10, rate: 10, total: 100 }),
            ev('purchase', 2, { itemId: 'rice', qty: 10, rate: 20, total: 200 }),
            ev('sale', 3, { itemId: 'rice', qty: 5 })
        ]);
        expect(s.rice).toEqual({ quantity: 15, rate: 0, totalValue: 225 });
        run([ev('sale', 4, { itemId: 'rice', quantity: '15' })], s);
        expect(s.rice).toEqual({ quantity: 0, rate: 0, totalValue: 0 });
    });
    test('below zero: no value; a purchase back above zero carries only the excess at its rate', () => {
        const s = run([ev('sale', 1, { itemId: 'dal', qty: 4 })]);
        expect(s.dal).toEqual({ quantity: -4, rate: 0, totalValue: 0 });
        run([ev('purchase', 2, { itemId: 'dal', qty: 3, rate: 50, total: 150 })], s);
        expect(s.dal).toEqual({ quantity: -1, rate: 0, totalValue: 0 });
        run([ev('purchase', 3, { itemId: 'dal', qty: 5, rate: 40, total: 210 })], s);
        expect(s.dal.quantity).toBe(4);
        expect(s.dal.totalValue).toBeCloseTo(4 * 42, 9);
        run([ev('purchase', 4, { itemId: 'dal', qty: 0, rate: 40 })], s);
        expect(s.dal.totalValue).toBeCloseTo(168, 9);
    });
    test('a sale from zero stock has no average and leaves no value', () => {
        const s = run([ev('purchase', 1, { itemId: 'rice', qty: 2, rate: 10, total: 20 }), ev('sale', 2, { itemId: 'rice', qty: 2 }), ev('sale', 3, { itemId: 'rice', qty: 1 })]);
        expect(s.rice).toEqual({ quantity: -1, rate: 0, totalValue: 0 });
    });
});

describe('replayEvents: corrections', () => {
    const start = () => run([ev('purchase', 1, { itemId: 'rice', qty: 10, rate: 10, total: 100 })]);
    test('add: at its rate, without a rate only kg; from below zero only the excess, at its rate', () => {
        const s = start();
        run([adj(2, 'add', 5, 12)], s);
        expect(s.rice).toEqual({ quantity: 15, rate: 0, totalValue: 160 });
        run([adj(3, 'add', 5, 0)], s);
        expect(s.rice).toEqual({ quantity: 20, rate: 0, totalValue: 160 });
        const neg = run([ev('sale', 1, { itemId: 'dal', qty: 3 })]);
        run([adj(2, 'add', 2, 9, 'dal')], neg);
        expect(neg.dal).toEqual({ quantity: -1, rate: 0, totalValue: 0 });
        run([adj(3, 'add', 4, 9, 'dal')], neg);
        expect(neg.dal).toEqual({ quantity: 3, rate: 0, totalValue: 27 });
        const neg2 = run([ev('sale', 1, { itemId: 'dal', qty: 1 }), adj(2, 'add', 4, 0, 'dal')]);
        expect(neg2.dal).toEqual({ quantity: 3, rate: 0, totalValue: 0 });
    });
    test('remove: at most what is on hand, at the average cost', () => {
        const s = start();
        run([adj(2, 'remove', 4, 0)], s);
        expect(s.rice).toEqual({ quantity: 6, rate: 0, totalValue: 60 });
        run([adj(3, 'remove', 50, 0)], s);
        expect(s.rice).toEqual({ quantity: 0, rate: 0, totalValue: 0 });
        const neg = run([ev('sale', 1, { itemId: 'dal', qty: 2 }), adj(2, 'remove', 1, 0, 'dal')]);
        expect(neg.dal).toEqual({ quantity: -2, rate: 0, totalValue: 0 });
    });
    test('set: to the count, at its rate, else at the average cost, else no value', () => {
        const s = start();
        run([adj(2, 'set', 4, 0)], s);
        expect(s.rice).toEqual({ quantity: 4, rate: 0, totalValue: 40 });
        run([adj(3, 'set', 8, 15)], s);
        expect(s.rice).toEqual({ quantity: 8, rate: 0, totalValue: 120 });
        run([adj(4, 'set', 0, 15)], s);
        expect(s.rice).toEqual({ quantity: 0, rate: 0, totalValue: 0 });
        run([adj(5, 'set', 3, 0)], s);
        expect(s.rice).toEqual({ quantity: 3, rate: 0, totalValue: 0 });
        const free = run([ev('purchase', 1, { itemId: 'dal', qty: 2, rate: 0, total: 0 }), adj(2, 'set', 5, 0, 'dal')]);
        expect(free.dal).toEqual({ quantity: 5, rate: 0, totalValue: 0 });
        const unknown = run([{ t: 1, kind: 'adjustment', adj: { itemId: 'rice', adjustType: 'other', quantity: 3 } }]);
        expect(unknown.rice).toEqual({ quantity: 0, rate: 0, totalValue: 0 });
    });
});

describe('values, checkpoints and their checks', () => {
    test('replayWithValues reports each change of value and the kg before it', () => {
        const seen = [];
        replayWithValues({}, [
            ev('purchase', 1, { itemId: 'rice', qty: 10, rate: 10, total: 100 }),
            ev('sale', 2, { itemId: 'rice', qty: 4 }),
            adj(3, 'add', 1, 0, 'dal')
        ], key, (e, k, delta, prevQty) => seen.push([k, delta, prevQty]));
        expect(seen).toEqual([['rice', 100, 0], ['rice', -40, 10], ['dal', 0, 0]]);
    });
    test('stateValue and finalizeStock count only stock on hand with a value', () => {
        const state = { a: { quantity: 2, totalValue: 30 }, b: { quantity: -1, totalValue: 5 }, c: { quantity: 3, totalValue: 0 }, d: { quantity: 0, totalValue: 7 } };
        expect(stateValue(state)).toBe(30);
        expect(stateValue(null)).toBe(0);
        expect(finalizeStock(state)).toEqual({ a: { quantity: 2, rate: 15 }, b: { quantity: -1, rate: 0 }, c: { quantity: 3, rate: 0 }, d: { quantity: 0, rate: 0 } });
    });
    test('cloneState copies (rate defaults to 0) without sharing', () => {
        const state = { a: { quantity: 1, totalValue: 2 } };
        const c = cloneState(state);
        expect(c).toEqual({ a: { quantity: 1, rate: 0, totalValue: 2 } });
        c.a.quantity = 9;
        expect(state.a.quantity).toBe(1);
        expect(cloneState({ a: { quantity: 1, rate: 4, totalValue: 2 } }).a.rate).toBe(4);
        expect(cloneState(undefined)).toEqual({});
    });
    test('a checkpoint plus the later events = the full replay; it records the key resolutions it used', () => {
        const sources = {
            purchases: [{ id: 'p1', timestamp: 1, items: [{ itemId: 'rice', name: 'Rice', qty: 10, rate: 10, total: 100 }] },
                { id: 'p2', timestamp: 5, items: [{ name: 'Dal', qty: 2, rate: 30, total: 60 }] }],
            retailSales: [{ id: 'r1', timestamp: 3, items: [{ itemId: 'rice', name: 'Rice', qty: 4 }] }]
        };
        const cp = buildCheckpointState(sources, 4, ITEMS);
        expect(cp.state).toEqual({ rice: { quantity: 6, rate: 0, totalValue: 60 } });
        expect(cp.resolutions).toEqual([['rice', 'rice', 'rice']]);
        expect(computeStockFrom(cp.state, 4, sources, ITEMS)).toEqual({ rice: { quantity: 6, rate: 10 }, dal: { quantity: 2, rate: 30 } });
        expect(cp.state.rice.quantity).toBe(6);
        const rolled = buildCheckpointState(sources, 6, ITEMS, { state: cp.state, from: 4 });
        expect(rolled.state).toEqual({ rice: { quantity: 6, rate: 0, totalValue: 60 }, dal: { quantity: 2, rate: 0, totalValue: 60 } });
        expect(rolled.resolutions).toEqual([[null, 'dal', 'dal']]);
        expect(resolutionsStillValid(cp.resolutions, ITEMS)).toBe(true);
        expect(resolutionsStillValid(rolled.resolutions, [{ id: 'dal2', name: 'Dal' }])).toBe(false);
        expect(resolutionsStillValid([...rolled.resolutions, 'bad'], ITEMS)).toBe(false);
        expect(resolutionsStillValid(null, ITEMS)).toBe(false);
        expect(resolutionsStillValid([], ITEMS)).toBe(true);
    });
    test('serializeState round-trips; anything malformed is refused', () => {
        const state = { rice: { quantity: 6, rate: 0, totalValue: 60 }, __unknown__: { quantity: -1, rate: 0, totalValue: 0 } };
        expect(deserializeState(serializeState(state))).toEqual(state);
        expect(deserializeState(null)).toBeNull();
        expect(deserializeState([null])).toBeNull();
        expect(deserializeState([{ k: 1, q: 1, v: 1 }])).toBeNull();
        expect(deserializeState([{ k: 'a', q: '1', v: 1 }])).toBeNull();
        expect(deserializeState([{ k: 'a', q: 1, v: '1' }])).toBeNull();
        expect(deserializeState([])).toEqual({});
    });
    test('stockFingerprint: payment-only edits keep it, stock fields change it, a voided bill has none', () => {
        const b = { timestamp: 5, items: [{ itemId: 'rice', name: 'Rice', qty: 2, rate: 10, total: 20 }], payment: { cash: 20 } };
        const f = stockFingerprint(b);
        expect(stockFingerprint({ ...b, payment: { cash: 0, due: 20 } })).toBe(f);
        ['itemId', 'name', 'qty', 'rate', 'total'].forEach(k => expect(stockFingerprint({ ...b, items: [{ ...b.items[0], [k]: 'x' }] })).not.toBe(f));
        expect(stockFingerprint({ ...b, items: [{ ...b.items[0], quantity: 2 }] })).not.toBe(f);
        expect(stockFingerprint({ ...b, items: [{ ...b.items[0], amount: 20 }] })).not.toBe(f);
        expect(stockFingerprint({ ...b, timestamp: 6 })).not.toBe(f);
        expect(stockFingerprint({ ...b, items: ['x'] })).toBe(JSON.stringify([5, [null], null, null]));
        expect(stockFingerprint({ ...b, voided: true })).toBeNull();
        const a = { timestamp: 7, adjustType: 'add', itemId: 'rice', itemName: 'Rice', quantity: 3, rate: 4 };
        expect(stockFingerprint(a)).toBe(JSON.stringify([7, null, 'add', ['rice', 'Rice', 3, 4]]));
        expect(stockFingerprint({ ...a, quantity: 4 })).not.toBe(stockFingerprint(a));
    });
    test('changeInvalidatesCheckpoint: only a stock change on either side of the threshold that touches before it', () => {
        const old = { timestamp: 5, items: [{ itemId: 'rice', qty: 2 }] };
        const moved = { ...old, items: [{ itemId: 'rice', qty: 3 }] };
        expect(changeInvalidatesCheckpoint(old, moved, 10)).toBe(true);
        expect(changeInvalidatesCheckpoint(old, moved, 5)).toBe(false);
        expect(changeInvalidatesCheckpoint(old, { ...moved, timestamp: 4 }, 5)).toBe(true);
        expect(changeInvalidatesCheckpoint(old, { ...old, payment: { cash: 1 } }, 10)).toBe(false);
        expect(changeInvalidatesCheckpoint(null, moved, 10)).toBe(true);
        expect(changeInvalidatesCheckpoint(old, null, 10)).toBe(true);
        expect(changeInvalidatesCheckpoint(null, moved, 10, { oldUnknown: true })).toBe(true);
        expect(changeInvalidatesCheckpoint(null, { ...moved, timestamp: 20 }, 10, { oldUnknown: true })).toBe(true);
        expect(changeInvalidatesCheckpoint(null, { ...moved, timestamp: 20 }, 10)).toBe(false);
        expect(changeInvalidatesCheckpoint(old, old, 10, { oldUnknown: true })).toBe(false);
    });
});
