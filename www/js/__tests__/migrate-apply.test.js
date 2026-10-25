/**
 * @jest-environment node
 */
/**
 * tools/migrate apply (#15): dry run by default, refuses the old project,
 * budgeted + resumable writes, idempotent reruns that keep opening balances
 * already paid in the new app, and dev_ only with --dev.
 */
import fs from 'fs';
import path from 'path';
import { buildPlan } from '../../../tools/migrate/lib/plan.js';
import {
    applyBundle, checkTarget, resumeCursor, newCursor, planRun, targetColl, validateBundle
} from '../../../tools/migrate/lib/apply.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';

const ROOT = path.join(__dirname, '..', '..', '..');
const load = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'migrate', 'backup-synthetic.json'), 'utf8'));
const makeBundle = (backup = load(), opts = {}) => buildPlan(backup, opts, { now: Date.UTC(2026, 9, 25, 9) }).bundle;

class FakeTimestamp {
    constructor(seconds, nanoseconds) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
    toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
    static fromMillis(ms) { return new FakeTimestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6); }
}
const types = { Timestamp: FakeTimestamp, GeoPoint: class {} };
const PROJECT = 'shop-new-project';

async function run(fake, bundle, cursor, opts = {}) {
    const saves = [];
    const result = await applyBundle({
        bundle, cursor, dryRun: false, db: fake.db, types, saveCursor: (c) => saves.push(JSON.parse(JSON.stringify(c))), ...opts
    });
    return { ...result, saves };
}

describe('apply: safety', () => {
    test('refuses the old project and mismatched keys', () => {
        expect(() => checkTarget({ project: 'aadhat-management' })).toThrow(/OLD project/);
        expect(() => checkTarget({ project: ' Aadhat-Management ' })).toThrow(/OLD project/);
        expect(() => checkTarget({ project: PROJECT, keyProject: 'aadhat-management' })).toThrow(/OLD project/);
        expect(() => checkTarget({ project: PROJECT, keyProject: 'other' })).toThrow(/not shop-new-project/);
        expect(() => checkTarget({})).toThrow(/--project/);
        expect(() => checkTarget({ project: PROJECT, keyProject: PROJECT })).not.toThrow();
    });

    test('dry run plans the writes and touches nothing', async () => {
        const bundle = makeBundle();
        const lines = [];
        const fake = createFakeFirestore();
        const r = await applyBundle({ bundle, cursor: newCursor(bundle, PROJECT), db: fake.db, types, log: (l) => lines.push(l) });
        expect(r.status).toBe('dry-run');
        expect(r.writes).toBe(0);
        expect(fake.stats.writes).toBe(0);
        expect(fake.stats.reads).toBe(0);
        expect(r.run).toMatchObject({ total: bundle.writes.length, start: 0, end: bundle.writes.length, remainingAfter: 0 });
        expect(lines.join('\n')).toMatch(/Nothing was written/);
    });

    test('dev_ collections only with --dev, which writes everything to dev_', async () => {
        expect(() => targetColl('dev_items', false)).toThrow(/--dev/);
        expect(targetColl('items', true)).toBe('dev_items');
        const bundle = makeBundle();
        const fake = createFakeFirestore();
        await run(fake, bundle, newCursor(bundle, PROJECT), { dev: true });
        expect(fake.raw('dev_items').size).toBe(3);
        expect(fake.raw('items').size).toBe(0);
        const bad = { ...bundle, writes: [...bundle.writes, { group: 'copy:x', coll: 'dev_x', id: '1', data: {} }] };
        await expect(applyBundle({ bundle: bad, cursor: newCursor(bad, PROJECT), dryRun: true })).rejects.toThrow(/--dev/);
    });

    test('a bundle is required', () => {
        expect(() => validateBundle({ format: 'aadhat-backup-v1', collections: {} })).toThrow(/plan/);
    });
});

describe('apply: writes', () => {
    test('writes every document by id, timestamps restored', async () => {
        const bundle = makeBundle();
        const fake = createFakeFirestore();
        const r = await run(fake, bundle, newCursor(bundle, PROJECT));
        expect(r.status).toBe('done');
        expect(r.writes).toBe(bundle.writes.length);
        expect(fake.stats.writes).toBe(bundle.writes.length);
        const wheat = fake.raw('items').get('item-wheat');
        expect(wheat.hindiName).toBe('गेहूं');
        expect(wheat.createdAt).toEqual({ seconds: Math.floor(Date.UTC(2025, 0, 2, 4, 30) / 1000), nanoseconds: 0 });
        expect(fake.raw('users').get('uid-owner').role).toBe('owner');
        expect(fake.raw('rateStats').get('_meta').backfillDone).toBe(true);
        expect([...fake.raw('retailSales').keys()].every(id => id.startsWith('opening-retail-'))).toBe(true);
    });

    test('stops at the budget and resumes from the cursor', async () => {
        const bundle = makeBundle();
        const fake = createFakeFirestore();
        const budget = 7;
        let cursor = newCursor(bundle, PROJECT);
        const first = await run(fake, bundle, cursor, { budget, batchSize: 3 });
        expect(first.status).toBe('budget');
        expect(first.cursor.next).toBe(7);
        expect(fake.stats.writes).toBe(7);
        // A crash after a batch keeps the cursor of that batch
        expect(first.saves[0].next).toBe(3);

        cursor = resumeCursor(first.saves[first.saves.length - 1], bundle, PROJECT);
        expect(planRun(bundle, cursor, budget)).toMatchObject({ start: 7, count: 7 });
        let r = await run(fake, bundle, cursor, { budget });
        while (r.status === 'budget') r = await run(fake, bundle, resumeCursor(r.saves[r.saves.length - 1], bundle, PROJECT), { budget });
        expect(r.status).toBe('done');
        expect(fake.stats.writes).toBe(bundle.writes.length);
        const done = await run(fake, bundle, r.cursor, { budget });
        expect(done).toMatchObject({ status: 'done', writes: 0 });
    });

    test('a cursor of another bundle or project is refused', () => {
        const bundle = makeBundle();
        const other = makeBundle(load(), { billNumbers: 'restart' });
        const saved = newCursor(bundle, PROJECT);
        expect(() => resumeCursor(saved, other, PROJECT)).toThrow(/different bundle/);
        expect(() => resumeCursor(saved, bundle, 'another')).toThrow(/is for project/);
        expect(resumeCursor(saved, other, PROJECT, { restart: true }).next).toBe(0);
    });

    test('a rerun keeps opening balances already paid in the new app and removes ones no longer due', async () => {
        const backup = load();
        const bundle = makeBundle(backup);
        const fake = createFakeFirestore();
        await run(fake, bundle, newCursor(bundle, PROJECT));
        const shyamId = bundle.writes.find(w => w.group === 'opening' && w.data.customerName === 'Shyam').id;
        const geetaId = bundle.writes.find(w => w.group === 'opening' && w.data.customerName === 'Geeta').id;
        const paid = fake.raw('retailSales').get(shyamId);
        paid.payments = [{ id: 'new-1', amount: 100, cash: 100 }];
        paid.payment = { ...paid.payment, cash: 100, due: 200 };

        // Fresher backup: Geeta paid in the old app before go-live.
        backup.collections.retailSales.find(d => d.id === 'r7').data.amountPaid = 90;
        const bundle2 = makeBundle(backup);
        const r = await run(fake, bundle2, resumeCursor(newCursor(bundle, PROJECT), bundle2, PROJECT, { restart: true }));
        expect(r.status).toBe('done');
        expect(fake.raw('retailSales').get(shyamId).payment.due).toBe(200);
        expect(fake.raw('retailSales').get(shyamId).payments).toHaveLength(1);
        expect(r.cursor.skipped).toEqual([`retailSales/${shyamId}`]);
        expect(fake.raw('retailSales').has(geetaId)).toBe(false);
        expect(r.cursor.deleted).toBe(1);
    });
});
