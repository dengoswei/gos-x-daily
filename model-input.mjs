// Browser-only subscription, mail and Xiaohongshu bodies remain in the local store.
// Public originals discovered through them enter separately as public supplements.
const shareableKinds = new Set(['x', 'watch', 'feed', 'blog', 'supplement']);
export const isModelShareableCard = card => shareableKinds.has(card.kind) || card.modelShareable === true;

export function modelTopic(topic) {
  const cards = (topic.cards ?? []).filter(isModelShareableCard);
  if (!cards.length) return null;
  const urls = [...new Set([
    ...cards.flatMap(card => [card.url, ...(card.outboundUrls ?? [])]),
    ...(topic.fetchedArticle?.modelShareable ? [topic.fetchedArticle.url, ...(topic.fetchedArticle.outboundLinks ?? []).map(link => link.href)] : []),
  ].filter(Boolean))];
  const primaryUrl = urls.includes(topic.primaryUrl) ? topic.primaryUrl : cards[0].url;
  const { fetchedArticle, ...rest } = topic;
  return {
    ...rest, cards, title: cards[0].title || cards[0].tldr, entities: [], primaryUrl,
    sources: [...new Set(cards.map(card => card.sourceLabel))],
    allObservedUrls: urls,
    discussionUrls: cards.filter(card => ['x', 'watch'].includes(card.kind)).map(card => card.url),
    contentStatus: cards.some(card => card.contentStatus === 'full_text') ? 'full_text' : 'snippet_only',
    ...(fetchedArticle?.modelShareable ? { fetchedArticle, contentStatus: 'full_text' } : {}),
  };
}
