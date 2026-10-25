/**
 * Service Worker for Happa
 * Provides offline functionality and caching
 */

const CACHE_NAME = 'happa-v19';
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
    '/css/analytics.css',
    '/css/anomalies.css',
    '/css/app-updates.css',
    '/css/auth.css',
    '/css/bill-checks.css',
    '/css/billing.css',
    '/css/buttons.css',
    '/css/charts.css',
    '/css/datefilter.css',
    '/css/day.css',
    '/css/desktop.css',
    '/css/finance.css',
    '/css/health.css',
    '/css/hamburger.css',
    '/css/history.css',
    '/css/outstanding.css',
    '/css/items.css',
    '/css/loading.css',
    '/css/navigation.css',
    '/css/notifications.css',
    '/css/overlay.css',
    '/css/rate-trends.css',
    '/css/reports.css',
    '/css/settings.css',
    '/css/stock.css',
    '/css/tables.css',
    '/css/tabs.css',
    '/css/toast.css',
    '/css/totals.css',
    '/css/variables.css',
    '/js/auth/authentication.js',
    '/js/firebase/firestore-service.js',
    '/js/firebase/firestore-meter.js',
    '/js/main.js',
    '/js/modules/admin.js',
    '/js/modules/anomalies.js',
    '/js/modules/analytics.js',
    '/js/modules/app-updates.js',
    '/js/modules/billing.js',
    '/js/modules/cash-management.js',
    '/js/modules/day.js',
    '/js/modules/diagnostics.js',
    '/js/modules/finance.js',
    '/js/modules/health.js',
    '/js/modules/history.js',
    '/js/modules/items.js',
    '/js/modules/miscellaneous.js',
    '/js/modules/notifications.js',
    '/js/modules/outstanding.js',
    '/js/modules/purchase.js',
    '/js/modules/rate-trends.js',
    '/js/modules/roles-access.js',
    '/js/modules/reports.js',
    '/js/modules/retail-sale.js',
    '/js/modules/settings.js',
    '/js/modules/stock.js',
    '/js/modules/users.js',
    '/js/modules/wholesale-sales.js',
    '/js/services/audit.js',
    '/js/services/install-prompt.js',
    '/js/services/printer.js',
    '/js/services/telemetry.js',
    '/js/ui/bill-highlight.js',
    '/js/ui/party-due-line.js',
    '/js/ui/infinite-scroll.js',
    '/js/ui/finance-breakdown-sheet.js',
    '/js/ui/navigation.js',
    '/js/ui/heading-emoji.js',
    '/js/ui/scroll-cue.js',
    '/js/ui/ui-manager.js',
    '/js/i18n/index.js',
    '/js/i18n/en.js',
    '/js/i18n/hi.js',
    '/js/i18n/localize.js',
    '/js/utils/bill-checks.js',
    '/js/utils/bill-share.js',
    '/js/utils/aging.js',
    '/js/utils/anomalies.js',
    '/js/utils/party-due.js',
    '/js/utils/due-reminder.js',
    '/js/utils/open-external.js',
    '/js/utils/cash-session.js',
    '/js/utils/constants.js',
    '/js/utils/data-export.js',
    '/js/utils/dates.js',
    '/js/utils/due-payments.js',
    '/js/utils/helpers.js',
    '/js/utils/history-filters.js',
    '/js/utils/history-range.js',
    '/js/utils/quota-guard.js',
    '/js/utils/rebuild-lease.js',
    '/js/utils/background-tasks.js',
    '/js/utils/history-window.js',
    '/js/utils/item-catalog.js',
    '/js/utils/keyboard-shortcuts.js',
    '/js/utils/lazy-scripts.js',
    '/js/utils/money.js',
    '/js/utils/number-checks.js',
    '/js/utils/notification-format.js',
    '/js/utils/record-permissions.js',
    '/js/utils/role-access.js',
    '/js/utils/release-info.js',
    '/js/config/app-identity.js',
    '/js/utils/render-memo.js',
    '/js/utils/startup-timings.js',
    '/js/utils/state.js',
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
    '/js/tip/tip.js',
    '/js/tip/index.js',
    '/js/tip/report.js',
    '/js/tip/health-stats.js',
    '/js/tip/scenarios/app-start.js',
    '/js/tip/scenarios/bill-save.js',
    '/js/tip/scenarios/payment-record.js',
    '/js/tip/scenarios/cash-close.js',
    '/js/version.js',
    '/templates/admin.html',
    '/templates/analytics.html',
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
    '/templates/finance.html',
    '/templates/health.html',
    '/templates/history.html',
    '/templates/items.html',
    '/templates/modals.html',
    '/templates/navigation.html',
    '/templates/reports.html',
    '/templates/settings.html',
    '/templates/stock.html',
    '/templates/users.html',
    '/templates/wholesale-sales.html',
    '/vendor/firebase/10.7.1/firebase-app-compat.js',
    '/vendor/firebase/10.7.1/firebase-auth-compat.js',
    '/vendor/firebase/10.7.1/firebase-firestore-compat.js'
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
                return Promise.all(STATIC_ASSETS.map((url) =>
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
    
    // For static assets - cache first, then network
    event.respondWith(
        caches.match(event.request)
            .then((cachedResponse) => {
                // A non-OK entry (e.g. a stored error page) is treated as a
                // miss so it gets refetched instead of replayed forever.
                if (cachedResponse && cachedResponse.ok) {
                    // Return cached version and update cache in background
                    event.waitUntil(
                        fetch(event.request)
                            .then((response) => {
                                if (response.ok) {
                                    caches.open(CACHE_NAME)
                                        .then((cache) => cache.put(event.request, response));
                                }
                            })
                            .catch(() => {})
                    );
                    return cachedResponse;
                }
                
                // Not in cache - fetch from network
                return fetch(event.request)
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
