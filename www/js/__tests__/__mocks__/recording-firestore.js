/**
 * @fileoverview Records every Firestore call made through a (fake) db: the chain
 * `collection('drafts').doc('d1').set({...})` is logged as
 * `['collection', 'drafts'], ['doc', 'd1'], ['set', {...}]`, transaction and batch
 * calls as `['tx.get', 'ref(drafts/d1)']` / `['batch.delete', ...]`. Used by the
 * repository characterisation tests to pin the exact reads and writes before and
 * after code moves into firebase/repos/ (docs/architecture.md, phase 4).
 */
const LOGGED = new Set([
    'collection', 'doc', 'where', 'orderBy', 'limit', 'startAfter', 'startAt', 'endAt', 'endBefore',
    'get', 'set', 'update', 'delete', 'add', 'onSnapshot', 'batch', 'commit', 'runTransaction'
]);
/** Calls whose result is another db / query / ref object (recorded too). */
const CHAINED = new Set(['collection', 'doc', 'where', 'orderBy', 'limit', 'startAfter', 'startAt', 'endAt', 'endBefore']);

const targets = new WeakMap();
const unwrap = (v) => (v && typeof v === 'object' && targets.has(v) ? targets.get(v) : v);

/** Plain, comparable form of a call argument (refs by path, sentinels by name, callbacks as 'fn'). */
export function describeArg(value) {
    const v = unwrap(value);
    if (typeof v === 'function') return 'fn';
    if (!v || typeof v !== 'object') return v;
    if (typeof v.path === 'string' && typeof v.get === 'function') return `ref(${v.path})`;
    const syms = Object.getOwnPropertySymbols(v);
    if (syms.length) return `${syms[0].description}(${JSON.stringify(v[syms[0]])})`;
    if (Array.isArray(v)) return v.map(describeArg);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, describeArg(x)]));
}

/**
 * Wraps a db so its calls are pushed to `log`.
 * @param {Object} db - e.g. createFakeFirestore().db
 * @param {Array} [log]
 * @returns {{db: Object, log: Array, clear: Function}}
 */
export function recordFirestore(db, log = []) {
    const wrap = (target, scope) => {
        if (!target || typeof target !== 'object') return target;
        const proxy = new Proxy(target, {
            get(t, prop) {
                const v = t[prop];
                if (typeof v !== 'function' || !LOGGED.has(prop)) return v;
                return (...args) => {
                    log.push([scope ? `${scope}.${String(prop)}` : String(prop), ...args.map(describeArg)]);
                    const real = args.map(a => (typeof a === 'function' && prop === 'runTransaction'
                        ? (tx, ...rest) => a(wrap(tx, 'tx'), ...rest)
                        : unwrap(a)));
                    const out = v.apply(t, real);
                    if (CHAINED.has(prop)) return wrap(out, '');
                    if (prop === 'batch') return wrap(out, 'batch');
                    return out;
                };
            }
        });
        targets.set(proxy, target);
        return proxy;
    };
    return { db: wrap(db, ''), log, clear: () => { log.length = 0; } };
}
