/**
 * Every audit action the app writes has a label in both languages, so the audit
 * lists (Diagnostics › Audit, Settings) never show a raw code like "RENT MOVE IN"
 * on a Hindi screen (the E2E smoke fails on English left on a Hindi screen).
 */
const fs = require('fs');
const path = require('path');
import en from '../i18n/en.js';
import hi from '../i18n/hi.js';
import { AUDIT_ACTIONS, auditActionLabel } from '../i18n/localize.js';
import { setLang, resetLangForTests } from '../i18n/index.js';

const JS = path.join(__dirname, '..');
const listFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : listFiles(full);
    return e.name.endsWith('.js') ? [full] : [];
});

/** Action codes in AuditService.ACTIONS and in the first argument of every AuditService.log(...) call. */
function writtenActions() {
    const codes = new Set();
    const audit = fs.readFileSync(path.join(JS, 'services', 'audit.js'), 'utf8');
    for (const m of audit.matchAll(/^\s*([A-Z]+(?:_[A-Z]+)*): '\1'/gm)) codes.add(m[1]);
    for (const f of listFiles(JS)) {
        const src = fs.readFileSync(f, 'utf8');
        for (const m of src.matchAll(/AuditService\.log\(([^{]*)/g)) {
            const firstArg = m[1].split(/,\s*(?=[{\w])/)[0];
            for (const c of firstArg.matchAll(/'([A-Z]+(?:_[A-Z]+)+)'|ACTIONS\.([A-Z_]+)/g)) codes.add(c[1] || c[2]);
        }
    }
    return [...codes].sort();
}

afterEach(() => resetLangForTests());

test('every audit action the app writes has an English and a Hindi label', () => {
    const codes = writtenActions();
    expect(codes).toEqual(expect.arrayContaining(['EDIT_BILL', 'RENT_MOVE_IN', 'RENT_LINK_OFF']));
    expect(codes.filter(c => !AUDIT_ACTIONS.includes(c))).toEqual([]);
    const key = (c) => `ui.diag.a_${c.toLowerCase()}`;
    expect(codes.filter(c => !en[key(c)] || !hi[key(c)])).toEqual([]);
});

test('audit labels follow the app language', () => {
    setLang('hi');
    expect(auditActionLabel('RENT_MOVE_OUT')).toBe(hi['ui.diag.a_rent_move_out']);
    expect(auditActionLabel('RENT_MOVE_OUT')).not.toMatch(/[A-Za-z]/);
    setLang('en');
    expect(auditActionLabel('RENT_MOVE_OUT')).toBe('Tenant Moved Out');
});
