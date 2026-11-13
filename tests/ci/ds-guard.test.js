/**
 * @jest-environment node
 */
/**
 * Design-system ratchet (UX audit 2026-11-13, G1; docs/design-system.md §7). Counts, per file, the
 * UI drift that the colour and type guards don't cover:
 *   spacing    raw margin / padding / gap lengths (use --sp-*)
 *   radius     raw border-radius (use --r-*)
 *   shadow     raw box-shadow / text-shadow (use --e* / --shadow-*)
 *   zIndex     raw z-index numbers
 *   important  !important
 *   idSelector CSS selectors with an #id
 *   themeSelector .dark-mode / [data-theme] / [data-mode] outside the token and theme files
 *   inlineStyle template style="…", style="…" in JS strings, non-display .style writes
 *               (custom-property-only geometry such as style="--w:42%" is allowed)
 *   emoji      emoji in templates; ui.* keys with an emoji in en.js / hi.js (keyed per ui area)
 *   titleCase  Title Case ui.* labels in en.js (keyed per ui area)
 *   legacyClass uses of the legacy component classes in tests/ds-legacy-classes.json
 * Scope: www/css (not app.css, variables.css, themes/), www/index.html, www/templates, www/js;
 * @media print and the receipt files stay out, as in colour-guard.
 *
 * Counts may only go down, and the baseline must follow them down, so a fix can't be spent on a
 * new drift later. DS_BASELINE=lower npx jest ds-guard lowers tests/ds-baseline.json. Files in its
 * "strict" list are pinned at 0 on every metric; the list may only grow.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const BASELINE_REL = 'tests/ds-baseline.json';
const BASELINE_FILE = path.join(ROOT, BASELINE_REL);
const LEGACY = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/ds-legacy-classes.json'), 'utf8')).classes;
const SKIP = new Set([
    'www/css/app.css', 'www/css/variables.css', 'www/css/rent-receipt.css',
    'www/js/services/printer.js', 'www/js/services/receipt-drawing.js', 'www/js/rentals/rent-receipt.js',
]);
const I18N = ['www/js/i18n/en.js', 'www/js/i18n/hi.js'];
const METRICS = ['spacing', 'radius', 'shadow', 'zIndex', 'important', 'idSelector', 'themeSelector', 'inlineStyle', 'emoji', 'titleCase', 'legacyClass'];
const HINT = {
    spacing: 'use --sp-* tokens', radius: 'use --r-* tokens', shadow: 'use --e1…--e3 / --shadow-* tokens',
    zIndex: 'reuse an existing layer', important: 'fix the specificity instead', idSelector: 'style a class, keep ids as hooks',
    themeSelector: 'use a token that switches with the mode (theme rules live in css/themes/)',
    inlineStyle: 'use a class (only custom properties such as style="--w:42%" are allowed)',
    emoji: 'use a sprite icon (icon())', titleCase: 'labels are sentence case',
    legacyClass: 'use the replacement in tests/ds-legacy-classes.json',
};

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u2600-\u27BF\u2B50\u2B55\u231A-\u23FF]/gu;
const EMOJI_ANY = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u2600-\u27BF\u2B00-\u2BFF\u231A-\u23FF\u2190-\u21FF\u2122\u2139\u3030\u303D]/gu;
const LEN = /(?<![\w.-])-?\d*\.?\d+(?:px|rem|em)\b/g;
const HAS_LEN = new RegExp(LEN.source);
const HAS_EMOJI = new RegExp(EMOJI.source, 'u');
const ZERO_LEN = /^-?0*\.?0+(?:px|rem|em)$/;
const DECL = /(?:^|[;{\s"'`])(margin(?:-[a-z]+)*|padding(?:-[a-z]+)*|gap|row-gap|column-gap|border(?:-[a-z]+-[a-z]+)?-radius|box-shadow|text-shadow|z-index)\s*:\s*([^;"'`}\r\n]+)/gi;
const JS_PROP = /\.style\.(margin\w*|padding\w*|gap|rowGap|columnGap|border\w*Radius|boxShadow|textShadow|zIndex)\s*=\s*(['"`]?)([^'"`;\n]*)\2/g;
const KEBAB = (p) => p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const count = (text, re) => (text.match(re) || []).length;
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const stripJsComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const noVar = (v) => { let prev; while (prev !== v) { prev = v; v = v.replace(/var\([^()]*\)/g, ''); } return v; };

function stripPrint(css) {
    let out = '';
    let i = 0;
    const re = /@media\s+print[^{]*\{/gi;
    let m;
    while ((m = re.exec(css))) {
        out += css.slice(i, m.index);
        let depth = 1;
        let j = m.index + m[0].length;
        while (j < css.length && depth) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
        i = j;
        re.lastIndex = j;
    }
    return out + css.slice(i);
}

const zero = () => Object.fromEntries(METRICS.map((k) => [k, 0]));

/** Which token metric a raw declaration breaks (null when it uses tokens or keywords). */
function classify(prop, value) {
    const p = prop.toLowerCase();
    const v = noVar(value.replace(/!important/i, '')).trim();
    if (/^(margin|padding|gap|row-gap|column-gap)/.test(p)) {
        return (v.match(LEN) || []).some((x) => !ZERO_LEN.test(x)) ? 'spacing' : null;
    }
    if (/radius$/.test(p)) return HAS_LEN.test(v) || /\d%/.test(v) ? 'radius' : null;
    if (/shadow$/.test(p)) return !/^(none|inherit|initial|unset)\b/i.test(v) && /\d/.test(v) ? 'shadow' : null;
    if (p === 'z-index') return /^-?\d/.test(v) ? 'zIndex' : null;
    return null;
}

function addDecls(text, m) {
    for (const d of text.matchAll(DECL)) {
        const k = classify(d[1], d[2]);
        if (k) m[k]++;
    }
}

function cssMetrics(source, m = zero()) {
    const css = stripPrint(stripCssComments(source));
    addDecls(css, m);
    m.important += count(css, /!important/gi);
    for (const pre of css.matchAll(/([^{}]+)\{/g)) {
        const prelude = pre[1].trim();
        if (!prelude || prelude.startsWith('@')) continue;
        for (const sel of prelude.split(',')) {
            if (/#[A-Za-z_-]/.test(sel.replace(/\[[^\]]*\]/g, ''))) m.idSelector++;
            if (/\.dark-mode\b|\[data-(?:theme|mode)\b/.test(sel)) m.themeSelector++;
        }
    }
    return m;
}

const onlyCustomProps = (style) => style.split(';').map((d) => d.trim()).filter(Boolean).every((d) => d.startsWith('--'));

function classUses(text) {
    let n = 0;
    const tally = (value) => { for (const w of value.match(/[A-Za-z_][\w-]*/g) || []) if (Object.hasOwn(LEGACY, w)) n++; };
    for (const m of text.matchAll(/\bclass(?:Name)?\s*=\s*\\?(["'`])([\s\S]*?)\\?\1/g)) tally(m[2]);
    for (const m of text.matchAll(/\bclassName\s*[:+]=?\s*(["'`])([^"'`]*)\1/g)) tally(m[2]);
    for (const m of text.matchAll(/\bclassList\.(?:add|toggle|replace)\(([^)]*)\)/g)) {
        for (const s of m[1].matchAll(/(["'`])([^"'`]*)\1/g)) tally(s[2]);
    }
    return n;
}

function htmlMetrics(source) {
    const html = source.replace(/<!--[\s\S]*?-->/g, '');
    const m = zero();
    for (const b of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) cssMetrics(b[1], m);
    for (const s of html.matchAll(/\sstyle="([^"]*)"/gi)) {
        addDecls(` ${s[1]}`, m);
        m.important += count(s[1], /!important/gi);
        if (!onlyCustomProps(s[1])) m.inlineStyle++;
    }
    const body = html.replace(/<svg class="icon-sprite"[\s\S]*?<\/svg>/g, '').replace(/<script[\s\S]*?<\/script>/gi, '');
    m.emoji = count(body, EMOJI);
    m.legacyClass = classUses(html);
    return m;
}

function jsMetrics(source) {
    const src = stripJsComments(source);
    const m = zero();
    addDecls(src, m);
    for (const w of src.matchAll(JS_PROP)) {
        const k = classify(KEBAB(w[1]), w[2] ? w[3] : '');
        if (k) m[k]++;
    }
    m.important += count(src, /!important/gi);
    for (const s of src.matchAll(/style=\\?(["'])([\s\S]*?)\\?\1/g)) if (!onlyCustomProps(s[2])) m.inlineStyle++;
    m.inlineStyle += count(src, /\.style\.(?!display\b|setProperty\b|removeProperty\b|getPropertyValue\b)[a-zA-Z]+\s*=(?!=)/g);
    m.inlineStyle += count(src, /\.style\.setProperty\(\s*['"`](?!--)/g);
    m.inlineStyle += count(src, /setAttribute\(\s*['"]style['"]/g);
    m.legacyClass = classUses(src);
    return m;
}

/** [key, value] pairs of an i18n catalogue (single-line entries, as in en.js / hi.js). */
function i18nPairs(source) {
    const out = [];
    for (const m of source.matchAll(/^\s*'([\w.]+)'\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`]*)`)/gm)) {
        out.push([m[1], m[2] ?? m[3] ?? m[4]]);
    }
    return out;
}

const SMALL = new Set('a an the and or of to in on for by at with per vs from as is it its into via not no but if'.split(' '));
const PROPER = new Set(('WhatsApp UPI GST PDF CSV Google Android Hindi English ID OK Excel Bahi Happa Aadhat Firestore Firebase SMS QR Bluetooth USB IST FY Rs I Ctrl Alt Esc Enter Tab Shift Gmail Play Store Chrome Windows Rentals '
    + 'Sunday Monday Tuesday Wednesday Thursday Friday Saturday January February March April May June July August September October November December Diwali Holi Kharif Rabi').split(' '));
const isUpper = (w) => w === w.toUpperCase() && w !== w.toLowerCase();

/** A short label (2-7 words) whose every significant word after the first is capitalised. */
function isTitleCase(value) {
    const s = value.replace(/\{[^}]*\}/g, 'X').replace(EMOJI_ANY, '').trim();
    const words = s.match(/[A-Za-z][A-Za-z'’-]*/g) || [];
    if (words.length > 7 || (/[.?!]$/.test(s) && words.length > 4) || words.length < 2) return false;
    const sig = words.slice(1).filter((w) => !SMALL.has(w.toLowerCase()) && !PROPER.has(w) && !(isUpper(w) && w.length > 1) && w !== 'X');
    return sig.length > 0 && sig.every((w) => /^[A-Z]/.test(w));
}

const area = (key) => key.split('.').slice(0, 2).join('.');

function i18nMetrics(rel, source, result) {
    for (const [key, value] of i18nPairs(source)) {
        if (!key.startsWith('ui.')) continue;
        const row = `${rel}#${area(key)}`;
        if (HAS_EMOJI.test(value)) result.emoji[row] = (result.emoji[row] || 0) + 1;
        if (rel.endsWith('/en.js') && isTitleCase(value)) result.titleCase[row] = (result.titleCase[row] || 0) + 1;
    }
}

function walk(dir, out = []) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) { if (e.name !== '__tests__' && rel !== 'www/css/themes') walk(rel, out); } else out.push(rel);
    }
    return out;
}

function scan() {
    const files = [
        ...walk('www/css').filter((f) => f.endsWith('.css')),
        'www/index.html',
        ...walk('www/templates').filter((f) => f.endsWith('.html')),
        ...walk('www/js').filter((f) => f.endsWith('.js')),
    ].filter((f) => !SKIP.has(f)).sort();
    const result = Object.fromEntries(METRICS.map((k) => [k, {}]));
    const perFile = {};
    for (const f of files) {
        const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
        const m = f.endsWith('.css') ? cssMetrics(text) : f.endsWith('.html') ? htmlMetrics(text) : jsMetrics(text);
        perFile[f] = m;
        for (const k of METRICS) if (m[k]) result[k][f] = m[k];
        if (I18N.includes(f)) i18nMetrics(f, text, result);
    }
    for (const k of METRICS) result[k] = Object.fromEntries(Object.entries(result[k]).sort(([a], [b]) => a.localeCompare(b)));
    return { result, perFile };
}

const diff = (current, base) => {
    const up = [];
    const down = [];
    for (const f of new Set([...Object.keys(current), ...Object.keys(base)])) {
        const n = current[f] || 0;
        const b = base[f] || 0;
        if (n > b) up.push(`  ${f}: ${b} -> ${n}${b ? '' : ' (new row)'}`);
        else if (n < b) down.push(`  ${f}: ${b} -> ${n}`);
    }
    return { up: up.sort(), down: down.sort() };
};
const sum = (rows) => Object.values(rows).reduce((a, b) => a + b, 0);

function writeBaseline(metrics, strict) {
    const doc = {
        _readme: 'Design-system ratchet (tests/ci/ds-guard.test.js, docs/design-system.md §7). Per-file counts may only go down; lower them with DS_BASELINE=lower npx jest ds-guard. Files in "strict" are pinned at 0 on every metric.',
        totals: Object.fromEntries(METRICS.map((k) => [k, sum(metrics[k] || {})])),
        strict: [...strict].sort(),
        metrics: Object.fromEntries(METRICS.map((k) => [k, metrics[k] || {}])),
    };
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(doc, null, 2)}\n`);
}

function priorBaseline() {
    const ref = process.env.ARCH_BASE_REF || `origin/${process.env.GITHUB_BASE_REF || 'main'}`;
    const git = (args) => execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    try {
        git(['rev-parse', '--verify', `${ref}^{commit}`]);
    } catch {
        if (process.env.ARCH_REQUIRE_BASE === '1') throw new Error(`Cannot compare ${BASELINE_REL} with the PR base: ${ref} is missing.`);
        return null;
    }
    try {
        return JSON.parse(git(['show', `${ref}:${BASELINE_REL}`]));
    } catch {
        return null;
    }
}

describe('design-system ratchet (counts only go down)', () => {
    const { result: current, perFile } = scan();
    if (process.env.DS_BASELINE === 'reset' && !process.env.CI) {
        const old = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).strict || [] : [];
        writeBaseline(current, old);
    }
    const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));

    test.each(METRICS)('%s: no row goes up, and the baseline follows every drop', (k) => {
        const base = baseline.metrics[k] || {};
        const { up, down } = diff(current[k], base);
        if (up.length) throw new Error([`More ${k} than tests/ds-baseline.json allows: ${HINT[k]}.`, ...up].join('\n'));
        if (down.length && process.env.DS_BASELINE === 'lower') {
            const latest = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
            latest.metrics[k] = current[k];
            writeBaseline(latest.metrics, latest.strict);
            return;
        }
        if (down.length) {
            throw new Error([`${k} went down — well done. Lower the baseline to lock it in: DS_BASELINE=lower npx jest ds-guard`, ...down].join('\n'));
        }
    });

    test('strict files are at 0 on every metric', () => {
        const bad = [];
        for (const f of baseline.strict) {
            if (!perFile[f]) { bad.push(`  ${f}: not scanned (renamed or deleted? update "strict")`); continue; }
            for (const k of METRICS) if (perFile[f][k]) bad.push(`  ${f}: ${k} ${perFile[f][k]}`);
        }
        expect(bad).toEqual([]);
    });

    test('the baseline is no higher than the PR base, and strict files stay strict', () => {
        const prior = priorBaseline();
        if (!prior) return;
        const raised = [];
        for (const k of METRICS) {
            if (!prior.metrics?.[k]) continue;
            raised.push(...diff(baseline.metrics[k] || {}, prior.metrics[k]).up.map((r) => `${k}${r}`));
        }
        expect(raised).toEqual([]);
        expect((prior.strict || []).filter((f) => !baseline.strict.includes(f) && fs.existsSync(path.join(ROOT, f)))).toEqual([]);
    });

    test('the baseline totals match their rows', () => {
        for (const k of METRICS) expect([k, baseline.totals[k]]).toEqual([k, sum(baseline.metrics[k] || {})]);
    });

    test.each([
        ['a { margin: 8px 0; padding: var(--sp-2); gap: 0; margin-top: 0px; }', 'spacing', 1],
        ['a { padding: calc(var(--sp-2) + 2px); margin: -4px; }', 'spacing', 2],
        ['a { border-radius: 50%; border-top-left-radius: var(--r-sm); } b { border-radius: 0; }', 'radius', 1],
        ['a { box-shadow: none; text-shadow: 0 1px 2px var(--ink); } b { box-shadow: var(--e2); }', 'shadow', 1],
        ['a { z-index: 10; } b { z-index: auto; } @media print { c { z-index: 5; } }', 'zIndex', 1],
        ['a { color: red !important; } /* !important */', 'important', 1],
        ['#billing .row, .a #b, [href="#x"] a, .x { color: var(--ink); }', 'idSelector', 2],
        ['.dark-mode .a, [data-theme="vintage"] b, [data-mode=dark] c, .dark-modes { color: var(--ink); }', 'themeSelector', 3],
    ])('cssMetrics(%s).%s = %i', (css, k, n) => {
        expect(cssMetrics(css)[k]).toBe(n);
    });

    test.each([
        ['<div style="margin: 8px; display: none">x</div><div style="--w:42%"></div>', { spacing: 1, inlineStyle: 1 }],
        ['<h2>🧾 Bills</h2><p>₹ 10</p><!-- 🔍 --><script>x = "🔍"</script>', { emoji: 1 }],
        ['<div class="panel stat-card settings-card"></div>', { legacyClass: 2 }],
    ])('htmlMetrics(%s)', (html, expected) => {
        expect(htmlMetrics(html)).toEqual({ ...zero(), ...expected });
    });

    test.each([
        ['el.style.display = "none"; el.style.color = c; el.style.setProperty("--w", w); el.style.marginTop = "8px";', { inlineStyle: 2, spacing: 1 }],
        ['`<div style="padding: 12px; z-index: 3" class="row ${on ? \'rent-row\' : \'\'}">` + \'<b style="--w:1">\'', { inlineStyle: 1, spacing: 1, zIndex: 1, legacyClass: 1 }],
        ["el.classList.add('fin-row', 'row'); el.classList.remove('ins-row'); el.className = 'ins-card';", { legacyClass: 2 }],
        ["el.style.zIndex = '20'; el.style.borderRadius = 'var(--r-sm)';\n// style=\"margin: 4px\"", { zIndex: 1, inlineStyle: 2 }],
    ])('jsMetrics(%s)', (src, expected) => {
        expect(jsMetrics(src)).toEqual({ ...zero(), ...expected });
    });

    test.each([
        ['Total Paid', true], ['Add new item', false], ['Save', false], ['Share on WhatsApp', false],
        ['Open UPI QR', false], ['📲 Install App', true], ['This is a full sentence that Explains Things.', false], ['{count} Bills', true],
    ])('isTitleCase(%s) = %s', (label, expected) => {
        expect(isTitleCase(label)).toBe(expected);
    });

    test('i18n rows are keyed per ui area', () => {
        const result = { emoji: {}, titleCase: {} };
        i18nMetrics('www/js/i18n/en.js', "    'ui.cash.title': \"💵 Cash Book\",\n    'ui.cash.note': 'Add note',\n    'msg.cash.ok': \"✅ Saved Now\",\n", result);
        expect(result).toEqual({ emoji: { 'www/js/i18n/en.js#ui.cash': 1 }, titleCase: { 'www/js/i18n/en.js#ui.cash': 1 } });
    });
});
