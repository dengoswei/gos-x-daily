// Mail and Xiaohongshu bodies remain in the local store; public originals discovered
// through them enter separately as public supplements.
import { isAbstractLandingUrl } from './content-store.mjs';

const shareableKinds = new Set(['x', 'watch', 'feed', 'blog', 'supplement', 'substack']);
export const isModelShareableCard = card => shareableKinds.has(card.kind) || card.modelShareable === true;

function fetchedArticleIsFullText(fetchedArticle) {
  if (!fetchedArticle?.modelShareable || fetchedArticle.paywalled || isAbstractLandingUrl(fetchedArticle.url)) return false;
  if (fetchedArticle.contentStatus) return fetchedArticle.contentStatus === 'full_text';
  return !isAbstractLandingUrl(fetchedArticle.url) && (fetchedArticle.charCount ?? 0) >= 800;
}

export function modelTopic(topic) {
  const cards = (topic.cards ?? []).filter(isModelShareableCard);
  if (!cards.length) return null;
  const urls = [...new Set([
    ...cards.flatMap(card => [card.url, ...(card.outboundUrls ?? [])]),
    ...(topic.fetchedArticle?.modelShareable ? [topic.fetchedArticle.url, ...(topic.fetchedArticle.outboundLinks ?? []).map(link => link.href)] : []),
  ].filter(Boolean))];
  const primaryUrl = urls.includes(topic.primaryUrl) ? topic.primaryUrl : cards[0].url;
  const { fetchedArticle, ...rest } = topic;
  const hasFullText = cards.some(card => card.contentStatus === 'full_text' && !isAbstractLandingUrl(card.url)) || fetchedArticleIsFullText(fetchedArticle);
  return {
    ...rest, cards, title: cards[0].title || cards[0].tldr, entities: [], primaryUrl,
    sources: [...new Set(cards.map(card => card.sourceLabel))],
    allObservedUrls: urls,
    discussionUrls: cards.filter(card => ['x', 'watch'].includes(card.kind)).map(card => card.url),
    contentStatus: hasFullText ? 'full_text' : (cards.some(card => card.contentStatus === 'abstract_only') ? 'abstract_only' : 'snippet_only'),
    ...(fetchedArticle?.modelShareable ? { fetchedArticle: {
      ...fetchedArticle,
      ...(isAbstractLandingUrl(fetchedArticle.url) ? { contentStatus: 'abstract_only' } : {}),
    } } : {}),
  };
}
