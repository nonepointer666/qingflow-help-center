export const OUTLINE_PAGE_TYPES = Object.freeze([
  'content',
  'directory',
  'hybrid',
  'empty',
]);

export function isSearchableDocument(attributes = {}) {
  if (attributes.source !== 'outline') return true;
  const pageType = String(attributes.page_type ?? 'content');
  return pageType !== 'empty';
}
