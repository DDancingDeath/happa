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

/** Relative link targets of a Markdown text, without code blocks/spans. */
function relativeLinks(text) {
    const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    const links = [];
    const re = /!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
    let m;
    while ((m = re.exec(prose))) {
        const target = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('//')) continue;
        links.push(target);
    }
    return links;
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
        const text = '[a](docs/x.md) [b](https://e.com) [c](#top) `[d](no.md)`\n```\n[e](no2.md)\n```\n![img](i.png "t")';
        expect(relativeLinks(text)).toEqual(['docs/x.md', 'i.png']);
    });
});
