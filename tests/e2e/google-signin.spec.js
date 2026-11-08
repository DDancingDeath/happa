/**
 * "Continue with Google" on the web (docs/google-sign-in.md) against the Auth emulator, under the
 * enforced CSP: the emulator's Google provider shows a fake account chooser in the popup.
 * Google sign-in is off in happa.config.json; on localhost ?google=1 (with ?emulator=1) stands in
 * for googleSignIn.web. The Android path (native picker) needs a real-device test.
 */
const { test, expect, isReady, openApp } = require('./support/app');
const { PASSWORD, signUp, commit, listDocs } = require('./support/emulator');
const { seed } = require('./support/seed');

const WITH_GOOGLE = '?emulator=1&google=1';

/** Taps the button and signs in in the emulator's popup with `email` (a new or an earlier account). */
async function googlePopup(page, { email, name }) {
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#googleSignInBtn')]);
    await popup.waitForLoadState('domcontentloaded');
    const earlier = popup.locator('.js-reuse-account', { hasText: email });
    if (await earlier.count()) {
        await earlier.first().click();
    } else {
        await popup.click('#add-account-button');
        await popup.fill('#email-input', email);
        await popup.fill('#display-name-input', name);
        await popup.click('#sign-in');
    }
}

const profileOf = async (email) => (await listDocs('dev_users')).find((u) => u.email === email);

// Each test starts from the seed and leaves it as it was (other specs sign in as the seeded users).
test.beforeEach(async () => { await seed(); });
test.afterAll(async () => { await seed(); });

test('off unless switched on: no button, and its code is never loaded', async ({ page, problems }) => {
    const loaded = [];
    page.on('request', (r) => { if (/google-signin\.js/.test(r.url())) loaded.push(r.url()); });
    await openApp(page);
    await expect(page.locator('#googleSignIn')).toBeHidden();
    await page.waitForTimeout(500);
    expect(loaded).toEqual([]);
    expect(problems.pageErrors).toEqual([]);
});

test('a new Google account waits for the owner (pending profile), then gets in once approved', async ({ page, problems }) => {
    test.setTimeout(180000);
    const email = `new.google.${test.info().project.name}@gmail.com`;
    await openApp(page, WITH_GOOGLE);
    await expect(page.locator('#googleSignInBtn')).toBeVisible();
    await expect(page.locator('#googleSignInBtn')).toHaveText(/Continue with Google/);

    await googlePopup(page, { email, name: 'New Google' });
    await expect(page.locator('#googleMessage')).toHaveText('Registration successful! Please wait for admin approval.');
    await expect(page.locator('#authScreen')).toBeVisible();
    const pending = await profileOf(email);
    expect(pending).toMatchObject({ name: 'New Google', email, role: 'staff', status: 'pending' });
    expect(await page.evaluate(() => window.firebase.auth().currentUser)).toBeNull();

    // Still pending: signed straight back out
    await googlePopup(page, { email });
    await expect(page.locator('#googleMessage')).toHaveText('Your account is pending approval. Please wait for admin approval.');

    // The owner approves (Admin › Users does this write)
    const { _id: pendingUid, ...pendingProfile } = pending;
    await commit([['dev_users', pendingUid, { ...pendingProfile, status: 'approved' }]]);
    await googlePopup(page, { email });
    await page.waitForFunction(isReady, null, { timeout: 60000 });
    expect(await page.evaluate(() => window.firebase.auth().currentUser.uid)).toBe(pendingUid);
    expect(problems.pageErrors).toEqual([]);
    expect(problems.consoleErrors).toEqual([]);
});

test('an email that already has a password: Google is linked after that password, same account and role', async ({ page, problems }) => {
    test.setTimeout(180000);
    const email = `linker.${test.info().project.name}@e2e.local`;
    const uid = await signUp(email);
    await commit([['dev_users', uid, { name: 'Linker', email, role: 'manager', status: 'approved', createdAt: Date.now() }]]);
    await openApp(page, WITH_GOOGLE);
    await expect(page.locator('#googleSignInBtn')).toBeVisible();

    // A Google account for that email whose address Google has not verified: Firebase refuses to
    // merge it on its own (auth/account-exists-with-different-credential). The emulator's chooser
    // always sends a verified email, so the same sign-in is made with a fake ID token and its real
    // error goes to the button's own error handling (the same module instances the app uses).
    await page.evaluate(async (mail) => {
        const { AuthManager } = await import('/js/auth/authentication.js');
        const google = await AuthManager.loadGoogle();
        const token = JSON.stringify({ sub: `g-${mail}`, email: mail, email_verified: false, name: 'Linker G' });
        AuthManager.authFlowInProgress = true;
        try {
            await window.firebase.auth().signInWithCredential(window.firebase.auth.GoogleAuthProvider.credential(token));
        } catch (error) {
            await google.handleError(AuthManager, error, { allowRedirect: false });
        } finally {
            AuthManager.authFlowInProgress = false;
        }
    }, email);
    await expect(page.locator('#googleLinkForm')).toBeVisible();
    await expect(page.locator('#googleLinkEmail')).toHaveValue(email);
    await page.fill('#googleLinkPassword', 'wrong-password');
    await page.click('#googleLinkForm button[type=submit]');
    await expect(page.locator('#googleLinkMessage')).not.toBeEmpty();
    await page.fill('#googleLinkPassword', PASSWORD);
    await page.click('#googleLinkForm button[type=submit]');
    await page.waitForFunction(isReady, null, { timeout: 60000 });
    const user = await page.evaluate(() => ({ uid: window.firebase.auth().currentUser.uid, providers: window.firebase.auth().currentUser.providerData.map((p) => p.providerId).sort() }));
    expect(user).toEqual({ uid, providers: ['google.com', 'password'] });
    expect(await profileOf(email)).toMatchObject({ role: 'manager', status: 'approved' });
    expect(problems.pageErrors).toEqual([]);
});
