/**
 * @jest-environment node
 */
/**
 * Backup coverage: every collection firestore.rules knows about is in the
 * backup list, so a new collection is never silently left out, and the nightly
 * export only drops the log/telemetry collections (tools/backup/backup-lib.js).
 */
const fs = require('fs');
const path = require('path');
const {
    BACKUP_COLLECTIONS, SUBCOLLECTIONS, NIGHTLY_EXCLUDE, planCollections, backupMode, istDayOfWeek, decideRun
} = require('../../tools/backup/backup-lib.js');

const rules = fs.readFileSync(path.join(__dirname, '../../firestore.rules'), 'utf8');

/** Production collection names in firestore.rules: literal match paths plus businessCollections(). */
function rulesCollections() {
    const roots = new Set();
    const subs = new Set();
    for (const m of rules.matchAll(/match\s+\/([^\s{]+?)\/\{[^}]+\}(?:\/([A-Za-z_]\w*)\/\{[^}]+\})?\s*\{/g)) {
        const [, root, sub] = m;
        if (root === 'databases' || root.startsWith('dev_')) continue;
        if (sub) subs.add(`${root}/${sub}`);
        else roots.add(root);
    }
    const fn = rules.match(/function businessCollections\(\)\s*\{\s*return\s*\[([\s\S]*?)\]/);
    if (!fn) throw new Error('businessCollections() not found in firestore.rules');
    for (const m of fn[1].matchAll(/'([^']+)'/g)) roots.add(m[1]);
    return { roots: [...roots].sort(), subs: [...subs].sort() };
}

describe('backup covers every collection in firestore.rules', () => {
    const { roots, subs } = rulesCollections();

    test('the rules parser finds the collections', () => {
        expect(roots).toEqual(expect.arrayContaining(['purchases', 'counters', 'users', 'auditLogs', 'rent_leases']));
        expect(subs).toEqual(['purchases/edits', 'retailSales/edits', 'users/preferences', 'wholesaleSales/edits']);
    });

    test('every rules collection is in BACKUP_COLLECTIONS (add new ones there)', () => {
        expect(roots.filter(n => !BACKUP_COLLECTIONS.includes(n))).toEqual([]);
        expect(subs.filter(n => !SUBCOLLECTIONS.includes(n))).toEqual([]);
    });

    test('BACKUP_COLLECTIONS has no stale entries', () => {
        expect(BACKUP_COLLECTIONS.filter(n => !roots.includes(n))).toEqual([]);
    });

    test('nightly backs up everything but the excluded log collections; weekly backs up everything', () => {
        const nightly = planCollections(roots, { mode: 'nightly' }).names;
        expect(nightly).toEqual(roots.filter(n => !NIGHTLY_EXCLUDE.includes(n)));
        expect(NIGHTLY_EXCLUDE.slice().sort()).toEqual(['auditLogs', 'telemetry', 'tipFailures', 'tipHealth']);
        expect(nightly).toEqual(expect.arrayContaining([
            'rent_public', 'rent_properties', 'rent_units', 'rent_tenants', 'rent_leases', 'rent_charges', 'rent_settings',
            'rent_receipts', 'rent_counters', 'rent_deposits',
            'rateStats', 'rateHistory', 'settings', 'users', 'counters', 'purchases', 'retailSales', 'wholesaleSales'
        ]));
        expect(planCollections(roots, { mode: 'weekly' }).names).toEqual(roots);
    });

    test('BACKUP_EXCLUDE may skip optional collections but never business data', () => {
        const plan = planCollections([...roots, 'dev_items', 'newThing'], { mode: 'weekly', exclude: ['notifications', 'items', 'rent_units', ' '] });
        expect(plan.names).not.toContain('notifications');
        expect(plan.names).toEqual(expect.arrayContaining(['items', 'rent_units', 'newThing']));
        expect(plan.names).not.toContain('dev_items');
        expect(plan.refused).toEqual(['items', 'rent_units']);
        expect(plan.excluded).toEqual(['notifications']);
        expect(plan.undeclared).toEqual(['newThing']);
    });
});

describe('nightly / weekly mode', () => {
    test('scheduled runs are weekly on Sunday in India, nightly otherwise', () => {
        expect(istDayOfWeek(new Date('2026-11-01T08:15:00Z'))).toBe(0);
        expect(istDayOfWeek(new Date('2026-10-31T19:00:00Z'))).toBe(0); // Saturday in UTC, Sunday 00:30 IST
        expect(backupMode({ requested: 'auto', scheduled: true, dayOfWeek: 0 })).toBe('weekly');
        expect(backupMode({ requested: 'auto', scheduled: true, dayOfWeek: 3 })).toBe('nightly');
        expect(backupMode({ requested: '', scheduled: false, dayOfWeek: 0 })).toBe('nightly');
        expect(backupMode({ requested: 'weekly', scheduled: false, dayOfWeek: 3 })).toBe('weekly');
    });

    test('the size guard still lets the Sunday run through', () => {
        const o = { totalDocs: 20000, scheduled: true, weeklyAbove: 15000, hardMax: 40000, force: false };
        expect(decideRun({ ...o, dayOfWeek: 0 }).run).toBe(true);
        expect(decideRun({ ...o, dayOfWeek: 2 }).run).toBe(false);
    });
});
