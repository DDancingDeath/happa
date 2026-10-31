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
// 01/10/2025 00:00 in India: the app reads a DD/MM/YYYY bill date as the phone's local time.
const IST_OCT_1 = Date.UTC(2025, 8, 30, 18, 30);

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
        await db.collection(usersCol).doc('owner2').set({ name: 'O2', email: 'o2@x.com', role: 'owner', status: 'approved' });
        await db.collection(usersCol).doc('legacyStaff').set({ name: 'L', email: 'l@x.com', role: 'staff' });
        await db.collection(usersCol).doc('noRole').set({ name: 'N', email: 'n@x.com', status: 'active' });
        // Rentals (#170): shop member + rentals role, and a rentals-only helper (shop role 'none').
        await db.collection(usersCol).doc('rentManager').set({ name: 'RM', role: 'staff', rentRole: 'manager', status: 'active' });
        await db.collection(usersCol).doc('rentMember').set({ name: 'RC', role: 'staff', rentRole: 'member', status: 'active' });
        await db.collection(usersCol).doc('rentOnly').set({ name: 'RO', role: 'none', rentRole: 'member', status: 'active' });
        await db.collection(usersCol).doc('rentPending').set({ name: 'RP', role: 'staff', rentRole: 'manager', status: 'pending' });
    });
}

// One Firestore client per uid for the whole run: a new one per call kept every
// instance alive and the suite ran out of memory (the data is cleared between tests).
const clients = new Map();
const as = (uid) => {
    if (!clients.has(uid)) clients.set(uid, env.authenticatedContext(uid).firestore());
    return clients.get(uid);
};
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
    // What an app that knows voided bills (#75, CLIENT_VERSION 4) stamps on stock checkpoint,
    // month snapshot and rate stats writes (firestore-service.js voidAwareStamp).
    const V4 = (cv = 4) => ({ clientVersion: cv, writtenAt: serverTimestamp() });

    // A full edit as the app writes it (#121): the bill change with editCount n and its
    // edit record edits/{n} in one batch (firestore-service.js updateBillChecked). The record
    // names the logged fields the change touches (validEditCreate checks it).
    const LOGGED = ['items', 'customerName', 'grandTotal', 'amountPayable', 'total', 'billTotal', 'saleTotal',
        'laborCharges', 'payment', 'cashPayment', 'onlinePayment', 'dueAmount', 'date', 'timestamp'];
    const stored = async (coll, id) => {
        let data = {};
        await env.withSecurityRulesDisabled(async (ctx) => {
            const snap = await ctx.firestore().collection(coll).doc(id).get();
            data = snap.exists ? snap.data() : {};
        });
        return data;
    };
    // The record's fields: each logged field the change touches, with its true value before and after.
    const recFor = (before, fields, set) => {
        const after = set ? { ...fields } : { ...before };
        if (!set) {
            Object.entries(fields).forEach(([k, v]) => {
                const p = k.split('.');
                if (p.length === 1) { after[k] = v; return; }
                after[p[0]] = { ...(after[p[0]] || {}) };
                after[p[0]][p[1]] = v;
            });
        }
        const out = {};
        LOGGED.forEach(k => {
            const b = before[k] === undefined ? null : before[k];
            const a = after[k] === undefined ? null : after[k];
            if (JSON.stringify(b) !== JSON.stringify(a)) out[k] = { before: b, after: a };
        });
        return out;
    };
    const editRec = (uid, n, over = {}) => ({ n, at: serverTimestamp(), by: uid, byName: 'S', reason: 'Wrong rate', fields: {}, ...over });
    const logged = async (uid, coll, id, n, fields, { set = false, rec = {}, recId = String(n), cv = 4 } = {}) => {
        const before = await stored(coll, id);
        const db = as(uid);
        const ref = db.collection(coll).doc(id);
        const b = db.batch();
        if (set) b.set(ref, { ...fields, editCount: n, clientVersion: cv });
        else b.update(ref, { ...fields, editCount: n, clientVersion: cv });
        b.set(ref.collection('edits').doc(recId), editRec(uid, n, { fields: recFor(before, fields, set), ...rec }));
        return b.commit();
    };
    // A void as the app writes it (#75: firestore-service.js voidBillDoc).
    const voidFields = (uid, over = {}) => ({ voided: true, voidedAt: serverTimestamp(), voidedBy: uid, voidedByName: 'S',
        voidReason: 'Entered twice', openDue: false, clientVersion: 4, ...over });

    t('only the owner deletes a bill; the creator and a manager cannot (#75: they void it)', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'mine', { userId: 'staff1', total: 5, ...fresh() });
            await assertFails(as('manager1').collection(coll).doc('mine').delete());
            await assertFails(as('staff1').collection(coll).doc('mine').delete());
            await assertSucceeds(as('legacyOwner').collection(coll).doc('mine').delete());
            // deleting a bill that is already gone stays a no-op
            await assertSucceeds(as('staff1').collection(coll).doc('gone').delete());
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

    // ---- void (#75) ----

    t('void: the creator inside the window, the owner any bill; not a manager on another\'s bill, not after the window', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'mine', { userId: 'staff1', total: 5, openDue: true, clientVersion: 3, ...fresh() });
            await seedBill(coll, 'old', { userId: 'staff1', total: 5, createdAt: savedAgo(3 * DAY) });
            await seedBill(coll, 'legacy', { total: 5 });
            await assertFails(as('manager1').collection(coll).doc('mine').update(voidFields('manager1')));
            await assertFails(as('staff1').collection(coll).doc('old').update(voidFields('staff1')));
            await assertFails(as('staff1').collection(coll).doc('legacy').update(voidFields('staff1')));
            await assertFails(as('pending1').collection(coll).doc('mine').update(voidFields('pending1')));
            await assertSucceeds(as('staff1').collection(coll).doc('mine').update(voidFields('staff1')));
            await assertSucceeds(as('legacyOwner').collection(coll).doc('old').update(voidFields('legacyOwner')));
            await assertSucceeds(as('legacyOwner').collection(coll).doc('legacy').update(voidFields('legacyOwner')));
        }
    });

    t('void: a reason (3–300 characters), the caller, the server time; only the void fields; openDue false', async () => {
        await seedBill(purchases, 'b', { userId: 'staff1', total: 5, openDue: true, ...fresh() });
        const ref = as('staff1').collection(purchases).doc('b');
        const { voidReason: _reason, ...noReason } = voidFields('staff1');
        await assertFails(ref.update(noReason));
        await assertFails(ref.update(voidFields('staff1', { voidReason: '' })));
        await assertFails(ref.update(voidFields('staff1', { voidReason: '  x  ' })));
        await assertFails(ref.update(voidFields('staff1', { voidReason: 'x'.repeat(301) })));
        await assertFails(ref.update(voidFields('staff1', { voidedBy: 'manager1' })));
        await assertFails(ref.update(voidFields('staff1', { voidedAt: Timestamp.fromMillis(Date.now() - DAY) })));
        await assertFails(ref.update(voidFields('staff1', { openDue: true })));
        await assertFails(ref.update(voidFields('staff1', { voided: 'yes' })));
        await assertFails(ref.update(voidFields('staff1', { total: 0 })));
        await assertFails(as('legacyOwner').collection(purchases).doc('b').update(voidFields('legacyOwner', { voidReason: 'no' })));
        await assertSucceeds(ref.update(voidFields('staff1')));
    });

    t('void: refused while payments recorded after the save exist, for the owner too (their cash legs stay)', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'paid', { userId: 'staff1', total: 100, payment: { cash: 40, online: 0, due: 60 },
                payments: [{ id: 'p1', amount: 40, cash: 40, online: 0, at: Date.now() }], paidAt: Date.now(), ...fresh() });
            await assertFails(as('staff1').collection(coll).doc('paid').update(voidFields('staff1')));
            await assertFails(as('legacyOwner').collection(coll).doc('paid').update(voidFields('legacyOwner')));
            // nor can the creator empty payments[] first (a full edit never touches payments / paidAt)
            await assertFails(as('staff1').collection(coll).doc('paid').update({ payments: [], paidAt: FieldValue.delete() }));
            await assertFails(as('manager1').collection(coll).doc('paid').update({ payments: [] }));
        }
    });

    t('void needs an app that knows voids (clientVersion 4), gate on or off; it voids old-app bills too', async () => {
        await seedBill(purchases, 'oldApp', { total: 5 });
        await seedBill(purchases, 'mine', { userId: 'staff1', total: 5, clientVersion: 4, ...fresh() });
        const { clientVersion: _cv, ...noVersion } = voidFields('legacyOwner');
        await assertFails(as('legacyOwner').collection(purchases).doc('oldApp').update(noVersion));
        await assertFails(as('legacyOwner').collection(purchases).doc('oldApp').update(voidFields('legacyOwner', { clientVersion: 3 })));
        await assertFails(as('staff1').collection(purchases).doc('mine').update(voidFields('staff1', { clientVersion: 3 })));
        await env.withSecurityRulesDisabled(ctx => ctx.firestore().collection(`${prefix}settings`).doc('app').set({ enforceClientVersion: true }, { merge: true }));
        await assertSucceeds(as('legacyOwner').collection(purchases).doc('oldApp').update(voidFields('legacyOwner')));
        await assertSucceeds(as('staff1').collection(purchases).doc('mine').update(voidFields('staff1')));
    });

    t('a voided bill never changes again: no un-void, edit, payment or second void, the owner included; only the owner deletes it', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'v', { userId: 'staff1', total: 100, payment: { cash: 0, online: 0, due: 100 }, dueAmount: 100,
                clientVersion: 3, openDue: false, voided: true, voidedAt: Timestamp.now(), voidedBy: 'staff1', voidReason: 'Entered twice', ...fresh() });
            for (const uid of ['staff1', 'manager1', 'legacyOwner']) {
                const ref = as(uid).collection(coll).doc('v');
                await assertFails(ref.update({ voided: false }));
                await assertFails(ref.update({ voided: FieldValue.delete(), voidedAt: FieldValue.delete(), voidedBy: FieldValue.delete(), voidReason: FieldValue.delete() }));
                await assertFails(ref.update({ customerName: 'X' }));
                await assertFails(ref.update({ voidReason: 'Changed my mind' }));
                await assertFails(ref.update({ 'payment.cash': 40, 'payment.online': 0, 'payment.due': 60, dueAmount: 60,
                    payments: [{ amount: 40, cash: 40, online: 0, at: Date.now() }], paidAt: Date.now() }));
            }
            await assertFails(as('staff1').collection(coll).doc('v').delete());
            await assertSucceeds(as('legacyOwner').collection(coll).doc('v').delete());
        }
    });

    t('members can\'t create a bill that is voided or has an edit count', async () => {
        const c = as('staff1').collection(purchases);
        await assertFails(c.doc('n1').set({ userId: 'staff1', total: 5, ...voidFields('staff1') }));
        await assertFails(c.doc('n2').set({ userId: 'staff1', total: 5, editCount: 1 }));
        await assertSucceeds(c.doc('n3').set({ userId: 'staff1', total: 5 }));
    });

    // ---- edit records (#121): <bills>/{id}/edits/{n} ----

    t('edit record: a non-owner\'s change to items, money, party or date writes edits/{n} with it; editor = caller, server time, reason', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'e', { userId: 'staff1', total: 5, date: '2026-10-01', items: [{ name: 'x', qty: 1, total: 5 }], ...fresh() });
            await assertFails(as('staff1').collection(coll).doc('e').update({ total: 6 }));
            await assertFails(as('staff1').collection(coll).doc('e').update({ items: [{ name: 'x', qty: 2, total: 10 }] }));
            // probe: the date (or timestamp) moved without a record
            await assertFails(as('staff1').collection(coll).doc('e').update({ date: '2026-09-01' }));
            await assertFails(as('staff1').collection(coll).doc('e').update({ timestamp: 1 }));
            // the notes alone need none (and get none: see "no real change" below)
            await assertSucceeds(as('staff1').collection(coll).doc('e').update({ comments: 'note' }));
            await assertFails(logged('staff1', coll, 'e', 1, { total: 6 }, { rec: { by: 'manager1' } }));
            await assertFails(logged('staff1', coll, 'e', 1, { total: 6 }, { rec: { reason: 'no' } }));
            await assertFails(logged('staff1', coll, 'e', 1, { total: 6 }, { rec: { at: Timestamp.fromMillis(Date.now() - HOUR) } }));
            await assertFails(logged('staff1', coll, 'e', 1, { total: 6 }, { rec: { extra: 1 } }));
            await assertFails(logged('staff1', coll, 'e', 1, { total: 6 }, { rec: { n: 2 } }));
            await assertFails(logged('staff1', coll, 'e', 1, { total: 6 }, { recId: '7' }));
            await assertFails(logged('staff1', coll, 'e', 2, { total: 6 }));
            // the record holds the truth: every changed field, its real before and after
            await assertFails(logged('staff1', coll, 'e', 1, { total: 6, customerName: 'X' }, { rec: { fields: { total: { before: 5, after: 6 } } } }));
            // probe: a falsified before value
            await assertFails(logged('staff1', coll, 'e', 1, { total: 6 }, { rec: { fields: { total: { before: 50, after: 6 } } } }));
            await assertFails(logged('staff1', coll, 'e', 1, { total: 6 }, { rec: { fields: { total: { before: 5, after: 60 } } } }));
            await assertFails(logged('staff1', coll, 'e', 1, { items: [{ name: 'x', qty: 2, total: 10 }] },
                { rec: { fields: { items: { before: [{ name: 'x', qty: 9, total: 45 }], after: [{ name: 'x', qty: 2, total: 10 }] } } } }));
            // probe: an unlogged date change hidden behind a total change
            await assertFails(logged('staff1', coll, 'e', 1, { total: 6, date: '2026-09-01' }, { rec: { fields: { total: { before: 5, after: 6 } } } }));
            // probe: no real change (a notes-only edit gets no record), and no notes in a record
            await assertFails(logged('staff1', coll, 'e', 1, { comments: 'again' }));
            await assertFails(logged('staff1', coll, 'e', 1, { total: 5 }, { rec: { fields: { total: { before: 5, after: 5 } } } }));
            await assertFails(logged('staff1', coll, 'e', 1, { total: 6 }, { rec: { fields: { total: { before: 5, after: 6 }, comments: { before: 'note', after: 'x' } } } }));
            // an older app (clientVersion 3) can't edit
            await assertFails(logged('staff1', coll, 'e', 1, { total: 6 }, { cv: 3 }));
            await assertSucceeds(logged('staff1', coll, 'e', 1, { total: 6, date: '2026-09-01', items: [{ name: 'x', qty: 2, total: 10 }] }));
            await assertSucceeds(logged('manager1', coll, 'e', 2, { total: 7 }));
            await assertSucceeds(logged('legacyOwner', coll, 'e', 3, { total: 8 }));
        }
    });

    t('edit records are append-only: editCount moves only with its record, records never change; approved users read them', async () => {
        await seedBill(purchases, 'e', { userId: 'staff1', total: 5, ...fresh() });
        await assertSucceeds(logged('staff1', purchases, 'e', 1, { total: 6 }));
        const rec = (uid, id = '1') => as(uid).collection(purchases).doc('e').collection('edits').doc(id);
        await assertSucceeds(rec('staff1').get());
        await assertSucceeds(as('manager1').collection(purchases).doc('e').collection('edits').orderBy('n').get());
        await assertFails(rec('pending1').get());
        await assertFails(rec('staff1').update({ reason: 'Other reason' }));
        await assertFails(rec('legacyOwner').update({ reason: 'Other reason' }));
        await assertFails(rec('staff1').set(editRec('staff1', 1, { reason: 'Other reason' })));
        await assertFails(rec('staff1').delete());
        await assertFails(rec('legacyOwner').delete());
        // editCount without its record, or a record without raising editCount, the owner included
        await assertFails(as('legacyOwner').collection(purchases).doc('e').update({ editCount: 2 }));
        await assertFails(as('legacyOwner').collection(purchases).doc('e').update({ editCount: FieldValue.delete() }));
        await assertFails(rec('staff1', '2').set(editRec('staff1', 2)));
        await assertFails(rec('legacyOwner', '2').set(editRec('legacyOwner', 2)));
        // a voided bill gets no more records
        await env.withSecurityRulesDisabled(ctx => ctx.firestore().collection(purchases).doc('e')
            .update({ voided: true, voidReason: 'Entered twice', voidedBy: 'staff1' }));
        await assertFails(logged('legacyOwner', purchases, 'e', 2, { total: 9 }));
        // the owner deletes the bill for good together with its records
        const db = as('legacyOwner');
        const b = db.batch();
        b.delete(db.collection(purchases).doc('e').collection('edits').doc('1'));
        b.delete(db.collection(purchases).doc('e'));
        await assertSucceeds(b.commit());
    });

    t('staff can still record a payment on another user\'s bill', async () => {
        await seedBill(`${prefix}wholesaleSales`, 'w', { userId: 'manager1', total: 100, payment: { cash: 0, due: 100 }, clientVersion: 3 });
        const ref = as('staff1').collection(`${prefix}wholesaleSales`).doc('w');
        // #65: money on a bill moves only with a payments[] entry
        await assertFails(ref.update({ 'payment.cash': 40, 'payment.online': 0, 'payment.due': 60, openDue: true, clientVersion: 3 }));
        await assertSucceeds(ref.update({ 'payment.cash': 40, 'payment.online': 0, 'payment.due': 60,
            payments: [{ amount: 40, cash: 40, online: 0, at: PAID_AT }], openDue: true, clientVersion: 3 }));
    });

    t('item frequency: everyone approved keeps it up to date; only the owner deletes it (#64)', async () => {
        await seedBill(`${prefix}itemFrequency`, 'global', { sale: {} });
        await assertSucceeds(as('staff1').collection(`${prefix}itemFrequency`).doc('global')
            .set({ sale: { i1: { score: FieldValue.increment(1), count: FieldValue.increment(1) } } }, { merge: true }));
        await assertFails(as('staff1').collection(`${prefix}itemFrequency`).doc('global').delete());
        await assertFails(as('manager1').collection(`${prefix}itemFrequency`).doc('global').delete());
        await assertSucceeds(as('legacyOwner').collection(`${prefix}itemFrequency`).doc('global').delete());
    });

    t('item frequency: only merges into global/purchase|sale; no other doc, key or removed item', async () => {
        const ref = (uid, id = 'global') => as(uid).collection(`${prefix}itemFrequency`).doc(id);
        // billing.js updateItemFrequency
        const bump = (mode = 'sale', item = 'i1') => ({ [mode]: { [item]: {
            score: FieldValue.increment(101), count: FieldValue.increment(1), lastUsed: Date.now(), effectiveScore: 101
        } } });
        await assertSucceeds(ref('staff1').set(bump('sale'), { merge: true }));
        await assertSucceeds(ref('legacyStaff').set(bump('purchase', 'i2'), { merge: true }));
        await assertSucceeds(ref('manager1').set(bump('sale', 'i.3/x'), { merge: true }));
        await assertSucceeds(ref('staff1').set(bump('sale'), { merge: true }));
        for (const uid of ['staff1', 'manager1']) {
            await assertFails(ref(uid, uid).set(bump(), { merge: true }));
            await assertFails(ref(uid, 'other').set(bump()));
            // replacing global without merge drops the other items
            await assertFails(ref(uid).set(bump('sale', 'i9')));
            await assertFails(ref(uid).set({ purchase: {}, sale: {} }));
            await assertFails(ref(uid).update({ sale: { i1: { score: 1, count: 1 } } }));
            await assertFails(ref(uid).update({ ['sale.i1']: FieldValue.delete() }));
            await assertFails(ref(uid).update({ purchase: FieldValue.delete() }));
            await assertFails(ref(uid).set({ items: { i1: { score: 1 } } }, { merge: true }));
            await assertFails(ref(uid).set({ sale: 5 }, { merge: true }));
            await assertFails(ref(uid).set({ sale: 'x', ...bump('purchase') }, { merge: true }));
        }
        await assertFails(ref('pending1').set(bump(), { merge: true }));
        // the owner repairs it freely
        await assertSucceeds(ref('legacyOwner').set({ sale: {} }));
        await assertSucceeds(ref('legacyOwner', 'other').set({ x: 1 }));
    });

    t('settings docs other than app and the legacy cashSessions: owner only (#64)', async () => {
        await seedBill(`${prefix}settings`, 'other', { a: 1 });
        await seedBill(`${prefix}cashSessions`, 's1', { userId: 'staff1', openingBalance: 5, signedOut: false });
        for (const uid of ['staff1', 'manager1']) {
            await assertFails(as(uid).collection(`${prefix}settings`).doc('new').set({ a: 1 }));
            await assertFails(as(uid).collection(`${prefix}settings`).doc('other').update({ a: 2 }));
            await assertFails(as(uid).collection(`${prefix}settings`).doc('other').delete());
            await assertFails(as(uid).collection(`${prefix}cashSessions`).doc('s2')
                .set({ openingBalance: 5, signedOut: false, userId: uid, date: '2026-10-22' }));
            await assertFails(as(uid).collection(`${prefix}cashSessions`).doc('s1').update({ duePayments: [{ amount: 1 }] }));
        }
        await assertSucceeds(as('legacyOwner').collection(`${prefix}settings`).doc('other').update({ a: 2 }));
        await assertSucceeds(as('legacyOwner').collection(`${prefix}settings`).doc('other').delete());
        await assertSucceeds(as('legacyOwner').collection(`${prefix}cashSessions`).doc('s1').update({ note: 'x' }));
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
            await assertSucceeds(as('legacyOwner').collection(coll).doc('legacy').set({ total: 6, clientVersion: 4 }));
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
                payment: { online: 0, cash: 40, due: 60, total: 40 }, payments: [{ amount: 40, recordedBy: 'S', at: PAID_AT }],
                dueAmount: 60, openDue: true, clientVersion: 3
            }));
            // #65: clearing without settling the due (money or write-off) is refused
            await assertFails(ref.update({
                cleared: true, openDue: false, clientVersion: 3, clearedAt: 'x', clearedBy: 'staff1', clearedByName: 'S'
            }));
            // outstanding.js markAsCleared: "received in cash" pays the rest and clears in one write
            await assertSucceeds(ref.update({
                payment: { online: 0, cash: 100, due: 0, total: 100 },
                payments: [{ amount: 40, recordedBy: 'S', at: PAID_AT }, { amount: 60, cash: 60, online: 0, settlesDue: true, at: PAID_AT }],
                dueAmount: 0, openDue: false, clientVersion: 3,
                cleared: true, clearedAt: 'x', clearedBy: 'staff1', clearedByName: 'S'
            }));
        }
    });

    t('staff cannot clear a sale by only flipping cleared/openDue; a write-off clears it (wholesale markSaleAsCleared)', async () => {
        const coll = bills[2];
        await seedBill(coll, 'w', otherBill);
        const ref = as('staff1').collection(coll).doc('w');
        await assertFails(ref.set({ ...otherBill, cleared: true, openDue: false }));
        await assertFails(ref.update({ openDue: false, clientVersion: 3 }));
        await assertSucceeds(ref.set({
            ...otherBill, payment: { ...otherBill.payment, due: 0, writtenOff: 100 }, openDue: false,
            payments: [{ id: 'w', kind: 'writeOff', amount: 100, reason: 'gone', at: PAID_AT }],
            cleared: true, clearedAt: 'x', clearedBy: 'staff1', clearedByName: 'S'
        }));
    });

    t('staff legacy backfill: may fill a missing timestamp / id and openDue, never change them', async () => {
        for (const coll of bills) {
            const legacy = { userId: 'manager1', total: 100, date: '01/10/2025', payment: { due: 100 } };
            await seedBill(coll, 'old', legacy);
            const ref = as('staff1').collection(coll).doc('old');
            await assertSucceeds(ref.update({ timestamp: IST_OCT_1, openDue: true, clientVersion: 3 }));
            await assertFails(ref.update({ timestamp: 1, clientVersion: 3 }));
            await seedBill(coll, 'old2', { ...legacy, timestamp: '2026-10-01' });
            await assertSucceeds(as('staff1').collection(coll).doc('old2').update({ timestamp: IST_OCT_1, clientVersion: 3 }));
            await seedBill(coll, 'old3', legacy);
            await assertFails(as('staff1').collection(coll).doc('old3').set({ ...legacy, id: 'old3', cleared: true, openDue: false, clientVersion: 3 }));
            await assertSucceeds(as('staff1').collection(coll).doc('old3').set({ ...legacy, id: 'old3', openDue: true, clientVersion: 3 }));
            await seedBill(coll, 'old4', { ...legacy, id: 'old4' });
            await assertFails(as('staff1').collection(coll).doc('old4').update({ id: 'other', clientVersion: 3 }));
        }
    });

    t('staff bill backfill: the timestamp comes from the bill (its date or old Timestamp), never the future', async () => {
        const old = Date.now() - 40 * DAY;
        for (const coll of bills) {
            const legacy = { userId: 'manager1', total: 100, payment: { due: 100 } };
            const fill = (id, timestamp, extra = {}) => as('staff1').collection(coll).doc(id).update({ timestamp, clientVersion: 3, ...extra });
            await seedBill(coll, 'dmy', { ...legacy, date: '01/10/2025, 7:55:07 pm' });
            await assertFails(fill('dmy', Date.now()));
            await assertFails(fill('dmy', Date.now() + DAY));
            await assertFails(fill('dmy', Date.UTC(2025, 9, 5)));
            await assertFails(fill('dmy', '2025-10-01'));
            await assertSucceeds(fill('dmy', IST_OCT_1 + 19 * HOUR + 55 * MIN, { openDue: true }));
            await seedBill(coll, 'iso', { ...legacy, date: '2025-10-01' });
            await assertFails(fill('iso', Date.UTC(2025, 9, 1) - 2 * DAY));
            await assertSucceeds(fill('iso', Date.UTC(2025, 9, 1)));
            await seedBill(coll, 'ts', { ...legacy, date: '2025-10-01', timestamp: Timestamp.fromMillis(old) });
            await assertFails(fill('ts', old + MIN));
            await assertSucceeds(fill('ts', old));
            await seedBill(coll, 'odd', { ...legacy, date: 'Oct 1 2025' });
            await assertFails(fill('odd', Date.now() + HOUR));
            await assertFails(fill('odd', Number.MAX_SAFE_INTEGER));
            await assertSucceeds(fill('odd', Date.UTC(2025, 9, 1)));
            // the owner corrects bills freely
            await seedBill(coll, 'own', { ...legacy, date: '2025-10-01' });
            await assertFails(as('legacyOwner').collection(coll).doc('own').update({ timestamp: Number.MAX_SAFE_INTEGER, clientVersion: 3 }));
            await assertSucceeds(as('legacyOwner').collection(coll).doc('own').update({ timestamp: Number.MAX_SAFE_INTEGER, clientVersion: 4 }));
        }
    });

    t('creator, manager and owner can fully edit a bill inside the 2-day window', async () => {
        for (const coll of bills) {
            const mine = { ...otherBill, userId: 'staff1', ...fresh() };
            await seedBill(coll, 'b', mine);
            await assertSucceeds(logged('staff1', coll, 'b', 1, { ...mine, total: 7, items: [], payment: { online: 0, cash: 7, due: 0, total: 7 } }, { set: true }));
            // #121: a non-owner's change to the total or items needs its edit record
            await assertFails(as('manager1').collection(coll).doc('b').update({ total: 8, 'payment.cash': 8, timestamp: 1, clientVersion: 3 }));
            await assertSucceeds(logged('manager1', coll, 'b', 2, { total: 8, 'payment.cash': 8, timestamp: 1, clientVersion: 3 }));
            await assertFails(as('legacyOwner').collection(coll).doc('b').update({ items: [{ name: 'x' }], clientVersion: 3 }));
            await assertSucceeds(as('legacyOwner').collection(coll).doc('b').update({ items: [{ name: 'x' }], clientVersion: 4 }));
        }
    });

    // ---- 2-day edit window for non-owners (#87) ----

    t('edit window: creator may edit and void own bill saved 47 hours ago', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'b', { ...otherBill, userId: 'staff1', createdAt: savedAgo(47 * HOUR) });
            await assertSucceeds(logged('staff1', coll, 'b', 1, { total: 109, clientVersion: 3 }));
            await assertFails(as('staff1').collection(coll).doc('b').delete());
            await assertSucceeds(as('staff1').collection(coll).doc('b').update(voidFields('staff1')));
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
            await assertSucceeds(ref('legacyOwner').update({ total: 9, clientVersion: 4 }));
            await assertSucceeds(ref('legacyOwner').delete());
        }
    });

    t('edit window: payments can still be recorded on an old bill', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'old', { ...otherBill, userId: 'staff1', dueAmount: 100, createdAt: savedAgo(30 * DAY) });
            await assertSucceeds(as('staff1').collection(coll).doc('old').update({
                payment: { online: 0, cash: 40, due: 60, total: 40 }, payments: [{ amount: 40, recordedBy: 'S', at: PAID_AT }],
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
            await assertSucceeds(as('legacyOwner').collection(coll).doc('legacy').update({ total: 9, clientVersion: 4 }));
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

    // ---- per-role edit days from settings/app.roleAccess (#84), counted from createdAt ----

    const setRoleAccess = (roleAccess) => env.withSecurityRulesDisabled(ctx =>
        ctx.firestore().collection(`${prefix}settings`).doc('app').set({ roleAccess }, { merge: true }));
    const mineSaved = (ms, extra = {}) => ({ ...otherBill, userId: 'staff1', createdAt: savedAgo(ms), ...extra });

    t('edit window: days come from settings/app.roleAccess per role; bad values fall back to 2', async () => {
        const coll = purchases;
        await setRoleAccess({ staff: { editDays: 0 }, manager: { editDays: 10 } });
        await seedBill(coll, 'hour', mineSaved(HOUR));
        await seedBill(coll, 'five', mineSaved(5 * DAY));
        await assertFails(logged('staff1', coll, 'hour', 1, { total: 109, clientVersion: 3 }));
        await assertFails(as('staff1').collection(coll).doc('hour').update(voidFields('staff1')));
        await assertSucceeds(logged('manager1', coll, 'five', 1, { total: 109, clientVersion: 3 }));
        await setRoleAccess({ staff: { editDays: 7 }, manager: { editDays: 'x' } });
        await assertSucceeds(logged('staff1', coll, 'five', 2, { total: 110, clientVersion: 3 }));
        await assertFails(logged('manager1', coll, 'five', 3, { total: 111, clientVersion: 3 }));
        await setRoleAccess({ staff: { editDays: 99 } });
        await assertFails(logged('staff1', coll, 'five', 3, { total: 112, clientVersion: 3 }));
        await setRoleAccess({ staff: { editDays: 7 } });
        await assertSucceeds(as('staff1').collection(coll).doc('five').update(voidFields('staff1')));
    });

    t('edit window: per-role days still refuse made-up and old-app clocks', async () => {
        await setRoleAccess({ staff: { editDays: 30 }, manager: { editDays: 30 } });
        for (const coll of bills) {
            const db = as('staff1').collection(coll);
            // made-up createdAt on create is refused; a future client timestamp opens nothing
            await assertFails(db.doc('n3').set({ userId: 'staff1', total: 5, clientVersion: 3, createdAt: Timestamp.fromMillis(Date.now() + 30 * DAY) }));
            await assertSucceeds(db.doc('n4').set({ userId: 'staff1', total: 5, clientVersion: 3, timestamp: Date.now() + 365 * DAY }));
            await assertFails(db.doc('n4').update({ total: 6, clientVersion: 3 }));
            await assertFails(db.doc('n4').delete());
            // old-app bill (no createdAt) stays owner-only, even with a fresh timestamp
            await seedBill(coll, 'legacy', { ...otherBill, userId: 'staff1', timestamp: Date.now() });
            await assertFails(db.doc('legacy').update({ total: 9, clientVersion: 3 }));
            await assertFails(as('manager1').collection(coll).doc('legacy').update({ total: 9, clientVersion: 3 }));
            await assertSucceeds(as('legacyOwner').collection(coll).doc('legacy').delete());
        }
    });

    t('edit window: legacy backfill of timestamp or createdAt never unlocks an owner-only bill', async () => {
        for (const coll of bills) {
            const legacy = { userId: 'staff1', total: 100, date: '01/10/2025', payment: { due: 100 }, items: [] };
            await seedBill(coll, 'old', legacy);
            const ref = as('staff1').collection(coll).doc('old');
            await assertSucceeds(ref.update({ timestamp: IST_OCT_1 + HOUR, openDue: true, clientVersion: 3 }));
            await assertFails(ref.update({ total: 9, clientVersion: 3 }));
            await assertFails(ref.delete());
            await assertFails(ref.update({ createdAt: serverTimestamp(), clientVersion: 3 }));
            await assertFails(ref.update({ createdAt: Timestamp.fromMillis(Date.now()), total: 9, clientVersion: 3 }));
            await assertFails(ref.set({ ...legacy, createdAt: serverTimestamp(), clientVersion: 3 }));
            await assertFails(as('manager1').collection(coll).doc('old').update({ createdAt: serverTimestamp(), clientVersion: 3 }));
        }
    });

    t('roles & access (settings/app.roleAccess): only the owner writes it; everyone approved reads it', async () => {
        const roleAccess = { staff: { finance: true, editDays: 5 }, manager: { editDays: 30 } };
        await assertFails(as('staff1').collection(`${prefix}settings`).doc('app').set({ roleAccess }, { merge: true }));
        await assertFails(as('manager1').collection(`${prefix}settings`).doc('app').set({ roleAccess }, { merge: true }));
        await assertSucceeds(as('legacyOwner').collection(`${prefix}settings`).doc('app').set({ roleAccess }, { merge: true }));
        await assertSucceeds(as('staff1').collection(`${prefix}settings`).doc('app').get());
        await assertFails(as('pending1').collection(`${prefix}settings`).doc('app').get());
    });

    // ---- Settings › Aadhat: manager edits only when Roles & access allows it, only shop fields ----

    t('settings/app shop fields: manager only with roleAccess.manager.shopSettings; never roleAccess or version', async () => {
        const app = (uid) => as(uid).collection(`${prefix}settings`).doc('app');
        const seedApp = (shopSettings) => env.withSecurityRulesDisabled((ctx) => ctx.firestore().collection(`${prefix}settings`).doc('app')
            .set({ minClientVersion: 3, laborRate: 6, roleAccess: { manager: { shopSettings }, staff: {} } }));
        await seedApp(false);
        await assertFails(app('manager1').set({ laborRate: 8, labourUpdatedAt: 1, labourUpdatedBy: 'manager1' }, { merge: true }));
        await assertFails(app('manager1').set({ labourPackageKg: 40 }, { merge: true }));
        await assertFails(app('manager1').set({ businessName: 'Aadhat', businessDetails: 'Main road' }, { merge: true }));
        await seedApp(true);
        await assertSucceeds(app('manager1').set({ laborRate: 8, labourUpdatedAt: 1, labourUpdatedBy: 'manager1' }, { merge: true }));
        await assertSucceeds(app('manager1').set({ labourPackageKg: 40, labourUpdatedAt: 2, labourUpdatedBy: 'manager1' }, { merge: true }));
        await assertSucceeds(app('manager1').set({ checkThresholds: { cashOkRs: 50 }, checksUpdatedAt: 1 }, { merge: true }));
        await assertSucceeds(app('manager1').set({ businessName: 'Aadhat', businessDetails: 'Main road', businessUpdatedAt: 1 }, { merge: true }));
        await assertFails(app('manager1').set({ roleAccess: { manager: { shopSettings: true, finance: true } } }, { merge: true }));
        await assertFails(app('manager1').set({ minClientVersion: 99 }, { merge: true }));
        await assertFails(app('manager1').set({ laborRate: 9, tipPolicies: {} }, { merge: true }));
        await assertFails(app('manager1').delete());
        await assertFails(app('staff1').set({ laborRate: 9 }, { merge: true }));
        await assertFails(app('staff1').set({ labourPackageKg: 40 }, { merge: true }));
        await assertSucceeds(app('legacyOwner').set({ businessName: 'Owner set' }, { merge: true }));
    });

    t('settings/app: a manager cannot create it even when allowed elsewhere', async () => {
        await assertFails(as('manager1').collection(`${prefix}settings`).doc('app').set({ laborRate: 8 }));
    });

    // ---- settings/app (minClientVersion): owner only ----

    t('only the owner can write settings/app or other settings docs (#64)', async () => {
        const settings = as('staff1').collection(`${prefix}settings`);
        await assertFails(settings.doc('app').set({ minClientVersion: 99 }));
        await assertFails(as('manager1').collection(`${prefix}settings`).doc('app').set({ minClientVersion: 99 }));
        await assertSucceeds(as('legacyOwner').collection(`${prefix}settings`).doc('app').set({ minClientVersion: 3 }));
        await assertSucceeds(settings.doc('app').get());
        await assertFails(settings.doc('app').update({ minClientVersion: 99 }));
        await assertFails(settings.doc('app').delete());
        await assertFails(settings.doc('other').set({ a: 1 }));
        await assertSucceeds(as('legacyOwner').collection(`${prefix}settings`).doc('other').set({ a: 1 }));
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
        await assertSucceeds(as('manager1').collection(checkpoints).doc('current').set({ asOf: 5, state: [], stale: false, ...V4() }));
        await assertSucceeds(as('legacyOwner').collection(checkpoints).doc('current').set({ rebuildingUntil: 9, rebuildingBy: 'x', ...V4() }, { merge: true }));
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

    t('stock checkpoint: no doc ids but current and legacyScan, for anyone', async () => {
        for (const uid of ['staff1', 'manager1', 'legacyOwner']) {
            await assertFails(as(uid).collection(checkpoints).doc('other').set({ asOf: 1, state: [] }));
            await assertFails(as(uid).collection(checkpoints).doc('current2').set({ stale: true, staleCount: 1 }, { merge: true }));
        }
        await env.withSecurityRulesDisabled(ctx => ctx.firestore().collection(checkpoints).doc('junk').set({ stale: false }));
        await assertFails(as('staff1').collection(checkpoints).doc('junk').set({ stale: true }, { merge: true }));
        await assertFails(as('legacyOwner').collection(checkpoints).doc('junk').update({ asOf: 2 }));
        await assertFails(as('staff1').collection(checkpoints).doc('junk').delete());
        await assertSucceeds(as('manager1').collection(checkpoints).doc('junk').delete());
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
        await assertSucceeds(logged('staff1', `${prefix}purchases`, 'legacyApp2', 1, { total: 2 }));
    });

    t('stock records need clientVersion >= 3 once the gate is on (blocks outdated apps)', async () => {
        await setClientGate(true);
        const db = as('staff1');
        for (const c of ['purchases', 'retailSales', 'wholesaleSales', 'stockAdjustments']) {
            // stock adjustments are recorded by owners/managers (#64)
            const coll = (c === 'stockAdjustments' ? as('manager1') : db).collection(`${prefix}${c}`);
            const valid = c === 'stockAdjustments'
                ? { itemId: 'i1', adjustType: 'add', quantity: 1, userId: 'manager1' }
                : { total: 1 };
            await assertFails(coll.doc('old1').set({ ...valid }));
            await assertFails(coll.doc('old2').set({ ...valid, clientVersion: 2 }));
            await assertSucceeds(coll.doc('new1').set({ ...valid, clientVersion: 3 }));
        }
        // Expenses etc. are not restricted by the gate.
        await assertSucceeds(db.collection(`${prefix}expenses`).doc('e1').set({ amount: 1, userId: 'staff1', timestamp: Date.now() }));
    });

    t('payment updates on current bills pass; overwriting with an old-app full set() fails; only the owner deletes', async () => {
        await setClientGate(true);
        const coll = as('staff1').collection(purchases);
        await assertSucceeds(coll.doc('pay1').set({ total: 100, payment: { due: 100 }, userId: 'staff1', clientVersion: 3, createdAt: serverTimestamp() }));
        await assertSucceeds(coll.doc('pay1').update({ payment: { due: 0, cash: 100, online: 0 }, payments: [{ amount: 100, cash: 100, online: 0, at: PAID_AT }], openDue: false, clientVersion: 3 }));
        await assertSucceeds(coll.doc('pay1').update({ cleared: true, openDue: false }));
        await assertFails(coll.doc('pay1').set({ total: 100, payment: { due: 0 } }));
        await assertFails(coll.doc('pay1').delete());
        await assertSucceeds(as('legacyOwner').collection(purchases).doc('pay1').delete());
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

    t('members cannot list users or read other profiles; owner and manager can (#57)', async () => {
        await assertFails(as('staff1').collection(users).orderBy('createdAt', 'desc').get());
        await assertFails(as('staff1').collection(users).doc('manager1').get());
        await assertSucceeds(as('staff1').collection(users).doc('staff1').get());
        await assertSucceeds(as('manager1').collection(users).get());
        await assertSucceeds(as('legacyOwner').collection(users).doc('staff1').get());
    });

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

    // AadhatManagementApp#74: no self-removal, and two owners can't remove each other.
    t('owner cannot change own role or status', async () => {
        await assertFails(as('owner2').collection(users).doc('owner2').update({ role: 'manager' }));
        await assertFails(as('owner2').collection(users).doc('owner2').update({ status: 'disabled' }));
        await assertFails(as('legacyOwner').collection(users).doc('legacyOwner').update({ role: FieldValue.delete(), status: 'disabled' }));
        await assertSucceeds(as('owner2').collection(users).doc('owner2').update({ name: 'Renamed', lastLogin: new Date() }));
    });

    t('owner cannot remove, demote or delete another owner', async () => {
        await assertFails(as('legacyOwner').collection(users).doc('owner2').update({
            role: FieldValue.delete(), rentRole: FieldValue.delete(), status: 'disabled', disabledBy: 'legacyOwner'
        }));
        await assertFails(as('owner2').collection(users).doc('legacyOwner').update({ role: 'manager' }));
        await assertFails(as('owner2').collection(users).doc('legacyOwner').delete());
        await assertFails(as('legacyOwner').collection(users).doc('legacyOwner').delete());
        await assertSucceeds(as('owner2').collection(users).doc('legacyOwner').update({ name: 'Renamed' }));
    });

    t('owner can still remove a non-owner (disabled profile)', () =>
        assertSucceeds(as('legacyOwner').collection(users).doc('manager1').update({
            role: FieldValue.delete(), rentRole: FieldValue.delete(), approvedAt: FieldValue.delete(), approvedBy: FieldValue.delete(),
            status: 'disabled', disabledAt: new Date(), disabledBy: 'legacyOwner'
        })));

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

    t('rateHistory: accepts Excel-import entries and list positions 0-20; rejects other sources and bad positions', async () => {
        await assertSucceeds(as('manager1').collection(rateHistory).doc('i1_imp').set(entry('manager1', { source: 'import', index: 0 })));
        await assertSucceeds(as('legacyOwner').collection(rateHistory).doc('i1_inl').set(entry('legacyOwner', { source: 'inline', index: 20 })));
        await assertSucceeds(as('manager1').collection(rateHistory).doc('i1_old').set(entry('manager1')));
        await assertFails(as('manager1').collection(rateHistory).doc('e').set(entry('manager1', { source: 'script' })));
        await assertFails(as('manager1').collection(rateHistory).doc('f').set(entry('manager1', { index: 21 })));
        await assertFails(as('manager1').collection(rateHistory).doc('g').set(entry('manager1', { index: -1 })));
        await assertFails(as('manager1').collection(rateHistory).doc('h').set(entry('manager1', { index: 1.5 })));
        await assertFails(as('manager1').collection(rateHistory).doc('i').set(entry('manager1', { index: '0' })));
        await assertFails(as('staff1').collection(rateHistory).doc('j').set(entry('staff1', { source: 'import', index: 0 })));
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
    const empty = sec({ kg: 0, amount: 0, min: null, max: null, avg: 0, bills: 0 });
    const bucket = () => ({ purchase: sec(), retail: empty, wholesale: sec({ avg: 27.5, amount: 2750 }), bills: 4 });
    const stat = (extra = {}) => ({
        itemId: 'wheat', year: '2026',
        weeks: { 'w2026-10-19': bucket(), 'w2026-10-26': bucket() },
        months: { 'm2026-10': bucket() },
        updatedAt: 1700000000000, ...V4(), ...extra
    });
    const manyWeeks = () => Object.fromEntries(Array.from({ length: 55 }, (_, i) => [`w2026-x${i}`, bucket()]));

    t('rateStats: owner and manager can write item-year docs and the backfill status, and read them', async () => {
        await assertSucceeds(as('manager1').collection(rateStats).doc('wheat_2026').set(stat()));
        await assertSucceeds(as('legacyOwner').collection(rateStats).doc('wheat_2026').set(stat({ weeks: {} })));
        await assertSucceeds(as('legacyOwner').collection(rateStats).doc('_meta').set(
            { backfillDone: true, backfillAt: 1, bills: 1200, reads: 1210, months: 36, by: 'O', byUserId: 'legacyOwner', ...V4() }, { merge: true }));
        await assertSucceeds(as('manager1').collection(rateStats).doc('wheat_2026').get());
        await assertSucceeds(as('manager1').collection(rateStats).where('year', '>=', '2025').get());
        await assertSucceeds(as('manager1').collection(rateStats).where('year', '==', '2026').limit(300).get());
        await assertSucceeds(as('manager1').collection(rateStats).doc('_meta').get());
    });

    t('rateStats: other users cannot read or write; pending users neither', async () => {
        await env.withSecurityRulesDisabled((ctx) => ctx.firestore().collection(rateStats).doc('wheat_2026').set(stat()));
        await assertFails(as('staff1').collection(rateStats).doc('wheat_2026').get());
        await assertFails(as('staff1').collection(rateStats).get());
        await assertFails(as('staff1').collection(rateStats).doc('wheat_2027').set(stat({ year: '2027' })));
        await assertFails(as('staff1').collection(rateStats).doc('_meta').set({ backfillDone: true }));
        await assertFails(as('pending1').collection(rateStats).doc('wheat_2026').get());
        await assertFails(anon().collection(rateStats).doc('wheat_2026').get());
    });

    t('rateStats: rejects wrong id, bad year, the old monthly layout, unknown fields and oversized maps; only an owner deletes', async () => {
        await assertFails(as('manager1').collection(rateStats).doc('rice_2026').set(stat()));
        await assertFails(as('manager1').collection(rateStats).doc('wheat_26').set(stat({ year: '26' })));
        await assertFails(as('manager1').collection(rateStats).doc('wheat_2026').set(stat({ year: 2026 })));
        await assertFails(as('manager1').collection(rateStats).doc('wheat_2026-10').set({ itemId: 'wheat', month: '2026-10', purchase: sec(), bills: 1 }));
        await assertFails(as('manager1').collection(rateStats).doc('wheat_2026').set(stat({ extra: 1 })));
        await assertFails(as('manager1').collection(rateStats).doc('wheat_2026').set(stat({ weeks: 'lots' })));
        await assertFails(as('manager1').collection(rateStats).doc('wheat_2026').set(stat({ weeks: manyWeeks() })));
        const { months: _m, ...noMonths } = stat();
        await assertFails(as('manager1').collection(rateStats).doc('wheat_2026').set(noMonths));
        await assertFails(as('manager1').collection(rateStats).doc('_meta').set({ backfillDone: true, secret: 1 }));
        await env.withSecurityRulesDisabled((ctx) => ctx.firestore().collection(rateStats).doc('wheat_2026').set(stat()));
        await assertFails(as('manager1').collection(rateStats).doc('wheat_2026').delete());
        await assertSucceeds(as('legacyOwner').collection(rateStats).doc('wheat_2026').delete());
    });

    // ---- month snapshots (redesign §7.6): monthStats/{YYYY-MM}, owner/manager only ----

    const monthStats = `${prefix}monthStats`;
    const snap = (extra = {}) => ({
        month: '2026-10', v: 2,
        m: { M1: 1000, M1c: 3, M2: 800, M6: 150, close: 5000 },
        items: { wheat: { s: 1000, c: 800, q: 40, r: 1000, w: 0 } },
        customers: [{ k: 'ram', n: 'Ram', t: 1000, c: 3 }], suppliers: [],
        categories: { rent: 50 }, days: { 1: { s: 1000, p: 150 } }, builtAt: 1700000000000, ...V4(), ...extra
    });

    t('monthStats: owner and manager can write and read month snapshots', async () => {
        await assertSucceeds(as('manager1').collection(monthStats).doc('2026-10').set(snap()));
        await assertSucceeds(as('legacyOwner').collection(monthStats).doc('2026-10').set(snap({ stale: true })));
        await assertSucceeds(as('manager1').collection(monthStats).doc('2026-10').get());
        await assertSucceeds(as('manager1').collection(monthStats).orderBy(firebase.firestore.FieldPath.documentId()).startAt('2025-01').limit(40).get());
    });

    t('monthStats: members, pending users and strangers cannot read or write', async () => {
        await env.withSecurityRulesDisabled((ctx) => ctx.firestore().collection(monthStats).doc('2026-10').set(snap()));
        await assertFails(as('staff1').collection(monthStats).doc('2026-10').get());
        await assertFails(as('staff1').collection(monthStats).doc('2026-11').set(snap({ month: '2026-11' })));
        await assertFails(as('pending1').collection(monthStats).doc('2026-10').get());
        await assertFails(anon().collection(monthStats).doc('2026-10').get());
    });

    t('monthStats: rejects a wrong id, a month that does not match it, unknown fields and a missing figures map; only an owner deletes', async () => {
        await assertFails(as('manager1').collection(monthStats).doc('2026-1').set(snap({ month: '2026-1' })));
        await assertFails(as('manager1').collection(monthStats).doc('2026-11').set(snap()));
        await assertFails(as('manager1').collection(monthStats).doc('2026-10').set(snap({ extra: 1 })));
        await assertFails(as('manager1').collection(monthStats).doc('2026-10').set(snap({ v: '1' })));
        const { m: _m, ...noFigures } = snap();
        await assertFails(as('manager1').collection(monthStats).doc('2026-10').set(noFigures));
        await env.withSecurityRulesDisabled((ctx) => ctx.firestore().collection(monthStats).doc('2026-10').set(snap()));
        await assertFails(as('manager1').collection(monthStats).doc('2026-10').delete());
        await assertSucceeds(as('legacyOwner').collection(monthStats).doc('2026-10').delete());
    });

    // firestore-service.js noteMonthWrite: a merge of { month, stale: true, staleAt }.
    const mark = (month = '2026-10', extra = {}) => ({ month, stale: true, staleAt: 1760000000000, ...extra });

    t('monthStats: any approved user marks a month stale (merge); a missing month gets a stub', async () => {
        await env.withSecurityRulesDisabled((ctx) => ctx.firestore().collection(monthStats).doc('2026-10').set(snap()));
        for (const uid of ['staff1', 'legacyStaff', 'manager1', 'legacyOwner']) {
            await assertSucceeds(as(uid).collection(monthStats).doc('2026-10').set(mark('2026-10', { staleAt: Date.now() }), { merge: true }));
        }
        await assertSucceeds(as('staff1').collection(monthStats).doc('2026-03').set(mark('2026-03'), { merge: true }));
        await env.withSecurityRulesDisabled(async (ctx) => {
            const kept = (await ctx.firestore().collection(monthStats).doc('2026-10').get()).data();
            if (!kept.stale || kept.m.M1 !== 1000 || kept.v !== 2) throw new Error('stale mark changed the snapshot');
            const stub = (await ctx.firestore().collection(monthStats).doc('2026-03').get()).data();
            if (JSON.stringify(Object.keys(stub).sort()) !== '["month","stale","staleAt"]') throw new Error(`stub: ${JSON.stringify(stub)}`);
        });
        // A batch with a back-dated bill, as one device's writes.
        const db = as('staff1');
        const batch = db.batch();
        batch.set(db.collection(`${prefix}purchases`).doc('late'), { userId: 'staff1', total: 10, clientVersion: 3 });
        batch.set(db.collection(monthStats).doc('2026-04'), mark('2026-04'), { merge: true });
        await assertSucceeds(batch.commit());
    });

    t('monthStats: only real months (01-12) as ids, for snapshots and stale marks', async () => {
        for (const id of ['2025-13', '2025-99', '2026-00', '0000-00']) {
            await assertFails(as('staff1').collection(monthStats).doc(id).set(mark(id), { merge: true }));
            await assertFails(as('manager1').collection(monthStats).doc(id).set(snap({ month: id })));
        }
        for (const id of ['2026-01', '2026-09', '2026-12']) {
            await assertSucceeds(as('staff1').collection(monthStats).doc(id).set(mark(id), { merge: true }));
            await assertSucceeds(as('manager1').collection(monthStats).doc(id).set(snap({ month: id })));
        }
    });

    t('monthStats: a stale mark changes nothing else and needs an approved user', async () => {
        await env.withSecurityRulesDisabled((ctx) => ctx.firestore().collection(monthStats).doc('2026-10').set(snap()));
        const ref = (uid, id = '2026-10') => as(uid).collection(monthStats).doc(id);
        await assertFails(ref('staff1').set(mark('2026-10', { m: { M1: 1 } }), { merge: true }));
        await assertFails(ref('staff1').set(mark('2026-10', { builtAt: 1 }), { merge: true }));
        await assertFails(ref('staff1').set(mark('2026-10', { stale: false }), { merge: true }));
        await assertFails(ref('staff1').set(mark('2026-10', { staleAt: 'now' }), { merge: true }));
        await assertFails(ref('staff1').set(mark('2026-10', { month: '2026-09' }), { merge: true }));
        await assertFails(ref('staff1').set(mark('2026-10')));
        await assertFails(ref('staff1', '2026-02').set(mark('2026-02', { extra: 1 }), { merge: true }));
        await assertFails(ref('staff1', '2026-2').set(mark('2026-2'), { merge: true }));
        await assertFails(ref('staff1', '2026-02').set({ month: '2026-02', stale: true }, { merge: true }));
        await assertFails(ref('pending1').set(mark(), { merge: true }));
        await assertFails(ref('rejected1').set(mark(), { merge: true }));
        await assertFails(anon().collection(monthStats).doc('2026-10').set(mark(), { merge: true }));
        await assertFails(ref('staff1').get());
    });

    t('monthStats: an owner or manager rebuild replaces a stale mark (and may carry staleAt)', async () => {
        await env.withSecurityRulesDisabled((ctx) => ctx.firestore().collection(monthStats).doc('2026-10').set(mark()));
        await assertFails(as('staff1').collection(monthStats).doc('2026-10').set(snap()));
        await assertSucceeds(as('manager1').collection(monthStats).doc('2026-10').set(snap()));
        await assertSucceeds(as('manager1').collection(monthStats).doc('2026-10').set(snap({ stale: true, staleAt: 1 })));
        await assertSucceeds(as('legacyOwner').collection(monthStats).doc('2026-10').set(snap()));
        await env.withSecurityRulesDisabled(async (ctx) => {
            const d = (await ctx.firestore().collection(monthStats).doc('2026-10').get()).data();
            if (d.stale !== undefined) throw new Error('rebuild kept the stale mark');
        });
    });

    t('older apps (clientVersion 3, e.g. rc1) can\'t write figures built from bills: checkpoint, lease, month snapshots, rate stats (#75)', async () => {
        const cp = as('manager1').collection(checkpoints).doc('current');
        await assertFails(cp.set({ asOf: 5, state: [], stale: false }));
        await assertFails(cp.set({ asOf: 5, state: [], stale: false, ...V4(3) }));
        await assertFails(cp.set({ asOf: 5, state: [], stale: false, clientVersion: 4, writtenAt: Timestamp.fromMillis(1) }));
        await assertSucceeds(cp.set({ asOf: 5, state: [], stale: false, ...V4() }));
        // a merge (the rebuild lease) can't ride on the version a newer app stored
        await assertFails(cp.set({ rebuildingUntil: 9, rebuildingBy: 'old' }, { merge: true }));
        await assertFails(as('legacyOwner').collection(checkpoints).doc('current').update({ rebuildingUntil: 0, rebuildingBy: null }));
        await assertSucceeds(cp.set({ rebuildingUntil: 9, rebuildingBy: 'new', ...V4() }, { merge: true }));
        // anyone may still mark it stale (an older app's mark only makes newer apps rebuild)
        await assertSucceeds(as('staff1').collection(checkpoints).doc('current').set({ stale: true, staleCount: 7 }, { merge: true }));
        const ms = (uid) => as(uid).collection(monthStats).doc('2026-09');
        await assertFails(ms('manager1').set(snap({ month: '2026-09', ...V4(3) })));
        const { clientVersion: _c, writtenAt: _w, ...unstamped } = snap({ month: '2026-09' });
        await assertFails(ms('legacyOwner').set(unstamped));
        await assertSucceeds(ms('manager1').set(snap({ month: '2026-09' })));
        await assertSucceeds(ms('staff1').set(mark('2026-09', { staleAt: Date.now() }), { merge: true }));
        const rs = as('manager1').collection(rateStats);
        await assertFails(rs.doc('wheat_2026').set(stat(V4(3))));
        await assertFails(rs.doc('_meta').set({ backfillDone: true }, { merge: true }));
        await assertSucceeds(rs.doc('_meta').set({ backfillDone: true, ...V4() }, { merge: true }));
        await assertFails(rs.doc('_meta').set({ backfillDone: false }, { merge: true }));
    });

    t('older apps can\'t edit bills, the owner\'s included; they still record payments (#75)', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'o', { userId: 'staff1', total: 100, payment: { cash: 0, online: 0, due: 100 }, dueAmount: 100, clientVersion: 3, ...fresh() });
            const ref = (uid) => as(uid).collection(coll).doc('o');
            await assertFails(ref('legacyOwner').update({ total: 90, clientVersion: 3 }));
            await assertFails(ref('legacyOwner').set({ userId: 'staff1', total: 90, clientVersion: 3, ...fresh() }));
            await assertSucceeds(ref('legacyOwner').update({ comments: 'old app note' }));
            await assertSucceeds(ref('staff1').update({ 'payment.cash': 40, 'payment.online': 0, 'payment.due': 60, dueAmount: 60,
                payments: [{ amount: 40, cash: 40, online: 0, at: PAID_AT }], openDue: true, clientVersion: 3 }));
            await assertSucceeds(ref('legacyOwner').update({ total: 90, clientVersion: 4 }));
        }
    });

    // Documents written by tools/migrate (#15), as its plan builds them from the synthetic backup.
    const migrated = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', 'migrate', 'migrated-docs.json'), 'utf8')).docs;
    const migratedDoc = (coll, id) => migrated.find(d => d.coll === coll && d.id === id).data;

    t('migration (#15): carried rate stats and _meta pass the rules; the app can roll them forward', async () => {
        const doc = migratedDoc('rateStats', 'item-rice_2026');
        const meta = migratedDoc('rateStats', '_meta');
        await assertSucceeds(as('manager1').collection(rateStats).doc('item-rice_2026').set({ ...doc, ...V4() }));
        await assertSucceeds(as('legacyOwner').collection(rateStats).doc('_meta').set({ ...meta, ...V4() }));
        await assertSucceeds(as('manager1').collection(rateStats).doc('item-rice_2026').set({ ...doc, weeks: { ...doc.weeks, 'w2026-10-26': bucket() }, updatedAt: 1800000000000, ...V4() }));
        await assertSucceeds(as('manager1').collection(rateStats).doc('_meta').set({ startedAt: 1, ...V4() }, { merge: true }));
    });

    t('migration (#15): a member records a payment on a carried opening record', async () => {
        const col = `${prefix}retailSales`;
        const rec = migratedDoc('retailSales', 'opening-retail-r4');
        await env.withSecurityRulesDisabled((ctx) => ctx.firestore().collection(col).doc('opening-retail-r4').set(rec));
        const due = rec.payment.due;
        await assertSucceeds(as('staff1').collection(col).doc('opening-retail-r4').update({
            payment: { ...rec.payment, cash: 100, due: due - 100, total: 100 },
            payments: [{ id: 'm1', amount: 100, cash: 100, online: 0, at: PAID_AT }],
            dueAmount: due - 100, openDue: true, clientVersion: 3
        }));
        await assertFails(as('staff1').collection(col).doc('opening-retail-r4').update({ dueAmount: due + 1, payment: { ...rec.payment, due: due + 1 } }));
    });
    // ---- bill payment edits (#19) ----

    const dueBill = { userId: 'manager1', total: 100, items: [{ name: 'Rice', qty: 10 }], timestamp: 1760000000000,
        payment: { online: 0, cash: 0, due: 100, total: 0 }, dueAmount: 100, payments: [{ id: 'p0', amount: 0 }],
        openDue: true, clientVersion: 3 };
    // What outstanding.js applyPaymentTransaction writes for a cash payment.
    // Payment entries carry their time within 10 minutes of the server's (#65)
    const PAID_AT = Date.now();
    const paid = (cash, extra = {}) => ({
        payment: { online: 0, cash, due: 100 - cash, total: cash },
        payments: [...dueBill.payments, { id: 'p1', amount: cash, cash, online: 0, at: PAID_AT }],
        dueAmount: 100 - cash, openDue: 100 - cash > 0, clientVersion: 3, ...extra
    });

    t('payment edits: a member records a payment and a write-off on another user\'s bill', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'b', dueBill);
            const ref = as('staff1').collection(coll).doc('b');
            await assertSucceeds(ref.update(paid(40, { paidAt: PAID_AT })));
            // applyWriteOffTransaction: due to 0, writtenOff raised, one payments[] entry
            await assertSucceeds(ref.update({
                payment: { online: 0, cash: 40, due: 0, total: 40, writtenOff: 60 }, dueAmount: 0, openDue: false,
                payments: [...paid(40).payments, { id: 'w', kind: 'writeOff', amount: 60, reason: 'gone', at: PAID_AT + 60000 }],
                cleared: true, clearedAt: 'x', clearedBy: 'staff1', clearedByName: 'S', clientVersion: 3, paidAt: PAID_AT + 60000
            }));
        }
    });

    t('payment edits: paidAt (#163) is a time in ms, written with a new payments[] entry', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'b', dueBill);
            const ref = as('staff1').collection(coll).doc('b');
            await assertFails(ref.update(paid(40, { paidAt: '2026-10-05' })));
            await assertFails(ref.update({ paidAt: 1760000100000, clientVersion: 3 }));
            await assertSucceeds(ref.update(paid(40)));
        }
    });

    t('payment edits: paidAt equals the new payments[] entry\'s time; an entry without its time is refused', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'b', dueBill);
            const ref = as('staff1').collection(coll).doc('b');
            await assertFails(ref.update(paid(40, { paidAt: PAID_AT + 1 })));
            await assertFails(ref.update(paid(40, { paidAt: 9999999999999 })));
            await assertFails(ref.update(paid(40, { paidAt: 1 })));
            const noAt = paid(40);
            delete noAt.payments[noAt.payments.length - 1].at;
            await assertFails(ref.update({ ...noAt, paidAt: PAID_AT }));
            await assertFails(ref.update(noAt));
            await assertSucceeds(ref.update(paid(40)));
            // Write-off on top: its entry's `at` again.
            const writeOff = (at, paidAt) => ({
                payment: { online: 0, cash: 40, due: 0, total: 40, writtenOff: 60 }, dueAmount: 0, openDue: false,
                payments: [...paid(40).payments, { id: 'w', kind: 'writeOff', amount: 60, reason: 'gone', at }],
                cleared: true, clearedAt: 'x', clearedBy: 'staff1', clearedByName: 'S', clientVersion: 3, paidAt
            });
            await assertFails(ref.update(writeOff(PAID_AT + 60000, PAID_AT + 60001)));
            await assertSucceeds(ref.update(writeOff(PAID_AT + 60000, PAID_AT + 60000)));
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
                payment: { online: 0, cash: 40, due: 60, total: 40 }, payments: [{ id: 'p1', amount: 40, at: PAID_AT }],
                dueAmount: 60, openDue: true, clientVersion: 3
            }));
        }
    });

    // ---- money moves only with the due; never more than the bill total (#65) ----

    t('payment edits (#65): partial payments, a payment of the due + 1 paisa, then nothing more', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'b', dueBill);
            const ref = as('staff1').collection(coll).doc('b');
            await assertSucceeds(ref.update(paid(40)));
            await assertSucceeds(ref.update({
                payment: { online: 25.5, cash: 40, due: 34.5, total: 65.5 }, dueAmount: 34.5, openDue: true, clientVersion: 3,
                payments: [...paid(40).payments, { id: 'p2', amount: 25.5, cash: 0, online: 25.5, at: PAID_AT + 2000 }], paidAt: PAID_AT + 2000
            }));
            const after = [...paid(40).payments, { id: 'p2', amount: 25.5, cash: 0, online: 25.5, at: PAID_AT + 2000 }];
            await assertSucceeds(ref.update({
                payment: { online: 25.5, cash: 74.51, due: 0, total: 100.01 }, dueAmount: 0, openDue: false, clientVersion: 3,
                payments: [...after, { id: 'p3', amount: 34.51, cash: 34.51, online: 0, at: PAID_AT + 3000 }]
            }));
            const done = [...after, { id: 'p3', amount: 34.51, cash: 34.51, online: 0, at: PAID_AT + 3000 }];
            await assertFails(ref.update({
                payment: { online: 25.5, cash: 84.51, due: 0, total: 110.01 }, dueAmount: 0, clientVersion: 3,
                payments: [...done, { id: 'p4', amount: 10, cash: 10, online: 0, at: PAID_AT + 4000 }]
            }));
        }
    });

    t('payment edits (#65): a member cannot pay more than the due, nor take money off a bill', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'b', dueBill);
            const ref = as('staff1').collection(coll).doc('b');
            const entry = (amount, extra = {}) => [...dueBill.payments, { id: 'p1', amount, cash: amount, online: 0, at: PAID_AT, ...extra }];
            // more than the due (due 0, or due kept)
            await assertFails(ref.update({ payment: { online: 0, cash: 150, due: 0, total: 150 }, dueAmount: 0, payments: entry(150), clientVersion: 3 }));
            await assertFails(ref.update({ payment: { online: 0, cash: 40, due: 100, total: 40 }, payments: entry(40), clientVersion: 3 }));
            // the due goes down by more or less than the money
            await assertFails(ref.update({ payment: { online: 0, cash: 40, due: 0, total: 40 }, dueAmount: 0, payments: entry(40), clientVersion: 3 }));
            await assertFails(ref.update({ payment: { online: 0, cash: 40, due: 70, total: 40 }, dueAmount: 70, payments: entry(40), clientVersion: 3 }));
            // the due lowered with no money at all
            await assertFails(ref.update({ payment: { online: 0, cash: 0, due: 0, total: 0 }, dueAmount: 0, clientVersion: 3 }));
            await assertFails(ref.update({ 'payment.due': 50, dueAmount: 50, clientVersion: 3 }));
            // money without a payments[] entry, or an entry that says something else
            await assertFails(ref.update({ payment: { online: 0, cash: 40, due: 60, total: 40 }, dueAmount: 60, clientVersion: 3 }));
            await assertFails(ref.update({ payment: { online: 0, cash: 40, due: 60, total: 40 }, dueAmount: 60, payments: entry(30), clientVersion: 3 }));
            await assertFails(ref.update({ payment: { online: 0, cash: 40, due: 60, total: 40 }, dueAmount: 60, payments: entry(40, { cash: 0, online: 40 }), clientVersion: 3 }));
            await assertFails(ref.update({ payment: { online: 0, cash: 40, due: 60, total: 40 }, dueAmount: 60, payments: entry(40, { kind: 'writeOff' }), clientVersion: 3 }));
            await assertFails(ref.update({ payment: { online: 0, cash: 0, due: 60, total: 0, writtenOff: 40 }, dueAmount: 60, payments: entry(40), clientVersion: 3 }));
        }
    });

    t('payment edits (#65): no money moves without an entry, not even a paisa at a time', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'b', { ...dueBill, payment: { online: 0, cash: 20, due: 80, total: 20 }, dueAmount: 80 });
            const ref = as('staff1').collection(coll).doc('b');
            await assertFails(ref.update({ 'payment.due': 79.99, dueAmount: 79.99, clientVersion: 3 }));
            await assertFails(ref.update({ 'payment.cash': 19.99, clientVersion: 3 }));
            await assertFails(ref.update({ payment: { online: 0.01, cash: 20.01, due: 79.98, total: 20.02 }, dueAmount: 79.98, clientVersion: 3 }));
            await assertFails(ref.update({
                payment: { online: 0, cash: 20, due: 79.99, total: 20 }, dueAmount: 79.99, clientVersion: 3,
                payments: [...dueBill.payments, { id: 'z', amount: 0, cash: 0, online: 0 }]
            }));
            await assertFails(ref.update({
                payment: { online: 50, cash: 10, due: 40, total: 60 }, dueAmount: 40, clientVersion: 3,
                payments: [...dueBill.payments, { id: 'n', amount: 40, cash: -10, online: 50 }]
            }));
            // a due under 1 paisa is written off to 0 without an entry (applyWriteOffTransaction)
            await seedBill(coll, 't', { ...dueBill, payment: { online: 0, cash: 99.99, due: 0.01, total: 99.99 }, dueAmount: 0.01 });
            await assertSucceeds(as('staff1').collection(coll).doc('t').update({
                payment: { online: 0, cash: 99.99, due: 0, total: 99.99, writtenOff: 0 }, dueAmount: 0, openDue: false,
                cleared: true, clearedAt: 'x', clearedBy: 'staff1', clearedByName: 'S', clientVersion: 3
            }));
        }
    });

    t('payment edits (#65): cash, online and written off never go down', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'b', { ...dueBill, payment: { online: 30, cash: 20, due: 50, total: 50 }, dueAmount: 50 });
            const ref = as('staff1').collection(coll).doc('b');
            await assertFails(ref.update({ payment: { online: 0, cash: 50, due: 50, total: 50 }, clientVersion: 3 }));
            await assertFails(ref.update({ payment: { online: 30, cash: 0, due: 50, total: 30 }, clientVersion: 3 }));
            await assertFails(ref.update({
                payment: { online: 0, cash: 60, due: 40, total: 60 }, dueAmount: 40, clientVersion: 3,
                payments: [...dueBill.payments, { id: 'p1', amount: 10, cash: 10, online: 0 }]
            }));
            await seedBill(coll, 'w', { ...dueBill, payment: { online: 0, cash: 40, due: 0, total: 40, writtenOff: 60 }, dueAmount: 0, cleared: true, openDue: false });
            await assertFails(as('staff1').collection(coll).doc('w').update({ payment: { online: 0, cash: 40, due: 0, total: 40 }, clientVersion: 3 }));
        }
    });

    t('payment edits (#65): amounts are finite numbers >= 0 in whole paise', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'b', dueBill);
            const ref = as('staff1').collection(coll).doc('b');
            const pay = (cash, due, amount = cash) => ({
                payment: { online: 0, cash, due, total: cash }, dueAmount: due, clientVersion: 3,
                payments: [...dueBill.payments, { id: 'p1', amount, cash: amount, online: 0, at: PAID_AT }]
            });
            await assertFails(ref.update(pay(10.001, 89.999)));
            await assertFails(ref.update(pay(NaN, 60, 40)));
            await assertFails(ref.update(pay(Infinity, 0, 100)));
            await assertFails(ref.update({ ...pay(40, 60), payment: { online: 0, cash: 40, due: 60, total: -Infinity } }));
            await assertFails(ref.update({ ...pay(40, 60), payment: { online: 0, cash: 40, due: 60, total: 40, writtenOff: 'x' } }));
            await assertSucceeds(ref.update(pay(10.29, 89.71)));
        }
    });

    t('payment edits (#65): a bill whose Due was the total rounded to the rupee is paid in full; an opening record up to its amount', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'r', { ...dueBill, total: 99.6, payment: { online: 0, cash: 0, due: 100, total: 0 }, dueAmount: 100 });
            await assertSucceeds(as('staff1').collection(coll).doc('r').update(paid(100)));
        }
        const col = `${prefix}retailSales`;
        const rec = migratedDoc('retailSales', 'opening-retail-r4');
        await env.withSecurityRulesDisabled((ctx) => ctx.firestore().collection(col).doc('o').set(rec));
        const due = rec.payment.due;
        const ref = as('staff1').collection(col).doc('o');
        await assertFails(ref.update({
            payment: { ...rec.payment, cash: due + 50, due: 0, total: due + 50 }, dueAmount: 0, openDue: false, clientVersion: 3,
            payments: [{ id: 'm1', amount: due + 50, cash: due + 50, online: 0, at: PAID_AT }]
        }));
        await assertSucceeds(ref.update({
            payment: { ...rec.payment, cash: due, due: 0, total: due }, dueAmount: 0, openDue: false, clientVersion: 3,
            payments: [{ id: 'm1', amount: due, cash: due, online: 0, at: PAID_AT }]
        }));
    });

    t('payment edits (#65): a bill with only top-level money fields takes a payment the app\'s way', async () => {
        for (const coll of bills) {
            const flat = { userId: 'manager1', total: 100, cashPayment: 0, onlinePayment: 0, dueAmount: 100, timestamp: 1, clientVersion: 3 };
            await seedBill(coll, 'f', flat);
            const ref = as('staff1').collection(coll).doc('f');
            await assertFails(ref.update({ dueAmount: 0, clientVersion: 3 }));
            await assertSucceeds(ref.update({
                payment: { online: 0, cash: 40, due: 60, total: 40 }, dueAmount: 60, openDue: true, clientVersion: 3,
                payments: [{ id: 'p1', amount: 40, cash: 40, online: 0, at: PAID_AT }]
            }));
        }
    });

    t('payment edits (#65): cleared and openDue follow the due; clearedBy is the caller', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'b', dueBill);
            const ref = as('staff1').collection(coll).doc('b');
            await assertFails(ref.update({ cleared: true, clearedBy: 'staff1', clientVersion: 3 }));
            await assertFails(ref.update({ openDue: false, clientVersion: 3 }));
            await assertSucceeds(ref.update({ openDue: true, clientVersion: 3 }));
            const writeOff = (clearedBy) => ({
                payment: { online: 0, cash: 0, due: 0, total: 0, writtenOff: 100 }, dueAmount: 0, openDue: false,
                payments: [...dueBill.payments, { id: 'w', kind: 'writeOff', amount: 100, reason: 'gone', at: PAID_AT + 5000 }],
                cleared: true, clearedAt: 'x', clearedBy, clearedByName: 'S', clientVersion: 3, paidAt: PAID_AT + 5000
            });
            await assertFails(ref.update(writeOff('manager1')));
            await assertSucceeds(ref.update(writeOff('staff1')));
            await assertFails(ref.update({ cleared: false, clientVersion: 3 }));
        }
    });

    t('bill create (#65): paid + due at most the total + Rs 1; money in paise; no opening records', async () => {
        for (const coll of bills) {
            const c = as('staff1').collection(coll);
            const bill = (payment, extra = {}) => ({ userId: 'staff1', total: 99.6, payment, clientVersion: 3, ...extra });
            await assertSucceeds(c.doc('rounded').set(bill({ cash: 100, online: 0, due: 0, total: 100 }, { cashPayment: 100, onlinePayment: 0, dueAmount: 0 })));
            await assertSucceeds(c.doc('split').set(bill({ cash: 50, online: 20.6, due: 29, total: 99.6 })));
            await assertFails(c.doc('over').set(bill({ cash: 101, online: 0, due: 0, total: 101 })));
            await assertFails(c.doc('overDue').set(bill({ cash: 0, online: 0, due: 500, total: 500 })));
            await assertFails(c.doc('flatOver').set({ userId: 'staff1', total: 10, cashPayment: 0, dueAmount: 50, clientVersion: 3 }));
            await assertFails(c.doc('paise').set(bill({ cash: 10.005, online: 0, due: 0 })));
            await assertFails(c.doc('neg').set(bill({ cash: 120, online: -20, due: 0 })));
            await assertFails(c.doc('nan').set(bill({ cash: NaN, online: 0, due: 0 })));
            await assertFails(c.doc('inf').set({ userId: 'staff1', total: Infinity, payment: { cash: 5000, due: 0 }, clientVersion: 3 }));
            await assertFails(c.doc('opening').set({ ...bill({ cash: 0, online: 0, due: 0 }), openingBalance: { amount: 5000 } }));
            await assertFails(c.doc('amountPaid').set({ userId: 'staff1', total: 100, amountPaid: 5000, clientVersion: 3 }));
            await assertFails(c.doc('legacyDue').set({ userId: 'staff1', total: 100, due: 5000, clientVersion: 3 }));
            await assertFails(c.doc('payable').set({ userId: 'staff1', amountPayable: 100, total: 1000000,
                payment: { cash: 1000000, online: 0, due: 0 }, clientVersion: 3 }));
            await assertFails(c.doc('payableText').set({ userId: 'staff1', amountPayable: '100', total: 100, clientVersion: 3 }));
            // purchase: the total is after labour (grandTotal)
            await assertSucceeds(c.doc('p').set({ userId: 'staff1', billTotal: 100, laborCharges: 10, grandTotal: 90, amountPayable: 90,
                payment: { cash: 90, online: 0, due: 0, total: 90 }, clientVersion: 3 }));
            await assertFails(c.doc('p2').set({ userId: 'staff1', billTotal: 100, laborCharges: 10, grandTotal: 90, amountPayable: 90,
                payment: { cash: 100, online: 0, due: 0, total: 100 }, clientVersion: 3 }));
            await assertSucceeds(as('legacyOwner').collection(coll).doc('restored').set(bill({ cash: 500, online: 0, due: 0 })));
        }
    });

    t('bill create (#65): no payments[], paidAt or cleared on a new bill (non-owners)', async () => {
        for (const coll of bills) {
            const c = as('staff1').collection(coll);
            const bill = { userId: 'staff1', total: 100, payment: { cash: 0, online: 0, due: 100, total: 0 }, dueAmount: 100, clientVersion: 3 };
            await assertSucceeds(c.doc('ok').set(bill));
            await assertFails(c.doc('p').set({ ...bill, payment: { cash: 100, online: 0, due: 0, total: 100 }, dueAmount: 0,
                payments: [{ id: 'x', amount: 100, cash: 100, online: 0, at: Date.now() - 5 * DAY }] }));
            await assertFails(c.doc('pa').set({ ...bill, paidAt: Date.now() }));
            await assertFails(c.doc('cl').set({ ...bill, cleared: false }));
            await assertSucceeds(as('legacyOwner').collection(coll).doc('restored').set({ ...bill, payments: [], cleared: false }));
        }
    });

    t('payment edits (#65): a new entry\'s time is within 10 minutes of the server\'s', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'b', dueBill);
            const ref = as('staff1').collection(coll).doc('b');
            const at = (ms) => ({
                payment: { online: 0, cash: 40, due: 60, total: 40 }, dueAmount: 60, openDue: true, clientVersion: 3,
                payments: [...dueBill.payments, { id: 'p1', amount: 40, cash: 40, online: 0, at: ms }]
            });
            await assertFails(ref.update(at(Date.now() - DAY)));
            await assertFails(ref.update(at(Date.now() - 11 * MIN)));
            await assertFails(ref.update(at(Date.now() + 11 * MIN)));
            await assertFails(ref.update(at('now')));
            await assertSucceeds(ref.update(at(Date.now() - 2 * MIN)));
            // a back-dated write-off is refused too
            await seedBill(coll, 'w', dueBill);
            await assertFails(as('staff1').collection(coll).doc('w').update({
                payment: { online: 0, cash: 0, due: 0, total: 0, writtenOff: 100 }, dueAmount: 0, openDue: false,
                payments: [...dueBill.payments, { id: 'w', kind: 'writeOff', amount: 100, reason: 'gone', at: Date.now() - 3 * DAY }],
                cleared: true, clearedAt: 'x', clearedBy: 'staff1', clearedByName: 'S', clientVersion: 3
            }));
        }
    });

    t('bill full edit (#65): the creator cannot pay more than the total', async () => {
        for (const coll of bills) {
            await seedBill(coll, 'b', { ...dueBill, userId: 'staff1', ...fresh() });
            await assertFails(logged('staff1', coll, 'b', 1, { 'payment.cash': 200, 'payment.due': 0, dueAmount: 0, clientVersion: 3 }));
            await assertFails(logged('staff1', coll, 'b', 1, { total: 50, clientVersion: 3 }));
            await assertSucceeds(logged('staff1', coll, 'b', 1, { 'payment.cash': 100, 'payment.due': 0, dueAmount: 0, clientVersion: 3 }));
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
            await assertFails(logged('staff1', coll, 'b', 1, { total: 'free', clientVersion: 3 }));
            await assertSucceeds(logged('staff1', coll, 'b', 1, { total: 120, clientVersion: 3 }));
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
        const day = (extra = {}) => session({ id: 'cash_2026-10-22', ...extra });
        const ref = (uid, id = 'cash_2026-10-22') => as(uid).collection(cash).doc(id);
        await assertFails(ref('staff1').set(day({ userId: 'manager1' })));
        await assertFails(ref('staff1').set(day({ openingBalance: -1 })));
        await assertFails(ref('staff1').set(day({ openingBalance: '500' })));
        await assertFails(ref('staff1').set(day({ signedOut: true })));
        await assertFails(ref('pending1').set(day({ userId: 'pending1' })));
        await assertSucceeds(ref('staff1').set(day({ openingNotes: 'float from bank' })));
        await assertSucceeds(ref('legacyStaff', 'cash_2026-10-23').set(
            day({ id: 'cash_2026-10-23', date: '2026-10-23', userId: 'legacyStaff', openingBalance: 0 })));
    });

    t('cash: a new session needs the cash_<date> id and the signIn shape (no random ids)', async () => {
        for (const uid of ['staff1', 'manager1']) {
            // a random id (the removed FirebaseService.saveCashSession .add())
            await assertFails(as(uid).collection(cash).doc('s1').set(session({ userId: uid })));
            await assertFails(as(uid).collection(cash).doc('Xy12ab').set(session({ id: 'Xy12ab', userId: uid })));
            const day = session({ id: 'cash_2026-10-22', userId: uid });
            const db = as(uid);
            const ref = db.collection(cash).doc('cash_2026-10-22');
            const without = (key) => { const d = { ...day }; delete d[key]; return d; };
            await assertFails(ref.set({ ...day, id: 'cash_2026-10-21' }));
            await assertFails(ref.set({ ...day, cashDeposits: [deposit()] }));
            await assertFails(ref.set({ ...day, duePayments: [{ id: 'p1', amount: 40 }] }));
            await assertFails(ref.set({ ...day, closingBalance: 500, counted: true }));
            await assertFails(ref.set({ ...day, secret: 1 }));
            await assertFails(ref.set({ ...day, openingNotes: 5 }));
            await assertFails(ref.set(without('signedOut')));
            await assertFails(as(uid).collection(cash).doc('cash_2026-1-5').set({ ...day, id: 'cash_2026-1-5', date: '2026-1-5' }));
            await assertSucceeds(ref.set(without('id')));
            await env.withSecurityRulesDisabled(ctx => ctx.firestore().collection(cash).doc('cash_2026-10-22').delete());
            // firestore-service.js openCashSession: in a transaction
            await assertSucceeds(db.runTransaction(async tx => {
                const snap = await tx.get(ref);
                if (!snap.exists) tx.set(ref, day);
            }));
            await env.withSecurityRulesDisabled(ctx => ctx.firestore().collection(cash).doc('cash_2026-10-22').delete());
        }
        // the owner may still write any id (repairs, restore)
        await assertSucceeds(as('legacyOwner').collection(cash).doc('s9').set(session({ id: 's9', userId: 'legacyOwner' })));
    });

    t('cash: one session per day at cash_<date> (#38); a second phone cannot overwrite it', async () => {
        const day = session({ id: 'cash_2026-10-22' });
        await assertFails(as('staff1').collection(cash).doc('cash_2026-10-21').set(day));
        const noDate = { ...day };
        delete noDate.date;
        await assertFails(as('staff1').collection(cash).doc('cash_2026-10-22').set(noDate));
        await assertSucceeds(as('staff1').collection(cash).doc('cash_2026-10-22').set(day));
        const other = { ...day, userId: 'legacyStaff', openingBalance: 900 };
        await assertFails(as('legacyStaff').collection(cash).doc('cash_2026-10-22').set(other));
        await assertFails(as('legacyStaff').collection(cash).doc('cash_2026-10-22').set({ openingBalance: 900, userId: 'legacyStaff' }, { merge: true }));
        await assertSucceeds(as('legacyStaff').collection(cash).doc('cash_2026-10-22').update({ cashDeposits: FieldValue.arrayUnion(deposit()) }));
    });

    t('cash: sign-out records closedBy as the caller only (#38)', async () => {
        await seedSession();
        await assertFails(as('staff1').collection(cash).doc('s1').update(closing({ closedBy: 'manager1' })));
        await assertSucceeds(as('manager1').collection(cash).doc('s1').update(closing({ closedBy: 'manager1' })));
    });

    t('cash: nobody, owners included, sets signedOut back to false on a closed day (#38)', async () => {
        await seedSession(closing());
        const opening = session({ id: 'cash_2026-10-22', openingBalance: 900, signInTime: 'y' });
        for (const uid of ['legacyOwner', 'owner2', 'manager1', 'staff1']) {
            const ref = as(uid).collection(cash).doc('s1');
            await assertFails(ref.set({ ...opening, userId: uid }, { merge: true }));
            await assertFails(ref.update({ signedOut: false }));
            await assertFails(ref.set(session({ userId: uid })));
        }
        await assertSucceeds(as('staff1').collection(cash).doc('s1').update({ cashDeposits: FieldValue.arrayUnion(deposit()) }));
        await assertSucceeds(as('legacyOwner').collection(cash).doc('s1').update({ closingNotes: 'checked' }));
        await seedSession();
        await assertSucceeds(as('legacyOwner').collection(cash).doc('s1').update(closing()));
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
        await assertFails(as('legacyStaff').collection(expenses).doc('e2').set(expense('legacyStaff', { category: 'personal' })));
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
        await assertSucceeds(as('legacyOwner').collection(expenses).doc('b').update({ amount: 1, category: 'other' }));
        await assertSucceeds(as('legacyOwner').collection(expenses).doc('b').delete());
    });

    // ---- personal expenses: own collection, Roles & access › Personal expenses (#98) ----

    const personal = `${prefix}personalExpenses`;
    const personalDays = `${prefix}personalExpenseDays`;
    const setPersonalAccess = (roleAccess) => env.withSecurityRulesDisabled(ctx =>
        ctx.firestore().collection(`${prefix}settings`).doc('app').set({ roleAccess }));
    /** The local (IST) day `offset` days from today, YYYY-MM-DD. */
    const istDay = (offset = 0) => new Date(Date.now() + 330 * MIN + offset * DAY).toISOString().slice(0, 10);
    /** An expense `date` on that day, as en-IN writes it ("5/1/2026, 10:00:00 am"). */
    const onDay = (day) => `${Number(day.slice(8, 10))}/${Number(day.slice(5, 7))}/${day.slice(0, 4)}, 10:00:00 am`;
    const PDAY = istDay(0);
    const pexp = (uid, extra = {}) => expense(uid, { category: 'personal', day: PDAY, date: onDay(PDAY), ...extra });
    const dayKey = (id, amount) => ({ amounts: { [id]: amount === null ? FieldValue.delete() : amount }, last: id });

    t('personal expenses (#98): owner always; managers and members while their switch is on (default)', async () => {
        await seedBill(personal, 'p1', pexp('legacyOwner'));
        await seedBill(personalDays, PDAY, { amounts: { p1: 50 }, last: 'p1' });
        for (const uid of ['legacyOwner', 'manager1', 'staff1', 'legacyStaff']) {
            await assertSucceeds(as(uid).collection(personal).get());
            await assertSucceeds(as(uid).collection(personal).doc('p1').get());
        }
        await setPersonalAccess({ staff: { personalExpenses: false }, manager: { personalExpenses: true } });
        await assertFails(as('staff1').collection(personal).get());
        await assertFails(as('staff1').collection(personal).doc('p1').get());
        await assertFails(as('staff1').collection(personal).doc('p2').set(pexp('staff1')));
        await assertSucceeds(as('manager1').collection(personal).get());
        await assertSucceeds(as('legacyOwner').collection(personal).get());
        // the day totals stay readable, so the cash count and Today still add them up
        await assertSucceeds(as('staff1').collection(personalDays).doc(PDAY).get());
        await assertFails(as('staff1').collection(personalDays).doc(PDAY).set(dayKey('p1', 50), { merge: true }));
        await setPersonalAccess({ manager: { personalExpenses: false } });
        await assertFails(as('manager1').collection(personal).get());
        await assertSucceeds(as('staff1').collection(personal).get());
        for (const uid of ['pending1', 'rejected1', 'noRole', 'rentOnly', 'ghost']) {
            await assertFails(as(uid).collection(personal).get());
            await assertFails(as(uid).collection(personalDays).doc(PDAY).get());
        }
        await assertFails(anon().collection(personal).get());
    });

    t('personal expenses (#98): own personal rows only; the 24-hour edit rules of expenses', async () => {
        const c = as('staff1').collection(personal);
        await assertSucceeds(c.doc('mine').set(pexp('staff1')));
        await assertFails(c.doc('noDay').set(expense('staff1', { category: 'personal' })));
        await assertFails(c.doc('biz').set(expense('staff1')));
        await assertFails(c.doc('other').set(pexp('manager1')));
        await assertFails(c.doc('text').set(pexp('staff1', { amount: '50' })));
        await assertSucceeds(c.doc('mine').update(edit()));
        await assertFails(c.doc('mine').update(edit({ category: 'business' })));
        await assertFails(as('manager1').collection(personal).doc('mine').update({ day: istDay(-1) }));
        await seedBill(personal, 'theirs', pexp('manager1'));
        await seedBill(personal, 'old', pexp('staff1', { timestamp: Date.now() - 25 * HOUR }));
        await assertFails(c.doc('theirs').update(edit()));
        await assertFails(c.doc('theirs').delete());
        await assertFails(c.doc('old').delete());
        await assertSucceeds(c.doc('mine').delete());
        await assertSucceeds(as('manager1').collection(personal).doc('old').update(edit({ updatedBy: 'manager1' })));
        await assertSucceeds(as('manager1').collection(personal).doc('old').delete());
        await assertSucceeds(as('legacyOwner').collection(personal).doc('theirs').delete());
    });

    t('personal expenses (#98): a day doc key follows its expense, written in the same batch', async () => {
        const db = as('staff1');
        const D = PDAY;
        const dayDoc = async () => {
            let data;
            await env.withSecurityRulesDisabled(async ctx => { data = (await ctx.firestore().collection(personalDays).doc(D).get()).data(); });
            return data;
        };
        // create: expense + its key
        let b = db.batch();
        b.set(db.collection(personal).doc('b1'), pexp('staff1', { amount: 50 }));
        b.set(db.collection(personalDays).doc(D), dayKey('b1', 50), { merge: true });
        await assertSucceeds(b.commit());
        // a wrong amount, another day, an extra field or a second key are refused
        for (const [id, data, day] of [['b2', dayKey('b2', 99), D], ['b3', dayKey('b3', 50), istDay(-1)],
            ['b4', { ...dayKey('b4', 50), note: 'x' }, D], ['b5', { amounts: { b5: 50, b1: 0 }, last: 'b5' }, D]]) {
            b = db.batch();
            b.set(db.collection(personal).doc(id), pexp('staff1', { amount: 50 }));
            b.set(db.collection(personalDays).doc(day), data, { merge: true });
            await assertFails(b.commit());
        }
        // a key for an expense that doesn't exist, or zeroing the map
        await assertFails(db.collection(personalDays).doc(D).set(dayKey('ghost', 10), { merge: true }));
        await assertFails(db.collection(personalDays).doc(D).set({ amounts: {}, last: 'b1' }));
        await assertFails(db.collection(personalDays).doc(D).set(dayKey('b1', null), { merge: true }));
        // a member can't rewrite a key without writing its expense; a manager may correct it to the stored amount
        await env.withSecurityRulesDisabled(ctx => ctx.firestore().collection(personalDays).doc(D).set({ amounts: { b1: 5 }, last: 'b1' }));
        await assertFails(db.collection(personalDays).doc(D).set(dayKey('b1', 50), { merge: true }));
        await assertFails(as('manager1').collection(personalDays).doc(D).set(dayKey('b1', 7), { merge: true }));
        await assertSucceeds(as('manager1').collection(personalDays).doc(D).set(dayKey('b1', 50), { merge: true }));
        // edit: new amount
        b = db.batch();
        b.update(db.collection(personal).doc('b1'), edit({ amount: 65 }));
        b.set(db.collection(personalDays).doc(D), dayKey('b1', 65), { merge: true });
        await assertSucceeds(b.commit());
        // delete, then the same delete again: harmless
        for (let i = 0; i < 2; i++) {
            b = db.batch();
            b.delete(db.collection(personal).doc('b1'));
            b.set(db.collection(personalDays).doc(D), dayKey('b1', null), { merge: true });
            await assertSucceeds(b.commit());
        }
        if (Object.keys((await dayDoc()).amounts).length) throw new Error('the deleted key is still there');
        await assertFails(db.collection(personalDays).doc(D).delete());
        await assertFails(as('manager1').collection(personalDays).doc(D).delete());
        await assertSucceeds(as('legacyOwner').collection(personalDays).doc(D).delete());
    });

    // ---- expense date and payment mode (#118) ----

    const dated = (uid, offset, extra = {}) => expense(uid, { paymentMode: 'cash', day: istDay(offset), date: onDay(istDay(offset)), ...extra });

    t('expenses (#118): payment mode is cash or online; the day is never in the future', async () => {
        const c = as('staff1').collection(expenses);
        await assertSucceeds(c.doc('m1').set(dated('staff1', 0, { paymentMode: 'online' })));
        await assertSucceeds(c.doc('m2').set(dated('staff1', 0)));
        await assertFails(c.doc('m3').set(dated('staff1', 0, { paymentMode: 'card' })));
        await assertFails(c.doc('m4').set(dated('staff1', 2)));
        await assertFails(c.doc('m5').set(dated('staff1', 0, { day: '2026-13-01' })));
        await assertFails(as('legacyOwner').collection(expenses).doc('m6').set(dated('legacyOwner', 2)));
        await assertFails(as('legacyOwner').collection(expenses).doc('m7').set(dated('legacyOwner', 0, { paymentMode: 'upi' })));
        // the mode can be corrected on an edit; the 24-hour member rules still apply
        await assertSucceeds(c.doc('m2').update(edit({ paymentMode: 'online' })));
        await assertFails(c.doc('m2').update(edit({ paymentMode: 'cheque' })));
        await assertFails(as('manager1').collection(expenses).doc('m2').update({ paymentMode: 'cheque' }));
        await assertSucceeds(as('manager1').collection(expenses).doc('m2').update({ paymentMode: 'cash' }));
        // older apps send neither field
        await assertSucceeds(c.doc('m8').set(expense('staff1')));
    });

    t('expenses (#118): back-dating at most the role edit window (+3 days offline); owner any day', async () => {
        const c = as('staff1').collection(expenses);
        // default window 2 days, + 3 for a phone that saved offline
        await assertSucceeds(c.doc('w1').set(dated('staff1', -2)));
        await assertSucceeds(c.doc('w2').set(dated('staff1', -5)));
        await assertFails(c.doc('w3').set(dated('staff1', -6)));
        await assertFails(as('manager1').collection(expenses).doc('w4').set(dated('manager1', -6)));
        await assertSucceeds(as('legacyOwner').collection(expenses).doc('w5').set(dated('legacyOwner', -400)));
        await setPersonalAccess({ staff: { editDays: 0 } });
        await assertSucceeds(c.doc('w6').set(dated('staff1', -3)));
        await assertFails(c.doc('w7').set(dated('staff1', -4)));
        // personal expenses follow the same rule
        await assertFails(as('staff1').collection(personal).doc('w8').set(dated('staff1', -4, { category: 'personal' })));
        await assertSucceeds(as('staff1').collection(personal).doc('w9').set(dated('staff1', 0, { category: 'personal', paymentMode: 'online' })));
        // the window holds without a mode (older apps), and `date` (what the figures read) must be on `day`
        const noMode = dated('staff1', -4);
        delete noMode.paymentMode;
        await assertFails(c.doc('w10').set(noMode));
        await assertSucceeds(c.doc('w10b').set({ ...noMode, day: istDay(-1), date: onDay(istDay(-1)) }));
        await assertFails(as('staff1').collection(personal).doc('w11').set(expense('staff1', { category: 'personal', day: istDay(-30), date: onDay(istDay(-30)) })));
        await assertFails(c.doc('w12').set(dated('staff1', 0, { date: onDay(istDay(-30)) })));
        await assertFails(c.doc('w13').set(dated('staff1', 0, { date: '2026-01-01' })));
        await assertFails(c.doc('w14').set(dated('staff1', 0, { date: 7 })));
        const [y, m, d] = PDAY.split('-');
        await assertSucceeds(c.doc('w15').set(dated('staff1', 0, { date: `${d}/${m}/${y}, 9:05:00 am` })));
        // the owner: no window and no date check (repairs, restores)
        await assertSucceeds(as('legacyOwner').collection(expenses).doc('w16').set(dated('legacyOwner', -40, { date: onDay(istDay(-41)) })));
    });

    t('personal expenses (#118): the day doc flags exactly the expenses paid online', async () => {
        const db = as('staff1');
        const D = istDay(0);
        const key = (id, amount, online) => ({ ...dayKey(id, amount), online: { [id]: online ? true : FieldValue.delete() } });
        const create = (id, mode, dayData) => {
            const b = db.batch();
            b.set(db.collection(personal).doc(id), dated('staff1', 0, { category: 'personal', amount: 40, paymentMode: mode }));
            b.set(db.collection(personalDays).doc(D), dayData, { merge: true });
            return b.commit();
        };
        await assertSucceeds(create('o1', 'online', key('o1', 40, true)));
        await assertFails(create('o2', 'online', key('o2', 40, false)));
        await assertFails(create('o3', 'cash', key('o3', 40, true)));
        await assertSucceeds(create('o4', 'cash', key('o4', 40, false)));
        // a flag on someone else's key, or a flag that isn't `true`
        await assertFails(create('o5', 'cash', { ...key('o5', 40, false), online: { o5: FieldValue.delete(), o4: true } }));
        await assertFails(create('o6', 'online', { ...dayKey('o6', 40), online: { o6: 'yes' } }));
        // changing the mode moves the flag with it
        let b = db.batch();
        b.update(db.collection(personal).doc('o1'), edit({ amount: 40, paymentMode: 'cash' }));
        b.set(db.collection(personalDays).doc(D), key('o1', 40, true), { merge: true });
        await assertFails(b.commit());
        b = db.batch();
        b.update(db.collection(personal).doc('o1'), edit({ amount: 40, paymentMode: 'cash' }));
        b.set(db.collection(personalDays).doc(D), key('o1', 40, false), { merge: true });
        await assertSucceeds(b.commit());
        // an older app deletes without touching the flags: allowed, the stale flag counts nowhere
        await assertSucceeds(create('o7', 'online', key('o7', 40, true)));
        b = db.batch();
        b.delete(db.collection(personal).doc('o7'));
        b.set(db.collection(personalDays).doc(D), dayKey('o7', null), { merge: true });
        await assertSucceeds(b.commit());
    });

    t('personal expenses (#98): new expenses tagged personal are refused in `expenses` (older apps)', async () => {
        await assertFails(as('staff1').collection(expenses).doc('x1').set(expense('staff1', { category: 'personal' })));
        await assertFails(as('staff1').collection(expenses).doc('x2').set(expense('staff1', { category: ' Personal ' })));
        await assertFails(as('legacyOwner').collection(expenses).doc('x3').set(expense('legacyOwner', { category: 'PERSONAL' })));
        await assertSucceeds(as('staff1').collection(expenses).doc('x4').set(expense('staff1', { type: 'Personal' })));
        await seedBill(expenses, 'biz', expense('staff1'));
        await assertFails(as('manager1').collection(expenses).doc('biz').update({ category: 'personal' }));
        await assertFails(as('legacyOwner').collection(expenses).doc('biz').update({ category: 'personal' }));
        // rows saved before #98 stay editable
        await seedBill(expenses, 'old', expense('staff1', { category: 'personal' }));
        await assertSucceeds(as('staff1').collection(expenses).doc('old').update(edit()));
    });

    // ---- legacy timestamp backfill (any approved device) ----

    t('backfill: members may fill a missing timestamp on expenses/withdrawals/adjustments, never change one', async () => {
        for (const c of ['expenses', 'withdrawals', 'stockAdjustments']) {
            const coll = `${prefix}${c}`;
            await seedBill(coll, 'old', { amount: 5, quantity: 5, date: '01/10/2025', userId: 'manager1' });
            await seedBill(coll, 'new', { amount: 5, quantity: 5, date: '01/10/2025', userId: 'manager1', timestamp: 1 });
            const update = c === 'stockAdjustments' ? { timestamp: IST_OCT_1, clientVersion: 3 } : { timestamp: IST_OCT_1 };
            await assertSucceeds(as('staff1').collection(coll).doc('old').update(update));
            await assertFails(as('staff1').collection(coll).doc('new').update(update));
            await assertFails(as('staff1').collection(coll).doc('old').update({ amount: 0 }));
        }
    });

    t('backfill: the timestamp comes from the record (its date or old Timestamp), never the future', async () => {
        const old = Date.now() - 40 * DAY;
        for (const c of ['expenses', 'withdrawals', 'stockAdjustments']) {
            const coll = `${prefix}${c}`;
            const fill = (id, timestamp) => as('staff1').collection(coll).doc(id)
                .update(c === 'stockAdjustments' ? { timestamp, clientVersion: 3 } : { timestamp });
            const seed = (id, extra) => seedBill(coll, id, { amount: 5, quantity: 5, userId: 'manager1', ...extra });
            // DD/MM/YYYY[, time] (local time on the phone)
            await seed('dmy', { date: '01/10/2025, 7:55:07 pm' });
            await assertFails(fill('dmy', Date.now()));
            await assertFails(fill('dmy', Date.now() + DAY));
            await assertFails(fill('dmy', Date.UTC(2025, 9, 5)));
            await assertFails(fill('dmy', Date.UTC(2024, 9, 1)));
            await assertSucceeds(fill('dmy', IST_OCT_1 + 19 * HOUR + 55 * MIN));
            // YYYY-MM-DD (UTC midnight) and YYYY-MM-DDTHH:mm
            await seed('iso', { date: '2025-10-01' });
            await assertFails(fill('iso', Date.UTC(2025, 9, 1) + 3 * DAY));
            await assertSucceeds(fill('iso', Date.UTC(2025, 9, 1)));
            await seed('isoTime', { date: '2025-10-01T14:30:00' });
            await assertSucceeds(fill('isoTime', Date.UTC(2025, 9, 1, 9)));
            // an old Firestore Timestamp in `timestamp` (or `date`): its own millis only
            await seed('ts', { date: '2025-10-01', timestamp: Timestamp.fromMillis(old) });
            await assertFails(fill('ts', old + MIN));
            await assertSucceeds(fill('ts', old));
            await seed('tsDate', { date: Timestamp.fromMillis(old) });
            await assertFails(fill('tsDate', old - HOUR));
            await assertSucceeds(fill('tsDate', old));
            // a date the rules don't read: any past time, never the future or the "no time" marker
            await seed('odd', { date: 'Oct 1 2025' });
            await assertFails(fill('odd', Date.now() + HOUR));
            await assertFails(fill('odd', Number.MAX_SAFE_INTEGER));
            await assertSucceeds(fill('odd', Date.UTC(2025, 9, 1)));
            // managers correct records freely
            await seed('m', { date: '2025-10-01' });
            await assertSucceeds(as('manager1').collection(coll).doc('m')
                .update(c === 'stockAdjustments' ? { timestamp: old, clientVersion: 3 } : { timestamp: old }));
        }
    });

    // ---- withdrawals / stock adjustments (#18) ----

    t('backfill: a batch over several stock adjustments passes for a member', async () => {
        const coll = `${prefix}stockAdjustments`;
        const db = as('staff1');
        const batch = db.batch();
        for (const id of ['a', 'b', 'c', 'd']) {
            await seedBill(coll, id, { quantity: 1, date: '01/10/2025', userId: 'manager1' });
            batch.update(db.collection(coll).doc(id), { timestamp: IST_OCT_1, clientVersion: 3 });
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

    t('expenses / withdrawals / personal expenses: created with a numeric timestamp, not in the future', async () => {
        const rec = (uid, extra = {}) => ({ amount: 50, type: 'Tea', date: onDay(istDay(0)), userId: uid, timestamp: Date.now(), ...extra });
        const colls = [[`${prefix}expenses`, {}], [withdrawals, { person: 'O', purpose: 'x' }]];
        for (const [coll, extra] of colls) {
            for (const uid of ['staff1', 'manager1']) {
                const c = as(uid).collection(coll);
                await assertSucceeds(c.doc(`now-${uid}`).set(rec(uid, extra)));
                await assertSucceeds(c.doc(`ahead-${uid}`).set(rec(uid, { ...extra, timestamp: Date.now() + 5 * MIN })));
                // queued offline for days: still fine
                await assertSucceeds(c.doc(`queued-${uid}`).set(rec(uid, { ...extra, timestamp: Date.now() - 3 * DAY })));
                await assertFails(c.doc(`future-${uid}`).set(rec(uid, { ...extra, timestamp: Date.now() + 30 * MIN })));
                await assertFails(c.doc(`tomorrow-${uid}`).set(rec(uid, { ...extra, timestamp: Date.now() + DAY })));
                await assertFails(c.doc(`text-${uid}`).set(rec(uid, { ...extra, timestamp: '2026-10-31' })));
                const none = rec(uid, extra);
                delete none.timestamp;
                await assertFails(c.doc(`none-${uid}`).set(none));
            }
            // the owner records anything (repairs, restore)
            await assertSucceeds(as('legacyOwner').collection(coll).doc('owner').set(rec('legacyOwner', { ...extra, timestamp: Date.now() + DAY })));
        }
        // Today's IST day and date, so only the timestamp decides (#118 checks the day itself)
        const pe = (id, timestamp) => {
            const db = as('staff1');
            const b = db.batch();
            b.set(db.collection(`${prefix}personalExpenses`).doc(id), dated('staff1', 0, { category: 'personal', timestamp }));
            b.set(db.collection(`${prefix}personalExpenseDays`).doc(istDay(0)), { amounts: { [id]: 50 }, last: id }, { merge: true });
            return b.commit();
        };
        await assertSucceeds(pe('p1', Date.now()));
        await assertSucceeds(pe('p2', Date.now() + 5 * MIN));
        await assertFails(pe('p3', Date.now() + 30 * MIN));
        await assertFails(pe('p4', Date.now() + DAY));
    });

    t('stock adjustments: owner/manager record them (#64); only they change or delete them', async () => {
        await assertFails(as('staff1').collection(adjustments).doc('m1').set(adjustment('staff1')));
        await assertFails(as('legacyStaff').collection(adjustments).doc('m2').set(adjustment('legacyStaff', { adjustType: 'set', quantity: 0 })));
        await assertFails(as('rentMember').collection(adjustments).doc('m3').set(adjustment('rentMember')));
        await assertSucceeds(as('manager1').collection(adjustments).doc('a1').set(adjustment('manager1')));
        await assertSucceeds(as('legacyOwner').collection(adjustments).doc('a2').set(adjustment('legacyOwner', { adjustType: 'set', quantity: 0 })));
        await assertFails(as('manager1').collection(adjustments).doc('a3').set(adjustment('staff1')));
        await assertFails(as('manager1').collection(adjustments).doc('a4').set(adjustment('manager1', { quantity: -5 })));
        await assertFails(as('manager1').collection(adjustments).doc('a5').set(adjustment('manager1', { quantity: '5' })));
        await assertFails(as('manager1').collection(adjustments).doc('a6').set(adjustment('manager1', { adjustType: 'steal' })));
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

    // ---- per-user records: auto-saves, drafts, notifications (#18 follow-up) ----

    const autoSaves = `${prefix}autoSaves`;
    const drafts = `${prefix}drafts`;
    const notifications = `${prefix}notifications`;
    const autoSave = (uid, extra = {}) => ({ userId: uid, userName: 'X', mode: 'purchase', lastSaved: serverTimestamp(),
        purchase: { items: [], weights: [1] }, sale: { items: [], weights: [] }, ...extra });
    const draft = (uid, extra = {}) => ({ id: 'd1', userId: uid, userName: 'X', mode: 'purchase', timestamp: 1,
        items: [], weights: [5], ...extra });
    // firestore-service.js notifyRateChanges / notifyItemEdit → sendNotification
    const rateNote = (actor, recipient, extra = {}) => ({
        type: 'rate_change', itemId: 'g', itemName: 'Gehu', itemHindiName: '', rateType: 'sale', rateTypeLabel: 'Sale',
        oldRate: 40, newRate: 45, changedBy: 'Boss', changedByUserId: actor,
        read: false, timestamp: serverTimestamp(), userId: recipient, eventKey: 'rate-1-sale', ...extra });
    const itemNote = (actor, recipient, extra = {}) => ({
        type: 'item_edit', action: 'updated', fields: ['name'], itemId: 'g', itemName: 'Gehu', itemHindiName: '',
        changedBy: 'Boss', changedByUserId: actor, read: false, timestamp: serverTimestamp(),
        userId: recipient, eventKey: 'item-1', ...extra });
    const noteId = (n) => `${n.eventKey}_${n.userId}`;
    const sendAs = (uid, n) => as(uid).collection(notifications).doc(noteId(n)).set(n);

    t('autoSaves: each user writes and deletes only their own', async () => {
        await assertSucceeds(as('staff1').collection(autoSaves).doc('staff1').set(autoSave('staff1')));
        await assertSucceeds(as('staff1').collection(autoSaves).doc('staff1').set(autoSave('staff1', { mode: 'sale' })));
        await assertSucceeds(as('staff1').collection(autoSaves).doc('staff1').delete());
        await assertSucceeds(as('legacyOwner').collection(autoSaves).doc('legacyOwner').set(autoSave('legacyOwner')));
    });

    t('autoSaves: nobody plants, overwrites or wipes another user\'s auto-save', async () => {
        await seedBill(autoSaves, 'manager1', autoSave('manager1'));
        for (const uid of ['staff1', 'legacyStaff', 'manager1', 'legacyOwner']) {
            await assertFails(as(uid).collection(autoSaves).doc('owner2').set(autoSave('owner2')));
        }
        for (const uid of ['staff1', 'legacyOwner']) {
            await assertFails(as(uid).collection(autoSaves).doc('manager1').set(autoSave('manager1')));
            await assertFails(as(uid).collection(autoSaves).doc('manager1').update({ purchase: { items: [], weights: [] } }));
        }
        await assertFails(as('staff1').collection(autoSaves).doc('manager1').delete());
        // own doc, but claiming to be someone else
        await assertFails(as('staff1').collection(autoSaves).doc('staff1').set(autoSave('manager1')));
        await assertFails(as('pending1').collection(autoSaves).doc('pending1').set(autoSave('pending1')));
        // Admin › Clear Data
        await assertSucceeds(as('legacyOwner').collection(autoSaves).doc('manager1').delete());
    });

    t('drafts: own drafts are saved, loaded and deleted', async () => {
        const ref = as('staff1').collection(drafts).doc('d1');
        await assertSucceeds(ref.set(draft('staff1')));
        await assertSucceeds(ref.update({ weights: [5, 6] }));
        await assertSucceeds(ref.delete());
        await assertSucceeds(as('staff1').collection(drafts).doc('gone').delete());
    });

    t('drafts: nobody creates a draft for another user or changes userId', async () => {
        for (const uid of ['staff1', 'manager1', 'legacyOwner']) {
            await assertFails(as(uid).collection(drafts).doc('x').set(draft('owner2')));
        }
        await assertFails(as('staff1').collection(drafts).doc('x').set(draft('staff1', { userId: null })));
        await seedBill(drafts, 'mine', draft('staff1'));
        await assertFails(as('staff1').collection(drafts).doc('mine').update({ userId: 'manager1' }));
        await seedBill(drafts, 'theirs', draft('manager1'));
        await assertFails(as('staff1').collection(drafts).doc('theirs').update({ userId: 'staff1' }));
        await assertFails(as('staff1').collection(drafts).doc('theirs').update({ weights: [] }));
        await assertFails(as('legacyOwner').collection(drafts).doc('theirs').update({ weights: [] }));
    });

    t('drafts: only their own user (or the owner, Clear Data) deletes them', async () => {
        await seedBill(drafts, 'theirs', draft('manager1'));
        await assertFails(as('staff1').collection(drafts).doc('theirs').delete());
        await assertFails(as('legacyStaff').collection(drafts).doc('theirs').delete());
        await assertSucceeds(as('legacyOwner').collection(drafts).doc('theirs').delete());
    });

    t('notifications: owner and manager fan rate and item edits out to others (batched)', async () => {
        for (const actor of ['legacyOwner', 'manager1']) {
            const db = as(actor);
            const batch = db.batch();
            const notes = [
                rateNote(actor, 'staff1', { eventKey: `rate-${actor}-sale` }),
                rateNote(actor, 'owner2', { eventKey: `rate-${actor}-sale` }),
                rateNote(actor, 'staff1', { eventKey: `rate-${actor}-wholesale`, rateType: 'wholesale', oldRate: [1, 2], newRate: [3] }),
                itemNote(actor, 'owner2', { eventKey: `item-${actor}` }),
                itemNote(actor, 'owner2', { eventKey: `item-${actor}-a`, action: 'added', fields: [] })
            ];
            notes.forEach(n => batch.set(db.collection(notifications).doc(noteId(n)), n));
            await assertSucceeds(batch.commit());
        }
        // notifyItemEdit for an item without a Hindi name / old rows without fields
        await assertSucceeds(sendAs('manager1', itemNote('manager1', 'owner2', { eventKey: 'item-2', itemId: null })));
    });

    t('notifications: members cannot send any notification', async () => {
        for (const uid of ['staff1', 'legacyStaff']) {
            await assertFails(sendAs(uid, rateNote(uid, 'owner2')));
            await assertFails(sendAs(uid, itemNote(uid, 'owner2')));
            await assertFails(sendAs(uid, rateNote(uid, uid)));
        }
        await assertFails(sendAs('pending1', rateNote('pending1', 'owner2')));
    });

    t('notifications: a sender cannot forge the actor, type, fields or read state', async () => {
        for (const actor of ['manager1', 'legacyOwner']) {
            // "changed by" someone else
            await assertFails(sendAs(actor, rateNote('owner2', 'staff1')));
            await assertFails(sendAs(actor, rateNote(null, 'staff1')));
            // other types / extra fields / wrong shape
            await assertFails(sendAs(actor, rateNote(actor, 'staff1', { type: 'edit' })));
            await assertFails(sendAs(actor, rateNote(actor, 'staff1', { type: 'cash_mismatch', message: 'Pay me' })));
            await assertFails(sendAs(actor, rateNote(actor, 'staff1', { message: 'Call 9999' })));
            await assertFails(sendAs(actor, rateNote(actor, 'staff1', { tab: 'settings' })));
            await assertFails(sendAs(actor, rateNote(actor, 'staff1', { rateType: 'secret' })));
            await assertFails(sendAs(actor, rateNote(actor, 'staff1', { newRate: 'free' })));
            await assertFails(sendAs(actor, rateNote(actor, 'staff1', { action: 'added' })));
            await assertFails(sendAs(actor, itemNote(actor, 'owner2', { action: 'deleted' })));
            await assertFails(sendAs(actor, itemNote(actor, 'owner2', { fields: ['password'] })));
            await assertFails(sendAs(actor, itemNote(actor, 'owner2', { oldRate: 1 })));
            // already read, client time, to themselves, no recipient
            await assertFails(sendAs(actor, rateNote(actor, 'staff1', { read: true })));
            await assertFails(sendAs(actor, rateNote(actor, 'staff1', { timestamp: Date.now() })));
            await assertFails(sendAs(actor, rateNote(actor, actor)));
            await assertFails(sendAs(actor, rateNote(actor, '')));
            // doc id must be <eventKey>_<userId>
            await assertFails(as(actor).collection(notifications).doc('rate-1-sale_owner2').set(rateNote(actor, 'staff1')));
        }
    });

    t('notifications: the recipient marks them read; nothing else changes', async () => {
        await seedBill(notifications, 'n1', { ...rateNote('manager1', 'staff1'), timestamp: 1 });
        const mine = as('staff1').collection(notifications).doc('n1');
        await assertSucceeds(mine.update({ read: true, readAt: Date.now() }));
        await assertFails(mine.update({ read: false, newRate: 1 }));
        await assertFails(mine.update({ userId: 'manager1' }));
        await assertFails(mine.update({ readAt: 'now' }));
        await assertFails(mine.set({ ...rateNote('manager1', 'staff1'), timestamp: 1, read: true }));
        // markAllNotificationsRead: batched
        await seedBill(notifications, 'n2', { ...itemNote('manager1', 'staff1'), timestamp: 2 });
        const db = as('staff1');
        const batch = db.batch();
        ['n1', 'n2'].forEach(id => batch.update(db.collection(notifications).doc(id), { read: true, readAt: Date.now() }));
        await assertSucceeds(batch.commit());
    });

    t('notifications: nobody changes another user\'s notification, the owner included', async () => {
        await seedBill(notifications, 'n1', { ...rateNote('manager1', 'staff1'), timestamp: 1 });
        for (const uid of ['legacyStaff', 'manager1', 'legacyOwner']) {
            const ref = as(uid).collection(notifications).doc('n1');
            await assertFails(ref.update({ read: true, readAt: Date.now() }));
            await assertFails(ref.update({ userId: uid }));
            await assertFails(ref.update({ itemName: 'Chawal' }));
        }
        // re-sending over an existing doc is an update: refused too
        await assertSucceeds(sendAs('manager1', rateNote('manager1', 'staff1', { eventKey: 'x' })));
        await assertFails(sendAs('manager1', rateNote('manager1', 'staff1', { eventKey: 'x', newRate: 99 })));
    });

    t('notifications: deleted by the recipient (old-notification cleanup) or the owner only', async () => {
        await seedBill(notifications, 'n1', { ...rateNote('manager1', 'staff1'), timestamp: 1 });
        await seedBill(notifications, 'n2', { ...rateNote('manager1', 'staff1'), timestamp: 1 });
        await seedBill(notifications, 'n3', { ...rateNote('manager1', 'staff1'), timestamp: 1 });
        await assertFails(as('legacyStaff').collection(notifications).doc('n1').delete());
        await assertFails(as('manager1').collection(notifications).doc('n1').delete());
        await assertSucceeds(as('staff1').collection(notifications).doc('n1').delete());
        await assertSucceeds(as('legacyOwner').collection(notifications).doc('n2').delete());
        // the recipient's batched cleanup
        const db = as('staff1');
        const batch = db.batch();
        batch.delete(db.collection(notifications).doc('n3'));
        await assertSucceeds(batch.commit());
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

// ---- Read matrix (#57, #18): every role × collection, get and list ----
// docs/role-permissions.md "Server-side read rules".
const READ_ROLES = {
    owner: 'legacyOwner', manager: 'manager1', member: 'staff1', legacyMember: 'legacyStaff',
    rentMember: 'rentMember', rentalsOnly: 'rentOnly', pending: 'pending1', rejected: 'rejected1',
    noRole: 'noRole', noProfile: 'ghost', anon: null
};
const OWNER = ['owner'];
const MANAGERS = ['owner', 'manager'];
const APPROVED = ['owner', 'manager', 'member', 'legacyMember', 'rentMember'];
const RENTALS = ['owner', 'rentMember', 'rentalsOnly'];
const EVERYONE = Object.keys(READ_ROLES);
const SIGNED_IN = EVERYONE.filter(r => r !== 'anon');
const dbFor = (role) => (READ_ROLES[role] ? as(READ_ROLES[role]) : anon());

function defineReadMatrix(prefix) {
    const c = (name) => `${prefix}${name}`;
    const seedDocs = (docs) => env.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        for (const [path, data] of docs) await db.doc(path).set(data);
    });
    // One test per case: `get`/`list` build the request for a role (uid may be null);
    // the arrays name the roles that are allowed, every other role must be refused.
    const cases = [];
    const add = (name, spec) => cases.push({ name, ...spec });

    const shared = ['purchases', 'retailSales', 'wholesaleSales', 'items', 'expenses', 'stockAdjustments',
        'cashManagement', 'itemFrequency', 'counters', 'stockCheckpoints', 'personalExpenseDays'];
    shared.forEach(name => add(name, {
        seed: [[`${c(name)}/d1`, { userId: 'manager1', timestamp: 1, date: '2026-10-01' }]],
        get: (db) => db.collection(c(name)).doc('d1').get(), getAllowed: APPROVED,
        list: (db) => db.collection(c(name)).get(), listAllowed: APPROVED
    }));
    const personalRow = [`${c('personalExpenses')}/d1`, { userId: 'manager1', timestamp: 1, date: '2026-10-01', category: 'personal' }];
    add('personalExpenses (switch on, the default)', {
        seed: [personalRow],
        get: (db) => db.collection(c('personalExpenses')).doc('d1').get(), getAllowed: APPROVED,
        list: (db) => db.collection(c('personalExpenses')).get(), listAllowed: APPROVED
    });
    add('personalExpenses (members switched off)', {
        seed: [personalRow, [`${c('settings')}/app`, { roleAccess: { staff: { personalExpenses: false } } }]],
        get: (db) => db.collection(c('personalExpenses')).doc('d1').get(), getAllowed: MANAGERS,
        list: (db) => db.collection(c('personalExpenses')).get(), listAllowed: MANAGERS
    });
    add('settings/app', {
        seed: [[`${c('settings')}/app`, { minClientVersion: 3 }], [`${c('settings')}/other`, { a: 1 }]],
        get: (db) => db.collection(c('settings')).doc('app').get(), getAllowed: APPROVED,
        list: (db) => db.collection(c('settings')).get(), listAllowed: OWNER
    });
    add('settings (other docs)', {
        seed: [[`${c('settings')}/other`, { a: 1 }]],
        get: (db) => db.collection(c('settings')).doc('other').get(), getAllowed: OWNER,
        list: (db) => db.collection(c('settings')).where('a', '==', 1).get(), listAllowed: OWNER
    });
    ['notifications', 'drafts'].forEach(name => {
        add(`${name}: own (query on userId)`, {
            seed: [[`${c(name)}/n-staff`, { userId: 'staff1', read: false, timestamp: 1 }]],
            get: (db) => db.collection(c(name)).doc('missing').get(), getAllowed: APPROVED,
            list: (db, uid) => db.collection(c(name)).where('userId', '==', uid || 'x').get(), listAllowed: APPROVED
        });
        add(`${name}: another user's`, {
            seed: [[`${c(name)}/n-staff`, { userId: 'staff1', read: false, timestamp: 1 }]],
            get: (db) => db.collection(c(name)).doc('n-staff').get(), getAllowed: ['owner', 'member'],
            list: (db) => db.collection(c(name)).get(), listAllowed: OWNER
        });
    });
    add('autoSaves', {
        seed: [[`${c('autoSaves')}/staff1`, { userId: 'staff1' }]],
        get: (db) => db.collection(c('autoSaves')).doc('staff1').get(), getAllowed: ['owner', 'member'],
        list: (db) => db.collection(c('autoSaves')).get(), listAllowed: OWNER
    });
    add('autoSaves: own document', {
        seed: [],
        get: (db, uid) => db.collection(c('autoSaves')).doc(uid || 'x').get(), getAllowed: APPROVED,
        list: (db, uid) => db.collection(c('autoSaves')).where(firebase.firestore.FieldPath.documentId(), '==', uid || 'x').get(),
        listAllowed: APPROVED
    });
    const withdrawal = [`${c('withdrawals')}/w1`, { amount: 100, userId: 'manager1', timestamp: 1, date: '2026-10-01' }];
    const appWith = (roleAccess) => [`${c('settings')}/app`, { roleAccess }];
    const wGet = (db) => db.collection(c('withdrawals')).doc('w1').get();
    const wList = (db) => db.collection(c('withdrawals')).where('timestamp', '>=', 0).orderBy('timestamp', 'desc').get();
    add('withdrawals: default access (managers yes, members no)', {
        seed: [withdrawal], get: wGet, getAllowed: MANAGERS, list: wList, listAllowed: MANAGERS
    });
    for (const perm of ['finance', 'reports', 'analytics']) {
        add(`withdrawals: members with ${perm} on`, {
            seed: [withdrawal, appWith({ staff: { [perm]: true } })],
            get: wGet, getAllowed: APPROVED, list: wList, listAllowed: APPROVED
        });
    }
    add('withdrawals: managers with Money, Statements and Insights off', {
        seed: [withdrawal, appWith({ manager: { finance: false, reports: false, analytics: false }, staff: { finance: false } })],
        get: wGet, getAllowed: OWNER, list: wList, listAllowed: OWNER
    });
    add('cashSessions (legacy)', {
        seed: [[`${c('cashSessions')}/s1`, { userId: 'staff1' }]],
        get: (db) => db.collection(c('cashSessions')).doc('s1').get(), getAllowed: MANAGERS,
        list: (db) => db.collection(c('cashSessions')).get(), listAllowed: MANAGERS
    });
    add('users: own profile', {
        seed: [],
        get: (db, uid) => db.collection(c('users')).doc(uid || 'x').get(), getAllowed: SIGNED_IN,
        list: (db, uid) => db.collection(c('users')).where(firebase.firestore.FieldPath.documentId(), '==', uid || 'x').get(),
        listAllowed: SIGNED_IN
    });
    add('users: other profiles', {
        seed: [],
        get: (db) => db.collection(c('users')).doc('legacyStaff').get(), getAllowed: ['owner', 'manager', 'legacyMember'],
        list: (db) => db.collection(c('users')).get(), listAllowed: MANAGERS
    });
    add('users: preferences', {
        seed: [[`${c('users')}/staff1/preferences/ui`, { a: 1 }]],
        get: (db) => db.collection(c('users')).doc('staff1').collection('preferences').doc('ui').get(), getAllowed: ['member'],
        list: (db) => db.collection(c('users')).doc('staff1').collection('preferences').get(), listAllowed: ['member']
    });
    add('auditLogs', {
        seed: [[`${c('auditLogs')}/a1`, { action: 'X', userId: 'staff1', timestamp: 1 }]],
        get: (db) => db.collection(c('auditLogs')).doc('a1').get(), getAllowed: OWNER,
        list: (db) => db.collection(c('auditLogs')).where('timestamp', '>=', 0).orderBy('timestamp', 'desc').limit(300).get(),
        listAllowed: OWNER
    });
    add('telemetry', {
        seed: [[`${c('telemetry')}/t1`, { userId: 'staff1', fingerprint: 'f', count: 1 }]],
        get: (db) => db.collection(c('telemetry')).doc('t1').get(), getAllowed: OWNER,
        list: (db) => db.collection(c('telemetry')).get(), listAllowed: OWNER
    });
    ['tipHealth', 'tipFailures', 'anomalies', 'rateStats', 'monthStats', 'rateHistory'].forEach(name => add(name, {
        seed: [[`${c(name)}/d1`, { a: 1 }]],
        get: (db) => db.collection(c(name)).doc('d1').get(), getAllowed: MANAGERS,
        list: (db) => db.collection(c(name)).get(), listAllowed: MANAGERS
    }));
    ['rent_properties', 'rent_units', 'rent_tenants', 'rent_leases', 'rent_charges', 'rent_settings', 'rent_receipts', 'rent_counters'].forEach(name => add(name, {
        seed: [[`${c(name)}/d1`, { archived: false }]],
        get: (db) => db.collection(c(name)).doc('d1').get(), getAllowed: RENTALS,
        list: (db) => db.collection(c(name)).get(), listAllowed: RENTALS
    }));
    add('rent_public (tenant link)', {
        seed: [[`${c('rent_public')}/tok`, { lid: 'L1', v: 1 }]],
        get: (db) => db.collection(c('rent_public')).doc('tok').get(), getAllowed: EVERYONE,
        list: (db) => db.collection(c('rent_public')).get(), listAllowed: []
    });
    add('unknown collection', {
        seed: [[`${c('somethingElse')}/d1`, { a: 1 }]],
        get: (db) => db.collection(c('somethingElse')).doc('d1').get(), getAllowed: [],
        list: (db) => db.collection(c('somethingElse')).get(), listAllowed: []
    });

    for (const k of cases) {
        test(`[${prefix || 'prod'}] read matrix: ${k.name}`, async () => {
            await seedDocs(k.seed);
            const wrong = [];
            for (const role of EVERYONE) {
                for (const [kind, run, allowed] of [['get', k.get, k.getAllowed], ['list', k.list, k.listAllowed]]) {
                    const expectOk = allowed.includes(role);
                    try {
                        await (expectOk ? assertSucceeds : assertFails)(run(dbFor(role), READ_ROLES[role]));
                    } catch (e) {
                        wrong.push(`${role} ${kind} should be ${expectOk ? 'allowed' : 'denied'}`);
                    }
                }
            }
            if (wrong.length) throw new Error(wrong.join('; '));
        });
    }
}

defineReadMatrix('');
defineReadMatrix('dev_');

// ---- Rentals (#170): rent_* collections, roles per business (#149) ----
// Months relative to "now" in IST, as the rules compute them.
const istMonth = (offset = 0) => {
    const d = new Date(Date.now() + 330 * MIN);
    const idx = d.getUTCFullYear() * 12 + d.getUTCMonth() + offset;
    return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
};

function defineRentSuite(prefix) {
    const t = (name, fn) => test(`[${prefix || 'prod'} rentals] ${name}`, fn);
    const c = (name) => `${prefix}${name}`;
    const RENT = ['rent_properties', 'rent_units', 'rent_tenants', 'rent_leases', 'rent_charges'].map(c);
    const CUR = istMonth(0);
    const PREV = istMonth(-1);
    const PREV2 = istMonth(-2);
    const seed = (coll, id, data) => env.withSecurityRulesDisabled((ctx) => ctx.firestore().collection(c(coll)).doc(id).set(data));
    const meta = (uid) => ({ archived: false, createdAt: 1, createdBy: uid, updatedAt: 1, updatedBy: uid });
    const lease = (over = {}) => ({ unitId: 'U1', propertyId: 'P1', tenantId: 'T1', rent: 5000, dueDay: 10, startMonth: PREV, endMonth: null,
        deposit: 10000, status: 'active', chargedThrough: null, increasePct: 5, rentSince: PREV, ...meta('legacyOwner'), ...over });
    const unit = (over = {}) => ({ propertyId: 'P1', label: 'G1', type: 'flat', rent: 5000, leaseId: 'L1', lastReading: null, meterRate: null, meterCharge: null, ...meta('legacyOwner'), ...over });
    const charge = (month, over = {}) => ({ leaseId: 'L1', unitId: 'U1', propertyId: 'P1', tenantId: 'T1', tenantName: 'Ram', unitLabel: 'G1',
        month, dueDay: 10, rent: 5000, electricity: null, amount: 5000, paid: 0, open: true, payments: [], createdAt: 1, updatedAt: 1, updatedBy: 'x', ...over });
    const entry = (uid, amount) => ({ amount, mode: 'cash', ref: '', date: '2026-10-05', at: 2, by: uid, byName: 'x' });
    const pay = (uid, amount, paid = amount) => ({ paid, open: paid < 5000, updatedAt: 2, updatedBy: uid, payments: [entry(uid, amount)] });
    const db = (uid) => as(uid);
    const chargeOn = (f, month) => f.collection(c('rent_charges')).doc(`L1_${month}`);
    const leaseOn = (f) => f.collection(c('rent_leases')).doc('L1');
    const unitOn = (f) => f.collection(c('rent_units')).doc('U1');
    const chargeRef = (uid, month) => chargeOn(db(uid), month);
    const leaseRef = (uid) => leaseOn(db(uid));
    const unitRef = (uid) => unitOn(db(uid));
    // One write: charge for `month` + lease chargedThrough -> `through` (as chargeLease does).
    const step = (uid, ch, through) => {
        const f = db(uid);
        const b = f.batch();
        b.set(chargeOn(f, ch.month), ch);
        b.update(leaseOn(f), { chargedThrough: through, updatedAt: 2, updatedBy: uid });
        return b.commit();
    };
    // One write: end the lease (and optionally delete later charges, free the unit).
    const moveOut = (uid, endMonth, { del = [], freeUnit = true } = {}) => {
        const f = db(uid);
        const b = f.batch();
        del.forEach(m => b.delete(chargeOn(f, m)));
        b.update(leaseOn(f), { status: 'ended', endMonth, chargedThrough: endMonth, updatedAt: 2, updatedBy: uid });
        if (freeUnit) b.update(unitOn(f), { leaseId: null, updatedAt: 2, updatedBy: uid });
        return b.commit();
    };
    const elec = (prev, curr, rate) => ({ prev, curr, rate, units: curr - prev, amount: (curr - prev) * rate });
    const meterWrite = (uid, e, { unitUpdate = true, month = CUR, paid = 0 } = {}) => {
        const f = db(uid);
        const b = f.batch();
        b.update(chargeOn(f, month), { electricity: e, amount: 5000 + e.amount, open: paid < 5000 + e.amount, updatedAt: 2, updatedBy: uid });
        if (unitUpdate) b.update(unitOn(f), { lastReading: e.curr, meterRate: e.rate, meterCharge: `L1_${month}`, updatedAt: 2, updatedBy: uid });
        return b.commit();
    };

    t('shop member and manager without a rentals role read nothing', async () => {
        for (const coll of RENT) {
            await assertFails(as('staff1').collection(coll).get());
            await assertFails(as('manager1').collection(coll).doc('x').get());
        }
        await assertFails(as('rentPending').collection(c('rent_units')).get());
        await assertFails(anon().collection(c('rent_units')).get());
    });

    t('owner and rentals roles read; rentals-only helper reads no shop data', async () => {
        for (const uid of ['legacyOwner', 'rentManager', 'rentMember', 'rentOnly']) {
            await assertSucceeds(as(uid).collection(c('rent_units')).where('archived', '==', false).get());
        }
        await assertFails(as('rentOnly').collection(`${prefix}purchases`).get());
        await assertFails(as('rentOnly').collection(`${prefix}items`).get());
        await assertFails(as('rentOnly').collection(`${prefix}expenses`).get());
    });

    t('any rentals role adds records signed with its uid; a lease takes its unit in the same write', async () => {
        const prop = { name: 'Gali 2', address: 'Main road', kind: 'house', notes: '', ...meta('rentMember') };
        await assertSucceeds(db('rentMember').collection(c('rent_properties')).doc('P1').set(prop));
        await assertSucceeds(db('rentOnly').collection(c('rent_units')).doc('U1').set(unit({ ...meta('rentOnly'), leaseId: null })));
        await assertFails(db('rentOnly').collection(c('rent_units')).doc('U2').set(unit({ ...meta('rentOnly'), leaseId: 'L9' })));
        await assertSucceeds(db('rentManager').collection(c('rent_tenants')).doc('T1').set({ name: 'Ram', phone: '9876543210', notes: '', ...meta('rentManager') }));
        await assertFails(leaseRef('rentMember').set(lease(meta('rentMember'))));
        const f = db('rentMember');
        const b = f.batch();
        b.set(leaseOn(f), lease({ ...meta('rentMember'), startMonth: CUR, rentSince: CUR, startDate: today }));
        b.update(unitOn(f), { leaseId: 'L1', updatedAt: 2, updatedBy: 'rentMember' });
        await assertSucceeds(b.commit());
        await assertFails(db('rentMember').collection(c('rent_properties')).doc('P2').set({ ...prop, updatedBy: 'someoneElse' }));
        await assertFails(db('staff1').collection(c('rent_tenants')).doc('T2').set({ name: 'X', phone: '', notes: '', ...meta('staff1') }));
    });

    t('shape checks: bad kind, negative rent, due day 29, bad month, bad %, extra field, lease born with charges or ended', async () => {
        const m = meta('rentManager');
        await assertFails(db('rentManager').collection(c('rent_properties')).doc('P').set({ name: 'A', address: '', kind: 'castle', notes: '', ...m }));
        await assertFails(db('rentManager').collection(c('rent_units')).doc('U').set(unit({ ...m, leaseId: null, rent: -1 })));
        for (const bad of [{ dueDay: 29 }, { startMonth: '2026-13' }, { increasePct: 150 }, { chargedThrough: '2099-01' }, { status: 'ended', endMonth: PREV }]) {
            await assertFails(db('rentManager').collection(c('rent_leases')).doc('L').set(lease({ ...m, unitId: 'U', ...bad })));
        }
        await assertFails(db('rentManager').collection(c('rent_tenants')).doc('T').set({ name: 'A', phone: '', notes: '', hack: 1, ...m }));
    });

    t('charges: one month per write, in order, at the lease rent, never skipping or in the future', async () => {
        await seed('rent_leases', 'L1', lease({ startMonth: PREV2 }));
        await assertFails(chargeRef('rentMember', PREV2).set(charge(PREV2, { updatedBy: 'rentMember' })));
        await assertFails(step('rentMember', charge(PREV, { updatedBy: 'rentMember' }), PREV));
        await assertFails(step('rentMember', charge(PREV2, { amount: 1, rent: 1, updatedBy: 'rentMember' }), PREV2));
        await assertFails(step('rentMember', charge(PREV2, { paid: 100, updatedBy: 'rentMember' }), PREV2));
        await assertFails(step('staff1', charge(PREV2, { updatedBy: 'staff1' }), PREV2));
        await assertSucceeds(step('rentMember', charge(PREV2, { updatedBy: 'rentMember' }), PREV2));
        // Review attack: jump from PREV2 to CUR creating only CUR (skips PREV).
        await assertFails(step('rentMember', charge(CUR, { updatedBy: 'rentMember' }), CUR));
        const f = db('rentMember');
        const two = f.batch();
        two.set(chargeOn(f, PREV), charge(PREV, { updatedBy: 'rentMember' }));
        two.set(chargeOn(f, CUR), charge(CUR, { updatedBy: 'rentMember' }));
        two.update(leaseOn(f), { chargedThrough: CUR, updatedAt: 2, updatedBy: 'rentMember' });
        await assertFails(two.commit());
        await assertSucceeds(step('rentOnly', charge(PREV, { updatedBy: 'rentOnly' }), PREV));
        await assertSucceeds(step('rentMember', charge(CUR, { updatedBy: 'rentMember' }), CUR));
        const next = istMonth(1);
        await assertFails(step('rentMember', charge(next, { updatedBy: 'rentMember' }), next));
        // Review attack: chargedThrough to 2099 or to a month without a charge.
        await assertFails(leaseRef('rentMember').update({ chargedThrough: '2099-01', updatedAt: 3, updatedBy: 'rentMember' }));
        await assertSucceeds(leaseRef('rentMember').update({ rent: 5250, rentSince: next, updatedAt: 3, updatedBy: 'rentMember' }));
    });

    t('review attack (High): a member cannot delete unpaid months and keep the lease active', async () => {
        await seed('rent_units', 'U1', unit());
        await seed('rent_leases', 'L1', lease({ chargedThrough: CUR }));
        await seed('rent_charges', `L1_${PREV}`, charge(PREV));
        await seed('rent_charges', `L1_${CUR}`, charge(CUR));
        await assertFails(chargeRef('rentMember', CUR).delete());
        await assertFails(moveOut('rentMember', PREV, { del: [CUR] }));
        await assertFails(moveOut('rentMember', CUR, { freeUnit: false }));
        await assertSucceeds(moveOut('rentMember', CUR));
        // Ended is final: the lease can't come back to active or move its months.
        await assertFails(leaseRef('rentMember').update({ status: 'active', endMonth: null, updatedAt: 3, updatedBy: 'rentMember' }));
        await assertFails(leaseRef('rentManager').update({ endMonth: PREV, chargedThrough: PREV, updatedAt: 3, updatedBy: 'rentManager' }));
        // Outside a move-out write nobody but the owner deletes a charge.
        await assertFails(chargeRef('rentManager', CUR).delete());
        await assertFails(unitRef('rentMember').update({ leaseId: 'L1', updatedAt: 3, updatedBy: 'rentMember' }));
    });

    t('back-dated move-out: owner/manager only, deletes unpaid later months, blocked by a paid one', async () => {
        await seed('rent_units', 'U1', unit());
        await seed('rent_leases', 'L1', lease({ chargedThrough: CUR }));
        await seed('rent_charges', `L1_${PREV}`, charge(PREV));
        await seed('rent_charges', `L1_${CUR}`, charge(CUR, { paid: 100, payments: [entry('rentMember', 100)] }));
        await assertFails(moveOut('rentManager', PREV, { del: [CUR] }));
        await seed('rent_charges', `L1_${CUR}`, charge(CUR));
        await assertFails(moveOut('rentManager', PREV));
        await assertFails(moveOut('rentManager', istMonth(1)));
        await assertSucceeds(moveOut('rentManager', PREV, { del: [CUR] }));
    });

    t('a unit lease link is cleared only when that lease ends', async () => {
        await seed('rent_units', 'U1', unit());
        await seed('rent_leases', 'L1', lease({ chargedThrough: CUR }));
        await assertFails(unitRef('rentMember').update({ leaseId: null, updatedAt: 2, updatedBy: 'rentMember' }));
        await assertSucceeds(unitRef('rentMember').update({ label: 'G1 front', updatedAt: 2, updatedBy: 'rentMember' }));
        await assertFails(unitRef('rentMember').update({ createdAt: 99, updatedAt: 2, updatedBy: 'rentMember' }));
    });

    t('payments: one own entry, paid grows by it, never above the amount, at most 12', async () => {
        await seed('rent_charges', `L1_${CUR}`, charge(CUR));
        const ref = (uid) => chargeRef(uid, CUR);
        await assertFails(ref('rentMember').update(pay('rentMember', 2000, 2500)));
        await assertFails(ref('rentMember').update(pay('someoneElse', 2000)));
        await assertFails(ref('rentMember').update(pay('rentMember', 6000)));
        await assertFails(ref('rentMember').update({ ...pay('rentMember', 2000), amount: 2000 }));
        await assertFails(ref('rentMember').update({ ...pay('rentMember', 2000), open: false }));
        await assertFails(ref('rentMember').update({ ...pay('rentMember', 2000), updatedBy: 'someoneElse' }));
        await assertSucceeds(ref('rentMember').update(pay('rentMember', 2000)));
        await assertSucceeds(ref('rentOnly').update({
            paid: 5000, open: false, updatedAt: 3, updatedBy: 'rentOnly', payments: [entry('rentMember', 2000), entry('rentOnly', 3000)]
        }));
        await assertFails(ref('staff1').update({
            paid: 5000, open: false, updatedAt: 4, updatedBy: 'staff1', payments: [entry('rentMember', 2000), entry('rentOnly', 3000), entry('staff1', 0.5)]
        }));
        const twelve = Array.from({ length: 12 }, () => entry('rentMember', 100));
        await seed('rent_charges', `L1_${CUR}`, charge(CUR, { paid: 1200, payments: twelve }));
        await assertFails(ref('rentMember').update({ paid: 1300, open: true, updatedAt: 5, updatedBy: 'rentMember', payments: [...twelve, entry('rentMember', 100)] }));
    });

    t('electricity: previous = the last reading, unit rate for members, unit updated with it, re-entry owner/manager only', async () => {
        await seed('rent_units', 'U1', unit({ lastReading: 100, meterRate: 8 }));
        await seed('rent_leases', 'L1', lease({ chargedThrough: CUR }));
        await seed('rent_charges', `L1_${CUR}`, charge(CUR, { paid: 1000, payments: [entry('rentMember', 1000)] }));
        await assertFails(meterWrite('rentMember', elec(90, 150, 8), { paid: 1000 }));
        await assertFails(meterWrite('rentMember', elec(100, 150, 10), { paid: 1000 }));
        await assertFails(meterWrite('rentMember', elec(100, 150, 8), { paid: 1000, unitUpdate: false }));
        await assertFails(meterWrite('staff1', elec(100, 150, 8), { paid: 1000 }));
        await assertFails(chargeRef('rentMember', CUR).update({ electricity: elec(100, 150, 8), amount: 9999, open: true, updatedAt: 2, updatedBy: 'rentMember' }));
        await assertSucceeds(meterWrite('rentMember', elec(100, 150, 8), { paid: 1000 }));
        // Re-entry with a lower reading: members can't, owner/manager can (same previous).
        await assertFails(meterWrite('rentOnly', elec(100, 101, 8), { paid: 1000 }));
        await assertFails(meterWrite('rentManager', elec(140, 160, 8), { paid: 1000 }));
        await assertSucceeds(meterWrite('rentManager', elec(100, 160, 9), { paid: 1000 }));
        // The unit's reading moves only with a meter write; a manager may set the rate alone.
        await assertFails(unitRef('rentMember').update({ lastReading: 0, updatedAt: 3, updatedBy: 'rentMember' }));
        await assertFails(unitRef('rentMember').update({ meterRate: 1, updatedAt: 3, updatedBy: 'rentMember' }));
        await assertSucceeds(unitRef('rentManager').update({ meterRate: 9.5, updatedAt: 3, updatedBy: 'rentManager' }));
    });

    t('owner/manager corrections: payments kept or one own entry added, paid = Σ entries, creation fixed', async () => {
        await seed('rent_charges', `L1_${CUR}`, charge(CUR, { paid: 3000, payments: [entry('rentMember', 2000), entry('rentOnly', 1000)] }));
        const ref = chargeRef('rentManager', CUR);
        await assertFails(chargeRef('rentMember', CUR).update({ amount: 4000, updatedBy: 'rentMember' }));
        await assertSucceeds(ref.update({ amount: 4000, updatedBy: 'rentManager' }));
        // Review attack: rewrite the payments history / paid, or the electricity.
        await assertFails(ref.update({ payments: [entry('rentMember', 2000)], paid: 2000, updatedBy: 'rentManager' }));
        await assertFails(ref.update({ paid: 0, updatedBy: 'rentManager' }));
        await assertFails(ref.update({ payments: [entry('rentMember', 2000), entry('rentOnly', 1000), entry('rentMember', 500)], paid: 3500, updatedBy: 'rentManager' }));
        await assertSucceeds(ref.update({ payments: [entry('rentMember', 2000), entry('rentOnly', 1000), entry('rentManager', 500)], paid: 3500, updatedBy: 'rentManager' }));
        await assertFails(ref.update({ electricity: elec(0, 10, 1), updatedBy: 'rentManager' }));
        await assertFails(ref.update({ createdAt: 99, updatedBy: 'rentManager' }));
        await assertFails(ref.update({ month: istMonth(1), updatedBy: 'rentManager' }));
    });

    t('audit: rentals roles (also rentals-only) write RENT_* entries; nothing else without a shop role', async () => {
        const log = (uid, action) => as(uid).collection(`${prefix}auditLogs`).add({
            action, userId: uid, userName: 'x', userRole: 'none', details: { leaseId: 'L1' },
            timestamp: Date.now(), date: new Date().toISOString(), serverTime: serverTimestamp()
        });
        await assertSucceeds(log('rentOnly', 'RENT_PAYMENT'));
        await assertSucceeds(log('rentMember', 'RENT_METER'));
        await assertFails(log('rentOnly', 'CREATE_BILL'));
        await assertFails(log('rentPending', 'RENT_PAYMENT'));
    });

    // ---- tenant rent-history link: rent_public/{token} ----
    const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWx';
    const TOKEN2 = 'ZyXwVuTsRqPoNmLkJiHgFeDc';
    const snap = (over = {}) => ({ lid: 'L1', v: 1, shop: 'Shop', tenant: 'Ram', place: 'Gali 2 · G1', rent: 5000, dueDay: 10,
        ended: false, endMonth: null, months: [{ m: CUR, rent: 5000, elec: 0, units: 0, total: 5000, paid: 0, due: 5000, st: 'due', pd: [] }],
        updatedAt: 1, ...over });
    const pubOn = (f, tok) => f.collection(c('rent_public')).doc(tok);

    t('link: anyone gets the exact token (one doc); nobody lists; an unknown token is just missing', async () => {
        await seed('rent_public', TOKEN, snap());
        const got = await assertSucceeds(anon().collection(c('rent_public')).doc(TOKEN).get());
        if (!got.exists || got.data().tenant !== 'Ram') throw new Error('snapshot not readable');
        const miss = await assertSucceeds(anon().collection(c('rent_public')).doc(TOKEN2).get());
        if (miss.exists) throw new Error('unknown token found');
        await assertFails(anon().collection(c('rent_public')).get());
        await assertFails(anon().collection(c('rent_public')).where('lid', '==', 'L1').get());
        await assertFails(as('rentMember').collection(c('rent_public')).limit(1).get());
        await assertFails(anon().collection(c('rent_public')).doc(TOKEN).set(snap()));
    });

    t('link: made by owner/manager with the lease token in the same write; members only keep it current', async () => {
        await seed('rent_leases', 'L1', lease({ chargedThrough: CUR }));
        await assertFails(pubOn(db('rentManager'), TOKEN).set(snap()));
        await assertFails(leaseRef('rentMember').update({ shareToken: TOKEN, updatedAt: 2, updatedBy: 'rentMember' }));
        const f = db('rentManager');
        const b = f.batch();
        b.set(pubOn(f, TOKEN), snap());
        b.update(leaseOn(f), { shareToken: TOKEN, updatedAt: 2, updatedBy: 'rentManager' });
        await assertSucceeds(b.commit());
        // A member keeps it current (payment, meter, new month) while the lease points at it.
        await assertSucceeds(pubOn(db('rentMember'), TOKEN).set(snap({ updatedAt: 3 })));
        await assertFails(pubOn(db('rentMember'), TOKEN).set(snap({ phone: '9876543210' })));
        await assertFails(pubOn(db('rentMember'), TOKEN).set(snap({ lid: 'L9' })));
        await assertFails(pubOn(db('rentMember'), TOKEN).set(snap({ months: Array(37).fill(snap().months[0]) })));
        await assertFails(pubOn(db('rentMember'), TOKEN2).set(snap()));
        await assertFails(pubOn(db('staff1'), TOKEN).set(snap({ updatedAt: 4 })));
        await assertFails(pubOn(db('rentMember'), 'short').set(snap()));
    });

    t('link: turned off or replaced only with the lease in the same write; members cannot', async () => {
        await seed('rent_leases', 'L1', lease({ chargedThrough: CUR, shareToken: TOKEN }));
        await seed('rent_public', TOKEN, snap());
        await assertFails(pubOn(db('rentManager'), TOKEN).delete());
        const off = (uid) => {
            const f = db(uid);
            const b = f.batch();
            b.delete(pubOn(f, TOKEN));
            b.update(leaseOn(f), { shareToken: null, updatedAt: 2, updatedBy: uid });
            return b.commit();
        };
        await assertFails(off('rentMember'));
        const f = db('rentManager');
        const swap = f.batch();
        swap.delete(pubOn(f, TOKEN));
        swap.set(pubOn(f, TOKEN2), snap());
        swap.update(leaseOn(f), { shareToken: TOKEN2, updatedAt: 2, updatedBy: 'rentManager' });
        await assertSucceeds(swap.commit());
        await assertFails(pubOn(db('rentMember'), TOKEN).set(snap()));
    });

    t('link: a payment updates the charge and the snapshot in one write', async () => {
        await seed('rent_leases', 'L1', lease({ chargedThrough: CUR, shareToken: TOKEN }));
        await seed('rent_public', TOKEN, snap());
        await seed('rent_charges', `L1_${CUR}`, charge(CUR));
        const f = db('rentOnly');
        const b = f.batch();
        b.update(chargeOn(f, CUR), pay('rentOnly', 2000));
        b.set(pubOn(f, TOKEN), snap({ months: [{ ...snap().months[0], paid: 2000, due: 3000, st: 'partial', pd: ['2026-10-05'] }], updatedAt: 5 }));
        await assertSucceeds(b.commit());
    });

    t('unit type (required on create), size and floor are checked; older units without a type still edit', async () => {
        const units = (uid) => db(uid).collection(c('rent_units'));
        const fresh = (over) => unit({ ...meta('rentMember'), leaseId: null, ...over });
        await assertSucceeds(units('rentMember').doc('UA').set(fresh({ type: 'commercial', area: 450, floor: 'Ground' })));
        await assertSucceeds(units('rentMember').doc('UB').set(fresh({ type: 'office', area: null, floor: null })));
        const { type: _t, ...noType } = fresh({});
        await assertFails(units('rentMember').doc('UC').set(noType));
        await assertFails(units('rentMember').doc('UD').set(fresh({ type: 'castle' })));
        for (const area of [0, -5, 2000000, '450']) await assertFails(units('rentMember').doc('UE').set(fresh({ area })));
        await assertFails(units('rentMember').doc('UF').set(fresh({ floor: 'x'.repeat(21) })));
        await assertFails(units('rentMember').doc('UF').set(fresh({ floor: '' })));
        const { type: _u, ...legacy } = unit({ leaseId: null });
        await seed('rent_units', 'UL', legacy);
        await assertSucceeds(units('rentMember').doc('UL').update({ label: 'G9', updatedAt: 2, updatedBy: 'rentMember' }));
        await assertFails(units('rentMember').doc('UL').update({ type: 'shop', updatedAt: 3, updatedBy: 'rentMember' }));
        await assertSucceeds(units('rentMember').doc('UL').update({ type: 'godown', area: 1200, floor: 'Basement', updatedAt: 3, updatedBy: 'rentMember' }));
        await assertFails(units('staff1').doc('UA').update({ type: 'flat', updatedAt: 4, updatedBy: 'staff1' }));
    });

    t('link: the unit type travels with the snapshot (known types only)', async () => {
        await seed('rent_leases', 'L1', lease({ chargedThrough: CUR, shareToken: TOKEN }));
        await assertSucceeds(pubOn(db('rentMember'), TOKEN).set(snap({ ut: 'commercial', place: 'Shop 3, Gupta Bhawan' })));
        await assertFails(pubOn(db('rentMember'), TOKEN).set(snap({ ut: 'castle' })));
    });

    // ---- Add unit with its tenant / move-in in one batch; start date; phone; electricity modes ----
    const today = (() => { const d = new Date(Date.now() + 330 * MIN); return `${CUR}-${String(d.getUTCDate()).padStart(2, '0')}`; })();
    const moveInBatch = (uid, { newUnit = true, newTenant = true, phone = '9876543210', rent = 6000, chargeAmount = rent, firstRent = null,
        startDate = today, startMonth = startDate.slice(0, 7), withCharge = true, unitLease = 'LN', extraLease = {}, touch = false } = {}) => {
        const f = db(uid);
        const b = f.batch();
        const m = meta(uid);
        if (newTenant) b.set(f.collection(c('rent_tenants')).doc('TN'), { name: 'Sita', phone, notes: '', ...m });
        if (touch) b.update(f.collection(c('rent_tenants')).doc('T1'), { updatedAt: 2, updatedBy: uid });
        const leaseDoc = { unitId: 'UN', propertyId: 'P1', tenantId: newTenant ? 'TN' : 'T1', rent, dueDay: 10, startMonth, startDate,
            proRate: firstRent != null, endMonth: null, deposit: 0, increasePct: 5, rentSince: startMonth, elecMode: 'own', meterNo: 'CN-1234',
            status: 'active', chargedThrough: withCharge ? startMonth : null, ...m, ...extraLease };
        if (firstRent != null) leaseDoc.firstRent = firstRent;
        if (withCharge) {
            b.set(f.collection(c('rent_charges')).doc(`LN_${startMonth}`), {
                leaseId: 'LN', unitId: 'UN', propertyId: 'P1', tenantId: leaseDoc.tenantId, tenantName: 'Sita', unitLabel: 'S1', month: startMonth,
                dueDay: 10, rent: chargeAmount, electricity: null, amount: chargeAmount, paid: 0, open: chargeAmount > 0, payments: [],
                createdAt: 1, updatedAt: 1, updatedBy: uid
            });
        }
        b.set(f.collection(c('rent_leases')).doc('LN'), leaseDoc);
        if (newUnit) {
            b.set(f.collection(c('rent_units')).doc('UN'), unit({ ...m, label: 'S1', type: 'commercial', leaseId: unitLease, lastReading: 1200, meterRate: 9 }));
        } else {
            b.update(f.collection(c('rent_units')).doc('UN'), { leaseId: 'LN', updatedAt: 2, updatedBy: uid });
        }
        return b.commit();
    };

    t('add unit with its tenant: unit, tenant, lease and first charge in one batch (any rentals role)', async () => {
        await assertSucceeds(moveInBatch('rentMember'));
        let got = null;
        await env.withSecurityRulesDisabled(async (ctx) => { got = (await ctx.firestore().collection(c('rent_leases')).doc('LN').get()).data(); });
        if (got.chargedThrough !== CUR || got.startDate !== today) throw new Error('lease not saved as sent');
    });

    t('add unit with tenant: rent mismatch, bad phone, date/month mismatch, unit without its lease are refused', async () => {
        await assertFails(moveInBatch('rentMember', { chargeAmount: 1 }));
        await assertFails(moveInBatch('rentMember', { phone: '12345' }));
        await assertFails(moveInBatch('rentMember', { phone: '+919876543210' }));
        await assertFails(moveInBatch('rentMember', { startMonth: PREV }));
        await assertFails(moveInBatch('rentMember', { unitLease: 'LX' }));
        await assertFails(moveInBatch('staff1'));
        await assertFails(moveInBatch('rentMember', { extraLease: { elecMode: 'solar' } }));
    });

    t('pro-rated first month: charge = firstRent (never above the rent); a future start has no charge yet', async () => {
        await assertFails(moveInBatch('rentManager', { firstRent: 7000 }));
        await assertFails(moveInBatch('rentManager', { firstRent: 3000, chargeAmount: 6000 }));
        await assertSucceeds(moveInBatch('rentManager', { firstRent: 3000, chargeAmount: 3000 }));
        await env.clearFirestore();
        await seedUsers(prefix ? 'dev_users' : 'users');
        // Members: the computed pro-rated value only (RENT-11), never e.g. 0.
        const fr = proRated(6000, today);
        await assertFails(moveInBatch('rentMember', { firstRent: 0, chargeAmount: 0 }));
        if (fr !== 3000) await assertFails(moveInBatch('rentMember', { firstRent: 3000, chargeAmount: 3000 }));
        await assertSucceeds(moveInBatch('rentMember', { firstRent: fr, chargeAmount: fr }));
        const next = istMonth(1);
        await env.clearFirestore();
        await seedUsers(prefix ? 'dev_users' : 'users');
        await assertFails(moveInBatch('rentMember', { startDate: `${next}-05`, withCharge: true }));
        await assertSucceeds(moveInBatch('rentMember', { startDate: `${next}-05`, withCharge: false }));
    });

    t('move an existing tenant into an existing vacant unit with the first charge in one batch', async () => {
        await seed('rent_units', 'UN', unit({ label: 'S1', leaseId: null }));
        await seed('rent_tenants', 'T1', { name: 'Ram', phone: '9876543210', notes: '', ...meta('x') });
        await assertSucceeds(moveInBatch('rentOnly', { newUnit: false, newTenant: false }));
    });

    t('tenant form move-in (assignUnit): the tenant is touched in the same write', async () => {
        await seed('rent_units', 'UN', unit({ label: 'S1', leaseId: null }));
        await seed('rent_tenants', 'T1', { name: 'Ram', phone: '9876543210', notes: '', ...meta('x') });
        await assertFails(moveInBatch('staff1', { newUnit: false, newTenant: false, touch: true }));
        await assertSucceeds(moveInBatch('rentMember', { newUnit: false, newTenant: false, touch: true }));
        await env.clearFirestore();
        await seedUsers(prefix ? 'dev_users' : 'users');
        await seed('rent_tenants', 'T1', { name: 'Ram', phone: '9876543210', notes: '', ...meta('x') });
        await assertSucceeds(moveInBatch('rentMember', { newTenant: false, touch: true }));
    });

    t('a lease names an existing tenant and its unit\'s property', async () => {
        await seed('rent_units', 'UN', unit({ label: 'S1', leaseId: null }));
        await assertFails(moveInBatch('rentManager', { newUnit: false, newTenant: false }));
        await assertFails(moveInBatch('rentManager', { newUnit: false, withCharge: false, extraLease: { propertyId: 'P9' } }));
        await assertSucceeds(moveInBatch('rentManager', { newUnit: false, withCharge: false }));
    });

    // ---- Change of unit (tenant form, rent-store assignUnit): old lease ends, new one starts, one write ----
    const istDate = (daysAgo) => new Date(Date.now() + 330 * MIN - daysAgo * DAY).toISOString().slice(0, 10);
    const seedChange = async (month, destLease = null, { through = month, token = null } = {}) => {
        await seed('rent_tenants', 'T1', { name: 'Ram', phone: '9876543210', notes: '', ...meta('x') });
        await seed('rent_units', 'U1', unit());
        await seed('rent_units', 'U2', unit({ label: 'G2', leaseId: destLease }));
        await seed('rent_leases', 'L1', lease({ startMonth: istMonth(-6), rentSince: istMonth(-6), chargedThrough: through, shareToken: token }));
        for (const m of [month, through]) await seed('rent_charges', `L1_${m}`, charge(m));
        if (token) await seed('rent_public', token, snap());
    };
    // As assignUnit: the new lease's first month is charged right after (chargeLease), not in this write.
    // carry: the token the new lease takes (the old one clears its own unless clear=false; the snapshot moves to LN);
    // split: the old lease's move month {rent, amount} (RENT-13).
    const changeUnit = (uid, { date = today, unitId = 'U2', propertyId = 'P1', tenantId = 'T1', from = 'L1', freeOld = true, del = [], pub = '', endMonth = '',
        moved = 'LN', carry = '', clear = !!carry, split = null, first = null } = {}) => {
        const f = db(uid);
        const b = f.batch();
        const month = date.slice(0, 7);
        const end = endMonth || month;
        del.forEach(m => b.delete(chargeOn(f, m)));
        b.update(leaseOn(f), { status: 'ended', endMonth: end, chargedThrough: end, ...(moved ? { movedTo: moved } : {}),
            ...(clear ? { shareToken: null } : {}), updatedAt: 2, updatedBy: uid });
        if (pub) b.set(pubOn(f, pub), carry ? snap({ lid: 'LN', place: 'Gali 2 · G2' }) : snap({ ended: true, endMonth: end }));
        if (split) b.update(chargeOn(f, end), { rent: split.rent, amount: split.amount ?? split.rent, open: split.open ?? true, updatedAt: 2, updatedBy: uid });
        if (freeOld) b.update(unitOn(f), { leaseId: null, updatedAt: 2, updatedBy: uid });
        b.set(f.collection(c('rent_leases')).doc('LN'), { unitId, propertyId, tenantId, rent: 6000, dueDay: 10, startMonth: month, startDate: date,
            proRate: false, endMonth: null, deposit: 0, increasePct: 5, rentSince: month, elecMode: 'included', status: 'active',
            chargedThrough: null, fromLeaseId: from, ...(carry ? { shareToken: carry } : {}), ...(first != null ? { proRate: true, firstRent: first } : {}), ...meta(uid) });
        b.update(f.collection(c('rent_units')).doc(unitId), { leaseId: 'LN', updatedAt: 2, updatedBy: uid });
        return b.commit();
    };

    t('change of unit by a member, the old month already paid: the old charge is untouched and the new lease is pro-rated', async () => {
        await seedChange(CUR);
        await seed('rent_charges', `L1_${CUR}`, charge(CUR, { paid: 5000, open: false, payments: [entry('rentMember', 5000)] }));
        await assertFails(changeUnit('rentMember', { first: 7000 }));
        await assertFails(changeUnit('rentMember', { first: proRated(6000, today) - 2 }));
        await assertSucceeds(changeUnit('rentMember', { first: proRated(6000, today) }));
    });

    t('change of unit: old lease ends and the new one starts in one write; fromLeaseId stays fixed', async () => {
        await seedChange(CUR);
        await assertSucceeds(changeUnit('rentMember'));
        let got = null;
        await env.withSecurityRulesDisabled(async (ctx) => { got = (await ctx.firestore().collection(c('rent_leases')).doc('LN').get()).data(); });
        if (got.fromLeaseId !== 'L1') throw new Error('fromLeaseId not saved');
        await assertFails(db('rentManager').collection(c('rent_leases')).doc('LN').update({ fromLeaseId: 'L9', updatedAt: 3, updatedBy: 'rentManager' }));
        const f = db('rentMember');
        const b = f.batch();
        b.set(f.collection(c('rent_charges')).doc(`LN_${CUR}`), { ...charge(CUR, { leaseId: 'LN', unitId: 'U2', unitLabel: 'G2', rent: 6000, amount: 6000 }), updatedBy: 'rentMember' });
        b.update(f.collection(c('rent_leases')).doc('LN'), { chargedThrough: CUR, updatedAt: 3, updatedBy: 'rentMember' });
        await assertSucceeds(b.commit());
    });

    t('change of unit with a tenant link and a back-dated move: snapshot and unpaid later month in the same write', async () => {
        await seedChange(PREV, null, { through: CUR, token: TOKEN });
        await assertFails(changeUnit('rentMember', { date: `${PREV}-15`, del: [CUR], pub: TOKEN }));
        await assertSucceeds(changeUnit('legacyOwner', { date: `${PREV}-15`, del: [CUR], pub: TOKEN }));
    });

    t('change of unit back-dated two months with a link: both unpaid later months go in the same write', async () => {
        await seedChange(PREV2, null, { through: CUR, token: TOKEN });
        await seed('rent_charges', `L1_${PREV}`, charge(PREV));
        await assertSucceeds(changeUnit('legacyOwner', { date: `${PREV2}-15`, del: [PREV, CUR], pub: TOKEN }));
    });

    t('change of unit: an occupied unit is never overwritten (any role)', async () => {
        await seedChange(CUR, 'LX');
        await seed('rent_leases', 'LX', lease({ unitId: 'U2', tenantId: 'T9', chargedThrough: CUR }));
        for (const uid of ['rentMember', 'rentManager', 'legacyOwner']) await assertFails(changeUnit(uid));
    });

    t('change of unit: unit, property and tenant agree; the old lease is this tenant\'s and ends in the same write', async () => {
        await seedChange(CUR);
        await seed('rent_tenants', 'T2', { name: 'Sita', phone: '9876543211', notes: '', ...meta('x') });
        await seed('rent_units', 'U3', unit({ label: 'G3', leaseId: null, propertyId: 'P2' }));
        await assertFails(changeUnit('rentManager', { propertyId: 'P9' }));
        await assertFails(changeUnit('rentManager', { unitId: 'U3' }));
        await assertFails(changeUnit('rentManager', { tenantId: 'T2' }));
        await assertFails(changeUnit('rentManager', { from: 'L9' }));
        await assertFails(changeUnit('rentManager', { freeOld: false }));
        await assertSucceeds(changeUnit('rentManager', { unitId: 'U3', propertyId: 'P2' }));
    });

    t('change of unit: only rentals roles', async () => {
        await seedChange(CUR);
        for (const uid of ['staff1', 'manager1', 'rentPending']) await assertFails(changeUnit(uid));
        await assertSucceeds(changeUnit('rentOnly'));
    });

    t('change of unit: non-owners back-date only within the edit window; the owner any date', async () => {
        const back = istDate(3);
        await seedChange(back.slice(0, 7));
        await assertFails(changeUnit('rentMember', { date: back }));
        await assertFails(changeUnit('rentManager', { date: back }));
        await assertSucceeds(changeUnit('legacyOwner', { date: back }));
    });

    t('change of unit: fromLeaseId must be an active lease (not one already ended)', async () => {
        await seedChange(CUR);
        await seed('rent_leases', 'L9', lease({ unitId: 'U9', status: 'ended', endMonth: PREV, chargedThrough: PREV }));
        await assertFails(changeUnit('rentManager', { from: 'L9' }));
    });

    t('change of unit on the 1st: the old lease may end the month before (only then)', async () => {
        await seedChange(PREV, null, { through: CUR });
        await assertFails(changeUnit('legacyOwner', { date: `${CUR}-02`, endMonth: PREV, del: [CUR] }));
        await assertSucceeds(changeUnit('legacyOwner', { date: `${CUR}-01`, endMonth: PREV, del: [CUR] }));
    });

    t('change of unit by the owner with a link, back-dated 3 months: three later months go in the same write', async () => {
        const m3 = istMonth(-3);
        await seedChange(m3, null, { through: CUR, token: TOKEN });
        for (const m of [PREV2, PREV]) await seed('rent_charges', `L1_${m}`, charge(m));
        await assertSucceeds(changeUnit('legacyOwner', { date: `${m3}-15`, del: [PREV2, PREV, CUR], pub: TOKEN }));
    });

    t('every new lease: non-owners back-date the start at most 2 days (the boundary is allowed); the owner any date', async () => {
        await seed('rent_units', 'UN', unit({ label: 'S1', leaseId: null }));
        await assertFails(moveInBatch('rentMember', { newUnit: false, startDate: istDate(3) }));
        await assertFails(moveInBatch('rentManager', { startDate: istDate(3) }));
        await assertSucceeds(moveInBatch('rentMember', { newUnit: false, startDate: istDate(2) }));
        await env.clearFirestore();
        await seedUsers(prefix ? 'dev_users' : 'users');
        await assertSucceeds(moveInBatch('legacyOwner', { startDate: `${istMonth(-3)}-05` }));
    });

    t('change of unit: 1 day back is inside the 2-day window', async () => {
        const yesterday = istDate(1);
        await seedChange(yesterday.slice(0, 7));
        await assertSucceeds(changeUnit('rentOnly', { date: yesterday }));
    });

    t('change of unit: the old lease must point at the new one (movedTo), and only in that write', async () => {
        await seedChange(CUR);
        await assertFails(changeUnit('rentMember', { moved: '' }));
        await assertFails(changeUnit('rentMember', { moved: 'LZ' }));
        const f = db('rentManager');
        const b = f.batch();
        b.update(leaseOn(f), { status: 'ended', endMonth: CUR, chargedThrough: CUR, movedTo: 'LZ', updatedAt: 2, updatedBy: 'rentManager' });
        b.update(unitOn(f), { leaseId: null, updatedAt: 2, updatedBy: 'rentManager' });
        await assertFails(b.commit());
        await assertSucceeds(changeUnit('rentMember'));
        await assertFails(leaseRef('rentManager').update({ movedTo: 'LQ', updatedAt: 3, updatedBy: 'rentManager' }));
    });

    // ---- change of unit carries the tenant link (same token, snapshot moves to the new lease) ----
    t('change of unit carries the tenant link: a member moves the token and the snapshot in the same write', async () => {
        await seedChange(CUR, null, { token: TOKEN });
        await assertFails(changeUnit('rentMember', { carry: TOKEN, clear: false, pub: TOKEN }));
        await assertFails(changeUnit('rentMember', { carry: TOKEN, moved: '', pub: TOKEN }));
        await assertSucceeds(changeUnit('rentMember', { carry: TOKEN, pub: TOKEN }));
        let got = null;
        await env.withSecurityRulesDisabled(async (ctx) => {
            const fs = ctx.firestore();
            got = { ln: (await fs.collection(c('rent_leases')).doc('LN').get()).data(), l1: (await fs.collection(c('rent_leases')).doc('L1').get()).data(),
                pub: (await fs.collection(c('rent_public')).doc(TOKEN).get()).data() };
        });
        if (got.ln.shareToken !== TOKEN || got.l1.shareToken != null || got.pub.lid !== 'LN' || got.pub.ended) throw new Error('link not carried');
        // Later writes keep it current through the new lease.
        await assertSucceeds(pubOn(db('rentMember'), TOKEN).set(snap({ lid: 'LN', updatedAt: 3 })));
        await assertFails(pubOn(db('rentMember'), TOKEN).set(snap({ lid: 'L1', updatedAt: 4 })));
    });

    t('change of unit: a member can\'t take another lease\'s link (token or snapshot) this way', async () => {
        await seedChange(CUR, null, { token: TOKEN });
        await seed('rent_units', 'U9', unit({ label: 'G9', leaseId: 'L7' }));
        await seed('rent_tenants', 'T9', { name: 'Sita', phone: '9876543211', notes: '', ...meta('x') });
        await seed('rent_leases', 'L7', lease({ unitId: 'U9', tenantId: 'T9', shareToken: TOKEN2 }));
        await seed('rent_public', TOKEN2, snap({ lid: 'L7', tenant: 'Sita' }));
        // The other lease's token on the new lease (with or without its snapshot).
        await assertFails(changeUnit('rentMember', { carry: TOKEN2 }));
        await assertFails(changeUnit('rentMember', { carry: TOKEN2, pub: TOKEN2 }));
        await assertFails(changeUnit('rentManager', { carry: TOKEN2, pub: TOKEN2 }));
        // Its snapshot pointed at the new lease, which doesn't hold that token.
        await assertFails(changeUnit('rentMember', { carry: TOKEN, pub: TOKEN2 }));
        // A new lease from another tenant's lease.
        await assertFails(changeUnit('rentMember', { from: 'L7', carry: TOKEN2 }));
        // Moving a snapshot to a lease not made from its own.
        await assertFails(pubOn(db('rentMember'), TOKEN2).set(snap({ lid: 'L1' })));
        await assertSucceeds(changeUnit('rentMember', { carry: TOKEN, pub: TOKEN }));
        await assertFails(pubOn(db('rentMember'), TOKEN2).set(snap({ lid: 'LN' })));
    });

    t('a new lease without fromLeaseId never starts with a link', async () => {
        await seed('rent_units', 'UN', unit({ label: 'S1', leaseId: null }));
        await seed('rent_leases', 'L1', lease({ shareToken: TOKEN }));
        await assertFails(moveInBatch('rentManager', { newUnit: false, withCharge: false, extraLease: { shareToken: TOKEN } }));
        await assertSucceeds(moveInBatch('rentManager', { newUnit: false, withCharge: false }));
    });

    // ---- RENT-13: the old unit's move month pro-rated in the change write ----
    const dim = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
    const oldDays = (date, s = 1) => Math.round(5000 * (Number(date.slice(8, 10)) - s) / (dim(date.slice(0, 7)) - s + 1));
    const proRated = (rent, date) => Math.round(rent * (dim(date.slice(0, 7)) - Number(date.slice(8, 10)) + 1) / dim(date.slice(0, 7)));

    t('RENT-13: members pro-rate the old unit\'s move month to the computed amount only, in the change write', async () => {
        await seedChange(CUR);
        const x = oldDays(today);
        await assertFails(changeUnit('rentMember', { split: { rent: x + 2 } }));
        await assertFails(changeUnit('rentMember', { split: { rent: x, amount: x + 100 } }));
        await assertFails(chargeRef('rentMember', CUR).update({ rent: x, amount: x, open: true, updatedAt: 2, updatedBy: 'rentMember' }));
        await assertSucceeds(changeUnit('rentMember', { split: { rent: x } }));
    });

    t('change of unit as the app writes it fits in one write: link carried + pro-rated month (member), + 3 later months (owner)', async () => {
        await seedChange(CUR, null, { token: TOKEN });
        await assertSucceeds(changeUnit('rentMember', { carry: TOKEN, pub: TOKEN, split: { rent: oldDays(today) } }));
        await env.clearFirestore();
        await seedUsers(prefix ? 'dev_users' : 'users');
        const m3 = istMonth(-3);
        await seedChange(m3, null, { through: CUR, token: TOKEN });
        for (const m of [PREV2, PREV]) await seed('rent_charges', `L1_${m}`, charge(m));
        await assertSucceeds(changeUnit('legacyOwner', { date: `${m3}-15`, del: [PREV2, PREV, CUR], carry: TOKEN, pub: TOKEN, split: { rent: 2100 } }));
    });

    t('RENT-13: electricity stays on the old month; the amount is the pro-rated rent + electricity', async () => {
        await seedChange(CUR);
        await seed('rent_charges', `L1_${CUR}`, charge(CUR, { electricity: elec(100, 130, 10), amount: 5300 }));
        const x = oldDays(today);
        await assertFails(changeUnit('rentMember', { split: { rent: x } }));
        await assertSucceeds(changeUnit('rentMember', { split: { rent: x, amount: x + 300 } }));
    });

    t('RENT-13: owner/manager may set any lower old-month rent, never above it or below what is paid', async () => {
        await seedChange(CUR);
        await seed('rent_charges', `L1_${CUR}`, charge(CUR, { paid: 1500, open: true, payments: [entry('x', 1500)] }));
        await assertFails(changeUnit('rentManager', { split: { rent: 6000 } }));
        await assertFails(changeUnit('rentManager', { split: { rent: 1000 } }));
        await assertSucceeds(changeUnit('rentManager', { split: { rent: 1600.5 } }));
    });

    t('RENT-13: more than its share paid: a member closes the old month at exactly what is paid, never another amount above the share', async () => {
        const x = oldDays(today);
        if (5000 - x < 4) return; // needs room between the share and the full rent
        const paid = Math.round((x + 5000) / 2);
        const above = Math.floor((paid + 5000) / 2);
        await seedChange(CUR);
        await seed('rent_charges', `L1_${CUR}`, charge(CUR, { paid, open: true, payments: [entry('x', paid)] }));
        await assertFails(changeUnit('rentMember', { split: { rent: above, amount: above, open: true } }));
        await assertFails(changeUnit('rentMember', { split: { rent: above, amount: above, open: false } }));
        await assertFails(changeUnit('rentMember', { split: { rent: x, amount: x, open: false } }));
        await assertSucceeds(changeUnit('rentMember', { split: { rent: paid, amount: paid, open: false } }));
    });

    t('RENT-13: an old lease that started (pro-rated) in the move month counts from its start day', async () => {
        const day = Number(today.slice(8, 10));
        if (day < 3) return; // needs a start day before today inside this month
        const start = `${CUR}-02`;
        await seedChange(CUR);
        await seed('rent_leases', 'L1', lease({ startMonth: CUR, rentSince: CUR, startDate: start, proRate: true, firstRent: 4800, chargedThrough: CUR }));
        await seed('rent_charges', `L1_${CUR}`, charge(CUR, { rent: 4800, amount: 4800 }));
        const x = Math.round(4800 * (day - 2) / (dim(CUR) - 1));
        await assertFails(changeUnit('rentMember', { split: { rent: oldDays(today) === x ? x + 2 : oldDays(today) } }));
        await assertSucceeds(changeUnit('rentMember', { split: { rent: x } }));
    });

    // Members may only start a lease up to 2 days back, so a member's move on the 1st with this month already
    // charged happens on the 1st–3rd (IST); on other days the rules refuse it for the date alone.
    t('change of unit on the 1st by a member (chargedThrough = this month): the charged month goes in the same write', async () => {
        await seedChange(PREV, null, { through: CUR });
        const first = `${CUR}-01`;
        const run = () => changeUnit('rentMember', { date: first, endMonth: PREV, del: [CUR] });
        await assertFails(moveOut('rentMember', PREV, { del: [CUR] }));
        if (first >= istDate(2)) {
            await assertFails(changeUnit('rentMember', { date: first, endMonth: PREV, del: [CUR], moved: '' }));
            await assertSucceeds(run());
        } else {
            await assertFails(run());
        }
    });

    t('tenant phone: a 10-digit mobile required on create; second number optional; old tenants without a phone still edit', async () => {
        const ten = (uid) => db(uid).collection(c('rent_tenants'));
        await assertSucceeds(ten('rentMember').doc('TA').set({ name: 'A', phone: '9876543210', phone2: '8123456789', notes: '', ...meta('rentMember') }));
        await assertFails(ten('rentMember').doc('TB').set({ name: 'B', phone: '', notes: '', ...meta('rentMember') }));
        await assertFails(ten('rentMember').doc('TC').set({ name: 'C', phone: '5876543210', notes: '', ...meta('rentMember') }));
        await assertFails(ten('rentMember').doc('TD').set({ name: 'D', phone: '9876543210', phone2: '123', notes: '', ...meta('rentMember') }));
        await seed('rent_tenants', 'TL', { name: 'Old', phone: '', notes: '', ...meta('x') });
        await assertSucceeds(ten('rentMember').doc('TL').update({ notes: 'shop 2', updatedAt: 2, updatedBy: 'rentMember' }));
        await assertFails(ten('rentMember').doc('TL').update({ phone: '99', updatedAt: 3, updatedBy: 'rentMember' }));
    });

    t('electricity modes: meter readings only when the lease bills by meter; start date and first rent stay fixed', async () => {
        await seed('rent_units', 'U1', unit({ lastReading: 100, meterRate: 8 }));
        await seed('rent_charges', `L1_${CUR}`, charge(CUR));
        for (const mode of ['included', 'own']) {
            await seed('rent_leases', 'L1', lease({ chargedThrough: CUR, elecMode: mode }));
            await assertFails(meterWrite('rentManager', elec(100, 150, 8)));
        }
        await seed('rent_leases', 'L1', lease({ chargedThrough: CUR, elecMode: 'meter', startDate: `${PREV}-15`, startMonth: PREV }));
        await assertSucceeds(meterWrite('rentMember', elec(100, 150, 8)));
        await assertSucceeds(leaseRef('rentMember').update({ elecMode: 'own', meterNo: 'CN-9', updatedAt: 3, updatedBy: 'rentMember' }));
        await assertFails(leaseRef('rentManager').update({ startDate: `${PREV}-01`, updatedAt: 4, updatedBy: 'rentManager' }));
        await assertFails(leaseRef('rentManager').update({ firstRent: 1, updatedAt: 4, updatedBy: 'rentManager' }));
    });

    t('link snapshot carries the start date and electricity mode (checked)', async () => {
        await seed('rent_leases', 'L1', lease({ chargedThrough: CUR, shareToken: TOKEN }));
        await assertSucceeds(pubOn(db('rentMember'), TOKEN).set(snap({ since: `${PREV}-15`, em: 'own' })));
        await assertFails(pubOn(db('rentMember'), TOKEN).set(snap({ since: '15/10/2026' })));
        await assertFails(pubOn(db('rentMember'), TOKEN).set(snap({ em: 'solar' })));
    });

    t('rent can go down on a pro-rated lease (also one that started on the 1st); firstRent stays fixed (review of #30)', async () => {
        await seed('rent_leases', 'L1', lease({ chargedThrough: CUR, rent: 6000, firstRent: 3000, proRate: true, startDate: `${PREV}-16`, startMonth: PREV }));
        await assertSucceeds(leaseRef('rentMember').update({ rent: 2500, updatedAt: 2, updatedBy: 'rentMember' }));
        await seed('rent_leases', 'L1', lease({ chargedThrough: CUR, rent: 6000, firstRent: 6000, proRate: true, startDate: `${PREV}-01`, startMonth: PREV }));
        await assertSucceeds(leaseRef('rentManager').update({ rent: 5000, updatedAt: 3, updatedBy: 'rentManager' }));
        await assertFails(leaseRef('rentManager').update({ firstRent: 100, updatedAt: 4, updatedBy: 'rentManager' }));
        await assertFails(leaseRef('rentManager').update({ firstRent: -1, updatedAt: 4, updatedBy: 'rentManager' }));
    });

    t('only the owner deletes rentals records', async () => {
        await seed('rent_tenants', 'T1', { name: 'Ram', phone: '', notes: '', ...meta('x') });
        await assertFails(db('rentManager').collection(c('rent_tenants')).doc('T1').delete());
        await assertSucceeds(db('legacyOwner').collection(c('rent_tenants')).doc('T1').delete());
    });

    t('nobody sets their own rentRole; registration cannot carry one; the owner can grant it', async () => {
        const users = `${prefix}users`;
        await assertFails(as('staff1').collection(users).doc('staff1').update({ rentRole: 'manager' }));
        await assertFails(as('newbie').collection(users).doc('newbie').set({ name: 'N', role: 'staff', status: 'pending', rentRole: 'member' }));
        await assertSucceeds(as('newbie').collection(users).doc('newbie').set({ name: 'N', role: 'staff', status: 'pending' }));
        await assertSucceeds(as('legacyOwner').collection(users).doc('staff1').update({ rentRole: 'member' }));
    });

    // ---- Rent receipts (RENT-12): rent_receipts + rent_counters ----
    const R_YEAR = new Date(Date.now() + 330 * MIN).getUTCFullYear();
    const rno = (seq) => `R-${R_YEAR}-${String(seq).padStart(4, '0')}`;
    const rctOn = (f, id) => f.collection(c('rent_receipts')).doc(id);
    const ctrOn = (f, year = R_YEAR) => f.collection(c('rent_counters')).doc(`receipts_${year}`);
    // Profile names (seedUsers): "Received by" must be the writer's.
    const NAME = { rentMember: 'RC', rentManager: 'RM', rentOnly: 'RO', legacyOwner: 'O', staff1: 'S' };
    const paid1 = (uid, amount, seq) => ({ ...entry(uid, amount), byName: NAME[uid], ...(seq ? { rno: rno(seq) } : {}) });
    const receipt = (uid, seq, { pi = 0, amount = 2000, paidAfter = amount, month = CUR, total = 5000, ...over } = {}) => ({
        no: rno(seq), year: R_YEAR, seq, chargeId: `L1_${month}`, pi, leaseId: 'L1', tenantId: 'T1', unitId: 'U1', propertyId: 'P1',
        tenantName: 'Ram', place: 'G1, Gali 2', ut: 'flat', months: [month], rent: 5000, elec: null, total,
        paid: amount, mode: 'cash', ref: '', date: '2026-10-05', balance: total - paidAfter, by: uid, byName: NAME[uid],
        createdAt: serverTimestamp(), void: false, ...over
    });
    // One payment write with its receipt and the year's counter (as rent-store.js recordPayment).
    const payReceipt = (uid, seq, { prior = [], amount = 2000, total = 5000, rcpt = {}, ent = {}, ctr = {}, noCounter = false, noReceipt = false, f = db(uid) } = {}) => {
        const b = f.batch();
        const pi = prior.length;
        const paid = prior.reduce((s, x) => s + x.amount, 0) + amount;
        b.update(chargeOn(f, CUR), { paid, open: paid < total, updatedAt: 2, updatedBy: uid, payments: [...prior, { ...paid1(uid, amount, seq), ...ent }] });
        if (!noReceipt) b.set(rctOn(f, `L1_${CUR}_${pi}`), receipt(uid, seq, { pi, amount, paidAfter: paid, total, ...rcpt }));
        if (!noCounter) b.set(ctrOn(f), { last: seq, rid: `L1_${CUR}_${pi}`, updatedAt: 2, updatedBy: uid, ...ctr });
        return b.commit();
    };
    const seedPaid = async (seq = 1) => {
        const e = paid1('rentMember', 2000, seq);
        await seed('rent_charges', `L1_${CUR}`, charge(CUR, { paid: 2000, payments: [e] }));
        await seed('rent_receipts', `L1_${CUR}_0`, receipt('rentMember', seq));
        await seed('rent_counters', `receipts_${R_YEAR}`, { last: seq, rid: `L1_${CUR}_0`, updatedAt: 1, updatedBy: 'rentMember' });
        return e;
    };

    t('receipts: the payment, its receipt and the next number of the year go in one write', async () => {
        await seed('rent_charges', `L1_${CUR}`, charge(CUR));
        await assertFails(payReceipt('staff1', 1));
        await assertFails(payReceipt('rentMember', 1, { noCounter: true }));
        await assertFails(payReceipt('rentMember', 1, { noReceipt: true }));
        await assertFails(payReceipt('rentMember', 2));
        await assertFails(payReceipt('rentMember', 1, { ent: { rno: rno(7) } }));
        await assertSucceeds(payReceipt('rentMember', 1));
        const first = paid1('rentMember', 2000, 1);
        // Review attacks: reuse a number, jump the counter, point the counter elsewhere.
        await assertFails(payReceipt('rentOnly', 1, { prior: [first], amount: 1000 }));
        await assertFails(payReceipt('rentOnly', 3, { prior: [first], amount: 1000 }));
        await assertFails(payReceipt('rentOnly', 2, { prior: [first], amount: 1000, ctr: { rid: `L1_${CUR}_0` } }));
        await assertSucceeds(payReceipt('rentOnly', 2, { prior: [first], amount: 1000 }));
        // A payment without a receipt (an older app) is still allowed.
        await assertSucceeds(chargeRef('rentMember', CUR).update({
            paid: 3500, open: true, updatedAt: 3, updatedBy: 'rentMember',
            payments: [first, paid1('rentOnly', 1000, 2), entry('rentMember', 500)]
        }));
        await assertFails(ctrOn(db('rentMember')).set({ last: 3, rid: `L1_${CUR}_2`, updatedAt: 4, updatedBy: 'rentMember' }));
    });

    t('receipts: content must match the payment and the charge; fields allow-listed', async () => {
        await seed('rent_charges', `L1_${CUR}`, charge(CUR));
        for (const rcpt of [{ paid: 999 }, { balance: 0 }, { total: 9999 }, { months: [PREV] }, { by: 'rentOnly' }, { mode: 'upi' },
            { rent: 1 }, { elec: elec(0, 10, 8) }, { void: true }, { voidBy: 'x' }, { gst: 18 }, { leaseId: 'L9' }, { no: rno(2) },
            { ut: 'castle' }, { biz: 'Sharma Rentals' }, { bizAddr: 'Main Road' }, { year: R_YEAR + 1 }, { tenantName: 'Shyam' },
            { issuedBy: 'rentMember' }]) {
            await assertFails(payReceipt('rentMember', 1, { rcpt }));
        }
        await assertFails(payReceipt('rentMember', 1, { rcpt: { pi: 1 } }));
        // "Received by" is the writer's profile name, on the entry and the receipt alike.
        await assertFails(payReceipt('rentMember', 1, { rcpt: { byName: 'Owner' }, ent: { byName: 'Owner' } }));
        await assertSucceeds(payReceipt('rentMember', 1, { rcpt: { ut: 'commercial' } }));
    });

    t('receipts: a meter-billed month carries its electricity exactly', async () => {
        const e = elec(100, 150, 8);
        await seed('rent_charges', `L1_${CUR}`, charge(CUR, { electricity: e, amount: 5400 }));
        await assertFails(payReceipt('rentMember', 1, { total: 5400 }));
        await assertFails(payReceipt('rentMember', 1, { total: 5400, rcpt: { elec: { ...e, amount: 1 } } }));
        await assertSucceeds(payReceipt('rentMember', 1, { total: 5400, amount: 5400, rcpt: { elec: e } }));
    });

    t('receipts: two people paying at once never get the same number; the later one is refused and retries', async () => {
        await seed('rent_charges', `L1_${CUR}`, charge(CUR));
        await seed('rent_charges', `L1_${PREV}`, charge(PREV));
        // Both read the counter before either wrote (number 1 for both), then commit together.
        const claim = (uid, m, seq) => {
            const f = db(uid);
            const b = f.batch();
            b.update(chargeOn(f, m), { paid: 1000, open: true, updatedAt: 2, updatedBy: uid, payments: [paid1(uid, 1000, seq)] });
            b.set(rctOn(f, `L1_${m}_0`), { ...receipt(uid, seq, { amount: 1000 }), chargeId: `L1_${m}`, months: [m] });
            b.set(ctrOn(f), { last: seq, rid: `L1_${m}_0`, updatedAt: 2, updatedBy: uid });
            return b.commit();
        };
        const results = await Promise.allSettled([claim('rentMember', CUR, 1), claim('rentManager', PREV, 1)]);
        const won = results.map(r => r.status === 'fulfilled');
        if (won.filter(Boolean).length !== 1) throw new Error(`expected exactly one to succeed: ${results.map(r => r.status)}`);
        const [winM, loseUid, loseM] = won[0] ? [CUR, 'rentManager', PREV] : [PREV, 'rentMember', CUR];
        await assertFails(claim(loseUid, loseM, 1));
        await assertSucceeds(claim(loseUid, loseM, 2));
        let nos = [];
        await env.withSecurityRulesDisabled(async (ctx) => {
            const s = await ctx.firestore().collection(c('rent_receipts')).get();
            nos = s.docs.map(d => d.data().no).sort();
        });
        if (JSON.stringify(nos) !== JSON.stringify([rno(1), rno(2)])) throw new Error(`numbers: ${nos} (${winM})`);
    });

    t('receipts: a manager payment with its receipt and the tenant link snapshot fits in one write', async () => {
        await seed('rent_leases', 'L1', lease({ chargedThrough: CUR, shareToken: TOKEN }));
        await seed('rent_charges', `L1_${CUR}`, charge(CUR));
        const f = db('rentManager');
        const b = f.batch();
        b.update(chargeOn(f, CUR), { paid: 2000, open: true, updatedAt: 2, updatedBy: 'rentManager', payments: [paid1('rentManager', 2000, 1)] });
        b.set(rctOn(f, `L1_${CUR}_0`), receipt('rentManager', 1));
        b.set(ctrOn(f), { last: 1, rid: `L1_${CUR}_0`, updatedAt: 2, updatedBy: 'rentManager' });
        b.set(pubOn(f, TOKEN), snap());
        await assertSucceeds(b.commit());
    });

    t('receipts: the year is the server\'s (IST) and createdAt the server\'s time, not the device\'s', async () => {
        await seed('rent_charges', `L1_${CUR}`, charge(CUR));
        const y = R_YEAR + 1;
        const no = `R-${y}-0001`;
        const f = db('rentMember');
        const b = f.batch();
        b.update(chargeOn(f, CUR), { paid: 2000, open: true, updatedAt: 2, updatedBy: 'rentMember', payments: [{ ...paid1('rentMember', 2000), rno: no }] });
        b.set(rctOn(f, `L1_${CUR}_0`), { ...receipt('rentMember', 1), year: y, no });
        b.set(ctrOn(f, y), { last: 1, rid: `L1_${CUR}_0`, updatedAt: 2, updatedBy: 'rentMember' });
        await assertFails(b.commit());
        await assertFails(payReceipt('rentMember', 1, { rcpt: { createdAt: Date.now() } }));
        // A device time a minute off: Timestamp.now() alone can equal request.time to the ms
        await assertFails(payReceipt('rentMember', 1, { rcpt: { createdAt: Timestamp.fromMillis(Date.now() - 60 * 1000) } }));
        await assertSucceeds(payReceipt('rentMember', 1));
    });

    // A payment saved without a receipt (refused, or an older app) gets one later.
    const later = (uid, pi, seq, { rcpt = {}, payments = null, noCharge = false, noReceipt = false, total = 5000, withLink = false } = {}) => {
        const f = db(uid);
        const b = f.batch();
        const list = [paid1('rentMember', 2000), paid1('rentOnly', 1000)];
        const by = list[pi].by;
        if (!noCharge) b.update(chargeOn(f, CUR), { payments: payments || list.map((e, i) => (i === pi ? { ...e, rno: rno(seq) } : e)), updatedAt: 3, updatedBy: uid });
        if (!noReceipt) b.set(rctOn(f, `L1_${CUR}_${pi}`), receipt(by, seq, { pi, amount: list[pi].amount, paidAfter: 3000, total, issuedBy: uid, ...rcpt }));
        b.set(ctrOn(f), { last: seq, rid: `L1_${CUR}_${pi}`, updatedAt: 3, updatedBy: uid });
        if (withLink) b.set(pubOn(f, TOKEN), snap());
        return b.commit();
    };

    t('receipts: issued later for a payment without one, by its writer or an owner/manager', async () => {
        await seed('rent_charges', `L1_${CUR}`, charge(CUR, { paid: 3000, payments: [paid1('rentMember', 2000), paid1('rentOnly', 1000)] }));
        await assertFails(later('rentMember', 1, 1));
        await assertFails(later('staff1', 1, 1));
        await assertFails(later('rentOnly', 1, 1, { noCharge: true }));
        await assertFails(later('rentOnly', 1, 1, { noReceipt: true }));
        await assertFails(later('rentOnly', 1, 2));
        await assertFails(later('rentOnly', 1, 1, { rcpt: { issuedBy: 'rentMember' } }));
        await assertFails(later('rentOnly', 1, 1, { rcpt: { balance: 4000 } }));
        await assertFails(later('rentOnly', 1, 1, { rcpt: { byName: 'Owner' } }));
        await assertFails(later('rentOnly', 1, 1, { rcpt: { tenantName: 'Shyam' } }));
        await assertFails(later('rentOnly', 1, 1, { rcpt: { createdAt: Date.now() } }));
        await assertFails(later('rentOnly', 1, 1, { payments: [{ ...paid1('rentMember', 2000), amount: 1 }, { ...paid1('rentOnly', 1000), rno: rno(1) }] }));
        await assertFails(later('rentOnly', 1, 1, { payments: [paid1('rentMember', 2000), { ...paid1('rentOnly', 1000), rno: rno(1), amount: 999 }] }));
        await assertSucceeds(later('rentOnly', 1, 1));
        // Not twice for the same entry; a manager issues the other one's (balance due as when issued).
        await assertFails(later('rentManager', 1, 2));
        await assertFails(later('rentManager', 0, 2, { rcpt: { balance: 3000 } }));
        await assertSucceeds(later('rentManager', 0, 2, { payments: [paid1('rentMember', 2000, 2), paid1('rentOnly', 1000, 1)] }));
    });

    t('receipts: a manager issuing later with the tenant link snapshot fits in one write', async () => {
        await seed('rent_leases', 'L1', lease({ chargedThrough: CUR, shareToken: TOKEN }));
        await seed('rent_charges', `L1_${CUR}`, charge(CUR, { paid: 3000, payments: [paid1('rentMember', 2000), paid1('rentOnly', 1000)] }));
        await assertSucceeds(later('rentManager', 1, 1, { withLink: true }));
    });

    t('receipts: never edited or deleted; owner/manager cancel (void) together with the charge', async () => {
        await seedPaid(1);
        const rRef = (uid) => rctOn(db(uid), `L1_${CUR}_0`);
        const voidFields = (uid) => ({ void: true, voidBy: uid, voidByName: 'x', voidAt: 3, voidReason: 'wrong name' });
        const voidWrite = (uid, { charge: withCharge = true, idx = 0, fields = voidFields(uid) } = {}) => {
            const f = db(uid);
            const b = f.batch();
            b.update(rctOn(f, `L1_${CUR}_0`), fields);
            if (withCharge) b.update(chargeOn(f, CUR), { voided: [idx], updatedAt: 3, updatedBy: uid });
            return b.commit();
        };
        await assertFails(rRef('legacyOwner').update({ paid: 1 }));
        await assertFails(rRef('legacyOwner').update({ tenantName: 'Shyam' }));
        await assertFails(rRef('legacyOwner').delete());
        await assertFails(rRef('rentManager').delete());
        await assertFails(ctrOn(db('legacyOwner')).delete());
        await assertFails(voidWrite('rentMember'));
        await assertFails(voidWrite('rentManager', { charge: false }));
        await assertFails(voidWrite('rentManager', { idx: 1 }));
        await assertFails(voidWrite('rentManager', { fields: { ...voidFields('rentManager'), paid: 1 } }));
        await assertFails(voidWrite('rentManager', { fields: voidFields('legacyOwner') }));
        await assertFails(voidWrite('rentManager', { fields: { ...voidFields('rentManager'), voidReason: '' } }));
        await assertFails(chargeRef('rentManager', CUR).update({ voided: [0], updatedAt: 3, updatedBy: 'rentManager' }));
        await assertSucceeds(voidWrite('rentManager'));
        await assertFails(rRef('legacyOwner').update({ voidReason: 'changed' }));
        await assertFails(rRef('legacyOwner').update({ void: false }));
    });

    t('receipts: read by rentals roles only', async () => {
        await seedPaid(1);
        for (const uid of ['legacyOwner', 'rentManager', 'rentMember', 'rentOnly']) {
            await assertSucceeds(db(uid).collection(c('rent_receipts')).where('tenantId', '==', 'T1').orderBy('createdAt', 'desc').limit(60).get());
            await assertSucceeds(ctrOn(db(uid)).get());
        }
        for (const uid of ['staff1', 'manager1', 'rentPending']) {
            await assertFails(rctOn(db(uid), `L1_${CUR}_0`).get());
            await assertFails(ctrOn(db(uid)).get());
        }
        await assertFails(rctOn(anon(), `L1_${CUR}_0`).get());
    });

    // ---- Settings › Rentals (rent_settings/default) ----
    const rs = (over = {}) => ({ dueDay: 10, increasePct: 5, meterRate: 8, tenantLink: false, receiptHeader: 'Sharma Rentals', updatedAt: 1, ...over });
    const rsRef = (uid, id = 'default') => db(uid).collection(c('rent_settings')).doc(id);

    t('rent_settings: rentals roles read; shop-only users and strangers do not', async () => {
        await seed('rent_settings', 'default', rs({ updatedBy: 'legacyOwner' }));
        for (const uid of ['legacyOwner', 'rentManager', 'rentMember', 'rentOnly']) await assertSucceeds(rsRef(uid).get());
        for (const uid of ['staff1', 'manager1', 'rentPending']) await assertFails(rsRef(uid).get());
        await assertFails(anon().collection(c('rent_settings')).doc('default').get());
    });

    t('rent_settings: owner and rentals manager write; member and shop manager do not', async () => {
        await assertSucceeds(rsRef('legacyOwner').set(rs({ updatedBy: 'legacyOwner' })));
        await assertSucceeds(rsRef('rentManager').set(rs({ dueDay: 5, tenantLink: true, updatedBy: 'rentManager' })));
        await assertFails(rsRef('rentMember').set(rs({ updatedBy: 'rentMember' })));
        await assertFails(rsRef('rentOnly').set(rs({ updatedBy: 'rentOnly' })));
        await assertFails(rsRef('manager1').set(rs({ updatedBy: 'manager1' })));
        await assertFails(rsRef('rentManager').delete());
        await assertSucceeds(rsRef('legacyOwner').delete());
    });

    t('rent_settings: only the default doc, signed by the writer, with valid values', async () => {
        const w = (over) => rsRef('rentManager').set(rs({ updatedBy: 'rentManager', ...over }));
        await assertFails(rsRef('rentManager', 'other').set(rs({ updatedBy: 'rentManager' })));
        await assertFails(w({ updatedBy: 'legacyOwner' }));
        await assertFails(w({ dueDay: 0 }));
        await assertFails(w({ dueDay: 29 }));
        await assertFails(w({ dueDay: 10.5 }));
        await assertFails(w({ increasePct: 101 }));
        await assertFails(w({ meterRate: -1 }));
        await assertFails(w({ tenantLink: 'yes' }));
        await assertFails(w({ receiptHeader: 'x'.repeat(81) }));
        await assertFails(w({ receiptAddress: 'x'.repeat(201) }));
        await assertFails(w({ extra: 1 }));
        await assertSucceeds(w({ meterRate: null, receiptHeader: '', receiptAddress: 'Main Road, Kanpur' }));
    });
}

defineRentSuite('');
defineRentSuite('dev_');

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
    // RULES_TEST_FILTER=<text> runs only the tests whose name contains it (local debugging).
    const only = process.env.RULES_TEST_FILTER || '';
    for (const { name, fn } of tests.filter(x => x.name.includes(only))) {
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
    console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
