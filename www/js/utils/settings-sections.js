/**
 * @fileoverview Which Settings sections a user sees and may edit: Common for
 * everyone, Aadhat (internal id 'shop') for its owner/manager, Rentals for its
 * owner/manager. Members see only Common. Pure: no DOM, Firestore or AppState.
 * @module utils/settings-sections
 */

import { can } from './role-access.js';

export const BUSINESSES = Object.freeze(['shop', 'rentals']);

/** 'owner' | 'manager' | 'member' | null: the user's role in the Aadhat business. */
export function shopRoleOf(userRole) {
    if (userRole === 'owner' || userRole === 'manager') return userRole;
    return userRole === 'staff' ? 'member' : null;
}

/** 'owner' | 'manager' | 'member' | null: the user's role in Rentals (the shop owner owns every business). */
export function rentRoleOf(userRole, rentRole) {
    if (userRole === 'owner') return 'owner';
    return ['manager', 'member'].includes(rentRole) ? rentRole : null;
}

/**
 * @param {{userRole?: string, rentRole?: string, business?: string, choice?: string, roleAccess?: Object}} p
 *   business: the business open in the switcher; choice: the section the user toggled to.
 * @returns {{shop: {visible: boolean, editable: boolean}, rentals: {visible: boolean, editable: boolean},
 *   active: ('shop'|'rentals'|null), other: ('shop'|'rentals'|null)}}
 */
export function settingsView({ userRole, rentRole, business = 'shop', choice = null, roleAccess } = {}) {
    const shopRole = shopRoleOf(userRole);
    const rentalsRole = rentRoleOf(userRole, rentRole);
    const shopVisible = shopRole === 'owner' || shopRole === 'manager';
    const sections = {
        shop: {
            visible: shopVisible,
            editable: shopRole === 'owner' || (shopRole === 'manager' && can('manager', 'shopSettings', roleAccess))
        },
        rentals: {
            visible: rentalsRole === 'owner' || rentalsRole === 'manager',
            editable: rentalsRole === 'owner' || rentalsRole === 'manager'
        }
    };
    const current = BUSINESSES.includes(business) ? business : 'shop';
    const wanted = BUSINESSES.includes(choice) ? choice : current;
    const active = sections[wanted].visible ? wanted : (sections[current].visible ? current : null);
    const other = BUSINESSES.find(b => b !== active && sections[b].visible) || null;
    return { ...sections, active, other };
}
