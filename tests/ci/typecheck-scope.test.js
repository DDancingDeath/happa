const fs = require('fs');
const path = require('path');

// `npm run typecheck` checks only files that start with `// @ts-check` (#71).
const TYPED = ['www/js/utils/money.js', 'www/js/utils/expense-list.js'];
const CALC_DIR = 'www/js/utils/calc';

test('money and every calc file are type-checked', () => {
    const root = path.join(__dirname, '..', '..');
    const calc = fs.readdirSync(path.join(root, CALC_DIR)).filter((f) => f.endsWith('.js')).map((f) => `${CALC_DIR}/${f}`);
    expect(calc.length).toBeGreaterThanOrEqual(4);
    const unchecked = [...TYPED, ...calc].filter((f) => !fs.readFileSync(path.join(root, f), 'utf8').startsWith('// @ts-check'));
    expect(unchecked).toEqual([]);
});
