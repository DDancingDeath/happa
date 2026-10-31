/**
 * @fileoverview "Saved and printed" shows only when the bill really printed
 * (#77): not after "may have printed" or a cancelled reprint.
 */
import { PurchaseManager } from '../modules/purchase.js';
import { RetailSaleManager } from '../modules/retail-sale.js';
import { WholesaleSalesManager } from '../modules/wholesale-sales.js';
import { PrinterService } from '../services/printer.js';
import { UIManager } from '../ui/ui-manager.js';

const bill = { billNumber: 'P-1', items: [{ name: 'Rice', qty: 1, rate: 10, total: 10 }] };

const flows = [
    ['purchase', 'Bill saved and printed!', () => {
        PurchaseManager.setBillItems(bill.items);
        jest.spyOn(PurchaseManager, '_saveBill').mockImplementation(async (o) => { o.onWriteIssued(bill); return bill; });
        return () => PurchaseManager.printBill();
    }],
    ['retail', 'Sale saved and printed!', () => {
        RetailSaleManager.setSaleItems(bill.items);
        jest.spyOn(RetailSaleManager, '_completeSale').mockImplementation(async (o) => { o.onWriteIssued(bill); return bill; });
        return () => RetailSaleManager.printSale();
    }],
    ['wholesale', 'Sale saved and printed!', () => {
        WholesaleSalesManager.setItems(bill.items);
        jest.spyOn(WholesaleSalesManager, '_completeSale').mockImplementation(async (o) => { o.onWriteIssued(bill); return bill; });
        return () => WholesaleSalesManager.printWholesaleSale();
    }]
];

let toast;
beforeEach(() => {
    toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
});

describe.each(flows)('%s Print', (_name, message, setup) => {
    test('printed: "saved and printed"', async () => {
        jest.spyOn(PrinterService, 'printBill').mockResolvedValue(true);
        jest.spyOn(PrinterService, 'printWholesaleSale').mockResolvedValue(true);
        await setup()();
        expect(toast).toHaveBeenCalledWith(message);
    });

    test('may have printed or cancelled: no "printed" toast', async () => {
        jest.spyOn(PrinterService, 'printBill').mockResolvedValue(false);
        jest.spyOn(PrinterService, 'printWholesaleSale').mockResolvedValue(false);
        await setup()();
        expect(toast).not.toHaveBeenCalledWith(message);
    });
});
