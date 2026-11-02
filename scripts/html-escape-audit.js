#!/usr/bin/env node
/**
 * innerHTML audit (#89, docs/security.md). Lists each value that can reach HTML without being
 * plainly escaped, under www/js and www/r:
 * - each `${…}` in a template literal with markup, and each piece of a `+` chain that builds markup;
 * - each value given to a sink (innerHTML / outerHTML, also `['innerHTML']` and `+=`,
 *   insertAdjacentHTML, document.write, showModalWithHtml, showCustomModal, and calls in the same
 *   file to a function whose parameter reaches one, such as `this.html(id, …)`),
 *   followed through templates without tags, local variables (including `+=` and `.push`),
 *   `.map/.filter(…).join(…)` (block bodies too) and local functions to what they return;
 * - each `href="${…}"` that is not `safeUrl(…)` (escaping does not block `javascript:`).
 * Names are trusted only through the reviewed list in html-escape-allow.json, never by pattern.
 * A helper for review, not a proof.
 *   node scripts/html-escape-audit.js [--summary]   list
 *   node scripts/html-escape-audit.js --check       fail on lines not in tests/html-escape-baseline.txt
 *   node scripts/html-escape-audit.js --update-baseline   after checking every new line by hand
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['www/js', 'www/r'];
const SKIP = /[\\/](__tests__|i18n|vendor)[\\/]/;
const BASELINE = path.join(ROOT, 'tests', 'html-escape-baseline.txt');
const ALLOW = require('./html-escape-allow.json');

const MARKUP = /<\/?[a-z]/i;
const URL_ATTR = /\bhref\s*=\s*["']?\s*$/i;
const SAFE_URL = 'safeUrl';
const SINK_PROPS = new Set(['innerHTML', 'outerHTML']);
/** Sink call name -> [index of the markup argument, its property when it is an object] */
const SINK_CALLS = { insertAdjacentHTML: [1], showModalWithHtml: [0], showCustomModal: [0], printPage: [0, 'html'] };
const FN = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const ITEM_CALLBACKS = new Set(['map', 'flatMap', 'forEach', 'filter', 'some', 'every', 'find', 'reduce']);
const SAME_ITEMS = new Set(['filter', 'slice', 'sort', 'reverse', 'trim', 'trimStart', 'trimEnd', 'toUpperCase', 'toLowerCase']);
const GLOBAL = { type: 'Global' };

function patternIds(p) {
    if (!p) return [];
    switch (p.type) {
        case 'Identifier': return [p];
        case 'ObjectPattern': return p.properties.flatMap(x => patternIds(x.type === 'RestElement' ? x.argument : x.value));
        case 'ArrayPattern': return p.elements.flatMap(patternIds);
        case 'AssignmentPattern': return patternIds(p.left);
        case 'RestElement': return patternIds(p.argument);
        default: return [];
    }
}

/**
 * @param {string} src
 * @param {string} rel path shown in each line
 * @param {{names?: Record<string,string>, calls?: Record<string,string>}} [allow]
 * @returns {string[]} `rel:line: text (kind)`
 */
function auditSource(src, rel, allow = ALLOW) {
    const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true });
    const trustedNames = new Set(Object.keys(allow.names || {}));
    const trustedProps = new Set(Object.keys(allow.properties || {}));
    const trustedCalls = new Set(Object.keys(allow.calls || {}));
    const text = (n) => src.slice(n.start, n.end).replace(/\s+/g, ' ').slice(0, 140);
    const calleeName = (c) => (c.type === 'Identifier' ? c.name
        : c.type === 'MemberExpression' && !c.computed ? c.property.name : '');

    /** scope node -> name -> { opaque } (params, destructuring, imports, catch: value unknown here) */
    const decls = new Map();
    /** function -> parameter name (also inside a default / destructuring / rest) -> { i: position, rest } */
    const paramIndex = new Map();
    const declare = (scope, id, opaque) => {
        if (!decls.has(scope)) decls.set(scope, new Map());
        const m = decls.get(scope);
        m.set(id.name, { opaque: opaque || (m.get(id.name) || {}).opaque || false });
    };
    const scopeOf = (ancestors, skipSelf) => {
        for (let i = ancestors.length - (skipSelf ? 2 : 1); i >= 0; i--) {
            if (FN.has(ancestors[i].type) || ancestors[i].type === 'Program') return ancestors[i];
        }
        return ast;
    };
    walk.fullAncestor(ast, (n, ancestors) => {
        if (n.type === 'VariableDeclarator') {
            patternIds(n.id).forEach(id => declare(scopeOf(ancestors), id, n.id.type !== 'Identifier'));
        } else if (FN.has(n.type)) {
            if (n.type === 'FunctionDeclaration' && n.id) declare(scopeOf(ancestors, true), n.id, false);
            n.params.flatMap(patternIds).forEach(id => declare(n, id, true));
            paramIndex.set(n, new Map(n.params.flatMap((p, i) => patternIds(p).map(id => [id.name, { i, rest: p.type === 'RestElement' }]))));
        } else if (n.type === 'ClassDeclaration' && n.id) {
            declare(scopeOf(ancestors), n.id, true);
        } else if (n.type === 'CatchClause' && n.param) {
            patternIds(n.param).forEach(id => declare(scopeOf(ancestors), id, true));
        } else if (/^Import(Default|Namespace)?Specifier$/.test(n.type)) {
            declare(ast, n.local, true);
        }
    });
    const resolve = (name, ancestors) => {
        for (let i = ancestors.length - 1; i >= 0; i--) {
            const d = decls.get(ancestors[i]);
            if (d && d.has(name)) return ancestors[i];
        }
        return GLOBAL;
    };

    const refScope = new Map();
    /** scope -> name -> what a destructuring declaration took it from */
    const destructured = new Map();
    /** scope -> name -> assigned values (also `+=`, `||=`, `x[i] =`, `.push(…)` and function declarations) */
    const assigns = new Map();
    const assign = (scope, name, value) => {
        if (!assigns.has(scope)) assigns.set(scope, new Map());
        const m = assigns.get(scope);
        if (!m.has(name)) m.set(name, []);
        m.get(name).push(value);
    };
    /** Assigned in a way not followed here (destructuring, for…of into an existing name): value unknown. */
    const globalOpaque = new Set();
    const markOpaque = (scope, name) => {
        if (scope === GLOBAL) globalOpaque.add(name); else decls.get(scope).get(name).opaque = true;
    };
    /** method / property name -> [{ fn, owner }]; owner = the variable / class it was defined on, if known */
    const methods = new Map();
    const ownerOf = (ancestors) => {
        const p = ancestors[ancestors.length - 2];
        if (!p) return null;
        if (p.type === 'VariableDeclarator' && p.id.type === 'Identifier') return p.id.name;
        if (p.type === 'AssignmentExpression') return text(p.left);
        return null;
    };
    const addMethod = (key, fn, owner) => {
        if (!key || !/^(Private)?Identifier$/.test(key.type) || !FN.has(fn.type)) return;
        if (!methods.has(key.name)) methods.set(key.name, []);
        methods.get(key.name).push({ fn, owner });
    };
    const ASSIGN_VALUE = new Set(['=', '+=', '||=', '&&=', '??=']);
    walk.fullAncestor(ast, (n, ancestors) => {
        if (n.type === 'Identifier') refScope.set(n, resolve(n.name, ancestors));
        else if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init) {
            assign(resolve(n.id.name, ancestors), n.id.name, n.init);
        } else if (n.type === 'VariableDeclarator' && n.init) {
            patternIds(n.id).forEach(id => {
                const sc = resolve(id.name, ancestors);
                if (!destructured.has(sc)) destructured.set(sc, new Map());
                const m = destructured.get(sc);
                m.set(id.name, [...(m.get(id.name) || []), n.init]);
            });
        } else if (n.type === 'FunctionDeclaration' && n.id) {
            assign(resolve(n.id.name, ancestors.slice(0, -1)), n.id.name, n);
        } else if (n.type === 'AssignmentExpression') {
            const l = n.left;
            if (l.type === 'Identifier') {
                if (ASSIGN_VALUE.has(n.operator)) assign(resolve(l.name, ancestors), l.name, n.right);
            } else if (l.type === 'MemberExpression' && l.computed && l.object.type === 'Identifier') {
                assign(resolve(l.object.name, ancestors), l.object.name, n.right);
            } else if (l.type !== 'MemberExpression') {
                patternIds(l).forEach(id => markOpaque(resolve(id.name, ancestors), id.name));
            }
        } else if ((n.type === 'ForOfStatement' || n.type === 'ForInStatement') && n.left.type !== 'VariableDeclaration') {
            patternIds(n.left).forEach(id => markOpaque(resolve(id.name, ancestors), id.name));
        } else if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed
            && /^(push|unshift)$/.test(n.callee.property.name) && n.callee.object.type === 'Identifier') {
            n.arguments.forEach(a => assign(resolve(n.callee.object.name, ancestors), n.callee.object.name, a));
        } else if (n.type === 'MethodDefinition' && !n.computed) {
            const cls = ancestors[ancestors.length - 3];
            addMethod(n.key, n.value, cls && cls.id ? cls.id.name : cls ? ownerOf(ancestors.slice(0, -2)) : null);
        } else if (n.type === 'Property' && !n.computed) {
            addMethod(n.key, n.value, ownerOf(ancestors.slice(0, -1)));
        }
    });

    const markupTemplate = (n) => n.type === 'TemplateLiteral' && MARKUP.test(n.quasis.map(q => q.value.raw).join(''));
    const flatChain = (n, out = []) => {
        if (n.type === 'BinaryExpression' && n.operator === '+') { flatChain(n.left, out); flatChain(n.right, out); } else out.push(n);
        return out;
    };
    const markupChain = (parts) => parts.some(x => (x.type === 'Literal' && typeof x.value === 'string' && MARKUP.test(x.value)) || markupTemplate(x));

    const memo = new Map();
    /** The pieces of n that are not known to be safe in markup (markup templates / chains are listed where they are). */
    const leaves = (n) => {
        if (!n) return [];
        if (memo.has(n)) return memo.get(n);
        memo.set(n, []);
        const r = compute(n);
        memo.set(n, r);
        return r;
    };
    const returnNodes = (fn) => {
        if (fn.body.type !== 'BlockStatement') return [fn.body];
        const rets = [];
        walk.recursive(fn.body, null, {
            Function() { /* returns of nested functions are theirs */ },
            ReturnStatement(st) { if (st.argument) rets.push(st.argument); }
        });
        return rets;
    };
    const returnsMemo = new Map();
    const returnLeaves = (fn) => {
        if (returnsMemo.has(fn)) return returnsMemo.get(fn);
        returnsMemo.set(fn, []);
        const r = returnNodes(fn).flatMap(leaves);
        returnsMemo.set(fn, r);
        return r;
    };
    const functionsOf = (n) => {
        if (FN.has(n.type)) return [n];
        if (n.type === 'Identifier') {
            const vals = (assigns.get(refScope.get(n)) || new Map()).get(n.name) || [];
            const fns = vals.filter(v => FN.has(v.type));
            return fns.length ? fns : null;
        }
        if (n.type === 'MemberExpression' && !n.computed) {
            // this.m(): a method of this file's objects; X.m(): only one defined on X here
            const owner = n.object.type === 'ThisExpression' ? null : text(n.object);
            const fns = (methods.get(n.property.name) || []).filter(m => owner === null || m.owner === owner).map(m => m.fn);
            return fns.length ? fns : null;
        }
        return null;
    };
    const callLeaves = (n) => {
        const name = calleeName(n.callee);
        const member = n.callee.type === 'MemberExpression';
        // t() returns the key itself when it is missing, and doesn't escape its parameters
        if (name === 't' && !member) return n.arguments.length < 2 ? leaves(n.arguments[0]) : [n];
        if (trustedCalls.has(name)) return [];
        if (member && name === 'join') return leaves(n.callee.object);
        if (member && SAME_ITEMS.has(name)) return leaves(n.callee.object);
        if (member && name === 'concat') return [n.callee.object, ...n.arguments].flatMap(leaves);
        if (member && (name === 'map' || name === 'flatMap') && n.arguments[0]) {
            const fns = functionsOf(n.arguments[0]);
            return fns ? fns.flatMap(returnLeaves) : [n];
        }
        if (name === 'String' && !member) return n.arguments.flatMap(leaves);
        const fns = functionsOf(n.callee);
        return fns ? fns.flatMap(returnLeaves) : [n];
    };
    const compute = (n) => {
        switch (n.type) {
            case 'Literal': case 'UnaryExpression': case 'UpdateExpression': return [];
            case 'TemplateLiteral': return markupTemplate(n) ? [] : n.expressions.flatMap(leaves);
            case 'BinaryExpression': {
                if (n.operator !== '+') return [];
                const parts = flatChain(n);
                return markupChain(parts) ? [] : parts.flatMap(leaves);
            }
            case 'ConditionalExpression': return [...leaves(n.consequent), ...leaves(n.alternate)];
            case 'LogicalExpression': return [...leaves(n.left), ...leaves(n.right)];
            case 'SequenceExpression': return leaves(n.expressions[n.expressions.length - 1]);
            case 'AwaitExpression': case 'SpreadElement': return leaves(n.argument);
            case 'ChainExpression': return leaves(n.expression);
            case 'AssignmentExpression': return leaves(n.right);
            case 'ArrayExpression': return n.elements.flatMap(leaves);
            case 'ObjectExpression': return n.properties.flatMap(p => leaves(p.type === 'Property' ? p.value : p));
            case 'CallExpression': return callLeaves(n);
            case 'Identifier': {
                if (n.name === 'undefined' || trustedNames.has(n.name)) return [];
                const scope = refScope.get(n) || GLOBAL;
                const d = scope !== GLOBAL && decls.get(scope).get(n.name);
                const vals = ((assigns.get(scope) || new Map()).get(n.name) || []).filter(v => !FN.has(v.type));
                if ((d && d.opaque) || (scope === GLOBAL && globalOpaque.has(n.name)) || !vals.length) return [n];
                return vals.flatMap(leaves);
            }
            case 'MemberExpression': return !n.computed && trustedProps.has(n.property.name) ? [] : [n];
            default: return [n];
        }
    };

    /** one line per node and kind: the same text twice on a line counts twice */
    const hits = new Map();
    const hit = (n, kind, from = tracedTo(n, [n])) => hits.set(`${n.start}-${n.end}|${kind}`, `${rel}:${n.loc.start.line}: ${text(n)}${from}${kind ? ` (${kind})` : ''}`);
    /** ` ← a | b`: what a listed variable / call was traced to, so pointing it at other data is a new line */
    /** For x.y… / a destructured name: what the local variable at its root was given ('' if a parameter / unknown). */
    const rootNote = (l) => {
        let root = l;
        while (root.type === 'MemberExpression' || root.type === 'ChainExpression') root = root.type === 'ChainExpression' ? root.expression : root.object;
        if (root.type !== 'Identifier') return '';
        const scope = refScope.get(root) || GLOBAL;
        if (scope === GLOBAL) return '';
        const from = (destructured.get(scope) || new Map()).get(root.name);
        if (from) return `${root.name} from ${from.map(v => text(v).slice(0, 80)).join(' | ')}`;
        if (root === l || decls.get(scope).get(root.name).opaque) return '';
        const vals = ((assigns.get(scope) || new Map()).get(root.name) || []).filter(v => !FN.has(v.type));
        return vals.length ? `${root.name} = ${vals.map(v => text(v).slice(0, 80)).join(' | ')}` : '';
    };
    const tracedTo = (x, ls) => {
        const parts = ls.map(l => (l === x ? rootNote(l) : text(l).slice(0, 80) + (rootNote(l) ? ` {${rootNote(l)}}` : ''))).filter(Boolean);
        return parts.length ? ` ← ${parts.join(' | ')}`.slice(0, 300) : '';
    };
    const isSafeUrl = (x) => x.type === 'CallExpression' && calleeName(x.callee) === SAFE_URL;
    const tail = (x) => (x.type === 'Literal' && typeof x.value === 'string' ? x.value
        : x.type === 'TemplateLiteral' ? x.quasis[x.quasis.length - 1].value.raw : '');
    /**
     * [function, argument position, kind, property]: a parameter of a local function (or its
     * `.property`) reaches HTML (a sink, markup the function builds, an href), so each call to it in
     * this file, and each list handed to it through .map(fn) etc., is checked like the parameter.
     */
    const wrappers = [];
    const addWrapper = (l, kind) => {
        let root = l;
        let prop = null;
        while (root.type === 'MemberExpression' || root.type === 'ChainExpression') {
            if (root.type === 'ChainExpression') { root = root.expression; continue; }
            prop = root.computed ? null : root.property.name;
            root = root.object;
        }
        if (prop && kind === 'url') return;
        const fn = root.type === 'Identifier' && refScope.get(root);
        const p = fn && paramIndex.has(fn) ? paramIndex.get(fn).get(root.name) : undefined;
        if (p && !wrappers.some(([f, q, k, r]) => f === fn && q.i === p.i && k === kind && r === prop)) wrappers.push([fn, p, kind, prop]);
    };
    const propMemo = new Map();
    /** The unsafe pieces of `v.prop` (or of each item's `.prop` when v is a list). */
    const propLeaves = (v, prop) => {
        const key = v;
        if (!propMemo.has(key)) propMemo.set(key, new Map());
        const m = propMemo.get(key);
        if (m.has(prop)) return m.get(prop);
        m.set(prop, []);
        let r;
        switch (v.type) {
            case 'ObjectExpression': r = v.properties.flatMap(p => (p.type === 'SpreadElement' ? propLeaves(p.argument, prop)
                : !p.computed && (p.key.name || p.key.value) === prop ? leaves(p.value) : [])); break;
            case 'ArrayExpression': r = v.elements.flatMap(e => (e ? propLeaves(e.type === 'SpreadElement' ? e.argument : e, prop) : [])); break;
            case 'ConditionalExpression': r = [...propLeaves(v.consequent, prop), ...propLeaves(v.alternate, prop)]; break;
            case 'LogicalExpression': r = [...propLeaves(v.left, prop), ...propLeaves(v.right, prop)]; break;
            case 'AwaitExpression': r = propLeaves(v.argument, prop); break;
            case 'Identifier': {
                const scope = refScope.get(v) || GLOBAL;
                const d = scope !== GLOBAL && decls.get(scope).get(v.name);
                const vals = ((assigns.get(scope) || new Map()).get(v.name) || []).filter(x => !FN.has(x.type));
                r = (d && d.opaque) || (scope === GLOBAL && globalOpaque.has(v.name)) || !vals.length ? [v] : vals.flatMap(x => propLeaves(x, prop));
                break;
            }
            case 'CallExpression': {
                const name = calleeName(v.callee);
                const member = v.callee.type === 'MemberExpression';
                const fns = member && (name === 'map' || name === 'flatMap') && v.arguments[0] ? functionsOf(v.arguments[0]) : null;
                if (member && (SAME_ITEMS.has(name) || name === 'concat')) r = [v.callee.object, ...(name === 'concat' ? v.arguments : [])].flatMap(x => propLeaves(x, prop));
                else if (fns) r = fns.flatMap(fn => returnNodes(fn)).flatMap(x => propLeaves(x, prop));
                else r = [v];
                break;
            }
            default: r = [v];
        }
        m.set(prop, r);
        return r;
    };
    const unsafe = (v, kind) => {
        const ls = leaves(v);
        ls.forEach(l => addWrapper(l, kind));
        return ls;
    };
    const urlValue = (x, kind) => {
        if (isSafeUrl(x)) return;
        hit(x, kind);
        addWrapper(x, 'url');
    };
    const sinkValue = (v) => { if (v) unsafe(v, 'sink').forEach(l => hit(l, 'sink')); };
    const calls = [];
    const sinkProp = (m) => (!m.computed ? m.property.name
        : m.property.type === 'Literal' ? m.property.value
            : m.property.type === 'TemplateLiteral' && !m.property.expressions.length ? m.property.quasis[0].value.cooked : null);

    walk.fullAncestor(ast, (n, ancestors) => {
        const parent = ancestors[ancestors.length - 2];
        // A value right after href=" is a URL even in a piece without a tag (` href="${u}"`)
        if (n.type === 'TemplateLiteral') {
            const markup = markupTemplate(n);
            n.expressions.forEach((x, i) => {
                if (URL_ATTR.test(n.quasis[i].value.raw)) urlValue(x, 'url');
                else if (markup) { const ls = unsafe(x, 'markup'); if (ls.length) hit(x, '', tracedTo(x, ls)); }
            });
        }
        if (n.type === 'BinaryExpression' && n.operator === '+' && !(parent && parent.type === 'BinaryExpression' && parent.operator === '+')) {
            const parts = flatChain(n);
            const markup = markupChain(parts);
            parts.forEach((x, i) => {
                if (i > 0 && URL_ATTR.test(tail(parts[i - 1]))) urlValue(x, 'url (concatenated)');
                else if (markup) { const ls = unsafe(x, 'markup'); if (ls.length) hit(x, 'concatenated', tracedTo(x, ls)); }
            });
        }
        if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && SINK_PROPS.has(sinkProp(n.left))) sinkValue(n.right);
        if (n.type === 'CallExpression') {
            calls.push(n);
            const name = calleeName(n.callee);
            const obj = n.callee.type === 'MemberExpression' ? n.callee.object : null;
            if (Object.prototype.hasOwnProperty.call(SINK_CALLS, name)) {
                const [i, prop] = SINK_CALLS[name];
                const v = n.arguments[i];
                const p = prop && v && v.type === 'ObjectExpression'
                    && v.properties.find(q => q.type === 'Property' && !q.computed && (q.key.name || q.key.value) === prop);
                sinkValue(prop && v && v.type === 'ObjectExpression' ? p && p.value : v);
            }
            else if ((name === 'write' || name === 'writeln') && obj && /document$/.test(text(obj))) sinkValue(n.arguments[0]);
        }
    });
    for (let w = 0; w < wrappers.length; w++) {
        const [fn, { i, rest }, kind, prop] = wrappers[w];
        const check = (a, via) => {
            if (kind === 'url') { if (!isSafeUrl(a)) { hit(a, via); addWrapper(a, 'url'); } return; }
            const ls = prop ? propLeaves(a, prop) : unsafe(a, kind);
            if (prop) ls.forEach(l => addWrapper(l, kind));
            ls.forEach(l => hit(l, prop ? `${via} .${prop}` : via));
        };
        calls.forEach(c => {
            if ((functionsOf(c.callee) || []).includes(fn)) {
                (rest ? c.arguments.slice(i) : c.arguments.slice(i, i + 1)).forEach(a => check(a, `${kind} via ${text(c.callee)}`));
            }
            // list.map(fn): each item of list is fn's first argument
            const name = calleeName(c.callee);
            if (i === 0 && c.callee.type === 'MemberExpression' && ITEM_CALLBACKS.has(name) && c.arguments[0]
                && (functionsOf(c.arguments[0]) || []).includes(fn)) check(c.callee.object, `${kind} via ${name}(${text(c.arguments[0])})`);
        });
    }
    return [...hits.values()];
}

function files(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const p = path.join(dir, e.name);
        if (SKIP.test(p + path.sep)) return [];
        if (e.isDirectory()) return files(p);
        return p.endsWith('.js') ? [p] : [];
    });
}

function auditRepo(root = ROOT) {
    return DIRS.flatMap(d => files(path.join(root, d))).flatMap(f =>
        auditSource(fs.readFileSync(f, 'utf8'), path.relative(root, f).replace(/\\/g, '/')));
}

/** `file:12: text` -> `file: text`, so moving code doesn't count as new. */
const withoutLine = (h) => h.replace(/^([^:]+):\d+:/, '$1:');

/** Lines in `current` beyond their count in the baseline, and baseline lines no longer found. */
function compare(current, baseline) {
    const left = new Map();
    baseline.forEach(b => left.set(b, (left.get(b) || 0) + 1));
    const added = [];
    current.forEach(h => {
        const k = withoutLine(h);
        if (left.get(k)) left.set(k, left.get(k) - 1); else added.push(h);
    });
    const gone = [...left].flatMap(([k, c]) => Array(c).fill(k));
    return { added, gone };
}

const readBaseline = () => (fs.existsSync(BASELINE) ? fs.readFileSync(BASELINE, 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#')) : []);

function main(argv) {
    const all = auditRepo();
    if (argv.includes('--update-baseline')) {
        const header = '# innerHTML audit baseline (#89): the lines scripts/html-escape-audit.js lists today, each checked by hand.\n'
            + '# CI fails on a line not here. Fix it (escape / safeUrl) or, once checked, run: npm run check:html-escape -- --update-baseline\n';
        fs.writeFileSync(BASELINE, (header + all.map(withoutLine).sort().join('\n') + '\n').replace(/\n/g, require('os').EOL));
        console.log(`${all.length} line(s) written to ${path.relative(ROOT, BASELINE)}`);
        return 0;
    }
    if (argv.includes('--check')) {
        const { added, gone } = compare(all, readBaseline());
        if (gone.length) console.log(`${gone.length} baseline line(s) no longer found; lower the baseline with --update-baseline.`);
        if (!added.length) { console.log(`innerHTML audit: no new lines (${all.length} known).`); return 0; }
        console.error(`innerHTML audit: ${added.length} new value(s) reach HTML without plain escaping:\n${added.join('\n')}`);
        console.error('Escape them (Helpers.escapeHtml, href via Helpers.safeUrl) or, if checked safe by hand, run --update-baseline (docs/security.md).');
        return 1;
    }
    if (argv.includes('--summary')) {
        const by = {};
        all.forEach(h => { const f = h.split(':')[0]; by[f] = (by[f] || 0) + 1; });
        Object.entries(by).sort((a, b) => b[1] - a[1]).forEach(([f, c]) => console.log(`${String(c).padStart(4)} ${f}`));
    } else {
        console.log(all.join('\n'));
    }
    console.error(`${all.length} value(s) to check by hand`);
    return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { auditSource, auditRepo, compare, withoutLine };
