/**
 * @fileoverview Outstanding aging (#46) and WhatsApp reminder / statement (#77):
 * bucket math in IST with legacy DD/MM dates, party grouping by normalized
 * name, the bilingual reminder text, and the Outstanding panel actions.
 * Timezone is pinned to Asia/Kolkata in jest.config.js.
 */
import {
    AGING_BUCKETS, ageInDays, bucketIndex, buildAging, chaseFirst, filterBillsByBucket,
    normalizePartyName, sortParties
} from '../utils/aging.js';
import {
    REMINDER_MAX_BILLS, buildReminderText, buildStatement, cleanText, formatINR, normalizePhone, whatsAppReminderUrl
} from '../utils/due-reminder.js';
import { OutstandingManager } from '../modules/outstanding.js';
import { openExternal } from '../utils/open-external.js';
import { PrinterService } from '../services/printer.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import fs from 'fs';
import path from 'path';

const DUE_TEMPLATE = fs.readFileSync(path.join(__dirname, '../../templates/due.html'), 'utf8');

// 22 Oct 2026, 00:30 IST
const TODAY = new Date(2026, 9, 22, 0, 30);
const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const bill = (over) => ({ id: over.id || Math.random().toString(36).slice(2), payment: { cash: 0, online: 0, due: 100 }, ...over });

describe('#46 aging bucket math', () => {
    test('30/31 and 90/91 day boundaries', () => {
        expect(bucketIndex(0)).toBe(0);
        expect(bucketIndex(30)).toBe(0);
        expect(bucketIndex(31)).toBe(1);
        expect(bucketIndex(60)).toBe(1);
        expect(bucketIndex(61)).toBe(2);
        expect(bucketIndex(90)).toBe(2);
        expect(bucketIndex(91)).toBe(3);
        expect(bucketIndex(null)).toBe(AGING_BUCKETS.length - 1);
    });

    test('age counts local (IST) calendar days, not 24 h blocks or UTC days', () => {
        // 22 Sep 23:59 → 30 days; 21 Sep 00:01 → 31 days, from 22 Oct 00:30
        expect(ageInDays(new Date(at(2026, 9, 22, 23, 59)), TODAY)).toBe(30);
        expect(ageInDays(new Date(at(2026, 9, 21, 0, 1)), TODAY)).toBe(31);
        // 00:15 IST on 22 Oct is still 21 Oct in UTC: same local day = 0 days
        expect(ageInDays(new Date(Date.UTC(2026, 9, 21, 18, 45)), new Date(2026, 9, 22, 10, 0))).toBe(0);
        // 23 Jul → 91 days, 24 Jul → 90 days
        expect(ageInDays(new Date(at(2026, 7, 23)), TODAY)).toBe(91);
        expect(ageInDays(new Date(at(2026, 7, 24)), TODAY)).toBe(90);
        // future-dated bill
        expect(ageInDays(new Date(at(2026, 10, 25)), TODAY)).toBe(0);
    });

    test('legacy DD/MM/YYYY bill date is read day-first', () => {
        const { parties } = buildAging([bill({ customerName: 'A', date: '05/09/2026, 6:05:00 pm' })], { today: TODAY });
        // 5 Sep → 47 days (as MM/DD it would be 9 May → 166 days)
        expect(parties[0].oldestDays).toBe(47);
        expect(parties[0].bucket).toBe(1);
    });

    test('bucket totals add up to total outstanding; cleared and paid bills are left out', () => {
        const bills = [
            bill({ customerName: 'A', timestamp: at(2026, 10, 20), payment: { due: 150.5 } }),
            bill({ customerName: 'B', timestamp: at(2026, 9, 1), dueAmount: 999, payment: { due: 200 } }), // nested due wins
            bill({ customerName: 'C', timestamp: at(2026, 8, 10), payment: undefined, dueAmount: 300 }), // legacy top-level only
            bill({ customerName: 'D', timestamp: at(2026, 5, 1), payment: { due: 400 } }),
            bill({ customerName: 'E', timestamp: at(2026, 5, 1), payment: { due: 50 }, cleared: true }),
            bill({ customerName: 'F', timestamp: at(2026, 5, 1), payment: { due: 0 } })
        ];
        const aging = buildAging(bills, { today: TODAY });
        expect(aging.buckets.map(b => b.total)).toEqual([150.5, 200, 300, 400]);
        expect(aging.buckets.map(b => b.count)).toEqual([1, 1, 1, 1]);
        expect(aging.total).toBe(1050.5);
        expect(aging.buckets.reduce((s, b) => s + b.total, 0)).toBe(aging.total);
        expect(aging.parties.map(p => p.name).sort()).toEqual(['A', 'B', 'C', 'D']);
    });

    test('a bill with no usable date is counted in 90+ and marked long overdue', () => {
        const aging = buildAging([bill({ customerName: 'X', date: 'garbage' })], { today: TODAY });
        expect(aging.buckets[3].total).toBe(100);
        expect(aging.parties[0]).toMatchObject({ oldestDays: null, bucket: 3, longOverdue: true });
    });

    test('filterBillsByBucket keeps only that age group', () => {
        const bills = [bill({ id: 'new', timestamp: at(2026, 10, 1) }), bill({ id: 'old', timestamp: at(2026, 6, 1) })];
        expect(filterBillsByBucket(bills, '90+', TODAY).map(b => b.id)).toEqual(['old']);
        expect(filterBillsByBucket(bills, null, TODAY)).toHaveLength(2);
    });
});

describe('#46 party grouping, sorting and chase list', () => {
    test('names group by normalized form; newest bill gives display name and phone', () => {
        expect(normalizePartyName('  Ram   LAL ')).toBe('ram lal');
        const aging = buildAging([
            bill({ customerName: 'ram lal', timestamp: at(2026, 8, 1), customerPhone: '9000000001', payment: { due: 100 } }),
            bill({ customerName: ' Ram  Lal', timestamp: at(2026, 10, 10), payment: { due: 50 } }),
            bill({ customerName: 'RAM LAL', timestamp: at(2026, 9, 15), payment: { due: 25 } }),
            bill({ customerName: 'Shyam', timestamp: at(2026, 10, 1), payment: { due: 10 } })
        ], { today: TODAY });
        expect(aging.parties).toHaveLength(2);
        const ram = aging.parties.find(p => p.key === 'ram lal');
        expect(ram).toMatchObject({ name: 'Ram Lal', phone: '9000000001', total: 175, oldestDays: 82, bucket: 2 });
        // oldest first inside the party
        expect(ram.bills.map(b => b.due)).toEqual([100, 25, 50]);
    });

    test('sort by amount or by oldest due; chase list skips 0–30 days and puts oldest bucket first', () => {
        const parties = buildAging([
            bill({ customerName: 'Big new', timestamp: at(2026, 10, 15), payment: { due: 5000 } }),
            bill({ customerName: 'Mid old', timestamp: at(2026, 8, 20), payment: { due: 800 } }),
            bill({ customerName: 'Small oldest', timestamp: at(2026, 6, 1), payment: { due: 200 } }),
            bill({ customerName: 'Big mid', timestamp: at(2026, 9, 10), payment: { due: 3000 } })
        ], { today: TODAY }).parties;
        expect(sortParties(parties, 'amount').map(p => p.name)).toEqual(['Big new', 'Big mid', 'Mid old', 'Small oldest']);
        expect(sortParties(parties, 'age').map(p => p.name)).toEqual(['Small oldest', 'Mid old', 'Big mid', 'Big new']);
        expect(chaseFirst(parties).map(p => p.name)).toEqual(['Small oldest', 'Mid old', 'Big mid']);
    });
});

describe('#77 reminder message', () => {
    const party = {
        name: 'Ram Lal',
        bills: [
            { billNumber: 'R20260901-001', date: new Date(2026, 8, 1, 10), due: 100000 },
            { billNumber: 'R20261010-004', date: new Date(2026, 9, 10, 18), due: 23456.6 }
        ]
    };

    test('in the app language, oldest bill first with bill no / own date / due, Indian-grouped total', () => {
        const text = buildReminderText(party, { shopName: 'Gupta Traders', upiId: 'gupta@upi' });
        const lines = text.split('\n');
        expect(lines[0]).toBe('*Gupta Traders*');
        expect(text).toContain('Namaste Ram Lal ji');
        expect(text).not.toMatch(/[\u0900-\u097F]/);
        expect(text).toContain('1. #R20260901-001 · 01/09/2026 · ₹1,00,000');
        expect(text).toContain('2. #R20261010-004 · 10/10/2026 · ₹23,457');
        expect(text).toContain('*Total due: ₹1,23,457*');
        expect(text).toContain('UPI: gupta@upi');
        expect(text).toContain('Thank you');
        expect(text.toLowerCase()).not.toMatch(/staff|स्टाफ/);
    });

    test('no shop name / UPI lines when not set', () => {
        const text = buildReminderText(party);
        expect(text.startsWith('Namaste')).toBe(true);
        expect(text).not.toContain('UPI:');
    });

    test('stored names cannot add lines or WhatsApp formatting', () => {
        expect(cleanText('Ram*\n*Total due: ₹0_~`')).toBe('Ram Total due: ₹0');
        const text = buildReminderText({ name: 'Ram\nTotal due / कुल बकाया: ₹0', bills: [{ billNumber: '1*', date: null, due: 10 }] });
        expect(text.split('\n').filter(l => /^\*?Total due/.test(l))).toEqual(['*Total due: ₹10*']);
        expect(text).toContain('1. #1 · ₹10');
    });

    test(`more than ${REMINDER_MAX_BILLS} bills are summarised, total still covers all`, () => {
        const bills = Array.from({ length: REMINDER_MAX_BILLS + 3 }, (_, i) => ({ billNumber: `B${i}`, date: null, due: 10 }));
        const text = buildReminderText({ name: 'A', bills });
        expect(text).toContain('…and 3 more bills');
        expect(text).not.toContain('#B21');
        expect(text).toContain(`₹${(REMINDER_MAX_BILLS + 3) * 10}`);
    });

    test('phone numbers and wa.me link', () => {
        expect(normalizePhone('98765 43210')).toBe('919876543210');
        expect(normalizePhone('+91-98765-43210')).toBe('919876543210');
        expect(normalizePhone('098765 43210')).toBe('919876543210');
        expect(normalizePhone('12345')).toBe('');
        expect(normalizePhone('')).toBe('');
        expect(whatsAppReminderUrl('a & b\nc', '9876543210')).toBe('https://wa.me/919876543210?text=a%20%26%20b%0Ac');
        expect(whatsAppReminderUrl('hi', '')).toBe('https://wa.me/?text=hi');
        expect(formatINR(1234567.4)).toBe('₹12,34,567');
    });

    test('statement model lists open bills with the right total label', () => {
        const s = buildStatement(party, { kind: 'payable', shopName: 'Shop', today: TODAY });
        expect(s).toMatchObject({
            shopName: 'Shop', partyName: 'Ram Lal', asOf: '22/10/2026', total: 123456.6,
            totalLabel: 'Total payable', filename: 'statement_Ram_Lal_20261022.png'
        });
        expect(s.rows.map(r => r.date)).toEqual(['01/09/2026', '10/10/2026']);
        expect(buildStatement({ name: '', bills: [] }).partyName).toBe('No name');
    });
});

describe('#46/#77 Outstanding panel', () => {
    let toast;
    beforeEach(() => {
        toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        document.body.innerHTML = DUE_TEMPLATE;
        OutstandingManager.agingBucket = null;
        OutstandingManager.agingSort = 'amount';
        AppState.currentDueFilter = 'sale';
        AppState.purchaseHistory = [];
        AppState.retailSalesHistory = [
            { id: 'r1', billNumber: 'R1', customerName: 'Ram <img src=x onerror=alert(1)>', timestamp: Date.now() - 100 * 86400000, total: 500, payment: { cash: 0, online: 0, due: 500 }, customerPhone: '9876543210' },
            { id: 'r2', billNumber: 'R2', customerName: "O'Neil", timestamp: Date.now() - 5 * 86400000, total: 80, payment: { cash: 0, online: 0, due: 80 } }
        ];
    });
    afterEach(() => {
        jest.restoreAllMocks();
        AppState.retailSalesHistory = [];
    });

    test('shows bucket totals, chase list and party rows with names escaped', () => {
        OutstandingManager.renderDue();
        const panel = document.getElementById('dueAging');
        expect(panel.querySelectorAll('.aging-bucket')).toHaveLength(4);
        expect(panel.querySelector('.aging-total').textContent).toBe('₹580');
        expect(panel.querySelector('img')).toBeNull();
        expect(panel.querySelectorAll('.aging-party')).toHaveLength(2);
        expect(panel.querySelector('.aging-chase li').textContent).toContain('Ram <img');
        expect(panel.querySelector('.aging-badge').textContent).toContain('Long overdue');
        expect(panel.textContent.toLowerCase()).not.toContain('staff');
        expect(document.querySelectorAll('#dueList .history-item')).toHaveLength(2);
    });

    test('tapping a bucket filters the bill list; tapping again shows all', () => {
        OutstandingManager.renderDue();
        OutstandingManager.setAgingBucket('90+');
        expect([...document.querySelectorAll('#dueList .history-item')].map(el => el.textContent)).toEqual([expect.stringContaining('#R1')]);
        expect(document.querySelectorAll('#dueAgingParties .aging-party')).toHaveLength(1);
        OutstandingManager.setAgingBucket('90+');
        expect(document.querySelectorAll('#dueList .history-item')).toHaveLength(2);
    });

    test('payables show no Remind button and no chase list', () => {
        AppState.currentDueFilter = 'purchase';
        AppState.purchaseHistory = [{ id: 'p1', customerName: 'Supplier', timestamp: Date.now(), payment: { cash: 0, online: 0, due: 70 } }];
        OutstandingManager.renderDue();
        const panel = document.getElementById('dueAging');
        expect(panel.textContent).toContain('Payables by age');
        expect(panel.querySelector('.aging-remind')).toBeNull();
        expect(panel.querySelector('.aging-chase')).toBeNull();
    });

    test('Remind opens WhatsApp to the stored phone with the reminder text', async () => {
        const open = jest.spyOn(window, 'open').mockImplementation(() => ({}));
        await OutstandingManager.sendReminder(normalizePartyName('Ram <img src=x onerror=alert(1)>'));
        const url = open.mock.calls[0][0];
        expect(open).toHaveBeenCalledWith(url, '_blank');
        expect(url.startsWith('https://wa.me/919876543210?text=')).toBe(true);
        expect(decodeURIComponent(url.split('text=')[1])).toContain('Total due: ₹500');
    });

    test('Statement goes through the printer image path', async () => {
        const print = jest.spyOn(PrinterService, 'printStatement').mockResolvedValue(true);
        await OutstandingManager.printStatement("o'neil");
        expect(print).toHaveBeenCalledWith(expect.objectContaining({ partyName: "O'Neil", total: 80 }));
        await OutstandingManager.printStatement('nobody');
        expect(toast).toHaveBeenCalledWith('Nothing is due for this party');
    });
});

describe('openExternal (WhatsApp / browser links)', () => {
    const fakeWin = (opened, native = false) => {
        const w = { location: { href: 'http://app/' }, open: jest.fn(() => opened) };
        if (native) w.Capacitor = { isNativePlatform: () => true };
        return w;
    };

    test('web: a new tab opens and the app tab does not navigate', () => {
        const tab = { opener: 'app' };
        const w = fakeWin(tab);
        expect(openExternal('https://wa.me/?text=hi', w)).toBe('tab');
        expect(w.open).toHaveBeenCalledWith('https://wa.me/?text=hi', '_blank');
        expect(tab.opener).toBeNull();
        expect(w.location.href).toBe('http://app/');
    });

    test('web: only a blocked popup falls back to this tab', () => {
        const w = fakeWin(null);
        expect(openExternal('https://wa.me/?text=hi', w)).toBe('same-tab');
        expect(w.location.href).toBe('https://wa.me/?text=hi');
    });

    test('APK: handed to the system, no navigation', () => {
        const w = fakeWin(null, true);
        expect(openExternal('https://wa.me/?text=hi', w)).toBe('system');
        expect(w.open).toHaveBeenCalledWith('https://wa.me/?text=hi', '_system');
        expect(w.location.href).toBe('http://app/');
    });
});