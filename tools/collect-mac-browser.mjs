#!/usr/bin/env node
// Standalone CLI wrapper for scripted Mac source collection into an existing frozen run directory.
import { pathToFileURL } from 'node:url';
import { collectMacRun, parseCollectFlags } from '../deployment/mac/mac-collect.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseCollectFlags(process.argv.slice(2), { requireRun: true });
    console.log(JSON.stringify(await collectMacRun(options), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', error: error.message }));
    process.exitCode = 1;
  }
}
