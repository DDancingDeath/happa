/**
 * @fileoverview A lighter Billing form: what shows only when it is needed. The rest row only
 * while the split is off, the date line with "Change date" for the owner, notes behind "Add note",
 * Drafts only with drafts, the bill's lines only with lines, labour's working only when it is on.
 * Runs on the real billing.html.
 */
import fs from 'fs';
import path from 'path';
import { BillingManager } from '../modules/billing.js';
import { PurchaseManager } from '../modules/purchase.js';
import { RetailSaleManager } from '../modules/retail-sale.js';
import * as BillDrafts from '../firebase/repos/bill-drafts.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { Helpers } from '../utils/helpers.js';
import { backdatedText, prepareBillDate, renderBillDateLine, resetBillDate, revealBillDate } from '../ui/bill-date-input.js';
import { addLocalDays, formatDate, toLocalISODate } from '../utils/dates.js';
import { validatePaymentSplit } from '../utils/calc/billing.js';
import { showLastSaved } from '../ui/last-saved.js';

jest.mock('../firebase/repos/bill-drafts.js', () => ({
    getAutoSave: jest.fn(),
    saveAutoSave: jest.fn().mockResolvedValue(undefined),
    deleteAutoSave: jest.fn().mockResolvedValue(undefined),
    saveDraft: jest.fn().mockResolvedValue(undefined),
    countDrafts: jest.fn().mockResolvedValue(0)
}));

const TEMPLATES = path.join(__dirname, '..', '..', 'templates');
const BILLING = fs.readFileSync(path.join(TEMPLATES, 'billing.html'), 'utf8');
const WHOLESALE = fs.readFileSync(path.join(TEMPLATES, 'wholesale-sales.html'), 'utf8');

const $ = (id) => document.getElementById(id);
const rice = (kg = 10, rate = 25) => ({ name: 'Rice', itemId: 'rice', qty: kg, rate, total: kg * rate, weights: [kg] });
const typeIn = (id, value) => { $(id).value = String(value); };

beforeEach(() => {
    document.body.innerHTML = `<main>${BILLING}</main><div id="modalOverlay"></div>`;
    global.firebase = { auth: () => ({ currentUser: { uid: 'u1' } }) };
    jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
    jest.spyOn(UIManager, 'hapticFeedback').mockImplementation(() => {});
    window.matchMedia = jest.fn(() => ({ matches: false }));
    AppState.currentUser = { uid: 'u1' };
    AppState.userRole = 'owner';
    AppState.settings = {};
    AppState.items = [];
    AppState.purchaseHistory = [];
    AppState.retailSalesHistory = [];
    BillingManager.init();
    BillingManager.currentMode = 'purchase';
    BillingManager.editingBillIndex = undefined;
});

afterEach(() => {
    jest.restoreAllMocks();
    PurchaseManager.setBillItems([]);
    PurchaseManager.setPendingBill(null);
    RetailSaleManager.setSaleItems([]);
    RetailSaleManager.setPendingBill(null);
    BillingManager.editingBillIndex = undefined;
    delete global.firebase;
});

describe('1. "Not split yet" shows only while some of the bill is not split', () => {
    const restRow = (id) => $(id).closest('.pay-rest');

    test('purchase: hidden at ₹0 left, shown with the amount left or over, live as amounts change', () => {
        expect(restRow('purchaseSplitRemaining').hidden).toBe(true);
        PurchaseManager.setBillItems([rice(10, 25)]);
        PurchaseManager.renderBill();
        expect(restRow('purchaseSplitRemaining').hidden).toBe(false);
        expect($('purchaseSplitRemaining').textContent).toContain('250');

        typeIn('cashPayment', 200);
        PurchaseManager.updatePaymentTotal();
        expect(restRow('purchaseSplitRemaining').hidden).toBe(false);
        expect($('purchaseSplitRemaining').textContent).toContain('50');

        typeIn('dueAmount', 50);
        PurchaseManager.updatePaymentTotal();
        expect(restRow('purchaseSplitRemaining').hidden).toBe(true);

        typeIn('onlinePayment', 10);
        PurchaseManager.updatePaymentTotal();
        expect(restRow('purchaseSplitRemaining').hidden).toBe(false);
        expect($('purchaseSplitRemaining').dataset.split).toBe('off');
    });

    test('labour changes the payable, and the row follows it', () => {
        PurchaseManager.setBillItems([rice(10, 25)]);
        PurchaseManager.renderBill();
        typeIn('cashPayment', 250);
        PurchaseManager.updatePaymentTotal();
        expect(restRow('purchaseSplitRemaining').hidden).toBe(true);
        $('manualLaborCharges').dataset.manuallySet = 'true';
        typeIn('manualLaborCharges', 20);
        PurchaseManager.updateTotals();
        expect(restRow('purchaseSplitRemaining').hidden).toBe(false);
        expect($('amountPayable').textContent).toBe('230');
    });

    test('retail sale: the same rule', () => {
        RetailSaleManager.setSaleItems([rice(4, 30)]);
        RetailSaleManager.renderSalesBill();
        expect(restRow('saleSplitRemaining').hidden).toBe(false);
        typeIn('saleOnlinePayment', 120);
        RetailSaleManager.updateSalePaymentTotal();
        expect(restRow('saleSplitRemaining').hidden).toBe(true);
    });

    test('wholesale shares the row and the rule', () => {
        document.body.innerHTML = WHOLESALE;
        const row = restRow('wholesaleSplitRemaining');
        expect(row.hidden).toBe(true);
        Helpers.showSplitRemaining('wholesaleSplitRemaining', validatePaymentSplit(500, { cash: 100 }));
        expect(row.hidden).toBe(false);
        Helpers.showSplitRemaining('wholesaleSplitRemaining', validatePaymentSplit(500, { cash: 100, due: 400 }));
        expect(row.hidden).toBe(true);
    });

    test('WhatsApp and the Cash / Online / Total paid / Due rows always show, also on an empty or one-way-paid bill (owner)', () => {
        const shown = (section, ids) => {
            const box = document.querySelector(section);
            const share = box.querySelector('.bill-actions > .bill-share');
            expect(share.hidden).toBe(false);
            expect(share.classList.contains('btn-icon')).toBe(true);
            ids.forEach(id => {
                const line = $(id).closest('.pay-line');
                expect(line.hidden).toBe(false);
                expect(line.classList.contains('pay-folded')).toBe(false);
            });
        };
        PurchaseManager.renderBill();
        RetailSaleManager.renderSalesBill();
        shown('#purchaseSection', ['onlinePayment', 'cashPayment', 'totalPayment', 'dueAmount']);
        shown('#saleSection', ['saleOnlinePayment', 'saleCashPayment', 'totalReceived', 'saleDueAmount']);

        PurchaseManager.setBillItems([rice(10, 25)]);
        PurchaseManager.renderBill();
        $('cashCheckbox').checked = true;
        PurchaseManager.fillPayableAmount('cash');
        shown('#purchaseSection', ['onlinePayment', 'cashPayment', 'totalPayment', 'dueAmount']);
        expect(document.querySelector('#purchaseSection .pay-split')).toBeNull();

        document.body.innerHTML = WHOLESALE;
        shown('#salesEntrySection', ['wholesaleOnlinePayment', 'wholesaleCashPayment', 'wholesaleTotalReceived', 'wholesaleDueAmount']);
    });
});

describe('2. the date line: "Today" and, for the owner only, "Change date"', () => {
    const field = (id) => $(id).closest('.bill-date');
    const todayText = () => `Today · ${formatDate(toLocalISODate(new Date()), 'short')}`;

    test('owner: Today · Change date; the box unfolds on tap; another day shows formatted; reset folds it', () => {
        prepareBillDate('billDate');
        expect($('billDateText').textContent).toBe(todayText());
        expect($('billDateChange').hidden).toBe(false);
        expect(field('billDate').hidden).toBe(true);

        revealBillDate('billDate');
        expect(field('billDate').hidden).toBe(false);
        expect($('billDateChange').hidden).toBe(true);

        const yesterday = toLocalISODate(addLocalDays(new Date(), -1));
        $('billDate').value = yesterday;
        $('billDate').dispatchEvent(new Event('change'));
        expect($('billDateText').textContent).toBe(backdatedText(yesterday));

        expect(backdatedText('2026-11-12', new Date(2026, 10, 15))).toBe('Back-dated: 12 Nov');
        expect(backdatedText('2025-12-31', new Date(2026, 0, 2))).toBe('Back-dated: 31 Dec 2025');

        resetBillDate('billDate');
        expect(field('billDate').hidden).toBe(true);
        expect($('billDateText').textContent).toBe(todayText());
        expect($('billDate').value).toBe(toLocalISODate(new Date()));
    });

    test.each(['manager', 'staff', 'member'])('%s: the day only, no Change date, the box stays folded', (role) => {
        AppState.userRole = role;
        prepareBillDate('saleDate');
        expect($('saleDateText').textContent).toBe(todayText());
        expect($('saleDateChange').hidden).toBe(true);
        revealBillDate('saleDate');
        expect(field('saleDate').hidden).toBe(true);
    });

    test('an edited bill shows its own day; its date is locked, so no Change date even for the owner', () => {
        const day = addLocalDays(new Date(), -3);
        prepareBillDate('billDate', { timestamp: day.getTime() });
        expect($('billDateText').textContent).toBe(backdatedText(toLocalISODate(day)));
        expect($('billDateChange').hidden).toBe(true);
        expect(field('billDate').hidden).toBe(true);
    });

    test('Change date offers Today / Yesterday as day-month chips; one tap picks the day and folds the box (U-78)', () => {
        prepareBillDate('billDate');
        revealBillDate('billDate');
        const chips = [...field('billDate').querySelectorAll('.bill-date-chips .chip')];
        const yesterday = toLocalISODate(addLocalDays(new Date(), -1));
        expect(chips.map(c => c.textContent)).toEqual([todayText(), `Yesterday · ${formatDate(yesterday, 'short')}`]);
        expect(chips.map(c => c.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
        chips[1].click();
        expect($('billDate').value).toBe(yesterday);
        expect(field('billDate').hidden).toBe(true);
        expect($('billDateText').textContent).toBe(backdatedText(yesterday));
        revealBillDate('billDate');
        field('billDate').querySelector('.bill-date-chips .chip').click();
        expect($('billDateText').textContent).toBe(todayText());
    });

    test('a picked day is still what the bill is saved on when the box is folded', () => {
        prepareBillDate('billDate');
        revealBillDate('billDate');
        const yesterday = toLocalISODate(addLocalDays(new Date(), -1));
        $('billDate').value = yesterday;
        $('billDate').dispatchEvent(new Event('change'));
        delete $('billDate').dataset.open;
        renderBillDateLine('billDate');
        expect(field('billDate').hidden).toBe(true);
        expect($('billDate').value).toBe(yesterday);
        expect($('billDateText').textContent).toBe(backdatedText(yesterday));
    });
});

describe('3. notes and "Print in bill" behind "Add note"', () => {
    const notes = (id) => $(id).closest('.bill-notes');

    test('folded at first; Add note unfolds them', () => {
        expect(notes('billComments').hidden).toBe(true);
        expect($('billNoteToggle').hidden).toBe(false);
        BillingManager.showNotes('billComments');
        expect(notes('billComments').hidden).toBe(false);
        expect($('billNoteToggle').hidden).toBe(true);
    });

    test('a draft with a note opens them, with the note and its print choice kept; Clear folds them again', () => {
        BillingManager.applyDraft({ mode: 'purchase', items: [rice()], comments: 'GPay Ramesh', printComments: true });
        expect(notes('billComments').hidden).toBe(false);
        expect($('billComments').value).toBe('GPay Ramesh');
        expect($('billPrintComments').checked).toBe(true);
        PurchaseManager.clearBill();
        expect(notes('billComments').hidden).toBe(true);
        expect($('billNoteToggle').hidden).toBe(false);
    });

    test('retail: a draft with a note opens them too; one without stays folded', () => {
        BillingManager.applyDraft({ mode: 'sale', items: [rice()], comments: 'paid by son' });
        expect(notes('saleComments').hidden).toBe(false);
        RetailSaleManager.clearSale();
        BillingManager.applyDraft({ mode: 'sale', items: [rice()] });
        expect(notes('saleComments').hidden).toBe(true);
    });
});

describe('4. Drafts only with drafts; Save draft and Clear in the ⋯ menu', () => {
    test('Drafts hidden at 0, shown with the count above 0', async () => {
        BillDrafts.countDrafts.mockResolvedValueOnce(0);
        await BillingManager.updateDraftCount();
        expect($('draftsBtn').hidden).toBe(true);
        BillDrafts.countDrafts.mockResolvedValueOnce(2);
        await BillingManager.updateDraftCount();
        expect($('draftsBtn').hidden).toBe(false);
        expect($('draftCount').textContent).toBe('2');
    });

    test('Save draft and Clear sit inside the menu', () => {
        const menu = document.querySelector('.bill-mode-row details.bill-menu');
        expect(menu.contains($('saveDraftBtn'))).toBe(true);
        expect(menu.contains($('clearBillBtn'))).toBe(true);
    });

    test('Clear says what goes and offers Keep as draft; Cancel keeps the bill; Clear can be undone (U-06)', async () => {
        PurchaseManager.setBillItems([rice()]);
        const answer = async (choice) => {
            const asked = BillingManager.confirmClear();
            await Promise.resolve();
            const sheet = document.querySelector('.clear-bill-sheet');
            expect(sheet.querySelector('#clearBillMessage').textContent).toMatch(/^1 line, ₹/);
            expect(document.activeElement.dataset.choice).toBe('draft');
            sheet.querySelector(`[data-choice="${choice}"]`).click();
            await asked;
        };
        await answer('cancel');
        expect(PurchaseManager.getBillItems()).toHaveLength(1);
        await answer('clear');
        expect(PurchaseManager.getBillItems()).toHaveLength(0);
        const undo = document.querySelector('#undoBar .undo-bar-btn');
        expect(document.getElementById('undoBar').classList.contains('show')).toBe(true);
        undo.click();
        expect(PurchaseManager.getBillItems()).toHaveLength(1);
    });

    test('an empty bill clears without asking', async () => {
        await BillingManager.confirmClear();
        expect(document.querySelector('.clear-bill-sheet')).toBeNull();
    });
});

describe('5. "On this bill" and "Total packets" only with lines', () => {
    test('purchase: hidden, shown with a line, hidden again when the last is removed', () => {
        PurchaseManager.renderBill();
        expect($('purchaseLines').hidden).toBe(true);
        PurchaseManager.setBillItems([rice(), rice(20)]);
        PurchaseManager.renderBill();
        expect($('purchaseLines').hidden).toBe(false);
        expect($('totalPacketsInBill').textContent).toBe('2');
        PurchaseManager.deleteBillItem(0);
        expect($('purchaseLines').hidden).toBe(false);
        PurchaseManager.deleteBillItem(0);
        expect($('purchaseLines').hidden).toBe(true);
    });

    test('retail: the same', () => {
        RetailSaleManager.renderSalesBill();
        expect($('saleLines').hidden).toBe(true);
        RetailSaleManager.setSaleItems([rice()]);
        RetailSaleManager.renderSalesBill();
        expect($('saleLines').hidden).toBe(false);
        RetailSaleManager.setSaleItems([]);
        RetailSaleManager.renderSalesBill();
        expect($('saleLines').hidden).toBe(true);
    });
});

describe('6. labour: off shows only the switch', () => {
    const calc = () => $('laborCalculation');
    const box = () => $('manualLaborCharges').closest('.bill-money');

    test('one line: "1 bag × ₹6 = ₹6" opens the full working and the box; turning labour off closes them (N-07)', () => {
        PurchaseManager.setBillItems([{ ...rice(40, 25), weights: [40] }]);
        PurchaseManager.renderBill();
        expect(calc().textContent).toBe('1 bag × ₹6 = ₹6');
        expect($('laborDetail').hidden).toBe(true);
        PurchaseManager.toggleLabourDetail();
        expect($('laborDetail').hidden).toBe(false);
        expect(calc().getAttribute('aria-expanded')).toBe('true');
        expect($('laborWorking').textContent).toBe('1 bag over 30 kg × ₹6 = ₹6');
        $('manualLaborCharges').dataset.manuallySet = 'true';
        typeIn('manualLaborCharges', 10);
        PurchaseManager.updateTotals();
        expect(calc().textContent).toBe('₹10 (changed)');
        $('autoLaborCharge').checked = false;
        PurchaseManager.updateTotals();
        expect($('laborDetail').hidden).toBe(true);
        expect(calc().getAttribute('aria-expanded')).toBe('false');
    });

    test('on (the default): the working and the amount; off: neither, and no labour taken off', () => {
        PurchaseManager.setBillItems([{ ...rice(40, 25), weights: [40] }]);
        PurchaseManager.renderBill();
        expect($('autoLaborCharge').checked).toBe(true);
        expect(calc().hidden).toBe(false);
        expect(box().hidden).toBe(false);
        expect(calc().textContent).not.toBe('');
        const payableOn = $('amountPayable').textContent;

        $('autoLaborCharge').checked = false;
        PurchaseManager.updateTotals();
        expect(calc().hidden).toBe(true);
        expect(box().hidden).toBe(true);
        expect($('amountPayable').textContent).toBe('1,000');
        expect(PurchaseManager.computeTotals().laborCharges).toBe(0);

        $('autoLaborCharge').checked = true;
        PurchaseManager.updateTotals();
        expect(calc().hidden).toBe(false);
        expect(box().hidden).toBe(false);
        expect($('amountPayable').textContent).toBe(payableOn);
    });
});

describe('7. the next bill number hint is marked so the phone layout can leave it out', () => {
    test('"next" for a new bill, "known" once the bill has its number', () => {
        BillingManager.renderBillNumber();
        expect($('purchaseBillNo').dataset.kind).toBe('next');
        PurchaseManager.setPendingBill({ id: 'p1', billNumber: 'P20261115-007' });
        BillingManager.renderBillNumber();
        expect($('purchaseBillNo').dataset.kind).toBe('known');
    });
});

describe('7. lighter, safer bill form (U-05, U-06, U-18)', () => {
    test('removing a line offers Undo for a few seconds; Undo puts it back where it was', () => {
        PurchaseManager.setBillItems([rice(10), rice(20)]);
        PurchaseManager.renderBill();
        PurchaseManager.deleteBillItem(0);
        expect(PurchaseManager.getBillItems().map(l => l.qty)).toEqual([20]);
        const bar = document.getElementById('undoBar');
        expect(bar.classList.contains('show')).toBe(true);
        expect(bar.textContent).toContain('Removed Rice 10 kg');
        bar.querySelector('.undo-bar-btn').click();
        expect(PurchaseManager.getBillItems().map(l => l.qty)).toEqual([10, 20]);
        expect(bar.classList.contains('show')).toBe(false);
    });

    test('an Undo left showing never puts a removed line into the next bill', () => {
        PurchaseManager.setPendingBill({ id: 'p1' });
        PurchaseManager.setBillItems([rice(10), rice(20)]);
        PurchaseManager.renderBill();
        PurchaseManager.deleteBillItem(0);
        const undo = document.querySelector('#undoBar .undo-bar-btn');
        PurchaseManager.setPendingBill({ id: 'p2' });
        PurchaseManager.setBillItems([rice(30)]);
        undo.click();
        expect(PurchaseManager.getBillItems().map(l => l.qty)).toEqual([30]);
    });

    test('clearing the bill or switching mode hides the Undo bar', () => {
        PurchaseManager.setBillItems([rice(10), rice(20)]);
        PurchaseManager.renderBill();
        PurchaseManager.deleteBillItem(0);
        const bar = document.getElementById('undoBar');
        expect(bar.classList.contains('show')).toBe(true);
        PurchaseManager.clearBill();
        expect(bar.classList.contains('show')).toBe(false);
        bar.querySelector('.undo-bar-btn').click();
        expect(PurchaseManager.getBillItems()).toEqual([]);
        RetailSaleManager.setSaleItems([rice(5)]);
        RetailSaleManager.renderSalesBill();
        RetailSaleManager.removeSaleItem(0);
        expect(bar.classList.contains('show')).toBe(true);
        BillingManager.switchMode('purchase', { currentTarget: $('purchaseModeBtn') });
        expect(bar.classList.contains('show')).toBe(false);
    });

    test('a removed weight comes back with Undo', () => {
        PurchaseManager.setWeights([40, 50]);
        PurchaseManager.renderWeights();
        PurchaseManager.removeWeight(1);
        expect(PurchaseManager.getWeights()).toEqual([40]);
        document.querySelector('#undoBar .undo-bar-btn').click();
        expect(PurchaseManager.getWeights()).toEqual([40, 50]);
    });

    test('the Last saved strip is one compact row: bill number and "Saved · total · due · party" open the bill; Print, WhatsApp, × (U-05, N-08)', () => {
        showLastSaved('purchase', { id: 'p1', billNumber: 'P20261115-003', customerName: 'Ramesh', grandTotal: 16191, payment: { cash: 3000, online: 0, due: 13191 } });
        const strip = $('purchaseLastSaved');
        expect(strip.hidden).toBe(false);
        expect(strip.querySelector('.last-saved-head').textContent).toBe('#P20261115-003');
        expect(strip.querySelector('.last-saved-facts').textContent).toBe('Saved · ₹16,191 · Due ₹13,191 · Ramesh');
        expect(strip.querySelector('.last-saved-open').textContent).toContain('Open bill #P20261115-003');
        expect([...strip.querySelectorAll(':scope > .btn-icon')].map(b => b.getAttribute('aria-label'))).toEqual(['Print', 'WhatsApp', 'Hide']);
        strip.querySelector('.last-saved-close').click();
        expect(strip.hidden).toBe(true);
    });

    test('a line shows once: its weights under the item, no separate breakdown', () => {
        PurchaseManager.setBillItems([{ ...rice(101), weights: [52.5, 48.5] }]);
        PurchaseManager.renderBill();
        expect($('weightBreakdownSection').textContent.trim()).toBe('');
        expect(document.querySelector('#billTable .bill-line-weights').textContent).toBe('2 packets: 52.5 · 48.5');
    });
});