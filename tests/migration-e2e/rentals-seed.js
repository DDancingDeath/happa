/**
 * Rentals data already in Happa before the migration (it is real: owner,
 * 7 Nov 2026). run.js seeds it with the rehearsal leftovers; data.test.js
 * checks that wipe + apply keep it while the rest is wiped. Strings, numbers,
 * booleans and null only (run.js writes them over the emulator's REST API).
 */
export const RENTALS_SEED = {
    /** wipe keeps these and apply never writes them */
    kept: [
        { coll: 'rent_properties', id: 'e2e-prop', data: { name: 'Kept property', kind: 'shop', archived: false } },
        { coll: 'rent_units', id: 'e2e-unit', data: { propertyId: 'e2e-prop', label: 'G-1', rent: 5000 } },
        { coll: 'rent_settings', id: 'default', data: { dueDay: 5 } },
        { coll: 'dev_rent_units', id: 'e2e-dev-unit', data: { label: 'dev' } },
        { coll: 'auditLogs', id: 'e2e-rent-audit', data: { action: 'RENT_PAYMENT', userId: 'kept-login' } },
        // a Rentals helper only Happa has, with a stale Aadhat role: wipe keeps it (and its login, kept-login) for
        // Rentals only; Aadhat roles come from the old app
        { coll: 'users', id: 'kept-login', data: { email: 'keep@other.test', name: 'Rentals helper', role: 'staff', rentRole: 'member', status: 'approved' }, after: { role: 'none' } }
    ],
    /** wipe deletes these */
    wiped: [
        { coll: 'auditLogs', id: 'e2e-audit', data: { action: 'ADD_ITEM', userId: 'rehearsal-login' } },
        { coll: 'auditLogs', id: 'e2e-audit-no-action', data: { userId: 'rehearsal-login' } },
        { coll: 'users', id: 'rehearsal-login', data: { email: 'rehearsal@happa.local', role: 'staff', status: 'approved' } },
        { coll: 'users', id: 'rehearsal-staging-ro', data: { email: 'staging-readonly@aadhat.local', role: 'staff', status: 'active' } },
        { coll: 'users', id: 'old-test-profile', data: { email: 'old.test@happa.local', role: 'owner' } }
    ],
    /** synthetic backup only: profiles the bundle also writes; apply writes the old profile and puts Happa's rentRole back */
    merged: [
        { coll: 'users', id: 'old-member-04', data: { rentRole: 'member', name: 'Helper in Happa', role: 'manager' } }
    ],
    /** synthetic backup only: profiles without a rentRole that wipe deletes and apply re-creates from the old profile */
    replaced: [
        // a stale rehearsal copy with more access than the final backup gives
        { coll: 'users', id: 'old-pending-05', data: { email: 'new@old-shop.test', role: 'manager', status: 'approved' } },
        // Rentals role removed in Happa; the old profile still says rentRole 'manager': not carried
        { coll: 'users', id: 'old-manager-02', data: { email: 'manager@old-shop.test', role: 'manager', status: 'approved', rentRole: null } }
    ]
};

/** A kept doc as it is after wipe + apply. */
export const afterWipe = (d) => ({ ...d.data, ...(d.after || {}) });
