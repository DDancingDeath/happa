/**
 * Manual reminders on Today (#86): checks before saving, grouping (REM-5),
 * who sees and does what on Today, and the writes the taps make.
 */
import { checkReminder, groupReminders, daysUntil, nextDueDate, repeatDayFor } from '../utils/manual-reminders.js';
import { ManualReminders } from '../ui/manual-reminders.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { DayManager } from '../modules/day.js';

const TODAY = '2026-11-15';

describe('checkReminder', () => {
    test.each([
        [{ title: '  Collect  from Ramesh ', dueDate: TODAY, party: ' Ramesh ' }, { ok: true, value: { title: 'Collect from Ramesh', dueDate: TODAY, party: 'Ramesh', repeat: null, repeatDay: null } }],
        [{ title: 'Rent', dueDate: '2026-11-30', repeat: 'monthly' }, { ok: true, value: { title: 'Rent', dueDate: '2026-11-30', party: '', repeat: 'monthly', repeatDay: 30 } }],
        [{ title: 'Cash', dueDate: TODAY, repeat: 'daily' }, { ok: true, value: { title: 'Cash', dueDate: TODAY, party: '', repeat: 'daily', repeatDay: null } }],
        [{ title: 'a', dueDate: TODAY, repeat: 'yearly' }, { ok: true, value: { title: 'a', dueDate: TODAY, party: '', repeat: null, repeatDay: null } }],
        [{ title: '', dueDate: TODAY }, { ok: false, error: 'msg.reminders.title_needed' }],
        [{ title: 'x'.repeat(121), dueDate: TODAY }, { ok: false, error: 'msg.reminders.title_long' }],
        [{ title: 'a', dueDate: '2026-11-14' }, { ok: false, error: 'msg.reminders.date_past' }],
        [{ title: 'a', dueDate: '2026-02-30' }, { ok: false, error: 'msg.reminders.date_needed' }],
        [{ title: 'a', dueDate: '' }, { ok: false, error: 'msg.reminders.date_needed' }],
        [{ title: 'a', dueDate: '2029-01-01' }, { ok: false, error: 'msg.reminders.date_far' }],
        [{ title: 'a', dueDate: TODAY, party: 'p'.repeat(81) }, { ok: false, error: 'msg.reminders.party_long' }]
    ])('%j', (input, want) => expect(checkReminder(input, TODAY)).toEqual(want));

    test('an edit keeps a monthly reminder\'s day while its date and repeat stay; a new date sets it again', () => {
        const keep = { keepDueDate: '2027-02-28', keepRepeatDay: 31 };
        expect(checkReminder({ title: 'Rent', dueDate: '2027-02-28', repeat: 'monthly' }, '2027-02-01', keep).value.repeatDay).toBe(31);
        expect(checkReminder({ title: 'Rent', dueDate: '2027-02-27', repeat: 'monthly' }, '2027-02-01', keep).value.repeatDay).toBe(27);
        expect(checkReminder({ title: 'Rent', dueDate: '2027-02-28', repeat: 'weekly' }, '2027-02-01', keep).value.repeatDay).toBeNull();
    });

    test('an edit may keep a date that has passed; a changed date is checked as new', () => {
        expect(checkReminder({ title: 'a', dueDate: '2026-11-10' }, TODAY, { keepDueDate: '2026-11-10' }).ok).toBe(true);
        expect(checkReminder({ title: 'a', dueDate: '2026-11-11' }, TODAY, { keepDueDate: '2026-11-10' }))
            .toEqual({ ok: false, error: 'msg.reminders.date_past' });
    });
});

describe('nextDueDate (REM-6)', () => {
    test.each([
        ['2026-11-15', 'daily', '2026-11-15', '2026-11-16'],
        ['2026-11-15', 'weekly', '2026-11-15', '2026-11-22'],
        ['2026-11-15', 'monthly', '2026-11-15', '2026-12-15'],
        // done early: one period after the due date
        ['2026-11-20', 'weekly', '2026-11-15', '2026-11-27'],
        // done late: the first one today or later, not a pile of late copies
        ['2026-11-10', 'daily', '2026-11-15', '2026-11-15'],
        ['2026-11-01', 'weekly', '2026-11-15', '2026-11-15'],
        ['2026-11-02', 'weekly', '2026-11-15', '2026-11-16'],
        ['2026-09-10', 'monthly', '2026-11-15', '2026-12-10'],
        // a month end: the month's last day when shorter, back to the 31st after
        ['2027-01-31', 'monthly', '2027-01-31', '2027-02-28'],
        ['2028-01-31', 'monthly', '2028-01-31', '2028-02-29'],
        ['2026-12-31', 'daily', '2026-12-31', '2027-01-01'],
        ['2026-11-15', null, '2026-11-15', null],
        ['2026-11-15', 'yearly', '2026-11-15', null],
        ['bad', 'daily', '2026-11-15', null]
    ])('%s %s (today %s) → %s', (due, repeat, today, want) => expect(nextDueDate(due, repeat, today)).toBe(want));

    test('monthly keeps its day of the month through short months', () => {
        expect(nextDueDate('2027-02-28', 'monthly', '2027-02-28', 31)).toBe('2027-03-31');
        expect(nextDueDate('2027-04-30', 'monthly', '2027-04-30', 31)).toBe('2027-05-31');
        expect(repeatDayFor('2027-01-31', 'monthly')).toBe(31);
        expect(repeatDayFor('2027-01-31', 'weekly')).toBeNull();
    });
});

describe('groupReminders (REM-5)', () => {
    test('due (most late first), next 7 days, later only counted; closed ones left out', () => {
        const g = groupReminders([
            { id: 'a', title: 'A', dueDate: '2026-11-20' }, { id: 'b', title: 'B', dueDate: '2026-11-10' },
            { id: 'c', title: 'C', dueDate: TODAY }, { id: 'd', title: 'D', dueDate: '2026-11-30' },
            { id: 'e', title: 'E', dueDate: '2026-11-22' }, { id: 'f', title: 'F', dueDate: '2026-11-01', status: 'done' }
        ], TODAY);
        expect(g.due.map(r => [r.id, r.days])).toEqual([['b', -5], ['c', 0]]);
        expect(g.soon.map(r => [r.id, r.days])).toEqual([['a', 5], ['e', 7]]);
        expect(g.later).toBe(1);
    });
    test('days across a month end', () => expect(daysUntil('2026-12-01', '2026-11-30')).toBe(1));
});

describe('Today: manual reminders', () => {
    const LIST = [{ id: 'r1', title: '<b>Pay</b> Gupta', dueDate: '2000-01-01', party: 'Gupta', status: 'open' }];
    beforeEach(() => {
        ManualReminders.stop();
        ManualReminders.formOpen = false;
        AppState.currentUser = { uid: 'u1' };
        AppState.userName = 'Owner';
    });

    test('everyone sees due ones and Done; only owner/manager get Cancel and Add; text escaped', () => {
        ManualReminders.list = LIST;
        AppState.userRole = 'staff';
        const member = ManualReminders.html();
        expect(member).toContain('&lt;b&gt;Pay&lt;/b&gt; Gupta');
        expect(member).toContain('reminderDone(');
        expect(member).not.toContain('reminderCancel(');
        expect(member).not.toContain('reminderForm(true)');
        AppState.userRole = 'manager';
        expect(ManualReminders.html()).toContain('reminderCancel(');
        expect(ManualReminders.html()).toContain('reminderForm(true)');
    });

    test('members with nothing due see no block; owners see the Add button', () => {
        ManualReminders.list = [];
        AppState.userRole = 'staff';
        expect(ManualReminders.html()).toBe('');
        AppState.userRole = 'owner';
        expect(ManualReminders.html()).toContain('reminderForm(true)');
    });

    test('save checks first, then writes as the signed-in person', async () => {
        AppState.userRole = 'owner';
        const create = jest.spyOn(FirebaseService, 'createReminder').mockResolvedValue('new1');
        jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        ManualReminders.formOpen = true;
        document.body.innerHTML = ManualReminders.formHtml();
        document.getElementById('reminderTitle').value = '';
        expect(await ManualReminders.save()).toBe(false);
        expect(create).not.toHaveBeenCalled();
        document.getElementById('reminderTitle').value = 'Call Ramesh';
        expect(await ManualReminders.save()).toBe(true);
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Call Ramesh', party: '' }), { uid: 'u1', name: 'Owner' });
        expect(ManualReminders.formOpen).toBe(false);
    });

    test('members cannot save or cancel; Done writes for them', async () => {
        AppState.userRole = 'staff';
        const create = jest.spyOn(FirebaseService, 'createReminder').mockResolvedValue('x');
        const cancel = jest.spyOn(FirebaseService, 'cancelReminder').mockResolvedValue();
        const ack = jest.spyOn(FirebaseService, 'ackReminder').mockResolvedValue();
        expect(await ManualReminders.save()).toBe(false);
        expect(await ManualReminders.cancelReminderNow('r1')).toBe(false);
        expect(await ManualReminders.markReminderDone('r1')).toBe(true);
        expect(create).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
        expect(ack).toHaveBeenCalledWith('r1', { uid: 'u1', name: 'Owner' }, null);
    });

    test('Today shows the block first in Reminders, from the live list', () => {
        let push = null;
        jest.spyOn(FirebaseService, 'listenOpenReminders').mockImplementation((onNext) => { push = onNext; return () => {}; });
        AppState.userRole = 'staff';
        Object.assign(AppState, { retailSalesHistory: [], purchaseHistory: [], salesHistory: [] });
        document.body.innerHTML = '<div id="todayReminders"></div>';
        ManualReminders.start(() => DayManager.renderReminders());
        push(LIST);
        const host = document.getElementById('todayReminders');
        expect(host.hidden).toBe(false);
        expect(host.querySelector('[data-reminder="manual"] [data-reminder-id="r1"]')).not.toBeNull();
    });

    test('what is typed in the form survives Today redrawing', () => {
        AppState.userRole = 'owner';
        jest.spyOn(FirebaseService, 'listenOpenReminders').mockImplementation(() => () => {});
        Object.assign(AppState, { retailSalesHistory: [], purchaseHistory: [], salesHistory: [] });
        document.body.innerHTML = '<div id="todayReminders"></div>';
        ManualReminders.start(() => DayManager.renderReminders());
        ManualReminders.form(true);
        document.getElementById('reminderTitle').value = 'Call Gupta';
        document.getElementById('reminderParty').value = 'Gupta';
        document.getElementById('reminderParty').focus();
        DayManager.renderReminders();
        expect(document.getElementById('reminderTitle').value).toBe('Call Gupta');
        expect(document.getElementById('reminderParty').value).toBe('Gupta');
        expect(document.activeElement.id).toBe('reminderParty');
    });

    test('Done is one write per tap; already closed elsewhere is not an error', async () => {
        AppState.userRole = 'staff';
        ManualReminders.list = [];
        const toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        let finish;
        const ack = jest.spyOn(FirebaseService, 'ackReminder').mockImplementation(() => new Promise(r => { finish = r; }));
        const first = ManualReminders.markReminderDone('r1');
        const second = await ManualReminders.markReminderDone('r1');
        finish();
        await first;
        expect(ack).toHaveBeenCalledTimes(1);
        expect(second).toBeFalsy();
        ack.mockRejectedValueOnce(Object.assign(new Error('no'), { code: 'permission-denied' }));
        const closed = jest.spyOn(FirebaseService, 'reminderClosed').mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        expect(await ManualReminders.markReminderDone('r2')).toBe(true);
        expect(toast).not.toHaveBeenCalled();
        ack.mockRejectedValueOnce(Object.assign(new Error('no'), { code: 'permission-denied' }));
        expect(await ManualReminders.markReminderDone('r3')).toBe(false);
        expect(toast).toHaveBeenCalledTimes(1);
        expect(closed).toHaveBeenCalledTimes(2);
    });
});
describe('Today: changing and repeating reminders (#86)', () => {
    const today = () => new Date().toISOString().slice(0, 10);
    beforeEach(() => {
        ManualReminders.stop();
        ManualReminders.formOpen = false;
        ManualReminders.editId = null;
        AppState.currentUser = { uid: 'u1' };
        AppState.userName = 'Owner';
        jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());

    test('owner / manager get Change; members do not; a repeating one says how often', () => {
        ManualReminders.list = [{ id: 'r1', title: 'Rent', dueDate: '2000-01-01', repeat: 'monthly', status: 'open' }];
        AppState.userRole = 'staff';
        expect(ManualReminders.html()).not.toContain('reminderEdit(');
        expect(ManualReminders.html()).toContain('Every month');
        AppState.userRole = 'manager';
        expect(ManualReminders.html()).toContain(`reminderEdit('r1')`);
        expect(ManualReminders.edit('nope')).toBe(false);
    });

    test('Change fills the form; saving writes only that reminder, keeping a date that has passed', async () => {
        AppState.userRole = 'owner';
        ManualReminders.list = [{ id: 'r1', title: 'Pay Gupta', dueDate: '2000-01-01', party: 'Gupta', repeat: 'weekly', status: 'open' }];
        const update = jest.spyOn(FirebaseService, 'updateReminder').mockResolvedValue();
        const create = jest.spyOn(FirebaseService, 'createReminder').mockResolvedValue('x');
        expect(ManualReminders.edit('r1')).toBe(true);
        document.body.innerHTML = ManualReminders.html();
        expect(document.getElementById('reminderTitle').value).toBe('Pay Gupta');
        expect(document.getElementById('reminderRepeat').value).toBe('weekly');
        document.getElementById('reminderTitle').value = 'Pay Gupta in full';
        document.getElementById('reminderRepeat').value = '';
        expect(await ManualReminders.save()).toBe(true);
        expect(create).not.toHaveBeenCalled();
        expect(update).toHaveBeenCalledWith('r1', { title: 'Pay Gupta in full', dueDate: '2000-01-01', party: 'Gupta', repeat: null, repeatDay: null }, { uid: 'u1', name: 'Owner' });
        expect(ManualReminders.formOpen).toBe(false);
        expect(ManualReminders.editId).toBeNull();
    });

    test('a reminder done elsewhere while it was being changed is not written', async () => {
        AppState.userRole = 'owner';
        ManualReminders.list = [{ id: 'r1', title: 'A', dueDate: today(), status: 'open' }];
        const update = jest.spyOn(FirebaseService, 'updateReminder').mockResolvedValue();
        ManualReminders.edit('r1');
        document.body.innerHTML = ManualReminders.html();
        ManualReminders.list = [];
        expect(await ManualReminders.save()).toBe(false);
        expect(update).not.toHaveBeenCalled();
        expect(UIManager.showToast).toHaveBeenCalledWith('This reminder was done or cancelled on another phone.');
    });

    test('Done on a repeating one sends its next copy (REM-6) in the same write; a one-off sends none', async () => {
        AppState.userRole = 'staff';
        const due = today();
        ManualReminders.list = [
            { id: 'w', title: 'Collect', dueDate: due, party: 'Ram', repeat: 'weekly', status: 'open' },
            { id: 'm', title: 'Rent', dueDate: due, repeat: 'monthly', repeatDay: 31, status: 'open' },
            { id: 'o', title: 'Once', dueDate: due, status: 'open' }
        ];
        const ack = jest.spyOn(FirebaseService, 'ackReminder').mockResolvedValue('n1');
        expect(await ManualReminders.markReminderDone('w')).toBe(true);
        expect(ack).toHaveBeenLastCalledWith('w', { uid: 'u1', name: 'Owner' },
            { title: 'Collect', dueDate: nextDueDate(due, 'weekly', due), party: 'Ram', repeat: 'weekly', repeatDay: null });
        expect(UIManager.showToast.mock.calls[0][0]).toMatch(/^Done\. The next one is on /);
        await ManualReminders.markReminderDone('m');
        expect(ack.mock.calls[1][2]).toMatchObject({ repeat: 'monthly', repeatDay: 31, dueDate: nextDueDate(due, 'monthly', due, 31) });
        await ManualReminders.markReminderDone('o');
        expect(ack.mock.calls[2][2]).toBeNull();
    });
});
