/**
 * Rentals data already in Happa before the migration (it is real: owner,
 * 7 Nov 2026). run.js seeds it with the rehearsal leftovers; data.test.js
 * checks that wipe + apply keep it while the rest is wiped. Strings, numbers
 * and booleans only (run.js writes them over the emulator's REST API).
 */
export const RENTALS_SEED = {
    /** wipe keeps these and apply never writes them */
    kept: [
        { coll: 'rent_properties', id: 'e2e-prop', data: { name: 'Kept property', kind: 'shop', archived: false } },
        { coll: 'rent_units', id: 'e2e-unit', data: { propertyId: 'e2e-prop', label: 'G-1', rent: 5000 } },
        { coll: 'rent_settings', id: 'default', data: { dueDay: 5 } },
        { coll: 'dev_rent_units', id: 'e2e-dev-unit', data: { label: 'dev' } },
        { coll: 'auditLogs', id: 'e2e-rent-audit', data: { action: 'RENT_PAYMENT', userId: 'kept-login' } },
        // a rentals-only helper (no Aadhat role) whose login (kept-login) wipe keeps too
        { coll: 'users', id: 'kept-login', data: { email: 'keep@other.test', name: 'Rentals helper', role: 'none', rentRole: 'member', status: 'approved' } }
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
        { coll: 'users', id: 'old-member-04', data: { rentRole: 'member', name: 'Helper in Happa', role: 'manager' } },
        // the old profile says rentRole 'manager': Happa's wins
        { coll: 'users', id: 'old-manager-02', data: { rentRole: 'member' } }
    ],
    /** synthetic backup only: a stale rehearsal copy (no rentRole) with more access than the final backup gives; wipe deletes it, apply re-creates the old one */
    replaced: [
        { coll: 'users', id: 'old-pending-05', data: { email: 'new@old-shop.test', role: 'manager', status: 'approved' } }
    ]
};
