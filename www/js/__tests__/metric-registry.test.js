/**
 * Single home for every figure (docs/insights-redesign.md §6, AC13): a spec ID
 * is rendered as a value by one template only, its home; others link to it.
 */
import fs from 'fs';
import path from 'path';
import { METRICS, LEGACY_DUPLICATES, registryProblems, metricTags, unexplainedValues, renderedValueTags } from '../utils/metric-registry.js';

const ROOT = path.resolve(__dirname, '../../..');
const TEMPLATES = path.join(ROOT, 'www/templates');
const templates = fs.readdirSync(TEMPLATES).filter(f => f.endsWith('.html'));
const tagsByTemplate = Object.fromEntries(templates
    .filter(f => !LEGACY_DUPLICATES.includes(f))
    .map(f => [f, metricTags(fs.readFileSync(path.join(TEMPLATES, f), 'utf8'))]));

test('metricTags reads values, links and statement totals', () => {
    expect(metricTags('<b data-metric="M6"></b><a data-metric-ref="O4"></a><td data-metric-export="M1"></td>'))
        .toEqual([{ id: 'M6', kind: 'value' }, { id: 'O4', kind: 'ref' }, { id: 'M1', kind: 'export' }]);
});

test('registryProblems finds a figure rendered on two screens or away from its home', () => {
    expect(registryProblems({ 'money.html': [{ id: 'M6', kind: 'value' }], 'insights.html': [{ id: 'M6', kind: 'value' }] }))
        .toEqual(['insights.html: renders M6, whose home is money.html', 'M6 is rendered by money.html, insights.html']);
    expect(registryProblems({ 'insights.html': [{ id: 'M6', kind: 'ref' }], 'statements.html': [{ id: 'M6', kind: 'export' }] })).toEqual([]);
    expect(registryProblems({ 'x.html': [{ id: 'Z9', kind: 'ref' }] })).toEqual(['x.html: unknown metric Z9']);
});

test('no figure is rendered as a value by two templates (AC13)', () => {
    expect(registryProblems(tagsByTemplate)).toEqual([]);
});

test('every figure whose home page exists is rendered there', () => {
    const missing = Object.entries(METRICS)
        .filter(([id, m]) => /^[MI]/.test(id) && tagsByTemplate[m.home])
        .filter(([id, m]) => !tagsByTemplate[m.home].some(t => t.id === id && t.kind === 'value'))
        .map(([id]) => id);
    expect(missing).toEqual([]);
});

test('every registered figure has a spec entry and an oracle test', () => {
    const spec = fs.readFileSync(path.join(ROOT, 'docs/calculations.md'), 'utf8');
    const oracle = fs.readFileSync(path.join(ROOT, 'tests/oracle/business-metrics.test.js'), 'utf8');
    const noSpec = Object.keys(METRICS).filter(id => !new RegExp(`\\|\\s*${id}\\s*\\|`).test(spec));
    const noTest = Object.keys(METRICS).filter(id => /^[MI]/.test(id) && !new RegExp(`\\b${id}\\b`).test(oracle));
    expect({ noSpec, noTest }).toEqual({ noSpec: [], noTest: [] });
});

test('unexplainedValues finds a ₹ amount outside a tagged element; tagged, linked, takeaway, input, chart and caveat amounts are explained', () => {
    document.body.innerHTML = '<div id="p"><b data-metric="M6">₹100</b><span data-metric-ref="O4">₹5</span><p data-takeaway>Profit ₹100</p>'
        + '<i data-input>₹9</i><svg><title>₹3</title></svg><div class="ins-caveat">₹2</div><div hidden>₹8</div><em>retail ₹70</em></div>';
    const root = document.getElementById('p');
    expect(unexplainedValues(root)).toEqual(['retail ₹70']);
    expect(renderedValueTags(root)).toEqual([{ id: 'M6', kind: 'value' }]);
});
