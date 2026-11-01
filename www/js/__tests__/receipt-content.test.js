/**
 * @fileoverview What the printed bill shows (#107): footer, bill QR, receipt
 * language, print density and logo; plus the small QR encoder.
 */
import fs from 'fs';
import path from 'path';
import { PrinterService } from '../services/printer.js';
import { SettingsManager } from '../modules/settings.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { setLang } from '../i18n/index.js';
import { encodeQr, QR_MAX_BYTES } from '../utils/qr-code.js';
import { billQrText, receiptPayable } from '../utils/bill-share.js';
import { billTotal } from '../utils/money.js';
import {
    effectiveReceipt, hasOwnReceipt, LOGO_BITS_MAX, logoSize, normalizeLogo, normalizeReceiptOptions, normalizeSharedReceipt,
    rasterThreshold, receiptLang, setReceiptOptions, usePrinter
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
    PrinterService.setSharedReceipt(null);
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
    test('a picture is fitted, made black and white and drawn at the top', () => {
        pixel = 0;
        const logo = PrinterService.makeLogo({ naturalWidth: 800, naturalHeight: 400 });
        expect(logo).toMatchObject({ width: 240, height: 120 });
        expect(atob(logo.bits).charCodeAt(0)).toBe(0xFF);
        expect(PrinterService.makeLogo({ naturalWidth: 5000, naturalHeight: 5000 }).bits.length).toBeLessThanOrEqual(LOGO_BITS_MAX);

        images = [];
        PrinterService.manager._renderBillCanvas(bill, 384, { logo });
        expect(images[0]).toMatchObject({ width: 240, height: 120 });
    });

    test('a damaged or too big logo is ignored', () => {
        localStorage.setItem('receiptLogo', JSON.stringify({ width: 8, height: 2, bits: btoa('x') }));
        expect(PrinterService.localLogo()).toBeNull();
        localStorage.setItem('receiptLogo', '{');
        expect(PrinterService.localLogo()).toBeNull();
        expect(normalizeLogo({ width: 384, height: 121, bits: btoa('\0'.repeat(48 * 121)) })).toBeNull();
        expect(normalizeLogo({ width: 8, height: 1, bits: btoa('\xFF'), extra: 1 })).toEqual({ width: 8, height: 1, bits: btoa('\xFF') });
    });
});

describe('shared receipt (settings/app.receipt)', () => {
    const logo = { width: 8, height: 1, bits: btoa('\xFF') };
    const shared = { footer: 'Shop line', qr: true, lang: 'hi', density: 'light', logo };

    test('every phone prints with the shared receipt; this phone\'s own choices only until one is shared', () => {
        AppState.printerSettings = setReceiptOptions({}, { footer: 'Mine', density: 'dark' });
        expect(PrinterService.receiptOptions()).toMatchObject({ footer: 'Mine', threshold: 176, logo: null });
        PrinterService.setSharedReceipt(shared);
        expect(PrinterService.receiptOptions()).toEqual({ footer: 'Shop line', qr: true, lang: 'hi', threshold: 96, logo });
        expect(effectiveReceipt({}, null, null)).toEqual({ footer: '', qr: false, lang: 'app', density: 'normal', logo: null });
        expect(normalizeSharedReceipt(null)).toBeNull();
    });

    test('kept on the phone for an offline start', async () => {
        PrinterService.setSharedReceipt(shared);
        jest.resetModules();
        const { PrinterService: fresh } = await import('../services/printer.js');
        expect(fresh.sharedReceipt()).toEqual(shared);
        PrinterService.setSharedReceipt(null);
        expect(localStorage.getItem('receiptShared')).toBeNull();
    });

    test('only phones with their own choices or logo have something to share', () => {
        expect(hasOwnReceipt({}, null)).toBe(false);
        expect(hasOwnReceipt(setReceiptOptions({}, { qr: true }), null)).toBe(true);
        expect(hasOwnReceipt({}, logo)).toBe(true);
    });
});

describe('Settings › Printed bill', () => {
    const logo1 = { width: 8, height: 1, bits: btoa('\xFF') };
    let save;
    // settings/app.receipt as the server has it; saveReceiptSettings is a transaction over it
    let server;
    beforeEach(() => {
        AppState.userRole = 'owner';
        server = null;
        save = jest.spyOn(FirebaseService, 'saveReceiptSettings').mockImplementation(async (patch, { base, onlyIfMissing } = {}) => {
            if (server && onlyIfMissing) return { receipt: server, applied: false };
            server = normalizeSharedReceipt({ ...(server || base || {}), ...patch });
            return { receipt: server, applied: true };
        });
        jest.spyOn(FirebaseService, 'saveSharedLabourSettings').mockResolvedValue();
    });
    afterEach(() => {
        AppState.userRole = null;
    });

    test('the owner\'s choices are saved for everyone and shown again', async () => {
        document.getElementById('settingReceiptFooter').value = 'Dhanyavaad';
        document.getElementById('settingReceiptQr').checked = true;
        document.getElementById('settingReceiptLang').value = 'hi';
        document.getElementById('settingReceiptDensity').value = 'light';
        await expect(SettingsManager.saveReceiptOptions()).resolves.toBe(true);
        expect(save.mock.calls[0][0]).toEqual({ footer: 'Dhanyavaad', qr: true, lang: 'hi', density: 'light' });
        expect(server).toEqual({ footer: 'Dhanyavaad', qr: true, lang: 'hi', density: 'light', logo: null });
        expect(JSON.parse(localStorage.getItem('printerSettings') || '{}').receipt).toBeUndefined();

        document.body.innerHTML = TEMPLATE;
        SettingsManager.renderReceiptOptions();
        expect(document.getElementById('settingReceiptFooter').value).toBe('Dhanyavaad');
        expect(document.getElementById('settingReceiptQr').checked).toBe(true);
        expect(document.getElementById('settingReceiptLang').value).toBe('hi');
        expect(document.getElementById('settingReceiptFooter').disabled).toBe(false);
        expect(document.getElementById('receiptLogoStatus').textContent).toBe('No logo');
        expect(document.getElementById('receiptLogoRemoveBtn').hidden).toBe(true);
    });

    test('only the changed field is sent: an old copy on this phone never undoes another phone\'s logo', async () => {
        PrinterService.setSharedReceipt({ footer: 'A', qr: false, lang: 'app', density: 'normal', logo: null });
        server = { footer: 'A', qr: false, lang: 'app', density: 'normal', logo: logo1 };
        SettingsManager.renderReceiptOptions();
        document.getElementById('settingReceiptQr').checked = true;
        await expect(SettingsManager.saveReceiptOptions()).resolves.toBe(true);
        expect(save.mock.calls[0][0]).toEqual({ qr: true });
        expect(server).toMatchObject({ qr: true, logo: logo1 });
        expect(PrinterService.receipt()).toMatchObject({ qr: true, logo: logo1 });
        await expect(SettingsManager.saveReceiptOptions()).resolves.toBe(false);
        expect(save).toHaveBeenCalledTimes(1);
    });

    test('a logo is saved for everyone and can be removed', async () => {
        pixel = 0;
        const preview = jest.spyOn(PrinterService, 'showBillPreview').mockResolvedValue();
        const OrigImage = global.Image;
        global.Image = class { set src(v) { this.naturalWidth = 800; this.naturalHeight = 400; this.onload(); } };
        URL.createObjectURL = jest.fn(() => 'blob:x');
        URL.revokeObjectURL = jest.fn();
        try {
            await expect(SettingsManager.chooseReceiptLogo({ files: [{}], value: 'x' })).resolves.toBe(true);
        } finally {
            global.Image = OrigImage;
        }
        expect(Object.keys(save.mock.calls[0][0])).toEqual(['logo']);
        expect(server.logo).toMatchObject({ width: 240, height: 120 });
        expect(preview).toHaveBeenCalled();
        expect(document.getElementById('receiptLogoRemoveBtn').hidden).toBe(false);
        await SettingsManager.removeReceiptLogo();
        expect(save.mock.calls[1][0]).toEqual({ logo: null });
        expect(PrinterService.logo()).toBeNull();
    });

    test('a refused save keeps the shared choices as they were', async () => {
        PrinterService.setSharedReceipt({ footer: 'Old', qr: false, lang: 'app', density: 'normal', logo: null });
        save.mockRejectedValue(Object.assign(new Error('denied'), { code: 'permission-denied' }));
        document.getElementById('settingReceiptFooter').value = 'New';
        await expect(SettingsManager.saveReceiptOptions()).resolves.toBe(false);
        expect(PrinterService.receipt().footer).toBe('Old');
        expect(document.getElementById('settingReceiptFooter').value).toBe('Old');
    });

    test('members see the shared choices but cannot change them', async () => {
        AppState.userRole = 'staff';
        PrinterService.setSharedReceipt({ footer: 'Shop line', qr: true, lang: 'en', density: 'dark', logo: null });
        SettingsManager.renderReceiptOptions();
        expect(document.getElementById('settingReceiptFooter').value).toBe('Shop line');
        expect(document.getElementById('settingReceiptFooter').disabled).toBe(true);
        expect(document.getElementById('settingReceiptDensity').disabled).toBe(true);
        expect(document.getElementById('receiptViewOnly').hidden).toBe(false);
        document.getElementById('settingReceiptFooter').value = 'Mine';
        await expect(SettingsManager.saveReceiptOptions()).resolves.toBe(false);
        expect(save).not.toHaveBeenCalled();
    });

    test('nothing shared yet: the owner is offered this phone\'s choices once, and the button shares them', async () => {
        AppState.printerSettings = setReceiptOptions({}, { footer: 'Mine', qr: true });
        localStorage.setItem('receiptLogo', JSON.stringify(logo1));
        const modal = jest.spyOn(UIManager, 'showModal').mockResolvedValue(false);
        await SettingsManager.applySharedSettings({});
        await expect(SettingsManager.offerReceiptShare()).resolves.toBe(false);
        expect(modal).toHaveBeenCalledTimes(1);
        expect(document.getElementById('receiptShareBtn').hidden).toBe(false);
        await SettingsManager.offerReceiptShare();
        expect(modal).toHaveBeenCalledTimes(1);

        await expect(SettingsManager.shareOwnReceipt()).resolves.toBe(true);
        expect(save).toHaveBeenCalledWith({}, { base: { footer: 'Mine', qr: true, lang: 'app', density: 'normal', logo: logo1 }, onlyIfMissing: true });
        expect(server).toEqual({ footer: 'Mine', qr: true, lang: 'app', density: 'normal', logo: logo1 });
        expect(document.getElementById('receiptShareBtn').hidden).toBe(true);
    });

    test('sharing this phone\'s choices never replaces ones another phone shared meanwhile', async () => {
        AppState.printerSettings = setReceiptOptions({}, { footer: 'Mine' });
        server = { footer: 'Theirs', qr: true, lang: 'en', density: 'dark', logo: null };
        await expect(SettingsManager.shareOwnReceipt()).resolves.toBe(false);
        expect(server.footer).toBe('Theirs');
        expect(PrinterService.receipt().footer).toBe('Theirs');
        expect(UIManager.showToast).toHaveBeenCalledWith(expect.stringContaining('already saved for everyone'));
    });

    test('no offer when the shop already shares a receipt, for members, with nothing of its own, offline or over another question', async () => {
        const modal = jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        await SettingsManager.applySharedSettings({});
        await expect(SettingsManager.offerReceiptShare()).resolves.toBe(false);
        AppState.printerSettings = setReceiptOptions({}, { footer: 'Mine' });
        AppState.userRole = 'staff';
        await expect(SettingsManager.offerReceiptShare()).resolves.toBe(false);
        AppState.userRole = 'owner';
        AppState.modalResolve = () => {};
        await expect(SettingsManager.offerReceiptShare()).resolves.toBe(false);
        AppState.modalResolve = null;
        const online = jest.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        await expect(SettingsManager.offerReceiptShare()).resolves.toBe(false);
        online.mockRestore();
        expect(localStorage.getItem('receiptShareAsked')).toBeNull();
        await SettingsManager.applySharedSettings({ receipt: { footer: 'Shop', qr: false, lang: 'app', density: 'normal', logo: null } });
        await expect(SettingsManager.offerReceiptShare()).resolves.toBe(false);
        expect(modal).not.toHaveBeenCalled();
        expect(PrinterService.receipt().footer).toBe('Shop');
    });

    test('Preview the bill shows the sample bill with the shared options', async () => {
        const gen = jest.spyOn(PrinterService.manager, 'generateBillCanvas').mockResolvedValue({ width: 384, height: 10, toDataURL: () => 'data:,' });
        PrinterService.setSharedReceipt({ footer: 'Thanks' });
        await SettingsManager.previewReceipt();
        expect(gen.mock.calls[0][0]).toMatchObject({ billNumber: 'TEST-1' });
        expect(gen.mock.calls[0][1]).toMatchObject({ footer: 'Thanks' });
    });

    test('sample and walk-in names follow the bill language, not the app language', async () => {
        setLang('hi');
        PrinterService.setSharedReceipt({ lang: 'en' });
        expect(PrinterService.sampleBill()).toMatchObject({ customerName: 'Test Customer', items: [{ name: 'Test Item' }] });
        const print = jest.spyOn(PrinterService, 'printBill').mockResolvedValue(false);
        await PrinterService.printWholesaleSale({ billNumber: 'W-1', items: [], total: 0 });
        expect(print.mock.calls[0][0].customerName).toBe('Walk-in Customer');
    });
});

describe('FirebaseService.saveReceiptSettings (settings/app.receipt)', () => {
    let fake;
    beforeEach(() => {
        fake = createFakeFirestore();
        global.firebase = fake.firebase;
        AppState.currentUser = { uid: 'u1' };
    });
    afterEach(() => {
        delete global.firebase;
        AppState.currentUser = null;
    });
    const stored = () => fake.raw('settings').get('app');

    test('applies only the changed fields onto the receipt saved now; keeps the other settings', async () => {
        fake.raw('settings').set('app', { minClientVersion: 4, receipt: { footer: 'A', qr: false, lang: 'app', density: 'normal', logo: { width: 8, height: 1, bits: btoa('\xFF') } } });
        const res = await FirebaseService.saveReceiptSettings({ qr: true }, { base: { footer: 'stale', logo: null } });
        expect(res).toEqual({ applied: true, receipt: { footer: 'A', qr: true, lang: 'app', density: 'normal', logo: { width: 8, height: 1, bits: btoa('\xFF') } } });
        expect(stored()).toMatchObject({ minClientVersion: 4, receipt: res.receipt, receiptUpdatedBy: 'u1' });
    });

    test('the first share uses the base; "only if missing" leaves a saved receipt alone', async () => {
        const mine = { footer: 'Mine', qr: true, lang: 'hi', density: 'dark', logo: null };
        await expect(FirebaseService.saveReceiptSettings({}, { base: mine, onlyIfMissing: true })).resolves.toEqual({ receipt: mine, applied: true });
        expect(stored().receipt).toEqual(mine);
        const res = await FirebaseService.saveReceiptSettings({}, { base: { ...mine, footer: 'Other' }, onlyIfMissing: true });
        expect(res).toEqual({ receipt: mine, applied: false });
        expect(stored().receipt.footer).toBe('Mine');
    });
});