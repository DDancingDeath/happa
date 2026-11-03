/**
 * @fileoverview Delegated event handlers instead of inline `on*=` attributes (#89), so the
 * Content-Security-Policy can drop 'unsafe-inline' for scripts. Markup says what to call with a
 * `data-on<event>` attribute holding the same call the inline handler made, without
 * `window.app.`:
 *
 *     <button data-onclick="nav.showTab('billing', event)">
 *     <input data-onchange="i18n.setLang(this.value)">
 *     <a href="#" data-onclick="auth.showTab('login'); return false">
 *     <input data-onenter="event.preventDefault(); billing.addWeight(true)">
 *
 * One listener per event type on the document finds the elements carrying the attribute (the
 * target and its ancestors, nearest first, as the browser runs inline handlers while the event
 * bubbles) and calls the named `window.app` method on its object. Nothing is evaluated: the
 * attribute is parsed by a small grammar and anything else is refused, so it works under a CSP
 * without 'unsafe-eval'; the path is followed through own properties only (never `__proto__`,
 * `constructor`, `prototype`), so markup can only reach `window.app` methods. An error goes to
 * `window`'s error handler, as an inline handler's would.
 *
 * Grammar (statements separated by `;`):
 *   call      path '(' [arg {',' arg}] ')'          path: name {'.' name} under window.app
 *   arg       'text' | "text" (JS escapes) | number | true | false | null | undefined
 *             | event | this | this.value | this.checked | this.open | this.dataset.<name>
 *   also      `return false` (preventDefault; ends the handler), `event.stopPropagation()`,
 *             `event.preventDefault()`
 * @module ui/actions
 */

/** Events handled; focus / blur don't bubble, so their `focusin` / `focusout` are used; `toggle`
 * (a <details> opening or closing) doesn't bubble either: only the element itself, caught on the
 * way down. `enter` is a keydown of the Enter key (was an inline onkeypress testing
 * `event.key === 'Enter'`). */
export const ACTION_EVENTS = Object.freeze({
    click: 'click', change: 'change', input: 'input', submit: 'submit',
    keydown: 'keydown', keyup: 'keyup', focus: 'focusin', blur: 'focusout', toggle: 'toggle',
    enter: 'keydown'
});

const NAME = /[A-Za-z_$][\w$]*/y;
const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const SPACE = /\s*/y;
const SIMPLE_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', v: '\v', f: '\f', 0: '\0', '\\': '\\', '\'': '\'', '"': '"', '`': '`' };
/** Never a path segment: they lead off window.app to Object / Function. */
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Parses an attribute value into statements, or throws a SyntaxError.
 * @param {string} src
 * @returns {Array<{kind: 'call', path: string[], args: Array}|{kind: 'returnFalse'}|{kind: 'stop'}|{kind: 'prevent'}>}
 */
export function parseAction(src) {
    let i = 0;
    const skip = () => { SPACE.lastIndex = i; if (SPACE.exec(src)) i = SPACE.lastIndex; };
    const fail = (what) => { throw new SyntaxError(`data-on*: ${what} at ${i} in "${src}"`); };
    const name = () => {
        NAME.lastIndex = i;
        const m = NAME.exec(src);
        if (!m) fail('name expected');
        i = NAME.lastIndex;
        return m[0];
    };
    const hex = (from, to) => {
        const h = src.slice(from, to);
        if (!/^[0-9a-fA-F]+$/.test(h)) fail('bad escape');
        return parseInt(h, 16);
    };
    const string = () => {
        const q = src[i++];
        let out = '';
        while (i < src.length && src[i] !== q) {
            let c = src[i++];
            if (c === '\\') {
                c = src[i++];
                if (Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, c)) c = SIMPLE_ESCAPES[c];
                else if (c === 'x') { c = String.fromCharCode(hex(i, i + 2)); i += 2; }
                else if (c === 'u') {
                    if (src[i] === '{') {
                        const end = src.indexOf('}', i);
                        if (end < 0) fail('bad escape');
                        const cp = hex(i + 1, end);
                        if (cp > 0x10FFFF) fail('bad escape');
                        c = String.fromCodePoint(cp);
                        i = end + 1;
                    } else {
                        c = String.fromCharCode(hex(i, i + 4));
                        i += 4;
                    }
                } else if (c === '\n') c = '';
                else fail('bad escape');
            }
            out += c;
        }
        if (src[i] !== q) fail('unterminated string');
        i++;
        return out;
    };
    const arg = () => {
        skip();
        const c = src[i];
        if (c === '\'' || c === '"') return { lit: string() };
        NUMBER.lastIndex = i;
        const num = NUMBER.exec(src);
        if (num) { i = NUMBER.lastIndex; return { lit: Number(num[0]) }; }
        const word = name();
        if (word === 'true' || word === 'false') return { lit: word === 'true' };
        if (word === 'null') return { lit: null };
        if (word === 'undefined') return { lit: undefined };
        if (word === 'event') return { ref: 'event' };
        if (word !== 'this') fail(`unknown value ${word}`);
        if (src[i] !== '.') return { ref: 'this' };
        i++;
        const prop = name();
        if (prop === 'value' || prop === 'checked' || prop === 'open') return { ref: prop };
        if (prop !== 'dataset' || src[i] !== '.') fail(`this.${prop} not allowed`);
        i++;
        return { ref: 'dataset', key: name() };
    };
    const endOfStatement = () => {
        skip();
        if (i >= src.length) return;
        if (src[i] !== ';') fail('";" expected');
        i++;
    };
    const statements = [];
    for (;;) {
        skip();
        if (i >= src.length) break;
        if (src[i] === ';') { i++; continue; }
        const start = i;
        const first = name();
        if (first === 'return') {
            skip();
            if (name() !== 'false') fail('only "return false"');
            statements.push({ kind: 'returnFalse' });
            skip();
            while (src[i] === ';') { i++; skip(); }
            if (i < src.length) fail('nothing may follow "return false"');
            break;
        }
        i = start;
        const path = [name()];
        while (src[i] === '.') { i++; path.push(name()); }
        if (path[0] === 'window' && path[1] === 'app') path.splice(0, 2);
        skip();
        if (src[i] !== '(') fail('"(" expected');
        i++;
        const args = [];
        skip();
        if (src[i] === ')') i++;
        else {
            for (;;) {
                args.push(arg());
                skip();
                if (src[i] === ',') { i++; continue; }
                if (src[i] === ')') { i++; break; }
                fail('"," or ")" expected');
            }
        }
        if (path.length === 2 && path[0] === 'event' && !args.length
            && (path[1] === 'stopPropagation' || path[1] === 'preventDefault')) {
            statements.push({ kind: path[1] === 'stopPropagation' ? 'stop' : 'prevent' });
            endOfStatement();
            continue;
        }
        if (!path.length || path[0] === 'event' || path[0] === 'this' || path.some(p => FORBIDDEN.has(p))) {
            fail('only window.app calls');
        }
        statements.push({ kind: 'call', path, args });
        endOfStatement();
    }
    if (!statements.length) fail('empty');
    return statements;
}

const parsed = new Map();
function statementsOf(src) {
    let s = parsed.get(src);
    if (!s) {
        s = parseAction(src);
        if (parsed.size > 2000) parsed.clear();
        parsed.set(src, s);
    }
    return s;
}

/** An own property of an object or function, else undefined (nothing inherited). */
const own = (obj, key) => (obj !== null && (typeof obj === 'object' || typeof obj === 'function')
    && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined);

function argValue(a, el, event) {
    if ('lit' in a) return a.lit;
    if (a.ref === 'event') return event;
    if (a.ref === 'this') return el;
    if (a.ref === 'value') return el.value;
    if (a.ref === 'checked') return el.checked;
    if (a.ref === 'open') return el.open;
    return el.dataset ? el.dataset[a.key] : undefined;
}

/**
 * Runs one element's attribute for an event, like its inline handler would.
 * @returns {*} what the last call returned
 */
export function runAction(el, src, event, root = window.app) {
    let result;
    for (const st of statementsOf(src)) {
        if (st.kind === 'returnFalse' || st.kind === 'prevent') { event.preventDefault(); continue; }
        if (st.kind === 'stop') { event.stopPropagation(); continue; }
        let owner = root;
        for (let k = 0; k < st.path.length - 1; k++) owner = own(owner, st.path[k]);
        const fn = own(owner, st.path[st.path.length - 1]);
        if (typeof fn !== 'function') throw new TypeError(`data-on*: window.app.${st.path.join('.')} is not a function`);
        result = fn.apply(owner, st.args.map(a => argValue(a, el, event)));
    }
    return result;
}

/** Hands an error to window's error handler (toast + telemetry), as an inline handler's would. */
function reportHandlerError(e) {
    if (typeof reportError === 'function') reportError(e);
    else setTimeout(() => { throw e; });
}

/** Attaches the document listeners once. */
export function installActions(doc = document) {
    if (doc.__aadhatActions) return;
    doc.__aadhatActions = true;
    // A non-native control with role="button" and a data-onclick also answers Enter and Space,
    // as a button does (keyboard users; was an inline onkeydown on each).
    doc.addEventListener('keydown', (event) => {
        const el = event.target;
        if ((event.key !== 'Enter' && event.key !== ' ') || !(el instanceof Element)) return;
        if (el.getAttribute('role') !== 'button' || /^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
        const src = el.getAttribute('data-onclick');
        if (src === null || !src.trim() || el.hasAttribute('data-onkeydown')) return;
        event.preventDefault();
        try {
            runAction(el, src, event);
        } catch (e) {
            reportHandlerError(e);
        }
    });
    Object.entries(ACTION_EVENTS).forEach(([type, domType]) => {
        const attr = `data-on${type}`;
        // focus/blur/toggle don't bubble: only the element itself, as with its inline handler
        const bubbles = type !== 'focus' && type !== 'blur' && type !== 'toggle';
        doc.addEventListener(domType, (event) => {
            if (type === 'enter' && (event.key !== 'Enter' || event.isComposing)) return;
            let el = event.target instanceof Element ? event.target : event.target?.parentElement;
            while (el && el !== doc) {
                const src = el.getAttribute?.(attr);
                if (src !== null && src !== undefined && src.trim()) {
                    try {
                        runAction(el, src, event);
                    } catch (e) {
                        reportHandlerError(e);
                    }
                    if (event.cancelBubble) break;
                }
                if (!bubbles) break;
                el = el.parentElement;
            }
        }, type === 'toggle');
    });
}
