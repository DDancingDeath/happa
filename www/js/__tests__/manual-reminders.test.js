/**
 * Manual reminders on Today (#86): checks before saving, grouping (REM-3),
 * who sees and does what on Today, and the writes the taps make.
 */
import { checkReminder, groupReminders, daysUntil } from '../utils/manual-reminders.js';
import { ManualReminders } from '../ui/manual-reminders.js';
import { FirebaseService } from '../firebase/firestore-service.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { DayManager } from '../modules/day.js';

const TODAY = '2026-11-15';

describe('checkReminder', () => {
    test.each([
        [{ title: '  Collect  from Ramesh ', dueDate: TODAY, party: ' Ramesh ' }, { ok: true, value: { title: 'Collect from Ramesh', dueDate: TODAY, party: 'Ramesh' } }],
        [{ title: '', dueDate: TODAY }, { ok: false, error: 'msg.reminders.title_needed' }],
        [{ title: 'x'.repeat(121), dueDate: TODAY }, { ok: false, error: 'msg.reminders.title_long' }],
        [{ title: 'a', dueDate: '2026-11-14' }, { ok: false, error: 'msg.reminders.date_past' }],
        [{ title: 'a', dueDate: '2026-02-30' }, { ok: false, error: 'msg.reminders.date_needed' }],
        [{ title: 'a', dueDate: '' }, { ok: false, error: 'msg.reminders.date_needed' }],
        [{ title: 'a', dueDate: '2029-01-01' }, { ok: false, error: 'msg.reminders.date_far' }],
        [{ title: 'a', dueDate: TODAY, party: 'p'.repeat(81) }, { ok: false, error: 'msg.reminders.party_long' }]
    ])('%j', (input, want) => expect(checkReminder(input, TODAY)).toEqual(want));
});

describe('groupReminders (REM-3)', () => {
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
        expect(ack).toHaveBeenCalledWith('r1', { uid: 'u1', name: 'Owner' });
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