/**
 * @fileoverview Telemetry Service for error tracking and diagnostics
 * Captures all errors and exceptions, groups them, and stores in Firestore
 * @module services/telemetry
 */

import { AppState } from '../utils/state.js';
import { noteTipError } from '../tip/index.js';
import { saveTelemetryReport, recentTelemetryReports, hideTelemetryReports, deleteTelemetryReportsBefore } from '../firebase/repos/telemetry.js';
import { safeSetItem } from '../utils/storage-full.js';
import { describeLogArg, scrubText, scrubUrl } from '../utils/scrub.js';

/**
 * Maximum number of errors to store locally before syncing
 * @constant {number}
 */
const MAX_LOCAL_ERRORS = 50;

/**
 * Debounce time for syncing errors to Firestore (ms)
 * @constant {number}
 */
const SYNC_DEBOUNCE = 5000;

/**
 * Pause after a failed sync before writing again (ms); doubles on each
 * consecutive failure up to MAX_SYNC_BACKOFF.
 * @constant {number}
 */
const SYNC_BACKOFF = 60 * 1000;
const MAX_SYNC_BACKOFF = 60 * 60 * 1000;

/**
 * Errors caused by Firestore being unavailable/over quota. Reporting them
 * to Firestore would only fail again (or burn more quota), so they are
 * not captured.
 * @constant {RegExp}
 */
const FIRESTORE_UNAVAILABLE_PATTERN = /resource-exhausted|quota exceeded|RESOURCE_EXHAUSTED/i;

/** Longest stored text per field; firestore.rules (validTelemetryEntry) rejects longer. */
const TELEMETRY_TEXT_LIMITS = {
    type: 40, message: 1000, source: 500, stack: 4000, context: 2000, date: 40,
    url: 500, userAgent: 500, userName: 200, userRole: 32
};

const clip = (value, max) => (value === undefined || value === null ? undefined : String(value).slice(0, max));

const SCRUBBED_FIELDS = new Set(['message', 'stack', 'context']);

/** How long an error report is kept after it was last seen (#116; the audit log keeps 90 days too). */
const REPORT_KEEP_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * The telemetry document for one grouped error, holding only the fields the
 * rules allow (#122): reports are create-only, one document per sync.
 * @param {Object} group - grouped error (see syncToFirestore)
 * @param {string} uid - signed-in user's uid (rules require it)
 * @returns {Object}
 */
function buildTelemetryDoc(group, uid) {
    const doc = {
        userId: uid,
        fingerprint: String(group.fingerprint || 'unknown').slice(0, 40),
        count: Math.min(Math.max(1, Math.round(Number(group.count) || 1)), 100),
        occurrences: (group.occurrences || []).slice(-10),
        timestamp: group.timestamp,
        lastSeen: group.lastSeen,
        firstSeen: group.timestamp
    };
    if (group.line !== undefined) doc.line = group.line;
    if (group.column !== undefined) doc.column = group.column;
    Object.entries(TELEMETRY_TEXT_LIMITS).forEach(([key, max]) => {
        let value = group[key];
        if (key === 'context' && value !== undefined && typeof value !== 'string') {
            try { value = JSON.stringify(value); } catch (_) { value = String(value); }
        }
        // #116: no emails, phone numbers, amounts or tokens in stored reports
        if (SCRUBBED_FIELDS.has(key)) value = scrubText(value);
        if (key === 'url' || key === 'source') value = scrubUrl(value);
        const text = clip(value, max);
        if (text !== undefined) doc[key] = text;
    });
    Object.keys(doc).forEach(key => doc[key] === undefined && delete doc[key]);
    return doc;
}

/**
 * Merges report documents of the same error (same fingerprint) into one entry
 * for the Diagnostics list: counts add up, first/last seen span all reports,
 * the latest report's text is shown. Legacy docs (one per fingerprint, no
 * `fingerprint` field) group by their document id.
 * @param {Array<Object>} docs - `{ id, ...data }`
 * @returns {Array<Object>} newest first; `docIds` lists the merged documents
 */
function mergeTelemetryReports(docs) {
    const byFingerprint = new Map();
    (docs || []).forEach(d => {
        const key = d.fingerprint || d.id;
        const prev = byFingerprint.get(key);
        if (!prev) {
            byFingerprint.set(key, { ...d, id: key, docIds: [d.id], count: d.count || 1, occurrences: [...(d.occurrences || [])] });
            return;
        }
        const newer = (d.lastSeen || 0) > (prev.lastSeen || 0);
        const merged = newer ? { ...prev, ...d, id: key } : prev;
        merged.docIds = [...prev.docIds, d.id];
        merged.count = (prev.count || 1) + (d.count || 1);
        merged.lastSeen = Math.max(prev.lastSeen || 0, d.lastSeen || 0);
        merged.firstSeen = Math.min(prev.firstSeen || prev.lastSeen || Infinity, d.firstSeen || d.lastSeen || Infinity);
        merged.occurrences = [...prev.occurrences, ...(d.occurrences || [])]
            .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
            .slice(-10);
        byFingerprint.set(key, merged);
    });
    return [...byFingerprint.values()].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

/**
 * Telemetry Service - Captures and stores application errors
 * @namespace TelemetryService
 */
const TelemetryService = {
    /**
     * Local error buffer
     * @type {Array}
     */
    errorBuffer: [],

    /**
     * Sync timer ID
     * @type {number|null}
     */
    syncTimer: null,

    /**
     * Whether telemetry is initialized
     * @type {boolean}
     */
    initialized: false,

    /**
     * No sync attempts before this time (ms epoch) after failures
     * @type {number}
     */
    backoffUntil: 0,

    /**
     * Current backoff duration (ms)
     * @type {number}
     */
    backoffMs: 0,

    /**
     * Initialize telemetry service
     */
    init() {
        if (this.initialized) return;

        // Override global error handlers
        const originalOnError = window.onerror;
        window.onerror = (message, source, lineno, colno, error) => {
            this.captureError({
                type: 'uncaught',
                message: message,
                source: source,
                line: lineno,
                column: colno,
                stack: error?.stack
            });
            if (originalOnError) {
                originalOnError(message, source, lineno, colno, error);
            }
        };

        // Capture unhandled promise rejections
        window.addEventListener('unhandledrejection', (event) => {
            this.captureError({
                type: 'unhandledrejection',
                message: event.reason?.message || String(event.reason),
                stack: event.reason?.stack
            });
        });

        // Intercept console.error
        const originalConsoleError = console.error;
        console.error = (...args) => {
            this.captureConsoleError(args);
            originalConsoleError.apply(console, args);
        };

        this.initialized = true;
        console.log('Telemetry service initialized');
    },

    /**
     * Capture a console.error call
     * @param {Array} args - Console error arguments
     */
    captureConsoleError(args) {
        // Objects are reduced to their error code: data objects carry names and amounts (#116)
        const message = args.map(describeLogArg).join(' ');

        // Skip certain noisy errors
        if (message.includes('Telemetry') || 
            message.includes('telemetry') ||
            message.includes('FirebaseError: The query requires an index')) {
            return;
        }

        this.captureError({
            type: 'console.error',
            message: message.substring(0, 500), // Limit message length
            stack: args.find(a => a instanceof Error)?.stack
        });
    },

    /**
     * Capture an error
     * @param {Object} errorData - Error data
     */
    captureError(errorData) {
        if (FIRESTORE_UNAVAILABLE_PATTERN.test(String(errorData?.message || ''))) {
            return;
        }
        // TIP error watcher (#217): errors during an open scenario run turn a pass into a warning
        noteTipError();
        const error = {
            ...errorData,
            timestamp: Date.now(),
            date: new Date().toISOString(),
            url: window.location.href,
            userAgent: navigator.userAgent,
            userId: AppState.currentUser?.uid || 'anonymous',
            userName: AppState.userName || 'Unknown',
            userRole: AppState.userRole || 'unknown',
            // Create a fingerprint for grouping
            fingerprint: this.createFingerprint(errorData)
        };

        this.errorBuffer.push(error);

        // Limit buffer size
        if (this.errorBuffer.length > MAX_LOCAL_ERRORS) {
            this.errorBuffer.shift();
        }

        // Debounced sync
        this.schedulSync();
    },

    /**
     * Create a fingerprint for error grouping
     * @param {Object} errorData - Error data
     * @returns {string} Fingerprint hash
     */
    createFingerprint(errorData) {
        const parts = [
            errorData.type,
            errorData.message?.substring(0, 100),
            errorData.source?.split('/').pop(),
            errorData.line
        ].filter(Boolean);
        
        // Simple hash
        const str = parts.join('|');
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString(36);
    },

    /**
     * Schedule sync to Firestore
     */
    schedulSync() {
        if (this.syncTimer) {
            clearTimeout(this.syncTimer);
        }
        const delay = Math.max(SYNC_DEBOUNCE, this.backoffUntil - Date.now());
        this.syncTimer = setTimeout(() => this.syncToFirestore(), delay);
    },

    /**
     * Sync errors to Firestore
     */
    async syncToFirestore() {
        if (this.errorBuffer.length === 0) return;
        if (!AppState.currentUser) return;
        if (Date.now() < this.backoffUntil) {
            this.schedulSync();
            return;
        }

        let errorsToSync = [...this.errorBuffer];
        this.errorBuffer = [];

        try {
            // Group errors by fingerprint
            const grouped = {};
            errorsToSync.forEach(error => {
                const fp = error.fingerprint;
                if (!grouped[fp]) {
                    grouped[fp] = {
                        ...error,
                        count: 0,
                        occurrences: []
                    };
                }
                grouped[fp].count++;
                grouped[fp].lastSeen = error.timestamp;
                grouped[fp].occurrences.push({
                    timestamp: error.timestamp,
                    userId: error.userId,
                    userName: error.userName
                });
                // Keep only last 10 occurrences
                if (grouped[fp].occurrences.length > 10) {
                    grouped[fp].occurrences.shift();
                }
            });

            // One new document per grouped error (create-only, #122): rules
            // forbid rewriting reports, so nothing is read or updated here.
            const uid = AppState.currentUser.uid;
            const entries = Object.entries(grouped);
            const results = await Promise.allSettled(entries.map(([fingerprint, errorData]) => {
                const id = `${fingerprint}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
                return saveTelemetryReport(id, buildTelemetryDoc(errorData, uid));
            }));

            const failedFingerprints = new Set(entries
                .filter((entry, i) => results[i].status === 'rejected')
                .map(([fingerprint]) => fingerprint));
            if (failedFingerprints.size > 0) {
                // Only the failed groups need to be retried later
                errorsToSync = errorsToSync.filter(e => failedFingerprints.has(e.fingerprint));
                throw results.find(r => r.status === 'rejected').reason;
            }
            this.backoffMs = 0;
            this.backoffUntil = 0;
        } catch (error) {
            // Don't recursively log telemetry errors
            console.warn('Telemetry sync failed:', error?.message);
            // Back off so a failing/over-quota Firestore isn't hammered
            this.backoffMs = Math.min(this.backoffMs ? this.backoffMs * 2 : SYNC_BACKOFF, MAX_SYNC_BACKOFF);
            this.backoffUntil = Date.now() + this.backoffMs;
            // Re-add errors to buffer
            this.errorBuffer = [...errorsToSync, ...this.errorBuffer].slice(0, MAX_LOCAL_ERRORS);
        }
    },

    /**
     * Manually log an error
     * @param {string} message - Error message
     * @param {Object} [context] - Additional context
     */
    logError(message, context = {}) {
        this.captureError({
            type: 'manual',
            message: message,
            context: context
        });
    },

    /**
     * Manually log a warning
     * @param {string} message - Warning message
     * @param {Object} [context] - Additional context
     */
    logWarning(message, context = {}) {
        this.captureError({
            type: 'warning',
            message: message,
            context: context
        });
    },

    /**
     * Get all telemetry data (owner only)
     * @returns {Promise<Array>} Telemetry data
     */
    async getTelemetryData() {
        if (AppState.userRole !== 'owner') {
            throw new Error('Unauthorized');
        }

        try {
            const docs = await recentTelemetryReports(300);
            this.cleanupOldReports().catch(e => console.warn('Old error reports not deleted:', e?.code || e));
            return mergeTelemetryReports(docs.filter(d => d.hidden !== true));
        } catch (error) {
            console.warn('Failed to get telemetry data:', error.message);
            return [];
        }
    },

    /**
     * Retention (#116, as the audit log): the owner's phone deletes reports last seen
     * more than 90 days ago, hidden or not, at most 450 per run (one bounded query),
     * at most once a day per phone.
     * @param {number} [now]
     * @returns {Promise<number>} how many were deleted
     */
    async cleanupOldReports(now = Date.now()) {
        if (AppState.userRole !== 'owner') return 0;
        const key = 'happaTelemetryCleanup';
        if (now - (Number(localStorage.getItem(key)) || 0) < 24 * 60 * 60 * 1000) return 0;
        const deleted = await deleteTelemetryReportsBefore(now - REPORT_KEEP_MS, 450);
        safeSetItem(key, String(now));
        return deleted;
    },

    /**
     * Hides error reports (owner only, #116): marked `hidden`, never deleted, so the
     * record stays in Firestore; Diagnostics stops listing them.
     * @param {string[]} docIds - report documents (every one merged into the entries shown)
     * @returns {Promise<number>} how many were hidden
     */
    async hideErrors(docIds) {
        if (AppState.userRole !== 'owner') {
            throw new Error('Unauthorized');
        }
        const ids = [...new Set((docIds || []).filter(Boolean))];
        if (!ids.length) return 0;
        await hideTelemetryReports(ids, AppState.currentUser?.uid || null);
        return ids.length;
    }
};

export { TelemetryService, buildTelemetryDoc, mergeTelemetryReports };
