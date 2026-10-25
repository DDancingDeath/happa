/**
 * Business switcher (#149): shown only to people with rentals access, restores
 * the last choice per device, and never loads Rentals for shop-only users.
 */
jest.mock('../ui/ui-manager.js', () => ({ UIManager: { showToast: jest.fn(), hapticFeedback: jest.fn() } }));
jest.mock('../rentals/rentals.js', () => ({
    RentalsModule: { enter: jest.fn(() => Promise.resolve()), leave: jest.fn(), api: { page: jest.fn() } }
}));

import { AppState } from '../utils/state.js';
import { NavigationManager } from '../ui/navigation.js';
import { BusinessSwitcher, rentalsRole, savedBusiness, BUSINESS_KEY } from '../ui/business-switcher.js';
import { RentalsModule } from '../rentals/rentals.js';

beforeEach(() => {
    document.body.className = '';
    document.body.innerHTML = `
        <div class="biz-switch" id="bizSwitch" hidden>
            <button data-biz-btn="shop"></button><button data-biz-btn="rentals"></button>
        </div>
        <div class="side-nav active"></div><div class="overlay active"></div>
        <div id="billing" class="tab"></div>`;
    localStorage.clear();
    window.app = { rentals: {} };
    AppState.userRole = 'staff';
    AppState.rentRole = null;
    jest.spyOn(NavigationManager, 'showTabFromNav').mockImplementation(() => {});
});

test('rentalsRole: owner always, others only with a valid rentRole', () => {
    expect(rentalsRole({ userRole: 'owner' })).toBe('owner');
    expect(rentalsRole({ userRole: 'manager' })).toBeNull();
    expect(rentalsRole({ userRole: 'staff', rentRole: 'member' })).toBe('member');
    expect(rentalsRole({ userRole: 'staff', rentRole: 'owner' })).toBeNull();
});

test('shop-only user: switch hidden, Rentals never loaded even if the device remembers it', async () => {
    localStorage.setItem(BUSINESS_KEY, 'rentals');
    await BusinessSwitcher.init();
    expect(document.getElementById('bizSwitch').hidden).toBe(true);
    expect(document.body.classList.contains('biz-rentals')).toBe(false);
    expect(RentalsModule.enter).not.toHaveBeenCalled();
});

test('owner: switch shown; remembered Rentals opens after start; Shop goes back to Billing', async () => {
    AppState.userRole = 'owner';
    localStorage.setItem(BUSINESS_KEY, 'rentals');
    await BusinessSwitcher.init();
    expect(document.getElementById('bizSwitch').hidden).toBe(false);
    expect(document.body.classList.contains('biz-rentals')).toBe(true);
    expect(RentalsModule.enter).toHaveBeenCalledWith('rent');
    expect(window.app.rentals.page).toBe(RentalsModule.api.page);

    await BusinessSwitcher.set('shop');
    expect(savedBusiness()).toBe('shop');
    expect(document.body.classList.contains('biz-rentals')).toBe(false);
    expect(RentalsModule.leave).toHaveBeenCalled();
    expect(NavigationManager.showTabFromNav).toHaveBeenCalledWith('billing');
    expect(document.querySelector('[data-biz-btn="shop"]').getAttribute('aria-pressed')).toBe('true');
});

test('opening a shop page leaves Rentals (listeners detached)', async () => {
    AppState.userRole = 'staff';
    AppState.rentRole = 'member';
    await BusinessSwitcher.openRentals('tenants');
    RentalsModule.leave.mockClear();
    window.dispatchEvent(new CustomEvent('aadhat:tabshown', { detail: { tabId: 'rentals' } }));
    expect(RentalsModule.leave).not.toHaveBeenCalled();
    window.dispatchEvent(new CustomEvent('aadhat:tabshown', { detail: { tabId: 'settings' } }));
    expect(RentalsModule.leave).toHaveBeenCalledTimes(1);
});
