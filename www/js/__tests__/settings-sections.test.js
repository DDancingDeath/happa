/**
 * Settings sections: Common for everyone; Aadhat (internal 'shop') and Rentals
 * only for their owner/manager, picked by the business switcher with a toggle
 * to the other one; old routes still open the right place; the business is
 * called Aadhat / आढ़त on screen.
 */
jest.mock('../ui/ui-manager.js', () => ({ UIManager: { showToast: jest.fn(), hapticFeedback: jest.fn(), showModal: jest.fn() } }));

const fs = require('fs');
const path = require('path');
import { settingsView, shopRoleOf, rentRoleOf } from '../utils/settings-sections.js';
import { SettingsManager } from '../modules/settings.js';
import { BusinessSwitcher } from '../ui/business-switcher.js';
import { NavigationManager, resolveRoute } from '../ui/navigation.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { t, setLang, resetLangForTests, applyTranslations } from '../i18n/index.js';

const TEMPLATES = path.join(__dirname, '..', '..', 'templates');
const html = (f) => fs.readFileSync(path.join(TEMPLATES, f), 'utf8');
const shown = (id) => !document.getElementById(id).hidden;

describe('settingsView (pure)', () => {
    test('roles per business', () => {
        expect([shopRoleOf('owner'), shopRoleOf('manager'), shopRoleOf('staff'), shopRoleOf('none')]).toEqual(['owner', 'manager', 'member', null]);
        expect(rentRoleOf('owner', null)).toBe('owner');
        expect(rentRoleOf('staff', 'manager')).toBe('manager');
        expect(rentRoleOf('manager', 'owner')).toBeNull();
    });

    test.each([
        // userRole, rentRole, business, active, other
        ['owner', null, 'shop', 'shop', 'rentals'],
        ['owner', null, 'rentals', 'rentals', 'shop'],
        ['manager', null, 'shop', 'shop', null],
        ['manager', 'member', 'rentals', null, 'shop'],
        ['staff', null, 'shop', null, null],
        ['staff', 'member', 'rentals', null, null],
        ['staff', 'manager', 'shop', null, 'rentals'],
        ['staff', 'manager', 'rentals', 'rentals', null],
        ['none', 'manager', 'rentals', 'rentals', null],
        ['manager', 'manager', 'shop', 'shop', 'rentals']
    ])('%s / rent %s on %s -> %s (toggle %s)', (userRole, rentRole, business, active, other) => {
        const v = settingsView({ userRole, rentRole, business });
        expect(v.active).toBe(active);
        expect(v.other).toBe(other);
    });

    test('a chosen section wins only when the user may see it', () => {
        expect(settingsView({ userRole: 'owner', business: 'shop', choice: 'rentals' }).active).toBe('rentals');
        expect(settingsView({ userRole: 'manager', business: 'shop', choice: 'rentals' }).active).toBe('shop');
    });

    test('editing: owner always; manager in Aadhat only when Roles & access allows; rentals manager edits Rentals', () => {
        expect(settingsView({ userRole: 'owner' }).shop.editable).toBe(true);
        expect(settingsView({ userRole: 'manager' }).shop.editable).toBe(false);
        expect(settingsView({ userRole: 'manager', roleAccess: { manager: { shopSettings: true } } }).shop.editable).toBe(true);
        expect(settingsView({ userRole: 'staff', roleAccess: { staff: { shopSettings: true } } }).shop.editable).toBe(false);
        expect(settingsView({ userRole: 'staff', rentRole: 'manager' }).rentals.editable).toBe(true);
        expect(settingsView({ userRole: 'staff', rentRole: 'member' }).rentals.visible).toBe(false);
    });
});

describe('Settings page sections (jsdom)', () => {
    let mount;
    beforeEach(() => {
        document.body.innerHTML = html('settings.html');
        localStorage.clear();
        SettingsManager.sectionChoice = null;
        AppState.settings = { laborRate: 6, heavyWeightThreshold: 30, shopName: 'Gupta Aadhat', upiId: 'gupta@upi' };
        AppState.printerSettings = { enabled: false };
        AppState.currentUser = { uid: 'u1', email: 'u@x' };
        AppState.userName = 'Asha';
        window.app = { printer: null };
        mount = jest.fn(async (el) => { el.innerHTML = '<p id="rentMounted">rentals</p>'; });
        jest.spyOn(BusinessSwitcher, 'current').mockReturnValue('shop');
        jest.spyOn(BusinessSwitcher, 'loadSettings').mockResolvedValue({ mount, save: jest.fn() });
        jest.spyOn(FirebaseService, 'loadAppSettings').mockImplementation(() => { throw new Error('no reads'); });
        jest.spyOn(FirebaseService, 'loadUsers').mockImplementation(() => { throw new Error('no reads'); });
    });
    afterEach(() => { jest.restoreAllMocks(); delete window.app; resetLangForTests(); });
    const as = (userRole, rentRole = null, roleAccess) => {
        AppState.userRole = userRole;
        AppState.rentRole = rentRole;
        if (roleAccess) AppState.settings.roleAccess = roleAccess;
    };

    test('member: only Common (language, account, printer, notifications, install, about)', () => {
        as('staff');
        SettingsManager.open();
        expect(shown('settingsCommon')).toBe(true);
        expect(shown('settingsShop')).toBe(false);
        expect(shown('settingsRentals')).toBe(false);
        expect(shown('settingsBizBar')).toBe(false);
        ['languageSettingsCard', 'accountCard', 'notifSettingsCard', 'installAppCard'].forEach(id => {
            expect(document.getElementById(id).closest('#settingsCommon')).not.toBeNull();
        });
        expect(document.getElementById('settingBluetoothEnabled').closest('#settingsCommon')).not.toBeNull();
        expect(document.getElementById('settingUserName').value).toBe('Asha');
        expect(BusinessSwitcher.loadSettings).not.toHaveBeenCalled();
    });

    test('Aadhat-only manager never sees Rentals; view-only without the Roles & access switch', () => {
        as('manager');
        SettingsManager.open();
        expect(shown('settingsShop')).toBe(true);
        expect(shown('settingsRentals')).toBe(false);
        expect(shown('settingsBizToggle')).toBe(false);
        expect(document.getElementById('settingBusinessName').disabled).toBe(true);
        expect(document.getElementById('settingLaborRate').disabled).toBe(true);
        expect(document.getElementById('settingCheck_cashOkRs').disabled).toBe(true);
        expect(shown('settingsShopViewOnly')).toBe(true);
        // the opening stock shortcut and the per-device UPI stay usable
        expect(document.getElementById('settingUpiId').value).toBe('gupta@upi');
        expect(document.getElementById('settingUpiId').disabled).toBe(false);
    });

    test('manager allowed in Roles & access edits the Aadhat settings', () => {
        as('manager', null, { manager: { shopSettings: true } });
        SettingsManager.open('shop');
        expect(document.getElementById('settingBusinessName').disabled).toBe(false);
        expect(document.getElementById('settingBusinessName').value).toBe('Gupta Aadhat');
        expect(document.getElementById('settingLaborRate').disabled).toBe(false);
        expect(shown('settingsShopViewOnly')).toBe(false);
    });

    test('owner on Aadhat: Aadhat section plus a toggle; Rentals loads only when toggled', async () => {
        as('owner');
        SettingsManager.open();
        expect(shown('settingsShop')).toBe(true);
        expect(document.getElementById('settingsBizTitle').textContent).toBe('Aadhat settings');
        expect(document.getElementById('settingsBizToggle').textContent).toBe('View Rentals settings');
        expect(BusinessSwitcher.loadSettings).not.toHaveBeenCalled();
        SettingsManager.showOther();
        await new Promise(r => setTimeout(r));
        expect(shown('settingsShop')).toBe(false);
        expect(shown('settingsRentals')).toBe(true);
        expect(mount).toHaveBeenCalledWith(document.getElementById('settingsRentalsBody'), { editable: true });
        expect(document.getElementById('settingsBizToggle').textContent).toBe('View Aadhat settings');
    });

    test('Rentals is the current business: Rentals section first', async () => {
        BusinessSwitcher.current.mockReturnValue('rentals');
        as('staff', 'manager');
        SettingsManager.open();
        await new Promise(r => setTimeout(r));
        expect(shown('settingsRentals')).toBe(true);
        expect(shown('settingsShop')).toBe(false);
        expect(shown('settingsBizToggle')).toBe(false);
        expect(document.getElementById('rentMounted')).not.toBeNull();
    });

    test('rentals member sees only Common, even on Rentals', () => {
        BusinessSwitcher.current.mockReturnValue('rentals');
        as('staff', 'member');
        SettingsManager.open();
        expect(shown('settingsRentals')).toBe(false);
        expect(shown('settingsShop')).toBe(false);
        expect(BusinessSwitcher.loadSettings).not.toHaveBeenCalled();
    });

    test('saving the business name writes settings/app and is used on bills', async () => {
        as('owner');
        SettingsManager.open();
        const save = jest.spyOn(FirebaseService, 'saveBusinessDetails').mockResolvedValue();
        document.getElementById('settingBusinessName').value = '  Sharma   Aadhat ';
        document.getElementById('settingBusinessDetails').value = 'Mandi road';
        expect(await SettingsManager.saveBusinessDetails()).toBe(true);
        expect(save).toHaveBeenCalledWith({ businessName: 'Sharma Aadhat', businessDetails: 'Mandi road' });
        expect(AppState.settings.shopName).toBe('Sharma Aadhat');
        as('manager');
        save.mockClear();
        expect(await SettingsManager.saveBusinessDetails()).toBe(false);
        expect(save).not.toHaveBeenCalled();
    });

    test('bill checks are edited in Settings (moved from Admin › Configure)', async () => {
        as('owner');
        SettingsManager.open();
        const save = jest.spyOn(FirebaseService, 'saveSharedCheckThresholds').mockResolvedValue();
        document.getElementById('settingCheck_cashOkRs').value = '75';
        expect(await SettingsManager.saveCheckThresholds()).toBe(true);
        expect(save.mock.calls[0][0].cashOkRs).toBe(75);
    });

    test('start-up shared read sets the business name; no name in settings/app keeps the device one', async () => {
        as('staff');
        await SettingsManager.applySharedSettings({ laborRate: 6, businessName: 'Shared', businessDetails: 'Line' });
        expect(AppState.settings).toMatchObject({ shopName: 'Shared', businessDetails: 'Line' });
        await SettingsManager.applySharedSettings({ laborRate: 6 });
        expect(AppState.settings.shopName).toBe('Shared');
    });
});

describe('old routes still work', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="settings" class="tab"></div><div id="admin" class="tab"></div><nav class="nav-menu"><a onclick="window.app.nav.showTab(\'settings\', event)"></a></nav>';
        window.app = { settings: { load: jest.fn() } };
        AppState.userRole = 'owner';
        jest.useFakeTimers();
    });
    afterEach(() => { jest.useRealTimers(); delete window.app; });

    test.each([
        ['settings', 'settings', null],
        ['settings-shop', 'settings', 'shop'],
        ['settings-aadhat', 'settings', 'shop'],
        ['admin-configure', 'settings', 'shop'],
        ['settings-rentals', 'settings', 'rentals'],
        ['settings-roles', 'settings', 'roles']
    ])('%s opens %s (%s)', (route, tab, section) => {
        expect(resolveRoute(route)).toMatchObject({ tab, section });
        NavigationManager.showTabFromNav(route);
        jest.runOnlyPendingTimers();
        expect(document.getElementById('settings').classList.contains('active')).toBe(true);
        expect(window.app.settings.load).toHaveBeenCalledWith(section);
        expect(document.querySelector('.nav-menu a').classList.contains('active')).toBe(true);
    });
});

describe('the business is called Aadhat (internal id stays shop)', () => {
    afterEach(() => resetLangForTests());

    test('English and Hindi labels', () => {
        setLang('en');
        expect([t('ui.biz.shop'), t('ui.settings.section_shop'), t('ui.roles.shop_role'), t('ui.rent.shop_role', { role: 'Manager' }), t('ui.role.none')])
            .toEqual(['Aadhat', 'Aadhat settings', 'Aadhat role', 'Aadhat: Manager', 'No Aadhat access']);
        expect(t('ui.settings.business_name')).toBe('Business name');
        setLang('hi');
        expect([t('ui.biz.shop'), t('ui.settings.section_shop'), t('ui.roles.shop_role'), t('ui.role.none')])
            .toEqual(['आढ़त', 'आढ़त की सेटिंग', 'आढ़त में भूमिका', 'आढ़त की पहुँच नहीं']);
        expect(t('ui.settings.business_name')).toBe('व्यापार का नाम');
    });

    test('the switcher reads Aadhat | Rentals and keeps the stored key "shop"', () => {
        document.body.innerHTML = html('navigation.html');
        setLang('en');
        applyTranslations(document);
        const btn = document.querySelector('[data-biz-btn="shop"]');
        expect(btn.textContent).toContain('Aadhat');
        expect(btn.getAttribute('onclick')).toContain("set('shop')");
        setLang('hi');
        applyTranslations(document);
        expect(btn.textContent).toContain('आढ़त');
    });
});
