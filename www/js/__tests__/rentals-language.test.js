/**
 * Rentals screens speak one language (#143) and list only app users (review of
 * #10): the Access page shows shop roles via t('ui.role.*'), never the
 * English-only Helpers.roleLabel map.
 */
jest.mock('../rentals/rent-store.js', () => ({
    snapshot: () => ({ properties: [], units: [], tenants: [], leases: [], charges: [] }),
    truncatedKeys: () => [], isAttached: () => false, attach: jest.fn(), detach: jest.fn()
}));
jest.mock('../firebase/firestore-service.js', () => ({ FirebaseService: { loadUsers: jest.fn(async () => []) } }));
jest.mock('../ui/business-switcher.js', () => ({ rentalsRole: () => 'owner' }));
jest.mock('../ui/ui-manager.js', () => ({ UIManager: { showToast: jest.fn(), showModal: jest.fn() } }));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(async () => {}) } }));

const fs = require('fs');
const path = require('path');
import { _test } from '../rentals/rentals.js';
import { setLang, resetLangForTests } from '../i18n/index.js';

const USERS = [
    { id: 'a', name: 'Asha', role: 'manager', status: 'active' },
    { id: 'b', name: 'Bablu', role: 'staff', status: 'active', rentRole: 'member' },
    { id: 'c', name: 'Chhotu', role: 'none', status: 'active', rentRole: 'member' },
    { id: 'o', name: 'Boss', role: 'owner' },
    { id: 'p', name: 'Pending', role: 'staff', status: 'pending' }
];

function renderAccess() {
    document.body.innerHTML = '<div id="rentals" class="tab active"><div id="rentalsNotice"></div><div id="rentalsBody"></div></div>';
    _test.state.page = 'access';
    _test.state.users = USERS;
    _test.render();
    return document.getElementById('rentalsBody').textContent;
}

afterEach(() => { localStorage.clear(); resetLangForTests(); });

test('Hindi Access page: no English role names; only approved app users other than the owner', () => {
    setLang('hi');
    const text = renderAccess();
    expect(text).toMatch(/मैनेजर/);
    expect(text).toMatch(/सदस्य/);
    expect(text).toMatch(/दुकान की पहुँच नहीं/);
    expect(text).not.toMatch(/\b(Owner|Manager|Member|No access|none|staff)\b/);
    expect(text).not.toMatch(/Boss|Pending/);
});

test('English Access page has no Devanagari', () => {
    setLang('en');
    const text = renderAccess();
    expect(text).toMatch(/Shop: Manager/);
    expect(text).toMatch(/Shop: No shop access/);
    expect(text).not.toMatch(/[\u0900-\u097F]/);
});

test('rentals code never uses the English-only role label map', () => {
    const dir = path.join(__dirname, '..', 'rentals');
    const hits = fs.readdirSync(dir).filter(f => /\.js$/.test(f))
        .filter(f => /Helpers\.roleLabel\s*\(/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(hits).toEqual([]);
});
