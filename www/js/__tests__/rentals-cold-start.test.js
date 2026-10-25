/**
 * Cold start never loads Rentals (#149 owner rule "doesn't make the app slow",
 * review of #10): BusinessSwitcher.init() for a shop-only user, for a rentals
 * user and for the owner, with or without an old saved choice, imports nothing
 * from js/rentals. The rentals module mock records whether import() ran.
 */
const loaded = { rentals: false };
jest.mock('../ui/ui-manager.js', () => ({ UIManager: { showToast: jest.fn(), hapticFeedback: jest.fn() } }));
jest.mock('../rentals/rentals.js', () => {
    loaded.rentals = true;
    return { RentalsModule: { enter: jest.fn(), leave: jest.fn(), api: {} } };
});

import { AppState } from '../utils/state.js';
import { BusinessSwitcher } from '../ui/business-switcher.js';

const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
    document.body.innerHTML = '<div id="bizSwitch" hidden></div>';
    window.app = { rentals: {} };
    localStorage.clear();
});

test.each([
    ['shop-only member', 'staff', null, null],
    ['shop manager', 'manager', null, 'rentals'],
    ['rentals member', 'staff', 'member', null],
    ['owner with an old saved Rentals choice', 'owner', null, 'rentals']
])('%s: init() imports no rentals code and starts on Shop', async (_label, role, rentRole, saved) => {
    AppState.userRole = role;
    AppState.rentRole = rentRole;
    if (saved) localStorage.setItem('happa.business', saved);
    BusinessSwitcher.init();
    await flush();
    expect(loaded.rentals).toBe(false);
    expect(BusinessSwitcher.current()).toBe('shop');
    expect(document.body.classList.contains('biz-rentals')).toBe(false);
});

test('the mock does record a load (so the checks above can fail)', async () => {
    AppState.userRole = 'owner';
    await BusinessSwitcher.openRentals('rent');
    expect(loaded.rentals).toBe(true);
});
