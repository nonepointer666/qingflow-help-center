import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();
const docsRoot = path.join(cwd, 'docs');
const outputDir = path.join(cwd, '.tmp');
const outputFile = path.join(outputDir, 'search-records.json');

async function getMarkdownFiles(dir) {
  const entries = await readdir(dir, {withFileTypes: true});
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return getMarkdownFiles(fullPath);
      }
      if (entry.isFile() && /\.(md|mdx)$/i.test(entry.name)) {
        return [fullPath];
      }
      return [];
    }),
  );

  return nested.flat();
}

function parseFrontMatter(source) {
  if (!source.startsWith('---\n')) {
    return {attributes: {}, body: source};
  }

  const end = source.indexOf('\n---\n', 4);
  if (end === -1) {
    return {attributes: {}, body: source};
  }

  const rawFrontMatter = source.slice(4, end).trim();
  const body = source.slice(end + 5).trim();
  const attributes = {};

  for (const line of rawFrontMatter.split('\n')) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    attributes[key] = value;
  }

  return {attributes, body};
}

function extractTitle(body, frontMatterTitle) {
  if (frontMatterTitle) {
    return frontMatterTitle;
  }

  const firstHeading = body.match(/^#\s+(.+)$/m);
  return firstHeading?.[1]?.trim() ?? 'Untitled';
}

function extractSection(relativePath) {
  const parts = relativePath.split(path.sep);
  return parts.length > 1 ? parts[0] : 'general';
}

function normalizeContent(body) {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[[^\]]+\]\([^)]+\)/g, ' ')
    .replace(/[#>*_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferTags(relativePath) {
  const tags = new Set(relativePath.split(path.sep).filter(Boolean));
  return Array.from(tags);
}

function buildUrl(relativePath, attributes) {
  if (attributes.slug) {
    return `/docs${attributes.slug}`;
  }

  const withoutExtension = relativePath.replace(/\.(md|mdx)$/i, '');
  return `/docs/${withoutExtension.replaceAll(path.sep, '/')}`;
}

async function main() {
  const markdownFiles = await getMarkdownFiles(docsRoot);
  const records = [];

  for (const filePath of markdownFiles) {
    const relativePath = path.relative(docsRoot, filePath);
    const source = await readFile(filePath, 'utf8');
    const {attributes, body} = parseFrontMatter(source);
    const title = extractTitle(body, attributes.title);
    const content = normalizeContent(body);

    records.push({
      id: relativePath.replaceAll(path.sep, '-').replace(/\.(md|mdx)$/i, ''),
      title,
      section: extractSection(relativePath),
      content,
      url: buildUrl(relativePath, attributes),
      product: 'qingflow',
      version: 'current',
      language: 'zh-CN',
      tags: inferTags(relativePath),
      updated_at: new Date().toISOString(),
      updated_at_ts: Date.now(),
    });
  }

  await mkdir(outputDir, {recursive: true});
  await writeFile(outputFile, JSON.stringify(records, null, 2));

  console.log(
    `Generated ${records.length} search records at ${path.relative(cwd, outputFile)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
