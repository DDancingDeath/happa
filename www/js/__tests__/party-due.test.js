/**
 * @fileoverview Existing due while billing (#166): exact-name lookup on the
 * loaded open bills (same grouping as Outstanding), the line under the name
 * field, and Outstanding opened for that one party.
 * Timezone is pinned to Asia/Kolkata in jest.config.js.
 */
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(async () => {}), ACTIONS: {} } }));

import { billsForKind, partyDue, partyDueText } from '../utils/party-due.js';
import { buildAging } from '../utils/aging.js';
import { BillChecksUI, CHECK_DEBOUNCE_MS } from '../ui/bill-highlight.js';
import { renderPartyDue } from '../ui/party-due-line.js';
import { OutstandingManager } from '../modules/outstanding.js';
import { AppState } from '../utils/state.js';
import { Helpers } from '../utils/helpers.js';
import fs from 'fs';
import path from 'path';

const TODAY = new Date(2026, 9, 22, 10, 0);
const at = (y, m, d) => new Date(y, m - 1, d, 12, 0).getTime();
const bill = (id, customerName, due, over = {}) => ({
    id, customerName, billNumber: id.toUpperCase(), timestamp: at(2026, 10, 1),
    total: due + 100, payment: { cash: 100, online: 0, due }, ...over
});

describe('#166 partyDue lookup', () => {
    const bills = [
        bill('a', 'Ram Lal', 500, { timestamp: at(2026, 8, 1) }),
        bill('b', '  ram   LAL ', 250.5),
        bill('c', 'Ramesh', 900),
        bill('d', 'Ram Lal', 300, { cleared: true }),
        bill('e', 'Ram Lal', 0),
        bill('f', 'Ram', 70),
        bill('g', 'रामलाल', 120),
        bill('h', 'रामलाल', 80, { timestamp: at(2026, 10, 22), dueAmount: 999, payment: { cash: 0, online: 0, due: 80 } })
    ];

    test('exact normalized name only: case/spaces ignored, no prefix matches, cleared and zero-due skipped', () => {
        const due = partyDue(bills, 'RAM lal', { today: TODAY });
        expect(due).toEqual({ key: 'ram lal', total: 750.5, count: 2, oldestDays: 82, bucket: 2 });
        expect(partyDue(bills, 'Ram', { today: TODAY })).toMatchObject({ total: 70, count: 1 });
        expect(partyDue(bills, 'Ra', { today: TODAY })).toBeNull();
    });

    test('Hindi names match exactly and the nested payment.due wins over dueAmount', () => {
        expect(partyDue(bills, ' रामलाल ', { today: TODAY })).toMatchObject({ total: 200, count: 2, oldestDays: 21 });
        expect(partyDue(bills, 'राम', { today: TODAY })).toBeNull();
    });

    test('blank name or nothing owed → null (line hidden)', () => {
        expect(partyDue(bills, '', { today: TODAY })).toBeNull();
        expect(partyDue(bills, '   ', { today: TODAY })).toBeNull();
        expect(partyDue([bill('x', '', 50)], '', { today: TODAY })).toBeNull();
        expect(partyDue(bills, 'Shyam', { today: TODAY })).toBeNull();
    });

    test('the bill being edited is excluded (its due is already on screen)', () => {
        expect(partyDue(bills, 'Ram Lal', { excludeId: 'b', today: TODAY })).toMatchObject({ total: 500, count: 1 });
        expect(partyDue(bills, 'Ram', { excludeId: 'f', today: TODAY })).toBeNull();
    });

    test('equals the Outstanding party total for the same bills', () => {
        const party = buildAging(bills, { today: TODAY }).parties.find(p => p.key === 'ram lal');
        expect(partyDue(bills, 'Ram Lal', { today: TODAY }).total).toBe(party.total);
    });

    test('purchase vs sale side: each form reads its own Outstanding list', () => {
        const state = {
            purchaseHistory: [bill('p1', 'Gupta', 1000)],
            retailSalesHistory: [bill('r1', 'Gupta', 40)],
            salesHistory: [bill('w1', 'Gupta', 300, { source: 'sales-tab' }), bill('w2', 'Gupta', 5000)]
        };
        expect(partyDue(billsForKind(state, 'purchase'), 'Gupta', { today: TODAY }).total).toBe(1000);
        expect(partyDue(billsForKind(state, 'retail'), 'Gupta', { today: TODAY }).total).toBe(40);
        // Only wholesale bills shown on the Wholesale Outstanding list
        expect(partyDue(billsForKind(state, 'wholesale'), 'Gupta', { today: TODAY }).total).toBe(300);
        expect(billsForKind({}, 'retail')).toEqual([]);
    });

    test('text in the app language: customers owe us, we owe suppliers', () => {
        expect(partyDueText({ total: 1500, count: 3, oldestDays: 42 }, 'retail'))
            .toBe('Already owes ₹1,500 on 3 bills (oldest 42 days)');
        expect(partyDueText({ total: 800, count: 1, oldestDays: 1 }, 'purchase'))
            .toBe('We owe ₹800 on 1 bill (oldest 1 day)');
        expect(partyDueText({ total: 1500, count: 3, oldestDays: 42 }, 'retail', 'hi'))
            .toBe('पहले से ₹1,500 बकाया — 3 बिल (सबसे पुराना 42 दिन)');
        expect(partyDueText({ total: 10, count: 1, oldestDays: 0 }, 'wholesale')).toContain('(oldest today)');
        expect(partyDueText({ total: 10, count: 1, oldestDays: null }, 'retail')).toContain('(date unknown)');
    });
});

describe('#166 due line under the name', () => {
    const DOM = `
      <div id="saleSection">
        <div class="bill-form-field"><label>Customer</label><input id="saleCustomerName"></div>
        <div class="pay-line"><input id="saleDue"></div>
      </div>`;
    let draft;

    beforeAll(() => {
        BillChecksUI.register('retail', {
            sectionId: 'saleSection',
            getDraft: () => ({ kind: 'retail', id: 'new1', items: [], total: 0, payment: { cash: 0, online: 0, due: 0 }, ...draft, partyName: document.getElementById('saleCustomerName').value }),
            fields: { party: { inputs: ['saleCustomerName'] } }
        });
    });

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(TODAY);
        document.body.innerHTML = DOM;
        draft = {};
        AppState.items = [];
        AppState.settings = {};
        AppState.salesHistory = [];
        AppState.purchaseHistory = [bill('p1', 'Asha', 999)];
        AppState.retailSalesHistory = [
            bill('r1', 'Asha', 400, { timestamp: at(2026, 9, 1) }),
            bill('r2', 'asha ', 100),
            bill('r3', 'Asha Devi', 50)
        ];
    });

    afterEach(() => jest.useRealTimers());

    const line = () => document.getElementById('partyDue-retail');
    const type = (v) => {
        const input = document.getElementById('saleCustomerName');
        input.value = v;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    test('shows after typing pauses (debounced), right under the name row; hides for no due', () => {
        BillChecksUI.run('retail'); // binds the live listener
        expect(line()).toBeNull();
        type('Asha');
        jest.advanceTimersByTime(CHECK_DEBOUNCE_MS - 1);
        expect(line()).toBeNull();
        jest.advanceTimersByTime(1);
        expect(line().hidden).toBe(false);
        expect(line().textContent).toBe('📥 Already owes ₹500 on 2 bills (oldest 51 days) · updating… ›');
        // "updating…" is shown by CSS only while the dues come from the cache (#59)
        expect(line().querySelector('.updating-mark').textContent).toBe(' · updating…');
        expect(line().classList.contains('party-due-old')).toBe(true);
        expect(document.querySelector('#saleSection .bill-form-field').nextElementSibling).toBe(line());

        type('Asha Devi');
        jest.advanceTimersByTime(CHECK_DEBOUNCE_MS);
        expect(line().textContent).toContain('₹50 on 1 bill (oldest 21 days)');
        expect(line().classList.contains('party-due-old')).toBe(false);

        type('Nobody');
        jest.advanceTimersByTime(CHECK_DEBOUNCE_MS);
        expect(line().hidden).toBe(true);

        type('Asha');
        BillChecksUI.clear('retail');
        expect(line().hidden).toBe(true);
    });

    test('typing the name first works even before any other check ran on the form', () => {
        type('Asha');
        jest.advanceTimersByTime(CHECK_DEBOUNCE_MS);
        expect(line().textContent).toContain('₹500 on 2 bills');
    });

    test('👤 Pick Contact updates the line to the picked party (or hides it)', async () => {
        type('Asha');
        jest.advanceTimersByTime(CHECK_DEBOUNCE_MS);
        expect(line().dataset.party).toBe('Asha');
        AppState.retailSalesHistory.push(bill('r7', 'Ram', 60));
        const pick = (name) => {
            navigator.contacts = { select: jest.fn(async () => [{ name: [name], tel: [] }]) };
            window.ContactsManager = function ContactsManager() {};
            return Helpers.pickContact('saleCustomerName');
        };
        try {
            await pick('Ram');
            jest.advanceTimersByTime(CHECK_DEBOUNCE_MS);
            expect(line().hidden).toBe(false);
            expect(line().dataset.party).toBe('Ram');
            expect(line().textContent).toContain('₹60 on 1 bill');

            await pick('Nobody Owes');
            jest.advanceTimersByTime(CHECK_DEBOUNCE_MS);
            expect(line().hidden).toBe(true);
        } finally {
            delete navigator.contacts;
            delete window.ContactsManager;
        }
    });

    test('editing a bill leaves that bill out of the existing due', () => {
        draft = { id: 'r2', editingBill: { id: 'r2' } };
        document.getElementById('saleCustomerName').value = 'Asha';
        BillChecksUI.run('retail');
        expect(line().textContent).toContain('₹400 on 1 bill');
    });

    test('a name with markup is never rendered as HTML and tapping opens Outstanding for it', () => {
        const evil = '<img src=x onerror=alert(1)>';
        AppState.retailSalesHistory.push(bill('r9', evil, 75));
        const showParty = jest.fn();
        window.app = { outstanding: { showParty } };
        renderPartyDue('retail', 'saleCustomerName', { partyName: evil, id: 'new1' });
        expect(line().querySelector('img')).toBeNull();
        line().click();
        expect(showParty).toHaveBeenCalledWith('retail', evil);
        delete window.app;
    });

    test('purchase form says "We owe"', () => {
        document.body.innerHTML = '<div class="bill-form-field"><input id="customerName"></div>';
        renderPartyDue('purchase', 'customerName', { partyName: 'asha', id: 'new' });
        expect(document.getElementById('partyDue-purchase').textContent).toContain('We owe ₹999 on 1 bill');
    });
});

describe('#166 Outstanding opened for one party', () => {
    const DUE_TEMPLATE = fs.readFileSync(path.join(__dirname, '../../templates/due.html'), 'utf8');

    beforeEach(() => {
        document.body.innerHTML = DUE_TEMPLATE;
        OutstandingManager.agingBucket = null;
        OutstandingManager.partyFilter = null;
        AppState.purchaseHistory = [bill('p1', 'Mohan', 300), bill('p2', 'Mohan Lal', 200)];
        AppState.retailSalesHistory = [
            bill('r1', 'Sita <b>', 120), bill('r2', 'sita  <B>', 30), bill('r3', 'Sitaram', 999)
        ];
    });

    test('shows only that party (exact name), escaped, with the same total as the due line; Show all clears it', () => {
        OutstandingManager.showParty('sale', 'Sita <b>');
        const ids = [...document.querySelectorAll('#dueList [data-history-item]')].map(el => el.textContent);
        expect(ids).toHaveLength(2);
        expect(ids.join(' ')).not.toContain('Sitaram');
        const note = document.querySelector('.party-filter-note');
        expect(note.querySelector('strong').textContent).toBe('Sita <b>');
        expect(note.querySelector('b')).toBeNull();
        expect(document.querySelector('.aging-total').textContent).toBe('₹150');
        expect(document.querySelector('#due .filter-sale').classList.contains('active')).toBe(true);
        expect(partyDue(billsForKind(AppState, 'retail'), 'Sita <b>').total).toBe(150);

        OutstandingManager.clearPartyFilter();
        expect(document.querySelectorAll('#dueList [data-history-item]')).toHaveLength(3);
        expect(document.querySelector('.party-filter-note')).toBeNull();
    });

    test('purchase side, and switching filter drops the party', () => {
        OutstandingManager.showParty('purchase', 'mohan');
        expect(document.querySelectorAll('#dueList [data-history-item]')).toHaveLength(1);
        OutstandingManager.filterDue('purchase');
        expect(document.querySelectorAll('#dueList [data-history-item]')).toHaveLength(2);
    });
});
