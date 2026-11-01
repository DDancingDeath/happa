/**
 * @fileoverview Firebase Firestore Service Module
 * Provides all database operations for the Aadhat Management App.
 * Handles CRUD operations for items, bills, sales, expenses, stock, and cash management.
 * @module firebase/firestore-service
 */

// -------------------- FIREBASE DATA OPERATIONS --------------------

import { AppState } from '../utils/state.js';
import { Helpers } from '../utils/helpers.js';
import { isActiveBill, isActiveExpense, isOnlineExpense, outstandingDue } from '../utils/money.js';
import { billEditChanges, cleanReason, editCountOf, editRecord, hasEditChanges, nextEditNumber, voidBlocker } from '../utils/bill-edits.js';
import { localISODaysAgo, parseAnyBillDate } from '../utils/dates.js';
import {
    STOCK_REPLAY_FORMAT,
    eventTime,
    computeStock,
    computeStockFrom,
    buildCheckpointState,
    itemsSignature,
    resolutionsStillValid,
    serializeState,
    deserializeState,
    changeInvalidatesCheckpoint,
    stockFingerprint
} from '../utils/stock-replay.js';
import { defaultWindowStart, monthsBefore, normalizeFrom, dateDescComparator } from '../utils/history-range.js';
import { decideStockRebuild, leaseOwnerUid, LEASE_MAX_WAIT_MS, memberWindowStart } from '../utils/rebuild-lease.js';
import { whenIdle, afterFirstPaint, shouldScheduleLegacyScan, LEGACY_SCAN_DELAY_MS } from '../utils/background-tasks.js';
import { markStartup } from '../utils/startup-timings.js';
import { canReadWithdrawals } from '../utils/role-access.js';
import { canReadPersonalExpenses, dayDocTotals, expenseCollectionFor, personalDayFixes, personalDayKey, personalDaysFromRows, personalOnlineFromRows, PERSONAL_DAYS_COLLECTION } from '../utils/personal-expenses.js';
import { SyncStatus } from '../ui/sync-status.js';
import { entryTime } from '../utils/due-payments.js';
import { getDb, col, CLIENT_VERSION, serverCreatedAt, voidAwareStamp } from './db.js';
import { itemMethods } from './repos/items.js';
import { billStatsMethods } from './repos/bill-stats.js';
import { collectionAdminMethods } from './repos/collection-admin.js';
import { tipMethods } from './repos/tip-health.js';
import { anomalyMethods } from './repos/anomalies.js';
import { userProfileMethods } from './repos/user-profiles.js';
import { notificationMethods } from './repos/notifications.js';
import { cashDayMethods } from './repos/cash-days.js';
import { worthAccountMethods } from './repos/worth-accounts.js';
import { settingsMethods, forgetAppSettings } from './repos/settings.js';
import { getWithRetry } from './core/reads.js';
import { settleWrite, whenStoredLocally, LOCAL_STORE_WAIT_MS, EXPENSE_STORE_WAIT_MS } from './core/write-settle.js';
import { installFirestoreMeter, getQuotaStatus, backgroundReadsAllowed } from './firestore-meter.js';
import { emit, REFRESH, ITEM_FREQUENCY_CHANGED } from '../utils/events.js';
import { t } from '../i18n/index.js';
import { tip } from '../tip/index.js';
import { track } from '../services/usage.js';
import { billSaveProps } from '../tip/scenarios/bill-save.js';
import { checkpointProps } from '../tip/scenarios/stock-checkpoint.js';

// Count reads and catch quota errors for every Firestore call in the app (#194).
if (typeof firebase !== 'undefined' && firebase.firestore) {
    try {
        installFirestoreMeter(firebase.firestore);
    } catch (e) {
        console.warn('Read counter not installed:', e);
    }
}

/** @type {Function[]} Array of unsubscribe functions for real-time listeners */
const unsubscribeFunctions = [];
/** Numbers the data listeners for the sync pill (#70). */
let listenSeq = 0;

/** @type {Array<{resolve: Function}>} First-snapshot waiters of active listeners */
const pendingFirstSnapshots = [];

/**
 * Incremented whenever a listener changes AppState data. Used to decide
 * whether a previously computed stock object is still current.
 * @type {number}
 */
let dataVersion = 0;

/** @type {{stock?: Object, version?: number}} Last stock computed by getStock() */
let stockCache = {};

const defaultMapDoc = (doc) => ({ id: doc.id, ...doc.data() });

/**
 * Applies a query snapshot to a listener's private, ordered document list.
 * The first snapshot maps every document; later snapshots only deserialize
 * the changed documents (docChanges indices are defined relative to the
 * list with all prior changes applied, so sequential splicing reproduces
 * snapshot.docs order exactly).
 * @param {{docs: Object[], initialized: boolean}} live
 * @param {firebase.firestore.QuerySnapshot} snapshot
 * @param {Function} [mapFn]
 * @returns {{changed: boolean, changes: Array<{type: string, docId: string, oldRec: ?Object, newRec: ?Object}>|null}}
 *   changes is null for the initial snapshot (or after a resync)
 * @private
 */
const applySnapshot = (live, snapshot, mapFn = defaultMapDoc) => {
    if (!live.initialized) {
        live.docs = snapshot.docs.map(mapFn);
        live.initialized = true;
        return { changed: true, changes: null };
    }
    const changes = snapshot.docChanges();
    if (changes.length === 0) return { changed: false, changes: [] };
    const diffs = [];
    changes.forEach(change => {
        let oldRec = null;
        let newRec = null;
        if (change.oldIndex !== -1) oldRec = live.docs.splice(change.oldIndex, 1)[0] || null;
        if (change.newIndex !== -1) {
            newRec = mapFn(change.doc);
            live.docs.splice(change.newIndex, 0, newRec);
        }
        diffs.push({ type: change.type, docId: change.doc.id, oldRec, newRec });
    });
    if (live.docs.length !== snapshot.size) {
        live.docs = snapshot.docs.map(mapFn);
        return { changed: true, changes: null };
    }
    return { changed: true, changes: diffs };
};

const isTabActive = (tabId) => !!document.getElementById(tabId)?.classList.contains('active');

/**
 * Views refreshed after data changes. `tab` is the tab the view lives in
 * (null = always refresh). Views in hidden tabs stay pending until that
 * tab is shown. Refreshing a view emits its event (utils/events.js REFRESH);
 * the pages subscribe, this layer never calls them.
 * @private
 */
const VIEWS = {
    itemsList: { tab: null },
    itemsTable: { tab: 'items' },
    billingDropdown: { tab: 'billing' },
    salesDropdown: { tab: 'wholesale-sales' },
    wholesaleHistory: { tab: 'wholesale-sales' },
    wholesaleOutstanding: { tab: 'wholesale-sales' },
    history: { tab: 'history' },
    due: { tab: 'due' },
    stockAdjustmentHistory: { tab: 'stock' },
    stockView: { tab: 'stock' },
    expensesHistory: { tab: 'expenses' },
    money: { tab: 'money' },
    insights: { tab: 'insights' },
    statements: { tab: 'statements' },
    today: { tab: 'day' }
};

/** Debounce window that coalesces bursts of snapshot events (ms). */
const RENDER_DEBOUNCE_MS = 150;

/** Max wait for server data at startup once cached data is available (ms). */
const FIRST_SNAPSHOT_SERVER_WAIT_MS = 10000;
/** ...when this device already has cached data for the app (#13). */
const FIRST_SNAPSHOT_CACHED_WAIT_MS = 2500;
/** A first snapshot from cache had documents this session (the device has used the app before). */
let warmCache = false;
/** Per-listener startup facts for Diagnostics (first source, doc count, what made it ready). */
const listenerStartup = {};
const pendingViews = new Set();
let stockDirty = false;
let flushTimer = null;

const runView = (name) => {
    emit(REFRESH[name]);
};

const runPendingViews = (shouldRun) => {
    for (const name of [...pendingViews]) {
        if (!shouldRun(VIEWS[name])) continue;
        pendingViews.delete(name);
        runView(name);
    }
};

const flushPendingWork = async () => {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    if (stockDirty) {
        stockDirty = false;
        try {
            await FirebaseService.getStock();
        } catch (e) {
            console.error('Stock recalculation error:', e);
        }
    }
    runPendingViews(view => !view.tab || isTabActive(view.tab));
};

const scheduleFlush = () => {
    if (!flushTimer) {
        flushTimer = setTimeout(flushPendingWork, RENDER_DEBOUNCE_MS);
    }
};

const markDirty = (views, affectsStock) => {
    views.forEach(v => pendingViews.add(v));
    if (affectsStock) stockDirty = true;
    scheduleFlush();
};

// Refresh views that went stale while their tab was hidden.
if (typeof window !== 'undefined') {
    window.addEventListener('aadhat:tabshown', (event) => {
        const tabId = event.detail?.tabId;
        if ([...pendingViews].some(name => VIEWS[name].tab === tabId)) {
            // Run now (not debounced) so the tab never shows stale data.
            flushPendingWork();
        }
    });
}

// -------------------- RECENT-HISTORY WINDOW + STOCK CHECKPOINT --------------------
//
// Reads per app open are kept to the recent window instead of all history:
//  * Each history collection is listened to with `timestamp >= liveFrom`, where
//    liveFrom = min(1st of previous month, checkpoint.asOf). Every current save
//    path writes a numeric `timestamp` (FirebaseService.save*/update* add one
//    when missing); legacy docs get one from the checkpoint rebuild backfill.
//  * Old bills that still have money due are kept in memory by realtime
//    listeners on `payment.due > 0` and `dueAmount > 0`.
//  * Stock = replay(checkpoint.state, events with t >= checkpoint.asOf). The
//    checkpoint (doc stockCheckpoints/current) is the running state after every
//    event before asOf, so the result is identical to a full replay. It is
//    rebuilt from a full read when missing/stale/incompatible (one device at a
//    time, guarded by a lease), rolled forward from in-memory data when it is
//    more than a week behind the window start, and marked stale whenever a
//    stock-affecting record older than it is created/edited/deleted.
//  * ensureHistoryFrom()/loadOlderHistory() one-shot fetch older ranges on
//    demand. Those records stay in memory for the session but are NOT live:
//    edits made to them on another device show up on the next app open.
//
// AppState history arrays keep their historical order (`date` desc, ties by
// document id desc, as orderBy('date','desc') returned) and, like that query,
// exclude documents without a `date` field.

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECKPOINT_COLLECTION = 'stockCheckpoints';
const CHECKPOINT_DOC_ID = 'current';
const LEGACY_SCAN_DOC_ID = 'legacyScan';
/** Keep scanning a collection for timestamp-less docs this long after old clients last wrote one. */
const LEGACY_RESCAN_MS = 14 * DAY_MS;
/** ...but at most once per this interval across all devices. */
const LEGACY_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Bump when the legacy backfill learns a new field (2: openDue). */
const LEGACY_SCAN_VERSION = 2;
/** Owner/manager devices fully rebuild a checkpoint older than this (bounds drift from deletes by outdated apps). */
const FORCED_REBUILD_AGE_MS = 7 * DAY_MS;
/** Roll the checkpoint forward once it is this far behind the window start. */
const ROLL_FORWARD_SLACK_MS = 7 * DAY_MS;
/** How long a device may hold the rebuild lease. */
const REBUILD_LEASE_MS = 10 * 60 * 1000;
/** Re-check delay when another device has just built the checkpoint. */
const FRESH_CHECKPOINT_WAIT_MS = 5000;
/** Edits older than the window start of (now + margin) invalidate (covers roll-forwards by devices near a month boundary). */
const INVALIDATION_MARGIN_MS = 2 * DAY_MS;
const BACKFILL_MAX_WRITES = 5000;
const BACKFILL_BATCH_SIZE = 400;
const ROLL_FORWARD_RETRY_MS = 30000;
const RETRY_LIMIT_BASE = 1000000;
/** Retry delay after the full-history read for stock failed. */
const FULL_LOAD_RETRY_MS = 30000;
/** Max pinned (due-but-not-queryable) bills per collection; listened to in chunks of 30. */
const PINNED_MAX = 300;
const PINNED_CHUNK = 30;

const HISTORY_COLLECTIONS = [
    { key: 'purchases', stateKey: 'purchaseHistory', label: 'Purchases', stock: true, dues: true,
        views: ['billingDropdown', 'salesDropdown', 'history', 'due', 'stockView', 'money', 'insights', 'statements', 'today'] },
    { key: 'retailSales', stateKey: 'retailSalesHistory', label: 'Retail sales', stock: true, dues: true,
        views: ['billingDropdown', 'history', 'due', 'stockView', 'money', 'insights', 'statements', 'today'] },
    { key: 'wholesaleSales', stateKey: 'salesHistory', label: 'Sales', stock: true, dues: true,
        views: ['billingDropdown', 'salesDropdown', 'wholesaleHistory', 'wholesaleOutstanding', 'history', 'due', 'stockView', 'money', 'insights', 'statements', 'today'] },
    { key: 'expenses', stateKey: 'expensesHistory', label: 'Expenses', voidable: true,
        views: ['expensesHistory', 'money', 'insights', 'statements', 'today'] },
    // Shares AppState.expensesHistory with `expenses` (publishCollection merges them, #98)
    { key: 'personalExpenses', stateKey: 'expensesHistory', label: 'Personal expenses', optional: true, timestamped: true, voidable: true,
        views: ['expensesHistory', 'money', 'insights', 'statements', 'today'] },
    { key: 'stockAdjustments', stateKey: 'stockAdjustments', label: 'Stock adjustments', stock: true,
        views: ['stockAdjustmentHistory', 'stockView', 'money', 'insights', 'statements'] },
    { key: 'withdrawals', stateKey: 'withdrawalsHistory', label: 'Withdrawals', optional: true,
        views: ['money', 'statements'] }
];
const HISTORY_SPEC = Object.fromEntries(HISTORY_COLLECTIONS.map(s => [s.key, s]));
const ALL_HISTORY_VIEWS = [...new Set(HISTORY_COLLECTIONS.flatMap(s => s.views))];

/**
 * Whether this user may read a history collection (firestore.rules): withdrawals
 * only with Money, Statements or Insights on for the role (#57). Uses the last
 * known Roles & access, so a change applies from the next app start.
 */
function historySpecReadable(spec, role = AppState.userRole, roleAccess = AppState.settings?.roleAccess) {
    if (spec.key === 'withdrawals') return canReadWithdrawals(role, roleAccess);
    if (spec.key === 'personalExpenses') return canReadPersonalExpenses(role, roleAccess);
    return true;
}

/** Firestore document id of each mapped record (the data may carry its own `id`). */
const docIds = new WeakMap();

/**
 * Payment state of a bill as loaded from Firestore. Stored under a symbol key
 * so it survives `{...bill}` copies made by edit screens (and is never written
 * back: Firestore and JSON ignore symbol keys). update*() compare it with the
 * server copy to refuse overwriting payments recorded on another device.
 */
const LOADED_PAYMENT = Symbol('aadhatLoadedPayment');
/** JSON with sorted object keys (Firestore returns map fields in its own order). */
const stableJson = (v) => {
    if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
    if (v && typeof v === 'object' && !(typeof v.toMillis === 'function')) {
        return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
    }
    if (v && typeof v.toMillis === 'function') return String(v.toMillis());
    return JSON.stringify(v ?? null);
};
const paymentSignature = (d) => {
    if (!d) return null;
    const p = d.payment && typeof d.payment === 'object' ? d.payment : {};
    const payments = Array.isArray(d.payments) ? d.payments : [];
    return stableJson([
        p.due ?? null, p.cash ?? null, p.online ?? null, p.total ?? null,
        payments.length, payments.length ? payments[payments.length - 1] : null,
        d.dueAmount ?? null, !!d.cleared
    ]);
};

const mapDoc = (doc) => {
    // 'estimate': a bill saved on this device still shows its createdAt (#87) until the server confirms it
    const data = doc.data({ serverTimestamps: 'estimate' });
    const rec = { id: doc.id, ...data };
    docIds.set(rec, doc.id);
    rec[LOADED_PAYMENT] = paymentSignature(data);
    return rec;
};

/** Only owners/managers write checkpoint state (firestore.rules); staff devices never rebuild/roll forward. */
const canManageCheckpoint = () => ['owner', 'manager'].includes(AppState.userRole);
const isPermissionDenied = (e) => e?.code === 'permission-denied' || /insufficient permissions/i.test(String(e?.message || ''));
const docIdOf = (rec) => (docIds.has(rec) ? docIds.get(rec) : String(rec?.id));
const byDateDesc = dateDescComparator(docIdOf);

let sessionGen = 0;
/** @type {?{gen: number, liveFrom: number, rawFull: boolean, colls: Object}} */
let windowState = null;
/** Latest checkpoint doc data seen (undefined = not read yet, null = missing). */
let checkpointDoc;
/** Checkpoint in use for stock (parsed), or null. */
let activeCheckpoint = null;
let checkpointItemsCheck = { items: null, checkpoint: null, ok: false };

let rebuildPromise = null;
let rebuildRequestedAgain = false;
/** Stock objects returned while another device rebuilds the checkpoint (not exact yet). */
const pendingStocks = new WeakSet();
/** Re-checks the stock once the other device's lease ends. */
let leaseWaitTimer = null;
/** When this session first started waiting for another device's rebuild (0 = never). */
let leaseWaitStartedAt = 0;
/** Bumped on every change to a stock collection in memory (roll-forward conflict detection). */
let stockChangeGen = 0;
/** stockCheckpoints/legacyScan: per collection {complete, foundAt} of the timestamp backfill. */
let legacyScanDoc = null;
/** The legacyScan doc read of this session (never rejects); read in parallel with the listeners. */
let legacyScanReadPromise = Promise.resolve();
/** Background legacy scan scheduled after the first screen: {run, cancel} (#13). */
let legacyScanJob = null;
/** Set by calculateStock() when the stock it returned is approximate (members, stale checkpoint, #129). */
let lastStockApprox = null;
/** Parsed stale checkpoint for approximate stock, cached per checkpoint doc snapshot. */
let approxCheckpointCache = { doc: undefined, cp: null };
/** This device made a checkpoint-invalidating edit this session (approximate stock would miss it). */
let ownStaleWrite = false;
let oldestTimestampPromise = null;
/** When the on-demand (non-live) history currently in memory was first fetched (0 = none). */
let onDemandAsOf = 0;
let extendQueue = Promise.resolve();
const pendingExtends = new Map();
const invalidationTags = new Set();

const checkpointRef = () => getDb().collection(col(CHECKPOINT_COLLECTION)).doc(CHECKPOINT_DOC_ID);

const createCollState = (spec) => ({
    spec,
    live: { docs: [], initialized: false, server: false },
    dues: [],
    extended: new Map(),
    publishedExtended: new Set()
});

const liveIdSet = (c, except = null) => {
    const ids = new Set();
    [c.live, ...c.dues].forEach(l => {
        if (l !== except) l.docs.forEach(r => ids.add(docIdOf(r)));
    });
    return ids;
};

const findInSources = (c, docId, except = null) => {
    for (const l of [c.live, ...c.dues]) {
        if (l === except) continue;
        const rec = l.docs.find(r => docIdOf(r) === docId);
        if (rec) return rec;
    }
    return c.extended.get(docId) || null;
};

const currentSources = () => ({
    purchases: AppState.purchaseHistory || [],
    wholesaleSales: AppState.salesHistory || [],
    retailSales: AppState.retailSalesHistory || [],
    stockAdjustments: AppState.stockAdjustments || []
});

/**
 * Rebuilds AppState[stateKey] from the window listener, the dues listeners and
 * the one-shot (extended) records, deduped by document id (live data wins).
 * @private
 */
function publishCollection(c) {
    const current = AppState[c.spec.stateKey];
    if (c.publishedExtended.size && Array.isArray(current)) {
        // A one-shot record that was published but is gone from AppState was
        // removed by app code (e.g. a delete that splices the array); don't
        // resurrect it, and treat it as a deletion for the stock checkpoint.
        const present = new Set(current.map(r => String(r?.id)));
        const live = liveIdSet(c);
        c.publishedExtended.forEach(docId => {
            const rec = c.extended.get(docId);
            if (rec && !present.has(String(rec.id)) && !live.has(docId)) {
                c.extended.delete(docId);
                if (c.spec.stock) noteObservedChange(c, rec, null, 'removed locally');
            }
        });
    }
    const merged = new Map();
    c.extended.forEach((rec, id) => merged.set(id, rec));
    c.dues.forEach(l => l.docs.forEach(rec => merged.set(docIdOf(rec), rec)));
    c.live.docs.forEach(rec => merged.set(docIdOf(rec), rec));
    const list = [];
    const voided = [];
    merged.forEach(rec => {
        if (rec.date === undefined) return;
        // Voided bills (#75) and expenses (#99) never reach AppState's lists, so no figure counts them; History / Expenses ask for them.
        if ((c.spec.dues || c.spec.voidable) && !isActiveBill(rec)) voided.push(rec);
        else list.push(rec);
    });
    list.sort(byDateDesc);
    voided.sort(byDateDesc);
    c.voided = voided;
    c.publishedExtended = new Set();
    list.forEach(rec => {
        const id = docIdOf(rec);
        if (c.extended.get(id) === rec) c.publishedExtended.add(id);
    });
    c.published = list;
    AppState[c.spec.stateKey] = withSharedState(c, list);
    AppState.dataVersion = ++dataVersion;
    if (c.spec.stock) stockChangeGen++;
}

/** The published lists of every collection sharing c's AppState key (expenses + personal expenses), newest first. */
function withSharedState(c, list) {
    const others = Object.values(windowState?.colls || {})
        .filter(o => o !== c && o.spec.stateKey === c.spec.stateKey && Array.isArray(o.published));
    if (!others.length) return list;
    return [...list, ...others.flatMap(o => o.published)].sort(byDateDesc);
}

/**
 * Where an expense lives (#98): personalExpenses when that collection's state holds it, by
 * document id or by its own `id` field (old-app rows carry a numeric one), else expenses.
 * @returns {{collKey: string, rec: ?Object, docId: string}}
 */
function locateExpense(id) {
    const c = windowState?.colls?.personalExpenses;
    const sid = String(id);
    if (c) {
        const recs = [...c.extended.values(), ...c.live.docs, ...c.dues.flatMap(l => l.docs), ...(c.published || [])];
        const rec = recs.find(r => docIdOf(r) === sid) || recs.find(r => String(r?.id) === sid);
        if (rec) return { collKey: 'personalExpenses', rec, docId: docIdOf(rec) };
    }
    return { collKey: 'expenses', rec: null, docId: sid };
}

const personalDayOf = (rec) => rec?.day || personalDayKey(rec?.date);

/**
 * One key of personalExpenseDays/{day}: the expense's amount, or removed (amount null), and
 * its online flag (EXP-MODE, #118: set when paid online, else removed).
 * `last` names the key for firestore.rules (validPersonalDay).
 */
function personalDayWrite(day, id, amount, online = false) {
    const fv = typeof firebase !== 'undefined' ? firebase.firestore?.FieldValue : null;
    const remove = typeof fv?.delete === 'function' ? fv.delete() : undefined;
    const value = amount === null ? remove : amount;
    const flag = amount !== null && online ? true : remove;
    return [getDb().collection(col(PERSONAL_DAYS_COLLECTION)).doc(day), { amounts: { [id]: value }, online: { [id]: flag }, last: id }, { merge: true }];
}

/** Adds the day-doc key of a personal expense write to a batch: set to its amount, or removed (#98). */
function addPersonalDayWrites(batch, id, before, after) {
    const from = before ? personalDayOf(before) : null;
    const to = after ? personalDayOf(after) : null;
    if (from && from !== to) batch.set(...personalDayWrite(from, String(id), null));
    if (to && !(from === to && Number(before.amount) === Number(after.amount) && isOnlineExpense(before) === isOnlineExpense(after))) {
        batch.set(...personalDayWrite(to, String(id), Number(after.amount) || 0, isOnlineExpense(after)));
    }
}

/** Personal expense day totals read on this device: { [YYYY-MM-DD]: {total, count, at} }. */
const personalDayCache = new Map();

/**
 * Bill numbers already warned about this session (#41): pre-fix offline
 * numbering on two phones could issue the same number; tell the user once
 * when such a bill syncs so it can be told apart by customer/time.
 */
const warnedDuplicateBillNumbers = new Set();
function warnDuplicateBillNumbers(c, changes) {
    const dups = Helpers.findDuplicateBillNumbers(changes, AppState[c.spec.stateKey], docIdOf)
        .filter(n => !warnedDuplicateBillNumbers.has(n));
    if (!dups.length) return;
    dups.forEach(n => warnedDuplicateBillNumbers.add(n));
    console.warn(`[${c.spec.label}] duplicate bill number(s) after sync:`, dups);
    import('../ui/ui-manager.js')
        .then(({ UIManager }) => UIManager.showToast(
            t('msg.sync.same_bill_number_used_twice', { dups: dups.join(', ') }), 6000))
        .catch(() => {});
}

/**
 * Keeps the in-memory copy of a record written by this device in step with the
 * write: one-shot (extended) records are not live, so without this the next
 * publish would resurrect the pre-edit version. Live records are left to their
 * listener. record = null for deletes.
 * @private
 */
function noteLocalRecordWrite(collKey, docId, record) {
    const c = windowState?.colls[collKey];
    if (!c) return;
    const id = String(docId);
    if (record) {
        if (!liveIdSet(c).has(id)) {
            const rec = { ...record, id: record.id ?? id };
            rec[LOADED_PAYMENT] = paymentSignature(record);
            docIds.set(rec, id);
            c.extended.set(id, rec);
        }
    } else {
        c.extended.delete(id);
        c.extended.forEach((rec, key) => {
            if (String(rec.id) === id) c.extended.delete(key);
        });
    }
    publishCollection(c);
}

/** Parses a checkpoint doc; null if missing, stale (unless allowStale) or incompatible. */
function parseCheckpoint(data, { allowStale = false } = {}) {
    if (!data || data.formatVersion !== STOCK_REPLAY_FORMAT || (data.stale && !allowStale)) return null;
    if (typeof data.asOf !== 'number' || !Number.isFinite(data.asOf)) return null;
    const state = deserializeState(data.state);
    if (!state || !Array.isArray(data.resolutions)) return null;
    return {
        asOf: data.asOf,
        state,
        resolutions: data.resolutions.map(r => [r?.i ?? null, r?.n ?? '', r?.k]),
        itemsSignature: data.itemsSignature,
        staleCount: data.staleCount || 0,
        builtAt: data.builtAt || 0
    };
}

const checkpointMatchesItems = (cp, items = AppState.items || []) => {
    if (checkpointItemsCheck.items === items && checkpointItemsCheck.checkpoint === cp) {
        return checkpointItemsCheck.ok;
    }
    const ok = cp.itemsSignature === itemsSignature(items) || resolutionsStillValid(cp.resolutions, items);
    checkpointItemsCheck = { items, checkpoint: cp, ok };
    return ok;
};

/** The active checkpoint if it can produce exact stock right now. */
function usableCheckpoint() {
    const cp = activeCheckpoint;
    if (!cp || !windowState || windowState.liveFrom > cp.asOf) return null;
    return checkpointMatchesItems(cp) ? cp : null;
}

/**
 * Member devices only (#129): the last checkpoint even when it is marked
 * stale, if the loaded window covers it. Its state + the window give stock
 * that misses only the older edits that made it stale, so it is shown as
 * approximate instead of reading all history.
 */
function approximateCheckpoint() {
    if (!windowState || canManageCheckpoint() || !checkpointDoc || ownStaleWrite) return null;
    if (approxCheckpointCache.doc !== checkpointDoc) {
        approxCheckpointCache = { doc: checkpointDoc, cp: parseCheckpoint(checkpointDoc, { allowStale: true }) };
    }
    const cp = approxCheckpointCache.cp;
    if (!cp || windowState.liveFrom > cp.asOf) return null;
    return checkpointMatchesItems(cp) ? cp : null;
}

function adoptCheckpoint(data) {
    const cp = parseCheckpoint(data);
    if (!cp || !windowState || cp.asOf < windowState.liveFrom) return false;
    const cur = activeCheckpoint;
    if (cur && cur.asOf === cp.asOf && cur.builtAt === cp.builtAt && cur.staleCount === cp.staleCount) return true;
    activeCheckpoint = cp;
    AppState.dataVersion = ++dataVersion;
    return true;
}

const knownCheckpointAsOf = () => Math.max(
    activeCheckpoint?.asOf || 0,
    checkpointDoc && typeof checkpointDoc.asOf === 'number' ? checkpointDoc.asOf : 0
);

const invalidationTag = (collKey, oldRec, newRec) =>
    `${collKey}|${docIdOf(oldRec || newRec)}|${stockFingerprint(newRec)}`;

/**
 * Marks the stored checkpoint stale (merge write, fire-and-forget). When the
 * change also falls before the checkpoint this device uses, stock falls back
 * to a full replay until a rebuilt checkpoint is available.
 * @private
 */
function invalidateCheckpoint(reason, affectsLocal) {
    let write = Promise.resolve();
    try {
        const fv = typeof firebase !== 'undefined' ? firebase.firestore?.FieldValue : null;
        write = checkpointRef().set({
            stale: true,
            staleCount: fv?.increment ? fv.increment(1) : Date.now(),
            staleAt: Date.now(),
            staleReason: String(reason).slice(0, 200),
            staleBy: AppState.currentUser?.uid || 'unknown'
        }, { merge: true });
        write.catch(e => console.error('Stock checkpoint invalidation failed:', e));
    } catch (e) {
        console.error('Stock checkpoint invalidation failed:', e);
    }
    console.info(`Stock checkpoint invalidated (${reason})`);
    if (affectsLocal && activeCheckpoint) {
        activeCheckpoint = null;
        AppState.dataVersion = ++dataVersion;
        if (windowState) markDirty(['stockView'], true);
    }
    // Rebuild once the stale mark has reached the server (otherwise the
    // rebuild's own conflict check would discard it).
    if (canManageCheckpoint()) requestRebuild(write);
}

/** Safety net for changes seen by listeners (other devices, direct writes). */
function noteObservedChange(c, oldRec, newRec, why) {
    const threshold = knownCheckpointAsOf();
    if (!threshold || !changeInvalidatesCheckpoint(oldRec, newRec, threshold)) return;
    const tag = invalidationTag(c.spec.key, oldRec, newRec);
    if (invalidationTags.has(tag)) return;
    invalidationTags.add(tag);
    const local = !!activeCheckpoint && changeInvalidatesCheckpoint(oldRec, newRec, activeCheckpoint.asOf);
    invalidateCheckpoint(`${c.spec.key} ${why}`, local);
}

/**
 * Called by FirebaseService write paths for stock-affecting records, after the
 * record write has been issued (writes reach the server in issue order).
 * @private
 */
function noteStockWrite(collKey, oldRec, newRec, opts = {}) {
    try {
        const threshold = Math.max(knownCheckpointAsOf(), defaultWindowStart(Date.now() + INVALIDATION_MARGIN_MS));
        if (!changeInvalidatesCheckpoint(oldRec, newRec, threshold, opts)) return;
        invalidationTags.add(invalidationTag(collKey, oldRec, newRec));
        const local = !!activeCheckpoint && changeInvalidatesCheckpoint(oldRec, newRec, activeCheckpoint.asOf, opts);
        // The last checkpoint no longer reflects this device's own edit: no approximate stock from it (#129).
        ownStaleWrite = true;
        invalidateCheckpoint(`${collKey} write`, local);
        if (AppState.stockApprox && windowState) markDirty(['stockView'], true);
    } catch (e) {
        console.error('Stock checkpoint invalidation check failed:', e);
    }
}

/** The last stale mark started by noteMonthWrite (tests wait for it). */
let lastMonthMark = Promise.resolve([]);
/** Local time this device started its last fresh read of all history (0 = none this session). */
let fullHistoryFetchedAt = 0;

/** The time a record counts in a month: BILL-TIME for bills / adjustments, its date for expenses / withdrawals. */
function monthTimeOf(collKey, rec) {
    if (!rec) return null;
    if (collKey === 'expenses' || collKey === 'personalExpenses' || collKey === 'withdrawals') return parseAnyBillDate(rec.date)?.getTime() ?? null;
    const t = eventTime(rec);
    return t === Number.MAX_SAFE_INTEGER ? null : t;
}

/**
 * Marks the month snapshots (monthStats) a write to a record dated before this month makes wrong
 * as stale: one merge write per month (staleMonthsFor), issued after the record write, never
 * blocking it. Owner/manager devices rebuild them (Money: rollSnapshots, Build month history).
 * @private
 * @returns {Promise<string[]>} the months marked
 */
function noteMonthWrite(collKey, oldRec, newRec) {
    try {
        const now = Date.now();
        const d = new Date(now);
        const current = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
        const times = [monthTimeOf(collKey, oldRec), monthTimeOf(collKey, newRec)];
        if (!times.some(t => Number.isFinite(t) && t < current)) return (lastMonthMark = Promise.resolve([]));
        const cascade = !!HISTORY_SPEC[collKey]?.stock && stockFingerprint(oldRec) !== stockFingerprint(newRec);
        lastMonthMark = import('../utils/month-snapshots.js').then(({ staleMonthsFor, staleMark }) => {
            const months = staleMonthsFor(times, { now, cascade });
            if (!months.length) return months;
            const db = getDb();
            const ref = db.collection(col('monthStats'));
            const batch = db.batch();
            months.forEach(k => batch.set(ref.doc(k), staleMark(k, now), { merge: true }));
            batch.commit().catch(e => console.error('Month snapshot stale mark failed:', e));
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('aadhat:monthstale', { detail: { months, at: now } }));
            }
            return months;
        }).catch(e => {
            console.error('Month snapshot stale mark failed:', e);
            return [];
        });
        return lastMonthMark;
    } catch (e) {
        console.error('Month snapshot stale mark failed:', e);
        return Promise.resolve([]);
    }
}

/**
 * Puts this device's version of a live record in its listener's list at once
 * (a void: published lists drop it before the listener's own update arrives).
 * @private
 */
function replaceLiveRecord(collKey, docId, record) {
    const docs = windowState?.colls?.[collKey]?.live?.docs;
    const i = docs ? docs.findIndex(r => docIdOf(r) === String(docId)) : -1;
    if (i === -1) return;
    const rec = { ...record };
    docIds.set(rec, String(docId));
    docs[i] = rec;
}

/** Finds the in-memory version of a history record by document id or `id` field. */
function findRecord(collKey, id) {
    if (id === undefined || id === null) return null;
    const arr = AppState[HISTORY_SPEC[collKey].stateKey] || [];
    const sid = String(id);
    return arr.find(r => docIdOf(r) === sid) || arr.find(r => String(r?.id) === sid) || null;
}

/** A bill's edit records (#121): a sub-collection, so the bill's own (dev_-prefixed) collection sets the environment. */
const BILL_EDITS = 'edits';
const billEditsRef = (billRef) => billRef.collection(BILL_EDITS);

/** Voided bills (#75) loaded for a bill collection, newest first (kept out of AppState). */
const voidedOf = (collKey) => windowState?.colls?.[collKey]?.voided || [];

/** Drops a deleted record from memory so it is not resurrected. */
function forgetRecord(collKey, id) {
    noteLocalRecordWrite(collKey, id, null);
}

/**
 * New history record with an id made on the phone, shown in memory at once
 * (works offline; the listener later replaces it, same doc id). A refused
 * write removes it again and rejects `committed`. `id`: save again over this
 * not-yet-confirmed record; `sent` is the raw write (for whenStoredLocally).
 * `withBatch(batch, docId)` adds writes that must land with it (one batch).
 * @private
 * @returns {{record: Object, committed: Promise<void>, sent: Promise<void>}}
 */
function startCreate(collKey, data, id = null, withBatch = null) {
    const coll = getDb().collection(col(collKey));
    const ref = id ? coll.doc(String(id)) : coll.doc();
    const record = { id: ref.id, ...data };
    const stateKey = HISTORY_SPEC[collKey].stateKey;
    noteLocalRecordWrite(collKey, ref.id, record);
    const list = AppState[stateKey] || (AppState[stateKey] = []);
    const at = list.findIndex(r => String(r.id) === ref.id);
    if (at === -1) list.unshift(record);
    else list[at] = record;
    let sent;
    if (withBatch) {
        const batch = getDb().batch();
        batch.set(ref, data);
        withBatch(batch, ref.id);
        sent = batch.commit();
    } else {
        sent = ref.set(data);
    }
    SyncStatus.trackWrite(ref.path, sent);
    const committed = sent.catch(err => {
        forgetRecord(collKey, ref.id);
        const i = (AppState[stateKey] || []).findIndex(r => String(r.id) === ref.id);
        if (i !== -1) AppState[stateKey].splice(i, 1);
        throw err;
    });
    return { record, committed, sent };
}

/**
 * Gives a record the numeric `timestamp` the window queries filter on. Uses
 * the time the stock replay already assigns it (so replay order is unchanged),
 * or now for a new record without a parseable date.
 * @private
 */
function ensureTimestamp(record, isNew) {
    if (!record || typeof record.timestamp === 'number') return;
    const t = eventTime(record);
    record.timestamp = t === Number.MAX_SAFE_INTEGER && isNew ? Date.now() : t;
}

/**
 * Fields every FirebaseService bill/adjustment write carries: numeric timestamp,
 * clientVersion (required by firestore.rules) and, for bills, `openDue`
 * (the dues listener's filter).
 * @private
 */
function prepareStockRecord(collKey, record, isNew) {
    ensureTimestamp(record, isNew);
    record.clientVersion = CLIENT_VERSION;
    if (HISTORY_SPEC[collKey].dues) record.openDue = hasDue(collKey, record);
}

/** Bill fields that Outstanding / other devices change after a bill is created. */
const BILL_MONEY_FIELDS = ['payment', 'payments', 'dueAmount', 'cashPayment', 'onlinePayment', 'openDue', 'cleared'];

const withServerCreatedAt = (record) => ({ ...record, createdAt: serverCreatedAt() });

/** Keeps the bill's stored `createdAt` on an overwrite (the rules refuse a change). */
function keepStoredCreatedAt(record, stored) {
    if (stored && stored.createdAt !== undefined && stored.createdAt !== null) record.createdAt = stored.createdAt;
    else delete record.createdAt;
}

/** Keeps the bill's stored edit count on an overwrite (#121: it only moves with an edit record). */
function keepEditCount(record, stored) {
    if (editCountOf(stored)) record.editCount = editCountOf(stored);
    else delete record.editCount;
}

/**
 * A retried new bill that changes what its unconfirmed first save stored is an edit (#121):
 * its record goes into the same transaction, with a fixed reason in the app language.
 * Sets `target.editCount`. @private
 */
function logRetryEdit(tx, ref, server, after, target) {
    const changes = billEditChanges(server, after);
    if (!hasEditChanges(changes)) return;
    const n = nextEditNumber(server);
    target.editCount = n;
    tx.set(billEditsRef(ref).doc(String(n)), editRecord({
        n, at: serverCreatedAt(), by: AppState.currentUser?.uid || null, byName: AppState.userName,
        reason: t('ui.edits.retry_reason'), changes
    }));
}
/** Payment signature of the last new-bill write this device sent, by `${collKey}/${id}` (#70). */
const sentBillPaymentSigs = new Map();
/** Bills whose retry kept the server's money fields (a payment was recorded meanwhile). */
const keptServerPaymentBills = new WeakSet();
/** Bills that were stored on this phone while offline and are waiting to sync. */
const savedOnPhoneBills = new WeakSet();
/** Bills whose write this phone had not confirmed storing when the save gave up waiting. */
const unconfirmedBills = new WeakSet();
/** `${collKey}/${id}` of new bills whose first set() hasn't settled yet. */
const pendingFirstSaves = new Set();
/** Of those, the ones a retry has saved meanwhile. */
const retriedBillSaves = new Set();
/** First set() of new bills not yet confirmed on this phone, by key: { sent, json } (#153). */
const unconfirmedFirstSaves = new Map();

/** A bill's content as compared between save attempts (createdAt is set by the server). */
const billAttemptJson = (record) => {
    const rest = { ...record };
    delete rest.createdAt;
    return stableJson(rest);
};

/**
 * An offline re-save of a bill whose first attempt was not confirmed (#153): a
 * transaction needs the server, so instead check that first write on this phone.
 * 'stored' - stored, same content: nothing to write; 'resend' - this phone
 * refused it: save it again as new; 'unconfirmed' - still unknown, or changed
 * since (no write: re-sending could clash with the queued first write).
 * @private
 */
async function offlineRetryOutcome(key, record) {
    const first = unconfirmedFirstSaves.get(key);
    if (!first) return 'unconfirmed';
    const stored = await whenStoredLocally(first.sent, LOCAL_STORE_WAIT_MS);
    if (stored === false) return 'resend';
    if (stored === true && first.json === billAttemptJson(record)) return 'stored';
    return 'unconfirmed';
}

/**
 * Creates a bill (or overwrites by id) and keeps memory/checkpoint in step.
 * With `retry`, the same new bill (same id) is saved again after a failed or
 * timed-out attempt: see retryBillSave. @private
 */
async function saveBill(collKey, record, label, { retry = false } = {}) {
    if (!record.userId && AppState.currentUser) record.userId = AppState.currentUser.uid;
    if (!record.userName && AppState.userName) record.userName = AppState.userName;
    const previous = record.id ? findRecord(collKey, record.id) : null;
    prepareStockRecord(collKey, record, !previous);
    if (!record.id) record.id = getDb().collection(col(collKey)).doc().id;
    const docRef = getDb().collection(col(collKey)).doc(String(record.id));
    const key = `${collKey}/${record.id}`;
    const run = startBillSaveRun(collKey, record, retry);
    let resend = false;
    if (retry && typeof navigator !== 'undefined' && navigator.onLine === false) {
        const outcome = await offlineRetryOutcome(key, record);
        if (outcome !== 'resend') {
            if (outcome === 'stored') {
                unconfirmedFirstSaves.delete(key);
                savedOnPhoneBills.add(record);
            } else {
                unconfirmedBills.add(record);
            }
            run.complete();
            return record;
        }
        resend = true;
    }
    if (retry && !resend) {
        try {
            const saved = await retryBillSave(collKey, record, docRef, previous, key);
            unconfirmedFirstSaves.delete(key);
            run.complete();
            return saved;
        } catch (error) {
            run.completeAndFail('save_error', { code: String(error?.code || 'unknown').slice(0, 40) });
            throw error;
        }
    }
    sentBillPaymentSigs.set(key, paymentSignature(record));
    let payload = record;
    if (previous && !resend) {
        if (record.createdAt === undefined && previous.createdAt !== undefined) record.createdAt = previous.createdAt;
    } else {
        // Local estimate until the listener brings the server time
        record.createdAt = Date.now();
        payload = withServerCreatedAt(record);
    }
    pendingFirstSaves.add(key);
    const sent = docRef.set(payload);
    SyncStatus.trackWrite(docRef.path, sent);
    unconfirmedFirstSaves.set(key, { sent, json: billAttemptJson(record) });
    // A #70 retry may already have created this bill; this first attempt then arrives later as an
    // update that changes createdAt, which the rules refuse for non-owners (#87). Nothing is lost.
    const settled = () => {
        pendingFirstSaves.delete(key);
        retriedBillSaves.delete(key);
    };
    const write = Promise.resolve(sent).then(settled, (error) => {
        const superseded = retriedBillSaves.has(key) && isPermissionDenied(error);
        settled();
        if (superseded) {
            // Expected (a retry already saved this bill): not a misuse signal (#124)
            if (error && typeof error === 'object') error.aadhatExpected = true;
            return { supersededByRetry: true };
        }
        throw error;
    });
    // Server acknowledgement (may come after settleWrite released the UI)
    write.then((r) => run.complete(r ? { supersededByRetry: true } : undefined), (error) => run.completeAndFail('write_rejected', { code: String(error?.code || 'unknown').slice(0, 40) }));
    noteStockWrite(collKey, previous, record);
    noteMonthWrite(collKey, previous, record);
    noteLocalRecordWrite(collKey, String(record.id), record);
    const { pending, stored } = await settleWrite(write, label);
    if (!stored) {
        unconfirmedBills.add(record);
        return record;
    }
    unconfirmedFirstSaves.delete(key);
    if (pending && typeof navigator !== 'undefined' && navigator.onLine === false) savedOnPhoneBills.add(record);
    return record;
}

/** TIP BillSave run (#217) for a new bill; never throws. @private */
function startBillSaveRun(collKey, record, retry) {
    if (!retry) track(`bill.save.${collKey}`);
    try {
        return tip.start('BillSave', {
            flags: { retry: !!retry, offline: typeof navigator !== 'undefined' && navigator.onLine === false },
            props: billSaveProps(collKey, record, Date.now())
        });
    } catch (_) {
        return { complete() {}, completeAndFail() {} };
    }
}

/**
 * Retry of a new bill whose earlier attempt may already have reached the server
 * (#70). In a transaction: missing → create; identical → nothing to write; if a
 * payment was recorded on the server since (payments[] or a payment state other
 * than the one this device sent) → save the bill but keep the server's money
 * fields, so due / cash / payments[] stay consistent; otherwise overwrite.
 * Needs a connection (transaction). On "kept", `record` is updated in place with
 * the server's money fields. @private
 */
async function retryBillSave(collKey, record, ref, previous, key) {
    const sentSig = sentBillPaymentSigs.get(key) ?? paymentSignature(record);
    let kept = false;
    let wrote = false;
    let serverMoney = null;
    await getDb().runTransaction(async tx => {
        kept = false;
        wrote = true;
        serverMoney = null;
        const snap = await tx.get(ref);
        if (!snap.exists) {
            if (record.createdAt === undefined) record.createdAt = Date.now();
            tx.set(ref, withServerCreatedAt(record));
            return;
        }
        const server = snap.data() || {};
        // Voided meanwhile on another phone (#75): never written over.
        if (!isActiveBill(server)) throw Object.assign(new Error('This bill was voided'), { code: 'voided' });
        keepStoredCreatedAt(record, server);
        keepEditCount(record, server);
        const serverPayments = Array.isArray(server.payments) ? server.payments : [];
        if (serverPayments.length > 0 || paymentSignature(server) !== sentSig) {
            const nonMoney = { ...record };
            BILL_MONEY_FIELDS.forEach(k => delete nonMoney[k]);
            logRetryEdit(tx, ref, server, { ...server, ...nonMoney }, nonMoney);
            if (nonMoney.editCount !== undefined) record.editCount = nonMoney.editCount;
            tx.set(ref, nonMoney, { merge: true });
            serverMoney = server;
            kept = true;
            return;
        }
        wrote = !Object.keys(record).every(k => stableJson(server[k]) === stableJson(record[k]));
        if (wrote) {
            logRetryEdit(tx, ref, server, record, record);
            tx.set(ref, record);
        }
    });
    if (pendingFirstSaves.has(key)) retriedBillSaves.add(key);
    if (kept) {
        BILL_MONEY_FIELDS.forEach(k => {
            if (k in serverMoney) record[k] = serverMoney[k];
            else delete record[k];
        });
        keptServerPaymentBills.add(record);
    }
    sentBillPaymentSigs.set(key, paymentSignature(record));
    // An identical retry wrote nothing: stock and the checkpoint are unchanged
    if (wrote) {
        noteStockWrite(collKey, previous, record, { oldUnknown: true });
        noteMonthWrite(collKey, previous, record);
    }
    noteLocalRecordWrite(collKey, String(record.id), record);
    return record;
}

/**
 * Overwrites an existing bill only if its payments did not change on the
 * server since this device loaded it (a full set() would otherwise erase a
 * payment recorded elsewhere). Runs in a transaction, so it needs a connection.
 * A change to a recorded field (bill-edits EDIT_FIELDS or the items) also
 * writes its edit record `edits/{n}` in the same transaction (#121): the
 * changed fields before/after, the editor and `reason` (required then).
 * A voided bill is never changed (#75).
 * @private
 */
async function updateBillChecked(collKey, record, { reason = null } = {}) {
    if (!record.id) throw new Error('Bill ID is required for update');
    const previous = findRecord(collKey, record.id);
    prepareStockRecord(collKey, record, false);
    const base = record[LOADED_PAYMENT] ?? previous?.[LOADED_PAYMENT] ?? null;
    const ref = getDb().collection(col(collKey)).doc(String(record.id));
    const why = cleanReason(reason);
    await getDb().runTransaction(async tx => {
        const snap = await tx.get(ref);
        const stored = snap.exists ? snap.data() : null;
        if (stored && !isActiveBill(stored)) {
            throw Object.assign(new Error('This bill was voided'), { code: 'voided' });
        }
        if (base !== null && (!snap.exists || paymentSignature(stored) !== base)) {
            throw Object.assign(
                new Error('This bill was changed on another device — reopen it and try again'),
                { code: 'conflict' }
            );
        }
        if (stored) keepStoredCreatedAt(record, stored);
        const changes = stored ? billEditChanges(stored, record) : null;
        if (changes && hasEditChanges(changes)) {
            if (!why) throw Object.assign(new Error('A reason is needed to change this bill'), { code: 'reason-required' });
            const n = nextEditNumber(stored);
            record.editCount = n;
            tx.set(ref, record);
            tx.set(billEditsRef(ref).doc(String(n)), editRecord({
                n, at: serverCreatedAt(), by: AppState.currentUser?.uid || null, byName: AppState.userName, reason: why, changes
            }));
            return;
        }
        if (stored) keepEditCount(record, stored);
        else delete record.editCount;
        tx.set(ref, record);
    });
    // The server now holds exactly this record: later edits must compare against it.
    record[LOADED_PAYMENT] = paymentSignature(record);
    noteStockWrite(collKey, previous, record, { oldUnknown: true });
    noteMonthWrite(collKey, previous, record);
    noteLocalRecordWrite(collKey, String(record.id), record);
    return record;
}

async function deleteBill(collKey, id) {
    const previous = findRecord(collKey, id);
    const write = getDb().collection(col(collKey)).doc(String(id)).delete();
    noteStockWrite(collKey, previous, null, { oldUnknown: true });
    noteMonthWrite(collKey, previous, null);
    await write;
    forgetRecord(collKey, id);
}

/**
 * Voids a bill (#75): one update in a transaction that sets voided, voidedAt
 * (server time), voidedBy, voidedByName, voidReason and openDue = false. The
 * bill stays stored; from then on it counts in no figure (money.isActiveBill),
 * so stock, month snapshots and the checkpoint are marked as for a delete.
 * Refused (code) when it is already voided ('already-voided') or has payments
 * recorded after it was saved ('has-payments', bill-edits.voidBlocker).
 * Needs a connection.
 * @private
 */
async function voidBillDoc(collKey, bill, reason) {
    const why = cleanReason(reason);
    if (!why) throw Object.assign(new Error('A reason is needed to void a bill'), { code: 'reason-required' });
    const docId = docIdOf(bill);
    const previous = findRecord(collKey, docId);
    const ref = getDb().collection(col(collKey)).doc(String(docId));
    const fields = {
        voided: true,
        voidedAt: serverCreatedAt(),
        voidedBy: AppState.currentUser?.uid || null,
        voidedByName: String(AppState.userName || '').slice(0, 200),
        voidReason: why,
        openDue: false,
        // Bills are stock records: the clientVersion gate checks every write (firestore.rules writesCurrentClient)
        clientVersion: CLIENT_VERSION
    };
    let stored = null;
    await getDb().runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw Object.assign(new Error('Bill not found'), { code: 'not-found' });
        stored = snap.data();
        const blocked = voidBlocker(stored);
        if (blocked) {
            throw Object.assign(new Error(`This bill can't be voided (${blocked})`),
                { code: blocked === 'voided' ? 'already-voided' : 'has-payments' });
        }
        tx.update(ref, fields);
    });
    const voided = { id: docId, ...stored, ...fields, voidedAt: Date.now() };
    noteStockWrite(collKey, previous, voided, { oldUnknown: true });
    noteMonthWrite(collKey, previous || stored, voided);
    noteLocalRecordWrite(collKey, docId, voided);
    return voided;
}

/**
 * Deletes a voided bill for good, with its edit records (owner only in the
 * rules; test data and mistakes). It counted in nothing, so no figure changes.
 * @private
 */
async function deleteVoidedBillDoc(collKey, bill) {
    if (isActiveBill(bill)) throw Object.assign(new Error('Only a voided bill can be deleted'), { code: 'not-voided' });
    const docId = docIdOf(bill);
    const ref = getDb().collection(col(collKey)).doc(String(docId));
    const batch = getDb().batch();
    if (editCountOf(bill)) {
        const edits = await getWithRetry(billEditsRef(ref), 'Bill edits');
        edits.docs.forEach(d => batch.delete(d.ref));
    }
    batch.delete(ref);
    await batch.commit();
    noteLocalRecordWrite(collKey, docId, null);
}

/**
 * Another device is rebuilding the checkpoint: keep the last stock (marked
 * not ready) and re-check when its lease ends or the per-session wait cap
 * (LEASE_MAX_WAIT_MS, local clock, so a skewed or dead lease can't stretch
 * it) runs out, whichever is first; the checkpoint listener re-checks earlier
 * when the rebuilt checkpoint arrives. After the cap, stock falls back to a
 * full-history replay.
 * @private
 */
function waitForCheckpoint(until) {
    const gen = sessionGen;
    if (!leaseWaitStartedAt) leaseWaitStartedAt = Date.now();
    clearTimeout(leaseWaitTimer);
    const remaining = Math.max(LEASE_MAX_WAIT_MS - leaseWaitedMs(), 0);
    const delay = Math.min(Math.max(Number(until) - Date.now(), 0), remaining) + 250;
    leaseWaitTimer = setTimeout(() => {
        leaseWaitTimer = null;
        if (gen !== sessionGen) return;
        AppState.dataVersion = ++dataVersion;
        markDirty(['stockView'], true);
    }, delay);
    console.info('Stock checkpoint is being rebuilt on another device; waiting for it instead of reading all history.');
    const stock = { ...(AppState.stock || {}) };
    pendingStocks.add(stock);
    return stock;
}

/** Total time this session has waited for another device's checkpoint rebuild. */
const leaseWaitedMs = () => (leaseWaitStartedAt ? Date.now() - leaseWaitStartedAt : 0);

function requestRebuild(after = Promise.resolve()) {
    if (!windowState || !canManageCheckpoint()) return;
    const gen = sessionGen;
    Promise.resolve(after).catch(() => {}).then(() => {
        if (gen !== sessionGen || !windowState) return null;
        return FirebaseService.rebuildStockCheckpoint();
    }).catch(e => console.error('Stock checkpoint rebuild failed:', e));
}


/**
 * One-shot fetch of history older than the loaded window (target 0 = all
 * history, unfiltered so legacy docs without `timestamp` are included).
 * Collections are read one after another (see getWithRetry).
 * @private
 */
async function extendHistory(target) {
    const ws = windowState;
    if (!ws) return;
    const gen = sessionGen;
    const startedAt = Date.now();
    const upper = AppState.historyLoadedFrom;
    const full = target === 0;
    const db = getDb();
    const snaps = [];
    for (const spec of HISTORY_COLLECTIONS) {
        if (!historySpecReadable(spec)) {
            snaps.push(null);
            continue;
        }
        const makeQuery = (attempt) => {
            let q = db.collection(col(spec.key));
            if (!full) q = q.where('timestamp', '>=', target).where('timestamp', '<', upper);
            // A retry needs a distinct watch target; a huge limit keeps the results identical.
            return attempt ? q.limit(RETRY_LIMIT_BASE + attempt) : q;
        };
        snaps.push(await getWithRetry(makeQuery, `${spec.label} history`).catch(err => {
            if (spec.optional) {
                console.error(`${spec.label} history fetch error:`, err);
                return null;
            }
            throw err;
        }));
        if (gen !== sessionGen || windowState !== ws) return;
    }
    let fromServer = true;
    snaps.forEach((snap, i) => {
        if (!snap) return;
        const c = ws.colls[HISTORY_COLLECTIONS[i].key];
        const fresh = !snap.metadata?.fromCache;
        if (!fresh) fromServer = false;
        const live = liveIdSet(c);
        // A fresh full read is authoritative: replace the one-shot set so
        // records deleted or edited elsewhere don't linger.
        if (full && fresh) c.extended = new Map();
        snap.docs.forEach(doc => {
            if (!live.has(doc.id)) c.extended.set(doc.id, mapDoc(doc));
        });
        if (full && fresh) ws.backfills[c.spec.key] = backfillLegacyTimestamps(c.spec, snap.docs);
        publishCollection(c);
    });
    if (fromServer) {
        if (!onDemandAsOf) onDemandAsOf = Date.now();
        if (full) {
            AppState.historyLoadedFrom = 0;
            ws.rawFull = true;
            fullHistoryFetchedAt = startedAt;
        } else if (AppState.historyLoadedFrom !== 0 && target < AppState.historyLoadedFrom) {
            AppState.historyLoadedFrom = target;
        }
    } else {
        console.warn('History fetch was served from the offline cache; loaded window not extended.');
    }
    markDirty(ALL_HISTORY_VIEWS, true);
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('aadhat:historyextended', { detail: { from: AppState.historyLoadedFrom } }));
    }
}

let forcedExtends = 0;

/**
 * Re-reads every on-demand (non-live) record in [historyLoadedFrom, liveFrom)
 * from the server and replaces the in-memory copies, so edits/deletes made on
 * another device since they were loaded show up (#132).
 * @private
 * @returns {Promise<boolean>} false if offline / served from cache
 */
async function refreshOnDemand() {
    const ws = windowState;
    if (!ws) return false;
    const from = AppState.historyLoadedFrom;
    if (from >= ws.liveFrom) return true;
    const gen = sessionGen;
    const startedAt = Date.now();
    const full = from === 0;
    const db = getDb();
    const snaps = [];
    for (const spec of HISTORY_COLLECTIONS) {
        if (!historySpecReadable(spec)) {
            snaps.push(null);
            continue;
        }
        const makeQuery = (attempt) => {
            let q = db.collection(col(spec.key));
            if (!full) q = q.where('timestamp', '>=', from).where('timestamp', '<', ws.liveFrom);
            return attempt ? q.limit(RETRY_LIMIT_BASE + attempt) : q;
        };
        snaps.push(await getWithRetry(makeQuery, `${spec.label} refresh`).catch(err => {
            if (spec.optional) return null;
            throw err;
        }));
        if (gen !== sessionGen || windowState !== ws) return false;
    }
    if (snaps.some(s => s && s.metadata?.fromCache)) return false;
    const inRange = (rec) => full || (typeof rec?.timestamp === 'number' && rec.timestamp >= from && rec.timestamp < ws.liveFrom);
    snaps.forEach((snap, i) => {
        if (!snap) return;
        const c = ws.colls[HISTORY_COLLECTIONS[i].key];
        const live = liveIdSet(c);
        c.extended.forEach((rec, id) => {
            if (inRange(rec)) c.extended.delete(id);
        });
        snap.docs.forEach(doc => {
            if (!live.has(doc.id)) c.extended.set(doc.id, mapDoc(doc));
        });
        publishCollection(c);
    });
    onDemandAsOf = Date.now();
    if (full) fullHistoryFetchedAt = startedAt;
    markDirty(ALL_HISTORY_VIEWS, true);
    return true;
}
/** force: always do a fresh read (checkpoint rebuild must not reuse in-session data). */
function queueExtend(target, raw = false, force = false) {
    const covered = () => !windowState || (!force && (raw
        ? windowState.rawFull
        : AppState.historyLoadedFrom === 0 || (target > 0 && target >= AppState.historyLoadedFrom)));
    if (covered()) return Promise.resolve();
    const key = force ? `force:${++forcedExtends}` : `${raw ? 'raw' : 'w'}:${target}`;
    if (pendingExtends.has(key)) return pendingExtends.get(key);
    const gen = sessionGen;
    const p = extendQueue.then(() => (gen === sessionGen && !covered() ? extendHistory(target) : undefined));
    extendQueue = p.catch(() => {});
    pendingExtends.set(key, p);
    const clear = () => {
        if (pendingExtends.get(key) === p) pendingExtends.delete(key);
    };
    p.then(clear, clear);
    return p;
}

/** Oldest numeric timestamp across history collections (cached per session). */
function oldestTimestamp() {
    if (!oldestTimestampPromise) {
        const gen = sessionGen;
        const db = getDb();
        oldestTimestampPromise = Promise.all(HISTORY_COLLECTIONS.map(spec => (!historySpecReadable(spec) ? Infinity :
            getWithRetry(a => db.collection(col(spec.key)).orderBy('timestamp', 'asc').limit(1 + a), `${spec.label} oldest`)
                .then(s => (s.docs.length ? Number(s.docs[0].data().timestamp) : Infinity))
                .catch(err => {
                    if (spec.optional) return Infinity;
                    throw err;
                }))
        )).then(values => Math.min(...values)).catch(err => {
            if (gen === sessionGen) oldestTimestampPromise = null;
            throw err;
        });
    }
    return oldestTimestampPromise;
}

/** What a stale copy of a bill would differ in (#127): payments, edits, void. */
const billStateKey = (b) => `${paymentSignature(b)}|${editCountOf(b) || 0}|${isActiveBill(b) ? 1 : 0}`;
/** The read before an edit (#127): a failed read falls back to the copy in memory, so it waits less. */
const LATEST_BILL_TIMEOUT_MS = 5000;
/** The whole stored bill, to spot any change (createdAt: an estimate locally). */
const billContentJson = (b) => {
    const rest = { ...b };
    delete rest.createdAt;
    return stableJson(rest);
};
/** Whether a listener that has heard from the server keeps this bill (its copy is current). */
const keptLiveFromServer = (collKey, docId) => {
    const c = windowState?.colls?.[collKey];
    return !!c && [c.live, ...c.dues].some(l => l.server && l.docs.some(r => docIdOf(r) === docId));
};

/**
 * Puts a bill just read from the server in memory when no listener keeps it (an older,
 * on-demand bill), with the stock checkpoint check a listener change gets. @private
 */
function adoptFreshBill(collKey, prev, fresh) {
    const c = windowState?.colls?.[collKey];
    if (!c) return;
    const docId = docIdOf(fresh);
    if (liveIdSet(c).has(docId)) return;
    c.extended.set(docId, fresh);
    if (c.spec.stock && prev) noteObservedChange(c, prev, fresh, 'modified');
    publishCollection(c);
    markDirty(c.spec.views, !!c.spec.stock);
}

/** Drops a bill the server no longer has from memory when no listener keeps it. @private */
function dropGoneBill(collKey, prev, docId) {
    const c = windowState?.colls?.[collKey];
    if (!c || liveIdSet(c).has(docId)) return;
    if (c.spec.stock && prev) noteObservedChange(c, prev, null, 'deleted');
    forgetRecord(collKey, docId);
    markDirty(c.spec.views, !!c.spec.stock);
}

/** Re-reads an old bill that left a dues query (paid off, or deleted). */
function refetchAfterDueRemoval(c, docId, prev) {
    const gen = sessionGen;
    getWithRetry(getDb().collection(col(c.spec.key)).doc(docId), `${c.spec.label} ${docId}`).then(snap => {
        if (gen !== sessionGen || !windowState || liveIdSet(c).has(docId)) return;
        if (snap.exists) {
            const rec = mapDoc(snap);
            // Paid off: keep it only if it is inside the loaded history range.
            if (AppState.historyLoadedFrom === 0 || eventTime(rec) >= AppState.historyLoadedFrom) c.extended.set(docId, rec);
            else c.extended.delete(docId);
            if (c.spec.stock && prev) noteObservedChange(c, prev, rec, 'modified');
        } else {
            c.extended.delete(docId);
            if (c.spec.stock && prev) noteObservedChange(c, prev, null, 'deleted');
        }
        publishCollection(c);
        markDirty(c.spec.views, !!c.spec.stock);
    }).catch(e => console.error(`${c.spec.label}: re-reading ${docId} failed:`, e));
}

/**
 * Due as the screens compute it: BILL-DUE (outstandingDue), the rule of
 * Outstanding, Money and Wholesale › Outstanding.
 */
function hasDue(collKey, rec) {
    return outstandingDue(rec) > 0;
}

/** Whether the dues listener (openDue == true, numeric timestamp) returns this bill. */
const dueVisibleToQueries = (rec) => rec.openDue === true && typeof rec.timestamp === 'number';

/**
 * An older bill (before `from`) with a payment or write-off at/after `from` that the
 * `paidAt >= from` query does not return (paid by an app version without `paidAt`, #163).
 */
function paidUnseenSince(rec, from) {
    if (!Number.isFinite(from) || !Array.isArray(rec.payments) || !(eventTime(rec) < from)) return false;
    if (typeof rec.paidAt === 'number' && rec.paidAt >= from) return false;
    return rec.payments.some(p => entryTime(p) >= from);
}

const legacyScanRef = () => getDb().collection(col(CHECKPOINT_COLLECTION)).doc(LEGACY_SCAN_DOC_ID);

/** Whether a collection may still hold documents without a numeric timestamp (old clients). */
const needsLegacyScan = (key) => {
    const e = legacyScanDoc?.[key];
    if (!e || e.v !== LEGACY_SCAN_VERSION || e.complete !== true) return true;
    // While outdated apps may still be writing, one device re-scans every few hours; its
    // backfill makes those documents visible to every device's window listener.
    return Date.now() - (e.foundAt || 0) < LEGACY_RESCAN_MS && Date.now() - (e.at || 0) > LEGACY_SCAN_INTERVAL_MS;
};

/**
 * Gives documents without a numeric `timestamp` (legacy data, old app versions)
 * the time the app already uses for them, so the window queries see them, and
 * records the outcome in stockCheckpoints/legacyScan. Records at/after the
 * loaded window start are always written (uncapped); older ones are capped per
 * pass and finished on later scans. Any approved user may do this.
 * @param {Object} spec collection spec
 * @param {Array} docs Firestore document snapshots from an unfiltered server read
 * @returns {Promise<{ok: boolean, complete: boolean, writes: number}>} ok = all recent ones written
 * @private
 */
function backfillLegacyTimestamps(spec, docs) {
    // Never rejects (callers keep the promise around).
    return backfillLegacyTimestampsNow(spec, docs, sessionGen).catch(e => {
        console.warn(`${spec.label}: timestamp backfill failed:`, e?.code || e);
        return { ok: false, complete: false, writes: 0 };
    });
}

async function backfillLegacyTimestampsNow(spec, docs, gen) {
    const db = getDb();
    const from = Math.min(windowState?.liveFrom ?? Infinity, defaultWindowStart(Date.now()));
    const critical = [];
    const optional = [];
    let lastLegacyEvent = 0;
    docs.forEach(doc => {
        const data = doc.data();
        if (data.date === undefined) return;
        const update = {};
        let isCritical = false;
        if (typeof data.timestamp !== 'number') {
            const t = eventTime(data);
            if (spec.stock || t !== Number.MAX_SAFE_INTEGER) {
                update.timestamp = t;
                isCritical = t >= from;
                if (t !== Number.MAX_SAFE_INTEGER && t <= Date.now()) lastLegacyEvent = Math.max(lastLegacyEvent, t);
            }
        }
        if (spec.dues) {
            const due = hasDue(spec.key, data);
            if (data.openDue !== due) {
                update.openDue = due;
                if (due) isCritical = true;
            }
        }
        if (!Object.keys(update).length) return;
        if (spec.stock) update.clientVersion = CLIENT_VERSION;
        (isCritical ? critical : optional).push({ id: doc.id, ref: db.collection(col(spec.key)).doc(doc.id), update });
    });
    const written = new Set();
    const commit = async (writes) => {
        for (let i = 0; i < writes.length; i += BACKFILL_BATCH_SIZE) {
            const chunk = writes.slice(i, i + BACKFILL_BATCH_SIZE);
            const batch = db.batch();
            chunk.forEach(w => batch.update(w.ref, w.update));
            try {
                await batch.commit();
                chunk.forEach(w => written.add(w.id));
            } catch (e) {
                // e.g. a security-rules access-call limit on large batches: retry one by one.
                console.warn('Backfill batch failed, retrying documents individually:', e?.code || e);
                for (const w of chunk) {
                    await w.ref.update(w.update).then(() => written.add(w.id), err => console.warn('Backfill write failed:', err?.code || err));
                }
            }
        }
    };
    let ok = true;
    let complete = true;
    try {
        await commit(critical);
    } catch (e) {
        console.error(`${spec.label}: timestamp backfill failed:`, e);
        ok = false;
        complete = false;
    }
    const allowed = optional.slice(0, BACKFILL_MAX_WRITES);
    if (allowed.length < optional.length) complete = false;
    try {
        await commit(allowed);
    } catch (e) {
        console.error(`${spec.label}: timestamp backfill (older records) failed:`, e);
        complete = false;
    }
    if (windowState) (windowState.backfillWritten ||= {})[spec.key] = written;
    if (critical.some(w => !written.has(w.id))) ok = false;
    if (gen !== sessionGen) return { ok, complete, writes: critical.length + allowed.length };
    // The legacyScan doc is read in parallel with startup; merge with what it holds.
    await legacyScanReadPromise;
    if (gen !== sessionGen) return { ok, complete, writes: critical.length + allowed.length };
    const prev = legacyScanDoc?.[spec.key] || {};
    // foundAt ~ when an outdated app last wrote such a document (its event time).
    const entry = { v: LEGACY_SCAN_VERSION, complete, foundAt: Math.max(prev.foundAt || 0, lastLegacyEvent), at: Date.now() };
    legacyScanDoc = { ...(legacyScanDoc || {}), [spec.key]: entry };
    legacyScanRef().set({ [spec.key]: entry }, { merge: true })
        .catch(e => console.warn('Saving legacy scan state failed:', e?.code || e));
    if (critical.length || allowed.length) console.info(`${spec.label}: backfilled timestamp on ${critical.length + allowed.length} documents`);
    return { ok, complete, writes: critical.length + allowed.length };
}

/**
 * Startup safety net while a collection may hold documents without a numeric
 * timestamp: one unfiltered read of it, merging the recent ones (they are
 * invisible to the window query) and backfilling them.
 * @private
 */
async function scanLegacyCollections(ws, gen) {
    for (const spec of HISTORY_COLLECTIONS) {
        if (spec.timestamped || !needsLegacyScan(spec.key) || !historySpecReadable(spec)) continue;
        const db = getDb();
        let snap;
        try {
            snap = await getWithRetry(a => (a ? db.collection(col(spec.key)).limit(RETRY_LIMIT_BASE + a) : db.collection(col(spec.key))), `${spec.label} legacy scan`);
        } catch (e) {
            console.warn(`${spec.label}: legacy timestamp scan failed:`, e?.code || e);
            continue;
        }
        if (gen !== sessionGen || windowState !== ws) return;
        const c = ws.colls[spec.key];
        const live = liveIdSet(c);
        let added = 0;
        snap.docs.forEach(doc => {
            const data = doc.data();
            if (data.date !== undefined && !live.has(doc.id) &&
                ((typeof data.timestamp !== 'number' && eventTime(data) >= ws.liveFrom) ||
                 (spec.dues && hasDue(spec.key, data) && !dueVisibleToQueries(data)))) {
                c.extended.set(doc.id, mapDoc(doc));
                added++;
            }
        });
        publishCollection(c);
        // Runs after the first screen now (#13): refresh what it added.
        if (added) markDirty(spec.views, !!spec.stock);
        if (!snap.metadata?.fromCache) ws.backfills[spec.key] = backfillLegacyTimestamps(spec, snap.docs);
    }
}

/**
 * Schedules scanLegacyCollections() for when the device is idle after the
 * first screen, instead of holding startup on it (#13). Owner/manager devices
 * only, at most once per session.
 * @private
 */
function scheduleLegacyScan(ws, gen) {
    legacyScanJob?.cancel();
    let started = null;
    const run = () => {
        if (!started) {
            cancel();
            started = legacyScanReadPromise
                // settings/app holds the kill switch; skipped under the read guards (#159), the next app open tries again
                .then(() => FirebaseService.loadAppSettings().catch(() => null))
                .then(() => (gen === sessionGen && windowState === ws && backgroundReadsAllowed() ? scanLegacyCollections(ws, gen) : undefined))
                .catch(e => console.warn('Legacy timestamp scan failed:', e?.code || e))
                .then(() => markStartup('legacy-scan'));
        }
        return started;
    };
    const cancel = whenIdle(run, { minDelayMs: LEGACY_SCAN_DELAY_MS });
    legacyScanJob = { run, cancel };
}

/**
 * Ids of bills that are due but invisible to the dues queries (legacy derived
 * dues); stored in the checkpoint as `pinned`
 * and listened to by id.
 * @private
 */
/**
 * Bills the window and dues queries can't see but a phone needs, by document id:
 * a due only derivable from totals (no `openDue`), or — older bills paid or
 * written off at/after `asOf` by app versions that did not stamp `paidAt` (#163).
 * @param {number} asOf the checkpoint's start (the window starts no later)
 */
function computePinned(asOf) {
    const ws = windowState;
    const pinned = {};
    HISTORY_COLLECTIONS.forEach(spec => {
        if (!spec.dues) return;
        pinned[spec.key] = [];
        const c = ws.colls[spec.key];
        const all = new Map();
        c.extended.forEach((rec, id) => all.set(id, rec));
        [c.live, ...c.dues].forEach(l => l.docs.forEach(rec => all.set(docIdOf(rec), rec)));
        const written = ws.backfillWritten?.[spec.key] || new Set();
        const paid = [];
        all.forEach((rec, docId) => {
            if (rec.date === undefined) return;
            if (hasDue(spec.key, rec) && !dueVisibleToQueries(rec) && !written.has(docId)) {
                pinned[spec.key].push(docId);
            } else if (!hasDue(spec.key, rec) && paidUnseenSince(rec, asOf)) {
                paid.push(docId);
            }
        });
        // Open dues first: over the cap, a settled bill's payment is dropped before a due.
        pinned[spec.key].push(...paid);
        if (pinned[spec.key].length > PINNED_MAX) {
            console.warn(`${pinned[spec.key].length} ${spec.key} bills need pinning (due only derivable from totals, or paid without paidAt); listening to the first ${PINNED_MAX}.`);
            pinned[spec.key] = pinned[spec.key].slice(0, PINNED_MAX);
        }
    });
    return pinned;
}

const RESOLUTION_TAG = (r) => `${typeof r[0]}\u0000${r[0]}\u0000${r[1]}`;

function checkpointPayload({ asOf, state, resolutions, items, staleCount, backfill, extra = {} }) {
    return {
        formatVersion: STOCK_REPLAY_FORMAT,
        asOf,
        state: serializeState(state),
        resolutions: resolutions.map(r => ({ i: r[0], n: r[1], k: r[2] })),
        itemsSignature: itemsSignature(items),
        stale: false,
        staleCount,
        builtAt: Date.now(),
        builtBy: AppState.currentUser?.uid || 'unknown',
        rebuildingUntil: 0,
        rebuildingBy: null,
        backfill: backfill || null,
        ...extra
    };
}

const CHECKPOINT_MAX_BYTES = 900 * 1024;

/** Whether this session already tried a rebuild without being asked to by an invalidation. */
let rebuildAttempted = false;

/**
 * Listens to the checkpoint doc. Resolves after the first server snapshot (or
 * the cache when offline / the server is slow). Later snapshots adopt fresh
 * checkpoints built or rolled forward by other devices; a stale mark leaves
 * the checkpoint in use until a rebuilt one arrives.
 * @private
 */
function listenCheckpoint(gen) {
    return new Promise(resolve => {
        let ready = false;
        let timer = null;
        const done = () => {
            if (ready) return;
            ready = true;
            clearTimeout(timer);
            resolve();
        };
        pendingFirstSnapshots.push({ resolve: done, reject: done });
        let unsubscribe = () => {};
        try {
            unsubscribe = checkpointRef().onSnapshot({ includeMetadataChanges: true }, snap => {
                if (gen !== sessionGen) return;
                checkpointDoc = snap.exists ? snap.data() : null;
                if (ready) {
                    if (checkpointDoc && !checkpointDoc.stale && adoptCheckpoint(checkpointDoc)) {
                        markDirty(['stockView'], true);
                    } else if (checkpointDoc?.stale && activeCheckpoint &&
                        (checkpointDoc.staleCount || 0) > activeCheckpoint.staleCount) {
                        // Another device changed history before the checkpoint: stop using it
                        // (full replay) until a rebuilt one arrives.
                        activeCheckpoint = null;
                        AppState.dataVersion = ++dataVersion;
                        markDirty(['stockView'], true);
                        requestRebuild();
                    } else if (leaseWaitTimer && !((checkpointDoc?.rebuildingUntil || 0) > Date.now())) {
                        // The device we were waiting for gave up its lease: decide again now.
                        clearTimeout(leaseWaitTimer);
                        leaseWaitTimer = null;
                        AppState.dataVersion = ++dataVersion;
                        markDirty(['stockView'], true);
                    }
                    return;
                }
                if (!snap.metadata.fromCache || navigator.onLine === false) {
                    done();
                } else if (!timer) {
                    // A cached checkpoint is safe to start from: later snapshots
                    // adopt a newer one or drop it when marked stale (above).
                    timer = setTimeout(done, snap.exists ? FIRST_SNAPSHOT_CACHED_WAIT_MS : FIRST_SNAPSHOT_SERVER_WAIT_MS);
                }
            }, error => {
                console.error('Stock checkpoint listener error:', error);
                if (checkpointDoc === undefined) checkpointDoc = null;
                done();
            });
        } catch (e) {
            console.error('Stock checkpoint listener error:', e);
            checkpointDoc = null;
            done();
        }
        unsubscribeFunctions.push(unsubscribe);
    });
}

/**
 * Moves the checkpoint to `newAsOf` using the in-memory window data
 * (events with asOf <= t < newAsOf); no extra reads. The transaction only
 * writes if nobody changed/invalidated the checkpoint meanwhile.
 * @private
 */
async function rollForwardCheckpoint(cp, newAsOf) {
    const ws = windowState;
    const gen = sessionGen;
    if (!canManageCheckpoint()) return 'not-allowed';
    if (!ws || ws.liveFrom > cp.asOf) return 'uncovered';
    if (HISTORY_COLLECTIONS.some(s => s.stock && !ws.colls[s.key].live.server)) return 'waiting';
    const items = AppState.items || [];
    // Any stock change seen after this point (e.g. another device editing a record in
    // [asOf, newAsOf)) may be missing from the state below: then the payload is discarded.
    const changeGen = stockChangeGen;
    const { state, resolutions } = buildCheckpointState(currentSources(), newAsOf, items, { state: cp.state, from: cp.asOf });
    const allResolutions = new Map();
    [...cp.resolutions, ...resolutions].forEach(r => allResolutions.set(RESOLUTION_TAG(r), r));
    const ref = checkpointRef();
    let payload = null;
    let ok;
    try {
        ok = await getDb().runTransaction(async tx => {
            const snap = await tx.get(ref);
            const d = snap.exists ? snap.data() : null;
            if (stockChangeGen !== changeGen) return 'changed';
            if (!d || d.formatVersion !== STOCK_REPLAY_FORMAT || d.stale || d.asOf !== cp.asOf ||
                (d.staleCount || 0) !== cp.staleCount || (d.builtAt || 0) !== cp.builtAt ||
                (d.rebuildingUntil || 0) > Date.now()) {
                return 'conflict';
            }
            payload = checkpointPayload({
                asOf: newAsOf,
                state,
                resolutions: [...allResolutions.values()],
                items,
                staleCount: cp.staleCount,
                backfill: d.backfill || null,
                extra: { rolledForwardFrom: cp.asOf, pinned: d.pinned || null, fullBuiltAt: d.fullBuiltAt || d.builtAt || 0 }
            });
            if (JSON.stringify(payload).length > CHECKPOINT_MAX_BYTES) return 'too-large';
            tx.set(ref, { ...payload, ...voidAwareStamp() });
            return 'rolled';
        });
    } catch (e) {
        if (isPermissionDenied(e)) return 'not-allowed';
        throw e;
    }
    if (ok !== 'rolled') return ok;
    if (stockChangeGen !== changeGen) {
        // A change landed between the check and the commit: the stored state may miss it.
        invalidateCheckpoint('roll-forward raced with a stock change', true);
        return 'changed';
    }
    if (gen === sessionGen) adoptCheckpoint(payload);
    console.info(`Stock checkpoint rolled forward to ${new Date(newAsOf).toISOString()}`);
    return 'rolled';
}

/** Lease release after a rebuild that did not build: result → Promise<boolean> (TIP StockCheckpoint). */
const leaseReleases = new WeakMap();

/** See FirebaseService.rebuildStockCheckpoint(). @private */
async function rebuildCheckpointNow(gen) {
    if (!canManageCheckpoint()) return { status: 'not-allowed' };
    const db = getDb();
    const ref = checkpointRef();
    const token = `${AppState.currentUser?.uid || 'anon'}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    let baseStaleCount = 0;
    let lease;
    try {
        lease = await db.runTransaction(async tx => {
            const snap = await tx.get(ref);
            const d = snap.exists ? snap.data() : null;
            const parsed = parseCheckpoint(d);
            const aged = Date.now() - ((d && (d.fullBuiltAt || d.builtAt)) || 0) > FORCED_REBUILD_AGE_MS;
            if (parsed && checkpointMatchesItems(parsed) && !aged) return 'fresh';
            // A lease left by this same user (app reloaded/closed mid-rebuild) is taken over.
            const ownLease = !!AppState.currentUser?.uid && leaseOwnerUid(d?.rebuildingBy) === AppState.currentUser.uid;
            if (d && (d.rebuildingUntil || 0) > Date.now() && !ownLease) return 'leased';
            baseStaleCount = d?.staleCount || 0;
            tx.set(ref, { rebuildingUntil: Date.now() + REBUILD_LEASE_MS, rebuildingBy: token, ...voidAwareStamp() }, { merge: true });
            return 'acquired';
        });
    } catch (e) {
        if (isPermissionDenied(e)) {
            console.warn('Stock checkpoint: not allowed to rebuild (role); using full history.');
            return { status: 'not-allowed' };
        }
        throw e;
    }
    if (lease !== 'acquired') return { status: lease };
    let result = { status: 'failed' };
    try {
        // Always a fresh full server read: in-session copies may be stale.
        await queueExtend(0, true, true);
        const ws = windowState;
        if (gen !== sessionGen || !ws) return (result = { status: 'cancelled' });
        if (!ws.rawFull || HISTORY_COLLECTIONS.some(s => s.stock && !ws.colls[s.key].live.server)) {
            return (result = { status: 'offline' });
        }
        const asOf = Math.max(defaultWindowStart(Date.now()), ws.liveFrom);
        const backfills = await Promise.all(HISTORY_COLLECTIONS.map(spec => ws.backfills[spec.key] || { ok: true, complete: true, writes: 0 }));
        if (gen !== sessionGen) return (result = { status: 'cancelled' });
        if (HISTORY_COLLECTIONS.some((spec, i) => spec.stock && !backfills[i].ok)) return (result = { status: 'backfill-failed' });
        const backfill = {
            complete: backfills.every(b => b.complete),
            writes: backfills.reduce((n, b) => n + b.writes, 0),
            at: Date.now()
        };
        const items = AppState.items || [];
        const { state, resolutions } = buildCheckpointState(currentSources(), asOf, items);
        const now = Date.now();
        const payload = checkpointPayload({
            asOf,
            state,
            resolutions,
            items,
            staleCount: baseStaleCount,
            backfill,
            extra: { pinned: computePinned(asOf), fullBuiltAt: now }
        });
        if (JSON.stringify(payload).length > CHECKPOINT_MAX_BYTES) {
            console.error('Stock checkpoint too large to store; stock keeps using full history.');
            return (result = { status: 'too-large' });
        }
        const committed = await db.runTransaction(async tx => {
            const snap = await tx.get(ref);
            const d = snap.exists ? snap.data() : null;
            if (!d || d.rebuildingBy !== token || (d.staleCount || 0) !== baseStaleCount) return false;
            tx.set(ref, { ...payload, ...voidAwareStamp() });
            return true;
        });
        if (!committed) return (result = { status: 'conflict' });
        if (gen === sessionGen && adoptCheckpoint(payload)) markDirty(['stockView'], true);
        console.info(`Stock checkpoint rebuilt as of ${new Date(asOf).toISOString()} (${backfill.writes} backfill writes)`);
        return (result = { status: 'built', asOf, backfill });
    } catch (e) {
        if (isPermissionDenied(e)) {
            console.warn('Stock checkpoint: not allowed to rebuild (role); using full history.');
            return (result = { status: 'not-allowed' });
        }
        throw e;
    } finally {
        if (result.status !== 'built') {
            leaseReleases.set(result, db.runTransaction(async tx => {
                const snap = await tx.get(ref);
                if (snap.exists && snap.data().rebuildingBy === token) {
                    tx.update(ref, { rebuildingUntil: 0, rebuildingBy: null, ...voidAwareStamp() });
                }
            }).then(() => true, () => false));
        }
    }
}


/**
 * Firebase Service object containing all database operations.
 * Provides methods for CRUD operations on all collections.
 * @namespace FirebaseService
 */
const FirebaseService = {
    /**
     * Gets the Firestore database reference.
     * @type {firebase.firestore.Firestore}
     */
    get db() {
        return getDb();
    },

    /**
     * For the sync pill (ui/sync-status.js): a function that resolves once the SDK
     * has sent every queued write, or null when Firestore or that call isn't there.
     * @returns {?function(): Promise<void>}
     */
    pendingWritesWaiter() {
        const db = getDb();
        return typeof db.waitForPendingWrites === 'function' ? () => db.waitForPendingWrites() : null;
    },

    /**
     * Cleans up all active real-time listeners.
     * Should be called when user logs out or app is destroyed.
     * @returns {void}
     */
    cleanup() {
        unsubscribeFunctions.forEach(unsubscribe => {
            if (typeof unsubscribe === 'function') {
                unsubscribe();
            }
        });
        unsubscribeFunctions.length = 0;
        SyncStatus.clearListeners();
        pendingFirstSnapshots.forEach(settle => settle.resolve());
        pendingFirstSnapshots.length = 0;
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        pendingViews.clear();
        stockDirty = false;
        stockCache = {};
        AppState.dataVersion = ++dataVersion;
        sessionGen++;
        windowState = null;
        checkpointDoc = undefined;
        activeCheckpoint = null;
        checkpointItemsCheck = { items: null, checkpoint: null, ok: false };
        rebuildPromise = null;
        forgetAppSettings();
        rebuildRequestedAgain = false;
        rebuildAttempted = false;
        clearTimeout(leaseWaitTimer);
        leaseWaitTimer = null;
        leaseWaitStartedAt = 0;
        oldestTimestampPromise = null;
        extendQueue = Promise.resolve();
        pendingExtends.clear();
        invalidationTags.clear();
        legacyScanJob?.cancel();
        legacyScanJob = null;
        lastStockApprox = null;
        AppState.stockApprox = null;
        approxCheckpointCache = { doc: undefined, cp: null };
        ownStaleWrite = false;
        AppState.historyLoadedFrom = 0;
    },

    ...itemMethods,

    ...billStatsMethods,

    // ---- Month snapshots (redesign §7.6): monthStats/{YYYY-MM}, owner/manager only (rules) ----

    /**
     * Local time this device started its last fresh server read of all history (0 = none this
     * session); month snapshots marked stale before it can be rebuilt from the loaded bills.
     * @returns {number}
     */
    getFullHistoryFetchedAt() {
        return fullHistoryFetchedAt;
    },

    /** Resolves with the months of the last stale mark once it is issued (tests). */
    monthMarksIssued() {
        return lastMonthMark;
    },

    ...collectionAdminMethods,

    /**
     * See settleWrite(): resolves when a write is acknowledged, or stored on this
     * device (offline at once, online after a short timeout), so bill saves don't
     * block on the network; stored=false if that was not confirmed in time.
     * @param {Promise<void>} writePromise
     * @param {string} [label]
     * @returns {Promise<{pending: boolean, stored: boolean}>}
     */
    settleWrite(writePromise, label) {
        return settleWrite(writePromise, label);
    },

    /**
     * Saves a purchase to Firestore. Creates new if no ID, updates if ID exists.
     * Automatically adds userId and userName from AppState.
     * @async
     * @param {Object} purchase - The purchase to save
     * @param {string} [purchase.id] - Purchase ID (if updating existing)
     * @param {string} purchase.partyName - Party/customer name
     * @param {string} purchase.date - Purchase date
     * @param {Array} purchase.items - Array of purchase items
     * @param {number} purchase.total - Total purchase amount
     * @returns {Promise<Object>} The saved purchase with ID
     */
    async savePurchase(purchase, options) {
        return saveBill('purchases', purchase, 'savePurchase', options);
    },

    /**
     * Updates an existing purchase in Firestore.
     * @async
     * @param {Object} purchase - The purchase to update
     * @param {string} purchase.id - Purchase ID (required)
     * @returns {Promise<Object>} The updated purchase
     * @throws {Error} If purchase.id is not provided
     */
    async updatePurchase(purchase, options) {
        return updateBillChecked('purchases', purchase, options);
    },

    /**
     * Deletes a purchase from Firestore.
     * @async
     * @param {string} purchaseId - The ID of the purchase to delete
     * @returns {Promise<void>}
     */
    async deletePurchase(purchaseId) {
        await deleteBill('purchases', purchaseId);
    },

    /**
     * Saves a wholesale sale to Firestore. Creates new if no ID, updates if ID exists.
     * @async
     * @param {Object} sale - The sale to save
     * @param {string} [sale.id] - Sale ID (if updating existing)
     * @param {string} sale.partyName - Party/customer name
     * @param {string} sale.date - Sale date
     * @param {Array} sale.items - Array of sale items
     * @param {number} sale.total - Total sale amount
     * @returns {Promise<Object>} The saved sale with ID
     */
    async saveWholesaleSale(sale, options) {
        return saveBill('wholesaleSales', sale, 'saveWholesaleSale', options);
    },

    /**
     * Updates an existing wholesale sale in Firestore.
     * @async
     * @param {Object} sale - The sale to update
     * @param {string} sale.id - Sale ID (required)
     * @returns {Promise<Object>} The updated sale
     * @throws {Error} If sale.id is not provided
     */
    async updateWholesaleSale(sale, options) {
        return updateBillChecked('wholesaleSales', sale, options);
    },

    /**
     * Saves a retail sale to Firestore. Uses separate retailSales collection.
     * @async
     * @param {Object} sale - The retail sale to save
     * @param {string} [sale.id] - Sale ID (if updating existing)
     * @param {string} sale.customerName - Customer name
     * @param {string} sale.date - Sale date
     * @param {Array} sale.items - Array of sale items
     * @param {number} sale.total - Total sale amount
     * @returns {Promise<Object>} The saved sale with ID
     */
    async saveRetailSale(sale, options) {
        return saveBill('retailSales', sale, 'saveRetailSale', options);
    },

    /**
     * Updates an existing retail sale in Firestore.
     * @async
     * @param {Object} sale - The sale to update
     * @param {string} sale.id - Sale ID (required)
     * @returns {Promise<Object>} The updated sale
     * @throws {Error} If sale.id is not provided
     */
    async updateRetailSale(sale, options) {
        return updateBillChecked('retailSales', sale, options);
    },

    /**
     * Deletes a retail sale from Firestore.
     * @async
     * @param {string} saleId - The ID of the sale to delete
     * @returns {Promise<void>}
     */
    async deleteRetailSale(saleId) {
        await deleteBill('retailSales', saleId);
    },

    /**
     * Deletes a wholesale sale from Firestore.
     * @async
     * @param {string} saleId - The ID of the sale to delete
     * @returns {Promise<void>}
     */
    async deleteWholesaleSale(saleId) {
        await deleteBill('wholesaleSales', saleId);
    },

    /**
     * True when a retried new-bill save found a payment recorded on the server
     * since the first attempt and kept the server's money fields (#70).
     * @param {Object} record - The bill passed to savePurchase/saveRetailSale/saveWholesaleSale
     * @returns {boolean}
     */
    keptServerPayment(record) {
        return !!record && keptServerPaymentBills.has(record);
    },

    /**
     * True when a new bill was stored on this phone while offline and has not
     * reached the server yet (#153: "Saved on this phone, will sync").
     * @param {Object} record - The bill passed to savePurchase/saveRetailSale/saveWholesaleSale
     * @returns {boolean}
     */
    savedOnPhoneOnly(record) {
        return !!record && savedOnPhoneBills.has(record);
    },

    /**
     * True when a new bill's write was neither acknowledged nor confirmed stored on
     * this phone in time (#153): it may still be saved, so it must not be reported
     * as saved or cleared from the form.
     * @param {Object} record - The bill passed to savePurchase/saveRetailSale/saveWholesaleSale
     * @returns {boolean}
     */
    saveUnconfirmed(record) {
        return !!record && unconfirmedBills.has(record);
    },

    /**
     * Payment-state signature of a bill as it was loaded. Bill editors capture it when they
     * open so a later save can detect payments recorded on another device in the meantime.
     * @param {Object} record
     * @returns {?string}
     */
    loadedPaymentSignature(record) {
        return record?.[LOADED_PAYMENT] ?? paymentSignature(record);
    },

    /**
     * Sets the payment-state baseline the next update of `record` is checked against.
     * @param {Object} record
     * @param {?string} signature - Value from loadedPaymentSignature()
     * @returns {Object} record
     */
    withLoadedPaymentSignature(record, signature) {
        if (record && signature !== undefined) record[LOADED_PAYMENT] = signature;
        return record;
    },

    /**
     * Deletes a purchase / retail sale / wholesale sale shown in History, using its real
     * Firestore document id (legacy docs may have an `id` field that differs from it).
     * @param {'purchases'|'retailSales'|'wholesaleSales'} collKey
     * @param {Object} bill - Record from the AppState history array
     */
    async deleteHistoryBill(collKey, bill) {
        const docId = docIdOf(bill);
        if (collKey === 'purchases') return this.deletePurchase(docId);
        if (collKey === 'retailSales') return this.deleteRetailSale(docId);
        if (collKey === 'wholesaleSales') return this.deleteWholesaleSale(docId);
        throw new Error(`Unknown history collection: ${collKey}`);
    },

    /**
     * Voids a bill shown in History (#75): kept, marked who / when / why, left out of
     * every figure. Throws with `code` 'reason-required' | 'not-found' | 'already-voided' |
     * 'has-payments' (payments recorded after it was saved), or the Firestore error.
     * @param {'purchases'|'retailSales'|'wholesaleSales'} collKey
     * @param {Object} bill
     * @param {string} reason 3–300 characters
     * @returns {Promise<Object>} the voided bill
     */
    async voidBill(collKey, bill, reason) {
        if (!HISTORY_SPEC[collKey]?.dues) throw new Error(`Unknown bill collection: ${collKey}`);
        return voidBillDoc(collKey, bill, reason);
    },

    /**
     * Owner only: deletes a voided bill for good, with its edit records.
     * @param {'purchases'|'retailSales'|'wholesaleSales'} collKey
     * @param {Object} bill a voided bill
     */
    async deleteVoidedBill(collKey, bill) {
        if (!HISTORY_SPEC[collKey]?.dues) throw new Error(`Unknown bill collection: ${collKey}`);
        return deleteVoidedBillDoc(collKey, bill);
    },

    /**
     * The server's copy of a bill before it is edited (#127): one read, never the cache.
     * An older bill isn't listened to, so its copy here may be stale; a payment, edit or
     * void made on another phone shows as `changed`, and the server copy replaces the
     * one in memory. Rejects when the server can't be reached.
     * @param {'purchases'|'retailSales'|'wholesaleSales'} collKey
     * @param {Object} bill - the copy in memory
     * @returns {Promise<{bill: ?Object, changed: boolean}>} bill null when it no longer exists
     */
    async latestBill(collKey, bill) {
        if (!HISTORY_SPEC[collKey]?.dues) throw new Error(`Unknown bill collection: ${collKey}`);
        const docId = String(docIdOf(bill));
        // A listener with server data already has the latest copy: no read
        if (keptLiveFromServer(collKey, docId)) return { bill, changed: false };
        const ref = getDb().collection(col(collKey)).doc(docId);
        const snap = await getWithRetry(() => ({ get: () => ref.get({ source: 'server' }) }), `${collKey} latest`, { attempts: 1, timeoutMs: LATEST_BILL_TIMEOUT_MS });
        const prev = findRecord(collKey, docId) || bill;
        if (!snap.exists) {
            dropGoneBill(collKey, prev, docId);
            return { bill: null, changed: true };
        }
        const fresh = mapDoc(snap);
        if (billContentJson(fresh) === billContentJson(bill)) return { bill, changed: false };
        adoptFreshBill(collKey, prev, fresh);
        // Notes and other unrecorded fields: edit the latest copy without asking
        return { bill: fresh, changed: billStateKey(fresh) !== billStateKey(bill) };
    },

    /**
     * Voided bills loaded for a bill collection (History's "Show voided bills"),
     * newest first. They are never in AppState's bill lists.
     * @param {'purchases'|'retailSales'|'wholesaleSales'} collKey
     * @returns {Array<Object>}
     */
    voidedBills(collKey) {
        return voidedOf(collKey).slice();
    },

    /**
     * The edit records of one bill (#121), oldest first: read only when the user
     * opens them in the bill details (one read per edit).
     * @param {'purchases'|'retailSales'|'wholesaleSales'} collKey
     * @param {Object} bill
     * @returns {Promise<Array<Object>>}
     */
    async loadBillEdits(collKey, bill) {
        if (!HISTORY_SPEC[collKey]?.dues) throw new Error(`Unknown bill collection: ${collKey}`);
        const ref = billEditsRef(getDb().collection(col(collKey)).doc(String(docIdOf(bill))));
        const snap = await getWithRetry(ref.orderBy('n'), 'Bill edits');
        return snap.docs.map(d => d.data({ serverTimestamps: 'estimate' }));
    },

    /**
     * Saves an expense to Firestore.
     * @async
     * @param {Object} expense - The expense to save
     * @param {string} expense.description - Expense description
     * @param {number} expense.amount - Expense amount
     * @param {string} expense.date - Expense date
     * @param {string} [expense.category] - Expense category
     * @returns {Promise<Object>} The saved expense with ID
     */
    async saveExpense(expense) {
        const { record, committed } = this.startSaveExpense(expense);
        await committed;
        return record;
    },

    /**
     * Starts saving a new expense and shows it in AppState.expensesHistory
     * straight away (#89), without waiting for the server (works offline).
     * The listener later replaces the local copy (same doc id, no duplicate);
     * if the write fails the local copy is removed again. `stored` resolves true
     * once the write is on this device, false when this device refused it (e.g.
     * storage full, #153), null if still unconfirmed after EXPENSE_STORE_WAIT_MS.
     * @param {Object} expense
     * @param {{id?: string}} [options] - id: save again over this not-yet-confirmed expense
     * @returns {{record: Object, committed: Promise<void>, stored: Promise<boolean|null>}}
     */
    startSaveExpense(expense, { id } = {}) {
        if (!expense.userId && AppState.currentUser) {
            expense.userId = AppState.currentUser.uid;
        }
        if (!expense.userName && AppState.userName) {
            expense.userName = AppState.userName;
        }

        ensureTimestamp(expense, true);
        // Personal expenses go to their own collection, with their key in the day doc (#98)
        const collKey = expenseCollectionFor(expense);
        if (collKey !== 'expenses' && !expense.day) expense.day = personalDayKey(expense.date);
        const { record, committed, sent } = startCreate(collKey, expense, id,
            collKey === 'expenses' ? null : (batch, docId) => addPersonalDayWrites(batch, docId, null, expense));
        noteMonthWrite(collKey, null, record);
        return { record, committed, stored: whenStoredLocally(sent, EXPENSE_STORE_WAIT_MS) };
    },

    /**
     * Deletes an expense from Firestore.
     * Handles both old numeric IDs and new Firebase document IDs.
     * Also updates local AppState.expensesHistory.
     * @async
     * @param {string|number} expenseId - The ID of the expense to delete
     * @returns {Promise<void>}
     */
    async deleteExpense(expenseId) {
        // The Expenses page takes the row off the screen before this runs, so look in the collection state
        const where = locateExpense(expenseId);
        const collKey = where.collKey;
        const previous = where.rec || findRecord(collKey, expenseId);
        if (collKey === 'personalExpenses') {
            const batch = getDb().batch();
            batch.delete(getDb().collection(col(collKey)).doc(where.docId));
            addPersonalDayWrites(batch, where.docId, previous, null);
            await batch.commit();
        } else if (typeof expenseId === 'number' || !isNaN(Number(expenseId))) {
            // Handle both old numeric IDs and new Firebase document IDs
            // Old expense with numeric ID - query by id field
            const snapshot = await getDb().collection(col('expenses')).where('id', '==', Number(expenseId)).get();
            const deletePromises = snapshot.docs.map(doc => doc.ref.delete());
            await Promise.all(deletePromises);
        } else {
            // New expense with Firebase document ID
            await getDb().collection(col('expenses')).doc(expenseId).delete();
        }
        noteMonthWrite(collKey, previous, null);
        
        forgetRecord(collKey, collKey === 'personalExpenses' ? where.docId : expenseId);
        // Update local state
        const index = AppState.expensesHistory.findIndex(e => e.id == expenseId);
        if (index !== -1) {
            AppState.expensesHistory.splice(index, 1);
        }
    },

    /**
     * Updates fields of an existing expense in place (numeric ids are legacy
     * `id` fields, others document ids) and keeps the in-memory copy in step.
     * @param {string|number} expenseId
     * @param {Object} fields
     * @returns {Promise<void>}
     */
    async updateExpense(expenseId, fields) {
        const where = locateExpense(expenseId);
        const collKey = where.collKey;
        if (collKey === 'personalExpenses') {
            const ref = getDb().collection(col(collKey)).doc(where.docId);
            const prev = where.rec;
            const batch = getDb().batch();
            batch.update(ref, fields);
            if (prev) addPersonalDayWrites(batch, where.docId, prev, { ...prev, ...fields });
            await batch.commit();
            if (prev) noteLocalRecordWrite(collKey, ref.id, { ...prev, ...fields });
            noteMonthWrite(collKey, prev, prev ? { ...prev, ...fields } : fields);
            return;
        }
        const coll = getDb().collection(col('expenses'));
        let refs;
        if (typeof expenseId === 'number' || !isNaN(Number(expenseId))) {
            const snapshot = await getWithRetry(coll.where('id', '==', Number(expenseId)), 'Expense lookup');
            refs = snapshot.docs.map(doc => doc.ref);
        } else {
            refs = [coll.doc(String(expenseId))];
        }
        if (refs.length === 0) throw new Error('Expense not found');
        await Promise.all(refs.map(ref => ref.update(fields)));
        refs.forEach(ref => {
            const prev = findRecord('expenses', ref.id) || findRecord('expenses', expenseId);
            if (prev) noteLocalRecordWrite('expenses', ref.id, { ...prev, ...fields });
            noteMonthWrite('expenses', prev, prev ? { ...prev, ...fields } : fields);
        });
    },

    /**
     * Voids an expense (#99): never edited or deleted in place. One transaction
     * sets voided, voidedAt (server time), voidedBy, voidedByName and voidReason;
     * a personal expense also leaves its day total (personalExpenseDays) in the
     * same write. From then on it counts in no figure (money.isActiveExpense):
     * it leaves AppState.expensesHistory (voidedExpenses() lists it). Needs a
     * connection. Throws with `code` 'reason-required' | 'not-found' | 'already-voided'.
     * @param {string|number} expenseId
     * @param {string} reason
     * @returns {Promise<Object>} the voided expense
     */
    async voidExpense(expenseId, reason) {
        const why = cleanReason(reason);
        if (!why) throw Object.assign(new Error('A reason is needed to void an expense'), { code: 'reason-required' });
        const where = locateExpense(expenseId);
        const collKey = where.collKey;
        const previous = where.rec || findRecord(collKey, expenseId);
        let docId = previous ? docIdOf(previous) : where.docId;
        if (!previous && collKey === 'expenses' && /^\d+$/.test(String(expenseId))) {
            // Old-app rows carry a numeric `id` field, not their document id
            const snap = await getWithRetry(getDb().collection(col('expenses')).where('id', '==', Number(expenseId)), 'Expense lookup');
            if (snap.empty) throw Object.assign(new Error('Expense not found'), { code: 'not-found' });
            docId = snap.docs[0].id;
        }
        const ref = getDb().collection(col(collKey)).doc(String(docId));
        const fields = {
            voided: true,
            voidedAt: serverCreatedAt(),
            voidedBy: AppState.currentUser?.uid || null,
            voidedByName: String(AppState.userName || '').slice(0, 200),
            voidReason: why
        };
        let stored = null;
        await getDb().runTransaction(async tx => {
            const snap = await tx.get(ref);
            if (!snap.exists) throw Object.assign(new Error('Expense not found'), { code: 'not-found' });
            stored = snap.data();
            if (!isActiveExpense(stored)) throw Object.assign(new Error('This expense is already voided'), { code: 'already-voided' });
            tx.update(ref, fields);
            const day = collKey === 'personalExpenses' ? personalDayOf(stored) : null;
            if (day) tx.set(...personalDayWrite(day, String(docId), null));
        });
        const voided = { ...stored, ...fields, id: previous?.id ?? stored.id ?? docId, voidedAt: Date.now() };
        docIds.set(voided, String(docId));
        noteMonthWrite(collKey, previous || stored, null);
        if (collKey === 'personalExpenses') personalDayCache.delete(personalDayOf(stored));
        replaceLiveRecord(collKey, docId, voided);
        noteLocalRecordWrite(collKey, docId, voided);
        return voided;
    },

    /**
     * Voided expenses loaded (business and personal), newest first; kept out of
     * AppState.expensesHistory so no figure counts them (#99).
     * @returns {Array<Object>}
     */
    voidedExpenses() {
        return [...voidedOf('expenses'), ...voidedOf('personalExpenses')].sort(byDateDesc);
    },

    /**
     * A day's personal expense total and count (personalExpenseDays, #98), for
     * phones whose role can't read the expenses themselves. One read, reused for
     * `maxAgeMs`; personalExpenseDay() returns the last value read, for sync readers.
     * @param {string} day YYYY-MM-DD
     * @param {{maxAgeMs?: number}} [opts]
     * @returns {Promise<?{total: number, count: number}>} null when unknown (missing or unreadable)
     */
    async loadPersonalExpenseDay(day, { maxAgeMs = 60000 } = {}) {
        const cached = personalDayCache.get(day);
        if (cached && Date.now() - cached.at < maxAgeMs) return cached.value;
        let value = null;
        try {
            const snap = await getWithRetry(getDb().collection(col(PERSONAL_DAYS_COLLECTION)).doc(day), 'Personal expense day', { attempts: 2, timeoutMs: 8000 });
            value = dayDocTotals(snap.exists ? snap.data() : null);
        } catch (e) {
            console.warn('Personal expense day total not loaded:', e?.code || e);
            return cached ? cached.value : null;
        }
        personalDayCache.set(day, { value, at: Date.now() });
        return value;
    },

    /**
     * The last personal expense total read for a day (loadPersonalExpenseDay), or null.
     * @param {string} day YYYY-MM-DD
     * @returns {?{total: number, count: number}}
     */
    personalExpenseDay(day) {
        return personalDayCache.get(day)?.value ?? null;
    },

    /**
     * Whether this phone has the personal expense rows: their listener started
     * and delivered its first snapshot (not just what Roles & access says now).
     * When false, the cash count and Today use the day totals and the shared
     * month snapshots are not written (#98).
     * @returns {boolean}
     */
    personalRowsLoaded() {
        const live = windowState?.colls?.personalExpenses?.live;
        return !!(live && live.delivered && !live.failed);
    },

    /**
     * Owner/manager: makes personalExpenseDays of these days match the loaded
     * personal rows (one read per day, one write per wrong key; none when right).
     * @param {string[]} days YYYY-MM-DD, inside the loaded history
     * @returns {Promise<number>} keys written
     */
    async rebuildPersonalExpenseDays(days) {
        if (!canManageCheckpoint() || !this.personalRowsLoaded()) return 0;
        const rows = (windowState.colls.personalExpenses.published || []).map(r => ({ ...r, id: docIdOf(r) }));
        const want = personalDaysFromRows(rows);
        const wantOnline = personalOnlineFromRows(rows);
        let written = 0;
        for (const day of days) {
            const snap = await getWithRetry(getDb().collection(col(PERSONAL_DAYS_COLLECTION)).doc(day), 'Personal expense day', { attempts: 2 });
            const fixes = personalDayFixes(want[day] || {}, snap.exists ? snap.data() : null, wantOnline[day] || {});
            for (const f of fixes) {
                const [ref, data, opts] = personalDayWrite(day, f.id, f.amount, f.online);
                await ref.set(data, opts);
                written++;
            }
            personalDayCache.delete(day);
        }
        return written;
    },

    /**
     * Whether a bill has money due as the screens compute it (BILL-DUE,
     * outstandingDue). Stored as `openDue` on bills.
     * @param {'purchases'|'retailSales'|'wholesaleSales'} collKey
     * @param {Object} bill
     * @returns {boolean}
     */
    billHasOpenDue(collKey, bill) {
        return hasDue(collKey, bill);
    },

    /**
     * Firestore document id of a loaded record (a legacy doc may carry an `id`
     * field that differs from its document id).
     * @param {Object} record
     * @returns {string}
     */
    documentIdOf(record) {
        return docIdOf(record);
    },

    /** Version written as `clientVersion` on stock records (see firestore.rules). */
    CLIENT_VERSION,

    ...settingsMethods,

    ...tipMethods,

    /**
     * Startup: computes stock if that needs no full-history read; otherwise
     * starts it in the background (AppState.stockReady stays false until the
     * exact stock is available; screens show "Stock updating…").
     * With `defer`, stock is always computed right after the first screen is
     * painted (#13); the returned promise resolves once that is done.
     * @param {{defer?: boolean}} [opts]
     * @returns {Promise<void>}
     */
    async prepareStock({ defer = false } = {}) {
        if (!defer && (!windowState || usableCheckpoint() || AppState.historyLoadedFrom === 0)) {
            await this.getStock();
            return;
        }
        AppState.stockReady = false;
        const gen = sessionGen;
        const run = () => this.getStock()
            .then(() => {
                if (gen === sessionGen) markDirty(['stockView', 'itemsList', 'billingDropdown', 'salesDropdown'], false);
            })
            .catch(e => console.error('Background stock calculation failed:', e));
        if (!defer) {
            run();
            return;
        }
        await new Promise(resolve => afterFirstPaint(() => run().then(resolve)));
    },

    /**
     * Runs the background legacy-timestamp scan now if one is scheduled
     * (tests / Diagnostics); resolves when it is done.
     * @returns {Promise<void>}
     */
    runLegacyScanNow() {
        return legacyScanJob ? legacyScanJob.run() : Promise.resolve();
    },

    /**
     * Saves a stock adjustment to Firestore.
     * @async
     * @param {Object} adjustment - The stock adjustment to save
     * @param {string} adjustment.itemId - ID of the item being adjusted
     * @param {string} adjustment.adjustType - Type of adjustment ('add', 'remove', 'set')
     * @param {number} adjustment.quantity - Adjustment quantity
     * @param {number} [adjustment.rate] - Rate for the adjustment
     * @param {string} adjustment.date - Adjustment date
     * @param {string} [adjustment.reason] - Reason for adjustment
     * @returns {Promise<Object>} The saved adjustment with ID
     */
    async saveStockAdjustment(adjustment) {
        const { record, committed } = this.startSaveStockAdjustment(adjustment);
        await committed;
        return record;
    },

    /**
     * Starts saving a new stock adjustment (id made on the phone) and shows it
     * at once, also offline (#95); a refused write removes it again.
     * @param {Object} adjustment
     * @returns {{record: Object, committed: Promise<void>}}
     */
    startSaveStockAdjustment(adjustment, { id } = {}) {
        if (!adjustment.userId && AppState.currentUser) {
            adjustment.userId = AppState.currentUser.uid;
        }
        if (!adjustment.userName && AppState.userName) {
            adjustment.userName = AppState.userName;
        }
        
        prepareStockRecord('stockAdjustments', adjustment, true);
        // `id`: a fixed id (a reversal, #146), so a second phone's copy lands on the same document
        const started = startCreate('stockAdjustments', adjustment, id || null);
        noteStockWrite('stockAdjustments', null, adjustment);
        noteMonthWrite('stockAdjustments', null, adjustment);
        return started;
    },

    /**
     * Starts saving a new withdrawal (id made on the phone) and shows it at
     * once, also offline (#95); a refused write removes it again.
     * @param {Object} withdrawal
     * @returns {{record: Object, committed: Promise<void>}}
     */
    startSaveWithdrawal(withdrawal) {
        if (!withdrawal.userId && AppState.currentUser) {
            withdrawal.userId = AppState.currentUser.uid;
        }
        if (!withdrawal.userName && AppState.userName) {
            withdrawal.userName = AppState.userName;
        }
        
        // The window queries filter on `timestamp`; `date` is a user-picked day, so use the
        // later of creation time and that day (a backdated withdrawal is then an extra older record).
        if (typeof withdrawal.timestamp !== 'number') {
            withdrawal.timestamp = Math.max(Date.now(), parseAnyBillDate(withdrawal.date)?.getTime() || 0);
        }
        const started = startCreate('withdrawals', withdrawal);
        noteMonthWrite('withdrawals', null, withdrawal);
        return started;
    },

    /**
     * Calculates current stock levels from purchases, sales and adjustments.
     *
     * All events are merged into one timeline and applied in strict
     * chronological order (weighted-average cost with deficit rules; see
     * utils/stock-replay.js). While listeners are active and a valid stock
     * checkpoint is available, only events with t >= checkpoint.asOf are
     * replayed on top of the checkpoint's running state, which gives exactly
     * the same result as a full replay. Without a usable checkpoint the full
     * history is loaded once (ensureHistoryFrom(null)) and replayed, and a
     * checkpoint rebuild is requested in the background.
     *
     * @async
     * @returns {Promise<Object.<string, {quantity: number, rate: number}>>} Stock object keyed by item ID
     */
    async calculateStock() {
        lastStockApprox = null;
        if (!windowState) {
            return computeStock(currentSources(), AppState.items);
        }
        let cp = usableCheckpoint();
        if (cp) {
            return computeStockFrom(cp.state, cp.asOf, currentSources(), AppState.items);
        }
        if (AppState.historyLoadedFrom !== 0) {
            // One device rebuilds (lease) and does the only full-history read;
            // the others wait for its checkpoint instead of each reading everything (#194).
            // Members use the last (stale) checkpoint as approximate stock instead (#129).
            const approx = approximateCheckpoint();
            const plan = decideStockRebuild({
                canManage: canManageCheckpoint(),
                leaseUntil: checkpointDoc?.rebuildingUntil || 0,
                leaseBy: checkpointDoc?.rebuildingBy || null,
                uid: AppState.currentUser?.uid || null,
                now: Date.now(),
                waitedMs: leaseWaitedMs(),
                inFlight: !!rebuildPromise,
                attempted: rebuildAttempted,
                approxAvailable: !!approx
            });
            if (plan === 'approximate') {
                lastStockApprox = { builtAt: approx.builtAt || 0, asOf: approx.asOf };
                return computeStockFrom(approx.state, approx.asOf, currentSources(), AppState.items);
            }
            if (plan === 'wait') return waitForCheckpoint(checkpointDoc.rebuildingUntil);
            if (plan === 'join' || plan === 'rebuild') {
                let result = null;
                try {
                    result = await (plan === 'join' ? rebuildPromise : this.rebuildStockCheckpoint());
                } catch (e) {
                    console.error('Stock checkpoint rebuild failed:', e);
                }
                if (!windowState) return computeStock(currentSources(), AppState.items);
                cp = usableCheckpoint();
                if (cp) {
                    return computeStockFrom(cp.state, cp.asOf, currentSources(), AppState.items);
                }
                if (leaseWaitedMs() < LEASE_MAX_WAIT_MS) {
                    if (result?.status === 'leased') return waitForCheckpoint(checkpointDoc?.rebuildingUntil || Date.now() + REBUILD_LEASE_MS);
                    // Built elsewhere moments ago: the checkpoint listener delivers it shortly.
                    if (result?.status === 'fresh') return waitForCheckpoint(Date.now() + FRESH_CHECKPOINT_WAIT_MS);
                }
            }
        }
        if (AppState.historyLoadedFrom !== 0) {
            try {
                await this.ensureHistoryFrom(null);
            } catch (e) {
                console.error('Loading full history for stock failed:', e);
            }
            if (AppState.historyLoadedFrom !== 0 && windowState) {
                // Not exact without full history: retry and recompute shortly.
                const gen = sessionGen;
                setTimeout(() => {
                    if (gen === sessionGen) markDirty(['stockView'], true);
                }, FULL_LOAD_RETRY_MS);
            }
            cp = usableCheckpoint();
            if (cp) {
                return computeStockFrom(cp.state, cp.asOf, currentSources(), AppState.items);
            }
        }
        // The rebuild reuses the full history just loaded.
        if (!rebuildAttempted) requestRebuild();
        return computeStock(currentSources(), AppState.items);
    },

    /**
     * Returns the cached stock when it was computed from the current listener
     * data (and nobody has replaced AppState.stock since); otherwise
     * recalculates it, stores it in AppState.stock and returns it.
     * @async
     * @returns {Promise<Object.<string, {quantity: number, rate: number}>>}
     */
    async getStock() {
        if (unsubscribeFunctions.length > 0 && stockCache.stock && stockCache.stock === AppState.stock && stockCache.version === dataVersion) {
            // Only ready stock is cached (pending results clear the cache).
            AppState.stockReady = true;
            return AppState.stock;
        }
        const version = dataVersion;
        const stock = await this.calculateStock();
        AppState.stock = stock;
        AppState.stockApprox = lastStockApprox;
        if (pendingStocks.has(stock)) {
            // Last known stock is shown as "updating" until the checkpoint arrives.
            AppState.stockReady = false;
            stockCache = {};
            return stock;
        }
        AppState.stockReady = true;
        stockCache = { stock, version };
        return stock;
    },

    /**
     * Start (ms epoch) of the history guaranteed to be in AppState; 0 = all.
     * @returns {number}
     */
    getHistoryWindowStart() {
        return AppState.historyLoadedFrom;
    },

    /**
     * @returns {boolean} true when every history record is loaded
     */
    isFullHistoryLoaded() {
        return AppState.historyLoadedFrom === 0;
    },

    /**
     * Makes sure every history record with event time >= `from` is in AppState.
     * Resolves immediately when already covered; otherwise one-shot fetches the
     * missing range [from, historyLoadedFrom) of all history collections (all
     * history, unfiltered, for null), merges it (deduped by id, date-desc order),
     * updates AppState.historyLoadedFrom, re-renders and dispatches
     * `aadhat:historyextended` ({detail: {from}}). Concurrent calls share work.
     * Fetched records are not live (edits by other devices appear on next open).
     * @param {number|Date|null} from ms epoch / Date; null = all history
     * @returns {Promise<void>}
     */
    ensureHistoryFrom(from) {
        return queueExtend(normalizeFrom(from)).then(() => undefined);
    },

    /**
     * Extends the loaded history back by `months` calendar months (to full
     * history once nothing older exists).
     * @param {number} [months=1]
     * @returns {Promise<{loadedFrom: number, reachedEnd: boolean}>}
     */
    async loadOlderHistory(months = 1) {
        if (!windowState || AppState.historyLoadedFrom === 0) {
            return { loadedFrom: AppState.historyLoadedFrom, reachedEnd: true };
        }
        const oldest = await oldestTimestamp();
        const target = monthsBefore(AppState.historyLoadedFrom, months);
        if (oldest < target) {
            await this.ensureHistoryFrom(target);
        } else if (checkpointDoc?.backfill?.complete === true) {
            // Every document carries a numeric timestamp: [1, loadedFrom) is the rest.
            const before = AppState.historyLoadedFrom;
            await this.ensureHistoryFrom(1);
            if (AppState.historyLoadedFrom === 1 && before !== 0) {
                AppState.historyLoadedFrom = 0;
                if (typeof window !== 'undefined') {
                    window.dispatchEvent(new CustomEvent('aadhat:historyextended', { detail: { from: 0 } }));
                }
            }
        } else {
            // Legacy documents without a timestamp may exist: load everything.
            await this.ensureHistoryFrom(null);
        }
        return { loadedFrom: AppState.historyLoadedFrom, reachedEnd: AppState.historyLoadedFrom === 0 };
    },

    /**
     * Diagnostics: how each listener became ready at the last startup.
     * @returns {Object<string, {first: string, docs: number, readyBy?: string}>}
     */
    getStartupListenerInfo() {
        return JSON.parse(JSON.stringify(listenerStartup));
    },

    /**
     * Diagnostics (#194): estimated document reads since the app opened, the
     * top sources, and any "daily limit reached" errors seen this session.
     * @returns {{reads: number, since: number, top: Array<{source: string, reads: number}>, heavy: boolean, quota: Object}}
     */
    getReadStats() {
        return getQuotaStatus();
    },

    /**
     * On-demand history currently in memory (records older than the live
     * window; not live-updated), or null when only live data is loaded.
     * @returns {?{from: number, liveFrom: number, asOf: number}}
     */
    getOnDemandHistoryInfo() {
        if (!windowState || AppState.historyLoadedFrom >= windowState.liveFrom) return null;
        return { from: AppState.historyLoadedFrom, liveFrom: windowState.liveFrom, asOf: onDemandAsOf };
    },

    /**
     * Re-fetches the on-demand range from the server (queued behind any
     * running history load).
     * @returns {Promise<boolean>} false if it could not reach the server
     */
    refreshOnDemandHistory() {
        const p = extendQueue.then(() => refreshOnDemand());
        extendQueue = p.catch(() => {});
        return p;
    },

    /**
     * True once the live window listeners of all three bill collections
     * (purchases, retail, wholesale) have delivered a server snapshot this
     * session, i.e. the loaded bills are not just the offline cache.
     * @returns {boolean}
     */
    historyServerSynced() {
        const ws = windowState;
        if (!ws || ws.gen !== sessionGen) return false;
        return ['purchases', 'retailSales', 'wholesaleSales'].every(k => ws.colls[k]?.live?.server === true);
    },

    /**
     * Diagnostics: the stock checkpoint in use, if any.
     * @returns {?{asOf: number, builtAt: number, liveFrom: number}}
     */
    getStockCheckpointInfo() {
        const cp = usableCheckpoint();
        return cp ? { asOf: cp.asOf, builtAt: cp.builtAt, liveFrom: windowState.liveFrom } : null;
    },

    /**
     * The usable stock checkpoint's running state (read-only; callers clone
     * before replaying), for costing sales without reading older history (#215).
     * @returns {?{asOf: number, state: Object}}
     */
    getStockCheckpointState() {
        const cp = usableCheckpoint();
        return cp ? { asOf: cp.asOf, state: cp.state } : null;
    },

    /**
     * Rebuilds the stock checkpoint from a full read of all history (one device
     * at a time via the `rebuildingUntil` lease). Also backfills `timestamp` /
     * due fields into legacy documents so window and dues queries see them.
     * @returns {Promise<{status: string}>} built | fresh | leased | offline | conflict | ...
     */
    rebuildStockCheckpoint() {
        if (!windowState) return Promise.resolve({ status: 'inactive' });
        if (!canManageCheckpoint()) return Promise.resolve({ status: 'not-allowed' });
        if (rebuildPromise) {
            rebuildRequestedAgain = true;
            return rebuildPromise;
        }
        rebuildAttempted = true;
        const gen = sessionGen;
        const run = tip.start('StockCheckpoint');
        const p = rebuildCheckpointNow(gen);
        rebuildPromise = p;
        p.then(res => Promise.resolve(leaseReleases.get(res) ?? null).then(released => run.complete(checkpointProps(res, released))),
            () => run.complete(checkpointProps(null)));
        const done = () => {
            if (gen !== sessionGen || rebuildPromise !== p) return;
            rebuildPromise = null;
            if (rebuildRequestedAgain) {
                rebuildRequestedAgain = false;
                requestRebuild();
            }
        };
        p.then(done, done);
        return p;
    },

    /**
     * Startup maintenance: request a rebuild when no checkpoint is usable, or
     * roll the checkpoint forward (from data already in memory, no extra reads)
     * when it lags the window start by more than a week.
     * @returns {Promise<string>}
     */
    async maintainStockCheckpoint(attempt = 0) {
        if (!windowState) return 'inactive';
        const cp = usableCheckpoint();
        // Without a usable checkpoint calculateStock() loads full history and then requests the rebuild.
        if (!cp) return 'rebuild';
        if (!canManageCheckpoint()) return 'not-allowed';
        const d = checkpointDoc || {};
        if (Date.now() - (d.fullBuiltAt || d.builtAt || 0) > FORCED_REBUILD_AGE_MS) {
            // Deletes by outdated apps can't be detected: bound the drift with a weekly full rebuild.
            requestRebuild();
            return 'rebuild-aged';
        }
        const W = defaultWindowStart(Date.now());
        if (cp.asOf >= W - ROLL_FORWARD_SLACK_MS) return 'current';
        const result = await rollForwardCheckpoint(cp, W);
        if ((result === 'waiting' || result === 'changed') && attempt < 5) {
            const gen = sessionGen;
            setTimeout(() => {
                if (gen === sessionGen) this.maintainStockCheckpoint(attempt + 1).catch(e => console.error('Stock checkpoint roll-forward failed:', e));
            }, ROLL_FORWARD_RETRY_MS);
        }
        return result;
    },

    /**
     * Sets up real-time Firestore listeners for live data synchronization.
     *
     * Items are listened to in full. History collections (purchases, retail
     * and wholesale sales, expenses, stock adjustments, withdrawals) are
     * listened to only from the recent window start (see the section comment
     * above HISTORY_COLLECTIONS), plus bills with an outstanding due. The
     * stock checkpoint doc is read first because the window start depends on it.
     *
     * The first snapshot of each listener populates AppState, so startup does
     * not need a separate .get(). Later snapshots apply only docChanges() and
     * schedule a single debounced stock recalculation + re-render of the
     * visible tab.
     *
     * @returns {Promise<void>} Resolves once every data listener has delivered
     *   its first snapshot; rejects if a required listener fails before that.
     */
    setupRealtimeListeners() {
        // Clear any existing listeners first
        this.cleanup();
        const gen = sessionGen;
        const db = getDb();
        warmCache = false;
        Object.keys(listenerStartup).forEach(k => delete listenerStartup[k]);

        const listen = (query, label, live, onData, { optional = false, mapFn = mapDoc } = {}) => {
            let settle;
            const first = new Promise((resolve, reject) => { settle = { resolve, reject }; });
            // If listeners are torn down before the first snapshot (e.g. logout
            // during startup), don't leave startup waiting forever.
            pendingFirstSnapshots.push(settle);
            // Startup waits for server-confirmed data (like the former .get()),
            // falling back to the offline cache when offline or the server is slow.
            let ready = false;
            let readyTimer = null;
            const markReady = () => {
                if (ready) return;
                ready = true;
                clearTimeout(readyTimer);
                settle.resolve();
            };
            const syncId = `listen-${++listenSeq}`;
            // includeMetadataChanges so the cache -> server transition is seen
            // even when the cached data was already up to date.
            const unsubscribe = query.onSnapshot({ includeMetadataChanges: true }, snapshot => {
                if (gen !== sessionGen) return;
                SyncStatus.noteSnapshot(syncId, snapshot);
                const { changed, changes } = applySnapshot(live, snapshot, mapFn);
                if (!snapshot.metadata.fromCache) live.server = true;
                live.delivered = true;
                // Before startup is ready only AppState is updated; startup
                // computes stock and renders the initial views itself.
                if (changed) onData(changes, ready);
                if (!ready) {
                    const source = snapshot.metadata.fromCache ? 'cache' : 'server';
                    listenerStartup[label] = listenerStartup[label] || { first: source, docs: snapshot.size };
                    if (snapshot.metadata.fromCache && snapshot.size > 0) warmCache = true;
                    if (!snapshot.metadata.fromCache || navigator.onLine === false) {
                        listenerStartup[label].readyBy = source === 'server' ? 'server' : 'offline-cache';
                        markReady();
                    } else if (!readyTimer) {
                        // This device already has cached data: show it after a
                        // short wait instead of the full server grace; the live
                        // listener applies the server copy as soon as it arrives.
                        readyTimer = setTimeout(() => {
                            listenerStartup[label].readyBy = 'cache-timeout';
                            markReady();
                        }, warmCache ? FIRST_SNAPSHOT_CACHED_WAIT_MS : FIRST_SNAPSHOT_SERVER_WAIT_MS);
                    }
                }
            }, error => {
                console.error(`${label} listener error:`, error);
                live.failed = true;
                clearTimeout(readyTimer);
                if (!ready) {
                    ready = true;
                    if (optional) {
                        live.docs = [];
                        live.initialized = true;
                        if (gen === sessionGen) onData(null, false);
                        settle.resolve();
                    } else {
                        settle.reject(error);
                    }
                } else if (optional) {
                    // Failed later (e.g. Roles & access switched off): drop what it had, so a
                    // phone without the rows never also counts them (#98).
                    live.docs = [];
                    if (gen === sessionGen) onData(null, true);
                }
            });
            unsubscribeFunctions.push(unsubscribe);
            return first;
        };

        const itemsLive = { docs: [], initialized: false, server: false };
        const firstSnapshots = [listen(db.collection(col('items')), 'Items', itemsLive, (changes, started) => {
            AppState.items = itemsLive.docs.slice();
            AppState.dataVersion = ++dataVersion;
            if (!started) return;
            // Index-based views (item dropdown values, item cards) must
            // never lag behind AppState.items, so refresh them right away.
            ['itemsList', 'billingDropdown', 'salesDropdown'].forEach(name => {
                pendingViews.delete(name);
                runView(name);
            });
            markDirty(['itemsTable'], true);
        }, { mapFn: defaultMapDoc })];

        // Read in parallel: only the background legacy scan and backfills need it (#13).
        legacyScanReadPromise = getWithRetry(legacyScanRef(), 'Legacy scan state', { attempts: 2 })
            .then(snap => { if (gen === sessionGen) legacyScanDoc = snap.exists ? snap.data() : {}; })
            .catch(e => { console.warn('Reading legacy scan state failed:', e?.code || e); if (gen === sessionGen) legacyScanDoc = null; });
        const historyReady = listenCheckpoint(gen).then(() => {
            if (gen !== sessionGen) return undefined;
            const W = defaultWindowStart(Date.now());
            const cp = parseCheckpoint(checkpointDoc);
            let liveFrom = cp ? Math.min(W, cp.asOf) : W;
            if (!cp && !canManageCheckpoint()) {
                // Cover a stale checkpoint so members get approximate stock without a full read (#129).
                liveFrom = memberWindowStart(W, parseCheckpoint(checkpointDoc, { allowStale: true })?.asOf ?? null);
            }
            windowState = { gen, liveFrom, rawFull: false, colls: {}, backfills: {} };
            onDemandAsOf = 0;
            fullHistoryFetchedAt = 0;
            AppState.historyLoadedFrom = liveFrom;
            if (cp) adoptCheckpoint(checkpointDoc);

            const waits = [];
            HISTORY_COLLECTIONS.forEach(spec => {
                const c = createCollState(spec);
                windowState.colls[spec.key] = c;
                if (!historySpecReadable(spec)) {
                    Object.assign(c.live, { docs: [], initialized: true, server: true });
                    publishCollection(c);
                    return;
                }
                const affectsStock = !!spec.stock;
                const windowQuery = db.collection(col(spec.key))
                    .where('timestamp', '>=', liveFrom)
                    .orderBy('timestamp', 'desc');
                waits.push(listen(windowQuery, spec.label, c.live, (changes, started) => {
                    // null: an optional listener failed; its one-shot older records go too
                    if (changes === null) c.extended = new Map();
                    (changes || []).forEach(ch => {
                        const previous = ch.oldRec || findInSources(c, ch.docId, c.live);
                        if (ch.newRec) c.extended.delete(ch.docId);
                        if (spec.stock) noteObservedChange(c, previous, ch.newRec, ch.type);
                    });
                    publishCollection(c);
                    if (started && spec.dues && changes) warnDuplicateBillNumbers(c, changes);
                    if (started) markDirty(spec.views, affectsStock);
                }, { optional: !!spec.optional }));

                if (!spec.dues) return;
                // Older bills with money due (in-window bills come from the window query), and older
                // bills paid or written off inside the window (#163): their payment counts in this
                // window's money in / out, day book and month snapshots after the due is gone.
                // Bills inside the window with a later payment come from both queries (published
                // once, read twice): two range filters would need a composite index.
                const dueQueries = [
                    ['openDue', db.collection(col(spec.key)).where('openDue', '==', true).where('timestamp', '<', liveFrom)],
                    ['paidAt', db.collection(col(spec.key)).where('paidAt', '>=', liveFrom)]
                ];
                const pinnedIds = Array.isArray(checkpointDoc?.pinned?.[spec.key]) ? checkpointDoc.pinned[spec.key].slice(0, PINNED_MAX) : [];
                const docIdPath = typeof firebase !== 'undefined' && firebase.firestore?.FieldPath?.documentId
                    ? firebase.firestore.FieldPath.documentId() : null;
                for (let i = 0; docIdPath && i < pinnedIds.length; i += PINNED_CHUNK) {
                    dueQueries.push(['pinned', db.collection(col(spec.key)).where(docIdPath, 'in', pinnedIds.slice(i, i + PINNED_CHUNK))]);
                }
                dueQueries.forEach(([field, duesQuery]) => {
                    const live = { docs: [], initialized: false, server: false };
                    c.dues.push(live);
                    waits.push(listen(duesQuery, `${spec.label} dues (${field})`, live, (changes, started) => {
                        (changes || []).forEach(ch => {
                            if (ch.newRec) {
                                const previous = ch.oldRec || c.extended.get(ch.docId) || null;
                                c.extended.delete(ch.docId);
                                if (spec.stock && previous) noteObservedChange(c, previous, ch.newRec, ch.type);
                            } else if (!liveIdSet(c).has(ch.docId)) {
                                // Paid off (keep a fresh copy) or deleted.
                                refetchAfterDueRemoval(c, ch.docId, ch.oldRec);
                            }
                        });
                        publishCollection(c);
                        if (started) markDirty(spec.views, affectsStock);
                    }, { optional: true }));
                });
            });
            const ws = windowState;
            // Without a usable checkpoint calculateStock() reads everything anyway (and backfills).
            return Promise.all(waits).then(() => {
                if (gen !== sessionGen) return;
                if (shouldScheduleLegacyScan({ canManage: canManageCheckpoint(), hasCheckpoint: !!cp, online: navigator.onLine })) {
                    scheduleLegacyScan(ws, gen);
                }
                // Owner/manager phones keep the last week's personal day totals in step with the rows (#98)
                if (canManageCheckpoint() && FirebaseService.personalRowsLoaded() && navigator.onLine !== false) {
                    whenIdle(() => (gen === sessionGen
                        ? FirebaseService.rebuildPersonalExpenseDays([0, 1, 2, 3, 4, 5, 6].map(localISODaysAgo))
                            .catch(e => console.warn('Personal expense day totals not checked:', e?.code || e))
                        : undefined), { minDelayMs: LEGACY_SCAN_DELAY_MS });
                }
            });
        });
        firstSnapshots.push(historyReady);

        // Note: the former `cashSessions` and `users` listeners were removed.
        // Their callbacks targeted a non-existent element id / app method and
        // never did anything, yet each re-read its whole collection on every
        // app open.
        
        // Global item frequency (dropdown order) for signed-in users
        if (AppState.currentUser?.uid) {
            // Listen to global item frequency changes to update dropdown order in real-time
            // The bill and wholesale pages reload their item dropdowns (utils/events.js).
            const unsubItemFrequency = getDb().collection(col('itemFrequency')).doc('global').onSnapshot(doc => {
                if (doc.exists) emit(ITEM_FREQUENCY_CHANGED, doc.data());
            }, error => {
                console.error('Item frequency listener error:', error);
            });
            unsubscribeFunctions.push(unsubItemFrequency);
        }
        // The notifications listener is owned by NotificationsManager (#12):
        // it starts once the profile is loaded and stops on logout.

        return Promise.all(firstSnapshots).then(() => {
            if (gen !== sessionGen) return;
            setTimeout(() => {
                if (gen === sessionGen) {
                    this.maintainStockCheckpoint().catch(e => console.error('Stock checkpoint maintenance failed:', e));
                }
            }, 0);
        });
    },

    ...notificationMethods,

    ...cashDayMethods,

    ...anomalyMethods,
    ...worthAccountMethods,

    ...userProfileMethods,

};

// Export FirebaseService and cleanup function
export { FirebaseService };
