import {createHash} from 'node:crypto';

const safeDocumentIdPattern = /^[A-Za-z0-9_-]+$/;
const safeCollectionNamePattern = /^[A-Za-z0-9_-]+$/;
const deleteBatchSize = 100;
const managedSynonymPrefix = 'qingflow-';

export function buildCollectionSchema(collection) {
  return {
    name: collection,
    enable_nested_fields: false,
    fields: [
      {name: 'doc_id', type: 'string', facet: true},
      {name: 'record_type', type: 'string', facet: true},
      {name: 'title', type: 'string', locale: 'zh'},
      {name: 'document_title', type: 'string', optional: true, locale: 'zh'},
      {name: 'section', type: 'string', facet: true, locale: 'zh'},
      {name: 'breadcrumb', type: 'string', locale: 'zh'},
      {name: 'keywords', type: 'string[]', facet: true, optional: true, locale: 'zh'},
      {name: 'search_tokens', type: 'string[]', optional: true, locale: 'zh'},
      {name: 'content', type: 'string', locale: 'zh'},
      {name: 'url', type: 'string', facet: true},
      {name: 'product', type: 'string', facet: true},
      {name: 'business_priority', type: 'int32', optional: true},
      {name: 'version', type: 'string', facet: true},
      {name: 'language', type: 'string', facet: true},
      {name: 'tags', type: 'string[]', facet: true, optional: true, locale: 'zh'},
      {name: 'updated_at', type: 'string', optional: true},
      {name: 'updated_at_ts', type: 'int64'},
    ],
    default_sorting_field: 'updated_at_ts',
  };
}

function normalizeHost(host) {
  const normalized = String(host ?? '').trim().replace(/\/+$/, '');
  if (!normalized) throw new Error('TYPESENSE_HOST is required.');
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('TYPESENSE_HOST must be an absolute HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('TYPESENSE_HOST must be an absolute HTTP(S) URL.');
  }
  return normalized;
}

function normalizeCollectionName(value, label = 'Typesense collection') {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  if (!safeCollectionNamePattern.test(normalized)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
  return normalized;
}

function collectionUrl(host, collection, suffix = '') {
  return `${host}/collections/${encodeURIComponent(collection)}${suffix}`;
}

function requestHeaders(apiKey, contentType) {
  return {
    ...(contentType ? {'Content-Type': contentType} : {}),
    'X-TYPESENSE-API-KEY': apiKey,
  };
}

function synonymItemUrl(host, collection, id) {
  return collectionUrl(host, collection, `/synonyms/${encodeURIComponent(id)}`);
}

function aliasUrl(host, alias) {
  return `${host}/aliases/${encodeURIComponent(alias)}`;
}

function normalizeSynonymTerms(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((term) => String(term ?? '').trim()).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

export function buildTypesenseSynonyms(groups) {
  if (!Array.isArray(groups)) return [];
  const seen = new Set();
  return groups.flatMap((group) => {
    const synonyms = normalizeSynonymTerms(group?.terms ?? group?.synonyms);
    if (synonyms.length < 2) return [];
    const key = synonyms.map((term) => term.toLowerCase()).join('\u0000');
    if (seen.has(key)) return [];
    seen.add(key);
    const digest = createHash('sha256').update(key).digest('hex').slice(0, 16);
    return [{id: `${managedSynonymPrefix}${digest}`, synonyms}];
  });
}

async function responseDetails(response) {
  const details = (await response.text()).trim();
  return details ? ` ${details.slice(0, 500)}` : '';
}

function parseJsonLines(value, context) {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`${context} returned invalid JSON on line ${index + 1}.`);
    }
  });
}

export function validateSearchRecords(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('Search records artifact must be a non-empty JSON array.');
  }

  const ids = new Set();
  for (const record of records) {
    const id = record?.id;
    if (typeof id !== 'string' || !safeDocumentIdPattern.test(id)) {
      throw new Error(`Search record has an unsafe id: ${JSON.stringify(id)}.`);
    }
    if (ids.has(id)) throw new Error(`Search record id is duplicated: ${id}.`);
    ids.add(id);
  }
  return ids;
}

export async function ensureTypesenseCollection({
  host,
  apiKey,
  collection,
  fetchImpl = fetch,
  logger = console,
}) {
  const schema = buildCollectionSchema(collection);
  const response = await fetchImpl(collectionUrl(host, collection), {
    headers: requestHeaders(apiKey),
  });

  if (response.ok) {
    const existingSchema = await response.json();
    const existingFields = new Map(
      (existingSchema.fields ?? []).map((field) => [field.name, field]),
    );
    const missingFields = schema.fields.filter((field) => !existingFields.has(field.name));
    const localeChanges = schema.fields
      .filter((field) => existingFields.has(field.name) && field.locale)
      .filter((field) => existingFields.get(field.name)?.locale !== field.locale)
      .flatMap((field) => [{name: field.name, drop: true}, field]);
    const fields = [...missingFields, ...localeChanges];
    if (fields.length === 0) return;

    const alterResponse = await fetchImpl(collectionUrl(host, collection), {
      method: 'PATCH',
      headers: requestHeaders(apiKey, 'application/json'),
      body: JSON.stringify({fields}),
    });
    if (!alterResponse.ok) {
      throw new Error(
        `Failed to update collection schema: ${alterResponse.status}${await responseDetails(alterResponse)}`,
      );
    }
    logger.log(`Updated ${fields.length} Typesense schema fields in ${collection}`);
    return;
  }

  if (response.status !== 404) {
    throw new Error(
      `Failed to verify collection: ${response.status}${await responseDetails(response)}`,
    );
  }

  const createResponse = await fetchImpl(`${host}/collections`, {
    method: 'POST',
    headers: requestHeaders(apiKey, 'application/json'),
    body: JSON.stringify(schema),
  });
  if (!createResponse.ok) {
    throw new Error(
      `Failed to create collection: ${createResponse.status}${await responseDetails(createResponse)}`,
    );
  }
}

export async function ensureTypesenseSynonyms({
  host,
  apiKey,
  collection,
  synonymGroups,
  fetchImpl = fetch,
  logger = console,
}) {
  const desired = buildTypesenseSynonyms(synonymGroups);
  const listResponse = await fetchImpl(collectionUrl(host, collection, '/synonyms'), {
    headers: requestHeaders(apiKey),
  });
  if (!listResponse.ok && listResponse.status !== 404) {
    throw new Error(
      `Failed to retrieve Typesense synonyms: ${listResponse.status}${await responseDetails(listResponse)}`,
    );
  }

  const listed = listResponse.status === 404 ? {synonyms: []} : await listResponse.json();
  const existing = Array.isArray(listed?.synonyms)
    ? listed.synonyms.filter((item) => typeof item?.id === 'string')
    : [];
  const existingTerms = new Map(
    existing.map((item) => [item.id, normalizeSynonymTerms(item.synonyms)]),
  );

  let upserted = 0;
  for (const item of desired) {
    const current = existingTerms.get(item.id);
    if (current && JSON.stringify(current) === JSON.stringify(item.synonyms)) continue;
    const response = await fetchImpl(synonymItemUrl(host, collection, item.id), {
      method: 'PUT',
      headers: requestHeaders(apiKey, 'application/json'),
      body: JSON.stringify({synonyms: item.synonyms}),
    });
    if (!response.ok) {
      throw new Error(
        `Failed to upsert Typesense synonym ${item.id}: ${response.status}${await responseDetails(response)}`,
      );
    }
    upserted += 1;
  }

  const desiredIds = new Set(desired.map((item) => item.id));
  const stale = existing.filter(
    (item) => item.id.startsWith(managedSynonymPrefix) && !desiredIds.has(item.id),
  );
  for (const item of stale) {
    const response = await fetchImpl(synonymItemUrl(host, collection, item.id), {
      method: 'DELETE',
      headers: requestHeaders(apiKey),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `Failed to delete Typesense synonym ${item.id}: ${response.status}${await responseDetails(response)}`,
      );
    }
  }

  if (upserted > 0 || stale.length > 0) {
    logger.log(`Synchronized ${desired.length} Typesense synonyms in ${collection}`);
  }
  return {synchronized: desired.length, upserted, deleted: stale.length};
}

export async function importTypesenseDocuments({
  host,
  apiKey,
  collection,
  records,
  fetchImpl = fetch,
  logger = console,
}) {
  const payload = records.map((record) => JSON.stringify(record)).join('\n');
  const response = await fetchImpl(
    collectionUrl(host, collection, '/documents/import?action=upsert'),
    {
      method: 'POST',
      headers: requestHeaders(apiKey, 'text/plain'),
      body: payload,
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to import documents: ${response.status}${await responseDetails(response)}`,
    );
  }

  const results = parseJsonLines(await response.text(), 'Typesense import');
  if (results.length !== records.length) {
    throw new Error(
      `Typesense import returned ${results.length} results for ${records.length} records.`,
    );
  }
  const failedIndex = results.findIndex((result) => result?.success !== true);
  if (failedIndex !== -1) {
    const reason = String(results[failedIndex]?.error ?? 'unknown error').slice(0, 300);
    throw new Error(`Typesense rejected search record ${failedIndex + 1}: ${reason}`);
  }
  logger.log(`Imported ${records.length} records into ${collection}`);
}

export async function exportTypesenseDocumentIds({
  host,
  apiKey,
  collection,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(
    collectionUrl(host, collection, '/documents/export?include_fields=id'),
    {headers: requestHeaders(apiKey)},
  );
  if (!response.ok) {
    throw new Error(
      `Failed to export document ids: ${response.status}${await responseDetails(response)}`,
    );
  }

  const documents = parseJsonLines(await response.text(), 'Typesense export');
  return documents.map((document) => {
    const id = document?.id;
    if (typeof id !== 'string' || !safeDocumentIdPattern.test(id)) {
      throw new Error(`Typesense contains an unsafe document id: ${JSON.stringify(id)}.`);
    }
    return id;
  });
}

export async function deleteTypesenseDocuments({
  host,
  apiKey,
  collection,
  ids,
  fetchImpl = fetch,
  logger = console,
}) {
  for (let offset = 0; offset < ids.length; offset += deleteBatchSize) {
    const batch = ids.slice(offset, offset + deleteBatchSize);
    const params = new URLSearchParams({
      filter_by: `id:=[${batch.join(',')}]`,
      batch_size: String(batch.length),
    });
    const response = await fetchImpl(
      collectionUrl(host, collection, `/documents?${params}`),
      {
        method: 'DELETE',
        headers: requestHeaders(apiKey),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Failed to delete stale documents: ${response.status}${await responseDetails(response)}`,
      );
    }
    const result = await response.json();
    if (result?.num_deleted !== batch.length) {
      throw new Error(
        `Typesense deleted ${result?.num_deleted ?? 0} of ${batch.length} stale documents.`,
      );
    }
  }
  if (ids.length > 0) logger.log(`Deleted ${ids.length} stale records from ${collection}`);
}

export async function getTypesenseAlias({
  host,
  apiKey,
  alias,
  fetchImpl = fetch,
}) {
  const normalizedHost = normalizeHost(host);
  const normalizedAlias = normalizeCollectionName(alias, 'Typesense alias');
  if (!String(apiKey ?? '').trim()) {
    throw new Error('TYPESENSE_ADMIN_API_KEY is required.');
  }

  const response = await fetchImpl(aliasUrl(normalizedHost, normalizedAlias), {
    headers: requestHeaders(apiKey),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(
      `Failed to retrieve Typesense alias: ${response.status}${await responseDetails(response)}`,
    );
  }

  const result = await response.json();
  return normalizeCollectionName(result?.collection_name, 'Typesense alias target');
}

export async function setTypesenseAlias({
  host,
  apiKey,
  alias,
  collection,
  fetchImpl = fetch,
}) {
  const normalizedHost = normalizeHost(host);
  const normalizedAlias = normalizeCollectionName(alias, 'Typesense alias');
  const normalizedCollection = normalizeCollectionName(collection);
  if (!String(apiKey ?? '').trim()) {
    throw new Error('TYPESENSE_ADMIN_API_KEY is required.');
  }

  const response = await fetchImpl(aliasUrl(normalizedHost, normalizedAlias), {
    method: 'PUT',
    headers: requestHeaders(apiKey, 'application/json'),
    body: JSON.stringify({collection_name: normalizedCollection}),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to update Typesense alias: ${response.status}${await responseDetails(response)}`,
    );
  }
}

export async function deleteTypesenseAlias({
  host,
  apiKey,
  alias,
  fetchImpl = fetch,
}) {
  const normalizedHost = normalizeHost(host);
  const normalizedAlias = normalizeCollectionName(alias, 'Typesense alias');
  if (!String(apiKey ?? '').trim()) {
    throw new Error('TYPESENSE_ADMIN_API_KEY is required.');
  }

  const response = await fetchImpl(aliasUrl(normalizedHost, normalizedAlias), {
    method: 'DELETE',
    headers: requestHeaders(apiKey),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Failed to delete Typesense alias: ${response.status}${await responseDetails(response)}`,
    );
  }
}

export async function validateTypesenseCollection({
  host,
  apiKey,
  collection,
  expectedRecords,
  fetchImpl = fetch,
}) {
  const normalizedHost = normalizeHost(host);
  const normalizedCollection = normalizeCollectionName(collection);
  if (!String(apiKey ?? '').trim()) throw new Error('Typesense API key is required.');
  if (!Number.isSafeInteger(expectedRecords) || expectedRecords < 1) {
    throw new Error('Expected Typesense record count must be a positive integer.');
  }

  const response = await fetchImpl(`${normalizedHost}/multi_search`, {
    method: 'POST',
    headers: requestHeaders(apiKey, 'application/json'),
    body: JSON.stringify({
      searches: [{
        collection: normalizedCollection,
        q: '*',
        query_by: 'title',
        per_page: 1,
      }],
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to validate Typesense collection: ${response.status}${await responseDetails(response)}`,
    );
  }

  const result = (await response.json())?.results?.[0];
  if (result?.error) {
    throw new Error(`Typesense validation query failed: ${String(result.error).slice(0, 300)}`);
  }
  if (result?.found !== expectedRecords) {
    throw new Error(
      `Typesense validation found ${result?.found ?? 0} of ${expectedRecords} expected records.`,
    );
  }
}

export async function restoreTypesenseAlias({
  host,
  apiKey,
  alias,
  previousCollection,
  fetchImpl = fetch,
}) {
  if (previousCollection) {
    await setTypesenseAlias({
      host,
      apiKey,
      alias,
      collection: previousCollection,
      fetchImpl,
    });
    return;
  }
  await deleteTypesenseAlias({host, apiKey, alias, fetchImpl});
}

export async function activateTypesenseAlias({
  host,
  adminApiKey,
  searchApiKey,
  alias,
  collection,
  previousCollection,
  expectedRecords,
  fetchImpl = fetch,
}) {
  await setTypesenseAlias({
    host,
    apiKey: adminApiKey,
    alias,
    collection,
    fetchImpl,
  });
  try {
    await validateTypesenseCollection({
      host,
      apiKey: searchApiKey,
      collection: alias,
      expectedRecords,
      fetchImpl,
    });
  } catch (error) {
    try {
      await restoreTypesenseAlias({
        host,
        apiKey: adminApiKey,
        alias,
        previousCollection,
        fetchImpl,
      });
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Typesense alias activation and rollback both failed.',
      );
    }
    throw error;
  }
}

export async function syncTypesense({
  host,
  apiKey,
  collection = 'qingflow_help_docs',
  records,
  synonymGroups,
  fetchImpl = fetch,
  logger = console,
}) {
  const normalizedHost = normalizeHost(host);
  if (!String(apiKey ?? '').trim()) {
    throw new Error('TYPESENSE_ADMIN_API_KEY is required.');
  }
  collection = normalizeCollectionName(collection, 'TYPESENSE_COLLECTION');

  const currentIds = validateSearchRecords(records);
  const options = {
    host: normalizedHost,
    apiKey,
    collection,
    fetchImpl,
    logger,
  };
  await ensureTypesenseCollection(options);
  if (synonymGroups !== undefined) {
    await ensureTypesenseSynonyms({...options, synonymGroups});
  }
  await importTypesenseDocuments({...options, records});
  const indexedIds = await exportTypesenseDocumentIds(options);
  const staleIds = [...new Set(indexedIds)].filter((id) => !currentIds.has(id));
  await deleteTypesenseDocuments({...options, ids: staleIds});
  return {imported: records.length, deleted: staleIds.length};
}

export async function createTypesenseSearchKey({
  host,
  apiKey,
  collection,
  description = 'Qingflow Help Center browser search',
  fetchImpl = fetch,
}) {
  const normalizedHost = normalizeHost(host);
  if (!String(apiKey ?? '').trim()) {
    throw new Error('TYPESENSE_ADMIN_API_KEY is required to create a search key.');
  }
  if (!String(collection ?? '').trim()) {
    throw new Error('TYPESENSE_COLLECTION must not be empty.');
  }
  if (!String(description ?? '').trim()) {
    throw new Error('TYPESENSE_SEARCH_KEY_DESCRIPTION must not be empty.');
  }

  const response = await fetchImpl(`${normalizedHost}/keys`, {
    method: 'POST',
    headers: requestHeaders(apiKey, 'application/json'),
    body: JSON.stringify({
      description: String(description).trim(),
      actions: ['documents:search'],
      collections: [String(collection).trim()],
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to create Typesense search key: ${response.status}${await responseDetails(response)}`,
    );
  }

  const result = await response.json();
  if (typeof result?.value !== 'string' || !result.value.trim()) {
    throw new Error('Typesense search key response did not include a key value.');
  }
  return result;
}
