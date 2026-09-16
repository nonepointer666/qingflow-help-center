import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activateTypesenseAlias,
  createTypesenseSearchKey,
  buildTypesenseSynonyms,
  ensureTypesenseSynonyms,
  getTypesenseAlias,
  restoreTypesenseAlias,
  setTypesenseAlias,
  syncTypesense,
  validateTypesenseCollection,
} from '../scripts/lib/typesense-sync.mjs';

const host = 'https://typesense.example.com';
const apiKey = 'admin-key';
const collection = 'help';
const records = [
  {
    id: 'current-id',
    doc_id: 'current-id',
    title: 'Current',
  },
];

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

test('Typesense sync imports the snapshot before pruning only stale ids', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({url, options});
    const method = options.method ?? 'GET';
    if (url === `${host}/collections/${collection}` && method === 'GET') {
      return jsonResponse({message: 'not found'}, 404);
    }
    if (url === `${host}/collections` && method === 'POST') {
      return jsonResponse({name: collection}, 201);
    }
    if (url.endsWith('/documents/import?action=upsert')) {
      return new Response('{"success":true}\n');
    }
    if (url.endsWith('/documents/export?include_fields=id')) {
      return new Response('{"id":"current-id"}\n{"id":"removed-id"}\n');
    }
    if (url.includes('/documents?') && method === 'DELETE') {
      return jsonResponse({num_deleted: 1});
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  const result = await syncTypesense({
    host: `${host}/`,
    apiKey,
    collection,
    records,
    fetchImpl,
    logger: {log() {}},
  });

  assert.deepEqual(result, {imported: 1, deleted: 1});
  const importIndex = requests.findIndex(({url}) => url.includes('/documents/import'));
  const exportIndex = requests.findIndex(({url}) => url.includes('/documents/export'));
  const deleteRequest = requests.find(({options}) => options.method === 'DELETE');
  assert.ok(importIndex !== -1 && exportIndex > importIndex);
  assert.ok(deleteRequest);
  const deleteUrl = new URL(deleteRequest.url);
  assert.equal(deleteUrl.searchParams.get('filter_by'), 'id:=[removed-id]');
  assert.doesNotMatch(deleteUrl.searchParams.get('filter_by'), /current-id/);
  assert.equal(deleteRequest.options.headers['X-TYPESENSE-API-KEY'], apiKey);
});

test('Typesense sync never prunes records after a partial import failure', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({url, options});
    if (url.endsWith(`/collections/${collection}`) && !options.method) {
      return jsonResponse({fields: []});
    }
    if (options.method === 'PATCH') return jsonResponse({});
    if (url.endsWith('/documents/import?action=upsert')) {
      return new Response('{"success":false,"error":"invalid record"}\n');
    }
    throw new Error(`Unexpected request: ${options.method ?? 'GET'} ${url}`);
  };

  await assert.rejects(
    syncTypesense({host, apiKey, collection, records, fetchImpl, logger: {log() {}}}),
    /rejected search record 1/,
  );
  assert.equal(requests.some(({url}) => url.includes('/documents/export')), false);
  assert.equal(requests.some(({options}) => options.method === 'DELETE'), false);
});

test('Typesense search key is scoped to search actions and the configured collection', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({url, options});
    return jsonResponse({
      id: 7,
      value: 'search-key',
      description: 'browser search',
      actions: ['documents:search'],
      collections: [collection],
    }, 201);
  };

  const result = await createTypesenseSearchKey({
    host,
    apiKey,
    collection,
    description: 'browser search',
    fetchImpl,
  });

  assert.equal(result.value, 'search-key');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${host}/keys`);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers['X-TYPESENSE-API-KEY'], apiKey);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    description: 'browser search',
    actions: ['documents:search'],
    collections: [collection],
  });
});

test('Typesense alias helpers read, update, and restore a stable alias', async () => {
  const requests = [];
  const alias = 'help_current';
  const fetchImpl = async (url, options = {}) => {
    requests.push({url, options});
    if ((options.method ?? 'GET') === 'GET') {
      return jsonResponse({name: alias, collection_name: 'help_v_old'});
    }
    return jsonResponse({name: alias, collection_name: 'help_v_new'});
  };

  assert.equal(
    await getTypesenseAlias({host, apiKey, alias, fetchImpl}),
    'help_v_old',
  );
  await setTypesenseAlias({
    host,
    apiKey,
    alias,
    collection: 'help_v_new',
    fetchImpl,
  });
  await restoreTypesenseAlias({
    host,
    apiKey,
    alias,
    previousCollection: 'help_v_old',
    fetchImpl,
  });

  assert.deepEqual(
    requests.map(({options}) => options.method ?? 'GET'),
    ['GET', 'PUT', 'PUT'],
  );
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    collection_name: 'help_v_new',
  });
  assert.deepEqual(JSON.parse(requests[2].options.body), {
    collection_name: 'help_v_old',
  });
});

test('Typesense collection validation checks the exact staged record count', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({url, options});
    return jsonResponse({results: [{found: 7, hits: []}]});
  };

  await validateTypesenseCollection({
    host,
    apiKey,
    collection: 'help_v_release',
    expectedRecords: 7,
    fetchImpl,
  });

  assert.equal(requests[0].url, `${host}/multi_search`);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers['X-TYPESENSE-API-KEY'], apiKey);
  assert.deepEqual(JSON.parse(requests[0].options.body).searches[0], {
    collection: 'help_v_release',
    q: '*',
    query_by: 'title',
    per_page: 1,
  });
});

test('Typesense alias activation restores the previous target when browser validation fails', async () => {
  const alias = 'help_current';
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({url, options});
    if (url === `${host}/multi_search`) {
      return jsonResponse({message: 'forbidden'}, 403);
    }
    return jsonResponse({name: alias});
  };

  await assert.rejects(
    activateTypesenseAlias({
      host,
      adminApiKey: apiKey,
      searchApiKey: 'search-key',
      alias,
      collection: 'help_v_new',
      previousCollection: 'help_v_old',
      expectedRecords: 1,
      fetchImpl,
    }),
    /Failed to validate Typesense collection: 403/,
  );

  const aliasUpdates = requests
    .filter(({url, options}) => url.endsWith(`/aliases/${alias}`) && options.method === 'PUT')
    .map(({options}) => JSON.parse(options.body).collection_name);
  assert.deepEqual(aliasUpdates, ['help_v_new', 'help_v_old']);
  assert.equal(
    requests.find(({url}) => url === `${host}/multi_search`).options.headers[
      'X-TYPESENSE-API-KEY'
    ],
    'search-key',
  );
});

test('Typesense synonyms are reconciled through the native collection API', async () => {
  const requests = [];
  const groups = [{terms: ['数据导入', '批量导入']}, {terms: ['旧词', '旧别名']}];
  const desired = buildTypesenseSynonyms(groups);
  const staleId = 'qingflow-stale-rule';
  const fetchImpl = async (url, options = {}) => {
    requests.push({url, options});
    const method = options.method ?? 'GET';
    if (url === `${host}/collections/${collection}/synonyms` && method === 'GET') {
      return jsonResponse({synonyms: [
        {id: desired[1].id, synonyms: desired[1].synonyms},
        {id: staleId, synonyms: ['旧词', '旧别名']},
      ]});
    }
    if (url === `${host}/collections/${collection}/synonyms/${desired[0].id}` && method === 'PUT') {
      return jsonResponse({id: desired[0].id, synonyms: desired[0].synonyms});
    }
    if (url === `${host}/collections/${collection}/synonyms/${staleId}` && method === 'DELETE') {
      return jsonResponse({id: staleId});
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  const result = await ensureTypesenseSynonyms({
    host,
    apiKey,
    collection,
    synonymGroups: groups,
    fetchImpl,
    logger: {log() {}},
  });

  assert.deepEqual(result, {synchronized: 2, upserted: 1, deleted: 1});
  assert.equal(requests[0].options.headers['X-TYPESENSE-API-KEY'], apiKey);
  assert.equal(requests[1].options.method, 'PUT');
  assert.deepEqual(JSON.parse(requests[1].options.body), {synonyms: desired[0].synonyms});
  assert.equal(requests[2].options.method, 'DELETE');
});
