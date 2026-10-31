#!/usr/bin/env node
// Fake `firebase deploy` for tests/ci/deploy-with-retry.test.js. FAKE_OUTCOMES
// lists one outcome per call (ok | 503 | 500 | 429 | 409 | reset | compile |
// permission | weird); FAKE_STATE is a file that counts the calls so far. Its
// own arguments are appended to FAKE_ARGS_LOG.
const fs = require('fs');

const outcomes = process.env.FAKE_OUTCOMES.split(',');
const state = process.env.FAKE_STATE;
const call = fs.existsSync(state) ? Number(fs.readFileSync(state, 'utf8')) : 0;
fs.writeFileSync(state, String(call + 1));
fs.appendFileSync(process.env.FAKE_ARGS_LOG, process.argv.slice(2).join(' ') + '\n');

const outcome = outcomes[Math.min(call, outcomes.length - 1)];
const ESC = '\x1b';
const header = [
    `${ESC}[1m${ESC}[37m===${ESC}[39m Deploying to 'happa-test'...${ESC}[22m`,
    `${ESC}[36m${ESC}[1mi  cloud.firestore:${ESC}[22m${ESC}[39m checking ${ESC}[1mfirestore.rules${ESC}[22m for compilation errors...`
].join('\n');
const errors = {
    503: 'Error: Request to https://firebaserules.googleapis.com/v1/projects/happa-test:test had HTTP Error: 503, The service is currently unavailable.',
    500: 'Error: Request to https://firebaserules.googleapis.com/v1/projects/happa-test:test had HTTP Error: 500, Internal error encountered.',
    429: 'Error: HTTP Error: 429, Quota exceeded for quota metric.',
    409: 'Error: Request to https://firebaserules.googleapis.com/v1/projects/happa-test/releases had HTTP Error: 409, Release projects/happa-test/releases/cloud.firestore already exists.',
    reset: 'Error: read ECONNRESET',
    compile: `${ESC}[33m⚠  [E] 12:5 - Missing 'match' keyword before path.${ESC}[39m\nError: Compilation errors in ${ESC}[1mfirestore.rules${ESC}[22m.`,
    permission: 'Error: Request to https://firebaserules.googleapis.com/v1/projects/happa-test:test had HTTP Error: 403, The caller does not have permission',
    weird: 'Error: Something nobody expected.'
};

console.log(header);
if (outcome === 'ok') {
    console.log('✔  Deploy complete!');
    process.exit(0);
}
console.error(errors[outcome]);
process.exit(1);
