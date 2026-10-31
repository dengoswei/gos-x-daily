import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../cli.mjs';
import { makeRuntime } from '../runtime.mjs';
import { validateFeedConfig } from '../feed-import.mjs';

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

test('example sources use generic blog indexes and the broad-AI public feed list, without topic filters', () => {
  const sources = JSON.parse(fs.readFileSync(new URL('../config/sources.json', import.meta.url), 'utf8'));
  assert.deepEqual(sources.blogs.map(blog => [blog.name, blog.type]),
    [['Anthropic Engineering', 'html-index'], ['Claude Blog', 'html-index'], ['Thinking Machines', 'html-index']]);
  assert.deepEqual(sources.feeds.map(feed => feed.name), ['Hugging Face Daily Papers', 'OpenAI News', 'Google DeepMind blog', 'Google AI blog',
    'Hugging Face blog', 'Qwen blog', 'Interconnects', 'Ahead of AI', 'Lilian Weng', 'smol.ai AI News', 'PyTorch blog', 'NVIDIA Developer blog',
    'SemiAnalysis', 'Chips and Cheese', 'vLLM releases', 'SGLang releases']);
  for (const feed of sources.feeds) assert.deepEqual(Object.keys(feed).sort(), ['kind', 'maxItems', 'name', 'url']);
  assert.equal(validateFeedConfig(sources), sources.feeds);
});

test('watch profiles default to the karpathy entry and are validated fail-closed', () => {
  const sources = JSON.parse(fs.readFileSync(new URL('../config/sources.json', import.meta.url), 'utf8'));
  const karpathy = { handle: 'karpathy', name: 'Karpathy', required: true, latest: 10 };
  assert.deepEqual(sources.watchProfiles, [karpathy]);
  const watch = watchProfiles => makeRuntime({ sources: { blogs: [], xiaohongshuProfiles: [], watchProfiles } }, { runId: 'watch' }).sources.watchProfiles;
  assert.deepEqual(makeRuntime({}, { runId: 'watch' }).sources.watchProfiles, [karpathy]);
  assert.deepEqual(watch(undefined), [karpathy]);
  assert.deepEqual(watch([]), []);
  assert.deepEqual(watch([karpathy, { handle: 'Second_1', name: 'Second', required: false, latest: 20 }]).map(p => p.handle), ['karpathy', 'Second_1']);
  for (const bad of [{}, [{ ...karpathy, handle: 'bad-handle' }], [{ ...karpathy, handle: 'sixteen_chars_xx' }], [karpathy, { ...karpathy, handle: 'Karpathy' }],
    [{ ...karpathy, handle: 'substack' }], [{ ...karpathy, handle: '__proto__' }], [{ ...karpathy, name: ' ' }], [{ ...karpathy, required: 'true' }], [{ ...karpathy, latest: 0 }], [{ ...karpathy, latest: 21 }], [{ ...karpathy, latest: 2.5 }]]) {
    assert.throws(() => watch(bad), /watch profile|watchProfiles/i);
  }
});
