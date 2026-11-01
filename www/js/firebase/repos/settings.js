/**
 * @fileoverview The shared settings document `settings/app`: read once per app
 * open (the version check, labour, bill checks, business details, receipt, TIP
 * and Roles & access use the same read), each section saved by a transaction on
 * its `<section>UpdatedAt` stamp (#113). Moved verbatim out of
 * firestore-service.js (docs/architecture.md, phase 5, #69).
 * @module firebase/repos/settings
 */

import { AppState } from '../../utils/state.js';
import { changedElsewhereError, isOffline, needsInternetError } from '../../utils/write-conflict.js';
import { normalizeSharedReceipt } from '../../utils/printer-settings.js';
import { getDb, col, CLIENT_VERSION } from '../db.js';
import { pauseBackgroundReads } from '../firestore-meter.js';
import { getWithRetry } from '../core/reads.js';
import { settleWrite } from '../core/write-settle.js';

/** settings/app read once per app open (version check + shared labour settings) */
let appSettingsPromise = null;

/** Forgets the settings/app read (sign-out: FirebaseService.cleanup). */
export function forgetAppSettings() {
    appSettingsPromise = null;
}

/**
 * Saves one section of settings/app (#113): a transaction that refuses it (code
 * 'changed-elsewhere') when another phone saved the same section since this phone
 * read settings/app (its `<section>UpdatedAt` stamp moved), so a stale form can't
 * overwrite it; needs the internet. `{ checked: false }`: a plain merge write (the
 * owner's first-start seed, which must not fail offline).
 * `service` is FirebaseService (its loadAppSettings re-reads the document).
 * @private
 */
const settingsSectionQueue = new Map();
function saveSettingsSection(service, fields, stampKey, opts = {}) {
    // One save of a section at a time on this phone: two quick edits are not a "conflict".
    // A save queued behind one that was refused is refused too: its form was as stale.
    const before = settingsSectionQueue.get(stampKey);
    const run = before
        ? before.then(() => saveSettingsSectionNow(service, fields, stampKey, opts))
        : saveSettingsSectionNow(service, fields, stampKey, opts);
    settingsSectionQueue.set(stampKey, run);
    const done = () => { if (settingsSectionQueue.get(stampKey) === run) settingsSectionQueue.delete(stampKey); };
    run.then(done, done);
    return run;
}

async function saveSettingsSectionNow(service, fields, stampKey, { checked = true } = {}) {
    const ref = getDb().collection(col('settings')).doc('app');
    const keepInCache = () => {
        if (appSettingsPromise) {
            appSettingsPromise = appSettingsPromise.then(data => ({ ...(data || {}), ...fields }), () => ({ ...fields }));
        }
    };
    if (!checked) {
        const write = ref.set(fields, { merge: true });
        keepInCache();
        await settleWrite(write, `settings:${stampKey}`);
        return;
    }
    if (isOffline()) throw needsInternetError();
    const loaded = appSettingsPromise ? await appSettingsPromise.catch(() => undefined) : undefined;
    if (loaded === undefined) {
        // settings/app was never read on this phone: the form may not show what is stored,
        // so refuse and read it (the screen then shows the stored values)
        service.loadAppSettings({ refresh: true }).catch(() => {});
        throw changedElsewhereError('Settings');
    }
    const expected = loaded?.[stampKey] ?? null;
    try {
        await getDb().runTransaction(async tx => {
            const snap = await tx.get(ref);
            const current = snap.exists ? (snap.data()?.[stampKey] ?? null) : null;
            if (current !== expected) throw changedElsewhereError('Settings');
            tx.set(ref, fields, { merge: true });
        });
    } catch (error) {
        // Read again so the next save compares with what is stored now
        if (error?.code === 'changed-elsewhere') service.loadAppSettings({ refresh: true }).catch(() => {});
        throw error;
    }
    keepInCache();
}

/** FirebaseService methods for settings/app; spread into FirebaseService (`this` is FirebaseService). */
export const settingsMethods = {
    /**
     * Startup check against settings/app.minClientVersion. Resolves false when
     * this app is older than the minimum (caller shows an update message).
     * Unreadable/missing settings never block.
     * @returns {Promise<boolean>}
     */
    async isClientVersionSupported() {
        try {
            const data = await this.loadAppSettings();
            const min = data ? Number(data.minClientVersion) : NaN;
            return !(Number.isFinite(min) && min > CLIENT_VERSION);
        } catch (e) {
            console.warn('Reading minClientVersion failed:', e?.code || e);
            return true;
        }
    },

    /**
     * Reads the shared settings/app document once per app open (the version check
     * and the shared labour settings use the same read). Resolves null when the
     * document does not exist; rejects when it cannot be read.
     * @param {{refresh?: boolean}} [options]
     * @returns {Promise<Object|null>}
     */
    loadAppSettings({ refresh = false } = {}) {
        if (!appSettingsPromise || refresh) {
            appSettingsPromise = getWithRetry(getDb().collection(col('settings')).doc('app'), 'App settings', { attempts: 2, timeoutMs: 8000 })
                .then(snap => (snap.exists ? snap.data() || {} : null))
                .then(data => {
                    // The owner's kill switch for optional background reads (#159)
                    pauseBackgroundReads(data?.pauseBackgroundReads === true);
                    return data;
                });
            appSettingsPromise.catch(() => { appSettingsPromise = null; });
        }
        return appSettingsPromise;
    },

    /**
     * Saves the labour rate, heavy-packet weight and labour package weight for every device (#20).
     * settings/app is owner-only (firestore.rules); merge keeps minClientVersion etc.
     * @param {{laborRate: number, heavyWeightThreshold: number, labourPackageKg?: number}} labour
     * @returns {Promise<void>}
     */
    async saveSharedLabourSettings({ laborRate, heavyWeightThreshold, labourPackageKg }, opts) {
        const fields = {
            laborRate,
            heavyWeightThreshold,
            ...(labourPackageKg !== undefined ? { labourPackageKg } : {}),
            labourUpdatedAt: Date.now(),
            labourUpdatedBy: AppState.currentUser?.uid || 'unknown'
        };
        await saveSettingsSection(this, fields, 'labourUpdatedAt', opts);
    },

    /**
     * Saves the bill-check limits for every device (#37). settings/app is owner-only.
     * @param {Object} thresholds - normalized (utils/bill-checks.js normalizeThresholds)
     * @returns {Promise<void>}
     */
    async saveSharedCheckThresholds(thresholds, opts) {
        const fields = {
            checkThresholds: { ...thresholds },
            checksUpdatedAt: Date.now(),
            checksUpdatedBy: AppState.currentUser?.uid || 'unknown'
        };
        await saveSettingsSection(this, fields, 'checksUpdatedAt', opts);
    },

    /**
     * Business name and details printed on bills (Settings › Aadhat). settings/app:
     * owner, or a manager allowed in Roles & access (firestore.rules).
     * @param {{businessName: string, businessDetails: string}} details
     * @returns {Promise<void>}
     */
    async saveBusinessDetails({ businessName, businessDetails }, opts) {
        const fields = {
            businessName: String(businessName || ''),
            businessDetails: String(businessDetails || ''),
            businessUpdatedAt: Date.now(),
            businessUpdatedBy: AppState.currentUser?.uid || 'unknown'
        };
        await saveSettingsSection(this, fields, 'businessUpdatedAt', opts);
    },

    /**
     * What the printed bill shows, for every phone (#107): settings/app.receipt
     * { footer, qr, lang, density, logo }. Owner, or a manager allowed in Roles & access;
     * firestore.rules check the shape and the logo's size. A transaction (needs the
     * internet) applies only the changed fields onto the receipt saved now, so a phone
     * with an old copy never overwrites what another phone changed since.
     * @param {Object} patch - the fields this phone changed
     * @param {{base?: Object, onlyIfMissing?: boolean}} [options] - base: the whole receipt when none
     *   is saved yet; onlyIfMissing: change nothing when one is already saved
     * @returns {Promise<{receipt: Object, applied: boolean}>} the receipt saved after this call
     */
    async saveReceiptSettings(patch, { base = null, onlyIfMissing = false } = {}) {
        const ref = getDb().collection(col('settings')).doc('app');
        const result = await getDb().runTransaction(async tx => {
            const snap = await tx.get(ref);
            const current = normalizeSharedReceipt(snap.exists ? snap.data()?.receipt : null);
            if (current && onlyIfMissing) return { receipt: current, applied: false };
            const receipt = normalizeSharedReceipt({ ...(current || base || {}), ...patch });
            const fields = {
                receipt,
                receiptUpdatedAt: Date.now(),
                receiptUpdatedBy: AppState.currentUser?.uid || 'unknown'
            };
            if (snap.exists) tx.update(ref, fields);
            else tx.set(ref, fields);
            return { receipt, applied: true };
        });
        if (appSettingsPromise) {
            appSettingsPromise = appSettingsPromise.then(data => ({ ...(data || {}), receipt: result.receipt }), () => ({ receipt: result.receipt }));
        }
        return result;
    },

    /**
     * Test in Production settings for every device (#217): rollback policies.
     * settings/app is owner-only.
     * @param {Object} policies - normalized (tip/tip.js normalizePolicies)
     * @returns {Promise<void>}
     */
    async saveTipPolicies(policies, opts) {
        const fields = {
            tipPolicies: { ...policies },
            tipUpdatedAt: Date.now(),
            tipUpdatedBy: AppState.currentUser?.uid || 'unknown'
        };
        await saveSettingsSection(this, fields, 'tipUpdatedAt', opts);
    },

    /**
     * Roles & access for every device (#84). settings/app is owner-only;
     * firestore.rules read roleAccess.<role>.editDays for bill edits.
     * @param {{manager: Object, staff: Object}} roleAccess - normalized (utils/role-access.js)
     * @returns {Promise<void>}
     */
    async saveRoleAccess(roleAccess, opts) {
        const fields = {
            roleAccess: { manager: { ...roleAccess.manager }, staff: { ...roleAccess.staff } },
            roleAccessUpdatedAt: Date.now(),
            roleAccessUpdatedBy: AppState.currentUser?.uid || 'unknown'
        };
        await saveSettingsSection(this, fields, 'roleAccessUpdatedAt', opts);
    }
};
