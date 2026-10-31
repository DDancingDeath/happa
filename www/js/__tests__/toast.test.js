import { UIManager, resolveToastOptions, errorRef } from '../ui/ui-manager.js';
import { on, TOAST_ERROR } from '../utils/events.js';
import { TelemetryService } from '../services/telemetry.js';
import { t, setLang, resetLangForTests } from '../i18n/index.js';

describe('showToast (#51)', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        document.body.innerHTML = '<div id="toast" class="toast"></div>';
    });
    afterEach(() => jest.useRealTimers());

    const toast = () => document.getElementById('toast');

    test("a type string is not used as the duration: 'error' stays >= 4 s and is styled", () => {
        UIManager.showToast('Failed to delete user', 'error');
        expect(toast().classList.contains('error')).toBe(true);
        jest.advanceTimersByTime(4000);
        expect(toast().classList.contains('show')).toBe(true);
        jest.advanceTimersByTime(1100);
        expect(toast().classList.contains('show')).toBe(false);
    });

    test('numeric durations still work and clear a previous type style', () => {
        UIManager.showToast('Oops', 'error');
        UIManager.showToast('Saved', 1000);
        expect(toast().classList.contains('error')).toBe(false);
        jest.advanceTimersByTime(999);
        expect(toast().classList.contains('show')).toBe(true);
        jest.advanceTimersByTime(2);
        expect(toast().classList.contains('show')).toBe(false);
    });

    test("a translated message keeps its type styling: showToast(t(key), 'error') (#143, #176)", () => {
        UIManager.showToast(t('msg.common.access_denied'), 'error');
        expect(toast().textContent).toBe(`Access denied · Ref ${errorRef('Access denied')}`);
        expect(toast().classList.contains('error')).toBe(true);
        setLang('hi');
        UIManager.showToast(t('msg.finance.account_updated'), 'success');
        expect(toast().textContent).toBe(t('msg.finance.account_updated', null, 'hi'));
        expect(toast().classList.contains('success')).toBe(true);
        expect(toast().classList.contains('error')).toBe(false);
        localStorage.clear();
        resetLangForTests();
    });

    test('resolveToastOptions handles every signature', () => {
        expect(resolveToastOptions()).toEqual({ type: null, duration: 2000 });
        expect(resolveToastOptions(3000)).toEqual({ type: null, duration: 3000 });
        expect(resolveToastOptions('error')).toEqual({ type: 'error', duration: 5000 });
        expect(resolveToastOptions('success')).toEqual({ type: 'success', duration: 2000 });
        expect(resolveToastOptions('warning', 7000)).toEqual({ type: 'warning', duration: 7000 });
        expect(resolveToastOptions('bogus')).toEqual({ type: null, duration: 2000 });
    });

    test('an error toast carries a short ref that names its Diagnostics entry (#82)', () => {
        TelemetryService.errorBuffer = [];
        const seen = [];
        const stop = on(TOAST_ERROR, (e) => seen.push(e));
        UIManager.showToast('Failed to delete user', 'error');
        stop();
        const ref = errorRef('Failed to delete user');
        expect(ref).toMatch(/^\d{6}$/);
        expect(errorRef('Failed to delete user')).toBe(ref);
        expect(errorRef('Failed to save bill')).not.toBe(ref);
        expect(toast().textContent).toBe(`Failed to delete user · Ref ${ref}`);
        expect(seen).toEqual([{ message: 'Failed to delete user', ref }]);
        expect(TelemetryService.createFingerprint({ type: 'toast', message: 'Failed to delete user', ref })).toBe(ref);
        expect(TelemetryService.errorBuffer).toEqual([expect.objectContaining({ type: 'toast', message: 'Failed to delete user', fingerprint: ref })]);
        TelemetryService.errorBuffer = [];
    });

    test('other toasts have no ref and are not reported', () => {
        const seen = [];
        const stop = on(TOAST_ERROR, (e) => seen.push(e));
        UIManager.showToast('Saved', 'success');
        UIManager.showToast('Careful', 'warning');
        UIManager.showToast('Plain');
        stop();
        expect(toast().textContent).toBe('Plain');
        expect(seen).toEqual([]);
    });
});
