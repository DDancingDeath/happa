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

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
    document.body.innerHTML = '<div id="bizSwitch" hidden></div>';
    window.app = { rentals: {} };
    localStorage.clear();
});

test.each([
    ['shop-only member', 'staff', null],
    ['shop manager', 'manager', null],
    ['rentals member', 'staff', 'member'],
    ['owner', 'owner', null]
])('%s: init() imports no rentals code and starts on Shop', async (_label, role, rentRole) => {
    AppState.userRole = role;
    AppState.rentRole = rentRole;
    BusinessSwitcher.init();
    await flush();
    expect(loaded.rentals).toBe(false);
    expect(BusinessSwitcher.current()).toBe('shop');
    expect(document.body.classList.contains('biz-rentals')).toBe(false);
});

test('main.js opens Rentals only from window.app handlers (user taps), never during start-up', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
    const isWindowApp = (n) => n.type === 'MemberExpression' && n.object.name === 'window' && n.property.name === 'app';
    const calls = [];
    walk.ancestor(ast, {
        CallExpression(node, _state, ancestors) {
            const callee = node.callee;
            if (callee.type !== 'MemberExpression' || callee.object.name !== 'BusinessSwitcher') return;
            const name = callee.property.name;
            const inHandler = ancestors.some(a => a.type === 'ArrowFunctionExpression')
                && ancestors.some(a => a.type === 'AssignmentExpression' && isWindowApp(a.left));
            calls.push({ name, inHandler });
        }
    });
    const opening = calls.filter(c => ['set', 'openRentals', 'load'].includes(c.name));
    expect(opening.length).toBeGreaterThan(0);
    expect(opening.filter(c => !c.inHandler)).toEqual([]);
    expect(calls.filter(c => c.name === 'load')).toEqual([]);
});

test('the mock does record a load (so the checks above can fail)', async () => {
    AppState.userRole = 'owner';
    await BusinessSwitcher.openRentals('rent');
    expect(loaded.rentals).toBe(true);
});
