# Error and crash reporting

How happa finds out about errors on the phones and the website (#122), and why
there is no crash-reporting SDK. Everything here is free on the Spark plan.

## What is in place

| Layer | What it catches | Where it shows | Code |
|---|---|---|---|
| Error telemetry | Uncaught errors (`window.onerror`), unhandled promise rejections and `console.error`, grouped by fingerprint. Firestore quota errors are not sent (they would only fail again) | Diagnostics (owner), collection `telemetry` (create-only, owner read, field sizes capped by the rules) | `www/js/services/telemetry.js`, `firebase/repos/telemetry.js` |
| Test in Production (TIP) | Bill save, payment, cash close and app start: failures, slow runs, runs with errors (`errors_seen`), and runs left open when the app was killed or crashed (`abandoned`) | App health page; a daily job opens, updates and closes `tip-auto` GitHub issues (counts and reason codes only) | `www/js/tip/`, `tools/tip/autobugs.js`, `.github/workflows/tip-autobugs.yml` |
| Startup and read meter | Startup step timings, document reads per session, quota-exhausted errors (one banner per session) | Diagnostics → "Startup timings", "Data reads this session" | `utils/startup-timings.js`, `firebase/firestore-meter.js`, `utils/quota-guard.js` |

The Android APK is the same web app inside a Capacitor WebView, so all of the
above works there too: a JavaScript error in the APK is reported exactly like
one on the website.

## What is not covered

- **Native crashes** of the Android shell (a Java exception in a plugin, the
  WebView renderer dying, out of memory). No stack trace is collected. TIP still
  notices the effect: a bill save, payment, cash close or app start that was
  running when the app died is counted as `abandoned` the next time the app
  opens, and the daily job files a `tip-auto` issue when that repeats.
- **Errors before sign-in** (login screen). The rules accept telemetry only from
  an approved user, so these stay in the browser console.
- **Android vitals** (Play Console) only covers apps installed from Google Play;
  happa is installed from the GitHub release, so it has none.

## Options considered

| Option | Cost | Why not now |
|---|---|---|
| Firebase Crashlytics (APK) | Free on Spark | Needs `google-services.json`, the Google services and Crashlytics Gradle plugins, the Firebase Android SDK and a Capacitor plugin, so a bigger APK and a new native build path to maintain. It sends device identifiers and stack traces to Google, so the scrubbing in #116 must come first. Worth it only if TIP starts showing `abandoned` runs that the web telemetry can't explain |
| Sentry free tier (web + APK) | Free up to a monthly event limit | A third party outside Firebase; needs a new CSP origin and the #116 scrubbing first; the limit can run out silently |
| Sending error text to GitHub issues | Free | The repo is public and the errors can hold names, amounts and URLs. TIP issues carry counts and reason codes only, on purpose |

**Decision:** keep the existing telemetry plus TIP. Revisit Crashlytics if
`abandoned` TIP runs appear that have no matching error in Diagnostics.

## When something breaks in the field

1. App health: which check is failing, on which app version, since when.
2. Diagnostics (owner): the grouped error, its count and the last stack.
3. A `tip-auto` issue is opened automatically when failures repeat; add what you
   found there (without customer names or amounts).
