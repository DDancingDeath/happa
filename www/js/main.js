// -------------------- MAIN APPLICATION INITIALIZATION --------------------

import { AppState } from './utils/state.js';
import { UIManager } from './ui/ui-manager.js';
import { NavigationManager } from './ui/navigation.js';
import { AuthManager } from './auth/authentication.js';
import { FirebaseService } from './firebase/firestore-service.js';
import { ItemsManager } from './modules/items.js';
import { PrinterService, printerManager } from './services/printer.js';
import { BillingManager, PurchaseManager, RetailSaleManager } from './modules/billing.js';
import { StockManager } from './modules/stock.js';
import { WholesaleSalesManager } from './modules/wholesale-sales.js';
import { HistoryManager } from './modules/history.js';
import { OutstandingManager } from './modules/outstanding.js';
import { ReportsManager } from './modules/reports.js';
import { ExpensesManager } from './modules/miscellaneous.js';
import { SettingsManager } from './modules/settings.js';
import { UsersManager } from './modules/users.js';
import { FinanceManager } from './modules/finance.js';
import { AnalyticsManager } from './modules/analytics.js';
import { CashManagementManager } from './modules/cash-management.js';
import { DayManager } from './modules/day.js';
import { AnomaliesManager } from './modules/anomalies.js';
import { RateTrendsManager } from './modules/rate-trends.js';
import { HealthManager } from './modules/health.js';
import { RolesAccessManager } from './modules/roles-access.js';
import { tip, configureTip, startTipReporting, tipDeviceId } from './tip/index.js';
import { APP_VERSION } from './version.js';
import { AuditService } from './services/audit.js';
import { TelemetryService } from './services/telemetry.js';
import { DiagnosticsManager } from './modules/diagnostics.js';
import { AdminManager } from './modules/admin.js';
import { AppUpdatesManager } from './modules/app-updates.js';
import { NotificationsManager } from './modules/notifications.js';
import { markStartup, noteStartup, logStartupTimings } from './utils/startup-timings.js';

// Import template loader utility
import { TemplateLoader } from './utils/template-loader.js';
import { Helpers } from './utils/helpers.js';
import { InstallManager } from './services/install-prompt.js';
import { t, getLang, setLang, applyTranslations, LANG_CHANGE_EVENT } from './i18n/index.js';

// Build stamp — bumped on every deploy that ships new JS so you can verify
// in the browser console whether the latest code is actually running. If
// your console shows an OLDER BUILD_ID after a deploy + reload, the service
// worker / browser is still serving stale assets (reload twice, or hard
// refresh / unregister the service worker).
const BUILD_ID = '20261025s-single-language';
console.log(
    `%c[Aadhat] BUILD ${BUILD_ID}`,
    'color:#fff;background:#0a7;font-weight:bold;padding:2px 6px;border-radius:3px'
);
// Expose on window so the user can copy/paste it back to us when debugging.
window.__AADHAT_BUILD__ = BUILD_ID;
// Deferred Firebase SDK + firebaseConfig.js have run before any module code.
markStartup('sdk-and-modules-loaded');

InstallManager.init();

// Load and inject HTML templates from separate .html files
async function injectTemplates() {
    const templates = await TemplateLoader.loadAllTemplates();
    TemplateLoader.injectTemplates(templates);
    document.documentElement.lang = getLang();
    applyTranslations(document);
}

/**
 * Language switched (#143): redraw what JS rendered on the open screen and the
 * shared lists, using data already in memory (no Firestore reads).
 */
function refreshForLanguage(lang) {
    SettingsManager.syncItemNamesWithLanguage(lang);
    const run = (label, fn) => { try { fn(); } catch (e) { console.warn(`[i18n] ${label} redraw failed:`, e); } };
    // Relabel item pickers in place: reloading them would reset the chosen item and rate.
    run('items', () => {
        const label = (item) => ((AppState.settings.showHindi && item.hindiName) ? item.hindiName : item.name);
        document.querySelectorAll('#billItem option, #saleItem option').forEach(opt => {
            const item = AppState.items[Number(opt.value)];
            if (item) opt.textContent = label(item);
        });
        document.querySelectorAll('#sellItem option').forEach(opt => {
            const item = opt.value && AppState.items.find(i => i.name === opt.value);
            if (item) opt.textContent = label(item);
        });
    });
    // Signed out (login card links): nothing behind the login screen to redraw.
    if (!AppState.currentUser) return;
    const tabId = document.querySelector('.tab.active')?.id;
    const redraw = {
        day: () => { DayManager.updateTodayHeader(); DayManager.loadTodayData(); AnomaliesManager.drawDayReport(); },
        due: () => OutstandingManager.renderDue(),
        history: () => {
            const toggle = document.getElementById('historyViewToggle');
            if (toggle) toggle.textContent = t(HistoryManager.viewMode === 'card' ? 'ui.history.table_view' : 'ui.history.card_view');
            HistoryManager.refreshHistory();
        },
        'cash-management': () => CashManagementManager.refreshForLanguage(),
        'wholesale-sales': () => { WholesaleSalesManager.renderSalesHistory(); WholesaleSalesManager.renderSalesOutstanding(); },
        settings: () => { SettingsManager.loadSettings(); RolesAccessManager.render(); },
        finance: () => FinanceManager.renderDashboard(),
        'rate-trends': () => RateTrendsManager.refreshForLanguage(),
        anomalies: () => AnomaliesManager.refreshForLanguage(),
        stock: () => StockManager.refreshForLanguage(),
        admin: () => AdminManager.renderContent()
    }[tabId];
    if (redraw) run(tabId, redraw);
    if (tabId === 'day' && DayManager.currentSubTab === 'cash') run('day-cash', () => CashManagementManager.refreshForLanguage());
    run('notifications', () => NotificationsManager.renderPanel());
}
window.addEventListener(LANG_CHANGE_EVENT, (e) => refreshForLanguage(e.detail.lang));
SettingsManager.syncItemNamesWithLanguage(getLang());

// Global error handlers
window.addEventListener('error', function(event) {
    const errorMsg = event.error?.message || event.message || 'Unknown error';
    console.error('Global error:', event.error);
    UIManager.showToast(t('msg.app.error_occurred', { errorMsg }));
    
    // Log to telemetry
    TelemetryService.captureError({
        type: 'uncaught',
        message: errorMsg,
        stack: event.error?.stack,
        source: event.filename,
        line: event.lineno,
        column: event.colno
    });
});

window.addEventListener('unhandledrejection', function(event) {
    const errorMsg = event.reason?.message || event.reason || 'Unknown rejection';
    console.error('Unhandled promise rejection:', event.reason);
    
    // Log to telemetry
    TelemetryService.captureError({
        type: 'unhandledrejection',
        message: errorMsg,
        stack: event.reason?.stack
    });
});

// Setup event listeners
function setupEventListeners() {
    // Close the side menu on overlay tap / Esc / swipe-left
    NavigationManager.initMenuDismiss();
    
    // Modal buttons
    const modalCancel = document.getElementById('modalCancel');
    const modalConfirm = document.getElementById('modalConfirm');
    
    if (modalCancel) {
        modalCancel.addEventListener('click', () => UIManager.closeModal(false));
    }
    if (modalConfirm) {
        modalConfirm.addEventListener('click', () => UIManager.closeModal(true));
    }
    
    // Warn before leaving page with unsaved bill
    window.addEventListener('beforeunload', function(e) {
        if (AppState.billItems.length > 0 || AppState.salesItems.length > 0) {
            e.preventDefault();
            e.returnValue = '';
        }
    });
    
    // Auto-save triggers for text field changes
    const autoSaveFields = [
        'customerName', 'billComments', 'manualLaborCharges',
        'saleCustomerName', 'saleComments'
    ];
    
    autoSaveFields.forEach(fieldId => {
        const field = document.getElementById(fieldId);
        if (field) {
            field.addEventListener('input', () => {
                if (window.app?.billing?.triggerAutoSave) {
                    window.app.billing.triggerAutoSave();
                }
            });
        }
    });
}

// Load user data and initialize app.
// Login triggers this twice (onAuthStateChanged + AuthManager.handleLogin);
// share one in-flight run so data isn't loaded (and billed) twice and the
// second run's listener reset can't strand the first.
let initInFlight = null;
function loadUserDataAndInitialize() {
    if (!initInFlight) {
        initInFlight = initializeUserData().finally(() => {
            initInFlight = null;
        });
    }
    return initInFlight;
}

/** How long startup waits for the minClientVersion read once data is ready (ms). */
const VERSION_CHECK_WAIT_MS = 1500;

let outdatedBlocked = false;
/** Outdated app: stop syncing and keep the app hidden behind the update message. */
function blockOutdatedApp() {
    outdatedBlocked = true;
    FirebaseService.cleanup();
    NotificationsManager.stop();
    document.getElementById('appContent')?.classList.add('hidden');
    UIManager.hideLoading();
    AuthManager.showLoginNotice(t('msg.app.app_version_outdated_update_app'));
    UIManager.showModal(t('msg.app.app_version_outdated_update_app'));
}

/** TIP (#217) report sink: counters + failure samples for this user/device. */
function writeTipReport({ delta, failures }) {
    const uid = AppState.currentUser?.uid || firebase.auth().currentUser?.uid;
    const native = typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.();
    return FirebaseService.writeTip({
        uid, deviceId: tipDeviceId(uid), delta, failures,
        appVersion: APP_VERSION, buildId: BUILD_ID, platform: native ? 'android' : 'web'
    });
}

async function initializeUserData() {
    if (outdatedBlocked) {
        blockOutdatedApp();
        return;
    }
    UIManager.showLoading();
    // TIP AppStart (#217): first usable screen after the profile/data load
    const appStart = tip.start('AppStart', { flags: { offline: navigator.onLine === false } });
    const notShown = () => { appStart.setFlag('blocked'); appStart.complete(); };
    
    try {
        // Fetch user data
        const userId = AppState.currentUser?.uid || firebase.auth().currentUser?.uid;
        if (userId) {
            const userRef = firebase.firestore().collection(window.getCollection ? window.getCollection('users') : 'users').doc(userId);
            let userDoc = await userRef.get();
            markStartup('profile', { fromCache: !!userDoc.metadata?.fromCache });
            // A stale offline-cache copy must not lock out a user who has since been approved
            if (!userDoc.exists || userDoc.data().status === 'pending') {
                userDoc = await userRef.get({ source: 'server' }).catch(() => userDoc);
            }
            if (userDoc.exists) {
                const userData = userDoc.data();
                
                // Check if user is approved
                if (userData.status === 'pending') {
                    notShown();
                    await firebase.auth().signOut();
                    UIManager.hideLoading();
                    AuthManager.showLoginNotice(t('msg.common.account_pending_approval_wait_admin'), 'info');
                    document.getElementById('authScreen').style.display = 'flex';
                    return;
                }
                
                if (userData.status === 'rejected') {
                    notShown();
                    await firebase.auth().signOut();
                    UIManager.hideLoading();
                    AuthManager.showLoginNotice(t('msg.common.account_has_been_rejected_contact'));
                    document.getElementById('authScreen').style.display = 'flex';
                    return;
                }
                
                AppState.userRole = userData.role || 'staff';
                AppState.userName = userData.name || 'User';
            } else {
                // User document doesn't exist
                notShown();
                await firebase.auth().signOut();
                UIManager.hideLoading();
                AuthManager.showLoginNotice(t('msg.app.user_account_not_found_register'));
                document.getElementById('authScreen').style.display = 'flex';
                return;
            }
        }
        
        // Outdated app check (settings/app.minClientVersion), read alongside the listeners.
        const versionCheck = FirebaseService.isClientVersionSupported().then(ok => {
            markStartup('version-check', { ok });
            return ok;
        });
        // Shared labour rate / heavy-packet weight (#20) come from the same settings/app read
        FirebaseService.loadAppSettings()
            .then(data => { configureTip(data); RolesAccessManager.applyShared(data); return SettingsManager.applySharedSettings(data); })
            .catch(e => console.warn('Shared labour settings not loaded:', e?.code || e));
        // TIP reporting (#217): approved user only; writes are batched (≤ 1 counter write / 30 min)
        startTipReporting({ sink: writeTipReport, buildId: BUILD_ID });

        // Attach real-time listeners. Their first snapshots populate AppState,
        // so every document is read once per app open (a separate .get() of
        // each collection would read everything a second time).
        try {
            await Promise.all([
                FirebaseService.setupRealtimeListeners(),
                BillingManager.loadItemFrequency()
            ]);
        } catch (loadError) {
            FirebaseService.cleanup();
            throw loadError;
        }
        
        markStartup('listeners', { online: navigator.onLine });

        // Notifications: the profile is loaded, so the uid is known (#12).
        const notifUid = AppState.currentUser?.uid || firebase.auth().currentUser?.uid;
        if (notifUid) NotificationsManager.start(notifUid);

        // Don't hold the first screen for a slow version read (up to ~24 s on a
        // weak network): wait briefly, then let it finish in the background and
        // still block the app if it turns out to be outdated.
        const versionResult = await Promise.race([
            versionCheck,
            new Promise(resolve => setTimeout(() => resolve(null), VERSION_CHECK_WAIT_MS))
        ]);
        if (versionResult === false) {
            notShown();
            blockOutdatedApp();
            return;
        }
        if (versionResult === null) {
            const uid = AppState.currentUser?.uid;
            versionCheck.then(ok => {
                if (!ok && AppState.currentUser?.uid === uid) blockOutdatedApp();
            });
        }

        // Stock is computed right after the first screen is painted (#13): the
        // screens show "Stock updating…" until then and re-render when it is
        // ready, so the first screen never waits on it.
        if (outdatedBlocked) { notShown(); return; }
        AppState.stockReady = false;
        
        // Initialize billing manager (connects purchase and retail-sale modules)
        BillingManager.init();
        
        // Show app content
        const appContent = document.getElementById('appContent');
        if (appContent) {
            appContent.classList.remove('hidden');
        }
        
        // Show the billing tab by default
        NavigationManager.showTab('billing');
        NavigationManager.setActiveNavLink('billing');
        
        // Initialize UI
        AuthManager.updateUserDisplay();
        AuthManager.applyRoleBasedRestrictions();
        
        // Update username in navigation
        const userNameDisplay = document.getElementById('currentUserName');
        if (userNameDisplay) {
            userNameDisplay.textContent = AppState.userName || 'User';
        }
        
        // Render initial views
        ItemsManager.renderItems();
        BillingManager.loadItemsDropdown();
        WholesaleSalesManager.loadItemsDropdown();
        BillingManager.updateDraftCount();
        ExpensesManager.updateExpensePersonOptions();
        ExpensesManager.renderexpensesHistory();

        // TIP AppStart (#217): the first screen is usable now; the auto-save
        // restore prompt below waits for the user and must not count as start time.
        appStart.complete();
        
        // Check for auto-saved bill
        await BillingManager.checkAutoSave();
        if (outdatedBlocked) {
            notShown();
            blockOutdatedApp();
            return;
        }
        
        // Update printer status
        PrinterService.updateStatus();
        
        // Clean up old audit logs (runs silently for owners)
        AuditService.cleanupOldLogs().catch(e => console.warn('Audit log cleanup failed:', e));
        
        UIManager.hideLoading();
        markStartup('app-shown', { online: navigator.onLine });
        noteStartup('listeners', FirebaseService.getStartupListenerInfo?.() || {});
        logStartupTimings();
        FirebaseService.prepareStock({ defer: true })
            .then(() => markStartup('stock', { ready: AppState.stockReady, approximate: !!AppState.stockApprox }));

        // What's new + Android update banner (non-blocking, best effort)
        AppUpdatesManager.onAppReady();

        // Daily anomaly scan (#187): owner/manager devices, once per day, over loaded data
        AnomaliesManager.scheduleDailyScan();

        // Rate trends (#65): roll monthly rate stats forward from loaded bills (owner/manager)
        RateTrendsManager.scheduleRollForward();
        
    } catch (error) {
        console.error('Error initializing app:', error);
        appStart.complete({ loadFailed: true });
        UIManager.hideLoading();
        UIManager.showToast(t('msg.app.failed_load_data', { message: error.message }));
    }
}

// Initialize app on DOM ready
document.addEventListener('DOMContentLoaded', async function() {
    // STEP 1: Load and inject all HTML templates from .html files
    markStartup('dom-ready');
    await injectTemplates();
    markStartup('templates');
    InstallManager.refresh();
    
    // STEP 2: Initialize auth tabs after templates are loaded
    AuthManager.initAuthTabs();
    
    // STEP 3: Initialize Firebase auth listener
    if (typeof firebase !== 'undefined' && firebase.auth) {
        firebase.auth().onAuthStateChanged(user => {
            markStartup('auth', { signedIn: !!user });
            if (user) {
                // Registration signs in temporarily to create/recover the profile and then signs
                // out; don't start loading the app (and showing its errors) for that sign-in.
                if (AuthManager.authFlowInProgress) return;
                // Set current user in AppState
                AppState.currentUser = user;
                const authScreen = document.getElementById('authScreen');
                if (authScreen && authScreen.style.display !== 'none') {
                    authScreen.style.display = 'none';
                }
                loadUserDataAndInitialize();
            } else {
                // Clean up Firebase listeners when user signs out
                FirebaseService.cleanup();
                NotificationsManager.stop();
                AppState.currentUser = null;
                document.getElementById('authScreen').style.display = 'flex';
            }
        });
    }
    
    // STEP 4: Set up event listeners
    setupEventListeners();
    
    // STEP 5: Clean up listeners when page unloads
    window.addEventListener('beforeunload', () => {
        FirebaseService.cleanup();
    });
});

// Expose loadUserDataAndInitialize for manual login trigger
window.initializeApp = loadUserDataAndInitialize;

/**
 * Diagnostic helper: replay every event touching items whose name/hindiName/id
 * matches `query` (case-insensitive substring) and dump the chronological
 * timeline plus running totals to console. Compares against the value that
 * FirebaseService.calculateStock() returns so any divergence is obvious.
 *
 * Usage from browser console:  await app.debug.stock('piyar dana')
 */
async function debugStockForName(query) {
    if (!query || typeof query !== 'string') {
        console.warn('debugStock: pass an item name, e.g. app.debug.stock("piyar dana")');
        return;
    }
    const q = query.trim().toLowerCase();
    const matches = (AppState.items || []).filter(it => {
        const name = (it.name || '').toLowerCase();
        const hindi = (it.hindiName || '').toLowerCase();
        const id = (it.id || '').toLowerCase();
        return name.includes(q) || hindi.includes(q) || id === q;
    });

    if (matches.length === 0) {
        console.warn(`debugStock: no items matched "${query}". Items loaded:`, (AppState.items || []).map(i => i.name));
        return;
    }

    const eventTime = (record) => {
        if (typeof record.timestamp === 'number') return record.timestamp;
        if (record.timestamp && typeof record.timestamp.toMillis === 'function') {
            return record.timestamp.toMillis();
        }
        const parsed = Helpers.parseDate(record.date);
        return parsed ? parsed.getTime() : Number.MAX_SAFE_INTEGER;
    };

    const lineMatchesItem = (lineItem, item) => {
        if (lineItem.itemId && item.id) return lineItem.itemId === item.id;
        const n = (lineItem.name || '').toLowerCase();
        return n === (item.name || '').toLowerCase() || n === (item.hindiName || '').toLowerCase();
    };

    const computed = await FirebaseService.calculateStock();
    // The timeline below replays AppState directly, so it needs all history.
    await FirebaseService.ensureHistoryFrom(null);

    for (const item of matches) {
        const events = [];
        (AppState.purchaseHistory || []).forEach(p => {
            (p.items || []).forEach(li => {
                if (lineMatchesItem(li, item)) {
                    events.push({ t: eventTime(p), kind: 'purchase', date: p.date, doc: p.id, qty: parseFloat(li.qty || li.quantity) || 0, rate: parseFloat(li.rate) || 0, lineItem: li });
                }
            });
        });
        (AppState.salesHistory || []).forEach(s => {
            (s.items || []).forEach(li => {
                if (lineMatchesItem(li, item)) {
                    events.push({ t: eventTime(s), kind: 'wholesale-sale', date: s.date, doc: s.id, qty: parseFloat(li.qty || li.quantity) || 0, rate: parseFloat(li.rate) || 0, lineItem: li });
                }
            });
        });
        (AppState.retailSalesHistory || []).forEach(s => {
            (s.items || []).forEach(li => {
                if (lineMatchesItem(li, item)) {
                    events.push({ t: eventTime(s), kind: 'retail-sale', date: s.date, doc: s.id, qty: parseFloat(li.qty || li.quantity) || 0, rate: parseFloat(li.rate) || 0, lineItem: li });
                }
            });
        });
        (AppState.stockAdjustments || []).forEach(adj => {
            const key = adj.itemId || adj.itemName;
            const matchesById = item.id && adj.itemId === item.id;
            const matchesByName = (adj.itemName || '').toLowerCase() === (item.name || '').toLowerCase()
                || (adj.itemName || '').toLowerCase() === (item.hindiName || '').toLowerCase();
            if (key && (matchesById || matchesByName)) {
                events.push({ t: eventTime(adj), kind: `adjust:${adj.adjustType}`, date: adj.date, doc: adj.id, qty: parseFloat(adj.quantity) || 0, rate: parseFloat(adj.rate) || 0, newStockSnapshot: adj.newStock, reason: adj.reason, adj });
            }
        });
        events.sort((a, b) => a.t - b.t);

        let runningQty = 0;
        let runningValue = 0;
        const timeline = events.map((ev, idx) => {
            let delta = 0;
            let note = '';
            // Mirror the cost-basis discipline in firestore-service.js
            // calculateStock(): totalValue is clamped to 0 whenever
            // runningQty drops to <= 0, and a purchase that lifts a
            // negative position back into positive territory contributes
            // only the excess to the new cost basis at the purchase rate.
            if (ev.kind === 'purchase') {
                delta = ev.qty;
                const prevQty = runningQty;
                runningQty = prevQty + ev.qty;
                if (runningQty <= 0) {
                    runningValue = 0;
                } else if (prevQty < 0) {
                    runningValue = runningQty * ev.rate;
                    note = `filled deficit ${(-prevQty).toFixed(3)}kg; ${runningQty.toFixed(3)}kg new stock @ ${ev.rate}`;
                } else {
                    runningValue += ev.qty * ev.rate;
                }
            } else if (ev.kind === 'wholesale-sale' || ev.kind === 'retail-sale') {
                delta = -ev.qty;
                const prevQty = runningQty;
                const avg = prevQty > 0 ? runningValue / prevQty : 0;
                runningQty = prevQty - ev.qty;
                if (runningQty <= 0) {
                    runningValue = 0;
                    note = `avg-rate-used=${avg.toFixed(2)} (clamped: oversold by ${Math.abs(runningQty).toFixed(3)}kg)`;
                } else {
                    runningValue -= ev.qty * avg;
                    note = `avg-rate-used=${avg.toFixed(2)}`;
                }
            } else if (ev.kind === 'adjust:add') {
                delta = ev.qty;
                const prevQty = runningQty;
                runningQty = prevQty + ev.qty;
                if (runningQty <= 0) {
                    runningValue = 0;
                } else if (prevQty < 0) {
                    runningValue = ev.rate > 0 ? runningQty * ev.rate : 0;
                } else if (ev.rate > 0) {
                    runningValue += ev.qty * ev.rate;
                }
            } else if (ev.kind === 'adjust:remove') {
                // Same cap as stock-replay: never removes more than is on hand
                const prevQty = runningQty;
                const removed = Math.min(ev.qty, Math.max(0, prevQty));
                delta = -removed;
                runningQty = prevQty - removed;
                if (runningQty <= 0 || prevQty <= 0) {
                    runningValue = 0;
                } else {
                    const ratio = removed / prevQty;
                    runningValue -= runningValue * ratio;
                }
            } else if (ev.kind === 'adjust:set') {
                const prev = runningQty;
                const prevValue = runningValue;
                delta = ev.qty - prev;
                runningQty = ev.qty;
                if (runningQty <= 0) {
                    runningValue = 0;
                } else if (ev.rate > 0) {
                    runningValue = ev.qty * ev.rate;
                } else {
                    const avg = prev > 0 && prevValue > 0 ? prevValue / prev : 0;
                    runningValue = ev.qty * avg;
                }
                note = `was ${prev}, snapshot=${ev.newStockSnapshot}`;
            }
            return {
                '#': idx + 1,
                when: new Date(ev.t).toLocaleString('en-IN'),
                kind: ev.kind,
                date_field: ev.date,
                qty: ev.qty,
                rate: ev.rate,
                delta,
                runningQty: Number(runningQty.toFixed(3)),
                runningRate: runningQty > 0 ? Number((runningValue / runningQty).toFixed(2)) : 0,
                doc: ev.doc,
                note
            };
        });

        const key = item.id;
        const displayed = computed[key] || computed[item.name] || computed[item.hindiName];

        console.groupCollapsed(`%cStock debug — ${item.name}${item.hindiName ? ' / ' + item.hindiName : ''}  (id=${item.id})`, 'font-weight:bold;color:#0a7');
        console.log('Events found:', events.length);
        console.table(timeline);
        console.log('Expected final  :', { quantity: Number(runningQty.toFixed(3)), rate: runningQty > 0 ? Number((runningValue / runningQty).toFixed(2)) : 0 });
        console.log('calculateStock() :', displayed || '(not present in output — quantity is 0 or key mismatch)');
        if (displayed && Math.abs((displayed.quantity || 0) - runningQty) > 1e-6) {
            console.warn('⚠ MISMATCH between replay and calculateStock — please share this dump.');
        }
        console.groupEnd();
    }
    console.log(`debugStock: dumped ${matches.length} item(s) matching "${query}". Expand the groups above.`);
}

/**
 * Diagnostic helper: summarise the raw AppState collections for an item and
 * list every distinct (name, itemId) tuple that appears in sales/retail lines
 * even *loosely* related to `query`. This is the tool to reach for when
 * debugStock returns "no sales" but you know there must be some — it shows
 * whether the sales arrays are empty, whether sales line items reference the
 * item by a different name spelling, or whether they reference no itemId at
 * all.
 *
 * Usage from browser console:  await app.debug.item('piyar dana')
 *                              or:  await debugItemForName('piyar')
 */
async function debugItemForName(query) {
    if (!query || typeof query !== 'string') {
        console.warn('debugItem: pass an item name, e.g. app.debug.item("piyar dana")');
        return;
    }
    const q = query.trim().toLowerCase();
    const matchedItems = (AppState.items || []).filter(it => {
        const name = (it.name || '').toLowerCase();
        const hindi = (it.hindiName || '').toLowerCase();
        const id = (it.id || '').toLowerCase();
        return name.includes(q) || hindi.includes(q) || id === q;
    });

    const counts = {
        items: (AppState.items || []).length,
        purchaseHistory: (AppState.purchaseHistory || []).length,
        salesHistory: (AppState.salesHistory || []).length,
        retailSalesHistory: (AppState.retailSalesHistory || []).length,
        stockAdjustments: (AppState.stockAdjustments || []).length,
    };

    console.groupCollapsed(`%cItem debug — query "${query}"`, 'font-weight:bold;color:#06c');
    console.log('AppState counts:', counts);
    console.log('Items matched in AppState.items:', matchedItems);
    if (matchedItems.length === 0) {
        console.warn('No items matched. The catalogue may be on a different env, or the spelling differs.');
    }

    // Walk every sale line and collect distinct (name, itemId, hindiName?) tuples
    // that loosely contain the query string. This catches the case where sales
    // were entered under "Piyar Dana" or "पियर दाना" but the catalogue entry is
    // "piyar dana", which would silently key the sale to a separate stock bucket.
    const lineFingerprints = new Map();
    const recordLine = (li, source) => {
        const name = li.name || '';
        const itemId = li.itemId || '';
        const lname = name.toLowerCase();
        const isLooseHit = q && lname.includes(q);
        const isExactToMatched = matchedItems.some(m => {
            if (itemId && m.id === itemId) return true;
            return lname === (m.name || '').toLowerCase() || lname === (m.hindiName || '').toLowerCase();
        });
        if (!isLooseHit && !isExactToMatched) return;
        const key = `${name}|${itemId}`;
        if (!lineFingerprints.has(key)) {
            lineFingerprints.set(key, { name, itemId, count: 0, sources: new Set(), matchedToCatalogue: isExactToMatched });
        }
        const entry = lineFingerprints.get(key);
        entry.count += 1;
        entry.sources.add(source);
    };

    (AppState.purchaseHistory || []).forEach(p => (p.items || []).forEach(li => recordLine(li, 'purchase')));
    (AppState.salesHistory || []).forEach(s => (s.items || []).forEach(li => recordLine(li, 'wholesale-sale')));
    (AppState.retailSalesHistory || []).forEach(s => (s.items || []).forEach(li => recordLine(li, 'retail-sale')));

    const fingerprintRows = Array.from(lineFingerprints.values()).map(f => ({
        name: f.name,
        itemId: f.itemId || '(none)',
        sources: Array.from(f.sources).join(', '),
        lineCount: f.count,
        matchesCatalogueEntry: f.matchedToCatalogue,
    }));

    if (fingerprintRows.length === 0) {
        console.warn(`No line items across purchases/sales contain "${query}" in their name. Sales for this item may not exist, OR may be keyed entirely by itemId with a different name.`);
    } else {
        console.log('Distinct (name, itemId) tuples that touch this query:');
        console.table(fingerprintRows);
        const orphans = fingerprintRows.filter(r => !r.matchesCatalogueEntry);
        if (orphans.length > 0) {
            console.warn(`⚠ ${orphans.length} fingerprint(s) above do NOT match any catalogue entry exactly. Those lines will be keyed by their raw name and produce a SEPARATE stock bucket from the catalogue item.`);
        }
    }

    console.groupEnd();
}

// Expose clean API to window for HTML event handlers
// Note: `app` is also defined as a top-level `let` in firebaseConfig.js (Firebase instance),
// which shadows `window.app` when referenced by bare name in the DevTools console.
// Use `window.app.debug.stock(...)` or the dedicated `debugStock(...)` global below.
window.debugStock = debugStockForName;
window.debugItem = debugItemForName;
window.calculateStock = () => FirebaseService.calculateStock();
window.FirebaseService = FirebaseService;
window.app = {
    // Diagnostics
    debug: {
        stock: debugStockForName,
        item: debugItemForName
    },


    // Authentication
    auth: {
        showTab: (tab) => AuthManager.showAuthTab(tab),
        login: () => AuthManager.handleLogin(),
        register: () => AuthManager.handleRegister(),
        logout: () => AuthManager.handleLogout(),
        forgotPassword: () => AuthManager.handleForgotPassword()
    },
    
    // App language (#143): Settings switch + login card links
    i18n: {
        setLang: (lang) => setLang(lang),
        getLang: () => getLang()
    },

    // Navigation
    nav: {
        toggleMenu: () => NavigationManager.toggleMenu(),
        closeMenu: () => NavigationManager.closeMenu(),
        showTab: (tabId, evt) => NavigationManager.showTabFromNav(tabId, evt)
    },
    
    // Notifications inbox (#12)
    notifications: {
        toggle: () => NotificationsManager.toggle(),
        open: () => NotificationsManager.openInbox(),
        close: () => NotificationsManager.close(),
        loadMore: () => NotificationsManager.loadMore(),
        markAllRead: () => NotificationsManager.markAllRead(),
        openNotification: (id) => NotificationsManager.openNotification(id),
        toggleSystem: (checked) => NotificationsManager.toggleSystem(checked),
        refreshSettings: () => NotificationsManager.refreshSettings()
    },

    // Items Management
    items: {
        render: () => ItemsManager.renderItems(),
        renderTable: () => ItemsManager.renderItemsTable(),
        refreshTable: () => ItemsManager.refreshTable(),
        search: (query) => ItemsManager.renderItemsTable(query),
        openAddModal: () => ItemsManager.openAddModal(),
        openEditModal: (id) => ItemsManager.openEditModal(id),
        closeItemModal: () => ItemsManager.closeItemModal(),
        addModalRate: (type) => ItemsManager.addModalRate(type),
        updateModalRate: (type, idx, val) => ItemsManager.updateModalRate(type, idx, val),
        deleteModalRate: (type, idx) => ItemsManager.deleteModalRate(type, idx),
        saveItemFromModal: () => ItemsManager.saveItemFromModal(),
        deleteItemFromModal: () => ItemsManager.deleteItemFromModal(),
        loadModalHistory: () => ItemsManager.loadModalHistory(),
        add: () => ItemsManager.addItem(),
        // Item handlers take the item id, never a list position (#29)
        updateName: (id, val) => ItemsManager.updateItemName(id, val),
        updateHindiName: (id, val) => ItemsManager.updateItemHindiName(id, val),
        addRate: (id) => ItemsManager.addRate(id),
        updateRate: (id, rIdx, val) => ItemsManager.updateRate(id, rIdx, val),
        commitRate: (id, rIdx) => ItemsManager.commitRate(id, rIdx),
        deleteRate: (id, rIdx) => ItemsManager.deleteRate(id, rIdx),
        addWholesaleRate: (id) => ItemsManager.addWholesaleRate(id),
        updateWholesaleRate: (id, rIdx, val) => ItemsManager.updateWholesaleRate(id, rIdx, val),
        commitWholesaleRate: (id, rIdx) => ItemsManager.commitWholesaleRate(id, rIdx),
        deleteWholesaleRate: (id, rIdx) => ItemsManager.deleteWholesaleRate(id, rIdx),
        addSaleRate: (id) => ItemsManager.addSaleRate(id),
        updateSaleRate: (id, rIdx, val) => ItemsManager.updateSaleRate(id, rIdx, val),
        commitSaleRate: (id, rIdx) => ItemsManager.commitSaleRate(id, rIdx),
        deleteSaleRate: (id, rIdx) => ItemsManager.deleteSaleRate(id, rIdx),
        deleteItem: (id) => ItemsManager.deleteItem(id),
        exportExcel: () => ItemsManager.exportToExcel(),
        importExcel: (evt) => ItemsManager.importFromExcel(evt)
    },
    
    // Billing
    billing: {
        // Items & Rates loading
        loadItemsDropdown: () => BillingManager.loadItemsDropdown(),
        loadSaleItemsDropdown: () => BillingManager.loadSaleItemsDropdown(),
        loadRates: () => BillingManager.loadRates(),
        loadSaleRates: () => BillingManager.loadSaleRates(),
        
        // Weight management
        addWeight: () => BillingManager.addWeight(),
        renderWeights: () => BillingManager.renderWeights(),
        removeWeight: (idx) => BillingManager.removeWeight(idx),
        clearWeights: () => BillingManager.clearWeights(),
        
        // Purchase bill
        addToBill: (autoAdd) => BillingManager.addToBill(autoAdd),
        renderBill: () => BillingManager.renderBill(),
        deleteBillItem: (idx) => BillingManager.deleteBillItem(idx),
        updateTotals: () => BillingManager.updateTotals(),
        updatePaymentTotal: () => BillingManager.updatePaymentTotal(),
        fillPayableAmount: (type) => BillingManager.fillPayableAmount(type),
        saveBill: () => BillingManager.saveBillToHistory(),
        
        // Sales bill
        addSaleWeight: (autoAdd) => BillingManager.addSaleWeight(autoAdd),
        renderSaleWeights: () => BillingManager.renderSaleWeights(),
        removeSaleWeight: (idx) => BillingManager.removeSaleWeight(idx),
        clearSaleWeights: () => BillingManager.clearSaleWeights(),
        addToSalesBill: (autoAdd) => BillingManager.addToSalesBill(autoAdd),
        renderSalesBill: () => BillingManager.renderSalesBill(),
        removeSalesItem: (idx) => BillingManager.removeSalesItem(idx),
        removeSaleItem: (idx) => BillingManager.removeSaleItem(idx),
        updateSalePaymentTotal: () => BillingManager.updateSalePaymentTotal(),
        fillSalePayableAmount: (type) => BillingManager.fillSalePayableAmount(type),
        fillReceivableAmount: (type) => BillingManager.fillReceivableAmount(type),
        putRestInDue: (mode) => BillingManager.putRestInDue(mode),
        completeSale: () => BillingManager.completeSale(),
        
        // Print bill (saves and prints; printing starts as soon as the save is issued)
        printBill: () => BillingManager.printBill(),
        
        // Mode toggle between Purchase and Sale
        switchMode: (mode, event) => BillingManager.switchMode(mode, event),
        
        // Contact picker
        pickContact: () => BillingManager.pickContact(),
        pickSaleContact: () => BillingManager.pickSaleContact(),
        
        // WhatsApp share
        shareWhatsApp: () => BillingManager.shareWhatsApp(),
        shareSaleWhatsApp: () => BillingManager.shareSaleWhatsApp(),
        
        // Sale methods
        printSale: () => BillingManager.printSale(),
        editSaleItem: (index) => BillingManager.editSaleItem(index),
        
        // Edit bill items
        editBillItem: (index) => BillingManager.editBillItem(index),
        
        // Draft management
        saveDraft: () => BillingManager.saveDraft(),
        showDrafts: () => BillingManager.showDrafts(),
        closeDrafts: () => BillingManager.closeDrafts(),
        loadDraft: (index) => BillingManager.loadDraft(index),
        deleteDraft: (index) => BillingManager.deleteDraft(index),
        clearBill: () => BillingManager.clearBill(),
        updateDraftCount: () => BillingManager.updateDraftCount(),
        
        // Auto-save management
        triggerAutoSave: () => BillingManager.triggerAutoSave(),
        checkAutoSave: () => BillingManager.checkAutoSave()
    },
    
    // Purchase (direct access to PurchaseManager)
    purchase: {
        addWeight: (autoAdd) => PurchaseManager.addWeight(autoAdd),
        renderWeights: () => PurchaseManager.renderWeights(),
        removeWeight: (idx) => PurchaseManager.removeWeight(idx),
        clearWeights: () => PurchaseManager.clearWeights(),
        addToBill: (autoAdd) => PurchaseManager.addToBill(autoAdd),
        renderBill: () => PurchaseManager.renderBill(),
        deleteBillItem: (idx) => PurchaseManager.deleteBillItem(idx),
        editBillItem: (idx) => PurchaseManager.editBillItem(idx),
        updateTotals: (heavy) => PurchaseManager.updateTotals(heavy),
        updatePaymentTotal: () => PurchaseManager.updatePaymentTotal(),
        fillPayableAmount: (type) => PurchaseManager.fillPayableAmount(type),
        saveBillToHistory: () => PurchaseManager.saveBillToHistory(),
        shareWhatsApp: () => PurchaseManager.shareWhatsApp(),
        getBillItems: () => PurchaseManager.getBillItems(),
        getWeights: () => PurchaseManager.getWeights(),
        clearBill: () => PurchaseManager.clearBill()
    },
    
    // Retail Sale (direct access to RetailSaleManager)
    retailSale: {
        addSaleWeight: (autoAdd) => RetailSaleManager.addSaleWeight(autoAdd),
        renderSaleWeights: () => RetailSaleManager.renderSaleWeights(),
        removeSaleWeight: (idx) => RetailSaleManager.removeSaleWeight(idx),
        clearSaleWeights: () => RetailSaleManager.clearSaleWeights(),
        addToSalesBill: (autoAdd) => RetailSaleManager.addToSalesBill(autoAdd),
        renderSalesBill: () => RetailSaleManager.renderSalesBill(),
        removeSaleItem: (idx) => RetailSaleManager.removeSaleItem(idx),
        editSaleItem: (idx) => RetailSaleManager.editSaleItem(idx),
        updateSaleTotals: () => RetailSaleManager.updateSaleTotals(),
        updateSaleRunningTotal: () => RetailSaleManager.updateSaleRunningTotal(),
        updateSalePaymentTotal: () => RetailSaleManager.updateSalePaymentTotal(),
        fillReceivableAmount: (type) => RetailSaleManager.fillReceivableAmount(type),
        completeSale: () => RetailSaleManager.completeSale(),
        shareSaleWhatsApp: () => RetailSaleManager.shareSaleWhatsApp(),
        printSale: () => RetailSaleManager.printSale(),
        pickSaleContact: () => RetailSaleManager.pickSaleContact(),
        getSaleItems: () => RetailSaleManager.getSaleItems(),
        getSaleWeights: () => RetailSaleManager.getSaleWeights(),
        clearSale: () => RetailSaleManager.clearSale()
    },
    
    // Printer
    printer: {
        scan: () => PrinterService.scanDevices(),
        connect: (deviceId, deviceName) => PrinterService.connect(deviceId, deviceName),
        disconnect: () => PrinterService.disconnect(),
        test: () => PrinterService.testPrint(),
        updateStatus: () => PrinterService.updateStatus(),
        print: (billData) => PrinterService.printBill(billData),
        printExpense: (expense) => PrinterService.printExpense(expense)
    },
    
    // Stock
    stock: {
        filterTab: (view, evt) => StockManager.filterStockTab(view, evt),
        render: () => StockManager.renderStock(),
        searchStock: () => StockManager.searchStock(),
        loadAdjustItemStock: () => StockManager.loadAdjustItemStock(),
        updateAdjustmentPlaceholder: () => StockManager.updateAdjustmentPlaceholder(),
        applyAdjustment: () => StockManager.applyStockAdjustment(),
        renderAdjustmentHistory: () => StockManager.renderAdjustmentHistory(),
        renderDeadStock: () => StockManager.renderDeadStock(),
        setDeadStockDays: (days) => StockManager.setDeadStockDays(days)
    },
    
    // Wholesale Sales
    wholesaleSales: {
        loadItemsDropdown: () => WholesaleSalesManager.loadItemsDropdown(),
        loadItemDetails: () => WholesaleSalesManager.loadItemDetails(),
        addToWholesaleBill: () => WholesaleSalesManager.addToWholesaleBill(),
        removeWholesaleItem: (index) => WholesaleSalesManager.removeWholesaleItem(index),
        completeSale: () => WholesaleSalesManager.completeSale(),
        printWholesaleSale: () => WholesaleSalesManager.printWholesaleSale(),
        shareViaWhatsApp: () => WholesaleSalesManager.shareViaWhatsApp(),
        filterTab: (view, evt) => WholesaleSalesManager.filterSalesTab(view, evt),
        renderHistory: () => WholesaleSalesManager.renderSalesHistory(),
        renderOutstanding: () => WholesaleSalesManager.renderSalesOutstanding(),
        recordPayment: (saleId) => WholesaleSalesManager.recordPayment(saleId),
        markSaleAsCleared: (saleId) => WholesaleSalesManager.markSaleAsCleared(saleId),
        reprintSale: (index) => WholesaleSalesManager.reprintSale(index),
        reprintSaleById: (saleId) => WholesaleSalesManager.reprintSaleById(saleId),
        updateProfitCalculation: () => WholesaleSalesManager.updateProfitCalculation(),
        updatePaymentTotal: () => WholesaleSalesManager.updatePaymentTotal(),
        fillReceivableAmount: (type) => WholesaleSalesManager.fillReceivableAmount(type),
        putRestInDue: () => WholesaleSalesManager.putRestInDue(),
        pickContact: () => WholesaleSalesManager.pickContact(),
        clearOutstandingParty: () => WholesaleSalesManager.clearOutstandingParty()
    },
    
    // History
    history: {
        saveBillToHistory: () => HistoryManager.saveBillToHistory(),
        render: () => HistoryManager.renderHistory(),
        // Re-render keeping the selected Purchase/Sale filter and search text (used by live sync)
        refresh: () => HistoryManager.refreshHistory(),
        viewBill: (index, type) => HistoryManager.viewBill(index, type),
        
        closeBillDetails: () => HistoryManager.closeBillDetails(),
        confirmDeleteBill: (index) => HistoryManager.confirmDeleteBill(index),
        deleteBill: (index) => HistoryManager.deleteBill(index),
        filterHistory: (type, event) => HistoryManager.filterHistory(type, event),
        searchHistory: (searchTerm) => HistoryManager.searchHistory(searchTerm),
        toggleView: () => HistoryManager.toggleView(),
        setDatePreset: (preset) => HistoryManager.setDatePreset(preset),
        setCustomRange: (from, to) => HistoryManager.setCustomRange(from, to),
        applyCustomRange: (from, to) => HistoryManager.applyCustomRange(from, to),
        reprintBill: () => HistoryManager.reprintBill(),
        shareBill: () => HistoryManager.shareBill(),
        editBillDetails: (billIndex) => {
            if (billIndex !== undefined) {
                // Pass the bill type along with index
                const billType = window.currentBillType || 'purchase';
                BillingManager.editBill(billIndex, billType);
            } else {
                UIManager.showToast(t('msg.app.bill_index_not_provided'));
            }
        }
    },
    
    // Outstanding
    outstanding: {
        filterDue: (filter, evt) => OutstandingManager.filterDue(filter, evt),
        render: () => OutstandingManager.renderDue(),
        renderDue: () => OutstandingManager.renderDue(),
        searchOutstanding: () => OutstandingManager.searchOutstanding(),
        recordPayment: (txnId, txnType) => OutstandingManager.recordPayment(txnId, txnType),
        markAsCleared: (txnId, txnType) => OutstandingManager.markAsCleared(txnId, txnType),
        showDetails: (txnId, txnType) => OutstandingManager.showDetails(txnId, txnType),
        setAgingBucket: (key) => OutstandingManager.setAgingBucket(key),
        setAgingSort: (by) => OutstandingManager.setAgingSort(by),
        setPartiesOpen: (open) => OutstandingManager.setPartiesOpen(open),
        sendReminder: (partyKey) => OutstandingManager.sendReminder(partyKey),
        printStatement: (partyKey) => OutstandingManager.printStatement(partyKey),
        clearPartyFilter: () => OutstandingManager.clearPartyFilter(),
        // Tap on a bill's "Already owes" line (#166); wholesale dues live on the Wholesale page
        showParty: (kind, name) => {
            const tab = kind === 'wholesale' ? 'wholesale-sales' : 'due';
            NavigationManager.setActiveNavLink(tab);
            NavigationManager.showTab(tab);
            if (kind === 'wholesale') WholesaleSalesManager.showOutstandingParty(name);
            else OutstandingManager.showParty(kind === 'purchase' ? 'purchase' : 'sale', name);
        }
    },
    
    // Reports
    reports: {
        filterTab: (view, evt) => ReportsManager.filterTab(view, evt),
        setDateFilter: (filter, evt) => ReportsManager.setDateFilter(filter, evt),
        applyCustomDateFilter: () => ReportsManager.applyCustomDateFilter(),
        renderReports: () => ReportsManager.renderReports(),
        renderReportsIfStale: () => ReportsManager.renderReportsIfStale(),
        applyFilters: () => ReportsManager.applyFilters(),
        exportCSV: () => ReportsManager.exportCSV(),
        exportPDF: () => ReportsManager.exportPDF()
    },
    
    // Expenses
    expenses: {
        filterExpenseTab: (view, evt) => ExpensesManager.filterExpenseTab(view, evt),
        saveBusinessExpense: () => ExpensesManager.saveBusinessExpense(),
        savePersonalExpense: () => ExpensesManager.savePersonalExpense(),
        renderHistory: () => ExpensesManager.renderexpensesHistory(),
        updateExpensePersonOptions: () => ExpensesManager.updateExpensePersonOptions(),
        saveAndPrintBusiness: () => ExpensesManager.saveAndPrintBusiness(),
        saveAndPrintPersonal: () => ExpensesManager.saveAndPrintPersonal(),
        viewExpenseDetails: (index, category) => ExpensesManager.viewExpenseDetails(index, category),
        closeExpenseDetails: () => ExpensesManager.closeExpenseDetails(),
        editExpenseFromModal: () => ExpensesManager.editExpenseFromModal(),
        confirmDeleteExpense: () => ExpensesManager.confirmDeleteExpense(),
        editExpense: (expenseId, category) => ExpensesManager.editExpense(expenseId, category),
        deleteExpense: (expenseId, category) => ExpensesManager.deleteExpense(expenseId, category)
    },
    
    // Finance
    finance: {
        filterTab: (view, evt) => FinanceManager.filterTab(view, evt),
        setDateFilter: (filter, evt) => FinanceManager.setDateFilter(filter, evt),
        applyCustomDateFilter: () => FinanceManager.applyCustomDateFilter(),
        renderDashboard: () => FinanceManager.renderDashboard(),
        renderAssets: () => FinanceManager.renderAssets(),
        renderWithdrawals: () => FinanceManager.renderWithdrawals(),
        recordWithdrawal: () => FinanceManager.recordWithdrawal(),
        toggleOtherPurpose: () => FinanceManager.toggleOtherPurpose(),
        showAddAccountModal: () => FinanceManager.showAddAccountModal(),
        closeAccountModal: () => FinanceManager.closeAccountModal(),
        saveNewAccount: () => FinanceManager.saveNewAccount(),
        quickAddAccount: (name, icon) => FinanceManager.quickAddAccount(name, icon),
        editAccount: (index) => FinanceManager.editAccount(index),
        closeEditAccountModal: () => FinanceManager.closeEditAccountModal(),
        updateAccount: () => FinanceManager.updateAccount(),
        deleteAccount: () => FinanceManager.deleteAccount(),
        init: () => FinanceManager.init()
    },
    
    // Analytics
    analytics: {
        init: () => AnalyticsManager.init(),
        renderAll: () => AnalyticsManager.renderAll(),
        showTab: (tab, evt) => AnalyticsManager.showTab(tab, evt),
        setProfitPeriod: (period, evt) => AnalyticsManager.setProfitPeriod(period, evt)
    },
    
    // Anomalies (#187, #40): Day report card on Today + Anomalies page
    anomalies: {
        init: () => AnomaliesManager.init(),
        openPage: () => AnomaliesManager.openPage(),
        applyFilters: () => AnomaliesManager.applyFilters(),
        showView: (view) => AnomaliesManager.showView(view),
        loadMore: () => AnomaliesManager.loadMore(),
        openRef: (id) => AnomaliesManager.openRef(id),
        review: (id, status) => AnomaliesManager.review(id, status),
        shareDayReport: () => AnomaliesManager.shareDayReport(),
        printDayReport: () => AnomaliesManager.printDayReport(),
        refreshNow: () => AnomaliesManager.refreshNow(),
        cashCloseLine: () => AnomaliesManager.cashCloseLine()
    },

    // Rate trends (#65): monthly rate history per item + seasonal estimate
    // App health / Test in Production (#217): owner/manager page + Today banner
    health: {
        init: () => HealthManager.init(),
        refresh: () => HealthManager.refresh(),
        openPage: () => HealthManager.openPage(),
        savePolicies: () => HealthManager.savePolicies()
    },

    rateTrends: {
        init: () => RateTrendsManager.init(),
        selectItem: (id) => RateTrendsManager.selectItem(id),
        setRange: (v) => RateTrendsManager.setRange(v),
        setPeriod: (v) => RateTrendsManager.setPeriod(v),
        setView: (v) => RateTrendsManager.setView(v),
        setWeeks: (v) => RateTrendsManager.setWeeks(v),
        setCompareKind: (v) => RateTrendsManager.setCompareKind(v),
        setBudget: (v) => RateTrendsManager.setBudget(v),
        startBackfill: () => RateTrendsManager.startBackfill(),
        continueBackfill: () => RateTrendsManager.continueBackfill(),
        setSection: (v) => RateTrendsManager.setSection(v),
        setTrafficMonth: (v) => RateTrendsManager.setTrafficMonth(v),
        setTrafficItem: (v) => RateTrendsManager.setTrafficItem(v),
        setTrafficWeeks: (v) => RateTrendsManager.setTrafficWeeks(v)
    },

    // Day (Today's Summary + Cash Management)
    day: {
        init: () => DayManager.init(),
        showSubTab: (tab) => DayManager.showSubTab(tab),
        loadTodayData: () => DayManager.loadTodayData(),
        filterTransactions: () => DayManager.filterTransactions()
    },
    
    // Cash Management
    cashManagement: {
        init: () => CashManagementManager.init(),
        signIn: () => CashManagementManager.signIn(),
        signOut: () => CashManagementManager.signOut(),
        recordTransaction: () => CashManagementManager.recordTransaction(),
        showDetails: (sessionDate) => CashManagementManager.showSessionDetails(sessionDate),
        recordLateCount: (sessionId) => CashManagementManager.recordLateCount(sessionId),
        loadTodaySession: () => CashManagementManager.loadTodaySession(),
        renderHistory: () => CashManagementManager.renderHistory(),
        calculateTodayTransactions: () => CashManagementManager.calculateTodayTransactions(),
        updateUI: () => CashManagementManager.updateUI()
    },
    
    // Sales (alias for wholesaleSales for easier access)
    sales: {
        loadItemsDropdown: () => WholesaleSalesManager.loadItemsDropdown(),
        loadItemDetails: () => WholesaleSalesManager.loadItemDetails(),
        renderHistory: () => WholesaleSalesManager.renderSalesHistory()
    },
    
    // Settings
    settings: {
        load: () => {
            AppUpdatesManager.renderSettings();
            SettingsManager.loadSettings();
            RolesAccessManager.render();
        },
        save: () => SettingsManager.saveSettings(),
        toggleDarkMode: () => SettingsManager.toggleDarkMode(),
        clearAllData: () => SettingsManager.clearAllData(),
        toggleBluetoothPrinter: () => SettingsManager.toggleBluetoothPrinter(),
        scanBluetoothDevices: () => SettingsManager.scanBluetoothDevices(),
        connectToPrinter: (id, name) => SettingsManager.connectToPrinter(id, name),
        disconnectPrinter: () => SettingsManager.disconnectPrinter(),
        updatePrinterStatus: () => SettingsManager.updatePrinterStatus(),
        testPrint: () => SettingsManager.testPrint(),
        loadAuditLogs: () => SettingsManager.loadAuditLogs(),
        filterAuditLogs: () => SettingsManager.filterAuditLogs(),
        loadStorageStats: () => SettingsManager.loadStorageStats()
    },

    // PWA install (Settings)
    install: {
        prompt: () => InstallManager.prompt(),
        refresh: () => InstallManager.refresh()
    },

    // Settings → Roles & access (owner, #84)
    roles: {
        render: () => RolesAccessManager.render(),
        save: () => RolesAccessManager.saveForm()
    },
    
    // Users
    users: {
        load: () => UsersManager.loadUsers(),
        approveUser: (userId, role) => UsersManager.approveUser(userId, role),
        rejectUser: (userId) => UsersManager.rejectUser(userId),
        showChangeRoleDialog: (userId, userName, currentRole) => UsersManager.showChangeRoleDialog(userId, userName, currentRole)
    },
    
    // Diagnostics (owner; managers see Number checks only)
    diagnostics: {
        init: () => DiagnosticsManager.init(),
        runNumberChecks: () => DiagnosticsManager.runNumberChecks(),
        showTab: (tab) => DiagnosticsManager.showTab(tab),
        loadData: () => DiagnosticsManager.loadData(),
        loadAuditLogs: () => DiagnosticsManager.loadAuditLogs(),
        filterByType: (type) => DiagnosticsManager.filterByType(type),
        filterAuditLogs: (action) => DiagnosticsManager.filterAuditLogs(action),
        deleteError: (errorId) => DiagnosticsManager.deleteError(errorId),
        clearAll: () => DiagnosticsManager.clearAll()
    },
    
    // Admin (owner only)
    admin: {
        init: () => AdminManager.init(),
        showTab: (tab) => AdminManager.showTab(tab),
        saveConfigure: () => AdminManager.saveConfigure(),
        saveCheckThresholds: () => AdminManager.saveCheckThresholds(),
        approveUser: (userId) => AdminManager.approveUser(userId),
        rejectUser: (userId) => AdminManager.rejectUser(userId),
        showChangeRole: (userId, userName, currentRole) => AdminManager.showChangeRole(userId, userName, currentRole),
        loadStorageStats: () => AdminManager.loadStorageStats(),
        clearAllData: () => AdminManager.clearAllData()
    },
    
    // What's new / update banner / share app
    updates: {
        showWhatsNew: () => AppUpdatesManager.showWhatsNew(),
        shareOnWhatsApp: () => AppUpdatesManager.shareOnWhatsApp(),
        shareNative: () => AppUpdatesManager.shareNative(),
        openDownloadPage: () => AppUpdatesManager.openDownloadPage()
    },

    // UI
    ui: {
        showLoading: () => UIManager.showLoading(),
        hideLoading: () => UIManager.hideLoading(),
        showToast: (msg, durationOrType, duration) => UIManager.showToast(msg, durationOrType, duration),
        showModal: (msg, title, showCancel) => UIManager.showModal(msg, title, showCancel),
        closeModal: (result) => UIManager.closeModal(result)
    }
};


