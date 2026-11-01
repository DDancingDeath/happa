/**
 * @fileoverview Printer link (#77): timeouts, one quick reconnect for bills,
 * retries with backoff for Test Print / Connect, one job queue (prints and
 * manual connects), the "may have printed" outcome that is never re-sent on
 * its own, and the user's Disconnect. Uses a fake Bluetooth transport.
 */
import { PrinterLink, LINK_TIMEOUTS } from '../services/printer-link.js';
import { PrinterService, BILL_PRINT_TRIES } from '../services/printer.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';

const never = () => new Promise(() => {});
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

class FakeTransport {
    constructor() {
        this.up = false;
        this.connectPlan = [];
        this.writePlan = [];
        this.calls = { connect: 0, write: 0, isConnected: 0 };
        this.written = [];
        this.onDrop = null;
    }
    available() { return true; }
    canCheck() { return true; }
    connect(id, onDrop) {
        this.calls.connect++;
        const step = this.connectPlan.shift() || 'ok';
        if (step === 'hang') return never();
        if (step === 'fail') return Promise.reject(new Error('Unable to connect to device'));
        if (step === 'denied') return Promise.reject(new Error('Need android.permission.BLUETOOTH_CONNECT permission'));
        this.up = true;
        this.onDrop = onDrop;
        return Promise.resolve();
    }
    disconnect() { this.up = false; return Promise.resolve(); }
    isConnected() { this.calls.isConnected++; return Promise.resolve(this.up); }
    write(bytes) {
        this.calls.write++;
        this.written.push(bytes);
        const step = this.writePlan.shift() || 'ok';
        if (step === 'hang') return never();
        if (step === 'drop') { this.up = false; return Promise.resolve(); }
        if (step === 'fail') return Promise.reject(new Error('Broken pipe'));
        return Promise.resolve();
    }
    list() { return Promise.resolve([]); }
}

const TIMEOUTS = { checkMs: 20, connectMs: 30, quickConnectMs: 30, writeBaseMs: 30, writePerKbMs: 0 };
const BYTES = new Uint8Array([0x1B, 0x40]);
const FULL = { mode: 'full' };

function makeLink(transport = new FakeTransport()) {
    const sleeps = [];
    const link = new PrinterLink({
        transport,
        timeouts: TIMEOUTS,
        sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
        now: () => 1000
    });
    return { link, transport, sleeps };
}

beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('PrinterLink', () => {
    test('a write that never answers times out as "may have printed" and is not re-sent', async () => {
        const { link, transport } = makeLink();
        await link.connectNow('AA:BB', 'Shop printer');
        transport.writePlan = ['hang'];
        const onUncertain = jest.fn();

        await expect(link.send(BYTES, {}, { onUncertain })).rejects.toMatchObject({ kind: 'timeout_write', outcome: 'uncertain' });
        expect(onUncertain).toHaveBeenCalledTimes(1);
        expect(transport.calls.write).toBe(1);
        expect(link.status.lastJob).toEqual({ outcome: 'uncertain', at: 1000 });
        expect(link.deviceId).toBeNull();

        await expect(link.send(BYTES, { deviceId: 'AA:BB' })).resolves.toMatchObject({ outcome: 'printed' });
        expect(transport.calls.write).toBe(2);
    });

    test('a bill makes one quick connect when the link is down, with no retries', async () => {
        const { link, transport, sleeps } = makeLink();
        transport.connectPlan = ['hang', 'hang'];

        await expect(link.send(BYTES, { deviceId: 'AA:BB' })).rejects.toMatchObject({ kind: 'timeout_connect', outcome: 'failed' });
        expect(transport.calls.connect).toBe(1);
        expect(sleeps).toEqual([]);
        expect(transport.calls.write).toBe(0);
    });

    test('Test Print mode: a connect that never answers gives up after 3 tries with backoff', async () => {
        const { link, transport, sleeps } = makeLink();
        transport.connectPlan = ['hang', 'hang', 'hang', 'hang'];

        await expect(link.send(BYTES, { deviceId: 'AA:BB' }, FULL)).rejects.toMatchObject({ kind: 'timeout_connect', outcome: 'failed' });
        expect(transport.calls.connect).toBe(3);
        expect(sleeps).toEqual([1000, 2000]);
        expect(transport.calls.write).toBe(0);
        expect(link.status.lastError).toMatchObject({ kind: 'timeout_connect', at: 1000 });
    });

    test('Test Print mode: succeeds on the last allowed try; three refusals fail', async () => {
        const { link, transport, sleeps } = makeLink();
        transport.connectPlan = ['fail', 'fail', 'ok'];
        await expect(link.send(BYTES, { deviceId: 'AA:BB' }, FULL)).resolves.toEqual({ outcome: 'printed', attempts: 3 });
        expect(sleeps).toEqual([1000, 2000]);

        transport.up = false;
        link.deviceId = null;
        transport.connectPlan = ['fail', 'fail', 'fail', 'ok'];
        await expect(link.send(BYTES, { deviceId: 'AA:BB' }, FULL)).rejects.toMatchObject({ kind: 'connect', message: 'Unable to connect to device' });
        expect(transport.calls.connect).toBe(6);
        expect(transport.calls.write).toBe(1);
    });

    test('a link drop reported by the plugin is reconnected before the next print', async () => {
        const { link, transport } = makeLink();
        await link.connectNow('AA:BB', 'Shop printer');
        transport.onDrop(new Error('Device connection was lost'));
        expect(link.deviceId).toBeNull();
        expect(link.status.lastError.kind).toBe('dropped');
        transport.up = false;

        await expect(link.send(BYTES)).resolves.toEqual({ outcome: 'printed', attempts: 1 });
        expect(transport.calls.connect).toBe(2);
        expect(link.deviceId).toBe('AA:BB');
        expect(link.status.lastError).toBeNull();
    });

    test('a link that went to sleep unnoticed is found by the check and reconnected', async () => {
        const { link, transport } = makeLink();
        await link.connectNow('AA:BB', 'Shop printer');
        transport.up = false;

        await expect(link.send(BYTES)).resolves.toMatchObject({ outcome: 'printed' });
        expect(transport.calls.isConnected).toBeGreaterThan(0);
        expect(transport.calls.connect).toBe(2);
    });

    test('a link lost during the write, or a write error, may have printed', async () => {
        const { link, transport } = makeLink();
        await link.connectNow('AA:BB');
        transport.writePlan = ['drop'];
        await expect(link.send(BYTES)).rejects.toMatchObject({ kind: 'dropped', outcome: 'uncertain' });

        transport.writePlan = ['fail'];
        await expect(link.send(BYTES, { deviceId: 'AA:BB' })).rejects.toMatchObject({ kind: 'write', outcome: 'uncertain' });
        expect(transport.calls.write).toBe(2);
    });

    test('Android refusing the link for a missing permission is its own kind of failure', async () => {
        const { link, transport } = makeLink();
        transport.connectPlan = ['denied'];
        await expect(link.send(BYTES, { deviceId: 'AA:BB' })).rejects.toMatchObject({ kind: 'permission', outcome: 'failed' });
        expect(transport.calls.write).toBe(0);
    });

    test('no printer to connect to fails at once', async () => {
        const { link, transport } = makeLink();
        await expect(link.send(BYTES)).rejects.toMatchObject({ kind: 'no_printer', outcome: 'failed' });
        expect(transport.calls.connect).toBe(0);
    });

    test('prints, manual connects and the may-have-printed check share one queue', async () => {
        const { link, transport } = makeLink();
        await link.connectNow('AA:BB');
        let release;
        transport.write = jest.fn(() => new Promise((resolve) => { release = resolve; }));
        const confirmReprint = jest.fn(async () => true);
        const first = link.send(BYTES);
        const connect = link.connectNow('CC:DD');
        const second = link.send(BYTES, {}, { confirmReprint });
        await flush();
        expect(transport.write).toHaveBeenCalledTimes(1);
        expect(transport.calls.connect).toBe(1);
        expect(confirmReprint).not.toHaveBeenCalled();

        release();
        await first;
        await connect;
        expect(transport.calls.connect).toBe(2);
        expect(link.deviceId).toBe('CC:DD');
        await flush();
        expect(confirmReprint).toHaveBeenCalledTimes(1);
        release();
        await second;
    });

    test('after the user disconnects nothing reconnects until they connect again', async () => {
        const { link, transport } = makeLink();
        await link.connectNow('AA:BB');
        await link.disconnect();
        await expect(link.send(BYTES, { deviceId: 'AA:BB' })).rejects.toMatchObject({ kind: 'stopped', outcome: 'failed' });
        expect(transport.calls.connect).toBe(1);

        await link.connectNow('AA:BB');
        await expect(link.send(BYTES)).resolves.toMatchObject({ outcome: 'printed' });
    });
});

describe('PrinterService with the fake transport', () => {
    let transport;
    let modal;
    let toast;
    let preview;
    const bill = { billNumber: 'P-20261031-001', items: [] };
    const billB = { billNumber: 'P-20261031-002', items: [] };
    const overlayActive = () => document.getElementById('loadingOverlay').classList.contains('active');

    beforeEach(() => {
        localStorage.clear();
        document.body.innerHTML = '<div id="loadingOverlay"></div><span id="printerStatusText"></span><button id="testPrintBtn"></button><button id="disconnectBtn"></button>';
        transport = new FakeTransport();
        const link = PrinterService.manager.link;
        link.transport = transport;
        link.timeouts = { ...TIMEOUTS };
        link.sleep = () => Promise.resolve();
        link.deviceId = null;
        link.lastDevice = null;
        link.stopped = false;
        link.status = { checkedAt: null, lastError: null, lastJob: null };
        AppState.printerSettings = { enabled: true, deviceId: 'AA:BB', deviceName: 'Shop printer' };
        jest.spyOn(PrinterService.manager, 'billBytes').mockReturnValue(BYTES);
        modal = jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        preview = jest.spyOn(PrinterService, 'showBillPreview').mockResolvedValue(true);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('after an app restart a bill reconnects to the saved printer and prints', async () => {
        expect(await PrinterService.printBill(bill)).toBe(true);
        expect(transport.calls.connect).toBe(1);
        expect(transport.written).toEqual([BYTES]);
        expect(toast).toHaveBeenCalledWith('✓ Printed successfully');
        expect(preview).not.toHaveBeenCalled();
        expect(overlayActive()).toBe(false);
    });

    test.each([
        ['after an app restart', false],
        ['with a link that dropped', true]
    ])('printer off %s: the preview opens within 4 s', async (_label, linked) => {
        PrinterService.manager.link.timeouts = { ...LINK_TIMEOUTS };
        if (linked) {
            await PrinterService.connect('AA:BB', 'Shop printer');
            transport.up = false;
        }
        transport.connectPlan = ['hang', 'hang', 'hang'];
        jest.useFakeTimers();
        const done = PrinterService.printBill(bill);
        await jest.advanceTimersByTimeAsync(3000);
        expect(preview).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1000);
        expect(preview).toHaveBeenCalledWith(bill, { onPrint: expect.any(Function) });
        await expect(done).resolves.toBe(true);
        expect(transport.calls.connect).toBe(linked ? 2 : 1);
        expect(toast).toHaveBeenCalledWith('Print failed: the printer did not connect in time');
    });

    test('overlapping bills: a save hiding the spinner or one bill finishing does not hide the other\'s', async () => {
        const releases = [];
        transport.write = jest.fn(() => new Promise((resolve) => releases.push(resolve)));
        const a = PrinterService.printBill(bill);
        const b = PrinterService.printBill(billB);
        await flush();
        UIManager.showLoading();
        UIManager.hideLoading();
        expect(overlayActive()).toBe(true);

        releases[0]();
        await a;
        expect(overlayActive()).toBe(true);
        await flush();
        releases[1]();
        await b;
        expect(overlayActive()).toBe(false);
    });

    test('a timed-out bill shows "may have printed", no preview, and asks before printing it again', async () => {
        transport.writePlan = ['hang'];
        expect(await PrinterService.printBill(bill)).toBe(false);
        expect(transport.calls.write).toBe(1);
        expect(preview).not.toHaveBeenCalled();
        expect(modal).toHaveBeenCalledWith(expect.stringContaining('It may have printed: check the paper before printing again.'), 'May have printed');
        expect(document.getElementById('printerStatusText').textContent).toContain('may have printed: check the paper before printing again');

        modal.mockClear();
        modal.mockResolvedValueOnce(false);
        expect(await PrinterService.printBill(bill)).toBe(false);
        expect(modal).toHaveBeenCalledWith('This may have printed already. Check the paper. Print it again?', 'May have printed', true);
        expect(transport.calls.write).toBe(1);

        expect(await PrinterService.printBill(bill)).toBe(true);
        expect(transport.calls.write).toBe(2);
        expect(PrinterService.uncertainJobs()).toEqual({});
    });

    test('A may have printed, B prints: reprinting A still asks', async () => {
        transport.writePlan = ['hang'];
        await PrinterService.printBill(bill);
        modal.mockClear();
        expect(await PrinterService.printBill(billB)).toBe(true);
        expect(modal).not.toHaveBeenCalled();

        modal.mockResolvedValueOnce(false);
        expect(await PrinterService.printBill(bill)).toBe(false);
        expect(modal).toHaveBeenCalledWith('This may have printed already. Check the paper. Print it again?', 'May have printed', true);
        expect(transport.calls.write).toBe(2);
    });

    test('the may-have-printed list is kept in localStorage for 24 h', async () => {
        transport.writePlan = ['hang'];
        await PrinterService.printBill(bill);
        const stored = JSON.parse(localStorage.getItem('printerMayHavePrinted'));
        expect(Object.keys(stored)).toEqual(['bill:P-20261031-001']);

        const later = Date.now() + 25 * 60 * 60 * 1000;
        jest.spyOn(Date, 'now').mockReturnValue(later);
        modal.mockClear();
        expect(await PrinterService.printBill(bill)).toBe(true);
        expect(modal).not.toHaveBeenCalled();
    });

    test('a reprint queued behind the unanswered original still asks', async () => {
        transport.writePlan = ['hang'];
        modal.mockImplementation(async (message) => !message.includes('Print it again?'));
        const first = PrinterService.printBill(bill);
        const second = PrinterService.printBill(bill);
        expect(await first).toBe(false);
        expect(await second).toBe(false);
        expect(modal).toHaveBeenCalledWith('This may have printed already. Check the paper. Print it again?', 'May have printed', true);
        expect(transport.calls.write).toBe(1);
    });

    test('bills without a number are never held back', async () => {
        transport.writePlan = ['hang'];
        await PrinterService.printBill({ items: [] });
        modal.mockClear();
        expect(await PrinterService.printBill({ items: [] })).toBe(true);
        expect(modal).not.toHaveBeenCalled();
    });

    test('an unreachable printer falls back to the preview and Settings shows the last problem', async () => {
        transport.connectPlan = ['hang'];
        expect(await PrinterService.printBill(bill)).toBe(true);
        expect(preview).toHaveBeenCalledWith(bill, { onPrint: expect.any(Function) });
        const status = document.getElementById('printerStatusText');
        expect(status.dataset.state).toBe('disconnected');
        expect(status.textContent).toContain('Not connected (last used: Shop printer)');
        expect(status.textContent).toMatch(/Last problem at \d\d:\d\d: the printer did not connect in time/);
    });

    test('Settings shows when a connected printer was last checked', async () => {
        await PrinterService.connect('AA:BB', 'Shop printer');
        await PrinterService.refreshStatus();
        const status = document.getElementById('printerStatusText');
        expect(status.dataset.state).toBe('connected');
        expect(status.textContent).toMatch(/Connected to Shop printer \(checked \d\d:\d\d\)/);
    });

    test('after Disconnect bills go to the preview without touching Bluetooth', async () => {
        await PrinterService.connect('AA:BB', 'Shop printer');
        await PrinterService.disconnect();
        expect(await PrinterService.printBill(bill)).toBe(true);
        expect(preview).toHaveBeenCalled();
        expect(transport.calls.connect).toBe(1);
        expect(transport.calls.write).toBe(0);
    });

    test('printer off: Print in the preview tries again; after the last try only the picture is left', async () => {
        transport.connectPlan = Array(BILL_PRINT_TRIES).fill('fail');
        const offers = [];
        preview.mockImplementation(async (_bill, opts = {}) => {
            offers.push(typeof opts.onPrint === 'function');
            return opts.onPrint ? opts.onPrint() : true;
        });
        // Not printed: the caller must not say "saved and printed"
        expect(await PrinterService.printBill(bill)).toBe(false);
        expect(transport.calls.connect).toBe(BILL_PRINT_TRIES);
        expect(offers).toEqual([...Array(BILL_PRINT_TRIES - 1).fill(true), false]);
        expect(toast).toHaveBeenLastCalledWith(`Print failed after ${BILL_PRINT_TRIES} tries: Unable to connect to device. Use the picture, or print it again later from History.`);
        expect(transport.calls.write).toBe(0);
    });

    test('printer back on: Print in the preview prints the bill', async () => {
        transport.connectPlan = ['fail', 'ok'];
        preview.mockImplementationOnce(async (_bill, opts) => opts.onPrint());
        expect(await PrinterService.printBill(bill)).toBe(true);
        expect(transport.written).toEqual([BYTES]);
        expect(toast).toHaveBeenLastCalledWith('✓ Printed successfully');
    });

    describe('Bluetooth permission (Android 12+)', () => {
        let granted;
        let asked;
        beforeEach(() => {
            granted = false;
            asked = 0;
            jest.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 13; Pixel 7) wv');
            window.cordova = { plugins: { permissions: {
                BLUETOOTH_CONNECT: 'android.permission.BLUETOOTH_CONNECT',
                checkPermission: (name, ok) => ok({ hasPermission: granted }),
                requestPermission: (name, ok) => { asked++; granted = true; ok({ hasPermission: true }); }
            } } };
            PrinterService.permissionState = 'unknown';
            PrinterService.permissionBannerClosed = false;
        });
        afterEach(() => {
            delete window.cordova;
            document.getElementById('printerPermissionBanner')?.remove();
        });
        const banner = () => document.getElementById('printerPermissionBanner');

        test('a bill with the permission refused does not touch Bluetooth; the banner asks for it', async () => {
            expect(await PrinterService.printBill(bill)).toBe(true);
            expect(transport.calls.connect).toBe(0);
            expect(preview).toHaveBeenCalledWith(bill, { onPrint: expect.any(Function) });
            expect(toast).toHaveBeenCalledWith('Print failed: Bluetooth permission needed: allow Nearby devices for this app');
            expect(banner().textContent).toContain('The printer needs Bluetooth permission (Nearby devices).');
            expect(document.getElementById('printerStatusText').dataset.state).toBe('permission');

            banner().querySelector('.printer-perm-banner__allow').click();
            await flush();
            expect(asked).toBe(1);
            expect(banner()).toBeNull();
            expect(await PrinterService.printBill(billB)).toBe(true);
            expect(transport.written).toEqual([BYTES]);
        });

        test('Print in the preview after a refusal asks Android first, then prints', async () => {
            preview.mockImplementationOnce(async (_bill, opts) => opts.onPrint());
            expect(await PrinterService.printBill(bill)).toBe(true);
            expect(asked).toBe(1);
            expect(transport.written).toEqual([BYTES]);
            expect(banner()).toBeNull();
        });

        test('Android 11: a link error mentioning permission does not leave "permission needed" behind', async () => {
            jest.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 11; X) wv');
            transport.connectPlan = ['denied'];
            await PrinterService.printBill(bill);
            expect(PrinterService.permissionState).toBe('unknown');
            expect(banner()).toBeNull();
        });

        test('turning the printer off in Settings hides the banner', async () => {
            await PrinterService.bluetoothPermission();
            expect(banner()).not.toBeNull();
            AppState.printerSettings = { ...AppState.printerSettings, enabled: false };
            PrinterService.renderPermissionBanner();
            expect(banner()).toBeNull();
        });

        test('Android still says no: the banner stays and says where to allow it', async () => {
            window.cordova.plugins.permissions.requestPermission = (name, ok) => { asked++; ok({ hasPermission: false }); };
            await PrinterService.bluetoothPermission();
            expect(banner()).not.toBeNull();
            await PrinterService.requestBluetoothPermission();
            expect(asked).toBe(1);
            expect(banner()).not.toBeNull();
            expect(toast).toHaveBeenCalledWith(expect.stringContaining('allow Nearby devices'), 'warning');
        });

        test('× hides the banner; no printer in use, no banner', async () => {
            await PrinterService.bluetoothPermission();
            banner().querySelector('.printer-perm-banner__close').click();
            expect(banner()).toBeNull();
            PrinterService.permissionBannerClosed = false;
            AppState.printerSettings = { enabled: false, deviceId: null };
            await PrinterService.bluetoothPermission();
            expect(banner()).toBeNull();
        });

        test('Android 11 and older have no such permission: nothing is checked', async () => {
            jest.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 11; X) wv');
            expect(await PrinterService.bluetoothPermission()).toBe('unknown');
            expect(banner()).toBeNull();
        });

        test('a link refused for the permission shows the banner too', async () => {
            granted = true;
            transport.connectPlan = ['denied'];
            await PrinterService.printBill(bill);
            granted = false;
            expect(PrinterService.permissionState).toBe('denied');
            expect(banner()).not.toBeNull();
        });
    });

    test('printing disabled in Settings goes straight to the preview', async () => {
        AppState.printerSettings.enabled = false;
        expect(await PrinterService.printBill(bill)).toBe(true);
        expect(transport.calls.connect).toBe(0);
        expect(preview).toHaveBeenCalled();
    });
});
