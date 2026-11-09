/** SheetJS's pinned URL, read from the app (www/js/utils/lazy-scripts.js is an ES module). */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../../../www/js/utils/lazy-scripts.js'), 'utf8');
const XLSX_URL = /XLSX_URL = '([^']+)'/.exec(src)[1];

module.exports = { XLSX_URL };
