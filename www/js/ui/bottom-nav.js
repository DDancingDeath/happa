/**
 * @fileoverview Phone navigation (#142): the bottom tab bar (templates/navigation.html,
 * hidden at >= 1024 px by desktop.css), pull-to-refresh on the open page and, when
 * switched on in Settings, swiping left/right between the bar's pages.
 * @module ui/bottom-nav
 */

import { safeSetItem } from '../utils/storage-full.js';

/** The bar's pages, left to right (tab element ids); "More" opens the side menu. */
export const BAR_TABS = Object.freeze(['billing', 'day', 'history', 'due']);
const SWIPE_KEY = 'aadhat.swipeTabs';
/** Pull distance (px) that refreshes on release. */
export const PULL_REFRESH_PX = 70;
const SWIPE_MIN_PX = 80;

/**
 * The bar page a swipe goes to, or null.
 * @param {string} tab - open tab id
 * @param {number} dx - horizontal travel (negative = towards the left: next page)
 * @param {number} dy - vertical travel
 * @returns {?string}
 */
export function swipeTarget(tab, dx, dy) {
    const at = BAR_TABS.indexOf(tab);
    if (at === -1 || Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < 2 * Math.abs(dy)) return null;
    return BAR_TABS[at + (dx < 0 ? 1 : -1)] || null;
}

/** True when a touch starting at `el` belongs to something else (a field, a sideways-scrolling table, a dialog). */
function ownGesture(el, tabEl) {
    for (let n = el; n && n !== tabEl; n = n.parentElement) {
        if (/^(INPUT|SELECT|TEXTAREA)$/.test(n.tagName) || n.isContentEditable) return true;
        if (n.scrollWidth > n.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowX)) return true;
    }
    return false;
}

const NO_KEYBOARD = /^(checkbox|radio|range|button|submit|reset|file|color|image)$/;
/** Text fields bring up the on-screen keyboard; checkboxes, selects and buttons don't. */
export const opensKeyboard = (el) => !!el && (el.tagName === 'TEXTAREA' || el.isContentEditable === true
    || (el.tagName === 'INPUT' && !NO_KEYBOARD.test(String(el.type || 'text').toLowerCase())));

const somethingOpen = () => !!document.querySelector('.side-nav.active, .modal-overlay.active, .bill-details-overlay.active, #notifPanel:not([hidden])');

export const BottomNav = {
    swipeOn: false,

    /**
     * @param {Object} opts
     * @param {function(string)} opts.showTab - open a page (swipe)
     * @param {Object<string, Function>} opts.refreshers - tab id → its data-only reload (pull-to-refresh); pages without one don't pull
     * @param {Function} [opts.onRefreshed]
     */
    init({ showTab, refreshers = {}, onRefreshed } = {}) {
        if (this.bound) return;
        this.bound = true;
        this.showTab = showTab;
        this.refreshers = refreshers;
        this.onRefreshed = onRefreshed;
        try { this.swipeOn = localStorage.getItem(SWIPE_KEY) === '1'; } catch { this.swipeOn = false; }
        const box = document.getElementById('settingSwipeTabs');
        if (box) box.checked = this.swipeOn;
        window.addEventListener('aadhat:tabshown', (e) => this.markActive(e.detail?.tabId));
        // The on-screen keyboard would push the bar over the field being typed in
        document.addEventListener('focusin', (e) => document.body.classList.toggle('typing', opensKeyboard(e.target)));
        document.addEventListener('focusout', () => document.body.classList.remove('typing'));
        this.bindGestures();
    },

    /** Highlights the open page's item ("More" for pages not on the bar). */
    markActive(tabId) {
        const items = document.querySelectorAll('.bottom-nav-item');
        const onBar = BAR_TABS.includes(tabId);
        items.forEach(item => {
            const here = onBar ? item.dataset.tab === tabId : item.dataset.tab === 'more';
            item.classList.toggle('active', here);
            if (here && onBar) item.setAttribute('aria-current', 'page');
            else item.removeAttribute('aria-current');
        });
    },

    /** Pull-to-refresh: the page's own data reload (no filter or form reset). */
    refreshPage(tab) {
        const fn = this.refreshers?.[tab];
        if (!fn) return Promise.resolve(false);
        return Promise.resolve()
            .then(fn)
            .then((ok) => {
                if (ok === false) return false;
                this.onRefreshed?.();
                return true;
            })
            .catch(e => { console.warn('Pull-to-refresh failed:', e); return false; });
    },

    setSwipe(on) {
        this.swipeOn = !!on;
        safeSetItem(SWIPE_KEY, on ? '1' : '0');
    },

    bindGestures() {
        let start = null;
        const pill = () => document.getElementById('pullRefresh');
        const phone = () => !window.matchMedia || !window.matchMedia('(min-width: 1024px)').matches;
        document.addEventListener('touchstart', (e) => {
            const tabEl = e.target?.closest?.('.tab.active');
            const touch = e.touches?.[0];
            if (!tabEl || !touch || e.touches.length > 1 || !phone() || somethingOpen() || ownGesture(e.target, tabEl)) { start = null; return; }
            start = { x: touch.clientX, y: touch.clientY, top: tabEl.scrollTop <= 0 && !!this.refreshers?.[tabEl.id], tab: tabEl.id, pulled: 0 };
        }, { passive: true });
        document.addEventListener('touchmove', (e) => {
            const touch = e.touches?.[0];
            if (!start || !touch || !start.top) return;
            const dy = touch.clientY - start.y;
            const dx = touch.clientX - start.x;
            const el = pill();
            if (!el) return;
            if (dy > 10 && dy > Math.abs(dx) * 1.5) {
                start.pulled = dy;
                el.hidden = false;
                el.classList.toggle('ready', dy >= PULL_REFRESH_PX);
                el.style.transform = `translate(-50%, ${Math.min(dy, 120) / 2}px)`;
            } else if (start.pulled) {
                start.pulled = 0;
                el.hidden = true;
            }
        }, { passive: true });
        document.addEventListener('touchend', (e) => {
            const touch = e.changedTouches?.[0];
            const s = start;
            start = null;
            const el = pill();
            if (el) { el.hidden = true; el.classList.remove('ready'); el.style.transform = ''; }
            if (!s || !touch) return;
            const dx = touch.clientX - s.x;
            const dy = touch.clientY - s.y;
            if (s.top && s.pulled && dy >= PULL_REFRESH_PX) { this.refreshPage(s.tab); return; }
            if (!this.swipeOn) return;
            const to = swipeTarget(s.tab, dx, dy);
            if (to) this.showTab?.(to);
        }, { passive: true });
        document.addEventListener('touchcancel', () => {
            start = null;
            const el = pill();
            if (el) el.hidden = true;
        }, { passive: true });
    }
};
