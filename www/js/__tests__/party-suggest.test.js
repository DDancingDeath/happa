/**
 * @fileoverview Name suggestions while billing (#139 phase 1, plan P3.B2): the matcher on the
 * loaded bills (any spelling, Latin or Devanagari), "Did you mean", and the Billing name
 * field's suggestion list and warning line (keyboard and tap, warn-never-block).
 */
import { closeParty, editDistance, looseWord, matchParties, partyEntries } from '../utils/party-match.js';
import { bindPartySuggest, closeSuggestions, renderNameHint, showSuggestions } from '../ui/party-suggest.js';
import { AppState } from '../utils/state.js';

const DAY = 86400000;
const NOW = Date.now();
const bill = (id, customerName, due, daysAgo, over = {}) => ({
    id, customerName, timestamp: NOW - daysAgo * DAY, total: 500, payment: { cash: 500 - due, online: 0, due }, ...over
});
const BILLS = [
    bill('a', 'Sita Devi', 200, 1),
    bill('b', 'sita  devi', 0, 3),
    bill('c', 'Ramesh Kumar', 0, 2),
    bill('d', 'सीता राम', 0, 5),
    bill('e', 'Mohan Lal Ji', 0, 9),
    bill('f', 'Gone Party', 300, 0, { voided: true }),
    bill('g', '', 50, 0)
];

describe('looseWord: one spelling for Latin and Devanagari', () => {
    test.each([
        ['रमेश', 'ramesh'], ['Ramesh', 'ramesh'], ['Seeta', 'sita'], ['सीता', 'sita'], ['Sunil', 'sunil'], ['सुनील', 'sunil'],
        ['Pappu', 'papu'], ['पप्पू', 'papu'], ['R.K.', 'rk'], ['Phool', 'ful']
    ])('%s → %s', (word, loose) => expect(looseWord(word)).toBe(loose));
});

describe('partyEntries: names on the loaded bills', () => {
    const entries = partyEntries(BILLS);

    test('one entry per PARTY, the most used spelling, newest first; voided and unnamed bills left out', () => {
        expect(entries.map(e => e.name)).toEqual(['Sita Devi', 'Ramesh Kumar', 'सीता राम', 'Mohan Lal Ji']);
        expect(entries[0]).toMatchObject({ key: 'sita devi', count: 2, due: 200, dueBills: 1 });
        expect(entries[1].due).toBe(0);
    });

    test('the bill being edited is left out', () => {
        expect(partyEntries(BILLS, { excludeId: 'c' }).map(e => e.name)).not.toContain('Ramesh Kumar');
    });
});

describe('matchParties: what typing lists', () => {
    const entries = partyEntries(BILLS);
    const names = (typed) => matchParties(entries, typed).map(e => e.name);

    test('word starts, newest first ("Sit" lists Sita Devi before सीता राम)', () => {
        expect(names('Sit')).toEqual(['Sita Devi', 'सीता राम']);
        expect(names('devi s')).toEqual(['Sita Devi']);
        expect(names('ramesh k')).toEqual(['Ramesh Kumar']);
    });

    test('Hindi typed finds Latin names and Latin typed finds Hindi names', () => {
        expect(names('रमेश')).toEqual(['Ramesh Kumar']);
        expect(names('सीता')).toEqual(['Sita Devi', 'सीता राम']);
        expect(names('seeta ra')).toEqual(['सीता राम']);
    });

    test('nothing for a blank name, a name already typed exactly, or no match; at most `limit`', () => {
        expect(names('')).toEqual([]);
        expect(names('  SITA devi ')).toEqual([]);
        expect(names('xyz')).toEqual([]);
        expect(matchParties(entries, 's', { limit: 1 })).toHaveLength(1);
    });
});

describe('closeParty: "Did you mean"', () => {
    const entries = partyEntries(BILLS);
    const dym = (typed) => closeParty(entries, typed)?.name ?? null;

    test('the plan example: "Seeta Devi" → Sita Devi', () => expect(dym('Seeta Devi')).toBe('Sita Devi'));

    test('honorifics, the other script, one name starting the other, a typo', () => {
        expect(dym('Mohan Lal')).toBe('Mohan Lal Ji');
        expect(dym('रमेश कुमार')).toBe('Ramesh Kumar');
        expect(dym('Ramesh')).toBe('Ramesh Kumar');
        expect(dym('Ramesh Kumr')).toBe('Ramesh Kumar');
    });

    test('nothing for a known name, a short name or a different one', () => {
        expect(dym('sita devi')).toBeNull();
        expect(dym('Sit')).toBeNull();
        expect(dym('Govind')).toBeNull();
        expect(dym('Rakesh Verma')).toBeNull();
    });

    test('editDistance stops past its limit', () => {
        expect(editDistance('sitadevi', 'sitadevi', 2)).toBe(0);
        expect(editDistance('kumar', 'kumr', 1)).toBe(1);
        expect(editDistance('abcdef', 'uvwxyz', 2)).toBe(3);
    });
});

describe('Billing name field (ui/party-suggest)', () => {
    let input;
    const type = (value) => {
        input.focus();
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const key = (k) => input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    const list = () => document.getElementById('partySuggest-retail');
    const hint = () => document.getElementById('partyHint-retail');

    beforeAll(() => bindPartySuggest());
    beforeEach(() => {
        document.body.innerHTML = `<div id="saleSection"><div class="bill-form-field field bill-customer"><div class="bill-party">
            <input id="saleCustomerName"></div><datalist id="saleCustomerOptions"></datalist></div><input id="other"></div>`;
        input = document.getElementById('saleCustomerName');
        AppState.retailSalesHistory = BILLS.map(b => ({ ...b }));
        closeSuggestions('retail');
    });

    test('typing lists the names with their dues as a combobox; the datalist keeps the names for voice', () => {
        type('sit');
        expect(list().hidden).toBe(false);
        expect(input.getAttribute('role')).toBe('combobox');
        expect(input.getAttribute('aria-expanded')).toBe('true');
        expect([...list().querySelectorAll('[role="option"]')].map(li => li.textContent)).toEqual(['Sita Deviowes ₹200', 'सीता रामno dues']);
        expect([...document.querySelectorAll('#saleCustomerOptions option')].map(o => o.value)).toContain('Ramesh Kumar');
    });

    test('↓ and Enter fill the name and tell the bill checks; Esc closes without filling', () => {
        const seen = [];
        document.addEventListener('change', (e) => seen.push(e.target.value), { once: true });
        type('sit');
        key('ArrowDown');
        key('ArrowDown');
        expect(input.getAttribute('aria-activedescendant')).toBe('partySuggest-retail-1');
        key('Enter');
        expect(input.value).toBe('सीता राम');
        expect(seen).toEqual(['सीता राम']);
        expect(list().hidden).toBe(true);
        type('ram');
        key('Escape');
        expect(input.value).toBe('ram');
        expect(list().hidden).toBe(true);
    });

    test('a tap on a suggestion fills the name', () => {
        type('रमेश');
        list().querySelector('[role="option"]').click();
        expect(input.value).toBe('Ramesh Kumar');
    });

    test('"Did you mean" shows only after leaving the field; Use fills it, "Yes, it\'s right" keeps the name', () => {
        type('Seeta Devi');
        expect(renderNameHint('retail')).toBeNull();
        document.getElementById('other').focus();
        expect(renderNameHint('retail')?.name).toBe('Sita Devi');
        expect(hint().hidden).toBe(false);
        expect(hint().textContent).toContain('Did you mean Sita Devi (owes ₹200)?');
        hint().querySelector('.party-name-right').click();
        expect(hint().hidden).toBe(true);
        expect(input.value).toBe('Seeta Devi');
        expect(renderNameHint('retail')).toBeNull();

        input.value = 'Mohan Lal';
        expect(renderNameHint('retail')?.name).toBe('Mohan Lal Ji');
        hint().querySelector('.party-name-use').click();
        expect(input.value).toBe('Mohan Lal Ji');
        expect(hint().hidden).toBe(true);
    });

    test('editing a bill leaves that bill out of "Did you mean"', () => {
        AppState.retailSalesHistory = [bill('x', 'Ramesh Kumar', 0, 1)];
        input.value = 'Ramesh Kumr';
        expect(renderNameHint('retail', { editingBill: { id: 'x' } })).toBeNull();
        expect(renderNameHint('retail', {})?.name).toBe('Ramesh Kumar');
    });

    test('editing a bill leaves that bill out of the list\'s dues too', () => {
        renderNameHint('retail', { editingBill: { id: 'a' } });
        type('sit');
        expect(list().querySelector('[role="option"]').textContent).toBe('sita devino dues');
        renderNameHint('retail', {});
        type('sit');
        expect(list().querySelector('[role="option"]').textContent).toBe('Sita Deviowes ₹200');
    });

    test('a press on Save that blurs the name keeps Save in place: the hint shows after the click', async () => {
        const tick = () => new Promise(r => setTimeout(r, 0));
        const save = document.createElement('button');
        document.body.appendChild(save);
        const saved = [];
        save.addEventListener('click', () => saved.push(hint()?.hidden !== false));
        type('Sita Devi Bhai');
        save.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        save.focus();
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: save }));
        expect(renderNameHint('retail')).toBeNull();
        await tick();
        await new Promise(r => setTimeout(r, 300));
        expect(hint()?.hidden ?? true).toBe(true);
        save.dispatchEvent(new Event('pointerup', { bubbles: true }));
        save.click();
        expect(saved).toEqual([true]);
        await tick();
        expect(hint().hidden).toBe(false);
        expect(hint().textContent).toContain('Did you mean Sita Devi');
    });

    test('no suggestions or warning on a field it does not know', () => {
        expect(showSuggestions('wholesale')).toEqual([]);
        expect(renderNameHint('wholesale')).toBeNull();
    });
});
