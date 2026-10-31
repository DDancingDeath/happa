/**
 * @fileoverview Printer link (#77): per-job timeouts, reconnect on a dropped
 * link, a limited number of retries with backoff, and the "may have printed"
 * outcome that is never re-sent on its own. Uses a fake Bluetooth transport.
 */
import { PrinterLink } from '../services/printer-link.js';
import { PrinterService } from '../services/printer.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';

const never = () => new Promise(() => {});

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

const TIMEOUTS = { checkMs: 20, connectMs: 30, writeBaseMs: 30, writePerKbMs: 0 };
const BYTES = new Uint8Array([0x1B, 0x40]);

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
        await link.connect('AA:BB', 'Shop printer');
        transport.writePlan = ['hang'];

        await expect(link.send(BYTES)).rejects.toMatchObject({ kind: 'timeout_write', outcome: 'uncertain' });
        expect(transport.calls.write).toBe(1);
        expect(link.status.lastJob).toEqual({ outcome: 'uncertain', at: 1000 });
        expect(link.deviceId).toBeNull();

        await expect(link.send(BYTES, { deviceId: 'AA:BB' })).resolves.toMatchObject({ outcome: 'printed' });
        expect(transport.calls.write).toBe(2);
    });

    test('a connect that never answers gives up after the retry limit, nothing written', async () => {
        const { link, transport, sleeps } = makeLink();
        transport.connectPlan = ['hang', 'hang', 'hang', 'hang'];

        await expect(link.send(BYTES, { deviceId: 'AA:BB' })).rejects.toMatchObject({ kind: 'timeout_connect', outcome: 'failed' });
        expect(transport.calls.connect).toBe(3);
        expect(sleeps).toEqual([1000, 2000]);
        expect(transport.calls.write).toBe(0);
        expect(link.status.lastError).toMatchObject({ kind: 'timeout_connect', at: 1000 });
    });

    test('a dropped link is reconnected before printing', async () => {
        const { link, transport } = makeLink();
        await link.connect('AA:BB', 'Shop printer');
        transport.onDrop(new Error('Device connection was lost'));
        expect(link.deviceId).toBeNull();
        expect(link.status.lastError.kind).toBe('dropped');
        transport.up = false;

        await expect(link.send(BYTES)).resolves.toEqual({ outcome: 'printed', attempts: 1 });
        expect(transport.calls.connect).toBe(2);
        expect(transport.calls.write).toBe(1);
        expect(link.deviceId).toBe('AA:BB');
        expect(link.status.lastError).toBeNull();
    });

    test('a link that went to sleep unnoticed is found by the check and reconnected', async () => {
        const { link, transport } = makeLink();
        await link.connect('AA:BB', 'Shop printer');
        transport.up = false;

        await expect(link.send(BYTES)).resolves.toMatchObject({ outcome: 'printed' });
        expect(transport.calls.isConnected).toBeGreaterThan(0);
        expect(transport.calls.connect).toBe(2);
    });

    test('reconnect is retried with backoff and succeeds on the last allowed attempt', async () => {
        const { link, transport, sleeps } = makeLink();
        transport.connectPlan = ['fail', 'fail', 'ok'];

        await expect(link.send(BYTES, { deviceId: 'AA:BB' })).resolves.toEqual({ outcome: 'printed', attempts: 3 });
        expect(sleeps).toEqual([1000, 2000]);
        expect(transport.calls.write).toBe(1);
    });

    test('retry limit: three refused connects fail the job with the plugin error', async () => {
        const { link, transport } = makeLink();
        transport.connectPlan = ['fail', 'fail', 'fail', 'ok'];

        await expect(link.send(BYTES, { deviceId: 'AA:BB' })).rejects.toMatchObject({ kind: 'connect', outcome: 'failed', message: 'Unable to connect to device' });
        expect(transport.calls.connect).toBe(3);
        expect(transport.calls.write).toBe(0);
    });

    test('a link lost during the write, or a write error, may have printed', async () => {
        const { link, transport } = makeLink();
        await link.connect('AA:BB');
        transport.writePlan = ['drop'];
        await expect(link.send(BYTES)).rejects.toMatchObject({ kind: 'dropped', outcome: 'uncertain' });

        transport.writePlan = ['fail'];
        await expect(link.send(BYTES, { deviceId: 'AA:BB' })).rejects.toMatchObject({ kind: 'write', outcome: 'uncertain' });
        expect(transport.calls.write).toBe(2);
    });

    test('no printer to connect to fails at once', async () => {
        const { link, transport } = makeLink();
        await expect(link.send(BYTES)).rejects.toMatchObject({ kind: 'no_printer', outcome: 'failed' });
        expect(transport.calls.connect).toBe(0);
    });

    test('jobs run one at a time', async () => {
        const { link, transport } = makeLink();
        await link.connect('AA:BB');
        let release;
        transport.write = jest.fn(() => new Promise((resolve) => { release = resolve; }));
        const first = link.send(BYTES);
        const second = link.send(BYTES);
        await new Promise((r) => setTimeout(r, 5));
        expect(transport.write).toHaveBeenCalledTimes(1);
        release();
        await first;
        await new Promise((r) => setTimeout(r, 5));
        expect(transport.write).toHaveBeenCalledTimes(2);
        release();
        await second;
    });
});

describe('PrinterService with the fake transport', () => {
    let transport;
    let modal;
    let toast;
    let preview;
    const bill = { billNumber: 'P-20261031-001', items: [] };

    beforeEach(() => {
        document.body.innerHTML = '<span id="printerStatusText"></span><button id="testPrintBtn"></button><button id="disconnectBtn"></button>';
        transport = new FakeTransport();
        const link = PrinterService.manager.link;
        link.transport = transport;
        link.timeouts = { ...TIMEOUTS };
        link.sleep = () => Promise.resolve();
        link.deviceId = null;
        link.lastDevice = null;
        link.status = { checkedAt: null, lastError: null, lastJob: null };
        PrinterService.uncertainKey = null;
        AppState.printerSettings = { enabled: true, deviceId: 'AA:BB', deviceName: 'Shop printer' };
        jest.spyOn(PrinterService.manager, 'billBytes').mockReturnValue(BYTES);
        modal = jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        jest.spyOn(UIManager, 'showLoading').mockImplementation(() => {});
        jest.spyOn(UIManager, 'hideLoading').mockImplementation(() => {});
        preview = jest.spyOn(PrinterService, 'showBillPreview').mockResolvedValue(true);
    });

    test('after an app restart a bill reconnects to the saved printer and prints', async () => {
        expect(await PrinterService.printBill(bill)).toBe(true);
        expect(transport.calls.connect).toBe(1);
        expect(transport.written).toEqual([BYTES]);
        expect(toast).toHaveBeenCalledWith('✓ Printed successfully');
        expect(preview).not.toHaveBeenCalled();
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
        expect(PrinterService.uncertainKey).toBeNull();
    });

    test('a different bill after a timeout is not held back', async () => {
        transport.writePlan = ['hang'];
        await PrinterService.printBill(bill);
        modal.mockClear();
        expect(await PrinterService.printBill({ ...bill, billNumber: 'P-20261031-002' })).toBe(true);
        expect(modal).not.toHaveBeenCalled();

        transport.writePlan = ['hang'];
        await PrinterService.printBill({ items: [] });
        modal.mockClear();
        expect(await PrinterService.printBill({ items: [] })).toBe(true);
        expect(modal).not.toHaveBeenCalled();
    });

    test('an unreachable printer falls back to the preview and Settings shows the last problem', async () => {
        transport.connectPlan = ['hang', 'hang', 'hang'];
        expect(await PrinterService.printBill(bill)).toBe(true);
        expect(preview).toHaveBeenCalledWith(bill);
        expect(toast).toHaveBeenCalledWith('Print failed: the printer did not connect in time');
        const status = document.getElementById('printerStatusText');
        expect(status.dataset.state).toBe('disconnected');
        expect(status.textContent).toContain('Not connected (last used: Shop printer)');
        expect(status.textContent).toMatch(/Last problem at \d\d:\d\d: the printer did not connect in time/);
    });

    test('Settings shows when a connected printer was last checked', async () => {
        await PrinterService.reconnectSaved();
        await PrinterService.refreshStatus();
        const status = document.getElementById('printerStatusText');
        expect(status.dataset.state).toBe('connected');
        expect(status.textContent).toMatch(/Connected to Shop printer \(checked \d\d:\d\d\)/);
    });

    test('printing disabled in Settings goes straight to the preview', async () => {
        AppState.printerSettings.enabled = false;
        expect(await PrinterService.printBill(bill)).toBe(true);
        expect(transport.calls.connect).toBe(0);
        expect(preview).toHaveBeenCalled();
    });
});
