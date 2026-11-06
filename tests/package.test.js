import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));

test('release explicitly supports the verified DSH prereleases without a wildcard exemption', () => {
  assert.equal(manifest.version, '1.0.1');
  assert.deepEqual(manifest.engines.dsh.split('||').map(value => value.trim()), [
    '0.2.1-rc.5', '0.2.2-rc.1',
  ]);
  assert.equal(manifest.name, '@local/dsh-conversation-export');
  assert.equal(manifest.repository.url, 'git+https://github.com/duanhaotian008-ctrl/dsh-conversation-export.git');
});

test('bundle preserves its loadable entries and dependency-free installation', async () => {
  for (const path of [manifest.exports['.'], manifest.exports['./client'], manifest.exports['./icon'], manifest.dsh.bundle.patch]) {
    await access(new URL(path, root));
  }
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.immediately, true);
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-workspace', '@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-locale',
  ]);
  assert.deepEqual(manifest.dependencies || {}, {});
  for (const script of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(manifest.scripts[script], undefined);
  }
});
