/**
 * Firebase emulator helpers for the E2E suite (REST only, no SDK).
 * Ports match firebase.json and www/firebaseConfig.js (?emulator=1).
 */
const { loadConfig, derive } = require('../../../scripts/happa-config.js');

const PROJECT = derive(loadConfig()).projectId;
const ROOT = `projects/${PROJECT}/databases/(default)/documents`;
const FS = `http://127.0.0.1:8181/v1/${ROOT}`;
const AUTH = 'http://127.0.0.1:9099';
// The Firestore emulator treats "Bearer owner" as an admin token that bypasses rules.
const H = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };

const PASSWORD = 'Test#12345';
const USERS = {
    owner: { email: 'owner@e2e.local', name: 'Owner', role: 'owner', status: 'active' },
    staff: { email: 'staff@e2e.local', name: 'Staff One', role: 'staff', status: 'approved' },
    pending: { email: 'pending@e2e.local', name: 'Pending Person', role: 'staff', status: 'pending' }
};
const ITEMS = [
    { id: 'itm_rice', name: 'Rice', hindiName: 'चावल', rates: [30], saleRates: [36], wholesaleRates: [34] },
    { id: 'itm_wheat', name: 'Wheat', hindiName: 'गेहूं', rates: [22], saleRates: [26], wholesaleRates: [25] },
    { id: 'itm_mustard', name: 'Mustard', hindiName: 'सरसों', rates: [55], saleRates: [62], wholesaleRates: [60] }
];

const enc = (v) => {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === 'string') return { stringValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
    return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
};
const dec = (v) => {
    if ('nullValue' in v) return null;
    if ('booleanValue' in v) return v.booleanValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return v.doubleValue;
    if ('stringValue' in v) return v.stringValue;
    if ('timestampValue' in v) return v.timestampValue;
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
    if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)]));
    return v;
};

async function waitForEmulators(timeoutMs = 120000) {
    const t0 = Date.now();
    for (;;) {
        try {
            const [a, f] = await Promise.all([fetch(`${AUTH}/`), fetch('http://127.0.0.1:8181/')]);
            if (a.ok && f.ok) return;
        } catch { /* not up yet */ }
        if (Date.now() - t0 > timeoutMs) throw new Error('Firebase emulators did not start (auth 9099, firestore 8181)');
        await new Promise(r => setTimeout(r, 500));
    }
}

async function resetEmulators() {
    await fetch(`http://127.0.0.1:8181/emulator/v1/${ROOT}`, { method: 'DELETE' });
    await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
}

async function signUp(email, password = PASSWORD) {
    const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=any`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true })
    });
    const j = await r.json();
    if (!j.localId) throw new Error('signUp failed: ' + JSON.stringify(j));
    return j.localId;
}

/** writes: [[collection, id, data], ...] */
async function commit(writes) {
    const body = { writes: writes.map(([c, id, data]) => ({ update: { name: `${ROOT}/${c}/${id}`, fields: enc(data).mapValue.fields } })) };
    const r = await fetch(`${FS}:commit`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`commit: ${r.status} ${await r.text()}`);
}

async function getDoc(c, id) {
    const r = await fetch(`${FS}/${c}/${encodeURIComponent(id)}`, { headers: H });
    if (r.status === 404) return null;
    const d = await r.json();
    return dec({ mapValue: { fields: d.fields || {} } });
}

async function listDocs(c) {
    const out = [];
    let tok = '';
    for (;;) {
        const r = await fetch(`${FS}/${c}?pageSize=300${tok ? '&pageToken=' + tok : ''}`, { headers: H });
        const j = await r.json();
        (j.documents || []).forEach(d => out.push({ _id: d.name.split('/').pop(), ...dec({ mapValue: { fields: d.fields || {} } }) }));
        if (!j.nextPageToken) break;
        tok = j.nextPageToken;
    }
    return out;
}

async function deleteAll(c) {
    for (const d of await listDocs(c)) {
        await fetch(`${FS}/${c}/${encodeURIComponent(d._id)}`, { method: 'DELETE', headers: H });
    }
}

module.exports = { PASSWORD, USERS, ITEMS, waitForEmulators, resetEmulators, signUp, commit, getDoc, listDocs, deleteAll };
