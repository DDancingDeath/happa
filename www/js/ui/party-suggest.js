/**
 * @fileoverview Name suggestions on the Billing form (#139 phase 1, plan P3.B2). Typing a
 * customer (retail) or supplier (purchase) name lists the names already used on the bills
 * loaded on this phone, with what is open on them (utils/party-match.js): no Firestore read.
 * A combobox: ↑ ↓ pick, Enter fills, Esc closes; a tap fills. After the name field is left,
 * a new name close to a known one shows "Did you mean …?" with [Use] and [Yes, it's right]:
 * a warning only, it never stops the bill.
 * @module ui/party-suggest
 */

import { AppState } from '../utils/state.js';
import { billsForKind } from '../utils/party-due.js';
import { closeParty, matchParties, partyEntries } from '../utils/party-match.js';
import { partyNameKey } from '../utils/parties.js';
import { formatRupees } from '../utils/money.js';
import { t } from '../i18n/index.js';

const KIND_OF = { customerName: 'purchase', saleCustomerName: 'retail' };
const INPUT_OF = { purchase: 'customerName', retail: 'saleCustomerName' };
const OPTIONS_OF = { purchase: 'customerOptions', retail: 'saleCustomerOptions' };
const LIMIT = 5;
const CACHE_MS = 10000;

/** @type {Map<string, {bills: Array<*>, stamp: string, at: number, entries: Array<*>}>} */
const cache = new Map();
/** kind → open list state */
const open = new Map();
/** "kind|key" of typed names the user said are right */
const confirmed = new Set();
/** kind → id of the bill being edited (left out of "Did you mean") */
const editingId = new Map();
let filling = false;
let pointerHeld = false;
/** kinds whose hint waits for the press to end */
const waitingForRelease = new Set();

const listId = (kind) => `partySuggest-${kind}`;
const hintId = (kind) => `partyHint-${kind}`;
const inputOf = (kind) => /** @type {?HTMLInputElement} */ (document.getElementById(INPUT_OF[kind]));

function entriesFor(kind, excludeId = null) {
    const bills = billsForKind(AppState, kind);
    const stamp = `${bills.length}|${bills[0]?.id ?? ''}|${bills[bills.length - 1]?.id ?? ''}|${excludeId ?? ''}`;
    const hit = cache.get(kind);
    if (hit && hit.bills === bills && hit.stamp === stamp && Date.now() - hit.at < CACHE_MS) return hit.entries;
    const entries = partyEntries(bills, { excludeId });
    cache.set(kind, { bills, stamp, at: Date.now(), entries });
    fillOptions(kind, entries);
    return entries;
}

// The datalist stays the list of known names voice billing reads (the field no longer points at it)
function fillOptions(kind, entries) {
    const datalist = document.getElementById(OPTIONS_OF[kind]);
    if (!datalist) return;
    datalist.replaceChildren(...entries.slice(0, 200).map(e => {
        const o = document.createElement('option');
        o.value = e.name;
        return o;
    }));
}

/** "owes ₹200" / "we owe ₹200" / "no dues" */
export function dueText(kind, entry) {
    if (!(entry?.due > 0)) return t('ui.billing.suggest_no_due');
    return t(kind === 'purchase' ? 'ui.billing.suggest_we_owe' : 'ui.billing.suggest_owes', { amount: formatRupees(entry.due) });
}

function setActive(kind, index) {
    const state = open.get(kind);
    const input = inputOf(kind);
    const list = document.getElementById(listId(kind));
    if (!state || !input || !list) return;
    state.active = index;
    [...list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === index)));
    if (index >= 0) {
        input.setAttribute('aria-activedescendant', `${listId(kind)}-${index}`);
        list.children[index]?.scrollIntoView?.({ block: 'nearest' });
    } else {
        input.removeAttribute('aria-activedescendant');
    }
}

function ensureList(kind, input) {
    let list = document.getElementById(listId(kind));
    if (list) return list;
    list = document.createElement('ul');
    list.id = listId(kind);
    list.className = 'party-suggest';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    // Keep the focus in the field while an option is tapped
    list.addEventListener('pointerdown', (e) => e.preventDefault());
    list.addEventListener('mousedown', (e) => e.preventDefault());
    list.addEventListener('click', (e) => {
        const li = /** @type {?HTMLElement} */ (/** @type {HTMLElement} */ (e.target).closest('[role="option"]'));
        const state = open.get(kind);
        if (li && state) choose(kind, state.items[Number(li.dataset.index)]);
    });
    (input.closest('.bill-customer-box') || input.parentElement).appendChild(list);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('aria-expanded', 'false');
    return list;
}

/** Close the suggestion list of a form. */
export function closeSuggestions(kind) {
    open.delete(kind);
    const list = document.getElementById(listId(kind));
    if (list) {
        list.hidden = true;
        list.replaceChildren();
    }
    const input = inputOf(kind);
    if (input) {
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
    }
}

/**
 * Show the suggestions for what is typed in a form's name field.
 * @param {'purchase'|'retail'} kind
 * @returns {Array<*>} the parties listed
 */
export function showSuggestions(kind) {
    const input = inputOf(kind);
    if (!input) return [];
    const items = matchParties(entriesFor(kind, editingId.get(kind) ?? null), input.value, { limit: LIMIT });
    if (!items.length) {
        closeSuggestions(kind);
        return [];
    }
    const list = ensureList(kind, input);
    list.setAttribute('aria-label', t('ui.billing.name_suggestions'));
    list.replaceChildren(...items.map((entry, i) => {
        const li = document.createElement('li');
        li.id = `${listId(kind)}-${i}`;
        li.className = 'party-suggest-option';
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        li.dataset.index = String(i);
        const name = document.createElement('span');
        name.className = 'party-suggest-name';
        name.textContent = entry.name;
        const due = document.createElement('span');
        due.className = entry.due > 0 ? 'party-suggest-due has-due' : 'party-suggest-due';
        due.textContent = dueText(kind, entry);
        li.append(name, due);
        return li;
    }));
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    open.set(kind, { items, active: -1 });
    setActive(kind, -1);
    return items;
}

function fillName(kind, name) {
    const input = inputOf(kind);
    if (!input) return;
    input.value = name;
    filling = true;
    try {
        // Bill checks, the "Already owes" line and auto-save see the new name
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    } finally {
        filling = false;
    }
}

function choose(kind, entry) {
    if (!entry) return;
    fillName(kind, entry.name);
    closeSuggestions(kind);
    hideNameHint(kind);
    inputOf(kind)?.focus();
}

/** Hide the "Did you mean" line of a form. */
export function hideNameHint(kind) {
    const el = document.getElementById(hintId(kind));
    if (el) {
        el.hidden = true;
        el.replaceChildren();
    }
}

function hintButton(cls, text, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn btn-sm ${cls}`;
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
}

/**
 * Show or hide "Did you mean …?" under a form's name field: only while the field is not
 * being typed in, for a name no loaded bill uses that is close to a known party's.
 * @param {string} kind
 * @param {?Object} [draft] the bill checks' draft ({editingBill, id}): the bill being edited is left out
 * @returns {?Object} the party suggested, or null
 */
export function renderNameHint(kind, draft = undefined) {
    if (typeof document === 'undefined' || !INPUT_OF[kind]) return null;
    const input = inputOf(kind);
    if (!input) return null;
    if (draft !== undefined) editingId.set(kind, draft?.editingBill?.id ?? null);
    const typed = input.value;
    const key = partyNameKey(typed);
    const editing = editingId.get(kind) ?? null;
    const match = key && document.activeElement !== input && !confirmed.has(`${kind}|${key}`)
        ? closeParty(entriesFor(kind, editing), typed) : null;
    if (!match) {
        hideNameHint(kind);
        return null;
    }
    let el = document.getElementById(hintId(kind));
    // A new line would move what is under a press still held (Save): show it after the click
    if (pointerHeld && (!el || el.hidden)) {
        waitingForRelease.add(kind);
        return null;
    }
    if (!el) {
        el = document.createElement('div');
        el.id = hintId(kind);
        el.className = 'party-name-hint';
        el.setAttribute('role', 'status');
        (input.closest('.form-row') || input).insertAdjacentElement('afterend', el);
    }
    const text = document.createElement('span');
    text.className = 'party-name-hint-text';
    text.textContent = match.due > 0
        ? t('ui.billing.did_you_mean_due', { name: match.name, due: dueText(kind, match) })
        : t('ui.billing.did_you_mean', { name: match.name });
    el.replaceChildren(
        text,
        hintButton('btn-tonal party-name-use', t('ui.billing.use_name'), () => {
            fillName(kind, match.name);
            hideNameHint(kind);
            inputOf(kind)?.focus();
        }),
        hintButton('btn-ghost party-name-right', t('ui.billing.name_is_right'), () => {
            confirmed.add(`${kind}|${key}`);
            hideNameHint(kind);
        })
    );
    el.hidden = false;
    return match;
}

function onKeydown(e) {
    const kind = KIND_OF[e.target?.id];
    if (!kind) return;
    const state = open.get(kind);
    if (!state) {
        if (e.key === 'ArrowDown' && showSuggestions(kind).length) {
            e.preventDefault();
            setActive(kind, 0);
        }
        return;
    }
    const n = state.items.length;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive(kind, (state.active + 1) % n);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(kind, state.active <= 0 ? n - 1 : state.active - 1);
    } else if (e.key === 'Enter' && state.active >= 0) {
        e.preventDefault();
        e.stopPropagation();
        choose(kind, state.items[state.active]);
    } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeSuggestions(kind);
    } else if (e.key === 'Tab') {
        closeSuggestions(kind);
    }
}

let bound = false;
/** Listen on the Billing name fields (once; the fields may be put in later). */
export function bindPartySuggest() {
    if (bound || typeof document === 'undefined') return;
    bound = true;
    document.addEventListener('input', (e) => {
        const kind = KIND_OF[/** @type {HTMLElement} */ (e.target)?.id];
        if (!kind || filling) return;
        hideNameHint(kind);
        showSuggestions(kind);
    });
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('pointerdown', () => { pointerHeld = true; }, true);
    const release = () => {
        pointerHeld = false;
        if (!waitingForRelease.size) return;
        const kinds = [...waitingForRelease];
        waitingForRelease.clear();
        // After the click this release makes has run
        setTimeout(() => kinds.forEach(kind => renderNameHint(kind)), 0);
    };
    ['pointerup', 'pointercancel'].forEach(type => document.addEventListener(type, release, true));
    window.addEventListener('blur', release);
    document.addEventListener('focusout', (e) => {
        const kind = KIND_OF[/** @type {HTMLElement} */ (e.target)?.id];
        if (!kind) return;
        closeSuggestions(kind);
        setTimeout(() => renderNameHint(kind), 0);
    });
    window.addEventListener('aadhat:langchange', () => {
        Object.keys(INPUT_OF).forEach(kind => {
            if (document.getElementById(hintId(kind))?.hidden === false) renderNameHint(kind);
            if (open.has(kind)) showSuggestions(kind);
        });
    });
}
