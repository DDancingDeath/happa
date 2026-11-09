/**
 * @jest-environment node
 */
/**
 * tools/migrate parties dry run (#139 phase 2 proposal): proposed parties with
 * salted stable ids, possible duplicates (suggested, never merged) and dues per
 * party that add up to Outstanding. Offline: no Firebase anywhere.
 */
import fs from 'fs';
import path from 'path';
import {
    formatSummary, hindiSuggestion, mergeSuggestions, partiesDryRun, partyIdOf, PARTY_ID_RE, proposeParties, saltFrom, toCsv
} from '../../../tools/migrate/lib/parties-dryrun.js';
import { revive } from '../../../tools/migrate/lib/plan.js';
import { buildAging } from '../utils/aging.js';

const ROOT = path.join(__dirname, '..', '..', '..');
const load = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'migrate', 'parties-backup.json'), 'utf8'));
const SALT = '0123456789abcdef0123456789abcdef';
const NOW = Date.UTC(2026, 9, 25, 9);
const run = (opts = {}, backup = load()) => partiesDryRun(backup, { salt: SALT, now: NOW, ...opts });
const byName = (result, name) => result.parties.find(p => p.name === name);

describe('partyId scheme', () => {
    test("'p-' + 16 hex digits, valid as a bill's partyId in the rules", () => {
        const id = partyIdOf(SALT, 'Ramesh');
        expect(id).toMatch(PARTY_ID_RE);
        expect(id).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
    });

    test('same salt, same id for every spelling of one PARTY key; blank names get none', () => {
        expect(partyIdOf(SALT, '  RAMESH ')).toBe(partyIdOf(SALT, 'Ramesh'));
        expect(partyIdOf(SALT, 'Ram  Lal')).toBe(partyIdOf(SALT, 'ram lal'));
        expect(partyIdOf(SALT, 'Ramesh Ji')).not.toBe(partyIdOf(SALT, 'Ramesh'));
        expect(partyIdOf(SALT, '   ')).toBe('');
    });

    test('another salt gives other ids; a bad salt is refused', () => {
        expect(partyIdOf('f'.repeat(32), 'Ramesh')).not.toBe(partyIdOf(SALT, 'Ramesh'));
        expect(() => partyIdOf('short', 'Ramesh')).toThrow(/salt/);
        expect(() => partyIdOf(undefined, 'Ramesh')).toThrow(/salt/);
    });

    test('a rerun with the saved salt keeps every id, also when a name gains the other side', () => {
        const first = run();
        const again = partiesDryRun(load(), { salt: saltFrom(first), now: NOW });
        expect(again.parties.map(p => p.partyId)).toEqual(first.parties.map(p => p.partyId));
        const backup = load();
        backup.collections.purchases.push({ id: 'p-new', data: { type: 'purchase', isPurchase: true, date: '2026-10-20', customerName: 'Mohan', payment: { due: 10, total: 10 } } });
        const later = run({}, backup);
        expect(byName(later, 'Mohan')).toMatchObject({ partyId: byName(first, 'Mohan').partyId, type: 'both' });
    });

    test('saltFrom reads a dry run or a bundle and refuses files without one', () => {
        expect(saltFrom({ salt: SALT })).toBe(SALT);
        expect(saltFrom({ partySalt: SALT })).toBe(SALT);
        expect(() => saltFrom({ format: 'aadhat-backup-v1' })).toThrow(/salt/);
    });
});

describe('proposed parties', () => {
    test('one party per name with an open due; voided bills, blank names and dev_ data left out', () => {
        const r = run();
        expect(r.totals).toMatchObject({ parties: 12, namesInBackup: 14, customers: 10, suppliers: 1, both: 1, voidedBillsSkipped: 1 });
        expect(r.totals.unnamed).toEqual({ bills: 1, dueBills: 1, due: 50 });
        const names = r.parties.map(p => p.name);
        expect(names).not.toEqual(expect.arrayContaining(['Gopal']));
        expect(names.some(n => /Voided|Dev Only/.test(n))).toBe(false);
        expect(new Set(r.parties.map(p => p.partyId)).size).toBe(r.parties.length);
    });

    test('scope all also proposes fully paid names', () => {
        const r = run({ scope: 'all' });
        expect(r.totals.parties).toBe(14);
        expect(byName(r, 'Gopal')).toMatchObject({ dueBills: 0, dues: { receivable: 0, payable: 0 }, bills: { total: 1 } });
        expect(() => run({ scope: 'some' })).toThrow(/scope/);
    });

    test('name = most used spelling, other spellings as aliases, newest phone as legacyPhone, type from the sides', () => {
        const r = run();
        expect(byName(r, 'Ramesh')).toMatchObject({ aliases: ['ramesh'], legacyPhone: '9876500011', type: 'customer', bills: { retail: 2, total: 2 }, dueBills: 2 });
        expect(byName(r, 'Suresh Traders')).toMatchObject({ type: 'both', dues: { purchase: 1500, wholesale: 500, receivable: 500, payable: 1500 } });
        expect(byName(r, 'Kisan')).toMatchObject({ type: 'supplier', legacyPhone: null });
    });

    test('Hindi name is a spelled suggestion for Latin names only', () => {
        expect(hindiSuggestion('Mohan')).toBe('मोहन');
        expect(hindiSuggestion('रमेश')).toBe('');
        expect(byName(run(), 'Ramesh Ji').hindiSuggestion).toBe('रमेश जी');
    });

    test('refuses anything but a decrypted backup', () => {
        expect(() => proposeParties({ format: 'x' }, { salt: SALT })).toThrow(/decrypted backup/);
    });
});

describe('dues add up to Outstanding', () => {
    test('per list: Σ parties + "No name" = buildAging total of the same bills', () => {
        const backup = load();
        const r = run({}, backup);
        const total = (coll) => buildAging(backup.collections[coll].map(d => ({ id: d.id, ...revive(d.data) })), { today: new Date(NOW) }).total;
        expect(r.totals.outstanding.purchase).toMatchObject({ parties: 2200, unnamed: 0, outstanding: total('purchases'), matches: true });
        expect(r.totals.outstanding.retail).toMatchObject({ parties: 1190, unnamed: 50, outstanding: total('retailSales'), matches: true });
        expect(r.totals.outstanding.wholesale).toMatchObject({ parties: 900, outstanding: total('wholesaleSales'), matches: true });
        expect(r.totals.matchesOutstanding).toBe(true);
    });

    test('nothing is written: only a count of what the migration would write', () => {
        expect(run().writes).toEqual({ parties: 12, directory: 1, bills: 0 });
    });
});

describe('merge suggestions', () => {
    const r = run();
    const pair = (a, b) => r.suggestions.find(s => s.names.includes(a) && s.names.includes(b));

    test('Hindi / Latin, "ji", spacing and spelling variants are high; a one-letter typo medium; a longer name low', () => {
        expect(pair('Ramesh', 'Ramesh Ji')).toMatchObject({ level: 'high', reasons: ['honorific'], keep: byName(r, 'Ramesh').partyId });
        expect(pair('Ramesh', 'रमेश')).toMatchObject({ level: 'high', reasons: ['script'] });
        expect(pair('Ram Lal', 'Ramlal')).toMatchObject({ level: 'high', reasons: ['spacing'] });
        expect(pair('Sita Devi', 'Seeta Devi')).toMatchObject({ level: 'high', reasons: ['spelling'] });
        expect(pair('Mohan', 'Mohun')).toMatchObject({ level: 'medium', reasons: ['typo'] });
        expect(pair('Ramesh', 'Ramesh Kumar')).toMatchObject({ level: 'low', reasons: ['prefix'] });
        expect(pair('Suresh Traders', 'Kisan')).toBeUndefined();
    });

    test('ranked by confidence; the party with more bills is the one kept; combined dues shown', () => {
        const conf = r.suggestions.map(s => s.confidence);
        expect(conf).toEqual([...conf].sort((a, b) => b - a));
        expect(pair('Ramesh', 'Ramesh Ji').after).toEqual({ bills: 3, receivable: 600, payable: 0 });
    });

    test('never merged automatically: every suggestion says so and the proposals stay separate', () => {
        expect(r.suggestions.every(s => s.autoMerge === false)).toBe(true);
        const before = JSON.stringify(r.parties);
        mergeSuggestions(r.parties);
        expect(JSON.stringify(r.parties)).toBe(before);
        expect(r.parties.map(p => p.name)).toEqual(expect.arrayContaining(['Ramesh', 'Ramesh Ji', 'रमेश']));
    });
});

describe('outputs', () => {
    test('CSV: one row per party with its possible duplicates, quoted where needed', () => {
        const csv = toCsv(run()).trim().split('\n');
        expect(csv[0]).toMatch(/^partyId,name,hindiSuggestion,type,aliases,bills/);
        expect(csv).toHaveLength(13);
        expect(csv.find(l => l.includes(',Mohan,'))).toMatch(/\(medium\)$/);
        const odd = run({}, { ...load(), collections: { retailSales: [{ id: 'x', data: { customerName: 'A, "B"', payment: { due: 5, total: 5 } } }] } });
        expect(toCsv(odd)).toContain('"A, ""B"""');
    });

    test('the summary without names shows counts and the Outstanding check only', () => {
        const text = formatSummary(run(), { names: false });
        expect(text).toMatch(/NO WRITES/);
        expect(text).toMatch(/retail +parties ₹1,190 \+ no name ₹50 = ₹1,240; Outstanding ₹1,240 OK/);
        expect(text).not.toMatch(/Ramesh|Mohan/);
    });
});
