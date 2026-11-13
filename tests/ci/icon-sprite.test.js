/**
 * @jest-environment node
 */
/**
 * Line icon sprite (redesign 2.4, DIRECTION §3.5): the symbols live in templates/navigation.html
 * (precached, no extra request). Every #i-* reference must exist, and the sprite stays small.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const NAV = read('www/templates/navigation.html').replace(/<!--[\s\S]*?-->/g, '');

function walk(dir, ext, out = []) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(rel, ext, out); } else if (rel.endsWith(ext)) out.push(rel);
    }
    return out;
}

const sprite = NAV.match(/<svg class="icon-sprite"[\s\S]*?<\/svg>/)[0];
const ids = [...sprite.matchAll(/<symbol id="(i-[\w]+)"/g)].map((m) => m[1]);

test('the sprite has unique symbols and stays about 2.5 KB gzip', () => {
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    expect(zlib.gzipSync(sprite).length).toBeLessThanOrEqual(3000);
    expect(sprite).not.toMatch(/<script|on\w+=|style=/i);
});

test('every #i-* reference has a symbol', () => {
    const files = ['www/index.html', ...walk('www/templates', '.html'), ...walk('www/js', '.js'), ...walk('www/css', '.css')];
    const missing = [];
    for (const f of files) {
        for (const m of read(f).replace(/<!--[\s\S]*?-->/g, '').matchAll(/href="#(i-[\w]+)"/g)) if (!ids.includes(m[1])) missing.push(`${f}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
});

test('every icon() call names a symbol, as a constant', () => {
    const missing = [];
    const dynamic = [];
    for (const f of walk('www/js', '.js')) {
        const src = read(f);
        if (!/import \{[^}]*\bicon\b[^}]*\} from '[./]*(ui\/)?icons\.js'/.test(src)) continue;
        for (const m of src.matchAll(/\bicon\(\s*([^,)]*)/g)) {
            const name = /^'(\w+)'$/.exec(m[1].trim());
            if (!name) dynamic.push(`${f}: icon(${m[1]})`);
            else if (!ids.includes(`i-${name[1]}`)) missing.push(`${f}: ${name[1]}`);
        }
    }
    expect(dynamic).toEqual([]);
    expect(missing).toEqual([]);
});

test('icons are decorative and the menu, tab bar and bell use them', () => {
    const uses = [...NAV.replace(sprite, '').matchAll(/<svg class="i[^"]*"[^>]*>/g)].map((m) => m[0]);
    expect(uses.length).toBeGreaterThan(0);
    for (const tag of uses) expect(tag).toContain('aria-hidden="true"');
    for (const cls of ['nav-icon', 'bottom-nav-icon', 'notif-bell-icon']) {
        const spans = [...NAV.matchAll(new RegExp(`<span class="${cls}"[^>]*>([\\s\\S]*?)</span>`, 'g'))];
        expect(spans.length).toBeGreaterThan(0);
        for (const [, inner] of spans) expect(inner).toMatch(/^<svg class="i[^"]*"[^>]*><use href="#i-\w+"\/><\/svg>$/);
    }
});
