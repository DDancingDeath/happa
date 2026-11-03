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
| `Content-Security-Policy` | the enforced policy below, ending in `frame-ancestors 'none'` | The same for current browsers (the redirect-only sites send `default-src 'none'; frame-ancestors 'none'; base-uri 'none'`) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Other sites see only `https://myhappa.web.app`, never a path |
| `Permissions-Policy` | `camera=(), microphone=(self), geolocation=(), payment=(), usb=(), serial=(), hid=()` | The web app uses none of these except the microphone, for its own pages only: voice billing (#81, `docs/voice-billing.md`) is off by default and asks for the microphone only when a user switches it on and taps 🎤 (the browser then asks once per site). Frames and other sites get no microphone. The redirect-only sites and the tenant link page keep `microphone=()`. Bluetooth is left alone: printing is native-only today, but a web printer would need it |

- The tenant link page (`/r/**`, `/r.html`) keeps its stricter
  `Referrer-Policy: no-referrer` (its entries come after the `**` one, and the
  page also has `<meta name="referrer" content="no-referrer">`), so the link's
  token never leaks.
- The tenant link page also sends `Permissions-Policy` with every feature off,
  microphone included (its entries come after `**`, so they win there).
- **Privacy (voice billing):** voice audio goes to the phone's speech service
  (Google on most phones; Chrome's on the web), which turns it into text. The app keeps
  no audio and no text. The in-app notice is the Settings › Voice billing hint (en/hi).
- The redirect-only sites (`happaapp`, `happa-bfc07`) get the same headers from
  `scripts/happa-config.js` (`REDIRECT_SECURITY_HEADERS`; `npm run apply:happa-config`
  writes them) with an enforced `default-src 'none'`, since they only answer 301s.

## Content-Security-Policy (enforced)

The app site sends this as `Content-Security-Policy` (enforced since the inline
handlers and inline `<script>` blocks were removed; before that it was report-only):

```
default-src 'self';
script-src 'self' https://apis.google.com https://cdn.sheetjs.com;
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self' data:;
connect-src 'self' https://firestore.googleapis.com https://identitytoolkit.googleapis.com
            https://securetoken.googleapis.com https://firebaseinstallations.googleapis.com
            https://apis.google.com https://www.google.com https://api.github.com;
worker-src 'self'; manifest-src 'self'; frame-src https://happa-bfc07.firebaseapp.com;
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

| Source | Used by |
|---|---|
| `'self'` | the app, templates, `changelog.json`, the vendored Firebase SDK, the service worker, `/download`, `/r/`, and the small classic scripts in `www/js/boot/` that used to be inline (install-prompt capture and SW registration in `index.html`, the pre-paint theme, `/download`'s language and release notes) |
| `https://cdn.sheetjs.com` (script) | Excel export (`ensureXLSX()`, pinned with SRI) |
| `firestore.googleapis.com` | Firestore SDK and the tenant page's single REST read |
| `identitytoolkit.googleapis.com`, `securetoken.googleapis.com` | Firebase Auth sign-in and token refresh |
| `apis.google.com` (script, connect), `www.google.com` (connect), `happa-bfc07.firebaseapp.com` (frame) | Firebase Auth (compat) on **phones** (and Safari) loads Google's `gapi` loader at start-up and frames `<authDomain>/__/auth/iframe` (its popup/redirect helper), even though the app only signs in with email + password. Found by the E2E phone runs. These scripts can't carry SRI; dropping them needs Auth without the popup/redirect resolver (modular SDK), a separate change |
| `firebaseinstallations.googleapis.com` | not called today; listed for the Firebase SDKs that use it (App Check, see below) |
| `api.github.com` | the "Update available" check |
| `data:` / `blob:` images | receipts and bill images drawn on a canvas, the inline favicon, downloads |
| `'unsafe-inline'` (style) | ~800 `style=` attributes in 33 files and the `<style>` blocks in templates / `download.html` / the print window. Inline styles can't run code; moving them all to classes is a separate, larger change |

Not listed, on purpose:

- **No `'unsafe-inline'` / `'unsafe-eval'` in `script-src`**, and no hashes: there is no
  inline script left. Every `<script>` in `www/` has a `src`.
- **No `www.gstatic.com`**: the Firebase SDK is self-hosted (`www/vendor/firebase/`), so
  nothing is loaded from gstatic. App Check / reCAPTCHA would add it (see below).
- **No `firebasestorage.googleapis.com`**: the app doesn't use Cloud Storage (no Storage
  SDK; `storageBucket` is only part of the standard web config).
- **No report-only twin.** With no report collector (below), a stricter report-only policy
  would only add console noise, and the E2E fixture fails on any CSP console message.

Links the app only opens (`wa.me`, `github.com`, its own address) are
navigation, which CSP does not cover.

**Keeping it right.** `tests/ci/security-headers.test.js` fails when a site loses
a header, when `script-src` gains `'unsafe-inline'` / `'unsafe-eval'` or another origin,
when a page or template under `www/` has an inline `<script>` whose sha256 isn't in
`script-src` (move the code to `www/js/boot/` or a module instead) or a `javascript:` URL,
or when code under `www/` names an `https://` origin that is neither in the CSP nor in
its short "only linked to" list. `www/js/__tests__/inline-handlers.test.js` fails on any
`on<event>=` attribute. The E2E static server sends the same `**` headers (plus the
emulator ports in `connect-src` / `frame-src`), and the E2E fixture fails on any CSP
violation, so every page × role is checked against the enforced policy on each PR.
`tests/e2e/csp.spec.js` also checks that the header is really enforced (an injected inline
script and an `onclick=` attribute don't run) and listens for `securitypolicyviolation`
while the app loads, signs in and opens the main pages, `/download` and `/r/`.
When you add a new external origin, add it to the CSP in
`firebase.json` in the same PR. `frame-src` must name the project's `authDomain`
(the test reads it from `www/firebaseConfig.js`), so a project change updates it too.

`tests/e2e/external-origins.spec.js` covers the two non-Firebase loads that no
page does on its own: the Excel export (real script load from `cdn.sheetjs.com`,
SRI checked) and the Android update check (`api.github.com`, answered by a route;
the CSP check runs in the browser before the request is routed).

**No field data.** The policy has no `report-uri` / `report-to`: the project is on
the Spark plan with no Cloud Functions or other server to receive reports. So
violations on real phones only show in the DevTools console of whoever is looking.
**E2E is the signal**: every page × role × language, `/download` and `/r/` run under
this exact policy on each PR. Gaps E2E can't see: browsers / WebViews other than
Chromium, flows E2E doesn't drive, and Google's own scripts changing what they load.

**Rollback.** If something is blocked in the field, rename the header key in
`firebase.json` back to `Content-Security-Policy-Report-Only` (and keep a separate
enforced `Content-Security-Policy: frame-ancestors 'none'`, which report-only ignores);
the deploy on merge ships it.

**Service worker.** Cached pages keep the headers they were fetched with, so a phone
running an older cached `index.html` (with its inline scripts) keeps that page's old
report-only header until the new worker takes over; the new `index.html` comes with the
enforced one.

### Android app (Capacitor)

The APK doesn't get any of these headers: Capacitor serves `www/` from inside the APK
(`https://localhost`, Capacitor 7's default `androidScheme`) through its local server,
which sends no CSP. So the enforced policy can't break the Android WebView, and on
Android the app runs without a CSP, as before. A CSP for the APK would be a
`<meta http-equiv="Content-Security-Policy">` in `www/index.html`; it is left for a
separate change tested on a device, because:

- Capacitor's docs: CSP in the app is set with a `<meta>` tag in `<head>`
  (capacitorjs.com/docs/guides/security).
- The plugin bridge (Capacitor runtime, plugin and Cordova plugin JS) is added with
  `WebViewCompat.addDocumentStartJavaScript` when the WebView supports it, which CSP doesn't
  affect. On older WebViews Capacitor falls back to inserting it as an **inline `<script>`**
  right after `<head>` in each HTML response. A meta policy only governs what comes after
  the tag, so that script still runs today, but only because of where Capacitor puts it;
  calls from native code (`evaluateJavascript`) aren't subject to CSP either.
- `'self'` there is `https://localhost`; the APK needs the same external hosts as the web
  (the WebView is a phone browser to Firebase Auth, so gapi and the authDomain frame too).
- A meta tag can't set `frame-ancestors`, `report-uri` or `sandbox`, and it would also
  apply on the web next to the header (both must pass) and in E2E.

## innerHTML audit (#89, 2 Nov 2026)

Every `innerHTML` / `insertAdjacentHTML` / `outerHTML` sink under `www/js` and `www/r`
(239 of them), plus `document.write` in `Exporter.printPage` (print / PDF of Statements and the
audit log), was traced to the markup it gets. **No unescaped user or Firestore text was
found**; what remains is numbers and amounts (computed or `parseFloat`-ed),
colours / classes / styles / icons, fragments built from escaped parts (`rowHtml`, `L(…)`,
`partyName(p)`), catalogue text without parameters, internal ids (page names, view
keys) and static templates. The conventions that keep it so:

- text: `Helpers.escapeHtml()` (pages alias it `esc` / `e`), `t()` with parameters through
  a local `L` / `tt` / `tx` / `et` (= `escapeHtml(t(key, params))`), stored two-language
  records through `loc` (`escapeHtml(pickLang(…))`);
- values inside a handler attribute: `Helpers.escapeJsAttr()` (JS-escaped, then
  HTML-escaped), for both `onclick="fn('…')"` and `data-onclick="fn('…')"`;
- a link built from data: `href="${Helpers.safeUrl(url)}"`. Escaping alone doesn't stop
  `javascript:`; `safeUrl` keeps relative, http(s), mailto, tel, sms, whatsapp and upi links,
  turns anything else into `#`, and escapes the result;
- `UIManager.showModalWithHtml` / `showCustomModal` and `Exporter.printPage` take markup the
  caller has escaped (all callers build it with the helpers above);
- `www/js/__tests__/xss-rendering.test.js` renders the main lists with hostile names, ids
  and "numbers" and checks nothing runs.

**Regression check (CI).** `npm run check:html-escape` (`scripts/html-escape-audit.js --check`,
in the *Lint, Jest, release checks* job) lists every value that reaches HTML without plain
escaping (a listed variable, call or `local.property` also shows what it was traced to:
`timeStr ← Helpers.formatTime(time)`, `d.icon ← d = describeNotification(n)`)
and fails on a line that isn't in `tests/html-escape-baseline.txt` (lines are compared
without line numbers, so moving code doesn't count). It looks at:

- each `${…}` in a template literal with markup, and each piece of a `+` chain that builds markup;
- each value given to a sink: `innerHTML` / `outerHTML` (also `['innerHTML']` and `+=`),
  `insertAdjacentHTML`, `document.write`, `showModalWithHtml`, `showCustomModal` and the `html` of
  `Exporter.printPage({ … })`.
  It follows the value through templates without tags, local variables (`=`, `+=`, `||=`,
  `x[i] =`, `.push`; other assignments make the variable unknown), `.map(…)` / `.filter(…)` /
  `.join(…)` (block bodies too), `t(key)` (a missing key comes back as is) and local functions
  to what they return (`this.m()`, or `X.m()` for a method defined on `X` in the same file);
- when a function's parameter (plain, defaulted, destructured or rest, or a `.property` of it) reaches a sink, markup or an
  `href` (`this.html(id, value)`,
  ``const cell = (v) => `<td>${v}</td>` ``), each call to it in the same file, and each list handed to it
  through `.map(cell)` / `.forEach(cell)` …, so a new caller is a new line (`… (markup via cell)`);
- each `href="${…}"` that isn't `safeUrl(…)`, in any template or `+` chain (also a tagless
  `` ` href="${…}"` `` piece added under a condition).

Names are trusted only through the reviewed list in `scripts/html-escape-allow.json` (escaping
and number helpers, `.length`), never by how they are spelled. `tests/ci/html-escape-audit.test.js`
holds 15 hostile probes the check must catch, plus the forms an independent review found. It is a
helper, not a proof: review new markup by hand too. When the check fails, escape the value; if it
is safe (a number, an internal id), check it by hand and run
`npm run check:html-escape -- --update-baseline` in the same PR. The baseline started at 451
lines, all checked by hand (555 lines of the first, looser version of the script on 2 Nov, then
the lines the wider check added: counts, colours, icons, loop indexes, internal ids passed to
local helpers, cross-file `…Html()` helpers whose own markup is checked in their file, and
static templates).

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

## Audit log and error reports (#85, #116)

- **Audit log** (`auditLogs`, owner reads in Settings and Diagnostics): every entry is
  created by an approved user **as themselves** (`userId` = caller), with the server time
  (`serverTime`) and an UPPER_CASE action code (`^[A-Z][A-Z0-9_]{0,63}$`, no free text);
  nobody edits an entry; the owner's phone deletes entries older than 90 days
  (`cleanupOldLogs`, allowed by the rules). Logged: bills (create, edit, void, delete),
  payments and write-offs, expenses (edit, delete), items (create, edit, delete, import), stock
  adjustments (before → after), withdrawals, cash day open / close (counted vs expected),
  Settings › Aadhat changes (labour, bill checks, business name: before → after), Roles &
  access, accounts (approve, reject, role change, remove, restore), rentals actions,
  Clear Data and hiding error reports. Print / export of the log is #103. An entry's stored
  `userName` / `userRole` are whatever the phone sent (kept for history): Settings, Diagnostics
  and the anomaly flags name the **profile** behind `userId` (the owner's phone reads the
  profiles; the audit cards add the profile email, which unlike the name the person can't change; the role
  is the person's role now, "removed" once removed), and show a stored name that differs, or one with no profile, as "name as sent by
  the phone, not checked".
- **Error reports** (`telemetry`): before a report is stored, `utils/scrub.js` replaces
  emails, Indian mobile numbers, rupee amounts, tokens and keys (JWTs, `AIza…`,
  `token=` / `key=` / `oobCode=` values, long opaque strings) with placeholders, drops
  the page address's query string, and keeps only the error code of objects logged with
  `console.error` (data objects hold names and amounts). Only the owner reads reports
  (Diagnostics › Errors; managers see Number checks only). **Hide** / **Hide all** mark
  reports `hidden` (owner only, nothing else may change) instead of deleting them, and
  write a `HIDE_ERRORS` audit entry. Retention, like the audit log: once a day, when Diagnostics
  loads, the owner's phone deletes reports last seen more than 90 days ago, hidden or not (one
  query, at most 450).

## Misuse review flags (#124)

On the free plan there is no server code, so each phone reports, and the owner's daily anomaly scan
(`modules/anomalies.js`, which already reads the audit log on the owner's phone) raises the flags
on Anomalies and the Today day report. No extra reads.

- **Refused writes**: `firebase/firestore-meter.js` sees every Firestore call; a `permission-denied`
  on a write emits `firestore:denied` and `services/security-monitor.js` writes a `PERMISSION_DENIED`
  audit entry with only the collection and operation (no data), 8 s later. At most one per kind every 2
  minutes and five per 10 minutes per phone. Not recorded: refusals the app expects (a wrong phone
  clock, a bill a retry already saved: the caller marks the error), batches and transactions (they carry
  no collection, and several of the app's own are refused by design), the audit log itself, error
  reports, app health and the stock checkpoint's scan state; rentals-only people can't write the log. **Flag** `access-denied` (high): one
  person's refused changes reaching the limit in Settings › Aadhat › bill checks (default **3 within 10
  minutes**: `deniedCount`, `deniedWindowMin`).
- **New phone**: at start-up the app compares this phone's id (the App health device id) with
  `deviceLog/{uid}.devices` (up to 10 `id:YYYYMMDD` entries, added with `arrayUnion`). The rules let
  only that approved person write their own doc (`devices` only; each entry `^[a-z0-9]{1,20}:[0-9]{8}$`,
  its day not after tomorrow), and only that person and the owner read it: managers never see phones.
  A phone that already checked for this person reads nothing (kept on the phone). A new phone is
  remembered; it writes `NEW_DEVICE` only once the person's list is 14 days old, so the phones in use
  when this starts are not flagged. **Flag** `new-device` (low).
- **Old bills**: past the edit window, Edit / Void stay visible but **locked** (greyed, "🔒 Edit window
  closed" / "🔒 बदलने का समय बीत गया") for those who could act inside it. A tap only explains the window;
  for someone other than the owner it also writes `OLD_BILL_EDIT_TRY` (one per bill and action per app
  run), which is no flag by itself. **Flag** `old-bill-edit-try` (low) only when one person tries **3
  or more different** old bills in one IST day. (Edits the rules refuse are refused writes, above.)

The daily scan reads the audit log since the last scanned day in pages of 300, at most 1,000 entries
per scanned day (`loadAuditLogsSince`), so a busy day is not cut short at the first page.

These entries come from the person's own app, so a modified app can leave them out: they are review
hints. The rules remain the protection.

## Firestore rules

`firestore.rules` is the permission model; `rules-tests/test.js` pins it for the prod and
`dev_` collections. This section holds what used to be comments in the rules file.

### Compile budget

Every rules deploy first compiles the file with the Rules API (`projects/<id>:test`), and
that call has a time limit (about 7 s; it answers 503 when it runs out). At 159 KB the rules
failed it on every try. Measured with the local emulator's compiler and the real API, the
cost is not the size in bytes (comments and whitespace are nearly free) but the work of the
type checker:

- every function costs something on every call it resolves, so fewer functions is cheaper;
- a call re-walks the whole tree under the called function, so a dispatch helper that only
  picks another helper (`canUpdateRecord`, `rentUpdateOk`, `rentUpdateAs`, …) doubles the cost
  of everything below it;
- the expensive parts are deep helper chains, not the checks themselves.

So the rules now:

- dispatch on the collection inside the `allow` expression of the shared business block, and
  give each other collection its own `match` with direct calls to its validator;
- inline a helper that is used once, keeping its `let`s (they are lazy: a `let` is evaluated
  only when used, checked against the production engine with `:test` test cases), and keep
  small shared helpers (`rentStr`, `rentLeasePath`, `isOwnerIn`, …);
- write the role checks (`isApprovedIn`, `isOwnerIn`, `isManagerIn`) without nested calls.

`npm run check:rules-size` (CI) keeps the file under a byte budget as a tripwire. Before
raising it, time the compile: `POST https://firebaserules.googleapis.com/v1/projects/happa-bfc07:test`
with `{"source": {"files": [{"name": "firestore.rules", "content": ...}]}}` compiles without
publishing. A faster loop is the Firestore emulator: `PUT
http://127.0.0.1:<port>/emulator/v1/projects/demo-x:securityRules` with
`{"rules": {"files": [...]}}` returns when the compile is done (the API took about 2 to 3
times as long as the emulator on this machine).

Runtime has its own limit: at most 1000 expressions per document. A wildcard
`match /{c}/{id}` block is evaluated for every write to every collection, so the rentals and
other collections have explicit `match` blocks for prod and `dev_` (only the business block
and the `edits` / `preferences` subcollections are wildcards). The heaviest rentals writes (a
change of unit with its first charge) are close to the limit.

### Where the old helpers went

The rework kept every check; these helpers were folded into the function or block named:

| Old helper | Now in |
|---|---|
| `isSignedIn`, `profilePath`, `isApproved`, `isAdmin` | written out (`request.auth != null`, the profile path, `isApprovedIn('users')`, `isOwnerIn('users')`) |
| `businessCollections`, `devBusinessCollections`, `stockCollections`, `billCollections` | `businessAccess`, the business `match`, `canDeleteRecord` |
| `canCreateRecord`, `canUpdateRecord`, `canUpdateBill`, `clientGateOn` | the business `match /{collection}/{docId}`, `writesCurrentClient` |
| `voidFields`, `voidOk`, `editCountOk`, `canFullyEditBill` | `billUpdateAs` |
| `billTimeOk`, `noBackdatedCash` | `validBillCreate` |
| `storedDue`, `entryTimeOk` | `paymentEditOk` |
| `backfillDayOk` | `backfillTimeOk` |
| `canDeleteBill`, `canDeleteOwnRecord` | `canDeleteRecord` |
| `expenseDateOnDay` / `withinExpenseWindow` | `expenseDayInWindow` / `expenseVoidOk` |
| `wasAutoClosedUncounted` | `cashCloseOk` |
| `notificationFields` | `validNotificationCreate` |
| `roleSeesMoneyPages` | `canReadRecord` |
| `receiptOk`, `receiptLogoOk` | `settingsReceiptOk` |
| `shopSettingsFields` | `managerShopSettingsOk` |
| `staleMarkOnly` | `checkpointRules` |
| `ownerProfileGuardOk`, `savedRangesOk` | `canUpdateProfile` |
| `reminderRepeatOk` | `reminderFieldsOk` |
| `rentProfile`, `rentPrefix` | `rentReceiptCreateOk`, `rentPath` / `rentLeasePath` / `rentChargePath` |
| `validRentDoc`, `rentUnitExtrasOk` | `validRentProperty`, `validRentUnit`, `validRentTenant`, `validRentLease` |
| `rentCreateOk`, `rentUpdateOk`, `rentUpdateAs`, `rentDeleteOk` | the rentals `match` blocks, `rentLeaseCreateOk`, `rentLeaseUpdateOk`, `rentUnitUpdateOk`, `rentChargeUpdateOk` |
| `rentUnitChangeOk`, `rentDaysAgo`, `rentFirstRentOk` | `rentLeaseCreateOk` |
| `rentLeaseStateOk`, `rentAgreementOk`, `rentMovedOk` | `rentLeaseUpdateOk` |
| `rentUnitMeterOk` | `rentUnitUpdateOk` |
| `rentPaymentOk`, `rentChargeRnoOk`, `rentChargeMoveOk`, `rentAdvOutOk`, `rentChargeEditOk` | `rentChargeUpdateOk` |
| `rentAdvSrc` | `validRentChargeCreate` |
| `rentDepPaysOk` | `rentNewEntryOk` |
| `rentReceiptFields`, `rentReceiptSeqOk`, `rentReceiptWithPayment`, `rentReceiptLater`, `rentByNameOk`, `rentBalanceOk` | `rentReceiptCreateOk` |
| `rentAdvBackOk` | `rentChargeDeleteOk` |
| `rentDepEntryOk` | `rentDepNewOk` |
| `isMember`, `withinEditWindow`, `expenseEditOk` | removed (unused) |

### Notes per rule

The comments that were in `firestore.rules`, by the function or `match` they described (names
as they were before the rework; see the table above).

- `isSignedIn()`: HELPERS Production collections use the 'users' collection as the source of a caller's profile; development (dev_ prefix) collections use 'dev_users'.
- `isApprovedIn()`: Approved = has a profile whose status is not pending/rejected and whose role is known. Legacy approved profiles have status 'active', 'approved' or no status field at all.
- `businessCollections()`: Shared business data: every approved user (owner/manager/staff) can read/write.

#### bills (purchases / retail / wholesale sales)


#### bill edit window (#87; days per role in Roles & access, #84)

- `settingsAppPath()`: Clock: the bill's `createdAt`, the server time of its first save (firestore-service.js saveBill; validBillCreate requires it to equal request.time and nobody but the owner can change it). Bills without a server createdAt (saved before #87 / by old apps) are owner-only. Days: settings/app.roleAccess.<role>.editDays (int 0-30, else 2). settings/app is already read for the clientVersion gate on bill writes.
- in `canDeleteBill()`: Bills are voided, not deleted (#75): only the owner deletes (test data, a voided bill for good, Clear Data). resource is null when deleting a doc that is already gone (no-op).

#### void (#75) and edit records (#121)

- `editLoggedFields()`: Changing these on a bill needs its edit record (edits/{editCount}) in the same write (firestore-service.js updateBillChecked; bill-edits.js EDIT_FIELDS). The notes are not logged.
- `voidAwareBill()`: An app that knows voided bills (#75) writes clientVersion >= 4 (firestore-service.js CLIENT_VERSION). Older apps (rc1 has its www inside the APK) must not edit or void bills.
- `voidAwareWriter()`: Figures built from bills (stock checkpoint, month snapshots, rate stats) are written only by such an app, stamped by this very write (writtenAt = server time: a merge from an older app can't ride on the version a newer one stored). firestore-service.js voidAwareStamp().
- `reasonOk()`: A void or edit reason: 3 to 300 characters (bill-edits.js REASON_MIN / REASON_MAX).
- `voidOk()`: A void: only the void fields change (and openDue to false, clientVersion for the gate); by the caller, at the server time, with a reason; never with payments recorded after the bill was saved (their cash legs would be left without a bill); the owner any bill, anyone else their own bill inside the edit window (who could delete a bill before #75). A voided bill never changes again.
- `editCountOk()`: editCount only goes up by one, together with the creation of its record edits/{n}.
- `editFieldOk()`: One field of an edit record: absent, or exactly its value on the bill before and after.
- `validEditCreate()`: An edit record: append-only and immutable; by the caller at the server time with a reason; numbered with the bill's new editCount, which the same write raises by one. Its fields are exactly the logged fields that write changed (at least one), each with its true value before and after (the item list compared whole), so it can't be faked.
- `canFullyEditBill()`: Full edits (the owner is handled in canUpdateBill): a manager, or the bill's creator, inside the edit window; createdAt never changes.
- `bookkeepingOnly()`: Everyone else may only touch payment/due bookkeeping written by the app: payments (outstanding.js applyPaymentTransaction / applyWriteOffTransaction, which also stamp `paidAt`, the time of the payment, #163), clearing (markAsCleared, wholesale markSaleAsCleared) and the legacy backfill (openDue, clientVersion, a missing numeric timestamp, bounded like legacyBackfillOnly). `timestamp` and `id` may only be filled in, never changed.

#### money validation (#19, #65)

- `moneyOk()`: A bill write already uses much of the 1000 expressions rules evaluate per request, so these follow the shape the app writes (payment.cash / online / due, with top-level copies) rather than every legacy shape readPayment() reads. A payment amount as the app writes it (round2): a number >= 0 in whole paise (NaN fails >= 0; for Infinity the paise test is NaN, so it fails too).
- `storedDue()`: The bill's due before this write, as readPayment() reads it (nested payment.due first); null when it isn't stored as a number.
- `changedMoneyOk()`: Money on a bill created or fully edited by a non-owner: totals are finite numbers, payment amounts are money and, when any of them changes, cash + online + written off + due is at most the bill total + Rs 1 (the bill screen's split check, money.js SPLIT_TOLERANCE: "Cash" or "Due" fills in the total rounded to the rupee). The total is read as billTotal() reads it (grandTotal, amountPayable, total, then billTotal / saleTotal). Only tools/migrate writes opening records; the app never writes the legacy amountPaid / due that readPayment() would also read.
- `appendsOneEntry()`: payments[] may only grow by one entry; existing entries stay unchanged and the new entry has a numeric amount >= 0 (#19).
- `paymentMoneyOk()`: Money moves only with the due (#65). A payment or write-off writes payment.cash, online and due as money; cash, online and written off never go down, each goes up by what the new payments[] entry (amount > 0) says (due-payments.js entryParts: a write-off, else its cash / online parts, else all cash; half a paisa for round2 of older values), and the due goes down by the same (1 paisa either way, outstanding.js PAYMENT_TOLERANCE). Without an entry no money moves and the due only drops when a due under 1 paisa is written off to 0. So a member can neither take money off a bill nor lower a due without money, and with the split check on creates and edits nobody pays more than the bill total.
- `entryTimeOk()`: A new payments[] entry carries its time (`at`, ms) within 10 minutes of the server's: payments and write-offs are transactions, so they never queue offline, and a back- or forward-dated entry would move drawer cash to another day (due-payments.js counts an entry on the day of its `at`).
- `clearOk()`: A due is cleared only when it is settled in the same write (#104: paid or written off), by the caller, and openDue goes false only with it (firestore-service.js hasDue).
- `paymentEditOk()`: Payment bookkeeping by someone who may not fully edit the bill: amounts are money, payment.due and dueAmount agree, payments[] is append-only, money moves only with the due (paymentMoneyOk), dues are cleared only when settled (clearOk), and `paidAt` is written only with a new payments[] entry and equals that entry's `at` (outstanding.js applyPaymentTransaction / applyWriteOffTransaction; markAsCleared and wholesale markSaleAsCleared go through them). Older apps append without `paidAt`; that stays allowed.
- `canUpdateBill()`: The caller is approved (businessAccess); their role is read once and the changed keys worked out once (rules allow 1000 expressions per request). Only an owner may change userId.
- `billUpdateAs()`: A voided bill never changes (owner included); a void is voidOk; editCount moves only with its edit record; full edits by non-owners that change a logged field need one (#121) and never touch payments / paidAt (only bookkeeping appends to them).
- in `billUpdateAs()`: Ternaries keep the expensive checks off the paths that don't need them.
- in `billUpdateAs()`: A payment (payments[] / paidAt) is bookkeeping only: checked straight away, so the edit-window lookups of canFullyEditBill don't use up the 1000 expressions a payment's checks need (a manager's full settle on a bill with createdAt was refused, #229).
- `billTimeOk()`: New bills: the creator's own uid (when set), well-formed money (changedMoneyOk), no payment history, cleared state, edit count or void (the app never sends them on a new bill), and createdAt = the server time of this write (#115: every happa version, rc1 included, sends it; the edit window counts from it). The owner (restores) skips this. A bill's date (#147): `timestamp` is the time it counts at (BILL-TIME), `enteredAt` when this app entered it. Anyone but the owner may date a bill back at most the role's editDays (+ 1 day: the window is in calendar days) before it was entered, and never after (10 minutes). `enteredAt` itself is the phone's clock and is not bounded: a bill queued offline arrives later, and a phone whose clock is fast must not lose its bills. Bills without `enteredAt` (apps before #147) are not limited, as before.
- `noBackdatedCash()`: A bill dated before the day it was entered (IST) takes no cash from anyone but the owner (#147): that day's drawer may already be counted and closed, so the cash would show in no open drawer. Judged against the IST day of `enteredAt`, not the server's time, so a cash bill entered offline yesterday and synced today is kept. For cash bills `enteredAt` must be within the last 3 days (a phone that saved offline). It has no upper bound: a later `enteredAt` can't move cash onto an earlier day (`timestamp` must be on or after its day), and a phone whose clock is fast must not lose its bills. A cash bill with `enteredAt` but no numeric `timestamp` counts as dated back. Bills without `enteredAt` (apps before #147, which can't date a bill back) are not checked: refusing them would lose their offline bills; the app check and the anomaly scan cover the new app.
- `isMember()`: CASH, EXPENSES, STOCK ADJUSTMENTS, ITEMS, COUNTERS (#18) The owner may write these freely (repairs, backup restore). Everyone else is limited to the writes the app makes.
- `createdByCaller()`: Who created a record (expenses carry userId and createdBy).
- `withinEditWindow()`: Members may change their own record for 24 hours after it was made (fixing a typo); after that only an owner/manager may.
- `legacyBackfillOnly()`: Legacy backfill (firestore-service.js backfillLegacyTimestamps): fills a missing numeric timestamp (+ clientVersion on stock records), nothing else. The value is the one the app derives (stock-replay.js eventTime), never in the future: an old Firestore Timestamp's millis, else the record's `date`.
- `backfillDayOk()`: A date string the rules can read: YYYY-MM-DD[...] or DD/MM/YYYY[, time].
- `nearDay()`: Within that calendar day, give or take a day for the phone's time zone (the app reads YYYY-MM-DD as UTC midnight and DD/MM/YYYY as local time).
- `validLedgerCreate()`: Expenses / withdrawals: anyone approved records their own, with a numeric amount and a numeric `timestamp` that is not in the future (10 minutes' slack for the phone's clock): startSaveExpense sets it from the creation time, startSaveWithdrawal from the later of the creation time and the picked day (Money refuses a future day). A queued offline record arrives later, so there is no lower bound.

#### expense date and payment mode (#118)

- `expenseDayStart()`: paymentMode: 'cash' | 'online' (none = cash). day: the local (IST) day the expense counts on, YYYY-MM-DD, never in the future (1 hour for a fast phone clock).
- `expenseDateOnDay()`: A new expense by anyone but the owner that names its day may be dated back at most the role's edit window (roleAccess.<role>.editDays, as bills; the app allows exactly that), plus 3 days for a phone that saved it offline. Its `date` (what the figures read) must be on that day: "D/M/YYYY, …" as en-IN writes it, with or without leading zeros. Older apps name the day only on personal expenses (today, from the date).
- `canUpdateExpense()`: Expenses are voided, never edited or deleted in place (#99): apart from the owner (repairs), only the legacy timestamp backfill changes one. A save this phone couldn't confirm, sent again over the same id (#153, miscellaneous.js pendingExpense), lands as an update that changes nothing: its creator may write it. A change is a void plus a new expense (replacesId); only the owner deletes.

#### expense void (#99, as bills #75)

- `personalVoidLeavesDay()`: A voided personal expense leaves its day total in the same write (personalExpenseDays).
- `withinExpenseWindow()`: The role's edit window (roleAccess.<role>.editDays, as bills) from the expense's `timestamp`, which validLedgerCreate keeps from running ahead of its creation.
- `expenseVoidOk()`: A void: only the void fields, by the caller at the server time, with a reason; the owner any expense, a manager any expense and a member their own, inside the role's edit window. A voided expense never changes again (canUpdateRecord).
- `validAdjustmentCreate()`: Stock adjustments: owner/manager record them (stock.js applyStockAdjustment; the Stock › Adjustment tab and Set opening stock are not open to members, #64).

#### cash sessions (cashManagement)

- `validCashCreate()`: cash-management.js signIn → firestore-service.js openCashSession: the day's session (#38) at cash_<date>, with the fields signIn sends and no entries yet. (Every happa version opens cash this way; the old random-id .add() is gone.)
- `cashAppendOk()`: Deposits and due-payment legs are appended one at a time (arrayUnion, or outstanding.js applyPaymentTransaction). Also allowed on a closed session: an entry queued offline must not be lost because another device closed it.
- `wasAutoClosedUncounted()`: A day the app closed automatically without a real count (#101; older apps wrote closingBalance 0 and no `counted`).
- `cashCloseOk()`: Sign-out (counted) or the automatic close of a past day (not counted). A counted sign-out may also replace an automatic close: older apps (v1.3/v1.4) sign out with a plain update and would otherwise lose the count.
- `cashLateCountOk()`: Recording the real count for a day that was closed without one (#101).

#### items: owner/manager create and edit; only the owner deletes


#### item frequency (billing.js updateItemFrequency): only itemFrequency/global,

- `itemFrequencyOk()`: { purchase|sale: { <item>: { score, count, lastUsed, effectiveScore } } }, merged in with FieldValue.increment. Only those two maps, and a write never removes an item (no replacing the doc without merge). Rules can't loop over the item keys, so the numbers inside each item are not checked.

#### bill-number counters (helpers.js _nextCounterValue): +1 per transaction

- in `counterIncrementOk()`: Not yet seeded from today's bills: may jump forward, never back.

#### per-user records: auto-save, drafts, notifications (#18 follow-up)

- `ownAutoSaveWrite()`: Nobody writes another user's records, the owner included; the owner may only delete them (Admin › Clear Data deletes auto-saves and drafts). autoSaves/{uid} (billing.js autoSaveToCloud / deleteAutoSave): that user only.
- `validDraftCreate()`: drafts (billing.js saveDraft / loadDraft / deleteDraft): own drafts only; userId never changes.
- `notificationFields()`: notifications: the sender's device writes one doc per recipient (firestore-service.js sendNotification / planNotificationDocs, id <eventKey>_<userId>). The only senders are item adds and rate/name edits (notifyRateChanges, notifyItemEdit), and only owners/managers edit items, so only they may create them: stamped with their own uid and server time, types rate_change and item_edit, these fields only.
- `notificationReadOnly()`: The recipient marks it read (markNotificationsRead / markAllNotificationsRead).
- `canDeleteOwnRecord()`: Delete: the doc's own user (resource == null: already gone, a no-op), or the owner. autoSaves are keyed by uid.
- `personalOn()`: --- personal expenses (#98): their own collection, read and written only by the owner and roles with Roles & access › Personal expenses on (default on; one read of settings/app, never for the owner). personalExpenseDays/{YYYY-MM-DD} = { amounts: { <expense id>: amount }, last } holds each day's amounts (one key per expense, written with it) so the cash count and Today still add them up on phones that can't read the expenses. Members and managers may read these totals.
- `personalSwitch()`: Off unless the owner turned it on in Roles & access (#98): a stored true without personalExpensesChosen is the old default (every switch used to be saved), not a choice.
- `validPersonalCreate()`: A personal expense names the day it counts on (`day`, its personalExpenseDays doc).
- `validPersonalDay()`: A day doc write changes one key, `last` (an expense id): set to that expense's amount after this write, on its day, or removed when the expense is gone after it. So a repeated delete or a late write is harmless, and nobody can zero the map or add a key for an expense that doesn't exist. Members only touch the key of an expense written in the same batch; managers may also correct a key to the stored amount (rebuild from the rows).
- `personalDayKeyOk()`: `online` flags an expense paid online (#118): set exactly when the expense's paymentMode is 'online', so nobody can move a cash expense out of the drawer. A removed expense may keep a stale flag (older apps don't clear it); it counts nowhere. `same`: the write changes no key (an unchanged re-send of a save, #153), always harmless.
- `personalTagged()`: Older apps tagged personal expenses in `expenses`, where every member reads them (#98).
- in `canCreateRecord()`: legacy cashSessions (backup only) and settings: owner only (#64), but settings/accounts (#74)
- `cashStaysClosed()`: A closed cash day stays closed for everyone, owners too (#38): a queued or stale write must not reopen it. There is no reopen action.
- in `canUpdateRecord()`: settings first, on its own: the settings/app receipt check uses most of the 1,000-expression budget. settings/app is guarded in the match (appSettingsGuard / managerShopSettingsOk); other docs owner only
- in `canUpdateRecord()`: A voided expense never changes (owner included); a void is expenseVoidOk (#99)
- `appSettingsGuard()`: settings/app (minClientVersion) can lock every outdated phone out: owner only.
- `shopSettingsFields()`: Settings › Aadhat: a manager may update only these settings/app fields, and only when Roles & access allows it (roleAccess.manager.shopSettings == true).
- `receiptLogoOk()`: Printed bill for every phone (#107): footer, QR, language, darkness and a small 1-bit logo (at most 384 × 120 dots: 5,760 bytes, 7,680 base64 characters). No character check: a regex over 7,680 characters uses most of the 1,000-expression budget; the app ignores a logo whose bits aren't valid base64 of the right length.
- `stampAtOk()`: settings/app section stamps: <section>UpdatedAt is a time in ms (int), <section>UpdatedBy a uid (or 'unknown'), as every app version writes them. Only fields this write sets are checked, so an odd stamp already stored never blocks other saves; removing a stamp is allowed.
- `stockCollections()`: Stock records: writes must come from an app version that maintains the stock checkpoint (sets clientVersion >= 3). Blocks outdated apps from creating or overwriting bills/adjustments. DEPLOY ONLY AFTER every phone runs the new app.
- `clientGateOn()`: The clientVersion gate is switched on by the owner (settings/app.enforceClientVersion = true, dev_settings/app for dev_) once every phone runs the new app, so these rules can be deployed before the old APK is retired.

#### reads (#57, #18; docs/role-permissions.md "Server-side read rules")

- `canReadRecord()`: Called after businessAccess, so the caller's profile is already read. The owner reads everything (backup, Admin). `single` = a get of one document.
- in `canReadRecord()`: settings/team: names and roles of the team (owner-written) for managers' App health and notification fan-out, so they never read other profiles (#87)
- `roleSeesMoneyPages()`: Withdrawals are shown only on Money, Statements and Insights (roleAccess ids finance, reports, analytics; defaults: on for managers, off for members). A manager or member reads them only when one of those is on for their role: one extra read (settings/app), never for the owner.
- `moneyPageOn()`: A withdrawal is recorded only on Money (roleAccess id finance; default on for managers, off for members), so only roles with Money on may create one (#64). One extra read (settings/app), never for the owner; withdrawals are rare.
- `worthAccountOk()`: Money › Worth accounts (settings/accounts, #74): one doc shared by every phone, { accounts: { <id>: { name, balance, type } }, updatedAt, updatedBy, changedId }; read by the owner and managers with Money on (canReadRecord). The owner writes anything (moving one phone's accounts in one write); a manager with Money on adds, changes or removes one account per write (named in changedId), in whole rupees.

#### stock checkpoint (stockCheckpoints/current)

- `staleMarkOnly()`: Fields any approved user may write to mark the checkpoint stale.
- `checkpointRules()`: Only the two docs the app uses (firestore-service.js checkpointRef / legacyScanRef).

#### item rate/name history (rateHistory, #82 / #65 phase 1)

- `validRateHistoryEntry()`: Append-only: owner/manager create entries for their own uid; nobody updates or deletes them. `index` = position in the rate list (#65); `source` = where the change was made (Items page row, edit dialog, Excel import).

#### user profile rules (shared by users and dev_users)

- in `canReadProfile()`: Own profile (pending/rejected users too, at login); only the owner reads everyone (Admin, Roles & access). Managers read names and roles from settings/team instead (#87); members never read others (#57).
- in `canCreateProfile()`: Self-registration only, always as a pending staff member, with the fields registration writes (repos/users.js createProfileIfMissing). A removed or rejected person keeps their profile, so they can't come back as pending (#84).
- `ownerProfileGuardOk()`: An owner can't change their own role/status, nor demote or remove another owner (two owners removing each other at once would leave none).
- `savedRangesOk()`: Saved period ranges (#140): "a|b;a|b", at most 10 pairs of the app's period presets.
- `canUpdateProfile()`: Users change only their own name (Settings › account) and their saved period ranges (#140; the list of their phones is deviceLog, #124); never while removed or rejected.

#### phones per person (#124): deviceLog/{uid}.devices, "deviceId:YYYYMMDD"

- `deviceEntryOk()`: Written only by that person (an approved shop user), read by them and the owner, never by managers. Entries are checked one by one (at most 10); the day may not be after tomorrow (UTC) since the phone writes its IST day.

#### audit logs (#55) and telemetry (#122): append-only

- `validAuditEntry()`: The caller's own uid; `serverTime` (FieldValue.serverTimestamp) is the trusted time. `timestamp` (client clock, used for ordering) may not be in the future and only lags when the entry was queued offline (up to 3 days); entries without serverTime (older apps) must be within 10 minutes.
- `isExpiredAuditEntry()`: Owner cleanup (audit.js cleanupOldLogs): only entries older than 90 days.
- `telemetryHideOnly()`: The owner hides a report (#116): only these fields, by the caller, at the server time.
- `validTelemetryEntry()`: One document per sync of a grouped error (telemetry.js syncToFirestore).
- `rentProfile()`: RENTALS (#170): rent_* collections (dev_rent_* in development), roles per business (#149). The shop owner owns every business; anyone else needs users/{uid}.rentRole = 'manager' | 'member' (set by the owner). A shop role alone gives no rentals access, and a rentals role alone (shop role 'none') gives no shop access. See docs/rentals-design.md.
- `rentRoleIn()`: 'owner' | 'manager' | 'member' | '' (no access). The profile is read once (rules have an expression budget per request).
- `canWriteRent()`: Owner decision (2026-10-25): anyone with a rentals role records payments and keeps the records up to date. Deletes and Access stay owner-only; correcting a charge's amount stays owner/manager.
- `nextMonth()`: The month after 'YYYY-MM'.
- `rentThisMonth()`: This month in India (IST = UTC+5:30), as 'YYYY-MM'.
- `rentWriterOk()`: Every rentals write names its writer (audit: who recorded what).
- `rentCreationKept()`: Who/when created a record never changes.
- `validRentDoc()`: Shape of properties, units, tenants and leases.
- in `validRentDoc()`: firstRent <= rent only when the lease is created; afterwards firstRent is fixed and the rent may go down (rentLeaseUpdateOk keeps firstRent unchanged).
- `rentMobile()`: 10-digit Indian mobile (WhatsApp reminders), stored without +91.
- `rentUnitExtrasOk()`: Unit type (flat / commercial / office / godown / other), optional size (sq ft) and floor. Units saved before types existed have no type (shown as flats until set).
- `rentLeaseCreateOk()`: New leases start active, with no charges and no tenant link (except one carried over on a change of unit), and take their unit in the same write. The lease's property is its unit's, and its tenant exists. Non-owners can't back-date the start more than 2 days (IST; the app's default edit window, fixed here because Roles & access days would cost reads past this write's limit). A member's pro-rated first month is the computed one (RENT-11).
- in `rentLeaseCreateOk()`: No charges yet, or the first month's charge written in the same batch (move-in).
- in `rentLeaseCreateOk()`: A change of unit's first month is charged after (its opening advance, RENT-16, comes from the old lease).
- `rentUnitChangeOk()`: Change of unit (rent-unit.js): the same tenant's active lease (fromLeaseId) ends in this write on another unit, pointing here (movedTo), with the move month, or the month before when the move is on the 1st (that month isn't charged twice). Its tenant link moves here: only that lease's token, which it gives up in the same write.
- `rentMovedOk()`: The old lease of a change of unit points at the new lease created in the same write.
- `rentDaysAgo()`: 'YYYY-MM-DD' n days ago in India (IST).
- `rentLeaseUpdateOk()`: Lease changes (review of #10, High): - an ended lease is final: status, endMonth and chargedThrough never change again; - an active lease stays active with endMonth null, and chargedThrough moves forward exactly one month per write, to a month whose charge exists after the write and that isn't after this month (IST); - active -> ended only in the move-out write: endMonth (start..this month) = chargedThrough, its charge exists, the unit is freed in the same write. Ending before the last charged month deletes the later unpaid months and is owner/manager only, or one month back on a change of unit (movedTo; a move on the 1st within the members' 2-day start window).
- `rentAgreementOk()`: Agreement terms (#157 phase 3): the month the agreement ends (not before the start) and the notice period in months; set or changed only by the owner or a rentals manager, on a full lease edit (the app never writes them at move-in, and a new lease may not carry them: rentLeaseCreateOk).
- `rentLeaseStateOk()`: Only the lease's state changed (charging, move-out, change of unit, link): the other fields are as stored, so only these are checked (expression budget).
- `rentUnitLeaseOk()`: A unit's lease link changes only with the lease: set by a new active lease for this unit, cleared when that lease ends in the same write.
- `rentUnitMeterOk()`: lastReading / meterRate move only with a meter write on a charge of this unit (meterCharge points at it); owner/manager may also set the rate alone.
- `validRentChargeCreate()`: rent_charges/{leaseId}_{YYYY-MM}: created only in the write that moves its active lease's chargedThrough to exactly this month; amount = the lease's rent; nothing paid, no electricity yet.
- `rentAdvSrc()`: RENT-16: the month whose advance opens this one: the lease's month before (its chargedThrough before this write), or for the first month after a change of unit the old lease's last month.
- `rentChargeOpeningOk()`: A new month starts unpaid, or (advance `a` carried) paid min(a, amount) by one 'advance' payment of the writer, the rest carried on, and the month before's advance cleared in this write.
- `rentMonthRent()`: The rent of a month: a pro-rated first month (firstRent, set at move-in) or the lease rent (RENT-11).
- `rentPayAt()`: Σ amount of up to 12 payment entries (rules have no loops; a charge holds at most 12).
- `rentNewEntryOk()`: One new payment entry by the caller (amount > 0, known mode), at most 12 per charge. An entry with a receipt number (rno) needs its receipt rent_receipts/{charge}_{i} with that number created in the same write (validRentReceiptCreate).
- `rentPaymentOk()`: A payment (rent-store.js recordPayment): paid grows by exactly the new entry and never above the amount due.
- `rentPayAdvOk()`: RENT-16: more than is due, only on the active lease's latest month and only once the month is paid off: the payment's adv (> 0) is added to the month's advance, carried to the next month (rentChargeOpeningOk). Otherwise the month's advance is unchanged.
- `rentAdvOutOk()`: RENT-16: a month's advance goes to 0 only (a) in the write that creates the next month paid by it (that month's paid + advance = this advance), or (b) the lease has ended: moved out, the tenant's deposit ledger gains it in this write ('received', mode 'advance'); or changed unit, it opens the new lease's first month, created in this write.
- `rentAdvEndedOk()`: An ended lease's advance: after a change of unit it opens the new lease's first month (created in this write); after a move-out it goes into the tenant's deposit ledger.
- `rentMeterOk()`: Electricity from a sub-meter (rent-store.js recordMeter): units = current − previous, amount = units × rate rounded to the rupee (#129; within half a rupee + a paisa for floating point, like the pro-rated rents, so the paise amount older app versions write is accepted too), charge = rent + electricity (rent unchanged). Previous = the reading already on this charge, else the unit's last reading; rate = the unit's rate unless owner/manager; replacing a saved reading is owner/manager only; the unit stores the new reading in the same write.
- `rentChargeEditOk()`: Owner/manager corrections (e.g. a waived month): same lease, month and creation; payments unchanged or one new own entry; paid = Σ entries ≤ amount.
- `rentChargeMoveOk()`: Change of unit, pro-rated (RENT-13): in the write that ends the lease with a move (movedTo), its last month's rent goes down to the old unit's days; the amount follows (rent + electricity), never below what is paid. Members: the computed value, or (more paid than that) closed at what is paid; owner/manager: any lower amount (they correct charges anyway).
- `rentFirstRentOk()`: RENT-11: rent × days from the start date to the month's end ÷ days in that month, rounded.
- `rentMoveRentOk()`: RENT-13: rent × (days in the old unit: from the 1st, or the lease's start day when that month was pro-rated, to the day before the move) ÷ (days that charge covers), rounded to the rupee (either way on a .5). capped: closed at what is paid (more than the share): any rent from the share up.
- `rentIstYear()`: This year in India (IST = UTC+5:30): receipt numbers follow the server's clock.
- `rentChargeRnoOk()`: Receipt issued later (rent-store.js issueReceipt): entry i gains its rno and nothing else changes; i comes from this year's receipt counter, which must point at rent_receipts/{charge}_{i} created in the same write with that number.
- `rentChargeVoidOk()`: Cancelling a receipt (rent-store.js voidReceipt), owner/manager: the charge lists that payment's index in `voided` (so the tenant link drops its number) in the same write that marks rent_receipts/{charge}_{i} void.

#### Rent receipts (RENT-12): plain, non-GST, one per payment

- `rentReceiptFields()`: rent_receipts/{chargeId}_{i} is created in the payment write that adds entry i (with rno = its number) to the charge, or later for an entry i without one (rentChargeRnoOk), and moves this IST year's counter rent_counters/receipts_{YYYY} on by exactly one; the number is that counter value, so numbers are unique and gap-free per year. The header (business name, address) is not stored: the app shows it from Settings. Never edited, except cancel (void) by owner/manager.
- `rentReceiptSeqOk()`: The counter moves from seq − 1 (or nothing, for the year's first receipt) to seq, pointing at this receipt.
- `rentByNameOk()`: "Received by" is the caller's profile name (users/{uid}.name, cut to 80; the app says 'User' when it is empty).
- `rentBalanceOk()`: Balance due = the charge's after this write (a receipt issued later shows it as then).
- `rentReceiptWithPayment()`: With the payment: entry pi is new and the caller's.
- `rentReceiptLater()`: Later: entry pi existed without a number (its writer, or an owner/manager: see the match).
- `rentReceiptMatches()`: The receipt shows payment entry e and its charge exactly; createdAt is the server's time.
- `rentReceiptVoidOk()`: Cancel: void once, by owner/manager, nothing else changes; the charge marks it in the same write.
- `rentChargeDeleteOk()`: Move-out removes unpaid months after the last month, only inside the move-out write (lease active before, ended after); owner/manager, or the one month after on a change of unit (rentLeaseUpdateOk checks movedTo).
- `rentAdvBackOk()`: RENT-16: the one month right after the new last month, paid only from the advance (or just carrying it), may go when the lease ends before it: paid + its advance go back to the last month's advance.
- `rentAdvBackInOk()`: RENT-16, the other side: the last month's advance grows only by that month, deleted in this write, as the lease ends with this month.
- `rentUnitCreateLeaseOk()`: The caller's rentals role is read once per rule (rules have an expression budget). A new unit is vacant, or occupied by a lease created in the same batch (Add unit with its tenant). An opening meter reading is allowed.
- in `rentUpdateAs()`: RENT-16, only the advance changes (gated here: the expression budget of a correction).
- `validRentPublic()`: Tenant rent-history link (follow-up to #170): rent_public/{token} is a read-only snapshot anyone holding the exact token may get (no list). Written only by rentals roles while the lease points at this token (same write as the lease change, via getAfter); removed when the link is turned off/replaced.
- in `validRentPublic()`: lid is fixed, except when the link moves with a change of unit (to the lease made from the old one).
- `rentAuditOk()`: Audit entries for rentals actions from users with a rentals role (a rentals-only helper isn't approved for the shop).
- `validRentSettings()`: Settings › Rentals: defaults for NEW leases (rent_settings/default only). Rentals roles read; owner/manager write; the owner deletes.

#### Security deposit ledger (#157, RENT-14): rent_deposits/{tenantId}

- `rentDepAt()`: {tenantId, tenantName, held, entries[≤ 24]}; held = Σ received − Σ adjusted − Σ refunded, never below 0. Any rentals role appends one own entry; only the owner rewrites (edits / removes) entries, with held still their sum. An adjustment pays a month of this tenant in the same write: the charge gains a 'deposit' payment of the same amount (rentDepPaysOk checks the other side).
- `rentDepNewOk()`: The new entry (index n), held moved by it; an adjustment is this tenant's charge gaining a 'deposit' payment of the same amount in this write.

#### Property expenses (#157, RENT-17): rent_expenses/{id}

- `validRentExpense()`: Paid for a property (or one of its units): repairs, tax, maintenance, insurance, broker, other. Any rentals role adds one signed with its uid; only the owner edits or deletes. Never Aadhat cash.
- `rentDepPaysOk()`: The 'deposit' payment of charge `chargeId`: the tenant's ledger gains its adjustment in this write.
- `match /{collection}/{docId}`: PRODUCTION COLLECTIONS Business collections (production and dev_ mirrors) live under one wildcard match. Reads: see canReadRecord (own notifications/drafts/auto-save, settings/app only, withdrawals by role access).
Stock records need an up-to-date app (clientVersion >= 3) on create/update.
Bills: full edits by owner/manager/creator; anyone else approved may only record payment/due bookkeeping. Only an owner may change userId. Cash, expenses, stock adjustments, items, counters: see canUpdateRecord. Auto-saves and drafts: their own user only; notifications: the recipient marks them read.
Bills: only an owner deletes them (#75: everyone else voids). Cash sessions, items, counters, item frequency and settings: owner only. Expenses: owner/manager, or the creator within 24 hours. Withdrawals/stock adjustments: owner/manager. Auto-saves, drafts, notifications: their own user, or the owner (Clear Data).
- `match /purchases/{billId}/edits/{editId}`: Bill edit records (#121, validEditCreate): approved users read them (opened from the bill details); created only with the bill update that raises its editCount; never changed; the owner deletes them only once their bill is gone (delete for good, Clear Data).
- `match /stockCheckpoints/{docId}`: State/lease writes: owner or manager only; anyone approved may mark it stale. legacyScan (backfill completion state): owner/manager only, so staff can't switch the backfill off; staff devices still backfill and ignore the denied state write. No other doc ids.
- `validAnomaly()`: --- anomalies (#187 / #40): found by the daily scan on owner/manager devices; only owner/manager may read them or mark them OK/fixed (#84 is still open, so other users see nothing). Only an owner may delete.

#### Manual reminders on Today (#86)

- `remIstDay()`: reminders/{id}: { title (1-120), dueDate 'YYYY-MM-DD' (India), party?, repeat? ('daily' | 'weekly' | 'monthly'), repeatDay? (monthly: 1-31), status, createdBy, createdByName?, createdAt, updatedBy/updatedByName/updatedAt, doneBy/doneByName/doneAt/nextId or cancelledBy/cancelledByName/cancelledAt, repeatOf? }. Shop-wide: every approved user reads them (Today) and may mark an open one done, for everyone. Owners and managers create them (due today or later, at most ~2 years ahead, yesterday allowed for a phone clock near midnight), edit and cancel open ones. Marking a repeating one done creates its next copy in the same batch (anyone who may mark it done): same title, party and repeat, a later date in the create range, linked both ways (nextId / repeatOf); a repeating one is never marked done without it (stop one with a change to "once" or Cancel). Done and cancelled are final. Only the owner deletes. In-app only (#58).
- `reminderNextDateOk()`: REM-6 bound: the next copy is due at most one period (+1 day of slack) after the later of its reminder's due date and today (India); a monthly period counts as 31 days.
- `validReminderNext()`: The next copy of a repeating reminder, created in the batch that marks it done.
- `reminderEditOk()`: Owner / manager edit an open reminder: title, date (a changed one in the create range), party, repeat.

#### rate trends (#65): per-item-year rate stats + backfill status

- `validRateStats()`: rateStats/{itemId}_{YYYY} holds weekly (weeks: {'wYYYY-MM-DD': bucket}) and monthly (months: {'mYYYY-MM': bucket}) buckets of one item and year; rateStats/_meta is the backfill status. Owner/manager only. Bucket maps are size-capped (rules can't check every bucket; the app writes them).

#### month snapshots (redesign §7.6): monthStats/{YYYY-MM}

- `validMonthStats()`: One doc per calendar month with that month's Money figures, per-item and top-party totals, so Money / Insights compare with last year without reading old bills. Built and rolled by owner/manager devices; read by them.
- in `validMonthStats()`: Month figures include expenses: built only by an app that knows voided expenses (#99)
- `monthStaleMarkOnly()`: Saving, editing or deleting a bill, expense or withdrawal dated in an earlier month marks that month stale (firestore-service.js noteMonthWrite, a merge write): any approved user, only `stale: true` and its time; a month without a snapshot gets a stub { month, stale, staleAt }.

#### Test in Production (#217)

- `validTipHealth()`: tipHealth/{deviceId}_{YYYYMMDD}: daily per-device counters, written with set+merge and FieldValue.increment. Any approved user may create/update only their own device docs (uid, deviceId and day can't change); the per-version map is capped. tipFailures/{deviceId}_{YYYYMMDD}_{1..20}: create-only samples, so at most 20 per device per day. Owner/manager read.
- `match /users/{userId}/preferences/{prefId}`: Never used by the app (#64): readable by its user, written by nobody.
- `match /auditLogs/{logId}`: Audit logs - approved users append entries as themselves; only owners read, and only owners delete entries older than 90 days (retention cleanup).
- `match /telemetry/{docId}`: Telemetry - append-only error reports; only owners read them, and hide them (Diagnostics, #116: hidden, never deleted by the app; delete stays for repairs).
- `match /rent_public/{token}`: Tenant rent-history link: anyone with the exact token reads one doc; nobody lists.
- `match /rent_properties/{docId}`: Rentals (#170): helpers above. Deletes: owner, or move-out removing unpaid later months.
- `match /rent_receipts/{rid}`: Rent receipts and their yearly counters (helpers above): rentals roles read; created with a payment, or later for a payment without one (its writer or owner/manager); never edited except cancel (owner/manager); never deleted.
- `match /dev_users/{userId}`: DEVELOPMENT ENVIRONMENT COLLECTIONS (dev_ prefix) Same rules as production, with dev_users as the profile source.
