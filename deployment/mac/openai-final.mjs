import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalUrl, citedUrls, digestUrls, observedUrls, readPublicationFile } from '../../binding.mjs';
import { coverageStatusLine, larkMarkdown, publicationGates } from '../../digest.mjs';
import { recentPublishedUrls } from '../../delivery-ledger.mjs';
import { createReviewInput, validateReview } from '../../review.mjs';
import { JSON_NOTE, UNTRUSTED, modelJson, tagged } from '../../prototype/run-packets.mjs';
import { frozenApiRun, readApiKey } from './openai-draft.mjs';

const model = 'gpt-6.1-sol';
const inputName = 'api-final-input.json';
const auditId = 'local-disposition-counts';
const accountingId = 'local-coverage-accounting';
const endpoint = 'https://api.openai.com/v1/chat/completions';
const write = (file, content) => fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
const writeJson = (file, value) => write(file, JSON.stringify(value, null, 2) + '\n');
const repoText = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const message = (role, content) => ({ role, content });
const data = (tag, value) => tagged(tag, modelJson(value));
const system = (stage, task) => message('system', '<!-- stage: ' + stage + ' -->\n' + task + '\n' + UNTRUSTED + '\n' + JSON_NOTE + '\nReturn exactly one JSON object.');
const evidenceKinds = new Set(['public', 'coverage']);
const asList = (items, limit) => Array.isArray(items) && items.length <= limit;
const substantial = text => typeof text === 'string' && text.trim().length >= 8 && text.length <= 3000;
const fields = ['problem', 'method', 'result', 'innovation'];
const checkedAt = () => new Date().toISOString();

function loadPacket(root, sources, raw, sourcesPath = 'sources.json') {
  if (Buffer.byteLength(raw) > 350000) throw new Error('API final evidence manifest exceeds byte budget');
  const packet = JSON.parse(raw);
  if (packet.schemaVersion !== 1 || packet.collectionId !== sources.collectionId ||
      !asList(packet.materialsPaths, 200) || !asList(packet.evidencePaths, 500) ||
      !asList(packet.excerpts, 100) || !packet.excerpts.length ||
      !packet.materialsPaths.includes('canonical-materials.json') ||
      !packet.materialsPaths.includes('collection-coverage.md')) throw new Error('Invalid API final evidence manifest');
  const materialsPaths = [inputName, ...packet.materialsPaths];
  const evidencePaths = [...new Set([...(sources.provenance?.evidence ?? []).map(row => row.path), ...packet.evidencePaths])];
  const bound = new Set([...materialsPaths, ...evidencePaths, sourcesPath]);
  if (bound.size !== materialsPaths.length + evidencePaths.length + 1) throw new Error('Overlapping API final artifact roles');
  // The manifest itself must not introduce URLs to the publication allowlist.
  const originalUrls = observedUrls({ collection: sources, rootDir: root, materialsPaths: packet.materialsPaths, evidencePaths });
  const byId = new Map();
  const backing = new Map();
  const excerpts = packet.excerpts.map(({ id, kind, path: file, url, text }) => {
    if (!/^[a-zA-Z0-9-]{1,50}$/.test(id ?? '') || byId.has(id) || [auditId, accountingId].includes(id) || !evidenceKinds.has(kind) ||
        !bound.has(file) || file === inputName || /(?:^|\/)(?:mail|gmail|private)(?:[\/._-]|$)/i.test(file) ||
        !/\.(?:json|md|txt|html)$/i.test(file) || !substantial(text) || text.length > 3000) {
      throw new Error('Invalid API final excerpt or disallowed backing file');
    }
    if (!backing.has(file)) backing.set(file, readPublicationFile(root, file));
    if (!backing.get(file).includes(text)) throw new Error('API final excerpt is not verbatim in its bound local file');
    if (kind === 'coverage') {
      if (file !== 'collection-coverage.md' || url !== undefined) throw new Error('Coverage excerpts must come from the coverage audit');
    } else {
      // Do not transmit inbox URLs, signed URLs, query strings or local addresses.
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search ||
          !host.includes('.') || /^(?:\[|\d|mail\.|outlook\.|localhost\.)|\.(?:local|internal|localhost)$/.test(host) ||
          !backing.get(file).includes(url) ||
          ![originalUrls.collection, originalUrls.materials].some(set => set.has(canonicalUrl(url)))) {
        throw new Error('API final public excerpt requires an observed public HTTPS URL in its backing file');
      }
    }
    const projected = { id, kind, ...(url ? { url } : {}), text };
    byId.set(id, { ...projected, file });
    return projected;
  });
  if (!excerpts.some(row => row.kind === 'public') || !excerpts.some(row => row.kind === 'coverage')) {
    throw new Error('API final needs both public evidence and coverage evidence');
  }
  if (Buffer.byteLength(JSON.stringify(excerpts)) > 180000) throw new Error('API final excerpt budget exceeded');
  return { excerpts, byId, backing, materialsPaths, evidencePaths };
}

function validateReviewAnswer(answer, units, packet, invalidQuotes) {
  if (!Array.isArray(answer.units) || answer.units.length !== units.length) throw new Error('API review returned incomplete unit coverage');
  const rows = new Map();
  const seen = new Set();
  for (const row of answer.units) {
    const unit = units.find(item => item.id === row?.id);
    if (!unit || seen.has(row.id) || !['pass', 'fail'].includes(row.status) || !substantial(row.notes)) {
      throw new Error('API review returned an invalid or duplicate unit verdict');
    }
    seen.add(row.id);
    if (!packet) {
      if (!fields.every(key => substantial(row.reconstruction?.[key]))) throw new Error('API review lacks a substantive reconstruction');
      rows.set(row.id, { status: row.status, notes: row.notes, reconstruction: Object.fromEntries(fields.map(key => [key, row.reconstruction[key]])) });
    } else {
      const refs = row.evidence;
      if (!asList(refs, 100) || (row.status === 'pass' && !refs.length)) throw new Error('API review lacks fidelity evidence');
      const quotedIds = new Set();
      const metadataIds = new Set();
      const invalidIds = new Set();
      const evidence = refs.flatMap(ref => {
        const source = packet.byId.get(ref?.id);
        if (!source || !substantial(ref.quote)) throw new Error('API review cited an unsupported evidence excerpt');
        if (source.url && ref.quote === source.url) {
          metadataIds.add(ref.id);
          return [];
        }
        if (!source.text.includes(ref.quote)) {
          if (!invalidQuotes) throw new Error('API review cited an unsupported evidence excerpt');
          invalidIds.add(ref.id);
          return [];
        }
        quotedIds.add(ref.id);
        return [{ id: ref.id, quote: ref.quote }];
      });
      if (invalidIds.size) {
        invalidQuotes.set(unit.id, [...invalidIds]);
        continue;
      }
      if ([...metadataIds].some(id => !quotedIds.has(id))) throw new Error('API review cited a URL without source text');
      if (row.status === 'pass') {
        const sources = evidence.map(ref => packet.byId.get(ref.id));
        if ((['render', 'transport'].includes(unit.kind) || unit.text.includes('本次采集范围') ||
            (unit.kind === 'audit' && /覆盖|遍历|采集|未看到|截图/.test(unit.text))) && !sources.some(source => source.kind === 'coverage')) {
          throw new Error('API review must check coverage against the coverage evidence');
        }
        const links = unit.kind === 'main' || unit.kind === 'render' ? citedUrls(unit.text).map(canonicalUrl) : [];
        if (links.some(url => !sources.some(source => source.url && canonicalUrl(source.url) === url))) {
          throw new Error('API review must account for every cited link in this unit');
        }
      }
      rows.set(row.id, { status: row.status, notes: row.notes, evidence });
    }
  }
  return rows;
}

const comprehension = 'For each exact unit return {"units":[{"id":"…","status":"pass or fail","reconstruction":{"problem":"…","method":"…","result":"…","innovation":"…"},"notes":"…"}]}. Reconstruct the main point, mechanism, result, and contribution or limitation solely from the supplied final prose; for coverage, audit and transport units reconstruct their actual meaning and role. State what is missing rather than inventing it. Fail unclear or misleading units and explain the concrete defect. Use distinct, substantive explanations.';
const fidelity = 'For each exact unit return {"units":[{"id":"…","status":"pass or fail","notes":"…","evidence":[{"id":"excerpt ID","quote":"verbatim substring of that excerpt\'s text field, at least 8 characters"}]}]}. Compare claims, dates, mechanism, results, comparisons and limitations with the supplied evidence. Give specific findings, fail material discrepancies or missing evidence. Cite evidence for every link in main and rendered Markdown units, coverage evidence for any coverage claims, render and transport, and the local disposition facts for any candidate counts. A URL alone is not evidence. A disposition reason records an editorial decision, not proof of which source bodies were read. For exact transport JSON check visible text, link grouping and any truncation against render; do not claim client UI readback.';

export async function finalizeOpenAI({ runsDir, runDir, keyFile, ledgerDir, revision = false, fetchImpl = globalThis.fetch }) {
  const { run, sources, sourcesText, sourcesPath = 'sources.json' } = frozenApiRun(runsDir, runDir);
  const read = file => readPublicationFile(runDir, file);
  const inputRaw = read(inputName);
  const packet = loadPacket(runDir, sources, inputRaw, sourcesPath);
  const recent = recentPublishedUrls(ledgerDir, { before: run.date });
  if (revision) recent.push(...recentPublishedUrls(ledgerDir, { before: new Date(Date.parse(run.date) + 86400000).toISOString().slice(0, 10) })
    .filter(row => row.date === run.date));
  const allowed = new Set(packet.excerpts.flatMap(row => row.url ? [row.url] : []));
  const canonicalAllowed = new Set([...allowed].map(canonicalUrl));
  const draftReport = JSON.parse(read('api-draft/report.json'));
  if (draftReport.validation?.passed !== true) throw new Error('API final requires a validated API draft');
  const draft = { markdown: read('api-draft/digest.md'), dispositions: JSON.parse(read('api-draft/dispositions.json')) };
  const windows = sources.coverage?.accounting?.windows;
  const accounting = { id: accountingId, kind: 'coverage', text: coverageStatusLine(sources) +
    '\nHours lacking certified UI traversal: 24h window = ' + (windows?.['24h']?.unscannedHours ?? 'unknown') +
    '; 48h window = ' + (windows?.['48h']?.unscannedHours ?? 'unknown') + '. These are not measured missing posts.' };
  const renderedCoverage = larkMarkdown(draft.markdown, sources, { renderStyle: 'concise' }).trimEnd().split('\n').at(-1);
  const key = readApiKey(keyFile);
  const resultPath = path.join(runDir, 'api-final-result.json');
  const lock = path.join(runDir, 'api-final.lock');
  fs.mkdirSync(lock, { mode: 0o700 });
  try {
    if (fs.existsSync(resultPath)) throw new Error('API final already completed for this run');
    const outDir = fs.mkdtempSync(path.join(runDir, 'api-final-'));
    const usagePath = path.join(outDir, 'api-usage.jsonl');
    const call = async (stage, messages, attempt) => {
      if (Buffer.byteLength(JSON.stringify(messages)) > 540000) throw new Error('API final request exceeds byte budget');
      const startedAt = checkedAt();
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(240000),
          headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
          body: JSON.stringify({ model, messages, reasoning_effort: 'high', service_tier: 'default',
            max_completion_tokens: 20000, response_format: { type: 'json_object' }, store: false }),
        });
      } catch {
        throw new Error('OpenAI API final network failure or timeout at ' + stage);
      }
      const payload = await response.json().catch(() => null);
      const actual = payload?.model;
      const usage = payload?.usage;
      const finishedAt = checkedAt();
      fs.appendFileSync(usagePath, JSON.stringify({
        attempt, stage, model, actualModel: actual, requestId: payload?.id, status: response.status, startedAt, finishedAt,
        serviceTier: payload?.service_tier, inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens,
        cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens,
        cacheWriteInputTokens: usage?.prompt_tokens_details?.cache_write_tokens,
        reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
      }) + '\n', { mode: 0o600 });
      const choice = payload?.choices?.[0];
      const content = choice?.message?.content;
      if (!response.ok || typeof payload?.id !== 'string' ||
          (actual !== model && !actual?.startsWith(model + '-')) || choice?.finish_reason !== 'stop' ||
          typeof content !== 'string' || choice.message.refusal || content.includes(key)) {
        throw new Error('OpenAI API final rejected or incomplete at ' + stage + ' (HTTP ' + response.status + ')');
      }
      let answer;
      try { answer = JSON.parse(content); } catch { throw new Error('Invalid OpenAI JSON at ' + stage); }
      if (!answer || Array.isArray(answer) || typeof answer !== 'object') throw new Error('OpenAI final result must be a JSON object');
      write(path.join(outDir, attempt + '-' + stage + '.json'), content + '\n');
      return { answer, content, id: payload.id, actualModel: actual, finishedAt };
    };
    const checkFidelity = async (stage, messages, attempt, units, evidence, authorModel) => {
      const first = await call(stage, messages, attempt);
      if (authorModel && first.actualModel !== authorModel) throw new Error('The final author model changed during self-review');
      const invalidQuotes = new Map();
      const rows = validateReviewAnswer(first.answer, units, evidence, invalidQuotes);
      for (const row of rows.values()) row.checkedAt = first.finishedAt;
      if (!invalidQuotes.size) return { result: first, rows };
      const affected = units.filter(unit => invalidQuotes.has(unit.id));
      const errors = affected.map(unit => ({ unitId: unit.id, excerptIds: invalidQuotes.get(unit.id) }));
      const repair = message('user',
        'Continue the same fidelity review. Return verdicts only for the listed repair units. The identified quotes were not exact substrings of their excerpt text. ' +
        'Recheck the affected verdicts against the same evidence. Use short verbatim substrings of the supplied text, including any model version or qualifier that changes the claim. ' +
        'If the source does not support a claim, return fail and explain the discrepancy. ' +
        fidelity + '\n' + data('repair_units', affected) + '\n' + data('citation_errors', errors));
      const result = await call(stage + '-citation-repair', [...messages, message('assistant', first.content), repair], attempt);
      if (result.actualModel !== first.actualModel) throw new Error('The fidelity reviewer model changed during citation repair');
      const repaired = validateReviewAnswer(result.answer, affected, evidence);
      for (const [id, row] of repaired) rows.set(id, { ...row, checkedAt: result.finishedAt });
      return { result, rows: new Map(units.map(unit => [unit.id, rows.get(unit.id)])) };
    };
    const recentPublic = recent.map(row => ({ date: row.date, urls: row.urls.filter(url => canonicalAllowed.has(canonicalUrl(url))).map(canonicalUrl) }));
    const shared = data('verified_evidence', { renderedCoverage, recentPublic, excerpts: [...packet.excerpts, accounting] });
    const base = [
      system('final', repoText('../../EDITORIAL.md') + '\n' + repoText('../../prompts/compose-digest.md') +
        '\nYou are the final author. Use the draft only as leads; every included story must be supported by verified excerpts. Cite only their exact public URLs. Use the draft collection ID and account for every original candidate key; compress same-reason skipped keys into groups if helpful. Audit counts must match your final dispositions. Count candidate keys, main bullets and supplemental links separately; one key or link need not equal one story. Do not infer reading depth, an excerpt absence reason, or the controller’s review or delivery status. Keep a concise 本次采集范围 paragraph in the visible main body, separated by blank lines, and preserve material limits. The renderer appends renderedCoverage verbatim. Distinguish hours with no certified traversal from measured actual gaps and unknown unseen-post count; make your own coverage text consistent with the appended line. No private source paths, links or headers. For repeats, require a supported new fact with 跟进. Return {"markdown":"complete digest","dispositions":{"schemaVersion":1,"collectionId":"…","items":[]}}.'),
      message('user', data('final_inputs', { date: run.date, revision, draft }) + '\n' + shared),
    ];
    let feedback = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const folder = path.join(outDir, 'attempt-' + attempt);
      fs.mkdirSync(folder, { mode: 0o700 });
      const author = feedback.length ? [...base, message('user', data('revision_findings', feedback))] : base;
      const final = await call('final', author, attempt);
      const { markdown, dispositions } = final.answer;
      const rel = file => path.relative(runDir, path.join(folder, file));
      if (typeof markdown !== 'string' || !dispositions || markdown.length > 24000 ||
          !markdown.includes('本次采集范围') ||
          (revision && !markdown.startsWith('# X AI 日报 ' + run.date + '\n' + Number(run.date.slice(5, 7)) + ' 月 ' + Number(run.date.slice(-2)) + ' 日修订版。')) ||
          citedUrls(markdown).some(url => !allowed.has(url))) {
        feedback = ['Final must be bounded, use only exact authorized public links, include current coverage, and use the required date/revision header.'];
        continue;
      }
      write(path.join(folder, 'digest.md'), markdown);
      writeJson(path.join(folder, 'dispositions.json'), dispositions);
      const snapshotInputs = {
        digestPath: rel('digest.md'), dispositionsPath: rel('dispositions.json'), sourcesPath,
        materialsPaths: [...packet.materialsPaths], evidencePaths: packet.evidencePaths, authorId: 'openai-api:' + model + ':' + final.id,
        reviewMode: 'self', renderStyle: 'concise', transport: 'feishu-post-v1',
      };
      let gates;
      try {
        gates = publicationGates(runDir, snapshotInputs, markdown, sources, { publishedHistory: recent });
      } catch (error) {
        writeJson(path.join(folder, 'structural-failure.json'), { reason: error.message });
        feedback = ['Local digest and dispositions gate failed. Preserve all original candidate keys, match included URLs and section names to actual bullets, and use the exact title, collection marker and audit heading.'];
        continue;
      }
      if (!gates.renderedMarkdown.includes('本次采集范围') || digestUrls(gates.renderedMarkdown).some(url => !allowed.has(url))) {
        feedback = ['Coverage paragraph must survive the exact final render in a retained main section.'];
        continue;
      }
      const { candidates, included, merged, skipped, skippedReasons, supplementUrls } = gates.validation.dispositions;
      const includedUrlsByKey = new Map(dispositions.items.filter(row => row.disposition === 'included')
        .map(row => [row.key, canonicalUrl(row.url)]));
      const publicUrlDispositions = new Map();
      for (const url of includedUrlsByKey.values()) {
        if (!publicUrlDispositions.has(url)) publicUrlDispositions.set(url, { includedKeys: 0, mergedKeys: 0 });
        publicUrlDispositions.get(url).includedKeys++;
      }
      for (const row of dispositions.items) {
        if (row.disposition === 'merged') publicUrlDispositions.get(includedUrlsByKey.get(row.mergedInto)).mergedKeys++;
      }
      const audit = { id: auditId, kind: 'audit', text: JSON.stringify({
        candidates, included, merged, skipped, skippedReasons, mainBullets: gates.validation.mainBullets,
        supplementUrls, publicUrlDispositions: Object.fromEntries(publicUrlDispositions),
      }) };
      const auditPath = rel('audit-facts.json');
      write(path.join(folder, 'audit-facts.json'), audit.text + '\n');
      snapshotInputs.materialsPaths.push(auditPath);
      const auditData = data('local_disposition_facts', audit);
      const scopedEvidence = { byId: new Map([...packet.byId,
        [auditId, { ...audit, file: auditPath }], [accountingId, { ...accounting, file: sourcesPath }]]) };
      // Detect changes since the evidence was actually read, then bind all exact local bytes.
      const assertEvidenceUnchanged = () => {
        if (read(inputName) !== inputRaw || read(sourcesPath) !== sourcesText ||
            [...packet.backing].some(([file, original]) => read(file) !== original)) throw new Error('API final evidence changed during review');
      };
      assertEvidenceUnchanged();
      const inputs = { rootDir: runDir, ...snapshotInputs, renderedMarkdown: gates.renderedMarkdown };
      const pending = createReviewInput(inputs);
      writeJson(path.join(folder, 'review.pending.json'), pending);
      write(path.join(folder, 'report.final.md'), gates.renderedMarkdown);
      const native = pending.units.find(unit => unit.kind === 'transport');
      write(path.join(folder, 'post.final.json'), native.text);
      const units = pending.units.map(({ id, kind, text }) => ({ id, kind, text }));
      const repeated = new Set(gates.validation.repeatedUrls.map(row => row.url));
      if (units.some(unit => unit.kind === 'main' && !unit.text.includes('跟进') &&
          citedUrls(unit.text).some(url => repeated.has(canonicalUrl(url))))) {
        feedback = ['A previously published URL requires a supported new fact and the visible 跟进 label on its item.'];
        continue;
      }
      const unitData = data('review_units', units);
      const readerPrompt = system('reader-comprehension', 'You are a fresh advisory reader with no prior context. ' + comprehension);
      const readerA = await call('reader-comprehension', [readerPrompt, message('user', unitData)], attempt);
      const readerARows = validateReviewAnswer(readerA.answer, units);
      if (checkedAt() <= readerA.finishedAt) await delay(2);
      const { result: readerB, rows: readerBRows } = await checkFidelity('reader-fidelity', [
        system('reader-fidelity', 'You are the advisory fidelity reader. ' + fidelity),
        message('user', unitData + '\n' + data('persisted_reader_reconstruction', [...readerARows]) + '\n' + shared + '\n' + auditData),
      ], attempt, units, scopedEvidence);
      writeJson(path.join(folder, 'reader.advisory.json'), {
        advisory: true, notApproval: true, model,
        snapshotSha256: pending.snapshotSha256,
        comprehension: { sourceBlind: true, checkedAt: readerA.finishedAt, requestId: readerA.id, units: [...readerARows] },
        fidelity: { checkedAt: readerB.finishedAt, requestId: readerB.id, units: [...readerBRows] },
      });
      const failures = (...stages) => stages.flatMap(rows => [...rows].filter(([, row]) => row.status === 'fail')
        .map(([id, row]) => ({ id, notes: row.notes })));
      feedback = failures(readerARows, readerBRows);
      if (feedback.length) feedback.unshift({ previousFinal: markdown });
      if (feedback.length) continue;
      const transcript = [...author, message('assistant', final.content)];
      const selfRequest = message('user', 'Continue as the same final author, now reconstructing your final units. You have already seen evidence; do not claim source blindness. ' + comprehension + '\n' + unitData);
      const selfA = await call('author-comprehension', [...transcript, selfRequest], attempt);
      const selfARows = validateReviewAnswer(selfA.answer, units);
      if (checkedAt() <= selfA.finishedAt) await delay(2);
      if (selfA.actualModel !== final.actualModel) throw new Error('The final author model changed during self-review');
      const { rows: selfBRows } = await checkFidelity('author-fidelity', [...transcript, selfRequest, message('assistant', selfA.content),
        message('user', 'Continue as the same final author; compare the exact units against the already supplied verified evidence. ' + fidelity + '\n' + auditData),
      ], attempt, units, scopedEvidence, final.actualModel);
      feedback = failures(selfARows, selfBRows);
      if (feedback.length) feedback.unshift({ previousFinal: markdown });
      if (feedback.length) continue;
      assertEvidenceUnchanged();
      const review = {
        ...pending, status: 'approved', reviewerId: pending.authorId, reviewedAt: checkedAt(),
        units: pending.units.map(unit => ({
          ...unit, status: 'approved',
          comprehension: { ...selfARows.get(unit.id), sourceBlind: false, checkedAt: selfA.finishedAt },
          fidelity: { status: 'pass', checkedAt: selfBRows.get(unit.id).checkedAt, notes: selfBRows.get(unit.id).notes,
            sourcePaths: [...new Set(selfBRows.get(unit.id).evidence.map(ref => scopedEvidence.byId.get(ref.id).file))] },
        })),
      };
      validateReview(review, inputs);
      writeJson(path.join(folder, 'review.self.json'), review);
      const publication = path.join(folder, 'publication.json');
      writeJson(publication, { rootDir: '../..', snapshotInputs, reviewPath: rel('review.self.json'), ledgerDir });
      const result = { status: 'api_final_reviewed_not_sent', publication, outDir, usagePath, units: units.length, attempt, authorId: pending.authorId };
      writeJson(resultPath, result);
      return result;
    }
    throw new Error('API final could not resolve validation or material review findings in two attempts. Inspect ' + outDir);
  } finally {
    fs.rmdirSync(lock);
  }
}
