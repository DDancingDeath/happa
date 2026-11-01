/**
 * @fileoverview Oracle for the Diagnostics speed score (docs/calculations.md DIAG-SCORE):
 * an independent count of the suspects on generated probes agrees with
 * utils/perf-probe.js analyseProbes.
 */
import fc from 'fast-check';
import { analyseProbes } from '../../www/js/utils/perf-probe.js';

function oracleScore(p) {
    let high = 0, med = 0, low = 0;
    for (const n of [p.purchases, p.retail, p.wholesale]) {
        if (n >= 3000) high++;
        else if (n >= 1500) med++;
    }
    if (p.items >= 800) med++;
    if (p.stock >= 1500) med++;
    if (p.memRatio >= 0.8) high++;
    else if (p.memUsed >= 250) med++;
    if (p.deviceGB > 0 && p.deviceGB <= 2) med++;
    if (!p.online || p.net === '2g' || p.net === 'slow-2g') high++;
    if (!p.swController) low++;
    if (p.loadMs >= 5000) med++;
    if (p.longTasks >= 8) high++;
    if (p.storageRatio >= 0.85) med++;
    return Math.max(0, 100 - 25 * high - 12 * med - 4 * low);
}

const probesOf = (p) => ({
    appState: {
        byName: {
            purchaseHistory: { count: p.purchases },
            retailSalesHistory: { count: p.retail },
            salesHistory: { count: p.wholesale },
            items: { count: p.items },
            stock: { count: p.stock }
        }
    },
    memory: { usedMB: p.memUsed, limitMB: 1000, usedRatio: p.memRatio },
    device: { deviceMemoryGB: p.deviceGB },
    network: { online: p.online, effectiveType: p.net },
    sw: { supported: true, hasController: p.swController },
    navigation: { pageLoadMs: p.loadMs },
    longTasks: { count: p.longTasks, totalMs: p.longTasks * 60 },
    storage: { usedRatio: p.storageRatio, usageMB: 1, quotaMB: 2 }
});

describe('DIAG-SCORE: speed score', () => {
    test('equals 100 minus 25/12/4 per high/medium/low suspect', () => {
        fc.assert(fc.property(fc.record({
            purchases: fc.integer({ min: 0, max: 4000 }),
            retail: fc.integer({ min: 0, max: 4000 }),
            wholesale: fc.integer({ min: 0, max: 4000 }),
            items: fc.integer({ min: 0, max: 1200 }),
            stock: fc.integer({ min: 0, max: 2000 }),
            memUsed: fc.integer({ min: 0, max: 400 }),
            memRatio: fc.double({ min: 0, max: 1, noNaN: true }),
            deviceGB: fc.constantFrom(0, 1, 2, 4, 8),
            online: fc.boolean(),
            net: fc.constantFrom('4g', '3g', '2g', 'slow-2g'),
            swController: fc.boolean(),
            loadMs: fc.integer({ min: 0, max: 9000 }),
            longTasks: fc.integer({ min: 0, max: 15 }),
            storageRatio: fc.double({ min: 0, max: 1, noNaN: true })
        }), (p) => {
            expect(analyseProbes(probesOf(p)).score).toBe(oracleScore(p));
        }), { numRuns: 200, seed: 119 });
    });
});
