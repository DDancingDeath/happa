/**
 * Makes an ANONYMISED old-app backup for the migration end-to-end test, in the
 * format of tools/backup/export-firestore.js (decrypted), plus the matching
 * Auth export (`firebase auth:export --format=json`) with SCRYPT hashes of
 * known test passwords and test hash parameters.
 *
 *   node tests/migration-e2e/make-old-backup.js --out <dir> [--now <ISO>] [--seed 7]
 *
 * Writes <dir>/firestore-backup.json, users.json, hash-params.txt and
 * logins.json (the test passwords). Two years of history from the shared
 * generator (tests/fixtures/generator.js) ending yesterday, plus hand-made
 * bills for every shape the real data has (see EDGE below). Nothing here is
 * real shop data; it is generated at test time and never committed.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { generateShop, ITEMS } from '../fixtures/generator.js';

process.env.TZ = 'Asia/Kolkata';
const require = createRequire(import.meta.url);
const { firebaseScrypt } = require('./firebase-scrypt.js');

const DAY = 86400000;
const pad = (v, n = 2) => String(v).padStart(n, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const compact = (d) => isoDay(d).replace(/-/g, '');
const isoLocal = (d) => `${isoDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const dmy = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
const dmyTime = (d) => {
    const h = d.getHours();
    return `${dmy(d)}, ${h % 12 || 12}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${h < 12 ? 'am' : 'pm'}`;
};
const ts = (ms) => ({ __type: 'timestamp', iso: new Date(ms).toISOString(), millis: ms, seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 });
const BILL_PREFIX = { purchase: 'P', retail: 'S', wholesale: 'W' };

/** Test logins: role, profile and the ORIGINAL password the app test signs in with. */
export const LOGINS = [
    { key: 'owner', uid: 'old-owner-01', email: 'owner@old-shop.test', name: 'Malik', role: 'owner', status: 'active', password: 'Owner#old-2024' },
    { key: 'manager', uid: 'old-manager-02', email: 'manager@old-shop.test', name: 'Munim Ji', role: 'manager', status: 'approved', rentRole: 'manager', password: 'Manager#old-2024' },
    { key: 'member', uid: 'old-member-03', email: 'member@old-shop.test', name: 'राजू', role: 'staff', status: 'approved', password: 'Member#old-2024' },
    { key: 'legacyMember', uid: 'old-member-04', email: 'helper@old-shop.test', name: 'Helper', role: 'staff', password: 'Helper#old-2024' },
    { key: 'pending', uid: 'old-pending-05', email: 'new@old-shop.test', name: 'New Person', role: 'staff', status: 'pending', password: 'Pending#old-2024' }
];
/** The archived staging clone's login (#101): in the old data, never carried (tools/migrate/lib/service-accounts.js). */
export const SERVICE_LOGIN = { uid: 'old-staging-ro-07', email: 'staging-readonly@aadhat.local', name: 'Staging read-only', role: 'staff', status: 'active', password: 'Staging#old-2024' };

function args(argv) {
    const get = (n) => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
    return { out: get('--out'), now: get('--now'), seed: Number(get('--seed') || 7) };
}

/**
 * @param {{now?: number, seed?: number}} [o]
 * @returns {{backup: Object, authExport: Object, hashParamsText: string, logins: Object}}
 */
export function makeOldBackup({ now = Date.now(), seed = 7 } = {}) {
    const today = new Date(now);
    const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const daysAgo = (n, h = 11, m = 15) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - n, h, m, 0).getTime();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 730);
    const shop = generateShop({ seed, years: 2, start: isoDay(start), openingRate: 0, creditRate: 0.05 });

    // ---- bills from the generator: numbers per type and day, wholesale source, createdAt on newer bills
    const kinds = [['purchase', shop.purchases], ['retail', shop.retailSales], ['wholesale', shop.wholesaleSales]];
    const timeOf = (b) => (typeof b.timestamp === 'number' ? b.timestamp : Date.parse(b.date.includes('/') ? b.date.replace(/^(\d\d)\/(\d\d)\/(\d{4}).*$/, '$3-$2-$1T12:00:00') : b.date));
    let n = 0;
    kinds.forEach(([kind, list]) => {
        const seq = new Map();
        [...list].sort((a, b) => timeOf(a) - timeOf(b)).forEach(b => {
            const day = compact(new Date(timeOf(b)));
            const s = (seq.get(day) || 0) + 1;
            seq.set(day, s);
            b.billNumber = `${BILL_PREFIX[kind]}${day}-${pad(s, 3)}`;
            b.type = kind;
            if (kind === 'purchase') b.isPurchase = true;
            if (kind === 'wholesale' && (n++ % 5) !== 0) b.source = 'sales-tab';
            if (timeOf(b) > now - 200 * DAY) b.createdAt = ts(timeOf(b));
        });
    });

    // ---- EDGE: hand-made bills for the shapes the real data has
    const line = (item, qty, rate, extra = {}) => ({ itemId: item.id, name: item.name, qty, rate, total: Math.round(qty * rate), ...extra });
    const [wheat, rice, mustard, , gram] = ITEMS;
    const todayKey = compact(today);
    const yKey = compact(new Date(daysAgo(1)));
    const retail = (id, at, o) => ({ id, type: 'retail', timestamp: at, date: isoLocal(new Date(at)), ...o });
    const edge = {
        retail: [
            // DD/MM date with time, dueAmount only (no payment object)
            { id: 'edge-ddmm-dueonly', type: 'retail', date: dmyTime(new Date(daysAgo(40, 10, 5))), billNumber: `S${compact(new Date(daysAgo(40)))}-091`,
                customerName: 'Bhola Nath', items: [line(rice, 40, 40)], total: 1600, cashPayment: 100, dueAmount: 1500 },
            // plain DD/MM date, payment.* split; case variant of the same party
            { id: 'edge-ddmm-split', type: 'retail', date: dmy(new Date(daysAgo(75))), billNumber: `S${compact(new Date(daysAgo(75)))}-091`,
                customerName: 'bhola nath ', items: [line(wheat, 50, 30)], total: 1500, cashPayment: 500, onlinePayment: 300, dueAmount: 700,
                payment: { cash: 500, online: 300, due: 700, total: 1500 } },
            retail('edge-case-upper', daysAgo(5, 17, 40), { billNumber: `S${compact(new Date(daysAgo(5)))}-091`, customerName: 'BHOLA  NATH',
                items: [line(gram, 5, 60)], total: 300, cashPayment: 0, onlinePayment: 0, dueAmount: 300, payment: { cash: 0, online: 0, due: 300, total: 300 } }),
            // Hindi party and name-only lines (Hindi name, odd-cased English name, no itemId)
            retail('edge-hindi', daysAgo(120, 9, 30), { billNumber: `S${compact(new Date(daysAgo(120)))}-091`, customerName: 'राम लाल',
                items: [{ name: 'गेहूं', qty: 20, rate: 32, total: 640 }, { name: ' RICE ', qty: 30, rate: 52, total: 1560 }],
                total: 2200, cashPayment: 0, dueAmount: 2200, payment: { cash: 0, online: 0, due: 2200, total: 2200 } }),
            // the same Hindi name with a decomposed nukta (U+0915 U+093C vs U+0958): one party
            retail('edge-nukta-a', daysAgo(33, 12), { billNumber: `S${compact(new Date(daysAgo(33)))}-091`, customerName: '\u0958ासिम',
                items: [line(mustard, 2, 70)], total: 140, dueAmount: 140, payment: { cash: 0, online: 0, due: 140, total: 140 } }),
            retail('edge-nukta-b', daysAgo(64, 12), { billNumber: `S${compact(new Date(daysAgo(64)))}-091`, customerName: '\u0915\u093Cासिम',
                items: [line(mustard, 3, 70)], total: 210, dueAmount: 210, payment: { cash: 0, online: 0, due: 210, total: 210 } }),
            // duplicate bill numbers (two devices, same day), both still due
            retail('edge-dup-a', daysAgo(95, 10), { billNumber: `S${compact(new Date(daysAgo(95)))}-002`, customerName: 'Gupta Traders',
                items: [line(rice, 10, 45)], total: 450, dueAmount: 450, payment: { cash: 0, online: 0, due: 450, total: 450 } }),
            retail('edge-dup-b', daysAgo(95, 16), { billNumber: `S${compact(new Date(daysAgo(95)))}-002`, customerName: 'Sharma Stores',
                items: [line(wheat, 10, 31)], total: 310, dueAmount: 310, payment: { cash: 0, online: 0, due: 310, total: 310 } }),
            // overpaid: negative due, and paid more than the total with due 0
            retail('edge-overpaid-neg', daysAgo(20), { billNumber: `S${compact(new Date(daysAgo(20)))}-091`, customerName: 'Mohan',
                items: [line(rice, 10, 50)], total: 500, cashPayment: 700, dueAmount: -200, payment: { cash: 700, online: 0, due: -200, total: 500 } }),
            retail('edge-overpaid-zero', daysAgo(21), { billNumber: `S${compact(new Date(daysAgo(21)))}-091`, customerName: 'Mohan',
                items: [line(rice, 4, 50)], total: 200, payment: { cash: 150, online: 100, due: 0, total: 200 }, dueAmount: 0,
                payments: [{ id: 'pay-edge-op', amount: 100, cash: 0, online: 100, at: daysAgo(18) }] }),
            // cleared (old "mark as cleared") but the due fields still hold an amount
            retail('edge-cleared-with-due', daysAgo(50), { billNumber: `S${compact(new Date(daysAgo(50)))}-091`, customerName: 'Sita',
                items: [line(gram, 10, 80)], total: 800, cleared: true, dueAmount: 800, payment: { cash: 0, online: 0, due: 800, total: 800 } }),
            // payments[] with a write-off that settles it, and one that leaves a due
            retail('edge-writeoff-settled', daysAgo(150), { billNumber: `S${compact(new Date(daysAgo(150)))}-091`, customerName: 'Ravi',
                items: [line(wheat, 30, 30)], total: 900, cashPayment: 400, dueAmount: 0, cleared: true,
                payment: { cash: 600, online: 0, due: 0, total: 600, writtenOff: 300 },
                payments: [{ id: 'pay-edge-w1', amount: 200, cash: 200, online: 0, at: daysAgo(140) }, { id: 'wo-edge-w1', kind: 'writeOff', amount: 300, at: daysAgo(120) }] }),
            retail('edge-writeoff-partial', daysAgo(65), { billNumber: `S${compact(new Date(daysAgo(65)))}-091`, customerName: 'Ravi',
                items: [line(mustard, 20, 62)], total: 1240, cashPayment: 240, dueAmount: 250,
                payment: { cash: 640, online: 100, due: 250, total: 740, writtenOff: 250 },
                payments: [{ id: 'pay-edge-w2', amount: 400, date: dmyTime(new Date(daysAgo(60))) }, { id: 'pay-edge-w3', amount: 100, cash: 0, online: 100, at: daysAgo(55) },
                    { id: 'wo-edge-w2', kind: 'writeOff', amount: 250, at: daysAgo(50) }] }),
            // a bill with a due but no customer name
            retail('edge-no-name', daysAgo(12), { billNumber: `S${compact(new Date(daysAgo(12)))}-091`, customerName: '',
                items: [line(rice, 1, 50)], total: 50, cashPayment: 0, onlinePayment: 0, dueAmount: 50 }),
            // today's bills: one paid, one on credit (carried; Today must not show it as activity)
            retail('edge-today-paid', daysAgo(0, 9, 5), { billNumber: `S${todayKey}-001`, customerName: 'Walk-in',
                items: [line(rice, 2, 50)], total: 100, cashPayment: 100, onlinePayment: 0, dueAmount: 0, payment: { cash: 100, online: 0, due: 0, total: 100 } }),
            retail('edge-today-due', daysAgo(0, 9, 20), { billNumber: `S${todayKey}-002`, customerName: 'Shyam Lal', customerPhone: '9000000001',
                items: [line(wheat, 15, 30)], total: 450, cashPayment: 0, onlinePayment: 0, dueAmount: 450, payment: { cash: 0, online: 0, due: 450, total: 450 } }),
            retail('edge-today-3', daysAgo(0, 9, 40), { billNumber: `S${todayKey}-003`, customerName: 'Walk-in',
                items: [line(gram, 1, 60)], total: 60, cashPayment: 60, dueAmount: 0, payment: { cash: 60, online: 0, due: 0, total: 60 } }),
            retail('edge-yesterday', daysAgo(1, 18), { billNumber: `S${yKey}-005`, customerName: 'Walk-in',
                items: [line(gram, 1, 60)], total: 60, cashPayment: 60, dueAmount: 0, payment: { cash: 60, online: 0, due: 0, total: 60 } }),
            // a legacy bill number and a very old due (90+)
            { id: 'edge-legacy-number', date: dmyTime(new Date(daysAgo(400, 11))), billNumber: 'S-OLD-7', customerName: ' राम  लाल ',
                items: [{ name: 'चावल', qty: 5, rate: 40 }], total: 200, dueAmount: 200 }
        ],
        wholesale: [
            // Wholesale page rule: payment.due 0 and nothing received = the whole total is due
            { id: 'edge-w-due-zero', type: 'wholesale', source: 'sales-tab', timestamp: daysAgo(25, 13), date: isoLocal(new Date(daysAgo(25, 13))),
                billNumber: `W${compact(new Date(daysAgo(25)))}-091`, customerName: 'Gupta Traders', customer: 'Gupta Traders',
                items: [{ itemId: rice.id, name: rice.name, quantity: 100, rate: 50, total: 5000 }], total: 5000, payment: { cash: 0, online: 0, due: 0, total: 0 } },
            { id: 'edge-w-due', type: 'wholesale', source: 'sales-tab', timestamp: daysAgo(70, 13), date: isoLocal(new Date(daysAgo(70, 13))),
                billNumber: `W${compact(new Date(daysAgo(70)))}-091`, customerName: 'gupta traders', customer: 'gupta traders',
                items: [{ itemId: wheat.id, name: wheat.name, quantity: 120, rate: 30, total: 3600 }], total: 3600, payment: { cash: 2400, online: 0, due: 1200, total: 2400 } },
            // not made on the Wholesale page: no page shows its due (not carried by default)
            { id: 'edge-w-hidden', type: 'wholesale', timestamp: daysAgo(30, 13), date: isoLocal(new Date(daysAgo(30, 13))),
                billNumber: `W${compact(new Date(daysAgo(30)))}-091`, customerName: 'Sharma Stores',
                items: [{ itemId: gram.id, name: gram.name, quantity: 30, rate: 60, total: 1800 }], total: 1800, payment: { cash: 900, online: 0, due: 900, total: 900 } }
        ],
        purchase: [
            // a supplier still owed (payables are checked, not carried)
            { id: 'edge-p-payable', type: 'purchase', isPurchase: true, timestamp: daysAgo(10, 8), date: isoLocal(new Date(daysAgo(10, 8))),
                billNumber: `P${compact(new Date(daysAgo(10)))}-091`, customerName: 'Kisan Mandi',
                items: [line(wheat, 100, 25)], billTotal: 2500, laborCharges: 12, grandTotal: 2488, cashPayment: 1488, dueAmount: 1000,
                payment: { cash: 1488, online: 0, due: 1000, total: 2488 } },
            { id: 'edge-p-today', type: 'purchase', isPurchase: true, timestamp: daysAgo(0, 8), date: isoLocal(new Date(daysAgo(0, 8))),
                billNumber: `P${todayKey}-001`, customerName: 'Kisan Mandi',
                items: [line(rice, 200, 30)], billTotal: 6000, laborCharges: 24, grandTotal: 5976, cashPayment: 5976, dueAmount: 0,
                payment: { cash: 5976, online: 0, due: 0, total: 5976 } }
        ]
    };
    shop.retailSales.push(...edge.retail);
    shop.wholesaleSales.push(...edge.wholesale);
    shop.purchases.push(...edge.purchase);

    const docs = (list) => list.map(({ id, ...data }) => ({ id: String(id), data }));
    const items = ITEMS.map((i, k) => ({
        id: i.id,
        data: {
            name: i.name, hindiName: i.hindiName, rates: [i.cost, i.cost - 1], saleRates: [Math.round(i.cost * 1.2), Math.round(i.cost * 1.25)],
            wholesaleRates: [Math.round(i.cost * 1.1)], unit: 'kg', createdAt: ts(start.getTime() + k * 60000), updatedAt: ts(now - (k + 1) * DAY)
        }
    }));
    const users = [...LOGINS, SERVICE_LOGIN].map(u => ({
        id: u.uid,
        data: {
            name: u.name, email: u.email, role: u.role, ...(u.status ? { status: u.status } : {}), ...(u.rentRole ? { rentRole: u.rentRole } : {}),
            createdAt: ts(start.getTime() + 3600000), ...(u.role === 'owner' ? { approvedAt: ts(start.getTime() + 7200000) } : { approvedBy: 'old-owner-01' })
        }
    }));
    const sessions = [];
    shop.sessions.forEach((s, i) => {
        const { id, ...rest } = s;
        sessions.push({ id, data: { ...rest, openingBalance: s.openingBalance, signInTime: `${s.date}T03:30:00.000Z`, signedOut: true, closingBalance: s.openingBalance, userId: 'old-owner-01', userName: 'Malik' } });
        // two sessions on one day (a second phone opened the drawer)
        if (i % 97 === 5) sessions.push({ id: `${id}-b`, data: { ...rest, duePayments: [], openingBalance: 0, signInTime: `${s.date}T09:00:00.000Z`, signedOut: false, userId: 'old-member-03', userName: 'राजू' } });
    });
    const todaySession = { id: `s-${isoDay(today)}`, data: { date: isoDay(today), openingBalance: 1500, signInTime: new Date(daysAgo(0, 9)).toISOString(), signedOut: false, duePayments: [], userId: 'old-owner-01' } };
    const collections = {
        items,
        users,
        purchases: docs(shop.purchases),
        retailSales: docs(shop.retailSales),
        wholesaleSales: docs(shop.wholesaleSales),
        stockAdjustments: docs(shop.stockAdjustments),
        expenses: docs(shop.expenses),
        withdrawals: docs(shop.withdrawals),
        cashManagement: [...sessions, todaySession, { id: `s-${isoDay(today)}-b`, data: { ...todaySession.data, openingBalance: 200, userId: 'old-member-03' } }],
        cashSessions: [{ id: 'legacy-session', data: { date: isoDay(new Date(daysAgo(300))), opening: 1000 } }],
        settings: [
            { id: 'app', data: {
                laborRate: 7, heavyWeightThreshold: 32, labourPackageKg: 35, checkThresholds: { maxBillAmount: 150000, maxRate: 500 },
                minClientVersion: 3, enforceClientVersion: true, downloadUrl: 'https://aadhat-management.web.app/download', updatedAt: ts(now - 9 * DAY)
            } },
            { id: 'billNumbers', data: { perDevice: true } }
        ],
        counters: [
            { id: `S${todayKey}`, data: { next: 2, initialized: true, prefix: 'S', date: todayKey, updatedAt: daysAgo(0, 9, 20) } },
            { id: `P${todayKey}`, data: { next: 1, initialized: true, prefix: 'P', date: todayKey } },
            { id: `S${yKey}`, data: { next: 5, initialized: true, prefix: 'S', date: yKey } },
            { id: `W${compact(new Date(daysAgo(25)))}`, data: { next: 91, initialized: true, prefix: 'W', date: compact(new Date(daysAgo(25))) } }
        ],
        rateHistory: ITEMS.slice(0, 3).map((i, k) => ({ id: `rh-${k}`, data: { itemId: i.id, itemName: i.name, rateType: 'saleRates', oldRate: i.cost, newRate: i.cost + 2, changedAt: ts(now - (k + 3) * DAY), changedBy: 'old-owner-01' } })),
        itemFrequency: [{ id: 'old-owner-01', data: Object.fromEntries(ITEMS.map((i, k) => [i.id, 50 - k * 7])) }, { id: SERVICE_LOGIN.uid, data: { [ITEMS[0].id]: 3 } }],
        // the old app's own rate stats: replaced by the ones built from every old bill
        rateStats: [{ id: '_meta', data: { backfillDone: true, backfillAt: now - 100 * DAY, bills: 12, reads: 900, months: 3, by: 'owner', byUserId: 'old-owner-01' } }],
        stockCheckpoints: [{ id: 'cp-1', data: { at: now - 30 * DAY, qty: { [wheat.id]: 100 } } }],
        notifications: [{ id: 'n-1', data: { to: ['old-member-03'], title: 'Rate changed', createdAt: ts(now - 3 * DAY) } }],
        auditLogs: [{ id: 'a-1', data: { action: 'login', userId: 'old-owner-01', at: ts(now - DAY) } }],
        telemetry: [{ id: 't-1', data: { day: isoDay(today), saves: 3 } }],
        // never carried
        dev_retailSales: [{ id: 'dev-1', data: { billNumber: 'S-DEV-1', customerName: 'Dev', dueAmount: 999, total: 999, items: [] } }],
        dev_users: [{ id: 'dev-user', data: { name: 'Dev', role: 'owner', status: 'approved' } }],
        dev_items: [{ id: 'dev-item', data: { name: 'Dev Item', rates: [1] } }]
    };
    const backup = {
        format: 'aadhat-backup-v1', mode: 'weekly', exportedAt: new Date(now).toISOString(), env: 'prod', project: 'aadhat-management',
        collections,
        subcollections: { 'users/preferences': [{ path: 'users/old-owner-01/preferences/ui', data: { lang: 'hi' } }] }
    };
    backup.manifest = {
        format: backup.format, mode: backup.mode, exportedAt: backup.exportedAt, project: backup.project,
        totalDocs: Object.values(collections).reduce((a, l) => a + l.length, 0) + 1,
        collections: Object.fromEntries(Object.entries(collections).map(([k, l]) => [k, l.length])), subcollections: { 'users/preferences': 1 }
    };

    // ---- Auth export with SCRYPT hashes (test signer key, not the shop's)
    const params = { key: crypto.randomBytes(64), saltSeparator: Buffer.from('Bw==', 'base64'), rounds: 8, memoryCost: 14 };
    const authUsers = [...LOGINS, SERVICE_LOGIN].map((u, i) => {
        const salt = crypto.randomBytes(12).toString('base64');
        return {
            localId: u.uid, email: u.email, emailVerified: i === 0, passwordHash: firebaseScrypt(u.password, salt, params), salt,
            lastSignedInAt: String(now - (i + 1) * DAY), createdAt: String(start.getTime() + 3600000),
            providerUserInfo: [{ providerId: 'password', rawId: u.email, email: u.email, federatedId: u.email }]
        };
    });
    // a login whose profile was deleted in the old app
    const orphanSalt = crypto.randomBytes(12).toString('base64');
    authUsers.push({ localId: 'old-orphan-06', email: 'left@old-shop.test', emailVerified: false, disabled: true,
        passwordHash: firebaseScrypt('Left#old-2024', orphanSalt, params), salt: orphanSalt, createdAt: String(start.getTime()),
        providerUserInfo: [{ providerId: 'password', rawId: 'left@old-shop.test', email: 'left@old-shop.test', federatedId: 'left@old-shop.test' }] });
    const hashParamsText = [
        'hash_config {',
        '  algorithm: SCRYPT,',
        `  base64_signer_key: ${params.key.toString('base64')},`,
        `  base64_salt_separator: ${params.saltSeparator.toString('base64')},`,
        `  rounds: ${params.rounds},`,
        `  mem_cost: ${params.memoryCost},`,
        '}'
    ].join('\n');
    const logins = Object.fromEntries(LOGINS.map(u => [u.key, { uid: u.uid, email: u.email, password: u.password, role: u.role, name: u.name }]));
    return { backup, authExport: { users: authUsers }, hashParamsText, logins };
}

/** Writes the four files into `out`. */
export function writeOldBackup(out, o) {
    const r = makeOldBackup(o);
    fs.mkdirSync(out, { recursive: true });
    const files = {
        backup: path.join(out, 'firestore-backup.json'),
        auth: path.join(out, 'users.json'),
        hashParams: path.join(out, 'hash-params.txt'),
        logins: path.join(out, 'logins.json')
    };
    fs.writeFileSync(files.backup, JSON.stringify(r.backup));
    fs.writeFileSync(files.auth, JSON.stringify(r.authExport, null, 1));
    fs.writeFileSync(files.hashParams, r.hashParamsText);
    fs.writeFileSync(files.logins, JSON.stringify(r.logins, null, 1));
    return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const a = args(process.argv.slice(2));
    if (!a.out) {
        console.error('Usage: node tests/migration-e2e/make-old-backup.js --out <dir> [--now <ISO>] [--seed 7]');
        process.exit(2);
    }
    const files = writeOldBackup(a.out, { now: a.now ? Date.parse(a.now) : Date.now(), seed: a.seed });
    console.log(`Old-app backup (synthetic): ${files.backup}`);
}
