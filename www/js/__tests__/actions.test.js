/**
 * @fileoverview Delegated handlers (#89, ui/actions.js): the data-on* grammar and how the
 * document listeners run it, like the inline handlers they replace.
 */
import { parseAction, runAction, installActions } from '../ui/actions.js';
import { Helpers } from '../utils/helpers.js';

describe('parseAction', () => {
    test('a window.app call with literal, event and element arguments', () => {
        expect(parseAction(`nav.showTab('billing', event)`)).toEqual([
            { kind: 'call', path: ['nav', 'showTab'], args: [{ lit: 'billing' }, { ref: 'event' }] }
        ]);
        expect(parseAction(`window.app.items.updateRate('i1', 2, this.value)`)[0]).toEqual(
            { kind: 'call', path: ['items', 'updateRate'], args: [{ lit: 'i1' }, { lit: 2 }, { ref: 'value' }] });
        expect(parseAction('x.y(-1.5, true, false, null, this.checked, this, this.dataset.id)')[0].args).toEqual([
            { lit: -1.5 }, { lit: true }, { lit: false }, { lit: null }, { ref: 'checked' }, { ref: 'this' }, { ref: 'dataset', key: 'id' }
        ]);
    });

    test('statements: return false, event.stopPropagation(), several calls', () => {
        expect(parseAction(`event.stopPropagation(); auth.showTab('login'); return false;`).map(s => s.kind))
            .toEqual(['stop', 'call', 'returnFalse']);
        expect(parseAction('returns.open()')[0].path).toEqual(['returns', 'open']);
    });

    test('strings keep what Helpers.escapeJsAttr escaped (after the browser decodes the attribute)', () => {
        const tricky = `x');alert(1);//"<b>\\ \u0101`;
        const js = tricky.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n');
        expect(parseAction(`a.b('${js}')`)[0].args[0].lit).toBe(tricky);
        expect(parseAction(`a.b('\\x41\\u0042\\u{1F600}\\b\\v\\f')`)[0].args[0].lit).toBe('AB\u{1F600}\b\v\f');
    });

    test('anything else is refused: no code runs from markup', () => {
        ['alert(1)()', 'a.b(c)', 'a.b(this.style)', 'a.b(1+1)', 'this.style.color="red"', 'event.target.remove()',
            'a.b(', "a.b('x)", 'return true', '', 'a.b(window)', 'a["b"](1)',
            "constructor.constructor('alert(1)')", 'nav.__proto__.x()', 'a.prototype.b()', "a.b('x') c.d('y')",
            'return false; nav.x()', "a.b('\\q')", "a.b('\\xZZ')", "a.b('\\u12')", 'returnfalse', 'return; a.b()', "a.b('\\u{110000}')"].forEach(src => {
            expect(() => parseAction(src)).toThrow(SyntaxError);
        });
    });
});

describe('document listeners', () => {
    let calls;
    beforeAll(() => installActions(document));
    beforeEach(() => {
        calls = [];
        window.app = {
            page: {
                go(...args) { calls.push(['go', this === window.app.page, ...args]); },
                outer() { calls.push(['outer']); },
                set(v) { calls.push(['set', v]); }
            }
        };
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
        delete window.app;
        document.body.innerHTML = '';
        jest.restoreAllMocks();
    });

    test('a click runs the nearest handler with its object as this, then the ones above (bubbling)', () => {
        document.body.innerHTML = `<div data-onclick="page.outer()"><button data-onclick="page.go('a', 1, this, event)"><span>x</span></button></div>`;
        const button = document.querySelector('button');
        document.querySelector('span').click();
        expect(calls[0].slice(0, 4)).toEqual(['go', true, 'a', 1]);
        expect(calls[0][4]).toBe(button);
        expect(calls[0][5].type).toBe('click');
        expect(calls[1]).toEqual(['outer']);
    });

    test('event.stopPropagation() stops the handlers above; return false prevents the default', () => {
        document.body.innerHTML = `<div data-onclick="page.outer()"><a href="#x" data-onclick="event.stopPropagation(); page.go(); return false">a</a></div>`;
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
        document.querySelector('a').dispatchEvent(ev);
        expect(calls.map(c => c[0])).toEqual(['go']);
        expect(ev.defaultPrevented).toBe(true);
    });

    test('change and input pass the control value; focus does not bubble', () => {
        document.body.innerHTML = `<div data-onfocus="page.outer()"><input id="i" data-onchange="page.set(this.value)" data-onfocus="page.set('f')"></div>`;
        const input = document.getElementById('i');
        input.value = 'abc';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        expect(calls).toEqual([['set', 'abc'], ['set', 'f']]);
    });

    test('a missing or inherited method or a bad attribute runs nothing and goes to the window error handler', () => {
        window.reportError = jest.fn();
        document.body.innerHTML = `<button data-onclick="page.nope()"></button><i data-onclick="alert(1)"></i><b data-onclick="page.toString()"></b>`;
        document.querySelector('button').click();
        document.querySelector('i').click();
        document.querySelector('b').click();
        expect(calls).toEqual([]);
        expect(window.reportError).toHaveBeenCalledTimes(3);
        delete window.reportError;
    });

    test('only own properties of window.app are reachable, nothing inherited', () => {
        const el = document.createElement('b');
        const proto = { hidden() { return 'no'; } };
        const root = { m: Object.assign(Object.create(proto), { v: () => 'yes' }) };
        expect(runAction(el, 'm.v()', new Event('x'), root)).toBe('yes');
        expect(() => runAction(el, 'm.hidden()', new Event('x'), root)).toThrow(TypeError);
        expect(() => runAction(el, 'm.hasOwnProperty(1)', new Event('x'), root)).toThrow(TypeError);
    });

    test('a value escaped with Helpers.escapeJsAttr in rendered markup arrives unchanged', () => {
        const tricky = `x');window.__pwned=1;//"<img src=x> \\ ${'\n'}ā &amp;`;
        document.body.innerHTML = `<button data-onclick="page.set('${Helpers.escapeJsAttr(tricky)}')"></button>`;
        document.querySelector('button').click();
        expect(calls).toEqual([['set', tricky]]);
        expect(window.__pwned).toBeUndefined();
    });

    test('Enter or Space on a role=button element runs its data-onclick, not on native buttons', () => {
        document.body.innerHTML = `<div role="button" tabindex="0" data-onclick="page.go('k')"></div><button data-onclick="page.go('b')"></button>`;
        const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        document.querySelector('div').dispatchEvent(ev);
        document.querySelector('div').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        document.querySelector('div').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
        document.querySelector('button').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(calls.map(c => c[2])).toEqual(['k', 'k']);
        expect(ev.defaultPrevented).toBe(true);
    });

    test('a <details> toggle passes this.open (toggle does not bubble)', () => {
        document.body.innerHTML = `<div data-ontoggle="page.outer()"><details data-ontoggle="page.set(this.open)"><summary>s</summary></details></div>`;
        const d = document.querySelector('details');
        d.open = true;
        d.dispatchEvent(new Event('toggle'));
        expect(calls).toEqual([['set', true]]);
    });

    test('runAction returns what the call returned', () => {
        const el = document.createElement('b');
        expect(runAction(el, 'm.v(2)', new Event('x'), { m: { v: (n) => n * 2 } })).toBe(4);
    });
});
