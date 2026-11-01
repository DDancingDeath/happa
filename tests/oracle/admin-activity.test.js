/**
 * @fileoverview Oracle for Admin activity (docs/calculations.md ADM-2, ADM-3):
 * an independent per-person tally of generated bills and audit rows agrees
 * with utils/user-activity.js activityByUser.
 */
import fc from 'fast-check';
import { activityByUser } from '../../www/js/utils/user-activity.js';

const FROM = Date.UTC(2026, 10, 1);
const TO = Date.UTC(2026, 10, 8);
const PAYMENT = ['RECORD_PAYMENT', 'UPDATE_PAYMENT', 'CLEAR_DUE'];
const EDIT = ['EDIT_BILL', 'EDIT_SALE'];

describe('ADM-2 / ADM-3: activity by person', () => {
    test('bill count and total per author, audit counts per action, all inside [from, to)', () => {
        const uid = fc.constantFrom('a', 'b', 'c');
        const time = fc.integer({ min: FROM - 86400000, max: TO + 86400000 });
        fc.assert(fc.property(
            fc.array(fc.record({ uid, time, total: fc.integer({ min: 0, max: 100000 }), voided: fc.boolean(), wholesale: fc.boolean() }), { maxLength: 30 }),
            fc.array(fc.record({ uid, time, action: fc.constantFrom(...PAYMENT, ...EDIT, 'VOID_BILL', 'LOGIN', 'CREATE_ITEM') }), { maxLength: 30 }),
            (rawBills, rawAudit) => {
                const bills = rawBills.map((b, i) => ({
                    id: String(i), timestamp: b.time, grandTotal: b.total, voided: b.voided,
                    ...(b.wholesale ? { createdBy: b.uid } : { userId: b.uid })
                }));
                const audit = rawAudit.map(a => ({ userId: a.uid, action: a.action, timestamp: a.time }));
                const exp = {};
                const get = (u) => (exp[u] = exp[u] || { bills: 0, total: 0, payments: 0, edits: 0, voids: 0, logins: 0, last: null });
                const inRange = (t) => t >= FROM && t < TO;
                for (const b of rawBills) {
                    if (b.voided || !inRange(b.time)) continue;
                    const e = get(b.uid);
                    e.bills += 1;
                    e.total += b.total;
                    e.last = e.last === null ? b.time : Math.max(e.last, b.time);
                }
                for (const a of rawAudit) {
                    if (!inRange(a.time)) continue;
                    const e = get(a.uid);
                    if (PAYMENT.includes(a.action)) e.payments += 1;
                    if (EDIT.includes(a.action)) e.edits += 1;
                    if (a.action === 'VOID_BILL') e.voids += 1;
                    if (a.action === 'LOGIN') e.logins += 1;
                    e.last = e.last === null ? a.time : Math.max(e.last, a.time);
                }
                const got = Object.fromEntries(activityByUser({ bills, audit, from: FROM, to: TO })
                    .map(r => [r.uid, { bills: r.bills, total: r.billTotal, payments: r.payments, edits: r.edits, voids: r.voids, logins: r.logins, last: r.lastActive }]));
                expect(got).toEqual(exp);
            }
        ), { numRuns: 200, seed: 145 });
    });
});
