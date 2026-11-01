/**
 * TIP instrumentation (#161): the Print run around every print job and the
 * sync pill's watch() that feeds the Sync scenario.
 */
import { jest } from '@jest/globals';
import { tip } from '../tip/index.js';
import { dayKeyOf } from '../tip/tip.js';
import { PrinterService } from '../services/printer.js';
import { createSyncStatus } from '../ui/sync-status.js';

const printCounts = () => {
    const day = tip.takeDelta()[dayKeyOf(Date.now())] || {};
    const v = Object.values(day)[0] || {};
    return v.Print || { n: {} };
};

describe('Print runs around PrinterService.runJob', () => {
    beforeEach(() => {
        tip.setEnabled(true);
        tip.takeDelta();
        jest.spyOn(PrinterService, 'updateStatus').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());

    it('a printed job passes; a failed connect fails with its reason', async () => {
        await expect(PrinterService.runJob('bill:1', async () => ({}))).resolves.toEqual({ outcome: 'printed' });
        expect(printCounts().n).toEqual({ s: 1 });

        const err = Object.assign(new Error('no answer'), { kind: 'timeout_connect' });
        const res = await PrinterService.runJob('bill:2', async () => { throw err; });
        expect(res).toEqual({ outcome: 'failed', error: err });
        const c = printCounts();
        expect(c.n).toEqual({ f: 1 });
        expect(c.r).toEqual({ f1: 1 });
    });
});

describe('SyncStatus.watch', () => {
    it('reports pending changes and the sign-out', async () => {
        document.body.innerHTML = '';
        const seen = [];
        const s = createSyncStatus({ win: window, doc: document });
        const off = s.watch((x) => seen.push(x));
        s.start();
        let resolve;
        s.trackWrite('purchases/a', new Promise(r => { resolve = r; }));
        expect(seen.at(-1)).toEqual({ online: true, pending: 1 });
        resolve();
        await new Promise(r => setTimeout(r, 0));
        expect(seen.at(-1)).toEqual({ online: true, pending: 0 });
        s.stop();
        expect(seen.at(-1)).toEqual({ online: true, pending: 0, stopped: true });
        off();
        s.start();
        const n = seen.length;
        s.trackWrite('purchases/b', Promise.resolve());
        expect(seen.length).toBe(n);
        s.stop();
    });
});
