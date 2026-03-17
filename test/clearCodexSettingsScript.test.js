const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  getContributedSettingKeys,
  parseJsoncObject,
  removeSettingsKeys,
  updateSettingsFile,
} = require('../scripts/clear-codex-autocomplete-settings.js');

test('clear settings script reads contributed Codex Autocomplete keys from package.json', () => {
  const keys = getContributedSettingKeys();
  assert.ok(keys.length > 0);
  assert.ok(keys.includes('codexAutocomplete.enabled'));
  assert.ok(keys.includes('codexAutocomplete.triggerMode'));
  assert.ok(keys.every((key) => key.startsWith('codexAutocomplete.')));
});

test('clear settings script parses JSONC and removes only Codex Autocomplete keys', () => {
  const parsed = parseJsoncObject(`{
    // keep unrelated settings
    "editor.fontSize": 14,
    "codexAutocomplete.enabled": true,
    "nested": {
      "keep": true,
    },
    "codexAutocomplete.triggerMode": "automatic",
  }`);

  const removedCount = removeSettingsKeys(parsed, [
    'codexAutocomplete.enabled',
    'codexAutocomplete.triggerMode',
  ]);

  assert.equal(removedCount, 2);
  assert.deepEqual(parsed, {
    'editor.fontSize': 14,
    nested: {
      keep: true,
    },
  });
});

test('clear settings script updates a settings file in place', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-clear-settings-'));
  const settingsPath = path.join(tempDir, 'settings.json');

  try {
    await fs.writeFile(
      settingsPath,
      `{
  "editor.tabSize": 2,
  "codexAutocomplete.enabled": false,
  "codexAutocomplete.model": "gpt-5.4",
  "files.trimTrailingWhitespace": true
}
`,
      'utf8',
    );

    const result = await updateSettingsFile(
      settingsPath,
      ['codexAutocomplete.enabled', 'codexAutocomplete.model'],
      false,
    );

    assert.equal(result.changed, true);
    assert.equal(result.removedCount, 2);

    const updatedText = await fs.readFile(settingsPath, 'utf8');
    assert.equal(
      updatedText,
      `{
  "editor.tabSize": 2,
  "files.trimTrailingWhitespace": true
}
`,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
