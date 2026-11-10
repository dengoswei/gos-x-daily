#!/usr/bin/env node
// Mac deployment entry point. Offline CLI plus pinned local production controller.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { deploymentHome, sourceRepo } from './paths.mjs';
const base = deploymentHome();
const repo = sourceRepo;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const offline = new Set(['inspect-config', 'coverage-plan', 'coverage-report', 'import-browser', 'import-feed', 'compose-input', 'worker-input', 'review-input', 'validate-publication', 'prepare-delivery']);

export function verifyFiles(root, manifest) {
  if (fs.realpathSync(root) !== root) throw new Error('Release root must be a real path');
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Missing release manifest');
  const seen = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || path.isAbsolute(file.path) || file.path.split(/[\\/]/).some(p => !p || p === '.' || p === '..') || seen.has(file.path)) throw new Error('Invalid release file path');
    seen.add(file.path);
    const target = path.join(root, file.path);
    if (fs.realpathSync(target) !== target || !fs.statSync(target).isFile()) throw new Error(`Release path changed: ${file.path}`);
    if (hash(fs.readFileSync(target)) !== file.sha256) throw new Error(`Release hash changed: ${file.path}`);
  }
  return seen.size;
}

export async function main(argv = process.argv.slice(2)) {
  const manifest = read(path.join(base, 'release-manifest.json'));
  const filesVerified = verifyFiles(repo, manifest);
  const [command = 'inspect', ...args] = argv;
  const localManifest = read(path.join(base, 'local-release-manifest.json'));
  verifyFiles(base, localManifest);
  if (command === 'local') {
    const local = await import(pathToFileURL(path.join(repo, 'deployment/mac/mac-local.mjs')).href);
    return local.main(args);
  }
  if (command === 'inspect') {
    const runtime = read(path.join(base, 'runtime.local.json'));
    const deployment = read(path.join(base, 'deployment.local.json'));
    return { status: 'mac_release_verified', repo, revision: manifest.revision, filesVerified, cloudSourceFiles: manifest.cloudSourceFiles,
      productionFilesChanged: manifest.productionFilesChanged, testOnlyPatches: manifest.testOnlyPatches, node: process.version,
      compositionPromptSha256: hash(fs.readFileSync(path.join(repo, 'prompts/compose-digest.md'))),
      editorialSha256: hash(fs.readFileSync(path.join(repo, 'EDITORIAL.md'))),
      runtime: { config: path.join(base, 'runtime.local.json'), lookbackHours: runtime.lookbackHours, sourcesFile: runtime.sourcesFile, dataDir: runtime.dataDir, collectionEnabled: runtime.collectionEnabled, larkEnabled: runtime.lark.enabled },
      controller: deployment.controller, model: deployment.model, delivery: deployment.delivery,
      apiFinalization: { enabled: Boolean(deployment.model?.apiDraft?.keyFile), model: 'gpt-6.1-sol', reasoningEffort: 'high',
        stages: ['final', 'reader-comprehension', 'reader-fidelity', 'author-comprehension', 'author-fidelity'], sends: false },
      schedule: 'Codex X Daily Digest 9AM, Asia/Shanghai; retired Dot remote schedule', localController: read(path.join(base, 'mac-authority.json')) };
  }
  if (command === 'test') {
    const env = { ...process.env, TMPDIR: fs.realpathSync(os.tmpdir()) };
    for (const script of ['test', 'check', 'test:synthetic']) {
      const result = spawnSync('npm', ['run', script], { cwd: repo, env, stdio: 'inherit', shell: false });
      if (result.error || result.status !== 0) throw new Error(`Offline check failed: ${script}`);
    }
    return { status: 'offline_checks_passed', filesVerified, semanticReview: 'not performed', reportSent: false };
  }
  if (command !== 'cli' || !offline.has(args[0])) throw new Error('Use inspect, test, or cli with an offline command. Use local doctor/start-run/draft/finalize/publish/status/reconcile for Mac production. Direct CDP collection remains disabled.');
  const needsConfig = new Set(['inspect-config', 'coverage-plan', 'coverage-report', 'import-browser', 'import-feed', 'prepare-delivery']);
  if (needsConfig.has(args[0]) && !args.includes('--config')) args.push('--config', path.join(base, 'runtime.local.json'));
  const cli = await import(pathToFileURL(path.join(repo, 'cli.mjs')).href);
  return await cli.main(args);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await main(), null, 2)); }
  catch (error) { console.error(JSON.stringify({ status: 'blocked', error: error.message })); process.exitCode = 1; }
}
