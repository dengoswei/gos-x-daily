#!/usr/bin/env node
// Source-only defense in depth. This does not prove that a repository has no secrets.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
const skip = new Set(['.git', 'node_modules', 'data', 'production', 'private', '.local', 'runs', 'evidence', 'mail', 'primary']);
const walk = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  if (skip.has(e.name) || e.name.endsWith('.local.json')) return [];
  const name = path.posix.join(prefix, e.name);
  return e.isDirectory() ? walk(path.join(dir, e.name), name) : [name];
});
const files = listed.status === 0 && listed.stdout ? [...new Set(listed.stdout.split('\0').filter(Boolean))] : walk(root);
const errors = [];
for (const file of files) {
  const absolute = path.join(root, file);
  if (fs.lstatSync(absolute).isSymbolicLink()) { errors.push(`${file}: symlinks are not allowed`); continue; }
  if (file.split('/').some(p => skip.has(p)) || /(?:^|\/)\.env(?:\.|$)|\.local\.json$|\.(?:png|jpe?g|pdf|tgz|zip|key|pem|sqlite|log|jsonl)$/.test(file)) errors.push(`${file}: forbidden runtime/private artifact class`);
  const content = fs.readFileSync(absolute, 'utf8');
  const patterns = [
    ['GitHub token', /gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/],
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['AWS key ID', /AKIA[0-9A-Z]{16}/],
    ['OpenAI-style key', /sk-[A-Za-z0-9_-]{32,}/],
    ['machine-specific workspace', /\/workspace\/(?:scratch|shared)\//],
    ['private home path', /\/Users\/(?!example\/)[^/\s]+\//],
    ['specific Lark app ID', /cli_[a-f0-9]{16}\b/i],
  ];
  for (const [name, regex] of patterns) if (regex.test(content)) errors.push(`${file}: ${name}`);
  for (const match of content.matchAll(/ou_([a-f0-9]{32})\b/gi)) {
    if (!/^(a{32}|b{32})$/.test(match[1])) errors.push(`${file}: non-synthetic Lark recipient ID`);
  }
  if (file.endsWith('.mjs')) {
    const checked = spawnSync(process.execPath, ['--check', absolute], { encoding: 'utf8' });
    if (checked.status !== 0) errors.push(`${file}: JavaScript syntax check failed`);
  }
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`Checked ${files.length} source files: syntax and selected privacy patterns passed. Manual staged review remains required.`);
