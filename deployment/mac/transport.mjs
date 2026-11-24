import { createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { larkPostJson, larkPostVisibleText } from '../../lark-post.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');

export function nativeSenderArgs(plan) {
  const content = larkPostJson(plan.args[7]);
  if (plan.transport?.kind !== 'feishu-post-v1' || plan.transport.content !== content ||
      plan.transport.sha256 !== hash(content) ||
      plan.validation?.review?.bindings?.transport?.sha256 !== hash(content)) {
    throw new Error('Native post payload does not match reviewed transport');
  }
  return [...plan.args.slice(0, 6), '--msg-type', 'post', '--content', content, ...plan.args.slice(8)];
}

// Historic receipts retain their original Markdown projection. New sends always
// use nativeSenderArgs; this fallback is reconciliation-only, never a retry path.
export function expectedReadback(plan) {
  if (plan.transport === undefined) return plan.args[7];
  nativeSenderArgs(plan);
  return larkPostVisibleText(plan.args[7]);
}

export const normalizedReadback = text => text
  // Feishu may autolink a plain domain or IPv4:port in a text node. Accept only identical
  // label/destination decoration; changed destinations still fail comparison.
  .replace(/\[([a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,63})\]\(\1\)/g, '$1')
  .replace(/\[(((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5}))\]\(\1\)/g,
    (match, label, ip, port) => isIPv4(ip) && Number(port) >= 1 && Number(port) <= 65535 ? label : match)
  .replace(/^#{1,6}\s+/gm, '').replace(/\*\*/g, '').replace(/[\s\u200b-\u200d\ufeff]/g, '');
