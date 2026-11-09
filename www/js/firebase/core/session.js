/**
 * @fileoverview The data layer's mutable state for one signed-in session, shared by
 * firestore-service.js and the core/ modules split out of it (docs/architecture.md,
 * phase 5, #69). One object, so every module reads and writes the same values;
 * FirebaseService.cleanup() resets it on sign-out.
 * @module firebase/core/session
 */

export const S = {
    /** Bumped by cleanup(): async work started by an earlier session checks it and stops. */
    sessionGen: 0,
    /** Numbers the data listeners for the sync pill (#70). */
    listenSeq: 0,
    /** A first snapshot from cache had documents this session (the device has used the app before). */
    warmCache: false,
    /**
     * Incremented whenever a listener changes AppState data. Used to decide
     * whether a previously computed stock object is still current.
     * @type {number}
     */
    dataVersion: 0,
    /** @type {{stock?: Object, version?: number}} Last stock computed by getStock() */
    stockCache: {},
    stockDirty: false,
    flushTimer: null,
    /** @type {?{gen: number, liveFrom: number, rawFull: boolean, colls: Object}} */
    windowState: null,
    /** Latest checkpoint doc data seen (undefined = not read yet, null = missing). */
    checkpointDoc: undefined,
    /** Checkpoint in use for stock (parsed), or null. */
    activeCheckpoint: null,
    checkpointItemsCheck: { items: null, checkpoint: null, ok: false },
    rebuildPromise: null,
    rebuildRequestedAgain: false,
    /** Whether this session already tried a rebuild without being asked to by an invalidation. */
    rebuildAttempted: false,
    /** Re-checks the stock once the other device's lease ends. */
    leaseWaitTimer: null,
    /** When this session first started waiting for another device's rebuild (0 = never). */
    leaseWaitStartedAt: 0,
    /** Bumped on every change to a stock collection in memory (roll-forward conflict detection). */
    stockChangeGen: 0,
    /** stockCheckpoints/legacyScan: per collection {complete, foundAt} of the timestamp backfill. */
    legacyScanDoc: null,
    /** The legacyScan doc read of this session (never rejects); read in parallel with the listeners. */
    legacyScanReadPromise: Promise.resolve(),
    /** Background legacy scan scheduled after the first screen: {run, cancel} (#13). */
    legacyScanJob: null,
    /** Set by calculateStock() when the stock it returned is approximate (members, stale checkpoint, #129). */
    lastStockApprox: null,
    /** Parsed stale checkpoint for approximate stock, cached per checkpoint doc snapshot. */
    approxCheckpointCache: { doc: undefined, cp: null },
    /** This device made a checkpoint-invalidating edit this session (approximate stock would miss it). */
    ownStaleWrite: false,
    oldestTimestampPromise: null,
    /** Bills read for Ask item reports, per collection (repos/report-bills.js, #415). @type {Map<string, {gen: number, from: ?number, bills: Array<Object>, readAt: number}>} */
    reportBills: new Map(),
    /** Item year stats read for Ask quick figures (repos/report-bills.js, #415). @type {?{gen: number, meta: *, items: Map<string, Array<Object>>}} */
    reportStats: null,
    /** When the on-demand (non-live) history currently in memory was first fetched (0 = none). */
    onDemandAsOf: 0,
    extendQueue: Promise.resolve(),
    forcedExtends: 0,
    /** The last stale mark started by noteMonthWrite (tests wait for it). */
    lastMonthMark: Promise.resolve([]),
    /** Local time this device started its last fresh read of all history (0 = none this session). */
    fullHistoryFetchedAt: 0
};
