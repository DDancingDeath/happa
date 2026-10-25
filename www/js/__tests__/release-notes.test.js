/**
 * @jest-environment node
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildReleaseNotes } = require('../../../scripts/release-notes.js');
const { loadConfig, derive } = require('../../../scripts/happa-config.js');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'release-notes.js');

const fixture = {
    releases: [
        {
            version: '1.4.0',
            date: '2026-11-01',
            androidVersionCode: 5,
            notes: { en: ['Faster stock page', 'Printer fix'], hi: ['स्टॉक पेज तेज़'] }
        },
        { version: '1.3.0', date: '2026-10-20', androidVersionCode: 4, notes: { en: ['Older'] } }
    ]
};

describe('release-notes', () => {
    let dir;
    let changelogPath;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aadhat-release-notes-'));
        changelogPath = path.join(dir, 'changelog.json');
        fs.writeFileSync(changelogPath, JSON.stringify(fixture));
    });

    afterAll(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('renders English + Hindi bullets, download link and install steps for the requested version', () => {
        const md = buildReleaseNotes(fixture, 'v1.4.0');
        expect(md).toContain("## What's new in v1.4.0 (2026-11-01)");
        expect(md).toContain('**English**\n- Faster stock page\n- Printer fix');
        expect(md).toContain('**हिन्दी**\n- स्टॉक पेज तेज़');
        const identity = derive(loadConfig());
        expect(md).toContain(identity.downloadPageUrl);
        expect(md).toContain(identity.apkFile);
        expect(md).toContain('**Install:**');
        expect(md).not.toContain('Older');
    });

    test('omits the Hindi section when there are no Hindi notes', () => {
        expect(buildReleaseNotes(fixture, '1.3.0')).not.toContain('हिन्दी');
    });

    test('CLI prints notes for a version present in the given changelog', () => {
        const r = spawnSync(process.execPath, [SCRIPT, 'v1.3.0', '--changelog', changelogPath], { encoding: 'utf8' });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('- Older');
    });

    test('CLI exits 1 when the version is missing from the changelog', () => {
        const r = spawnSync(process.execPath, [SCRIPT, '9.9.9', '--changelog', changelogPath], { encoding: 'utf8' });
        expect(r.status).toBe(1);
        expect(r.stdout).toBe('');
        expect(r.stderr).toContain('No changelog entry for version 9.9.9');
    });
});
