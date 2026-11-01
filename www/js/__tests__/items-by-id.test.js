/**
 * @fileoverview Items page acts on item ids, never list positions (#29),
 * and blocks duplicate item names.
 */

jest.mock('../firebase/firestore-service.js', () => ({
    FirebaseService: {
        saveItem: jest.fn(async (item) => item),
        setItemArchived: jest.fn(async (id, archived) => ({ archived })),
        notifyRateChange: jest.fn(async () => {}),
        notifyRateChanges: jest.fn(async () => {}),
        notifyItemEdit: jest.fn(async () => {}),
        addRateHistoryEntries: jest.fn(async () => {})
    }
}));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(async () => {}), note: jest.fn(), ACTIONS: { ARCHIVE_ITEM: 'ARCHIVE_ITEM', UNARCHIVE_ITEM: 'UNARCHIVE_ITEM' } } }));
jest.mock('../ui/ui-manager.js', () => ({
    UIManager: {
        showToast: jest.fn(),
        showLoading: jest.fn(),
        hideLoading: jest.fn(),
        showModal: jest.fn(async () => true),
        showModalWithHtml: jest.fn(async () => true),
        withLoading: jest.fn(async (fn) => fn())
    }
}));

import { FirebaseService } from '../firebase/firestore-service.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { ItemsManager } from '../modules/items.js';
import { findDuplicateItem, normalizeItemName, itemUsageFrequency, visibleItems, duplicateItemMessage } from '../utils/item-catalog.js';

const A = () => ({ id: 'a', name: 'Chana', hindiName: 'चना', rates: [50], saleRates: [], wholesaleRates: [] });
const B = () => ({ id: 'b', name: 'Gehu', hindiName: 'गेहूं', rates: [30], saleRates: [], wholesaleRates: [], createdAt: 123 });
const C = () => ({ id: 'c', name: 'Moong', hindiName: '', rates: [], saleRates: [], wholesaleRates: [] });

function setupDom() {
    document.body.innerHTML = `
        <input id="itemsSearchInput" value="">
        <input type="checkbox" id="itemsShowArchived">
        <table><tbody id="itemsViewTableBody"></tbody></table>
        <div id="itemEditOverlay" style="display:none">
            <input id="itemModalName"><input id="itemModalHindiName"><input id="itemModalContactPerson">
            <div id="itemModalPurchaseRates"></div><div id="itemModalWholesaleRates"></div><div id="itemModalSaleRates"></div>
            <button id="itemModalArchiveBtn"></button>
        </div>`;
}

beforeEach(() => {
    setupDom();
    AppState.items = [A(), B(), C()];
    AppState.stock = {};
    AppState.userRole = 'owner';
    AppState.settings = { showHindi: false };
    FirebaseService.saveItem.mockClear();
    FirebaseService.setItemArchived.mockClear();
    ItemsManager.showArchived = false;
    UIManager.showToast.mockClear();
    UIManager.showModal.mockImplementation(async () => true);
});

describe('edit dialog uses the item id', () => {
    test('list changes while the dialog is open → the edited item (by id) is saved', async () => {
        ItemsManager.openEditModal('b');
        // Another phone deletes "Chana" and the live listener replaces the array
        AppState.items = [C(), B()];
        document.getElementById('itemModalName').value = 'Gehu Sharbati';
        await ItemsManager.saveItemFromModal();

        expect(FirebaseService.saveItem).toHaveBeenCalledTimes(1);
        const saved = FirebaseService.saveItem.mock.calls[0][0];
        expect(saved.id).toBe('b');
        expect(saved.name).toBe('Gehu Sharbati');
        expect(saved.createdAt).toBe(123);
        expect(AppState.items.map(i => i.name)).toEqual(['Moong', 'Gehu Sharbati']);
    });

    test('item deleted elsewhere while editing → nothing is saved', async () => {
        ItemsManager.openEditModal('b');
        AppState.items = [A(), C()];
        await ItemsManager.saveItemFromModal();
        expect(FirebaseService.saveItem).not.toHaveBeenCalled();
        expect(AppState.items.map(i => i.id)).toEqual(['a', 'c']);
    });

    test('list changes while the archive confirm is open → the right item is archived, never deleted', async () => {
        ItemsManager.openEditModal('b');
        UIManager.showModal.mockImplementation(async () => {
            AppState.items = [C(), B(), A()];
            return true;
        });
        await ItemsManager.archiveFromModal();
        expect(FirebaseService.setItemArchived).toHaveBeenCalledWith('b', true);
        expect(AppState.items.map(i => i.id)).toEqual(['c', 'b', 'a']);
        expect(AppState.items[1].archived).toBe(true);
    });

    test('item vanishes during the archive confirm → nothing written', async () => {
        UIManager.showModal.mockImplementation(async () => {
            AppState.items = [A(), C()];
            return true;
        });
        await ItemsManager.archiveItem('b');
        expect(FirebaseService.setItemArchived).not.toHaveBeenCalled();
    });
});

describe('archive instead of delete (#123)', () => {
    const rowNames = () => [...document.querySelectorAll('#itemsViewTableBody tr')].map(r => r.cells[0].textContent.trim());

    test('a member cannot archive; owner and manager can', async () => {
        AppState.userRole = 'staff';
        await ItemsManager.archiveItem('b');
        expect(FirebaseService.setItemArchived).not.toHaveBeenCalled();
        AppState.userRole = 'manager';
        await ItemsManager.archiveItem('b');
        expect(FirebaseService.setItemArchived).toHaveBeenCalledWith('b', true);
    });

    test('the confirm warns when the item still has stock', async () => {
        AppState.stock = { b: { quantity: 12.5, rate: 30 } };
        await ItemsManager.archiveItem('b');
        expect(UIManager.showModal.mock.calls[0][0]).toMatch(/12\.5 kg in stock/);
    });

    test('archived items are hidden from the list until "Show archived", then shown with a chip', () => {
        AppState.items[1].archived = true;
        ItemsManager.renderItemsTable();
        expect(rowNames()).not.toContain('Gehu');
        ItemsManager.toggleArchived(true);
        const gehu = [...document.querySelectorAll('#itemsViewTableBody tr')].find(r => r.textContent.includes('Gehu'));
        expect(gehu.querySelector('.item-archived-chip')).not.toBeNull();
    });

    test('the dialog of an archived item offers Unarchive, which brings it back', async () => {
        AppState.items[1].archived = true;
        ItemsManager.openEditModal('b');
        expect(document.getElementById('itemModalArchiveBtn').textContent).toBe('Unarchive item');
        await ItemsManager.archiveFromModal();
        expect(FirebaseService.setItemArchived).toHaveBeenCalledWith('b', false);
        expect(AppState.items[1].archived).toBe(false);
    });

    test('offline: nothing is written', async () => {
        const spy = jest.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        try {
            await ItemsManager.archiveItem('b');
            expect(FirebaseService.setItemArchived).not.toHaveBeenCalled();
            expect(UIManager.showToast.mock.calls.at(-1)[0]).toMatch(/needs the internet/);
        } finally {
            spy.mockRestore();
        }
    });

    test('a name used by an archived item is refused with an unarchive hint', async () => {
        AppState.items[1].archived = true;
        ItemsManager.openAddModal();
        document.getElementById('itemModalName').value = 'gehu';
        await ItemsManager.saveItemFromModal();
        expect(FirebaseService.saveItem).not.toHaveBeenCalled();
        expect(UIManager.showToast.mock.calls[0][0]).toBe(duplicateItemMessage('Gehu', AppState.items[1]));
        expect(UIManager.showToast.mock.calls[0][0]).toMatch(/archived/);
    });

    test('visibleItems leaves archived items out unless asked', () => {
        const items = [A(), { ...B(), archived: true }];
        expect(visibleItems(items).map(i => i.id)).toEqual(['a']);
        expect(visibleItems(items, { showArchived: true }).map(i => i.id)).toEqual(['a', 'b']);
    });
});

describe('debounced saves target the item by id', () => {
    test('rate edit saves the same item after the list reorders', async () => {
        jest.useFakeTimers();
        try {
            ItemsManager.updateRate('b', 0, '35');
            AppState.items = [AppState.items[2], AppState.items[1], AppState.items[0]];
            jest.advanceTimersByTime(600);
            await Promise.resolve();
            expect(FirebaseService.saveItem).toHaveBeenCalledTimes(1);
            const saved = FirebaseService.saveItem.mock.calls[0][0];
            expect(saved.id).toBe('b');
            expect(saved.rates).toEqual([35]);
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('table rows', () => {
    test('row click opens the clicked item even after a re-sort', () => {
        ItemsManager.renderItemsTable();
        const rows = [...document.querySelectorAll('#itemsViewTableBody tr')];
        const gehuRow = rows.find(r => r.textContent.includes('Gehu'));
        AppState.items = [B(), C(), A()];
        gehuRow.onclick();
        expect(ItemsManager.currentEditingItemId).toBe('b');
        expect(document.getElementById('itemModalName').value).toBe('Gehu');
    });
});

describe('duplicate item names are blocked', () => {
    test('adding a name that differs only by case/spaces is refused', async () => {
        ItemsManager.openAddModal();
        document.getElementById('itemModalName').value = '  chANa ';
        await ItemsManager.saveItemFromModal();
        expect(FirebaseService.saveItem).not.toHaveBeenCalled();
        expect(UIManager.showToast.mock.calls[0][0]).toMatch(/"chANa" already exists|already exists/);
    });

    test('a Hindi name clash is refused on edit', async () => {
        ItemsManager.openEditModal('c');
        document.getElementById('itemModalHindiName').value = 'गेहूं ';
        await ItemsManager.saveItemFromModal();
        expect(FirebaseService.saveItem).not.toHaveBeenCalled();
    });

    test('saving an item under its own name is allowed', async () => {
        ItemsManager.openEditModal('a');
        await ItemsManager.saveItemFromModal();
        expect(FirebaseService.saveItem).toHaveBeenCalledTimes(1);
    });

    test('findDuplicateItem normalises case, spaces and checks both names', () => {
        const items = [A(), B()];
        expect(findDuplicateItem(items, { name: 'GEHU' })?.item.id).toBe('b');
        expect(findDuplicateItem(items, { name: 'chana  dal' })).toBeNull();
        expect(findDuplicateItem(items, { name: 'X', hindiName: 'चना' })?.item.id).toBe('a');
        expect(findDuplicateItem(items, { name: 'chana' }, 'a')).toBeNull();
        expect(findDuplicateItem(items, { name: '', hindiName: '' })).toBeNull();
        expect(normalizeItemName('  Piyar   Dana ')).toBe('piyar dana');
    });
});

describe('most-used sort (#75)', () => {
    const histories = () => ({
        purchaseHistory: [
            { items: [{ itemId: 'c', name: 'Moong' }, { name: 'gehu ' }] },
            { items: [{ itemId: 'c', name: 'Moong' }] }
        ],
        salesHistory: [{ items: [{ name: 'मूंग', itemId: 'gone' }, { itemId: 'c', name: 'Moong' }] }],
        retailSalesHistory: [{ items: [{ itemName: 'गेहूं' }, { name: 'unknown thing' }] }]
    });

    afterEach(() => {
        AppState.purchaseHistory = [];
        AppState.salesHistory = [];
        AppState.retailSalesHistory = [];
    });

    test('itemUsageFrequency counts bill lines per item id across all three histories', () => {
        const items = [A(), B(), { ...C(), hindiName: 'मूंग' }];
        const h = histories();
        expect(itemUsageFrequency({
            purchases: h.purchaseHistory, wholesaleSales: h.salesHistory, retailSales: h.retailSalesHistory
        }, items)).toEqual({ c: 4, b: 2 });
    });

    test('Items table sorts most used first without showing the usage count', () => {
        Object.assign(AppState, histories());
        ItemsManager.renderItemsTable();
        const rows = [...document.querySelectorAll('#itemsViewTableBody tr')];
        expect(rows.map(r => r.cells[0].textContent.trim())).toEqual(['Moong', 'Gehu', 'Chana']);
        expect(rows.every(r => r.cells[0].querySelector('span') === null)).toBe(true);
    });
});
describe('rate / name history on save (#82)', () => {
    beforeEach(() => {
        FirebaseService.addRateHistoryEntries.mockClear();
        UIManager.showModalWithHtml.mockClear();
        UIManager.showModalWithHtml.mockImplementation(async () => true);
        AppState.currentUser = { uid: 'owner1' };
        AppState.userName = 'Owner';
        ItemsManager.lastChangeAt = {};
    });

    const entriesWritten = () => FirebaseService.addRateHistoryEntries.mock.calls.flatMap(c => c[0].map(e => e.data));

    test('typing 4 then 45 in the dialog writes one entry 50 → 45 (value at edit start)', async () => {
        ItemsManager.openEditModal('a');
        ItemsManager.updateModalRate('purchase', 0, '4');
        ItemsManager.updateModalRate('purchase', 0, '45');
        await ItemsManager.saveItemFromModal();
        const written = entriesWritten();
        expect(written).toHaveLength(1);
        expect(written[0]).toMatchObject({ itemId: 'a', field: 'purchase', old: 50, new: 45, byUserId: 'owner1', source: 'modal', flags: [] });
        expect(UIManager.showModalWithHtml).not.toHaveBeenCalled();
    });

    test('rate more than 2× asks first; cancel saves nothing', async () => {
        UIManager.showModalWithHtml.mockImplementation(async () => false);
        ItemsManager.openEditModal('a');
        ItemsManager.updateModalRate('purchase', 0, '500');
        await ItemsManager.saveItemFromModal();
        expect(UIManager.showModalWithHtml.mock.calls[0][0]).toMatch(/₹50 → ₹500/);
        expect(FirebaseService.saveItem).not.toHaveBeenCalled();
        expect(FirebaseService.addRateHistoryEntries).not.toHaveBeenCalled();
    });

    test('rename asks first, explains old bills, and records name history when confirmed', async () => {
        ItemsManager.openEditModal('b');
        document.getElementById('itemModalName').value = 'Wheat';
        await ItemsManager.saveItemFromModal();
        expect(UIManager.showModalWithHtml.mock.calls[0][0]).toMatch(/Old bills keep the old name/);
        expect(entriesWritten()).toEqual([expect.objectContaining({ field: 'name', old: 'Gehu', new: 'Wheat' })]);
    });

    test('second change of the same field within 60 s is flagged', async () => {
        ItemsManager.openEditModal('a');
        ItemsManager.updateModalRate('purchase', 0, '52');
        await ItemsManager.saveItemFromModal();
        ItemsManager.openEditModal('a');
        ItemsManager.updateModalRate('purchase', 0, '53');
        await ItemsManager.saveItemFromModal();
        expect(entriesWritten()[1]).toMatchObject({ old: 52, new: 53, flags: ['quick-repeat'] });
    });

    test('no history writes for a user who is not owner/manager, or when nothing changed', async () => {
        ItemsManager.openEditModal('a');
        await ItemsManager.saveItemFromModal();
        AppState.userRole = 'staff';
        ItemsManager.openEditModal('a');
        ItemsManager.updateModalRate('purchase', 0, '55');
        await ItemsManager.saveItemFromModal();
        expect(FirebaseService.saveItem).toHaveBeenCalledTimes(2);
        expect(FirebaseService.addRateHistoryEntries).not.toHaveBeenCalled();
    });

    test('inline rate typing records the value from before the burst, once', async () => {
        jest.useFakeTimers();
        try {
            ItemsManager.updateRate('b', 0, '4');
            ItemsManager.updateRate('b', 0, '45');
            jest.advanceTimersByTime(600);
            await Promise.resolve();
            await Promise.resolve();
            expect(entriesWritten()).toEqual([expect.objectContaining({ itemId: 'b', field: 'purchase', old: 30, new: 45, source: 'inline' })]);
            // The notification goes out once, when the input is committed (#12)
            expect(FirebaseService.notifyRateChange).not.toHaveBeenCalled();
            ItemsManager.commitRate('b', 0);
            expect(FirebaseService.notifyRateChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }), 'purchase', 30, 45);
            expect(FirebaseService.notifyRateChange).toHaveBeenCalledTimes(1);
        } finally {
            jest.useRealTimers();
        }
    });
});
