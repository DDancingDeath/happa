/**
 * Docs link check (#62): every relative link in the repo's Markdown files
 * points to a file or folder that exists. External (http/mailto) links are not
 * fetched, so the check needs no network.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'android', 'coverage', 'playwright-report', 'test-results', '.stryker-tmp', 'reports']);

function markdownFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) markdownFiles(path.join(dir, entry.name), out);
        } else if (entry.name.endsWith('.md')) {
            out.push(path.join(dir, entry.name));
        }
    }
    return out;
}

/** The text outside fenced code blocks (``` or ~~~, closed by a fence at least as long) and code spans. */
function proseOf(text) {
    const out = [];
    let fence = null;
    text.split(/\r?\n/).forEach(line => {
        const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
        if (fence) {
            if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.slice(line.indexOf(m[1]) + m[1].length).trim()) fence = null;
            return;
        }
        if (m) { fence = m[1]; return; }
        out.push(line.replace(/(`+)[^`]*?\1/g, ''));
    });
    return out.join('\n');
}

/** Destination of an inline link starting at text[i] (just after "]("), or null. */
function destinationAt(text, i) {
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (text[i] === '<') {
        const end = text.indexOf('>', i);
        return end > i ? text.slice(i + 1, end) : null;
    }
    let depth = 0;
    let j = i;
    for (; j < text.length; j++) {
        const c = text[j];
        if (/\s/.test(c)) break;
        if (c === '(') depth++;
        else if (c === ')') { if (depth === 0) break; depth--; }
    }
    return j > i ? text.slice(i, j) : null;
}

/** Relative link targets (inline links, images and reference definitions) outside code. */
function relativeLinks(text) {
    const prose = proseOf(text);
    const targets = [];
    for (let i = prose.indexOf(']('); i !== -1; i = prose.indexOf('](', i + 2)) {
        const dest = destinationAt(prose, i + 2);
        if (dest) targets.push(dest);
    }
    for (const m of prose.matchAll(/^\s{0,3}\[(?!\^)[^\]\n]+\]:\s*(?:<([^>\n]*)>|(\S+))/gm)) targets.push(m[1] ?? m[2]);
    return targets.filter(t => !/^[a-z][a-z0-9+.-]*:/i.test(t) && !t.startsWith('#') && !t.startsWith('//'));
}

describe('docs link check', () => {
    const files = markdownFiles(ROOT);

    test('finds the docs', () => {
        expect(files.map(f => path.relative(ROOT, f).replace(/\\/g, '/'))).toEqual(
            expect.arrayContaining(['README.md', 'AGENTS.md', 'docs/architecture.md'])
        );
    });

    test('relative links point to existing files', () => {
        const broken = [];
        files.forEach(file => {
            relativeLinks(fs.readFileSync(file, 'utf8')).forEach(link => {
                let target = link.split('#')[0].split('?')[0];
                try { target = decodeURIComponent(target); } catch (_) { /* keep as is */ }
                if (!target) return;
                const resolved = target.startsWith('/') ? path.join(ROOT, target) : path.resolve(path.dirname(file), target);
                if (!fs.existsSync(resolved)) broken.push(`${path.relative(ROOT, file)} -> ${link}`);
            });
        });
        expect(broken).toEqual([]);
    });

    test('the parser skips external links, anchors and code', () => {
        const text = [
            "[a](docs/x.md) [b](https://e.com) [c](#top) `[d](no.md)` ``[e](no.md)``",
            '````', '```', '[f](no2.md)', '```', '````',
            '~~~~', '~~~', '[g](no3.md)', '~~~', '~~~~',
            '![img](i.png "t") [h](y.md \'t\') [**[i]**](z.md) [j](<my file.md>) [k](foo_(bar).md)',
            '[ref]: refs/r.md "Title"', '[r2]: <my ref.md>', '[^1]: A footnote'
        ].join('\n');
        expect(relativeLinks(text)).toEqual(['docs/x.md', 'i.png', 'y.md', 'z.md', 'my file.md', 'foo_(bar).md', 'refs/r.md', 'my ref.md']);
    });
});
