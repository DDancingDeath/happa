/**
 * @fileoverview Printer setup (#130): 58/80 mm paper, preview before print,
 * several saved printers, Bluetooth off, and one Test Print at a time.
 */
import fs from 'fs';
import path from 'path';
import { PrinterService } from '../services/printer.js';
import { SettingsManager } from '../modules/settings.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import {
    forgetPrinter, MAX_SAVED_PRINTERS, normalizePrinterSettings, paperDots, setPaperWidth, usePrinter
} from '../utils/printer-settings.js';

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'settings.html'), 'utf8');

function fakeContext(canvas) {
    return {
        canvas,
        font: '',
        fillStyle: '',
        textAlign: 'left',
        scale: jest.fn(),
        fillRect: jest.fn(),
        fillText: jest.fn(),
        drawImage: jest.fn(),
        measureText: (s) => ({ width: String(s).length * 8 }),
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) })
    };
}

function mockPlugin({ enabled = true, enableOk = true } = {}) {
    window.bluetoothSerial = {
        connect: jest.fn((id, ok) => ok()),
        disconnect: jest.fn((ok) => ok()),
        isConnected: jest.fn((ok) => ok()),
        isEnabled: jest.fn((ok, fail) => (enabled ? ok() : fail())),
        enable: jest.fn((ok, fail) => (enableOk ? ok() : fail('refused'))),
        list: jest.fn((ok) => ok([])),
        write: jest.fn((bytes, ok) => ok())
    };
}

const bill = {
    billNumber: 'P-7',
    date: '2026-11-01T10:00:00',
    items: [{ name: 'Rice', qty: 10, rate: 20, total: 200 }],
    billTotal: 200,
    isPurchase: true
};

let modal;
let getContext;

beforeEach(() => {
    document.body.innerHTML = TEMPLATE;
    document.getElementById('bluetoothPrinterSection').style.display = 'block';
    delete window.bluetoothSerial;
    localStorage.clear();
    PrinterService.manager.device = null;
    PrinterService.manager.printerName = null;
    PrinterService.manager.link.stopped = false;
    PrinterService.manager.link.lastDevice = null;
    PrinterService.manager.link.status.bluetoothOff = false;
    PrinterService.manager.link.sleep = () => Promise.resolve();
    AppState.printerSettings = { enabled: true, deviceId: null, deviceName: null };
    modal = jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
    jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
    jest.spyOn(UIManager, 'showLoading').mockImplementation(() => {});
    jest.spyOn(UIManager, 'hideLoading').mockImplementation(() => {});
    jest.spyOn(UIManager, 'hapticFeedback').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function () { return fakeContext(this); };
});

afterEach(() => {
    delete window.bluetoothSerial;
    HTMLCanvasElement.prototype.getContext = getContext;
});

describe('printer settings (pure)', () => {
    test('an old single-printer setting becomes a saved 58 mm printer in use', () => {
        const s = normalizePrinterSettings({ enabled: true, deviceId: 'AA', deviceName: 'Shop', paperWidth: 48 });
        expect(s).toEqual({
            enabled: true, deviceId: 'AA', deviceName: 'Shop', previewFirst: false,
            printers: [{ deviceId: 'AA', deviceName: 'Shop', widthMm: 58 }]
        });
        expect(normalizePrinterSettings(null)).toMatchObject({ enabled: false, deviceId: null, printers: [] });
    });

    test('paper width maps to dots; anything else is 58 mm', () => {
        expect(paperDots(58)).toBe(384);
        expect(paperDots(80)).toBe(576);
        expect(paperDots(undefined)).toBe(384);
        expect(paperDots(110)).toBe(384);
    });

    test('use / width / forget keep a short list and the width of a known printer', () => {
        let s = usePrinter({}, { deviceId: 'A', deviceName: 'Counter' });
        s = setPaperWidth(s, 'A', 80);
        s = usePrinter(s, { deviceId: 'B', deviceName: 'Godown' });
        expect(s.deviceId).toBe('B');
        expect(s.printers.map(p => p.deviceId)).toEqual(['B', 'A']);
        s = usePrinter(s, { deviceId: 'A' });
        expect(s).toMatchObject({ deviceId: 'A', deviceName: 'Counter' });
        expect(s.printers[0]).toEqual({ deviceId: 'A', deviceName: 'Counter', widthMm: 80 });
        expect(forgetPrinter(s, 'B')).toMatchObject({ deviceId: 'A', printers: [{ deviceId: 'A' }] });
        expect(forgetPrinter(s, 'A')).toMatchObject({ deviceId: null, deviceName: null, printers: [{ deviceId: 'B' }] });
        for (let i = 0; i < 9; i++) s = usePrinter(s, { deviceId: `X${i}` });
        expect(s.printers).toHaveLength(MAX_SAVED_PRINTERS);
    });
});

describe('80 mm paper', () => {
    test('the bill is drawn 576 dots wide, scaled from the 58 mm layout', () => {
        const { canvas, height } = PrinterService.manager._renderBillCanvas(bill, 576);
        expect(canvas.width).toBe(576);
        const plain = PrinterService.manager._renderBillCanvas(bill, 384);
        expect(plain.canvas.width).toBe(384);
        expect(height).toBe(Math.ceil(plain.height * 1.5));

        const bytes = PrinterService.manager.billBytes(bill, 576);
        expect([bytes[9], bytes[10]]).toEqual([72, 0]);
        expect([PrinterService.manager.billBytes(bill)[9]]).toEqual([48]);
    });

    test('a print job uses the width of the printer in use', async () => {
        mockPlugin();
        AppState.printerSettings = setPaperWidth(usePrinter({ enabled: true }, { deviceId: 'A', deviceName: 'Wide' }), 'A', 80);
        const send = jest.spyOn(PrinterService.manager.link, 'send');
        expect(await PrinterService.printBill(bill)).toBe(true);
        const bytes = send.mock.calls[0][0];
        expect([bytes[9], bytes[10]]).toEqual([72, 0]);
    });

    test('an already drawn receipt canvas is scaled up to 576 dots', async () => {
        mockPlugin();
        AppState.printerSettings = setPaperWidth(usePrinter({ enabled: true }, { deviceId: 'A' }), 'A', 80);
        const canvas = document.createElement('canvas');
        canvas.width = 384;
        canvas.height = 100;
        const send = jest.spyOn(PrinterService.manager.link, 'send');
        await PrinterService.printCanvas(canvas, 'r.png', 'Receipt');
        const bytes = send.mock.calls[0][0];
        expect(bytes[9]).toBe(72);
        expect(bytes[11] + bytes[12] * 256).toBe(150);
    });
});

describe('preview before print', () => {
    const previewCanvas = { width: 384, height: 10, toDataURL: () => 'data:image/png;base64,' };

    beforeEach(() => {
        document.body.innerHTML = '';
        mockPlugin();
        AppState.printerSettings = { ...usePrinter({ enabled: true }, { deviceId: 'A', deviceName: 'P' }), previewFirst: true };
        jest.spyOn(PrinterService.manager, 'generateBillCanvas').mockResolvedValue(previewCanvas);
    });

    const buttons = () => [...document.querySelectorAll('button')].map(b => b.textContent);
    const button = (text) => [...document.querySelectorAll('button')].find(b => b.textContent === text);

    test('shows the bill with Print; nothing prints until Print is tapped', async () => {
        const result = PrinterService.printBill(bill);
        await new Promise(r => setTimeout(r, 0));
        expect(buttons()).toEqual(['Print', 'Download', 'Close']);
        expect(window.bluetoothSerial.write).not.toHaveBeenCalled();
        button('Print').click();
        expect(await result).toBe(true);
        expect(window.bluetoothSerial.write).toHaveBeenCalledTimes(1);
        expect(buttons()).toEqual([]);
    });

    test('Close prints nothing', async () => {
        const result = PrinterService.printBill(bill);
        await new Promise(r => setTimeout(r, 0));
        button('Close').click();
        expect(await result).toBe(false);
        expect(window.bluetoothSerial.write).not.toHaveBeenCalled();
    });

    test('off: prints straight away', async () => {
        AppState.printerSettings = { ...AppState.printerSettings, previewFirst: false };
        expect(await PrinterService.printBill(bill)).toBe(true);
        expect(buttons()).toEqual([]);
    });

    test('the Settings switch is stored on this phone', () => {
        document.body.innerHTML = TEMPLATE;
        const box = document.getElementById('settingPrintPreview');
        box.checked = false;
        SettingsManager.togglePrintPreview();
        expect(JSON.parse(localStorage.getItem('printerSettings')).previewFirst).toBe(false);
        box.checked = true;
        SettingsManager.togglePrintPreview();
        expect(PrinterService.settings().previewFirst).toBe(true);
    });
});

describe('several printers in Settings', () => {
    const rows = () => [...document.querySelectorAll('#savedPrintersList .saved-printer')];

    test('each connected printer is saved; Use switches, the width is per printer, Remove forgets', async () => {
        mockPlugin();
        await SettingsManager.connectToPrinter('A', 'Counter');
        await SettingsManager.connectToPrinter('B', 'Godown');
        expect(rows().map(r => r.dataset.deviceId)).toEqual(['B', 'A']);
        expect(rows()[0].textContent).toContain('in use');
        expect(rows()[0].querySelector('.saved-printer-use')).toBeNull();

        const width = rows()[1].querySelector('.saved-printer-width');
        width.value = '80';
        width.dispatchEvent(new Event('change'));
        expect(JSON.parse(localStorage.getItem('printerSettings')).printers.find(p => p.deviceId === 'A').widthMm).toBe(80);
        expect(PrinterService.paperDots()).toBe(384);

        rows()[1].querySelector('.saved-printer-use').click();
        await new Promise(r => setTimeout(r, 0));
        expect(window.bluetoothSerial.connect).toHaveBeenLastCalledWith('A', expect.any(Function), expect.any(Function));
        expect(PrinterService.settings().deviceId).toBe('A');
        expect(PrinterService.paperDots()).toBe(576);

        rows().find(r => r.dataset.deviceId === 'B').querySelector('.saved-printer-forget').click();
        await new Promise(r => setTimeout(r, 0));
        expect(rows().map(r => r.dataset.deviceId)).toEqual(['A']);
        expect(PrinterService.settings().deviceId).toBe('A');
    });

    test('Disconnect keeps the printer saved, with none in use', async () => {
        mockPlugin();
        await SettingsManager.connectToPrinter('A', 'Counter');
        await SettingsManager.disconnectPrinter();
        expect(PrinterService.settings()).toMatchObject({ deviceId: null, printers: [{ deviceId: 'A' }] });
        expect(rows()).toHaveLength(1);
        expect(rows()[0].querySelector('.saved-printer-use')).not.toBeNull();
    });

    test('printer names are escaped', async () => {
        mockPlugin();
        await SettingsManager.connectToPrinter('A', '<b>x</b>');
        expect(document.getElementById('savedPrintersList').innerHTML).not.toContain('<b>x</b>');
    });
});

describe('Bluetooth off or missing', () => {
    test('the status says Bluetooth is off and Test Print is hidden', async () => {
        mockPlugin({ enabled: false });
        AppState.printerSettings = usePrinter({ enabled: true }, { deviceId: 'A', deviceName: 'P' });
        await SettingsManager.updatePrinterStatus();
        const status = document.getElementById('printerStatusText');
        expect(status.dataset.state).toBe('bluetooth_off');
        expect(status.textContent).toContain('Bluetooth is off on this phone');
        expect(document.getElementById('testPrintBtn').style.display).toBe('none');
    });

    test('Scan asks Android to turn Bluetooth on, and explains when it stays off', async () => {
        mockPlugin({ enabled: false });
        await SettingsManager.scanBluetoothDevices();
        expect(window.bluetoothSerial.enable).toHaveBeenCalledTimes(1);
        expect(window.bluetoothSerial.list).toHaveBeenCalledTimes(1);

        mockPlugin({ enabled: false, enableOk: false });
        await SettingsManager.scanBluetoothDevices();
        expect(window.bluetoothSerial.list).not.toHaveBeenCalled();
        expect(modal).toHaveBeenCalledWith(expect.stringContaining('Bluetooth is off, or this phone has no Bluetooth.'));
    });
});

test('Test Print runs once while a test is printing; the button is disabled meanwhile', async () => {
    mockPlugin();
    AppState.printerSettings = usePrinter({ enabled: true }, { deviceId: 'A', deviceName: 'P' });
    let finish;
    jest.spyOn(PrinterService.manager, 'write').mockImplementation(() => new Promise(r => { finish = r; }));
    const first = SettingsManager.testPrint();
    await new Promise(r => setTimeout(r, 0));
    const btn = document.getElementById('testPrintBtn');
    expect(btn.disabled).toBe(true);
    expect(await SettingsManager.testPrint()).toBe(false);
    expect(PrinterService.manager.write).toHaveBeenCalledTimes(1);
    finish(true);
    expect(await first).toBe(true);
    expect(btn.disabled).toBe(false);
});
