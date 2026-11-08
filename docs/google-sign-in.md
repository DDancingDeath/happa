# Google sign-in (web + Android)

"Continue with Google" on the login card, next to email and password. It is **built but off**:
`googleSignIn` in `happa.config.json` is `{ "web": false, "android": false }` until the owner has
done the console steps below. Off means no button, and its code is never loaded.

Target projects: `happa-bahi` (live) and `happa-bahi-dev` (test); the Android package stays
`com.happa` (owner decision). No Google sign-in is planned on the current project `happa-bfc07`
(owner decision). The `GOOGLE_SERVICES_JSON` secret is not set yet, so the APK has no Google sign-in.

- Code: `www/js/auth/google-signin.js` (loaded with `import()` only when switched on; in the
  service worker's `LAZY_ASSETS`, not precached), the switch and the profile check in
  `www/js/auth/authentication.js` (`googleSignInMode`, `completeSignIn`), the button in
  `www/templates/auth.html`.
- Tests: `www/js/__tests__/google-signin.test.js` (mocked Auth and plugin),
  `tests/e2e/google-signin.spec.js` (Auth emulator, enforced CSP). The Android picker needs a
  real-device test (end of this page).
- Local try-out: `http://localhost:<port>/?emulator=1&google=1` against the emulators turns the
  web button on (localhost only); the emulator's Google provider shows a fake account chooser.

## Who gets in: the same approval as an email registration

Every Google sign-in goes through `AuthManager.completeSignIn`, the same check as the email login:

- **No profile yet** (a new person): a pending profile is created (`role: 'staff'`,
  `status: 'pending'`, Google's name and email, in a transaction that never overwrites an existing
  profile), the person is signed out and told to wait for the owner's approval. The owner approves in
  Admin › Users as for any registration. **The app never approves anyone.**
- **Pending, rejected or removed**: signed straight back out, with the reason.
- **Approved**: the app opens with the profile's role (and `rentRole`).

The Firestore rules are unchanged: they key everything on the uid and the profile. The profile create
rule already requires `email` to equal the sign-in token's email, which Google tokens carry. Nothing
in the rules or the app checks the sign-in provider (no `providerId`, `sign_in_provider`,
`EmailAuthProvider` or re-authentication anywhere).

## Account linking (one account per email)

Keep the Firebase default "Link accounts that use the same email" (Authentication › Settings › User
account linking). Then a Google sign-in whose email already has a password here goes one of two ways:

1. **Google vouches for the email** (a verified Gmail address): Firebase signs in to the **existing**
   account (same uid, so the same profile, role and approval) and adds Google to it. If that account's
   email was never verified (happa never asks for email verification), Firebase also **removes its
   password**: the person signs in with Google from then on, or sets a new password with
   "Forgot password?".
2. **Otherwise** Firebase refuses (`auth/account-exists-with-different-credential`). The app shows
   "*email* already has a password here. Enter it once to add Google sign-in to this account", with
   the email fixed. The password sign-in shares the Login card's wrong-password backoff; on success
   `linkWithCredential` adds Google to that account, and the same profile check runs (a pending account
   stays pending). "Not now" forgets the Google credential. A Google account that is already on another
   account here is refused ("already linked to another account here").

Linking never happens without either Google's proof of the email (1) or the account's password (2).

## Web and PWA

- `signInWithPopup` with the account chooser (`prompt: select_account`). The popup opens in the tap
  itself: the module is loaded when the button is shown, so nothing is awaited before the popup (no
  popup blocker).
- **Redirect fallback**: when the popup can't open (`auth/popup-blocked`,
  `auth/operation-not-supported-in-this-environment`), `signInWithRedirect`. A per-tab mark
  (`sessionStorage`, 15 minutes) tells the reloaded page to finish it: `main.js` calls
  `AuthManager.resumeGoogleRedirect()` before `onAuthStateChanged` can start the app, and
  `getRedirectResult` goes through the same profile check.
- **Same-origin auth helper**: on Firebase Hosting (a `*.web.app` / `*.firebaseapp.com` page) with the
  web switch on, `www/firebaseConfig.js` sets `authDomain` to the page's own host. Hosting serves the
  reserved `/__/auth/handler` and `/__/auth/iframe` on every site, without the site's custom headers
  (checked on `myhappa.web.app`: 200, no `X-Frame-Options`), so the popup / redirect helper is
  same-origin. Browsers that partition third-party storage (Safari, Firefox, Chrome) lose a redirect
  result that goes through `<project>.firebaseapp.com`. Localhost and the APK keep
  `<project>.firebaseapp.com`.
- **CSP** (`firebase.json`, enforced on the web):

| Needed by Google sign-in | Directive | |
|---|---|---|
| Google's `gapi` loader, `https://apis.google.com` | `script-src`, `connect-src` | already allowed (the compat Auth SDK loads it on phones anyway) |
| `identitytoolkit.googleapis.com`, `securetoken.googleapis.com` | `connect-src` | already allowed |
| the auth helper frame `<authDomain>/__/auth/iframe` | `frame-src` | `'self'` added (the same-origin helper on Hosting); `https://<project>.firebaseapp.com` kept for localhost and is now written by `npm run apply:happa-config` from the project id, so a project move updates it |
| `accounts.google.com` | none | not needed: Google's own pages open in the popup window or the top-level redirect, which this page's CSP does not govern; the app never frames or fetches them |

  The E2E spec runs the popup flow under the enforced policy (the fixture fails on any violation).

## Android app (Capacitor WebView)

Popups and redirects don't work in the WebView (Google refuses OAuth in embedded WebViews,
"disallowed_useragent", and Firebase's popup / redirect need a real browser). So the APK uses the
**native account picker** through
[`@capacitor-firebase/authentication`](https://github.com/capawesome-team/capacitor-firebase/tree/main/packages/authentication)
**7.5.0** with `skipNativeAuth: true` and `providers: ["google.com"]` (`capacitor.config.json`):
`signInWithGoogle()` opens Android's Credential Manager picker and returns a Google ID token; the JS
SDK then signs in with `signInWithCredential(GoogleAuthProvider.credential(idToken))`. The JS SDK owns
the session, so Firestore and the rules work exactly as on the web.

Why this plugin:

- Same maintainer and version line as `@capacitor-firebase/crashlytics` 7.5.0, which the app already
  ships; maintained; uses Credential Manager (Google's current API; the old Google Sign-In for Android
  API is deprecated); `skipNativeAuth` is made for "native picker, JS SDK session".
- Alternatives: `@codetrix-studio/capacitor-google-auth` (unmaintained, Capacitor 6 at most, the
  deprecated API); `@capgo/capacitor-social-login` (works, but another vendor and no Firebase link);
  `cordova-plugin-googleplus` (deprecated API); an in-app browser (Custom Tabs) OAuth with a deep link
  back (our own redirect handling and a custom scheme to secure).
- **Compatibility**: the repo is on Capacitor 7.4.4 (`@capacitor/core`, `@capacitor/android`); 7.5.0
  needs `@capacitor/core >= 7.0.0` (8.x needs Capacitor 8). Java 21, compileSdk 35, minSdk 30: fine.
  Its optional `firebase ^11` peer (only for its web build, which the app doesn't use) clashed with the
  root `firebase@12` dependency that nothing used (the app self-hosts the 10.7.1 compat SDK;
  `rules-tests` has its own), so that dependency was dropped.
- `android/variables.gradle`: `rgcfaIncludeGoogle = true` and androidx credentials 1.3.0 (the plugin's
  setup) add Play services auth, androidx credentials and the Google ID library: the APK grows (the
  *Crashlytics build (dummy config)* job reports the size on each Android PR).
- **No `google-services.json`, no Google**: the plugin's `load()` needs the Firebase Android app and
  throws without it; Capacitor catches a plugin's load error (`PluginHandle.load` →
  `PluginLoadException`, logged), so the APK starts as before and `isPluginAvailable('FirebaseAuthentication')`
  is false: no button even with `android: true`. The picker asks for the project's web client
  (`default_web_client_id`, written by the google-services Gradle plugin from `google-services.json`;
  CI checks it is written).

## Owner / console steps

**Target projects: `happa-bahi` (live) and `happa-bahi-dev` (test)**; the Android package stays
`com.happa` (owner decision; existing installs update in place). By owner decision, **no Google sign-in setup is planned on
`happa-bfc07`** (the current project): Google sign-in stays off there and is switched on only once the
app runs on the new projects (`happa.config.json` then names them). Do these steps for each of the two
new projects. Nothing here goes in the repo except the last step.

1. **Enable Google** (done by the owner on 8 Nov 2026 for `happa-bahi` and `happa-bahi-dev`, support
   email guptasdata@gmail.com): console.firebase.google.com → the project → Build → Authentication →
   Sign-in method → Add new provider → Google → Enable. Public-facing name: the app's name (Google's
   chooser says "to continue to *name*"). Project support email → Save. This also creates the Web OAuth
   client the APK uses.
2. **Authorised domains**: Authentication → Settings → Authorized domains → Add domain → the project's
   app site (the `hostingSite` in `happa.config.json` once it names the new project; `myhappa.web.app`
   today is a site of `happa-bfc07`). `localhost`, `<project>.firebaseapp.com` and `<project>.web.app`
   are there by default. Preview channels are not added, so Google sign-in says "not set up" there.
3. **Account linking**: Authentication → Settings → User account linking → keep "Link accounts that use
   the same email".
4. **Android app**: Project settings (gear) → General → Your apps → Add app → Android →
   - Android package name: `com.happa` (the `androidPackage` in `happa.config.json`; the APK build
     stops if `google-services.json` has no client for the APK's package);
   - App nickname: happa Android;
   - Debug signing certificate SHA-1: the release key's SHA-1,
     `58:FD:C7:C6:D8:30:86:B0:60:C6:D4:16:B1:10:69:5D:33:9A:E3:43`
     (from `keytool -printcert -jarfile happa-rc9.apk`, signer CN=happa, O=happa, C=IN);
   - Register app (skip the SDK steps).
   Then on the app's card → Add fingerprint → the SHA-256,
   `D8:8A:F7:8E:7E:19:FB:47:5A:AD:0E:C0:DC:B6:05:EA:72:86:DD:0B:B0:98:62:CE:36:8A:08:FC:BC:24:B8:06`
   (the `HAPPA_CERT_SHA256` variable) → Save. A debug build has another key, so the picker says
   "not set up" there.
5. **`google-services.json`**: on the same card → download `google-services.json` (download it
   **after** step 1 and the fingerprints, so it lists the OAuth clients). GitHub → DDancingDeath/happa →
   Settings → Secrets and variables → Actions → New repository secret → Name `GOOGLE_SERVICES_JSON` →
   the file's whole text → Add secret. The release workflow already writes it to
   `android/app/google-services.json` before the build (the same file switches on the Crashlytics build
   path, docs/error-reporting.md; crash reports still stay off until a user switches them on). The
   secret holds the **live** project's file (`happa-bahi`), the one the released APK signs in against;
   `happa-bahi-dev`'s file is only for local test builds.
6. **Google consent screen** (only for a project made from scratch): Google Cloud console → the same
   project → Google Auth Platform → Branding: app name and support email; Audience: External, In
   production. Only the `openid`, `email` and `profile` scopes are used, so no Google review is needed.
7. **Switch it on** (a small PR): `happa.config.json` → `"googleSignIn": { "web": true }` (live after
   the merge's deploy), then `"android": true` with the next APK release built with the secret;
   run `npm run apply:happa-config`. Before switching on, check in Admin › Users that every approved
   person's email really is theirs (see Risks).

## Real-device check (Android, before `android: true` ships)

1. An APK built **without** the secret: opens, no Google button, no crash.
2. An APK built **with** the secret and `android: true`: the button shows; the picker lists the phone's
   accounts; a new account gets "Registration successful! Please wait for admin approval."; the owner
   approves; it gets in; closing and reopening the app keeps it signed in; Logout, then Google again
   shows the picker.
3. A Gmail account that matches an approved email user: the same account and role.
4. Cancel the picker: nothing shown. Airplane mode: the network message.
5. A debug build (other key): "Google sign-in is not set up yet".

## Risks

- **A Gmail address that isn't the person's**: if an approved email/password account was registered
  with someone else's Gmail address, that address's real owner can sign in with Google to the same
  account (way 1 above), with its role. Check the approved emails before switching on.
- **Lost phone, Google-only person**: Admin › Users › Reset password doesn't apply (no password). Remove
  the person (the rules refuse them at once), then Restore and approve them again; the person can also
  remove happa's access in their Google account.
- **Android**: the native picker is not covered by CI; do the real-device check. The APK is bigger.
- **Web**: the redirect fallback depends on the same-origin helper (Hosting only); a browser that
  blocks the popup on localhost redirects through `<project>.firebaseapp.com`.
