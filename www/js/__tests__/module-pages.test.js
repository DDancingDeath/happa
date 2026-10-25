/**
 * @fileoverview Everyday pages (#96): Items, Stock, Today (day.js),
 * Admin/Users, Settings and Diagnostics — a happy path plus edge cases each,
 * using the shared SAMPLE_ITEMS fixture, including Hindi/English search.
 *
 * Tests marked `test.skip` pin a known bug (see the referenced issue).
 */
import { ItemsManager } from '../modules/items.js';
import { StockManager } from '../modules/stock.js';
import { DayManager } from '../modules/day.js';
import { AdminManager } from '../modules/admin.js';
import { UsersManager } from '../modules/users.js';
import { SettingsManager } from '../modules/settings.js';
import { DiagnosticsManager } from '../modules/diagnostics.js';
import { RolesAccessManager } from '../modules/roles-access.js';
import { AuditService } from '../services/audit.js';
import { ROLE_ACCESS_DEFAULTS } from '../utils/role-access.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { TelemetryService } from '../services/telemetry.js';
import { UIManager } from '../ui/ui-manager.js';
import { Helpers } from '../utils/helpers.js';
import { AppState } from '../utils/state.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';
import { SAMPLE_ITEMS, sampleItems } from '../../../tests/fixtures/sample-items.js';

let toast;
beforeEach(() => {
    toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
    jest.spyOn(UIManager, 'hapticFeedback').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    AppState.items = sampleItems();
    AppState.stock = {};
    AppState.settings = { showHindi: false, laborRate: 6, heavyWeightThreshold: 30, autoLaborEnabled: true };
    AppState.userRole = 'owner';
    AppState.currentUser = { uid: 'owner1', email: 'o@x' };
    AppState.userName = 'Owner';
});
afterEach(() => jest.restoreAllMocks());

describe('Items', () => {
    beforeEach(() => {
        document.body.innerHTML = `
          <table><thead><tr><th class="wholesale-column"></th></tr></thead><tbody id="itemsViewTableBody"></tbody></table>
          <div id="itemsActionButtons"></div>
          <div id="itemEditOverlay" style="display:none"></div>
          <input id="itemModalName"><input id="itemModalHindiName"><input id="itemModalContactPerson">
          <button id="itemModalDeleteBtn"></button>
          <div id="itemModalPurchaseRates"></div><div id="itemModalWholesaleRates"></div><div id="itemModalSaleRates"></div>`;
    });
    const rowNames = () => [...document.querySelectorAll('#itemsViewTableBody tr')].map(r => r.cells[0].textContent.trim());

    test('lists every item alphabetically with its rates', () => {
        ItemsManager.renderItemsTable();
        expect(rowNames()).toEqual(['Maize', 'Mustard', 'Rice', 'Wheat']);
        const rice = [...document.querySelectorAll('#itemsViewTableBody tr')][2];
        expect([...rice.cells].map(c => c.textContent.trim())).toEqual(['Rice', '30', '36', '34']);
    });

    test.each([
        ['whe', ['Wheat']],
        ['RICE', ['Rice']],
        ['गेहूं', ['Wheat']],
        ['सरसों', ['Mustard']],
        ['xyz', ['No items found']]
    ])('search %s (English or Hindi)', (q, expected) => {
        ItemsManager.renderItemsTable(q);
        expect(rowNames()).toEqual(expected);
    });

    test('shows Hindi names when the setting is on', () => {
        AppState.settings.showHindi = true;
        ItemsManager.renderItemsTable();
        expect(rowNames()).toContain('चावल');
    });

    test('staff: wholesale column and edit actions hidden, rows not editable', () => {
        AppState.userRole = 'staff';
        ItemsManager.renderItemsTable();
        expect(document.querySelector('th.wholesale-column').style.display).toBe('none');
        expect(document.getElementById('itemsActionButtons').style.display).toBe('none');
        expect(document.querySelector('#itemsViewTableBody tr').cells).toHaveLength(3);
        document.querySelector('#itemsViewTableBody tr').click();
        expect(document.getElementById('itemEditOverlay').style.display).toBe('none');
    });

    test('clicking a sorted row edits that item (by id, not list position)', async () => {
        const save = jest.spyOn(FirebaseService, 'saveItem').mockResolvedValue(undefined);
        jest.spyOn(UIManager, 'showLoading').mockImplementation(() => {});
        ItemsManager.renderItemsTable();
        const wheatRow = [...document.querySelectorAll('#itemsViewTableBody tr')].find(r => r.cells[0].textContent.trim() === 'Wheat');
        wheatRow.click();
        expect(document.getElementById('itemModalName').value).toBe('Wheat');
        document.getElementById('itemModalHindiName').value = 'गेहूँ';
        ItemsManager.updateModalRate('sale', 0, '29');
        await ItemsManager.saveItemFromModal();
        expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: 'item-wheat', name: 'Wheat', hindiName: 'गेहूँ', saleRates: [29] }));
        expect(AppState.items.find(i => i.id === 'item-wheat').saleRates).toEqual([29]);
        expect(AppState.items.find(i => i.id === 'item-rice').saleRates).toEqual([36]);
    });

    test('a new item needs a name; empty rates are dropped', async () => {
        const save = jest.spyOn(FirebaseService, 'saveItem').mockImplementation(async (d) => ({ ...d, id: 'new1' }));
        ItemsManager.openAddModal();
        await ItemsManager.saveItemFromModal();
        expect(save).not.toHaveBeenCalled();
        expect(toast).toHaveBeenCalledWith('Please enter item name');

        document.getElementById('itemModalName').value = ' Barley ';
        ItemsManager.addModalRate('purchase');
        ItemsManager.addModalRate('purchase');
        ItemsManager.updateModalRate('purchase', 1, '18');
        await ItemsManager.saveItemFromModal();
        expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: 'Barley', rates: [18] }));
        expect(AppState.items).toHaveLength(SAMPLE_ITEMS.length + 1);
    });

    // #75: usage is counted from the real purchase/sale histories.
    test('most-used items sort first', () => {
        AppState.purchaseHistory = [{ items: [{ itemId: 'item-wheat', name: 'Wheat' }] }];
        ItemsManager.renderItemsTable();
        expect(rowNames()[0]).toMatch(/^Wheat/);
    });
});

describe('Stock', () => {
    beforeEach(() => {
        document.body.innerHTML = `
          <div id="stock"><button class="filter-btn"></button><button class="filter-btn"></button></div>
          <input id="stockSearchInput"><div id="stockList"></div>
          <select id="adjustItem"></select><select id="adjustType"><option>add</option><option>remove</option><option>set</option></select>
          <input id="adjustQuantity"><input id="adjustRate" value="0"><input id="adjustReason">
          <select id="adjustReasonCode"><option value=""></option><option value="count">count</option><option value="other">other</option></select>
          <span id="currentStockDisplay"></span><div id="avgRateDisplay"></div><span id="avgRateValue"></span>`;
        jest.spyOn(UIManager, 'withLoading').mockImplementation(async (fn) => fn());
    });

    const STOCK = {
        'item-rice': { quantity: 100, rate: 30 },
        Rice: { quantity: 50, rate: 36 },             // legacy name bucket, same item
        'item-wheat': { quantity: 40, rate: 24 },
        'item-maize': { quantity: 0, rate: 20 },      // empty: hidden
        'Old Bajra': { quantity: -5, rate: 0 }        // no catalogue item
    };
    const cloneStock = () => JSON.parse(JSON.stringify(STOCK));
    const rows = () => [...document.querySelectorAll('#stockList .stock-item')];

    test('merges id + legacy name buckets with a weighted rate; hides empty items; flags unmatched', async () => {
        jest.spyOn(FirebaseService, 'getStock').mockResolvedValue(cloneStock());
        await StockManager.renderStock();
        const text = rows().map(r => r.textContent.replace(/\s+/g, ' ').trim());
        expect(text).toHaveLength(3);
        expect(text[0]).toContain('Rice');
        expect(text[0]).toContain('Rate: ₹32.00/kg');   // (100×30 + 50×36) / 150
        expect(text[0]).toContain('150.0 kg');
        expect(text[0]).toContain('≈ ₹4800');
        expect(text[1]).toContain('Wheat');
        expect(text[1]).toContain('40.0 kg');
        expect(text[2]).toContain('Old Bajra');
        expect(text[2]).toContain('Unmatched');
    });

    test('staff see "Available" instead of quantity/value above 100 kg', async () => {
        AppState.userRole = 'staff';
        jest.spyOn(FirebaseService, 'getStock').mockResolvedValue(cloneStock());
        await StockManager.renderStock();
        expect(rows()[0].textContent).toContain('Available');
        expect(rows()[0].textContent).not.toContain('₹4800');
        expect(rows()[1].textContent).toContain('40.0 kg');
    });

    test('search filters rendered rows and shows "No items found"', async () => {
        jest.spyOn(FirebaseService, 'getStock').mockResolvedValue(cloneStock());
        await StockManager.renderStock();
        document.getElementById('stockSearchInput').value = 'WHE';
        StockManager.searchStock();
        expect(rows().filter(r => r.style.display !== 'none').map(r => r.textContent)).toEqual([expect.stringContaining('Wheat')]);
        document.getElementById('stockSearchInput').value = 'zzz';
        StockManager.searchStock();
        expect(document.querySelector('.no-results-message').textContent).toBe('No items found');
    });

    test('search by Hindi name when Hindi names are shown', async () => {
        AppState.settings.showHindi = true;
        jest.spyOn(FirebaseService, 'getStock').mockResolvedValue(cloneStock());
        await StockManager.renderStock();
        document.getElementById('stockSearchInput').value = 'गेहूं';
        StockManager.searchStock();
        expect(rows().filter(r => r.style.display !== 'none')).toHaveLength(1);
    });

    // BUG: see #96 — stock search only matches the displayed name, so a Hindi query finds nothing in English mode.
    test.skip('search by Hindi name while English names are shown', async () => {
        jest.spyOn(FirebaseService, 'getStock').mockResolvedValue(cloneStock());
        await StockManager.renderStock();
        document.getElementById('stockSearchInput').value = 'गेहूं';
        StockManager.searchStock();
        expect(rows().filter(r => r.style.display !== 'none')).toHaveLength(1);
    });

    test('add adjustment records previous stock from the id bucket (#29: replay folds legacy names into the id)', async () => {
        AppState.stock = cloneStock();
        const save = jest.spyOn(FirebaseService, 'saveStockAdjustment').mockResolvedValue(undefined);
        jest.spyOn(FirebaseService, 'calculateStock').mockResolvedValue({});
        jest.spyOn(StockManager, 'renderAdjustmentHistory').mockImplementation(() => {});
        StockManager.loadAdjustItemsDropdown();
        document.getElementById('adjustItem').value = 'item-rice';
        document.getElementById('adjustType').value = 'add';
        document.getElementById('adjustReasonCode').value = 'other';
        document.getElementById('adjustQuantity').value = '25';
        document.getElementById('adjustReason').value = 'recount';
        await StockManager.applyStockAdjustment();
        expect(save).toHaveBeenCalledWith(expect.objectContaining({
            itemId: 'item-rice', itemName: 'Rice', adjustType: 'add', quantity: 25,
            previousStock: 100, newStock: 125, reason: 'Other / अन्य: recount', createdBy: 'owner1'
        }));
    });

    test('rejects a missing item or non-positive quantity', async () => {
        const save = jest.spyOn(FirebaseService, 'saveStockAdjustment').mockResolvedValue(undefined);
        StockManager.loadAdjustItemsDropdown();
        await StockManager.applyStockAdjustment();
        expect(toast).toHaveBeenLastCalledWith('Please select an item');
        document.getElementById('adjustItem').value = 'item-rice';
        document.getElementById('adjustQuantity').value = '-3';
        await StockManager.applyStockAdjustment();
        expect(toast).toHaveBeenLastCalledWith(expect.stringMatching(/^Please enter a valid quantity/));
        expect(save).not.toHaveBeenCalled();
    });

    // #72: "Set" to 0 is allowed, but only with a reason.
    test('can set stock to 0 (with a reason)', async () => {
        AppState.stock = cloneStock();
        const save = jest.spyOn(FirebaseService, 'saveStockAdjustment').mockResolvedValue(undefined);
        jest.spyOn(FirebaseService, 'calculateStock').mockResolvedValue({});
        jest.spyOn(StockManager, 'renderAdjustmentHistory').mockImplementation(() => {});
        StockManager.loadAdjustItemsDropdown();
        const select = document.getElementById('adjustItem');
        select.value = [...select.options].find(o => /Wheat/.test(o.textContent)).value;
        document.getElementById('adjustType').value = 'set';
        document.getElementById('adjustQuantity').value = '0';
        await StockManager.applyStockAdjustment();
        expect(save).not.toHaveBeenCalled();

        document.getElementById('adjustReasonCode').value = 'other';
        document.getElementById('adjustReason').value = 'spoiled';
        await StockManager.applyStockAdjustment();
        expect(save).toHaveBeenCalledWith(expect.objectContaining({
            itemId: 'item-wheat', adjustType: 'set', previousStock: 40, newStock: 0,
            reasonCode: 'other', reason: expect.stringContaining('spoiled')
        }));
    });
});

describe('Today (day.js)', () => {
    const IDS = ['todayTotalPurchases', 'todayPurchaseCount', 'todayTotalSales', 'todaySaleCount', 'todayLaborCost',
        'todayBusinessExpenses', 'todayPersonalExpenses', 'todayTotalIn', 'todayTotalOut', 'todayNetCashFlow',
        'todayCashFlowLabel', 'todayCashReceived', 'todayOnlineReceived', 'todayCashPaid', 'todayOnlinePaid',
        'todayDueReceived', 'todayDuePaid', 'todayDueToReceive', 'todayDueToPay', 'todayPurchaseItems', 'todaySaleItems'];
    const val = (id) => document.getElementById(id).textContent;
    const money = (n) => Helpers.formatCurrency(n);

    beforeEach(() => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
        jest.setSystemTime(new Date(2026, 9, 21, 15, 0, 0)); // 21 Oct 2026, 3 pm IST
        document.body.innerHTML = IDS.map(id => `<div id="${id}"></div>`).join('');
        AppState.purchaseHistory = [
            { id: 'p1', date: '2026-10-21T09:00:00', grandTotal: 2568, billTotal: 2580, laborCharges: 12,
              items: [{ name: 'Rice', qty: 60, rate: 25.5, total: 1530 }, { name: 'Wheat', qty: 35, rate: 30, total: 1050 }],
              payment: { cash: 1000, online: 500, due: 1068 } },
            { id: 'p0', date: '20/10/2026', grandTotal: 999, payment: { cash: 999 } } // yesterday (DD/MM)
        ];
        AppState.salesHistory = [
            { id: 'w1', date: '2026-10-21T12:00:00', total: 5000, items: [{ name: 'Rice', qty: 140, rate: 35.71, total: 5000 }],
              payment: { cash: 3000, online: 0, due: 2000 } }
        ];
        AppState.retailSalesHistory = [
            { id: 'r1', date: '21/10/2026', total: 795, items: [{ name: 'Rice', qty: 12.5, rate: 36, total: 450 }, { name: 'Wheat', qty: 12, rate: 28.75, total: 345 }],
              cashPayment: 300, dueAmount: 495, payment: { cash: 300, online: 0, due: 495 } },
            { id: 'r2', date: '2026-10-22T00:30:00', total: 100, payment: { cash: 100 } } // tomorrow
        ];
        AppState.expensesHistory = [
            { id: 'e1', date: '2026-10-21', amount: 150, category: 'business' },
            { id: 'e2', date: '21/10/2026', amount: 80, category: 'personal' }
        ];
    });
    afterEach(() => {
        jest.useRealTimers();
        ['purchaseHistory', 'salesHistory', 'retailSalesHistory', 'expensesHistory'].forEach(k => { AppState[k] = []; });
    });

    test('headline numbers for the local day (ISO and DD/MM dates)', () => {
        DayManager.loadTodayData();
        expect(val('todayTotalPurchases')).toBe(money(2568));
        expect(val('todayPurchaseCount')).toBe('1 bills');
        expect(val('todayTotalSales')).toBe(money(5795));
        expect(val('todaySaleCount')).toBe('2 bills');
        expect(val('todayLaborCost')).toBe(money(12));
        expect(val('todayBusinessExpenses')).toBe(money(150));
        expect(val('todayPersonalExpenses')).toBe(money(80));
        expect(val('todayCashReceived')).toBe(money(3300));
        expect(val('todayOnlinePaid')).toBe(money(500));
        expect(val('todayCashPaid')).toBe(money(1000 + 230));
        expect(val('todayTotalIn')).toBe(money(3300));
        expect(val('todayTotalOut')).toBe(money(1730));
        expect(val('todayCashFlowLabel')).toBe('Net Inflow:');
        expect(val('todayNetCashFlow')).toBe(money(1570));
        expect(val('todayDueToReceive')).toBe(money(2495));
        expect(val('todayDueToPay')).toBe(money(1068));
    });

    test('item-wise cards aggregate quantity and value per item', () => {
        DayManager.loadTodayData();
        const sale = document.getElementById('todaySaleItems').textContent.replace(/\s+/g, ' ');
        expect(sale.indexOf('Rice')).toBeLessThan(sale.indexOf('Wheat')); // sorted by value
        expect(sale).toContain('152.50 kg');
        expect(sale).toContain('12.00 kg');
    });

    test('empty day', () => {
        ['purchaseHistory', 'salesHistory', 'retailSalesHistory', 'expensesHistory'].forEach(k => { AppState[k] = []; });
        DayManager.loadTodayData();
        expect(val('todayTotalSales')).toBe(money(0));
        expect(val('todayPurchaseItems')).toBe('No purchases today');
    });

    // #95: due payments recorded on bills today show as "due received".
    test('a due collected today shows as "due received"', () => {
        AppState.retailSalesHistory[0].payments = [{ amount: 200, date: '2026-10-21T14:00:00' }];
        DayManager.loadTodayData();
        expect(val('todayDueReceived')).toBe(money(200));
    });
});

describe('Admin → Users and Users manager', () => {
    let fake;
    beforeEach(() => {
        fake = createFakeFirestore();
        window.firebase = { ...fake.firebase, auth: () => ({ sendPasswordResetEmail: jest.fn(async () => {}) }) };
        global.firebase = window.firebase;
        jest.spyOn(UIManager, 'showLoading').mockImplementation(() => {});
        fake.seed('users', [
            { id: 'owner1', name: 'Owner', email: 'o@x', role: 'owner', status: 'active', createdAt: 1 },
            { id: 'new1', name: 'Newbie', email: 'n@x', role: 'staff', status: 'pending', createdAt: 3 },
            { id: 'legacy1', name: 'Legacy', email: 'l@x', role: 'manager' },           // no status, no createdAt
            { id: 'norole', name: 'NoRole', email: 'r@x', createdAt: 2 }               // no role → pending
        ]);
        document.body.innerHTML = '<div id="adminTabsContainer"></div><div id="adminContainer"></div><div id="pendingUsersList"></div><div id="activeUsersList"></div>';
    });
    afterEach(() => { delete window.firebase; delete global.firebase; });

    test('admin users tab splits pending (status pending or no role) from active users', async () => {
        AdminManager.activeTab = 'users';
        await AdminManager.init();
        await new Promise((r) => setTimeout(r)); // init() starts loadUsers without awaiting it
        const pending = document.getElementById('adminPendingUsers').textContent;
        const active = document.getElementById('adminActiveUsers').textContent;
        expect(pending).toContain('Newbie');
        expect(pending).toContain('NoRole');
        expect(active).toContain('Legacy');
        expect(active).toContain('Owner');
        expect(active).toContain('(You)');
    });

    test('approve writes role from the picker, active status and approver', async () => {
        AdminManager.activeTab = 'users';
        await AdminManager.init();
        await new Promise((r) => setTimeout(r)); // init() starts loadUsers without awaiting it
        document.getElementById('role-new1').value = 'manager';
        await AdminManager.approveUser('new1');
        expect(fake.raw('users').get('new1')).toMatchObject({ role: 'manager', status: 'active', approvedBy: 'owner1' });
        expect(document.getElementById('adminActiveUsers').textContent).toContain('Newbie');
    });

    test('reject deletes the profile only after confirmation', async () => {
        const modal = jest.spyOn(UIManager, 'showModal').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        await AdminManager.rejectUser('new1');
        expect(fake.raw('users').has('new1')).toBe(true);
        await AdminManager.rejectUser('new1');
        expect(fake.raw('users').has('new1')).toBe(false);
        expect(modal).toHaveBeenCalledTimes(2);
    });

    test('non-owners cannot open the admin panel', async () => {
        AppState.userRole = 'manager';
        AdminManager.activeTab = 'users';
        await AdminManager.init();
        await new Promise((r) => setTimeout(r)); // init() starts loadUsers without awaiting it
        expect(document.getElementById('adminTabsContainer').innerHTML).toBe('');
        expect(fake.stats.gets).toBe(0);
    });

    test('UsersManager: approve as a role, change role; non-owner loads nothing', async () => {
        await UsersManager.approveUser('new1', 'staff');
        expect(fake.raw('users').get('new1')).toMatchObject({ role: 'staff', status: 'active' });
        await UsersManager.changeUserRole('new1', 'manager');
        expect(fake.raw('users').get('new1').role).toBe('manager');
        AppState.userRole = 'staff';
        const gets = fake.stats.gets;
        await UsersManager.loadUsers();
        expect(fake.stats.gets).toBe(gets);
    });

    test('user names are escaped in the lists', async () => {
        fake.seed('users', [{ id: 'x1', name: '<img src=x onerror=alert(1)>', email: 'x@x', status: 'pending' }]);
        await AdminManager.loadUsers();
        expect(document.querySelector('#adminPendingUsers img')).toBeNull();
    });

    test('Admin → Configure saves the shared labour rate that billing uses (#21)', async () => {
        const shared = jest.spyOn(FirebaseService, 'saveSharedLabourSettings').mockResolvedValue(undefined);
        localStorage.setItem('laborChargeRate', '9'); // orphan key from the old screen
        AdminManager.renderConfigure();
        expect(document.getElementById('adminLaborRate').value).toBe('6');
        document.getElementById('adminLaborRate').value = '8';
        expect(await AdminManager.saveConfigure()).toBe(true);
        expect(AppState.settings.laborRate).toBe(8);
        expect(shared).toHaveBeenCalledWith({ laborRate: 8, heavyWeightThreshold: 30 });
        expect(localStorage.getItem('laborChargeRate')).toBeNull();
        // Re-opening Configure shows the same value Settings and billing use
        AdminManager.renderConfigure();
        expect(document.getElementById('adminLaborRate').value).toBe('8');
        localStorage.clear();
    });
});

describe('Settings', () => {
    let shared;
    beforeEach(() => {
        document.body.innerHTML = `
          <input id="settingHeavyWeight"><input id="settingLaborRate">
          <input type="checkbox" id="settingAutoLabor"><input type="checkbox" id="settingShowHindi">
          <span id="userEmail"></span><div id="auditLogsList"></div><select id="auditFilterAction"><option value=""></option><option>DELETE_BILL</option></select>`;
        window.app = { items: { render: jest.fn() }, billing: { loadItemsDropdown: jest.fn() } };
        AppState.printerSettings = { enabled: false };
        jest.spyOn(SettingsManager, 'updatePrinterStatus').mockImplementation(() => {});
        shared = jest.spyOn(FirebaseService, 'saveSharedLabourSettings').mockResolvedValue(undefined);
        localStorage.clear();
    });
    afterEach(() => { delete window.app; localStorage.clear(); });

    test('loads settings into the form and saves edits to AppState, localStorage and the shared setting', async () => {
        AppState.settings = { heavyWeightThreshold: 35, laborRate: 7, autoLaborEnabled: false, showHindi: true };
        SettingsManager.loadSettings();
        expect(document.getElementById('settingHeavyWeight').value).toBe('35');
        expect(document.getElementById('settingShowHindi').checked).toBe(true);
        expect(document.getElementById('userEmail').textContent).toBe('o@x');

        document.getElementById('settingLaborRate').value = '8';
        document.getElementById('settingAutoLabor').checked = true;
        expect(await SettingsManager.saveSettings()).toBe(true);
        expect(AppState.settings).toMatchObject({ heavyWeightThreshold: 35, laborRate: 8, autoLaborEnabled: true, showHindi: true });
        expect(JSON.parse(localStorage.getItem('settings')).laborRate).toBe(8);
        expect(shared).toHaveBeenCalledWith({ laborRate: 8, heavyWeightThreshold: 35 });
        expect(window.app.items.render).toHaveBeenCalled();
    });

    test('a blank or invalid labour rate is saved as ₹6 for everyone (#20)', async () => {
        AppState.settings.laborRate = 8;
        document.getElementById('settingHeavyWeight').value = '30';
        document.getElementById('settingLaborRate').value = '';
        await SettingsManager.saveSettings();
        expect(AppState.settings.laborRate).toBe(6);
        expect(shared).toHaveBeenCalledWith({ laborRate: 6, heavyWeightThreshold: 30 });
    });

    test('only the owner can change the shared labour rate (#20)', async () => {
        AppState.userRole = 'manager';
        SettingsManager.loadSettings();
        expect(document.getElementById('settingLaborRate').disabled).toBe(true);
        document.getElementById('settingLaborRate').value = '9';
        expect(await SettingsManager.saveSettings()).toBe(false);
        expect(shared).not.toHaveBeenCalled();
        expect(AppState.settings.laborRate).toBe(6);
        expect(document.getElementById('settingLaborRate').value).toBe('6');
    });

    test('startup: the shared value wins on every device; the owner seeds it once from this phone (#20)', async () => {
        AppState.userRole = 'staff';
        await SettingsManager.applySharedSettings({ minClientVersion: 3, laborRate: 7.5, heavyWeightThreshold: 'x' });
        expect(AppState.settings).toMatchObject({ laborRate: 7.5, heavyWeightThreshold: 30 });
        expect(JSON.parse(localStorage.getItem('settings')).laborRate).toBe(7.5);

        await SettingsManager.applySharedSettings(null);
        expect(shared).not.toHaveBeenCalled();

        AppState.userRole = 'owner';
        AppState.settings.laborRate = 5;
        await SettingsManager.applySharedSettings({ minClientVersion: 3 });
        expect(shared).toHaveBeenCalledWith({ laborRate: 5, heavyWeightThreshold: 30 });
    });

    test('audit log: owner-only, filter by action, user text escaped', async () => {
        AppState.userRole = 'staff';
        await SettingsManager.loadAuditLogs();
        expect(toast).toHaveBeenCalledWith('Only owners can view audit logs');

        SettingsManager.auditLogs = [
            { action: 'DELETE_BILL', timestamp: Date.now(), userName: '<b>x</b>', userRole: 'staff', details: { billNumber: 'P1', amount: 50 } },
            { action: 'CREATE_SALE', timestamp: Date.now(), userName: 'Asha', userRole: 'owner', details: {} }
        ];
        document.getElementById('auditFilterAction').value = 'DELETE_BILL';
        SettingsManager.renderAuditLogs();
        const list = document.getElementById('auditLogsList');
        expect(list.textContent).toContain('DELETE BILL');
        expect(list.textContent).toContain('Bill: P1 • Amount: ₹50');
        expect(list.textContent).not.toContain('Asha');
        expect(list.querySelector('b')).toBeNull();
    });

    test('Roles & access (#84): owner-only grid; saving writes settings/app and applies at once', async () => {
        document.body.innerHTML += `<div id="roleAccessCard" style="display:none"><div id="roleAccessGrid"></div><p id="roleAccessStatus"></p></div>`;
        const save = jest.spyOn(FirebaseService, 'saveRoleAccess').mockResolvedValue(undefined);
        jest.spyOn(AuditService, 'log').mockResolvedValue(undefined);

        AppState.userRole = 'manager';
        RolesAccessManager.render();
        expect(document.getElementById('roleAccessCard').style.display).toBe('none');
        expect(document.getElementById('roleAccessGrid').innerHTML).toBe('');
        expect(await RolesAccessManager.saveForm()).toBe(false);
        expect(save).not.toHaveBeenCalled();

        AppState.userRole = 'owner';
        RolesAccessManager.render();
        expect(document.getElementById('roleAccessCard').style.display).toBe('');
        expect(document.getElementById('ra-staff-finance').checked).toBe(false);
        expect(document.getElementById('ra-manager-finance').checked).toBe(true);
        expect(document.getElementById('ra-staff-editDays').value).toBe('2');
        expect(document.getElementById('roleAccessGrid').textContent).toContain('Member');
        expect(document.getElementById('roleAccessGrid').textContent).not.toMatch(/staff/i);

        document.getElementById('ra-staff-reports').checked = true;
        document.getElementById('ra-staff-personalExpenses').checked = false;
        document.getElementById('ra-staff-editDays').value = '45';
        expect(await RolesAccessManager.saveForm()).toBe(true);
        const saved = save.mock.calls[0][0];
        expect(saved.staff).toMatchObject({ reports: true, personalExpenses: false, editDays: 30, finance: false });
        expect(saved.manager).toEqual(ROLE_ACCESS_DEFAULTS.manager);
        expect(AppState.settings.roleAccess).toEqual(saved);
        expect(JSON.parse(localStorage.getItem('settings')).roleAccess.staff.reports).toBe(true);
        expect(AuditService.log).toHaveBeenCalledWith('CHANGE_ROLE_ACCESS', { changes: expect.stringContaining('staff.reports=true') });
        delete AppState.settings.roleAccess;
    });

    test('Roles & access: startup read uses settings/app.roleAccess, defaults when missing', () => {
        RolesAccessManager.applyShared({ roleAccess: { staff: { finance: true } } });
        expect(AppState.settings.roleAccess.staff.finance).toBe(true);
        RolesAccessManager.applyShared(null);
        expect(AppState.settings.roleAccess).toEqual(ROLE_ACCESS_DEFAULTS);
        delete AppState.settings.roleAccess;
    });
});

describe('Diagnostics', () => {
    const ERRORS = [
        { id: 'e1', type: 'uncaught', message: '<script>x</script>', count: 3, lastSeen: Date.UTC(2026, 9, 21, 6, 0) },
        { id: 'e2', type: 'console.error', message: 'boom', count: 1 },
        { id: 'e3', type: 'uncaught', message: 'again', count: 2 }
    ];
    beforeEach(() => {
        document.body.innerHTML = '<div id="diagnosticsTabsContainer"></div><div id="diagnosticsContainer"></div>';
        jest.spyOn(UIManager, 'showLoading').mockImplementation(() => {});
        DiagnosticsManager.filter = 'all';
        DiagnosticsManager.activeTab = 'errors';
    });

    test('owner sees error stats; messages are escaped', async () => {
        jest.spyOn(TelemetryService, 'getTelemetryData').mockResolvedValue(ERRORS);
        await DiagnosticsManager.init();
        const stats = [...document.querySelectorAll('.diag-stat-value')].map(e => e.textContent);
        expect(stats).toEqual(['3', '6', '2', '1']);
        expect(document.querySelectorAll('.diag-error-card')).toHaveLength(3);
        expect(document.querySelector('#diagnosticsContainer script')).toBeNull();
    });

    test('filter by type', async () => {
        jest.spyOn(TelemetryService, 'getTelemetryData').mockResolvedValue(ERRORS);
        await DiagnosticsManager.init();
        DiagnosticsManager.filterByType('console.error');
        expect([...document.querySelectorAll('.diag-error-message')].map(e => e.textContent)).toEqual(['boom']);
        DiagnosticsManager.filterByType('all');
    });

    test('non-owners are refused before any telemetry read', async () => {
        AppState.userRole = 'member';
        const read = jest.spyOn(TelemetryService, 'getTelemetryData').mockResolvedValue([]);
        await DiagnosticsManager.init();
        expect(read).not.toHaveBeenCalled();
        expect(document.getElementById('diagnosticsContainer').innerHTML).toBe('');
    });

    // #216: managers get Number checks only — still no telemetry read.
    test('managers see only Number checks and never read telemetry', async () => {
        AppState.userRole = 'manager';
        DiagnosticsManager.activeTab = 'errors';
        const read = jest.spyOn(TelemetryService, 'getTelemetryData').mockResolvedValue([]);
        await DiagnosticsManager.init();
        await DiagnosticsManager.showTab('errors');
        expect(read).not.toHaveBeenCalled();
        expect(DiagnosticsManager.activeTab).toBe('numbers');
    });

    // #114: Firestore Timestamps render as a real date.
    test('Firestore Timestamp "last seen" renders as a date', () => {
        const ts = { seconds: 1792560000, nanoseconds: 0, toDate: () => new Date(1792560000000), toMillis: () => 1792560000000 };
        const html = DiagnosticsManager.renderErrorCard({ id: 'e9', type: 'manual', message: 'm', lastSeen: ts });
        expect(html).not.toContain('Invalid Date');
    });
});
