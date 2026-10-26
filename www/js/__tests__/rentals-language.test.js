/**
 * Settings › Roles & access › People (moved from Rentals › Access) speaks one
 * language (#143) and lists only app users: Aadhat roles via t('ui.role.*'),
 * never the English-only Helpers.roleLabel map.
 */
jest.mock('../firebase/firestore-service.js', () => ({ FirebaseService: { loadUsers: jest.fn(async () => []), updateUser: jest.fn(async () => {}) } }));
jest.mock('../ui/ui-manager.js', () => ({ UIManager: { showToast: jest.fn(), showModal: jest.fn() } }));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(async () => {}), ACTIONS: {} } }));
jest.mock('../auth/authentication.js', () => ({ AuthManager: { applyRoleBasedRestrictions: jest.fn() } }));

const fs = require('fs');
const path = require('path');
import { RolesAccessManager } from '../modules/roles-access.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { AppState } from '../utils/state.js';
import { setLang, resetLangForTests } from '../i18n/index.js';

const USERS = [
    { id: 'a', name: 'Asha', role: 'manager', status: 'active' },
    { id: 'b', name: 'Bablu', role: 'staff', status: 'active', rentRole: 'member' },
    { id: 'c', name: 'Chhotu', role: 'none', status: 'active', rentRole: 'member' },
    { id: 'o', name: 'Boss', role: 'owner' },
    { id: 'p', name: 'Pending', role: 'staff', status: 'pending' }
];

async function renderPeople() {
    document.body.innerHTML = '<div id="rolePeopleList"></div>';
    FirebaseService.loadUsers.mockResolvedValueOnce(USERS.map(u => ({ ...u })));
    await RolesAccessManager.loadPeople();
    return document.getElementById('rolePeopleList');
}

beforeEach(() => { AppState.userRole = 'owner'; });
afterEach(() => { localStorage.clear(); resetLangForTests(); RolesAccessManager.people = null; });

test('Hindi People list: Aadhat role and Rentals role, no English role names, no pending users', async () => {
    setLang('hi');
    const box = await renderPeople();
    const text = box.textContent;
    expect(text).toMatch(/आढ़त में भूमिका/);
    expect(text).toMatch(/मैनेजर/);
    expect(text).toMatch(/सदस्य/);
    expect(text).toMatch(/आढ़त की पहुँच नहीं/);
    expect(text).not.toMatch(/\b(Owner|Manager|Member|No access|none|staff|Shop)\b/);
    expect(text).not.toMatch(/Pending/);
    expect(text).toMatch(/Boss/);
    expect(box.querySelectorAll('select')).toHaveLength(3);
});

test('English People list has no Devanagari and says Aadhat, not Shop', async () => {
    setLang('en');
    const text = (await renderPeople()).textContent;
    expect(text).toMatch(/Aadhat role/);
    expect(text).toMatch(/No Aadhat access/);
    expect(text).not.toMatch(/\bShop\b/);
    expect(text).not.toMatch(/[\u0900-\u097F]/);
});

test('owner sets a Rentals role from the People list; others cannot', async () => {
    await renderPeople();
    expect(await RolesAccessManager.setRentRole('b', 'manager')).toBe(true);
    expect(FirebaseService.updateUser).toHaveBeenCalledWith('b', { rentRole: 'manager' });
    expect(await RolesAccessManager.setRentRole('b', 'bogus')).toBe(true);
    expect(FirebaseService.updateUser).toHaveBeenLastCalledWith('b', { rentRole: null });
    AppState.userRole = 'manager';
    FirebaseService.updateUser.mockClear();
    expect(await RolesAccessManager.setRentRole('b', 'member')).toBe(false);
    expect(await RolesAccessManager.loadPeople()).toBe(false);
    expect(FirebaseService.updateUser).not.toHaveBeenCalled();
});

test('rentals code never uses the English-only role label map', () => {
    const dir = path.join(__dirname, '..', 'rentals');
    const hits = fs.readdirSync(dir).filter(f => /\.js$/.test(f))
        .filter(f => /Helpers\.roleLabel\s*\(/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(hits).toEqual([]);
});
