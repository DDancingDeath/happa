/**
 * Utility Helpers Module
 * Common utility functions used throughout the application
 * @module utils/helpers
 */

/**
 * Static utility helper class
 */
import { t, getLang } from '../i18n/index.js';
import { formatRupees } from './money.js';
import { formatDay, formatDayTime, formatTimeOfDay } from './dates.js';
import { dayCounter } from '../firebase/repos/counters.js';

export class Helpers {
    // -------------------- FORMATTING --------------------

    /**
     * Display label for a stored user role. The stored value 'staff' is shown as "Member":
     * the owner doesn't want people using the app to be called staff.
     * @param {string} role - Stored role value ('owner' | 'manager' | 'staff')
     * @returns {string} Label to show in the UI
     */
    static roleLabel(role) {
        const keys = { owner: 'ui.roles.owner', manager: 'ui.roles.manager', staff: 'ui.roles.member' };
        return keys[role] ? t(keys[role]) : String(role ?? '');
    }
    
    /**
     * Escape HTML to prevent XSS attacks
     * @param {*} text - Text to escape (null/undefined become '', other values are stringified)
     * @returns {string} Escaped HTML string
     */
    static escapeHtml(text) {
        if (text === null || text === undefined) return '';
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;',
            '`': '&#096;'
        };
        return String(text).replace(/[&<>"'`]/g, m => map[m]);
    }

    /**
     * Escape a value for use inside a single- or double-quoted JS string literal that sits
     * inside an HTML attribute, e.g. onclick="fn('${Helpers.escapeJsAttr(name)}')".
     * HTML-escaping alone is not enough there: the browser decodes &#039; back to ' before
     * running the handler, so the value is JS-escaped first and then HTML-escaped.
     * @param {*} text - Value to escape
     * @returns {string} Escaped string
     */
    static escapeJsAttr(text) {
        if (text === null || text === undefined) return '';
        const js = String(text)
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/"/g, '\\"')
            .replace(/`/g, '\\`')
            .replace(/\r/g, '\\r')
            .replace(/\n/g, '\\n')
            .replace(/\u2028/g, '\\u2028')
            .replace(/\u2029/g, '\\u2029')
            .replace(/</g, '\\x3C')
            .replace(/>/g, '\\x3E');
        return Helpers.escapeHtml(js);
    }

    /**
     * The app's date format, "25 Oct 2026" (utils/dates.js formatDay, in the app language).
     * @param {*} date
     * @returns {string} '' when there is no usable date
     */
    static formatDate(date) {
        if (!date) return '';
        return formatDay(date, { lang: getLang() });
    }

    /**
     * The app's date-and-time format, "25 Oct, 8:59 pm" (utils/dates.js formatDayTime).
     * @param {*} dateString
     * @returns {string}
     */
    static formatDateTime(dateString) {
        if (!dateString) return '';
        return formatDayTime(dateString, { lang: getLang() }) || String(dateString);
    }

    /**
     * Time of day in the app's format, "8:59 pm".
     * @param {*} value
     * @returns {string}
     */
    static formatTime(value) {
        return formatTimeOfDay(value, { lang: getLang() });
    }

    /**
     * Get current date/time string in en-IN locale
     * @returns {string} Current date/time string
     */
    static getCurrentDateTime() {
        return new Date().toLocaleString('en-IN');
    }

    /**
     * Parse date from various formats (Firestore timestamp, ISO string, or Indian locale string)
     * @param {*} dateValue - Date value to parse
     * @returns {Date|null} Parsed Date object or null
     */
    static parseDate(dateValue) {
        if (!dateValue) return null;
        // Firestore timestamp
        if (dateValue.toDate) return dateValue.toDate();
        // Already a Date object
        if (dateValue instanceof Date) return dateValue;
        // Try parsing Indian locale format: "28/12/2025, 7:55:07 pm" (d/m/yyyy)
        if (typeof dateValue === 'string' && dateValue.includes('/')) {
            const [datePart, timePart] = dateValue.split(', ');
            if (datePart) {
                const [day, month, year] = datePart.split('/');
                if (day && month && year) {
                    let hours = 0, minutes = 0, seconds = 0;
                    if (timePart) {
                        const timeMatch = timePart.match(/(\d+):(\d+):?(\d*)?\s*(am|pm)?/i);
                        if (timeMatch) {
                            hours = parseInt(timeMatch[1]);
                            minutes = parseInt(timeMatch[2]);
                            seconds = parseInt(timeMatch[3]) || 0;
                            const period = timeMatch[4];
                            if (period?.toLowerCase() === 'pm' && hours !== 12) hours += 12;
                            if (period?.toLowerCase() === 'am' && hours === 12) hours = 0;
                        }
                    }
                    return new Date(parseInt(year), parseInt(month) - 1, parseInt(day), hours, minutes, seconds);
                }
            }
        }
        // Try standard Date parsing
        const parsed = new Date(dateValue);
        if (!isNaN(parsed.getTime())) return parsed;
        return null;
    }

    /**
     * Format amount as Indian Rupee currency
     * @param {number} amount - Amount to format
     * @returns {string} Formatted currency string
     */
    static formatCurrency(amount, opts) {
        return formatRupees(amount, opts);
    }

    // -------------------- GENERATORS --------------------

    /**
     * Generate a unique ID using timestamp and random string
     * @returns {string} Unique identifier
     */
    static generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    /**
     * Create a debounced version of a function
     * @param {Function} func - Function to debounce
     * @param {number} wait - Milliseconds to wait
     * @returns {Function} Debounced function
     */
    static debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    // -------------------- INPUT HELPERS --------------------

    /**
     * Get float value from input element
     * @param {string} elementId - Input element ID
     * @param {number} [defaultValue=0] - Default value if parsing fails
     * @returns {number} Parsed float value
     */
    static getInputNumber(elementId, defaultValue = 0) {
        const el = document.getElementById(elementId);
        const value = parseFloat(el?.value);
        return isNaN(value) ? defaultValue : value;
    }

    /**
     * Get integer value from input element
     * @param {string} elementId - Input element ID
     * @param {number} [defaultValue=0] - Default value if parsing fails
     * @returns {number} Parsed integer value
     */
    static getInputInt(elementId, defaultValue = 0) {
        const el = document.getElementById(elementId);
        const value = parseInt(el?.value, 10);
        return isNaN(value) ? defaultValue : value;
    }

    /**
     * Get trimmed string value from input element
     * @param {string} elementId - Input element ID
     * @param {string} [defaultValue=''] - Default value if empty
     * @returns {string} Trimmed input value
     */
    static getInputText(elementId, defaultValue = '') {
        const el = document.getElementById(elementId);
        return el?.value?.trim() || defaultValue;
    }

    /**
     * Get float value from element's text content
     * @param {string} elementId - Element ID
     * @param {number} [defaultValue=0] - Default value if parsing fails
     * @returns {number} Parsed float value
     */
    static getElementNumber(elementId, defaultValue = 0) {
        const el = document.getElementById(elementId);
        const value = parseFloat(el?.textContent);
        return isNaN(value) ? defaultValue : value;
    }

    /**
     * Get integer value from element's text content
     * @param {string} elementId - Element ID
     * @param {number} [defaultValue=0] - Default value if parsing fails
     * @returns {number} Parsed integer value
     */
    static getElementInt(elementId, defaultValue = 0) {
        const el = document.getElementById(elementId);
        const value = parseInt(el?.textContent, 10);
        return isNaN(value) ? defaultValue : value;
    }

    // -------------------- DEVICE HELPERS --------------------

    /**
     * Pick a contact from the device's contact list
     * @param {string} inputElementId - ID of input element to populate with contact name
     * @returns {Promise<void>}
     */
    static async pickContact(inputElementId) {
        // Roles & access › Phone contacts (Q52 of #111): sign-in adds this class when the owner turned it off for the role
        if (typeof document !== 'undefined' && document.body?.classList.contains('no-perm-contacts')) return;
        try {
            if ('contacts' in navigator && 'ContactsManager' in window) {
                const contacts = await navigator.contacts.select(['name', 'tel'], { multiple: false });
                if (contacts && contacts.length > 0) {
                    const contact = contacts[0];
                    const nameInput = document.getElementById(inputElementId);
                    if (nameInput && contact.name && contact.name.length > 0) {
                        nameInput.value = contact.name[0];
                        // Let live listeners (bill checks, existing-due line #166) see the new name
                        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
                        nameInput.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }
            } else {
                const { UIManager } = await import('../ui/ui-manager.js');
                UIManager.showToast(t('msg.common.contact_picker_not_supported'));
            }
        } catch (error) {
            console.error('Pick contact error:', error);
        }
    }

    // -------------------- BILL NUMBER GENERATION --------------------

    /**
     * Generate a bill number with prefix and date
     * Format: {prefix}{YYYYMMDD}-{sequence}
     *
     * Online, the sequence comes from an atomic per-day counter document
     * `counters/{prefix}{YYYYMMDD}` (field `next` = last issued sequence), so
     * concurrent devices never get the same number and no per-save scan of
     * today's bills is needed. The first time a counter is used it is seeded
     * from the number of bills already saved today (mid-day deploy).
     * Offline, or if the transaction takes longer than BILL_COUNTER_TIMEOUT_MS,
     * it issues a device-scoped number instead (see nextOfflineBillNumber):
     * `{prefix}{YYYYMMDD}-{device}-{seq}`.
     *
     * @param {string} prefix - Bill type prefix ('P' for purchase, 'S' for retail sale, 'W' for wholesale)
     * @param {string} collectionName - Firebase collection name to query for sequence
     * @returns {Promise<string>} Generated bill number
     */
    static async generateBillNumber(prefix, collectionName) {
        const today = new Date();
        const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
        const format = (n) => `${prefix}${dateStr}-${String(n).padStart(3, '0')}`;
        
        const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const todayEnd = new Date(todayStart);
        todayEnd.setDate(todayEnd.getDate() + 1);
        
        try {
            const counter = dayCounter({
                prefix, dateStr, billsCollection: collectionName, dayStart: todayStart.getTime(), dayEnd: todayEnd.getTime()
            });
            
            const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
            if (!offline && counter.transactional) {
                try {
                    const seq = await withTimeout(counter.next(), BILL_COUNTER_TIMEOUT_MS);
                    return format(seq);
                } catch (counterError) {
                    console.warn('Bill counter unavailable, using local fallback:', counterError?.message || counterError);
                }
            }
            
            // Fallback (offline, or the counter transaction timed out): the
            // shared counter can't be reached, so issue a device-scoped
            // number that can never equal another phone's (#41).
            return Helpers.nextOfflineBillNumber(prefix, dateStr);
        } catch (error) {
            console.error('Error generating bill number:', error);
            return Helpers.nextOfflineBillNumber(prefix, dateStr);
        }
    }

    /**
     * This device's short bill-number code (3 chars, no 0/O/1/I), created
     * once and kept in localStorage. Clearing storage just picks a new code,
     * which keeps numbers unique.
     * @param {Storage} [storage]
     * @returns {string}
     */
    static getBillDeviceCode(storage = Helpers._storage()) {
        try {
            const saved = storage?.getItem(BILL_DEVICE_CODE_KEY);
            if (saved && /^[A-Z0-9]{3}$/.test(saved)) return saved;
        } catch (_) { /* storage blocked */ }
        const bytes = new Uint8Array(3);
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
        else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
        const code = Array.from(bytes, b => BILL_DEVICE_ALPHABET[b % BILL_DEVICE_ALPHABET.length]).join('');
        try { storage?.setItem(BILL_DEVICE_CODE_KEY, code); } catch (_) { /* keep for this call only */ }
        if (!storage) memoryDeviceCode = memoryDeviceCode || code;
        return storage ? code : memoryDeviceCode;
    }

    /**
     * Offline bill number: `{prefix}{YYYYMMDD}-{device}-{seq}`, e.g.
     * `P20261021-K7Q-004`. The sequence is per device, prefix and day, so two
     * phones offline at the same time get different strings, and the format
     * can't collide with online numbers (`P20261021-004`).
     * @param {string} prefix
     * @param {string} dateStr - YYYYMMDD
     * @param {Storage} [storage]
     * @returns {string}
     */
    static nextOfflineBillNumber(prefix, dateStr, storage = Helpers._storage()) {
        const code = Helpers.getBillDeviceCode(storage);
        const key = `${BILL_OFFLINE_SEQ_KEY}${prefix}${dateStr}`;
        let seq;
        try {
            seq = (parseInt(storage.getItem(key), 10) || 0) + 1;
            storage.setItem(key, String(seq));
            // Drop this prefix's counters for earlier days.
            for (let i = storage.length - 1; i >= 0; i--) {
                const k = storage.key(i);
                if (k && k !== key && k.startsWith(`${BILL_OFFLINE_SEQ_KEY}${prefix}`)) storage.removeItem(k);
            }
        } catch (_) {
            memoryOfflineSeq[key] = (memoryOfflineSeq[key] || 0) + 1;
            seq = memoryOfflineSeq[key];
        }
        return `${prefix}${dateStr}-${code}-${String(seq).padStart(3, '0')}`;
    }

    /**
     * Bill numbers of newly added/changed records that another record in the
     * same collection already uses (e.g. two phones synced the same number).
     * @param {Array<{newRec: ?Object, docId: string}>} changes
     * @param {Object[]} records - all records of the collection
     * @param {Function} [idOf]
     * @returns {string[]}
     */
    static findDuplicateBillNumbers(changes, records, idOf = (r) => String(r?.id)) {
        const out = new Set();
        (changes || []).forEach(ch => {
            const num = ch?.newRec?.billNumber;
            if (!num) return;
            if ((records || []).some(r => r?.billNumber === num && idOf(r) !== String(ch.docId))) out.add(num);
        });
        return [...out];
    }

    /** @private */
    static _storage() {
        try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (_) { return null; }
    }

    /**
     * Show how much of a bill is not yet split into Cash / Online / Due.
     * @param {string} elementId
     * @param {{ok: boolean, difference: number}} check - result of validatePaymentSplit (utils/calc/billing.js)
     */
    static showSplitRemaining(elementId, check) {
        const el = typeof document !== 'undefined' ? document.getElementById(elementId) : null;
        if (!el || !check) return;
        const amount = Math.abs(Math.round(check.difference * 100) / 100).toLocaleString('en-IN');
        if (check.ok) {
            el.textContent = '✓ ₹0';
            el.style.color = '#16a34a';
        } else if (check.difference > 0) {
            el.textContent = t('ui.billing.split_left', { amount });
            el.style.color = '#dc2626';
        } else {
            el.textContent = t('ui.billing.split_extra', { amount });
            el.style.color = '#dc2626';
        }
    }

    /**
     * Ticking Online / Cash / Due on a bill form: when that box is ticked, write
     * the amounts from prefillPayment() (utils/calc/billing.js) and untick the others.
     * @param {'online'|'cash'|'due'} type
     * @param {{online: *, cash: *, due: *}} values
     * @param {{online: string[], cash: string[], due: string[]}} ids - [input id, checkbox id] per kind
     */
    static applyPaymentPrefill(type, values, ids) {
        if (!ids[type] || !document.getElementById(ids[type][1])?.checked) return;
        Object.entries(ids).forEach(([key, [inputId, checkboxId]]) => {
            const input = document.getElementById(inputId);
            if (input) input.value = values[key];
            if (key !== type) {
                const box = document.getElementById(checkboxId);
                if (box) box.checked = false;
            }
        });
    }

    /**
     * Run `fn` unless another call with the same key is still running.
     * While running, the matching buttons are disabled so a double tap
     * cannot create a duplicate bill. Returns undefined when ignored.
     * @param {string} key - Lock name (e.g. 'purchase')
     * @param {string} buttonSelector - CSS selector for buttons to disable
     * @param {Function} fn - Async work to run
     * @returns {Promise<*>}
     */
    static async runExclusive(key, buttonSelector, fn) {
        if (inFlightLocks.has(key)) return undefined;
        inFlightLocks.add(key);
        const buttons = (typeof document !== 'undefined' && buttonSelector)
            ? Array.from(document.querySelectorAll(buttonSelector))
            : [];
        const previous = buttons.map(btn => ({ btn, disabled: btn.disabled, opacity: btn.style.opacity }));
        buttons.forEach(btn => {
            btn.disabled = true;
            btn.style.opacity = '0.6';
            btn.setAttribute('aria-busy', 'true');
        });
        try {
            return await fn();
        } finally {
            inFlightLocks.delete(key);
            previous.forEach(({ btn, disabled, opacity }) => {
                btn.disabled = disabled;
                btn.style.opacity = opacity;
                btn.removeAttribute('aria-busy');
            });
        }
    }

    /**
     * Run post-save bookkeeping (audit, item frequency, auto-save cleanup) in the
     * background. Failures are logged and never block or fail the save.
     * @param {Array<Function>} tasks - Functions returning promises (or values)
     * @returns {Promise<PromiseSettledResult[]>}
     */
    static runInBackground(tasks) {
        const promises = tasks.map(task => Promise.resolve().then(task));
        return Promise.allSettled(promises).then(results => {
            results.forEach(r => {
                if (r.status === 'rejected') console.error('Background task failed:', r.reason);
            });
            return results;
        });
    }

    /**
     * Whether a runExclusive lock is currently held
     * @param {string} key
     * @returns {boolean}
     */
    static isBusy(key) {
        return inFlightLocks.has(key);
    }
}

const BILL_COUNTER_TIMEOUT_MS = 2500;
const BILL_DEVICE_CODE_KEY = 'aadhatBillDeviceCode';
const BILL_OFFLINE_SEQ_KEY = 'aadhatOfflineBillSeq:';
const BILL_DEVICE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
let memoryDeviceCode = null;
const memoryOfflineSeq = {};
const inFlightLocks = new Set();

function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error); }
        );
    });
}

// Returns the Android major version from the WebView user agent, or Infinity if unknown
// (so newer-OS permissions are requested when detection fails).
export function getAndroidMajorVersion(userAgent = (typeof navigator !== 'undefined' ? navigator.userAgent : '')) {
    const match = /Android\s+(\d+)/i.exec(userAgent || '');
    return match ? parseInt(match[1], 10) : Infinity;
}
