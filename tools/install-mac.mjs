#!/usr/bin/env node
// Deliberate code promotion only. No credential provisioning, scheduling or sending.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--deployment-dir' || !path.isAbsolute(args[1])) throw new Error('Use --deployment-dir ABSOLUTE_EXISTING_PRIVATE_INSTALLATION');
const home = fs.realpathSync(args[1]);
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const git = (...argv) => {
  const r = spawnSync('git', argv, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('Cannot inspect source revision');
  return r.stdout.trim();
};
if (git('status', '--porcelain')) throw new Error('Commit and review all source changes before promoting');
const required = ['mac.local.json', 'mac-authority.json', 'runtime.local.json', 'deployment.local.json', 'sources.local.json'];
for (const file of required) if (!fs.statSync(path.join(home, file)).isFile()) throw new Error(`Missing provisioned configuration: ${file}`);
const files = git('ls-files', '-z').split('\0').filter(Boolean);
for (const file of files) if (fs.realpathSync(path.join(repo, file)) !== path.join(repo, file)) throw new Error(`Source symlink: ${file}`);
const revision = git('rev-parse', 'HEAD');
const backup = path.join(home, 'setup', `code-backup-${Date.now()}`);
fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
for (const file of ['run.mjs', 'MAC-RUNBOOK.md', 'source-repo.local.json', 'release-manifest.json', 'local-release-manifest.json']) {
  if (fs.existsSync(path.join(home, file))) fs.copyFileSync(path.join(home, file), path.join(backup, file));
}
const write = (name, bytes) => {
  const temp = path.join(home, `${name}.new-${process.pid}`);
  fs.writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, path.join(home, name));
};
const json = (name, value) => write(name, JSON.stringify(value, null, 2) + '\n');
write('run.mjs', fs.readFileSync(path.join(repo, 'deployment/mac/bootstrap.mjs')));
write('MAC-RUNBOOK.md', `# X Daily deployment\n\nSource checkout: ${repo}\n\nRead the authoritative [Mac runbook](${repo}/deployment/mac/RUNBOOK.md), [daily controller prompt](${repo}/prompts/run-daily.md), and [worker workflow](${repo}/docs/AGENT-WORKFLOW.md).\n\nThis local file is an installation pointer. All scripts, prompts and reusable instructions are versioned in that checkout. Private configuration, receipts and evidence remain in their existing local locations.\n`);
json('source-repo.local.json', { schemaVersion: 1, repo, revision, entrySha256: hash(path.join(repo, 'deployment/mac/run.mjs')) });
json('release-manifest.json', { schemaVersion: 1, revision, installedAt: new Date().toISOString(), files: files.map(file => ({ path: file, sha256: hash(path.join(repo, file)) })) });
const localFiles = ['run.mjs', 'source-repo.local.json', 'MAC-RUNBOOK.md', ...required];
json('local-release-manifest.json', { schemaVersion: 1, revision, files: localFiles.map(file => ({ path: file, sha256: hash(path.join(home, file)) })) });
console.log(JSON.stringify({ status: 'source_promoted', repo, revision, backup, reportSent: false, scheduleChanged: false }));
