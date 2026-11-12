#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--deployment-dir' || !path.isAbsolute(args[1])) throw new Error('Use --deployment-dir ABSOLUTE_EXISTING_PRIVATE_INSTALLATION');
const git = (...argv) => {
  const result = spawnSync('git', argv, { cwd: source, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('git ' + argv[0] + ' failed: ' + (result.stderr?.trim() || result.error?.message || result.status));
  return result.stdout.trim();
};
if (git('branch', '--show-current') !== 'main' || git('status', '--porcelain')) {
  throw new Error('Run the update from a clean main checkout');
}
git('pull', '--ff-only', 'origin', 'main');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'FETCH_HEAD')) {
  throw new Error('Local main differs from the fetched origin/main');
}
const install = spawnSync(process.execPath, [path.join(source, 'tools/install-mac.mjs'), ...args], { stdio: 'inherit' });
if (install.error) throw install.error;
process.exitCode = install.status ?? 1;
