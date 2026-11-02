#!/usr/bin/env node
/**
 * Lists the `${…}` interpolations in HTML-looking template literals (and `'<tag…' + x`
 * concatenations) under www/js and www/r that are not plainly escaped, for the innerHTML audit
 * (#89, docs/security.md). A report for review, not a gate: most hits are numbers, colours, other
 * escaped fragments or catalogue text; check each new one by hand.
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
    'toFixed', 'toLocaleString', 'Number', 'round', 'floor', 'ceil', 'abs', 'min', 'max', 'join', 'map', 'filter']);
/** Names that by convention hold a number, a colour / class / style, or already-escaped HTML. */
const SAFE_NAME = /(html|Html|HTML|rows|Rows|cls|Class|class|style|Style|color|Color|icon|Icon|count|Count|total|Total|amount|Amount|qty|Qty|width|height|pct|Pct|index|idx|^i$|^n$|^h$|^k$)/;

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
                return SAFE_CALLS.has(name) || /Html$|html$|HTML$|Row$|Rows$|Chip$|Badge$|^render|Icon$/.test(name);
            }
            case 'Identifier': return SAFE_NAME.test(n.name);
            case 'MemberExpression': return !n.computed && SAFE_NAME.test(n.property.name);
            default: return false;
        }
    };
    const hits = [];
    const at = (n) => `${path.relative(ROOT, file).replace(/\\/g, '/')}:${n.loc.start.line}`;
    walk.full(ast, (n) => {
        if (n.type === 'TemplateLiteral' && /<[a-z]/i.test(n.quasis.map(q => q.value.raw).join(''))) {
            n.expressions.filter(x => !safe(x)).forEach(x => hits.push(`${at(x)}: ${text(x)}`));
        }
        if (n.type === 'BinaryExpression' && n.operator === '+') {
            const tag = [n.left, n.right].find(x => x.type === 'Literal' && typeof x.value === 'string' && /<\/?[a-z]/i.test(x.value));
            const other = tag && [n.left, n.right].find(x => x !== tag);
            if (other && other.type !== 'BinaryExpression' && !safe(other)) hits.push(`${at(other)}: ${text(other)} (concatenated)`);
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
console.error(`${all.length} interpolation(s) to check by hand`);
