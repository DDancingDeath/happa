/**
 * Dialogs opened one after another (#63, Clear Data): the OK button is wired once
 * (its data-onclick in templates/modals.html, #89), so one click closes only the dialog it
 * was clicked in, never the one that opens right after.
 */
const fs = require('fs');
const path = require('path');
import { UIManager } from '../ui/ui-manager.js';
import { installActions } from '../ui/actions.js';
import { AppState } from '../utils/state.js';

const WWW = path.join(__dirname, '..', '..');

beforeAll(() => installActions(document));
beforeEach(() => {
    document.body.innerHTML = fs.readFileSync(path.join(WWW, 'templates', 'modals.html'), 'utf8');
    window.app = { ui: { closeModal: (r) => UIManager.closeModal(r) } };
});
afterEach(() => { delete window.app; });

test('the data-onclick in the template alone answers the dialog', async () => {
    const ok = UIManager.showModal('first', 'First', true);
    document.getElementById('modalConfirm').click();
    await expect(ok).resolves.toBe(true);
    const cancel = UIManager.showModal('second', 'Second', true);
    document.getElementById('modalCancel').click();
    await expect(cancel).resolves.toBe(false);
    expect(document.getElementById('modalOverlay').classList.contains('active')).toBe(false);
});

test('a confirm can carry its own verb and the danger style, and the next dialog is back to OK', async () => {
    const btn = document.getElementById('modalConfirm');
    const voiding = UIManager.showModalWithHtml('<p>x</p>', 'Void this bill?', true, { confirmLabel: 'Void bill', danger: true });
    expect(btn.textContent).toBe('Void bill');
    expect(btn.classList.contains('btn-danger')).toBe(true);
    expect(btn.classList.contains('btn-primary')).toBe(false);
    expect(btn.hasAttribute('data-i18n')).toBe(false);
    btn.click();
    await expect(voiding).resolves.toBe(true);
    const plain = UIManager.showModal('next', 'Next', true);
    expect(btn.textContent).toBe('OK');
    expect(btn.classList.contains('btn-danger')).toBe(false);
    expect(btn.classList.contains('btn-primary')).toBe(true);
    expect(btn.getAttribute('data-i18n')).toBe('ui.modals.ok');
    btn.click();
    await expect(plain).resolves.toBe(true);
});

// A real click runs queued promise callbacks between two click handlers, so a
// second handler closed the dialog that the first one's caller had just opened.
// jsdom can't reproduce that ordering, hence the source check.
test('main.js adds no second click handler to the dialog buttons', () => {
    const main = fs.readFileSync(path.join(WWW, 'js', 'main.js'), 'utf8');
    expect(main).not.toMatch(/getElementById\('modal(Confirm|Cancel)'\)/);
});

describe('one dialog controller (C5a)', () => {
    const overlay = () => document.getElementById('modalOverlay');
    const box = () => document.getElementById('modalBox');
    // jsdom lays nothing out: a control shows unless it is hidden or display: none
    const rects = Element.prototype.getClientRects;
    beforeEach(() => {
        Element.prototype.getClientRects = function () {
            return this.hidden || this.style.display === 'none' ? [] : [{}];
        };
    });
    afterEach(() => { Element.prototype.getClientRects = rects; });

    test('Esc, Back and a scrim tap answer a confirm as Cancel, and an alert as OK', async () => {
        const { closeTopDialog } = await import('../utils/keyboard-shortcuts.js');
        const confirm = UIManager.showModal('sure?', 'Confirm', true);
        expect(closeTopDialog()).toBe(true);
        await expect(confirm).resolves.toBe(false);
        const alert = UIManager.showModal('done', 'Alert');
        expect(closeTopDialog()).toBe(true);
        await expect(alert).resolves.toBe(true);
        const tapped = UIManager.showModalWithHtml('<p>x</p>', 'Mark as cleared', true, { confirmLabel: 'Mark cleared' });
        overlay().click();
        await expect(tapped).resolves.toBe(false);
        const inside = UIManager.showModal('x', 'X', true);
        box().click();
        expect(overlay().classList.contains('active')).toBe(true);
        document.getElementById('modalCancel').click();
        await expect(inside).resolves.toBe(false);
    });

    test('a drag from a field that ends on the scrim keeps the dialog and its typed text', async () => {
        const asked = UIManager.showModalWithHtml('<input id="reasonInput">', 'Why?', true);
        const field = document.getElementById('reasonInput');
        field.value = 'typed';
        field.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        overlay().click();
        expect(overlay().classList.contains('active')).toBe(true);
        expect(document.getElementById('reasonInput').value).toBe('typed');
        overlay().dispatchEvent(new Event('pointerdown', { bubbles: true }));
        overlay().click();
        await expect(asked).resolves.toBe(false);
    });

    test('a double tap answers once and never the dialog opened after it', async () => {
        const next = [];
        const first = UIManager.showModal('first', 'First', true).then((v) => {
            next.push(UIManager.showModal('second', 'Second', true));
            return v;
        });
        const ok = document.getElementById('modalConfirm');
        ok.click();
        ok.click();
        await expect(first).resolves.toBe(true);
        expect(overlay().classList.contains('active')).toBe(true);
        expect(AppState.modalResolve).toEqual(expect.any(Function));
        document.getElementById('modalCancel').click();
        await expect(next[0]).resolves.toBe(false);
    });

    test('a dialog replaced before it was answered resolves as dismissed', async () => {
        const confirm = UIManager.showModal('first', 'First', true);
        const second = UIManager.showModal('second', 'Second');
        await expect(confirm).resolves.toBe(false);
        document.getElementById('modalConfirm').click();
        await expect(second).resolves.toBe(true);
    });

    test('focus moves into the dialog and back to the opener', async () => {
        const opener = document.createElement('button');
        document.body.appendChild(opener);
        opener.focus();
        const asked = UIManager.showModal('x', 'X', true);
        expect(document.activeElement).toBe(box());
        document.getElementById('modalConfirm').click();
        await asked;
        expect(document.activeElement).toBe(opener);
    });

    test('a sheet below 600 px, a dialog from 600 px', async () => {
        const original = window.matchMedia;
        try {
            window.matchMedia = (q) => ({ matches: true, media: q, addEventListener() {} });
            const narrow = UIManager.showModal('x', 'X');
            expect(box().classList.contains('sheet')).toBe(true);
            expect(box().classList.contains('dialog')).toBe(false);
            UIManager.closeModal(true);
            await narrow;
            window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {} });
            const wide = UIManager.showModal('x', 'X');
            expect(box().classList.contains('dialog')).toBe(true);
            expect(box().classList.contains('sheet')).toBe(false);
            UIManager.closeModal(true);
            await wide;
        } finally {
            window.matchMedia = original;
        }
    });

    test('a custom modal resolves its value, Esc presses its dismiss, and the next dialog is the stock one', async () => {
        const { closeTopDialog } = await import('../utils/keyboard-shortcuts.js');
        const picked = UIManager.showCustomModal('<p>pick</p>', [{ text: 'Keep', value: null }, { text: 'A', value: 'a' }]);
        expect(document.getElementById('modalConfirm').hidden).toBe(true);
        [...document.querySelectorAll('#modalFooter [data-custom]')].find(b => b.textContent === 'A').click();
        await expect(picked).resolves.toBe('a');
        const dismissed = UIManager.showCustomModal('<p>pick</p>', [{ text: 'Keep', value: null }, { text: 'A', value: 'a' }]);
        expect(closeTopDialog()).toBe(true);
        await expect(dismissed).resolves.toBe(null);
        const plain = UIManager.showModal('next', 'Next', true);
        expect(document.querySelectorAll('#modalFooter [data-custom]').length).toBe(0);
        expect(document.getElementById('modalConfirm').hidden).toBe(false);
        expect(document.getElementById('modalTitle').textContent).toBe('Next');
        document.getElementById('modalConfirm').click();
        await expect(plain).resolves.toBe(true);
    });
});
