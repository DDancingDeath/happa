/**
 * @fileoverview UI Manager Module
 * Provides centralized UI utility functions for the Aadhat Management App.
 * Handles loading states, toasts, modals, and haptic feedback.
 * @module ui/ui-manager
 */

// -------------------- UI UTILITIES --------------------

import { AppState } from '../utils/state.js';
import { t } from '../i18n/index.js';
import { emit, TOAST_ERROR } from '../utils/events.js';
import { closeTopDialog, trapFocus } from '../utils/keyboard-shortcuts.js';

// #toast and #loadingOverlay are declared inside #appContent, which is hidden until login.
// Move them to <body> so they are also visible on the login/register screen.
function attachToBody(el) {
    if (el && el.parentElement !== document.body) {
        document.body.appendChild(el);
    }
    return el;
}

let toastTimer = null;
let loadingShown = false;
let loadingHolds = 0;

/** Confirm button of #modalOverlay: "OK", or a verb (and danger) for this one dialog. */
function setConfirmButton({ confirmLabel = '', danger = false } = {}) {
    const btn = document.getElementById('modalConfirm');
    if (!btn) return;
    if (confirmLabel) {
        btn.removeAttribute('data-i18n');
        btn.textContent = confirmLabel;
    } else {
        btn.setAttribute('data-i18n', 'ui.modals.ok');
        btn.textContent = t('ui.modals.ok');
    }
    btn.classList.toggle('modal-btn-danger', !!danger);
}

// -------------------- The app dialog (#modalOverlay) --------------------
// One controller for showModal, showModalWithHtml and showCustomModal: a .dialog from 600 px, a bottom
// .sheet below. Esc and Back close it through keyboard-shortcuts.js closeTopDialog (Cancel, or OK on an
// alert); a tap on the scrim does the same. Tab stays inside; focus goes back to the opener.

const SHEET_QUERY = '(max-width: 599.98px)';
/** A second tap of a double-tap lands within this time; it must not answer the dialog it just opened. */
const TAP_GUARD_MS = 350;
let modalOpener = null;
let modalOpenedAt = 0;

const narrowScreen = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(SHEET_QUERY).matches;

function fitModalBox(box) {
    if (!box) return;
    const sheet = narrowScreen();
    box.classList.toggle('sheet', sheet);
    box.classList.toggle('dialog', !sheet);
}

function tooSoonTap(e) {
    return !!e.isTrusted && e.pointerType === 'touch' && Date.now() - modalOpenedAt < TAP_GUARD_MS;
}

function bindModalController(overlay, box) {
    if (overlay.dataset.controller) return;
    overlay.dataset.controller = '1';
    overlay.addEventListener('click', (e) => {
        if (tooSoonTap(e)) {
            e.stopImmediatePropagation();
            e.preventDefault();
        }
    }, true);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay && overlay.classList.contains('active')) closeTopDialog();
    });
    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') trapFocus(e, box);
    });
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        window.matchMedia(SHEET_QUERY).addEventListener?.('change', () => fitModalBox(document.getElementById('modalBox')));
    }
}

/**
 * Answers a dialog that is still open as dismissed (Cancel, OK for an alert, null for a custom
 * modal), as Esc would, before another one takes its place: no caller waits forever.
 */
function dismissOpenModal(overlay) {
    const previous = AppState.modalResolve;
    if (!previous || !overlay.classList.contains('active')) return;
    AppState.modalResolve = null;
    const cancel = document.getElementById('modalCancel');
    const hadCancel = !!cancel && !cancel.hidden && cancel.style.display !== 'none';
    previous(previous.custom ? null : !hadCancel);
}

function openModal(overlay, resolve, { custom = false } = {}) {
    const box = document.getElementById('modalBox') || overlay.querySelector('.modal-box');
    const active = document.activeElement;
    if (!overlay.classList.contains('active') && !(box && box.contains(active))) modalOpener = active;
    if (box) {
        bindModalController(overlay, box);
        fitModalBox(box);
    }
    if (custom) resolve.custom = true;
    AppState.modalResolve = resolve;
    modalOpenedAt = Date.now();
    overlay.classList.add('active');
    if (box && typeof box.focus === 'function') {
        box.focus({ preventScroll: true });
        if (document.activeElement !== box && typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => {
                if (overlay.classList.contains('active') && !box.contains(document.activeElement)) box.focus({ preventScroll: true });
            });
        }
    }
}

/** The stock title, OK and Cancel back in place (showCustomModal hides them). */
function resetModalParts() {
    document.querySelectorAll('#modalFooter [data-custom]').forEach(b => b.remove());
    const header = document.getElementById('modalHeader');
    if (header) header.hidden = false;
    const ok = document.getElementById('modalConfirm');
    if (ok) ok.hidden = false;
    const cancel = document.getElementById('modalCancel');
    if (cancel) cancel.hidden = false;
}

function returnFocus(overlay) {
    const opener = modalOpener;
    modalOpener = null;
    const at = document.activeElement;
    if (at && at !== document.body && !overlay.contains(at)) return;
    if (opener && opener !== document.body && opener.isConnected && typeof opener.focus === 'function') {
        opener.focus({ preventScroll: true });
    }
    const now = document.activeElement;
    if (now && overlay.contains(now) && typeof now.blur === 'function') now.blur();
}

const TOAST_TYPES = ['success', 'error', 'warning', 'info'];
const TOAST_TYPE_DURATIONS = { error: 5000, warning: 4000, info: 3000, success: 2000 };

/**
 * Normalises showToast's flexible arguments.
 * Accepts (duration), (type) or (type, duration); a type string must never
 * reach setTimeout, where it would hide the toast after ~0 ms.
 * @param {number|string} [durationOrType]
 * @param {number} [maybeDuration]
 * @returns {{type: string|null, duration: number}}
 */
export function resolveToastOptions(durationOrType, maybeDuration) {
    let type = null;
    let duration = durationOrType;
    if (typeof durationOrType === 'string' && !/^\d+$/.test(durationOrType.trim())) {
        type = TOAST_TYPES.includes(durationOrType) ? durationOrType : null;
        duration = maybeDuration;
    }
    duration = Number(duration);
    if (!Number.isFinite(duration) || duration <= 0) {
        duration = (type && TOAST_TYPE_DURATIONS[type]) || 2000;
    }
    return { type, duration };
}

/**
 * Short id of an error message (#82): six digits, the same for the same text, so
 * the user can read it out and it finds the Diagnostics entry (telemetry fingerprint).
 * @param {string} message
 * @returns {string}
 */
export function errorRef(message) {
    const text = String(message ?? '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return String(Math.abs(hash) % 1000000).padStart(6, '0');
}

/**
 * UI Manager object containing all UI utility functions.
 * @namespace UIManager
 */
const UIManager = {
    /**
     * Shows the loading overlay.
     * @returns {void}
     */
    showLoading() {
        loadingShown = true;
        const overlay = attachToBody(document.getElementById('loadingOverlay'));
        if (overlay) overlay.classList.add('active');
    },

    /**
     * Hides the loading overlay, unless a holdLoading() is still active.
     * @returns {void}
     */
    hideLoading() {
        loadingShown = false;
        if (loadingHolds > 0) return;
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) overlay.classList.remove('active');
    },

    /**
     * Shows the loading overlay until the returned release() is called, even
     * if hideLoading() runs meanwhile (e.g. a print that outlives its save).
     * @returns {() => void} release (safe to call more than once)
     */
    holdLoading() {
        loadingHolds++;
        const overlay = attachToBody(document.getElementById('loadingOverlay'));
        if (overlay) overlay.classList.add('active');
        let released = false;
        return () => {
            if (released) return;
            released = true;
            loadingHolds--;
            if (loadingHolds > 0 || loadingShown) return;
            const el = document.getElementById('loadingOverlay');
            if (el) el.classList.remove('active');
        };
    },

    /**
     * Wraps an async operation with loading state.
     * Shows loading overlay before the operation, hides it after completion.
     * @async
     * @template T
     * @param {Promise<T>|Function} operation - The async operation or function to execute
     * @returns {Promise<T>} The result of the operation
     * @throws {Error} Rethrows any error from the operation after hiding loading
     * @example
     * // Usage with a promise
     * const result = await UIManager.withLoading(FirebaseService.loadItems());
     * 
     * // Usage with an async function
     * const result = await UIManager.withLoading(async () => {
     *     const items = await FirebaseService.loadItems();
     *     return items.filter(i => i.active);
     * });
     */
    async withLoading(operation) {
        this.showLoading();
        try {
            if (typeof operation === 'function') {
                return await operation();
            }
            return await operation;
        } finally {
            this.hideLoading();
        }
    },

    /**
     * Shows a toast notification message.
     * @param {string} message - The message to display
     * @param {number|string} [durationOrType=2000] - Duration in ms, or a type
     *   ('success' | 'error' | 'warning' | 'info') that sets the style and a
     *   sensible default duration (errors stay 5 s)
     * @param {number} [typeDuration] - Duration in ms when a type is given
     * @returns {void}
     */
    showToast(message, durationOrType, typeDuration) {
        const { type, duration } = resolveToastOptions(durationOrType, typeDuration);
        const toast = document.getElementById('toast');
        if (!toast) {
            // Fallback: create toast element if not found
            console.warn('Toast element not found, creating one...');
            const newToast = document.createElement('div');
            newToast.id = 'toast';
            newToast.className = 'toast';
            document.body.appendChild(newToast);
            return this.showToast(message, durationOrType, typeDuration); // Retry
        }
        
        attachToBody(toast);
        if (type === 'error') {
            const ref = errorRef(message);
            toast.textContent = `${message} · ${t('msg.common.error_ref', { ref })}`;
            emit(TOAST_ERROR, { message: String(message ?? ''), ref });
        } else {
            toast.textContent = message;
        }
        toast.classList.remove(...TOAST_TYPES);
        if (type) toast.classList.add(type);
        toast.classList.add('show');
        
        // Restart the timer so an earlier toast's timeout doesn't hide this one early
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toast.classList.remove('show');
        }, duration);
    },

    /**
     * Shows a modal dialog with message and optional cancel button.
     * @param {string} message - The message to display
     * @param {string} [title='Alert'] - The modal title
     * @param {boolean} [showCancel=false] - Whether to show cancel button
     * @param {{confirmLabel?: string, danger?: boolean}} [opts] - A verb for the confirm button; danger styles it destructive
     * @returns {Promise<boolean>} Resolves with user's choice (true for OK, false for Cancel, Esc, Back or a scrim tap)
     */
    showModal(message, title = t('ui.modals.alert'), showCancel = false, opts = {}) {
        return this.openStockModal((el) => { el.textContent = message; }, title, showCancel, opts);
    },

    /**
     * Shows a modal with HTML content. For trusted internal use only.
     * WARNING: Only use for trusted content. Consider DOMPurify for user-generated content.
     * @param {string} htmlMessage - The HTML message to display
     * @param {string} [title='Alert'] - The modal title
     * @param {boolean} [showCancel=false] - Whether to show cancel button
     * @param {{confirmLabel?: string, danger?: boolean}} [opts] - A verb for the confirm button; danger styles it destructive
     * @returns {Promise<boolean>} Resolves with user's choice
     */
    showModalWithHtml(htmlMessage, title = t('ui.modals.alert'), showCancel = false, opts = {}) {
        return this.openStockModal((el) => { el.innerHTML = htmlMessage; }, title, showCancel, opts);
    },

    /**
     * The dialog with its own title, message, Cancel and confirm (showModal, showModalWithHtml).
     * @param {(el: HTMLElement) => void} fill - writes the message
     * @returns {Promise<boolean>}
     */
    openStockModal(fill, title, showCancel, opts) {
        return new Promise((resolve) => {
            const overlay = document.getElementById('modalOverlay');
            const modalTitle = document.getElementById('modalTitle');
            const modalMessage = document.getElementById('modalMessage');
            const cancelBtn = document.getElementById('modalCancel');

            if (!overlay || !modalTitle || !modalMessage) {
                resolve(true);
                return;
            }

            dismissOpenModal(overlay);
            resetModalParts();
            modalTitle.textContent = title;
            fill(modalMessage);
            if (cancelBtn) cancelBtn.style.display = showCancel ? '' : 'none';
            setConfirmButton(opts);
            openModal(overlay, resolve);
        });
    },

    /**
     * Closes the modal dialog and resolves with result.
     * @param {boolean} result - The result to resolve the modal promise with
     * @returns {void}
     */
    closeModal(result) {
        const overlay = document.getElementById('modalOverlay');
        if (overlay) {
            overlay.classList.remove('active');
            returnFocus(overlay);
            const resolve = AppState.modalResolve;
            AppState.modalResolve = null;
            if (resolve) resolve(result);
        }
    },

    /**
     * Shows a custom modal with HTML content and custom buttons, in the same dialog.
     * WARNING: Only use for trusted content. Consider using DOMPurify for user-generated content.
     * A button whose value is null, false or undefined is the dismiss: Esc, Back and a scrim tap press it.
     * @param {string} html - The HTML content to display
     * @param {Array<{text: string, value: any, class?: string}>} buttons - Array of button configs
     * @returns {Promise<any>} Resolves with the clicked button's value
     */
    showCustomModal(html, buttons) {
        return new Promise((resolve) => {
            const overlay = document.getElementById('modalOverlay');
            const modalMessage = document.getElementById('modalMessage');
            const footer = document.getElementById('modalFooter');
            if (!overlay || !modalMessage || !footer) {
                resolve(null);
                return;
            }

            dismissOpenModal(overlay);
            resetModalParts();
            const header = document.getElementById('modalHeader');
            if (header) header.hidden = true;
            document.getElementById('modalConfirm')?.setAttribute('hidden', '');
            document.getElementById('modalCancel')?.setAttribute('hidden', '');
            modalMessage.innerHTML = html;
            (buttons || []).forEach(cfg => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = cfg.class || 'modal-btn';
                button.textContent = cfg.text;
                button.dataset.custom = '';
                if (cfg.value === null || cfg.value === false || cfg.value === undefined) button.dataset.dismiss = '';
                button.addEventListener('click', () => this.closeModal(cfg.value));
                footer.appendChild(button);
            });
            openModal(overlay, resolve, { custom: true });
        });
    },

    /**
     * Triggers haptic feedback vibration on supported devices.
     * @param {'light'|'medium'|'heavy'|'success'|'error'} [type='light'] - Type of haptic feedback
     * @returns {void}
     */
    hapticFeedback(type = 'light') {
        try {
            if ('vibrate' in navigator) {
                switch (type) {
                    case 'light':
                        navigator.vibrate(10);
                        break;
                    case 'medium':
                        navigator.vibrate(20);
                        break;
                    case 'heavy':
                        navigator.vibrate(50);
                        break;
                    case 'success':
                        navigator.vibrate([10, 50, 10]);
                        break;
                    case 'error':
                        navigator.vibrate([50, 100, 50]);
                        break;
                }
            }
        } catch (e) {
            // Haptic feedback not supported on this device
        }
    }
};

// Export UIManager
export { UIManager };
