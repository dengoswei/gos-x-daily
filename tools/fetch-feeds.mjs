#!/usr/bin/env node
// Network tool: downloads the configured public feeds into a capture bundle for
// `cli.mjs import-feed`. The CLI itself never fetches; run this deliberately.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateFeedConfig, parseFeedDocument } from '../feed-import.mjs';
import { publicUrlRefusal } from '../feed.mjs';

const USER_AGENT = 'gos-x-daily-feed-fetch/0.1';
const PER_FEED_MS = 20000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;

async function readCapped(response, controller) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { controller.abort(); throw new Error(`Body exceeds ${MAX_BYTES} bytes`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function fetchFeed(feed, { fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${PER_FEED_MS} ms`)), PER_FEED_MS);
  try {
    let url = new URL(feed.url);
    for (let hop = 0; ; hop++) {
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`Refusing non-HTTPS or credentialed URL: ${url.origin}`);
      // A redirect must not steer the fetch to loopback, link-local or LAN hosts.
      const refusal = publicUrlRefusal(url);
      if (refusal) throw new Error(`Refusing ${refusal} URL: ${url.origin}`);
      const response = await fetchImpl(url.href, { redirect: 'manual', signal: controller.signal, headers: {
        'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.5' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (hop >= MAX_REDIRECTS) throw new Error(`More than ${MAX_REDIRECTS} redirects`);
        const location = response.headers.get('location');
        if (!location) throw new Error(`Redirect ${response.status} without Location`);
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { bytes: await readCapped(response, controller), finalUrl: url.href, status: response.status, contentType: response.headers.get('content-type') ?? '' };
    }
  } finally { clearTimeout(timer); }
}

export async function fetchFeeds(sources, outDir, { fetchImpl = globalThis.fetch, clock = () => new Date() } = {}) {
  const feeds = validateFeedConfig(sources);
  if (!feeds.length) throw new Error('No feeds configured');
  const bundleFile = path.join(outDir, 'feed-capture.json');
  if (fs.existsSync(bundleFile)) throw new Error(`Refusing to replace ${bundleFile}`);
  fs.mkdirSync(path.join(outDir, 'feeds'), { recursive: true });
  const bundle = { schemaVersion: 1, transport: 'fetched-documents', startedAt: clock().toISOString(), fetchedAt: null, documents: [], failures: [] };
  const report = [];
  for (const [index, feed] of feeds.entries()) {
    const id = `feed-${index + 1}`;
    try {
      const fetched = await fetchFeed(feed, { fetchImpl });
      const fetchedAt = clock().toISOString();
      // A document the importer would reject is recorded as a failure here, so one bad feed cannot block the rest.
      const entries = parseFeedDocument(fetched.bytes.toString('utf8'), feed.kind, feed.name);
      const relative = `feeds/${id}.${feed.kind === 'hf-daily-papers' ? 'json' : 'xml'}`;
      fs.writeFileSync(path.join(outDir, relative), fetched.bytes, { flag: 'wx' });
      bundle.documents.push({ id, feed: feed.name, url: feed.url, finalUrl: fetched.finalUrl, path: relative,
        sha256: createHash('sha256').update(fetched.bytes).digest('hex'), fetchedAt, contentType: fetched.contentType });
      report.push({ feed: feed.name, status: fetched.status, bytes: fetched.bytes.length, entries: entries.length });
    } catch (error) {
      const message = error?.cause?.message ? `${error.message}: ${error.cause.message}` : String(error?.message ?? error);
      bundle.failures.push({ feed: feed.name, url: feed.url, error: message.slice(0, 300) });
      report.push({ feed: feed.name, status: 'failed', error: message.slice(0, 300) });
    }
  }
  bundle.fetchedAt = clock().toISOString();
  fs.writeFileSync(bundleFile, JSON.stringify(bundle, null, 2) + '\n', { flag: 'wx' });
  return { output: bundleFile, documents: bundle.documents.length, failures: bundle.failures.length, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const value = flag => { const i = argv.indexOf(flag); const v = i >= 0 ? argv[i + 1] : undefined; if (!v || v.startsWith('--')) throw new Error(`Missing ${flag}`); return v; };
  try {
    const result = await fetchFeeds(JSON.parse(fs.readFileSync(value('--sources'), 'utf8')), path.resolve(value('--out')));
    console.log(JSON.stringify(result, null, 2));
    if (!result.documents) process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ status: 'failed', error: error.message })); process.exitCode = 1; }
}
