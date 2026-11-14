/**
 * @jest-environment node
 */
/**
 * Billing's script output (redesign 3.3): bill lines, weights, the drafts sheet, the mode
 * buttons and the bill checks are drawn with classes and tones (.tone-neg …), so every theme
 * and mode restyles them. No colour in these
 * scripts: no hex / rgb() / hsl(), no colour in an inline style, no colour set through
 * `.style`. Print and receipts are drawn elsewhere (services/printer.js, receipt-drawing.js).
 */
const fs = require('fs');
const path = require('path');

const JS = path.join(__dirname, '..', '..', 'www', 'js');
const FILES = [
    'modules/billing.js', 'modules/purchase.js', 'modules/retail-sale.js',
    ...fs.readdirSync(path.join(JS, 'ui')).filter(f => /^bill-.*\.js$/.test(f)).map(f => `ui/${f}`),
    ...fs.readdirSync(path.join(JS, 'utils')).filter(f => /^bill-.*\.js$/.test(f)).map(f => `utils/${f}`),
];

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
const RULES = [
    ['a hex colour', /(?<![\w&#-])#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})(?![\w-])/gi],
    ['an rgb()/hsl() colour', /(?<![\w-])(?:rgba?|hsla?)\(/gi],
    ['a colour in an inline style', /style=\\?["'][^"']*(?:color|background|border(?:-[a-z]+)?|outline|fill|stroke)\s*:/gi],
    ['a colour set through .style', /\.style\.(?:color|background\w*|border\w*|outline\w*|fill|stroke|boxShadow)\s*=\s*(?!['"`]{2})['"`]/g],
];

test.each(FILES)('%s writes no colours', (file) => {
    const src = stripComments(fs.readFileSync(path.join(JS, file), 'utf8'));
    const found = RULES.flatMap(([what, re]) => (src.match(re) || []).map(m => `${what}: ${m}`));
    expect(found).toEqual([]);
});
