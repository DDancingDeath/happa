import fc from 'fast-check';
import {
    unitRows, summarize, propertySummaries, groupByType, filterRows, typedPlace, placeText, unitType, unitExtraError, UNIT_TYPES
} from '../rentals/rent-views.js';
import { monthSummary } from '../rentals/rent-math.js';

const MONTH = '2026-10';
const TODAY = new Date(2026, 9, 20);
const d = {
    properties: [{ id: 'P1', name: 'Gupta Bhawan' }, { id: 'P2', name: 'Arora Market' }, { id: 'P3', name: 'Empty Plot' }],
    units: [
        { id: 'U1', propertyId: 'P1', label: '2B', type: 'flat', rent: 8000 },
        { id: 'U2', propertyId: 'P1', label: '3A', rent: 7000 },
        { id: 'U3', propertyId: 'P1', label: 'Shop 3', type: 'commercial', rent: 12000, area: 300, floor: 'Ground' },
        { id: 'U4', propertyId: 'P2', label: 'G1', type: 'godown', rent: 15000 },
        { id: 'U5', propertyId: 'P2', label: 'X', type: 'office', rent: 9000, archived: true }
    ],
    tenants: [{ id: 'T1', name: 'Ram' }, { id: 'T2', name: 'Shyam' }, { id: 'T3', name: 'Mohan' }],
    leases: [
        { id: 'L1', unitId: 'U1', tenantId: 'T1', rent: 8000, dueDay: 10, status: 'active' },
        { id: 'L3', unitId: 'U3', tenantId: 'T2', rent: 12000, dueDay: 25, status: 'active' },
        { id: 'L4', unitId: 'U4', tenantId: 'T3', rent: 15000, dueDay: 10, status: 'active' }
    ],
    charges: [
        { id: 'L1_2026-10', leaseId: 'L1', unitId: 'U1', month: MONTH, dueDay: 10, amount: 8400, paid: 8400 },
        { id: 'L1_2026-09', leaseId: 'L1', unitId: 'U1', month: '2026-09', dueDay: 10, amount: 8000, paid: 8000 },
        { id: 'L3_2026-10', leaseId: 'L3', unitId: 'U3', month: MONTH, dueDay: 25, amount: 12000, paid: 5000 },
        { id: 'L4_2026-09', leaseId: 'L4', unitId: 'U4', month: '2026-09', dueDay: 10, amount: 15000, paid: 0 },
        { id: 'L4_2026-10', leaseId: 'L4', unitId: 'U4', month: MONTH, dueDay: 10, amount: 15000, paid: 0 },
        // moved out of U2 this month, still owes
        { id: 'L2_2026-10', leaseId: 'L2', unitId: 'U2', month: MONTH, dueDay: 10, amount: 7000, paid: 1000 }
    ]
};

describe('unit rows (RENT-10)', () => {
    const rows = unitRows(d, MONTH, TODAY);
    const by = Object.fromEntries(rows.map(r => [r.unitId, r]));

    test('one row per unit (archived left out); older units without a type count as flats', () => {
        expect(rows.map(r => r.unitId)).toEqual(['U1', 'U2', 'U3', 'U4']);
        expect(by.U2.type).toBe('flat');
        expect(unitType({})).toBe('flat');
    });

    test('status: Paid / Part paid / Late / Vacant; month totals and amount due per unit', () => {
        expect(by.U1).toMatchObject({ status: 'paid', expected: 8400, collected: 8400, pending: 0, due: 0, tenantName: 'Ram', occupied: true });
        expect(by.U3).toMatchObject({ status: 'partial', expected: 12000, collected: 5000, pending: 7000, due: 7000, late: false, area: 300, floor: 'Ground' });
        expect(by.U4).toMatchObject({ status: 'late', expected: 15000, collected: 0, due: 30000, late: true });
        // vacant now, but this month's charge of the tenant who left still counts on it
        expect(by.U2).toMatchObject({ status: 'vacant', occupied: false, expected: 7000, collected: 1000, due: 6000, rent: 7000 });
    });

    test('property summaries: counts by type, occupancy, late, month money', () => {
        const [arora, empty, gupta] = propertySummaries(d.properties, rows);
        expect(gupta.property.id).toBe('P1');
        expect(gupta.summary).toMatchObject({
            units: 3, occupied: 2, vacant: 1, late: 0, expected: 27400, collected: 14400, pending: 13000, due: 13000
        });
        expect(gupta.summary.byType).toMatchObject({ flat: 2, commercial: 1 });
        expect(arora.summary).toMatchObject({ units: 1, late: 1, due: 30000 });
        expect(empty.summary).toMatchObject({ units: 0, expected: 0 });
    });

    test('page totals = sum of property cards = sum of unit rows = RENT-1/2/4', () => {
        const all = summarize(rows);
        const cards = propertySummaries(d.properties, rows).map(x => x.summary);
        for (const k of ['units', 'occupied', 'vacant', 'late', 'expected', 'collected', 'due']) {
            expect(cards.reduce((s, c) => s + c[k], 0)).toBeCloseTo(all[k], 2);
        }
        const rent = monthSummary(d.charges, MONTH);
        expect(all.expected).toBe(rent.expected);
        expect(all.collected).toBe(rent.collected);
        expect(all.due).toBe(rent.outstanding);
    });

    test('property detail groups by type in a fixed order', () => {
        const g = groupByType(rows.filter(r => r.propertyId === 'P1'));
        expect(g.map(x => [x.type, x.rows.map(r => r.label)])).toEqual([['flat', ['2B', '3A']], ['commercial', ['Shop 3']]]);
    });

    test('unit list: filters, search over unit / tenant / property, sort by due', () => {
        expect(filterRows(rows).map(r => r.unitId)).toEqual(['U4', 'U3', 'U2', 'U1']);
        expect(filterRows(rows, { sort: 'asc' })[0].unitId).toBe('U1');
        expect(filterRows(rows, { propertyId: 'P1', status: 'occupied' }).map(r => r.unitId)).toEqual(['U3', 'U1']);
        expect(filterRows(rows, { status: 'vacant' }).map(r => r.unitId)).toEqual(['U2']);
        expect(filterRows(rows, { status: 'late' }).map(r => r.unitId)).toEqual(['U4']);
        expect(filterRows(rows, { status: 'due' }).map(r => r.unitId)).toEqual(['U4', 'U3', 'U2']);
        expect(filterRows(rows, { type: 'commercial' }).map(r => r.unitId)).toEqual(['U3']);
        expect(filterRows(rows, { q: 'shy' }).map(r => r.unitId)).toEqual(['U3']);
        expect(filterRows(rows, { q: '2b' }).map(r => r.unitId)).toEqual(['U1']);
        expect(filterRows(rows, { q: 'arora' }).map(r => r.unitId)).toEqual(['U4']);
    });
});

test('a former tenant\'s late month stays in the unit\'s due but does not make the new tenant Late (review of #30)', () => {
    const data = {
        properties: [{ id: 'P1', name: 'Gupta Bhawan' }],
        units: [{ id: 'U1', propertyId: 'P1', label: '2B', type: 'flat', rent: 8000 }],
        tenants: [{ id: 'T2', name: 'New' }],
        leases: [{ id: 'LNEW', unitId: 'U1', tenantId: 'T2', rent: 8000, dueDay: 10, status: 'active' }],
        charges: [
            { id: 'LOLD_2026-09', leaseId: 'LOLD', unitId: 'U1', month: '2026-09', dueDay: 5, amount: 7000, paid: 0 },
            { id: 'LNEW_2026-10', leaseId: 'LNEW', unitId: 'U1', month: MONTH, dueDay: 10, amount: 8000, paid: 8000 }
        ]
    };
    const [row] = unitRows(data, MONTH, TODAY);
    expect(row).toMatchObject({ status: 'paid', late: false, due: 7000, expected: 8000, collected: 8000 });
    expect(summarize([row]).late).toBe(0);
    expect(filterRows([row], { status: 'late' })).toEqual([]);
    expect(filterRows([row], { status: 'due' })).toHaveLength(1);
});

test('property totals always equal the sum of their unit rows (generated data)', () => {
    const arb = fc.record({
        units: fc.array(fc.record({ p: fc.integer({ min: 0, max: 3 }), type: fc.constantFrom(...UNIT_TYPES, undefined), occupied: fc.boolean(),
            charges: fc.array(fc.record({ m: fc.constantFrom('2026-08', '2026-09', '2026-10'), amount: fc.integer({ min: 0, max: 20000 }), pct: fc.integer({ min: 0, max: 100 }) }), { maxLength: 3 }) }),
        { maxLength: 15 })
    });
    fc.assert(fc.property(arb, ({ units }) => {
        const data = { properties: [0, 1, 2, 3].map(i => ({ id: `P${i}`, name: `P${i}` })), units: [], leases: [], tenants: [], charges: [] };
        units.forEach((u, i) => {
            data.units.push({ id: `U${i}`, propertyId: `P${u.p}`, label: `U${i}`, type: u.type, rent: 1000 });
            if (u.occupied) data.leases.push({ id: `L${i}`, unitId: `U${i}`, tenantId: 'T', rent: 1000, dueDay: 10, status: 'active' });
            const seen = new Set();
            u.charges.forEach(c => {
                if (seen.has(c.m)) return;
                seen.add(c.m);
                data.charges.push({ id: `L${i}_${c.m}`, leaseId: `L${i}`, unitId: `U${i}`, month: c.m, dueDay: 10, amount: c.amount, paid: Math.floor(c.amount * c.pct / 100) });
            });
        });
        const rows = unitRows(data, '2026-10', TODAY);
        const all = summarize(rows);
        const cards = propertySummaries(data.properties, rows).map(x => x.summary);
        for (const k of ['units', 'occupied', 'late', 'expected', 'collected', 'due']) {
            if (Math.abs(cards.reduce((s, c) => s + c[k], 0) - all[k]) > 0.01) return false;
        }
        const rent = monthSummary(data.charges, '2026-10');
        return Math.abs(all.expected - rent.expected) < 0.01 && Math.abs(all.collected - rent.collected) < 0.01
            && Math.abs(all.due - rent.outstanding) < 0.01;
    }), { seed: 909, numRuns: Number(process.env.FC_RUNS) || 100 });
});

test('places: "Flat 2B, Gupta Bhawan"; no double type word; size and floor checks', () => {
    expect(typedPlace('Flat', '2B', 'Gupta Bhawan')).toBe('Flat 2B, Gupta Bhawan');
    expect(typedPlace('Shop', 'Shop 3', 'Gupta Bhawan')).toBe('Shop 3, Gupta Bhawan');
    expect(typedPlace('फ़्लैट', '2B', 'Gupta Bhawan')).toBe('फ़्लैट 2B, Gupta Bhawan');
    expect(placeText('2B', '')).toBe('2B');
    expect(unitExtraError({ type: 'flat', area: 450, floor: '1st' })).toBe('');
    expect(unitExtraError({ type: 'castle' })).toBe('msg.rent.bad_unit_type');
    expect(unitExtraError({ type: 'flat', area: 0 })).toBe('msg.rent.bad_area');
    expect(unitExtraError({ type: 'flat', area: null, floor: 'x'.repeat(21) })).toBe('msg.rent.too_long');
});
