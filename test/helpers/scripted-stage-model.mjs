#!/usr/bin/env node
// SYNTHETIC TEST FIXTURE ONLY: a deterministic stdin -> stdout stand-in for a model,
// keyed on the orchestrator's stage marker. It never reviews, judges or approves;
// it only exercises the stage contracts offline. Never use it in real work.
const SECTION = 'Frameworks / Infra';
const SECTIONS = ['Frameworks / Infra', 'Breakthrough Research', 'Applications / Products', 'Long-form / Essays', '补课 / 历史讨论'];

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

const block = (text, tag) => {
  const matches = [...text.matchAll(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`, 'g'))];
  if (!matches.length) throw new Error(`Scripted model: missing <${tag}> block`);
  return matches.at(-1)[1];
};
const jsonBlock = (text, tag) => JSON.parse(block(text, tag));
const fenced = (language, body) => `\`\`\`${language}\n${body}\n\`\`\``;

// Screening: skip 'PROMO' texts as promotion, otherwise select; group candidates
// of one batch that share an outbound link with an earlier selected candidate.
function screen(prompt) {
  const views = jsonBlock(prompt, 'candidates_json');
  const decisions = [];
  for (const view of views) {
    if (String(view.text ?? '').includes('PROMO')) {
      decisions.push({ key: view.key, action: 'skip', reason: 'promotion' });
      continue;
    }
    const shared = decisions.find(decision => decision.action === 'story' &&
      (views.find(other => other.key === decision.key)?.links ?? []).some(href => (view.links ?? []).includes(href)));
    decisions.push({ key: view.key, action: 'story', reason: 'SYNTHETIC fixture selection',
      ...(shared ? { groupWith: shared.key } : {}) });
  }
  return fenced('json', JSON.stringify({ decisions }, null, 2));
}

function story(prompt) {
  const group = jsonBlock(prompt, 'group');
  const packets = jsonBlock(prompt, 'candidate_packets');
  const primary = packets.find(packet => packet.candidate.key === group.representative) ?? packets[0];
  const url = primary.candidate.url;
  const bullet = `- **SYNTHETIC 合成要点：固定夹具条目** 本条由离线测试夹具生成，不包含任何真实评估；仅用于验证编排契约。${url}`;
  return [fenced('markdown', bullet), '', fenced('json', JSON.stringify({
    primaryKey: group.representative, section: SECTION, citedUrls: [url],
    limits: ['SYNTHETIC fixture output; no evidence was read.'],
    unresolved: ['SYNTHETIC fixture output; nothing was verified.'],
  }, null, 2))].join('\n');
}

function compose(prompt) {
  const collection = jsonBlock(prompt, 'collection_json');
  const keys = block(prompt, 'candidate_keys').split('\n').map(line => line.trim()).filter(Boolean);
  const screened = jsonBlock(prompt, 'screen_decisions');
  const items = jsonBlock(prompt, 'story_items');
  const used = SECTIONS.filter(section => items.some(item => item.section === section));
  const coverage = collection.coverage;
  const scope = `本次采集范围：SYNTHETIC 合成运行。近24小时有 ${coverage?.windows?.['24h']?.unscannedHours ?? '未知'} 小时、近48小时有 ${coverage?.windows?.['48h']?.unscannedHours ?? '未知'} 小时未验证扫描；累计观察链接 ${coverage?.knownCandidates?.observedLinks ?? '未知'} 个，规则过滤 ${coverage?.knownCandidates?.filterDrops ?? '未知'} 个，待深读 ${coverage?.knownCandidates?.deepReadBacklog ?? '未知'} 个（其中失败 ${coverage?.knownCandidates?.deepReadFailures ?? '未知'} 个）。未看到的帖子数未知。`;
  const lines = [`# X AI 日报 ${collection.date}`, collection.digestMarker, ''];
  for (const [index, section] of used.entries()) {
    lines.push(`## ${section}`);
    for (const item of items.filter(entry => entry.section === section)) lines.push(item.markdown, '');
    if (index === used.length - 1) lines.push('### 本次采集范围', scope, '');
  }
  lines.push('## 差异补充', 'SYNTHETIC 合成审计段：本条目来自离线测试夹具，未做任何语义审阅。', '');
  const included = new Map(items.map(item => [item.primaryKey, item]));
  const rows = keys.map(key => {
    const item = included.get(key);
    if (item) return { key, disposition: 'included', section: item.section, url: item.citedUrls[0] };
    const owner = items.find(entry => entry.keys.includes(key));
    if (owner) return { key, disposition: 'merged', mergedInto: owner.primaryKey };
    const skip = screened.skipped.find(entry => entry.key === key);
    return { key, disposition: 'skipped', reason: skip?.reason ?? 'other', note: 'SYNTHETIC fixture row' };
  });
  return [fenced('markdown', lines.join('\n').trimEnd()), '', fenced('json', JSON.stringify({
    schemaVersion: 1, collectionId: collection.collectionId, items: rows,
  }, null, 2))].join('\n');
}

const prompt = await readStdin();
const stage = prompt.match(/<!-- stage: (screen|story|compose) -->/)?.[1];
const handler = { screen, story, compose }[stage];
if (!handler) { process.stderr.write(`Scripted model: unknown stage marker\n`); process.exit(1); }
process.stdout.write(handler(prompt) + '\n');
