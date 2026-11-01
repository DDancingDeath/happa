/**
 * @fileoverview Every figure on the three bill forms (purchase, retail sale,
 * wholesale sale) while a bill is being entered, the payment split and its
 * checks, and the money fields of the bill they save (docs/calculations.md
 * BF-KG … BF-SAVE, WS-PROFIT, WS-MARGIN, DUE-CHECK). Pure: no DOM, no AppState,
 * no Firestore. modules/purchase.js, retail-sale.js and wholesale-sales.js read
 * the inputs, call these and render the result.
 *
 * Rounding (#129, owner decision 2026-11-01: "rate will have paise, total will
 * not, it will be rounded"): rates and kg keep their decimals; every money
 * amount the app saves is a whole rupee, rounded half-up. Each choice is a named
 * policy in ROUNDING, the one switch for it (docs/calculations.md MONEY-ROUND).
 * @module utils/calc/billing
 */

import { billLabour, billTotal, normalizeLabourSettings, readLineItem, readPayment, round2, toMoney } from '../money.js';

/**
 * How each rounding policy rounds a value. rupee is half-up on the amount in
 * paise, so 0.7 kg × ₹45 (31.499999999999996 in floating point) is ₹32; never -0.
 */
const ROUNDERS = Object.freeze({
    rupee: (x) => Math.round(round2(x)) || 0,
    paise: (x) => round2(x),
    tenthOfPercent: (ratio) => Math.round(ratio * 1000) / 10
});

/**
 * Rounding policy per figure (MONEY-ROUND; #129 decided: money amounts are whole
 * rupees, rates and kg are never rounded here).
 * rupee = whole rupees, half-up; paise = 2 decimals (round2);
 * tenthOfPercent = a ratio as a percentage with one decimal.
 */
export const ROUNDING = Object.freeze({
    /** BF-LINE: qty × rate of a new line (12.4 kg × ₹33.50 = ₹415). */
    lineAmount: 'rupee',
    /** BF-TOTAL / BF-PAYABLE as saved: Σ lines, total − labour, wholesale cost and profit. */
    billTotal: 'rupee',
    /** BF-LAB as saved: the Labour box, typed or suggested (₹12.50 → ₹13, so ₹1,000 of lines pay ₹987). */
    labour: 'rupee',
    /** BF-SAVE, DUE-CHECK: each typed cash / online / due / wholesale expenses amount, and payment.total. */
    payment: 'rupee',
    /** BF-FILL: Rest → Due (total − cash − online). */
    restInDue: 'rupee',
    /** BF-FILL: ticking Cash / Online / Due fills the whole total. */
    tickFill: 'rupee',
    /** MONEY-ROUND: an expense, withdrawal, cash deposit or "No bill" amount as saved. */
    entryAmount: 'rupee',
    /** RENT-7: a sub-meter bill's amount (units × rate per unit). */
    meterAmount: 'rupee',
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
    const labour = roundFor('labour', toMoney(laborCharges) || 0);
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
 * box as it is saved (ROUNDING.labour), in ROUNDING.shown: the same figure as
 * the saved `grandTotal` (computePurchaseTotals') and the Cash / Online / Due tick.
 * @param {number} billTotal
 * @param {number} labour - the Labour box (0 when unticked)
 * @returns {number}
 */
export function payableOnScreen(billTotal, labour) {
    return roundFor('shown', billTotal - roundFor('labour', toMoney(labour) || 0));
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
    const profit = roundFor('billTotal', total - cost - roundFor('payment', toMoney(expenses) || 0));
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
 * MONEY-ROUND: an expense, withdrawal, cash deposit or "No bill" amount as it
 * is saved (ROUNDING.entryAmount); unparseable → 0.
 * @param {*} value
 * @returns {number}
 */
export function entryAmount(value) {
    return roundFor('entryAmount', Number(value) || 0);
}

/**
 * RENT-7: a sub-meter bill's amount, units × rate per unit, in
 * ROUNDING.meterAmount (the rules accept it within ₹0.51 of units × rate, like
 * the pro-rated rents' half a rupee).
 * @param {number} units
 * @param {number} rate
 * @returns {number}
 */
export function meterAmount(units, rate) {
    return roundFor('meterAmount', (Number(units) || 0) * (Number(rate) || 0));
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
 * MONEY-ROUND: whether a stored amount has paise (only records saved before #129 do).
 * @param {*} value
 * @returns {boolean}
 */
export function hasPaise(value) {
    const v = round2(toMoney(value) || 0);
    return v !== Math.round(v);
}

/**
 * BF-SAVE, DUE-CHECK: each leg in ROUNDING.payment, then the remainder
 * (target − Σ rounded legs) in one leg, so the legs add up to `target` exactly:
 * the first leg of `prefer` that has an amount, else the largest leg (never
 * taken below 0). Legs typed 300.50 + 300.50 + 386.50 for ₹987 are 301 + 301 + 385.
 * @param {Object<string, *>} typed legs as typed
 * @param {number} target
 * @param {string[]} [prefer]
 * @returns {Object<string, number>} the same keys
 */
export function settleSplit(typed, target, prefer = []) {
    const legs = {};
    Object.keys(typed).forEach(k => { legs[k] = typedAmount(toMoney(typed[k]) || 0); });
    const rest = round2(target - Object.values(legs).reduce((a, v) => a + v, 0));
    if (rest === 0) return legs;
    const keys = Object.keys(legs);
    const largest = keys.reduce((a, k) => (legs[k] > legs[a] ? k : a), keys[0]);
    const pick = [...prefer.filter(k => legs[k] > 0), largest].find(k => k !== undefined && legs[k] + rest >= 0);
    if (pick !== undefined) legs[pick] = round2(legs[pick] + rest);
    return legs;
}

/**
 * BF-SAVE on an edited bill (#129): the typed cash / online / due in
 * ROUNDING.payment. When they add up to the new total (within BF-SPLIT's ₹1) or
 * to the bill's stored total (an unchanged split of a bill saved with paise),
 * the rounding remainder goes into Due if it has an amount, else the largest
 * leg, so cash + online + due = the new total exactly. A split still being
 * changed (further off) is only rounded, so the form shows what is left.
 * @param {{online: *, cash: *, due: *}} typed
 * @param {number} total - the bill's new total (BF-PAYABLE / BF-TOTAL)
 * @param {?number} storedTotal - BILL-TOTAL of the bill as saved
 * @returns {{online: number, cash: number, due: number}}
 */
export function editedPaymentSplit(typed, total, storedTotal) {
    const raw = { online: toMoney(typed.online) || 0, cash: toMoney(typed.cash) || 0, due: toMoney(typed.due) || 0 };
    const sum = round2(raw.online + raw.cash + raw.due);
    const settles = Math.abs(sum - total) <= SPLIT_TOLERANCE
        || (storedTotal !== null && storedTotal !== undefined && Math.abs(sum - storedTotal) <= 0.01);
    return settles ? settleSplit(raw, total, ['due']) : paymentSplit(raw);
}

/**
 * BF-SAVE on an edited bill (#129): true when the edit leaves the money as it
 * was loaded: the same lines (item, kg, rate, amount, weights), the same labour
 * (purchases) and the same cash / online / due. The edit then keeps every
 * stored money field exactly (a bill saved with paise keeps its paise) and
 * saves only what else changed.
 * @param {{bill: Object, items: Object[], labour: ?number, typed: {online: *, cash: *, due: *}}} edit
 *   labour: the Labour box (0 when unticked); null for sales
 * @returns {boolean}
 */
export function editKeepsMoney({ bill, items, labour = null, typed }) {
    const sig = (lines) => JSON.stringify((lines || []).map(l => {
        const r = readLineItem(l);
        return [l?.itemId ?? null, r.name, r.qty, r.rate, r.total, Array.isArray(l?.weights) ? l.weights.map(Number) : null];
    }));
    if (sig(items) !== sig(bill?.items)) return false;
    if (labour !== null && round2(toMoney(labour) || 0) !== billLabour(bill)) return false;
    const stored = readPayment(bill);
    return ['online', 'cash', 'due'].every(k => round2(toMoney(typed?.[k]) || 0) === stored[k]);
}

/**
 * BF-SAVE on an edited bill (#129): the payment as it is checked and saved:
 * editedPaymentSplit against the new total, for the bill being edited.
 * @param {{online: *, cash: *, due: *}} typed
 * @param {number} total
 * @param {Object} bill - the bill as saved
 * @returns {{online: number, cash: number, due: number}}
 */
export function editSplitFor(typed, total, bill) {
    return editedPaymentSplit(typed, total, bill ? billTotal(bill) : null);
}

/**
 * DUE-CHECK: the cash / online of a due payment against the bill's due. Each
 * part is saved in ROUNDING.payment. Only when the due itself has paise (a bill
 * saved before #129, ₹987.50) and the payment is exactly that due (within the
 * tolerance), the paise remainder goes into one leg (the one typed with paise,
 * else the largest), so the due can be paid off to 0 and only the old
 * remainder carries paise. A ₹100 due paid 0.01 + 99.99 is 0 + 100.
 * @param {*} cash
 * @param {*} online
 * @param {number} due
 * @param {number} [tolerance=0.01]
 * @returns {{ok: true, cash: number, online: number, total: number}|{ok: false, error: 'negative'|'empty'|'exceeds-due'}}
 */
export function validateDuePayment(cash, online, due, tolerance = 0.01) {
    const c0 = round2(Number(cash) || 0);
    const o0 = round2(Number(online) || 0);
    if (c0 < 0 || o0 < 0) return { ok: false, error: 'negative' };
    const d = round2(Number(due) || 0);
    const paysOldDue = hasPaise(d) && Math.abs(round2(c0 + o0) - d) <= tolerance;
    const prefer = [hasPaise(c0) && 'cash', hasPaise(o0) && 'online'].filter(Boolean);
    const { cash: c, online: o } = paysOldDue
        ? settleSplit({ cash: c0, online: o0 }, d, prefer)
        : { cash: typedAmount(c0), online: typedAmount(o0) };
    const total = round2(c + o);
    if (total <= 0) return { ok: false, error: 'empty' };
    if (total > due + tolerance) return { ok: false, error: 'exceeds-due' };
    return { ok: true, cash: c, online: o, total };
}

/**
 * BF-RECOVER: what the unsaved-bill prompt says about an auto-save: which form,
 * how many lines and the total it had (the saved `billTotal` / `saleTotal`, else
 * the lines' plain sum), as shown.
 * @param {Object} data - the auto-save document (`{ mode, purchase, sale }`; older ones hold one form at the top level)
 * @returns {{mode: 'purchase'|'sale', lines: number, total: number}}
 */
export function autoSaveSummary(data) {
    const mode = data?.mode === 'sale' ? 'sale' : 'purchase';
    const form = (mode === 'sale' ? data?.sale : data?.purchase) || data || {};
    const items = Array.isArray(form.items) ? form.items : [];
    const saved = toMoney(mode === 'sale' ? form.saleTotal : form.billTotal);
    return { mode, lines: items.length, total: shownAmount(saved ?? draftLineSum(items)) || 0 };
}

/**
 * BF-NO: the number the next bill will probably get, before it is saved: one more
 * than the highest `{prefix}{YYYYMMDD}-NNN` among today's loaded bills. The real
 * number comes from the shared counter at save (it can be higher: voided bills,
 * another phone saving first), or a device number when offline (#41).
 * @param {string} prefix - 'P' | 'S' | 'W'
 * @param {Array<Object>} bills - loaded bills of that type ({ billNumber })
 * @param {Date} [now]
 * @returns {string}
 */
export function nextBillNumberHint(prefix, bills, now = new Date()) {
    const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const pattern = new RegExp(`^${prefix}${day}-(\\d+)$`);
    const highest = (bills || []).reduce((max, bill) => {
        const match = pattern.exec(String(bill?.billNumber || ''));
        return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    return `${prefix}${day}-${String(highest + 1).padStart(3, '0')}`;
}

/**
 * DUE-FIFO: one part of a party payment as saved. A part that pays its bill's whole
 * due keeps that due's paise (an old due saved before #129); any other part is whole
 * rupees (ROUNDING.payment), as "Record payment" saves it (DUE-CHECK).
 * @param {number} part
 * @param {number} due
 * @param {number} [tolerance=0.01]
 * @returns {number}
 */
export function partAsSaved(part, due, tolerance = 0.01) {
    const p = round2(part);
    const d = round2(due);
    if (hasPaise(d) && Math.abs(p - d) <= tolerance) return d;
    return typedAmount(p);
}

/**
 * DUE-FIFO: one payment from a party spread over their open bills, oldest first
 * (#152): the amount (whole rupees) fills each bill up to its due until it runs
 * out, so only the last bill reached can be part-paid, with the whole rupees left
 * (never above its due). What is not allocated is `left`.
 * @param {number[]} dues - BILL-DUE per bill, oldest first
 * @param {number} amount
 * @returns {{amounts: number[], allocated: number, left: number}}
 */
export function allocateOldestFirst(dues, amount) {
    let rest = typedAmount(Math.max(0, Number(amount) || 0));
    const amounts = (dues || []).map(d => {
        const due = round2(Math.max(0, Number(d) || 0));
        // Never more than was received: a part-paid bill gets the whole rupees left.
        const part = rest >= due ? due : Math.min(Math.floor(rest + 0.001), Math.floor(due));
        rest = round2(rest - part);
        return part;
    });
    return { amounts, allocated: round2(amounts.reduce((s, a) => s + a, 0)), left: rest };
}

/**
 * DUE-FIFO: checks the parts of one party payment against the amount received.
 * The amount is required (whole rupees, ROUNDING.payment). Every part is a number
 * from 0 to its bill's due (+ tolerance), saved as partAsSaved. The parts must add
 * up to the amount, with two exceptions only: (a) the amount is more than all the
 * dues and every bill is paid in full (Σ parts = Σ dues; the rest is `excess`, not
 * recorded); (b) an old due with paise is paid in full, so Σ parts differs from the
 * whole-rupee amount by those paise only (less than ₹1).
 * @param {number[]} dues
 * @param {Array<number|string>} parts - per bill, same order
 * @param {number|string} amount - the amount typed as received / paid
 * @param {number} [tolerance=0.01]
 * @returns {{ok: true, amounts: number[], total: number, received: number, excess: number, allFull: boolean}
 *   |{ok: false, error: 'no-amount'|'invalid'|'exceeds-due'|'empty'|'mismatch', index?: number, total?: number, received?: number, diff?: number, gap?: number}}
 */
export function checkAllocation(dues, parts, amount, tolerance = 0.01) {
    const rawAmount = amount === '' || amount === null || amount === undefined ? NaN : Number(amount);
    const received = Number.isFinite(rawAmount) && rawAmount > 0 ? typedAmount(rawAmount) : 0;
    if (!(received > 0)) return { ok: false, error: 'no-amount' };
    const amounts = [];
    for (let i = 0; i < dues.length; i++) {
        const raw = parts[i];
        const n = raw === '' || raw === null || raw === undefined ? 0 : Number(raw);
        if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'invalid', index: i };
        const a = partAsSaved(n, dues[i], tolerance);
        if (a > round2(dues[i]) + tolerance) return { ok: false, error: 'exceeds-due', index: i };
        amounts.push(a);
    }
    const total = round2(amounts.reduce((s, a) => s + a, 0));
    if (!(total > 0)) return { ok: false, error: 'empty' };
    const diff = round2(total - received);
    const allFull = amounts.every((a, i) => a >= round2(dues[i]) - tolerance);
    const ok = Math.abs(diff) <= tolerance
        || (allFull && diff < 0)
        || (Math.abs(diff) < 1 && hasPaise(total));
    if (!ok) return { ok: false, error: 'mismatch', total, received, diff, gap: Math.abs(diff) };
    return { ok: true, amounts, total, received, excess: round2(Math.max(0, received - total)), allFull };
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
    entryAmount: 'MONEY-ROUND',
    meterAmount: 'RENT-7',
    buildPaymentSplit: 'BF-SAVE',
    hasPaise: 'MONEY-ROUND',
    settleSplit: 'BF-SAVE, DUE-CHECK',
    editedPaymentSplit: 'BF-SAVE',
    editKeepsMoney: 'BF-SAVE',
    editSplitFor: 'BF-SAVE',
    prefillPayment: 'BF-FILL',
    restInDue: 'BF-FILL',
    validatePaymentSplit: 'BF-SPLIT',
    validateDuePayment: 'DUE-CHECK',
    partAsSaved: 'DUE-FIFO',
    allocateOldestFirst: 'DUE-FIFO',
    checkAllocation: 'DUE-FIFO',
    autoSaveSummary: 'BF-RECOVER',
    nextBillNumberHint: 'BF-NO'
});
