// Token contrast check for every theme x mode (the Phase 2 Jest test does the same on www/css/themes).
// Resolves var() chains from the CSS files, composites translucent colours over the canvas and reports pairs below target.
// Usage (repo root): node direction/tools/theme-contrast.cjs [--all]
const fs = require('fs');
const path = require('path');
const SRC = path.resolve(__dirname, '../mocks/src');
const registry = require(path.join(SRC, 'themes/registry.cjs'));

const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
function blocks(css) {
  const out = [];
  for (const m of strip(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decl = {};
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) decl[d[1]] = d[2].trim();
    if (Object.keys(decl).length) out.push({ sel: m[1].trim().replace(/\s+/g, ' '), decl });
  }
  return out;
}
const base = blocks(fs.readFileSync(path.join(SRC, 'ds.css'), 'utf8'));
const pick = (list, test) => Object.assign({}, ...list.filter((b) => b.sel.split(',').map((s) => s.trim()).some(test)).map((b) => b.decl));

function tokens(id, mode) {
  const t = pick(base, (s) => s === '[data-theme]');
  if (id === 'modern') { if (mode === 'dark') Object.assign(t, pick(base, (s) => s === '[data-theme="modern"][data-mode="dark"]')); return t; }
  const th = blocks(fs.readFileSync(path.join(SRC, 'themes', id + '.css'), 'utf8'));
  Object.assign(t, pick(th, (s) => s === `[data-theme="${id}"]`));
  if (mode === 'dark') Object.assign(t, pick(th, (s) => s === `[data-theme="${id}"][data-mode="dark"]`));
  return t;
}
function resolve(t, v, depth = 0) {
  if (depth > 10 || v == null) return v;
  return v.replace(/var\((--[\w-]+)(?:,\s*([^)]+))?\)/g, (_, n, fb) => resolve(t, t[n] != null ? t[n] : fb, depth + 1));
}
function rgba(s) {
  s = (s || '').trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) { let h = m[1]; if (h.length === 3) h = h.split('').map((c) => c + c).join(''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1]; }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) { const p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p[3] == null ? 1 : p[3]]; }
  return null;
}
const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
const lum = (c) => { const v = c.slice(0, 3).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const PAIRS = [
  ['ink', 'bg'], ['ink-2', 'bg'], ['ink-3', 'bg'], ['ink', 'panel-bg'], ['ink-2', 'panel-bg'], ['ink-3', 'panel-bg'], ['ink-2', 'surface-2'], ['ink-3', 'surface-2'],
  ['ink-placeholder', 'input-bg'], ['accent-text', 'panel-bg'], ['accent-text', 'bg'], ['accent-text', 'accent-soft@panel-bg'],
  ['btn-primary-ink', 'btn-primary-bg'], ['btn-sale-ink', 'btn-sale-bg'], ['on-accent', 'accent'],
  ['positive', 'panel-bg'], ['negative', 'panel-bg'], ['warning', 'panel-bg'], ['negative', 'negative-soft@panel-bg'], ['warning', 'warning-soft@panel-bg'], ['positive', 'positive-soft@panel-bg'],
  ['toast-ink', 'toast-bg'], ['appbar-ink', 'appbar-bg']
];
function color(t, name, canvas) {
  const [n, on] = name.split('@');
  const c = rgba(resolve(t, t['--' + n]));
  if (!c) return null;
  const under = on ? color(t, on, canvas) : canvas;
  return c[3] < 1 ? over(c, under) : c;
}
const all = process.argv.includes('--all');
const rows = [];
let fails = 0;
for (const th of registry) {
  for (const mode of th.kind === 'dark' ? ['dark'] : ['light', 'dark']) {
    const t = tokens(th.id, mode);
    const bg = rgba(resolve(t, t['--bg']));
    // Mesh / glow themes: also test over every colour stop of --page-bg, composited on the canvas
    const stops = (resolve(t, t['--page-bg']) || '').match(/#[0-9a-f]{3,8}\b|rgba?\([^)]+\)/gi) || [];
    const canvases = [bg, ...stops.map(rgba).filter(Boolean).map((s) => over(s, bg))];
    let min = 99, worst = '';
    const bad = [];
    for (const canvas of canvases) for (const [f, b] of PAIRS) {
      const bgc = b === 'appbar-bg' && /transparent/.test(resolve(t, t['--appbar-bg'])) ? null : color(t, b, canvas);
      const fgc = color(t, f, bgc || canvas);
      if (!fgc || !bgc) continue;
      const r = ratio(fgc, over(bgc, canvas));
      if (r < min) { min = r; worst = `${f} on ${b}`; }
      if (r < 4.5) bad.push(`${f} on ${b} ${r.toFixed(2)}`);
    }
    fails += bad.length;
    rows.push({ theme: th.id, mode, min: min.toFixed(2), worst, below: bad.length ? bad.join('; ') : '—' });
  }
}
console.table(all ? rows : rows.map(({ theme, mode, min, worst, below }) => ({ theme, mode, min, worst, below: below.slice(0, 90) })));
console.log(fails ? `${fails} pair(s) below 4.5:1` : 'All checked pairs >= 4.5:1');
process.exitCode = fails ? 1 : 0;
