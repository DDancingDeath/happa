/**
 * Local usage analytics (#136): track() → counters on this phone, Settings › Usage.
 */
import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { isUsageEvent, mergeUsage, topUsage, expiredUsage, usageKey } from '../utils/usage-stats.js';
import { createUsage, localStore, idbStore } from '../services/usage.js';
import { UsageView, usageLabel, PAGE_KEYS } from '../ui/usage-view.js';
import { Usage } from '../services/usage.js';
import { setLang } from '../i18n/index.js';
import { DiagnosticsManager } from '../modules/diagnostics.js';
import { AppState } from '../utils/state.js';
import { todayLocalISO, localISODaysAgo } from '../utils/dates.js';

/** Minimal IndexedDB: one database, one object store, async callbacks like the real one. */
function fakeIndexedDB() {
    const data = new Map();
    const names = new Set();
    const later = (fn) => setTimeout(fn, 0);
    const req = (result) => {
        const r = { result };
        later(() => r.onsuccess && r.onsuccess());
        return r;
    };
    const db = {
        objectStoreNames: { contains: (n) => names.has(n) },
        createObjectStore: (n) => { names.add(n); },
        transaction() {
            const tx = { pending: 0 };
            const done = () => later(() => { if (tx.pending === 0 && tx.oncomplete) tx.oncomplete(); });
            const op = (fn) => { tx.pending++; const r = {}; later(() => { r.result = fn(); if (r.onsuccess) r.onsuccess(); tx.pending--; done(); }); return r; };
            tx.objectStore = () => ({
                getAll: () => op(() => [...data.values()].map(v => ({ ...v }))),
                get: (k) => op(() => data.get(k)),
                put: (v) => op(() => { data.set(v.key, { ...v }); }),
                delete: (k) => op(() => { data.delete(k); }),
                clear: () => op(() => { data.clear(); })
            });
            done();
            return tx;
        }
    };
    return {
        data,
        open() {
            const r = { result: db };
            later(() => { if (r.onupgradeneeded) r.onupgradeneeded(); r.onsuccess(); });
            return r;
        }
    };
}

describe('usage events and counters (USE-1)', () => {
    test('only documented event names count; no free text', () => {
        expect(isUsageEvent('page.billing')).toBe(true);
        expect(isUsageEvent('bill.save.purchases')).toBe(true);
        expect(isUsageEvent('perf.diagnostic_run')).toBe(true);
        expect(isUsageEvent('page.Ramesh 98765')).toBe(false);
        expect(isUsageEvent('bill.save.Ramesh')).toBe(false);
        expect(isUsageEvent('custom')).toBe(false);
        expect(isUsageEvent(42)).toBe(false);
    });

    test('merge adds counts; top lists the range, most used first, ties by name', () => {
        const rows = mergeUsage([{ day: '2026-11-01', event: 'page.day', count: 2 }],
            new Map([[usageKey('2026-11-01', 'page.day'), 3], [usageKey('2026-10-20', 'print.bill'), 9], [usageKey('2026-11-01', 'cash.close'), 5]]));
        expect(rows.find(r => r.event === 'page.day').count).toBe(5);
        expect(topUsage(rows, { fromDay: '2026-10-26', toDay: '2026-11-01' })).toEqual([
            { event: 'cash.close', count: 5 }, { event: 'page.day', count: 5 }
        ]);
        expect(topUsage(rows, { fromDay: '2026-10-01', toDay: '2026-11-01', limit: 1 })).toEqual([{ event: 'print.bill', count: 9 }]);
        expect(expiredUsage(rows, '2026-10-21').map(r => r.event)).toEqual(['print.bill']);
    });
});

describe('track() store', () => {
    beforeEach(() => localStorage.clear());

    test('batches counts and keeps them after a reload (localStorage fallback)', async () => {
        const timers = [];
        const usage = createUsage({ store: localStore(localStorage), setTimer: (fn) => timers.push(fn) });
        usage.track('page.billing');
        usage.track('page.billing');
        usage.track('bill.save.purchases');
        usage.track('Ramesh owes 500');
        expect(timers).toHaveLength(1);
        timers[0]();
        await usage.flush();
        const again = createUsage({ store: localStore(localStorage) });
        const top = topUsage(await again.rows(), { fromDay: todayLocalISO(), toDay: todayLocalISO() });
        expect(top).toEqual([{ event: 'page.billing', count: 2 }, { event: 'bill.save.purchases', count: 1 }]);
        expect(localStorage.getItem('happa.usage')).not.toMatch(/Ramesh|500/);
        await again.clear();
        expect(await again.rows()).toEqual([]);
    });

    test('IndexedDB store adds in one transaction and drops days older than 90', async () => {
        const idb = fakeIndexedDB();
        const store = idbStore(idb);
        await store.add(new Map([[usageKey(todayLocalISO(), 'page.day'), 2], [usageKey(localISODaysAgo(120), 'page.day'), 4]]));
        await store.add(new Map([[usageKey(todayLocalISO(), 'page.day'), 1]]));
        const usage = createUsage({ store });
        const rows = await usage.rows();
        expect(rows).toEqual([expect.objectContaining({ day: todayLocalISO(), event: 'page.day', count: 3 })]);
        await new Promise(r => setTimeout(r, 10));
        expect([...idb.data.keys()]).toEqual([usageKey(todayLocalISO(), 'page.day')]);
    });

    test('Clear wins over a write that fails after it', async () => {
        let rejectAdd;
        let stored = [];
        const store = { add: () => new Promise((_, rej) => { rejectAdd = rej; }), all: async () => stored, dropKeys: async () => {}, clear: async () => { stored = []; } };
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const usage = createUsage({ store, setTimer: () => 1 });
        usage.track('print.bill');
        usage.flush();
        await Promise.resolve();
        const cleared = usage.clear();
        rejectAdd(new Error('quota'));
        await cleared;
        store.add = async (p) => { stored = [...p].map(([k, n]) => ({ day: k.split('|')[0], event: k.split('|')[1], count: n })); };
        expect(await usage.rows()).toEqual([]);
        warn.mockRestore();
    });

    test('a failed write keeps the counts for the next try', async () => {
        let fail = true;
        const saved = [];
        const store = { add: async (p) => { if (fail) throw new Error('quota'); saved.push(new Map(p)); }, all: async () => [], dropKeys: async () => {}, clear: async () => {} };
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const usage = createUsage({ store, setTimer: () => 1 });
        usage.track('print.bill');
        await usage.flush();
        fail = false;
        usage.track('print.bill');
        await usage.flush();
        expect([...saved[0].values()]).toEqual([2]);
        warn.mockRestore();
    });
});

describe('Settings › Usage on this phone', () => {
    beforeEach(() => {
        localStorage.clear();
        document.body.innerHTML = `<div id="usageRange"><button data-range="today"></button><button data-range="week"></button></div><div id="usageList"></div>`;
        UsageView.range = 'week';
    });
    afterEach(() => { setLang('en'); jest.restoreAllMocks(); });

    test('lists the most used features in the app language and copies them', async () => {
        jest.spyOn(Usage, 'rows').mockResolvedValue([
            { day: todayLocalISO(), event: 'page.billing', count: 4 },
            { day: todayLocalISO(), event: 'bill.save.retailSales', count: 2 },
            { day: localISODaysAgo(10), event: 'print.bill', count: 7 }
        ]);
        await UsageView.render();
        const items = [...document.querySelectorAll('#usageList li')].map(li => li.textContent.replace(/\s+/g, ' ').trim());
        expect(items).toEqual(['Billing opened 4', 'Retail sale saved 2']);
        await UsageView.setRange('month');
        expect(document.querySelector('#usageList li').textContent).toContain('Bill printed');

        const writeText = jest.fn().mockResolvedValue();
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        await UsageView.copy();
        expect(writeText.mock.calls[0][0]).toBe('Usage on this phone, Last 30 days\nBill printed: 7\nBilling opened: 4\nRetail sale saved: 2');

        setLang('hi');
        expect(usageLabel('page.billing')).toBe('बिलिंग खोला');
        expect(usageLabel('cash.close')).toBe('नकद दिन बंद');
    });

    test('every page has a name (no raw page id on screen)', () => {
        const dir = path.join(__dirname, '..', '..', 'templates');
        const ids = fs.readdirSync(dir).flatMap(f => {
            const host = document.createElement('div');
            host.innerHTML = fs.readFileSync(path.join(dir, f), 'utf8');
            return [...host.querySelectorAll('.tab[id]')].map(el => el.id);
        });
        expect(ids.length).toBeGreaterThan(15);
        expect(ids.filter(id => !PAGE_KEYS[id])).toEqual([]);
    });

    test('the Diagnostics speed check counts perf.diagnostic_run (#83)', async () => {
        const spy = jest.spyOn(Usage, 'track').mockImplementation(() => {});
        AppState.userRole = 'owner';
        await DiagnosticsManager.runSpeedCheck();
        AppState.userRole = null;
        expect(spy).toHaveBeenCalledWith('perf.diagnostic_run');
    });

    test('nothing counted yet', async () => {
        jest.spyOn(Usage, 'rows').mockResolvedValue([]);
        await UsageView.render();
        expect(document.getElementById('usageList').textContent).toContain('Nothing counted yet.');
    });
});
