/**
 * Service Worker for Happa
 * Provides offline functionality and caching
 */

const CACHE_NAME = 'happa-v384';
// Generated/verified by scripts/check-sw-assets.js (npm run check:sw).
// Every entry must exist: a 404 here used to make the whole precache fail.
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/firebaseConfig.js',
    '/download.html',
    '/changelog.json',
    '/img/download-qr.svg',
    '/manifest.webmanifest',
    '/icons/apple-touch-icon.png',
    '/icons/favicon-32.png',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/icons/icon-maskable-512.png',
    '/css/app.css',
    '/css/rentals.css',
    '/js/auth/authentication.js',
    '/js/firebase/firestore-service.js',
    '/js/firebase/firestore-meter.js',
    '/js/firebase/db.js',
    '/js/firebase/core/reads.js',
    '/js/firebase/core/write-settle.js',
    '/js/firebase/repos/anomalies.js',
    '/js/firebase/repos/audit-logs.js',
    '/js/firebase/repos/bill-drafts.js',
    '/js/firebase/repos/bill-payments.js',
    '/js/firebase/repos/bill-stats.js',
    '/js/firebase/repos/cash-days.js',
    '/js/firebase/repos/cash-sessions.js',
    '/js/firebase/repos/collection-admin.js',
    '/js/firebase/repos/counters.js',
    '/js/firebase/repos/items.js',
    '/js/firebase/repos/notifications.js',
    '/js/firebase/repos/settings.js',
    '/js/firebase/repos/telemetry.js',
    '/js/firebase/repos/tip-health.js',
    '/js/firebase/repos/user-profiles.js',
    '/js/firebase/repos/users.js',
    '/js/firebase/repos/worth-accounts.js',
    '/js/main.js',
    '/js/modules/admin.js',
    '/js/modules/anomalies.js',
    '/js/modules/app-updates.js',
    '/js/modules/billing.js',
    '/js/modules/cash-management.js',
    '/js/modules/day.js',
    '/js/modules/diagnostics.js',
    '/js/modules/health.js',
    '/js/modules/history.js',
    '/js/modules/items.js',
    '/js/modules/miscellaneous.js',
    '/js/modules/notifications.js',
    '/js/modules/outstanding.js',
    '/js/modules/purchase.js',
    '/js/modules/rate-trends.js',
    '/js/modules/roles-access.js',
    '/js/modules/retail-sale.js',
    '/js/modules/settings.js',
    '/js/modules/stock.js',
    '/js/modules/wholesale-sales.js',
    '/js/modules/money.js',
    '/js/modules/insights.js',
    '/js/modules/statements.js',
    '/js/rentals/rent-math.js',
    '/js/rentals/rent-public.js',
    '/js/rentals/rent-settings.js',
    '/js/rentals/rent-store.js',
    '/js/rentals/rent-views.js',
    '/js/rentals/rentals.js',
    '/js/services/audit.js',
    '/js/services/exporter.js',
    '/js/services/install-prompt.js',
    '/js/services/printer.js',
    '/js/services/printer-link.js',
    '/js/services/telemetry.js',
    '/js/services/user-admin.js',
    '/js/ui/bill-highlight.js',
    '/js/ui/bill-row.js',
    '/js/ui/bill-status.js',
    '/js/ui/bill-date-input.js',
    '/js/ui/business-switcher.js',
    '/js/ui/party-due-line.js',
    '/js/ui/infinite-scroll.js',
    '/js/ui/finance-breakdown-sheet.js',
    '/js/ui/navigation.js',
    '/js/ui/bottom-nav.js',
    '/js/ui/heading-emoji.js',
    '/js/ui/scroll-cue.js',
    '/js/ui/sync-status.js',
    '/js/ui/ui-manager.js',
    '/js/ui/voice-mic.js',
    '/js/modules/voice-billing.js',
    '/js/utils/voice-parse.js',
    '/js/i18n/index.js',
    '/js/i18n/en.js',
    '/js/i18n/hi.js',
    '/js/i18n/localize.js',
    '/js/utils/bill-checks.js',
    '/js/utils/bill-share.js',
    '/js/utils/bill-edits.js',
    '/js/utils/aging.js',
    '/js/utils/anomalies.js',
    '/js/utils/party-due.js',
    '/js/utils/due-reminder.js',
    '/js/utils/open-external.js',
    '/js/utils/cash-session.js',
    '/js/utils/clock-skew.js',
    '/js/utils/constants.js',
    '/js/utils/data-export.js',
    '/js/utils/dates.js',
    '/js/utils/due-payments.js',
    '/js/utils/events.js',
    '/js/utils/helpers.js',
    '/js/utils/history-filters.js',
    '/js/utils/history-range.js',
    '/js/utils/quota-guard.js',
    '/js/utils/rebuild-lease.js',
    '/js/utils/background-tasks.js',
    '/js/utils/history-window.js',
    '/js/utils/item-catalog.js',
    '/js/utils/item-name-autofill.js',
    '/js/utils/write-conflict.js',
    '/js/utils/keyboard-shortcuts.js',
    '/js/utils/lazy-scripts.js',
    '/js/utils/money.js',
    '/js/utils/print-status.js',
    '/js/utils/user-activity.js',
    '/js/utils/reminders.js',
    '/js/utils/perf-probe.js',
    '/js/utils/status-report.js',
    '/js/utils/usage-stats.js',
    '/js/services/usage.js',
    '/js/ui/usage-view.js',
    '/js/utils/printer-settings.js',
    '/js/utils/qr-code.js',
    '/js/utils/labour.js',
    '/js/utils/launch-shortcut.js',
    '/js/utils/calc/billing.js',
    '/js/utils/calc/today.js',
    '/js/utils/calc/stock.js',
    '/js/utils/calc/cash.js',
    '/js/utils/number-checks.js',
    '/js/utils/number-check-flags.js',
    '/js/utils/notification-format.js',
    '/js/utils/record-permissions.js',
    '/js/utils/role-access.js',
    '/js/utils/personal-expenses.js',
    '/js/utils/expense-entry.js',
    '/js/utils/expense-list.js',
    '/js/utils/bill-date.js',
    '/js/utils/settings-sections.js',
    '/js/utils/release-info.js',
    '/js/config/app-identity.js',
    '/js/utils/render-memo.js',
    '/js/utils/startup-timings.js',
    '/js/utils/storage-full.js',
    '/js/utils/state.js',
    '/js/utils/security-flags.js',
    '/js/services/security-monitor.js',
    '/js/utils/scrub.js',
    '/js/utils/export-stamp.js',
    '/js/utils/error-report.js',
    '/js/utils/audit-changes.js',
    '/js/utils/login-backoff.js',
    '/js/utils/team-directory.js',
    '/js/utils/stock-adjust.js',
    '/js/utils/dead-stock.js',
    '/js/utils/item-rate-series.js',
    '/js/utils/product-traffic.js',
    '/js/utils/rate-history.js',
    '/js/utils/rate-trends.js',
    '/js/utils/stock-check.js',
    '/js/utils/stock-replay.js',
    '/js/utils/finance-calc.js',
    '/js/utils/finance-breakdown.js',
    '/js/utils/template-loader.js',
    '/js/utils/validator.js',
    '/js/utils/chart-scale.js',
    '/js/utils/business-metrics.js',
    '/js/utils/insights-config.js',
    '/js/utils/metric-registry.js',
    '/js/utils/month-snapshots.js',
    '/js/utils/takeaways.js',
    '/js/utils/insights-context.js',
    '/js/utils/statements.js',
    '/js/tip/tip.js',
    '/js/tip/index.js',
    '/js/tip/report.js',
    '/js/tip/health-stats.js',
    '/js/tip/scenarios/app-start.js',
    '/js/tip/scenarios/bill-save.js',
    '/js/tip/scenarios/payment-record.js',
    '/js/tip/scenarios/cash-close.js',
    '/js/tip/scenarios/session-reads.js',
    '/js/tip/scenarios/print.js',
    '/js/tip/scenarios/sync.js',
    '/js/tip/scenarios/stock-checkpoint.js',
    '/js/tip/scenarios/number-checks.js',
    '/js/version.js',
    '/templates/admin.html',
    '/templates/anomalies.html',
    '/templates/auth.html',
    '/templates/billing.html',
    '/templates/cash-management.html',
    '/templates/chat.html',
    '/templates/day.html',
    '/templates/diagnostics.html',
    '/templates/due.html',
    '/templates/expenses.html',
    '/templates/rate-trends.html',
    '/templates/rentals.html',
    '/templates/health.html',
    '/templates/history.html',
    '/templates/items.html',
    '/templates/modals.html',
    '/templates/navigation.html',
    '/templates/settings.html',
    '/templates/stock.html',
    '/templates/wholesale-sales.html',
    '/templates/money.html',
    '/templates/insights.html',
    '/templates/statements.html',
    '/vendor/firebase/10.7.1/firebase-app-compat.js',
    '/vendor/firebase/10.7.1/firebase-auth-compat.js',
    '/vendor/firebase/10.7.1/firebase-firestore-compat.js'
];
// Loaded with import() only when used (rent receipts, unit picker, tenant link actions, deposits, expenses), so not in
// the precache budget; install also caches them, best effort, so this version's copies (matching
// the precached files) are there offline right after a deploy.
const LAZY_ASSETS = [
    '/css/rent-receipt.css',
    '/js/rentals/rent-deposit.js',
    '/js/rentals/rent-deposit-store.js',
    '/js/rentals/rent-expense.js',
    '/js/rentals/rent-expense-store.js',
    '/js/rentals/rent-link.js',
    '/js/rentals/rent-math-ledger.js',
    '/js/rentals/rent-receipt.js',
    '/js/rentals/rent-receipt-store.js',
    '/js/rentals/rent-unit.js'
];

/**
 * Install event - cache static assets
 */
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[SW] Caching static assets');
                // Cache each asset individually so one failing URL can't abort
                // the whole precache (cache.addAll is all-or-nothing).
                // cache:'reload' bypasses the HTTP cache so a new SW version
                // doesn't precache stale copies.
                return Promise.all([...STATIC_ASSETS, ...LAZY_ASSETS].map((url) =>
                    cache.add(new Request(url, { cache: 'reload' }))
                        .catch((error) => console.warn('[SW] Failed to precache', url, error))
                ));
            })
            .then(() => self.skipWaiting())
            .catch((error) => {
                console.error('[SW] Failed to cache:', error);
            })
    );
});

/**
 * Allow the page to ask us to take over immediately, so a freshly-installed
 * SW does not have to wait for all tabs to close before activating. Paired
 * with the controllerchange auto-reload in index.html.
 */
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

/**
 * Activate event - clean up old caches
 */
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames
                        .filter((name) => name !== CACHE_NAME)
                        .map((name) => {
                            console.log('[SW] Deleting old cache:', name);
                            return caches.delete(name);
                        })
                );
            })
            .then(() => self.clients.claim())
    );
});

/**
 * Fetch event - serve from cache, fallback to network
 * Strategy:
 *   - index.html (the navigation document) is fetched NETWORK-FIRST so the
 *     latest cache-buster query strings in <script> / <link> tags reach the
 *     browser on first reload after a deploy. Without this, the user has to
 *     reload twice to see new code (the SW serves a stale index.html on the
 *     first reload, which references the stale main.js URL).
 *   - All other static assets are cache-first with background refresh.
 *   - Cross-origin requests (CDNs, Firebase/external APIs) bypass the SW entirely.
 */
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // The tenant rent-history page (/r/<token>) is not part of the app: never
    // serve it from (or store it in) the app cache, and never fall back to the app.
    if (url.pathname === '/r.html' || url.pathname.startsWith('/r/')) {
        return;
    }
    
    // Skip non-GET requests
    if (event.request.method !== 'GET') {
        return;
    }
    
    // Only handle (and cache) same-origin requests. Third-party responses
    // (CDN libraries, Firebase/Google APIs) always go to the network so the SW
    // never stores or replays cross-origin content.
    if (url.origin !== self.location.origin) {
        return;
    }

    // Skip Firebase/external API requests - always go to network
    if (url.hostname.includes('firebase') || 
        url.hostname.includes('googleapis') ||
        url.hostname.includes('gstatic')) {
        return;
    }

    // Treat navigation requests and explicit index.html requests as
    // network-first so post-deploy cache-busters take effect immediately.
    const isNavigation = event.request.mode === 'navigate'
        || url.pathname === '/'
        || url.pathname === '/index.html';
    // changelog.json drives "What's new" and the download page: network-first
    // so a new release's notes are never hidden behind a stale cached copy.
    if (isNavigation || url.pathname === '/changelog.json') {
        const isDownloadPage = url.pathname === '/download' || url.pathname === '/download.html';
        const fallback = isDownloadPage ? '/download.html' : '/index.html';
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    if (response && response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
                    }
                    return response;
                })
                .catch(() => caches.match(event.request).then((cached) => {
                    if (cached || !isNavigation) return cached || new Response('', { status: 504, statusText: 'Offline' });
                    return caches.match(fallback);
                }))
        );
        return;
    }
    
    // For static assets - cache first, then network. A deploy changes
    // CACHE_NAME and precaches every file again, so a cached copy is never
    // out of date: no background re-download on every open (#59).
    event.respondWith(
        caches.match(event.request)
            .then((cachedResponse) => {
                // A non-OK entry (e.g. a stored error page) is treated as a
                // miss so it gets refetched instead of replayed forever.
                if (cachedResponse && cachedResponse.ok) {
                    return cachedResponse;
                }
                
                // Not in cache - fetch from network (revalidated: the HTTP cache
                // may still hold the previous deploy's copy, and it would stay
                // in this cache until the next deploy)
                return fetch(event.request, { cache: 'no-cache' })
                    .then((response) => {
                        // Cache successful responses
                        if (response.ok) {
                            const responseClone = response.clone();
                            caches.open(CACHE_NAME)
                                .then((cache) => cache.put(event.request, responseClone));
                        }
                        return response;
                    })
                    .catch(() => {
                        // Offline fallback for HTML pages
                        if (event.request.headers.get('accept')?.includes('text/html')) {
                            return caches.match('/index.html');
                        }
                        // Offline: assets are requested with ?v= cache-busters but
                        // precached without them, so retry ignoring the query.
                        return caches.match(event.request, { ignoreSearch: true })
                            .then((cached) => cached || new Response('', { status: 404, statusText: 'Not Found' }));
                    });
            })
            .catch(() => {
                // Fallback if cache match fails
                return new Response('', { status: 500, statusText: 'Service Worker Error' });
            })
    );
});

/**
 * Background sync for offline data
 */
self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-data') {
        event.waitUntil(syncOfflineData());
    }
});

/**
 * Sync offline data when back online
 */
async function syncOfflineData() {
    // This will be called when the app comes back online
    // The main app handles syncing through Firebase's real-time listeners
    console.log('[SW] Syncing offline data...');
}
