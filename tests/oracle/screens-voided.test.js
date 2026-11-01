/**
 * @fileoverview Oracle (#75): every displayed number of screens.test.js again, with a
 * voided copy of every bill (old-app dues included, same items, payments and dates) loaded
 * into AppState next to the real ones. The oracle's data has no voided bills, so each
 * Today, Money, Outstanding, cash drawer, Stock, Insights, Statements and labour figure
 * must equal it: a voided bill counts in no figure, nor does a voided copy of
 * every expense (#99).
 */
global.__ORACLE_WITH_VOIDED__ = true;
require('./screens.test.js');

describe('the voided copies are really loaded', () => {
    test('AppState holds a voided copy of every bill during these tests', () => {
        const { AppState } = require('../../www/js/utils/state.js');
        const FIX = require('../fixtures/calculations/shop-month.json');
        // loadAppState() runs in screens.test.js's beforeEach, so it has run before this test
        expect(AppState.purchaseHistory.filter(b => b.voided === true)).toHaveLength(FIX.purchases.length);
        expect(AppState.retailSalesHistory.filter(b => b.voided === true)).toHaveLength(FIX.retailSales.length);
        expect(AppState.salesHistory.filter(b => b.voided === true)).toHaveLength(FIX.wholesaleSales.length);
        expect(AppState.expensesHistory.filter(e => e.voided === true)).toHaveLength(FIX.expenses.length);
    });
});
