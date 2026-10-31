/**
 * @fileoverview What the printed bill shows (#107): footer, bill QR, receipt
 * language, print density and logo; plus the small QR encoder.
 */
import fs from 'fs';
import path from 'path';
import { PrinterService } from '../services/printer.js';
import { SettingsManager } from '../modules/settings.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { setLang } from '../i18n/index.js';
import { encodeQr, QR_MAX_BYTES } from '../utils/qr-code.js';
import { billQrText, receiptPayable } from '../utils/bill-share.js';
import { billTotal } from '../utils/money.js';
import {
    logoSize, normalizeReceiptOptions, rasterThreshold, receiptLang, setReceiptOptions, usePrinter
} from '../utils/printer-settings.js';

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'settings.html'), 'utf8');

// Reference matrices from the `qrcode` npm package (byte mode, level M, fixed mask).
const REF_V3_MASK2 = ['11111110000011010001001111111', '10000010011011110010001000001', '10111010110101011011001011101', '10111010111000111110101011101', '10111010101000000001001011101', '10000010111100011110101000001', '11111110101010101010101111111', '00000000101000100011100000000', '10111110011110011111001111100', '01110000000111100001011010001', '10000011000101110100110100010', '10101101100011000010010110011', '01011111001110111110100101110', '10101100100000000011001010001', '00010110110010010010101110110', '11010100101100111010010100000', '00101110011000000100110001101', '11111000001011100101011011011', '10001011101001111000110110110', '10000100001011010011110010010', '10111011110010111111111111110', '00000000111110000010100010000', '11111110001100011011101011000', '10000010101110110110100010010', '10111010110110001100111111100', '10111010101101100011010100011', '10111010100001000110001011010', '10000010011011100111110010010', '11111110110001110010010011100'];
const REF_V4_MASK5 = ['111111100011000000000000001111111', '100000101111111011001000001000001', '101110101010110101100110101011101', '101110101010100100010101001011101', '101110100100010101100011001011101', '100000100010000010101000001000001', '111111101010101010101010101111111', '000000001100001000000010100000000', '100000101100111111001011011001110', '100010011111100100010101010110010', '011110111011000110101100001001110', '100101011000101000000010110011110', '110010101100011011101000001000010', '101100001010001011001111011100011', '001111100000010000110100001001110', '101011010100110100010000111001111', '100110101111001011011011010011001', '100011011110000111011111011100011', '110000100000111100010111010010101', '110000011000101001100010110011110', '110011101100110010010011010011001', '100110001110000011101101010110010', '100010110101101110101100001001110', '101101011111010000000010110011101', '111100110101010100000000111110011', '000000001010000110011111100010011', '111111100010111110101101101011110', '100000100000011010001001100011111', '101110100100100000111010111111001', '101110100001001011011111110110011', '101110100010101011110111000010111', '100000100110110110000011001101100', '111111101101000011011011110111010'];
const rows = (qr) => qr.modules.map(r => r.map(b => (b ? '1' : '0')).join(''));

let drawn;
let rects;
let images;
let pixel;
let getContext;

function fakeContext(canvas) {
    return {
        canvas,
        font: '',
        fillStyle: '',
        textAlign: 'left',
        scale: () => {},
        fillRect: (x, y, w, h) => rects.push([x, y, w, h]),
        fillText: (s) => drawn.push(String(s)),
        drawImage: (img) => images.push(img),
        measureText: (s) => ({ width: String(s).length * 9 }),
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: () => {},
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(pixel) })
    };
}

const bill = {
    billNumber: 'P-20261101-7',
    date: '2026-11-01T10:05:00',
    items: [{ itemId: 'i1', name: 'Rice', qty: 10, rate: 20, total: 200 }],
    grandTotal: 200,
    billTotal: 200,
    isPurchase: true
};

beforeEach(() => {
    drawn = [];
    rects = [];
    images = [];
    pixel = 255;
    localStorage.clear();
    setLang('en');
    document.body.innerHTML = TEMPLATE;
    AppState.items = [{ id: 'i1', name: 'Rice', hindiName: 'चावल' }];
    AppState.printerSettings = { enabled: false };
    getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function () { return fakeContext(this); };
    jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    HTMLCanvasElement.prototype.getContext = getContext;
    setLang('en');
});

describe('QR encoder', () => {
    test('matches a reference encoder module for module (versions 3 and 4, two blocks)', () => {
        expect(rows(encodeQr('P-20261101-7 | 01/11/2026 | ₹1,234', { mask: 2 }))).toEqual(REF_V3_MASK2);
        const v4 = encodeQr('y'.repeat(50), { mask: 5 });
        expect(v4.version).toBe(4);
        expect(rows(v4)).toEqual(REF_V4_MASK5);
    });

    test('picks the smallest version and a mask; too long gives null', () => {
        expect(encodeQr('P-7')).toMatchObject({ version: 1, size: 21 });
        expect(encodeQr('z'.repeat(QR_MAX_BYTES))).toMatchObject({ version: 5, size: 37 });
        expect(encodeQr('z'.repeat(QR_MAX_BYTES + 1))).toBeNull();
    });
});

describe('receipt options (pure)', () => {
    test('defaults, limits and unknown values', () => {
        expect(normalizeReceiptOptions(undefined)).toEqual({ footer: '', qr: false, lang: 'app', density: 'normal' });
        expect(normalizeReceiptOptions({ footer: '  Thank\n you  ', qr: 1, lang: 'fr', density: 'max' }))
            .toEqual({ footer: 'Thank you', qr: true, lang: 'app', density: 'normal' });
        expect(normalizeReceiptOptions({ footer: 'x'.repeat(200) }).footer).toHaveLength(80);
        const s = setReceiptOptions({}, { lang: 'hi', density: 'dark' });
        expect(receiptLang(s)).toBe('hi');
        expect(receiptLang({})).toBeUndefined();
        expect(rasterThreshold(s)).toBe(176);
        expect(rasterThreshold({})).toBe(128);
        expect(rasterThreshold(setReceiptOptions({}, { density: 'light' }))).toBe(96);
    });

    test('logo fits 384 × 120 dots and is never enlarged', () => {
        expect(logoSize(1000, 500)).toEqual({ width: 240, height: 120 });
        expect(logoSize(2000, 100)).toEqual({ width: 384, height: 19 });
        expect(logoSize(50, 20)).toEqual({ width: 50, height: 20 });
    });

    test('the QR text carries the bill number, the slip date and the payable (BILL-TOTAL) in rupees', () => {
        expect(receiptPayable(bill)).toBe(billTotal(bill));
        expect(billQrText({ ...bill, grandTotal: 987.5 })).toBe('P-20261101-7 | 01/11/2026 10:05 am | ₹988');
        expect(billQrText({ ...bill, billNumber: '' })).toBe('');
    });
});

describe('the printed bill', () => {
    const render = (receipt) => PrinterService.manager._renderBillCanvas(bill, 384, receipt);

    test('footer line and QR print below the totals; off by default', () => {
        const plain = render({});
        const plainRects = rects.length;
        drawn = [];
        rects = [];
        const withBoth = render({ footer: 'Thank you, visit again', qr: true });
        expect(drawn.slice(-1)).toEqual(['Thank you, visit again']);
        const dark = encodeQr(billQrText(bill)).modules.flat().filter(Boolean).length;
        expect(rects.length - plainRects).toBe(dark);
        expect(withBoth.height).toBeGreaterThan(plain.height + 100);
    });

    test('a long footer wraps instead of running off the paper', () => {
        render({ footer: 'word '.repeat(20).trim() });
        const lines = drawn.filter(s => s.startsWith('word'));
        expect(lines.length).toBeGreaterThan(1);
        lines.forEach(l => expect(l.length * 9).toBeLessThanOrEqual(384 - 8));
    });

    test('no QR without a bill number', () => {
        PrinterService.manager._renderBillCanvas({ ...bill, billNumber: '' }, 384, { qr: true });
        const before = rects.length;
        rects = [];
        PrinterService.manager._renderBillCanvas({ ...bill, billNumber: '' }, 384, {});
        expect(rects.length).toBe(before);
    });

    test('receipt language: English slip on a Hindi app, Hindi slip on an English app', () => {
        setLang('hi');
        render({ lang: 'en' });
        expect(drawn).toContain('Receipt');
        expect(drawn).toContain('Rice');
        expect(drawn).not.toContain('चावल');

        setLang('en');
        drawn = [];
        render({ lang: 'hi' });
        expect(drawn).toContain('रसीद');
        expect(drawn).toContain('चावल');

        drawn = [];
        render({});
        expect(drawn).toContain('Receipt');
        expect(drawn).toContain('चावल');
    });

    test('density sets how dark grey edges print', () => {
        pixel = 150;
        const normal = PrinterService.manager.billBytes(bill, 384, { threshold: 128 });
        const dark = PrinterService.manager.billBytes(bill, 384, { threshold: 176 });
        expect(normal[13]).toBe(0x00);
        expect(dark[13]).toBe(0xFF);
    });

    test('a print job carries this phone\'s receipt options', async () => {
        window.bluetoothSerial = {
            connect: jest.fn((id, ok) => ok()),
            isConnected: jest.fn((ok) => ok()),
            write: jest.fn((bytes, ok) => ok())
        };
        try {
            AppState.printerSettings = setReceiptOptions(usePrinter({ enabled: true }, { deviceId: 'A' }), { density: 'dark', footer: 'Hi', qr: true });
            const write = jest.spyOn(PrinterService.manager, 'write');
            await PrinterService.printBill(bill);
            expect(write.mock.calls[0][1].receipt).toMatchObject({ footer: 'Hi', qr: true, threshold: 176, logo: null });
        } finally {
            delete window.bluetoothSerial;
        }
    });
});

describe('logo', () => {
    test('a picture is stored fitted and black and white, drawn at the top, and can be removed', () => {
        pixel = 0;
        expect(PrinterService.saveLogo({ naturalWidth: 800, naturalHeight: 400 })).toEqual({ ok: true, full: false });
        const logo = PrinterService.logo();
        expect(logo).toMatchObject({ width: 240, height: 120 });
        expect(atob(logo.bits).charCodeAt(0)).toBe(0xFF);

        images = [];
        PrinterService.manager._renderBillCanvas(bill, 384, { logo });
        expect(images[0]).toMatchObject({ width: 240, height: 120 });

        PrinterService.removeLogo();
        expect(PrinterService.logo()).toBeNull();
    });

    test('a damaged stored logo is ignored', () => {
        localStorage.setItem('receiptLogo', JSON.stringify({ width: 8, height: 2, bits: btoa('x') }));
        expect(PrinterService.logo()).toBeNull();
        localStorage.setItem('receiptLogo', '{');
        expect(PrinterService.logo()).toBeNull();
    });
});

describe('Settings › Printed bill', () => {
    test('the fields are saved on this phone and shown again', () => {
        document.getElementById('settingReceiptFooter').value = 'Dhanyavaad';
        document.getElementById('settingReceiptQr').checked = true;
        document.getElementById('settingReceiptLang').value = 'hi';
        document.getElementById('settingReceiptDensity').value = 'light';
        SettingsManager.saveReceiptOptions();
        expect(JSON.parse(localStorage.getItem('printerSettings')).receipt)
            .toEqual({ footer: 'Dhanyavaad', qr: true, lang: 'hi', density: 'light' });

        document.body.innerHTML = TEMPLATE;
        SettingsManager.renderReceiptOptions();
        expect(document.getElementById('settingReceiptFooter').value).toBe('Dhanyavaad');
        expect(document.getElementById('settingReceiptQr').checked).toBe(true);
        expect(document.getElementById('settingReceiptLang').value).toBe('hi');
        expect(document.getElementById('receiptLogoStatus').textContent).toBe('No logo');
        expect(document.getElementById('receiptLogoRemoveBtn').hidden).toBe(true);
    });

    test('Preview the bill shows the sample bill with this phone\'s options', async () => {
        const gen = jest.spyOn(PrinterService.manager, 'generateBillCanvas').mockResolvedValue({ width: 384, height: 10, toDataURL: () => 'data:,' });
        AppState.printerSettings = setReceiptOptions({}, { footer: 'Thanks' });
        await SettingsManager.previewReceipt();
        expect(gen.mock.calls[0][0]).toMatchObject({ billNumber: 'TEST-1' });
        expect(gen.mock.calls[0][1]).toMatchObject({ footer: 'Thanks' });
    });

    test('sample and walk-in names follow the bill language, not the app language', async () => {
        setLang('hi');
        AppState.printerSettings = setReceiptOptions({}, { lang: 'en' });
        expect(PrinterService.sampleBill()).toMatchObject({ customerName: 'Test Customer', items: [{ name: 'Test Item' }] });
        const print = jest.spyOn(PrinterService, 'printBill').mockResolvedValue(false);
        await PrinterService.printWholesaleSale({ billNumber: 'W-1', items: [], total: 0 });
        expect(print.mock.calls[0][0].customerName).toBe('Walk-in Customer');
    });
});
