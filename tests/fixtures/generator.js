/**
 * @fileoverview Realistic multi-year shop history generator (#216).
 *
 * Deterministic for a given seed. Produces the bill shapes the app has
 * written over the years, so property tests exercise real-world data:
 *  - seasonal items (wheat bought in Apr–Jun, rice in Oct–Dec, …);
 *  - purchases (with labour), retail and wholesale sales (wholesale lines use
 *    `quantity`, retail/purchase lines `qty`);
 *  - credit sales/purchases, later partial payments in `payments[]` (cash or
 *    online, mirrored as cash-session legs with the same id), write-offs and
 *    legacy "mark as cleared";
 *  - legacy money shapes: `dueAmount`-only (no `payment` object) and
 *    `amountPaid`-only bills;
 *  - date shapes: ISO datetime, 'DD/MM/YYYY, h:mm:ss am', plain 'DD/MM/YYYY'
 *    and 'YYYY-MM-DD' (local midnight), some with a numeric `timestamp`;
 *  - line names by itemId, odd-cased English name, Hindi name, or a deleted
 *    itemId plus a name;
 *  - edited bills (`editedAt`, payment recomputed) and deleted bills (absent);
 *  - stock adjustments (add / remove), business / personal / untagged expenses,
 *    withdrawals and one cash session per working day;
 *  - in some shops, opening records carried from the old app (dues only, no lines,
 *    total 0, `openingBalance`), some dated on the migration day itself.
 * Sales never exceed the stock on hand at the start of the day, so stock never
 * goes negative (accounting check AC8).
 *
 * `truth` holds what really happened (independent of how it is stored), for
 * the property tests to compare the app against.
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

export const ITEMS = [
    { id: 'i-wheat', name: 'Wheat', hindiName: 'गेहूं', cost: 24, season: [3, 4, 5] },
    { id: 'i-rice', name: 'Rice', hindiName: 'चावल', cost: 32, season: [9, 10, 11] },
    { id: 'i-mustard', name: 'Mustard', hindiName: 'सरसों', cost: 55, season: [1, 2, 3] },
    { id: 'i-maize', name: 'Maize', hindiName: 'मक्का', cost: 19, season: [8, 9] },
    { id: 'i-gram', name: 'Gram', hindiName: 'चना', cost: 48, season: [2, 3] }
];
const PARTIES = ['Sita', 'Ravi', 'Kamla Devi', 'Gupta Traders', 'Mohan', 'Shyam Lal', 'Sharma Stores', 'राम लाल'];

const pad = (v) => String(v).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isoLocal = (d) => `${isoDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const dmy = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
function dmyTime(d) {
    const h = d.getHours();
    return `${dmy(d)}, ${h % 12 || 12}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${h < 12 ? 'am' : 'pm'}`;
}

/**
 * @param {Object} [opts]
 * @param {number} [opts.seed=1]
 * @param {number} [opts.years=3] length of history
 * @param {string} [opts.start='2023-04-01'] first day (local)
 * @param {number} [opts.activity=1] bills-per-day multiplier
 * @param {number} [opts.creditRate=0.35] share of bills with something left due
 * @param {number} [opts.legacyRate=0.2] share of bills stored in a legacy money shape
 * @param {number} [opts.ddmmRate=0.25] share of bills dated 'DD/MM/YYYY…'
 * @param {number} [opts.untaggedExpenseRate=0.03] share of expenses without a business/personal category
 * @param {number} [opts.editRate=0.04]
 * @param {number} [opts.deleteRate=0.02]
 * @param {number} [opts.openingRate=0.5] chance the shop starts with opening records migrated from the old app
 * @param {boolean} [opts.openingPayments=true] money received / paid (and written off) later on those records
 * @returns {Object} { items, purchases, wholesaleSales, retailSales, stockAdjustments, expenses, withdrawals, sessions, truth }
 */
export function generateShop(opts = {}) {
    const {
        seed = 1, years = 3, start = '2023-04-01', activity = 1, creditRate = 0.35, legacyRate = 0.2,
        ddmmRate = 0.25, untaggedExpenseRate = 0.03, editRate = 0.04, deleteRate = 0.02,
        openingRate = 0.5, openingPayments = true
    } = opts;
    const rnd = prng(seed);
    const chance = (p) => rnd() < p;
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const between = (lo, hi) => lo + rnd() * (hi - lo);
    const int = (lo, hi) => Math.floor(between(lo, hi + 1));

    const [y, m, d0] = start.split('-').map(Number);
    const first = new Date(y, m - 1, d0);
    const days = Math.round(years * 365);
    const end = new Date(y, m - 1, d0 + days).getTime();

    const out = {
        items: ITEMS.map(({ id, name, hindiName }) => ({ id, name, hindiName })),
        purchases: [], wholesaleSales: [], retailSales: [], stockAdjustments: [], expenses: [], withdrawals: [], sessions: [],
        truth: { bills: {}, cashDays: {}, deleted: 0, edited: 0, writtenOff: 0 }
    };
    const T = out.truth;
    const stock = Object.fromEntries(ITEMS.map(i => [i.id, 0]));
    const sessionByDay = new Map();
    let seq = 0;
    const nextId = (p) => `${p}${(++seq).toString(36)}`;

    const cashDay = (ms) => {
        const k = isoDay(new Date(ms));
        return T.cashDays[k] || (T.cashDays[k] = { in: 0, out: 0 });
    };
    const sessionFor = (ms) => {
        const k = isoDay(new Date(ms));
        if (!sessionByDay.has(k)) {
            const s = { id: `s-${k}`, date: k, openingBalance: int(5, 50) * 100, duePayments: [], cashDeposits: [] };
            sessionByDay.set(k, s);
            out.sessions.push(s);
        }
        return sessionByDay.get(k);
    };

    /** A bill's date fields; `plainOk` allows midnight-only dates (sales only, see stock ordering note). */
    function dateFields(t, plainOk) {
        const dt = new Date(t);
        const r = rnd();
        if (r < ddmmRate * 0.6) return { date: dmyTime(dt) };
        if (r < ddmmRate) return plainOk ? { date: dmy(dt) } : { date: dmyTime(dt) };
        if (plainOk && r < ddmmRate + 0.08) return { date: isoDay(dt) };
        return chance(0.5) ? { date: isoLocal(dt), timestamp: t } : { date: isoLocal(dt) };
    }
    /** Day of a stored bill as the app sees it (plain dates are local midnight). */
    const storedTime = (fields, t) => (/^\d{4}-\d{2}-\d{2}$|^\d{2}\/\d{2}\/\d{4}$/.test(fields.date) ? new Date(new Date(t).setHours(0, 0, 0, 0)).getTime() : t);

    function lineFor(item, qty, rate, qtyKey) {
        const total = Math.round(qty * rate);
        const r = rnd();
        const ref = r < 0.7 ? { itemId: item.id, name: item.name }
            : r < 0.8 ? { name: ` ${item.name.toUpperCase()}` }
                : r < 0.9 ? { name: item.hindiName }
                    : { itemId: `deleted-${item.id}`, name: item.name.toLowerCase() };
        return { ...ref, [qtyKey]: qty, rate, total };
    }

    /** Payment split at save time for a whole-rupee total. */
    function split(total) {
        const due = chance(creditRate) ? Math.max(1, Math.round(total * between(0.2, 1))) : 0;
        const online = chance(0.3) ? Math.round((total - due) * between(0.2, 1)) : 0;
        return { cash: total - due - online, online, due };
    }

    /** Writes the money fields in one of the shapes the app has used. */
    function storeMoney(bill, kind, total, pay) {
        const legacy = kind !== 'wholesale' && pay.online === 0 && chance(legacyRate);
        if (legacy && chance(0.5)) {
            Object.assign(bill, { cashPayment: pay.cash, dueAmount: pay.due });
            return 'dueAmount';
        }
        if (legacy) {
            bill.amountPaid = pay.cash;
            return 'amountPaid';
        }
        if (kind === 'wholesale') {
            bill.payment = { cash: pay.cash, online: pay.online, due: pay.due, total: pay.cash + pay.online };
        } else {
            Object.assign(bill, { cashPayment: pay.cash, onlinePayment: pay.online, dueAmount: pay.due,
                payment: { cash: pay.cash, online: pay.online, due: pay.due, total } });
        }
        return 'modern';
    }

    /** Later due payments / write-off / legacy clear on a saved bill. */
    function settleLater(bill, kind, truth, shape, t) {
        if (truth.due <= 0) return;
        if (shape === 'modern' && chance(0.6)) {
            const n = int(1, 3);
            let when = t;
            for (let i = 0; i < n && truth.due > 0; i++) {
                when += int(1, 45) * DAY + int(0, 8) * 3600000;
                if (when >= end) break;
                const amt = i === n - 1 && chance(0.5) ? truth.due : Math.max(1, Math.round(truth.due * between(0.2, 0.8)));
                const online = chance(0.25) ? amt : 0;
                const cash = amt - online;
                const id = nextId('pay-');
                const at = new Date(when).setHours(int(9, 19), int(0, 59), 0, 0);
                const entry = { id, amount: amt, cash, online, at, date: isoLocal(new Date(at)) };
                // Entries written before #107 carry only `amount` (always cash)
                if (online === 0 && chance(0.1)) { delete entry.cash; delete entry.online; }
                bill.payments = [...(bill.payments || []), entry];
                truth.due -= amt;
                truth.laterCash += cash;
                truth.laterOnline += online;
                bill.payment.cash += cash;
                bill.payment.online += online;
                bill.payment.due = truth.due;
                bill.payment.total = bill.payment.cash + bill.payment.online;
                if ('dueAmount' in bill) bill.dueAmount = truth.due;
                const dir = kind === 'purchase' ? 'paid' : 'received';
                cashDay(at)[dir === 'paid' ? 'out' : 'in'] += cash;
                if (chance(0.7)) {
                    sessionFor(at).duePayments.push({ id, billId: bill.id, type: dir, amount: amt, cash, online,
                        method: cash > 0 && online > 0 ? 'split' : cash > 0 ? 'cash' : 'online', timestamp: new Date(at).toISOString() });
                }
            }
        }
        if (truth.due > 0 && chance(0.12)) {
            T.writtenOff++;
            if (shape === 'modern' && chance(0.6)) {
                bill.payments = [...(bill.payments || []), { id: nextId('wo-'), kind: 'writeOff', amount: truth.due, at: Math.min(end - 1, t + 30 * DAY) }];
                bill.payment.writtenOff = truth.due;
                bill.payment.due = 0;
                if ('dueAmount' in bill) bill.dueAmount = 0;
                truth.writtenOff = truth.due;
            }
            bill.cleared = true;
            truth.cleared = true;
            truth.due = 0;
        }
    }

    function addBill(kind, t, lines, extra) {
        const id = nextId(kind[0]);
        const fields = dateFields(t, kind !== 'purchase');
        const lineTotal = lines.reduce((a, l) => a + l.total, 0);
        const bill = { id, ...fields, items: lines, customerName: pick(PARTIES), ...extra(lineTotal) };
        if (kind === 'wholesale') bill.customer = bill.customerName;
        const total = kind === 'purchase' ? bill.grandTotal : bill.total;
        const pay = split(total);
        const truth = { kind, t: storedTime(fields, t), total, cash: pay.cash, online: pay.online, due: pay.due,
            atSaveCash: pay.cash, atSaveOnline: pay.online, laterCash: 0, laterOnline: 0, writtenOff: 0, cleared: false };
        const shape = storeMoney(bill, kind, total, pay);
        if (chance(editRate)) { bill.editedAt = isoLocal(new Date(t + 3600000)); T.edited++; }
        cashDay(t)[kind === 'purchase' ? 'out' : 'in'] += pay.cash;
        settleLater(bill, kind, truth, shape, t);
        T.bills[id] = truth;
        (kind === 'purchase' ? out.purchases : kind === 'wholesale' ? out.wholesaleSales : out.retailSales).push(bill);
        return bill;
    }

    for (let day = 0; day < days; day++) {
        const base = new Date(first.getFullYear(), first.getMonth(), first.getDate() + day);
        if (base.getDay() === 0 && chance(0.7)) continue; // mostly closed on Sundays
        const at = (h) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, int(0, 59), int(0, 59)).getTime();
        const month = base.getMonth();
        const avail = { ...stock }; // sell only what was on hand at the start of the day
        const bought = {};

        // Purchases: in-season items, heavier in season
        ITEMS.forEach(item => {
            const inSeason = item.season.includes(month);
            if (!chance((inSeason ? 0.45 : 0.06) * activity)) return;
            const qty = Math.round(between(inSeason ? 80 : 20, inSeason ? 600 : 120));
            const rate = Math.round(item.cost * between(0.88, 1.12) * 2) / 2;
            const deleted = chance(deleteRate);
            const labour = chance(0.6) ? Math.round(qty / 50) * 6 : 0;
            const t = at(int(7, 11));
            if (deleted) { T.deleted++; return; }
            const line = lineFor(item, qty, rate, 'qty');
            addBill('purchase', t, [line], (lineTotal) => ({ billTotal: lineTotal, laborCharges: labour, grandTotal: lineTotal - labour }));
            bought[item.id] = (bought[item.id] || 0) + qty;
        });

        // Retail sales
        const retailCount = Math.round(between(0, 5) * activity);
        for (let b = 0; b < retailCount; b++) {
            if (chance(deleteRate)) { T.deleted++; continue; } // saved, then deleted: leaves no trace
            const lines = [];
            ITEMS.filter(() => chance(0.35)).slice(0, 3).forEach(item => {
                const qty = Math.min(Math.round(between(1, 25) * 2) / 2, Math.floor(avail[item.id] * 0.5 * 2) / 2);
                if (qty <= 0) return;
                avail[item.id] -= qty;
                lines.push(lineFor(item, qty, Math.round(item.cost * between(1.1, 1.3)), 'qty'));
            });
            if (!lines.length) continue;
            addBill('retail', at(int(9, 20)), lines, (lineTotal) => ({ total: lineTotal }));
        }

        // Wholesale
        if (chance(0.2 * activity)) {
            const item = pick(ITEMS);
            const qty = Math.min(Math.round(between(20, 250)), Math.floor(avail[item.id] * 0.6));
            if (qty > 0) {
                avail[item.id] -= qty;
                addBill('wholesale', at(int(10, 18)), [lineFor(item, qty, Math.round(item.cost * between(1.05, 1.18) * 2) / 2, 'quantity')],
                    (lineTotal) => ({ total: lineTotal }));
            }
        }

        // Stock adjustments (evening, after the day's sales)
        if (chance(0.03)) {
            const item = pick(ITEMS);
            const t = at(21);
            if (chance(0.5) && avail[item.id] > 2) {
                const q = Math.min(Math.round(between(1, 10)), Math.floor(avail[item.id] / 2));
                avail[item.id] -= q;
                out.stockAdjustments.push({ id: nextId('a'), itemId: item.id, itemName: item.name, adjustType: 'remove', quantity: q, rate: 0, timestamp: t, date: isoLocal(new Date(t)), reason: 'spoiled' });
            } else {
                const q = Math.round(between(1, 20));
                avail[item.id] += q;
                out.stockAdjustments.push({ id: nextId('a'), itemId: item.id, itemName: item.name, adjustType: 'add', quantity: q, rate: item.cost, timestamp: t, date: isoLocal(new Date(t)), reason: 'found' });
            }
        }

        // Expenses
        const expenseCount = Math.round(between(0, 2.4));
        for (let e = 0; e < expenseCount; e++) {
            const amount = int(1, 40) * 25;
            const t = at(int(9, 20));
            const exp = { id: nextId('e'), amount, date: chance(0.2) ? dmy(new Date(t)) : isoDay(new Date(t)) };
            const r = rnd();
            if (r < untaggedExpenseRate) {
                if (chance(0.5)) exp.type = 'business';
            } else {
                exp.category = r < 0.75 ? 'business' : 'personal';
            }
            out.expenses.push(exp);
            cashDay(t).out += amount;
        }
        if (base.getDate() === 1 && chance(0.8)) {
            out.withdrawals.push({ id: nextId('x'), date: isoDay(base), amount: int(5, 40) * 500 });
        }
        if (chance(0.03)) {
            const s = sessionFor(at(12));
            const amount = int(1, 20) * 100;
            s.cashDeposits.push({ amount });
            cashDay(at(12)).in += amount;
        }

        Object.keys(stock).forEach(k => { stock[k] = avail[k] + (bought[k] || 0); });
        sessionFor(at(9)); // a session for every working day
    }

    // Migration from the old app (tools/migrate): opening records for old unpaid
    // bills, written on a "migration day" and dated with the old bill's date
    // (sometimes that same day, as in the live case). Drawn from their own PRNG
    // after the history, so a shop with and without them is otherwise identical.
    const orand = prng((seed * 31 + 7) >>> 0);
    const ochance = (p) => orand() < p;
    const obetween = (lo, hi) => lo + orand() * (hi - lo);
    const oint = (lo, hi) => Math.floor(obetween(lo, hi + 1));
    T.opening = [];
    if (ochance(openingRate)) {
        const migDay = new Date(first.getFullYear(), first.getMonth(), first.getDate() + Math.floor(days * obetween(0.5, 0.95)));
        const asOf = new Date(migDay).setHours(20, 0, 0, 0);
        const count = oint(1, 5);
        for (let i = 0; i < count; i++) {
            const kind = ['retail', 'retail', 'wholesale', 'purchase'][oint(0, 3)];
            const sameDay = ochance(0.4);
            const origin = sameDay ? new Date(migDay).setHours(oint(9, 19), oint(0, 59), 0, 0)
                : new Date(first.getFullYear(), first.getMonth(), first.getDate() + oint(0, Math.max(0, Math.round((migDay - first) / DAY) - 1)), oint(9, 19), oint(0, 59)).getTime();
            const due = ochance(0.15) ? 250000 : oint(1, 4000) * 10;
            const id = `opening-${kind}-${nextId('old')}`;
            const bill = {
                id, billNumber: `OLD-${i + 1}`, customerName: PARTIES[oint(0, PARTIES.length - 1)],
                date: ochance(0.3) ? dmyTime(new Date(origin)) : isoLocal(new Date(origin)), timestamp: origin,
                type: kind, isPurchase: kind === 'purchase', items: [], total: 0, cashPayment: 0, onlinePayment: 0,
                dueAmount: due, payment: { cash: 0, online: 0, due, total: 0 }, openDue: true, cleared: false,
                openingBalance: { migrated: true, kind: kind === 'purchase' ? 'payable' : 'receivable', billType: kind, amount: due,
                    billTotal: due, paidBefore: 0, asOf, fromProject: 'aadhat-management', sourceBillId: id }
            };
            if (kind === 'wholesale') bill.source = 'sales-tab';
            const truth = { kind, opening: true, t: origin, total: 0, cash: 0, online: 0, due, atSaveCash: 0, atSaveOnline: 0,
                laterCash: 0, laterOnline: 0, writtenOff: 0, cleared: false };
            if (openingPayments && ochance(0.5)) {
                const at = new Date(asOf + oint(1, 30) * DAY).setHours(oint(9, 19), oint(0, 59), 0, 0);
                if (at < end) {
                    const amt = ochance(0.4) ? due : Math.max(1, Math.round(due * obetween(0.1, 0.8)));
                    const pid = nextId('pay-');
                    bill.payments = [{ id: pid, amount: amt, cash: amt, online: 0, at, date: isoLocal(new Date(at)) }];
                    bill.payment = { cash: amt, online: 0, due: due - amt, total: amt };
                    bill.dueAmount = due - amt;
                    truth.due = due - amt;
                    truth.laterCash = amt;
                    truth.cash = 0;
                    const dir = kind === 'purchase' ? 'paid' : 'received';
                    cashDay(at)[dir === 'paid' ? 'out' : 'in'] += amt;
                    sessionFor(at).duePayments.push({ id: pid, billId: id, type: dir, amount: amt, cash: amt, online: 0, method: 'cash', timestamp: new Date(at).toISOString() });
                    if (truth.due > 0 && ochance(0.3)) {
                        bill.payments.push({ id: nextId('wo-'), kind: 'writeOff', amount: truth.due, at: at + 3600000 });
                        bill.payment.writtenOff = truth.due;
                        bill.payment.due = 0;
                        bill.dueAmount = 0;
                        bill.cleared = true;
                        truth.writtenOff = truth.due;
                        truth.due = 0;
                        truth.cleared = true;
                    }
                }
            }
            T.bills[id] = truth;
            T.opening.push(id);
            (kind === 'purchase' ? out.purchases : kind === 'wholesale' ? out.wholesaleSales : out.retailSales).push(bill);
        }
        T.migrationDay = migDay.getTime();
    }
    T.finalQty = { ...stock };
    T.end = end;
    T.start = first.getTime();
    return out;
}
