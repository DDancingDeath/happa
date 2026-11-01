/**
 * @fileoverview Labour on purchases (docs/calculations.md T-LAB-1, T-LAB-2):
 * what was deducted from farmers on the bills, and what the labour should be
 * paid for the kg that came in (kg ÷ package weight, rounded up, × labour rate).
 * Pure: callers pass the bills of one day (or another period) and the settings.
 * @module utils/labour
 */

import {
    activityBills, billLabour, formatKg, formatRupees, normalizeLabourSettings, readLineItem, round2, toMoney,
    DEFAULT_LABOUR_PACKAGE_KG, LABOUR_PACKAGE_KG_MIN, LABOUR_PACKAGE_KG_MAX, normalizePackageKg
} from './money.js';
import { tn } from '../i18n/index.js';

export { billLabour, formatKg, DEFAULT_LABOUR_PACKAGE_KG, LABOUR_PACKAGE_KG_MIN, LABOUR_PACKAGE_KG_MAX, normalizePackageKg };

/**
 * "(1,000 kg ÷ 35 kg = 29 packages × ₹6)" in the app language.
 * @param {{kg: number, packageKg: number, packages: number, rate: number}} toPay - labourToPay result
 * @param {string} key - catalogue key with {kg} {packageKg} {packages} {rate} (and a `_one` form)
 * @param {Object} [params] - extra params
 * @param {'en'|'hi'} [lang]
 * @returns {string}
 */
export function labourCalcText(toPay, key, params = {}, lang) {
    return tn(key, toPay.packages, {
        kg: formatKg(toPay.kg), packageKg: formatKg(toPay.packageKg), packages: toPay.packages,
        rate: formatRupees(toPay.rate, { small: true }), ...params
    }, lang);
}

/** kg on a purchase bill: Σ line kg. */
export function billKg(bill) {
    const items = Array.isArray(bill?.items) ? bill.items : [];
    return round2(items.reduce((sum, item) => sum + readLineItem(item).qty, 0));
}

/** Packets (weighings) on a purchase bill: Σ line weights, else the stored totalPackets. */
export function billPackets(bill) {
    const items = Array.isArray(bill?.items) ? bill.items : [];
    const counted = items.reduce((sum, item) => sum + (Array.isArray(item?.weights) ? item.weights.length : 0), 0);
    if (counted > 0) return counted;
    const stored = toMoney(bill?.totalPackets);
    return stored && stored > 0 ? Math.round(stored) : 0;
}

/**
 * T-LAB-1: labour deducted from farmers on these purchase bills.
 * @param {Array<Object>} bills
 * @returns {{amount: number, bills: number}} bills = bills with labour > 0
 */
export function labourDeducted(bills) {
    const list = activityBills(bills);
    let amount = 0;
    let count = 0;
    list.forEach(b => {
        const v = billLabour(b);
        amount += v;
        if (v > 0) count += 1;
    });
    return { amount: round2(amount), bills: count };
}

/**
 * Packages for the labour: kg ÷ package weight, rounded UP (a part package is paid as one).
 * @param {number} kg
 * @param {number} packageKg
 * @returns {number}
 */
export function labourPackages(kg, packageKg) {
    const total = round2(kg);
    if (!(total > 0)) return 0;
    return Math.ceil(total / normalizePackageKg(packageKg) - 1e-9);
}

/**
 * T-LAB-2: what to pay the labour for the kg on these purchase bills.
 * @param {Array<Object>} bills
 * @param {{laborRate?: *, labourPackageKg?: *}} [settings] - Settings › Aadhat (shared)
 * @returns {{kg: number, packageKg: number, packages: number, rate: number, amount: number}}
 */
export function labourToPay(bills, settings = {}) {
    const { laborRate: rate, labourPackageKg: packageKg } = normalizeLabourSettings(settings);
    const kg = round2(activityBills(bills).reduce((sum, b) => sum + billKg(b), 0));
    const packages = labourPackages(kg, packageKg);
    return { kg, packageKg, packages, rate, amount: round2(packages * rate) };
}

/**
 * T-LAB-2 for a period longer than a day: each day rounded up on its own, then summed.
 * @param {Array<Object>} bills
 * @param {Object} settings
 * @param {(bill: Object) => (string|null)} dayKeyOf - local day of a bill (e.g. from utils/dates.js)
 * @returns {{kg: number, packages: number, amount: number, days: number}}
 */
export function labourToPayByDay(bills, settings, dayKeyOf) {
    const byDay = new Map();
    activityBills(bills).forEach(b => {
        const key = dayKeyOf(b);
        if (!key) return;
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push(b);
    });
    let kg = 0;
    let packages = 0;
    let amount = 0;
    byDay.forEach(list => {
        const day = labourToPay(list, settings);
        kg += day.kg;
        packages += day.packages;
        amount += day.amount;
    });
    return { kg: round2(kg), packages, amount: round2(amount), days: byDay.size };
}

/**
 * T-LAB-3: how far to pay is from deducted; within 50 paise they "match".
 * @param {number} difference - to pay − deducted
 * @returns {{amount: number, kind: 'same'|'more'|'less'}}
 */
export function labourGap(difference) {
    const amount = Math.abs(difference);
    return { amount, kind: amount < 0.5 ? 'same' : difference > 0 ? 'more' : 'less' };
}

/**
 * T-LAB-3 for a period (Money › Spending, M7 vs M18): labourGap of to pay −
 * deducted, to paise.
 * @param {number} toPay M18 amount
 * @param {number} deducted M7 amount
 * @returns {{amount: number, kind: 'same'|'more'|'less'}}
 */
export function periodLabourGap(toPay, deducted) {
    return labourGap(round2(toPay - deducted));
}

/**
 * Both labour figures for the Today card, the day report and Money › Spending.
 * @param {Array<Object>} bills - purchase bills of the period (opening records are left out here)
 * @param {Object} [settings]
 * @returns {{deducted: {amount: number, bills: number}, toPay: ReturnType<typeof labourToPay>,
 *   difference: number, rows: Array<{bill: Object, kg: number, packets: number, labour: number}>}}
 *   difference = to pay − deducted
 */
export function labourSummary(bills, settings = {}) {
    const list = activityBills(bills);
    const deducted = labourDeducted(list);
    const toPay = labourToPay(list, settings);
    const rows = list.map(bill => ({ bill, kg: billKg(bill), packets: billPackets(bill), labour: billLabour(bill) }));
    return { deducted, toPay, difference: round2(toPay.amount - deducted.amount), rows };
}
