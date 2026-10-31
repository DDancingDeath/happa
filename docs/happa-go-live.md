# Happa go-live runbook (26 Oct 2026, ~15:00 IST)

Happa is a **new app**: its own Android package, signing key, Firebase project
(business account, Firestore in `asia-south1`) and website. The old app is
archived and must not change: Android `com.hitesh.aadhat`, Firebase project
`aadhat-management`, site `aadhat-management.web.app`, last release v1.6.1.

Every Happa-specific value lives in **`happa.config.json`**.
`npm run apply:happa-config` copies it into every file that needs it, and
`npm run check:happa-config` fails while any placeholder is left. The release
workflow runs that check on tag builds.

Data moves with the migration tool from the separate PR (branch
`feat/migrate-project-15`). Its `README` is the source of truth for the data
steps. This runbook only says when to run it.

Run the commands in PowerShell from a clone of the repo (e.g. `Q:\aadhat\happa-app`).

---

## 0. Merge order (owner decision)

**#231 → #226 → #228 → #229 → #230 → #227 → #232**

1. **#231** (this happa PR) merges first, after the cut-off steps 6–7.
2. Then the feature PRs **#226, #228, #229, #230, #227**, in that order.
   Rebase each one on `main` first. Each takes the next cache bump with the
   new prefix: `?v=` token, `BUILD_ID` and `CACHE_NAME = 'happa-v2'`, `'happa-v3'`, …
   (not `aadhat-vN`).
3. **#232** (migration tool + cutover runbook) merges last. The migration
   `apply` runs only after #232 has merged (step 10).

The old project `aadhat-management` must stay untouched. While `main` is
still the old app, **every** merge to `main` deploys to it. So until #231
merges, **don't merge anything to `main`**. Also avoid pushing to the
feature PRs: their own PR-preview workflow still uses the old secret and would
create preview channels in `aadhat-management`. The live old site is not
affected, but the project is. Once the old secrets are deleted (step 7), those
runs fail instead of deploying. After rebasing on `main` they preview to happa.

## 1. Create the Firebase project (console, business account)

1. Done: project **`happa-bfc07`** (console display name "Happa"). The app's
   address is the site **`myhappa`** → https://myhappa.web.app. The site `happaapp`
   and the default site `happa-bfc07` (which can't be deleted) serve no app files,
   only a 301 of every path to myhappa. All set in `happa.config.json`.
2. Firestore: **Create database → Production mode → location `asia-south1` (Mumbai)**.
   You cannot change the location later.
3. Authentication: enable **Email/Password**. Phone sign-in stays enabled in the
   console for a planned future feature; the app does not use it yet. Check that `myhappa.web.app`
   and `happa-bfc07.firebaseapp.com` (the `authDomain`; its `/__/auth/*` handler
   keeps working, Hosting serves `/__/` before redirects) are listed under
   *Authorized domains*.
4. Done: the web app config is in `happa.config.json` (public client config, not a
   secret). `measurementId` is kept there, but the Analytics SDK is deliberately
   not loaded.
5. Hosting: `hostingSite` is `myhappa` (the address on the download page, QR,
   update banner, share text and password-reset link). `redirectHostingSites`
   lists `happaapp` and `happa-bfc07`: `npm run apply:happa-config` gives them a
   `firebase.json` entry with no app files (`hosting-redirect/`) and one 301 of
   every path to myhappa. The guard and `check:happa-config` fail a deploy unless
   myhappa gets the app and the others get only that redirect.

   Each address has its own offline storage. Install and use happa from
   https://myhappa.web.app; don't switch addresses on a device with unsynced
   offline bills.

## 2. Fill in `happa.config.json`

| Field | Value |
|---|---|
| `firebase.projectId` | ✅ `happa-bfc07` (already filled) |
| `firebase.apiKey` | ✅ filled |
| `firebase.messagingSenderId` | ✅ filled |
| `firebase.appId` | ✅ filled |
| `firebase.measurementId` | ✅ filled (Analytics SDK not loaded) |
| `firebase.hostingSite` | ✅ `myhappa` (https://myhappa.web.app) |
| `firebase.redirectHostingSites` | ✅ `["happaapp", "happa-bfc07"]` (301 to myhappa, no app files) |
| `androidPackage` | ✅ `com.happa` (owner confirmed; it can never change after phones install v1.0.0) |
| `appName` / `appNameHi` | ✅ `happa`: all lowercase wherever it is shown, the same in English and Hindi |
| `apkName` | ✅ `happa` → `happa.apk` / `happa-vX.Y.Z.apk`, release "happa vX.Y.Z" |
| `ownerConfirmed` | ✅ `true` |

All values are filled and `npm run check:happa-config` passes. The commands below are
only needed if a value changes again. `apply` also moves `MainActivity.java` to the
folder that matches `androidPackage`.

```powershell
npm ci
npm run apply:happa-config      # also regenerates www/img/download-qr.svg (needs internet for npx qrcode)
npm run check:happa-config      # must print OK
npm test; npm run check:sw; npm run check:release
git add -A; git commit -m "chore(happa): fill in project config"
```

The PR's cache bump (`?v=20261025g`, `BUILD_ID`, `CACHE_NAME = 'happa-v1'`) covers
these `www/` changes. Bump again (AGENTS.md section 4) only if a PR merged
after this one already used those values.

## 3. Create the Happa signing key (never commit it)

```powershell
$dir = 'C:\Users\hik\AadhatManagementApp-apk\signing-happa'
New-Item -ItemType Directory -Force $dir | Out-Null
keytool -genkeypair -v -keystore "$dir\happa-release.keystore" -alias happa `
  -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Happa, O=Happa, C=IN"
keytool -list -v -keystore "$dir\happa-release.keystore" -alias happa   # copy the "SHA256:" line
```

Save the keystore file and both passwords in the password manager. **If you lose
them, Happa can never be updated on phones again.** For local release builds,
create `android\keystore-happa.properties` (git-ignored) with `storeFile`,
`storePassword`, `keyAlias`, `keyPassword`. The old `keystore.properties` is
not read any more.

## 4. Repository secrets and variable (owner token)

```powershell
$env:GH_TOKEN = (gh auth token -u DDancingDeath)
$R = 'DDancingDeath/happa'
$ks = 'C:\Users\hik\AadhatManagementApp-apk\signing-happa\happa-release.keystore'

[Convert]::ToBase64String([IO.File]::ReadAllBytes($ks)) | gh secret set HAPPA_KEYSTORE_BASE64 -R $R
gh secret set HAPPA_KEYSTORE_PASSWORD -R $R       # prompts; paste the store password
gh secret set HAPPA_KEY_ALIAS -R $R --body happa
gh secret set HAPPA_KEY_PASSWORD -R $R            # prompts; paste the key password
gh variable set HAPPA_CERT_SHA256 -R $R --body '<SHA256 from keytool, colons are fine>'
```

Service account for the GitHub workflows (Google Cloud console → IAM & Admin →
Service accounts, in the **new** project). Create `github-deploy` with these roles:
Firebase Hosting Admin, API Keys Viewer, Firebase Rules Admin,
Cloud Datastore Index Admin, Service Usage Consumer and Cloud Datastore Viewer
(the last one is for the backup and TIP). Then create a JSON key:

```powershell
Get-Content .\happa-sa.json -Raw | gh secret set FIREBASE_SERVICE_ACCOUNT_HAPPA -R $R
Remove-Item .\happa-sa.json
# optional: a read-only account (Cloud Datastore Viewer only) just for the backup/TIP
# Get-Content .\happa-backup-sa.json -Raw | gh secret set FIREBASE_BACKUP_SERVICE_ACCOUNT_HAPPA -R $R
```

`BACKUP_PASSPHRASE` is reused by happa's backup; keep it. The old secrets
(`FIREBASE_SERVICE_ACCOUNT_AADHAT_MANAGEMENT`, `FIREBASE_BACKUP_SERVICE_ACCOUNT`,
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEY_PASSWORD`) are **not** read by #231's workflows. They are still
read by the workflows on every older ref: branches made before #231, PRs that
have not been rebased, and the tags v1.3.0–v1.6.1. A manual dispatch or a push
on such a ref could deploy to `aadhat-management`, or publish an old-app APK as
the *latest* release. Step 7 deletes them once the final old backup and the
auth export are done.

## 5. Deploy Firestore rules and indexes to the new project

Do this before the migration (step 10) so the data is protected from the start.

```powershell
npx --yes firebase-tools@latest login      # the business account
npx --yes firebase-tools@latest deploy --only firestore:rules,firestore:indexes --project happa-bfc07
```

## 6. Cut-off: stop billing in the old app, final backup and auth export

1. Pick a cut-off time. After it, nobody bills in the old app. Every phone
   opens the old app once while online, so queued offline bills get uploaded.
2. Take a final backup of the old project: Actions → *Firestore backup* →
   Run workflow on `main`. This must happen **before** #231 merges and before
   step 7, because it still uses the old secrets to back up `aadhat-management`.
   Download the artifact and keep it with `BACKUP_PASSPHRASE`.
3. Export the old project's Auth users, read-only, as the #232 README describes,
   e.g. `npx --yes firebase-tools@latest auth:export old-auth-users.json --format=json --project aadhat-management`.
   Keep the file private. It contains password hashes; never commit it.
   It still holds the archived staging clone's two logins (`staging-readonly@aadhat.local`,
   `staging-owner@aadhat.local`, #101). The migration tool never carries them
   (README, "Service accounts"); if you use the plain `firebase auth:import`,
   run `migrate.js auth:filter` on the export first.
4. Optionally, do a migration **dry run** from the #232 branch to check the counts.
   The real `apply` waits for step 10.

## 7. Delete the old app's repository secrets

Do this only after step 6.2 (final backup) and step 6.3 (`auth:export`) have
succeeded. Use the owner token. This only removes GitHub secrets; it does
**not** touch the old project's IAM or service accounts.

```powershell
$env:GH_TOKEN = (gh auth token -u DDancingDeath)
$R = 'DDancingDeath/AadhatManagementApp'
foreach ($s in 'FIREBASE_SERVICE_ACCOUNT_AADHAT_MANAGEMENT', 'FIREBASE_BACKUP_SERVICE_ACCOUNT',
               'ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD') {
    gh secret delete $s -R $R
}
gh secret list -R $R    # BACKUP_PASSPHRASE, HAPPA_* and FIREBASE_SERVICE_ACCOUNT_HAPPA remain
```

Keep `BACKUP_PASSPHRASE`. The old keystore and its passwords stay in the
password manager and in `C:\Users\hik\AadhatManagementApp-apk\`. The
`ANDROID_CERT_SHA256` variable is harmless without the keystore secrets and can stay.
After this, an old ref can no longer deploy to `aadhat-management` or sign an
old-app APK. Those runs fail at the secret check.

## 8. Merge #231 (= deploy hosting)

Merging deploys `www/` to `https://myhappa.web.app` and the 301 redirects on happaapp / happa-bfc07 (*Deploy to
Firebase Hosting on merge*), and, because `happa.config.json` changed, it also
re-deploys rules and indexes to the new project. Check that:

- both runs passed, and the guard step printed `project=happa-bfc07`;
- `https://myhappa.web.app` and `/download` open; `https://happaapp.web.app` and `https://happa-bfc07.web.app` 301 to it;
- `https://aadhat-management.web.app` still shows the old app, unchanged.

Do **not** revert the merge commit to roll back. That would bring back the
workflows that deploy to `aadhat-management` (after step 7 they would fail).
Fix forward instead; the old app keeps working on its own.

## 9. Merge the feature PRs, then #232

Merge **#226 → #228 → #229 → #230 → #227 → #232**, in that order. Rebase each one
on `main` and let CI pass first; step 0 has the cache bump. Every merge now
deploys to happa only.

## 10. Run the migration (after #232 has merged)

Run the migration tool from `main`, exactly as the #232 README says: dry run,
check the counts, then `apply` into `happa-bfc07`. Its source is the old
project (read-only, with the owner's local credentials, not repository secrets)
plus the auth export from step 6.3.

Service accounts (#101): the plan report must say **"Skipped 2 service
accounts"** and `auth:import` the same. Run `wipe` first even without a new
rehearsal: the 26 Oct rehearsal imported both staging logins into
`happa-bfc07` Auth, and `wipe` deletes them. After the import, Authentication →
Users must list no `staging-*@aadhat.local` login.

Owner action, outside this tool (it never changes `aadhat-management`): in the
old project's console, disable or delete `staging-readonly@aadhat.local` (and
`staging-owner@aadhat.local`), delete or reject their `users/{uid}` docs,
remove any stored password for them, and delete the branch
`feat/staging-readonly-rule`.

## 11. Tag v1.0.0 (Android release)

Run the manual checks in [release-checklist.md](release-checklist.md) on a
release candidate first (printer, offline bills, cash, install over the RC, timings).

```powershell
git fetch origin
git tag v1.0.0 origin/main
git push origin v1.0.0
```

The *Android release* workflow checks `check:happa-config`, builds and signs
with the happa key, checks the certificate against `HAPPA_CERT_SHA256` and the
package (`com.happa`) against `happa.config.json`, then publishes
**"happa v1.0.0"** with `happa.apk` and `happa-v1.0.0.apk`. Tag after step 10,
so the APK has the feature PRs in it and the data is already in place.

**Release candidate first (optional).** A tag `v1.0.0-rc1` (on a commit whose
`package.json` version is `1.0.0`) runs the same build, signing and certificate
checks but publishes **"happa v1.0.0-rc1"** as a *prerelease* that is never
marked latest, with `happa.apk` and `happa-v1.0.0-rc1.apk`. The update banner and
`/download` read `releases/latest`, so they don't offer it; testers install it
from the release page. It has the same version code as v1.0.0, so the final APK
installs over it.

Side effect: happa v1.0.0 becomes the repo's *latest* release. The old app's
download page link (`releases/latest/download/AadhatManagement.apk`) then stops
working. The old APK stays available at `releases/tag/v1.6.1`. Old phones get
no update banner, because 1.0.0 is lower than 1.6.1. Once happa reaches a
version above 1.6.1, old installs would offer a broken update, so remove the
old app from the phones before that.

**After the next RC: lock out rc1 (`minClientVersion: 4`).** rc1 (and any APK
built before #75/#121) has its web code inside the APK and writes
`clientVersion: 3`; it doesn't know voided bills. Since #196 the rules refuse a
`clientVersion` below 4 on everything built from bills (the stock checkpoint,
month snapshots `monthStats`, rate patterns `rateStats`) and on bill voids and
edits, so rc1 can't write a wrong figure. Its screens still count voided bills,
though, its Delete and Edit buttons now end in its own "failed" message (the
server refuses them, and rc1's text can't be changed), and it still saves new
bills and payments. So:

1. Tag the next RC (`v1.0.0-rc2`) or v1.0.0 from a main that has #196.
2. Every rc1 tester installs it over rc1 (same signing key, nothing to remove).
3. Then the owner sets `minClientVersion: 4` on `settings/app` (Firebase
   console → Firestore → `settings` → `app`). rc1 then shows "Please update"
   at start and does nothing else. (`enforceClientVersion` only refuses writes
   below version 3; the figures, voids and edits need 4 regardless.)

The first phone with the new code rebuilds the stock checkpoint once (format 4:
one full read of the bill history, like the weekly rebuild) and re-rolls the
current and last month's snapshots (2 writes, version 2). Older month
snapshots stay in use: no bill was voided before #196, and rc1 can't write
them any more.

## 12. Install on the phones

On each phone, open `https://myhappa.web.app/download`, download `happa.apk`
and install it. It installs **next to** the old app; nothing is replaced. Sign in.
Accounts and roles work as the migration README describes. Any user it did not
carry over registers again, and the owner approves them in Admin.

## 13. Opening stock

In Happa, count each item and enter the opening quantity with a stock
adjustment. Do this once, before the first bill.

## 14. Start billing in happa

All new bills go into Happa from now on. Keep the old app only to look things up.
Afterwards, run *Firestore backup* and *TIP auto bugs* once by hand (Actions →
Run workflow) to confirm they read the new project.

---

## Where the app/project identity lives

Written by `npm run apply:happa-config` from `happa.config.json`:

- `.firebaserc` (default project), `firebase.json` (`hosting.site`)
- `capacitor.config.json` (`appId`, `appName`)
- `android/app/build.gradle` (`applicationId` and `namespace`), and `MainActivity.java` is moved to `android/app/src/main/java/com/happa/`
- `android/app/src/main/res/values/strings.xml` (`app_name`, `title_activity_main`, `package_name`, `custom_url_scheme`)
- `www/manifest.webmanifest` (`name`, `short_name`)
- `www/firebaseConfig.js` (the `<happa-config>` block)
- `www/js/config/app-identity.js` (name, site, download/APK/release URLs). It is used by the update banner, share text, What's new, password-reset link, reports and notifications
- `www/index.html` (`<title>`), `www/js/i18n/en.js` + `hi.js` (`ui.app.name`, used by the login screen, side menu and About)
- `www/download.html` (`data-happa*` markers), `www/img/download-qr.svg`

These read it at run time: `scripts/release-notes.js`, `playwright*.config.js`,
`tests/e2e/support/emulator.js`, `scripts/inspect-app.js`,
`scripts/save-login.js`, `tools/tip/autobugs.js`, and every workflow
(`scripts/happa-config.js guard` / `get`).
