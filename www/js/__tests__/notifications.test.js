/**
 * @fileoverview Notifications (#12): bilingual text for every type, unread
 * badge, read-state rules, listener attach/detach, inbox paging, retention,
 * per-event de-duplication and the rate old→new capture.
 */

jest.mock('../ui/ui-manager.js', () => ({
    UIManager: {
        showToast: jest.fn(),
        showLoading: jest.fn(),
        hideLoading: jest.fn(),
        showModal: jest.fn(async () => true)
    }
}));
jest.mock('../services/telemetry.js', () => ({
    TelemetryService: { logWarning: jest.fn(), logError: jest.fn(), captureError: jest.fn() }
}));

import fs from 'fs';
import path from 'path';
import { UIManager } from '../ui/ui-manager.js';
import { TelemetryService } from '../services/telemetry.js';
import { AppState } from '../utils/state.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { NotificationsManager, notificationErrorMessage } from '../modules/notifications.js';
import { ItemsManager } from '../modules/items.js';
import { createFakeFirestore } from './__mocks__/fake-firestore.js';
import {
    describeNotification, notificationText, formatWhen, badgeText, idsToMarkRead,
    prepareList, newArrivals, planNotificationDocs, createRateEditTracker,
    diffItemRates, diffItemFields, UNREAD_LIMIT
} from '../utils/notification-format.js';

const NOW = Date.UTC(2026, 9, 22, 6, 30); // 22 Oct 2026, 12:00 IST
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

const SAMPLES = [
    { id: 'r1', type: 'rate_change', itemName: 'Gehu', itemHindiName: 'गेहूं', rateType: 'sale', oldRate: 40, newRate: 45, changedBy: 'Ramesh', timestamp: NOW },
    { id: 'r2', type: 'rate_change', itemName: 'Chana', rateType: 'wholesale', oldRate: [50, 52], newRate: [55], changedBy: 'Ramesh', timestamp: NOW },
    { id: 'i1', type: 'item_edit', action: 'added', itemName: 'Moong', itemHindiName: 'मूंग', changedBy: 'Sita', timestamp: NOW },
    { id: 'i2', type: 'item_edit', action: 'updated', fields: ['name', 'contactPerson'], itemName: 'Moong', changedBy: 'Sita', timestamp: NOW },
    { id: 'e1', type: 'edit', documentType: 'sale', documentId: 's1', editedBy: 'Sita', newData: { billNumber: 'W-12' }, timestamp: NOW },
    { id: 'e2', type: 'edit', documentType: 'payment', editedBy: 'Sita', timestamp: NOW },
    { id: 'x1', type: 'cash_mismatch', message: 'Cash count differs by ₹200', messageHi: 'नकद में ₹200 का अंतर', timestamp: NOW },
    { id: 'x2', type: 'something_new', timestamp: NOW }
];

describe('notification text', () => {
    test('rate change shows item, rate type and old → new in English and Hindi', () => {
        const d = describeNotification(SAMPLES[0]);
        expect(d.en).toBe('Gehu: Retail rate ₹40 → ₹45');
        expect(d.hi).toBe('गेहूं: फुटकर रेट ₹40 → ₹45');
        expect(d.who).toBe('Ramesh');
        expect(d.target).toEqual({ tab: 'items', itemId: null, query: 'Gehu' });
        expect(describeNotification(SAMPLES[1]).en).toBe('Chana: Wholesale rate ₹50, ₹52 → ₹55');
    });

    test('item edits, document edits and unknown types all get bilingual text', () => {
        expect(describeNotification(SAMPLES[2])).toMatchObject({ en: 'New item added: Moong', hi: 'नया आइटम जोड़ा गया: मूंग' });
        expect(describeNotification(SAMPLES[3])).toMatchObject({ en: 'Item updated: Moong (name, contact)', hi: 'आइटम बदला गया: Moong (नाम, संपर्क)' });
        expect(describeNotification(SAMPLES[4])).toMatchObject({ en: 'Wholesale sale W-12 edited', hi: 'थोक बिक्री W-12 बदला गया', target: { tab: 'wholesale-sales', documentId: 's1' } });
        expect(describeNotification(SAMPLES[5]).en).toBe('Payment edited');
        expect(describeNotification(SAMPLES[6])).toMatchObject({ en: 'Cash count differs by ₹200', hi: 'नकद में ₹200 का अंतर' });
        expect(describeNotification(SAMPLES[7])).toMatchObject({ en: 'New update', hi: 'नई सूचना', target: null });
    });

    test('every type has English and Hindi text, and never says "staff"', () => {
        SAMPLES.forEach(n => {
            const d = describeNotification(n);
            expect(d.en).toBeTruthy();
            expect(/[\u0900-\u097F]/.test(d.hi)).toBe(true);
            const all = `${notificationText(n)} ${JSON.stringify(d)}`;
            expect(all).not.toMatch(/staff|स्टाफ/i);
        });
        [notificationErrorMessage({ code: 'failed-precondition' }), notificationErrorMessage({ code: 'permission-denied' }), notificationErrorMessage(new Error('x'))]
            .forEach(m => expect(m).not.toMatch(/staff|स्टाफ/i));
    });

    test('user-facing notification files never use the word "staff"', () => {
        const root = path.join(__dirname, '..', '..');
        const files = ['js/utils/notification-format.js', 'js/modules/notifications.js', 'css/notifications.css'];
        files.forEach(f => {
            const src = fs.readFileSync(path.join(root, f), 'utf8');
            expect(src).not.toMatch(/staff|स्टाफ/i);
        });
        const nav = fs.readFileSync(path.join(root, 'templates/navigation.html'), 'utf8');
        const bell = nav.slice(nav.indexOf('notifBell'), nav.indexOf('<!-- Side Navigation -->'));
        expect(bell).not.toMatch(/staff|स्टाफ/i);
    });

    test('relative time in both languages', () => {
        expect(formatWhen(NOW, NOW)).toMatchObject({ en: 'just now', hi: 'अभी' });
        expect(formatWhen(NOW - 5 * MIN, NOW)).toMatchObject({ en: '5 min ago', hi: '5 मिनट पहले' });
        expect(formatWhen(NOW - 3 * 60 * MIN, NOW)).toMatchObject({ en: '3 h ago', hi: '3 घंटे पहले' });
        expect(formatWhen(NOW - DAY - MIN, NOW)).toMatchObject({ en: 'yesterday', hi: 'कल' });
        expect(formatWhen(NOW - 4 * DAY, NOW)).toMatchObject({ en: '4 days ago', hi: '4 दिन पहले' });
        expect(formatWhen(NOW, NOW).abs).toMatch(/22 Oct.*12:00/);
    });
});

describe('badge and read rules', () => {
    test('badge text', () => {
        expect(badgeText(0)).toBe('');
        expect(badgeText(3)).toBe('3');
        expect(badgeText(UNREAD_LIMIT)).toBe(`${UNREAD_LIMIT}+`);
    });

    test('showing a toast never marks anything read; opening or tapping does', () => {
        const list = [{ id: 'a', read: false }, { id: 'b', read: true }, { id: 'c', read: false }];
        expect(idsToMarkRead('toast', list)).toEqual([]);
        expect(idsToMarkRead('open', list)).toEqual(['a', 'c']);
        expect(idsToMarkRead('tap', list, 'c')).toEqual(['c']);
        expect(idsToMarkRead('tap', list, 'b')).toEqual([]);
    });

    test('list is newest first, de-duplicated by id and event, and hides > 30 days', () => {
        const list = prepareList([
            { id: 'old', timestamp: NOW - 31 * DAY },
            { id: 'a', timestamp: NOW - 2 * MIN, eventKey: 'e1' },
            { id: 'b', timestamp: NOW - MIN, eventKey: 'e1' },
            { id: 'c', timestamp: NOW },
            { id: 'c', timestamp: NOW }
        ], NOW);
        expect(list.map(n => n.id)).toEqual(['c', 'b']);
    });

    test('only docs added after the first snapshot are new arrivals, once', () => {
        const seen = new Set();
        expect(newArrivals([{ type: 'added', id: 'a' }], seen, true)).toEqual([]);
        expect(newArrivals([{ type: 'added', id: 'a' }, { type: 'added', id: 'b' }, { type: 'modified', id: 'c' }], seen, false)).toEqual(['b']);
        expect(newArrivals([{ type: 'added', id: 'b' }], seen, false)).toEqual([]);
    });

    test('an event produces at most one notification per user (actor excluded)', () => {
        const docs = planNotificationDocs('evt-1', ['u1', 'u2', 'u2', 'actor', ''], 'actor', { type: 'rate_change' });
        expect(docs.map(d => d.id)).toEqual(['evt-1_u1', 'evt-1_u2']);
        expect(docs[0].data).toMatchObject({ userId: 'u1', eventKey: 'evt-1', type: 'rate_change' });
        expect(planNotificationDocs('evt-1', ['u1'], 'actor', {})[0].id).toBe(docs[0].id);
    });
});

describe('rate old → new capture', () => {
    test('keystrokes 4, 45 after 40 report 40 → 45 once', () => {
        const t = createRateEditTracker();
        t.begin('k', 40);
        t.begin('k', 4);
        t.begin('k', 45);
        expect(t.commit('k', 45)).toEqual({ oldRate: 40, newRate: 45 });
        expect(t.commit('k', 45)).toBeNull();
    });

    test('no report when the value ends where it started or is cleared', () => {
        const t = createRateEditTracker();
        t.begin('k', 40);
        expect(t.commit('k', 40)).toBeNull();
        t.begin('k', 40);
        expect(t.commit('k', '')).toBeNull();
    });

    test('item dialog diffs', () => {
        const before = { name: 'Gehu', hindiName: 'गेहूं', rates: [40], saleRates: [50, 52], wholesaleRates: [45] };
        const after = { name: 'Gehu ', hindiName: 'गेहूँ', contactPerson: 'Ram', rates: [42], saleRates: [50, 52], wholesaleRates: [] };
        expect(diffItemRates(before, after)).toEqual([
            { rateType: 'purchase', oldRate: 40, newRate: 42 },
            { rateType: 'wholesale', oldRate: [45], newRate: [] }
        ]);
        expect(diffItemFields(before, after)).toEqual(['hindiName', 'contactPerson']);
    });
});

describe('Firestore paths (fake Firestore)', () => {
    let fake;
    beforeEach(() => {
        fake = createFakeFirestore();
        global.firebase = fake.firebase;
        AppState.currentUser = { uid: 'owner1' };
        AppState.userName = 'Owner';
        AppState.userRole = 'owner';
        FirebaseService.forgetPeopleCaches();
        fake.seed('users', [
            { id: 'owner1', role: 'owner' }, { id: 'owner2', role: 'owner' },
            { id: 'mgr', role: 'manager' }, { id: 'u3', role: 'staff' }
        ]);
    });
    afterEach(() => {
        NotificationsManager.stop();
        delete global.firebase;
    });

    test("a manager's fan-out reads the team directory, never the profiles (#87)", async () => {
        AppState.currentUser = { uid: 'mgr' };
        AppState.userRole = 'manager';
        fake.seed('settings', [{ id: 'team', people: {
            owner1: { name: 'O', role: 'owner' }, mgr: { name: 'M', role: 'manager' }, u3: { name: 'U', role: 'staff' }
        } }]);
        fake.raw('users').clear();
        await FirebaseService.notifyRateChanges({ id: 'g', name: 'Gehu' }, [{ rateType: 'wholesale', oldRate: 38, newRate: 41 }], 'evt-m');
        expect([...fake.raw('notifications').values()].map(d => d.userId)).toEqual(['owner1']);
    });

    test('rate changes go to everyone but the actor; wholesale only to owners/managers; one batch per event', async () => {
        await FirebaseService.notifyRateChanges({ id: 'g', name: 'Gehu' }, [
            { rateType: 'sale', oldRate: 40, newRate: 45 },
            { rateType: 'wholesale', oldRate: 38, newRate: 41 }
        ], 'evt-x');
        const docs = [...fake.raw('notifications').entries()];
        const sale = docs.filter(([, d]) => d.rateType === 'sale').map(([, d]) => d.userId).sort();
        const wholesale = docs.filter(([, d]) => d.rateType === 'wholesale').map(([, d]) => d.userId).sort();
        expect(sale).toEqual(['mgr', 'owner2', 'u3']);
        expect(wholesale).toEqual(['mgr', 'owner2']);
        expect(docs.every(([, d]) => d.read === false && d.oldRate !== undefined)).toBe(true);

        // Re-sending the same event does not duplicate it
        await FirebaseService.notifyRateChanges({ id: 'g', name: 'Gehu' }, [{ rateType: 'sale', oldRate: 40, newRate: 45 }], 'evt-x');
        expect(fake.raw('notifications').size).toBe(5);
    });

    test('item edits go to owners only', async () => {
        await FirebaseService.notifyItemEdit({ id: 'g', name: 'Gehu' }, 'updated', ['name']);
        const users = [...fake.raw('notifications').values()].map(d => d.userId);
        expect(users).toEqual(['owner2']);
    });

    test('inbox pages newest first with "show more", and marks read in a batch', async () => {
        fake.seed('notifications', Array.from({ length: 35 }, (_, i) => ({
            id: `n${String(i).padStart(2, '0')}`, userId: 'owner1', read: i % 2 === 0, timestamp: NOW - i * MIN, type: 'rate_change'
        })).concat([{ id: 'other', userId: 'mgr', read: false, timestamp: NOW, type: 'rate_change' }]));
        const p1 = await FirebaseService.loadNotificationsPage('owner1', { limit: 30 });
        expect(p1.items).toHaveLength(30);
        expect(p1.items[0].id).toBe('n00');
        expect(p1.hasMore).toBe(true);
        const p2 = await FirebaseService.loadNotificationsPage('owner1', { limit: 30, after: p1.cursor });
        expect(p2.items.map(n => n.id)).toEqual(['n30', 'n31', 'n32', 'n33', 'n34']);
        expect(p2.hasMore).toBe(false);

        await FirebaseService.markNotificationsRead(['n01', 'n03', 'n03']);
        expect(fake.raw('notifications').get('n01').read).toBe(true);
        expect(fake.raw('notifications').get('n03').read).toBe(true);
        expect(fake.raw('notifications').get('n05').read).toBe(false);
    });

    test('mark all read covers unread beyond memory, bounded by pages', async () => {
        fake.seed('notifications', Array.from({ length: 12 }, (_, i) => ({
            id: `u${String(i).padStart(2, '0')}`, userId: 'owner1', read: false, timestamp: NOW - i * MIN, type: 'rate_change'
        })).concat([{ id: 'other', userId: 'mgr', read: false, timestamp: NOW, type: 'rate_change' }]));
        expect(await FirebaseService.markAllNotificationsRead('owner1', { pageSize: 5, maxPages: 2 })).toBe(10);
        const mine = [...fake.raw('notifications').entries()].filter(([, d]) => d.userId === 'owner1');
        expect(mine.filter(([, d]) => !d.read)).toHaveLength(2);
        expect(await FirebaseService.markAllNotificationsRead('owner1', { pageSize: 5, maxPages: 2 })).toBe(2);
        expect(mine.length).toBe(12);
        expect([...fake.raw('notifications').values()].filter(d => d.userId === 'owner1').every(d => d.read)).toBe(true);
        expect(fake.raw('notifications').get('other').read).toBe(false);
    });

    test('retention deletes only this user\'s notifications older than the cut-off', async () => {
        fake.seed('notifications', [
            { id: 'old', userId: 'owner1', read: true, timestamp: NOW - 40 * DAY },
            { id: 'oldUnread', userId: 'owner1', read: false, timestamp: NOW - 31 * DAY },
            { id: 'new', userId: 'owner1', read: true, timestamp: NOW - DAY },
            { id: 'otherOld', userId: 'mgr', read: true, timestamp: NOW - 40 * DAY }
        ]);
        const n = await FirebaseService.deleteOldNotifications('owner1', NOW - 30 * DAY);
        expect(n).toBe(2);
        expect([...fake.raw('notifications').keys()].sort()).toEqual(['new', 'otherOld']);
    });

    describe('NotificationsManager', () => {
        beforeEach(() => {
            document.body.innerHTML = `
                <button id="notifBell" style="display:none"><span id="notifBadge" hidden></span></button>
                <div id="notifBackdrop" hidden></div>
                <div id="notifPanel" hidden><div id="notifList"></div><button id="notifMore" hidden></button></div>`;
            UIManager.showToast.mockClear();
            TelemetryService.logWarning.mockClear();
            jest.spyOn(console, 'error').mockImplementation(() => {});
        });
        afterEach(() => jest.restoreAllMocks());

        test('attaches after login, re-attaches once on re-login, detaches on logout', async () => {
            NotificationsManager.start('owner1');
            NotificationsManager.start('owner1');
            await fake.settle();
            expect(fake.listenerCount()).toBe(1);
            expect(document.getElementById('notifBell').style.display).toBe('');
            NotificationsManager.stop();
            expect(fake.listenerCount()).toBe(0);
            expect(document.getElementById('notifBell').style.display).toBe('none');
        });

        test('new notification → 5 s toast + badge, still unread; opening the inbox marks it read', async () => {
            fake.seed('notifications', [{ id: 'early', userId: 'owner1', read: false, timestamp: Date.now() - 5 * MIN, type: 'rate_change', itemName: 'Moong', rateType: 'sale', oldRate: 1, newRate: 2 }]);
            NotificationsManager.start('owner1');
            await fake.settle();
            expect(document.getElementById('notifBadge').textContent).toBe('1');
            UIManager.showToast.mockClear();

            AppState.currentUser = { uid: 'mgr' };
            AppState.userName = 'Manager';
            await FirebaseService.notifyRateChange({ id: 'g', name: 'Gehu', hindiName: 'गेहूं' }, 'sale', 40, 45);
            await fake.settle();

            expect(UIManager.showToast).toHaveBeenCalledTimes(1);
            const [msg, ms] = UIManager.showToast.mock.calls[0];
            expect(msg).toContain('Gehu: Retail rate ₹40 → ₹45');
            expect(msg).not.toMatch(/[\u0900-\u097F]/); // one language: English by default (#143)
            expect(msg).toContain('Manager');
            expect(ms).toBe(5000);
            expect(document.getElementById('notifBadge').textContent).toBe('2');
            const stored = [...fake.raw('notifications').values()].filter(d => d.userId === 'owner1');
            expect(stored.every(d => d.read === false)).toBe(true);

            await NotificationsManager.openInbox();
            await fake.settle();
            expect(document.getElementById('notifPanel').hidden).toBe(false);
            expect(document.querySelectorAll('#notifList .notif-row')).toHaveLength(2);
            expect([...fake.raw('notifications').values()].filter(d => d.userId === 'owner1').every(d => d.read === true)).toBe(true);
            expect(document.getElementById('notifBadge').hidden).toBe(true);
        });

        test('"Mark all read" clears unread beyond the 20 in the listener, so the badge stays empty', async () => {
            fake.seed('notifications', Array.from({ length: 25 }, (_, i) => ({
                id: `m${String(i).padStart(2, '0')}`, userId: 'owner1', read: false, timestamp: Date.now() - (i + 10) * MIN, type: 'rate_change', itemName: 'Gehu', rateType: 'sale', oldRate: 1, newRate: 2
            })));
            NotificationsManager.start('owner1');
            await fake.settle();
            expect(document.getElementById('notifBadge').textContent).toBe(`${UNREAD_LIMIT}+`);

            NotificationsManager.markAllRead();
            await fake.settle();
            await fake.settle();
            expect([...fake.raw('notifications').values()].every(d => d.read === true)).toBe(true);
            expect(document.getElementById('notifBadge').hidden).toBe(true);
            expect(UIManager.showToast).not.toHaveBeenCalledWith(expect.stringContaining('Gehu'), expect.anything());
        });

        test('listener errors: one bilingual toast + Diagnostics entry, no crash', async () => {
            fake = createFakeFirestore({ failures: { notifications: Object.assign(new Error('index'), { code: 'failed-precondition' }) } });
            global.firebase = fake.firebase;
            NotificationsManager.start('owner1');
            await fake.settle();
            expect(UIManager.showToast).toHaveBeenCalledTimes(1);
            expect(UIManager.showToast.mock.calls[0][0]).toMatch(/database index/);
            expect(TelemetryService.logWarning).toHaveBeenCalledWith('Notifications listener failed', expect.objectContaining({ code: 'failed-precondition' }));
            expect(document.getElementById('notifBell').classList.contains('notif-error')).toBe(true);
        });
    });
});

describe('ItemsManager writes', () => {
    beforeEach(() => {
        AppState.items = [{ id: 'g', name: 'Gehu', hindiName: 'गेहूं', rates: [40], saleRates: [], wholesaleRates: [] }];
        jest.spyOn(FirebaseService, 'saveItem').mockImplementation(async (item) => item);
        jest.spyOn(FirebaseService, 'notifyRateChange').mockImplementation(async () => {});
        jest.spyOn(FirebaseService, 'notifyRateChanges').mockImplementation(async () => {});
        jest.spyOn(FirebaseService, 'notifyItemEdit').mockImplementation(async () => {});
    });
    afterEach(() => jest.restoreAllMocks());

    test('inline rate typing notifies once on commit with the value from edit start', () => {
        jest.useFakeTimers();
        ItemsManager.updateRate('g', 0, '4');
        ItemsManager.updateRate('g', 0, '45');
        jest.advanceTimersByTime(600);
        expect(FirebaseService.notifyRateChange).not.toHaveBeenCalled();
        ItemsManager.commitRate('g', 0);
        expect(FirebaseService.notifyRateChange).toHaveBeenCalledTimes(1);
        expect(FirebaseService.notifyRateChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'g' }), 'purchase', 40, 45);
        jest.useRealTimers();
    });

    test('edit dialog save sends rate and item-edit notifications', async () => {
        document.body.innerHTML = `
            <table><tbody id="itemsViewTableBody"></tbody></table>
            <div id="itemEditOverlay"><input id="itemModalName"><input id="itemModalHindiName"><input id="itemModalContactPerson">
            <div id="itemModalPurchaseRates"></div><div id="itemModalWholesaleRates"></div><div id="itemModalSaleRates"></div>
            <button id="itemModalDeleteBtn"></button></div>`;
        AppState.settings = { showHindi: false };
        ItemsManager.openEditModal('g');
        ItemsManager.updateModalRate('purchase', 0, '42');
        document.getElementById('itemModalContactPerson').value = 'Ram';
        await ItemsManager.saveItemFromModal();
        expect(FirebaseService.notifyRateChanges).toHaveBeenCalledWith(expect.objectContaining({ id: 'g' }), [{ rateType: 'purchase', oldRate: 40, newRate: 42 }]);
        expect(FirebaseService.notifyItemEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'g' }), 'updated', ['contactPerson']);
    });
});
