/**
 * @fileoverview Clear Data safety (#17 part A): owner only, nothing
 * pre-ticked, typed DELETE, JSON backup + audit before deleting, no
 * localStorage.clear().
 */

jest.mock('../firebase/firestore-service.js', () => ({
    FirebaseService: {
        readCollectionForBackup: jest.fn(async (name) => [{ id: `${name}1`, data: { total: 5 } }, { id: `${name}2`, data: {} }]),
        deleteDocsInBatches: jest.fn(async (name, ids) => ids.length)
    }
}));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(async () => {}), ACTIONS: { CLEAR_DATA: 'CLEAR_DATA' } } }));
jest.mock('../ui/ui-manager.js', () => ({
    UIManager: {
        showToast: jest.fn(),
        showLoading: jest.fn(),
        hideLoading: jest.fn(),
        showModal: jest.fn(async () => true),
        showModalWithHtml: jest.fn()
    }
}));

import { FirebaseService } from '../firebase/firestore-service.js';
import { AuditService } from '../services/audit.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { AdminManager } from '../modules/admin.js';

const realSaveJsonBackup = AdminManager.saveJsonBackup;
import { serializeForBackup, buildBackup, isDeleteConfirmed, canClearCollection } from '../utils/data-export.js';

describe('data-export helpers', () => {
    test('serializes Timestamps, Dates and refs to plain JSON', () => {
        const ts = { seconds: 1, nanoseconds: 0, toMillis: () => 1000 };
        const ref = { path: 'items/a', firestore: {} };
        expect(serializeForBackup({ a: ts, b: [new Date(2000)], c: ref, d: 'x', e: null })).toEqual({
            a: { __type: 'timestamp', iso: '1970-01-01T00:00:01.000Z', millis: 1000 },
            b: [{ __type: 'timestamp', iso: '1970-01-01T00:00:02.000Z', millis: 2000 }],
            c: { __type: 'ref', path: 'items/a' },
            d: 'x',
            e: null
        });
        const backup = buildBackup({ items: [{ id: 'a', data: { name: 'Chana' } }] }, { now: new Date(0) });
        expect(backup).toMatchObject({ format: 'aadhat-backup-v1', collections: { items: [{ id: 'a', data: { name: 'Chana' } }] } });
    });

    test('the live business record can only be cleared on dev_ data (#63)', () => {
        ['purchases', 'retailSales', 'wholesaleSales', 'expenses', 'stockAdjustments', 'withdrawals', 'cashManagement', 'items', 'users']
            .forEach(id => {
                expect(canClearCollection(id, 'prod')).toBe(false);
                expect(canClearCollection(id, 'dev')).toBe(true);
            });
        ['drafts', 'autoSaves', 'itemFrequency'].forEach(id => expect(canClearCollection(id, 'prod')).toBe(true));
    });

    test('only the exact word DELETE confirms', () => {
        expect(isDeleteConfirmed(' DELETE ')).toBe(true);
        expect(isDeleteConfirmed('delete')).toBe(false);
        expect(isDeleteConfirmed('')).toBe(false);
    });
});

describe('AdminManager.clearAllData', () => {
    let typedWord;
    let tickIds;
    let firstModalHtml;
    const order = [];

    beforeEach(() => {
        jest.useFakeTimers();
        order.length = 0;
        document.body.innerHTML = '<div id="modalMessage"></div>';
        AppState.userRole = 'owner';
        AppState.currentUser = { uid: 'owner1' };
        typedWord = 'DELETE';
        tickIds = ['purchases'];
        firstModalHtml = null;
        FirebaseService.deleteDocsInBatches.mockClear();
        FirebaseService.deleteDocsInBatches.mockImplementation(async (name, ids) => { order.push(`delete:${name}`); return ids.length; });
        AuditService.log.mockClear();
        AuditService.log.mockImplementation(async () => { order.push('audit'); });
        AdminManager.saveJsonBackup = jest.fn(async () => { order.push('backup'); return true; });
        UIManager.showModalWithHtml.mockImplementation(async (html) => {
            document.getElementById('modalMessage').innerHTML = html;
            if (!firstModalHtml) {
                firstModalHtml = html;
                tickIds.forEach(id => { document.querySelector(`[data-collection="${id}"]`).checked = true; });
            } else {
                document.getElementById('clearDataConfirmInput').value = typedWord;
            }
            return true;
        });
        jest.spyOn(Storage.prototype, 'clear');
        window.getCollection = (name) => `dev_${name}`;
    });
    afterEach(() => {
        jest.useRealTimers();
        delete AdminManager.saveJsonBackup;
        delete window.getCollection;
    });

    test('nothing is pre-ticked', async () => {
        tickIds = [];
        await AdminManager.clearAllData();
        const div = document.createElement('div');
        div.innerHTML = firstModalHtml;
        expect(div.querySelectorAll('.collection-checkbox').length).toBeGreaterThan(0);
        expect(div.querySelectorAll('.collection-checkbox:checked').length).toBe(0);
        expect(FirebaseService.deleteDocsInBatches).not.toHaveBeenCalled();
    });

    test('wrong confirmation word deletes nothing', async () => {
        typedWord = 'delete';
        await AdminManager.clearAllData();
        expect(FirebaseService.deleteDocsInBatches).not.toHaveBeenCalled();
        expect(AdminManager.saveJsonBackup).not.toHaveBeenCalled();
    });

    test('DELETE: backup, then audit, then batched delete; localStorage kept', async () => {
        await AdminManager.clearAllData();
        expect(order).toEqual(['backup', 'audit', 'delete:purchases']);
        const [backup] = AdminManager.saveJsonBackup.mock.calls[0];
        expect(backup.collections.purchases.map(d => d.id)).toEqual(['purchases1', 'purchases2']);
        expect(FirebaseService.deleteDocsInBatches).toHaveBeenCalledWith('purchases', ['purchases1', 'purchases2']);
        expect(Storage.prototype.clear).not.toHaveBeenCalled();
    });

    test('backup not saved → nothing deleted, no way to go on without it', async () => {
        AdminManager.saveJsonBackup = jest.fn(async () => false);
        await AdminManager.clearAllData();
        expect(FirebaseService.deleteDocsInBatches).not.toHaveBeenCalled();
        expect(AuditService.log).not.toHaveBeenCalled();
        expect(UIManager.showModal).not.toHaveBeenCalled();
        expect(UIManager.showToast).toHaveBeenCalledWith('The backup was not saved, so nothing was deleted.');
    });

    test('Android app without sharing: stops at once and says to use the website', async () => {
        window.Capacitor = { isNativePlatform: () => true };
        try {
            await AdminManager.clearAllData();
        } finally {
            delete window.Capacitor;
        }
        expect(UIManager.showModalWithHtml).not.toHaveBeenCalled();
        expect(UIManager.showToast).toHaveBeenCalledWith("Clear Data needs the website: the Android app can't save the backup file.");
    });

    test('Android app: a backup that could not be shared counts as not saved', async () => {
        window.Capacitor = { isNativePlatform: () => true };
        const click = jest.spyOn(HTMLAnchorElement.prototype, 'click');
        try {
            expect(await realSaveJsonBackup.call(AdminManager, { a: 1 }, 'b.json')).toBe(false);
        } finally {
            delete window.Capacitor;
        }
        expect(click).not.toHaveBeenCalled();
    });

    test('live data: bills, cash, items and users are not offered; drafts still can be cleared', async () => {
        delete window.getCollection;
        tickIds = ['drafts'];
        await AdminManager.clearAllData();
        const div = document.createElement('div');
        div.innerHTML = firstModalHtml;
        const offered = [...div.querySelectorAll('.collection-checkbox')].map(cb => cb.dataset.collection);
        expect(offered).toEqual(['autoSaves', 'drafts', 'itemFrequency']);
        expect(div.textContent).toMatch(/can't be deleted here/);
        expect(order).toEqual(['backup', 'audit', 'delete:drafts']);
    });

    test('live data: a ledger collection slipped into the selection is ignored', async () => {
        delete window.getCollection;
        tickIds = ['drafts'];
        UIManager.showModalWithHtml.mockImplementationOnce(async (html) => {
            firstModalHtml = html;
            document.getElementById('modalMessage').innerHTML = html + '<input type="checkbox" class="collection-checkbox" data-collection="purchases" checked>';
            return true;
        });
        await AdminManager.clearAllData();
        expect(FirebaseService.readCollectionForBackup).not.toHaveBeenCalledWith('purchases');
        expect(FirebaseService.deleteDocsInBatches).not.toHaveBeenCalled();
    });

    test('non-owner is refused', async () => {
        AppState.userRole = 'staff';
        await AdminManager.clearAllData();
        expect(UIManager.showModalWithHtml).not.toHaveBeenCalled();
    });
});
