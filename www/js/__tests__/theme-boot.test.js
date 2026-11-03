/**
 * #102: the saved dark-mode preference must be applied at boot, before first
 * paint, by js/boot/theme.js, a classic script that is the first thing in <body>.
 */
const fs = require('fs');
const path = require('path');

const WWW = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
const bootScript = fs.readFileSync(path.join(WWW, 'js', 'boot', 'theme.js'), 'utf8');

describe('theme boot script (#102)', () => {
    afterEach(() => {
        document.body.className = '';
        localStorage.clear();
    });

    test('is the first thing in <body>, a blocking classic script, so it runs before the app paints', () => {
        const afterBody = html.slice(html.indexOf('<body>') + '<body>'.length);
        expect(afterBody.replace(/<!--[\s\S]*?-->/g, '').trim()).toMatch(/^<script src="js\/boot\/theme\.js(\?v=[0-9a-z]+)?"><\/script>/);
    });

    test('darkMode=true adds body.dark-mode; otherwise the body stays light', () => {
        localStorage.setItem('darkMode', 'true');
        new Function(bootScript)();
        expect(document.body.classList.contains('dark-mode')).toBe(true);

        document.body.className = '';
        localStorage.setItem('darkMode', 'false');
        new Function(bootScript)();
        expect(document.body.classList.contains('dark-mode')).toBe(false);
    });
});