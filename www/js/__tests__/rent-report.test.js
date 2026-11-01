/**
 * Rentals phase 3 (#157): agreement terms, lease reminders for Today (REM-4)
 * and the yearly report (RENT-19, figures checked against the oracle in
 * tests/oracle/rent-report.test.js).
 */
import { agreementError, noticeBy, leaseReminders, reportMonths, LEASE_ENDING_AHEAD } from '../rentals/rent-math-report.js';
import { saveLeaseReminders, leaseReminder, LEASE_REMINDER_LIMIT } from '../utils/reminders.js';
import { DayManager } from '../modules/day.js';
import { AppState } from '../utils/state.js';

const memStore = () => {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
};

describe('agreement terms', () => {
    test.each([
        [{ agreementEnd: '2027-03', noticeMonths: 1 }, null],
        [{ agreementEnd: '', noticeMonths: 0 }, null],
        [{ agreementEnd: '2026-01', noticeMonths: 0 }, 'msg.rent.agr_end_bad'],
        [{ agreementEnd: '2027-13', noticeMonths: 0 }, 'msg.rent.agr_end_bad'],
        [{ agreementEnd: '2027-03', noticeMonths: 13 }, 'msg.rent.agr_notice_bad'],
        [{ agreementEnd: '2027-03', noticeMonths: 1.5 }, 'msg.rent.agr_notice_bad']
    ])('%j', (terms, want) => expect(agreementError(terms, '2026-04')).toBe(want));

    test('notice by = end month − notice months', () => {
        expect(noticeBy({ agreementEnd: '2027-02', noticeMonths: 3 })).toBe('2026-11');
        expect(noticeBy({ agreementEnd: '2027-02', noticeMonths: 0 })).toBe('');
        expect(noticeBy({ noticeMonths: 2 })).toBe('');
    });
});

describe('REM-4: lease reminders', () => {
    const MONTH = '2026-11';
    const lease = (id, extra) => ({ id, status: 'active', rent: 10000, increasePct: 5, startMonth: '2026-06', rentSince: '2026-06', ...extra });
    test(`agreements ending within ${LEASE_ENDING_AHEAD} months or already past, soonest first; increases due; ended leases left out`, () => {
        const list = leaseReminders([
            lease('a', { agreementEnd: '2027-01', noticeMonths: 1 }),
            lease('b', { agreementEnd: '2026-10' }),
            lease('c', { agreementEnd: '2027-02' }),
            lease('d', { agreementEnd: '2026-11', status: 'ended' }),
            lease('e', { startMonth: '2025-09', rentSince: '2025-09' })
        ], MONTH, { names: (l) => ({ place: `P-${l.id}`, tenant: '' }) });
        expect(list.map(x => [x.kind, x.leaseId, x.left ?? x.newRent])).toEqual([['ending', 'b', -1], ['ending', 'a', 2], ['increase', 'e', 10500]]);
        expect(list[1].notice).toBe('2026-12');
    });

    test('kept per person and month on this phone, at most 20 listed', () => {
        const s = memStore();
        const items = Array.from({ length: 25 }, (_, i) => ({ kind: 'ending', place: `U${i}`, end: '2026-12', left: 1 }));
        saveLeaseReminders(s, { uid: 'u1', month: MONTH, items, at: 5 });
        expect(leaseReminder(s, 'u1', MONTH)).toMatchObject({ more: 5, at: 5 });
        expect(leaseReminder(s, 'u1', MONTH).items).toHaveLength(LEASE_REMINDER_LIMIT);
        expect(leaseReminder(s, 'u2', MONTH)).toBeNull();
        expect(leaseReminder(s, 'u1', '2026-12')).toBeNull();
    });

    test('Today lists them for rentals roles, names escaped', () => {
        const now = new Date();
        const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        Object.assign(AppState, { currentUser: { uid: 'u1' }, userRole: 'owner', retailSalesHistory: [], purchaseHistory: [], salesHistory: [] });
        saveLeaseReminders(localStorage, { uid: 'u1', month, items: [{ kind: 'ending', place: '<b>G1</b>', tenant: 'Ram', end: month, left: 0 }, { kind: 'increase', place: 'G2', pct: 5, newRent: 10500 }] });
        document.body.innerHTML = '<div id="todayReminders"></div>';
        DayManager.renderReminders(now);
        const block = document.querySelector('[data-reminder="leases"]');
        expect(block).not.toBeNull();
        expect(block.innerHTML).toContain('&lt;b&gt;G1&lt;/b&gt;');
        expect(block.textContent).toContain('10,500');
    });
});

describe('RENT-19 months', () => {
    test('financial year April–March; calendar year January–December', () => {
        expect(reportMonths(2026)).toEqual(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03']);
        expect(reportMonths(2026, false)[0]).toBe('2026-01');
        expect(reportMonths(2026, false)[11]).toBe('2026-12');
    });
});
