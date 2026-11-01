/**
 * @fileoverview Wrong-clock banner at start-up and both times in the bill details (#115).
 * The start-up check asks the server's time (a fresh ID token) at most once a day on
 * this phone, never reads Firestore, and keeps the day's answer.
 */
import { dailyClockSkew, readClockCheck, billTimes, skewMinutes, CLOCK_CHECK_KEY, CLOCK_WRONG_MS } from '../utils/clock-skew.js';
import { startClockCheck, renderClockBanner, CLOCK_BANNER_ID } from '../ui/clock-banner.js';
import { HistoryManager } from '../modules/history.js';
import { AppState } from '../utils/state.js';
import { UIManager } from '../ui/ui-manager.js';
import { setLang } from '../i18n/index.js';

const MIN = 60 * 1000;
const memoryStorage = () => {
    const map = new Map();
    return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
};

afterEach(() => {
    setLang('en');
    jest.restoreAllMocks();
    document.body.innerHTML = '';
});

describe('daily start-up check', () => {
    test('measures once a day and keeps the answer for that day', async () => {
        const storage = memoryStorage();
        const measure = jest.fn(async () => 2 * MIN);
        let now = new Date(2026, 10, 1, 9, 0).getTime();
        expect(await dailyClockSkew({ storage, measure, now: () => now })).toBe(2 * MIN);
        now += 6 * 60 * MIN;
        expect(await dailyClockSkew({ storage, measure, now: () => now })).toBe(2 * MIN);
        expect(measure).toHaveBeenCalledTimes(1);
        expect(readClockCheck(storage)).toEqual({ day: '2026-11-01', skewMs: 2 * MIN });

        now = new Date(2026, 10, 2, 8, 0).getTime();
        measure.mockResolvedValueOnce(0);
        expect(await dailyClockSkew({ storage, measure, now: () => now })).toBe(0);
        expect(measure).toHaveBeenCalledTimes(2);
    });

    test('a wrong clock found earlier today is measured again at the next start (it may be fixed)', async () => {
        const storage = memoryStorage();
        const measure = jest.fn(async () => 15 * MIN);
        expect(await dailyClockSkew({ storage, measure })).toBe(15 * MIN);
        measure.mockResolvedValueOnce(0);
        expect(await dailyClockSkew({ storage, measure })).toBe(0);
        expect(await dailyClockSkew({ storage, measure })).toBe(0);
        expect(measure).toHaveBeenCalledTimes(2);
    });

    test('offline: nothing kept, the next start tries again; force measures now', async () => {
        const storage = memoryStorage();
        const measure = jest.fn(async () => null);
        expect(await dailyClockSkew({ storage, measure })).toBeNull();
        expect(storage.map.has(CLOCK_CHECK_KEY)).toBe(false);
        measure.mockResolvedValueOnce(-20 * MIN);
        expect(await dailyClockSkew({ storage, measure })).toBe(-20 * MIN);
        measure.mockResolvedValueOnce(0);
        expect(await dailyClockSkew({ storage, measure, force: true })).toBe(0);
        expect(measure).toHaveBeenCalledTimes(3);
    });

    test('a broken stored value is ignored', () => {
        const storage = memoryStorage();
        storage.setItem(CLOCK_CHECK_KEY, '{oops');
        expect(readClockCheck(storage)).toBeNull();
    });
});

describe('banner', () => {
    const banner = () => document.getElementById(CLOCK_BANNER_ID);

    test('a clock off by the limit or more shows it; a right clock shows nothing', async () => {
        await startClockCheck({ storage: memoryStorage(), doc: document, measure: async () => 2 * MIN });
        expect(banner()).toBeNull();
        await startClockCheck({ storage: memoryStorage(), doc: document, measure: async () => CLOCK_WRONG_MS + 3 * MIN });
        expect(banner().textContent).toContain('about 12 min behind');
    });

    test('ahead / behind, in Hindi too', () => {
        renderClockBanner(-30 * MIN, { doc: document });
        expect(banner().textContent).toContain('about 30 min ahead');
        setLang('hi');
        renderClockBanner(-30 * MIN, { doc: document });
        expect(banner().textContent).toContain('लगभग 30 मिनट आगे');
        expect(skewMinutes(20 * 1000)).toBe(1);
    });

    test('Check again measures now: a fixed clock removes the banner and says so', async () => {
        const toast = jest.fn();
        const measure = jest.fn(async () => 15 * MIN);
        await startClockCheck({ storage: memoryStorage(), doc: document, measure, toast });
        measure.mockResolvedValueOnce(30 * 1000);
        banner().querySelector('.clock-banner__recheck').click();
        await new Promise(r => setTimeout(r, 0));
        expect(banner()).toBeNull();
        expect(toast).toHaveBeenCalledWith("The phone's clock is right now.");
    });

    test('Check again with no internet keeps the banner and says why', async () => {
        const toast = jest.fn();
        const measure = jest.fn(async () => 15 * MIN);
        await startClockCheck({ storage: memoryStorage(), doc: document, measure, toast });
        measure.mockResolvedValueOnce(null);
        banner().querySelector('.clock-banner__recheck').click();
        await new Promise(r => setTimeout(r, 0));
        expect(banner()).not.toBeNull();
        expect(toast).toHaveBeenCalledWith("Couldn't check the clock: no internet.");
    });

    test('× hides it', () => {
        renderClockBanner(20 * MIN, { doc: document });
        banner().querySelector('.clock-banner__close').click();
        expect(banner()).toBeNull();
    });
});

describe('bill details: entered on the phone and saved on the server', () => {
    const entered = new Date(2026, 10, 1, 10, 0).getTime();

    test('billTimes: no server time for a bill not on the server yet', () => {
        const server = { seconds: (entered + 60 * MIN) / 1000 };
        expect(billTimes({ enteredAt: entered, createdAt: server }, { waiting: true })).toEqual({ entered: new Date(entered), server: null, far: false });
        expect(billTimes({ enteredAt: entered, createdAt: entered + 60 * MIN })).toMatchObject({ server: null, far: false });
    });

    test('billTimes: both times; far apart from the clock limit on', () => {
        const server = { toDate: () => new Date(entered + 2 * MIN) };
        expect(billTimes({ enteredAt: entered, createdAt: server })).toEqual({ entered: new Date(entered), server: new Date(entered + 2 * MIN), far: false });
        expect(billTimes({ enteredAt: entered, createdAt: { seconds: (entered + CLOCK_WRONG_MS) / 1000 } }).far).toBe(true);
        expect(billTimes({})).toEqual({ entered: null, server: null, far: false });
    });

    const open = (bill) => {
        document.body.innerHTML = '<div id="billDetailsOverlay"><div id="billDetailsContent"></div></div><div id="billDetailsActions"></div>';
        AppState.purchaseHistory = [bill];
        AppState.userRole = 'owner';
        jest.spyOn(UIManager, 'showModal').mockResolvedValue(true);
        return HistoryManager.viewBill(`id:${bill.id}`, 'purchase');
    };
    const rows = () => [...document.querySelectorAll('.bill-time-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim());

    test('both rows show; a far-apart pair gets the note', async () => {
        await open({ id: 'p1', billNumber: 'P1', items: [], grandTotal: 100, enteredAt: entered, createdAt: { seconds: (entered + 40 * MIN) / 1000 } });
        expect(rows()).toEqual(['Entered on the phone 1 Nov, 10:00 am', 'Saved on the server 1 Nov, 10:40 am']);
        expect(document.querySelector('.bill-times-note').textContent).toMatch(/clock was wrong, or the bill was saved offline/);
    });

    test('close together: no note; an old bill without the times: no rows', async () => {
        await open({ id: 'p2', billNumber: 'P2', items: [], grandTotal: 100, enteredAt: entered, createdAt: { seconds: (entered + MIN) / 1000 } });
        expect(rows()).toHaveLength(2);
        expect(document.querySelector('.bill-times-note')).toBeNull();
        await open({ id: 'p3', billNumber: 'P3', items: [], grandTotal: 100, date: '2026-10-01' });
        expect(rows()).toEqual([]);
    });
});
