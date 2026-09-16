import {compile} from '@mdx-js/mdx';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {OUTLINE_PAGE_TYPES} from './document-page-type.mjs';

export const DEFAULT_OUTLINE_URL = 'https://outline.qingflow.com';
export const DEFAULT_OUTLINE_COLLECTION = '售后知识库(公开)';

const routePattern = /^\/[a-z0-9][a-z0-9/-]*$/;
const outlineDocumentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const retryableStatuses = new Set([408, 429]);
const unsafeElementNames = new Set([
  'base',
  'button',
  'embed',
  'form',
  'input',
  'link',
  'meta',
  'object',
  'option',
  'script',
  'select',
  'style',
  'textarea',
]);
const labelAliases = new Map([
  ['常见问题(faq)', '常见问题-faq'],
  ['常见问题（faq）', '常见问题-faq'],
  ['faq', '常见问题-faq'],
]);
const proxyEnvironmentVariables = [
  'ALL_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'all_proxy',
  'http_proxy',
  'https_proxy',
];

export function disableProxyForOutline(environment = process.env) {
  for (const name of proxyEnvironmentVariables) delete environment[name];
  environment.NODE_USE_ENV_PROXY = '0';
  environment.NO_PROXY = '*';
  environment.no_proxy = '*';
}

function assertObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
  return value;
}

function sanitizeErrorMessage(error, token) {
  const message = error instanceof Error ? error.message : String(error);
  return token ? message.replaceAll(token, '[REDACTED]') : message;
}

export function normalizeOutlineUrl(value = DEFAULT_OUTLINE_URL) {
  let parsed;
  try {
    parsed = new URL(String(value).trim());
  } catch {
    throw new Error('OUTLINE_URL must be a valid absolute URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('OUTLINE_URL must use HTTP or HTTPS.');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

export function createOutlineClient({
  baseUrl = DEFAULT_OUTLINE_URL,
  token,
  fetchImpl = globalThis.fetch,
  maxAttempts = 3,
  timeoutMs = 30_000,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const normalizedBaseUrl = normalizeOutlineUrl(baseUrl);
  const normalizedToken = String(token ?? '').trim();
  if (!normalizedToken) throw new Error('OUTLINE_API_TOKEN is required.');
  if (typeof fetchImpl !== 'function') throw new Error('A Fetch API implementation is required.');

  return {
    baseUrl: normalizedBaseUrl,
    async post(endpoint, payload = {}) {
      if (!/^[a-z]+\.[a-z_]+$/i.test(endpoint)) {
        throw new Error(`Invalid Outline API endpoint: ${endpoint}`);
      }

      let lastError;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const response = await fetchImpl(`${normalizedBaseUrl}/api/${endpoint}`, {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${normalizedToken}`,
              'Content-Type': 'application/json',
              'User-Agent': 'Qingflow-Help-Center-Outline-Sync/1.0',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(timeoutMs),
          });

          if (!response.ok) {
            const error = new Error(`Outline API ${endpoint} returned HTTP ${response.status}.`);
            error.status = response.status;
            error.retryAfter = response.headers?.get?.('retry-after') ?? '';
            throw error;
          }

          const body = await response.text();
          try {
            return JSON.parse(body);
          } catch {
            throw new Error(`Outline API ${endpoint} returned invalid JSON.`);
          }
        } catch (error) {
          lastError = error;
          const status = Number(error?.status ?? 0);
          const networkError =
            error instanceof TypeError ||
            ['AbortError', 'TimeoutError'].includes(error?.name);
          const retryable =
            networkError || retryableStatuses.has(status) || (status >= 500 && status <= 599);
          if (!retryable || attempt === maxAttempts) break;
          const retryAfter = Number.parseInt(error?.retryAfter ?? '', 10);
          const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : attempt * 500;
          await sleep(delay);
        }
      }
      throw new Error(sanitizeErrorMessage(lastError, normalizedToken));
    },
  };
}

export async function fetchAllPages(client, endpoint, payload = {}, limit = 100) {
  const results = [];
  let offset = 0;
  while (true) {
    const response = await client.post(endpoint, {...payload, limit, offset});
    const data = response?.data;
    if (!Array.isArray(data)) {
      throw new Error(`Outline API ${endpoint} returned a non-array data field.`);
    }
    results.push(...data);
    if (data.length < limit) return results;
    offset += data.length;
    if (offset > 100_000) throw new Error(`Outline API ${endpoint} pagination exceeded its safety limit.`);
  }
}

export function flattenNavigationTree(nodes, parents = [], seen = new Set()) {
  if (!Array.isArray(nodes)) throw new Error('Outline document tree must be an array.');
  const flattened = [];
  for (const node of nodes) {
    assertObject(node, 'Outline navigation contains an invalid node.');
    const id = String(node.id ?? '').trim();
    const title = String(node.title ?? '').trim();
    if (!id || !title) throw new Error('Every Outline navigation node must have an id and title.');
    if (!outlineDocumentIdPattern.test(id)) {
      throw new Error(`Outline navigation contains an invalid document UUID: ${id}`);
    }
    if (seen.has(id)) throw new Error(`Duplicate Outline document id in navigation: ${id}`);
    seen.add(id);
    const children = node.children ?? [];
    if (!Array.isArray(children)) throw new Error(`Outline document ${id} has invalid children.`);
    flattened.push({...node, id, title, parents: [...parents]});
    flattened.push(...flattenNavigationTree(children, [...parents, title], seen));
  }
  return flattened;
}

export async function fetchOutlineSnapshot(client, collectionName) {
  const collections = await fetchAllPages(client, 'collections.list');
  const matches = collections.filter((collection) => collection?.name === collectionName);
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `Outline collection not found: ${collectionName}`
        : `Multiple Outline collections are named: ${collectionName}`,
    );
  }

  const collection = matches[0];
  const treeResponse = await client.post('collections.documents', {id: collection.id});
  if (!Array.isArray(treeResponse?.data) || treeResponse.data.length === 0) {
    throw new Error(`Outline collection is empty: ${collectionName}`);
  }
  const [possibleWrapper] = treeResponse.data;
  const wrapperTitle = normalizeLabel(possibleWrapper?.title);
  const removedWrapper =
    treeResponse.data.length === 1 &&
    Array.isArray(possibleWrapper?.children) &&
    possibleWrapper.children.length > 0 &&
    (wrapperTitle === normalizeLabel(collectionName) ||
      String(possibleWrapper.title ?? '').trim().startsWith('📖'));
  const tree = removedWrapper ? possibleWrapper.children : treeResponse.data;
  const navigation = flattenNavigationTree(tree);
  const listedDocuments = await fetchAllPages(client, 'documents.list', {
    collectionId: collection.id,
    sort: 'createdAt',
    direction: 'ASC',
  });
  const documentsById = new Map();
  for (const document of listedDocuments) {
    const id = String(document?.id ?? '').trim();
    if (!id) throw new Error('Outline documents.list returned a document without an id.');
    if (documentsById.has(id)) throw new Error(`Duplicate Outline document from documents.list: ${id}`);
    if (document.collectionId && document.collectionId !== collection.id) {
      throw new Error(`Outline document ${id} belongs to an unexpected collection.`);
    }
    documentsById.set(id, document);
  }
  const expectedIds = new Set(navigation.map(({id}) => id));
  const allowedWrapperId = removedWrapper ? String(possibleWrapper.id ?? '') : '';
  const unexpectedIds = [...documentsById.keys()].filter(
    (id) => !expectedIds.has(id) && id !== allowedWrapperId,
  );
  if (unexpectedIds.length > 0) {
    throw new Error(
      `Outline documents.list returned documents outside the navigation tree: ${unexpectedIds.join(', ')}`,
    );
  }

  const documents = await mapConcurrent(navigation, async (navigationNode) => {
    let document = documentsById.get(navigationNode.id);
    if (!document || typeof document.text !== 'string') {
      const info = await client.post('documents.info', {id: navigationNode.id});
      document = info?.data;
    }
    if (!document || typeof document.text !== 'string') {
      throw new Error(`Outline document body is missing: ${navigationNode.id}`);
    }
    if (String(document.id ?? '') !== navigationNode.id) {
      throw new Error(`Outline documents.info returned the wrong document: ${navigationNode.id}`);
    }
    const documentTitle = String(document.title ?? '').trim();
    if (documentTitle && documentTitle !== navigationNode.title) {
      throw new Error(
        `Outline document title changed during sync: ${navigationNode.id}`,
      );
    }
    return {
      ...document,
      id: navigationNode.id,
      title: navigationNode.title,
      url: document.url ?? navigationNode.url ?? '',
      parents: navigationNode.parents,
    };
  });

  const attachments = await fetchOutlineAttachmentMetadata(client, documents, client.baseUrl);
  return {collection, tree, documents, attachments};
}

function attachmentIdFromUrl(value, baseUrl) {
  if (!value || isSkippedUrl(value)) return '';
  let parsed;
  try {
    parsed = new URL(value, `${baseUrl}/`);
  } catch {
    return '';
  }
  if (
    parsed.origin !== new URL(baseUrl).origin ||
    parsed.pathname.toLowerCase() !== '/api/attachments.redirect'
  ) {
    return '';
  }
  return String(parsed.searchParams.get('id') ?? '').trim();
}

export function collectOutlineAttachmentIds(markdown, baseUrl) {
  const normalizedBaseUrl = normalizeOutlineUrl(baseUrl);
  const ids = new Set();
  const source = String(markdown).replace(/(?:```|~~~)[\s\S]*?(?:```|~~~)/g, '');
  for (const match of source.matchAll(
    /(!?)\[[^\]\n]*\]\(\s*<?([^\s)>]+)>?/g,
  )) {
    if (match[1]) continue;
    const id = attachmentIdFromUrl(
      match[2].replace(/[.,;:]+$/, ''),
      normalizedBaseUrl,
    );
    if (id) ids.add(id);
  }
  return [...ids];
}

export async function fetchOutlineAttachmentMetadata(client, documents, baseUrl) {
  const normalizedBaseUrl = normalizeOutlineUrl(baseUrl);
  const candidates = documents
    .map((document) => ({
      documentId: document.id,
      ids: collectOutlineAttachmentIds(document.text, normalizedBaseUrl),
    }))
    .filter(({ids}) => ids.length > 0);
  if (candidates.length === 0) return new Map();

  const metadata = new Map();
  const entries = await mapConcurrent(candidates, async ({documentId, ids}) => {
    const requestedIds = new Set(ids);
    const attachments = await fetchAllPages(
      client,
      'attachments.list',
      {documentId},
    );
    const matches = [];
    for (const attachment of attachments) {
      assertObject(
        attachment,
        `Outline attachments.list returned invalid metadata for document ${documentId}.`,
      );
      const id = String(attachment.id ?? '').trim();
      if (!id || !requestedIds.has(id)) continue;
      const ownerId = String(attachment.documentId ?? '').trim();
      if (ownerId && ownerId !== documentId) {
        throw new Error(`Outline attachment ${id} belongs to an unexpected document.`);
      }
      const contentType = String(
        attachment.contentType ?? attachment.mimeType ?? attachment.type ?? '',
      )
        .trim()
        .toLowerCase();
      matches.push([id, {id, contentType}]);
    }
    return matches;
  });
  for (const [id, attachment] of entries.flat()) {
    if (metadata.has(id)) throw new Error(`Duplicate Outline attachment metadata: ${id}`);
    metadata.set(id, attachment);
  }
  return metadata;
}

function parseYamlValue(rawValue) {
  const value = rawValue.trim();
  if (!value) return '';
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

export function parseFrontMatter(source) {
  const normalized = String(source).replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) return {attributes: {}, body: normalized};
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) return {attributes: {}, body: normalized};
  const attributes = {};
  const lines = normalized.slice(4, end).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    if (!match[2].trim()) {
      const values = [];
      while (index + 1 < lines.length && /^\s+-\s+/.test(lines[index + 1])) {
        index += 1;
        values.push(parseYamlValue(lines[index].replace(/^\s+-\s+/, '')));
      }
      attributes[match[1]] = values;
    } else {
      attributes[match[1]] = parseYamlValue(match[2]);
    }
  }
  return {attributes, body: normalized.slice(end + 5).trim()};
}

async function getMarkdownFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, {withFileTypes: true});
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return getMarkdownFiles(filePath);
      return entry.isFile() && /\.mdx?$/i.test(entry.name) ? [filePath] : [];
    }),
  );
  return nested.flat().sort();
}

function normalizeLabel(value) {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, '')
    .replace(/\s*[（(]公开[）)]\s*$/u, '')
    .trim()
    .toLowerCase();
  return labelAliases.get(normalized) ?? normalized;
}

function routeKey(parts) {
  return parts.map(normalizeLabel).filter(Boolean).join('\u001f');
}

function parseSidebarSource(source) {
  const match = String(source).match(/const sidebars[^=]*=\s*([\s\S]*);\s*export default/);
  if (!match) throw new Error('Unable to parse the legacy sidebars.ts file.');
  try {
    return JSON.parse(match[1]);
  } catch {
    throw new Error('Legacy sidebars.ts must contain a JSON-serializable sidebar object.');
  }
}

export async function readLegacyRoutes({docsRoot, sidebarFile}) {
  const documentsBySidebarId = new Map();
  for (const filePath of await getMarkdownFiles(docsRoot)) {
    const source = await readFile(filePath, 'utf8');
    const {attributes, body} = parseFrontMatter(source);
    const relative = path.relative(docsRoot, filePath).replaceAll(path.sep, '/');
    const sidebarId = `migrated/${relative.replace(/\.mdx?$/i, '')}`;
    const title = String(attributes.title ?? '').trim();
    const slug = String(attributes.slug ?? '').trim();
    if (!title || !routePattern.test(slug)) {
      throw new Error(`Legacy document has invalid title or slug: ${relative}`);
    }
    documentsBySidebarId.set(sidebarId, {title, slug, body, attributes, relative});
  }

  const sidebar = parseSidebarSource(await readFile(sidebarFile, 'utf8'));
  const roots = sidebar.helpCenterSidebar;
  if (!Array.isArray(roots)) throw new Error('Legacy sidebar is missing helpCenterSidebar.');
  const pathsById = new Map();

  function visit(items, parents = []) {
    for (const item of items) {
      if (typeof item === 'string') {
        const document = documentsBySidebarId.get(item);
        if (!document) throw new Error(`Legacy sidebar references an unknown document: ${item}`);
        pathsById.set(item, [...parents, document.title]);
        continue;
      }
      assertObject(item, 'Legacy sidebar contains an invalid item.');
      const label = String(item.label ?? '').trim();
      const nextParents = label ? [...parents, label] : parents;
      if (item.link?.type === 'doc') pathsById.set(item.link.id, nextParents);
      if (Array.isArray(item.items)) visit(item.items, nextParents);
    }
  }
  visit(roots);

  const routes = [];
  for (const [sidebarId, document] of documentsBySidebarId) {
    const fallback = Array.isArray(document.attributes.keywords)
      ? document.attributes.keywords
      : [document.title];
    const breadcrumb = pathsById.get(sidebarId) ?? fallback;
    routes.push({...document, breadcrumb, key: routeKey(breadcrumb)});
  }
  return routes;
}

export async function readRouteMap(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return validateRouteMap(parsed);
  } catch (error) {
    if (error.code === 'ENOENT') return {version: 2, legacyRoutes: []};
    throw error;
  }
}

function normalizeOutlineUrlId(value) {
  const routeId = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return routeId;
}

export function outlineCanonicalRoute(urlId) {
  const routeId = normalizeOutlineUrlId(urlId);
  if (!routeId) throw new Error('Outline document has no usable urlId.');
  return `/outline/${routeId}`;
}

export function validateRouteMap(value) {
  if (value?.version !== 2 || !Array.isArray(value.legacyRoutes)) {
    throw new Error('Outline route map must use version 2 and contain a legacyRoutes array.');
  }

  const sources = new Set();
  const normalized = value.legacyRoutes.map((entry, index) => {
    assertObject(entry, `Outline legacy route ${index + 1} is invalid.`);
    const from = String(entry.from ?? '').trim();
    const status = String(entry.status ?? '').trim();
    if (!routePattern.test(from)) throw new Error(`Invalid legacy route source: ${from}`);
    if (sources.has(from)) throw new Error(`Duplicate legacy route source: ${from}`);
    sources.add(from);
    if (!['active', 'redirect', 'deleted'].includes(status)) {
      throw new Error(`Invalid legacy route status for ${from}: ${status}`);
    }
    if (status === 'active') {
      const outlineUrlId = String(entry.outlineUrlId ?? '').trim();
      if (!normalizeOutlineUrlId(outlineUrlId)) {
        throw new Error(`Active legacy route has no usable outlineUrlId: ${from}`);
      }
      return {...entry, from, status, outlineUrlId};
    }
    if (status === 'redirect') {
      const to = String(entry.to ?? '').trim();
      if (!routePattern.test(to) || to === from) {
        throw new Error(`Invalid legacy redirect target for ${from}: ${to}`);
      }
      return {...entry, from, status, to};
    }
    const removedAt = String(entry.removedAt ?? '').trim();
    if (!removedAt || Number.isNaN(Date.parse(removedAt))) {
      throw new Error(`Deleted legacy route has an invalid removedAt value: ${from}`);
    }
    return {...entry, from, status, removedAt};
  });

  const redirects = new Map(
    normalized
      .filter((entry) => entry.status === 'redirect')
      .map((entry) => [entry.from, entry.to]),
  );
  for (const source of redirects.keys()) {
    const visited = new Set([source]);
    let target = redirects.get(source);
    while (redirects.has(target)) {
      if (visited.has(target)) throw new Error(`Legacy redirect cycle detected at ${target}`);
      visited.add(target);
      target = redirects.get(target);
    }
  }

  return {...value, legacyRoutes: normalized};
}

export function assignDocumentRoutes(documents, _legacyRoutes = [], routeMap = {version: 2, legacyRoutes: []}) {
  const validatedRouteMap = validateRouteMap(routeMap);
  const conflicts = [];
  const assignedSlugs = new Map();
  const assigned = documents.map((document) => {
    let slug;
    try {
      slug = outlineCanonicalRoute(document.urlId);
    } catch {
      conflicts.push({
        type: 'invalid-url-id',
        outlineId: document.id,
        title: document.title,
        urlId: document.urlId,
      });
    }
    if (slug) {
      const assignedOwner = assignedSlugs.get(slug);
      if (assignedOwner && assignedOwner !== document.id) {
        conflicts.push({
          type: 'duplicate-url-id',
          outlineId: document.id,
          title: document.title,
          candidates: [{outlineId: assignedOwner, slug}],
        });
      }
      assignedSlugs.set(slug, document.id);
    }
    return {...document, slug, routeSource: 'outline-url-id'};
  });

  const currentRoutes = new Set(assigned.map((document) => document.slug).filter(Boolean));
  for (const entry of validatedRouteMap.legacyRoutes) {
    if (entry.status !== 'active') continue;
    const target = outlineCanonicalRoute(entry.outlineUrlId);
    if (!currentRoutes.has(target)) {
      conflicts.push({
        type: 'missing-active-legacy-target',
        from: entry.from,
        outlineUrlId: entry.outlineUrlId,
      });
    }
  }

  return {documents: assigned, conflicts};
}

function absoluteOutlineUrl(value, baseUrl) {
  try {
    return new URL(value, `${baseUrl}/`).toString();
  } catch {
    return value;
  }
}

function documentPathKey(value, baseUrl) {
  try {
    const url = new URL(value, `${baseUrl}/`);
    if (url.origin !== new URL(baseUrl).origin) return '';
    return url.pathname.replace(/\/$/, '');
  } catch {
    return '';
  }
}

function buildDocumentLinkMap(documents, baseUrl) {
  const links = new Map();
  for (const document of documents) {
    const paths = [document.url, `/doc/${document.id}`, `/doc/${document.urlId ?? ''}`];
    for (const value of paths) {
      const key = documentPathKey(value, baseUrl);
      if (key) links.set(key, `/docs${document.slug}`);
    }
  }
  return links;
}

function isSkippedUrl(value) {
  return /^(?:#|data:|javascript:|mailto:|tel:)/i.test(value);
}

function rewriteReference(value, {baseUrl, documentLinks, media}) {
  if (!value || isSkippedUrl(value)) return value;
  let resolved;
  try {
    resolved = new URL(value, `${baseUrl}/`);
  } catch {
    return value;
  }
  const localDocumentRoute = documentLinks.get(resolved.pathname.replace(/\/$/, ''));
  if (localDocumentRoute) return `${localDocumentRoute}${resolved.search}${resolved.hash}`;
  const isOutlineAttachment =
    resolved.origin === new URL(baseUrl).origin &&
    /^\/api\/(?:attachments|files)(?:\.|\/)/i.test(resolved.pathname);
  if (media || isOutlineAttachment) return resolved.toString();
  // Docusaurus treats protocol-relative links as local routes. Outline content
  // can contain these links, so make their external protocol explicit.
  if (String(value).startsWith('//')) return resolved.toString();
  return value;
}

function rewriteSrcSet(value, context) {
  return value
    .split(',')
    .map((candidate) => {
      const match = candidate.trim().match(/^(\S+)(\s+.+)?$/);
      if (!match) return candidate;
      return `${rewriteReference(match[1], {...context, media: true})}${match[2] ?? ''}`;
    })
    .join(', ');
}

function attachmentMetadataFor(metadata, id) {
  if (!metadata || !id) return undefined;
  if (metadata instanceof Map) return metadata.get(id);
  return metadata[id];
}

function escapeHtmlText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function rewriteVideoAttachmentLinks(value, {baseUrl, attachmentMetadata}) {
  if (!attachmentMetadata || (attachmentMetadata instanceof Map && attachmentMetadata.size === 0)) {
    return value;
  }
  return value.replace(
    /(!?)\[([^\]\n]*)\]\(\s*<?([^\s)>]+)>?((?:\s+["'][^"']*["'])?\s*\))/g,
    (match, imageMarker, label, target) => {
      if (imageMarker) return match;
      const absoluteUrl = absoluteOutlineUrl(target, baseUrl);
      const id = attachmentIdFromUrl(absoluteUrl, baseUrl);
      const contentType = String(
        attachmentMetadataFor(attachmentMetadata, id)?.contentType ?? '',
      ).toLowerCase();
      if (!id || !contentType.startsWith('video/')) return match;
      const safeUrl = escapeHtmlText(absoluteUrl);
      const safeLabel = escapeHtmlText(label.trim() || '视频');
      return `<video controls playsInline preload="metadata" src="${safeUrl}" aria-label="${safeLabel}"><a href="${safeUrl}">${safeLabel}</a></video>`;
    },
  );
}

function isMalformedWebUrl(value) {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    return !new URL(value).hostname;
  } catch {
    return true;
  }
}

function isInvalidMarkdownLinkTarget(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  // Outline's rich-text conversion can turn an email domain into a local path
  // such as `/example.com`. It cannot resolve inside this site, so retain the
  // label instead of emitting a broken Docusaurus route.
  const malformedLocalDomain = /^\/(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/|$)/i.test(normalized);
  return (
    !normalized ||
    normalized === 'undefined' ||
    normalized === 'null' ||
    malformedLocalDomain ||
    isMalformedWebUrl(normalized)
  );
}

function removeInvalidMarkdownLinks(value) {
  return value.replace(
    /(!?)\[([^\]\n]*)\]\(\s*(?:<([^>\s]*)>|([^\s)]+))?\s*(?:["'][^"']*["'])?\s*\)/g,
    (match, imageMarker, label, bracketedUrl, bareUrl) => {
      const url = bracketedUrl ?? bareUrl ?? '';
      if (!isInvalidMarkdownLinkTarget(url)) return match;
      return label;
    },
  );
}

function escapeInlineJsonObjects(value) {
  let output = '';
  let cursor = 0;
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"' && depth > 0) {
      inString = true;
      continue;
    }
    if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character !== '}' || depth === 0) continue;
    depth -= 1;
    if (depth !== 0) continue;

    const candidate = value.slice(start, index + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    } catch {
      continue;
    }
    output += value.slice(cursor, start);
    output += candidate.replaceAll('{', '&#123;').replaceAll('}', '&#125;');
    cursor = index + 1;
  }
  return cursor === 0 ? value : `${output}${value.slice(cursor)}`;
}

function escapeMdxTextBraces(value) {
  let output = '';
  let cursor = 0;
  const delimiterPattern = /`+/g;
  let opening;

  while ((opening = delimiterPattern.exec(value))) {
    const delimiter = opening[0];
    const closingIndex = value.indexOf(delimiter, opening.index + delimiter.length);
    if (closingIndex === -1) break;
    output += value
      .slice(cursor, opening.index)
      .replaceAll('{', '&#123;')
      .replaceAll('}', '&#125;');
    const closingEnd = closingIndex + delimiter.length;
    output += value.slice(opening.index, closingEnd);
    cursor = closingEnd;
    delimiterPattern.lastIndex = closingEnd;
  }

  return `${output}${value
    .slice(cursor)
    .replaceAll('{', '&#123;')
    .replaceAll('}', '&#125;')}`;
}

function escapeHtmlInQuotedValues(value) {
  const marker = value.match(/:\s*["']/);
  if (!marker) return value;
  const start = marker.index + marker[0].length;
  if (!/[<][/?A-Za-z]/.test(value.slice(start))) return value;
  return `${value.slice(0, start)}${value
    .slice(start)
    .replace(/<\/?[A-Za-z][^>]*>/g, (tag) =>
      tag.replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    )}`;
}

export function rewriteMarkdownUrls(markdown, documents, baseUrl, attachmentMetadata = new Map()) {
  const normalizedBaseUrl = normalizeOutlineUrl(baseUrl);
  const documentLinks = buildDocumentLinkMap(documents, normalizedBaseUrl);
  let codeFence;
  const lines = String(markdown)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .split('\n')
    .map((line) => {
      const unquotedLine = line.replace(/^(?: {0,3}> ?)+/, '');
      const fenceMatch = unquotedLine.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (
        fenceMatch &&
        (!codeFence ||
          (fenceMatch[1][0] === codeFence.marker &&
            fenceMatch[1].length >= codeFence.length &&
            /^\s*$/.test(fenceMatch[2])))
      ) {
        codeFence = codeFence
          ? undefined
          : {marker: fenceMatch[1][0], length: fenceMatch[1].length};
        return line;
      }
      if (codeFence) return line;

      let output = line.replace(/<(https?:\/\/[^>\s]+)>/gi, (match, url) =>
        `[${url}](${rewriteReference(url, {
          baseUrl: normalizedBaseUrl,
          documentLinks,
          media: false,
        })})`,
      );
      output = output.replace(
        /(!?\[[^\]\n]*\]\()<?([^\s)>]+)>?((?:\s+["'][^"']*["'])?\))/g,
        (match, prefix, url, suffix) => {
          const media = prefix.startsWith('!');
          return `${prefix}${rewriteReference(url, {
            baseUrl: normalizedBaseUrl,
            documentLinks,
            media,
          })}${suffix}`;
        },
      );
      output = output.replace(
        /(\b(?:src|href|poster)\s*=\s*["'])([^"']+)(["'])/gi,
        (match, prefix, url, suffix) => {
          const attribute = prefix.match(/\b(src|href|poster)/i)?.[1]?.toLowerCase();
          return `${prefix}${rewriteReference(url, {
            baseUrl: normalizedBaseUrl,
            documentLinks,
            media: attribute === 'src' || attribute === 'poster',
          })}${suffix}`;
        },
      );
      output = output.replace(
        /(\bsrcset\s*=\s*["'])([^"']+)(["'])/gi,
        (match, prefix, value, suffix) =>
          `${prefix}${rewriteSrcSet(value, {baseUrl: normalizedBaseUrl, documentLinks})}${suffix}`,
      );
      output = rewriteVideoAttachmentLinks(output, {
        baseUrl: normalizedBaseUrl,
        attachmentMetadata,
      });
      output = removeInvalidMarkdownLinks(output);
      const normalizedOutput = output
        .replace(/<@([A-Za-z0-9_-]+)>/g, '&lt;@$1&gt;')
        .replace(/<(?=\/?[A-Z][A-Za-z0-9_-]*(?:\s|\/?>))/g, '&lt;')
        .replace(/<(?=[^\sA-Za-z!/?])/gu, '&lt;')
        .replace(/<(?=\s*$)/u, '&lt;')
        .replace(/<(?==)/g, '&lt;')
        .replace(/<(?=[*_~\s]*(?:\d|\p{Script=Han}))/gu, '&lt;')
        .replace(
          /<(br|hr|img|source|track|wbr)\b([^>]*?)(?<!\/)\s*>/gi,
          '<$1$2 />',
        )
        .replace(/\s+style\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
        .replace(
          /\{\{([\p{Letter}\p{Number}\s_$-]+)\}\}/gu,
          '&#123;&#123;$1&#125;&#125;',
        )
        .replace(
          /\{([\p{Letter}\p{Number}\s_$-]*\p{Script=Han}[\p{Letter}\p{Number}\s_$-]*)\}/gu,
          '&#123;$1&#125;',
        )
        .replace(
          /(qf_output\s*=\s*)\{([A-Za-z_$][A-Za-z0-9_$]*)\}/gi,
          '$1&#123;$2&#125;',
        )
        .replace(/\{(\d+(?:,\d*)?)\}/g, '&#123;$1&#125;');
      const safeOutput = /^\s*\|.*\|\s*$/.test(normalizedOutput)
        ? normalizedOutput.replaceAll('{', '&#123;').replaceAll('}', '&#125;')
        : escapeInlineJsonObjects(normalizedOutput);
      return escapeMdxTextBraces(escapeHtmlInQuotedValues(safeOutput));
    });
  return lines.join('\n').trim();
}

export function findRelativeMediaReferences(markdown) {
  const references = [];
  const source = String(markdown).replace(/(?:```|~~~)[\s\S]*?(?:```|~~~)/g, '');
  for (const match of source.matchAll(/!\[[^\]\n]*\]\(<?([^\s)>]+)>?/g)) {
    if (/^(?:\/|\.\.?\/)/.test(match[1])) references.push(match[1]);
  }
  for (const match of source.matchAll(/\b(?:src|poster|srcset)\s*=\s*["']([^"']+)["']/gi)) {
    const values = match[1].split(',').map((item) => item.trim().split(/\s+/)[0]);
    references.push(...values.filter((value) => /^(?:\/|\.\.?\/)/.test(value)));
  }
  for (const match of source.matchAll(/\[[^\]\n]*\]\(<?([^\s)>]+)>?/g)) {
    if (/^\/api\/(?:attachments|files)(?:\.|\/)/i.test(match[1])) references.push(match[1]);
  }
  return [...new Set(references)];
}

function plainText(markdown) {
  return String(markdown)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~{}-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSiteRoute(value) {
  const route = String(value ?? '')
    .trim()
    .split(/[?#]/, 1)[0]
    .replace(/\/+$/, '');
  return route.startsWith('/') ? route.toLowerCase() : '';
}

function markdownLinkTargets(line) {
  return [...String(line).matchAll(/(?<!!)\[[^\]\n]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)]
    .map((match) => normalizeSiteRoute(match[1]))
    .filter(Boolean);
}

function stripNavigationOnlyContent(markdown, descendantRoutes) {
  const routes = new Set([...descendantRoutes].map(normalizeSiteRoute).filter(Boolean));
  if (routes.size === 0) return String(markdown).trim();

  let codeFence;
  const entries = String(markdown)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const fence = line.match(/^\s*(`{3,}|~{3,})/);
      if (fence) {
        codeFence = codeFence
          ? undefined
          : {marker: fence[1][0], length: fence[1].length};
        return {line, removedNavigation: false};
      }
      if (codeFence) return {line, removedNavigation: false};

      const targets = markdownLinkTargets(line);
      if (targets.length === 0 || targets.some((target) => !routes.has(target))) {
        return {line, removedNavigation: false};
      }
      const remainder = line
        .replace(/(?<!!)\[[^\]\n]*\]\(\s*<?[^\s)>]+>?(?:\s+["'][^"']*["'])?\s*\)/g, '')
        .replace(/^\s*(?:[-+*]|\d+[.)])\s*/, '')
        .replace(/[\s,，、;；:：。.!！?？()（）\[\]【】]+/g, '');
      if (remainder) return {line, removedNavigation: false};
      return {line: '', removedNavigation: true};
    });

  for (let index = 0; index < entries.length; index += 1) {
    const heading = entries[index].line.match(/^\s{0,3}(#{1,6})\s+/);
    if (!heading) continue;
    let removedNavigation = false;
    let hasContent = false;
    for (let cursor = index + 1; cursor < entries.length; cursor += 1) {
      const nextHeading = entries[cursor].line.match(/^\s{0,3}(#{1,6})\s+/);
      if (nextHeading && nextHeading[1].length <= heading[1].length) break;
      removedNavigation ||= entries[cursor].removedNavigation;
      hasContent ||= Boolean(entries[cursor].line.trim());
    }
    if (removedNavigation && !hasContent) entries[index].line = '';
  }

  return entries
    .map(({line}) => line)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function meaningfulTextLength(value) {
  return Array.from(String(value).matchAll(/[\p{Letter}\p{Number}]/gu)).length;
}

/**
 * Classify content independently from the Outline navigation tree. Links whose
 * only purpose is to point at descendants are removed before evaluating the
 * body, so a parent can be a directory even when Outline exports link bullets.
 */
export function classifyOutlineDocument(markdown, {hasChildren = false, descendantRoutes = []} = {}) {
  const contentMarkdown = stripNavigationOnlyContent(markdown, descendantRoutes);
  const codeBlocks = [...contentMarkdown.matchAll(/(?:```|~~~)[^\n]*\n([\s\S]*?)(?:```|~~~)/g)];
  const hasCodeBlock = codeBlocks.some((match) => meaningfulTextLength(match[1]) > 0);
  const withoutCode = contentMarkdown.replace(/(?:```|~~~)[\s\S]*?(?:```|~~~)/g, ' ');
  const contentLines = withoutCode
    .split('\n')
    .filter((line) => !/^\s{0,3}#{1,6}\s+/.test(line))
    .filter((line) => !/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line));
  const hasTable = contentLines.some((line, index) =>
    /\|/.test(line) && /^\s*\|?\s*:?-{3,}/.test(contentLines[index + 1] ?? ''),
  );
  const hasReferenceLink = /(?<!!)\[[^\]\n]+\]\(\s*<?[^\s)>]+>?/.test(withoutCode);
  const hasNonNavigationList = contentLines.some(
    (line) =>
      /^\s*(?:[-+*]|\d+[.)])\s+/.test(line) &&
      meaningfulTextLength(plainText(line)) > 0,
  );
  const evidence = contentLines
    .join('\n')
    .replace(/<video\b[\s\S]*?<\/video>/gi, ' ')
    .replace(/<(?:img|source|track)\b[^>]*\/?\s*>/gi, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  const effectiveText = plainText(evidence);
  const substantialLine = contentLines.some((line) => {
    const normalized = plainText(line.replace(/^\s*(?:[-+*]|\d+[.)])\s*/, ''));
    return meaningfulTextLength(normalized) >= 12;
  });
  const hasMeaningfulContent =
    meaningfulTextLength(effectiveText) >= 30 ||
    substantialLine ||
    hasCodeBlock ||
    hasTable ||
    hasReferenceLink ||
    hasNonNavigationList;
  const pageType = hasMeaningfulContent
    ? (hasChildren ? 'hybrid' : 'content')
    : (hasChildren ? 'directory' : 'empty');

  return {contentMarkdown, effectiveText, hasMeaningfulContent, pageType};
}

function replaceUnpairedSurrogates(value) {
  return String(value).replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD',
  );
}

function createDescription(markdown, maximumLength = 180) {
  const description = Array.from(replaceUnpairedSurrogates(plainText(markdown)))
    .slice(0, maximumLength)
    .join('')
    .trimEnd();
  // A Markdown escape at the truncation boundary would escape the quote in
  // Docusaurus' generated front matter module.
  return description.replace(/\\+$/, '');
}

function validateUrlProtocol(value, context) {
  const normalized = String(value ?? '').trim().replace(/[\u0000-\u0020]+/g, '');
  if (/^(?:javascript|vbscript):/i.test(normalized)) {
    throw new Error(`Unsafe URL protocol in ${context}.`);
  }
  if (/^data:text\/(?:html|javascript)/i.test(normalized)) {
    throw new Error(`Unsafe data URL in ${context}.`);
  }
}

function outlineMarkdownSafetyPlugin() {
  return (tree) => {
    function walk(node) {
      if (['mdxjsEsm', 'mdxFlowExpression', 'mdxTextExpression'].includes(node.type)) {
        const location = node.position?.start?.line
          ? ` at line ${node.position.start.line}`
          : '';
        throw new Error(`Executable MDX construct is not allowed: ${node.type}${location}`);
      }
      if (['link', 'image', 'definition'].includes(node.type)) {
        validateUrlProtocol(node.url, node.type);
      }
      if (['mdxJsxFlowElement', 'mdxJsxTextElement'].includes(node.type)) {
        const name = String(node.name ?? '');
        if (!name || name !== name.toLowerCase() || unsafeElementNames.has(name)) {
          throw new Error(`Unsafe MDX element is not allowed: ${name || 'fragment'}`);
        }
        for (const attribute of node.attributes ?? []) {
          if (attribute.type !== 'mdxJsxAttribute') {
            throw new Error(`Executable MDX attribute is not allowed on <${name}>.`);
          }
          const attributeName = String(attribute.name ?? '').toLowerCase();
          if (
            attributeName.startsWith('on') ||
            ['dangerouslysetinnerhtml', 'srcdoc', 'style'].includes(attributeName) ||
            (attribute.value !== null && typeof attribute.value === 'object')
          ) {
            throw new Error(`Unsafe MDX attribute is not allowed: ${attribute.name}`);
          }
          if (['href', 'src', 'poster', 'srcset'].includes(attributeName)) {
            validateUrlProtocol(attribute.value, `${name}.${attributeName}`);
          }
        }
      }
      for (const child of node.children ?? []) walk(child);
    }
    walk(tree);
  };
}

export async function validateOutlineMarkdown(markdown) {
  await compile(markdown, {
    format: 'mdx',
    remarkPlugins: [outlineMarkdownSafetyPlugin],
  });
}

export function serializeGeneratedDocument(document, markdown, baseUrl) {
  const sourceUrl = absoluteOutlineUrl(
    document.url || `/doc/${document.urlId ?? document.id}`,
    normalizeOutlineUrl(baseUrl),
  );
  const navigationPath = (document.parents ?? []).filter(Boolean);
  const pageType = document.pageType ?? 'content';
  const hasMeaningfulContent = document.hasMeaningfulContent ?? true;
  const childDocuments = document.outlineChildren ?? [];
  const description = createDescription(markdown) ||
    (pageType === 'directory'
      ? `本章节包含 ${childDocuments.length} 篇文档。`
      : '该文档暂无正文内容。');
  return [
    '---',
    `title: ${JSON.stringify(document.title)}`,
    `description: ${JSON.stringify(description)}`,
    `slug: ${JSON.stringify(document.slug)}`,
    'source: "outline"',
    `source_url: ${JSON.stringify(sourceUrl)}`,
    `source_updated_at: ${JSON.stringify(document.updatedAt ?? '')}`,
    `outline_id: ${JSON.stringify(document.id)}`,
    `outline_url_id: ${JSON.stringify(document.urlId)}`,
    `page_type: ${JSON.stringify(pageType)}`,
    `has_meaningful_content: ${hasMeaningfulContent}`,
    ...(childDocuments.length > 0
      ? [`outline_children: ${JSON.stringify(childDocuments)}`]
      : []),
    ...(navigationPath.length > 0
      ? [
          'navigation_path:',
          ...navigationPath.map((part) => `  - ${JSON.stringify(part)}`),
        ]
      : ['navigation_path: []']),
    '---',
    markdown,
    '',
  ].join('\n');
}

function generatedDocumentId(id) {
  return `generated/${String(id).toLowerCase()}`;
}

export function serializeGeneratedSidebar(tree) {
  function itemFor(node) {
    const id = generatedDocumentId(node.id);
    if (!node.children?.length) return id;
    return {
      type: 'category',
      label: node.title,
      link: {type: 'doc', id},
      items: node.children.map(itemFor),
    };
  }
  const sidebars = {helpCenterSidebar: tree.map(itemFor)};
  return [
    "import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';",
    '',
    `const sidebars: SidebarsConfig = ${JSON.stringify(sidebars, null, 2)};`,
    '',
    'export default sidebars;',
    '',
  ].join('\n');
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function replaceGeneratedOutput({
  cwd,
  stagedDocs,
  stagedSidebar,
  stagedReport,
  operations = {rename, rm},
}) {
  const targetDocs = path.join(cwd, 'docs', 'generated');
  const targetSidebar = path.join(cwd, 'sidebars.generated.ts');
  const targetReport = path.join(cwd, '.tmp', 'outline-sync-report.json');
  const backupRoot = path.join(cwd, '.tmp', `outline-backup-${Date.now()}-${process.pid}`);
  const backupDocs = path.join(backupRoot, 'generated');
  const backupSidebar = path.join(backupRoot, 'sidebars.generated.ts');
  const backupReport = path.join(backupRoot, 'outline-sync-report.json');
  let docsBackedUp = false;
  let sidebarBackedUp = false;
  let reportBackedUp = false;
  let docsInstalled = false;
  let sidebarInstalled = false;
  let reportInstalled = false;
  let removeBackup = false;
  await mkdir(backupRoot, {recursive: true});
  await mkdir(path.dirname(targetDocs), {recursive: true});
  try {
    if (await pathExists(targetDocs)) {
      await operations.rename(targetDocs, backupDocs);
      docsBackedUp = true;
    }
    if (await pathExists(targetSidebar)) {
      await operations.rename(targetSidebar, backupSidebar);
      sidebarBackedUp = true;
    }
    if (await pathExists(targetReport)) {
      await operations.rename(targetReport, backupReport);
      reportBackedUp = true;
    }
    await operations.rename(stagedDocs, targetDocs);
    docsInstalled = true;
    await operations.rename(stagedSidebar, targetSidebar);
    sidebarInstalled = true;
    await operations.rename(stagedReport, targetReport);
    reportInstalled = true;
    removeBackup = true;
  } catch (error) {
    try {
      if (reportInstalled) await operations.rm(targetReport, {force: true});
      if (sidebarInstalled) await operations.rm(targetSidebar, {force: true});
      if (docsInstalled) await operations.rm(targetDocs, {recursive: true, force: true});
      if (reportBackedUp) await operations.rename(backupReport, targetReport);
      if (sidebarBackedUp) await operations.rename(backupSidebar, targetSidebar);
      if (docsBackedUp) await operations.rename(backupDocs, targetDocs);
      removeBackup = true;
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Outline output rollback failed. Recovery files remain at ${backupRoot}.`,
      );
    }
    throw error;
  } finally {
    if (removeBackup) {
      try {
        await operations.rm(backupRoot, {recursive: true, force: true});
      } catch (error) {
        console.warn(`Unable to remove Outline backup directory ${backupRoot}: ${error.message}`);
      }
    }
  }
}

async function mapConcurrent(items, worker, concurrency = 8) {
  const results = [];
  for (let index = 0; index < items.length; index += concurrency) {
    results.push(...(await Promise.all(items.slice(index, index + concurrency).map(worker))));
  }
  return results;
}

function buildOutlineTreeMetadata(tree) {
  const metadata = new Map();
  function visit(node) {
    const children = Array.isArray(node.children) ? node.children : [];
    const descendantIds = children.flatMap((child) => visit(child));
    metadata.set(String(node.id), {
      childIds: children.map((child) => String(child.id)),
      descendantIds,
    });
    return [String(node.id), ...descendantIds];
  }
  for (const node of tree) visit(node);
  return metadata;
}

function documentSiteUrl(document) {
  return `/docs${document.slug}`.replace(/\/+$/, '');
}

export async function generateOutlineOutput({
  cwd,
  snapshot,
  assignedDocuments,
  baseUrl,
  writeFileImpl = writeFile,
}) {
  if (assignedDocuments.some((document) => !document.slug)) {
    throw new Error('Cannot generate Outline content while route conflicts remain.');
  }
  const invalidId = assignedDocuments.find(
    (document) => !outlineDocumentIdPattern.test(document.id),
  );
  if (invalidId) {
    throw new Error(`Cannot generate a file for invalid Outline document UUID: ${invalidId.id}`);
  }
  const stageRoot = path.join(cwd, '.tmp', `outline-sync-${Date.now()}-${process.pid}`);
  const stagedDocs = path.join(stageRoot, 'docs', 'generated');
  const stagedSidebar = path.join(stageRoot, 'sidebars.generated.ts');
  const stagedReport = path.join(stageRoot, 'outline-sync-report.json');
  await mkdir(stagedDocs, {recursive: true});
  try {
    const rewrittenDocuments = await mapConcurrent(assignedDocuments, async (document) => {
      const markdown = rewriteMarkdownUrls(
        document.text,
        assignedDocuments,
        baseUrl,
        snapshot.attachments,
      );
      const relativeMedia = findRelativeMediaReferences(markdown);
      if (relativeMedia.length > 0) {
        throw new Error(
          `Outline document ${document.id} contains relative media URLs: ${relativeMedia.join(', ')}`,
        );
      }
      try {
        await validateOutlineMarkdown(markdown);
      } catch (error) {
        throw new Error(
          `Outline document ${document.id} contains invalid MDX: ${error.message}`,
        );
      }
      return {document, markdown};
    });

    const documentsById = new Map(
      rewrittenDocuments.map(({document}) => [String(document.id), document]),
    );
    const treeMetadata = buildOutlineTreeMetadata(snapshot.tree);
    const classifications = new Map(
      rewrittenDocuments.map(({document, markdown}) => {
        const metadata = treeMetadata.get(String(document.id)) ?? {
          childIds: [],
          descendantIds: [],
        };
        const descendantRoutes = metadata.descendantIds
          .map((id) => documentsById.get(id))
          .filter(Boolean)
          .map(documentSiteUrl);
        return [
          String(document.id),
          classifyOutlineDocument(markdown, {
            hasChildren: metadata.childIds.length > 0,
            descendantRoutes,
          }),
        ];
      }),
    );
    const generatedDocuments = rewrittenDocuments.map(({document}) => {
      const metadata = treeMetadata.get(String(document.id)) ?? {childIds: []};
      const classification = classifications.get(String(document.id));
      const outlineChildren = metadata.childIds.map((id) => {
        const child = documentsById.get(id);
        const childMetadata = treeMetadata.get(id) ?? {childIds: []};
        const childClassification = classifications.get(id);
        if (!child || !childClassification) {
          throw new Error(`Outline navigation references an unknown child document: ${id}`);
        }
        const childDescription = createDescription(childClassification.contentMarkdown, 120) ||
          (childMetadata.childIds.length > 0
            ? `包含 ${childMetadata.childIds.length} 篇子文档。`
            : '暂无正文内容。');
        return {
          title: child.title,
          url: `${documentSiteUrl(child)}/`,
          description: childDescription,
          pageType: childClassification.pageType,
        };
      });
      return {
        ...document,
        ...classification,
        outlineChildren,
      };
    });
    const outputs = generatedDocuments.map((document) => ({
      id: document.id,
      output: serializeGeneratedDocument(document, document.contentMarkdown, baseUrl),
    }));

    for (const {id, output} of outputs) {
      await writeFileImpl(path.join(stagedDocs, `${String(id).toLowerCase()}.mdx`), output);
    }
    const report = {
      syncedAt: new Date().toISOString(),
      collection: snapshot.collection.name,
      collectionId: snapshot.collection.id,
      documents: assignedDocuments.length,
      routeSources: Object.fromEntries(
        ['outline-url-id'].map((source) => [
          source,
          assignedDocuments.filter((document) => document.routeSource === source).length,
        ]),
      ),
      pageTypes: Object.fromEntries(
        OUTLINE_PAGE_TYPES.map((pageType) => [
          pageType,
          generatedDocuments.filter((document) => document.pageType === pageType).length,
        ]),
      ),
      media: 'remote',
    };
    await writeFileImpl(stagedSidebar, serializeGeneratedSidebar(snapshot.tree));
    await writeFileImpl(
      stagedReport,
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await replaceGeneratedOutput({cwd, stagedDocs, stagedSidebar, stagedReport});
    return report;
  } catch (error) {
    await rm(stageRoot, {recursive: true, force: true});
    throw error;
  } finally {
    await rm(stageRoot, {recursive: true, force: true});
  }
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), {recursive: true});
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
