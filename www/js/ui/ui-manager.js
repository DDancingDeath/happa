/**
 * @fileoverview UI Manager Module
 * Provides centralized UI utility functions for the Aadhat Management App.
 * Handles loading states, toasts, modals, and haptic feedback.
 * @module ui/ui-manager
 */

// -------------------- UI UTILITIES --------------------

import { AppState } from '../utils/state.js';
import { t } from '../i18n/index.js';

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
        toast.textContent = message;
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
     * @returns {Promise<boolean>} Resolves with user's choice (true for OK, false for Cancel)
     */
    showModal(message, title = t('ui.modals.alert'), showCancel = false) {
        return new Promise((resolve) => {
            const overlay = document.getElementById('modalOverlay');
            const modalTitle = document.getElementById('modalTitle');
            const modalMessage = document.getElementById('modalMessage');
            const cancelBtn = document.getElementById('modalCancel');
            
            if (!overlay || !modalTitle || !modalMessage) {
                resolve(true);
                return;
            }
            
            modalTitle.textContent = title;
            // Use textContent to prevent XSS attacks
            modalMessage.textContent = message;
            cancelBtn.style.display = showCancel ? 'inline-block' : 'none';
            overlay.classList.add('active');
            
            AppState.modalResolve = resolve;
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
            if (AppState.modalResolve) {
                AppState.modalResolve(result);
                AppState.modalResolve = null;
            }
        }
    },

    /**
     * Shows a custom modal with HTML content and custom buttons.
     * WARNING: Only use for trusted content. Consider using DOMPurify for user-generated content.
     * @param {string} html - The HTML content to display
     * @param {Array<{text: string, value: any, class?: string}>} buttons - Array of button configs
     * @returns {Promise<any>} Resolves with the clicked button's value
     */
    showCustomModal(html, buttons) {
        return new Promise((resolve) => {
            const overlay = document.getElementById('modalOverlay');
            const modalBox = overlay.querySelector('.modal-box');
            
            // Create content safely using DOM methods where possible
            modalBox.innerHTML = '';
            
            const contentDiv = document.createElement('div');
            contentDiv.className = 'modal-content';
            // For custom modals, we trust the caller has sanitized the HTML
            // In production, consider using DOMPurify: contentDiv.innerHTML = DOMPurify.sanitize(html);
            contentDiv.innerHTML = html;
            modalBox.appendChild(contentDiv);
            
            const footer = document.createElement('div');
            footer.className = 'modal-footer';
            
            buttons.forEach(btn => {
                const button = document.createElement('button');
                button.className = btn.class || 'modal-btn';
                button.textContent = btn.text;
                button.onclick = () => {
                    overlay.classList.remove('active');
                    resolve(btn.value);
                };
                footer.appendChild(button);
            });
            
            modalBox.appendChild(footer);
            overlay.classList.add('active');
        });
    },

    /**
     * Shows a modal with HTML content. For trusted internal use only.
     * WARNING: Only use for trusted content. Consider DOMPurify for user-generated content.
     * @param {string} htmlMessage - The HTML message to display
     * @param {string} [title='Alert'] - The modal title
     * @param {boolean} [showCancel=false] - Whether to show cancel button
     * @returns {Promise<boolean>} Resolves with user's choice
     */
    showModalWithHtml(htmlMessage, title = t('ui.modals.alert'), showCancel = false) {
        return new Promise((resolve) => {
            const overlay = document.getElementById('modalOverlay');
            const modalTitle = document.getElementById('modalTitle');
            const modalMessage = document.getElementById('modalMessage');
            const cancelBtn = document.getElementById('modalCancel');
            
            if (!overlay || !modalTitle || !modalMessage) {
                resolve(true);
                return;
            }
            
            modalTitle.textContent = title;
            // WARNING: Only use for trusted content. Consider DOMPurify for user-generated content.
            modalMessage.innerHTML = htmlMessage;
            cancelBtn.style.display = showCancel ? 'inline-block' : 'none';
            overlay.classList.add('active');
            
            AppState.modalResolve = resolve;
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
