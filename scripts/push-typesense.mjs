import {readFile} from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();
const host = process.env.TYPESENSE_HOST?.replace(/\/$/, '');
const apiKey = process.env.TYPESENSE_ADMIN_API_KEY;
const collection = process.env.TYPESENSE_COLLECTION ?? 'qingflow_help_docs';
const recordsPath = path.join(cwd, '.tmp', 'search-records.json');

const schema = {
  name: collection,
  enable_nested_fields: false,
  fields: [
    {name: 'title', type: 'string'},
    {name: 'section', type: 'string', facet: true},
    {name: 'content', type: 'string'},
    {name: 'url', type: 'string', facet: true},
    {name: 'product', type: 'string', facet: true},
    {name: 'version', type: 'string', facet: true},
    {name: 'language', type: 'string', facet: true},
    {name: 'tags', type: 'string[]', facet: true, optional: true},
    {name: 'updated_at', type: 'string', optional: true},
    {name: 'updated_at_ts', type: 'int64', optional: true},
  ],
  default_sorting_field: 'updated_at_ts',
};

async function ensureCollection() {
  const response = await fetch(`${host}/collections/${collection}`, {
    headers: {'X-TYPESENSE-API-KEY': apiKey ?? ''},
  });

  if (response.ok) {
    return;
  }

  if (response.status !== 404) {
    throw new Error(`Failed to verify collection: ${response.status}`);
  }

  const createResponse = await fetch(`${host}/collections`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-TYPESENSE-API-KEY': apiKey ?? '',
    },
    body: JSON.stringify(schema),
  });

  if (!createResponse.ok) {
    const details = await createResponse.text();
    throw new Error(
      `Failed to create collection: ${createResponse.status} ${details}`,
    );
  }
}

async function importDocuments() {
  const rawRecords = await readFile(recordsPath, 'utf8');
  const records = JSON.parse(rawRecords);
  const payload = records.map((record) => JSON.stringify(record)).join('\n');

  const response = await fetch(
    `${host}/collections/${collection}/documents/import?action=upsert`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'X-TYPESENSE-API-KEY': apiKey ?? '',
      },
      body: payload,
    },
  );

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Failed to import documents: ${response.status} ${details}`);
  }

  console.log(`Imported ${records.length} records into ${collection}`);
}

async function main() {
  if (!host || !apiKey) {
    throw new Error('TYPESENSE_HOST and TYPESENSE_ADMIN_API_KEY are required.');
  }

  await ensureCollection();
  await importDocuments();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
