import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../cli.mjs';
import { makeRuntime } from '../runtime.mjs';

test('personal source configuration resolves relative to its runtime file, not shell cwd', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdaily-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'sources.local.json'), JSON.stringify({ blogs: [], xiaohongshuProfiles: [] }));
  fs.writeFileSync(path.join(dir, 'runtime.local.json'), JSON.stringify({ sourcesFile: 'sources.local.json', dataDir: path.join(dir, 'data'), collectionEnabled: false }));
  const result = await main(['inspect-config', '--config', path.join(dir, 'runtime.local.json')]);
  assert.deepEqual(result.sourceCounts, { blogs: 0, xiaohongshuProfiles: 0 });
  assert.equal(result.collectionEnabled, false);
  assert.equal(result.sendEnabled, false);
  assert.equal(fs.existsSync(path.join(dir, 'data')), false);
});

test('default public example stays portable and collection/delivery stay disabled', async () => {
  const result = await main(['inspect-config']);
  assert.equal(result.lookbackHours, 48);
  assert.equal(result.collectionEnabled, false);
  assert.equal(result.lark.enabled, false);
  assert.equal(result.lark.userId, null);
  assert.equal(result.lark.executable, '/ABSOLUTE/PATH/TO/VERIFIED/lark-cli');
  assert.equal(result.sourceCounts.xiaohongshuProfiles, 0);
  assert.equal(makeRuntime({ dataDir: './data' }, { runId: 'portable' }).runDir,
    path.resolve(fileURLToPath(new URL('../', import.meta.url)), 'data/runs/portable'));
});
