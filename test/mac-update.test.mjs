import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('one update installs fetched main and the production entry selects its workflow', t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'xdaily-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const upstream = path.join(root, 'upstream');
  const checkout = path.join(root, 'checkout');
  const home = path.join(root, 'deployment');
  fs.mkdirSync(home);
  const run = (cwd, command, args, env = process.env) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const git = (cwd, ...args) => run(cwd, 'git', args);
  git(root, 'init', '--initial-branch=main', upstream);
  git(upstream, 'config', 'user.name', 'Synthetic test');
  git(upstream, 'config', 'user.email', 'synthetic@example.invalid');
  for (const file of ['tools/update-mac.mjs', 'tools/install-mac.mjs', 'deployment/mac/bootstrap.mjs', 'deployment/mac/run.mjs', 'deployment/mac/paths.mjs']) {
    const target = path.join(upstream, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(new URL('../' + file, import.meta.url), target);
  }
  const prompt = 'prompts/run-daily.md';
  fs.mkdirSync(path.join(upstream, 'prompts'));
  fs.writeFileSync(path.join(upstream, prompt), 'original instructions');
  git(upstream, 'add', '--', 'tools', 'deployment', 'prompts');
  git(upstream, 'commit', '-m', 'Initial workflow');
  git(root, 'clone', upstream, checkout);
  for (const file of ['mac.local.json', 'mac-authority.json', 'runtime.local.json', 'deployment.local.json', 'sources.local.json']) {
    fs.writeFileSync(path.join(home, file), '{}');
  }
  const update = () => JSON.parse(run(checkout, process.execPath, ['tools/update-mac.mjs', '--deployment-dir', home]));
  const workflow = () => JSON.parse(run(root, process.execPath, [path.join(home, 'run.mjs'), 'workflow']));
  const old = update();
  assert.equal(workflow().revision, old.revision);
  fs.writeFileSync(path.join(upstream, prompt), 'new instructions');
  git(upstream, 'commit', '-am', 'Update workflow');
  const next = update();
  const selected = workflow();
  assert.equal(selected.revision, git(upstream, 'rev-parse', 'HEAD'));
  assert.equal(selected.revision, next.revision);
  assert.equal(fs.readFileSync(selected.prompt, 'utf8'), 'new instructions');
  assert.equal(fs.readFileSync(path.join(old.repo, prompt), 'utf8'), 'original instructions');
  const stale = spawnSync(process.execPath, [path.join(home, 'run.mjs'), 'workflow'], {
    encoding: 'utf8', env: { ...process.env, GOS_X_DAILY_EXPECT_REVISION: old.revision },
  });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /Production revision changed/);
  fs.writeFileSync(selected.prompt, 'tampered instructions');
  const tampered = spawnSync(process.execPath, [path.join(home, 'run.mjs'), 'workflow'], { encoding: 'utf8' });
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /Release hash changed: prompts\/run-daily\.md/);
});
