/**
 * @fileoverview Settings → Bluetooth Printer status and Test Print
 * (AadhatManagementApp#133). The status comes from PrinterService's real connection
 * state; Test Print sends the raster test bill through the manager; on the web
 * (no bluetoothSerial plugin) both say printing works in the Android app.
 */
import fs from 'fs';
import path from 'path';
import { PrinterService } from '../services/printer.js';
import { SettingsManager } from '../modules/settings.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'settings.html'), 'utf8');

let modal;
let toast;
let write;

function mockPlugin({ connectOk = true, linkUp = true } = {}) {
    window.bluetoothSerial = {
        connect: jest.fn((id, ok, fail) => (connectOk ? ok() : fail('refused'))),
        disconnect: jest.fn((ok) => ok()),
        isConnected: jest.fn((ok, fail) => (linkUp ? ok() : fail())),
        list: jest.fn((ok) => ok([])),
        write: jest.fn((bytes, ok) => ok())
    };
}

const status = () => document.getElementById('printerStatusText');
const shown = (id) => document.getElementById(id).style.display !== 'none';

beforeEach(() => {
    document.body.innerHTML = TEMPLATE;
    document.getElementById('bluetoothPrinterSection').style.display = 'block';
    delete window.bluetoothSerial;
    localStorage.clear();
    PrinterService.manager.device = null;
    PrinterService.manager.printerName = null;
    PrinterService.manager.link.stopped = false;
    PrinterService.manager.link.lastDevice = null;
    PrinterService.manager.link.sleep = () => Promise.resolve();
    AppState.printerSettings = { enabled: true, deviceId: null, deviceName: null };
    modal = jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
    toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
    jest.spyOn(UIManager, 'showLoading').mockImplementation(() => {});
    jest.spyOn(UIManager, 'hideLoading').mockImplementation(() => {});
    jest.spyOn(UIManager, 'hapticFeedback').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    write = jest.spyOn(PrinterService.manager, 'write').mockResolvedValue(true);
});

afterEach(() => {
    delete window.bluetoothSerial;
});

describe('on the web (no Bluetooth plugin)', () => {
    test('status says printing works in the Android app; scan, test and disconnect are hidden', async () => {
        AppState.printerSettings.deviceId = 'AA:BB';
        AppState.printerSettings.deviceName = 'Shop printer';
        await SettingsManager.updatePrinterStatus();
        expect(status().textContent).toContain('Printing works in the Android app');
        expect(status().dataset.state).toBe('unavailable');
        expect(shown('scanPrintersBtn')).toBe(false);
        expect(shown('testPrintBtn')).toBe(false);
        expect(shown('disconnectBtn')).toBe(false);
    });

    test('Test Print explains instead of printing', async () => {
        expect(await SettingsManager.testPrint()).toBe(false);
        expect(modal).toHaveBeenCalledWith('Printing works in the Android app.');
        expect(write).not.toHaveBeenCalled();
    });
});

describe('in the Android app', () => {
    test('nothing saved: not connected, only scan is offered', async () => {
        mockPlugin();
        await SettingsManager.updatePrinterStatus();
        expect(status().textContent).toContain('Not connected');
        expect(status().dataset.state).toBe('disconnected');
        expect(shown('scanPrintersBtn')).toBe(true);
        expect(shown('testPrintBtn')).toBe(false);
        expect(shown('disconnectBtn')).toBe(false);
    });

    test('after connecting the status shows the printer and Test Print prints the raster test bill', async () => {
        mockPlugin();
        await SettingsManager.connectToPrinter('AA:BB', 'Shop <printer>');
        expect(window.bluetoothSerial.connect).toHaveBeenCalledWith('AA:BB', expect.any(Function), expect.any(Function));
        expect(status().textContent).toContain('Connected to Shop <printer>');
        expect(status().innerHTML).not.toContain('<printer>');
        expect(status().dataset.state).toBe('connected');
        expect(shown('testPrintBtn')).toBe(true);
        expect(shown('disconnectBtn')).toBe(true);

        expect(await SettingsManager.testPrint()).toBe(true);
        expect(write).toHaveBeenCalledTimes(1);
        expect(write.mock.calls[0][0]).toMatchObject({ isPurchase: true, billTotal: 1000, amountPayable: 1006 });
        expect(toast).toHaveBeenCalledWith('Test print successful!');
    });

    test('Test Print reconnects to the saved printer after an app restart', async () => {
        mockPlugin();
        write.mockRestore();
        jest.spyOn(PrinterService.manager, 'billBytes').mockReturnValue(new Uint8Array([0x1B, 0x40]));
        AppState.printerSettings.deviceId = 'AA:BB';
        AppState.printerSettings.deviceName = 'Shop printer';
        await SettingsManager.updatePrinterStatus();
        expect(status().textContent).toContain('Not connected (last used: Shop printer)');
        expect(shown('testPrintBtn')).toBe(true);

        expect(await SettingsManager.testPrint()).toBe(true);
        expect(window.bluetoothSerial.connect).toHaveBeenCalledWith('AA:BB', expect.any(Function), expect.any(Function));
        expect(window.bluetoothSerial.write).toHaveBeenCalledTimes(1);
        expect(status().dataset.state).toBe('connected');
    });

    test('Test Print retries the saved printer and then says why it could not print', async () => {
        mockPlugin({ connectOk: false });
        write.mockRestore();
        jest.spyOn(PrinterService.manager, 'billBytes').mockReturnValue(new Uint8Array([0x1B, 0x40]));
        AppState.printerSettings.deviceId = 'AA:BB';
        expect(await SettingsManager.testPrint()).toBe(false);
        expect(window.bluetoothSerial.connect).toHaveBeenCalledTimes(3);
        expect(toast).toHaveBeenCalledWith('Test print failed: refused', 'error');
        expect(window.bluetoothSerial.write).not.toHaveBeenCalled();
    });

    test('Test Print with no printer says not connected', async () => {
        mockPlugin();
        write.mockRestore();
        jest.spyOn(PrinterService.manager, 'billBytes').mockReturnValue(new Uint8Array([0x1B, 0x40]));
        expect(await SettingsManager.testPrint()).toBe(false);
        expect(modal).toHaveBeenCalledWith('Printer not connected');
        expect(window.bluetoothSerial.connect).not.toHaveBeenCalled();
    });

    test('a failed print is reported, not thrown', async () => {
        mockPlugin();
        await PrinterService.connect('AA:BB', 'P');
        write.mockRejectedValueOnce(new Error('paper out'));
        expect(await SettingsManager.testPrint()).toBe(false);
        expect(toast).toHaveBeenCalledWith('Test print failed: paper out', 'error');
    });

    test('a dropped link flips the status back to not connected', async () => {
        mockPlugin({ linkUp: false });
        await PrinterService.connect('AA:BB', 'Shop printer');
        AppState.printerSettings.deviceId = 'AA:BB';
        AppState.printerSettings.deviceName = 'Shop printer';
        await SettingsManager.updatePrinterStatus();
        expect(window.bluetoothSerial.isConnected).toHaveBeenCalled();
        expect(PrinterService.isConnected()).toBe(false);
        expect(status().textContent).toContain('Not connected (last used: Shop printer)');
    });

    test('disconnect hides Test Print and Disconnect, and bills stop using the printer', async () => {
        mockPlugin();
        await SettingsManager.connectToPrinter('AA:BB', 'P');
        AppState.printerSettings.enabled = true;
        await SettingsManager.disconnectPrinter();
        expect(PrinterService.isConnected()).toBe(false);
        expect(status().dataset.state).toBe('disconnected');
        expect(shown('testPrintBtn')).toBe(false);
        expect(shown('disconnectBtn')).toBe(false);

        AppState.printerSettings.deviceId = 'AA:BB';
        expect(PrinterService.canPrint()).toBe(false);
        expect(localStorage.getItem('printerDisconnected')).toBe('1');

        await SettingsManager.connectToPrinter('AA:BB', 'P');
        expect(PrinterService.canPrint()).toBe(true);
        expect(localStorage.getItem('printerDisconnected')).toBeNull();
    });
});

test('settings.js reads the connection from PrinterService, not missing facade members', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'settings.js'), 'utf8');
    expect(src).not.toMatch(/window\.app\.printer\.(device|write)\b/);
});
