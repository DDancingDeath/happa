# Release checklist

Manual checks for every APK release, about 30 minutes. If any step fails, don't
push the final tag; open an issue and fix it first. If the failure is in the app
itself (not only the APK), the website already has it: roll it back right away
(Firebase console → Hosting → release history).

The order (release steps themselves: AGENTS.md section 5, "Releasing"; the first
release, v1.0.0, also follows [happa-go-live.md](happa-go-live.md)):

1. Merge the release to `main` **after shop hours**: the website updates at the merge.
2. Tag a release candidate `v<x.y.z>-rc<n>` from that commit. It builds the signed
   APK as a prerelease that the update banner and `/download` never offer.
3. Run sections 1–5 and 7 below with the RC's `happa.apk`.
4. All good: tag `v<x.y.z>` on the same commit, after shop hours (section 8).
5. Section 6 (blocking old versions) only later, once every phone has the new APK.

## 1. Before you start

- [ ] `main` is green: *CI* (lint, Jest, rules tests) and *Playwright E2E (emulators)*.
- [ ] The last *Deploy to Firebase on merge* run succeeded, and
      https://myhappa.web.app shows the new `BUILD_ID` (the
      browser console line `[Aadhat] BUILD …`, or `window.__AADHAT_BUILD__`).
- [ ] The old site https://aadhat-management.web.app still shows `20261023e-release-1-6-1`.
- [ ] `npm run check:release` passes and `www/changelog.json` has the new
      version with short `en` and `hi` notes.
- [ ] Last night's *Firestore backup* run succeeded (Actions). If it didn't,
      run it by hand after the quota reset and wait for it.
- [ ] Today's Firestore reads are well under the free limit (Diagnostics →
      "Data reads this session" on the main phones).

Use a test phone signed in as the owner, plus one phone with a non-owner role.
Test against the live site and the RC APK, not the emulator.

## 2. Install over the previous APK

- [ ] On a phone that has the **previous** release installed (with data and a
      saved printer), install the RC's `happa.apk` from its GitHub release page.
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
- [ ] A test phone kept on the older APK shows "This app version is outdated. Please
      update the app to continue." at start and can't save anything.
- [ ] A phone on the new APK still opens and saves normally.
- [ ] If a phone that needs to work gets blocked by mistake, set
      `minClientVersion` back to the previous value at once.

## 7. Timings (record them every release)

Measure on the shop's reference phone, on mobile data. Close the app fully
before each cold start. Cold start = tap the icon until the billing screen
can be used; the app's own steps are in Diagnostics → "Startup timings"
(`app-shown`). Save = tap Save until the success message. Today ready = open Today until its figures show.

| Release | Date | Phone | Cold start (s) | `app-shown` (ms) | Save bill (s) | Today ready (s) | Startup reads | Notes |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |

Budget ([performance-budget.md](performance-budget.md)): cold start ≤ 2.5 s, save ≤ 1.5 s. A release that is clearly slower than
the last row needs an issue before it goes out.

## 8. Roll out after shop hours

- [ ] Merge to `main` (the website update) and push the final `v<x.y.z>` tag
      (the APK and its update banner) only **after the shop closes**, never
      during billing hours, so a bad build can't stop a sale.
- [ ] Next morning, before billing starts: open the app on each phone, confirm
      the new version, print one test bill and check App health for new failures.
- [ ] If something is badly wrong, fix forward with a new release (Android won't
      install an older version code over a newer one). A bad web deploy can be
      rolled back in the Firebase console → Hosting → release history.
