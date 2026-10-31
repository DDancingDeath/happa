# Web security: headers, CSP, script integrity, App Check (#89)

What the Hosting sites send, why, and what is still to do. Hosting headers apply
only to the web (`myhappa.web.app` and the PWA); the Android app serves `www/`
from inside the APK (Capacitor), so none of this reaches it.

## Headers (`firebase.json`)

Every site sends these on every path (the first `"source": "**"` entry):

| Header | Value | Why |
|---|---|---|
| `Strict-Transport-Security` | `max-age=31556926; includeSubDomains; preload` | HTTPS only (Hosting already sends the same value; `.app` is HSTS-preloaded anyway) |
| `X-Content-Type-Options` | `nosniff` | Files run only as their declared type |
| `X-Frame-Options` | `DENY` | No clickjacking: the app can't be put in a frame (old browsers) |
| `Content-Security-Policy` | `frame-ancestors 'none'` | The same for current browsers. This part is **enforced** (report-only ignores `frame-ancestors`) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Other sites see only `https://myhappa.web.app`, never a path |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=()` | The web app uses none of these (no barcode scanning, voice billing or location). Bluetooth is left alone: printing is native-only today, but a web printer would need it |

- The tenant link page (`/r/**`, `/r.html`) keeps its stricter
  `Referrer-Policy: no-referrer` (its entries come after the `**` one, and the
  page also has `<meta name="referrer" content="no-referrer">`), so the link's
  token never leaks.
- The redirect-only sites (`happaapp`, `happa-bfc07`) get the same headers from
  `scripts/happa-config.js` (`REDIRECT_SECURITY_HEADERS`; `npm run apply:happa-config`
  writes them) with an enforced `default-src 'none'`, since they only answer 301s.

## Content-Security-Policy (report-only)

The app site sends this as `Content-Security-Policy-Report-Only`: browsers log
what it *would* block (DevTools console, "[Report Only]") and block nothing.

```
default-src 'self';
script-src 'self' 'unsafe-inline' https://apis.google.com https://cdn.sheetjs.com;
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self' data:;
connect-src 'self' https://firestore.googleapis.com https://identitytoolkit.googleapis.com
            https://securetoken.googleapis.com https://firebaseinstallations.googleapis.com
            https://apis.google.com https://www.google.com https://api.github.com;
worker-src 'self'; manifest-src 'self'; frame-src https://happa-bfc07.firebaseapp.com;
object-src 'none'; base-uri 'self'; form-action 'self'
```

| Source | Used by |
|---|---|
| `'self'` | the app, templates, `changelog.json`, the vendored Firebase SDK, the service worker, `/download`, `/r/` |
| `https://cdn.sheetjs.com` (script) | Excel export (`ensureXLSX()`, pinned with SRI) |
| `firestore.googleapis.com` | Firestore SDK and the tenant page's single REST read |
| `identitytoolkit.googleapis.com`, `securetoken.googleapis.com` | Firebase Auth sign-in and token refresh |
| `apis.google.com` (script, connect), `www.google.com` (connect), `happa-bfc07.firebaseapp.com` (frame) | Firebase Auth (compat) on **phones** (and Safari) loads Google's `gapi` loader at start-up and frames `<authDomain>/__/auth/iframe` (its popup/redirect helper), even though the app only signs in with email + password. Found by the E2E phone runs. These scripts can't carry SRI; dropping them needs Auth without the popup/redirect resolver (modular SDK), a separate change |
| `firebaseinstallations.googleapis.com` | not called today; listed for the Firebase SDKs that use it (App Check, see below) |
| `api.github.com` | the "Update available" check |
| `data:` / `blob:` images | receipts and bill images drawn on a canvas, the inline favicon, downloads |
| `'unsafe-inline'` (script) | **temporary**: ~440 inline `onclick=`/`onchange=` handlers and 5 inline `<script>` blocks (`index.html`, `download.html`). Remove it in the "inline handlers" architecture phase, then switch to the enforcing header |
| `'unsafe-inline'` (style) | ~800 `style=` attributes and the `<style>` blocks in templates / `download.html` |

Links the app only opens (`wa.me`, `github.com`, its own address) are
navigation, which CSP does not cover.

**Keeping it right.** `tests/ci/security-headers.test.js` fails when a site loses
a header, or when code under `www/` names an `https://` origin that is neither
in the CSP nor in its short "only linked to" list. The E2E static server sends
the same `**` headers (plus the emulator ports in `connect-src` / `frame-src`), and the E2E
fixture fails on any CSP report, so every page × role is checked against the
policy on each PR. When you add a new external origin, add it to the CSP in
`firebase.json` in the same PR. `frame-src` must name the project's `authDomain`
(the test reads it from `www/firebaseConfig.js`), so a project change updates it too.

`tests/e2e/external-origins.spec.js` covers the two non-Firebase loads that no
page does on its own: the Excel export (real script load from `cdn.sheetjs.com`,
SRI checked) and the Android update check (`api.github.com`, answered by a route;
the CSP check runs in the browser before the request is routed).

**No field data.** The policy has no `report-uri` / `report-to`: the project is on
the Spark plan with no Cloud Functions or other server to receive reports. So
report-only mode tells us **nothing from real phones**; violations only show in
the DevTools console of whoever is looking. **E2E is the signal**: every page ×
role × language, `/download` and `/r/` run under this exact policy on each PR.
Gaps E2E can't see: browsers / WebViews other than Chromium, flows E2E doesn't
drive, and Google's own scripts changing what they load.

**Enforcing.** Switch `Content-Security-Policy-Report-Only` to
`Content-Security-Policy` only after the inline-handlers removal has taken
`'unsafe-inline'` out of `script-src` and E2E has been clean on it. Before that
switch, pick one:
1. add a free `report-to` collector (a hosted CSP-report service's free tier,
   with `report-uri` for older browsers) and run report-only in the field for
   a couple of weeks, checking it shows nothing new; or
2. rely on E2E plus the inline-handlers removal, and enforce with a quick
   rollback ready (one `firebase.json` header change, redeployed on merge).

## Script integrity (SRI)

- The Firebase SDK is self-hosted (`www/vendor/firebase/10.7.1/`, byte-identical
  to gstatic) and loaded with `integrity="sha384-…"`; `load-perf.test.js`
  checks the hashes.
- The only CDN script, SheetJS, is loaded on demand with a pinned version,
  `integrity` and `crossorigin="anonymous"` (`www/js/utils/lazy-scripts.js`).
- Everything else the app's own code loads is same-origin, so no further SRI
  work is needed. The one exception is not ours: on phones the Firebase Auth SDK
  itself injects Google's `gapi` loader from `apis.google.com` (versioned URLs,
  no SRI possible); see the CSP table.

## App Check: assessment (not enabled)

App Check makes Firestore and Auth accept requests only from the real app, so the
public web config can't be used from scripts (signup spam, quota burn).

| | Web (myhappa.web.app, PWA) | Android APK (Capacitor) |
|---|---|---|
| Provider | reCAPTCHA Enterprise (score based, invisible) | Play Integrity |
| Free quota | 10,000 assessments / month (per Cloud org); more needs a billing account (10k–100k: $8 flat; then $1 per 1,000) | 10,000 checks / day (standard) |
| Calls | one per App Check token; the token lives 1 h by default, can be set up to 7 days | one per token, same |
| Setup | reCAPTCHA Enterprise key for `myhappa.web.app` (+ preview hosts), vendor `firebase-app-check-compat.js` 10.7.1 with SRI, `firebase.appCheck().activate(...)` in `firebaseConfig.js` | The APK runs the **web** SDK in a WebView, which can't call Play Integrity: needs a native plugin (e.g. `@capacitor-firebase/app-check`) feeding a custom provider, and the app's SHA-256 (`HAPPA_CERT_SHA256`) registered |

Things that make it more than a switch:

1. **Tenant link page `/r/`** reads Firestore over REST with no SDK. With
   Firestore enforcement on, it would stop working unless it gets an App Check
   token (reCAPTCHA on that page, against its "tiny, no SDK" design) or the
   read moves behind something that has one.
2. **Old APKs** (no App Check) are refused the moment Firestore is enforced; wait
   until the APK with App Check is the one people run (update banner, `/download`).
3. **CSP**: add `https://content-firebaseappcheck.googleapis.com` (connect),
   `https://www.google.com` and `https://www.gstatic.com` (script, frame) for
   reCAPTCHA.
4. **Tests**: emulators don't check App Check; use the debug provider only on
   localhost / `?emulator=1`, never in production.

**Recommendation.** Do it as its own issue, in this order:
(1) owner: register the web app with reCAPTCHA Enterprise and the Android app
with Play Integrity in the Firebase console (owner action, free within the
quotas above at this shop's size; set the token TTL to ~12 h so a phone uses
about 2 assessments a day); (2) ship the SDK (web + native plugin) in
**monitor** mode (unenforced); (3) decide the tenant page path; (4) enforce Auth,
then Firestore, only when the App Check metrics show > 95% verified requests
for two weeks. Until then the Firestore rules remain the only data protection,
so rules stay the priority.

## Misuse review flags (#124)

On the free plan there is no server code, so each phone reports, and the owner's daily anomaly scan
(`modules/anomalies.js`, which already reads the audit log on the owner's phone) raises the flags
on Anomalies and the Today day report. No extra reads.

- **Refused writes**: `firebase/firestore-meter.js` sees every Firestore call; a `permission-denied`
  on a write emits `firestore:denied` and `services/security-monitor.js` writes a `PERMISSION_DENIED`
  audit entry with only the collection and operation (no data). At most one per kind and five per
  10 minutes per phone. Writes the app expects to be refused (the audit log itself, error reports, app
  health, the stock checkpoint's scan state) are not recorded. **Flag** `access-denied` (high): one
  person's refused changes reaching the limit in Settings › Aadhat › bill checks (default **3 within 10
  minutes**: `deniedCount`, `deniedWindowMin`).
- **New phone**: at start-up the app compares this phone's id (the App health device id) with
  `users/{uid}.devices` (up to 10, the person's own field). A known phone writes nothing. The first
  phone ever is remembered without a flag; any later new phone writes `NEW_DEVICE`. **Flag**
  `new-device` (low).
- **Old bills**: when someone other than the owner tries to change or void a bill the app refuses
  because its edit window has passed, `OLD_BILL_EDIT_TRY`. **Flag** `old-bill-edit-try` (medium).
  (Edits the rules refuse are refused writes, above.)

These entries come from the person's own app, so a modified app can leave them out: they are review
hints. The rules remain the protection.
