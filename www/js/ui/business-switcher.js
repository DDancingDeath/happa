/**
 * @fileoverview Business switcher (#149): Shop | Rentals at the top of the side
 * menu. This is the only start-up file that knows about Rentals, and it only
 * loads the Rentals code with import() when Rentals is opened (design §4).
 * The app always starts on Shop, so start-up never reads rentals data.
 * @module ui/business-switcher
 */

import { AppState } from '../utils/state.js';
import { NavigationManager } from './navigation.js';
import { UIManager } from './ui-manager.js';
import { t } from '../i18n/index.js';

const RENT_ROLES = ['manager', 'member'];

/** 'owner' | 'manager' | 'member' | null: what this user may do in Rentals. */
export function rentalsRole(state = AppState) {
    if (state?.userRole === 'owner') return 'owner';
    return RENT_ROLES.includes(state?.rentRole) ? state.rentRole : null;
}

let current = 'shop';
let loading = null;
let rentals = null;
let tabListenerBound = false;
// Bumped whenever Shop is chosen, so a slow Rentals load can't open Rentals afterwards.
let openSeq = 0;

function apply(biz) {
    current = biz;
    document.body.classList.toggle('biz-rentals', biz === 'rentals');
    document.querySelectorAll('[data-biz-btn]').forEach(btn => {
        const on = btn.getAttribute('data-biz-btn') === biz;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
}

export const BusinessSwitcher = {
    current: () => current,

    /** After the first screen is shown: show the switch (if allowed) and start on Shop. */
    init() {
        const sw = document.getElementById('bizSwitch');
        if (sw) sw.hidden = !rentalsRole();
        if (!tabListenerBound) {
            tabListenerBound = true;
            window.addEventListener('aadhat:tabshown', (e) => {
                if (rentals && e.detail?.tabId !== 'rentals') rentals.leave();
            });
        }
        apply('shop');
    },

    /** Loads the Rentals code once (dynamic import, never at start-up). */
    load() {
        if (!loading) {
            loading = import('../rentals/rentals.js').then((m) => {
                rentals = m.RentalsModule;
                Object.assign(window.app.rentals, m.RentalsModule.api);
                return rentals;
            }).catch((e) => { loading = null; throw e; });
        }
        return loading;
    },

    async set(biz) {
        if (biz === 'rentals' && rentalsRole()) return this.openRentals('rent');
        openSeq++;
        apply('shop');
        rentals?.leave();
        NavigationManager.showTabFromNav('billing');
    },

    async openRentals(page = 'rent', evt) {
        evt?.preventDefault?.();
        if (!rentalsRole()) return;
        const seq = ++openSeq;
        apply('rentals');
        NavigationManager.setMenuOpen(false);
        try {
            const mod = await this.load();
            if (seq !== openSeq || current !== 'rentals') return;
            await mod.enter(page);
        } catch (e) {
            console.error('Rentals failed to open:', e);
            UIManager.showToast(t('msg.rent.could_not_open'), 'error');
        }
    },

    /** Sign-out: stop rentals listeners and go back to Shop. */
    reset() {
        openSeq++;
        rentals?.leave();
        apply('shop');
    }
};
