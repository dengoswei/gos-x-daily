#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const source = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--deployment-dir' || !path.isAbsolute(args[1])) throw new Error('Use --deployment-dir ABSOLUTE_EXISTING_PRIVATE_INSTALLATION');
const home = fs.realpathSync(args[1]);
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (command, argv) => {
  const result = spawnSync(command, argv, { cwd: source, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(command + ' failed: ' + (result.stderr?.trim() || result.error?.message || result.status));
  return result.stdout;
};
const git = (...argv) => run('git', argv);
if (git('status', '--porcelain')) throw new Error('Commit and review all source changes before promoting');
const required = ['mac.local.json', 'mac-authority.json', 'runtime.local.json', 'deployment.local.json', 'sources.local.json'];
for (const name of required) {
  const file = path.join(home, name);
  if (fs.realpathSync(file) !== file || !fs.statSync(file).isFile()) throw new Error('Invalid provisioned configuration: ' + name);
}
const revision = git('rev-parse', 'HEAD').trim();
const files = git('ls-tree', '-r', '-z', revision).split('\0').filter(Boolean).map(row => {
  const tab = row.indexOf('\t');
  if (!/^100(?:644|755) blob /.test(row.slice(0, tab))) throw new Error('Release contains a symlink or non-regular Git entry');
  return row.slice(tab + 1);
});
const releases = path.join(home, 'releases');
fs.mkdirSync(releases, { recursive: true, mode: 0o700 });
if (fs.realpathSync(releases) !== releases) throw new Error('Release directory must be a real path');
const repo = path.join(releases, revision);
const staging = fs.mkdtempSync(path.join(releases, '.staging-'));
try {
  const archive = path.join(staging, 'source.tar');
  const tree = path.join(staging, 'tree');
  fs.mkdirSync(tree, { mode: 0o700 });
  git('archive', '--format=tar', '--output=' + archive, revision);
  run('tar', ['-xf', archive, '-C', tree]);
  const manifestFiles = files.map(name => ({ path: name, sha256: hash(path.join(tree, name)) }));
  if (!fs.existsSync(repo)) fs.renameSync(tree, repo);
  if (fs.realpathSync(repo) !== repo || manifestFiles.some(file => {
    const target = path.join(repo, file.path);
    return fs.realpathSync(target) !== target || !fs.statSync(target).isFile() || hash(target) !== file.sha256;
  })) throw new Error('Existing release bytes differ from the Git commit');
  fs.mkdirSync(path.join(home, 'setup'), { recursive: true, mode: 0o700 });
  const backup = fs.mkdtempSync(path.join(home, 'setup', 'code-backup-'));
  for (const name of ['run.mjs', 'MAC-RUNBOOK.md', 'source-repo.local.json', 'release-manifest.json', 'local-release-manifest.json']) {
    if (fs.existsSync(path.join(home, name))) fs.copyFileSync(path.join(home, name), path.join(backup, name));
  }
  const write = (name, bytes) => {
    const temporary = path.join(staging, name);
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, path.join(home, name));
  };
  const launcher = fs.readFileSync(path.join(repo, 'deployment/mac/bootstrap.mjs'));
  const activeLauncher = path.join(home, 'run.mjs');
  if (!fs.existsSync(activeLauncher) || !launcher.equals(fs.readFileSync(activeLauncher))) write('run.mjs', launcher);
  const runbook = path.join(home, 'MAC-RUNBOOK.md');
  if (!fs.existsSync(runbook) || !fs.readFileSync(runbook, 'utf8').includes('run.mjs workflow')) {
    write('MAC-RUNBOOK.md', '# X Daily deployment\n\nRun `node run.mjs workflow` to locate the active production instructions.\n');
  }
  const localFiles = ['run.mjs', 'MAC-RUNBOOK.md', ...required];
  const pointer = {
    schemaVersion: 2, repo, revision, entrySha256: hash(path.join(repo, 'deployment/mac/run.mjs')),
    release: { revision, files: manifestFiles },
    local: { files: localFiles.map(name => ({ path: name, sha256: hash(path.join(home, name)) })) },
  };
  write('source-repo.local.json', JSON.stringify(pointer, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'source_promoted', repo, revision, backup }));
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
