/**
 * @fileoverview Inline event handlers (#89): the Content-Security-Policy can only drop
 * 'unsafe-inline' for scripts once no `on<event>=` attribute is left in www/. They move to
 * delegated `data-on<event>` attributes (ui/actions.js) page by page; this ratchet stops new
 * ones and checks that every data-on* attribute in the templates and the JS parses.
 * `INLINE_BASELINE=lower npx jest inline-handlers` writes the lower counts.
 */
import fs from 'fs';
import path from 'path';
import { parseAction } from '../ui/actions.js';

const WWW = path.resolve(__dirname, '../..');
const BASELINE_FILE = path.resolve(WWW, '../tests/inline-handlers-baseline.json');
const INLINE = /\son(click|dblclick|change|input|submit|reset|key(?:down|up|press)|mouse\w+|pointer\w+|touch\w+|focus|blur|load|error|scroll|wheel|drag\w*|drop|contextmenu|select|paste|copy|cut|toggle|animation\w+|transition\w+)\s*=\s*["'`]/g;
const DATA_ON = /data-on(click|change|input|submit|keydown|keyup|focus|blur|toggle|enter)="([^"]*)"/g;

function files(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return ['__tests__', 'vendor', 'node_modules'].includes(e.name) ? [] : files(p);
        return /\.(html|js)$/.test(e.name) ? [p] : [];
    });
}
const rel = (p) => path.relative(WWW, p).replace(/\\/g, '/');
const counts = () => Object.fromEntries(files(WWW)
    // JSDoc examples in .js files don't count
    .map(f => [rel(f), ((f.endsWith('.js') ? fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '') : fs.readFileSync(f, 'utf8')).match(INLINE) || []).length])
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b)));

describe('inline event handlers (#89)', () => {
    test('no file gains an inline handler (ratchet)', () => {
        const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
        const now = counts();
        if (process.env.INLINE_BASELINE === 'lower') {
            const lowered = Object.fromEntries(Object.entries(baseline.files)
                .map(([f, n]) => [f, Math.min(n, now[f] || 0)]).filter(([, n]) => n > 0));
            fs.writeFileSync(BASELINE_FILE, `${JSON.stringify({ ...baseline, files: lowered }, null, 2)}\n`);
            return;
        }
        const raised = Object.entries(now).filter(([f, n]) => n > (baseline.files[f] || 0)).map(([f, n]) => `${f}: ${baseline.files[f] || 0} -> ${n}`);
        expect(raised).toEqual([]);
        const lower = Object.entries(baseline.files).filter(([f, n]) => (now[f] || 0) < n).map(([f, n]) => `${f}: ${n} -> ${now[f] || 0}`);
        // Converted handlers must be taken off the baseline in the same PR, so they can't come back.
        expect(lower).toEqual([]);
    });

    test('no tag in www/ has any on<event>= attribute (the enforced CSP blocks them all)', () => {
        // Wider than INLINE: any on* name, quoted or not, inside a tag in the HTML or a JS string.
        const ANY_ON = /<[a-z][^<>]*?[\s/]on[a-z]+\s*=/gi;
        const hits = files(WWW).flatMap(f => {
            const src = f.endsWith('.js') ? fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '') : fs.readFileSync(f, 'utf8');
            return (src.match(ANY_ON) || []).map(m => `${rel(f)}: ${m.slice(-60)}`);
        });
        expect(hits).toEqual([]);
    });

    test('every data-on* attribute parses (templates as written, JS with each ${…} as a value)', () => {
        const bad = [];
        for (const f of files(WWW)) {
            const src = fs.readFileSync(f, 'utf8');
            for (const m of src.matchAll(DATA_ON)) {
                // A whole call string built by the caller (bill rows, the edits row, Today's reminders):
                // not seen here; rendering tests (xss-rendering, today-reminders) cover those
                if (/^\$\{[^}]*\}$/.test(m[2])) continue;
                // A method name or an argument list built at run time (rentals' btn(), a nested template):
                // rendering tests cover those
                if (/\.\$\{|`/.test(m[2])) continue;
                // In a JS template literal an interpolation stands for a namespace (period-compare's
                // ${page}.saveRange()), a string (inside quotes) or a value
                const value = m[2].replace(/^\$\{[^}]*\}(?=\.)/, 'ns').replace(/'\$\{[^}]*\}'/g, "'x'").replace(/\$\{[^}]*\}/g, '0');
                const decoded = value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
                try {
                    parseAction(decoded);
                } catch (e) {
                    bad.push(`${rel(f)}: ${m[0]} (${e.message})`);
                }
            }
        }
        expect(bad).toEqual([]);
    });
});
