/**
 * @fileoverview Minimal in-memory Firestore (compat API subset) for unit tests:
 * collection/doc refs, where (==, in, >, >=, <, <=) / orderBy / limit /
 * startAfter(doc) queries,
 * get(), onSnapshot() with sequential docChanges(), set (merge) / update
 * (dotted paths) / delete / add, batches, transactions and
 * FieldValue.increment / delete. Also counts billed document reads.
 */
import { compareFirestoreValues } from '../../utils/history-range.js';

const deepClone = (v) => {
    if (Array.isArray(v)) return v.map(deepClone);
    if (v && typeof v === 'object') {
        const out = {};
        Object.keys(v).forEach(k => { out[k] = deepClone(v[k]); });
        return out;
    }
    return v;
};
const clone = (v) => (v === undefined ? undefined : deepClone(v));

const getPath = (data, path) => path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), data);

const typeRank = (v) => {
    if (v === null) return 0;
    if (typeof v === 'boolean') return 1;
    if (typeof v === 'number') return 2;
    if (typeof v === 'string') return 4;
    return 5;
};

const matches = (data, { field, op, value }, id) => {
    const v = field === '__name__' ? id : getPath(data, field);
    if (op === 'in') return value.includes(v);
    if (v === undefined) return false;
    if (op === '==') return compareFirestoreValues(v, value) === 0 && typeRank(v) === typeRank(value);
    if (typeRank(v) !== typeRank(value)) return false;
    const c = compareFirestoreValues(v, value);
    switch (op) {
        case '>': return c > 0;
        case '>=': return c >= 0;
        case '<': return c < 0;
        case '<=': return c <= 0;
        default: throw new Error(`op ${op} not supported`);
    }
};

const INC = Symbol('increment');
const DEL = Symbol('delete');

function applyFields(target, fields, { dotted }) {
    const out = clone(target) || {};
    Object.entries(fields).forEach(([key, value]) => {
        const path = dotted ? key.split('.') : [key];
        let o = out;
        for (let i = 0; i < path.length - 1; i++) {
            if (!o[path[i]] || typeof o[path[i]] !== 'object') o[path[i]] = {};
            o = o[path[i]];
        }
        const last = path[path.length - 1];
        if (value && value[DEL]) {
            delete o[last];
        } else if (value && value[INC] !== undefined) {
            o[last] = (typeof o[last] === 'number' ? o[last] : 0) + value[INC];
        } else {
            o[last] = clone(value);
        }
    });
    return out;
}

export function createFakeFirestore(options = {}) {
    const store = new Map();
    const listeners = new Set();
    const stats = { reads: 0, gets: 0, docGets: 0, listens: 0, writes: 0, queryLog: [], listenLog: [] };
    const failures = options.failures || {};
    let flushScheduled = false;
    let serverHeld = !!options.holdServer;
    let idCounter = 0;

    const coll = (name) => {
        if (!store.has(name)) store.set(name, new Map());
        return store.get(name);
    };

    const docSnap = (collName, id, data) => ({
        id,
        exists: data !== undefined,
        ref: docRef(collName, id),
        data: () => clone(data),
        metadata: { fromCache: false, hasPendingWrites: false }
    });

    const evaluate = (q) => {
        let rows = [...coll(q.coll).entries()].filter(([id, d]) => q.filters.every(f => matches(d, f, id)));
        rows = rows.filter(([, d]) => q.order.every(o => getPath(d, o.field) !== undefined));
        const lastDir = q.order.length ? q.order[q.order.length - 1].dir : 'asc';
        rows.sort((a, b) => {
            for (const o of q.order) {
                const c = compareFirestoreValues(getPath(a[1], o.field), getPath(b[1], o.field));
                if (c) return o.dir === 'desc' ? -c : c;
            }
            const c = a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
            return lastDir === 'desc' ? -c : c;
        });
        if (q.after) {
            const at = rows.findIndex(([id]) => id === q.after);
            rows = at === -1 ? rows : rows.slice(at + 1);
        }
        if (q.limitN) rows = rows.slice(0, q.limitN);
        return rows.map(([id, d]) => ({ id, data: d }));
    };

    const querySnap = (q, rows, changes, fromCache = false) => ({
        docs: rows.map(r => docSnap(q.coll, r.id, r.data)),
        size: rows.length,
        empty: rows.length === 0,
        metadata: { fromCache, hasPendingWrites: false },
        docChanges: () => changes
    });

    const diff = (q, prev, next) => {
        const cur = prev.slice();
        const changes = [];
        const nextIds = new Set(next.map(r => r.id));
        for (let i = cur.length - 1; i >= 0; i--) {
            if (!nextIds.has(cur[i].id)) {
                changes.push({ type: 'removed', oldIndex: i, newIndex: -1, doc: docSnap(q.coll, cur[i].id, cur[i].data) });
                cur.splice(i, 1);
            }
        }
        next.forEach((row, i) => {
            const j = cur.findIndex(r => r.id === row.id);
            if (j === i && cur[i].data === row.data) return;
            const doc = docSnap(q.coll, row.id, row.data);
            if (j === -1) {
                changes.push({ type: 'added', oldIndex: -1, newIndex: i, doc });
                cur.splice(i, 0, row);
            } else {
                changes.push({ type: 'modified', oldIndex: j, newIndex: i, doc });
                cur.splice(j, 1);
                cur.splice(i, 0, row);
            }
        });
        return changes;
    };

    const flush = () => {
        flushScheduled = false;
        listeners.forEach(l => {
            if (!l.started || l.held) return;
            if (l.kind === 'doc') {
                const data = coll(l.coll).get(l.id);
                if (data === l.last) return;
                l.last = data;
                stats.reads++;
                l.next(docSnap(l.coll, l.id, data));
                return;
            }
            const rows = evaluate(l.q);
            const changes = diff(l.q, l.last, rows);
            if (!changes.length) return;
            stats.reads += changes.filter(c => c.type !== 'removed').length;
            l.last = rows;
            l.next(querySnap(l.q, rows, changes));
        });
    };
    const scheduleFlush = () => {
        if (!flushScheduled) {
            flushScheduled = true;
            Promise.resolve().then(flush);
        }
    };

    const write = (collName, id, data) => {
        stats.writes++;
        if (data === undefined) coll(collName).delete(id);
        else coll(collName).set(id, data);
        scheduleFlush();
    };

    const startListener = (l) => {
        Promise.resolve().then(() => {
            if (!listeners.has(l)) return;
            const fail = failures[l.coll];
            if (fail && l.kind === 'query') {
                l.error(fail);
                return;
            }
            l.started = true;
            if (l.kind === 'doc') {
                l.last = coll(l.coll).get(l.id);
                stats.reads++;
                const snap = docSnap(l.coll, l.id, l.last);
                if (serverHeld) {
                    l.held = true;
                    snap.metadata = { fromCache: true };
                }
                l.next(snap);
                return;
            }
            l.last = evaluate(l.q);
            stats.reads += Math.max(1, l.last.length);
            if (serverHeld) l.held = true;
            l.next(querySnap(l.q, l.last, l.last.map((r, i) => ({ type: 'added', oldIndex: -1, newIndex: i, doc: docSnap(l.q.coll, r.id, r.data) })), serverHeld));
        });
    };

    const listen = (l, args) => {
        const fns = args.filter(a => typeof a === 'function');
        l.next = fns[0];
        l.error = fns[1] || (() => {});
        listeners.add(l);
        stats.listens++;
        stats.listenLog.push(l.coll);
        startListener(l);
        return () => listeners.delete(l);
    };

    function makeQuery(q) {
        return {
            where: (field, op, value) => makeQuery({ ...q, filters: [...q.filters, { field, op, value }] }),
            orderBy: (field, dir = 'asc') => makeQuery({ ...q, order: [...q.order, { field, dir }] }),
            limit: (n) => makeQuery({ ...q, limitN: n }),
            startAfter: (doc) => makeQuery({ ...q, after: doc.id }),
            get: async () => {
                stats.gets++;
                stats.queryLog.push(q);
                const fail = failures[q.coll];
                if (fail) throw fail;
                const rows = evaluate(q);
                stats.reads += Math.max(1, rows.length);
                return querySnap(q, rows, []);
            },
            onSnapshot: (...args) => listen({ kind: 'query', q, coll: q.coll }, args)
        };
    }

    function docRef(collName, id) {
        return {
            id,
            path: `${collName}/${id}`,
            get: async () => {
                stats.docGets++;
                stats.reads++;
                return docSnap(collName, id, coll(collName).get(id));
            },
            set: async (data, opts = {}) => {
                const prev = coll(collName).get(id);
                write(collName, id, opts.merge ? applyFields(prev, data, { dotted: false }) : applyFields({}, data, { dotted: false }));
            },
            update: async (fields) => {
                const prev = coll(collName).get(id);
                if (prev === undefined) throw new Error(`No document to update: ${collName}/${id}`);
                write(collName, id, applyFields(prev, fields, { dotted: true }));
            },
            delete: async () => write(collName, id, undefined),
            onSnapshot: (...args) => listen({ kind: 'doc', coll: collName, id }, args)
        };
    }

    const collection = (name) => ({
        ...makeQuery({ coll: name, filters: [], order: [], limitN: 0 }),
        doc: (id) => docRef(name, id === undefined ? `auto${String(++idCounter).padStart(6, '0')}` : String(id)),
        add: async (data) => {
            const id = `auto${String(++idCounter).padStart(6, '0')}`;
            write(name, id, applyFields({}, data, { dotted: false }));
            return docRef(name, id);
        }
    });

    const db = {
        collection,
        batch: () => {
            const ops = [];
            return {
                set: (ref, data, opts) => ops.push(() => ref.set(data, opts)),
                update: (ref, fields) => ops.push(() => ref.update(fields)),
                delete: (ref) => ops.push(() => ref.delete()),
                commit: async () => {
                    for (const op of ops) await op();
                }
            };
        },
        runTransaction: async (fn) => {
            // options.occ: optimistic concurrency like the client SDK — a transaction
            // whose read documents changed before it commits runs again (up to 5 times).
            for (let attempt = 1; ; attempt++) {
                const ops = [];
                const seen = new Map();
                const tx = {
                    get: async (ref) => {
                        stats.reads++;
                        const [c, id] = ref.path.split('/');
                        seen.set(ref.path, coll(c).get(id));
                        return ref.get().then(s => { stats.reads--; stats.docGets--; return s; });
                    },
                    set: (ref, data, opts) => ops.push(() => ref.set(data, opts)),
                    update: (ref, fields) => ops.push(() => ref.update(fields)),
                    delete: (ref) => ops.push(() => ref.delete())
                };
                const result = await fn(tx);
                if (options.occ) {
                    const stale = [...seen].some(([p, v]) => { const [c, id] = p.split('/'); return coll(c).get(id) !== v; });
                    if (stale) {
                        stats.retries = (stats.retries || 0) + 1;
                        if (attempt >= 5) throw Object.assign(new Error('aborted'), { code: 'aborted' });
                        continue;
                    }
                    // Commit atomically: every write starts before anything else can run.
                    await Promise.all(ops.map(op => op()));
                    return result;
                }
                for (const op of ops) await op();
                return result;
            }
        }
    };

    const firebase = {
        firestore: Object.assign(() => db, {
            FieldPath: { documentId: () => '__name__' },
            FieldValue: {
                increment: (n) => ({ [INC]: n }),
                delete: () => ({ [DEL]: true }),
                serverTimestamp: () => Date.now()
            }
        })
    };

    return {
        db,
        firebase,
        stats,
        /** Seeds documents without counting writes or notifying listeners. */
        seed(collName, docs) {
            docs.forEach(({ id, ...data }) => coll(collName).set(String(id), deepClone(data)));
        },
        raw: (collName) => coll(collName),
        /** Delivers the server snapshots held back by options.holdServer. */
        releaseServer() {
            serverHeld = false;
            listeners.forEach(l => {
                if (!l.held) return;
                l.held = false;
                if (l.kind === 'doc') {
                    l.next(docSnap(l.coll, l.id, l.last));
                } else {
                    l.next(querySnap(l.q, l.last, [], false));
                }
            });
        },
        listenerCount: () => listeners.size,
        settle: async () => {
            for (let i = 0; i < 20; i++) await Promise.resolve();
            flush();
            for (let i = 0; i < 20; i++) await Promise.resolve();
        }
    };
}
