/**
 * @fileoverview Pure helpers for in-app notifications (#12): bilingual text for
 * every notification type, badge text, read-state rules, retention, rate diffs
 * and per-edit rate baselines. No Firestore / DOM access here.
 * @module utils/notification-format
 */

import { toJsDate, displayLocale } from './dates.js';
import { getLang } from '../i18n/index.js';

/** Unread notifications the live listener keeps (also the badge cap). */
export const UNREAD_LIMIT = 20;
/** Notifications per page in the inbox. */
export const PAGE_SIZE = 30;
/** Notifications older than this are hidden and cleaned up. */
export const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const RATE_LABELS = {
    purchase: { en: 'Purchase', hi: 'खरीद' },
    sale: { en: 'Retail', hi: 'फुटकर' },
    retail: { en: 'Retail', hi: 'फुटकर' },
    wholesale: { en: 'Wholesale', hi: 'थोक' }
};

const DOC_LABELS = {
    bill: { en: 'Purchase bill', hi: 'खरीद बिल' },
    purchase: { en: 'Purchase bill', hi: 'खरीद बिल' },
    purchases: { en: 'Purchase bill', hi: 'खरीद बिल' },
    sale: { en: 'Wholesale sale', hi: 'थोक बिक्री' },
    wholesale: { en: 'Wholesale sale', hi: 'थोक बिक्री' },
    wholesaleSale: { en: 'Wholesale sale', hi: 'थोक बिक्री' },
    wholesaleSales: { en: 'Wholesale sale', hi: 'थोक बिक्री' },
    retail: { en: 'Retail sale', hi: 'फुटकर बिक्री' },
    retailSale: { en: 'Retail sale', hi: 'फुटकर बिक्री' },
    retailSales: { en: 'Retail sale', hi: 'फुटकर बिक्री' },
    payment: { en: 'Payment', hi: 'भुगतान' },
    expense: { en: 'Expense', hi: 'खर्च' },
    item: { en: 'Item', hi: 'आइटम' }
};

const DOC_TABS = {
    bill: 'history', purchase: 'history', purchases: 'history',
    retail: 'history', retailSale: 'history', retailSales: 'history',
    sale: 'wholesale-sales', wholesale: 'wholesale-sales', wholesaleSale: 'wholesale-sales', wholesaleSales: 'wholesale-sales',
    payment: 'due', expense: 'expenses', item: 'items'
};

const FIELD_LABELS = {
    name: { en: 'name', hi: 'नाम' },
    hindiName: { en: 'Hindi name', hi: 'हिंदी नाम' },
    contactPerson: { en: 'contact', hi: 'संपर्क' }
};

/** Milliseconds for any stored timestamp shape (Firestore Timestamp, ms, Date), or 0. */
export function notificationTime(n) {
    const d = toJsDate(n?.timestamp ?? n?.createdAt);
    return d ? d.getTime() : 0;
}

function formatRate(value) {
    if (Array.isArray(value)) return value.length ? value.map(v => `₹${v}`).join(', ') : '—';
    if (value === '' || value === null || value === undefined) return '—';
    return `₹${value}`;
}

function clean(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function itemNames(n) {
    const en = clean(n.itemName) || clean(n.itemHindiName) || 'Item';
    const hi = clean(n.itemHindiName) || en;
    return { en, hi };
}

/**
 * Display model for one notification document.
 * @param {Object} n - notification document data (with `id`)
 * @returns {{icon: string, en: string, hi: string, who: string, target: ?Object}}
 */
export function describeNotification(n = {}) {
    const who = clean(n.changedBy) || clean(n.editedBy) || clean(n.createdByName) || clean(n.byName);
    const type = n.type || '';

    if (type === 'rate_change') {
        const names = itemNames(n);
        const label = RATE_LABELS[n.rateType] || { en: clean(n.rateTypeLabel) || 'Rate', hi: clean(n.rateTypeLabel) || 'रेट' };
        const change = `${formatRate(n.oldRate ?? n.oldRates)} → ${formatRate(n.newRate ?? n.newRates)}`;
        return {
            icon: '💲',
            en: `${names.en}: ${label.en} rate ${change}`,
            hi: `${names.hi}: ${label.hi} रेट ${change}`,
            who,
            target: { tab: 'items', itemId: n.itemId || null, query: names.en === 'Item' ? '' : names.en }
        };
    }

    if (type === 'item_edit') {
        const names = itemNames(n);
        if (n.action === 'added') {
            return {
                icon: '📦',
                en: `New item added: ${names.en}`,
                hi: `नया आइटम जोड़ा गया: ${names.hi}`,
                who,
                target: { tab: 'items', itemId: n.itemId || null, query: names.en }
            };
        }
        const fields = (Array.isArray(n.fields) ? n.fields : []).filter(f => FIELD_LABELS[f]);
        const enFields = fields.length ? ` (${fields.map(f => FIELD_LABELS[f].en).join(', ')})` : '';
        const hiFields = fields.length ? ` (${fields.map(f => FIELD_LABELS[f].hi).join(', ')})` : '';
        return {
            icon: '📦',
            en: `Item updated: ${names.en}${enFields}`,
            hi: `आइटम बदला गया: ${names.hi}${hiFields}`,
            who,
            target: { tab: 'items', itemId: n.itemId || null, query: names.en }
        };
    }

    if (type === 'edit') {
        const label = DOC_LABELS[n.documentType] || { en: 'Record', hi: 'रिकॉर्ड' };
        const ref = clean(n.billNumber) || clean(n.newData?.billNumber) || clean(n.oldData?.billNumber);
        const suffix = ref ? ` ${ref}` : '';
        return {
            icon: '✏️',
            en: `${label.en}${suffix} edited`,
            hi: `${label.hi}${suffix} बदला गया`,
            who,
            target: DOC_TABS[n.documentType] ? { tab: DOC_TABS[n.documentType], documentId: n.documentId || null } : null
        };
    }

    // Unknown / future types (catalogue rows such as flags, cash mismatch, …)
    const en = clean(n.message) || clean(n.title) || 'New update';
    const hi = clean(n.messageHi) || clean(n.titleHi) || 'नई सूचना';
    return { icon: '🔔', en, hi, who, target: n.tab ? { tab: n.tab } : null };
}

/** One-line text in the app language (toast). */
export function notificationText(n, lang = getLang()) {
    const d = describeNotification(n);
    const by = d.who ? ` — ${d.who}` : '';
    return `${d.icon} ${lang === 'hi' ? d.hi : d.en}${by}`;
}

/**
 * Relative time in English and Hindi, plus an absolute IST stamp.
 * @param {number} ms
 * @param {number} [now]
 * @returns {{en: string, hi: string, abs: string}}
 */
export function formatWhen(ms, now = Date.now()) {
    if (!ms) return { en: '', hi: '', abs: '' };
    const abs = new Date(ms).toLocaleString(displayLocale(), {
        timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'
    });
    const diff = Math.max(0, now - ms);
    const min = Math.floor(diff / 60000);
    if (min < 1) return { en: 'just now', hi: 'अभी', abs };
    if (min < 60) return { en: `${min} min ago`, hi: `${min} मिनट पहले`, abs };
    const hours = Math.floor(min / 60);
    if (hours < 24) return { en: `${hours} h ago`, hi: `${hours} घंटे पहले`, abs };
    const days = Math.floor(hours / 24);
    if (days === 1) return { en: 'yesterday', hi: 'कल', abs };
    return { en: `${days} days ago`, hi: `${days} दिन पहले`, abs };
}

/** Badge text for the bell: '' when nothing unread, '20+' when the listener is full. */
export function badgeText(unreadCount, limit = UNREAD_LIMIT) {
    if (!unreadCount || unreadCount < 0) return '';
    return unreadCount >= limit ? `${limit}+` : String(unreadCount);
}

/** True when the notification is within the retention window. */
export function isFresh(n, now = Date.now(), days = RETENTION_DAYS) {
    const t = notificationTime(n);
    // Pending server timestamps have no time yet: they are brand new.
    return !t || now - t <= days * DAY_MS;
}

/** Retention cut-off (ms). */
export function retentionCutoff(now = Date.now(), days = RETENTION_DAYS) {
    return now - days * DAY_MS;
}

/**
 * Ids to mark read. Read state only changes when the user opens the inbox
 * (everything shown) or taps one row — never because a toast was shown.
 * @param {'open'|'tap'|'toast'|'all'} reason
 * @param {Array<{id: string, read?: boolean}>} notifications - shown / known rows
 * @param {string} [tappedId]
 * @returns {string[]}
 */
export function idsToMarkRead(reason, notifications = [], tappedId) {
    const unread = notifications.filter(n => n && n.id && n.read !== true);
    if (reason === 'open' || reason === 'all') return [...new Set(unread.map(n => n.id))];
    if (reason === 'tap') return unread.some(n => n.id === tappedId) ? [tappedId] : [];
    return [];
}

/**
 * Drops duplicates (same id, or same `eventKey`) keeping the newest first,
 * and hides anything past the retention window.
 */
export function prepareList(notifications = [], now = Date.now()) {
    const seenIds = new Set();
    const seenEvents = new Set();
    return notifications
        .filter(n => n && isFresh(n, now))
        .sort((a, b) => notificationTime(b) - notificationTime(a))
        .filter(n => {
            if (seenIds.has(n.id)) return false;
            seenIds.add(n.id);
            if (n.eventKey) {
                if (seenEvents.has(n.eventKey)) return false;
                seenEvents.add(n.eventKey);
            }
            return true;
        });
}

/**
 * Which listener changes deserve a "new notification" toast: only docs added
 * after the listener's first snapshot that weren't toasted before.
 * @param {Array<{type: string, id: string}>} changes
 * @param {Set<string>} seen - ids already shown/known (mutated)
 * @param {boolean} initial - first snapshot of this listener
 * @returns {string[]} ids to toast
 */
export function newArrivals(changes, seen, initial) {
    const out = [];
    (changes || []).forEach(ch => {
        if (ch.type !== 'added' || !ch.id) return;
        if (!seen.has(ch.id) && !initial) out.push(ch.id);
        seen.add(ch.id);
    });
    return out;
}

/** Deterministic document id: one notification per recipient per event. */
export function notificationDocId(eventId, userId) {
    return `${eventId}_${userId}`.replace(/[/\s]/g, '_');
}

/**
 * Plans the notification documents for one event (deduplicated recipients,
 * actor excluded). Writing the same event twice targets the same doc ids,
 * so an event never notifies a user twice.
 */
export function planNotificationDocs(eventId, recipientIds, actorId, data) {
    const ids = [...new Set((recipientIds || []).filter(id => id && id !== actorId))];
    return ids.map(userId => ({ id: notificationDocId(eventId, userId), data: { ...data, userId, eventKey: eventId } }));
}

/** Random-enough event id for a user action. */
export function newEventId(prefix = 'evt') {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const RATE_FIELDS = [['rates', 'purchase'], ['saleRates', 'sale'], ['wholesaleRates', 'wholesale']];

const sameRates = (a, b) => a.length === b.length && a.every((v, i) => Number(v) === Number(b[i]));
const cleanRates = (list) => (Array.isArray(list) ? list : []).map(Number).filter(v => v > 0);

/**
 * Rate lists that changed between two versions of an item.
 * Single-value changes give numbers (`40 → 45`), others the whole lists.
 * @returns {Array<{rateType: string, oldRate: (number|number[]), newRate: (number|number[])}>}
 */
export function diffItemRates(before = {}, after = {}) {
    const out = [];
    RATE_FIELDS.forEach(([field, rateType]) => {
        const a = cleanRates(before[field]);
        const b = cleanRates(after[field]);
        if (sameRates(a, b)) return;
        const single = a.length === 1 && b.length === 1;
        out.push({ rateType, oldRate: single ? a[0] : a, newRate: single ? b[0] : b });
    });
    return out;
}

/** Non-rate item fields that changed (for the owners' "item updated" note). */
export function diffItemFields(before = {}, after = {}) {
    return Object.keys(FIELD_LABELS).filter(f => clean(before[f]) !== clean(after[f]));
}

/**
 * Remembers the value a rate had when editing started, so a notification
 * says "40 → 45" and not "4 → 45" (the old code compared against the
 * previous keystroke). `begin` keeps the first baseline until `commit`.
 */
export function createRateEditTracker() {
    const baselines = new Map();
    return {
        begin(key, value) {
            if (!baselines.has(key)) baselines.set(key, Number(value) || 0);
        },
        /** @returns {?{oldRate: number, newRate: number}} null when nothing to report */
        commit(key, value) {
            if (!baselines.has(key)) return null;
            const oldRate = baselines.get(key);
            baselines.delete(key);
            const newRate = Number(value) || 0;
            if (newRate <= 0 || newRate === oldRate) return null;
            return { oldRate, newRate };
        },
        has: (key) => baselines.has(key)
    };
}
