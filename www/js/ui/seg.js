/**
 * @fileoverview Keyboard for tabs (UX C3, plan 6.2). Every `role="tablist"` gets a roving tabindex
 * (only the selected tab is in the Tab order) and Left / Right / Home / End move to a tab and
 * activate it through its own click handler (`data-onclick` or a listener). Installed once on the
 * document, so tablists drawn later work too.
 * @module ui/seg
 */

const TAB = '[role="tab"]';
const LIST = '[role="tablist"]';

/**
 * The tablist's own usable tabs, in order (not hidden, not disabled, not in a nested tablist).
 * @param {Element} list
 * @returns {HTMLElement[]}
 */
export function tabsOf(list) {
    return [...list.querySelectorAll(TAB)].filter(tab => tab.closest(LIST) === list
        && !tab.hidden && !tab.disabled && tab.getAttribute('aria-disabled') !== 'true');
}

/**
 * Roving tabindex: the selected tab (else the first) is 0, the rest -1.
 * @param {Element} list
 */
export function syncTablist(list) {
    const tabs = tabsOf(list);
    const current = tabs.find(tab => tab.getAttribute('aria-selected') === 'true') || tabs[0];
    list.querySelectorAll(TAB).forEach(tab => {
        if (tab.closest(LIST) === list) tab.tabIndex = tab === current ? 0 : -1;
    });
}

/** @param {ParentNode} [root] */
export function syncAllTablists(root = document) {
    root.querySelectorAll(LIST).forEach(syncTablist);
}

/**
 * The tab an arrow key moves to from `from`, or null for any other key.
 * @param {HTMLElement[]} tabs
 * @param {HTMLElement} from
 * @param {string} key
 * @param {boolean} [vertical]
 * @returns {?HTMLElement}
 */
export function targetTab(tabs, from, key, vertical = false) {
    if (!tabs.length) return null;
    const i = tabs.indexOf(from);
    const prev = vertical ? 'ArrowUp' : 'ArrowLeft';
    const next = vertical ? 'ArrowDown' : 'ArrowRight';
    if (key === 'Home') return tabs[0];
    if (key === 'End') return tabs[tabs.length - 1];
    if (key === next) return tabs[(i + 1) % tabs.length];
    if (key === prev) return tabs[(i - 1 + tabs.length) % tabs.length];
    return null;
}

/** @param {KeyboardEvent} event */
function onKeydown(event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const from = event.target?.closest?.(TAB);
    const list = from?.closest(LIST);
    if (!list) return;
    const to = targetTab(tabsOf(list), from, event.key, list.getAttribute('aria-orientation') === 'vertical');
    if (!to) return;
    event.preventDefault();
    if (to === from) return;
    list.querySelectorAll(TAB).forEach(tab => { if (tab.closest(LIST) === list) tab.tabIndex = tab === to ? 0 : -1; });
    const host = list.parentElement;
    const index = tabsOf(list).indexOf(to);
    to.focus();
    to.click();
    // A handler that redraws its tablist (Admin) drops focus: put it on the redrawn tab
    if (!to.isConnected && host?.isConnected) {
        const again = host.querySelector(LIST);
        const tabs = again ? tabsOf(again) : [];
        const tab = tabs.find(t => t.getAttribute('aria-selected') === 'true') || tabs[index];
        if (tab) { syncTablist(again); tab.focus(); }
    }
}

/** @param {FocusEvent} event */
function onFocusIn(event) {
    const list = event.target?.closest?.(TAB)?.closest(LIST);
    if (list) syncTablist(list);
}

let installed = false;

/** Adds the document listeners and keeps every tablist's tabindex in step with `aria-selected`. */
export function installTablistKeys(doc = document) {
    if (installed) return;
    installed = true;
    doc.addEventListener('keydown', onKeydown);
    doc.addEventListener('focusin', onFocusIn);
    syncAllTablists(doc);
    if (typeof MutationObserver !== 'function') return;
    let queued = false;
    new MutationObserver(() => {
        if (queued) return;
        queued = true;
        queueMicrotask(() => { queued = false; syncAllTablists(doc); });
    }).observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-selected', 'hidden', 'role'] });
}
