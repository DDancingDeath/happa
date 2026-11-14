/**
 * @fileoverview Extreme-rate confirm (docs/calculations.md BF-RATECHECK, owner decision
 * OD-02): the threshold (≥ 5× / ≤ ⅕ of today's rate, both ends included), the money the
 * confirm shows, the record stored on the line, and the dialog at Add to bill on the
 * purchase, retail and wholesale forms; the heavy bag / packet confirm (BF-BAGCHECK, above
 * 100 kg). The oracle is tests/oracle/billing.test.js.
 */
import fc from 'fast-check';
import {
    BAG_WEIGHT_LIMIT_KG, bagChecks, bagWeightGuess, extremeRate, heavyBag, linesNeedingRateCheck, RATE_CHECK_FACTOR,
    rateCheckFigures, rateCheckRecord, rateConfirmed, savedRateCheck, todaysRates, weightCheckRecord
} from '../utils/calc/billing.js';
import { askBagCheck, askRateCheck, checkLineRate } from '../ui/rate-check.js';
import { PurchaseManager } from '../modules/purchase.js';
import { RetailSaleManager } from '../modules/retail-sale.js';
import { WholesaleSalesManager } from '../modules/wholesale-sales.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { setLang } from '../i18n/index.js';
import { sampleItems } from '../../../tests/fixtures/sample-items.js';

const RUNS = Number(process.env.FC_RUNS) || 200;
const ITEM = { id: 'w', name: 'Wheat', hindiName: 'गेहूं', rates: [22], saleRates: [26], wholesaleRates: [25] };

describe('BF-RATECHECK: extremeRate', () => {
    test.each([
        ['₹260 against ₹26 (the ×10 typo)', 260, [26], { todayRate: 26, direction: 'high' }],
        ['exactly 5×', 130, [26], { todayRate: 26, direction: 'high' }],
        ['a paisa under 5×', 129.99, [26], null],
        ['exactly ⅕', 5.2, [26], { todayRate: 26, direction: 'low' }],
        ['a paisa over ⅕', 5.21, [26], null],
        ['₹2.60 against ₹26', 2.6, [26], { todayRate: 26, direction: 'low' }],
        ['today\'s rate itself', 26, [26], null],
        ['several rates: 5× the highest', 150, [26, 30], { todayRate: 30, direction: 'high' }],
        ['several rates: under 5× the highest', 149.99, [26, 30], null],
        ['several rates: ⅕ of the lowest', 5.2, [30, 26], { todayRate: 26, direction: 'low' }],
        ['several rates: a rate in the list is never extreme', 140, [26, 140], null],
        ['no rate in the list', 260, [], null],
        ['blank, zero and junk list values are left out', 260, [0, '', null, 'x', -5, '26'], { todayRate: 26, direction: 'high' }],
        ['only junk in the list', 260, [0, '', null], null],
        ['blank rate', '', [26], null],
        ['zero rate', 0, [26], null],
        ['negative rate', -260, [26], null],
        ['not a number', 'abc', [26], null],
        ['list missing', 260, undefined, null],
        ['typed rate as text', '260', [26], { todayRate: 26, direction: 'high' }],
        ['paise rates', 132.5, [26.5], { todayRate: 26.5, direction: 'high' }]
    ])('%s', (_name, rate, list, want) => {
        expect(extremeRate(rate, list)).toEqual(want);
    });

    test('the factor is the owner\'s 5', () => {
        expect(RATE_CHECK_FACTOR).toBe(5);
    });

    test('property: high from 5× the highest up, low from ⅕ of the lowest down, nothing in between', () => {
        const paise = fc.integer({ min: 1, max: 1_000_000 });
        fc.assert(fc.property(fc.array(paise, { minLength: 1, maxLength: 4 }), paise, (list, r) => {
            const got = extremeRate(r / 100, list.map(p => p / 100));
            const high = Math.max(...list);
            const low = Math.min(...list);
            if (r >= 5 * high) expect(got).toEqual({ todayRate: high / 100, direction: 'high' });
            else if (5 * r <= low) expect(got).toEqual({ todayRate: low / 100, direction: 'low' });
            else expect(got).toBeNull();
        }), { seed: 202, numRuns: RUNS });
    });

    test('property: a higher rate stays high, a lower one stays low; any rate in the list never asks', () => {
        const paise = fc.integer({ min: 1, max: 1_000_000 });
        fc.assert(fc.property(fc.array(paise, { minLength: 1, maxLength: 4 }), paise, paise, (list, a, b) => {
            const rates = list.map(p => p / 100);
            const [lo, hi] = a < b ? [a, b] : [b, a];
            if (extremeRate(lo / 100, rates)?.direction === 'high') expect(extremeRate(hi / 100, rates)?.direction).toBe('high');
            if (extremeRate(hi / 100, rates)?.direction === 'low') expect(extremeRate(lo / 100, rates)?.direction).toBe('low');
            rates.forEach(r => expect(extremeRate(r, rates)).toBeNull());
        }), { seed: 203, numRuns: RUNS });
    });
});

describe('BF-RATECHECK: today\'s rates, figures, record', () => {
    test('today\'s rates come from the Rates-page list of the bill type', () => {
        expect(todaysRates(ITEM, 'purchase')).toEqual([22]);
        expect(todaysRates(ITEM, 'retail')).toEqual([26]);
        expect(todaysRates(ITEM, 'wholesale')).toEqual([25]);
        expect(todaysRates({ saleRates: [0, '27.5', null, 30] }, 'retail')).toEqual([27.5, 30]);
        expect(todaysRates({ name: 'New' }, 'retail')).toEqual([]);
        expect(todaysRates(null, 'retail')).toEqual([]);
    });

    test('the money: the line at its rate and at today\'s rate, BF-LINE whole rupees', () => {
        expect(rateCheckFigures({ rate: 260, qty: 15, todayRate: 26 })).toEqual({ amount: 3900, todayAmount: 390 });
        expect(rateCheckFigures({ rate: 2.6, qty: 12.4, todayRate: 26 })).toEqual({ amount: 32, todayAmount: 322 });
    });

    test('the record keeps paise rates, who and when', () => {
        expect(rateCheckRecord({ rate: '260', todayRate: 26, by: 'u1', byName: 'Staff One', at: 5 }))
            .toEqual({ rate: 260, todayRate: 26, by: 'u1', byName: 'Staff One', at: 5 });
        expect(rateCheckRecord({ rate: 5.2, todayRate: 26, at: undefined })).toEqual({ rate: 5.2, todayRate: 26, by: '', byName: '', at: 0 });
    });

    test('a line is confirmed only for the rate it has now (any saved line shape)', () => {
        const rateCheck = { rate: 260, todayRate: 26, by: 'u1', at: 1 };
        expect(rateConfirmed({ rate: 260, qty: 15, rateCheck })).toBe(true);
        expect(rateConfirmed({ rate: '260.00', quantity: 15, rateCheck })).toBe(true);
        expect(rateConfirmed({ rate: 250, qty: 15, rateCheck })).toBe(false);
        expect(rateConfirmed({ rate: 260, qty: 15 })).toBe(false);
        expect(rateConfirmed({ rate: 260, qty: 15, rateCheck: { todayRate: 26 } })).toBe(false);
        expect(rateConfirmed(null)).toBe(false);
    });
});

describe('BF-RATECHECK at Save: linesNeedingRateCheck, savedRateCheck', () => {
    const cat = [ITEM, { id: 'r', name: 'Rice', rates: [], saleRates: [36] }];
    const confirmed = { itemId: 'w', name: 'Wheat', rate: 260, qty: 15, rateCheck: { rate: 260, todayRate: 26 } };

    test('extreme lines that are not confirmed, by item id or English / Hindi name', () => {
        const items = [
            { itemId: 'w', name: 'Wheat', rate: 26, qty: 1 },
            { itemId: 'w', name: 'Wheat', rate: 260, qty: 15 },
            confirmed,
            { name: ' गेहूं ', rate: 5, qty: 2 },
            { name: 'Unknown', rate: 9999, qty: 1 },
            { itemId: 'r', name: 'Rice', rate: 999, qty: 1 },
            null
        ];
        expect(linesNeedingRateCheck(items, cat, 'retail')).toEqual([
            { index: 1, todayRate: 26, direction: 'high' },
            { index: 3, todayRate: 26, direction: 'low' },
            { index: 5, todayRate: 36, direction: 'high' }
        ]);
        // Purchase: ₹5 is above ⅕ of ₹22; Rice has no purchase rate today: no check
        expect(linesNeedingRateCheck(items, cat, 'purchase').map(x => x.index)).toEqual([1]);
    });

    test('editing: a line the saved bill already has (same item and rate) is not asked; a changed rate is', () => {
        const saved = [{ itemId: 'w', name: 'Wheat', rate: 260, qty: 10 }];
        expect(linesNeedingRateCheck([{ itemId: 'w', name: 'Wheat', rate: 260, qty: 15 }], cat, 'retail', saved)).toEqual([]);
        expect(linesNeedingRateCheck([{ itemId: 'w', name: 'Wheat', rate: 270, qty: 15 }], cat, 'retail', saved))
            .toEqual([{ index: 0, todayRate: 26, direction: 'high' }]);
    });

    test('savedRateCheck: a line put back unchanged keeps its confirm', () => {
        expect(savedRateCheck({ itemId: 'w', rate: 260 }, [confirmed])).toEqual({ saved: true, rateCheck: confirmed.rateCheck });
        expect(savedRateCheck({ itemId: 'w', rate: 260 }, [{ itemId: 'w', rate: 260 }])).toEqual({ saved: true, rateCheck: null });
        expect(savedRateCheck({ itemId: 'w', rate: 261 }, [confirmed])).toEqual({ saved: false, rateCheck: null });
        expect(savedRateCheck({ itemId: 'w', rate: 260 }, undefined)).toEqual({ saved: false, rateCheck: null });
    });
});

// ---------- BF-BAGCHECK ----------

describe('BF-BAGCHECK: one bag / packet above 100 kg', () => {
    test.each([
        ['exactly 100 kg is fine', 100, false],
        ['100.01 kg asks', 100.01, true],
        ['100.001 kg asks (to the gram)', 100.001, true],
        ['485 kg asks', 485, true],
        ['48.5 kg is fine', 48.5, false],
        ['typed as text', '485', true],
        ['blank', '', false],
        ['null', null, false],
        ['zero', 0, false],
        ['negative', -485, false],
        ['not a number', 'abc', false]
    ])('%s', (_name, kg, want) => {
        expect(heavyBag(kg)).toBe(want);
    });

    test('the limit is the owner\'s 100 kg; the suggestion is ÷ 10', () => {
        expect(BAG_WEIGHT_LIMIT_KG).toBe(100);
        expect(bagWeightGuess(485)).toBe(48.5);
        expect(bagWeightGuess(1000)).toBe(100);
        expect(bagWeightGuess(101.25)).toBe(10.125);
    });

    test('property: heavy exactly when the grams are above 100,000', () => {
        fc.assert(fc.property(fc.integer({ min: -1000, max: 2_000_000 }), (g) => {
            expect(heavyBag(g / 1000)).toBe(g > 100_000);
        }), { seed: 1008, numRuns: RUNS });
    });

    test('a record keeps the weight to the gram and who confirmed it', () => {
        expect(weightCheckRecord({ kg: '485', by: 'u1', byName: 'Staff One', at: 7 })).toEqual({ kg: 485, by: 'u1', byName: 'Staff One', at: 7 });
    });

    test('bagChecks: each confirm covers one heavy bag of the same weight; light bags need none', () => {
        const r = (kg) => weightCheckRecord({ kg, by: 'u', at: 1 });
        expect(bagChecks([40, 485, 485, 120], [r(485)])).toEqual({ confirmed: [r(485)], unconfirmed: [485, 120] });
        expect(bagChecks([40, 485], [r(485), r(300), r(50)])).toEqual({ confirmed: [r(485)], unconfirmed: [] });
        expect(bagChecks([100, 99.5], [])).toEqual({ confirmed: [], unconfirmed: [] });
        expect(bagChecks(undefined, undefined)).toEqual({ confirmed: [], unconfirmed: [] });
    });

    test('property: confirmed + unconfirmed are exactly the heavy bags', () => {
        const kg = fc.integer({ min: 1, max: 300_000 }).map(g => g / 1000);
        fc.assert(fc.property(fc.array(kg, { maxLength: 8 }), fc.array(kg, { maxLength: 8 }), (weights, confirmedKg) => {
            const { confirmed, unconfirmed } = bagChecks(weights, confirmedKg.map(k => ({ kg: k })));
            const heavy = weights.filter(w => w > 100).sort((a, b) => a - b);
            expect([...confirmed.map(c => c.kg), ...unconfirmed].sort((a, b) => a - b)).toEqual(heavy);
        }), { seed: 1009, numRuns: RUNS });
    });
});

// ---------- the dialog and the forms ----------

const dialog = () => document.querySelector('.rate-check-dialog');
async function answer(choice) {
    for (let i = 0; i < 50 && !dialog(); i++) await new Promise(r => setTimeout(r, 0));
    expect(dialog()).not.toBeNull();
    const message = dialog().querySelector('.dialog-body p').textContent;
    dialog().querySelector(`[data-choice="${choice}"]`).click();
    return message;
}
const settle = () => new Promise(r => setTimeout(r, 0));
const setVal = (id, v) => { document.getElementById(id).value = String(v); };

describe('the confirm dialog', () => {
    beforeEach(() => {
        AppState.currentUser = { uid: 'u9' };
        AppState.userName = 'Staff One';
        document.body.innerHTML = '<input id="rate" value="260">';
    });
    afterEach(() => {
        dialog()?.remove();
        setLang('en');
    });

    test('shows the money; "Fix rate" is focused and stops the line, with the rate box selected', async () => {
        const result = checkLineRate({ kind: 'retail', item: ITEM, label: 'Wheat', rate: 260, qty: 15, rateInputId: 'rate' });
        await settle();
        expect(document.activeElement.dataset.choice).toBe('fix');
        expect(dialog().querySelector('[data-choice="fix"]').textContent).toBe('Fix rate');
        expect(dialog().querySelector('[data-choice="confirm"]').textContent).toBe('Yes, ₹260 is right');
        expect(dialog().querySelector('[data-choice="fix"]').hasAttribute('data-dismiss')).toBe(true);
        expect(await answer('fix')).toBe('Wheat 15 kg × ₹260 = ₹3,900. Today\'s rate ₹26 would give ₹390.');
        expect(await result).toEqual({ ok: false, rateCheck: null });
        expect(document.activeElement.id).toBe('rate');
        expect(dialog()).toBeNull();
    });

    test('Esc / Back and a tap on the scrim answer "Fix rate"', async () => {
        const { closeTopDialog } = await import('../utils/keyboard-shortcuts.js');
        const escaped = checkLineRate({ kind: 'retail', item: ITEM, label: 'Wheat', rate: 260, qty: 15, rateInputId: 'rate' });
        await settle();
        expect(closeTopDialog()).toBe(true);
        expect(await escaped).toEqual({ ok: false, rateCheck: null });
        const tapped = checkLineRate({ kind: 'retail', item: ITEM, label: 'Wheat', rate: 260, qty: 15, rateInputId: 'rate' });
        await settle();
        dialog().dispatchEvent(new Event('pointerdown', { bubbles: true }));
        dialog().click();
        expect(await tapped).toEqual({ ok: false, rateCheck: null });
        expect(dialog()).toBeNull();
    });

    test('"Yes, it is right" adds the line with who confirmed it', async () => {
        const result = checkLineRate({ kind: 'retail', item: ITEM, label: 'Wheat', rate: 260, qty: 15, rateInputId: 'rate' });
        await answer('confirm');
        const { ok, rateCheck } = await result;
        expect(ok).toBe(true);
        expect(rateCheck).toMatchObject({ rate: 260, todayRate: 26, by: 'u9', byName: 'Staff One' });
        expect(rateCheck.at).toBeGreaterThan(0);
    });

    test('a normal rate, an item with no rate today, and a line put back unchanged (bill being edited, line taken back) never ask', async () => {
        expect(await checkLineRate({ kind: 'retail', item: ITEM, label: 'Wheat', rate: 30, qty: 15, rateInputId: 'rate' })).toEqual({ ok: true, rateCheck: null });
        expect(await checkLineRate({ kind: 'retail', item: { id: 'n', name: 'New' }, label: 'New', rate: 9999, qty: 1, rateInputId: 'rate' })).toEqual({ ok: true, rateCheck: null });
        const kept = { rate: 260, todayRate: 26, by: 'u1', byName: 'Owner', at: 1 };
        const keptLines = [{ itemId: 'w', name: 'Wheat', rate: 260, qty: 15, rateCheck: kept }];
        expect(await checkLineRate({ kind: 'retail', item: ITEM, label: 'Wheat', rate: 260, qty: 10, rateInputId: 'rate', keptLines })).toEqual({ ok: true, rateCheck: kept });
        expect(dialog()).toBeNull();
    });

    test('Hindi: one language, "kg" for the weight', async () => {
        setLang('hi');
        const result = askRateCheck({ label: 'गेहूं', qty: 15, rate: 260, todayRate: 26, amount: 3900, todayAmount: 390 });
        expect(await answer('fix')).toBe('गेहूं 15 kg × ₹260 = ₹3,900। आज के रेट ₹26 से ₹390 होता।');
        expect(await result).toBe('fix');
    });
});

const PURCHASE_DOM = `
  <select id="billItem"><option value=""></option><option value="0">Rice</option><option value="1">Wheat</option></select>
  <input id="billRate"><input id="newWeight"><div id="weightsDisplay"></div>
  <span id="totalWeights">0</span><span id="totalPackets">0</span>
  <table id="billTable"><tbody></tbody></table><div id="weightBreakdownSection"></div>
  <span id="billTotal">0</span><span id="totalPacketsInBill">0</span>
  <input type="checkbox" id="autoLaborCharge"><input id="manualLaborCharges" value="0"><span id="laborCalculation"></span>
  <span id="amountPayable">0</span><span id="totalPayment">0</span>
  <input id="onlinePayment"><input id="cashPayment"><input id="dueAmount"><strong id="purchaseSplitRemaining"></strong>
  <input type="checkbox" id="onlineCheckbox"><input type="checkbox" id="cashCheckbox"><input type="checkbox" id="dueCheckbox">
  <input id="customerName"><input id="billComments"><input type="checkbox" id="billPrintComments">`;
const SALE_DOM = `
  <select id="saleItem"><option value=""></option><option value="0">Rice</option><option value="1">Wheat</option></select>
  <input id="saleRate"><input id="saleWeight"><div id="saleWeightsDisplay"></div>
  <span id="saleRunningTotal">0</span><span id="salePacketCount">0</span>
  <table id="saleTable"><tbody></tbody></table><div id="saleWeightBreakdownSection"></div>
  <span id="saleTotal">0</span><span id="totalSalePacketsInBill">0</span><span id="amountReceivable">0</span><span id="totalReceived">0</span>
  <input id="saleOnlinePayment"><input id="saleCashPayment"><input id="saleDueAmount"><strong id="saleSplitRemaining"></strong>
  <input type="checkbox" id="saleOnlineCheckbox"><input type="checkbox" id="saleCashCheckbox"><input type="checkbox" id="saleDueCheckbox">
  <input id="saleCustomerName"><input id="saleComments"><input type="checkbox" id="salePrintComments">`;
const WHOLESALE_DOM = `
  <select id="sellItem"><option value=""></option><option value="Rice">Rice</option><option value="Wheat">Wheat</option></select>
  <span id="availableStock">-</span><span id="avgPurchaseRate">-</span>
  <input id="sellRate"><input id="sellQuantity"><table id="salesTable"><tbody></tbody></table>
  <span id="salesTotalAmount">0</span><input id="salesExpensesAmount" value="0">
  <span id="salesProfitAmount">0</span><span id="salesProfitPercent">0</span>
  <input id="wholesaleOnlinePayment"><input id="wholesaleCashPayment"><input id="wholesaleDueAmount">
  <strong id="wholesaleSplitRemaining"></strong><span id="wholesaleTotalReceived">0</span>`;

describe('Add to bill on the three forms (OD-02)', () => {
    beforeEach(() => {
        jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        jest.spyOn(UIManager, 'hapticFeedback').mockImplementation(() => {});
        AppState.items = sampleItems();
        AppState.stock = { 'item-rice': { quantity: 500, rate: 30 }, 'item-wheat': { quantity: 500, rate: 24 } };
        AppState.stockReady = true;
        AppState.stockApprox = null;
        AppState.settings = { laborRate: 6, heavyWeightThreshold: 30 };
        AppState.currentUser = { uid: 'u2' };
        AppState.userName = 'Staff One';
    });
    afterEach(() => {
        dialog()?.remove();
        jest.restoreAllMocks();
        PurchaseManager.setBillItems([]);
        PurchaseManager.setWeights([]);
        PurchaseManager.setPendingBill(null);
        RetailSaleManager.setSaleItems([]);
        RetailSaleManager.setSaleWeights([]);
        RetailSaleManager.setPendingBill(null);
        WholesaleSalesManager.setItems([]);
    });

    test('purchase: Fix rate adds nothing and keeps the weight; the right rate then adds the line with no record', async () => {
        document.body.innerHTML = PURCHASE_DOM;
        setVal('billItem', 1);
        setVal('billRate', 240);
        setVal('newWeight', 15);
        const adding = PurchaseManager.addToBill();
        expect(await answer('fix')).toBe('Wheat 15 kg × ₹240 = ₹3,600. Today\'s rate ₹24 would give ₹360.');
        await adding;
        expect(PurchaseManager.getBillItems()).toEqual([]);
        expect(PurchaseManager.getWeights()).toEqual([15]);
        expect(document.activeElement.id).toBe('billRate');
        setVal('billRate', 24);
        await PurchaseManager.addToBill();
        expect(dialog()).toBeNull();
        expect(PurchaseManager.getBillItems()).toEqual([expect.objectContaining({ name: 'Wheat', rate: 24, qty: 15, total: 360 })]);
        expect(PurchaseManager.getBillItems()[0]).not.toHaveProperty('rateCheck');
    });

    test('retail: confirmed, the line keeps its amount and carries the record', async () => {
        document.body.innerHTML = SALE_DOM;
        setVal('saleItem', 1);
        setVal('saleRate', 280);
        setVal('saleWeight', 15);
        const adding = RetailSaleManager.addToSalesBill();
        expect(await answer('confirm')).toBe('Wheat 15 kg × ₹280 = ₹4,200. Today\'s rate ₹28 would give ₹420.');
        await adding;
        const [line] = RetailSaleManager.getSaleItems();
        expect(line).toMatchObject({ name: 'Wheat', rate: 280, qty: 15, total: 4200, rateCheck: { rate: 280, todayRate: 28, by: 'u2', byName: 'Staff One' } });
    });

    test('wholesale: ⅕ of today\'s rate asks too; the record goes into the saved line', async () => {
        document.body.innerHTML = WHOLESALE_DOM;
        setVal('sellItem', 'Wheat');
        setVal('sellRate', 5.4);
        setVal('sellQuantity', 10);
        const adding = WholesaleSalesManager.addToWholesaleBill();
        expect(await answer('confirm')).toBe('Wheat 10 kg × ₹5.40 = ₹54. Today\'s rate ₹27 would give ₹270.');
        await adding;
        expect(WholesaleSalesManager.getItems()).toEqual([expect.objectContaining({ rate: 5.4, qty: 10, total: 54, rateCheck: expect.objectContaining({ rate: 5.4, todayRate: 27 }) })]);
    });

    test('purchase bag: 485 kg asks; Fix weight keeps it in the box; confirmed it goes on the line', async () => {
        document.body.innerHTML = PURCHASE_DOM;
        setVal('billItem', 1);
        setVal('billRate', 24);
        setVal('newWeight', 485);
        const adding = PurchaseManager.addWeight();
        expect(dialog().querySelector('#bagCheckTitle').textContent).toBe('Check the bag weight');
        expect(document.activeElement.dataset.choice).toBe('fix');
        expect(dialog().querySelector('[data-choice="fix"]').textContent).toBe('Fix weight');
        expect(dialog().querySelector('[data-choice="confirm"]').textContent).toBe('Yes, 485 kg');
        expect(await answer('fix')).toBe('Bag weight 485 kg — usually under 100 kg. Did you mean 48.5?');
        await adding;
        expect(PurchaseManager.getWeights()).toEqual([]);
        expect(document.getElementById('newWeight').value).toBe('485');
        expect(document.activeElement.id).toBe('newWeight');

        // 100 kg exactly is fine; 485 confirmed; both go on the line, the confirm only for 485
        setVal('newWeight', 100);
        await PurchaseManager.addWeight();
        expect(dialog()).toBeNull();
        setVal('newWeight', 485);
        const again = PurchaseManager.addWeight();
        await answer('confirm');
        await again;
        expect(PurchaseManager.getWeights()).toEqual([100, 485]);
        await PurchaseManager.addToBill();
        expect(dialog()).toBeNull(); // not asked twice
        const [line] = PurchaseManager.getBillItems();
        expect(line).toMatchObject({ weights: [100, 485], qty: 585, total: 14040 });
        expect(line.weightCheck).toEqual([expect.objectContaining({ kg: 485, by: 'u2', byName: 'Staff One' })]);

        // Taking the line back to edit keeps the bags and their confirm: not asked again
        await PurchaseManager.editBillItem(0);
        await new Promise(r => setTimeout(r, 60)); // editBillItem puts the rate back after 50 ms
        setVal('billRate', 24);
        await PurchaseManager.addToBill();
        expect(dialog()).toBeNull();
        expect(PurchaseManager.getBillItems()[0].weightCheck).toEqual(line.weightCheck);
    });

    test('purchase: a weight typed and not added yet is a bag too (asked at Add to bill)', async () => {
        document.body.innerHTML = PURCHASE_DOM;
        setVal('billItem', 1);
        setVal('billRate', 24);
        setVal('newWeight', 150);
        const adding = PurchaseManager.addToBill();
        expect(await answer('fix')).toBe('Bag weight 150 kg — usually under 100 kg. Did you mean 15?');
        await adding;
        expect(PurchaseManager.getBillItems()).toEqual([]);
        expect(document.getElementById('newWeight').value).toBe('150');
    });

    test('retail: a packet above 100 kg asks; a weight typed with no packets is the line total and does not', async () => {
        document.body.innerHTML = SALE_DOM;
        setVal('saleItem', 1);
        setVal('saleRate', 28);
        setVal('saleWeight', 150);
        await RetailSaleManager.addToSalesBill(); // 150 kg total, no packets
        expect(dialog()).toBeNull();
        expect(RetailSaleManager.getSaleItems()[0]).toMatchObject({ qty: 150, total: 4200 });
        expect(RetailSaleManager.getSaleItems()[0]).not.toHaveProperty('weightCheck');

        setVal('saleItem', 1);
        setVal('saleRate', 28);
        setVal('saleWeight', 120);
        const adding = RetailSaleManager.addSaleWeight();
        expect(dialog().querySelector('#bagCheckTitle').textContent).toBe('Check the packet weight');
        expect(await answer('confirm')).toBe('Packet weight 120 kg — usually under 100 kg. Did you mean 12?');
        await adding;
        setVal('saleWeight', 30);
        await RetailSaleManager.addToSalesBill();
        const line = RetailSaleManager.getSaleItems()[1];
        expect(line).toMatchObject({ weights: [120, 30], qty: 150 });
        expect(line.weightCheck).toEqual([expect.objectContaining({ kg: 120, by: 'u2' })]);
    });

    test('retail: a packet typed with the others and confirmed is not asked again after "Fix rate"', async () => {
        document.body.innerHTML = SALE_DOM;
        RetailSaleManager.setSaleWeights([20]);
        setVal('saleItem', 1);
        setVal('saleRate', 280);
        setVal('saleWeight', 485);
        const first = RetailSaleManager.addToSalesBill();
        expect(await answer('confirm')).toMatch(/^Packet weight 485 kg/);
        expect(await answer('fix')).toMatch(/^Wheat 505 kg × ₹280/);
        await first;
        expect(RetailSaleManager.getSaleItems()).toEqual([]);
        setVal('saleRate', 28);
        await RetailSaleManager.addToSalesBill();
        expect(dialog()).toBeNull();
        const [line] = RetailSaleManager.getSaleItems();
        expect(line).toMatchObject({ weights: [20, 485], qty: 505 });
        expect(line.weightCheck).toEqual([expect.objectContaining({ kg: 485 })]);
    });

    test('Hindi bag confirm: one language, "kg"', async () => {
        setLang('hi');
        try {
            const asking = askBagCheck(485, 'bag');
            expect(dialog().querySelector('[data-choice="confirm"]').textContent).toBe('हाँ, 485 kg');
            expect(await answer('fix')).toBe('बोरी का वज़न 485 kg — आमतौर पर 100 kg से कम होता है। क्या 48.5 लिखना था?');
            expect(await asking).toBe('fix');
        } finally {
            setLang('en');
        }
    });
});
