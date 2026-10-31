/** Phone bottom bar (#142): active item, swipe targets, the swipe setting. */
import fs from 'fs';
import path from 'path';
import { BAR_TABS, BottomNav, opensKeyboard, swipeTarget } from '../ui/bottom-nav.js';

const NAV = fs.readFileSync(path.resolve(__dirname, '../../templates/navigation.html'), 'utf8');

test('the bar lists its pages in order, then More', () => {
    document.body.innerHTML = NAV;
    expect([...document.querySelectorAll('.bottom-nav-item')].map(i => i.dataset.tab)).toEqual([...BAR_TABS, 'more']);
});

test('the open page is marked (aria-current); other pages mark More', () => {
    document.body.innerHTML = NAV;
    BottomNav.markActive('history');
    const active = [...document.querySelectorAll('.bottom-nav-item.active')];
    expect(active.map(i => i.dataset.tab)).toEqual(['history']);
    expect(active[0].getAttribute('aria-current')).toBe('page');
    BottomNav.markActive('stock');
    expect([...document.querySelectorAll('.bottom-nav-item.active')].map(i => i.dataset.tab)).toEqual(['more']);
    expect(document.querySelector('[aria-current]')).toBeNull();
});

test('swipe left goes to the next bar page, right to the previous; short, slanted or off-bar swipes do nothing', () => {
    expect(swipeTarget('day', -120, 10)).toBe('history');
    expect(swipeTarget('day', 120, 10)).toBe('billing');
    expect(swipeTarget('billing', 120, 0)).toBeNull();
    expect(swipeTarget('due', -120, 0)).toBeNull();
    expect(swipeTarget('day', -50, 0)).toBeNull();
    expect(swipeTarget('day', -120, 80)).toBeNull();
    expect(swipeTarget('stock', -120, 0)).toBeNull();
});

test('the swipe setting is saved on this phone', () => {
    BottomNav.setSwipe(true);
    expect(localStorage.getItem('aadhat.swipeTabs')).toBe('1');
    BottomNav.setSwipe(false);
    expect(BottomNav.swipeOn).toBe(false);
    expect(localStorage.getItem('aadhat.swipeTabs')).toBe('0');
});

test('only text fields count as typing (the bar stays for checkboxes, selects and buttons)', () => {
    const el = (html) => { document.body.innerHTML = html; return document.body.firstElementChild; };
    expect(opensKeyboard(el('<input type="text">'))).toBe(true);
    expect(opensKeyboard(el('<input>'))).toBe(true);
    expect(opensKeyboard(el('<input type="number">'))).toBe(true);
    expect(opensKeyboard(el('<textarea></textarea>'))).toBe(true);
    expect(opensKeyboard(el('<input type="checkbox">'))).toBe(false);
    expect(opensKeyboard(el('<input type="radio">'))).toBe(false);
    expect(opensKeyboard(el('<select><option>a</option></select>'))).toBe(false);
    expect(opensKeyboard(el('<button>b</button>'))).toBe(false);
});

test('pull-to-refresh runs only the page\'s own data reload; pages without one do nothing', async () => {
    const day = jest.fn();
    const done = jest.fn();
    BottomNav.refreshers = { day };
    BottomNav.onRefreshed = done;
    await expect(BottomNav.refreshPage('day')).resolves.toBe(true);
    expect(day).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
    await expect(BottomNav.refreshPage('billing')).resolves.toBe(false);
    expect(done).toHaveBeenCalledTimes(1);
});