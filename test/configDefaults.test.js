const test = require('node:test');
const assert = require('node:assert/strict');

const packageJson = require('../package.json');
const { WORKSPACE_SETTING_DEFAULTS } = require('../out/configDefaults.js');

test('package.json contributed defaults stay aligned with runtime workspace defaults', () => {
  const properties = packageJson.contributes?.configuration?.properties;
  assert.ok(properties, 'Missing contributes.configuration.properties in package.json');

  for (const [name, expectedDefault] of Object.entries(WORKSPACE_SETTING_DEFAULTS)) {
    const settingKey = `codexAutocomplete.${name}`;
    assert.ok(properties[settingKey], `Missing ${settingKey} in package.json`);
    assert.deepEqual(
      properties[settingKey].default,
      expectedDefault,
      `Default mismatch for ${settingKey}`,
    );
  }
});
