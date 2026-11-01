/**
 * Dialogs opened one after another (#63, Clear Data): the OK button is wired once
 * (its onclick in templates/modals.html), so one click closes only the dialog it
 * was clicked in, never the one that opens right after.
 */
const fs = require('fs');
const path = require('path');
import { UIManager } from '../ui/ui-manager.js';

const WWW = path.join(__dirname, '..', '..');

beforeEach(() => {
    document.body.innerHTML = fs.readFileSync(path.join(WWW, 'templates', 'modals.html'), 'utf8');
    window.app = { ui: { closeModal: (r) => UIManager.closeModal(r) } };
});
afterEach(() => { delete window.app; });

test('the template onclick alone answers the dialog', async () => {
    const ok = UIManager.showModal('first', 'First', true);
    document.getElementById('modalConfirm').click();
    await expect(ok).resolves.toBe(true);
    const cancel = UIManager.showModal('second', 'Second', true);
    document.getElementById('modalCancel').click();
    await expect(cancel).resolves.toBe(false);
    expect(document.getElementById('modalOverlay').classList.contains('active')).toBe(false);
});

// A real click runs queued promise callbacks between two click handlers, so a
// second handler closed the dialog that the first one's caller had just opened.
// jsdom can't reproduce that ordering, hence the source check.
test('main.js adds no second click handler to the dialog buttons', () => {
    const main = fs.readFileSync(path.join(WWW, 'js', 'main.js'), 'utf8');
    expect(main).not.toMatch(/getElementById\('modal(Confirm|Cancel)'\)/);
});
