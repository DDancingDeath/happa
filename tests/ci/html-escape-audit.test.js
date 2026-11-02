/**
 * @jest-environment node
 */
const { auditSource, compare } = require('../../scripts/html-escape-audit.js');

const audit = (src) => auditSource(src, 'probe.js');

// Each probe puts attacker-controlled text into HTML; the audit must list at least one line.
const HOSTILE = {
    'tag template': 'el.innerHTML = `<b>${party.name}</b>`;',
    'template without tags at innerHTML': 'el.innerHTML = `${party.name}`;',
    'template without tags at insertAdjacentHTML': "el.insertAdjacentHTML('beforeend', `${party.name} `);",
    '+= into a variable later given to innerHTML': "let h = ''; for (const r of rows) h += r.name; el.innerHTML = h;",
    '+= of a tagless template into a variable named html': "let html = '<ul>'; html += `${r.name}`; el.innerHTML = html;",
    "['innerHTML']": "el['innerHTML'] = party.name;",
    'block-body map().join()': "el.innerHTML = rows.map(r => { const n = r.name; return n; }).join('<br>');",
    'block-body filter().join()': "function f(el, names) { el.innerHTML = names.filter(n => { return n.length > 0; }).join(', '); }",
    'a name that sounds safe (…Html), assigned user text': 'const userHtml = user.displayName; el.innerHTML = `<p>${userHtml}</p>`;',
    'a parameter that sounds numeric': 'function show(el, totalAmount) { el.innerHTML = `<td>${totalAmount}</td>`; }',
    'an imported render…() call': "import { renderRow } from './x.js'; el.innerHTML = renderRow(r);",
    'href escaped but not a safe URL': 'el.innerHTML = `<a href="${esc(link)}">open</a>`;',
    'href in a concatenation': "el.innerHTML = '<a href=\"' + esc(link) + '\">open</a>';",
    't() with parameters': "el.innerHTML = `<p>${t('ui.x', { name: party.name })}</p>`;",
    'document.write of a tagless template': 'document.write(`${party.name}`);'
};

// The same shapes written safely: nothing to list.
const SAFE = {
    'escaped tag template': 'el.innerHTML = `<b>${esc(party.name)}</b>`;',
    'escaped += build': "let h = ''; for (const r of rows) h += Helpers.escapeHtml(r.name); el.innerHTML = h;",
    'block-body map of escaped markup': "el.innerHTML = rows.map(r => { const n = esc(r.name); return `<li>${n}</li>`; }).join('');",
    'local helper returning escaped text': 'const cell = (v) => `<td>${esc(v)}</td>`; el.innerHTML = `<tr>${cell(r.name)}</tr>`;',
    'href through safeUrl': 'el.innerHTML = `<a href="${Helpers.safeUrl(link)}">open</a>`;',
    'reviewed name (length)': 'el.innerHTML = `<b>${rows.length}</b>`;',
    'textContent is not a sink': 'el.textContent = party.name;'
};

describe('html-escape-audit', () => {
    test('there are 15 hostile probes', () => expect(Object.keys(HOSTILE)).toHaveLength(15));

    test.each(Object.entries(HOSTILE))('lists %s', (_, src) => {
        expect(audit(src).length).toBeGreaterThan(0);
    });

    test.each(Object.entries(SAFE))('does not list %s', (_, src) => {
        expect(audit(src)).toEqual([]);
    });

    test('an href value is listed as a url line', () => {
        expect(audit(HOSTILE['href escaped but not a safe URL'])).toEqual(['probe.js:1: esc(link) (url)']);
    });

    test('names are trusted only through the allow-list', () => {
        const src = 'function f(el, rowsHtml) { el.innerHTML = `<div>${rowsHtml}</div>`; }';
        expect(audit(src)).toHaveLength(1);
        expect(auditSource(src, 'probe.js', { names: { rowsHtml: 'reviewed' } })).toEqual([]);
    });

    test('calls to a local function whose parameter reaches a sink are sinks too', () => {
        const src = [
            'const set = (id, html) => { document.getElementById(id).innerHTML = html; };',
            "set('a', party.name);",
            "set('b', `<i>${esc(x)}</i>`);",
            "const page = { html(id, v) { el.innerHTML = v; }, render() { this.html('k', user.name); } };"
        ].join('\n');
        expect(audit(src).sort()).toEqual([
            'probe.js:1: html (sink)', 'probe.js:2: party.name (sink via set)', 'probe.js:4: user.name (sink via this.html)', 'probe.js:4: v (sink)'
        ]);
    });

    test('a new caller of a function that builds markup from its parameter is a new line', () => {
        const before = "const block = (title) => `<h4>${title}</h4>`; el.innerHTML = block(L('ui.x'));";
        const after = `${before} el.innerHTML += block(party.name);`;
        expect(audit(before)).toEqual(['probe.js:1: title']);
        expect(compare(audit(after), audit(before).map(h => h.replace(/:\d+:/, ':'))).added)
            .toEqual(['probe.js:1: party.name (markup via block)']);
    });

    test.each([
        ['a method of another object with the same name', "const store = { get(k) { return 0; } }; el.innerHTML = `<b>${params.get('n')}</b>`;"],
        ['||=', "let h = ''; h ||= party.name; el.innerHTML = h;"],
        ['a destructuring assignment', "let h = ''; ({ h } = party); el.innerHTML = h;"],
        ['an array index write', "const parts = []; parts[0] = party.name; el.innerHTML = parts.join('');"],
        ['for…of into an existing variable', "let h = ''; for (h of names) {} el.innerHTML = h;"],
        ['toLocaleString on text', 'el.innerHTML = `<b>${party.name.toLocaleString()}</b>`;'],
        ['t() with a key from data', 'el.innerHTML = `<b>${t(party.name)}</b>`;'],
        ['a variable named length', 'const length = party.name; el.innerHTML = `<b>${length}</b>`;'],
        ['el[`innerHTML`]', 'el[`innerHTML`] = party.name;']
    ])('lists %s', (_, src) => {
        expect(audit(src).length).toBeGreaterThan(0);
    });

    test.each([
        ['a caller of a helper with a default-valued parameter', "const block = (title = '') => `<h4>${title}</h4>`; el.innerHTML = block(party.name);", 'party.name (markup via block)'],
        ['a caller of a helper with a destructured parameter', 'const card = ({ title }) => `<h4>${title}</h4>`; el.innerHTML = card({ title: party.name });', 'party.name (markup via card)'],
        ['a caller of a helper with a rest parameter', "const row = (...cells) => `<tr>${cells.join('')}</tr>`; el.innerHTML = row('a', party.name);", 'party.name (markup via row)'],
        ['a caller of a helper that puts its parameter in an href', 'const link = (u) => `<a href="${u}">x</a>`; el.innerHTML = link(party.url);', 'party.url (url via link)'],
        ['Exporter.printPage html', "Exporter.printPage({ title: 'x', html: row.note });", 'row.note (sink)'],
        ['a caller of a private method that writes innerHTML', 'class P { #show(v) { el.innerHTML = v; } go() { this.#show(party.name); } }', 'party.name (sink via this.#show)'],
        ['a list handed to .map(helper)', 'const row = (p) => `<tr id="${p}"></tr>`; el.innerHTML = party.tags.map(row).join(\'\');', 'party.tags (markup via map(row))'],
        ['an href in a conditional tagless template', 'el.innerHTML = `<a class="x"${link ? ` href="${esc(link)}"` : \'\'}>open</a>`;', 'esc(link) (url)'],
        ['an href in a conditional concatenation', "el.innerHTML = '<a' + (link ? ' href=\"' + esc(link) + '\"' : '') + '>open</a>';", 'esc(link) (url (concatenated))']
    ])('lists %s', (_, src, line) => {
        expect(audit(src)).toContain(`probe.js:1: ${line}`);
    });

    test('the same value twice on one line counts twice', () => {
        expect(audit('el.innerHTML = `<b>${p.name}</b><i>${p.name}</i>`;')).toEqual(['probe.js:1: p.name', 'probe.js:1: p.name']);
    });

    test('this.m() and X.m() follow the method defined on that object', () => {
        expect(audit("const page = { n() { return 1; }, r() { el.innerHTML = `<b>${this.n()}${page.n()}</b>`; } };")).toEqual([]);
    });

    test('the baseline check ignores moved lines and fails on new or extra ones', () => {
        const baseline = ['a.js: name', 'a.js: name', 'b.js: x (sink)'];
        expect(compare(['a.js:40: name', 'a.js:90: name', 'b.js:3: x (sink)'], baseline)).toEqual({ added: [], gone: [] });
        expect(compare(['a.js:1: name', 'a.js:2: name', 'a.js:3: name'], baseline).added).toEqual(['a.js:3: name']);
        expect(compare(['a.js:1: name'], baseline).gone).toEqual(['a.js: name', 'b.js: x (sink)']);
    });
});
