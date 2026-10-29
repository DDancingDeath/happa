/**
 * Playwright globalSetup: wait for the emulators, wipe them, then seed users,
 * the item catalogue and a few known bills (dev_ collections, as the app uses
 * on localhost).
 */
const { USERS, ITEMS, TENANT_TOKEN, waitForEmulators, resetEmulators, signUp, commit } = require('./support/emulator');

const DAY = 86400000;

/** 'YYYY-MM' of the month `back` months before now (local time). */
const monthKey = (back = 0) => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - back);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

module.exports = async () => {
    await waitForEmulators();
    await resetEmulators();

    const writes = [];
    for (const u of Object.values(USERS)) {
        const uid = await signUp(u.email);
        const profile = { name: u.name, email: u.email, role: u.role, status: u.status, createdAt: Date.now() };
        if (u.rentRole) profile.rentRole = u.rentRole;
        writes.push(['dev_users', uid, profile]);
        u.uid = uid;
    }
    ITEMS.forEach(i => writes.push(['dev_items', i.id, i]));

    // A tenant rent-history link (the snapshot rent-public.js writes) for the /r/<token> page.
    writes.push(['dev_rent_public', TENANT_TOKEN, {
        lid: 'lease_e2e', v: 1, shop: 'E2E Shop', tenant: 'Tenant E2E', place: '1A, E2E Bhawan', ut: 'flat',
        rent: 5000, dueDay: 10, ended: false, endMonth: null, em: 'meter', since: `${monthKey(1)}-01`,
        months: [
            { m: monthKey(1), rent: 5000, elec: 400, units: 50, total: 5400, paid: 5400, due: 0, dd: 10, st: 'paid', pd: [`${monthKey(1)}-05`] },
            { m: monthKey(0), rent: 5000, elec: 0, units: 0, total: 5000, paid: 2000, due: 3000, dd: 10, st: 'partial', pd: [`${monthKey(0)}-01`] }
        ],
        updatedAt: Date.now()
    }]);

    // One purchase per viewport project for the edit spec (projects share the emulator).
    const t = Date.now() - 2 * DAY;
    for (const project of ['phone', 'desktop']) {
        const id = `edit_${project}`;
        writes.push(['dev_purchases', id, {
            id, billNumber: `PEDIT-${project.toUpperCase()}`, timestamp: t, date: new Date(t).toISOString(),
            items: [{ itemId: 'itm_wheat', name: 'Wheat', qty: 50, rate: 22, total: 1100, weights: [50] }],
            billTotal: 1100, laborCharges: 0, grandTotal: 1100, amountPayable: 1100, totalPackets: 1,
            cashPayment: 600, onlinePayment: 0, dueAmount: 500,
            payment: { cash: 600, online: 0, due: 500, total: 1100 },
            customerName: 'Before Edit', type: 'purchase', isPurchase: true,
            userId: USERS.owner.uid, userName: 'Owner', clientVersion: 3, openDue: true
        }]);
    }
    await commit(writes);
};
