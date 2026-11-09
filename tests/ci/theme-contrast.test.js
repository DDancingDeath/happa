/**
 * @jest-environment node
 */
/**
 * Token contrast (redesign DIRECTION §4.9): every text colour token keeps WCAG AA (4.5:1) on the
 * surfaces it is used on, in every theme and mode. Reads www/css/variables.css (Modern Minimal, the
 * base of every theme), resolves var() chains and composites translucent fills over the surface.
 * The E2E axe checks stay the gate for the rendered pages.
 */
const fs = require('fs');
const path = require('path');

const WWW = path.join(__dirname, '..', '..', 'www');
const CSS = fs.readFileSync(path.join(WWW, 'css', 'variables.css'), 'utf8');

/** Rule blocks on screen: @media screen is unwrapped, other @media blocks (print) are dropped. */
function screenBlocks(css) {
    let src = css.replace(/\/\*[\s\S]*?\*\//g, '');
    let out = '';
    let i = 0;
    const re = /@media([^{]*)\{/g;
    let m;
    while ((m = re.exec(src))) {
        out += src.slice(i, m.index);
        let depth = 1;
        let j = m.index + m[0].length;
        while (j < src.length && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
        if (/^\s*screen\s*$/.test(m[1])) out += src.slice(m.index + m[0].length, j - 1);
        i = j;
        re.lastIndex = j;
    }
    src = out + src.slice(i);
    return [...src.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((b) => ({
        selectors: b[1].split(',').map((s) => s.trim()),
        decl: Object.fromEntries([...b[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((d) => [d[1], d[2].trim()])),
    }));
}

const blocks = screenBlocks(CSS);
const pick = (test) => Object.assign({}, ...blocks.filter((b) => b.selectors.some(test)).map((b) => b.decl));
const BASE = {
    light: pick((s) => s === '[data-theme]'),
    dark: { ...pick((s) => s === '[data-theme]'), ...pick((s) => s === '[data-mode="dark"]') },
};
const KINDS = Object.fromEntries([...fs.readFileSync(path.join(WWW, 'js', 'ui', 'themes.js'), 'utf8')
    .matchAll(/\{\s*id:\s*'([\w-]+)',\s*kind:\s*'(\w+)'/g)].map((m) => [m[1], m[2]]));

/** A theme's tokens in a mode: Modern's base for that mode, then the theme's own blocks for it. */
function themeTokens(id, mode) {
    if (id === 'modern') return BASE[mode];
    const own = screenBlocks(fs.readFileSync(path.join(WWW, 'css', 'themes', `${id}.css`), 'utf8'));
    const take = (sel) => Object.assign({}, ...own.filter((b) => b.selectors.includes(sel)).map((b) => b.decl));
    const t = `[data-theme="${id}"]`;
    return mode === 'dark'
        ? { ...BASE.dark, ...take(t), ...take(`${t}[data-mode="dark"]`) }
        : { ...BASE.light, ...take(t), ...take(`${t}:not([data-mode="dark"])`) };
}

const TOKENS = Object.fromEntries(Object.entries(KINDS).flatMap(([id, kind]) =>
    (kind === 'dark' ? ['dark'] : ['light', 'dark']).map((mode) => [`${id} ${mode}`, themeTokens(id, mode)])));

function resolve(t, v, depth = 0) {
    if (v == null || depth > 12) return v;
    return v.replace(/var\((--[\w-]+)(?:,\s*([^)]+))?\)/g, (_, n, fb) => resolve(t, t[n] != null ? t[n] : fb, depth + 1));
}
function rgba(s) {
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s || '');
    if (m) {
        let h = m[1];
        if (h.length === 3) h = h.split('').map((c) => c + c).join('');
        return [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16)).concat(h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1);
    }
    m = /^rgba?\(([^)]+)\)$/.exec(s || '');
    if (!m) return null;
    const p = m[1].split(',').map(Number);
    return [p[0], p[1], p[2], p[3] == null ? 1 : p[3]];
}
const over = (fg, bg) => [0, 1, 2].map((k) => fg[k] * fg[3] + bg[k] * (1 - fg[3])).concat(1);
const lum = (c) => {
    const v = c.slice(0, 3).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
};
const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

/** A token's colour; `name@under` composites a translucent token over another. */
function colour(t, name) {
    const [n, under] = name.split('@');
    const c = name === '#fff' ? [255, 255, 255, 1] : rgba(resolve(t, t[`--${n}`]));
    if (!c) throw new Error(`--${n} is not a colour: ${resolve(t, t[`--${n}`])}`);
    return c[3] < 1 ? over(c, colour(t, under || 'surface')) : c;
}

const PAIRS = [
    ['ink', 'bg'], ['ink', 'surface'], ['ink-2', 'bg'], ['ink-2', 'surface'], ['ink-2', 'surface-2'],
    ['ink-3', 'bg'], ['ink-3', 'surface'], ['ink-3', 'surface-2'], ['ink-placeholder', 'input-bg'],
    ['accent-text', 'bg'], ['accent-text', 'surface'], ['accent-text', 'surface-2'], ['accent-text', 'accent-soft@surface'],
    ['on-accent', 'accent'], ['#fff', 'accent-strong'], ['btn-primary-ink', 'btn-primary-bg'],
    ['btn-sale-ink', 'btn-sale-bg'], ['#fff', 'btn-danger-bg'],
    ['positive', 'surface'], ['positive', 'bg'], ['positive', 'positive-soft@surface'],
    ['negative', 'surface'], ['negative', 'bg'], ['negative', 'negative-soft@surface'],
    ['warning', 'surface'], ['warning', 'warning-soft@surface'],
    ['info', 'surface'], ['info', 'info-soft@surface'],
    ['on-caution-soft', 'caution-soft@surface'], ['toast-ink', 'toast-bg'],
];

describe.each(Object.keys(TOKENS))('%s', (name) => {
    const t = TOKENS[name];

    test('has the semantic tokens', () => {
        for (const n of ['bg', 'surface', 'surface-2', 'ink', 'ink-2', 'ink-3', 'accent', 'accent-text', 'positive', 'negative', 'warning', 'info']) {
            expect(rgba(resolve(t, t[`--${n}`]))).not.toBeNull();
        }
    });

    test.each(PAIRS)('%s on %s is at least 4.5:1', (fg, bg) => {
        const bgc = colour(t, bg);
        const fgc = fg === '#fff' ? [255, 255, 255, 1] : colour(t, `${fg}@${bg.split('@')[0]}`);
        expect(Number(ratio(fgc, bgc).toFixed(2))).toBeGreaterThanOrEqual(4.5);
    });
});

test('printing uses the light values: the dark tokens are screen-only', () => {
    expect(BASE.dark['--bg']).not.toBe(BASE.light['--bg']);
    expect(blocks.filter((b) => b.selectors.includes('[data-mode="dark"]')).length).toBeGreaterThan(0);
    const printOnly = CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media\s+screen\s*\{[\s\S]*?\n\}/g, '');
    expect(printOnly).not.toMatch(/\[data-mode="dark"\]\s*[,{]/);
});
