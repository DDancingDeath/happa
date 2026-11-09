# Owner device checklist (rc14)

The code for these items is done and tested in CI. What is left needs a real phone, the shop PC or
the owner's Firebase console, so it can't be checked from here. Do them once on **v1.0.0-rc14** (or the
first release after it) and note the result in the follow-up issue "[Owner] Device checks on rc14".

| Check | From | Where | Time |
|---|---|---|---|
| 1. Cold start on the shop phone | #59 | Shop phone, Android app | 5 min |
| 2. Voice billing, Hindi and English | #81 | Shop phone, Android app | 15 min |
| 3. Thermal printer from the shop PC | #133 | Shop PC, Chrome or Edge | 10 min |
| 4. One test crash | #122 | Shop phone, Android app, after the cut-over | 5 min |

## 1. Cold start (#59)

**Target:** from the tap on the app icon until Billing can be used, **≤ 2.5 s** on the shop's phone
([performance-budget.md](performance-budget.md)).

1. Install rc14 and sign in once as the owner, on the shop's Wi-Fi or mobile data.
2. Close the app fully (swipe it away from the recent apps), wait a few seconds, then tap the icon.
3. Open **Settings › Diagnostics**, unfold **Technical details › ⏱ Startup timings** (ms since page
   start). The **`app-shown`** row is the cold-start time: the first screen is usable then. The other
   rows show where the time went (`sdk-and-modules-loaded`, `templates`, `auth`, `profile`,
   `listeners`, `version-check`; `stock` comes after the screen is shown and is not part of it).
4. Repeat steps 2–3 three times; also time one open with a stopwatch.

**Pass:** `app-shown` ≤ 2,500 ms in at least two of three opens, and the stopwatch agrees (within about
half a second, which is the Android splash before the page starts). **If it fails:** note the slowest
row and whether the phone was online; the same table's `profile` and `listeners` details say whether
the data came from the phone's copy (`fromCache`) or the server.

## 2. Voice billing (#81)

Switch it on first: **Settings › Voice billing** (per phone, off by default). Details:
[voice-billing.md](voice-billing.md).

1. **Mic prompt:** tap 🎤 on the purchase form. Android asks once for the microphone: allow it. The
   check dialog opens after you speak.    (If you deny it, the app says "Microphone permission is off…" and
      nothing else breaks.)
2. **Hindi** (app language Hindi): "गेहूं 50 किलो 25 रुपये" → one line, wheat, 50 kg, ₹25. Then two
   lines in one sentence: "गेहूं 50 किलो 25 रुपये और सरसों 30 किलो 55 रुपये", and a customer: "ग्राहक
   का नाम रमेश".
3. **English** (app language English): "wheat 50 kg 25 rupees and mustard 30 kg 55 rupees",
   "customer name is Mohan".
4. **Noise:** repeat one of the above in the shop at a busy time.
5. **Offline:** turn on flight mode and try once more.
6. **Readback:** the dialog reads what it understood aloud (when the phone has an on-device voice for
   the language; otherwise the switch is hidden and nothing is read).

**Pass:** each sentence shows the right item, kg and rate (and customer) in the check dialog before
anything is filled; OK fills or adds the lines and nothing is saved until you tap Save. In noise or
offline it may hear less, but it must never fill a wrong line without the dialog showing it; offline
it either works (the phone's offline speech pack) or says "Voice needs the internet here". Note the phone model and anything misheard.

## 3. Thermal printer from the shop PC (#133)

Full steps: [desktop-printing.md](desktop-printing.md) › "Owner checklist".

1. Windows Settings › Bluetooth & devices: pair the shop's thermal printer.
2. In **Chrome or Edge**, open https://myhappa.web.app/spike/serial.html. Step 1 should say the browser
   can talk to the printer directly.
3. **Choose printer** (listed by name or as "Standard Serial over Bluetooth link (COMx)"), then
   **Print test slip**; click it again once.
4. Switch the printer off and click **Print test slip**.

**Pass:** a test slip comes out, sharp, full width, with readable Hindi; the second click prints once,
quickly; with the printer off the log shows a failure within about 10–25 s and nothing prints later.
Note the Windows and Chrome/Edge versions and copy the page's log. If step 3 prints nothing, try
**Print with Windows** (paper 58 mm, margins none) and note that result instead; it decides whether a
desktop app shell is needed (#144).

## 4. One test crash (#122)

Only after the cut-over to **happa-bahi**, once the `GOOGLE_SERVICES_JSON` secret holds that project's
`google-services.json` and an APK has been built with it ([error-reporting.md](error-reporting.md) ›
"Set-up"). Until then the switch says crash reports are not set up.

1. **Settings › Crash reports**: switch on.
2. **Settings › Diagnostics › Status › Test error reports › Send a test crash (closes the app)**,
   confirm. The app closes.
3. Open the app again (the report is sent then).
4. Firebase console › Crashlytics (happa-bahi project) › Crashes.

**Pass:** the "Test crash sent by the owner from Diagnostics" report shows within a few minutes. Also
tap **Send a test error**: it shows under Diagnostics › Errors and as a non-fatal in Crashlytics.

## Closure notes

### Owner questionnaire (#111): final values

No answers came back, so **the defaults in #111 are accepted as built**, with one change:

- **Q23 (clock tolerance):** built as **warn at 9 min, refuse at 10 min**, not 5 / 15. The rules refuse
  a payment or write-off whose time is 10 minutes or more from the server's   (the payment `at` check in
    `firestore.rules`, ±600,000 ms), and 10 min is the tested safe limit; the app calls the clock wrong a minute
  earlier, at 9 min, and shows the clock banner (`PAYMENT_CLOCK_LIMIT_MS` and `CLOCK_WRONG_MS` in
  `www/js/utils/clock-skew.js`, `ui/clock-banner.js`).

### Firestore reads (#159)

Root cause and guards: [read-budget.md](read-budget.md) › "Status". A normal day's reads are measured in
week 1 after the cut-over to happa-bahi.

### Ask AI fallback (#415)

PR 4 of #415 (the optional Gemini fallback) is deferred until App Check (#89) and the AI decision
(#374); see [calculations.md](calculations.md) › Ask.
