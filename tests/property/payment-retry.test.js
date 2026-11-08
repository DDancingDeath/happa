/**
 * @fileoverview D-1 (#70): a due payment the user retries is recorded at most once, whatever the
 * network does. Each attempt's commit may not reach the server, or reach it with its answer lost;
 * the server check afterwards may answer or not; this phone's listener may bring the bill back or
 * not. The user retries the same amount until told it was recorded. Then the bill has exactly one
 * entry when any attempt reached the server (none otherwise), one audit entry per payment entry
 * (written in the same commit, D-3), and the phone never says "not recorded" or "internet
 * required" for a payment that is on the server.
 */
jest.mock('../../www/js/firebase/repos/bill-payments.js', () => {
    const actual = jest.requireActual('../../www/js/firebase/repos/bill-payments.js');
    return { ...actual, readBillFromServer: jest.fn(actual.readBillFromServer) };
});

import fc from 'fast-check';
import { readBillFromServer } from '../../www/js/firebase/repos/bill-payments.js';
import { OutstandingManager } from '../../www/js/modules/outstanding.js';
import { CashManagementManager } from '../../www/js/modules/cash-management.js';
import { FirebaseService } from '../../www/js/firebase/firestore-service.js';
import { UIManager } from '../../www/js/ui/ui-manager.js';
import { AppState } from '../../www/js/utils/state.js';
import { readPayment } from '../../www/js/utils/money.js';
import { forgetPaymentIntents } from '../../www/js/services/payment-intents.js';
import { t } from '../../www/js/i18n/index.js';
import { createFakeFirestore } from '../../www/js/__tests__/__mocks__/fake-firestore.js';

const RUNS = Number(process.env.FC_RUNS) || 200;
const FC = { seed: 70, numRuns: RUNS, endOnFailure: true };
const actualRead = jest.requireActual('../../www/js/firebase/repos/bill-payments.js').readBillFromServer;
const copy = (v) => JSON.parse(JSON.stringify(v));
const lost = () => Object.assign(new Error('Failed to get document because the client is offline.'), { code: 'unavailable' });

const BILL = {
    id: 'r1', billNumber: 'S1', customerName: 'Sita', total: 795, cashPayment: 300, onlinePayment: 0, dueAmount: 495,
    payment: { cash: 300, online: 0, due: 495, total: 795 }
};

const attemptArb = fc.record({
    reachesServer: fc.boolean(),
    answerLost: fc.boolean(),
    serverAnswers: fc.boolean(),
    listenerDelivers: fc.boolean()
});

beforeEach(() => {
    jest.spyOn(UIManager, 'hapticFeedback').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(OutstandingManager, 'renderDue').mockImplementation(() => {});
    jest.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
    window.getCollection = (n) => n;
    AppState.currentUser = { uid: 'u1', email: 'o@x' };
    AppState.userName = 'Owner';
    CashManagementManager.todaySession = null;
});
afterEach(() => {
    jest.restoreAllMocks();
    delete window.getCollection;
    AppState.retailSalesHistory = [];
});

test('D-1: retrying one payment through lost answers records it at most once', async () => {
    await fc.assert(fc.asyncProperty(fc.array(attemptArb, { minLength: 1, maxLength: 5 }), fc.constantFrom(100, 495), async (attempts, amount) => {
        forgetPaymentIntents();
        const fake = createFakeFirestore();
        fake.seed('retailSales', [BILL]);
        AppState.retailSalesHistory = [{ ...copy(BILL) }];
        let current = null;
        const db = {
            ...fake.db,
            runTransaction: async (fn) => {
                if (!current.reachesServer) throw lost();
                const out = await fake.db.runTransaction(fn);
                if (current.answerLost) throw lost();
                return out;
            }
        };
        jest.spyOn(FirebaseService, 'db', 'get').mockReturnValue(db);
        readBillFromServer.mockImplementation((...args) => (current.serverAnswers ? actualRead(...args) : Promise.resolve(null)));
        const toasts = [];
        jest.spyOn(UIManager, 'showToast').mockImplementation((m) => { toasts.push(m); });
        const server = () => fake.raw('retailSales').get('r1');
        const entries = () => (server().payments || []).length;

        let reached = false;
        for (const attempt of attempts) {
            current = attempt;
            reached = reached || attempt.reachesServer;
            toasts.length = 0;
            const ok = await OutstandingManager.recordDuePayment({ billType: 'retail', billId: 'r1', cash: amount, online: 0 });
            expect(entries()).toBeLessThanOrEqual(1);
            expect(toasts).not.toContain(t('msg.common.internet_required_record_payment'));
            if (toasts.includes(t('msg.outstanding.payment_not_saved', { total: String(amount) }))) expect(entries()).toBe(0);
            if (ok) expect(entries()).toBe(1);
            if (attempt.listenerDelivers) AppState.retailSalesHistory = [{ ...copy(server()), id: 'r1' }];
            if (ok) break;
        }
        expect(entries()).toBe(reached ? 1 : 0);
        expect(readPayment(server()).due).toBe(reached ? 495 - amount : 495);
        expect(fake.raw('auditLogs').size).toBe(entries());
    }), FC);
});
