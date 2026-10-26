/**
 * @fileoverview Tests for utils/history-window.js: range checks against the
 * loaded history window, de-duplicated loads, and the render gate that shows
 * a loading state instead of partial totals.
 */

import { createHistoryServiceMock } from './__mocks__/history-service-mock.js';

const MAR_1 = new Date(2026, 2, 1).getTime();
const FEB_1 = new Date(2026, 1, 1).getTime();
const JAN_1 = new Date(2026, 0, 1).getTime();

let hw;
let AppState;

beforeEach(() => {
    jest.resetModules();
    hw = require('../utils/history-window.js');
    AppState = require('../utils/state.js').AppState;
    delete window.FirebaseService;
});

afterEach(() => {
    delete window.FirebaseService;
});

const flush = () => new Promise(r => setTimeout(r, 0));

describe('needsHistoryFrom', () => {
    test('nothing is needed when full history is loaded', () => {
        expect(hw.needsHistoryFrom(JAN_1, 0)).toBe(false);
        expect(hw.needsHistoryFrom(null, 0)).toBe(false);
    });

    test('compares the range start with the window start', () => {
        expect(hw.needsHistoryFrom(FEB_1, MAR_1)).toBe(true);
        expect(hw.needsHistoryFrom(MAR_1, MAR_1)).toBe(false);
        expect(hw.needsHistoryFrom(new Date(2026, 2, 15), MAR_1)).toBe(false);
        expect(hw.needsHistoryFrom(new Date(2026, 1, 28), MAR_1)).toBe(true);
    });

    test('all-time (null) needs history whenever the window is partial', () => {
        expect(hw.needsHistoryFrom(null, MAR_1)).toBe(true);
        expect(hw.needsHistoryFrom(undefined, MAR_1)).toBe(true);
    });

    test('reads the window from FirebaseService, falling back to AppState', () => {
        AppState.historyLoadedFrom = MAR_1;
        expect(hw.historyLoadedFrom()).toBe(MAR_1);
        expect(hw.needsHistoryFrom(FEB_1)).toBe(true);

        window.FirebaseService = createHistoryServiceMock({ loadedFrom: FEB_1 });
        expect(hw.historyLoadedFrom()).toBe(FEB_1);
        expect(hw.needsHistoryFrom(FEB_1)).toBe(false);
    });

    test('a service without the window API means full history', () => {
        window.FirebaseService = {};
        expect(hw.historyLoadedFrom()).toBe(0);
        expect(hw.isFullHistoryLoaded()).toBe(true);
    });
});

describe('ensureHistoryFrom', () => {
    test('does not call the service when the range is covered', async () => {
        const svc = createHistoryServiceMock({ loadedFrom: FEB_1 });
        window.FirebaseService = svc;
        await expect(hw.ensureHistoryFrom(MAR_1)).resolves.toBe(true);
        expect(svc.ensureHistoryFrom).not.toHaveBeenCalled();
    });

    test('shares one request between concurrent callers', async () => {
        const svc = createHistoryServiceMock({ loadedFrom: MAR_1 });
        window.FirebaseService = svc;
        const [a, b] = await Promise.all([hw.ensureHistoryFrom(JAN_1), hw.ensureHistoryFrom(new Date(JAN_1))]);
        expect(a).toBe(true);
        expect(b).toBe(true);
        expect(svc.ensureHistoryFrom).toHaveBeenCalledTimes(1);
        expect(svc.ensureHistoryFrom).toHaveBeenCalledWith(JAN_1);
    });

    test('passes null for all history', async () => {
        const svc = createHistoryServiceMock({ loadedFrom: MAR_1 });
        window.FirebaseService = svc;
        await expect(hw.ensureHistoryFrom(null)).resolves.toBe(true);
        expect(svc.ensureHistoryFrom).toHaveBeenCalledWith(null);
        expect(hw.isFullHistoryLoaded()).toBe(true);
    });

    test('resolves false when the window still does not cover the range', async () => {
        const svc = createHistoryServiceMock({ loadedFrom: MAR_1 });
        svc.ensureHistoryFrom.mockImplementation(async () => {});
        window.FirebaseService = svc;
        await expect(hw.ensureHistoryFrom(JAN_1)).resolves.toBe(false);
    });
});

describe('rangeStatus', () => {
    test('ready when covered, otherwise loading then re-render', async () => {
        const svc = createHistoryServiceMock({ loadedFrom: MAR_1 });
        window.FirebaseService = svc;
        const rerender = jest.fn();

        expect(hw.rangeStatus('reports', MAR_1, rerender)).toBe('ready');
        expect(hw.rangeStatus('reports', JAN_1, rerender)).toBe('loading');
        // Repeated renders while loading don't start another request
        expect(hw.rangeStatus('reports', JAN_1, rerender)).toBe('loading');
        await flush();
        expect(svc.ensureHistoryFrom).toHaveBeenCalledTimes(1);
        expect(rerender).toHaveBeenCalledTimes(1);
        expect(hw.rangeStatus('reports', JAN_1, rerender)).toBe('ready');
    });

    test('reports error until retried', async () => {
        const svc = createHistoryServiceMock({ loadedFrom: MAR_1 });
        svc.ensureHistoryFrom.mockRejectedValueOnce(new Error('offline'));
        window.FirebaseService = svc;
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const rerender = jest.fn();

        expect(hw.rangeStatus('finance', null, rerender)).toBe('loading');
        await flush();
        expect(rerender).toHaveBeenCalledTimes(1);
        expect(hw.rangeStatus('finance', null, rerender)).toBe('error');
        expect(svc.ensureHistoryFrom).toHaveBeenCalledTimes(1);

        hw.retryRange('finance');
        expect(hw.rangeStatus('finance', null, rerender)).toBe('loading');
        await flush();
        expect(hw.rangeStatus('finance', null, rerender)).toBe('ready');
    });
});

describe('loadOlderHistory', () => {
    test('one request at a time, and remembers reaching the end', async () => {
        const svc = createHistoryServiceMock({ loadedFrom: MAR_1, earliest: JAN_1 });
        window.FirebaseService = svc;

        const [a, b] = await Promise.all([hw.loadOlderHistory(1), hw.loadOlderHistory(1)]);
        expect(svc.loadOlderHistory).toHaveBeenCalledTimes(1);
        expect(a).toEqual({ loadedFrom: FEB_1, reachedEnd: false });
        expect(b).toBe(a);
        expect(hw.historyReachedEnd()).toBe(false);

        await expect(hw.loadOlderHistory(1)).resolves.toEqual({ loadedFrom: 0, reachedEnd: true });
        expect(hw.historyReachedEnd()).toBe(true);
        await hw.loadOlderHistory(1);
        expect(svc.loadOlderHistory).toHaveBeenCalledTimes(2);
    });

    test('reaching the end does not stick across logout/login without a reload', async () => {
        AppState.currentUser = { uid: 'u1' };
        const svc = createHistoryServiceMock({ loadedFrom: FEB_1, earliest: JAN_1 });
        window.FirebaseService = svc;
        await hw.loadOlderHistory(1);
        expect(hw.historyReachedEnd()).toBe(true);

        // Same user signs in again: a fresh session restarts at the recent window
        window.FirebaseService = createHistoryServiceMock({ loadedFrom: MAR_1, earliest: 0 });
        expect(hw.historyReachedEnd()).toBe(false);
        await expect(hw.loadOlderHistory(1)).resolves.toEqual({ loadedFrom: FEB_1, reachedEnd: false });
        expect(window.FirebaseService.loadOlderHistory).toHaveBeenCalledTimes(1);
    });

    test('end flag reported by the service is reset when the user changes', async () => {
        AppState.currentUser = { uid: 'u1' };
        const svc = createHistoryServiceMock({ loadedFrom: MAR_1 });
        svc.loadOlderHistory = jest.fn(async () => ({ loadedFrom: MAR_1, reachedEnd: true }));
        window.FirebaseService = svc;
        await hw.loadOlderHistory(1);
        expect(hw.historyReachedEnd()).toBe(true);

        AppState.currentUser = { uid: 'u2' };
        expect(hw.historyReachedEnd()).toBe(false);
        AppState.currentUser = null;
    });

    test('a failed range gate is retried in a new session', async () => {
        AppState.currentUser = { uid: 'u1' };
        const svc = createHistoryServiceMock({ loadedFrom: MAR_1 });
        svc.ensureHistoryFrom = jest.fn(async () => { throw new Error('offline'); });
        window.FirebaseService = svc;
        jest.spyOn(console, 'error').mockImplementation(() => {});
        expect(hw.rangeStatus('reports', JAN_1)).toBe('loading');
        await flush(); await flush();
        expect(hw.rangeStatus('reports', JAN_1)).toBe('error');

        AppState.currentUser = { uid: 'u2' };
        svc.ensureHistoryFrom = jest.fn(async () => {});
        expect(hw.rangeStatus('reports', JAN_1)).toBe('loading');
        await flush();
        expect(svc.ensureHistoryFrom).toHaveBeenCalledTimes(1);
        AppState.currentUser = null;
    });
});

describe('findBillIndex', () => {
    const history = [{ id: 'abc' }, { id: 1700000000000 }, { id: 'xyz' }];

    test('finds by id regardless of string/number', () => {
        expect(hw.findBillIndex(history, 'xyz')).toBe(2);
        expect(hw.findBillIndex(history, '1700000000000')).toBe(1);
        expect(hw.findBillIndex(history, 'missing', 0)).toBe(-1);
    });

    test('falls back to the given index without an id', () => {
        expect(hw.findBillIndex(history, undefined, 1)).toBe(1);
        expect(hw.findBillIndex(history, null)).toBe(-1);
    });
});

describe('applyRangeState', () => {
    test('shows a notice and blurs figures while loading, removes it when ready', () => {
        document.body.innerHTML = '<div id="wrap"><div id="a"></div><div id="b"></div></div>';
        const a = document.getElementById('a');
        const b = document.getElementById('b');

        hw.applyRangeState([a, b], 'loading', { loadingText: 'Loading full history…' });
        const notice = a.previousElementSibling;
        expect(notice.classList.contains('history-range-notice')).toBe(true);
        expect(notice.textContent).toContain('Loading full history…');
        expect(a.classList.contains('history-range-loading')).toBe(true);
        expect(b.classList.contains('history-range-loading')).toBe(true);

        const onRetry = jest.fn();
        hw.applyRangeState([a, b], 'error', { onRetry });
        expect(document.querySelectorAll('.history-range-notice')).toHaveLength(1);
        expect(a.classList.contains('history-range-loading')).toBe(false);
        notice.querySelector('button').click();
        expect(onRetry).toHaveBeenCalled();

        hw.applyRangeState([a, b], 'ready');
        expect(document.querySelector('.history-range-notice')).toBeNull();
    });
});

describe('stale on-demand history hint (#132)', () => {
    const setup = (info, refreshResult = true) => {
        document.body.innerHTML = '<div id="wrap"><div id="list"></div></div>';
        const svc = {
            getOnDemandHistoryInfo: jest.fn(() => info),
            refreshOnDemandHistory: jest.fn(async () => refreshResult)
        };
        window.FirebaseService = svc;
        return { svc, list: document.getElementById('list') };
    };

    test('no on-demand history: no hint', () => {
        const { list } = setup(null);
        hw.renderStaleHistoryHint(list, { id: 'hint' });
        expect(document.getElementById('hint')).toBeNull();
    });

    test('plain "not updated live" text; Refresh re-fetches, then re-renders', async () => {
        const asOf = new Date(2026, 9, 21, 9, 5).getTime();
        const { svc, list } = setup({ from: JAN_1, liveFrom: MAR_1, asOf });
        expect(hw.staleHistoryHintText({ liveFrom: MAR_1, asOf }))
            .toBe("Bills older than 1 Mar 2026 aren't updated live. Refresh to see recent changes.");
        const onRefreshed = jest.fn();
        hw.renderStaleHistoryHint(list, { id: 'hint', onRefreshed });
        const hint = document.getElementById('hint');
        expect(hint.nextElementSibling).toBe(list);
        hint.querySelector('button').click();
        await flush();
        expect(svc.refreshOnDemandHistory).toHaveBeenCalledTimes(1);
        expect(onRefreshed).toHaveBeenCalledTimes(1);
        // Re-rendering reuses the same element.
        hw.renderStaleHistoryHint(list, { id: 'hint' });
        expect(document.querySelectorAll('#hint')).toHaveLength(1);
    });

    test('hidden when the screen shows no bill older than the live window', () => {
        const { list } = setup({ from: JAN_1, liveFrom: MAR_1, asOf: 1 });
        hw.renderStaleHistoryHint(list, { id: 'hint', isRelevant: () => true });
        expect(document.getElementById('hint')).not.toBeNull();
        hw.renderStaleHistoryHint(list, { id: 'hint', isRelevant: (info) => info.liveFrom < 0 });
        expect(document.getElementById('hint')).toBeNull();
    });

    test('failed refresh offers Retry and does not re-render', async () => {
        const { list } = setup({ from: JAN_1, liveFrom: MAR_1, asOf: 1 }, false);
        const onRefreshed = jest.fn();
        hw.renderStaleHistoryHint(list, { id: 'hint', onRefreshed });
        document.querySelector('#hint button').click();
        await flush();
        expect(document.querySelector('#hint button').textContent).toBe('Retry');
        expect(onRefreshed).not.toHaveBeenCalled();
    });
});
