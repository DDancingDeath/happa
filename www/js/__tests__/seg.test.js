/**
 * @fileoverview Tab keyboard (UX C3, ui/seg.js): roving tabindex and arrow keys on every
 * role=tablist, activating a tab through its own click handler (data-onclick included).
 */
import { installTablistKeys, syncTablist, targetTab, tabsOf } from '../ui/seg.js';
import { installActions } from '../ui/actions.js';

const flush = () => new Promise(r => setTimeout(r, 0));
const key = (el, k, opts = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));

function tablist(selected = 0, extra = '') {
    return `<div role="tablist" id="list">
        ${['a', 'b', 'c'].map((n, i) => `<button type="button" role="tab" id="t-${n}" aria-selected="${i === selected}" data-onclick="demo.show('${n}')"${n === 'c' ? extra : ''}>${n}</button>`).join('')}
    </div>`;
}

const show = jest.fn(name => {
    document.querySelectorAll('#list [role="tab"]').forEach(t => t.setAttribute('aria-selected', String(t.id === `t-${name}`)));
});

beforeAll(() => {
    window.app = { demo: { show } };
    installActions();
    installTablistKeys();
});

beforeEach(() => {
    show.mockClear();
    document.body.innerHTML = '';
});

const tab = n => document.getElementById(`t-${n}`);
const tabIndexes = () => ['a', 'b', 'c'].map(n => tab(n).tabIndex);

describe('targetTab', () => {
    const tabs = ['a', 'b', 'c'];
    test('Left / Right wrap; Home / End go to the ends; other keys move nowhere', () => {
        expect(targetTab(tabs, 'c', 'ArrowRight')).toBe('a');
        expect(targetTab(tabs, 'a', 'ArrowLeft')).toBe('c');
        expect(targetTab(tabs, 'a', 'ArrowRight')).toBe('b');
        expect(targetTab(tabs, 'b', 'Home')).toBe('a');
        expect(targetTab(tabs, 'a', 'End')).toBe('c');
        expect(targetTab(tabs, 'a', 'Enter')).toBeNull();
        expect(targetTab(tabs, 'a', 'ArrowDown')).toBeNull();
        expect(targetTab(tabs, 'a', 'ArrowDown', true)).toBe('b');
    });
});

describe('roving tabindex', () => {
    test('only the selected tab is in the Tab order, and it follows aria-selected', async () => {
        document.body.innerHTML = tablist(1);
        await flush();
        expect(tabIndexes()).toEqual([-1, 0, -1]);
        tab('c').setAttribute('aria-selected', 'true');
        tab('b').setAttribute('aria-selected', 'false');
        await flush();
        expect(tabIndexes()).toEqual([-1, -1, 0]);
    });

    test('with none selected the first visible tab is reachable; hidden tabs are skipped', () => {
        document.body.innerHTML = tablist(-1);
        tab('a').hidden = true;
        syncTablist(document.getElementById('list'));
        expect(tabIndexes()).toEqual([-1, 0, -1]);
        expect(tabsOf(document.getElementById('list')).map(t => t.id)).toEqual(['t-b', 't-c']);
    });
});

describe('arrow keys', () => {
    test('Right activates the next tab through its data-onclick and moves focus to it', async () => {
        document.body.innerHTML = tablist(0);
        tab('a').focus();
        key(tab('a'), 'ArrowRight');
        expect(show).toHaveBeenCalledWith('b');
        expect(document.activeElement).toBe(tab('b'));
        await flush();
        expect(tabIndexes()).toEqual([-1, 0, -1]);
    });

    test('Left wraps, End and Home reach the ends, disabled tabs are skipped', () => {
        document.body.innerHTML = tablist(0, ' disabled');
        key(tab('a'), 'ArrowLeft');
        expect(show).toHaveBeenLastCalledWith('b');
        key(tab('b'), 'Home');
        expect(show).toHaveBeenLastCalledWith('a');
        key(tab('a'), 'End');
        expect(show).toHaveBeenLastCalledWith('b');
    });

    test('a listener added with addEventListener runs too; the key is consumed', () => {
        document.body.innerHTML = tablist(0);
        const clicked = jest.fn();
        tab('b').addEventListener('click', clicked);
        const ev = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
        tab('a').dispatchEvent(ev);
        expect(clicked).toHaveBeenCalledTimes(1);
        expect(ev.defaultPrevented).toBe(true);
    });

    test('modifier keys, other keys and elements outside a tablist are left alone', () => {
        document.body.innerHTML = `${tablist(0)}<div class="seg"><button type="button" id="seg" data-onclick="demo.show('x')">x</button></div>`;
        key(tab('a'), 'ArrowRight', { altKey: true });
        key(tab('a'), 'ArrowRight', { shiftKey: true });
        key(tab('a'), 'Enter');
        key(document.getElementById('seg'), 'ArrowRight');
        expect(show).not.toHaveBeenCalled();
    });

    test('a handler that redraws the tablist keeps focus on the newly selected tab', () => {
        document.body.innerHTML = '<div id="host"></div>';
        const host = document.getElementById('host');
        const draw = (sel) => { host.innerHTML = tablist(['a', 'b', 'c'].indexOf(sel)); };
        window.app.demo.show = jest.fn(draw);
        draw('a');
        key(tab('a'), 'ArrowRight');
        expect(window.app.demo.show).toHaveBeenCalledWith('b');
        expect(document.activeElement).toBe(tab('b'));
        expect(tab('b').tabIndex).toBe(0);
        window.app.demo.show = show;
    });
});
