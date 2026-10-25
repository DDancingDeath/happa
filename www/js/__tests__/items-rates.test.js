/**
 * @fileoverview Item rate add/delete run from inline onclick handlers, so a
 * failed save must not become an unhandled rejection (#126): the local change
 * is undone and the user gets a toast.
 */
jest.mock('../utils/lazy-scripts.js', () => ({ ensureXLSX: jest.fn(async () => {}) }));

import { ItemsManager } from '../modules/items.js';
import { AuditService } from '../services/audit.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';

beforeEach(() => {
    AppState.items = [{ id: 'i1', name: 'Gehu', rates: [10, 20], saleRates: [30], wholesaleRates: [] }];
    jest.spyOn(ItemsManager, 'renderItems').mockImplementation(() => {});
    jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
});

test('failed delete restores the rate and tells the user', async () => {
    jest.spyOn(FirebaseService, 'saveItem').mockRejectedValue(new Error('offline'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(ItemsManager.deleteRate('i1', 0)).resolves.toBeUndefined();
    expect(AppState.items[0].rates).toEqual([10, 20]);
    expect(UIManager.showToast).toHaveBeenCalledWith(expect.stringMatching(/Rate not saved/), expect.any(Number));
    expect(ItemsManager.renderItems).toHaveBeenCalled();
});

test('failed add removes the empty rate again', async () => {
    jest.spyOn(FirebaseService, 'saveItem').mockRejectedValue(new Error('offline'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await ItemsManager.addSaleRate('i1');
    await ItemsManager.addWholesaleRate('i1');
    expect(AppState.items[0].saleRates).toEqual([30]);
    expect(AppState.items[0].wholesaleRates).toEqual([]);
});

test('successful delete saves the shortened list without a toast', async () => {
    const save = jest.spyOn(FirebaseService, 'saveItem').mockResolvedValue(undefined);
    await ItemsManager.deleteSaleRate('i1', 0);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ saleRates: [] }));
    expect(UIManager.showToast).not.toHaveBeenCalled();
});

describe('rate history', () => {
    beforeEach(() => {
        AppState.userRole = 'owner';
        AppState.currentUser = { uid: 'own1' };
        AppState.userName = 'Owner';
        ItemsManager.lastChangeAt = {};
    });
    afterEach(() => { delete global.XLSX; });

    test('Excel import records each updated item\'s rate changes (source import, list positions)', async () => {
        AppState.items = [
            { id: 'i1', name: 'Gehu', rates: [10, 12], saleRates: [30], wholesaleRates: [] },
            { id: 'i2', name: 'Chana', rates: [50], saleRates: [], wholesaleRates: [] }
        ];
        global.XLSX = {
            read: () => ({ SheetNames: ['s'], Sheets: { s: {} } }),
            utils: { sheet_to_json: () => [
                { ID: 'i1', 'Item Name': 'Gehu', 'Purchase Rates': '10, 10', 'Retail-Sale Rates': '30' },
                { ID: 'i2', 'Item Name': 'Chana', 'Purchase Rates': '50' }
            ] }
        };
        jest.spyOn(UIManager, 'showModalWithHtml').mockResolvedValue(true);
        jest.spyOn(UIManager, 'showLoading').mockImplementation(() => {});
        jest.spyOn(UIManager, 'hideLoading').mockImplementation(() => {});
        jest.spyOn(ItemsManager, 'downloadItemsWorkbook').mockResolvedValue(undefined);
        jest.spyOn(ItemsManager, 'refreshTable').mockImplementation(() => {});
        jest.spyOn(AuditService, 'log').mockResolvedValue(undefined);
        jest.spyOn(FirebaseService, 'importItems').mockResolvedValue([]);
        const add = jest.spyOn(FirebaseService, 'addRateHistoryEntries').mockResolvedValue(undefined);

        const input = { files: [{ arrayBuffer: async () => new ArrayBuffer(0) }], value: 'x' };
        await ItemsManager.importFromExcel({ target: input });

        expect(add).toHaveBeenCalledTimes(1);
        const [entries] = add.mock.calls[0];
        expect(entries).toHaveLength(1);
        expect(entries[0].id.startsWith('i1_')).toBe(true);
        expect(entries[0].data).toMatchObject({ itemId: 'i1', field: 'purchase', old: 12, new: 10, index: 1, source: 'import', byUserId: 'own1' });
        expect(AppState.items[0].rates).toEqual([10, 10]);
    });

    test('inline delete and inline edit keep the list position', async () => {
        AppState.items = [{ id: 'i1', name: 'Gehu', rates: [10, 12], saleRates: [30], wholesaleRates: [] }];
        jest.spyOn(FirebaseService, 'saveItem').mockResolvedValue(undefined);
        const add = jest.spyOn(FirebaseService, 'addRateHistoryEntries').mockResolvedValue(undefined);
        await ItemsManager.deleteRate('i1', 0);
        expect(add.mock.calls[0][0][0].data).toMatchObject({ field: 'purchase', old: 10, new: null, index: 0, source: 'inline' });

        ItemsManager.pendingOldValues = { k: 30 };
        ItemsManager.recordInlineChange('k', AppState.items[0], 'retail', 32, 0);
        expect(add.mock.calls[1][0][0].data).toMatchObject({ field: 'retail', old: 30, new: 32, index: 0 });
    });
});
