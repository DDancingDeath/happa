/**
 * @fileoverview Undo of voice changes (#131): a per-form stack, and undoing only what is
 * still as voice left it.
 */
import { createVoiceUndo, planUndo, fieldChanges, UNDO_LIMIT } from '../utils/voice-undo.js';

describe('createVoiceUndo', () => {
    test('last in, first out; a change that changed nothing is not kept', () => {
        const undo = createVoiceUndo();
        const a = { lines: [{ n: 1 }], fields: {} };
        const b = { lines: [], fields: { customer: { before: '', after: 'Ramesh' } } };
        expect(undo.push({ lines: [], fields: {} })).toBe(false);
        expect(undo.push(a)).toBe(true);
        expect(undo.push(b)).toBe(true);
        expect(undo.size).toBe(2);
        expect(undo.pop().fields).toEqual(b.fields);
        expect(undo.peek().lines).toEqual(a.lines);
        expect(undo.pop().lines[0]).toBe(a.lines[0]);
        expect(undo.pop()).toBeNull();
    });

    test(`keeps the last ${UNDO_LIMIT} only; clear empties it`, () => {
        const undo = createVoiceUndo(3);
        for (let i = 1; i <= 5; i++) undo.push({ lines: [{ i }], fields: {} });
        expect(undo.size).toBe(3);
        expect(undo.pop().lines[0].i).toBe(5);
        undo.clear();
        expect(undo.size).toBe(0);
    });
});

describe('planUndo', () => {
    const l1 = { name: 'Wheat' };
    const l2 = { name: 'Rice' };
    const other = { name: 'Typed' };

    test('removes the lines it added (highest index first) and puts the boxes back', () => {
        const change = {
            lines: [l1, l2],
            fields: { customer: { before: 'Old', after: 'Ramesh' }, item: { before: '0', after: '1' } }
        };
        const plan = planUndo(change, { lines: [other, l1, l2], fields: { customer: 'Ramesh', item: '1' } });
        expect(plan).toEqual({ removeAt: [2, 1], restore: { customer: 'Old', item: '0' }, kept: 0, any: true });
    });

    test('a line removed or edited since, or a box typed over, is left alone', () => {
        const change = { lines: [l1, l2], fields: { customer: { before: '', after: 'Ramesh' }, rate: { before: '', after: '25' } } };
        const plan = planUndo(change, { lines: [l2], fields: { customer: 'Suresh', rate: '25' } });
        expect(plan).toEqual({ removeAt: [0], restore: { rate: '' }, kept: 2, any: true });
    });

    test('nothing left to undo (the bill was saved and cleared)', () => {
        const change = { lines: [l1], fields: { weight: { before: '', after: '10' } } };
        expect(planUndo(change, { lines: [], fields: { weight: '' } })).toMatchObject({ any: false, kept: 2 });
        expect(planUndo(null, { lines: [], fields: {} })).toMatchObject({ any: false, kept: 0 });
    });

    test('fieldChanges keeps only the boxes that changed', () => {
        expect(fieldChanges({ customer: 'A', item: '0', rate: '', weight: '' }, { customer: 'A', item: '1', rate: '25', weight: '' }))
            .toEqual({ item: { before: '0', after: '1' }, rate: { before: '', after: '25' } });
    });
});
