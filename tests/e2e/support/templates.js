/**
 * The template lists of www/js/utils/template-loader.js (an ES module) for the
 * CommonJS specs: SHELL_TEMPLATES, PAGE_TEMPLATES and EAGER_PAGES (null when absent).
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../../../www/js/utils/template-loader.js'), 'utf8');
const list = (name) => {
    const m = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(src);
    return m ? [...m[1].matchAll(/'([\w-]+)'/g)].map(x => x[1]) : null;
};

module.exports = { SHELL_TEMPLATES: list('SHELL_TEMPLATES'), PAGE_TEMPLATES: list('PAGE_TEMPLATES'), EAGER_PAGES: list('EAGER_PAGES') };
