/**
 * @fileoverview Single home for every figure (docs/insights-redesign.md §6).
 * Each spec ID is rendered as a value (`data-metric="ID"`) by exactly one
 * screen, its home template; other screens may only link to it
 * (`data-metric-ref="ID"`), or show it as a document total
 * (`data-metric-export="ID"`, Statements). Checked by metric-registry.test.js.
 * @module utils/metric-registry
 */

/** spec ID → { home: template file (www/templates), section: route } */
export const METRICS = Object.freeze({
    M1: { home: 'money.html', section: 'money-profit' },
    M2: { home: 'money.html', section: 'money-profit' },
    M3: { home: 'money.html', section: 'money-profit' },
    M4: { home: 'money.html', section: 'money-spending' },
    M5: { home: 'money.html', section: 'money-profit' },
    M6: { home: 'money.html', section: 'money-profit' },
    M7: { home: 'money.html', section: 'money-profit' },
    M8: { home: 'money.html', section: 'money-spending' },
    M9: { home: 'money.html', section: 'money-spending' },
    M10: { home: 'money.html', section: 'money-spending' },
    M11: { home: 'money.html', section: 'money-profit' },
    M12: { home: 'money.html', section: 'money-cash' },
    M13: { home: 'money.html', section: 'money-cash' },
    M14: { home: 'money.html', section: 'money-cash' },
    M15: { home: 'money.html', section: 'money-worth' },
    M16: { home: 'money.html', section: 'money-profit' },
    M17: { home: 'money.html', section: 'money-profit' },
    I1: { home: 'insights.html', section: 'insights-items' },
    I2: { home: 'insights.html', section: 'insights-items' },
    I3: { home: 'insights.html', section: 'insights-parties' },
    I4: { home: 'insights.html', section: 'insights-parties' },
    I5: { home: 'insights.html', section: 'insights-seasons' },
    I7: { home: 'insights.html', section: 'insights-actions' },
    I8: { home: 'insights.html', section: 'insights-actions' },
    I9: { home: 'insights.html', section: 'insights-actions' },
    S4: { home: 'stock.html', section: 'stock' },
    O3: { home: 'outstanding.html', section: 'outstanding' },
    O4: { home: 'outstanding.html', section: 'outstanding' }
});

/**
 * Templates that still repeat figures until the redesign's last phase removes
 * them (docs/insights-redesign.md §10). Empty once Finance, Reports and
 * Analytics are gone.
 */
export const LEGACY_DUPLICATES = Object.freeze(['finance.html', 'reports.html', 'analytics.html']);

/**
 * Problems with the values found in templates.
 * @param {Object<string, Array<{id: string, kind: 'value'|'ref'|'export'}>>} byTemplate file → metric tags
 * @param {Object} [metrics=METRICS]
 * @returns {string[]} human-readable problems; [] when every figure has one home
 */
export function registryProblems(byTemplate, metrics = METRICS) {
    const problems = [];
    const valueHomes = new Map();
    Object.entries(byTemplate).forEach(([file, tags]) => {
        tags.forEach(({ id, kind }) => {
            if (!metrics[id]) { problems.push(`${file}: unknown metric ${id}`); return; }
            if (kind !== 'value') return;
            if (metrics[id].home !== file) problems.push(`${file}: renders ${id}, whose home is ${metrics[id].home}`);
            const set = valueHomes.get(id) || new Set();
            set.add(file);
            valueHomes.set(id, set);
        });
    });
    valueHomes.forEach((files, id) => {
        if (files.size > 1) problems.push(`${id} is rendered by ${[...files].join(', ')}`);
    });
    return problems;
}

/**
 * Metric tags in one template's HTML.
 * @param {string} html
 * @returns {Array<{id: string, kind: 'value'|'ref'|'export'}>}
 */
export function metricTags(html) {
    const out = [];
    const re = /data-metric(-ref|-export)?="([A-Z]+\d+)"/g;
    let m;
    while ((m = re.exec(String(html)))) out.push({ id: m[2], kind: m[1] === '-ref' ? 'ref' : m[1] === '-export' ? 'export' : 'value' });
    return out;
}
