/**
 * @fileoverview Sharing a bill picture (#91): the preview's Download button uses the
 * phone's share sheet when it can share files, and falls back to a plain download when
 * it can't, when sharing fails or when it isn't offered. jsdom has no canvas, so the
 * canvas calls are mocked.
 */
import { PrinterService } from '../services/printer.js';
import { UIManager } from '../ui/ui-manager.js';

const BLOB = { size: 3, type: 'image/png' };
let toast;
let clicked;
let blobResult;

function previewCanvas() {
    const canvas = document.createElement('canvas');
    canvas.width = 384;
    canvas.height = 200;
    return canvas;
}

function downloadButton() {
    const buttons = [...document.body.querySelectorAll('button')];
    return buttons.find(b => b.textContent === 'Download');
}

/** Clicks Download and waits for the toBlob callback to finish. */
async function clickDownload() {
    let done;
    const finished = new Promise(resolve => { done = resolve; });
    HTMLCanvasElement.prototype.toBlob = jest.fn(function (cb) {
        Promise.resolve(cb(blobResult)).then(done, done);
    });
    downloadButton().onclick();
    await finished;
}

beforeAll(() => {
    global.File = class File {
        constructor(parts, name, opts) {
            this.parts = parts;
            this.name = name;
            this.type = opts?.type;
        }
    };
});

beforeEach(() => {
    document.body.innerHTML = '';
    blobResult = BLOB;
    clicked = [];
    HTMLCanvasElement.prototype.getContext = jest.fn(() => ({ fillRect: jest.fn(), drawImage: jest.fn(), fillStyle: '' }));
    HTMLCanvasElement.prototype.toDataURL = jest.fn(() => 'data:image/png;base64,AAAA');
    URL.createObjectURL = jest.fn(() => 'blob:bill');
    URL.revokeObjectURL = jest.fn();
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
        clicked.push({ href: this.href, download: this.download });
    });
    toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    delete navigator.share;
    delete navigator.canShare;
});

afterEach(() => {
    jest.restoreAllMocks();
    delete navigator.share;
    delete navigator.canShare;
});

describe('bill picture: Download / share', () => {
    test('a phone that can share files opens the share sheet with the PNG, no download', async () => {
        navigator.canShare = jest.fn(() => true);
        navigator.share = jest.fn(() => Promise.resolve());
        PrinterService.showImagePreview(previewCanvas(), 'purchase_bill_P1.png', 'Bill');
        await clickDownload();
        expect(navigator.share).toHaveBeenCalledTimes(1);
        const shared = navigator.share.mock.calls[0][0];
        expect(shared.title).toBe('Bill');
        expect(shared.files).toHaveLength(1);
        expect(shared.files[0].name).toBe('purchase_bill_P1.png');
        expect(shared.files[0].type).toBe('image/png');
        expect(clicked).toEqual([]);
    });

    test('no share sheet (desktop browser): the PNG downloads under the bill file name', async () => {
        PrinterService.showImagePreview(previewCanvas(), 'sale_bill_S7.png');
        await clickDownload();
        expect(clicked).toEqual([{ href: 'blob:bill', download: 'sale_bill_S7.png' }]);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:bill');
        expect(document.querySelector('a[download]')).toBeNull();
    });

    test('the phone can share but not files: falls back to the download', async () => {
        navigator.canShare = jest.fn(() => false);
        navigator.share = jest.fn(() => Promise.resolve());
        PrinterService.showImagePreview(previewCanvas(), 'sale_bill_S8.png');
        await clickDownload();
        expect(navigator.share).not.toHaveBeenCalled();
        expect(clicked).toHaveLength(1);
    });

    test('sharing fails: falls back to the download', async () => {
        navigator.canShare = jest.fn(() => true);
        navigator.share = jest.fn(() => Promise.reject(Object.assign(new Error('no app'), { name: 'NotAllowedError' })));
        PrinterService.showImagePreview(previewCanvas(), 'sale_bill_S9.png');
        await clickDownload();
        expect(navigator.share).toHaveBeenCalledTimes(1);
        expect(clicked).toEqual([{ href: 'blob:bill', download: 'sale_bill_S9.png' }]);
    });

    test('the user closes the share sheet: also downloads, so the picture is never lost', async () => {
        navigator.canShare = jest.fn(() => true);
        navigator.share = jest.fn(() => Promise.reject(Object.assign(new Error('cancel'), { name: 'AbortError' })));
        PrinterService.showImagePreview(previewCanvas(), 'sale_bill_S10.png');
        await clickDownload();
        expect(clicked).toHaveLength(1);
    });

    test('the picture could not be made: says so instead of sharing an empty file', async () => {
        blobResult = null;
        navigator.canShare = jest.fn(() => true);
        navigator.share = jest.fn(() => Promise.resolve());
        PrinterService.showImagePreview(previewCanvas(), 'sale_bill_S11.png');
        await clickDownload();
        expect(navigator.share).not.toHaveBeenCalled();
        expect(clicked).toEqual([]);
        expect(toast).toHaveBeenCalledWith(expect.any(String), 'error');
    });

    test('a bill that can not be printed shows the picture preview from the bill canvas', async () => {
        const canvas = previewCanvas();
        jest.spyOn(PrinterService.manager, 'generateBillCanvas').mockResolvedValue(canvas);
        jest.spyOn(PrinterService, 'canPrint').mockReturnValue(false);
        const preview = jest.spyOn(PrinterService, 'showImagePreview');
        await PrinterService.printBill({ billNumber: 'P20261101-001', isPurchase: true, items: [] });
        expect(preview).toHaveBeenCalledWith(canvas, 'purchase_bill_P20261101-001.png', expect.any(String), {});
        expect(downloadButton()).toBeTruthy();
    });
});
