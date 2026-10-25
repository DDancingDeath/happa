#!/usr/bin/env node
/**
 * Finds UI text that mixes English and Hindi in one string ("Open / खोलें").
 * The app shows one language at a time (#143): every such string must be a t() key.
 * Used by www/js/__tests__/single-language-guard.test.js; run directly to list hits.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const espree = require('espree');

const ROOT = path.join(__dirname, '..');
const LATIN = /[A-Za-z]/;
const DEVANAGARI = /[\u0900-\u097F]/;

// Strings that may legitimately hold both scripts: the names of the two languages.
const ALLOW = [
    /^\s*English\s*\/\s*हिंदी\s*$/,
    /^\s*हिंदी\s*\/\s*English\s*$/
];

// The language picker's own label ("Language / भाषा") in the Settings row and the side-menu
// toggle: left as is because feat/language-in-settings is moving that toggle.
const ALLOW_IN_FILE = {
    'www/templates/settings.html': [/^Language \/ भाषा$/],
    'www/templates/navigation.html': [/^Language \/ भाषा$/]
};

function isMixed(text, file) {
    if (!text || !LATIN.test(text) || !DEVANAGARI.test(text)) return false;
    const allowed = ALLOW.concat(ALLOW_IN_FILE[file] || []);
    return !allowed.some(re => re.test(String(text).trim()));
}

function listFiles(dir, filter, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) listFiles(full, filter, out);
        else if (filter(full)) out.push(full);
    }
    return out;
}

function jsFiles() {
    const skip = /[\\/](__tests__|vendor|i18n)[\\/]|\.(test|spec)\.js$/;
    return listFiles(path.join(ROOT, 'www', 'js'), f => f.endsWith('.js') && !skip.test(f))
        .concat(path.join(ROOT, 'www', 'firebaseConfig.js'), path.join(ROOT, 'www', 'service-worker.js'))
        .filter(f => fs.existsSync(f));
}

function htmlFiles() {
    return listFiles(path.join(ROOT, 'www', 'templates'), f => f.endsWith('.html'))
        .concat(path.join(ROOT, 'www', 'index.html'));
}

function walk(node, visit, parent = null) {
    if (!node || typeof node.type !== 'string') return;
    visit(node, parent);
    for (const key of Object.keys(node)) {
        if (key === 'parent') continue;
        const value = node[key];
        if (Array.isArray(value)) value.forEach(v => walk(v, visit, node));
        else if (value && typeof value.type === 'string') walk(value, visit, node);
    }
}

const stringOf = (node) => {
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node.type === 'TemplateLiteral') return node.quasis.map(q => q.value.cooked ?? q.value.raw).join('${}');
    return null;
};

/** Literal pieces of a `'a' + x + 'b'` chain. */
function concatParts(node, out = []) {
    if (node.type === 'BinaryExpression' && node.operator === '+') {
        concatParts(node.left, out);
        concatParts(node.right, out);
    } else {
        out.push(node);
    }
    return out;
}

const langProp = (node) => (node && node.type === 'MemberExpression' && !node.computed && node.property
    && (node.property.name === 'en' || node.property.name === 'hi') ? node.property.name : null);

/** Mixed string literals / template literals / concatenations in JS source. */
function scanJsSource(source, file = '<js>') {
    let ast;
    const opts = { ecmaVersion: 'latest', loc: true, comment: false };
    try { ast = espree.parse(source, { ...opts, sourceType: 'module' }); } catch (_) {
        ast = espree.parse(source, { ...opts, sourceType: 'script' });
    }
    const hits = [];
    const hit = (node, text) => hits.push({ file, line: node.loc.start.line, text: String(text).trim().slice(0, 120) });
    walk(ast, (node, parent) => {
        const text = stringOf(node);
        if (text != null && isMixed(text, file)) { hit(node, text); return; }
        if (node.type === 'TemplateLiteral') {
            const langs = new Set(node.expressions.map(langProp).filter(Boolean));
            if (langs.size === 2) hit(node, `\`${text}\` renders both .en and .hi`);
        }
        if (node.type === 'BinaryExpression' && node.operator === '+'
            && !(parent && parent.type === 'BinaryExpression' && parent.operator === '+')) {
            const parts = concatParts(node);
            const strs = parts.map(stringOf);
            const joined = strs.map(s => (s == null ? '${}' : s)).join('');
            if (!strs.some(s => s != null && isMixed(s, file)) && strs.some(s => s != null) && isMixed(joined, file)) hit(node, joined);
            const langs = new Set(parts.map(langProp).filter(Boolean));
            if (langs.size === 2) hit(node, `${joined} renders both .en and .hi`);
        }
    });
    return hits;
}

/** Mixed text nodes / attribute values (and inline scripts) in HTML. */
function scanHtmlSource(source, file = '<html>') {
    const hits = [];
    const lineOf = idx => source.slice(0, idx).split('\n').length;
    const noComments = source.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '));
    const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = scriptRe.exec(noComments))) {
        if (!m[1].trim()) continue;
        try {
            const base = lineOf(m.index) - 1;
            scanJsSource(m[1], file).forEach(h => hits.push({ ...h, line: h.line + base }));
        } catch (_) { /* JSON / non-JS script block */ }
    }
    const markup = noComments.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, s => s.replace(/[^\n]/g, ' '));
    const textRe = />([^<]+)</g;
    while ((m = textRe.exec(markup))) {
        if (isMixed(m[1], file)) hits.push({ file, line: lineOf(m.index), text: m[1].trim().slice(0, 120) });
    }
    const attrRe = /\s[\w:-]+\s*=\s*("([^"]*)"|'([^']*)')/g;
    while ((m = attrRe.exec(markup))) {
        const value = m[2] ?? m[3];
        if (/^\s*on\w+/i.test(m[0])) {
            try { scanJsSource(value, file).forEach(h => hits.push({ ...h, line: lineOf(m.index) })); } catch (_) { /* not parseable */ }
            continue;
        }
        if (isMixed(value, file)) hits.push({ file, line: lineOf(m.index), text: value.trim().slice(0, 120) });
    }
    return hits;
}

function scanAll() {
    const rel = f => path.relative(ROOT, f).replace(/\\/g, '/');
    const hits = [];
    for (const f of jsFiles()) hits.push(...scanJsSource(fs.readFileSync(f, 'utf8'), rel(f)));
    for (const f of htmlFiles()) hits.push(...scanHtmlSource(fs.readFileSync(f, 'utf8'), rel(f)));
    return hits;
}

module.exports = { isMixed, scanJsSource, scanHtmlSource, scanAll, jsFiles, htmlFiles, ALLOW, ALLOW_IN_FILE };

if (require.main === module) {
    const hits = scanAll();
    for (const h of hits) console.log(`${h.file}:${h.line}  ${h.text}`);
    console.log(`\n${hits.length} mixed-language string(s)`);
    process.exitCode = hits.length ? 1 : 0;
}
