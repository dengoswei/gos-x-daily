/**
 * Deterministic Feishu rich-text post renderer for the digest's Markdown subset.
 * Native text/link elements stay inline. The CLI's `--markdown` path instead
 * creates separate `md` elements for links, which clients render as blocks.
 * This module is offline: it never resolves URLs, loads images, or sends.
 */
const text = (value, bold = false) => ({ tag: 'text', text: value, ...(bold ? { style: ['bold'] } : {}) });

/** Shared with binding.mjs: the exact `[label](href)` span the renderer parses (balanced parentheses). */
export function linkSpan(input, start) {
  const labelEnd = input.indexOf(']', start + 1);
  if (labelEnd < 0 || input[labelEnd + 1] !== '(') return null;
  let depth = 1, end = labelEnd + 2;
  for (; end < input.length; end++) {
    if (input[end] === '(') depth++;
    if (input[end] === ')' && --depth === 0) break;
  }
  return { label: input.slice(start + 1, labelEnd), href: input.slice(labelEnd + 2, end), hrefStart: labelEnd + 2, end: end + 1, closed: depth === 0 };
}

/**
 * The only destinations that may be rendered or bound: absolute HTTP(S) with the scheme
 * in any case, no credentials, whitespace, `<`, `>`, backslash or (encoded) dot segments.
 */
export function safeHref(href) {
  if (typeof href !== 'string' || !/^https?:\/\/[^\s<>\\]+$/i.test(href)) return false;
  const pathname = href.replace(/^https?:\/\/[^/?#]*/i, '').split(/[?#]/)[0];
  if (pathname.split('/').some(segment => /^(?:\.|%2e){1,2}$/i.test(segment))) return false;
  let parsed;
  try { parsed = new URL(href); } catch { return false; }
  return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
}

/** One bullet grammar for render and validation, applied to a trimmed line. */
export const bulletLine = /^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/;

function linkAt(input, start) {
  const span = linkSpan(input, start);
  if (!span) return null;
  if (!span.label || /[\[\]\n]/.test(span.label)) throw new Error('Unsupported or empty link label');
  if (!span.closed) throw new Error('Unclosed Markdown link');
  try { new URL(span.href); } catch { throw new Error('Invalid source link'); }
  if (!safeHref(span.href)) throw new Error('Source links must be HTTP(S) URLs without credentials, whitespace, angle brackets, backslashes or dot segments');
  return { node: { tag: 'a', text: span.label, href: span.href }, end: span.end };
}

/** Explicit support: bold, inline code (literal text), and Markdown source links. */
export function larkInline(input, { bold: initialBold = false } = {}) {
  const nodes = [];
  let buffer = '', bold = initialBold, toggled = false;
  const flush = () => { if (buffer) nodes.push(text(buffer, bold)); buffer = ''; };
  for (let index = 0; index < input.length;) {
    if (input.startsWith('![', index)) throw new Error('Digest post images must not be implicit Markdown fetches');
    if (input[index] === '\\' && /[\\*`\[\]]/.test(input[index + 1] ?? '')) {
      buffer += input[index + 1]; index += 2; continue;
    }
    if (input.startsWith('**', index)) {
      flush(); toggled = !toggled; bold = initialBold || toggled; index += 2; continue;
    }
    if (input[index] === '`') {
      flush();
      const fence = input.slice(index).match(/^`+/)[0];
      const end = input.indexOf(fence, index + fence.length);
      if (end < 0) throw new Error('Unclosed inline code');
      nodes.push(text(input.slice(index + fence.length, end), bold));
      index = end + fence.length; continue;
    }
    if (input[index] === '[') {
      const link = linkAt(input, index);
      if (link) { flush(); nodes.push(link.node); index = link.end; continue; }
    }
    buffer += input[index++];
  }
  flush();
  if (toggled) throw new Error('Unclosed bold span');
  return nodes;
}

export function renderLarkPost(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(markdown)) {
    throw new Error('Post requires nonempty Markdown without control characters');
  }
  const lines = markdown.replace(/\r\n?/g, '\n').trim().split('\n');
  if (!/^#\s+\S/.test(lines[0])) throw new Error('Post requires a first-level title');
  const title = lines.shift().replace(/^#\s+/, '').trim();
  if (/[`*\[\]]/.test(title)) throw new Error('Post title must be plain text');
  const content = [];
  let block = [];
  const flush = () => {
    if (block.length) content.push(larkInline(block.join(' ')));
    block = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (/^(?:```|~~~|\|)/.test(line) || /^<!--/.test(line)) throw new Error('Unsupported post block; review rendered main body only');
    const heading = line.match(/^(#{2,6})\s+(.+)$/);
    if (heading) { flush(); content.push(larkInline(heading[2], { bold: true })); continue; }
    if (/^#\s/.test(line)) throw new Error('Post may contain only one first-level title');
    const bullet = line.match(bulletLine);
    if (bullet) { flush(); block.push(`• ${bullet[1]}`); continue; }
    block.push(line);
  }
  flush();
  if (!content.length) throw new Error('Post must have body content');
  return { zh_cn: { title, content } };
}

/** These exact serialized bytes should be included in review/delivery bindings. */
export const larkPostJson = markdown => JSON.stringify(renderLarkPost(markdown));

/** Text projection for review; hyperlinks retain their URL, like CLI readback. */
export function larkPostVisibleText(markdown) {
  const { title, content } = renderLarkPost(markdown).zh_cn;
  return [title, ...content.map(row => row.map(node => node.tag === 'a' ? `[${node.text}](${node.href})` : node.text).join(''))].join('\n');
}
