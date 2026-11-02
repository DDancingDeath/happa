#!/usr/bin/env node
/**
 * Lists the values that reach HTML without being plainly escaped, for the innerHTML audit (#89,
 * docs/security.md): each `${…}` in an HTML-looking template literal, each piece of a `+` chain
 * that builds markup, and each innerHTML / outerHTML / insertAdjacentHTML / document.write /
 * showModalWithHtml / showCustomModal given something other than a literal, under www/js and
 * www/r. A helper for review, not a proof: most hits are numbers, colours, other escaped
 * fragments or catalogue text, and a value can still be unsafe in a way the rules below accept;
 * check each new line by hand.
 *   node scripts/html-escape-audit.js [--summary]
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['www/js', 'www/r'].map(d => path.join(ROOT, d));
const SKIP = /[\\/](__tests__|i18n|vendor)[\\/]/;

/** Calls that return escaped text, numbers, or HTML built from escaped parts. */
const SAFE_CALLS = new Set(['esc', 'e', 'escapeHtml', 'escapeJsAttr', 'escapeAttr', 'L', 'tt', 'tx', 'et', 'loc', 'js', 'attr',
    'encodeURIComponent', 'formatCurrency', 'formatINR', 'formatRupees', 'formatKg', 'formatRate', 'fmt', 'money', 'rupees',
    'toFixed', 'toLocaleString', 'Number', 'round', 'floor', 'ceil', 'abs', 'min', 'max']);
/** Whole names that by convention hold a number, a colour / class / style, or already-escaped HTML. */
const SAFE_NAME = /^(?:[a-z]\w*)?(?:Html|HTML|Rows|Class|Style|Color|Icon|Count|Total|Amount|Qty|Pct|Width|Height)$|^(?:html|rows|cls|style|color|icon|count|total|amount|qty|pct|width|height|index|idx|i|n|h|k)$/;
const SINK_CALLS = new Set(['insertAdjacentHTML', 'showModalWithHtml', 'showCustomModal']);
const MARKUP = /<\/?[a-z]/i;

function files(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const p = path.join(dir, e.name);
        if (SKIP.test(p + path.sep)) return [];
        if (e.isDirectory()) return files(p);
        return p.endsWith('.js') ? [p] : [];
    });
}

function audit(file) {
    const src = fs.readFileSync(file, 'utf8');
    const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
    const text = (n) => src.slice(n.start, n.end).replace(/\s+/g, ' ').slice(0, 140);
    const callee = (c) => (c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' && !c.computed ? c.property.name : '');
    const safe = (n) => {
        switch (n.type) {
            case 'Literal': case 'UnaryExpression': return true;
            case 'TemplateLiteral': return n.expressions.every(safe);
            case 'ConditionalExpression': return safe(n.consequent) && safe(n.alternate);
            case 'LogicalExpression': return safe(n.left) && safe(n.right);
            case 'BinaryExpression': return n.operator !== '+' || (safe(n.left) && safe(n.right));
            case 'CallExpression': {
                const name = callee(n.callee);
                if (name === 't') return n.arguments.length < 2;
                // x.map(…).join(…) is as safe as what is mapped (template literals inside are listed on their own)
                if (name === 'join' && n.callee.type === 'MemberExpression') return safe(n.callee.object);
                if ((name === 'map' || name === 'filter') && n.arguments[0] && /Function/.test(n.arguments[0].type)) {
                    const body = n.arguments[0].body;
                    return body.type === 'BlockStatement' || safe(body);
                }
                return SAFE_CALLS.has(name) || /^(?:[a-z]\w*)?(?:Html|HTML)$|^render[A-Z]?/.test(name);
            }
            case 'Identifier': return SAFE_NAME.test(n.name);
            case 'MemberExpression': return !n.computed && SAFE_NAME.test(n.property.name);
            default: return false;
        }
    };
    const hits = [];
    const at = (n) => `${path.relative(ROOT, file).replace(/\\/g, '/')}:${n.loc.start.line}`;
    const isLiteral = (v) => v.type === 'Literal' || v.type === 'TemplateLiteral';
    walk.fullAncestor(ast, (n, ancestors) => {
        const parent = ancestors[ancestors.length - 2];
        if (n.type === 'TemplateLiteral' && MARKUP.test(n.quasis.map(q => q.value.raw).join(''))) {
            n.expressions.filter(x => !safe(x)).forEach(x => hits.push(`${at(x)}: ${text(x)}`));
        }
        if (n.type === 'BinaryExpression' && n.operator === '+' && !(parent && parent.type === 'BinaryExpression' && parent.operator === '+')) {
            // One + chain at a time: if any piece is markup, list every unsafe piece
            const parts = [];
            const flat = (x) => {
                if (x.type === 'BinaryExpression' && x.operator === '+') { flat(x.left); flat(x.right); } else parts.push(x);
            };
            flat(n);
            const markup = parts.some(x => (x.type === 'Literal' && typeof x.value === 'string' && MARKUP.test(x.value))
                || (x.type === 'TemplateLiteral' && MARKUP.test(x.quasis.map(q => q.value.raw).join(''))));
            if (markup) parts.filter(x => x.type !== 'TemplateLiteral' && !safe(x)).forEach(x => hits.push(`${at(x)}: ${text(x)} (concatenated)`));
        }
        if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && !n.left.computed
            && /^(innerHTML|outerHTML)$/.test(n.left.property.name) && !isLiteral(n.right) && !safe(n.right)) {
            hits.push(`${at(n.right)}: ${text(n.right)} (sink)`);
        }
        const docWrite = n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && callee(n.callee) === 'write'
            && /document$/.test(text(n.callee.object));
        if (n.type === 'CallExpression' && (SINK_CALLS.has(callee(n.callee)) || docWrite)) {
            const v = n.arguments[callee(n.callee) === 'insertAdjacentHTML' ? 1 : 0];
            if (v && !isLiteral(v) && !safe(v)) hits.push(`${at(v)}: ${text(v)} (sink)`);
        }
    });
    return hits;
}

const all = DIRS.flatMap(files).flatMap(audit);
if (process.argv.includes('--summary')) {
    const by = {};
    all.forEach(h => { const f = h.split(':')[0]; by[f] = (by[f] || 0) + 1; });
    Object.entries(by).sort((a, b) => b[1] - a[1]).forEach(([f, n]) => console.log(`${String(n).padStart(4)} ${f}`));
} else {
    console.log(all.join('\n'));
}
console.error(`${all.length} value(s) to check by hand`);
