/**
 * Characterisation of the Rentals screens and receipts (refactor safety net): one
 * rich fixture (pro-rated first month, the three electricity modes, part payments
 * with paise, a change of unit, a tenant who moved out owing rent) on the
 * in-memory Firestore, "today" = 20 Feb 2028 (a leap February). Pins every figure
 * the Rent / Tenants / Properties pages show, the receipts (RENT-12) and the change
 * of unit / move-in dialogs (RENT-11, RENT-13), as recorded before rent maths moved
 * into rent-math. A snapshot change here is a behaviour change.
 */
import { createFakeFirestore } from './__mocks__/fake-firestore.js';

let fake = createFakeFirestore({ occ: true });
global.__fakeDb = fake.db;
jest.mock('../firebase/firestore-service.js', () => ({
    FirebaseService: { get db() { return global.__fakeDb; }, loadUsers: async () => [], serverTimestamp: () => 'SERVER_TIME' }
}));
jest.mock('../ui/business-switcher.js', () => ({ rentalsRole: jest.fn(() => 'owner') }));
jest.mock('../ui/ui-manager.js', () => ({ UIManager: { showToast: jest.fn(), showModal: jest.fn(async () => true) } }));
jest.mock('../services/audit.js', () => ({ AuditService: { log: jest.fn(async () => {}) } }));
jest.mock('../services/telemetry.js', () => ({ TelemetryService: { logWarning: jest.fn() } }));

import { AppState } from '../utils/state.js';
import * as store from '../rentals/rent-store.js';
import * as rs from '../rentals/rent-receipt-store.js';
import { RentalsModule, _test } from '../rentals/rentals.js';
import { UIManager } from '../ui/ui-manager.js';
import { rentalsRole } from '../ui/business-switcher.js';
import { setLang, resetLangForTests } from '../i18n/index.js';
import { receiptRows, buildReceiptText } from '../rentals/rent-receipt.js';
import { unitRows, summarize, propertySummaries } from '../rentals/rent-views.js';
import { leaseDues, chargeDue, chargeStatus, rentTotals, paidEarlier } from '../rentals/rent-math.js';

const M = '2028-02';
// RENT-1 … RENT-4 in the shape recorded before rentTotals replaced monthSummary.
const monthSummary = (charges, month) => {
    const { expected, collected, pending, due } = rentTotals(charges, month);
    return { expected, collected, pending, outstanding: due };
};
const meta = { archived: false, createdAt: 1, createdBy: 'x', updatedAt: 1, updatedBy: 'x' };
const at = (day) => jest.useFakeTimers({
    now: new Date(`${M}-${String(day).padStart(2, '0')}T12:00:00`),
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'nextTick', 'hrtime', 'performance']
});
const NAMES = { T1: 'Ram', T2: 'Sita', T3: 'Om', T4: 'Gita', T5: 'Hari' };
const pay = (amount, date, n) => ({ amount, mode: 'cash', ref: '', date, by: 'x', byName: 'Owner', id: `p${n}` });
const charge = (leaseId, unitId, propertyId, tenantId, month, { rent, elec = null, paid = 0, payments = [], dueDay = 10 }) => {
    const amount = rent + (elec ? elec.amount : 0);
    return {
        id: `${leaseId}_${month}`, leaseId, unitId, propertyId, tenantId, tenantName: NAMES[tenantId], unitLabel: '', month, dueDay, rent,
        electricity: elec, amount, paid, open: paid < amount, payments, createdAt: 1, updatedAt: 1
    };
};

function seed() {
    fake = createFakeFirestore({ occ: true });
    global.__fakeDb = fake.db;
    fake.seed('rent_properties', [{ id: 'P1', name: 'Gupta Bhawan', kind: 'house', address: 'Civil Lines', ...meta }, { id: 'P2', name: 'Arora Market', kind: 'shop', ...meta }]);
    fake.seed('rent_units', [
        { id: 'U1', propertyId: 'P1', label: '1A', type: 'flat', rent: 5000, leaseId: 'L1', lastReading: 1260, meterRate: 8, floor: '1', area: 650, ...meta },
        { id: 'U2', propertyId: 'P1', label: '2B', type: 'flat', rent: 7000, leaseId: 'L2', ...meta },
        { id: 'U6', propertyId: 'P1', label: '3C', type: 'flat', rent: 6000, leaseId: null, ...meta },
        { id: 'U3', propertyId: 'P2', label: 'Shop 3', type: 'commercial', rent: 12000, leaseId: 'L3', ...meta },
        { id: 'U4', propertyId: 'P2', label: 'G1', type: 'godown', rent: 15000, leaseId: null, lastReading: 410, meterRate: 7, ...meta },
        { id: 'U5', propertyId: 'P2', label: '7', type: 'office', rent: 9000, leaseId: 'L5', lastReading: 95.5, meterRate: 9.5, ...meta }
    ]);
    fake.seed('rent_tenants', [
        { id: 'T1', name: 'Ram', phone: '9876543210', ...meta }, { id: 'T2', name: 'Sita', phone: '9876543211', phone2: '9876500002', ...meta },
        { id: 'T3', name: 'Om', phone: '9876543212', notes: 'Pays by cheque', ...meta }, { id: 'T4', name: 'Gita', phone: '9876543213', ...meta },
        { id: 'T5', name: 'Hari', phone: '9876543214', ...meta }
    ]);
    const lease = (id, unitId, propertyId, tenantId, over) => ({
        id, unitId, propertyId, tenantId, dueDay: 10, increasePct: 5, deposit: 0, endMonth: null, status: 'active', chargedThrough: M, ...meta, ...over
    });
    fake.seed('rent_leases', [
        lease('L1', 'U1', 'P1', 'T1', { rent: 5000, startDate: '2027-06-01', startMonth: '2027-06', elecMode: 'meter', deposit: 10000 }),
        lease('L2', 'U2', 'P1', 'T2', { rent: 7000, dueDay: 5, startDate: '2027-12-12', startMonth: '2027-12', proRate: true, firstRent: 4516, elecMode: 'included' }),
        lease('L3', 'U3', 'P2', 'T3', { rent: 12000, dueDay: 28, startDate: '2027-01-05', startMonth: '2027-01', elecMode: 'own', meterNo: 'MTR-77', increasePct: 10, deposit: 24000 }),
        lease('L4', 'U4', 'P2', 'T4', { rent: 15000, startDate: '2027-08-01', startMonth: '2027-08', elecMode: 'meter', status: 'ended', endMonth: '2028-01', chargedThrough: '2028-01', movedTo: 'L5' }),
        lease('L5', 'U5', 'P2', 'T4', { rent: 9000, startDate: '2028-01-20', startMonth: '2028-01', proRate: true, firstRent: 3484, elecMode: 'meter', fromLeaseId: 'L4' }),
        lease('L6', 'U6', 'P1', 'T5', { rent: 6000, startDate: '2027-03-01', startMonth: '2027-03', elecMode: 'included', status: 'ended', endMonth: '2027-12', chargedThrough: '2027-12' })
    ]);
    fake.seed('rent_charges', [
        charge('L1', 'U1', 'P1', 'T1', '2028-01', { rent: 5000, elec: { prev: 1100, curr: 1200, rate: 8, units: 100, amount: 800 }, paid: 3000, payments: [pay(3000, '2028-01-12', 1)] }),
        charge('L1', 'U1', 'P1', 'T1', M, { rent: 5000, elec: { prev: 1200, curr: 1260, rate: 8, units: 60, amount: 480 } }),
        charge('L2', 'U2', 'P1', 'T2', '2027-12', { rent: 4516, paid: 4516, dueDay: 5, payments: [pay(4516, '2027-12-12', 2)] }),
        charge('L2', 'U2', 'P1', 'T2', '2028-01', { rent: 7000, paid: 7000, dueDay: 5, payments: [pay(7000, '2028-01-04', 3)] }),
        charge('L2', 'U2', 'P1', 'T2', M, { rent: 7000, paid: 2500, dueDay: 5, payments: [pay(2500, '2028-02-03', 4)] }),
        charge('L3', 'U3', 'P2', 'T3', M, { rent: 12000, paid: 12000, dueDay: 28, payments: [pay(12000, '2028-02-02', 5)] }),
        charge('L4', 'U4', 'P2', 'T4', '2028-01', { rent: 9194, elec: { prev: 380, curr: 410, rate: 10, units: 30, amount: 300 }, paid: 5000, payments: [pay(5000, '2028-01-08', 6)] }),
        charge('L5', 'U5', 'P2', 'T4', '2028-01', { rent: 3484, paid: 3484, payments: [pay(3484, '2028-01-20', 7)] }),
        charge('L5', 'U5', 'P2', 'T4', M, { rent: 9000, elec: { prev: 50, curr: 95.5, rate: 9.5, units: 45.5, amount: 432.25 }, paid: 4000.25, payments: [pay(4000.25, '2028-02-09', 8)] }),
        charge('L6', 'U6', 'P1', 'T5', '2027-11', { rent: 6000, paid: 1000, payments: [pay(1000, '2027-11-30', 9)] }),
        charge('L6', 'U6', 'P1', 'T5', '2027-12', { rent: 6000 })
    ]);
}

/** Visible text as lines (one per block), so a snapshot diff shows which figure moved. */
function lines(root) {
    const copy = root.cloneNode(true);
    copy.querySelectorAll('div, li, h3, h4, p, ul, button, option, label, span.rent-badge').forEach(e => e.append('\n'));
    return copy.textContent.split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
const flush = () => new Promise(r => setTimeout(r));
async function waitFor(test) {
    for (let i = 0; i < 200 && !test(); i++) await flush();
    expect(test()).toBeTruthy();
}
const body = () => document.getElementById('rentalsBody');
async function show(page, { view = 'properties', openProperty = '' } = {}) {
    _test.state.page = page;
    _test.state.view = view;
    _test.state.openProperty = openProperty;
    _test.render();
    if (page === 'tenants') await waitFor(() => document.querySelector('#rentTenantUnit'));
    return lines(body());
}
async function attach() {
    store.detach();
    _test.state.loaded = new Set();
    _test.state.charged = new Set();
    store.attach(M, (k) => _test.state.loaded.add(k));
    await fake.settle();
}
const toasts = () => UIManager.showToast.mock.calls.map(([m, type]) => `${type}: ${m}`);
const modals = () => UIManager.showModal.mock.calls.map(([m]) => m);
const set = (id, v) => { document.getElementById(id).value = v; };
const fire = (id) => document.getElementById(id).dispatchEvent(new Event('change'));
const dialogOpen = (id) => () => document.getElementById(id) && !document.getElementById('rentDialog').hidden;
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o && k in o).map(k => [k, o[k]]));
const CHARGE_KEYS = ['month', 'rent', 'electricity', 'amount', 'paid', 'open'];
let seeded = new Map();
const allCharges = () => [...fake.raw('rent_charges').entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([id, c]) => ({ id: /^L\d_/.test(id) ? id : `new_${c.month}`, ...pick(c, CHARGE_KEYS) }));
const remember = () => { seeded = new Map(allCharges().map(c => [c.id, JSON.stringify(c)])); };
/** Charges that are new, changed or removed since the fixture was loaded. */
const charges = () => {
    const now = allCharges();
    const ids = new Set(now.map(c => c.id));
    return [...now.filter(c => seeded.get(c.id) !== JSON.stringify(c)), ...[...seeded.keys()].filter(id => !ids.has(id)).map(id => ({ id, removed: true }))];
};
const leaseOut = (l) => pick(l, ['unitId', 'rent', 'dueDay', 'increasePct', 'deposit', 'elecMode', 'startDate', 'startMonth', 'proRate', 'firstRent', 'status', 'endMonth', 'chargedThrough']);
/** The change dialog's split fields as shown. */
const splitShown = () => ({
    on: document.getElementById('rentSplitOn').checked,
    boxHidden: document.getElementById('rentSplitBox').hidden,
    oldHidden: document.getElementById('rentSplitOldL').hidden,
    oldLabel: document.getElementById('rentSplitOldL').firstChild.textContent,
    old: document.getElementById('rentSplitOld').value,
    newLabel: document.getElementById('rentSplitNewL').firstChild.textContent,
    next: document.getElementById('rentSplitNew').value,
    help: document.getElementById('rentSplitHelp').textContent,
    readOnly: document.getElementById('rentSplitOld').readOnly
});

beforeAll(() => {
    AppState.currentUser = { uid: 'owner1' };
    AppState.userName = 'Owner';
    document.body.innerHTML = `<div id="rentals" class="tab active"><div id="rentalsNotice"></div><div id="rentalsBody"></div>
        <div id="rentDialog" hidden><div id="rentDialogBody"></div><div class="rent-dialog-actions"><button class="rent-btn rent-btn-primary">Save</button></div></div></div>`;
    window.app = { rentals: { ...RentalsModule.api } };
    _test.state.month = M;
});

beforeEach(async () => {
    at(20);
    seed();
    store._resetSettingsCache();
    rentalsRole.mockReturnValue('owner');
    UIManager.showToast.mockClear();
    UIManager.showModal.mockClear();
    _test.state.filters = { propertyId: '', type: '', status: '', q: '', sort: 'desc' };
    await attach();
    remember();
});

afterEach(() => {
    RentalsModule.api.dialogClose(false);
    jest.useRealTimers();
    resetLangForTests();
});

describe.each(['en', 'hi'])('pages (%s)', (lang) => {
    test('Rent: property cards, each property, unit list; Tenants; Properties', async () => {
        setLang(lang);
        const out = {
            propertyCards: await show('rent'),
            guptaBhawan: await show('rent', { openProperty: 'P1' }),
            aroraMarket: await show('rent', { openProperty: 'P2' }),
            unitList: await show('rent', { view: 'units' }),
            tenants: await show('tenants'),
            properties: await show('properties')
        };
        expect(out).toMatchSnapshot();
    });
});

test('the figures behind the pages (unit rows, totals, per-tenant dues, month summary)', () => {
    const d = store.snapshot();
    const rows = unitRows(d, M);
    const dues = Object.fromEntries(['L1', 'L2', 'L3', 'L4', 'L5', 'L6'].map(id => {
        const x = leaseDues(d.charges, id);
        return [id, { total: x.total, months: x.charges.map(c => [c.month, chargeDue(c), chargeStatus(c)]) }];
    }));
    expect({
        rows, all: summarize(rows), properties: propertySummaries(d.properties, rows).map(x => [x.property.id, x.summary]),
        dues, monthSummary: monthSummary(d.charges, M), lastMonth: monthSummary(d.charges, '2028-01')
    }).toMatchSnapshot();
});

test('unit list filters: late, due, one property, sorted ascending', async () => {
    setLang('en');
    await show('rent', { view: 'units' });
    const ids = () => [...body().querySelectorAll('[data-unit]')].map(e => e.getAttribute('data-unit'));
    const totals = () => [...body().querySelectorAll('.rent-card-value')].map(e => e.textContent);
    const out = {};
    for (const [field, value] of [['status', 'late'], ['status', 'due'], ['status', ''], ['propertyId', 'P2'], ['sort', 'asc']]) {
        RentalsModule.api.filterUnits(field, value);
        out[`${field}=${value}`] = { units: ids(), totals: totals() };
    }
    expect(out).toMatchSnapshot();
});

test('receipts: part payment by UPI with a meter bill, paise, a moved-out tenant, the pro-rated old unit, issued later (en + hi)', async () => {
    const rc = { place: '1A, Gupta Bhawan', ut: 'flat' };
    const paid = [];
    paid.push(await store.recordPayment(`L1_${M}`, { amount: 2000, mode: 'upi', ref: 'UPI-881', date: '2028-02-20' }, rc));
    paid.push(await store.recordPayment(`L5_${M}`, { amount: 5432, mode: 'bank', ref: '', date: '2028-02-20' }, { place: '7, Arora Market', ut: 'office' }));
    paid.push(await store.recordPayment('L6_2027-11', { amount: 1500, mode: 'cash', ref: '', date: '2028-02-19' }, { place: '3C, Gupta Bhawan', ut: 'flat' }));
    paid.push(await store.recordPayment('L4_2028-01', { amount: 4494, mode: 'cheque', ref: 'CHQ 0042', date: '2028-02-18' }, { place: 'G1, Arora Market', ut: 'godown' }));
    // #129: typed ₹1,000.50 is saved as ₹1,001 (whole rupees; the receipt was pinned with ₹1,000.5 before)
    paid.push(await store.recordPayment(`L2_${M}`, { amount: 1000.5, mode: 'cash', ref: '', date: '2028-02-20' }, null));
    const later = await rs.issueReceipt(`L2_${M}`, 1, { place: '2B, Gupta Bhawan', ut: 'flat' });
    const receipts = [...paid.map(p => p.receipt).filter(Boolean), later];
    const out = receipts.map(r => ({
        stored: pick(r, ['no', 'months', 'rent', 'elec', 'total', 'paid', 'mode', 'ref', 'date', 'balance', 'place', 'ut']),
        paidEarlier: paidEarlier(r),
        en: receiptRows(r, 'en'),
        hi: receiptRows(r, 'hi'),
        text: buildReceiptText({ ...r, biz: 'Sharma Rentals', bizAddr: 'Main Road' }, { lang: 'en', link: '' }).split('\n')
    }));
    expect(paid.map(p => pick(p, ['amount', 'paid', 'open', 'noReceipt']))).toMatchSnapshot('payments');
    expect(out).toMatchSnapshot('receipts');
    expect(charges()).toMatchSnapshot('charges after payments');
    setLang('en');
    await attach();
    expect(await show('rent', { view: 'units' })).toMatchSnapshot('unit list after payments');
});

describe('change of unit and move in (RENT-11, RENT-13)', () => {
    async function changeUnit(tenant, unitId, { date, typed = null, off = false } = {}) {
        await show('tenants');
        const p = _test.toUnit(tenant, unitId);
        await waitFor(dialogOpen('rentSplitOn'));
        const shown = { opened: splitShown() };
        if (date) {
            set('rentTDate', date);
            fire('rentTDate');
            shown.afterDate = splitShown();
        }
        if (off) {
            document.getElementById('rentSplitOn').checked = false;
            fire('rentSplitOn');
            shown.afterOff = splitShown();
        }
        if (typed) Object.entries(typed).forEach(([id, v]) => set(id, v));
        RentalsModule.api.dialogClose(true);
        await p;
        await fake.settle();
        const leases = [...fake.raw('rent_leases').entries()].filter(([id]) => !/^L\d$/.test(id)).map(([, l]) => leaseOut(l));
        return { ...shown, modals: modals(), toasts: toasts(), oldLease: leaseOut(fake.raw('rent_leases').get(tenant.lease)), newLeases: leases, charges: charges() };
    }

    test('member moves Ram (meter, nothing paid) from 1A to G1 the day before yesterday: both units pro-rated by days of the leap February', async () => {
        rentalsRole.mockReturnValue('member');
        setLang('en');
        expect(await changeUnit({ id: 'T1', name: 'Ram', lease: 'L1' }, 'U4', { date: '2028-02-19' })).toMatchSnapshot();
    });

    test('member moves Sita (part paid) on the 18th: Hindi texts', async () => {
        rentalsRole.mockReturnValue('member');
        setLang('hi');
        expect(await changeUnit({ id: 'T2', name: 'Sita', lease: 'L2' }, 'U6', { date: '2028-02-18' })).toMatchSnapshot();
    });

    test('manager types an old-unit amount below what is paid: the month closes at what is paid', async () => {
        rentalsRole.mockReturnValue('manager');
        setLang('en');
        expect(await changeUnit({ id: 'T2', name: 'Sita', lease: 'L2' }, 'U4', { date: '2028-02-18', typed: { rentSplitOld: '1000', rentSplitNew: '4000' } })).toMatchSnapshot();
    });

    test('manager types amounts out of range: refused, nothing saved', async () => {
        rentalsRole.mockReturnValue('manager');
        setLang('en');
        const over = await changeUnit({ id: 'T1', name: 'Ram', lease: 'L1' }, 'U6', { date: '2028-02-19', typed: { rentSplitNew: '6001' } });
        const old = await changeUnit({ id: 'T1', name: 'Ram', lease: 'L1' }, 'U6', { date: '2028-02-19', typed: { rentSplitOld: '-1' } });
        expect({ over: over.toasts, old: old.toasts, charges: old.charges, newLeases: old.newLeases }).toMatchSnapshot();
    });

    test('owner unticks "Pro-rate move month": both units the full month', async () => {
        setLang('en');
        expect(await changeUnit({ id: 'T4', name: 'Gita', lease: 'L5' }, 'U4', { date: '2028-02-07', off: true })).toMatchSnapshot();
    });

    test('a move on 1 Feb: the old lease ends in January, the new unit pays the full month', async () => {
        at(2);
        rentalsRole.mockReturnValue('member');
        setLang('en');
        fake.seed('rent_charges', [charge('L1', 'U1', 'P1', 'T1', M, { rent: 5000 })]);
        await attach();
        expect(await changeUnit({ id: 'T1', name: 'Ram', lease: 'L1' }, 'U4', { date: '2028-02-01' })).toMatchSnapshot();
    });

    test('member: start more than 2 days back, and a lease charged ahead of the move', async () => {
        rentalsRole.mockReturnValue('member');
        setLang('en');
        const tooOld = await changeUnit({ id: 'T3', name: 'Om', lease: 'L3' }, 'U6', { date: '2028-02-17' });
        at(2);
        fake.seed('rent_leases', [{ ...fake.raw('rent_leases').get('L3'), id: 'L3', chargedThrough: '2028-03' }]);
        await attach();
        UIManager.showToast.mockClear();
        const ahead = await changeUnit({ id: 'T3', name: 'Om', lease: 'L3' }, 'U6', { date: '2028-02-01' });
        expect({ tooOld: tooOld.toasts, ahead: ahead.toasts, newLeases: ahead.newLeases }).toMatchSnapshot();
    });

    test('Add unit with its tenant: opening meter reading checks, then saved with a pro-rated first month', async () => {
        setLang('en');
        const addUnit = async (fill) => {
            UIManager.showToast.mockClear();
            const p = RentalsModule.api.addUnit('P1');
            await waitFor(dialogOpen('rentUnitLabel'));
            set('rentUnitLabel', '4D');
            set('rentUnitRent', '6500');
            document.getElementById('rentTOn').checked = true;
            set('rentTName', 'Mohan');
            set('rentTPhone', '9876500009');
            set('rentTDate', '2028-02-20');
            document.getElementById('rentTProRate').checked = true;
            set('rentTElec', 'meter');
            fill();
            RentalsModule.api.dialogClose(true);
            await p;
            await fake.settle();
            return toasts();
        };
        const out = {
            badReading: await addUnit(() => { set('rentTOpen', '-5'); set('rentTRate', '8'); }),
            badRate: await addUnit(() => { set('rentTOpen', '300'); set('rentTRate', '-1'); }),
            badDay: await addUnit(() => { set('rentTOpen', '300'); set('rentTRate', '8'); set('rentTDay', '29'); }),
            saved: await addUnit(() => { set('rentTOpen', '300'); set('rentTRate', '7.5'); })
        };
        const unit = [...fake.raw('rent_units').values()].find(u => u.label === '4D');
        const lease = [...fake.raw('rent_leases').values()].find(l => l.unitId && fake.raw('rent_units').get(l.unitId)?.label === '4D');
        expect({ ...out, unit: pick(unit, ['rent', 'lastReading', 'meterRate', 'type']), lease: leaseOut(lease), charges: charges() }).toMatchSnapshot();
    });
});
