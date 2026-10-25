/**
 * @fileoverview Roles & access (#84): what each role may see and do, set by
 * the owner in Settings → Roles & access. Stored in settings/app.roleAccess
 * (dev_settings/app for dev_), read with the settings/app read the app already
 * makes at startup. firestore.rules read `editDays` for bill edits/deletes,
 * counted from the bill's server `createdAt` (#87).
 * Design: docs/role-permissions.md.
 * @module utils/role-access
 */

/** Roles the owner configures ('staff' is shown as "Member"). The owner always has full access. */
export const CONFIGURABLE_ROLES = ['manager', 'staff'];

export const PAGE_PERMISSIONS = ['finance', 'reports', 'analytics', 'wholesale'];
export const SECTION_PERMISSIONS = ['personalExpenses', 'profit', 'stockValue', 'oldCashSessions'];
export const SWITCH_PERMISSIONS = [...PAGE_PERMISSIONS, ...SECTION_PERMISSIONS];

export const DEFAULT_EDIT_DAYS = 2;
export const MAX_EDIT_DAYS = 30;
export const MAX_HISTORY_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Today's behaviour (and #87: bills editable for 2 days); used when settings/app has no roleAccess. */
export const ROLE_ACCESS_DEFAULTS = Object.freeze({
    manager: Object.freeze({
        finance: true, reports: true, analytics: true, wholesale: true,
        personalExpenses: true, profit: true, stockValue: true, oldCashSessions: true,
        historyDays: 0, editDays: DEFAULT_EDIT_DAYS
    }),
    staff: Object.freeze({
        finance: false, reports: false, analytics: false, wholesale: false,
        personalExpenses: true, profit: true, stockValue: true, oldCashSessions: true,
        historyDays: 0, editDays: DEFAULT_EDIT_DAYS
    })
});

const OWNER_ACCESS = Object.freeze({
    ...Object.fromEntries(SWITCH_PERMISSIONS.map(p => [p, true])),
    historyDays: 0, editDays: Infinity
});

/** Page ids (navigation tab ids) that a permission controls. */
export const TAB_PERMISSIONS = Object.freeze({
    finance: 'finance',
    reports: 'reports',
    analytics: 'analytics',
    'wholesale-sales': 'wholesale'
});

function wholeDays(value, fallback, max) {
    const n = Number(value);
    if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return fallback;
    return Math.min(Math.max(Math.floor(n), 0), max);
}

/**
 * Fills missing/invalid entries with the defaults; unknown keys are dropped.
 * @param {*} raw - settings/app.roleAccess (may be missing)
 * @returns {{manager: Object, staff: Object}}
 */
export function normalizeRoleAccess(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    for (const role of CONFIGURABLE_ROLES) {
        const def = ROLE_ACCESS_DEFAULTS[role];
        const r = src[role] && typeof src[role] === 'object' ? src[role] : {};
        const entry = {};
        for (const p of SWITCH_PERMISSIONS) entry[p] = typeof r[p] === 'boolean' ? r[p] : def[p];
        entry.historyDays = wholeDays(r.historyDays, def.historyDays, MAX_HISTORY_DAYS);
        entry.editDays = wholeDays(r.editDays, def.editDays, MAX_EDIT_DAYS);
        out[role] = entry;
    }
    return out;
}

/**
 * Access of one role. Owner: everything, no edit limit. Unknown roles get the member defaults.
 * @param {string} role
 * @param {*} raw - settings/app.roleAccess
 */
export function accessFor(role, raw) {
    if (role === 'owner') return OWNER_ACCESS;
    const all = normalizeRoleAccess(raw);
    return all[role] || all.staff;
}

/** @returns {boolean} */
export function can(role, permission, raw) {
    return accessFor(role, raw)[permission] === true;
}

/**
 * Whether the role may open a page. Pages not in TAB_PERMISSIONS are not
 * controlled here (their built-in role checks still apply).
 */
export function canOpenTab(tabId, role, raw) {
    const permission = TAB_PERMISSIONS[tabId];
    return !permission || can(role, permission, raw);
}

/**
 * When the bill was first saved (ms): its server `createdAt` (Firestore
 * Timestamp, or the local estimate right after saving). null for bills saved
 * before #87 / by old apps — those are outside the window (owner only).
 */
export function billCreatedMs(bill) {
    const c = bill?.createdAt;
    if (c === null || c === undefined) return null;
    if (typeof c === 'number') return Number.isFinite(c) ? c : null;
    if (typeof c.toMillis === 'function') return c.toMillis();
    if (c instanceof Date) return Number.isFinite(c.getTime()) ? c.getTime() : null;
    if (typeof c.seconds === 'number') return c.seconds * 1000 + Math.floor((c.nanoseconds || 0) / 1e6);
    return null;
}

/**
 * The bill is inside the role's edit window (mirrors firestore.rules
 * withinBillWindow): now < createdAt + editDays days. 0 days = never. Owner: always.
 */
export function withinBillEditWindow(bill, { role, now = Date.now(), raw } = {}) {
    if (role === 'owner') return true;
    const days = accessFor(role, raw).editDays;
    const created = billCreatedMs(bill);
    return created !== null && now < created + days * DAY_MS;
}

/** Full edit: owner; manager any bill, member own bill, both inside the window. */
export function canEditBillWith(bill, { uid, role, now, raw } = {}) {
    if (role === 'owner') return true;
    if (!bill) return false;
    const mayTouch = role === 'manager' || (!!uid && !!bill.userId && bill.userId === uid);
    return mayTouch && withinBillEditWindow(bill, { role, now, raw });
}

/** Delete: owner; anyone else only their own bill, inside the window. */
export function canDeleteBillWith(bill, { uid, role, now, raw } = {}) {
    if (role === 'owner') return true;
    if (!bill || !uid || !bill.userId || bill.userId !== uid) return false;
    return withinBillEditWindow(bill, { role, now, raw });
}

/**
 * Oldest time (ms) the role may see in History; null = no limit.
 */
export function historyCutoff(role, raw, now = Date.now()) {
    const days = accessFor(role, raw).historyDays;
    return days > 0 ? now - days * DAY_MS : null;
}

/** CSS classes for <body> that hide `[data-perm~="<permission>"]` elements. */
export function hiddenPermissionClasses(role, raw) {
    const access = accessFor(role, raw);
    return SECTION_PERMISSIONS.filter(p => !access[p]).map(p => `no-perm-${p}`);
}
