// Firestore security rules tests. Run from the repo root with `npm run test:rules`
// (starts the Firestore emulator via firebase-tools and runs this file).
const fs = require('fs');
const path = require('path');
const {
    initializeTestEnvironment,
    assertFails,
    assertSucceeds
} = require('@firebase/rules-unit-testing');
const { setLogLevel } = require('firebase/firestore');
const firebase = require('firebase/compat/app');
require('firebase/compat/firestore');

const { FieldValue, Timestamp } = firebase.firestore;
const serverTimestamp = () => FieldValue.serverTimestamp();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Expected PERMISSION_DENIED errors would otherwise flood the output.
setLogLevel('silent');

const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let env;

// Seed user profiles (bypassing rules) into the given users collection.
async function seedUsers(usersCol) {
    await env.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        await db.collection(usersCol).doc('pending1').set({ name: 'P', email: 'p@x.com', role: 'staff', status: 'pending' });
        await db.collection(usersCol).doc('rejected1').set({ name: 'R', email: 'r@x.com', role: 'staff', status: 'rejected' });
        await db.collection(usersCol).doc('staff1').set({ name: 'S', email: 's@x.com', role: 'staff', status: 'active' });
        await db.collection(usersCol).doc('manager1').set({ name: 'M', email: 'm@x.com', role: 'manager', status: 'approved' });
        await db.collection(usersCol).doc('legacyOwner').set({ name: 'O', email: 'o@x.com', role: 'owner' });
        await db.collection(usersCol).doc('legacyStaff').set({ name: 'L', email: 'l@x.com', role: 'staff' });
        await db.collection(usersCol).doc('noRole').set({ name: 'N', email: 'n@x.com', status: 'active' });
    });
}

const as = (uid) => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();

function defineSuite(prefix) {
    const users = `${prefix}users`;
    const purchases = `${prefix}purchases`;
    const counters = `${prefix}counters`;
    const t = (name, fn) => test(`[${prefix || 'prod'}] ${name}`, fn);

    t('unauthenticated cannot read purchases', () =>
        assertFails(anon().collection(purchases).doc('b1').get()));

    t('pending user cannot read purchases', () =>
        assertFails(as('pending1').collection(purchases).doc('b1').get()));

    t('pending user cannot write purchases', () =>
        assertFails(as('pending1').collection(purchases).doc('b1').set({ total: 1 })));

    t('rejected user cannot read purchases', () =>
        assertFails(as('rejected1').collection(purchases).get()));

    t('signed-in user without a profile cannot read purchases', () =>
        assertFails(as('ghost').collection(purchases).get()));

    t('user with unknown role cannot read purchases', () =>
        assertFails(as('noRole').collection(purchases).get()));

    t('approved staff can write and read purchases', async () => {
        await assertSucceeds(as('staff1').collection(purchases).doc('b1').set({ total: 10, clientVersion: 3 }));
        await assertSucceeds(as('staff1').collection(purchases).doc('b1').get());
        await assertSucceeds(as('staff1').collection(purchases).orderBy('total').get());
    });

    // ---- bill deletion: owner, or the approved user who created the bill ----

    const seedBill = (coll, id, data) => env.withSecurityRulesDisabled((ctx) =>
        ctx.firestore().collection(coll).doc(id).set(data));
    const bills = ['purchases', 'retailSales', 'wholesaleSales'].map(c => `${prefix}${c}`);
    // Server time of the bill's first save (#87): non-owners may change/delete it for 2 days.
    const savedAgo = (ms) => Timestamp.fromMillis(Date.now() - ms);
    const fresh = () => ({ createdAt: savedAgo(HOUR) });

    t('creator can delete own bill; other staff/manager cannot (all bill collections)', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'mine', { userId: 'staff1', total: 5, ...fresh() });
            await seedBill(coll, 'theirs', { userId: 'staff1', total: 5, ...fresh() });
            await assertFails(as('manager1').collection(coll).doc('theirs').delete());
            await assertSucceeds(as('staff1').collection(coll).doc('mine').delete());
        }
    });

    t('owner can delete any bill, including legacy bills without userId', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'b', { userId: 'staff1', total: 5 });
            await seedBill(coll, 'legacy', { total: 5 });
            await assertSucceeds(as('legacyOwner').collection(coll).doc('b').delete());
            await assertSucceeds(as('legacyOwner').collection(coll).doc('legacy').delete());
        }
    });

    t('non-owner cannot delete a legacy bill without userId', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'legacy', { total: 5 });
            await assertFails(as('staff1').collection(coll).doc('legacy').delete());
        }
    });

    t('pending creator cannot delete own bill', async () => {
        await seedBill(purchases, 'p', { userId: 'pending1', total: 5 });
        await assertFails(as('pending1').collection(purchases).doc('p').delete());
    });

    t('staff can still record a payment on another user\'s bill', async () => {
        await seedBill(`${prefix}wholesaleSales`, 'w', { userId: 'manager1', total: 100, payment: { cash: 0, due: 100 }, clientVersion: 3 });
        await assertSucceeds(as('staff1').collection(`${prefix}wholesaleSales`).doc('w')
            .update({ 'payment.cash': 40, 'payment.due': 60, openDue: true, clientVersion: 3 }));
    });

    t('non-bill business docs stay deletable by approved staff', async () => {
        await seedBill(`${prefix}drafts`, 'd', { userId: 'manager1' });
        await assertSucceeds(as('staff1').collection(`${prefix}drafts`).doc('d').delete());
    });

    t('staff cannot change userId on another user\'s bill (update or full set)', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'b', { userId: 'manager1', total: 5, clientVersion: 3 });
            await assertFails(as('staff1').collection(coll).doc('b').update({ userId: 'staff1', clientVersion: 3 }));
            await assertFails(as('staff1').collection(coll).doc('b').set({ total: 5, userId: 'staff1', clientVersion: 3 }));
            await assertFails(as('staff1').collection(coll).doc('b').set({ total: 5, clientVersion: 3 }));
        }
    });

    t('staff cannot claim a legacy bill without userId', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'legacy', { total: 5, clientVersion: 3 });
            await assertFails(as('staff1').collection(coll).doc('legacy').update({ userId: 'staff1', clientVersion: 3 }));
            // full edits of a legacy bill (no userId, no createdAt) are owner only (#87)
            await assertFails(as('staff1').collection(coll).doc('legacy').set({ total: 6, clientVersion: 3 }));
            await assertFails(as('manager1').collection(coll).doc('legacy').set({ total: 6, clientVersion: 3 }));
            await assertSucceeds(as('legacyOwner').collection(coll).doc('legacy').set({ total: 6, clientVersion: 3 }));
        }
    });

    t('owner can change userId on any bill', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'b', { userId: 'manager1', total: 5, clientVersion: 3 });
            await seedBill(coll, 'legacy', { total: 5, clientVersion: 3 });
            await assertSucceeds(as('legacyOwner').collection(coll).doc('b').update({ userId: 'staff1' }));
            await assertSucceeds(as('legacyOwner').collection(coll).doc('legacy').update({ userId: 'staff1' }));
        }
    });

    // ---- bill edits: full edits by owner/manager/creator; others only payment bookkeeping ----

    const otherBill = { userId: 'manager1', total: 100, items: [{ name: 'Rice', qty: 10 }], timestamp: 1760000000000,
        date: '2026-10-01', payment: { online: 0, cash: 0, due: 100, total: 0 }, openDue: true, clientVersion: 3 };

    t('staff cannot rewrite another user\'s bill (items, total, timestamp, full set)', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'b', otherBill);
            const ref = as('staff1').collection(coll).doc('b');
            await assertFails(ref.update({ items: [], clientVersion: 3 }));
            await assertFails(ref.update({ total: 0, clientVersion: 3 }));
            await assertFails(ref.update({ timestamp: 0, clientVersion: 3 }));
            await assertFails(ref.update({ date: '1970-01-01', clientVersion: 3 }));
            await assertFails(ref.set({ ...otherBill, total: 7, editedBy: 'staff1' }));
            await assertFails(ref.update({ payment: { due: 0 }, total: 0, clientVersion: 3 }));
        }
    });

    t('staff can record a payment and clear another user\'s bill', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'b', { ...otherBill, dueAmount: 100 });
            const ref = as('staff1').collection(coll).doc('b');
            // outstanding.js applyPaymentTransaction
            await assertSucceeds(ref.update({
                payment: { online: 0, cash: 40, due: 60, total: 40 }, payments: [{ amount: 40, recordedBy: 'S' }],
                dueAmount: 60, openDue: true, clientVersion: 3
            }));
            // outstanding.js markAsCleared
            await assertSucceeds(ref.update({
                cleared: true, openDue: false, clientVersion: 3, clearedAt: 'x', clearedBy: 'staff1', clearedByName: 'S'
            }));
        }
    });

    t('staff can clear a sale via a full set that only flips cleared/openDue (wholesale markSaleAsCleared)', async () => {
        const coll = bills[2];
        await seedBill(coll, 'w', otherBill);
        await assertSucceeds(as('staff1').collection(coll).doc('w').set({ ...otherBill, cleared: true, openDue: false }));
    });

    t('staff legacy backfill: may fill a missing timestamp / id and openDue, never change them', async () => {
        for (const coll of bills) {
            const legacy = { userId: 'manager1', total: 100, date: '01/10/2026', payment: { due: 100 } };
            await seedBill(coll, 'old', legacy);
            const ref = as('staff1').collection(coll).doc('old');
            await assertSucceeds(ref.update({ timestamp: 1759276800000, openDue: true, clientVersion: 3 }));
            await assertFails(ref.update({ timestamp: 1, clientVersion: 3 }));
            await seedBill(coll, 'old2', { ...legacy, timestamp: '2026-10-01' });
            await assertSucceeds(as('staff1').collection(coll).doc('old2').update({ timestamp: 1759276800000, clientVersion: 3 }));
            await seedBill(coll, 'old3', legacy);
            await assertSucceeds(as('staff1').collection(coll).doc('old3').set({ ...legacy, id: 'old3', cleared: true, openDue: false, clientVersion: 3 }));
            await seedBill(coll, 'old4', { ...legacy, id: 'old4' });
            await assertFails(as('staff1').collection(coll).doc('old4').update({ id: 'other', clientVersion: 3 }));
        }
    });

    t('creator, manager and owner can fully edit a bill inside the 2-day window', async () => {
        for (const coll of bills) {
            const mine = { ...otherBill, userId: 'staff1', ...fresh() };
            await seedBill(coll, 'b', mine);
            await assertSucceeds(as('staff1').collection(coll).doc('b').set({ ...mine, total: 7, items: [] }));
            await assertSucceeds(as('manager1').collection(coll).doc('b').update({ total: 8, timestamp: 1, clientVersion: 3 }));
            await assertSucceeds(as('legacyOwner').collection(coll).doc('b').update({ items: [{ name: 'x' }], clientVersion: 3 }));
        }
    });

    // ---- 2-day edit window for non-owners (#87) ----

    t('edit window: creator may edit and delete own bill saved 47 hours ago', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'b', { ...otherBill, userId: 'staff1', createdAt: savedAgo(47 * HOUR) });
            await assertSucceeds(as('staff1').collection(coll).doc('b').update({ total: 9, clientVersion: 3 }));
            await assertSucceeds(as('staff1').collection(coll).doc('b').delete());
        }
    });

    t('edit window: after 2 days creator and manager cannot edit or delete; owner can', async () => {
        for (const coll of bills) {
            const old = { ...otherBill, userId: 'staff1', createdAt: savedAgo(2 * DAY + MIN) };
            await seedBill(coll, 'old', old);
            const ref = (uid) => as(uid).collection(coll).doc('old');
            await assertFails(ref('staff1').update({ total: 9, clientVersion: 3 }));
            await assertFails(ref('staff1').set({ ...old, total: 9 }));
            await assertFails(ref('staff1').delete());
            await assertFails(ref('manager1').update({ total: 9, clientVersion: 3 }));
            await assertFails(ref('manager1').delete());
            await assertSucceeds(ref('legacyOwner').update({ total: 9, clientVersion: 3 }));
            await assertSucceeds(ref('legacyOwner').delete());
        }
    });

    t('edit window: payments can still be recorded on an old bill', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'old', { ...otherBill, userId: 'staff1', dueAmount: 100, createdAt: savedAgo(30 * DAY) });
            await assertSucceeds(as('staff1').collection(coll).doc('old').update({
                payment: { online: 0, cash: 40, due: 60, total: 40 }, payments: [{ amount: 40, recordedBy: 'S' }],
                dueAmount: 60, openDue: true, clientVersion: 3
            }));
        }
    });

    t('edit window: own bill without createdAt (saved before #87) is owner-only', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'legacy', { ...otherBill, userId: 'staff1' });
            await assertFails(as('staff1').collection(coll).doc('legacy').update({ total: 9, clientVersion: 3 }));
            await assertFails(as('staff1').collection(coll).doc('legacy').delete());
            await assertFails(as('manager1').collection(coll).doc('legacy').update({ total: 9, clientVersion: 3 }));
            await assertSucceeds(as('legacyOwner').collection(coll).doc('legacy').update({ total: 9, clientVersion: 3 }));
        }
    });

    t('edit window: another user\'s fresh bill stays off-limits to staff', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'b', { ...otherBill, ...fresh() });
            await assertFails(as('staff1').collection(coll).doc('b').update({ total: 9, clientVersion: 3 }));
            await assertFails(as('staff1').collection(coll).doc('b').delete());
        }
    });

    t('edit window: non-owners cannot move or drop createdAt', async () => {
        for (const coll of bills) {
            const mine = { ...otherBill, userId: 'staff1', createdAt: savedAgo(3 * DAY) };
            await seedBill(coll, 'b', mine);
            const ref = as('staff1').collection(coll).doc('b');
            await assertFails(ref.update({ createdAt: serverTimestamp(), clientVersion: 3 }));
            await seedBill(coll, 'c', { ...mine, createdAt: savedAgo(HOUR) });
            const noCreatedAt = { ...mine };
            delete noCreatedAt.createdAt;
            await assertFails(as('staff1').collection(coll).doc('c').set({ ...noCreatedAt, total: 9 }));
            await assertFails(as('manager1').collection(coll).doc('c').update({ createdAt: savedAgo(0), clientVersion: 3 }));
        }
    });

    t('edit window: new bills carry the server time; a made-up createdAt is refused', async () => {
        for (const coll of bills) {
            const db = as('staff1').collection(coll);
            await assertSucceeds(db.doc('n1').set({ userId: 'staff1', total: 5, clientVersion: 3, createdAt: serverTimestamp() }));
            await assertSucceeds(db.doc('n2').set({ userId: 'staff1', total: 5, clientVersion: 3 }));
            await assertFails(db.doc('n3').set({ userId: 'staff1', total: 5, clientVersion: 3, createdAt: Timestamp.fromMillis(Date.now() + 30 * DAY) }));
        }
    });

    // ---- settings/app (minClientVersion): owner only ----

    t('only the owner can write settings/app; other settings docs unchanged', async () => {
        const settings = as('staff1').collection(`${prefix}settings`);
        await assertFails(settings.doc('app').set({ minClientVersion: 99 }));
        await assertFails(as('manager1').collection(`${prefix}settings`).doc('app').set({ minClientVersion: 99 }));
        await assertSucceeds(as('legacyOwner').collection(`${prefix}settings`).doc('app').set({ minClientVersion: 3 }));
        await assertSucceeds(settings.doc('app').get());
        await assertFails(settings.doc('app').update({ minClientVersion: 99 }));
        await assertFails(settings.doc('app').delete());
        await assertSucceeds(settings.doc('other').set({ a: 1 }));
    });

    t('approved manager can write counters', () =>
        assertSucceeds(as('manager1').collection(counters).doc('retail-20261013').set({ next: 2 })));

    t('legacy owner without status field can read purchases', () =>
        assertSucceeds(as('legacyOwner').collection(purchases).get()));

    t('pending user cannot read counters', () =>
        assertFails(as('pending1').collection(counters).doc('x').get()));

    const checkpoints = `${prefix}stockCheckpoints`;
    const seedCheckpoint = () => env.withSecurityRulesDisabled(ctx =>
        ctx.firestore().collection(checkpoints).doc('current').set({ asOf: 1, state: [], stale: false, staleCount: 0 }));

    t('owner and manager can rebuild (write state/lease of) the stock checkpoint', async () => {
        await assertSucceeds(as('manager1').collection(checkpoints).doc('current').set({ asOf: 5, state: [], stale: false }));
        await assertSucceeds(as('legacyOwner').collection(checkpoints).doc('current').set({ rebuildingUntil: 9, rebuildingBy: 'x' }, { merge: true }));
        await assertSucceeds(as('staff1').collection(checkpoints).doc('current').get());
    });

    t('staff cannot write checkpoint state or take the rebuild lease', async () => {
        await seedCheckpoint();
        await assertFails(as('staff1').collection(checkpoints).doc('current').set({ asOf: 1, state: [], stale: false }));
        await assertFails(as('staff1').collection(checkpoints).doc('current').set({ asOf: 2 }, { merge: true }));
        await assertFails(as('staff1').collection(checkpoints).doc('current').set({ rebuildingUntil: 9, rebuildingBy: 'x' }, { merge: true }));
        await assertFails(as('staff1').collection(checkpoints).doc('current').set({ stale: false }, { merge: true }));
        await assertFails(as('staff1').collection(checkpoints).doc('current').delete());
    });

    t('staff can mark the checkpoint stale (only the stale fields)', async () => {
        await seedCheckpoint();
        await assertSucceeds(as('staff1').collection(checkpoints).doc('current').set(
            { stale: true, staleCount: 1, staleAt: 2, staleReason: 'x', staleBy: 'staff1' }, { merge: true }));
        await assertFails(as('staff1').collection(checkpoints).doc('current').set(
            { stale: true, staleCount: 2, state: [{ k: 'x', q: 1, v: 1 }] }, { merge: true }));
        await env.withSecurityRulesDisabled(ctx => ctx.firestore().collection(checkpoints).doc('current').delete());
        await assertSucceeds(as('staff1').collection(checkpoints).doc('current').set({ stale: true, staleCount: 1 }, { merge: true }));
    });

    t('legacy scan state: owner/manager only (staff cannot switch the backfill off)', async () => {
        const doc = (uid) => as(uid).collection(checkpoints).doc('legacyScan');
        await assertFails(doc('staff1').set({ expenses: { v: 2, complete: true, foundAt: 0, at: 1 } }, { merge: true }));
        await assertSucceeds(doc('manager1').set({ expenses: { v: 2, complete: true, foundAt: 0, at: 1 } }, { merge: true }));
        await assertSucceeds(doc('legacyOwner').set({ purchases: { v: 2, complete: true, foundAt: 0, at: 1 } }, { merge: true }));
        await assertFails(doc('staff1').set({ expenses: { v: 2, complete: true } }, { merge: true }));
        await assertSucceeds(doc('staff1').get());
    });

    t('pending/rejected/unauthenticated users cannot touch the stock checkpoint', async () => {
        await assertFails(as('pending1').collection(checkpoints).doc('current').get());
        await assertFails(as('rejected1').collection(checkpoints).doc('current').set({ stale: true }));
        await assertFails(anon().collection(checkpoints).doc('current').get());
    });

    const setClientGate = (on) => env.withSecurityRulesDisabled(ctx =>
        ctx.firestore().collection(`${prefix}settings`).doc('app').set({ enforceClientVersion: on }, { merge: true }));

    t('clientVersion gate is off until the owner enables it (old apps keep working)', async () => {
        await setClientGate(false);
        const coll = as('staff1').collection(`${prefix}purchases`);
        await assertSucceeds(coll.doc('legacyApp1').set({ total: 1, userId: 'staff1' }));
        // An old app's bill has no createdAt: outside the #87 edit window, so owner-only afterwards
        await assertFails(coll.doc('legacyApp1').update({ total: 2 }));
        await assertSucceeds(coll.doc('legacyApp2').set({ total: 1, userId: 'staff1', createdAt: serverTimestamp() }));
        await assertSucceeds(coll.doc('legacyApp2').update({ total: 2 }));
    });

    t('stock records need clientVersion >= 3 once the gate is on (blocks outdated apps)', async () => {
        await setClientGate(true);
        const db = as('staff1');
        for (const c of ['purchases', 'retailSales', 'wholesaleSales', 'stockAdjustments']) {
            const coll = db.collection(`${prefix}${c}`);
            const valid = c === 'stockAdjustments'
                ? { itemId: 'i1', adjustType: 'add', quantity: 1, userId: 'staff1' }
                : { total: 1 };
            await assertFails(coll.doc('old1').set({ ...valid }));
            await assertFails(coll.doc('old2').set({ ...valid, clientVersion: 2 }));
            await assertSucceeds(coll.doc('new1').set({ ...valid, clientVersion: 3 }));
        }
        // Expenses etc. are not restricted by the gate.
        await assertSucceeds(db.collection(`${prefix}expenses`).doc('e1').set({ amount: 1, userId: 'staff1' }));
    });

    t('payment updates on current bills pass; overwriting with an old-app full set() fails; deletes pass', async () => {
        await setClientGate(true);
        const coll = as('staff1').collection(purchases);
        await assertSucceeds(coll.doc('pay1').set({ total: 100, payment: { due: 100 }, userId: 'staff1', clientVersion: 3, createdAt: serverTimestamp() }));
        await assertSucceeds(coll.doc('pay1').update({ payment: { due: 0, cash: 100 }, payments: [{ amount: 100 }], openDue: false, clientVersion: 3 }));
        await assertSucceeds(coll.doc('pay1').update({ cleared: true, openDue: false }));
        await assertFails(coll.doc('pay1').set({ total: 100, payment: { due: 0 } }));
        await assertSucceeds(coll.doc('pay1').delete());
    });

    // ---- users collection ----

    t('pending user can read own profile', () =>
        assertSucceeds(as('pending1').collection(users).doc('pending1').get()));

    t('signed-in user can read own (missing) profile during registration', () =>
        assertSucceeds(as('newbie').collection(users).doc('newbie').get()));

    t('pending user cannot read other profiles', () =>
        assertFails(as('pending1').collection(users).doc('staff1').get()));

    t('pending user cannot list users', () =>
        assertFails(as('pending1').collection(users).get()));

    t('approved staff can list users', () =>
        assertSucceeds(as('staff1').collection(users).orderBy('createdAt', 'desc').get()));

    t('registration as pending staff succeeds', () =>
        assertSucceeds(as('newbie').collection(users).doc('newbie').set({
            name: 'New', email: 'new@x.com', role: 'staff', status: 'pending', createdAt: new Date()
        })));

    t('registration as owner fails', () =>
        assertFails(as('newbie2').collection(users).doc('newbie2').set({
            name: 'New', email: 'new@x.com', role: 'owner', status: 'pending'
        })));

    t('registration as already-active fails', () =>
        assertFails(as('newbie3').collection(users).doc('newbie3').set({
            name: 'New', email: 'new@x.com', role: 'staff', status: 'active'
        })));

    t('cannot create a profile for another uid', () =>
        assertFails(as('newbie4').collection(users).doc('someoneElse').set({
            name: 'New', email: 'new@x.com', role: 'staff', status: 'pending'
        })));

    t('pending user cannot set own status to active', () =>
        assertFails(as('pending1').collection(users).doc('pending1').update({ status: 'active' })));

    t('staff cannot set own role to owner', () =>
        assertFails(as('staff1').collection(users).doc('staff1').update({ role: 'owner' })));

    t('staff cannot set own approvedBy', () =>
        assertFails(as('staff1').collection(users).doc('staff1').update({ approvedBy: 'staff1' })));

    t('user can update own non-privileged fields', () =>
        assertSucceeds(as('staff1').collection(users).doc('staff1').update({ name: 'Renamed', lastLogin: new Date() })));

    t('staff cannot update another user', () =>
        assertFails(as('staff1').collection(users).doc('pending1').update({ name: 'x' })));

    t('manager cannot approve users', () =>
        assertFails(as('manager1').collection(users).doc('pending1').update({ status: 'approved', role: 'staff' })));

    t('owner can approve another user', () =>
        assertSucceeds(as('legacyOwner').collection(users).doc('pending1').update({
            status: 'approved', role: 'manager', approvedAt: new Date(), approvedBy: 'legacyOwner'
        })));

    t('staff cannot delete a user', () =>
        assertFails(as('staff1').collection(users).doc('rejected1').delete()));

    t('owner can delete a user', () =>
        assertSucceeds(as('legacyOwner').collection(users).doc('rejected1').delete()));

    t('approved user can access own preferences only', async () => {
        await assertSucceeds(as('staff1').collection(users).doc('staff1').collection('preferences').doc('ui').set({ a: 1 }));
        await assertFails(as('staff1').collection(users).doc('manager1').collection('preferences').doc('ui').get());
        await assertFails(as('pending1').collection(users).doc('pending1').collection('preferences').doc('ui').get());
    });

    // ---- audit logs (#55): append-only, caller's uid, server time ----

    const auditLogs = `${prefix}auditLogs`;
    const audit = (uid, extra = {}) => ({
        action: 'DELETE_EXPENSE', userId: uid, userName: 'S', userRole: 'staff', details: { amount: 5 },
        timestamp: Date.now(), date: new Date().toISOString(), serverTime: serverTimestamp(), ...extra
    });

    t('audit: approved users (incl. legacy no-status) can append their own entry but not read', async () => {
        await assertSucceeds(as('staff1').collection(auditLogs).add(audit('staff1')));
        await assertSucceeds(as('legacyStaff').collection(auditLogs).add(audit('legacyStaff')));
        await assertSucceeds(as('manager1').collection(auditLogs).add(audit('manager1')));
        await assertFails(as('staff1').collection(auditLogs).get());
        await assertFails(as('manager1').collection(auditLogs).get());
    });

    t('audit: entries from older apps (no serverTime) pass when timestamp is current', async () => {
        const legacy = { ...audit('staff1') };
        delete legacy.serverTime;
        await assertSucceeds(as('staff1').collection(auditLogs).add(legacy));
        await assertFails(as('staff1').collection(auditLogs).add({ ...legacy, timestamp: Date.now() - 60 * MIN }));
    });

    t('audit: an entry queued offline for a day still syncs (serverTime is the real time)', () =>
        assertSucceeds(as('staff1').collection(auditLogs).add(audit('staff1', { timestamp: Date.now() - 24 * HOUR }))));

    t('audit: forged uid, far-off or future timestamps, fake serverTime and extra fields are rejected', async () => {
        const logs = as('staff1').collection(auditLogs);
        await assertFails(logs.add(audit('manager1')));
        await assertFails(logs.add(audit('unknown')));
        await assertFails(logs.add(audit('staff1', { timestamp: Date.now() - 10 * DAY })));
        await assertFails(logs.add(audit('staff1', { timestamp: Date.now() + 60 * MIN })));
        await assertFails(logs.add(audit('staff1', { timestamp: '2026-10-01' })));
        await assertFails(logs.add(audit('staff1', { serverTime: Timestamp.fromMillis(Date.now() - DAY) })));
        await assertFails(logs.add(audit('staff1', { injected: true })));
        await assertFails(logs.add(audit('staff1', { action: 'X'.repeat(100) })));
    });

    t('audit: pending/rejected/unauthenticated users cannot append', async () => {
        await assertFails(as('pending1').collection(auditLogs).add(audit('pending1')));
        await assertFails(as('rejected1').collection(auditLogs).add(audit('rejected1')));
        await assertFails(anon().collection(auditLogs).add(audit('x')));
    });

    t('audit: nobody updates entries; only the owner deletes, and only entries older than 90 days', async () => {
        await seedBill(auditLogs, 'old', { action: 'X', userId: 'staff1', timestamp: Date.now() - 91 * DAY });
        await seedBill(auditLogs, 'recent', { action: 'X', userId: 'staff1', timestamp: Date.now() - 89 * DAY });
        await assertFails(as('legacyOwner').collection(auditLogs).doc('recent').update({ action: 'Y' }));
        await assertFails(as('staff1').collection(auditLogs).doc('old').delete());
        await assertFails(as('manager1').collection(auditLogs).doc('old').delete());
        await assertFails(as('legacyOwner').collection(auditLogs).doc('recent').delete());
        await assertSucceeds(as('legacyOwner').collection(auditLogs).get());
        await assertSucceeds(as('legacyOwner').collection(auditLogs).doc('old').delete());
    });

    // ---- telemetry (#122): append-only ----

    const telemetry = `${prefix}telemetry`;
    const report = (uid, extra = {}) => ({
        type: 'uncaught', message: 'boom', source: 'main.js', line: 3, stack: 'Error: boom', context: '{"a":1}',
        timestamp: Date.now(), date: new Date().toISOString(), url: 'https://x/', userAgent: 'UA', userId: uid,
        userName: 'S', userRole: 'staff', fingerprint: 'abc123', count: 2,
        occurrences: [{ timestamp: 1, userId: uid, userName: 'S' }], lastSeen: Date.now(), firstSeen: Date.now(), ...extra
    });

    t('telemetry: approved users append reports; only the owner reads and deletes', async () => {
        await assertSucceeds(as('staff1').collection(telemetry).doc('abc123-1').set(report('staff1')));
        await assertSucceeds(as('legacyStaff').collection(telemetry).doc('abc123-2').set(report('legacyStaff')));
        await assertFails(as('staff1').collection(telemetry).doc('abc123-1').get());
        await assertFails(as('manager1').collection(telemetry).get());
        await assertSucceeds(as('legacyOwner').collection(telemetry).doc('abc123-1').get());
        await assertFails(as('staff1').collection(telemetry).doc('abc123-1').delete());
        await assertSucceeds(as('legacyOwner').collection(telemetry).doc('abc123-1').delete());
    });

    t('telemetry: reports cannot be rewritten (no update, not even by the owner)', async () => {
        await seedBill(telemetry, 'fp1', report('staff1'));
        await assertFails(as('staff1').collection(telemetry).doc('fp1').update({ count: 3 }));
        await assertFails(as('staff1').collection(telemetry).doc('fp1').set(report('staff1', { message: 'nothing' })));
        await assertFails(as('legacyOwner').collection(telemetry).doc('fp1').update({ count: 0 }));
    });

    t('telemetry: forged uid, bad counts, oversized fields and unknown fields are rejected', async () => {
        const coll = as('staff1').collection(telemetry);
        await assertFails(coll.doc('a').set(report('manager1')));
        await assertFails(coll.doc('b').set(report('staff1', { count: 0 })));
        await assertFails(coll.doc('c').set(report('staff1', { count: 'many' })));
        await assertFails(coll.doc('d').set(report('staff1', { count: 1000 })));
        await assertFails(coll.doc('e').set(report('staff1', { message: 'x'.repeat(1001) })));
        await assertFails(coll.doc('f').set(report('staff1', { stack: 'x'.repeat(4001) })));
        await assertFails(coll.doc('g').set(report('staff1', { occurrences: Array.from({ length: 11 }, (_, i) => ({ timestamp: i })) })));
        await assertFails(coll.doc('h').set(report('staff1', { extra: 1 })));
        await assertFails(coll.doc('i').set(report('staff1', { context: { a: 1 } })));
        await assertFails(as('pending1').collection(telemetry).doc('j').set(report('pending1')));
    });

    // ---- rateHistory (#82): append-only, owner/manager only ----

    const rateHistory = `${prefix}rateHistory`;
    const entry = (uid, extra = {}) => ({
        itemId: 'i1', itemName: 'Wheat', field: 'purchase', old: 40, new: 45,
        by: 'X', byUserId: uid, at: 1700000000000, source: 'modal', flags: [], ...extra
    });

    t('rateHistory: owner and manager can create and read entries', async () => {
        await assertSucceeds(as('legacyOwner').collection(rateHistory).doc('i1_a').set(entry('legacyOwner')));
        await assertSucceeds(as('manager1').collection(rateHistory).doc('i1_b').set(entry('manager1', { field: 'name', old: 'Gehu', new: 'Wheat' })));
        await assertSucceeds(as('manager1').collection(rateHistory).doc('i1_a').get());
        await assertSucceeds(as('legacyOwner').collection(rateHistory).get());
    });

    t('rateHistory: staff and pending users cannot create or read', async () => {
        await assertFails(as('staff1').collection(rateHistory).doc('s').set(entry('staff1')));
        await assertFails(as('pending1').collection(rateHistory).doc('p').set(entry('pending1')));
        await env.withSecurityRulesDisabled((ctx) => ctx.firestore().collection(rateHistory).doc('x').set(entry('manager1')));
        await assertFails(as('staff1').collection(rateHistory).doc('x').get());
        await assertFails(as('staff1').collection(rateHistory).get());
    });

    t('rateHistory: entries cannot be updated or deleted, even by the owner', async () => {
        await env.withSecurityRulesDisabled((ctx) => ctx.firestore().collection(rateHistory).doc('x').set(entry('legacyOwner')));
        await assertFails(as('legacyOwner').collection(rateHistory).doc('x').update({ new: 50 }));
        await assertFails(as('legacyOwner').collection(rateHistory).doc('x').set(entry('legacyOwner', { new: 50 })));
        await assertFails(as('legacyOwner').collection(rateHistory).doc('x').delete());
        await assertFails(as('manager1').collection(rateHistory).doc('x').delete());
    });

    t('rateHistory: rejects another user\'s uid, unknown fields and bad field names', async () => {
        await assertFails(as('manager1').collection(rateHistory).doc('a').set(entry('legacyOwner')));
        await assertFails(as('manager1').collection(rateHistory).doc('b').set(entry('manager1', { extra: 1 })));
        await assertFails(as('manager1').collection(rateHistory).doc('c').set(entry('manager1', { field: 'stock' })));
        await assertFails(as('manager1').collection(rateHistory).doc('d').set(entry('manager1', { at: 'yesterday' })));
    });

    // ---- anomalies (#187 / #40): owner/manager only ----

    const anomalies = `${prefix}anomalies`;
    const anomaly = (extra = {}) => ({
        type: 'rate-high', severity: 'medium', en: 'Rate high', hi: 'रेट ज़्यादा', refKind: 'bill', refId: 'b1',
        billType: 'retail', billNumber: 'R1', party: 'Ramesh', item: 'Rice', userId: 'staff1', user: 'S',
        amount: 400, at: 1700000000000, dayKey: '2026-10-22', hour: 11, detectedBy: 'scan',
        detectedAt: 1700000000001, status: 'open', note: '', reviewedBy: null, reviewedByName: null, reviewedAt: null, ...extra
    });

    t('anomalies: owner and manager can write (set-merge, idempotent id) and read', async () => {
        const id = 'rate-high~bill~b1';
        await assertSucceeds(as('manager1').collection(anomalies).doc(id).set(anomaly(), { merge: true }));
        await assertSucceeds(as('legacyOwner').collection(anomalies).doc(id).set(anomaly({ amount: 450 }), { merge: true }));
        await assertSucceeds(as('manager1').collection(anomalies).doc(id).get());
        await assertSucceeds(as('legacyOwner').collection(anomalies).where('dayKey', '>=', '2026-10-01').where('dayKey', '<=', '2026-10-31').get());
    });

    t('anomalies: owner/manager can mark OK / fixed with a note', async () => {
        await env.withSecurityRulesDisabled((ctx) => ctx.firestore().collection(anomalies).doc('a').set(anomaly()));
        await assertSucceeds(as('manager1').collection(anomalies).doc('a').set(
            { status: 'ok', note: 'checked with party', reviewedBy: 'manager1', reviewedByName: 'M', reviewedAt: 1 }, { merge: true }));
        await assertSucceeds(as('legacyOwner').collection(anomalies).doc('a').update({ status: 'fixed' }));
    });

    t('anomalies: other users cannot read or write; pending users neither', async () => {
        await env.withSecurityRulesDisabled((ctx) => ctx.firestore().collection(anomalies).doc('a').set(anomaly()));
        await assertFails(as('staff1').collection(anomalies).doc('a').get());
        await assertFails(as('staff1').collection(anomalies).get());
        await assertFails(as('staff1').collection(anomalies).doc('a').update({ status: 'ok' }));
        await assertFails(as('staff1').collection(anomalies).doc('n').set(anomaly()));
        await assertFails(as('pending1').collection(anomalies).doc('a').get());
        await assertFails(anon().collection(anomalies).doc('a').get());
    });

    t('anomalies: rejects unknown fields, bad status/severity; only an owner deletes', async () => {
        await assertFails(as('manager1').collection(anomalies).doc('x').set(anomaly({ extra: 1 })));
        await assertFails(as('manager1').collection(anomalies).doc('y').set(anomaly({ status: 'deleted' })));
        await assertFails(as('manager1').collection(anomalies).doc('z').set(anomaly({ severity: 'block' })));
        await env.withSecurityRulesDisabled((ctx) => ctx.firestore().collection(anomalies).doc('a').set(anomaly()));
        await assertFails(as('manager1').collection(anomalies).doc('a').delete());
        await assertSucceeds(as('legacyOwner').collection(anomalies).doc('a').delete());
    });

    // ---- Test in Production (#217): tipHealth counters + tipFailures samples ----

    const tipHealth = `${prefix}tipHealth`;
    const tipFailures = `${prefix}tipFailures`;
    const healthDoc = (uid, extra = {}) => ({
        uid, deviceId: 'abc123de4f5g', day: '20261023', platform: 'web', appVersion: '1.6.0', buildId: 'b',
        updatedAt: serverTimestamp(),
        v: { '1_6_0': { BillSave: { n: { s: FieldValue.increment(1) }, d: { b1: FieldValue.increment(1) }, ms: FieldValue.increment(300) } } },
        ...extra
    });
    const failureDoc = (uid, extra = {}) => ({
        uid, deviceId: 'abc123de4f5g', day: '20261023', test: 'BillSave', result: 'fail', reason: 1,
        reasonName: 'totals_mismatch', flags: { offline: false }, props: { lines: 3 }, errors: 0, durationMs: 120,
        appVersion: '1.6.0', buildId: 'b', platform: 'web', at: 1700000000000, createdAt: serverTimestamp(), ...extra
    });

    t('tip: any approved user creates and increments own device doc (set-merge)', async () => {
        const ref = as('staff1').collection(tipHealth).doc('abc123de4f5g_20261023');
        await assertSucceeds(ref.set(healthDoc('staff1'), { merge: true }));
        await assertSucceeds(ref.set(healthDoc('staff1'), { merge: true }));
        let snap;
        await env.withSecurityRulesDisabled(async (ctx) => {
            snap = (await ctx.firestore().collection(tipHealth).doc('abc123de4f5g_20261023').get()).data();
        });
        if (snap.v['1_6_0'].BillSave.n.s !== 2) throw new Error(`expected 2 increments, got ${snap.v['1_6_0'].BillSave.n.s}`);
    });

    t('tip: cannot write another user\'s device doc, a mismatched id, unknown fields or too many versions', async () => {
        await env.withSecurityRulesDisabled((ctx) => ctx.firestore().collection(tipHealth).doc('abc123de4f5g_20261023')
            .set({ ...healthDoc('manager1'), updatedAt: 1, v: {} }));
        await assertFails(as('staff1').collection(tipHealth).doc('abc123de4f5g_20261023').set(healthDoc('staff1'), { merge: true }));
        await assertFails(as('staff1').collection(tipHealth).doc('zzz999zz9z9z_20261023').set(healthDoc('manager1')));
        await assertFails(as('staff1').collection(tipHealth).doc('abc123de4f5g_20261024').set(healthDoc('staff1')));
        await assertFails(as('staff1').collection(tipHealth).doc('ext123ab4c5d_20261023').set(healthDoc('staff1', { deviceId: 'ext123ab4c5d', extra: 1 })));
        await assertFails(as('staff1').collection(tipHealth).doc('cus123ab4c5d_20261023').set(healthDoc('staff1', { deviceId: 'cus123ab4c5d', customerName: 'Ramesh' })));
        await assertSucceeds(as('staff1').collection(tipHealth).doc('cus123ab4c5d_20261023').set(healthDoc('staff1', { deviceId: 'cus123ab4c5d' })));
        const v = { a: {}, b: {}, c: {}, d: {}, e: {} };
        await assertFails(as('staff1').collection(tipHealth).doc('xyz789ab0c1d_20261023').set(healthDoc('staff1', { deviceId: 'xyz789ab0c1d', v })));
        await assertFails(as('pending1').collection(tipHealth).doc('pqr456gh7i8j_20261023').set(healthDoc('pending1', { deviceId: 'pqr456gh7i8j' })));
        await assertFails(anon().collection(tipHealth).doc('abc123de4f5g_20261023').get());
    });

    t('tip: only owner/manager read health and failures; only an owner deletes', async () => {
        await env.withSecurityRulesDisabled(async (ctx) => {
            await ctx.firestore().collection(tipHealth).doc('abc123de4f5g_20261023').set({ ...healthDoc('staff1'), updatedAt: 1, v: {} });
            await ctx.firestore().collection(tipFailures).doc('abc123de4f5g_20261023_1').set({ ...failureDoc('staff1'), createdAt: 1 });
        });
        await assertSucceeds(as('manager1').collection(tipHealth).where('day', '>=', '20261010').orderBy('day', 'desc').limit(300).get());
        await assertSucceeds(as('legacyOwner').collection(tipFailures).orderBy('at', 'desc').limit(30).get());
        await assertFails(as('staff1').collection(tipHealth).doc('abc123de4f5g_20261023').get());
        await assertFails(as('staff1').collection(tipFailures).doc('abc123de4f5g_20261023_1').get());
        await assertFails(as('manager1').collection(tipHealth).doc('abc123de4f5g_20261023').delete());
        await assertSucceeds(as('legacyOwner').collection(tipFailures).doc('abc123de4f5g_20261023_1').delete());
    });

    t('tip: failure samples are create-only, capped at 20 per device per day, own uid, no extra fields', async () => {
        const col = as('staff1').collection(tipFailures);
        await assertSucceeds(col.doc('abc123de4f5g_20261023_1').set(failureDoc('staff1')));
        await assertSucceeds(col.doc('abc123de4f5g_20261023_20').set(failureDoc('staff1', { result: 'rolled_back', reason: 16389 })));
        await assertFails(col.doc('abc123de4f5g_20261023_1').set(failureDoc('staff1', { reason: 2 })));
        await assertFails(col.doc('abc123de4f5g_20261023_21').set(failureDoc('staff1')));
        await assertFails(col.doc('abc123de4f5g_20261024_2').set(failureDoc('staff1')));
        await assertFails(col.doc('abc123de4f5g_20261023_3').set(failureDoc('manager1')));
        await assertFails(col.doc('abc123de4f5g_20261023_4').set(failureDoc('staff1', { phone: '9876543210' })));
        await assertFails(col.doc('abc123de4f5g_20261023_5').set(failureDoc('staff1', { result: 'succeed' })));
        await assertFails(col.doc('abc123de4f5g_20261023_6').set(failureDoc('staff1', { reasonName: 'x'.repeat(41) })));
    });

    // ---- rate trends (#65): rateStats, owner/manager only ----

    const rateStats = `${prefix}rateStats`;
    const sec = (extra = {}) => ({ kg: 100, amount: 2500, min: 24, max: 26, avg: 25, bills: 2, ...extra });
    const stat = (extra = {}) => ({
        itemId: 'wheat', month: '2026-10', purchase: sec(), retail: sec({ kg: 0, amount: 0, min: null, max: null, avg: 0, bills: 0 }),
        wholesale: sec({ avg: 27.5, amount: 2750 }), bills: 4, updatedAt: 1700000000000, ...extra
    });

    t('rateStats: owner and manager can write month docs and the backfill status, and read them', async () => {
        await assertSucceeds(as('manager1').collection(rateStats).doc('wheat_2026-10').set(stat()));
        await assertSucceeds(as('legacyOwner').collection(rateStats).doc('wheat_2026-10').set(stat({ bills: 5 })));
        await assertSucceeds(as('legacyOwner').collection(rateStats).doc('_meta').set(
            { backfillDone: true, backfillAt: 1, bills: 1200, reads: 1210, months: 36, by: 'O', byUserId: 'legacyOwner' }, { merge: true }));
        await assertSucceeds(as('manager1').collection(rateStats).doc('wheat_2026-10').get());
        await assertSucceeds(as('manager1').collection(rateStats).where('month', '>=', '2026-08').get());
        await assertSucceeds(as('manager1').collection(rateStats).doc('_meta').get());
    });

    t('rateStats: other users cannot read or write; pending users neither', async () => {
        await env.withSecurityRulesDisabled((ctx) => ctx.firestore().collection(rateStats).doc('wheat_2026-10').set(stat()));
        await assertFails(as('staff1').collection(rateStats).doc('wheat_2026-10').get());
        await assertFails(as('staff1').collection(rateStats).get());
        await assertFails(as('staff1').collection(rateStats).doc('wheat_2026-11').set(stat({ month: '2026-11' })));
        await assertFails(as('staff1').collection(rateStats).doc('_meta').set({ backfillDone: true }));
        await assertFails(as('pending1').collection(rateStats).doc('wheat_2026-10').get());
        await assertFails(anon().collection(rateStats).doc('wheat_2026-10').get());
    });

    t('rateStats: rejects wrong id, bad month, unknown fields and bad sections; only an owner deletes', async () => {
        await assertFails(as('manager1').collection(rateStats).doc('rice_2026-10').set(stat()));
        await assertFails(as('manager1').collection(rateStats).doc('wheat_2026-1').set(stat({ month: '2026-1' })));
        await assertFails(as('manager1').collection(rateStats).doc('wheat_2026-10').set(stat({ extra: 1 })));
        await assertFails(as('manager1').collection(rateStats).doc('wheat_2026-10').set(stat({ purchase: sec({ kg: 'lots' }) })));
        await assertFails(as('manager1').collection(rateStats).doc('wheat_2026-10').set(stat({ purchase: sec({ note: 'x' }) })));
        await assertFails(as('manager1').collection(rateStats).doc('_meta').set({ backfillDone: true, secret: 1 }));
        await env.withSecurityRulesDisabled((ctx) => ctx.firestore().collection(rateStats).doc('wheat_2026-10').set(stat()));
        await assertFails(as('manager1').collection(rateStats).doc('wheat_2026-10').delete());
        await assertSucceeds(as('legacyOwner').collection(rateStats).doc('wheat_2026-10').delete());
    });

    // ---- bill payment edits (#19) ----

    const dueBill = { userId: 'manager1', total: 100, items: [{ name: 'Rice', qty: 10 }], timestamp: 1760000000000,
        payment: { online: 0, cash: 0, due: 100, total: 0 }, dueAmount: 100, payments: [{ id: 'p0', amount: 0 }],
        openDue: true, clientVersion: 3 };
    // What outstanding.js applyPaymentTransaction writes for a cash payment.
    const paid = (cash, extra = {}) => ({
        payment: { online: 0, cash, due: 100 - cash, total: cash },
        payments: [...dueBill.payments, { id: 'p1', amount: cash, cash, online: 0, at: 1 }],
        dueAmount: 100 - cash, openDue: 100 - cash > 0, clientVersion: 3, ...extra
    });

    t('payment edits: a member records a payment and a write-off on another user\'s bill', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'b', dueBill);
            const ref = as('staff1').collection(coll).doc('b');
            await assertSucceeds(ref.update(paid(40)));
            // applyWriteOffTransaction: due to 0, writtenOff raised, one payments[] entry
            await assertSucceeds(ref.update({
                payment: { online: 0, cash: 40, due: 0, total: 40, writtenOff: 60 }, dueAmount: 0, openDue: false,
                payments: [...paid(40).payments, { id: 'w', kind: 'writeOff', amount: 60, reason: 'gone' }],
                cleared: true, clearedAt: 'x', clearedBy: 'staff1', clearedByName: 'S', clientVersion: 3
            }));
        }
    });

    t('payment edits: a member cannot raise the due, set it negative or write text', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'b', dueBill);
            const ref = as('legacyStaff').collection(coll).doc('b');
            await assertFails(ref.update(paid(40, { payment: { online: 0, cash: 40, due: 160, total: 40 }, dueAmount: 160 })));
            await assertFails(ref.update(paid(40, { payment: { online: 0, cash: 40, due: -1, total: 40 }, dueAmount: 0 })));
            await assertFails(ref.update(paid(40, { payment: { online: 0, cash: '40', due: 60, total: 40 } })));
            await assertFails(ref.update(paid(40, { payment: { online: -5, cash: 45, due: 60, total: 40 } })));
            await assertFails(ref.update(paid(40, { dueAmount: '60' })));
            await assertFails(ref.update(paid(40, { dueAmount: 0 })));
            await assertFails(ref.update({ dueAmount: 150, clientVersion: 3 }));
            await assertFails(ref.update({ payment: { ...dueBill.payment, due: 120 }, clientVersion: 3 }));
        }
    });

    t('payment edits: payments[] is append-only (no removal, no edit, one entry at a time, amount >= 0)', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'b', dueBill);
            const ref = as('staff1').collection(coll).doc('b');
            await assertFails(ref.update(paid(40, { payments: [] })));
            await assertFails(ref.update(paid(40, { payments: [{ id: 'p0', amount: 999 }, { id: 'p1', amount: 40 }] })));
            await assertFails(ref.update(paid(40, { payments: [...dueBill.payments, { amount: 20 }, { amount: 20 }] })));
            await assertFails(ref.update(paid(40, { payments: [...dueBill.payments, { amount: -40 }] })));
            await assertFails(ref.update(paid(40, { payments: [...dueBill.payments, { amount: 'forty' }] })));
            await assertFails(ref.update(paid(40, { payments: 'none' })));
        }
    });

    t('payment edits: works on bills without payments[] and with drifted dueAmount', async () => {
        for (const coll of bills) {
            const noList = { ...dueBill };
            delete noList.payments;
            await seedBill(coll, 'b', { ...noList, dueAmount: 0 });
            await assertSucceeds(as('staff1').collection(coll).doc('b').update({
                payment: { online: 0, cash: 40, due: 60, total: 40 }, payments: [{ id: 'p1', amount: 40 }],
                dueAmount: 60, openDue: true, clientVersion: 3
            }));
        }
    });

    t('bill create: a member may only create bills as themselves, with numeric money fields', async () => {
        for (const coll of bills) {
            const c = as('staff1').collection(coll);
            await assertSucceeds(c.doc('own').set({ userId: 'staff1', total: 10, payment: { cash: 10, online: 0, due: 0 }, clientVersion: 3 }));
            await assertFails(c.doc('other').set({ userId: 'manager1', total: 10, clientVersion: 3 }));
            await assertFails(c.doc('text').set({ userId: 'staff1', total: '10', clientVersion: 3 }));
            await assertFails(c.doc('textPay').set({ userId: 'staff1', total: 10, payment: { cash: 'ten' }, clientVersion: 3 }));
            await assertFails(c.doc('textDue').set({ userId: 'staff1', total: 10, dueAmount: 'x', clientVersion: 3 }));
            await assertSucceeds(as('legacyOwner').collection(coll).doc('restored').set({ userId: 'staff1', total: 10, clientVersion: 3 }));
        }
    });

    t('bill full edit: the creator cannot write text into money fields', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'b', { ...dueBill, userId: 'staff1', ...fresh() });
            await assertFails(as('staff1').collection(coll).doc('b').update({ total: 'free', clientVersion: 3 }));
            await assertSucceeds(as('staff1').collection(coll).doc('b').update({ total: 90, clientVersion: 3 }));
        }
    });

    // ---- cash sessions (#18) ----

    const cash = `${prefix}cashManagement`;
    const session = (extra = {}) => ({
        id: 's1', date: '2026-10-22', openingBalance: 500, signInTime: 'x', userId: 'staff1', userName: 'S',
        signedOut: false, duePayments: [], ...extra
    });
    const seedSession = (extra = {}) => seedBill(cash, 's1', session(extra));
    const deposit = (amount = 100, id = 'd1') => ({ id, amount, reason: '', timestamp: 'x', addedBy: 'S' });
    const closing = (extra = {}) => ({
        closingBalance: 600, expectedBalance: 600, difference: 0, signOutTime: 'x', signedOut: true, counted: true,
        transactions: { cashSales: 100 }, ...extra
    });

    t('cash: members (incl. legacy no-status) sign in as themselves with a valid opening amount', async () => {
        await assertSucceeds(as('staff1').collection(cash).doc('s1').set(session()));
        await assertSucceeds(as('legacyStaff').collection(cash).doc('s2').set(session({ id: 's2', userId: 'legacyStaff', openingBalance: 0 })));
        await assertFails(as('staff1').collection(cash).doc('s3').set(session({ userId: 'manager1' })));
        await assertFails(as('staff1').collection(cash).doc('s4').set(session({ openingBalance: -1 })));
        await assertFails(as('staff1').collection(cash).doc('s5').set(session({ openingBalance: '500' })));
        await assertFails(as('staff1').collection(cash).doc('s6').set(session({ signedOut: true })));
        await assertFails(as('pending1').collection(cash).doc('s7').set(session({ userId: 'pending1' })));
    });

    t('cash: anyone approved appends deposits / due payments (arrayUnion and transaction)', async () => {
        await seedSession();
        const ref = as('staff1').collection(cash).doc('s1');
        await assertSucceeds(ref.update({ cashDeposits: FieldValue.arrayUnion(deposit()) }));
        await assertSucceeds(as('legacyStaff').collection(cash).doc('s1').update({ duePayments: FieldValue.arrayUnion({ id: 'u1', amount: 50, type: 'received' }) }));
        // outstanding.js applyPaymentTransaction: whole list with one leg appended
        await assertSucceeds(as('manager1').collection(cash).doc('s1').update({
            duePayments: [{ id: 'u1', amount: 50, type: 'received' }, { id: 'p1', amount: 40, billId: 'b' }]
        }));
    });

    t('cash: nobody but the owner removes, edits or bulk-adds session entries', async () => {
        await seedSession({ cashDeposits: [deposit()], duePayments: [{ id: 'u1', amount: 50 }] });
        for (const uid of ['staff1', 'manager1']) {
            const ref = as(uid).collection(cash).doc('s1');
            await assertFails(ref.update({ cashDeposits: [] }));
            await assertFails(ref.update({ cashDeposits: FieldValue.arrayRemove(deposit()) }));
            await assertFails(ref.update({ cashDeposits: [deposit(1)] }));
            await assertFails(ref.update({ duePayments: [{ id: 'u1', amount: 50 }, { amount: 1 }, { amount: 2 }] }));
            await assertFails(ref.update({ cashDeposits: FieldValue.arrayUnion(deposit(-100, 'd2')) }));
            await assertFails(ref.update({ cashDeposits: FieldValue.arrayUnion(deposit('100', 'd3')) }));
            await assertFails(ref.update({ openingBalance: 5000 }));
            await assertFails(ref.update({ userId: uid }));
            await assertFails(ref.update({ date: '2026-10-01' }));
        }
        await assertSucceeds(as('legacyOwner').collection(cash).doc('s1').update({ cashDeposits: [], openingBalance: 450 }));
    });

    t('cash: entries queued offline still append to a session another device closed (append-only)', async () => {
        await seedSession(closing({ cashDeposits: [deposit()], duePayments: [{ id: 'u1', amount: 50 }] }));
        const ref = as('staff1').collection(cash).doc('s1');
        await assertSucceeds(ref.update({ cashDeposits: FieldValue.arrayUnion(deposit(20, 'd2')) }));
        await assertSucceeds(as('legacyStaff').collection(cash).doc('s1').update({ duePayments: FieldValue.arrayUnion({ id: 'u2', amount: 30 }) }));
        await assertSucceeds(as('manager1').collection(cash).doc('s1').update({
            duePayments: [{ id: 'u1', amount: 50 }, { id: 'u2', amount: 30 }, { id: 'p1', amount: 40 }]
        }));
        await assertFails(ref.update({ cashDeposits: [deposit()] }));
        await assertFails(ref.update({ cashDeposits: [deposit(999), deposit(20, 'd2')] }));
        await assertFails(ref.update({ duePayments: [{ id: 'u1', amount: 50 }] }));
        await assertFails(ref.update({ cashDeposits: FieldValue.arrayUnion(deposit(1, 'd3'), deposit(2, 'd4')) }));
        await assertFails(ref.update({ cashDeposits: FieldValue.arrayUnion(deposit(-5, 'd5')) }));
        await assertFails(ref.update({ cashDeposits: FieldValue.arrayUnion(deposit(5, 'd6')), closingBalance: 0 }));
    });

    t('cash: a counted sign-out may replace an automatic close (old apps sign out with a plain update)', async () => {
        const autoNew = closing({ closingBalance: null, difference: null, counted: false, autoSignedOut: true, autoClosed: true,
            autoSignOutReason: 'Session not closed by end of day' });
        // new-style auto-close (counted: false, closingBalance null)
        await seedSession(autoNew);
        await assertSucceeds(as('staff1').collection(cash).doc('s1').update({ closingBalance: 640, expectedBalance: 600,
            difference: 40, signOutTime: 'y', signedOut: true, transactions: { cashSales: 140 } }));
        await seedSession(autoNew);
        await assertSucceeds(as('legacyStaff').collection(cash).doc('s1').update(closing({ closingBalance: 590, difference: -10 })));
        // old-style auto-close (closingBalance 0, no `counted`)
        await seedSession(closing({ closingBalance: 0, difference: -600, autoSignedOut: true }));
        await env.withSecurityRulesDisabled(ctx => ctx.firestore().collection(cash).doc('s1').update({ counted: FieldValue.delete() }));
        await assertSucceeds(as('staff1').collection(cash).doc('s1').update({ closingBalance: 600, difference: 0, signOutTime: 'y', signedOut: true }));
    });

    t('cash: an automatic close cannot be replaced without a count, with other fields, or after a real count', async () => {
        const autoNew = closing({ closingBalance: null, difference: null, counted: false, autoSignedOut: true });
        await seedSession(autoNew);
        const ref = as('staff1').collection(cash).doc('s1');
        await assertFails(ref.update({ closingBalance: null, signOutTime: 'y', signedOut: true }));
        await assertFails(ref.update({ closingBalance: -1, signOutTime: 'y', signedOut: true }));
        await assertFails(ref.update({ closingBalance: '600', signOutTime: 'y', signedOut: true }));
        await assertFails(ref.update({ closingBalance: 600, signedOut: true, openingBalance: 0 }));
        await assertFails(ref.update({ closingBalance: 600, signedOut: true, userId: 'staff1x' }));
        // already counted (late count or sign-out over the auto-close): no second count
        await seedSession({ ...autoNew, closingBalance: 600, counted: true, countedLate: true });
        await assertFails(ref.update({ closingBalance: 1, signOutTime: 'z', signedOut: true }));
        // a normal (not automatic) sign-out cannot be redone
        await seedSession(closing());
        await assertFails(ref.update({ closingBalance: 1, signOutTime: 'z', signedOut: true }));
    });

    t('cash: anyone approved signs out (also as a full set) or the app auto-closes a past day', async () => {
        await seedSession();
        await assertSucceeds(as('staff1').collection(cash).doc('s1').update(closing({ closingNotes: 'ok', flags: [] })));
        await seedSession();
        await assertSucceeds(as('legacyStaff').collection(cash).doc('s1').set({ ...session(), ...closing() }));
        await seedSession();
        await assertSucceeds(as('manager1').collection(cash).doc('s1').update(closing({
            closingBalance: null, difference: null, counted: false, autoSignedOut: true, autoClosed: true,
            autoSignOutReason: 'Session not closed by end of day', expectedBalance: -20
        })));
    });

    t('cash: sign-out cannot change other fields, use bad amounts or close twice', async () => {
        await seedSession({ cashDeposits: [deposit()] });
        const ref = as('staff1').collection(cash).doc('s1');
        await assertFails(ref.update(closing({ openingBalance: 0 })));
        await assertFails(ref.update(closing({ closingBalance: -5 })));
        await assertFails(ref.update(closing({ closingBalance: '600' })));
        await assertFails(ref.update(closing({ closingBalance: null })));
        // an old-app full set that would drop a deposit added on another device
        await assertFails(ref.set({ ...session(), ...closing() }));
        await seedSession(closing());
        await assertFails(ref.update(closing({ closingBalance: 10, signOutTime: 'y' })));
    });

    t('cash: a late count is recorded once, by the caller, on a day closed without a count', async () => {
        const lateCount = (uid, amount = 550) => ({ closingBalance: amount, difference: -50, counted: true, countedLate: true,
            countedAt: 'x', countedBy: uid, countedByName: 'S' });
        await seedSession(closing({ closingBalance: null, difference: null, counted: false, autoSignedOut: true }));
        await assertFails(as('staff1').collection(cash).doc('s1').update(lateCount('manager1')));
        await assertFails(as('staff1').collection(cash).doc('s1').update(lateCount('staff1', -1)));
        await assertSucceeds(as('staff1').collection(cash).doc('s1').update(lateCount('staff1')));
        await assertFails(as('manager1').collection(cash).doc('s1').update(lateCount('manager1', 999)));
        // legacy auto-closed session without `counted`
        await seedSession(closing({ closingBalance: 0, autoSignedOut: true }));
        await env.withSecurityRulesDisabled(ctx => ctx.firestore().collection(cash).doc('s1').update({ counted: FieldValue.delete() }));
        await assertSucceeds(as('legacyStaff').collection(cash).doc('s1').update(lateCount('legacyStaff')));
    });

    t('cash: a due payment updates the bill and today\'s session in one transaction (outstanding.js)', async () => {
        await seedSession({ duePayments: [{ id: 'u1', amount: 50 }] });
        const billColl = `${prefix}retailSales`;
        await seedBill(billColl, 'b', dueBill);
        const db = as('staff1');
        await assertSucceeds(db.runTransaction(async (tx) => {
            const billRef = db.collection(billColl).doc('b');
            const sessionRef = db.collection(cash).doc('s1');
            await tx.get(billRef);
            const s = await tx.get(sessionRef);
            tx.update(billRef, paid(40));
            tx.update(sessionRef, { duePayments: [...s.data().duePayments, { id: 'p1', amount: 40, billId: 'b' }] });
        }));
    });

    t('cash: only the owner deletes a session', async () => {
        await seedSession();
        await assertFails(as('staff1').collection(cash).doc('s1').delete());
        await assertFails(as('manager1').collection(cash).doc('s1').delete());
        await assertSucceeds(as('legacyOwner').collection(cash).doc('s1').delete());
    });

    // ---- expenses (#18) ----

    const expenses = `${prefix}expenses`;
    const expense = (uid, extra = {}) => ({
        type: 'Tea', personName: '', amount: 50, remarks: '', category: 'business', date: '22/10/2026, 10:00:00',
        createdBy: uid, createdByName: 'S', userId: uid, userName: 'S', timestamp: Date.now(), ...extra
    });
    const edit = (extra = {}) => ({ type: 'Tea', amount: 60, remarks: 'fixed', updatedAt: 'x', updatedBy: 'staff1', updatedByName: 'S', ...extra });

    t('expenses: approved users record their own expense with a numeric amount', async () => {
        await assertSucceeds(as('staff1').collection(expenses).doc('e1').set(expense('staff1')));
        await assertSucceeds(as('legacyStaff').collection(expenses).doc('e2').set(expense('legacyStaff', { category: 'personal' })));
        await assertFails(as('staff1').collection(expenses).doc('e3').set(expense('manager1')));
        await assertFails(as('staff1').collection(expenses).doc('e4').set(expense('staff1', { amount: '50' })));
        await assertFails(as('staff1').collection(expenses).doc('e5').set(expense('staff1', { amount: -50 })));
        await assertFails(as('pending1').collection(expenses).doc('e6').set(expense('pending1')));
    });

    t('expenses: a member edits or deletes their own expense within 24 hours', async () => {
        await seedBill(expenses, 'mine', expense('staff1', { timestamp: Date.now() - 2 * HOUR }));
        await assertSucceeds(as('staff1').collection(expenses).doc('mine').update(edit()));
        await assertSucceeds(as('staff1').collection(expenses).doc('mine').delete());
    });

    t('expenses: a member cannot change other users\' or older expenses, or protected fields', async () => {
        await seedBill(expenses, 'theirs', expense('manager1'));
        await seedBill(expenses, 'old', expense('staff1', { timestamp: Date.now() - 25 * HOUR }));
        await seedBill(expenses, 'legacy', { type: 'Tea', amount: 50, category: 'business', date: '01/10/2026' });
        await seedBill(expenses, 'mine', expense('staff1'));
        const c = as('staff1').collection(expenses);
        await assertFails(c.doc('theirs').update(edit()));
        await assertFails(c.doc('theirs').delete());
        await assertFails(c.doc('old').update(edit()));
        await assertFails(c.doc('old').delete());
        await assertFails(c.doc('legacy').delete());
        await assertFails(c.doc('mine').update(edit({ category: 'personal' })));
        await assertFails(c.doc('mine').update(edit({ timestamp: Date.now() + DAY })));
        await assertFails(c.doc('mine').update(edit({ userId: 'manager1' })));
        await assertFails(c.doc('mine').update(edit({ amount: 'free' })));
    });

    t('expenses: owner and manager edit and delete any expense', async () => {
        await seedBill(expenses, 'a', expense('staff1', { timestamp: Date.now() - 30 * DAY }));
        await seedBill(expenses, 'b', expense('staff1', { timestamp: Date.now() - 30 * DAY }));
        await assertSucceeds(as('manager1').collection(expenses).doc('a').update(edit({ updatedBy: 'manager1' })));
        await assertFails(as('manager1').collection(expenses).doc('a').update({ amount: 'x' }));
        await assertSucceeds(as('manager1').collection(expenses).doc('a').delete());
        await assertSucceeds(as('legacyOwner').collection(expenses).doc('b').update({ amount: 1, category: 'personal' }));
        await assertSucceeds(as('legacyOwner').collection(expenses).doc('b').delete());
    });

    // ---- legacy timestamp backfill (any approved device) ----

    t('backfill: members may fill a missing timestamp on expenses/withdrawals/adjustments, never change one', async () => {
        for (const c of ['expenses', 'withdrawals', 'stockAdjustments']) {
            const coll = `${prefix}${c}`;
            await seedBill(coll, 'old', { amount: 5, quantity: 5, date: '01/10/2026', userId: 'manager1' });
            await seedBill(coll, 'new', { amount: 5, quantity: 5, date: '01/10/2026', userId: 'manager1', timestamp: 1 });
            const update = c === 'stockAdjustments' ? { timestamp: 1759276800000, clientVersion: 3 } : { timestamp: 1759276800000 };
            await assertSucceeds(as('staff1').collection(coll).doc('old').update(update));
            await assertFails(as('staff1').collection(coll).doc('new').update(update));
            await assertFails(as('staff1').collection(coll).doc('old').update({ amount: 0 }));
        }
    });

    // ---- withdrawals / stock adjustments (#18) ----

    t('backfill: a batch over several stock adjustments passes for a member', async () => {
        const coll = `${prefix}stockAdjustments`;
        const db = as('staff1');
        const batch = db.batch();
        for (const id of ['a', 'b', 'c', 'd']) {
            await seedBill(coll, id, { quantity: 1, date: '01/10/2026', userId: 'manager1' });
            batch.update(db.collection(coll).doc(id), { timestamp: 1759276800000, clientVersion: 3 });
        }
        await assertSucceeds(batch.commit());
    });

    const withdrawals = `${prefix}withdrawals`;
    const adjustments = `${prefix}stockAdjustments`;
    const adjustment = (uid, extra = {}) => ({
        itemId: 'i1', itemName: 'Rice', adjustType: 'remove', quantity: 5, rawQuantity: 5, rate: 0, previousStock: 10,
        newStock: 5, reason: 'Damaged', reasonCode: 'damaged', date: 'x', timestamp: Date.now(), createdBy: uid,
        createdByName: 'S', userId: uid, userName: 'S', clientVersion: 3, ...extra
    });

    t('withdrawals: recorded with a numeric amount; only owner/manager change or delete them', async () => {
        const w = { amount: 500, person: 'O', purpose: 'Personal Use', date: '2026-10-22', createdAt: 'x', userId: 'manager1', timestamp: Date.now() };
        await assertSucceeds(as('manager1').collection(withdrawals).doc('w1').set(w));
        await assertFails(as('manager1').collection(withdrawals).doc('w2').set({ ...w, amount: '500' }));
        await assertFails(as('staff1').collection(withdrawals).doc('w3').set(w));
        await assertSucceeds(as('staff1').collection(withdrawals).doc('w4').set({ ...w, userId: 'staff1' }));
        await assertFails(as('staff1').collection(withdrawals).doc('w1').update({ amount: 1 }));
        await assertFails(as('staff1').collection(withdrawals).doc('w1').delete());
        await assertSucceeds(as('manager1').collection(withdrawals).doc('w1').update({ amount: 400 }));
        await assertSucceeds(as('manager1').collection(withdrawals).doc('w1').delete());
    });

    t('stock adjustments: anyone approved records one; only owner/manager change or delete it', async () => {
        await assertSucceeds(as('staff1').collection(adjustments).doc('a1').set(adjustment('staff1')));
        await assertSucceeds(as('legacyStaff').collection(adjustments).doc('a2').set(adjustment('legacyStaff', { adjustType: 'set', quantity: 0 })));
        await assertFails(as('staff1').collection(adjustments).doc('a3').set(adjustment('manager1')));
        await assertFails(as('staff1').collection(adjustments).doc('a4').set(adjustment('staff1', { quantity: -5 })));
        await assertFails(as('staff1').collection(adjustments).doc('a5').set(adjustment('staff1', { quantity: '5' })));
        await assertFails(as('staff1').collection(adjustments).doc('a6').set(adjustment('staff1', { adjustType: 'steal' })));
        await assertFails(as('staff1').collection(adjustments).doc('a1').update({ quantity: 50, clientVersion: 3 }));
        await assertFails(as('staff1').collection(adjustments).doc('a1').delete());
        await assertSucceeds(as('manager1').collection(adjustments).doc('a1').update({ reason: 'Counted', clientVersion: 3 }));
        await assertSucceeds(as('manager1').collection(adjustments).doc('a1').delete());
        await assertSucceeds(as('legacyOwner').collection(adjustments).doc('a2').delete());
        await assertFails(as('pending1').collection(adjustments).doc('a7').set(adjustment('pending1')));
    });

    // ---- items (#18) ----

    const items = `${prefix}items`;
    const item = { name: 'Rice', hindiName: 'चावल', rates: [40], saleRates: [45], wholesaleRates: [42] };

    t('items: owner/manager create and edit (incl. import merge); members cannot', async () => {
        await assertSucceeds(as('manager1').collection(items).doc('i1').set(item));
        await assertSucceeds(as('manager1').collection(items).doc('i1').set({ ...item, rates: [40, 41] }));
        await assertSucceeds(as('manager1').collection(items).doc('i1').set({ saleRates: [46] }, { merge: true }));
        await assertSucceeds(as('legacyOwner').collection(items).doc('i2').set(item));
        await assertFails(as('staff1').collection(items).doc('i3').set(item));
        await assertFails(as('staff1').collection(items).doc('i1').update({ rates: [1] }));
        await assertFails(as('legacyStaff').collection(items).doc('i1').update({ name: 'X' }));
        await assertFails(as('manager1').collection(items).doc('i1').update({ rates: '40' }));
        await assertFails(as('manager1').collection(items).doc('i4').set({ ...item, name: 5 }));
        await assertSucceeds(as('staff1').collection(items).doc('i1').get());
    });

    t('items: only the owner deletes an item', async () => {
        await seedBill(items, 'i1', item);
        await assertFails(as('staff1').collection(items).doc('i1').delete());
        await assertFails(as('manager1').collection(items).doc('i1').delete());
        await assertSucceeds(as('legacyOwner').collection(items).doc('i1').delete());
    });

    // ---- bill-number counters (#18 / #41) ----

    const counter = (extra = {}) => ({ next: 5, initialized: true, prefix: 'S', date: '20261022', updatedAt: 1, ...extra });

    t('counters: the bill-number transaction (create, +1) works for every approved user', async () => {
        const c = (uid) => as(uid).collection(counters).doc('S20261022');
        await assertSucceeds(c('staff1').set(counter({ next: 1 }), { merge: true }));
        await assertSucceeds(c('legacyStaff').set(counter({ next: 2, updatedAt: 2 }), { merge: true }));
        const db = as('staff1');
        await assertSucceeds(db.runTransaction(async (tx) => {
            const ref = db.collection(counters).doc('S20261022');
            const snap = await tx.get(ref);
            tx.set(ref, counter({ next: snap.data().next + 1, updatedAt: 3 }), { merge: true });
        }));
    });

    t('counters: nobody but the owner rewinds, skips, rewrites or deletes a counter', async () => {
        await seedBill(counters, 'S20261022', counter());
        for (const uid of ['staff1', 'manager1']) {
            const ref = as(uid).collection(counters).doc('S20261022');
            await assertFails(ref.set(counter({ next: 4 }), { merge: true }));
            await assertFails(ref.set(counter({ next: 7 }), { merge: true }));
            await assertFails(ref.set(counter({ next: 5, prefix: 'W' }), { merge: true }));
            await assertFails(ref.set(counter({ next: 6, extra: 1 }), { merge: true }));
            await assertFails(ref.set(counter({ next: '6' }), { merge: true }));
            await assertFails(ref.delete());
        }
        await assertFails(as('staff1').collection(counters).doc('P20261022').set({ next: 0 }));
        await assertFails(as('staff1').collection(counters).doc('P20261022').set({ next: 1, hack: true }));
        await assertSucceeds(as('legacyOwner').collection(counters).doc('S20261022').set(counter({ next: 1 })));
        await assertSucceeds(as('legacyOwner').collection(counters).doc('S20261022').delete());
    });

    t('counters: an unseeded counter may jump forward once (seeded from today\'s bills), never back', async () => {
        await seedBill(counters, 'S20261022', { next: 3 });
        await assertFails(as('staff1').collection(counters).doc('S20261022').set(counter({ next: 2 }), { merge: true }));
        await assertSucceeds(as('staff1').collection(counters).doc('S20261022').set(counter({ next: 9 }), { merge: true }));
    });

    t('pending users cannot write cash, expenses, items or counters', async () => {
        await assertFails(as('pending1').collection(counters).doc('x').set({ next: 1 }));
        await assertFails(as('pending1').collection(items).doc('x').set(item));
        await assertFails(as('rejected1').collection(expenses).doc('x').set(expense('rejected1')));
        await assertFails(as('rejected1').collection(cash).doc('x').set(session({ userId: 'rejected1' })));
    });
}

defineSuite('');
defineSuite('dev_');

test('[cross-env] prod approval does not grant dev access and vice versa', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        await db.collection('users').doc('prodOnly').set({ role: 'staff', status: 'active' });
        await db.collection('dev_users').doc('devOnly').set({ role: 'staff', status: 'active' });
    });
    await assertFails(as('prodOnly').collection('dev_purchases').get());
    await assertFails(as('devOnly').collection('purchases').get());
});

test('[other] unknown collections are denied', () =>
    assertFails(as('staff1').collection('randomCollection').get()));

async function main() {
    env = await initializeTestEnvironment({
        projectId: 'demo-aadhat',
        firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8') }
    });

    let passed = 0;
    let failed = 0;
    for (const { name, fn } of tests) {
        await env.clearFirestore();
        await seedUsers('users');
        await seedUsers('dev_users');
        try {
            await fn();
            passed++;
            console.log(`  ok   ${name}`);
        } catch (e) {
            failed++;
            console.log(`  FAIL ${name}\n       ${e.message}`);
        }
    }

    await env.cleanup();
    console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
