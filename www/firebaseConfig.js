// Firebase Configuration and Initialization
// This file will be loaded after Firebase SDK scripts in index.html

// IMPORTANT: For production deployments, consider:
// 1. Restricting API key in Firebase Console (Application restrictions)
// 2. Setting up HTTP referrer restrictions
// 3. Using Firebase App Check for additional security

// =============================================================================
// ENVIRONMENT CONFIGURATION
// =============================================================================
// Set to 'development' for local testing with dummy data
// Set to 'production' for live app with real data
// 
// Option 1: Use URL parameter: ?env=development
// Option 2: Use localStorage: localStorage.setItem('appEnv', 'development')
// Option 3: Automatic: localhost and Firebase preview channels (host contains
//           "--") = development (dev_ collections), otherwise = production.
//           On a preview channel ?prod=1 shows live data.
// Note: dev_ collections still live in the production project and count
// against its quota (far less than live data); #35 tracks a separate project.
// =============================================================================

// --- env-detect (#194; unit-tested by quota-guards.test.js) ---
// Firebase Hosting preview channels are served from <site>--<channel>-<hash>.web.app.
const isPreviewHost = (hostname) => /--/.test(hostname) && /\.(web\.app|firebaseapp\.com)$/i.test(hostname);

// Check environment from multiple sources
const getEnvironment = (loc = window.location, store = localStorage, isNative = !!window.Capacitor?.isNativePlatform?.()) => {
  const urlParams = new URLSearchParams(loc.search);
  // 1. URL parameter (highest priority for quick testing)
  if (urlParams.get('env')) return urlParams.get('env');

  // 2. Preview channel explicitly pointed at live data
  const preview = isPreviewHost(loc.hostname);
  if (preview && urlParams.get('prod') === '1') return 'production';

  // 3. localStorage (persists across sessions)
  if (store.getItem('appEnv')) return store.getItem('appEnv');

  // 4. localhost in a BROWSER (not the Capacitor app, which runs from capacitor:// or file://)
  const isCapacitorApp = loc.protocol === 'capacitor:' || loc.protocol === 'file:' || isNative;
  if (!isCapacitorApp && (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1')) {
    return 'development';
  }

  // 5. Preview channels use test (dev_) data so testing never spends the live
  //    data's read quota on real history (#194). Add ?prod=1 to see live data.
  if (preview) return 'development';

  // 6. Default to production (including Capacitor apps)
  return 'production';
};
// --- end env-detect ---

const APP_ENV = getEnvironment();

// Collection prefix based on environment
// Production: 'items', 'purchases', etc.
// Development: 'dev_items', 'dev_purchases', etc.
const COLLECTION_PREFIX = APP_ENV === 'production' ? '' : 'dev_';

// All collections are now prefixed in dev mode (no shared collections)
// This keeps dev and prod data completely separate

console.log(`🔧 App Environment: ${APP_ENV} | Collection Prefix: "${COLLECTION_PREFIX}"`);

// Single Firebase Config (same project for both environments), from happa.config.json
// <happa-config>
const firebaseConfig = {
  "apiKey": "AIzaSyDRSZiNfMAwU9jDfFnHf3zldvT6lUZEUtg",
  "authDomain": "happa-bfc07.firebaseapp.com",
  "projectId": "happa-bfc07",
  "storageBucket": "happa-bfc07.firebasestorage.app",
  "messagingSenderId": "516108799937",
  "appId": "1:516108799937:web:a4e3fdbff054b9cc07a940",
  "measurementId": "G-1514HNS14K"
};
// </happa-config>

// Expose environment globally
window.APP_ENV = APP_ENV;
window.COLLECTION_PREFIX = COLLECTION_PREFIX;

// Helper function to get prefixed collection name
window.getCollection = (name) => COLLECTION_PREFIX + name;

// Show environment indicator in UI (development and every preview channel)
const IS_PREVIEW_HOST = isPreviewHost(window.location.hostname);
window.IS_PREVIEW_HOST = IS_PREVIEW_HOST;
if (APP_ENV !== 'production' || IS_PREVIEW_HOST) {
  document.addEventListener('DOMContentLoaded', () => {
    const indicator = document.createElement('div');
    indicator.id = 'env-indicator';
    if (IS_PREVIEW_HOST) {
      indicator.textContent = APP_ENV === 'production' ? 'PREVIEW — LIVE data' : 'PREVIEW — test data';
    } else {
      indicator.textContent = `🔧 ${APP_ENV.toUpperCase()}`;
    }
    indicator.style.cssText = `
      position: fixed;
      top: 0;
      left: 50%;
      transform: translateX(-50%);
      background: ${IS_PREVIEW_HOST && APP_ENV === 'production' ? '#c62828' : '#ff6b35'};
      color: white;
      padding: 2px 12px;
      font-size: 10px;
      font-weight: bold;
      z-index: 99999;
      border-radius: 0 0 4px 4px;
    `;
    document.body.appendChild(indicator);
  });
}

// Firebase SDK health check (#28). The SDK is self-hosted and precached; if it
// still did not run (first open with no network, or a corrupt cached copy that
// SRI rejected), drop the cached SDK files and reload once so they are fetched
// again. If that already happened this session, show a message, not a blank page.
if (typeof firebase === 'undefined' || typeof firebase.auth !== 'function' || typeof firebase.firestore !== 'function') {
  const SDK_RETRY_KEY = 'aadhatSdkRetry';
  let retried = false;
  try { retried = sessionStorage.getItem(SDK_RETRY_KEY) === '1'; } catch (_) {}
  if (!retried && window.caches) {
    try { sessionStorage.setItem(SDK_RETRY_KEY, '1'); } catch (_) {}
    window.__aadhatSdkRecovery = caches.keys()
      .then((names) => Promise.all(names.map((name) => caches.open(name).then((cache) =>
        cache.keys().then((reqs) => Promise.all(reqs
          .filter((req) => req.url.includes('/vendor/firebase/'))
          .map((req) => cache.delete(req))))))))
      .catch(() => {})
      .then(() => window.location.reload());
  } else {
    const msg = document.createElement('div');
    msg.id = 'sdkLoadError';
    msg.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;' +
      'padding:24px;text-align:center;background:#fff;color:#333;font:16px/1.5 Arial,sans-serif;';
    msg.textContent = 'App could not start. Please connect to the internet once and reopen. / ' +
      'ऐप शुरू नहीं हो सका। एक बार इंटरनेट से जुड़कर फिर खोलें।';
    document.body.appendChild(msg);
  }
  throw new Error('Firebase SDK failed to load');
}
try { sessionStorage.removeItem('aadhatSdkRetry'); } catch (_) {}

// Initialize Firebase
//
// IMPORTANT: variable is intentionally NOT named `app`. A `let app`
// declared at the top level of a classic <script> creates a binding in
// the global lexical environment that SHADOWS `window.app` for inline
// event handlers (`onclick="app.x()"`) — even though it is not visible
// as a `window.app` property in DevTools. That broke every
// `onclick="app.chat.X()"` button in www/templates/chat.html: the AI
// Assistant Send button silently threw `Cannot read properties of
// undefined (reading 'sendFromInput')` because inline handlers
// resolved `app` to *this* Firebase App instance instead of the
// application's `window.app` object.
//
// Found via Playwright interaction-driver in the staging clone repo
// (DDancingDeath/AadhatManagementApp-staging). Full RCA in that repo's
// docs/REVIEW_ISSUES.md → STG-WALK-5.
let firebaseApp;
try {
  firebaseApp = firebase.initializeApp(firebaseConfig);
} catch (error) {
  if (error.code === 'app/duplicate-app') {
    firebaseApp = firebase.app();
  } else {
    console.error('Firebase initialization error:', error);
    throw error;
  }
}

// Initialize Firebase Authentication
// Not named `auth`/`db`: top-level let/const in this classic script would shadow
// window.auth / window.db (same bug class as `app` above; static-guards.test.js).
const firebaseAuth = firebase.auth();

// Initialize Cloud Firestore
const firestoreDb = firebase.firestore();

// Local testing against the Firebase emulators: only on localhost with ?emulator=1
// (ports match firebase.json "emulators"). Never active in production or the APK.
if (['localhost', '127.0.0.1'].includes(window.location.hostname) &&
    new URLSearchParams(window.location.search).get('emulator') === '1') {
  firebaseAuth.useEmulator('http://127.0.0.1:9099', { disableWarnings: true });
  firestoreDb.useEmulator('127.0.0.1', 8181);
  console.log('🧪 Using Firebase emulators (auth:9099, firestore:8181)');
}

// Enable offline persistence (Note: Using compat API for simplicity)
firestoreDb.enablePersistence({ synchronizeTabs: true })
  .catch((err) => {
    if (err.code === 'failed-precondition') {
      console.warn('Multiple tabs open, persistence can only be enabled in one tab at a time.');
    } else if (err.code === 'unimplemented') {
      console.warn('The current browser does not support offline persistence');
    }
  });

// Expose db globally for modules that need it
window.db = firestoreDb;
window.auth = firebaseAuth;
