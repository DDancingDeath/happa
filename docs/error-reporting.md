# Error and crash reporting

How happa finds out about errors on the phones and the website (#122). Everything
here is free on the Spark plan.

## What is in place

| Layer | What it catches | Where it shows | Code |
|---|---|---|---|
| Error telemetry | Uncaught errors and unhandled promise rejections (the `error` / `unhandledrejection` listeners in `main.js`) plus explicit `logError` / `logWarning` calls, grouped by fingerprint. Errors only written with `console.error` (most `catch` blocks) are **not** sent. Firestore quota errors are not sent (they would only fail again) | Diagnostics (owner), collection `telemetry` (create-only, owner read, field sizes capped by the rules) | `www/js/services/telemetry.js`, `firebase/repos/telemetry.js` |
| Test in Production (TIP) | Bill save, payment, cash close and app start: failures, slow runs, runs with errors (`errors_seen`), and runs left open when the app was killed or crashed (`abandoned`). Watchdog (#83): `MainThread` fails `frozen` when a 1-second timer runs 5 s or more late while the app is on screen (a frozen screen). The timer runs only while the page is on screen; each 5 minutes on screen is one run, a shorter stretch counts once it lasted a minute, sleep is not judged, and it keeps at most 2 failure samples a day (`maxSamplesPerDay`) so the other tests keep theirs; a change still waiting to sync online after 5 minutes is `Sync` › `not_flushed` (#161). No reads | App health page; a daily job opens, updates and closes `tip-auto` GitHub issues (counts, reason codes and a few small samples: rounded bill totals, line counts, flags; no names) | `www/js/tip/`, `tools/tip/autobugs.js`, `.github/workflows/tip-autobugs.yml` |
| Crash reports (Android app only, **off unless the user switches it on**) | Native crashes of the APK (a Java exception in a plugin, the app killed by an uncaught error): Firebase Crashlytics through the `@capacitor-firebase/crashlytics` plugin | Firebase console › Crashlytics (owner's Google account) | `www/js/services/crash-reports.js`, Settings › Crash reports, `android/app/src/main/AndroidManifest.xml` (`firebase_crashlytics_collection_enabled` false) |
| Startup and read meter | Startup step timings, document reads per session, quota-exhausted errors (one banner per session) | Diagnostics → "Startup timings", "Data reads this session" | `utils/startup-timings.js`, `firebase/firestore-meter.js`, `utils/quota-guard.js` |

The Android APK is the same web app inside a Capacitor WebView, so all of the
above works there too: a JavaScript error in the APK is reported exactly like
one on the website.

## What is not covered

- **Native crashes on phones that did not switch crash reports on** (and every
  native crash while the APK has no Firebase config, see "Crash reports: set-up").
  The WebView renderer dying or the phone killing the app for memory is not a
  crash Crashlytics sees either. TIP still notices the effect: a bill save, payment, cash close or app start that was
  running when the app died is counted as `abandoned` the next time the app
  opens, and the daily job files a `tip-auto` issue when that repeats.
- **Errors before sign-in** (login screen). The rules accept telemetry only from
  an approved user, so these stay in the browser console.
- **Android vitals** (Play Console) only covers apps installed from Google Play;
  happa is installed from the GitHub release, so it has none.

## Options considered

| Option | Cost | Why not now |
|---|---|---|
| Firebase Crashlytics (APK) | Free on Spark (and Blaze) | **Chosen, opt-in** (below). A native stack trace carries no app data (no names, amounts or text the user typed), so the #116 scrubbing of web error text is not needed for it; the app sets no user id, keys or logs |
| Sentry free tier (web + APK) | Free up to a monthly event limit | A third party outside Firebase; needs a new CSP origin and the #116 scrubbing first; the limit can run out silently |
| Sending error text to GitHub issues | Free | The repo is public and the errors can hold names, amounts and URLs. TIP issues carry only counts, reason codes and small sanitized samples, on purpose |

**Decision:** keep the existing telemetry plus TIP for the web code (also inside the APK), and add Crashlytics for native crashes of the APK, off by default (#122). A cheap improvement for later: also send the `console.error` calls of `catch` blocks (`TelemetryService.init()` exists but is not called; the `main.js` listeners would then need removing so errors aren't counted twice). Revisit Crashlytics if
`abandoned` TIP runs appear that have no matching error in Diagnostics.

## Crash reports: privacy, size, set-up

**What is sent, and only after the user switches it on.** Settings › Crash reports
(shown only in the Android app) is off on every phone until its user turns it on;
the APK's manifest keeps Crashlytics collection off (`firebase_crashlytics_collection_enabled`
false) and Firebase Sessions off for good (`firebase_sessions_enabled` false: no event on each
app open), and the app turns collection on at run time only for that phone. Then a crash (or
the app not responding) sends one report, and Crashlytics fetches its settings from Google
once a day. A report holds the stack trace, the phone model, Android and app version, free memory
and disk, the time, and a Firebase installation id (a random number per install,
not the phone's IMEI or Android id). The app never calls `setUserId`,
`setCustomKey` or `log`, so no user, shop, customer, bill or amount is in it.
Reports that Crashlytics kept on the phone while the switch was off are deleted
(`deleteUnsentReports`) after each sign-in and when the switch is turned on,
so nothing from before the consent is sent. Switching it off stops collection
and deletes what is still waiting.

**DPDP Act 2023.** The installation id and the phone details can be personal data
of the person using the phone, so the switch is the consent: off by default,
explained in the app's language next to the switch (who gets what, for how long),
and can be withdrawn at any time on the same screen. Google processes the
reports for the shop (Firebase data processing terms) and keeps them 90 days;
the owner can delete them in the Firebase console. Nothing else from the app
goes to Crashlytics: the web error telemetry above stays in the shop's own
Firestore.

**APK size.** The plugin brings the Firebase Crashlytics Android SDK
(`firebase-crashlytics` 19.4 with `firebase-common`, `firebase-installations`,
`firebase-sessions` and the transport libraries): the debug APK grows from 12.2 MB to
14.4 MB (+2.2 MB, CI build of 2 Nov 2026). Release builds are not minified
(`minifyEnabled false`), so they grow about as much; turning on R8 would win most of it back.

**Set-up (owner, once).** Until this is done the APK builds and runs as before
and the switch says "Not set up in this version of the app yet":
1. Firebase console › project `happa-bfc07` › Project settings › Add app ›
   Android, package name `com.happa` (no SHA-1 needed for Crashlytics).
2. Download `google-services.json`. It is configuration, not a secret, but keep
   it out of the public repo: GitHub › Settings › Secrets › Actions › new secret
   `GOOGLE_SERVICES_JSON` with the file's whole text.
3. Firebase console › Crashlytics › enable it for the Android app.
4. Build the next APK (tag, `android-release.yml`): with the secret present the
   workflow writes the file before the build and `android/app/build.gradle`
   applies the Google services and Crashlytics Gradle plugins.
5. On a test phone: Settings › Crash reports on. Crashlytics shows the app once a
   crash has been sent (it sends on the next app start after a crash).

## When something breaks in the field

1. App health: which check is failing, on which app version, since when.
2. Diagnostics (owner): the grouped error, its count and the last stack. **Export
   report** (#83) saves the listed errors as a JSON file, scrubbed again with
   `utils/scrub.js` (no user names or ids; the shop's people's names from the team list, the audit
   profiles and the reports themselves become `<person>`), with this phone's Status text, to send to
   whoever fixes the app; the export is an `EXPORT` audit row.
3. A `tip-auto` issue is opened automatically when failures repeat; add what you
   found there (without customer names or amounts).
