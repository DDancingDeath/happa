/**
 * @fileoverview Counts Firestore document reads and spots quota errors for
 * the whole app (#194) by wrapping the compat SDK's read/listen/write methods
 * once. Every wrapper returns what the SDK returned (same resolve/reject
 * behaviour, same unsubscribe), so offline-persistence writes still queue.
 * @module firebase/firestore-meter
 */

import {
    createQuotaGuard,
    isQuotaExhaustedError,
    readsForQueryGet,
    readsForDocGet,
    readsForQuerySnapshot,
    readsForDocSnapshot
} from '../utils/quota-guard.js';
import { emit, FIRESTORE_DENIED, READS_ALERT } from '../utils/events.js';

const telemetry = (fn) => {
    import('../services/telemetry.js')
        .then(({ TelemetryService }) => fn(TelemetryService))
        .catch(() => {});
};

/** Session guard shared by the whole app. */
export const quotaGuard = createQuotaGuard({
    onQuota: (source) => {
        telemetry(t => t.logWarning('Firestore daily free limit reached on this device', { source }));
        emit(READS_ALERT, { kind: 'quota', reads: quotaGuard.status().reads });
    },
    onHeavy: (total, top) => {
        telemetry(t => t.logWarning(`Heavy session: about ${total} document reads`, { top }));
        emit(READS_ALERT, { kind: 'heavy', reads: total });
    }
});

/** False while optional background reads must not run (kill switch, quota, session cap). */
export const backgroundReadsAllowed = () => quotaGuard.backgroundAllowed();
/** settings/app.pauseBackgroundReads: the owner's kill switch for background reads. */
export const pauseBackgroundReads = (value) => quotaGuard.setBackgroundPaused(value);

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    // A quota error can arrive before <body> exists; show the banner once it does.
    document.addEventListener('DOMContentLoaded', () => {
        if (quotaGuard.status().quota.count) quotaGuard.showBanner();
    });
}

/** "collection" for a query/collection, "collection (doc)" for a document. */
export function sourceLabel(ref, kind) {
    let path = '';
    try {
        if (typeof ref?.path === 'string') path = ref.path;
        else {
            const p = ref?._delegate?._query?.path;
            if (p) path = typeof p.canonicalString === 'function' ? p.canonicalString() : String(p);
        }
    } catch (_) { path = ''; }
    if (!path) return `query ${kind}`;
    const parts = path.split('/').filter(Boolean);
    const isDoc = parts.length % 2 === 0;
    const collection = isDoc ? parts.slice(0, -1).join('/') : parts.join('/');
    return `${collection}${isDoc ? ' (doc)' : ''} ${kind}`;
}

/** Writes sent and failed reads/writes since the app opened (#119 Status tab). */
const ioCounts = { writes: 0, writeErrors: 0, readErrors: 0, lastWriteAckAt: null };
const isWriteSource = (source) => / (set|update|delete|add)$|^batch commit$/.test(String(source));
const countedErrors = new WeakSet();
/** Transactions that called set / update / delete (a transaction that only read is no write). */
const writingTx = new WeakSet();

const countError = (err, source) => {
    if (err && typeof err === 'object') {
        if (countedErrors.has(err)) return;
        countedErrors.add(err);
    }
    if (source === 'transaction') {
        // The app's own checks throw inside transactions; only the SDK's errors are refused writes.
        if (err?.name === 'FirebaseError') ioCounts.writeErrors++;
        return;
    }
    if (isWriteSource(source)) ioCounts.writeErrors++;
    else ioCounts.readErrors++;
};

const checkError = (err, source) => {
    try { countError(err, source); } catch (_) { /* counting must never break a write */ }
    if (isQuotaExhaustedError(err)) quotaGuard.noteQuotaExhausted(source);
    if (err?.code === 'permission-denied') emit(FIRESTORE_DENIED, source, err);
};

const wrapPromise = (result, source, onValue) => {
    const write = isWriteSource(source);
    if (write) ioCounts.writes++;
    if (!result || typeof result.then !== 'function') return result;
    return result.then(
        (value) => {
            if (write) ioCounts.lastWriteAckAt = Date.now();
            if (onValue) {
                try { onValue(value); } catch (_) { /* counting must never break a read */ }
            }
            return value;
        },
        (err) => {
            checkError(err, source);
            throw err;
        }
    );
};

const isObserver = (o) => !!o && typeof o === 'object' &&
    (typeof o.next === 'function' || typeof o.error === 'function' || typeof o.complete === 'function');

/**
 * Wraps the callbacks of onSnapshot(...args) (all SDK overloads) so each
 * snapshot is counted and listener errors are checked for quota errors.
 */
export function wrapSnapshotArgs(args, source, countSnapshot) {
    const a = [...args];
    let i = 0;
    if (a[0] && typeof a[0] === 'object' && !isObserver(a[0])) i = 1;
    const state = { synced: false };
    const count = (snap) => {
        try { quotaGuard.reads.add(source, countSnapshot(snap, state)); } catch (_) { /* never break a listener */ }
    };
    const onError = (userError) => (err) => {
        checkError(err, source);
        if (userError) return userError(err);
        // Same as the SDK does when no error callback was given.
        console.error('Uncaught Error in snapshot listener:', err);
        return undefined;
    };
    if (isObserver(a[i])) {
        const obs = a[i];
        a[i] = {
            next: (snap) => {
                count(snap);
                if (obs.next) obs.next(snap);
            },
            error: onError(obs.error ? (e) => obs.error(e) : null),
            complete: obs.complete ? () => obs.complete() : undefined
        };
    } else if (typeof a[i] === 'function') {
        const next = a[i];
        const error = typeof a[i + 1] === 'function' ? a[i + 1] : null;
        a[i] = (snap) => {
            count(snap);
            return next(snap);
        };
        a[i + 1] = onError(error);
    }
    return a;
}

const patch = (proto, name, make) => {
    if (!proto || typeof proto[name] !== 'function' || proto[name].__aadhatMeter) return;
    const original = proto[name];
    const wrapped = make(original);
    wrapped.__aadhatMeter = true;
    proto[name] = wrapped;
};

let installed = false;

/**
 * Installs the wrappers on the compat SDK classes (no-op without them, e.g.
 * in unit tests with a fake Firestore). Safe to call more than once.
 * @param {Object} fs the `firebase.firestore` namespace
 * @returns {boolean} true when the SDK classes were found
 */
export function installFirestoreMeter(fs) {
    if (installed || !fs) return installed;
    const Query = fs.Query;
    const DocRef = fs.DocumentReference;
    if (!Query?.prototype || !DocRef?.prototype) return false;
    installed = true;

    patch(Query.prototype, 'get', (orig) => function (...args) {
        const source = sourceLabel(this, 'get');
        return wrapPromise(orig.apply(this, args), source, snap => quotaGuard.reads.add(source, readsForQueryGet(snap)));
    });
    patch(Query.prototype, 'onSnapshot', (orig) => function (...args) {
        return orig.apply(this, wrapSnapshotArgs(args, sourceLabel(this, 'listen'), readsForQuerySnapshot));
    });
    patch(DocRef.prototype, 'get', (orig) => function (...args) {
        const source = sourceLabel(this, 'get');
        return wrapPromise(orig.apply(this, args), source, snap => quotaGuard.reads.add(source, readsForDocGet(snap)));
    });
    patch(DocRef.prototype, 'onSnapshot', (orig) => function (...args) {
        return orig.apply(this, wrapSnapshotArgs(args, sourceLabel(this, 'listen'), readsForDocSnapshot));
    });
    ['set', 'update', 'delete'].forEach(name => patch(DocRef.prototype, name, (orig) => function (...args) {
        return wrapPromise(orig.apply(this, args), sourceLabel(this, name));
    }));
    patch(fs.CollectionReference?.prototype, 'add', (orig) => function (...args) {
        return wrapPromise(orig.apply(this, args), sourceLabel(this, 'add'));
    });
    patch(fs.Transaction?.prototype, 'get', (orig) => function (ref, ...rest) {
        const source = sourceLabel(ref, 'transaction');
        return wrapPromise(orig.call(this, ref, ...rest), source, () => quotaGuard.reads.add(source, 1));
    });
    ['set', 'update', 'delete'].forEach(name => patch(fs.Transaction?.prototype, name, (orig) => function (...args) {
        writingTx.add(this);
        return orig.apply(this, args);
    }));
    patch(fs.WriteBatch?.prototype, 'commit', (orig) => function (...args) {
        return wrapPromise(orig.apply(this, args), 'batch commit');
    });
    patch(fs.Firestore?.prototype, 'runTransaction', (orig) => function (updateFn, ...rest) {
        let lastTx = null;
        const fn = typeof updateFn === 'function'
            ? function (tx, ...a) { lastTx = tx; return updateFn.call(this, tx, ...a); }
            : updateFn;
        const result = orig.call(this, fn, ...rest);
        if (!result || typeof result.then !== 'function') return result;
        return result.then(
            (value) => {
                if (lastTx && writingTx.has(lastTx)) {
                    ioCounts.writes++;
                    ioCounts.lastWriteAckAt = Date.now();
                }
                return value;
            },
            (err) => {
                checkError(err, 'transaction');
                throw err;
            }
        );
    });

    // The SDK only logs quota errors on its streams (listeners stay on cache,
    // writes stay queued and retry), so watch its error log as well.
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
        const originalError = console.error;
        console.error = function (...args) {
            try {
                if (args.some(isQuotaExhaustedError)) quotaGuard.noteQuotaExhausted('firestore log');
            } catch (_) { /* never break logging */ }
            return originalError.apply(this, args);
        };
    }
    return true;
}

/** Diagnostics snapshot (reads since app open, top sources, quota events). */
export const getQuotaStatus = () => quotaGuard.status();

/** Writes sent, failed writes and failed reads/listeners since the app opened. */
export const getIoCounts = () => ({ ...ioCounts });
