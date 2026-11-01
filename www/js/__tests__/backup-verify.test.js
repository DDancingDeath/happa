/**
 * Checking a backup file on the phone (#63): read-only, the same checks as the
 * offline verify (tools/backup/verify-lib.js), a good check is the owner's
 * restore drill (REM-3) and an audit row; a bad or locked file says why.
 */
import { jest } from '@jest/globals';
import { verifyBackup, verifyBackupText, MAX_PROBLEMS } from '../utils/backup-verify.js';
import { buildBackup } from '../utils/data-export.js';
import { AdminManager } from '../modules/admin.js';
import { AuditService } from '../services/audit.js';
import { AppState } from '../utils/state.js';
import { setLang, resetLangForTests } from '../i18n/index.js';
import { t } from '../i18n/index.js';

const fs = require('fs');
const path = require('path');
const { checkBackup } = require('../../../tools/backup/verify-lib.js');

const NOW = new Date('2026-11-01T12:00:00+05:30').getTime();
const DAY = 86400000;
const bytesOf = (s) => Uint8Array.from(String(s), ch => ch.charCodeAt(0) & 0xff);
const ciBackup = () => ({
    format: 'aadhat-backup-v1', mode: 'nightly', exportedAt: new Date(NOW - 2 * DAY).toISOString(),
    collections: {
        purchases: [{ id: 'p1', data: { timestamp: NOW - 3 * DAY, createdAt: { __type: 'timestamp', seconds: 1, nanoseconds: 0 } } }],
        retailSales: [{ id: 'r1', data: { timestamp: { __type: 'timestamp', seconds: (NOW - 2.5 * DAY) / 1000, nanoseconds: 0 } } }, { id: 'r2', data: { items: [{ ref: { __type: 'ref', path: 'items/a' } }] } }],
        items: [{ id: 'a', data: { name: 'Rice', at: { __type: 'geopoint', latitude: 1, longitude: 2 } } }]
    },
    subcollections: { 'purchases/edits': [{ path: 'purchases/p1/edits/1', data: { reason: 'x' } }] },
    manifest: { collections: { items: 1, purchases: 1, retailSales: 2 }, subcollections: { 'purchases/edits': 1 } }
});

describe('verifyBackup', () => {
    test('a good nightly backup: counts, age, newest bill; agrees with the offline verify', () => {
        const b = ciBackup();
        const r = verifyBackup(b, NOW);
        expect(r).toMatchObject({ ok: true, problems: [], problemCount: 0, ageDays: 2, source: 'nightly', totalDocs: 5, newestBillAt: NOW - 2.5 * DAY });
        expect(r.collections).toEqual([{ name: 'items', docs: 1 }, { name: 'purchases', docs: 1 }, { name: 'retailSales', docs: 2 }]);
        expect(r.subcollections).toEqual([{ name: 'purchases/edits', docs: 1 }]);
        expect(checkBackup(b, b.manifest)).toEqual([]);
    });

    test('the in-app Clear Data backup is a good backup too', () => {
        const b = JSON.parse(JSON.stringify(buildBackup({ drafts: [{ id: 'd1', data: { at: new Date(NOW) } }] }, { now: new Date(NOW - DAY), exportedBy: 'u1' })));
        expect(verifyBackup(b, NOW)).toMatchObject({ ok: true, source: 'app', ageDays: 1, totalDocs: 1, newestBillAt: null });
    });

    test('every problem the offline verify finds is found here too, with a code to show', () => {
        const b = ciBackup();
        b.collections.items.push({ id: 'a', data: {} }, { data: { x: 1 } }, { id: 'z' });
        b.collections.purchases[0].data.createdAt = { __type: 'timestamp', seconds: 'x' };
        b.collections.retailSales[1].data.items[0].ref.path = '';
        const r = verifyBackup(b, NOW);
        expect(r.ok).toBe(false);
        expect(r.problems.map(p => p.code)).toEqual(['twice', 'no_id', 'no_data', 'bad_value', 'bad_value', 'count']);
        expect(r.problems.find(p => p.code === 'count')).toEqual({ code: 'count', coll: 'items', file: 4, manifest: 1 });
        expect(checkBackup(b, b.manifest).length).toBeGreaterThan(0);
        r.problems.forEach(p => expect(t(`ui.backup.p_${p.code}`, p)).not.toMatch(/ui\.backup|\{/));
    });

    test('not a backup, no collections, no time, not JSON; long lists are cut', () => {
        expect(verifyBackup({ format: 'x' }, NOW).problems).toEqual([{ code: 'not_backup' }]);
        expect(verifyBackup({ format: 'aadhat-backup-v1', collections: [] }, NOW).problems).toEqual([{ code: 'no_collections' }]);
        expect(verifyBackup({ format: 'aadhat-backup-v1', collections: { a: 'x' } }, NOW).problems.map(p => p.code)).toEqual(['no_time', 'not_list']);
        expect(verifyBackupText('{"format": "aadhat-backup-v1", "collections": {', NOW).problems).toEqual([{ code: 'not_json' }]);
        const many = verifyBackup({ format: 'aadhat-backup-v1', exportedAt: new Date(NOW).toISOString(), collections: { a: Array.from({ length: 30 }, () => ({})) } }, NOW);
        expect(many.problems.length).toBe(MAX_PROBLEMS);
        expect(many.problemCount).toBe(60);
    });
});

describe('Admin › Data › Check a backup', () => {
    const fakeFile = (text, { name = 'backup.json', head = null, size = text.length } = {}) => {
        const bytes = head || bytesOf(text.slice(0, 8));
        return { name, size, slice: () => ({ arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }), text: async () => text };
    };
    beforeEach(() => {
        document.body.innerHTML = '<div id="adminContainer"></div>';
        AppState.userRole = 'owner';
        AppState.currentUser = { uid: 'u1' };
        localStorage.clear();
        AdminManager.renderData();
    });
    afterEach(() => {
        jest.restoreAllMocks();
        setLang('en');
        resetLangForTests();
    });

    test('a good file: shown as complete, recorded as the drill and in the audit log; nothing written to the database', async () => {
        const note = jest.spyOn(AuditService, 'note').mockImplementation(() => {});
        const r = await AdminManager.checkBackupFile(fakeFile(JSON.stringify(ciBackup())));
        expect(r.ok).toBe(true);
        const box = document.getElementById('adminBackupResult');
        expect(box.querySelector('[data-backup-ok="true"]').textContent).toMatch(/Backup looks complete.*5 records in 3 collections/s);
        expect(JSON.parse(localStorage.getItem('happa.restoreDrill'))).toMatchObject({ uid: 'u1', docs: 5 });
        expect(note).toHaveBeenCalledWith('BACKUP_CHECK', { recordsChecked: 5, date: '2026-10-30' });
    });

    test('a locked, damaged or too big file says why and records nothing', async () => {
        const note = jest.spyOn(AuditService, 'note').mockImplementation(() => {});
        await AdminManager.checkBackupFile(fakeFile('x', { head: bytesOf('Salted__') }));
        expect(document.getElementById('adminBackupResult').textContent).toMatch(/still locked/);
        await AdminManager.checkBackupFile(fakeFile('{}', { name: 'b.json.gz.enc' }));
        expect(document.getElementById('adminBackupResult').textContent).toMatch(/still locked/);
        await AdminManager.checkBackupFile(fakeFile('{}', { size: 200 * 1024 * 1024 }));
        expect(document.getElementById('adminBackupResult').textContent).toMatch(/too big/);
        const b = ciBackup();
        b.collections.items.push({ id: 'a', data: {} });
        setLang('hi');
        await AdminManager.checkBackupFile(fakeFile(JSON.stringify(b)));
        expect(document.getElementById('adminBackupResult').textContent).toMatch(/सही बैकअप नहीं/);
        expect(note).not.toHaveBeenCalled();
        expect(localStorage.getItem('happa.restoreDrill')).toBeNull();
    });

    test('only the owner checks; the restore steps are on the card', async () => {
        expect(document.querySelector('#adminBackupCheck .backup-restore-guide li')).not.toBeNull();
        AppState.userRole = 'manager';
        expect(await AdminManager.checkBackupFile(fakeFile(JSON.stringify(ciBackup())))).toBeNull();
    });

    test('the tools README documents the phone check', () => {
        const readme = fs.readFileSync(path.join(__dirname, '../../../tools/backup/README.md'), 'utf8');
        expect(readme).toMatch(/Admin › Data › Check a backup/);
    });
});
