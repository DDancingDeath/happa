/**
 * @fileoverview A phone with a wrong clock can't record payments (the rules refuse a
 * payments[] entry whose `at` is 10 minutes or more off the server's time, #184):
 * it gets a clear message instead of a bare permission error (#115).
 */
import { OutstandingManager } from '../modules/outstanding.js';
import { WholesaleSalesManager } from '../modules/wholesale-sales.js';
import { UIManager } from '../ui/ui-manager.js';
import { AppState } from '../utils/state.js';
import { setLang } from '../i18n/index.js';
import { clockSkewMs, isClockWrong, measureClockSkew, refusedForClock, CLOCK_WRONG_MS, PAYMENT_CLOCK_LIMIT_MS } from '../utils/clock-skew.js';

const MIN = 60 * 1000;
const refused = () => Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
// An ID token issued by the server `offsetMs` from this phone's clock.
const userWithServerAt = (offsetMs) => ({
    getIdTokenResult: jest.fn(async (force) => ({ force, issuedAtTime: new Date(Date.now() + offsetMs).toUTCString() }))
});

describe('clock skew', () => {
    test('skew is server time minus the phone time halfway through the request', () => {
        expect(clockSkewMs(10_000, 1_000, 3_000)).toBe(8_000);
        expect(clockSkewMs(NaN, 1, 2)).toBeNull();
    });

    test('wrong a minute before the rules refuse, either way', () => {
        expect(CLOCK_WRONG_MS).toBeLessThan(PAYMENT_CLOCK_LIMIT_MS);
        expect(isClockWrong(CLOCK_WRONG_MS - 1)).toBe(false);
        expect(isClockWrong(CLOCK_WRONG_MS)).toBe(true);
        expect(isClockWrong(-PAYMENT_CLOCK_LIMIT_MS)).toBe(true);
        expect(isClockWrong(null)).toBe(false);
    });

    test('measured from a freshly issued ID token; unknown when it cannot be read', async () => {
        const user = userWithServerAt(20 * MIN);
        const skew = await measureClockSkew({ user });
        expect(user.getIdTokenResult).toHaveBeenCalledWith(true);
        expect(Math.abs(skew - 20 * MIN)).toBeLessThan(2000);
        expect(await measureClockSkew({ user: { getIdTokenResult: async () => { throw new Error('offline'); } } })).toBeNull();
        expect(await measureClockSkew({ user: null })).toBeNull();
    });

    test('only a permission error is checked against the clock', async () => {
        const user = userWithServerAt(-30 * MIN);
        expect(await refusedForClock({ code: 'unavailable' }, { user })).toBe(false);
        expect(user.getIdTokenResult).not.toHaveBeenCalled();
        expect(await refusedForClock(refused(), { user })).toBe(true);
        expect(await refusedForClock(refused(), { user: userWithServerAt(2 * MIN) })).toBe(false);
    });
});

describe('payment refused because of the phone clock', () => {
    let toast;
    let user;
    const bill = { id: 'r1', billNumber: 'R-1', customerName: 'Ram', total: 100, payment: { cash: 0, online: 0, due: 100 }, dueAmount: 100 };

    beforeEach(() => {
        toast = jest.spyOn(UIManager, 'showToast').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
        jest.spyOn(OutstandingManager, 'applyPaymentTransaction').mockRejectedValue(refused());
        jest.spyOn(OutstandingManager, 'applyWriteOffTransaction').mockRejectedValue(refused());
        AppState.currentUser = { uid: 'u1', email: 's@x' };
        AppState.userName = 'Staff';
        AppState.retailSalesHistory = [{ ...bill }];
        AppState.salesHistory = [{ ...bill, id: 'w1' }];
        user = userWithServerAt(25 * MIN);
        global.firebase = window.firebase = { auth: () => ({ currentUser: user }) };
        setLang('en', { store: null });
    });

    afterEach(() => {
        delete global.firebase;
        delete window.firebase;
        setLang('en', { store: null });
    });

    test('Due screen: the clock message, not "permission denied"', async () => {
        expect(await OutstandingManager.recordDuePayment({ billType: 'retail', billId: 'r1', cash: 40 })).toBe(false);
        expect(toast).toHaveBeenLastCalledWith("Your phone's time is wrong. Fix the date and time to record payments.");
    });

    test('in Hindi too', async () => {
        setLang('hi', { store: null });
        await OutstandingManager.recordDuePayment({ billType: 'retail', billId: 'r1', cash: 40 });
        expect(toast).toHaveBeenLastCalledWith('आपके फ़ोन का समय गलत है। भुगतान दर्ज करने के लिए फ़ोन की तारीख और समय ठीक करें।');
    });

    test('write-off and the wholesale payment box say the same', async () => {
        await OutstandingManager._writeOff('retail', AppState.retailSalesHistory[0], 'gone away');
        expect(toast).toHaveBeenLastCalledWith("Your phone's time is wrong. Fix the date and time to record payments.");
        document.body.innerHTML = '<input id="payment_w1" value="40">';
        await WholesaleSalesManager.recordPayment('w1');
        expect(toast).toHaveBeenLastCalledWith("Your phone's time is wrong. Fix the date and time to record payments.");
    });

    test('a right clock keeps the plain error', async () => {
        user = userWithServerAt(30 * 1000);
        await OutstandingManager.recordDuePayment({ billType: 'retail', billId: 'r1', cash: 40 });
        expect(toast).toHaveBeenLastCalledWith('Error: Missing or insufficient permissions.');
    });
});
