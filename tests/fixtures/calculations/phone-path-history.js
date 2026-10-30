/**
 * @fileoverview Synthetic shop history for the phone-path audit
 * (tests/oracle/phone-path.test.js), generated at test time from a seed so the
 * repo carries no large fixture and no real data. Made-up names and amounts only.
 *
 * It runs from 1 Jul 2025 to 15 Oct 2026 (more than 13 months), so a phone audited
 * on 15 Oct 2026 has whole-month snapshots for every month of last year it compares
 * with: "vs last year" (Money, item rows), stopped coming from snapshot customer
 * lists and the M11 last-year line all run. It uses its own items (Gram, Mustard)
 * and parties, so the hand-made records of phone-path.json (Rice, Wheat) keep their
 * own stock and meaning.
 *
 * - Retail sales most days (regular customers; "Test Customer Stopped" bought every
 *   week until 20 Jul 2026, so he bought in Sep, Oct and Nov 2025 and has stopped),
 *   wholesale twice a month (`quantity` lines), purchases three times a month with
 *   labour on some (I11), expenses, withdrawals and a few stock corrections.
 * - Mustard sells at about cost from Sep 2026 (I7 low profit) and some sale lines
 *   are below cost (I8). Stock never goes below zero (AC8).
 * - Some bills are bought / sold on credit and paid later as the current app does
 *   (`payments[]` entry, `payment.*`, `paidAt`, `openDue`).
 * - Cash sessions (`cash_<date>`) on working days from 1 Aug 2026, except 5–8 Oct
 *   (phone-path.json pays older bills on 5 and 6 Oct with no session open). A due
 *   paid while a session is open is also a leg of it, with the same id (DUE-PAY,
 *   counted once).
 * - 15 Oct 2026 (the fixture's "now") has two sessions: the day's `cash_2026-10-15`
 *   (open, listed first) and a legacy one (random id, signed out and counted at
 *   noon). Two bills from before the window are paid that day by an older app (no
 *   `paidAt`), each with a leg in one of the sessions; a bill inside the window is
 *   paid with `paidAt` and a leg (the same payment twice, counted once).
 */

const DAY = 86400000;

/** Small fast seeded PRNG (mulberry32). */
function prng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export const HISTORY_ITEMS = [
    { id: 'gram', name: 'Gram', hindiName: 'चना', rates: [48], wholesaleRates: [52], saleRates: [56] },
    { id: 'mustard', name: 'Mustard', hindiName: 'सरसों', rates: [55], wholesaleRates: [], saleRates: [62] }
];
const COST = { gram: 48, mustard: 55 };
const REGULARS = ['Test Regular 1', 'Test Regular 2', 'Test Regular 3', 'Test Regular 4', 'Test Regular 5', 'Test Regular 6'];
export const STOPPED_CUSTOMER = 'Test Customer Stopped';
const SUPPLIERS = ['Test Supplier S1', 'Test Supplier S2'];
const WHOLESALERS = ['Test Wholesaler W1', 'Test Wholesaler W2'];
/** Ids of the records the phone-path test looks at. */
export const IDS = { canonical: 'cash_2026-10-15', legacy: 'sess-legacy-1015', oldSale: 'h-old-sale', oldPurchase: 'h-old-purchase' };

const pad = (v) => String(v).padStart(2, '0');
const isoDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * @param {{seed?: number}} [opts]
 * @returns {{items, purchases, wholesaleSales, retailSales, stockAdjustments, expenses, withdrawals, sessions}}
 */
export function phonePathHistory({ seed = 216 } = {}) {
    const rnd = prng(seed);
    const chance = (p) => rnd() < p;
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

    const out = { items: HISTORY_ITEMS.map(i => ({ ...i })), purchases: [], wholesaleSales: [], retailSales: [], stockAdjustments: [], expenses: [], withdrawals: [], sessions: [] };
    const stock = { gram: 0, mustard: 0 };
    const sessions = new Map();
    let seq = 0;
    let lines = 0;
    const id = (p) => `h-${p}-${(++seq).toString(36)}`;
    const at = (day, h, m = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
    const stamp = (t) => ({ date: new Date(t).toISOString(), timestamp: t });

    // No session before Aug 2026, nor on 5–8 Oct 2026 (phone-path.json pays older bills then with none open).
    const hasSession = (day) => day.getTime() >= new Date(2026, 7, 1).getTime()
        && !(day.getFullYear() === 2026 && day.getMonth() === 9 && day.getDate() >= 5 && day.getDate() <= 8);
    const openSession = (day) => {
        const k = isoDay(day.getTime());
        if (sessions.has(k) || !hasSession(day)) return;
        const opening = int(20, 60) * 100;
        const s = {
            id: `cash_${k}`, date: k, openingBalance: opening, signInTime: new Date(at(day, 8)).toISOString(),
            signedOut: true, signOutTime: new Date(at(day, 20)).toISOString(), counted: true, closingBalance: opening + int(-5, 40) * 100,
            duePayments: [], cashDeposits: []
        };
        sessions.set(k, s);
        out.sessions.push(s);
    };

    /** A later due payment as the current app records it (outstanding.js applyPaymentTransaction), with its session leg. */
    const pay = (bill, kind, t, amount, { online = 0, paidAt = true, session = sessions.get(isoDay(t)) || null } = {}) => {
        const cash = r2(amount - online);
        const entry = { id: id('pay'), amount: r2(amount), cash, online, at: t, date: new Date(t).toISOString(), recordedBy: 'Test' };
        bill.payments = [...(bill.payments || []), entry];
        const p = bill.payment;
        p.cash = r2(p.cash + cash);
        p.online = r2(p.online + online);
        p.due = r2(Math.max(0, p.due - amount));
        p.total = r2(p.cash + p.online);
        if ('dueAmount' in bill) bill.dueAmount = p.due;
        if (paidAt) bill.paidAt = t;
        bill.openDue = p.due > 0.005;
        if (session) {
            session.duePayments.push({
                id: entry.id, billId: bill.id, billType: kind, billNumber: bill.billNumber, type: kind === 'purchase' ? 'paid' : 'received',
                customer: bill.customerName, amount: r2(amount), cash, online, method: cash > 0 && online > 0 ? 'split' : cash > 0 ? 'cash' : 'online',
                notes: '', timestamp: new Date(t).toISOString(), recordedBy: 'Test'
            });
        }
        return entry;
    };
    const money = (total, creditP) => {
        const due = chance(creditP) ? Math.round(total * (0.3 + rnd() * 0.7)) : 0;
        const online = chance(0.25) ? Math.round((total - due) * 0.5) : 0;
        return { cash: total - due - online, online, due };
    };
    const later = [];

    // Two bills from before the window, paid on 15 Oct 2026 by an older app (below).
    const oldBills = {};
    const oldBill = (kind, day, total) => {
        const t = at(day, 11);
        const base = { id: kind === 'purchase' ? IDS.oldPurchase : IDS.oldSale, billNumber: `HO-${kind}`, ...stamp(t), payment: { cash: 0, online: 0, due: total, total: 0 }, openDue: true };
        if (kind === 'purchase') {
            const qty = 100;
            const lineTotal = qty * COST.mustard;
            Object.assign(base, { customerName: SUPPLIERS[1], type: 'purchase', isPurchase: true, items: [{ itemId: 'mustard', name: 'Mustard', qty, rate: COST.mustard, total: lineTotal }],
                billTotal: lineTotal, laborCharges: lineTotal - total, grandTotal: total, amountPayable: total, cashPayment: 0, onlinePayment: 0, dueAmount: total });
            stock.mustard += qty;
            out.purchases.push(base);
        } else {
            const qty = total / 60;
            Object.assign(base, { customerName: REGULARS[1], type: 'retail', items: [{ itemId: 'gram', name: 'Gram', qty, rate: 60, total }], total, cashPayment: 0, onlinePayment: 0, dueAmount: total });
            stock.gram -= qty;
            out.retailSales.push(base);
        }
        return base;
    };

    const first = new Date(2025, 6, 1);
    const last = new Date(2026, 9, 14);
    for (let day = new Date(first); day <= last; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
        const dom = day.getDate();
        if (dom === 1) {
            out.withdrawals.push({ id: id('x'), date: isoDay(day.getTime()), amount: int(4, 12) * 500 });
            out.expenses.push({ id: id('e'), amount: 1500, category: 'business', type: 'Rent', ...stamp(at(day, 9)) });
        }
        if (day.getDay() === 0) continue;
        openSession(day);

        // Purchases on the 2nd, 12th and 22nd (morning, before the day's sales).
        if ([2, 12, 22].includes(dom)) {
            HISTORY_ITEMS.forEach((item, n) => {
                const t = at(day, 8, 10 + n * 10);
                const qty = item.id === 'gram' ? int(220, 360) : int(160, 260);
                const rate = r2(COST[item.id] * (0.96 + rnd() * 0.08));
                const total = Math.round(qty * rate);
                const labour = chance(0.6) ? Math.round(qty / 50) * 6 : 0;
                const grand = total - labour;
                const pm = money(grand, 0.15);
                const bill = {
                    id: id('p'), billNumber: `HP-${seq}`, customerName: SUPPLIERS[n], ...stamp(t), type: 'purchase', isPurchase: true,
                    items: [{ itemId: item.id, name: item.name, qty, rate, total }], billTotal: total, laborCharges: labour, grandTotal: grand,
                    amountPayable: grand, cashPayment: pm.cash, onlinePayment: pm.online, dueAmount: pm.due,
                    payment: { cash: pm.cash, online: pm.online, due: pm.due, total: pm.cash + pm.online }, openDue: pm.due > 0
                };
                out.purchases.push(bill);
                stock[item.id] += qty;
                if (pm.due > 0) later.push({ bill, kind: 'purchase', t });
            });
        }
        if (day.getFullYear() === 2026 && day.getMonth() === 2 && dom === 10) oldBills.sale = oldBill('retail', day, 3000);
        if (day.getFullYear() === 2026 && day.getMonth() === 3 && dom === 14) oldBills.purchase = oldBill('purchase', day, 4400);

        // Retail: 1–2 bills a day.
        const count = int(1, 2);
        for (let b = 0; b < count; b++) {
            const t = at(day, int(12, 18), int(0, 59));
            const stoppedCustomer = t < new Date(2026, 6, 21).getTime() && dom % 7 === 3 && b === 0;
            const customer = stoppedCustomer ? STOPPED_CUSTOMER : chance(0.75) ? pick(REGULARS) : '';
            const billLines = [];
            HISTORY_ITEMS.forEach(item => {
                if (!stoppedCustomer && !chance(0.6)) return;
                const qty = Math.min(int(4, 30), Math.floor(stock[item.id] * 0.4));
                if (qty <= 0) return;
                lines++;
                const lowMargin = item.id === 'mustard' && t >= new Date(2026, 8, 1).getTime();
                const rate = lines % 17 === 0 ? Math.round(COST[item.id] * 0.85)
                    : lowMargin ? COST[item.id] + 1 : Math.round(COST[item.id] * (1.15 + rnd() * 0.1));
                stock[item.id] -= qty;
                billLines.push({ itemId: item.id, name: item.name, qty, rate, total: qty * rate });
            });
            if (!billLines.length) continue;
            const total = billLines.reduce((a, l) => a + l.total, 0);
            const pm = money(total, customer ? 0.15 : 0);
            const bill = {
                id: id('r'), billNumber: `HR-${seq}`, customerName: customer, ...stamp(t), type: 'retail', items: billLines, total,
                cashPayment: pm.cash, onlinePayment: pm.online, dueAmount: pm.due,
                payment: { cash: pm.cash, online: pm.online, due: pm.due, total: pm.cash + pm.online }, openDue: pm.due > 0
            };
            out.retailSales.push(bill);
            if (pm.due > 0) later.push({ bill, kind: 'retail', t });
        }

        // Wholesale on the 8th and 25th.
        if ([8, 25].includes(dom)) {
            const qty = Math.min(int(80, 160), Math.floor(stock.gram * 0.5));
            if (qty > 0) {
                const t = at(day, 15, 30);
                const rate = r2(COST.gram * (1.08 + rnd() * 0.06));
                const total = Math.round(qty * rate);
                const pm = money(total, 0.4);
                const name = WHOLESALERS[dom === 8 ? 0 : 1];
                const bill = {
                    id: id('w'), billNumber: `HW-${seq}`, customer: name, customerName: name, ...stamp(t), type: 'wholesale',
                    items: [{ itemId: 'gram', name: 'Gram', quantity: qty, rate, total }], total,
                    payment: { cash: pm.cash, online: pm.online, due: pm.due, total: pm.cash + pm.online }, openDue: pm.due > 0
                };
                stock.gram -= qty;
                out.wholesaleSales.push(bill);
                if (pm.due > 0) later.push({ bill, kind: 'wholesale', t });
            }
        }

        if (dom % 9 === 4) {
            out.expenses.push({ id: id('e'), amount: int(2, 12) * 50, category: chance(0.8) ? 'business' : 'personal', type: chance(0.5) ? 'Transport' : 'Food', ...stamp(at(day, 12)) });
        }
        if (dom === 27 && day.getMonth() % 3 === 0 && stock.mustard > 20) {
            out.stockAdjustments.push({ id: id('a'), itemId: 'mustard', itemName: 'Mustard', adjustType: 'remove', quantity: 5, rate: 0, reason: 'spoiled', ...stamp(at(day, 20)) });
            stock.mustard -= 5;
        }
    }

    // Credit bills paid later (some in part, some never), as the current app records it.
    const end = new Date(2026, 9, 15).getTime();
    later.forEach(({ bill, kind, t }, i) => {
        if (i % 5 === 4) return;
        const when = new Date(t + int(3, 40) * DAY);
        const pt = new Date(when.getFullYear(), when.getMonth(), when.getDate(), int(10, 18), int(0, 59)).getTime();
        if (pt >= end) return;
        const part = i % 3 === 0 ? Math.round(bill.payment.due / 2) : bill.payment.due;
        pay(bill, kind, pt, part, { online: i % 4 === 1 ? part : 0 });
    });

    // ---- 15 Oct 2026: two sessions on one day, legs on bills from before the window.
    const today = new Date(2026, 9, 15);
    const canonical = {
        id: IDS.canonical, date: '2026-10-15', openingBalance: 3000, signInTime: new Date(at(today, 13)).toISOString(),
        signedOut: false, duePayments: [], cashDeposits: []
    };
    const legacy = {
        id: IDS.legacy, date: '2026-10-15', openingBalance: 2500, signInTime: new Date(at(today, 8)).toISOString(),
        signedOut: true, signOutTime: new Date(at(today, 12)).toISOString(), counted: true, closingBalance: 5600, duePayments: [], cashDeposits: []
    };
    out.sessions.push(canonical, legacy);
    pay(oldBills.sale, 'retail', at(today, 10, 30), 3000, { paidAt: false, session: legacy });
    pay(oldBills.purchase, 'purchase', at(today, 16), 4400, { online: 1500, paidAt: false, session: canonical });
    const inWindow = out.retailSales.find(b => b.customerName && b.timestamp >= new Date(2026, 9, 1).getTime() && !b.payments && b.payment.due === 0 && b.payment.cash >= 600);
    inWindow.payment = { cash: inWindow.payment.cash - 600, online: inWindow.payment.online, due: 600, total: inWindow.payment.cash - 600 + inWindow.payment.online };
    inWindow.cashPayment -= 600;
    inWindow.dueAmount = 600;
    inWindow.openDue = true;
    pay(inWindow, 'retail', at(today, 17), 600, { session: canonical });
    const t = at(today, 11, 45);
    out.retailSales.push({
        id: id('r'), billNumber: `HR-${seq}`, customerName: REGULARS[0], ...stamp(t), type: 'retail', items: [{ itemId: 'gram', name: 'Gram', qty: 10, rate: 60, total: 600 }],
        total: 600, cashPayment: 400, onlinePayment: 200, dueAmount: 0, payment: { cash: 400, online: 200, due: 0, total: 600 }, openDue: false
    });
    return out;
}
