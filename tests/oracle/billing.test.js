/**
 * @fileoverview Oracle tests for the bill forms (docs/calculations.md BF-KG,
 * BF-LINE, BF-TOTAL, BF-LAB, BF-PAYABLE, WS-PROFIT, WS-MARGIN): the purchase,
 * retail and wholesale forms show what the independent oracle computes, and
 * utils/calc/billing.js agrees with the oracle on generated bills.
 */
import fc from 'fast-check';
import * as O from './oracle.js';
import {
    autoLabour, computeLine, computePurchaseTotals, computeRetailTotals, payableOnScreen, wholesaleLiveProfit
} from '../../www/js/utils/calc/billing.js';
import { PurchaseManager } from '../../www/js/modules/purchase.js';
import { RetailSaleManager } from '../../www/js/modules/retail-sale.js';
import { WholesaleSalesManager } from '../../www/js/modules/wholesale-sales.js';
import { UIManager } from '../../www/js/ui/ui-manager.js';
import { AppState } from '../../www/js/utils/state.js';
import { sampleItems } from '../fixtures/sample-items.js';

const text = (id) => document.getElementById(id).textContent;
const setVal = (id, v) => { document.getElementById(id).value = String(v); };
const lineAmounts = (selector) => [...document.querySelectorAll(`${selector} tbody tr`)].map(tr => Number(tr.children[3].textContent.replace('₹', '')));
const RUNS = Number(process.env.FC_RUNS) || 200;

beforeEach(() => {
    jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
    jest.spyOn(UIManager, 'hapticFeedback').mockImplementation(() => {});
    AppState.items = sampleItems();
    AppState.stockReady = true;
    AppState.stockApprox = null;
    AppState.settings = { laborRate: 6.5, heavyWeightThreshold: 30 };
});
afterEach(() => {
    jest.restoreAllMocks();
    PurchaseManager.setBillItems([]);
    PurchaseManager.setWeights([]);
    PurchaseManager.setPendingBill(null);
    RetailSaleManager.setSaleItems([]);
    RetailSaleManager.setPendingBill(null);
    WholesaleSalesManager.setItems([]);
});

describe('the forms show the oracle\'s figures', () => {
    test('purchase: BF-LINE, BF-TOTAL, BF-LAB, BF-PAYABLE (auto and typed paise labour)', async () => {
        document.body.innerHTML = `<select id="billItem"><option value="0">Rice</option><option value="1">Wheat</option></select>
            <input id="billRate"><input id="newWeight"><table id="billTable"><tbody></tbody></table>
            <span id="billTotal"></span><span id="totalPacketsInBill"></span><input type="checkbox" id="autoLaborCharge" checked>
            <input id="manualLaborCharges" value="0"><span id="laborCalculation"></span><span id="amountPayable"></span>
            <input id="onlinePayment"><input id="cashPayment"><input id="dueAmount">`;
        const entries = [{ rate: 25.35, weights: [40.5, 20.3, 31] }, { rate: 33.5, weights: [12.4] }];
        for (const [i, e] of entries.entries()) {
            setVal('billItem', i);
            setVal('billRate', e.rate);
            PurchaseManager.setWeights([...e.weights]);
            await PurchaseManager.addToBill();
        }
        const want = O.billForm('purchase', entries, { laborRate: 6.5 });
        expect(lineAmounts('#billTable')).toEqual(want.BF_LINE);
        expect(Number(text('billTotal'))).toBe(want.BF_TOTAL_shown);
        expect(Number(document.getElementById('manualLaborCharges').value)).toBe(want.BF_LAB);
        expect(Number(text('amountPayable'))).toBe(want.BF_PAYABLE_shown);
        expect(PurchaseManager.computeTotals().grandTotal).toBe(want.BF_PAYABLE);

        setVal('manualLaborCharges', 12.5);
        document.getElementById('manualLaborCharges').dataset.manuallySet = 'true';
        PurchaseManager.updateTotals();
        const typed = O.billForm('purchase', entries, { laborRate: 6.5, labour: 12.5 });
        expect(Number(text('amountPayable'))).toBe(typed.BF_PAYABLE_shown);
        expect(PurchaseManager.computeTotals().grandTotal).toBe(typed.BF_PAYABLE);
    });

    test('retail: BF-LINE, BF-TOTAL', async () => {
        document.body.innerHTML = `<select id="saleItem"><option value="0">Rice</option><option value="1">Wheat</option></select>
            <input id="saleRate"><input id="saleWeight"><table id="saleTable"><tbody></tbody></table>
            <span id="saleTotal"></span><span id="amountReceivable"></span><span id="totalSalePacketsInBill"></span>`;
        AppState.stock = { 'item-rice': { quantity: 500 }, 'item-wheat': { quantity: 500 } };
        const entries = [{ rate: 41.75, weights: [25.5, 24.7, 10.15] }, { rate: 33.33, weights: [7] }];
        for (const [i, e] of entries.entries()) {
            setVal('saleItem', i);
            setVal('saleRate', e.rate);
            RetailSaleManager.setSaleWeights([...e.weights]);
            await RetailSaleManager.addToSalesBill();
        }
        const want = O.billForm('retail', entries);
        expect(lineAmounts('#saleTable')).toEqual(want.BF_LINE);
        expect(Number(text('saleTotal'))).toBe(want.BF_TOTAL_shown);
        expect(Number(text('amountReceivable'))).toBe(want.BF_TOTAL_shown);
        expect(RetailSaleManager.getCheckDraft().total).toBe(want.BF_TOTAL);
    });

    test('wholesale: BF-LINE, BF-TOTAL, WS-PROFIT, WS-MARGIN (one cost unknown)', async () => {
        document.body.innerHTML = `<select id="sellItem"><option value="Rice">Rice</option><option value="Wheat">Wheat</option></select>
            <input id="sellRate"><input id="sellQuantity"><table id="salesTable"><tbody></tbody></table>
            <span id="salesTotalAmount"></span><input id="salesExpensesAmount" value="0">
            <span id="salesProfitAmount"></span><span id="salesProfitPercent"></span>`;
        AppState.stock = { 'item-rice': { quantity: 500, rate: 22.4 }, 'item-wheat': { quantity: 300 } };
        const entries = [{ itemId: 'item-rice', name: 'Rice', rate: 33.5, qty: 12.4 }, { itemId: 'item-wheat', name: 'Wheat', rate: 40.1, qty: 7.25 }];
        for (const e of entries) {
            setVal('sellItem', e.name);
            setVal('sellRate', e.rate);
            setVal('sellQuantity', e.qty);
            await WholesaleSalesManager.addToWholesaleBill();
        }
        setVal('salesExpensesAmount', 20.5);
        WholesaleSalesManager.updateProfitCalculation();
        const want = O.billForm('wholesale', entries, { stock: AppState.stock, expenses: 20.5 });
        expect(lineAmounts('#salesTable')).toEqual(want.BF_LINE);
        expect(Number(text('salesTotalAmount'))).toBe(want.BF_TOTAL_shown);
        expect(want.WS_PROFIT).toBeNull();
        expect([text('salesProfitAmount'), text('salesProfitPercent')]).toEqual(['—', '—']);
        expect(WholesaleSalesManager.computeTotals()).toMatchObject({ total: want.BF_TOTAL, profit: null, profitPercent: null });

        AppState.stock['item-wheat'].rate = 30;
        WholesaleSalesManager.updateProfitCalculation();
        const known = O.billForm('wholesale', entries, { stock: AppState.stock, expenses: 20.5 });
        expect(Number(text('salesProfitAmount'))).toBe(known.WS_PROFIT_shown);
        expect(Number(text('salesProfitPercent'))).toBe(known.WS_MARGIN);
        expect(WholesaleSalesManager.computeTotals()).toMatchObject({ total: known.BF_TOTAL, profit: known.WS_PROFIT, profitPercent: known.WS_MARGIN });
    });
});

describe('utils/calc/billing.js == oracle on generated bills', () => {
    const rate = fc.integer({ min: 1, max: 20000 }).map(x => x / 100);
    const weights = fc.array(fc.integer({ min: 1, max: 900 }).map(x => x / 10), { minLength: 1, maxLength: 6 });

    test('purchase', () => {
        const entry = fc.record({ rate, weights });
        const opts = fc.record({
            laborRate: fc.integer({ min: 1, max: 2000 }).map(x => x / 100),
            labour: fc.oneof(fc.constant(undefined), fc.integer({ min: 0, max: 50000 }).map(x => x / 100))
        });
        fc.assert(fc.property(fc.array(entry, { maxLength: 5 }), opts, (entries, { laborRate, labour }) => {
            const want = O.billForm('purchase', entries, { laborRate, labour });
            const lines = entries.map(e => ({ ...computeLine(e), weights: e.weights }));
            const heavy = computePurchaseTotals(lines, 0, 30).heavyPackets;
            const suggested = autoLabour({ laborRate }, heavy).box;
            const typed = labour === undefined ? suggested : labour;
            const totals = computePurchaseTotals(lines, typed, 30);
            expect({
                BF_LINE: lines.map(l => l.total), BF_KG: lines.map(l => l.qty), BF_TOTAL: totals.billTotal,
                BF_TOTAL_shown: Math.round(totals.billTotal), BF_LAB: suggested,
                BF_PAYABLE: totals.grandTotal, BF_PAYABLE_shown: payableOnScreen(totals.billTotal, typed)
            }).toEqual(want);
        }), { seed: 129, numRuns: RUNS });
    });

    test('retail', () => {
        fc.assert(fc.property(fc.array(fc.record({ rate, weights }), { maxLength: 6 }), (entries) => {
            const want = O.billForm('retail', entries);
            const lines = entries.map(e => computeLine(e));
            expect(lines.map(l => l.total)).toEqual(want.BF_LINE);
            expect(computeRetailTotals(lines).total).toBe(want.BF_TOTAL);
        }), { seed: 129, numRuns: RUNS });
    });

    test('wholesale live profit and margin', () => {
        const entry = fc.record({
            itemId: fc.constantFrom('a', 'b', 'c'),
            rate,
            qty: fc.integer({ min: 1, max: 50000 }).map(x => x / 100)
        });
        const stock = fc.record({
            a: fc.record({ rate: fc.integer({ min: 1, max: 20000 }).map(x => x / 100) }),
            b: fc.record({ rate: fc.constant(undefined) })
        });
        const expenses = fc.integer({ min: 0, max: 100000 }).map(x => x / 100);
        fc.assert(fc.property(fc.array(entry, { maxLength: 6 }), stock, expenses, (entries, st, ex) => {
            const want = O.billForm('wholesale', entries, { stock: st, expenses: ex });
            const lines = entries.map(e => ({ itemId: e.itemId, qty: e.qty, total: computeLine(e).total }));
            const got = wholesaleLiveProfit(lines, st, ex);
            expect({ total: got.total, profit: got.profit, shown: got.shownProfit, margin: got.profitPercent })
                .toEqual({ total: want.BF_TOTAL, profit: want.WS_PROFIT, shown: want.WS_PROFIT_shown, margin: want.WS_MARGIN });
        }), { seed: 129, numRuns: RUNS });
    });
});
