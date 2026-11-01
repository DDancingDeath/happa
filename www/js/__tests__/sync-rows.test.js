/**
 * @fileoverview Offline / sync, the rest of #70: the offline pill says how old the data
 * is ("as of HH:MM"), each History / Expenses row says "Waiting to sync" until its
 * document reaches the server and "Saved" after, and closing cash warns while this
 * phone still has unsent changes. All from signals the app already gets (no reads).
 */
import { createSyncStatus, syncStatusText, syncChipHtml, asOfText, SyncStatus, SERVER_DATA_AT_KEY } from '../ui/sync-status.js';
import { buildBillRow, billTableHtml } from '../ui/bill-row.js';
import { CashManagementManager } from '../modules/cash-management.js';
import { UIManager } from '../ui/ui-manager.js';
import { setLang } from '../i18n/index.js';

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

/** A query snapshot with the given pending doc paths. */
const snap = (pendingPaths, { fromCache = false } = {}) => ({
    metadata: { hasPendingWrites: pendingPaths.length > 0, fromCache },
    docs: pendingPaths.map(p => ({ id: p.split('/').pop(), ref: { path: p }, metadata: { hasPendingWrites: true } }))
});

describe('"as of" on the offline pill', () => {
    let online;
    let status;
    let store;
    const pill = () => document.getElementById('syncStatus');
    const go = (on) => { online = on; window.dispatchEvent(new Event(on ? 'online' : 'offline')); };

    beforeEach(() => {
        document.body.innerHTML = '';
        online = true;
        jest.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => online);
        store = new Map();
        const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
        status = createSyncStatus({ win: window, doc: document, storage });
        status.start();
    });
    afterEach(() => {
        status.stop();
        setLang('en');
        jest.restoreAllMocks();
    });

    test('text: offline with a known time, with and without changes waiting', () => {
        expect(syncStatusText({ online: false, pending: 0, asOf: '2:05 pm' })).toBe('Offline · data as of 2:05 pm');
        expect(syncStatusText({ online: false, pending: 2, asOf: '2:05 pm' })).toBe('Offline · data as of 2:05 pm · 2 changes waiting to sync');
        expect(syncStatusText({ online: false, pending: 0 })).toBe('Offline');
        setLang('hi');
        expect(syncStatusText({ online: false, pending: 0, asOf: '2:05 अपराह्न' })).toBe('ऑफ़लाइन · 2:05 अपराह्न तक का डेटा');
    });

    test('the time: of day for today, with the day for an older one', () => {
        const now = new Date(2026, 10, 1, 18, 0).getTime();
        expect(asOfText(new Date(2026, 10, 1, 14, 5).getTime(), now)).toBe('2:05 pm');
        expect(asOfText(new Date(2026, 9, 30, 9, 30).getTime(), now)).toBe('30 Oct, 9:30 am');
        expect(asOfText(null, now)).toBe('');
    });

    test('offline shows when the server last sent data; the time is kept for the next start', () => {
        const at = Date.now() - 60 * 60 * 1000;
        status.noteServerData(at);
        go(false);
        expect(pill().textContent).toBe(`Offline · data as of ${asOfText(at)}`);
        expect(store.get(SERVER_DATA_AT_KEY)).toBe(String(at));

        status.stop();
        const again = createSyncStatus({ win: window, doc: document, storage: { getItem: k => store.get(k) ?? null, setItem: () => {} } });
        again.start();
        expect(pill().textContent).toBe(`Offline · data as of ${asOfText(at)}`);
        again.stop();
    });

    test('never had server data: plain "Offline"', () => {
        go(false);
        expect(pill().textContent).toBe('Offline');
    });
});

describe('per-row sync state', () => {
    let status;
    beforeEach(() => {
        document.body.innerHTML = '';
        jest.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => true);
        status = createSyncStatus({ win: window, doc: document });
        status.start();
    });
    afterEach(() => {
        status.stop();
        setLang('en');
        jest.restoreAllMocks();
    });

    test('a new bill: waiting until the server takes it, then saved', async () => {
        let ack;
        status.trackWrite('purchases/b1', new Promise(r => { ack = r; }));
        expect(status.syncStateOf('b1')).toBe('pending');
        expect(status.syncStateOf('b2')).toBeNull();
        ack();
        await flush();
        expect(status.syncStateOf('b1')).toBe('synced');
    });

    test('a refused write is not called saved', async () => {
        let refuse;
        status.trackWrite('expenses/e1', new Promise((_, r) => { refuse = r; }));
        refuse(new Error('permission-denied'));
        await flush();
        expect(status.syncStateOf('e1')).toBeNull();
    });

    test('a listened document: pending while its snapshot says so; cleared by a snapshot it has nothing to say', () => {
        status.noteSnapshot('L1', snap(['retailSales/s1', 'retailSales/s2']));
        expect(status.syncStateOf('s1')).toBe('pending');
        status.noteSnapshot('L1', snap(['retailSales/s2']));
        expect(status.syncStateOf('s1')).toBeNull();
        expect(status.syncStateOf('s2')).toBe('pending');
    });

    test('refused while a listener also saw it: never "Saved" (the SDK reverts the document)', async () => {
        let refuse;
        status.trackWrite('expenses/e2', new Promise((_, r) => { refuse = r; }));
        status.noteSnapshot('L2', snap(['expenses/e2'], { fromCache: true }));
        expect(status.syncStateOf('e2')).toBe('pending');
        refuse(new Error('permission-denied'));
        await flush();
        status.noteSnapshot('L2', snap([]));
        expect(status.syncStateOf('e2')).toBeNull();
    });

    test('saved, then written again: waiting again until that write is acknowledged', async () => {
        status.trackWrite('purchases/b5', Promise.resolve());
        await flush();
        expect(status.syncStateOf('b5')).toBe('synced');
        status.trackWrite('purchases/b5', new Promise(() => {}));
        expect(status.syncStateOf('b5')).toBe('pending');
    });

    test('chips on screen follow the state', async () => {
        document.body.innerHTML = `<div id="list">${syncChipHtml('b9')}</div>`;
        const chip = () => document.querySelector('.sync-chip');
        status.fillSyncChips(document);
        expect(chip().hidden).toBe(true);
        let ack;
        status.trackWrite('purchases/b9', new Promise(r => { ack = r; }));
        status.fillSyncChips(document);
        expect(chip().hidden).toBe(false);
        expect(chip().textContent).toBe('Waiting to sync');
        expect(chip().dataset.state).toBe('pending');
        ack();
        await flush();
        status.fillSyncChips(document);
        expect(chip().textContent).toBe('Saved');
        expect(chip().dataset.state).toBe('synced');
        setLang('hi');
        status.fillSyncChips(document);
        expect(chip().textContent).toBe('सेव हो गया');
    });

    test('syncChipHtml: nothing for no id; a hidden empty chip for no state; ids are cleaned', () => {
        expect(syncChipHtml('')).toBe('');
        expect(syncChipHtml('a"b<c')).toBe('<span class="sync-chip" data-sync-id="abc" data-state="" hidden></span>');
        expect(syncChipHtml('x1', 'pending')).toBe('<span class="sync-chip" data-sync-id="x1" data-state="pending">Waiting to sync</span>');
    });
});

describe('History rows carry the chip', () => {
    afterEach(() => jest.restoreAllMocks());

    test('card row and table row show "Waiting to sync" for a bill not on the server yet', () => {
        jest.spyOn(SyncStatus, 'syncStateOf').mockImplementation(id => (id === 'p1' ? 'pending' : null));
        const bill = { id: 'p1', billNumber: 'P1', customerName: 'Ram', grandTotal: 100, items: [], date: '2026-11-01T10:00:00' };
        const row = buildBillRow(bill, { onclick: '' });
        expect(row.querySelector('.sync-chip').textContent).toBe('Waiting to sync');
        document.body.innerHTML = billTableHtml([bill, { ...bill, id: 'p2' }], { onclickFor: () => '' });
        const chips = [...document.querySelectorAll('.sync-chip')];
        expect(chips.map(c => c.hidden)).toEqual([false, true]);
    });

    test('an old-app opening record has no chip', () => {
        const row = buildBillRow({ id: 'o1', openingBalance: { due: 50 }, items: [] }, { onclick: '' });
        expect(row.querySelector('.sync-chip')).toBeNull();
    });
});

describe('closing cash with unsent changes (#70)', () => {
    let modal;
    let close;
    beforeEach(() => {
        document.body.innerHTML = '<input id="cashSignOutAmount" value="500"><input id="cashSignOutNotes">';
        jest.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => true);
        jest.spyOn(CashManagementManager, 'calculateExpectedCash').mockReturnValue(500);
        close = jest.spyOn(CashManagementManager, '_closeSession').mockResolvedValue(undefined);
        modal = jest.spyOn(UIManager, 'showModal');
    });
    afterEach(() => jest.restoreAllMocks());

    test('asks first; No keeps the day open', async () => {
        jest.spyOn(SyncStatus, 'pendingCount').mockReturnValue(2);
        modal.mockResolvedValue(false);
        await CashManagementManager.signOut();
        expect(modal).toHaveBeenCalledTimes(1);
        expect(modal.mock.calls[0][0]).toMatch(/2 changes saved on this phone haven't reached the server/);
        expect(close).not.toHaveBeenCalled();
    });

    test('Yes closes as before', async () => {
        jest.spyOn(SyncStatus, 'pendingCount').mockReturnValue(1);
        modal.mockResolvedValue(true);
        await CashManagementManager.signOut();
        expect(modal.mock.calls[0][0]).toMatch(/^1 change saved on this phone/);
        expect(close).toHaveBeenCalledTimes(1);
    });

    test('nothing waiting: no extra question', async () => {
        jest.spyOn(SyncStatus, 'pendingCount').mockReturnValue(0);
        await CashManagementManager.signOut();
        expect(modal).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledTimes(1);
    });
});
