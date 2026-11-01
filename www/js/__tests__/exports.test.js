/**
 * Exports (#103, #85, #83): owner only, a confirm before names leave the app,
 * the shop / period / time / user stamp, an EXPORT audit row; the audit log
 * and the error report go out the same way.
 */
import { jest } from '@jest/globals';
import { exportStamp, stampPairs, stampLine, stampedCsv, exportFilename, exportAuditDetails } from '../utils/export-stamp.js';
import { buildErrorReport, errorReportPeriod, nameScrubber } from '../utils/error-report.js';
import * as UsersRepo from '../firebase/repos/users.js';
import { Exporter } from '../services/exporter.js';
import { AuditService } from '../services/audit.js';
import { UIManager } from '../ui/ui-manager.js';
import { DiagnosticsManager } from '../modules/diagnostics.js';
import { AppState } from '../utils/state.js';
import { formatAuditDetails } from '../utils/audit-changes.js';
import { setLang, resetLangForTests } from '../i18n/index.js';

const AT = new Date(2026, 10, 1, 21, 5).getTime();
const RealBlob = global.Blob;

/** Blob stand-in that keeps its text (jsdom's Blob can't be read synchronously). */
class TextBlob {
    constructor(parts = [], opts = {}) { this.text = parts.join(''); this.type = opts.type || ''; }
}

beforeEach(() => {
    AppState.userRole = 'owner';
    AppState.userName = 'Asha';
    AppState.settings = { shopName: 'Gupta Traders' };
    global.Blob = TextBlob;
});
afterEach(() => {
    global.Blob = RealBlob;
    jest.restoreAllMocks();
    setLang('en');
    resetLangForTests();
});

describe('the export stamp (#103)', () => {
    const stamp = exportStamp({ shop: 'Gupta Traders', period: { from: '2026-10-01', to: '2026-10-31' }, at: AT, user: 'Asha' });

    test('CSV: shop, period, export time and user on top, a blank row, then the header and rows (formulas neutralised)', () => {
        const csv = stampedCsv(['party', 'amount'], [['=cmd', 50]], stamp, 'en');
        expect(csv.split('\r\n')).toEqual(['\uFEFFShop,Gupta Traders', 'Period,2026-10-01 – 2026-10-31', 'Exported,2026-11-01 21:05', 'By,Asha', '', 'party,amount', "'=cmd,50", '']);
    });

    test('labels follow the language asked for; one line for shared text', () => {
        expect(stampPairs(stamp, 'hi').map(p => p[0])).toEqual(['दुकान', 'अवधि', 'निकाला गया', 'किसने']);
        expect(stampLine(stamp, 'en')).toBe('Shop: Gupta Traders · Period: 2026-10-01 – 2026-10-31 · Exported: 2026-11-01 21:05 · By: Asha');
    });

    test('file name: shop (any script), kind, period, time; one day once', () => {
        expect(exportFilename(stamp, 'accountant', 'csv')).toBe('Gupta-Traders_accountant_2026-10-01_2026-10-31_20261101-2105.csv');
        const day = exportStamp({ shop: 'गुप्ता / ट्रेडर्स', period: { from: '2026-10-20', to: '2026-10-20' }, at: AT });
        expect(exportFilename(day, 'day', 'csv')).toBe('गुप्ता-ट्रेडर्स_day_2026-10-20_20261101-2105.csv');
        expect(exportFilename(exportStamp({ shop: '***', at: AT }), 'errors', 'json')).toBe('happa_errors_20261101-2105.json');
    });

    test('audit details are bounded and the audit list says what was exported', () => {
        const d = exportAuditDetails({ kind: 'party', format: 'csv', period: { from: '2026-10-01', to: '2026-10-31' }, rows: 12.7 });
        expect(d).toEqual({ exportKind: 'party', format: 'csv', from: '2026-10-01', to: '2026-10-31', rows: 12, exportStatus: 'done', exportRef: '' });
        expect(exportAuditDetails({ kind: 'nope', format: 'x'.repeat(40) })).toEqual({ exportKind: 'other', format: 'x'.repeat(16), from: null, to: null, rows: 0, exportStatus: 'done', exportRef: '' });
        expect(formatAuditDetails(exportAuditDetails({ kind: 'day', format: 'csv', status: 'started' }), 'EXPORT')).toMatch(/Started/);
        expect(exportAuditDetails({ kind: 'day', format: 'csv', status: 'bogus' }).exportStatus).toBe('done');
        const shown = formatAuditDetails(d, 'EXPORT');
        expect(shown).toMatch(/Exported: Party ledger · CSV/);
        expect(shown).toMatch(/2026-10-01.*2026-10-31/);
        expect(shown).toMatch(/Rows: 12/);
        setLang('hi');
        expect(formatAuditDetails(d, 'EXPORT')).not.toMatch(/Party|Rows/);
    });
});

describe('Exporter.run (#103)', () => {
    test('anyone but the owner is refused before anything is produced or logged', async () => {
        AppState.userRole = 'manager';
        const toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        const note = jest.spyOn(AuditService, 'note').mockImplementation(() => {});
        const produce = jest.fn();
        expect(await Exporter.run({ kind: 'day', format: 'csv', produce })).toBe(false);
        expect(produce).not.toHaveBeenCalled();
        expect(note).not.toHaveBeenCalled();
        expect(toast).toHaveBeenCalledWith('Only the owner can export.', 'error');
    });

    test('names: a cancelled confirm exports nothing; an export is on record before the file goes out, then how it ended', async () => {
        const modal = jest.spyOn(UIManager, 'showModal').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const note = jest.spyOn(AuditService, 'note').mockImplementation(() => {});
        const produce = jest.fn(() => true);
        const job = { kind: 'party', format: 'print', period: { from: '2026-10-01', to: '2026-11-01' }, rows: 3, names: true, produce };
        expect(await Exporter.run(job)).toBe(false);
        expect(produce).not.toHaveBeenCalled();
        expect(await Exporter.run(job)).toBe(true);
        expect(modal.mock.calls[0][0]).toMatch(/customer and supplier names/);
        expect(produce.mock.calls[0][0]).toMatchObject({ shop: 'Gupta Traders', user: 'Asha', from: '2026-10-01', to: '2026-11-01' });
        expect(note.mock.calls.map(c => c[1].exportStatus)).toEqual(['started', 'done']);
        expect(note.mock.calls[0][1]).toMatchObject({ exportKind: 'party', format: 'print', from: '2026-10-01', to: '2026-11-01', rows: 3 });
        expect(note.mock.calls[1][1].exportRef).toBe(note.mock.calls[0][1].exportRef);
        expect(note.mock.calls[0][1].exportRef).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
        expect(produce.mock.invocationCallOrder[0]).toBeGreaterThan(note.mock.invocationCallOrder[0]);
    });

    test('no confirm without names; a share cancelled after it opened (iOS) or a failure is on record too', async () => {
        const modal = jest.spyOn(UIManager, 'showModal');
        const note = jest.spyOn(AuditService, 'note').mockImplementation(() => {});
        expect(await Exporter.run({ kind: 'month', format: 'csv', produce: () => false })).toBe(false);
        expect(modal).not.toHaveBeenCalled();
        expect(note.mock.calls.map(c => c[1].exportStatus)).toEqual(['started', 'cancelled']);
        await expect(Exporter.run({ kind: 'month', format: 'csv', produce: () => { throw new Error('x'); } })).rejects.toThrow('x');
        expect(note.mock.calls.map(c => c[1].exportStatus)).toEqual(['started', 'cancelled', 'started', 'failed']);
    });

    test('saveBlob in the Android app with the share plugins: writes to the app cache and opens the share sheet', async () => {
        global.Blob = RealBlob;
        const writeFile = jest.fn(async () => ({ uri: 'file:///data/cache/exports/x.csv' }));
        const share = jest.fn(async () => ({}));
        const rmdir = jest.fn(async () => { throw new Error('missing'); });
        window.Capacitor = { isNativePlatform: () => true, Plugins: { Filesystem: { writeFile, rmdir }, Share: { share } } };
        expect(Exporter.canShareNative()).toBe(true);
        expect(await Exporter.saveBlob(new Blob(['a,b'], { type: 'text/csv' }), 'x.csv', { shareFirst: false })).toBe(true);
        expect(writeFile).toHaveBeenCalledWith({ path: 'exports/x.csv', data: 'YSxi', directory: 'CACHE', recursive: true });
        expect(rmdir).toHaveBeenCalledWith({ path: 'exports', directory: 'CACHE', recursive: true });
        expect(share).toHaveBeenCalledWith({ title: 'x.csv', files: ['file:///data/cache/exports/x.csv'] });
        const toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        share.mockRejectedValueOnce(new Error('Share canceled'));
        expect(await Exporter.saveBlob(new Blob(['a']), 'x.csv')).toBe(false);
        expect(toast).not.toHaveBeenCalled();
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        share.mockRejectedValueOnce(new Error('No activity'));
        expect(await Exporter.saveBlob(new Blob(['a']), 'x.csv')).toBe(false);
        expect(toast).toHaveBeenCalledWith('The file could not be shared. Try again.', 'error');
        window.Capacitor = { isNativePlatform: () => true, Plugins: {} };
        expect(Exporter.canShareNative()).toBe(false);
        delete window.Capacitor;
        expect(Exporter.canShareNative()).toBe(false);
    });

    test('saveBlob: the Android app shares the file and never falls back to a download it would drop', async () => {
        window.Capacitor = { isNativePlatform: () => true };
        global.File = class { constructor(parts, name, o) { this.name = name; this.type = o.type; } };
        navigator.canShare = () => true;
        navigator.share = jest.fn(async () => {});
        expect(await Exporter.saveBlob(new TextBlob(['a'], { type: 'text/csv' }), 'x.csv', { shareFirst: false })).toBe(true);
        expect(navigator.share.mock.calls[0][0].files[0].name).toBe('x.csv');
        navigator.canShare = () => false;
        const toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        expect(await Exporter.saveBlob(new TextBlob(['a']), 'x.csv')).toBe(false);
        expect(toast).toHaveBeenCalledWith(expect.stringMatching(/website/), 'error');
        expect(await Exporter.saveBlob(new TextBlob(['a']), 'x.json', { quiet: true })).toBe(false);
        expect(toast).toHaveBeenCalledTimes(1);
        delete window.Capacitor;
        delete navigator.canShare;
        delete navigator.share;
    });
});

describe('Diagnostics exports', () => {
    let saved;
    beforeEach(() => {
        saved = [];
        jest.spyOn(Exporter, 'saveBlob').mockImplementation(async (blob, name) => { saved.push({ text: blob.text, name }); return true; });
        jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
    });

    test('audit log CSV (#85): the listed entries with who and details, stamped and audited', async () => {
        const note = jest.spyOn(AuditService, 'note').mockImplementation(() => {});
        DiagnosticsManager.auditFilter = '';
        DiagnosticsManager.auditPeople = new Map([['u1', { name: 'Ravi', role: 'manager', email: '' }]]);
        DiagnosticsManager.auditLogs = [
            { action: 'VOID_BILL', userId: 'u1', userName: 'Ravi', timestamp: new Date(2026, 9, 31, 10, 0).getTime(), details: { billNumber: 'R-7', reason: 'typo' } },
            { action: 'CASH_CLOSE', userId: 'u1', userName: 'Ravi', timestamp: new Date(2026, 9, 30, 19, 30).getTime(), details: {} }
        ];
        expect(await DiagnosticsManager.exportAuditCsv()).toBe(true);
        const lines = saved[0].text.split('\r\n');
        expect(lines[5]).toBe('Time,Action,Who,Details');
        expect(lines[6]).toMatch(/^2026-10-31 10:00,Void Bill,Ravi.*R-7.*typo/);
        expect(saved[0].name).toMatch(/^Gupta-Traders_audit_2026-10-30_2026-10-31_\d{8}-\d{4}\.csv$/);
        expect(note).toHaveBeenLastCalledWith('EXPORT', expect.objectContaining({ exportKind: 'audit', format: 'csv', from: '2026-10-30', to: '2026-10-31', rows: 2, exportStatus: 'done' }));
    });

    test('the audit CSV is English even in Hindi (headers, stamp, actions, details); the printed page follows the app', async () => {
        jest.spyOn(AuditService, 'note').mockImplementation(() => {});
        setLang('hi');
        DiagnosticsManager.auditFilter = '';
        DiagnosticsManager.auditPeople = new Map([['u1', { name: 'Ravi', role: 'manager', email: '' }]]);
        DiagnosticsManager.auditLogs = [{ action: 'VOID_BILL', userId: 'u1', userName: 'Ravi', timestamp: new Date(2026, 9, 31, 10, 0).getTime(), details: { billNumber: 'R-7' } }];
        await DiagnosticsManager.exportAuditCsv();
        const lines = saved[0].text.split('\r\n');
        expect(lines.slice(0, 4).map(l => l.replace('\uFEFF', '').split(',')[0])).toEqual(['Shop', 'Period', 'Exported', 'By']);
        expect(lines[5]).toBe('Time,Action,Who,Details');
        expect(lines[6]).toMatch(/Void Bill,Ravi \(Manager\),Bill: R-7/);
        expect(saved[0].text).not.toMatch(/[\u0900-\u097F]/);
        const doc = { write: jest.fn(), close: jest.fn() };
        jest.spyOn(window, 'open').mockReturnValue({ document: doc, print: jest.fn() });
        await DiagnosticsManager.printAudit();
        expect(doc.write.mock.calls[0][0]).toMatch(/समय/);
    });

    test('an empty list exports nothing', async () => {
        const toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        DiagnosticsManager.auditLogs = [];
        expect(await DiagnosticsManager.exportAuditCsv()).toBe(false);
        expect(toast).toHaveBeenCalledWith('Nothing to export.');
        expect(saved).toEqual([]);
    });

    test('error report (#83): scrubbed again, no names, with the phone status; owner only', async () => {
        const note = jest.spyOn(AuditService, 'note').mockImplementation(() => {});
        jest.spyOn(DiagnosticsManager, 'statusText').mockReturnValue('happa 1.0 · reads 12');
        DiagnosticsManager.filter = 'all';
        DiagnosticsManager.data = [{
            id: 'g1', type: 'uncaught', count: 3, message: 'Failed for ram@example.com 9876543210 ₹5,000', source: 'https://myhappa.web.app/js/x.js?token=abc', line: 12,
            stack: 'Error at eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', userName: 'Ravi', userId: 'u1',
            occurrences: [{ timestamp: 1, userName: 'Ravi' }], lastSeen: new Date(2026, 9, 31, 9).getTime(), firstSeen: new Date(2026, 9, 29, 9).getTime()
        }];
        expect(await DiagnosticsManager.exportErrorReport()).toBe(true);
        expect(UIManager.showModal).not.toHaveBeenCalled();
        const report = JSON.parse(saved[0].text);
        expect(report.status).toBe('happa 1.0 · reads 12');
        expect(report.stamp).toMatchObject({ shop: 'Gupta Traders', user: 'Asha' });
        const text = JSON.stringify(report.errors);
        expect(text).not.toMatch(/ram@example|9876543210|5,000|Ravi|u1|token=abc|eyJhbGci/);
        expect(report.errors[0]).toMatchObject({ type: 'uncaught', count: 3, source: 'https://myhappa.web.app/js/x.js:12' });
        expect(saved[0].name).toMatch(/_errors_2026-10-31_\d{8}-\d{4}\.json$/);
        expect(note).toHaveBeenLastCalledWith('EXPORT', expect.objectContaining({ exportKind: 'errors', format: 'json', from: '2026-10-31', to: '2026-10-31', rows: 1, exportStatus: 'done' }));
        AppState.userRole = 'manager';
        jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        expect(await DiagnosticsManager.exportErrorReport()).toBe(false);
        expect(saved.length).toBe(1);
    });

    test('error report period: oldest to newest last-seen day', () => {
        const day = (ms) => new Date(ms).toISOString().slice(0, 10);
        expect(errorReportPeriod([{ lastSeen: Date.UTC(2026, 9, 3) }, { lastSeen: Date.UTC(2026, 9, 1) }], day)).toEqual({ from: '2026-10-01', to: '2026-10-03' });
        expect(errorReportPeriod([], day)).toEqual({ from: null, to: null });
        expect(buildErrorReport(null).errors).toEqual([]);
    });

    test('error report: the shop\'s people (team list, audit profiles, this user, who saw the error) become <person>', async () => {
        jest.spyOn(AuditService, 'note').mockImplementation(() => {});
        jest.spyOn(DiagnosticsManager, 'statusText').mockReturnValue('signed in as Asha');
        jest.spyOn(UsersRepo, 'readTeamDirectory').mockResolvedValue({ people: { m1: { name: 'Mohan Lal', role: 'manager' }, s1: { name: 'गीता', role: 'staff' } } });
        DiagnosticsManager.filter = 'all';
        DiagnosticsManager.auditPeople = new Map([['p9', { name: 'Kiran', role: 'staff' }]]);
        DiagnosticsManager.data = [{ id: 'g2', type: 'manual', message: 'Mohan Lal and lal-ji, गीता, KIRAN, Seema; Kiranmala stays', stack: 'at Mohan', occurrences: [{ userName: 'Seema' }], lastSeen: Date.now() }];
        await DiagnosticsManager.exportErrorReport();
        const report = JSON.parse(saved[0].text);
        expect(report.errors[0].message).toBe('<person> and lal-ji, <person>, <person>, <person>; Kiranmala stays');
        expect(report.errors[0].stack).toBe('at <person>');
        expect(report.status).toBe('signed in as <person>');
        expect(nameScrubber(['Al', '', null])('Al Pacino')).toBe('Al Pacino');
        const placeholders = buildErrorReport([{ type: 'x', message: 'auth/user-not-found; Unknown error in User list', source: 'https://myhappa.web.app/js/services/user-admin.js', line: 3, userName: 'User', occurrences: [{ userName: 'Unknown' }] }], { names: ['Shop Staff', 'Unknown User'] });
        expect(placeholders.errors[0]).toMatchObject({ message: 'auth/user-not-found; Unknown error in User list', source: 'https://myhappa.web.app/js/services/user-admin.js:3' });
    });
});
