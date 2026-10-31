/**
 * @fileoverview Every figure on the three bill forms (purchase, retail sale,
 * wholesale sale) while a bill is being entered, the payment split and its
 * checks, and the money fields of the bill they save (docs/calculations.md
 * BF-KG … BF-SAVE, WS-PROFIT, WS-MARGIN, DUE-CHECK). Pure: no DOM, no AppState,
 * no Firestore. modules/purchase.js, retail-sale.js and wholesale-sales.js read
 * the inputs, call these and render the result.
 *
 * Rounding is exactly what the forms did before this module existed. Each
 * choice is a named policy in ROUNDING, so the owner's answer to #129 (F-R1:
 * whole-rupee lines vs paise) is a change in this file only.
 * @module utils/calc/billing
 */

import { normalizeLabourSettings, readLineItem, round2, toMoney } from '../money.js';

/** How each rounding policy rounds a value. */
const ROUNDERS = Object.freeze({
    rupee: (x) => Math.round(x),
    paise: (x) => round2(x),
    tenthOfPercent: (ratio) => Math.round(ratio * 1000) / 10
});

/**
 * Rounding policy per figure (#129 open; recorded, not decided, here).
 * rupee = whole rupees (Math.round), paise = 2 decimals (round2),
 * tenthOfPercent = a ratio as a percentage with one decimal.
 */
export const ROUNDING = Object.freeze({
    /** BF-LINE: qty × rate of a new line (12.4 kg × ₹33.50 = ₹415). */
    lineAmount: 'rupee',
    /** BF-TOTAL / BF-PAYABLE as saved: Σ lines, labour, total − labour, wholesale cost and profit. */
    billTotal: 'paise',
    /** BF-SAVE: each typed cash / online / due / expenses amount, and payment.total. */
    payment: 'paise',
    /** BF-FILL: Rest → Due (total − cash − online). */
    restInDue: 'paise',
    /** BF-FILL: ticking Cash / Online / Due fills the whole total (₹988 for ₹987.50). */
    tickFill: 'rupee',
    /** BF-LAB: auto labour written in the Labour box (rate × heavy packets). */
    autoLabourBox: 'rupee',
    /** Amounts shown on the forms: lines, totals, payable, paid / received, live profit. */
    shown: 'rupee',
    /** WS-MARGIN: profit ÷ total. */
    margin: 'tenthOfPercent'
});

/**
 * Round a value the way ROUNDING says for that figure.
 * @param {keyof ROUNDING} figure
 * @param {number} value
 * @returns {number}
 */
export function roundFor(figure, value) {
    return ROUNDERS[ROUNDING[figure]](value);
}

/** Σ of money values (absent / unparseable = 0), unrounded. */
const moneySum = (list, valueOf) => list.reduce((total, x) => total + (toMoney(valueOf(x)) || 0), 0);

/**
 * Σ of `line.total` exactly as the forms add it for the on-screen total and the
 * WhatsApp text: plain JS addition, no paise rounding (the saved total is BF-TOTAL).
 * @param {Object[]} lines
 * @returns {number}
 */
export function draftLineSum(lines) {
    return (lines || []).reduce((sum, item) => sum + item.total, 0);
}

/**
 * BF-KG: kg of the packets weighed so far (plain sum).
 * @param {number[]} weights
 * @returns {number}
 */
export function sumWeights(weights) {
    return (weights || []).reduce((sum, w) => sum + w, 0);
}

/**
 * BF-KG, BF-LINE: one bill line from its rate and either its packet weights
 * (purchase, retail) or its kg (wholesale).
 * @param {{rate: number, weights?: number[], qty?: number}} entry
 * @returns {{qty: number, packets: number, total: number}} total in ROUNDING.lineAmount
 */
export function computeLine({ rate, weights, qty }) {
    const kg = Array.isArray(weights) ? sumWeights(weights) : qty;
    return {
        qty: kg,
        packets: Array.isArray(weights) ? weights.length : 0,
        total: roundFor('lineAmount', kg * rate)
    };
}

/**
 * BF-KG: the packet weights to put back when a retail line is edited: its own
 * weights, else its kg split evenly over its packets, else its kg as one packet.
 * @param {{qty?: number, packets?: number, weights?: number[]}} line
 * @returns {number[]}
 */
export function weightsForEdit(line) {
    if (line.qty && line.packets) {
        if (line.weights && line.weights.length > 0) return [...line.weights];
        return Array(line.packets).fill(line.qty / line.packets);
    }
    return [line.qty];
}

/**
 * BF-TOTAL, BF-PAYABLE: purchase totals from the lines (never from the screen).
 * @param {Array<Object>} items - bill lines ({ total, weights })
 * @param {number} laborCharges - labour deducted from the line total (0 when Labour is unticked)
 * @param {number} [heavyWeightThreshold=30] - packets heavier than this (kg) count as heavy (BF-LAB)
 * @returns {{billTotal: number, laborCharges: number, grandTotal: number, totalPackets: number, heavyPackets: number}}
 */
export function computePurchaseTotals(items, laborCharges = 0, heavyWeightThreshold = 30) {
    const list = Array.isArray(items) ? items : [];
    const billTotal = roundFor('billTotal', moneySum(list, item => readLineItem(item).total));
    let totalPackets = 0;
    let heavyPackets = 0;
    for (const item of list) {
        const weights = Array.isArray(item?.weights) ? item.weights : [];
        totalPackets += weights.length;
        heavyPackets += weights.filter(w => Number(w) > heavyWeightThreshold).length;
    }
    const labour = roundFor('billTotal', toMoney(laborCharges) || 0);
    return { billTotal, laborCharges: labour, grandTotal: roundFor('billTotal', billTotal - labour), totalPackets, heavyPackets };
}

/**
 * BF-LAB: labour the purchase form suggests: the shared labour rate × heavy packets.
 * @param {Object} settings - labour settings (laborRate; blank / invalid → ₹6)
 * @param {number} heavyPackets
 * @returns {{rate: number, heavyPackets: number, amount: number, box: number, working: string}}
 *   box = what goes in the Labour box (ROUNDING.autoLabourBox); working = "6 × 2"
 */
export function autoLabour(settings, heavyPackets) {
    const { laborRate } = normalizeLabourSettings(settings);
    const amount = laborRate * heavyPackets;
    return { rate: laborRate, heavyPackets, amount, box: roundFor('autoLabourBox', amount), working: `${laborRate} × ${heavyPackets}` };
}

/**
 * BF-PAYABLE as shown on the purchase form: line total less the labour in the
 * box, in ROUNDING.shown (the saved `grandTotal` is computePurchaseTotals').
 * @param {number} billTotal
 * @param {number} labour - the Labour box (0 when unticked)
 * @returns {number}
 */
export function payableOnScreen(billTotal, labour) {
    return roundFor('shown', billTotal - labour);
}

/**
 * BF-TOTAL of a retail sale: the saved total (paise) and what the form shows
 * (plain sum of the lines, see draftLineSum), packets and kg.
 * @param {Object[]} items - sale lines ({ total, qty, packets })
 * @returns {{total: number, screenTotal: number, packetsShown: number, packetsSaved: number, kg: number, lines: number}}
 *   packetsShown counts a line without packets as 1 (bill table); packetsSaved as 0 (saved `totalPackets`)
 */
export function computeRetailTotals(items) {
    const list = Array.isArray(items) ? items : [];
    return {
        total: roundFor('billTotal', moneySum(list, item => item.total)),
        screenTotal: draftLineSum(list),
        packetsShown: list.reduce((sum, item) => sum + (item.packets || 1), 0),
        packetsSaved: list.reduce((sum, item) => sum + (item.packets || 0), 0),
        kg: list.reduce((sum, item) => sum + item.qty, 0),
        lines: list.length
    };
}

/**
 * WS-COST: the average cost per kg of a wholesale line's item in stock: by its
 * itemId, else the catalogue item with that id or name / Hindi name (as the stock
 * replay maps names); null when no stock entry has a rate (never purchased, no
 * opening stock, or an unknown item).
 * @param {Object} line - ({ itemId, name })
 * @param {Object} stock - AppState.stock ({ [itemId|name]: { rate } })
 * @param {Object[]} [catalogue] - AppState.items
 * @returns {?number}
 */
export function wholesaleCostRate(line, stock = {}, catalogue = []) {
    const norm = (s) => String(s ?? '').trim().toLowerCase();
    const name = norm(readLineItem(line).name);
    const item = (catalogue || []).find(i => i && ((line?.itemId && i.id === line.itemId)
        || (name && (norm(i.name) === name || norm(i.hindiName) === name)))) || null;
    for (const key of [line?.itemId, item?.id, item?.name, readLineItem(line).name, name]) {
        if (!key) continue;
        const rate = toMoney(stock?.[key]?.rate);
        if (rate && rate > 0) return rate;
    }
    return null;
}

/**
 * BF-TOTAL, WS-PROFIT, WS-MARGIN: wholesale total, cost (qty × the item's
 * current average rate in stock, WS-COST), profit and margin. When a line's
 * cost is not known the profit is not known either (#102): profit and margin
 * are null and `unknownCost` lists those lines (cost then counts the known lines).
 * @param {Array<Object>} items - sale lines ({ itemId, qty|quantity, total })
 * @param {Object} stock - AppState.stock ({ [itemId]: { rate } })
 * @param {number} [expenses=0]
 * @param {Object[]} [catalogue] - AppState.items, to find a line's stock by name
 * @returns {{total: number, cost: number, profit: ?number, profitPercent: ?number, unknownCost: number[]}}
 */
export function computeWholesaleTotals(items, stock = {}, expenses = 0, catalogue = []) {
    const list = Array.isArray(items) ? items : [];
    const total = roundFor('billTotal', moneySum(list, item => readLineItem(item).total));
    const unknownCost = [];
    const cost = roundFor('billTotal', moneySum(list.map((item, i) => {
        const rate = wholesaleCostRate(item, stock, catalogue);
        if (rate === null) unknownCost.push(i);
        return rate === null ? 0 : rate * readLineItem(item).qty;
    }), x => x));
    if (unknownCost.length) return { total, cost, profit: null, profitPercent: null, unknownCost };
    const profit = roundFor('billTotal', total - cost - (toMoney(expenses) || 0));
    const profitPercent = total > 0 ? roundFor('margin', profit / total) : 0;
    return { total, cost, profit, profitPercent, unknownCost };
}

/**
 * WS-PROFIT, WS-MARGIN as the wholesale form shows them while the bill is entered.
 * @param {Array<Object>} items
 * @param {Object} stock
 * @param {number} [expenses=0]
 * @param {Object[]} [catalogue]
 * @returns {{total: number, cost: number, profit: ?number, profitPercent: ?number, unknownCost: number[], shownProfit: ?number}}
 *   shownProfit in ROUNDING.shown (also the WhatsApp text's profit); null when a cost is unknown
 */
export function wholesaleLiveProfit(items, stock, expenses = 0, catalogue = []) {
    const totals = computeWholesaleTotals(items, stock, expenses, catalogue);
    return { ...totals, shownProfit: totals.profit === null ? null : (roundFor('shown', totals.profit) || 0) };
}

/**
 * Amount as the forms show it (ROUNDING.shown).
 * @param {number} value
 * @returns {number}
 */
export function shownAmount(value) {
    return roundFor('shown', value);
}

/**
 * A typed money amount (cash, online, due, wholesale expenses) as saved (ROUNDING.payment).
 * @param {number} value
 * @returns {number}
 */
export function typedAmount(value) {
    return roundFor('payment', value);
}

/**
 * BF-SAVE: the typed cash / online / due, each in ROUNDING.payment.
 * @param {{online: number, cash: number, due: number}} typed
 * @returns {{online: number, cash: number, due: number}}
 */
export function paymentSplit({ online, cash, due }) {
    return { online: typedAmount(online), cash: typedAmount(cash), due: typedAmount(due) };
}

/**
 * BF-PAID: "Total paid / received" on the form: cash + online, as shown.
 * @param {{online: number, cash: number}} split
 * @returns {number}
 */
export function paidOnScreen(split) {
    return shownAmount(split.online + split.cash);
}

/**
 * BF-SAVE: the bill's `payment` object.
 * @param {{online: number, cash: number, due: number}} split - from paymentSplit()
 * @returns {{online: number, cash: number, due: number, total: number}}
 */
export function buildPaymentSplit({ online, cash, due }) {
    return { online, cash, due, total: roundFor('payment', online + cash + due) };
}

/**
 * BF-FILL: ticking Online, Cash or Due puts the whole total in that box and 0 in the others.
 * @param {'online'|'cash'|'due'} type
 * @param {number} total - bill total
 * @returns {{online: (number|string), cash: (number|string), due: (number|string)}} box values
 */
export function prefillPayment(type, total) {
    const fill = roundFor('tickFill', total);
    return {
        online: type === 'online' ? fill : '0',
        cash: type === 'cash' ? fill : '0',
        due: type === 'due' ? fill : '0'
    };
}

/** BF-SPLIT: allowed gap (₹) between cash + online + due and the bill total. */
export const SPLIT_TOLERANCE = 1;

/**
 * BF-SPLIT: cash + online + due adds up to the bill total (within ₹1).
 * @param {number} total - bill total
 * @param {{cash?: number, online?: number, due?: number}} split
 * @returns {{ok: boolean, entered: number, difference: number}} difference = total − entered
 *   (positive: amount still to allocate; negative: entered too much)
 */
export function validatePaymentSplit(total, { cash = 0, online = 0, due = 0 } = {}) {
    const entered = round2((toMoney(cash) || 0) + (toMoney(online) || 0) + (toMoney(due) || 0));
    const difference = round2((toMoney(total) || 0) - entered);
    return { ok: Math.abs(difference) <= SPLIT_TOLERANCE, entered, difference };
}

/**
 * BF-FILL: Rest → Due puts what is not paid yet (total − cash − online) in Due.
 * @param {number} total - bill total
 * @param {{cash: number, online: number}} split
 * @returns {{ok: true, due: number, dueTicked: boolean}|{ok: false, check: Object}}
 *   not ok when more than the total is paid already (check: validatePaymentSplit's result)
 */
export function restInDue(total, { cash, online }) {
    const rest = roundFor('restInDue', total - cash - online);
    if (rest < 0) return { ok: false, check: validatePaymentSplit(total, { cash, online }) };
    return { ok: true, due: rest, dueTicked: rest > 0 };
}

/**
 * DUE-CHECK: the cash / online of a due payment against the bill's due.
 * @param {*} cash
 * @param {*} online
 * @param {number} due
 * @param {number} [tolerance=0.01]
 * @returns {{ok: true, cash: number, online: number, total: number}|{ok: false, error: 'negative'|'empty'|'exceeds-due'}}
 */
export function validateDuePayment(cash, online, due, tolerance = 0.01) {
    const c = round2(Number(cash) || 0);
    const o = round2(Number(online) || 0);
    if (c < 0 || o < 0) return { ok: false, error: 'negative' };
    const total = round2(c + o);
    if (total <= 0) return { ok: false, error: 'empty' };
    if (total > due + tolerance) return { ok: false, error: 'exceeds-due' };
    return { ok: true, cash: c, online: o, total };
}

/** Function → its spec IDs in docs/calculations.md. */
export const BILLING_SPEC = Object.freeze({
    sumWeights: 'BF-KG',
    computeLine: 'BF-KG, BF-LINE',
    weightsForEdit: 'BF-KG',
    draftLineSum: 'BF-TOTAL',
    computePurchaseTotals: 'BF-TOTAL, BF-LAB, BF-PAYABLE',
    autoLabour: 'BF-LAB',
    payableOnScreen: 'BF-PAYABLE',
    computeRetailTotals: 'BF-TOTAL',
    computeWholesaleTotals: 'BF-TOTAL, WS-PROFIT, WS-MARGIN',
    wholesaleCostRate: 'WS-COST',
    wholesaleLiveProfit: 'WS-PROFIT, WS-MARGIN',
    paymentSplit: 'BF-SAVE',
    paidOnScreen: 'BF-PAID',
    buildPaymentSplit: 'BF-SAVE',
    prefillPayment: 'BF-FILL',
    restInDue: 'BF-FILL',
    validatePaymentSplit: 'BF-SPLIT',
    validateDuePayment: 'DUE-CHECK'
});
