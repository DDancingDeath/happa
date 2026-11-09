'use strict';
/**
 * Sample shop data for the DEV project only (bahi-happa-dev, #72). Fixed ids
 * (sample_*) so loading twice overwrites instead of duplicating.
 */

const DAY = 86400000;

function assertDevProject(projectId) {
    if (typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,28}-dev$/.test(projectId)) {
        throw new Error(`Refusing to load sample data into "${projectId}": only a *-dev project may get it.`);
    }
    return projectId;
}

const ITEMS = [
    { id: 'sample_rice', name: 'Rice', hindiName: 'चावल', rates: [30], saleRates: [36], wholesaleRates: [34] },
    { id: 'sample_wheat', name: 'Wheat', hindiName: 'गेहूं', rates: [22], saleRates: [26], wholesaleRates: [25] },
    { id: 'sample_maize', name: 'Maize', hindiName: 'मक्का', rates: [20], saleRates: [25], wholesaleRates: [23] },
    { id: 'sample_mustard', name: 'Mustard', hindiName: 'सरसों', rates: [55], saleRates: [62], wholesaleRates: [60] }
];

function bill(type, id, daysAgo, item, qty, rate, paid, customerName, now) {
    const t = now - daysAgo * DAY;
    const total = qty * rate;
    const due = total - paid;
    return {
        id, billNumber: id.toUpperCase(), timestamp: t, date: new Date(t).toISOString(),
        items: [{ itemId: item.id, name: item.name, qty, rate, total, weights: [qty] }],
        billTotal: total, laborCharges: 0, grandTotal: total, amountPayable: total, totalPackets: 1,
        cashPayment: paid, onlinePayment: 0, dueAmount: due,
        payment: { cash: paid, online: 0, due, total },
        customerName, type, isPurchase: type === 'purchase',
        userName: 'Sample', clientVersion: 3, openDue: due > 0, sample: true
    };
}

/** [[collection, id, data], ...] relative to `now` (ms). */
function sampleDocs(now = Date.now(), prefix = '') {
    const [rice, wheat, , mustard] = ITEMS;
    const docs = [
        ...ITEMS.map((i) => ['items', i.id, { ...i }]),
        ['purchases', 'sample_p1', bill('purchase', 'sample_p1', 3, wheat, 100, 22, 2200, 'Ramesh (sample)', now)],
        ['purchases', 'sample_p2', bill('purchase', 'sample_p2', 1, mustard, 40, 55, 1000, 'Suresh (sample)', now)],
        ['retailSales', 'sample_r1', bill('retail', 'sample_r1', 2, rice, 5, 36, 180, 'Walk-in (sample)', now)],
        ['wholesaleSales', 'sample_w1', bill('wholesale', 'sample_w1', 1, wheat, 50, 25, 1000, 'Mohan Traders (sample)', now)]
    ];
    return docs.map(([c, id, data]) => [prefix + c, id, data]);
}

module.exports = { assertDevProject, sampleDocs, ITEMS };
