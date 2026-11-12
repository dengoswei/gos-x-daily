#!/usr/bin/env node
// Installed as DEPLOYMENT_HOME/run.mjs. All workflow logic lives in the source repo.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

try {
  const home = path.dirname(fileURLToPath(import.meta.url));
  const pointer = JSON.parse(fs.readFileSync(path.join(home, 'source-repo.local.json'), 'utf8'));
  const expected = process.env.GOS_X_DAILY_EXPECT_REVISION;
  if (expected && pointer.revision !== expected) throw new Error('Production revision changed during this run. Restart from workflow.');
  if (!path.isAbsolute(pointer.repo) || fs.realpathSync(pointer.repo) !== pointer.repo) throw new Error('Invalid source checkout');
  const entry = path.join(pointer.repo, 'deployment/mac/run.mjs');
  if (fs.realpathSync(entry) !== entry || createHash('sha256').update(fs.readFileSync(entry)).digest('hex') !== pointer.entrySha256) throw new Error('Deployment entry changed; promote reviewed source first');
  process.env.GOS_X_DAILY_HOME = home;
  const { main } = await import(pathToFileURL(entry).href);
  console.log(JSON.stringify(await main(undefined, pointer), null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'blocked', error: error.message }));
  process.exitCode = 1;
}
