/**
 * @jest-environment node
 */
/**
 * Themes (redesign 2.6, DIRECTION §4): every theme in the registry (www/js/ui/themes.js) has its
 * token file in css/themes, joined into app.css, a name and a description in English and Hindi,
 * stays small (all themes ship in the one stylesheet), and keeps its colours screen-only so printing
 * from any theme is the Modern light output (black on white).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const WWW = path.join(__dirname, '..', '..', 'www');
const read = (rel) => fs.readFileSync(path.join(WWW, rel), 'utf8');
const THEMES = [...read('js/ui/themes.js').matchAll(/\{\s*id:\s*'([\w-]+)',\s*kind:\s*'(\w+)'/g)].map((m) => ({ id: m[1], kind: m[2] }));
const OWN = THEMES.filter((th) => th.id !== 'modern');
const css = (id) => read(`css/themes/${id}.css`);

/** The CSS left once every @media screen block is removed (what print sees). */
function outsideScreen(src) {
    let s = src.replace(/\/\*[\s\S]*?\*\//g, '');
    let out = '';
    let i = 0;
    const re = /@media\s+screen\s*\{/g;
    let m;
    while ((m = re.exec(s))) {
        out += s.slice(i, m.index);
        let depth = 1;
        let j = m.index + m[0].length;
        while (j < s.length && depth) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++; }
        i = j;
        re.lastIndex = j;
    }
    return out + s.slice(i);
}

test('the registry lists Modern first and every theme once', () => {
    expect(THEMES[0]).toEqual({ id: 'modern', kind: 'both' });
    expect(new Set(THEMES.map((th) => th.id)).size).toBe(THEMES.length);
    for (const th of THEMES) expect(['both', 'dark']).toContain(th.kind);
});

test('every theme file is in the registry and joined into app.css', () => {
    const files = fs.readdirSync(path.join(WWW, 'css', 'themes')).filter((f) => f.endsWith('.css')).map((f) => f.slice(0, -4)).sort();
    expect(files).toEqual(OWN.map((th) => th.id).sort());
    const list = read('styles.css');
    for (const th of OWN) expect(list).toContain(`@import url('css/themes/${th.id}.css');`);
});

test.each(OWN.map((th) => [th.id, th.kind]))('%s: tokens only, colours on screen only, ≤ 1.5 KB gzip', (id, kind) => {
    const src = css(id);
    expect(zlib.gzipSync(src).length).toBeLessThanOrEqual(1536);
    const blocks = [...src.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    for (const [, sel, body] of blocks) {
        for (const s of sel.split(',').map((x) => x.trim()).filter((x) => !x.startsWith('@'))) expect(s).toMatch(new RegExp(`^\\[data-theme="${id}"\\]`));
        for (const d of body.split(';').map((x) => x.trim()).filter(Boolean)) expect(d).toMatch(/^(--[\w-]+|color-scheme)\s*:/);
    }
    expect(outsideScreen(src)).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|color-scheme/i);
    if (kind === 'both') expect(src).toContain(`[data-theme="${id}"][data-mode="dark"]`);
});

test('text on a theme fill uses its ink token, never literal white (the dark themes have light fills)', () => {
    const FILL = /background(?:-color)?\s*:[^;]*var\(--(btn-success|btn-sale-bg|mode-sale|sale-color|btn-primary|btn-primary-bg|accent|accent-hover|wholesale-color|mode-wholesale|success-color|positive|danger-color|negative)\)/;
    const WHITE = /(?:^|[;{\s])color\s*:\s*(#fff\b|#ffffff\b|white\b)/i;
    const sources = [
        ...fs.readdirSync(path.join(WWW, 'css')).filter((f) => f.endsWith('.css') && f !== 'app.css').map((f) => `css/${f}`),
        ...fs.readdirSync(path.join(WWW, 'templates')).filter((f) => f.endsWith('.html')).map((f) => `templates/${f}`),
    ];
    const bad = [];
    for (const rel of sources) {
        const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '');
        for (const [, sel, body] of src.matchAll(/([^{}<>]+)\{([^{}]*)\}/g)) {
            if (FILL.test(body) && WHITE.test(body)) bad.push(`${rel}: ${sel.trim().split('\n').pop()}`);
        }
    }
    expect(bad).toEqual([]);
});

test.each(['en', 'hi'])('every theme has a name and a description (%s)', (lang) => {
    const cat = read(`js/i18n/${lang}.js`);
    for (const th of THEMES) {
        expect(cat).toContain(`'ui.settings.theme_${th.id}':`);
        expect(cat).toContain(`'ui.settings.theme_${th.id}_desc':`);
    }
});
