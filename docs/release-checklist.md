# Release checklist

Run this before every APK release (`v<x.y.z>` or `-rc<n>` tag) and before any
web deploy that changes billing, printing, cash or offline saving. It takes about
30 minutes. If any step fails, don't release; open an issue and fix it first.

Release steps (changelog, `npm run release`, tag) are in AGENTS.md section 5,
"Releasing". The first release (v1.0.0) also follows [happa-go-live.md](happa-go-live.md).

## 1. Before you start

- [ ] `main` is green: *CI* (lint, Jest, rules tests) and *Playwright E2E (emulators)*.
- [ ] The last *Deploy to Firebase on merge* run succeeded, and
      https://myhappa.web.app shows the new `BUILD_ID` (Diagnostics, or the
      browser console line `[Aadhat] BUILD …`).
- [ ] The old site https://aadhat-management.web.app still shows `20261023e-release-1-6-1`.
- [ ] `npm run check:release` passes and `www/changelog.json` has the new
      version with short `en` and `hi` notes.
- [ ] Last night's *Firestore backup* run succeeded (Actions). If it didn't,
      run it by hand after the quota reset and wait for it.
- [ ] Today's Firestore reads are well under the free limit (Diagnostics →
      "Data reads this session" on the main phones).

Use a test phone signed in as the owner, plus one phone with a non-owner role.
Test against the live site / the new APK, not the emulator.

## 2. Install over the previous APK

- [ ] On a phone that has the **previous** release installed (with data and a
      saved printer), install the new `happa.apk` from the GitHub release.
      It must install **over** it with no "App not installed" error. That error
      means the signing key changed: stop, never ask users to uninstall.
- [ ] After opening: still signed in, the language, the printer and any
      unsynced bills are still there; Settings → About shows the new version.
- [ ] The "What's new" sheet shows once, in the app language.

## 3. Real printer

- [ ] Print one purchase bill and one retail bill on the shop's Bluetooth
      printer: the layout, Hindi text, totals and the QR/UPI line look right.
- [ ] Turn the printer off and print again: the app says it couldn't print
      (or "may have printed"), the bill stays saved, and you can reprint after
      turning the printer back on.

## 4. Five bills offline, then sync

- [ ] Turn on airplane mode. The header pill says Offline.
- [ ] Save 5 bills: purchase, retail sale and wholesale sale, at least one with
      a due and one paid. Each says "Saved on this phone, will sync"; none says
      "Saved" falsely, and none is lost when the app is closed and reopened offline.
- [ ] Turn the network back on. The pill goes to "N changes waiting to sync",
      then "Synced". The 5 bills appear once (no duplicates) on a second phone,
      with the right bill numbers, totals, dues and stock.

## 5. Cash open and close

- [ ] Open today's cash session (needs the network). A second phone joins the
      same session instead of opening another.
- [ ] Record a cash expense and a withdrawal; the expected drawer amount changes.
- [ ] Count and close the day. The difference shown is right, the closed day
      can't be reopened, and Today shows the closed session.

## 6. Old-version block (`minClientVersion`)

Do this only when the new release raises `CLIENT_VERSION`
(`www/js/firebase/firestore-service.js`), and only after every phone has the
new APK.

- [ ] In the Firebase console → Firestore → `settings/app`, set
      `minClientVersion` to the new `CLIENT_VERSION`.
- [ ] A phone still on the older APK shows "This app version is outdated. Please
      update the app to continue." at start and can't save anything.
- [ ] A phone on the new APK still opens and saves normally.
- [ ] If a phone that needs to work gets blocked by mistake, set
      `minClientVersion` back to the previous value at once.

## 7. Timings (record them every release)

Measure on the shop's reference phone, on mobile data. Close the app fully
before each cold start. Cold start = tap the icon until the billing screen
can be used; the app's own steps are in Diagnostics → "Startup timings"
(`app-shown`). Save = tap Save until the success message.

| Release | Date | Phone | Cold start (s) | `app-shown` (ms) | Save bill (s) | Startup reads | Notes |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

Budget: cold start ≤ 2.5 s, save ≤ 1.5 s. A release that is clearly slower than
the last row needs an issue before it goes out.

## 8. Roll out after shop hours

- [ ] Publish the release (push the tag) **after the shop closes**, never during
      billing hours, so a bad build can't stop a sale.
- [ ] Next morning, before billing starts: open the app on each phone, confirm
      the new version, print one test bill and check App health for new failures.
- [ ] If something is badly wrong, fix forward with a new release (Android won't
      install an older version code over a newer one). A bad web deploy can be
      rolled back in the Firebase console → Hosting → release history.
