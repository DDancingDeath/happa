/**
 * Diagnostics › Status (#119) and the speed check (#83).
 */
import { jest } from '@jest/globals';
import {
    analyseProbes, probeAppState, probeNetwork, probeMemory, probeNavigation, probeStorage,
    probeLongTasks, startLongTaskRecorder, _resetLongTasks, approxBytes, SEVERITY_COST
} from '../utils/perf-probe.js';
import { statusRows, statusText, billTraceId, speedLines } from '../utils/status-report.js';
import { setLang } from '../i18n/index.js';
import { DiagnosticsManager } from '../modules/diagnostics.js';
import { AppState } from '../utils/state.js';
import { SyncStatus } from '../ui/sync-status.js';
import { PrinterService } from '../services/printer.js';

const baseStatus = (over = {}) => ({
    appVersion: '1.0.0', buildId: '20261101a-x', deviceId: 'abc123', online: true, connection: '4g',
    pending: 2, lastSyncAt: null, printer: { state: 'saved', lastErrorKind: 'timeout_connect', mayHavePrinted: true },
    reads: 120, writes: 7, writeErrors: 1, readErrors: 0, errors: 3, openedAt: null, ...over
});

describe('speed check probes (#83)', () => {
    afterEach(() => _resetLongTasks());

    test('a healthy phone scores 100 with no suspects', () => {
        const r = analyseProbes({
            network: { online: true, effectiveType: '4g' },
            sw: { supported: true, hasController: true },
            appState: probeAppState({ purchaseHistory: [{ a: 1 }], items: [] }),
            memory: { usedMB: 40, limitMB: 1000, usedRatio: 0.04 },
            longTasks: { count: 0, totalMs: 0 }
        });
        expect(r).toEqual({ score: 100, suspects: [] });
    });

    test('suspects are ranked high first and the score takes off 25 / 12 / 4 (DIAG-SCORE)', () => {
        const r = analyseProbes({
            network: { online: false },
            sw: { supported: true, hasController: false },
            appState: { byName: { salesHistory: { count: 1600 }, items: { count: 900 } } },
            device: { deviceMemoryGB: 2 },
            longTasks: { count: 9, totalMs: 900 }
        });
        expect(r.suspects.map(s => s.severity)).toEqual(['high', 'high', 'med', 'med', 'med', 'low']);
        expect(r.suspects.map(s => s.id)).toEqual(expect.arrayContaining(['offline', 'long_tasks', 'history_growing', 'items_many', 'low_ram', 'no_service_worker']));
        expect(r.score).toBe(100 - 2 * SEVERITY_COST.high - 3 * SEVERITY_COST.med - SEVERITY_COST.low);
        expect(analyseProbes({ appState: { byName: { purchaseHistory: { count: 5000 }, retailSalesHistory: { count: 5000 }, salesHistory: { count: 5000 } } }, network: { online: false }, longTasks: { count: 20 } }).score).toBe(0);
    });

    test('probes return null without their browser API and measure when present', async () => {
        expect(probeMemory({})).toBeNull();
        expect(probeMemory({ memory: { usedJSHeapSize: 104857600, jsHeapSizeLimit: 209715200 } })).toEqual({ usedMB: 100, limitMB: 200, usedRatio: 0.5 });
        expect(probeNetwork({ onLine: false })).toMatchObject({ online: false, effectiveType: null });
        expect(probeNavigation({ getEntriesByType: () => [] })).toBeNull();
        expect(probeNavigation({ getEntriesByType: () => [{ startTime: 0, loadEventEnd: 6200.4, domContentLoadedEventEnd: 900 }] })).toEqual({ pageLoadMs: 6200, domContentLoadedMs: 900 });
        expect(await probeStorage({})).toBeNull();
        expect(await probeStorage({ storage: { estimate: async () => ({ usage: 90 * 1048576, quota: 100 * 1048576 }) } })).toEqual({ usageMB: 90, quotaMB: 100, usedRatio: 0.9 });
        const circular = {}; circular.self = circular;
        expect(approxBytes(circular)).toBeNull();
        expect(probeAppState({ items: [1, 2, 3], stock: { a: 1 } }).byName).toMatchObject({ items: { count: 3 }, stock: { count: 1 } });
    });

    test('long tasks are recorded once started and only the last minute counts', () => {
        let cb = null;
        class Obs { constructor(fn) { cb = fn; } observe() {} }
        expect(startLongTaskRecorder(Obs)).toBe(true);
        cb({ getEntries: () => [{ startTime: 1000, duration: 120 }, { startTime: 70000, duration: 80 }] });
        expect(probeLongTasks(60000, { now: () => 75000 })).toEqual({ count: 1, totalMs: 80 });
    });
});

describe('status rows and copy text (#119)', () => {
    afterEach(() => setLang('en'));

    test('every field is there; the copied text has codes and counts only', () => {
        const rows = statusRows(baseStatus());
        expect(rows.map(r => r.key)).toEqual(['version', 'build', 'device', 'network', 'pending', 'last_sync', 'printer',
            'reads', 'writes', 'write_errors', 'read_errors', 'errors']);
        expect(rows.find(r => r.key === 'network').value).toBe('Online (4g)');
        expect(rows.find(r => r.key === 'printer').value).toBe('Saved, not connected · last bill may have printed · had a problem');
        expect(rows.find(r => r.key === 'last_sync').value).toBe('Not since the app opened');
        const text = statusText(baseStatus({ online: false }), { score: 75, suspects: [{ severity: 'high', id: 'offline', params: {} }] }, Date.UTC(2026, 10, 1, 6));
        expect(text).toContain('Device id: abc123');
        expect(text).toContain('Network: Offline');
        expect(text).toContain('Speed score 75/100');
        expect(text).toContain('The phone is offline: Check Wi-Fi');
        expect(text).not.toMatch(/₹/);
    });

    test('Hindi status and suspects are Hindi', () => {
        setLang('hi');
        const rows = statusRows(baseStatus({ online: false }));
        expect(rows.find(r => r.key === 'network').value).toBe('ऑफ़लाइन');
        const lines = speedLines({ score: 88, suspects: [{ severity: 'med', id: 'history_growing', params: { list: 'salesHistory', count: 1600 } }] });
        expect(lines).toEqual(['गति अंक 88/100', '- काफ़ी थोक बिक्री लोड हैं (1600): अभी ठीक है; बढ़ने पर पुराने फ़ोन धीमे होंगे']);
    });

    test('a bill trace id is the kind letter and the document id', () => {
        expect(billTraceId({ id: 'Ab12', customerName: 'Ramesh', grandTotal: 500 }, 'purchase')).toBe('P-Ab12');
        expect(billTraceId({ id: 7 }, 'wholesale')).toBe('W-7');
        expect(billTraceId({}, 'retail')).toBe('');
    });
});

describe('Diagnostics › Status tab', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="diagnosticsSubtitle"></div><div id="diagnosticsTabsContainer"></div><div id="diagnosticsContainer"></div>';
        AppState.userRole = 'owner';
        AppState.currentUser = { uid: 'u1' };
    });
    afterEach(() => {
        AppState.userRole = null;
        AppState.currentUser = null;
        DiagnosticsManager.speed = null;
        jest.restoreAllMocks();
    });

    test('shows the phone state, runs a speed check and copies the status', async () => {
        jest.spyOn(SyncStatus, 'pendingCount').mockReturnValue(3);
        jest.spyOn(PrinterService, 'linkState').mockReturnValue({ state: 'connected', lastErrorKind: null, mayHavePrinted: false });
        await DiagnosticsManager.showTab('status');
        const html = document.getElementById('diagnosticsContainer');
        expect(document.getElementById('diagnosticsTabsContainer').textContent).toContain('Status');
        expect(html.querySelector('[data-status-row="pending"]').textContent).toContain('3');
        expect(html.querySelector('[data-status-row="printer"]').textContent).toContain('Connected');
        expect(html.querySelector('[data-status-row="device"] [lang="zxx"]')).not.toBeNull();

        await DiagnosticsManager.runSpeedCheck();
        expect(html.querySelector('.diag-speed').textContent).toMatch(/Speed score \d+\/100/);

        const writeText = jest.fn().mockResolvedValue();
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        await DiagnosticsManager.copyStatus();
        expect(writeText.mock.calls[0][0]).toContain('Changes waiting to sync: 3');
        expect(writeText.mock.calls[0][0]).toContain('Speed score');
    });

    test('a manager never gets the Status tab', async () => {
        AppState.userRole = 'manager';
        await DiagnosticsManager.showTab('status');
        expect(document.querySelector('[data-status-row]')).toBeNull();
        expect(document.getElementById('diagnosticsTabsContainer').textContent).not.toContain('Status');
    });
});
