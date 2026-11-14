// @ts-check
// Desktop keyboard shortcuts (active only at >= 1024px wide).
// resolveShortcut() is pure (key event + context -> action) so it can be unit-tested;
// installKeyboardShortcuts() wires it to the DOM.

import { t, LANG_CHANGE_EVENT } from '../i18n/index.js';
import { icon } from '../ui/icons.js';
import { pickLang } from '../i18n/localize.js';

export const DESKTOP_QUERY = '(min-width: 1024px)';

// Alt+1..9 -> first nine side-nav tabs, in navigation.html order.
export const TAB_SHORTCUTS = [
    { tabId: 'day', en: 'Today', hi: 'आज' },
    { tabId: 'billing', en: 'Billing', hi: 'बिलिंग' },
    { tabId: 'wholesale-sales', en: 'Wholesale', hi: 'थोक' },
    { tabId: 'expenses', en: 'Expenses', hi: 'खर्च' },
    { tabId: 'rates', en: 'Rates', hi: 'रेट' },
    { tabId: 'history', en: 'History', hi: 'इतिहास' },
    { tabId: 'stock', en: 'Stock', hi: 'स्टॉक' },
    { tabId: 'due', en: 'Outstanding', hi: 'बकाया' },
    { tabId: 'money', en: 'Money', hi: 'हिसाब' }
];

/** @type {Object<string, {save: string, print: string}>} */
const BILL_BUTTONS = {
    purchase: { save: '#saveBillBtn', print: '#printBillBtn' },
    sale: { save: '#saveSaleBtn', print: '#printSaleBtn' },
    wholesale: { save: '#salesEntrySection .save-sale-btn', print: '#salesEntrySection .print-sale-btn' }
};

/**
 * Which bill (if any) Ctrl+S / Ctrl+P act on for the given context.
 * @param {Rec} ctx
 * @returns {?string}
 */
function currentBill(ctx) {
    if (ctx.activeTab === 'billing') return ctx.billingMode === 'sale' ? 'sale' : 'purchase';
    if (ctx.activeTab === 'wholesale-sales' && ctx.wholesaleEntryVisible) return 'wholesale';
    return null;
}

/**
 * Map a keydown to an action.
 * @param {{key:string, code?:string, ctrlKey?:boolean, metaKey?:boolean, altKey?:boolean, shiftKey?:boolean, repeat?:boolean}} evt
 * @param {{typing?:boolean, modalOpen?:boolean, helpOpen?:boolean, activeTab?:string|null,
 *          billingMode?:string, wholesaleEntryVisible?:boolean}} ctx
 * @returns {null | {type:'tab', tabId:string} | {type:'click', selector:string}
 *          | {type:'focus-search'} | {type:'toggle-help'} | {type:'close-help'} | {type:'close-modal'}}
 */
export function resolveShortcut(evt, ctx = {}) {
    if (!evt || !ctx.activeTab) return null;
    const ctrl = !!(evt.ctrlKey || evt.metaKey);
    const alt = !!evt.altKey;
    const key = typeof evt.key === 'string' ? evt.key : '';

    if (key === 'Escape') {
        if (ctx.helpOpen) return { type: 'close-help' };
        if (ctx.modalOpen) return { type: 'close-modal' };
        return null;
    }
    if (ctx.helpOpen) {
        return !ctrl && !alt && key === '?' ? { type: 'toggle-help' } : null;
    }

    if (ctrl && !alt) {
        const k = key.toLowerCase();
        if ((k !== 's' && k !== 'p') || evt.shiftKey || ctx.modalOpen) return null;
        const bill = currentBill(ctx);
        if (!bill || evt.repeat) return null;
        return { type: 'click', selector: BILL_BUTTONS[bill][k === 's' ? 'save' : 'print'] };
    }

    if (alt && !ctrl) {
        const m = /^Digit([1-9])$/.exec(evt.code || '') || /^([1-9])$/.exec(key);
        if (!m || ctx.modalOpen || evt.repeat) return null;
        const entry = TAB_SHORTCUTS[Number(m[1]) - 1];
        return entry ? { type: 'tab', tabId: entry.tabId } : null;
    }

    if (ctrl || alt || ctx.typing || ctx.modalOpen) return null;
    if (key === '/') return { type: 'focus-search' };
    if (key === '?') return { type: 'toggle-help' };
    return null;
}

// ---------------------------------------------------------------------------
// DOM wiring
// ---------------------------------------------------------------------------

const HELP_ID = 'kbdHelpOverlay';

/**
 * @param {*} el
 * @returns {boolean}
 */
function isTypingTarget(el) {
    if (!el || !el.tagName) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea' || tag === 'select') return true;
    if (tag !== 'input') return false;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color'].includes(type);
}

/**
 * @param {?Element} el
 * @returns {boolean}
 */
function isShown(el) {
    return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}

/** Topmost open dialog: { closer: () => void | null } or null when none is open. */
function findOpenModal() {
    const alertOverlay = document.getElementById('modalOverlay');
    if (alertOverlay && alertOverlay.classList.contains('active')) {
        const cancel = document.getElementById('modalCancel');
        const ok = document.getElementById('modalConfirm');
        if (cancel && isShown(cancel)) return { closer: () => cancel.click() };
        // Alert-only dialog: Esc acknowledges it. Custom modals (no stock buttons) are left alone.
        if (ok && isShown(ok)) return { closer: () => ok.click() };
        return { closer: null };
    }
    // Popups built in JS (Users role change, Expense delete, ...) are full-screen fixed
    // children of <body> with no shared class; appended last, they sit on top.
    const generic = [...document.body.children].filter(isBodyOverlay);
    const top = generic[generic.length - 1] ||
        [...document.querySelectorAll('.bill-details-overlay, .modal, .sheet[aria-modal="true"]')].filter(isShown).pop();
    if (top) {
        const btn = findCloseControl(top);
        if (btn) return { closer: () => btn.click() };
        // Backdrop-click-to-dismiss popups: simulate a click on the backdrop itself.
        if (typeof /** @type {HTMLElement} */ (top).onclick === 'function') return { closer: () => /** @type {HTMLElement} */ (top).click() };
        return { closer: null };
    }
    return null;
}

/** Closes the topmost open dialog; true when one was closed. */
export function closeTopDialog() {
    const open = findOpenModal();
    if (!open || !open.closer) return false;
    open.closer();
    return true;
}

const NON_DIALOG_IDS = new Set(['appContent', 'toast', 'loadingOverlay', 'overlay', 'modalOverlay', HELP_ID]);

/**
 * @param {Element} el
 * @returns {boolean}
 */
function isBodyOverlay(el) {
    if (NON_DIALOG_IDS.has(el.id) || !isShown(el)) return false;
    if (getComputedStyle(el).position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    return r.width >= window.innerWidth * 0.9 && r.height >= window.innerHeight * 0.9;
}

const CLOSE_SELECTOR = '.bill-details-close, .bill-action-btn.btn-close, .modal-close, [data-dismiss]';
const CLOSE_TEXT = /^(cancel|close|✕|×|रद्द|रहने|बंद)/i;

/**
 * The control that dismisses a dialog without side effects: a known close button,
 * else a button labelled/identified as Cancel/Close. Null when there is none.
 * @param {Element} root
 * @returns {HTMLElement|null}
 */
export function findCloseControl(root) {
    if (!root) return null;
    const explicit = root.querySelector(CLOSE_SELECTOR);
    if (explicit) return /** @type {HTMLElement} */ (explicit);
    return /** @type {HTMLElement[]} */ ([...root.querySelectorAll('button, [role="button"]')]).find(b =>
        CLOSE_TEXT.test((b.textContent || '').trim()) || /cancel|close/i.test(b.id || '')
    ) || null;
}

/**
 * @param {?EventTarget} target
 * @returns {Rec}
 */
function buildContext(target) {
    const appContent = document.getElementById('appContent');
    const activeTabEl = appContent && !appContent.classList.contains('hidden')
        ? appContent.querySelector('.tab.active') : null;
    const saleSection = document.getElementById('saleSection');
    const wholesaleEntry = document.getElementById('salesEntrySection');
    return {
        typing: isTypingTarget(target),
        modalOpen: !!findOpenModal(),
        helpOpen: !!document.getElementById(HELP_ID),
        activeTab: activeTabEl ? activeTabEl.id : null,
        billingMode: saleSection && saleSection.style.display !== 'none' ? 'sale' : 'purchase',
        wholesaleEntryVisible: !!wholesaleEntry && wholesaleEntry.style.display !== 'none'
    };
}

function closeHelp() {
    const el = document.getElementById(HELP_ID);
    if (el) el.remove();
}

function openHelp() {
    if (document.getElementById(HELP_ID)) return;
    const esc = (/** @type {*} */ s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const row = (/** @type {string} */ keys, /** @type {string} */ label) => `<tr><td>${keys}</td><td>${esc(label)}</td></tr>`;
    const tabRows = TAB_SHORTCUTS.map((tab, i) => row(`<kbd class="kbd">Alt</kbd> + <kbd class="kbd">${i + 1}</kbd>`, pickLang(tab))).join('');
    const overlay = document.createElement('div');
    overlay.id = HELP_ID;
    overlay.className = 'kbd-help-overlay';
    overlay.innerHTML = `
        <div class="kbd-help" role="dialog" aria-modal="true" aria-labelledby="kbdHelpTitle">
            <h3 id="kbdHelpTitle">${esc(t('ui.kbd.title'))}</h3>
            <table><tbody>
                ${tabRows}
                ${row('<kbd class="kbd">Ctrl</kbd> + <kbd class="kbd">S</kbd>', t('ui.kbd.save_bill'))}
                ${row('<kbd class="kbd">Ctrl</kbd> + <kbd class="kbd">P</kbd>', t('ui.kbd.save_print_bill'))}
                ${row('<kbd class="kbd">/</kbd>', t('ui.kbd.search_page'))}
                ${row('<kbd class="kbd">Esc</kbd>', t('ui.kbd.close_dialog'))}
                ${row('<kbd class="kbd">?</kbd>', t('ui.kbd.toggle_help'))}
            </tbody></table>
            <button type="button" class="btn btn-primary kbd-help-close">${esc(t('ui.kbd.close'))}</button>
        </div>`;
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay || /** @type {Element} */ (e.target).classList.contains('kbd-help-close')) closeHelp();
    });
    document.body.appendChild(overlay);
}

/**
 * @param {string} tabId
 * @returns {boolean}
 */
function focusSearch(tabId) {
    const tab = document.getElementById(tabId);
    if (!tab) return false;
    const input = /** @type {HTMLInputElement[]} */ ([...tab.querySelectorAll('input[type="search"], input[id*="Search"], input[id*="search"]')]).find(isShown);
    if (!input) return false;
    input.focus();
    if (typeof input.select === 'function') input.select();
    return true;
}

/**
 * Run an action; returns true when the key was consumed.
 * @param {Rec} action
 * @param {Rec} ctx
 * @returns {boolean}
 */
function perform(action, ctx) {
    switch (action.type) {
        case 'tab':
            if (!window.app || !window.app.nav) return false;
            window.app.nav.showTab(action.tabId);
            return true;
        case 'click': {
            const btn = document.querySelector(action.selector);
            if (!btn || btn.disabled || !isShown(btn)) return false;
            btn.click();
            return true;
        }
        case 'focus-search':
            return focusSearch(ctx.activeTab);
        case 'toggle-help':
            if (document.getElementById(HELP_ID)) closeHelp(); else openHelp();
            return true;
        case 'close-help':
            closeHelp();
            return true;
        case 'close-modal': {
            const open = findOpenModal();
            if (!open || !open.closer) return false;
            open.closer();
            return true;
        }
        default:
            return false;
    }
}

const RAIL_QUERY = '(min-width: 1024px) and (max-width: 1279.98px)';

/**
 * Alt+N hint on the sidebar link of each shortcut page, and in the icon rail the link's name as its tooltip.
 * @param {Element} nav
 */
function decorateSidebar(nav) {
    const rail = window.matchMedia(RAIL_QUERY).matches;
    TAB_SHORTCUTS.forEach((tab, i) => {
        const link = nav.querySelector(`.nav-menu a[data-onclick*="showTab('${tab.tabId}'"]`);
        if (!link || link.querySelector('.nav-kbd')) return;
        link.setAttribute('aria-keyshortcuts', `Alt+${i + 1}`);
        const kbd = document.createElement('kbd');
        kbd.className = 'kbd nav-kbd';
        kbd.setAttribute('aria-hidden', 'true');
        kbd.lang = 'zxx';
        kbd.textContent = `Alt ${i + 1}`;
        link.appendChild(kbd);
    });
    nav.querySelectorAll('.nav-menu a, .desktop-shortcuts-link').forEach((/** @type {Element} */ link) => {
        const label = link.querySelector('[data-i18n]')?.textContent.trim();
        const keys = link.getAttribute('aria-keyshortcuts');
        if (rail && label) link.setAttribute('title', keys ? `${label} (${keys})` : label);
        else link.removeAttribute('title');
    });
}

function addSidebarLink() {
    const nav = document.getElementById('sideNav');
    if (!nav) return false;
    if (!nav.querySelector('.desktop-shortcuts-link')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'desktop-shortcuts-link';
        btn.setAttribute('aria-keyshortcuts', '?');
        btn.innerHTML = `<span class="nav-icon">${icon('keyboard')}</span><span data-i18n="ui.kbd.sidebar_link"></span><kbd class="kbd nav-kbd" aria-hidden="true">?</kbd>`;
        /** @type {HTMLElement} */ (btn.querySelector('[data-i18n]')).textContent = t('ui.kbd.sidebar_link');
        btn.addEventListener('click', openHelp);
        (nav.querySelector('.nav-menu-footer') || nav).appendChild(btn);
    }
    decorateSidebar(nav);
    return true;
}

export function installKeyboardShortcuts() {
    if (window.__aadhatShortcutsInstalled) return;
    window.__aadhatShortcutsInstalled = true;
    const mq = window.matchMedia(DESKTOP_QUERY);

    document.addEventListener('keydown', (e) => {
        if (!mq.matches || e.defaultPrevented || e.isComposing) return;
        const ctx = buildContext(e.target);
        const action = resolveShortcut(e, ctx);
        if (action && perform(action, ctx)) e.preventDefault();
    });

    const redecorate = () => { const nav = document.getElementById('sideNav'); if (nav) decorateSidebar(nav); };
    window.matchMedia(RAIL_QUERY).addEventListener?.('change', redecorate);
    window.addEventListener(LANG_CHANGE_EVENT, redecorate);

    if (!addSidebarLink()) {
        const obs = new MutationObserver(() => { if (addSidebarLink()) obs.disconnect(); });
        obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
    }
}

if (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && typeof document !== 'undefined') {
    installKeyboardShortcuts();
}
