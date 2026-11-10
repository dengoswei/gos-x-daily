import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { draftOpenAI } from '../deployment/mac/openai-draft.mjs';
import { makeSyntheticRun } from '../prototype/make-synthetic-run.mjs';
import { scriptedReply, stageOf } from './helpers/scripted-stage-model.mjs';

test('Mac API draft uses only bounded synthetic packets and pins Sol high', async t => {
  const runsDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'xdaily-SYNTHETIC-draft-'));
  t.after(() => fs.rmSync(runsDir, { recursive: true, force: true }));
  const runDir = path.join(runsDir, '2026-11-08-SYNTHETIC');
  const keyFile = path.join(runsDir, 'SYNTHETIC-config');
  const key = 'synthetic-placeholder-not-a-key';
  const previous = process.env.CODEX_API_KEY;
  await makeSyntheticRun({ outDir: runDir });
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ date: '2026-11-08' }));
  fs.writeFileSync(path.join(runDir, 'mail-body.txt'), 'SYNTHETIC local-only mail body');
  fs.writeFileSync(keyFile, `UNRELATED: omitted\nCODEX_API_KEY: "${key}"\n`, { mode: 0o600 });

  const seen = new Set();
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, `Bearer ${key}`);
    assert.equal(body.model, 'gpt-6.1-sol');
    assert.equal(body.reasoning_effort, 'high');
    assert.equal(body.store, false);
    assert.equal(body.tools, undefined);
    const prompt = body.messages.map(message => message.content).join('\n\n');
    assert.ok(!prompt.includes(key) && !prompt.includes('local-only mail body'));
    seen.add(stageOf(prompt));
    return Response.json({ model: 'gpt-6.1-sol',
      choices: [{ message: { content: scriptedReply(prompt) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 10 } });
  };
  const draft = await draftOpenAI({ runsDir, runDir, keyFile, fetchImpl });
  assert.equal(draft.status, 'api_draft_validated');
  assert.equal(draft.notApproval, true);
  assert.deepEqual(seen, new Set(['screen', 'story', 'compose']));
  assert.equal(process.env.CODEX_API_KEY, previous);
  assert.ok(!fs.readFileSync(path.join(runDir, 'api-draft-models.json'), 'utf8').includes(key));
  assert.ok(!fs.existsSync(path.join(runDir, 'api-draft.lock')));
  await assert.rejects(draftOpenAI({ runsDir, runDir, keyFile, fetchImpl, resume: true }), /output is already complete/);
  await assert.rejects(draftOpenAI({ runsDir: runDir, runDir, keyFile, fetchImpl }), /directly inside/);
});
