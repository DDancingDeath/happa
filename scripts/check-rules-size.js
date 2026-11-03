#!/usr/bin/env node
/**
 * firestore.rules must stay under a size budget. The Rules API compile check that every rules
 * deploy runs (projects/<id>:test) has a time limit, and its cost grows with the rules: at about
 * 159 KB it timed out with 503 on every try (Nov 2026). Commentary belongs in docs/security.md.
 *   node scripts/check-rules-size.js
 */
const fs = require('fs');
const path = require('path');

const RULES = path.resolve(__dirname, '..', 'firestore.rules');
// The size after the compile rework plus 10%. Raise it only with a passing compile measurement
// (docs/security.md, "Firestore rules").
const BUDGET_BYTES = 126000;

const size = fs.statSync(RULES).size;
if (size > BUDGET_BYTES) {
    console.error(`firestore.rules is ${size} bytes, over its budget of ${BUDGET_BYTES}. ` +
        'Move commentary to docs/security.md and keep helpers shallow (see "Firestore rules" there).');
    process.exit(1);
}
console.log(`firestore.rules: ${size} of ${BUDGET_BYTES} bytes`);
