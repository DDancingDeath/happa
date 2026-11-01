/**
 * Rent receipt (RENT-12): WhatsApp text, printer canvas and PDF in one language,
 * stored text cleaned / escaped, electricity only for a meter-billed month,
 * part payments, the reference, the header from Settings, the tenant link,
 * cancelled receipts (reason required), reprint and issuing one later.
 */
jest.mock('../rentals/rent-store.js', () => ({
    snapshot: jest.fn(() => ({ tenants: [{ id: 'T1', name: 'Ram Kumar', phone: '9876543210' }] }))
}));
jest.mock('../rentals/rent-receipt-store.js', () => ({
    listReceipts: jest.fn(),
    withoutReceipt: jest.fn(async () => []),
    issueReceipt: jest.fn(),
    voidReceipt: jest.fn(async () => true)
}));
jest.mock('../services/printer.js', () => ({ PrinterService: { printCanvas: jest.fn(async () => true) } }));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(async () => {}) } }));
jest.mock('../ui/ui-manager.js', () => ({ UIManager: { showToast: jest.fn(), showModal: jest.fn() } }));
jest.mock('../utils/open-external.js', () => ({ openExternal: jest.fn() }));

import * as store from '../rentals/rent-receipt-store.js';
import { PrinterService } from '../services/printer.js';
import { AuditService } from '../services/audit.js';
import { openExternal } from '../utils/open-external.js';
import { setLang, resetLangForTests } from '../i18n/index.js';
import {
    buildReceiptText, receiptRows, drawReceipt, pdfFromJpeg, showReceipt, showHistory, action
} from '../rentals/rent-receipt.js';
import { paidEarlier } from '../rentals/rent-math-ledger.js';

const base = (over = {}) => ({
    id: 'L1_2026-10_0', no: 'R-2026-0007', year: 2026, seq: 7, chargeId: 'L1_2026-10', pi: 0, leaseId: 'L1', tenantId: 'T1',
    unitId: 'U1', propertyId: 'P1', tenantName: 'Ram Kumar', place: '2B, Gupta Bhawan', ut: 'flat', months: ['2026-10'],
    rent: 5000, elec: null, total: 5000, paid: 5000, mode: 'cash', ref: '', date: '2026-10-05', balance: 0,
    by: 'u1', byName: 'Hitesh', biz: 'Sharma Rentals', bizAddr: 'Main Road, Kanpur', createdAt: 1, void: false, ...over
});
const METER = { prev: 100, curr: 150, rate: 8, units: 50, amount: 400 };
const LATIN = /[A-Za-z]/;
const DEVANAGARI = /[\u0900-\u097F]/;

let drawn = [];
beforeAll(() => {
    HTMLCanvasElement.prototype.getContext = function () {
        return {
            fillRect() {}, drawImage() {}, fillText: (s) => drawn.push(String(s)),
            measureText: (s) => ({ width: String(s).length * 10 })
        };
    };
});
beforeEach(() => { drawn = []; jest.clearAllMocks(); });
afterEach(() => { resetLangForTests(); localStorage.clear(); document.body.innerHTML = ''; });

describe('WhatsApp text', () => {
    test('a full payment, electricity included in the rent: the receipt text', () => {
        expect(buildReceiptText(base(), { lang: 'en' })).toBe([
            '🧾 *Rent receipt R-2026-0007*', 'Sharma Rentals', 'Main Road, Kanpur', 'Date: 05/10/2026', '',
            'Tenant: Ram Kumar', '🏠 Flat 2B, Gupta Bhawan', '',
            'Month: Oct 2026', 'Rent: ₹5,000', '*Total: ₹5,000*', '*Paid now: ₹5,000*', 'Paid by: Cash', '*Balance due: ₹0*', '',
            'Received by: Hitesh', '', 'Thank you'
        ].join('\n'));
    });

    test('meter billed by us: previous/current reading, units × rate and the amount, added to the total', () => {
        const text = buildReceiptText(base({ elec: METER, total: 5400, paid: 5400 }), { lang: 'en' });
        expect(text).toContain('Meter reading: 100 to 150\nUnits: 50 × ₹8 per unit\nElectricity: ₹400\n*Total: ₹5,400*');
    });

    test('included in rent or the tenant\'s own meter: no electricity lines', () => {
        const rows = receiptRows(base(), 'en').map(r => r[0]);
        expect(rows).toEqual(['Month', 'Rent', 'Total', 'Paid now', 'Paid by', 'Balance due']);
    });

    test('a part payment shows what was paid earlier, paid now and the balance (with paise)', () => {
        const r = base({ elec: { ...METER, amount: 404.5 }, total: 5404.5, paid: 1000, balance: 2404.5, mode: 'upi' });
        expect(paidEarlier(r)).toBe(2000);
        const text = buildReceiptText(r, { lang: 'en' });
        expect(text).toContain('Paid earlier: ₹2,000\n*Paid now: ₹1,000*\nPaid by: Online (UPI)\n*Balance due: ₹2,404.5*');
    });

    test('one language: Hindi has no English words (only the receipt number), English no Hindi', () => {
        const hi = buildReceiptText(base({
            tenantName: 'राम कुमार', place: 'दो बी, गुप्ता भवन', biz: 'शर्मा किराया', bizAddr: 'मेन रोड, कानपुर', byName: 'हितेश',
            elec: METER, total: 5400, paid: 3000, balance: 2400, mode: 'bank'
        }), { lang: 'hi' });
        expect(hi).toContain('किराया रसीद R-2026-0007');
        expect(hi).toContain('फ़्लैट दो बी');
        expect(hi.replace('R-2026-0007', '')).not.toMatch(LATIN);
        expect(buildReceiptText(base({ elec: METER, total: 5400 }), { lang: 'en' })).not.toMatch(DEVANAGARI);
    });

    test('stored names cannot add WhatsApp formatting or lines', () => {
        const text = buildReceiptText(base({ tenantName: '*Ram*\n_Boss_ ~x~', biz: '`Sharma`', byName: 'Hi\ntesh' }), { lang: 'en' });
        expect(text).toContain('Tenant: Ram Boss x\n');
        expect(text).toContain('\nSharma\n');
        expect(text).toContain('Received by: Hi tesh');
    });

    test('the tenant link is added when it is on; a cancelled receipt says so first', () => {
        const text = buildReceiptText(base({ void: true }), { lang: 'en', link: 'https://myhappa.web.app/r/AbCd' });
        expect(text.startsWith('*CANCELLED*\n')).toBe(true);
        expect(text).toContain('\nSee your rent history: https://myhappa.web.app/r/AbCd\n\nThank you');
        expect(buildReceiptText(base(), { lang: 'en' })).not.toContain('rent history');
    });
});

describe('printer image and PDF', () => {
    test('the canvas has the same lines, in one language', () => {
        setLang('hi');
        drawReceipt(base({ tenantName: 'राम', biz: 'शर्मा किराया', bizAddr: '', place: 'दो बी', byName: 'हितेश', elec: METER, total: 5400 }));
        expect(drawn).toEqual(expect.arrayContaining(['शर्मा किराया', 'किराया रसीद R-2026-0007', 'बिजली', '₹400', 'कुल', '₹5,400']));
        expect(drawn.join(' ').replace('R-2026-0007', '')).not.toMatch(LATIN);
    });

    test('PDF: one page holding the image, with a valid cross-reference table', () => {
        const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
        const pdf = pdfFromJpeg(jpeg, 384, 600);
        const text = Buffer.from(pdf).toString('latin1');
        expect(text.startsWith('%PDF-1.4\n')).toBe(true);
        expect(text).toContain('/MediaBox [0 0 288 450]');
        expect(text).toContain('/Width 384 /Height 600');
        const xref = Number(/startxref\n(\d+)/.exec(text)[1]);
        expect(text.slice(xref, xref + 4)).toBe('xref');
        const offsets = [...text.slice(xref).matchAll(/(\d{10}) 00000 n/g)].map(m => Number(m[1]));
        offsets.forEach((o, i) => expect(text.slice(o, o + 8)).toBe(`${i + 1} 0 obj\n`));
        expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    });
});

describe('dialogs: receipt, reprint from the list, cancel', () => {
    const env = (over = {}) => ({
        dialog: jest.fn(async (html) => { document.body.innerHTML = html; return true; }),
        linkOf: jest.fn(() => 'https://myhappa.web.app/r/AbCd'),
        canVoid: false,
        ...over
    });

    test('names are escaped in the dialog; members see no cancel button', async () => {
        const e = env({ head: { biz: '<b>x</b>', bizAddr: '' } });
        await showReceipt(e, base({ tenantName: '<img src=x onerror=alert(1)>', ref: '<i>UPI</i>' }));
        expect(document.querySelector('img, b')).toBeNull();
        expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');
        expect(document.body.textContent).toContain('Ref<i>UPI</i>');
        expect(document.querySelector('i')).toBeNull();
        expect(document.body.innerHTML).not.toContain("receiptAction('void')");
        expect(e.dialog.mock.calls[0][1]).toEqual({ info: true });
    });

    test('reprint: the tenant\'s list, then any receipt from it without reading again; WhatsApp and print', async () => {
        store.listReceipts.mockResolvedValue([base({ id: 'r2', no: 'R-2026-0009', paid: 1000 }), base()]);
        const e = env();
        await showHistory(e, 'T1');
        expect(store.listReceipts).toHaveBeenCalledWith('T1');
        expect(document.body.textContent).toContain('Receipts: Ram Kumar');
        expect(document.body.textContent).toContain('R-2026-0009');
        expect(document.body.textContent).toContain('R-2026-0007');

        await action(e, 'open', 'r2');
        expect(document.body.textContent).toContain('Rent receipt R-2026-0009');
        expect(store.listReceipts).toHaveBeenCalledTimes(1);

        await action(e, 'wa');
        const url = openExternal.mock.calls[0][0];
        expect(url.startsWith('https://wa.me/919876543210?text=')).toBe(true);
        expect(decodeURIComponent(url.split('text=')[1])).toContain('R-2026-0009');
        expect(decodeURIComponent(url.split('text=')[1])).toContain('See your rent history: https://myhappa.web.app/r/AbCd');
        expect(e.linkOf).toHaveBeenCalledWith('L1');

        await action(e, 'print');
        expect(PrinterService.printCanvas).toHaveBeenCalledWith(expect.anything(), 'R-2026-0009.png', 'Rent receipt R-2026-0009');
    });

    test('owner/manager cancel: asks for a reason, voids it and writes an audit entry; a cancelled one cannot be cancelled again', async () => {
        const e = env({ canVoid: true });
        e.dialog.mockImplementation(async (html) => {
            document.body.innerHTML = html;
            const input = document.getElementById('rentVoidReason');
            if (input) input.value = 'wrong month';
            return true;
        });
        await showReceipt(e, base());
        expect(document.body.innerHTML).toContain("receiptAction('void')");
        await action(e, 'void');
        expect(store.voidReceipt).toHaveBeenCalledWith('L1_2026-10_0', 'wrong month');
        expect(AuditService.log).toHaveBeenCalledWith('RENT_RECEIPT_VOID', { receiptId: 'L1_2026-10_0', no: 'R-2026-0007', reason: 'wrong month' });

        store.voidReceipt.mockClear();
        await showReceipt(e, base({ void: true, voidReason: 'wrong month' }));
        expect(document.body.textContent).toContain('CANCELLED · wrong month');
        expect(document.body.innerHTML).not.toContain("receiptAction('void')");
        await action(e, 'void');
        expect(store.voidReceipt).not.toHaveBeenCalled();
    });
});

describe('reference, header and payments without a receipt', () => {
    const env = (over = {}) => ({
        dialog: jest.fn(async (html) => { document.body.innerHTML = html; return true; }),
        linkOf: jest.fn(() => ''),
        rcOf: jest.fn(() => ({ place: '2B, Gupta Bhawan', ut: 'flat' })),
        canVoid: false,
        head: { biz: 'Sharma Rentals', bizAddr: 'Main Road, Kanpur' },
        ...over
    });

    test('a UPI/cheque reference is a Ref row in the text, the image and the dialog; none when empty', async () => {
        const r = base({ mode: 'cheque', ref: '*00123*' });
        expect(buildReceiptText(r, { lang: 'en' })).toContain('Paid by: Cheque\nRef: 00123\n*Balance due: ₹0*');
        expect(buildReceiptText(r, { lang: 'hi' })).toContain('संदर्भ: 00123');
        drawReceipt(r, 'en');
        expect(drawn).toEqual(expect.arrayContaining(['Ref', '00123']));
        await showReceipt(env(), r);
        expect(document.body.textContent).toContain('Ref00123');
        expect(receiptRows(base(), 'en').map(x => x[0])).not.toContain('Ref');
    });

    test('the header shown is Settings › Rentals (not stored on the receipt)', async () => {
        const e = env({ head: { biz: 'New Name', bizAddr: 'New Road' } });
        await showReceipt(e, base({ biz: undefined, bizAddr: undefined }));
        expect(document.body.textContent).toContain('New Name');
        expect(document.body.textContent).toContain('New Road');
        await action(e, 'wa');
        expect(decodeURIComponent(openExternal.mock.calls[0][0].split('text=')[1])).toContain('\nNew Name\nNew Road\n');
    });

    test('cancel needs a reason: Save stays off until one is typed; an empty one is never sent', async () => {
        let saveState = null;
        const e = env({ canVoid: true });
        e.dialog.mockImplementation((html) => {
            document.body.innerHTML = `<div id="rentDialog"><div>${html}</div><div class="rent-dialog-actions"><button class="rent-btn-primary">Save</button></div></div>`;
            return Promise.resolve(true).then(() => { saveState = document.querySelector('.rent-btn-primary').disabled; return true; });
        });
        await showReceipt(e, base());
        await action(e, 'void');
        expect(saveState).toBe(true);
        expect(store.voidReceipt).not.toHaveBeenCalled();
        expect(document.querySelector('.rent-btn-primary').disabled).toBe(false);

        e.dialog.mockImplementation((html) => {
            document.body.innerHTML = `<div id="rentDialog"><div>${html}</div><div class="rent-dialog-actions"><button class="rent-btn-primary">Save</button></div></div>`;
            const input = document.getElementById('rentVoidReason');
            if (input) {
                input.value = '  wrong tenant ';
                input.dispatchEvent(new Event('input'));
            }
            return Promise.resolve(true).then(() => { saveState = document.querySelector('.rent-btn-primary').disabled; return true; });
        });
        await showReceipt(e, base());
        await action(e, 'void');
        expect(saveState).toBe(false);
        expect(store.voidReceipt).toHaveBeenCalledWith('L1_2026-10_0', 'wrong tenant');
    });

    test('Receipts lists payments without a receipt with Issue receipt; issuing opens the new receipt', async () => {
        const charge = { id: 'L1_2026-09', month: '2026-09', tenantId: 'T1', unitId: 'U1', rent: 5000 };
        store.listReceipts.mockResolvedValue([base()]);
        store.withoutReceipt.mockResolvedValue([{ charge, pi: 1, entry: { amount: 1500, date: '2026-09-12', by: 'u1' } }]);
        store.issueReceipt.mockResolvedValue(base({ id: 'L1_2026-09_1', no: 'R-2026-0008', paid: 1500, issuedBy: 'u1' }));
        const e = env();
        await showHistory(e, 'T1');
        expect(store.withoutReceipt).toHaveBeenCalledWith('T1', false);
        expect(document.body.textContent).toContain('Payments without a receipt');
        expect(document.body.textContent).toContain('12/09/2026');
        expect(document.body.innerHTML).toContain("receiptAction('issue', '0')");
        expect(document.body.textContent).not.toContain('before receipts');

        await action(e, 'issue', '0');
        expect(store.issueReceipt).toHaveBeenCalledWith('L1_2026-09', 1, { place: '2B, Gupta Bhawan', ut: 'flat' });
        expect(e.rcOf).toHaveBeenCalledWith(charge);
        expect(AuditService.log).toHaveBeenCalledWith('RENT_RECEIPT_ISSUE', { chargeId: 'L1_2026-09', pi: 1, no: 'R-2026-0008' });
        expect(document.body.textContent).toContain('Rent receipt R-2026-0008');
    });
});
