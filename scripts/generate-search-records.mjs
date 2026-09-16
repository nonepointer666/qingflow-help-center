import {mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {loadLocalEnvironment} from './lib/load-env.mjs';
import {getContentPaths} from './lib/content-source.mjs';
import {isSearchableDocument} from './lib/document-page-type.mjs';
import {buildBreadcrumb} from './lib/search-breadcrumb.mjs';
import {extractSearchSections} from './lib/search-sections.mjs';
import {buildSearchTokens} from './lib/search-tokenizer.mjs';
import {createSearchSuggestionRecords} from '../src/utils/search-suggestions.mjs';

loadLocalEnvironment();

const cwd = process.cwd();
const {source: contentSource, docsBaseRoot, docsRoot} = getContentPaths(cwd);
const outputDir = path.join(cwd, '.tmp');
const outputFile = path.join(outputDir, 'search-records.json');
const publicOutputFile = path.join(cwd, 'static', 'search-records.json');
const publicSuggestionsFile = path.join(cwd, 'static', 'search-suggestions.json');
const rawDocsDir = path.join(cwd, 'static', 'raw-docs');
const llmsOutputFile = path.join(cwd, 'static', 'llms.txt');
const llmsFullOutputFile = path.join(cwd, 'static', 'llms-full.txt');
const synonymsFile = path.join(cwd, 'data', 'search-synonyms.json');
const publicSynonymsFile = path.join(cwd, 'static', 'search-synonyms.json');

const sectionByRoute = new Map([
  ['getting-started', '新手指南'],
  ['release-notes', '更新动态'],
  ['product-guides', '帮助文档'],
  ['solutions', '解决方案'],
  ['building-guides', '搭建技巧'],
  ['faq', '常见问题-faq'],
  ['video-guides', '视频中心'],
  ['contact', '联系我们'],
]);

const sectionByLabel = new Map([
  ['新手指南', '新手指南'],
  ['更新动态', '更新动态'],
  ['帮助文档', '帮助文档'],
  ['解决方案', '解决方案'],
  ['搭建技巧', '搭建技巧'],
  ['常见问题（FAQ）', '常见问题-faq'],
  ['常见问题(faq)', '常见问题-faq'],
  ['视频中心', '视频中心'],
  ['联系我们', '联系我们'],
]);

const llmsSections = [
  {
    section: '新手指南',
    title: '新手指南',
    path: contentSource === 'outline' ? '/docs/outline/o8kebzouct/' : '/docs/getting-started/',
    description: '认识轻流核心概念并开始搭建第一个应用。',
  },
  {
    section: '帮助文档',
    title: '产品帮助文档',
    path: contentSource === 'outline'
      ? '/docs/outline/d4flynedtc/'
      : '/docs/product-guides/qingflow-introduction/',
    description: '查阅表单、流程、权限、数据和开放平台等产品能力。',
  },
  {
    section: '搭建技巧',
    title: '搭建技巧',
    path: contentSource === 'outline'
      ? '/docs/outline/4kcf3aowp8/'
      : '/docs/building-guides/inventory-outbound-validation/',
    description: '按功能和业务场景查找系统搭建方法。',
  },
  {
    section: '常见问题-faq',
    title: '常见问题',
    path: contentSource === 'outline' ? '/docs/outline/4ohkf9hiol/' : '/docs/faq/',
    description: '快速定位产品使用中的高频问题。',
  },
  {
    section: '解决方案',
    title: '解决方案',
    path: contentSource === 'outline'
      ? '/docs/outline/tye0qxvu6g/'
      : '/docs/solutions/inventory-management/',
    description: '浏览按行业和场景整理的无代码解决方案。',
  },
  {
    section: '更新动态',
    title: '更新动态',
    path: contentSource === 'outline' ? '/docs/outline/09v4h2x3bm/' : '/docs/release-notes/',
    description: '了解产品更新日志和重要公告。',
  },
  {
    section: '视频中心',
    title: '视频中心',
    path: contentSource === 'outline' ? '/docs/outline/ldrdoionqu/' : '/docs/video-guides/',
    description: '通过视频教程学习轻流产品。',
  },
  {
    section: '联系我们',
    title: '联系我们',
    path: contentSource === 'outline' ? '/docs/outline/vwdkk42e1f/' : '/docs/contact/',
    description: '获取轻流服务与支持联系方式。',
  },
];

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

function parseYamlValue(value) {
  const trimmed = value.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }

  return trimmed.replace(/^['"]|['"]$/g, '');
}

function parseFrontMatter(source) {
  const normalizedSource = source.replace(/\r\n?/g, '\n');
  if (!normalizedSource.startsWith('---\n')) {
    return {attributes: {}, body: source};
  }

  const end = normalizedSource.indexOf('\n---\n', 4);
  if (end === -1) {
    return {attributes: {}, body: source};
  }

  const rawFrontMatter = normalizedSource.slice(4, end).trim();
  const body = normalizedSource.slice(end + 5).trim();
  const attributes = {};

  const lines = rawFrontMatter.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    if (!rawValue) {
      const list = [];
      while (index + 1 < lines.length && /^\s+-\s+/.test(lines[index + 1])) {
        index += 1;
        list.push(parseYamlValue(lines[index].replace(/^\s+-\s+/, '')));
      }
      attributes[key] = list;
      continue;
    }

    attributes[key] = parseYamlValue(rawValue);
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

function extractSection(relativePath, attributes, title) {
  if (attributes.source === 'outline') {
    const [root] = asStringArray(attributes.navigation_path);
    return sectionByLabel.get(root ?? title) ?? root ?? title ?? '帮助文档';
  }
  const slugSection = attributes.slug?.split('/').filter(Boolean)[0];
  if (slugSection) {
    return sectionByRoute.get(slugSection) ?? slugSection;
  }

  const parts = relativePath.split(path.sep);
  return parts.length > 1 ? parts[0] : 'general';
}

function inferBusinessPriority(relativePath, attributes, category) {
  if (attributes.source === 'outline') {
    if (category === '帮助文档') return 30;
    if (category === '常见问题-faq') return 20;
    if (category === '更新动态') return 10;
    return 0;
  }
  const route = String(attributes.slug ?? '')
    .split('/')
    .filter(Boolean)[0]
    ?.toLowerCase();
  const fallbackRoute = relativePath.split(path.sep).filter(Boolean)[0]?.toLowerCase();
  const section = route ?? fallbackRoute ?? '';

  if (section === 'product-guides') return 30;
  if (section === 'faq') return 20;
  if (section === 'release-notes') return 10;
  return 0;
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

function normalizeSearchText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .trim();
}

function cleanMarkdown(body) {
  return body
    .replace(/\n---\s*\n+\[查看语雀原文\]\([^)]+\)\s*$/s, '')
    .replace(/\n+请暂时访问语雀原文[^\n]*\s*$/s, '')
    .trim();
}

function inferTags(relativePath, attributes, title) {
  if (attributes.source === 'outline') {
    return Array.from(new Set(asStringArray(attributes.navigation_path).slice(-4)));
  }
  const slugTags = (attributes.slug ?? '')
    .split('/')
    .filter((part) => part && part !== title)
    .slice(0, 4);
  const fallbackTags = relativePath
    .replace(/\.(md|mdx)$/i, '')
    .split(path.sep)
    .filter((part) => part && !['migrated', 'generated'].includes(part));
  const tags = new Set(slugTags.length > 0 ? slugTags : fallbackTags);
  return Array.from(tags);
}

function asStringArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (typeof value === 'string') {
    return value
      .split(/[,，\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function buildSynonymKeywords(values, synonymGroups, sourceValues = values) {
  const source = normalizeSearchText(sourceValues.join(' '));
  const keywords = new Set(values.filter(Boolean));

  synonymGroups.forEach((group) => {
    const terms = asStringArray(group.terms);
    if (terms.some((term) => source.includes(normalizeSearchText(term)))) {
      terms.forEach((term) => keywords.add(term));
    }
  });

  return Array.from(keywords);
}

function buildUrl(relativePath, attributes) {
  if (attributes.slug) {
    return withTrailingSlash(`/docs${attributes.slug}`);
  }

  const withoutExtension = relativePath.replace(/\.(md|mdx)$/i, '');
  return withTrailingSlash(`/docs/${withoutExtension.replaceAll(path.sep, '/')}`);
}

function withTrailingSlash(url) {
  return url.endsWith('/') ? url : `${url}/`;
}

async function main() {
  const markdownFiles = await getMarkdownFiles(docsRoot);
  const records = [];
  const documentRecords = [];
  const rawWrites = [];
  const synonymGroups = JSON.parse(await readFile(synonymsFile, 'utf8'));
  const generatedAt = new Date().toISOString();
  const generatedAtTs = Date.now();

  await rm(rawDocsDir, {recursive: true, force: true});

  for (const filePath of markdownFiles) {
    const relativePath = path.relative(docsBaseRoot, filePath);
    const source = await readFile(filePath, 'utf8');
    const {attributes, body} = parseFrontMatter(source);
    const cleanBody = cleanMarkdown(body);
    const title = extractTitle(cleanBody, attributes.title);
    if (!isSearchableDocument(attributes)) continue;
    const pageType = String(attributes.page_type ?? 'content');
    const content = normalizeContent(cleanBody);
    const category = extractSection(relativePath, attributes, title);
    const businessPriority = inferBusinessPriority(relativePath, attributes, category);
    const tags = inferTags(relativePath, attributes, title);
    const legacyNavigationPath = asStringArray(attributes.keywords);
    const navigationPath = asStringArray(attributes.navigation_path);
    const breadcrumbPath = navigationPath.length > 0
      ? navigationPath
      : legacyNavigationPath;
    const searchAliases = asStringArray(attributes.search_aliases);
    const keywords = buildSynonymKeywords(
      [title, ...tags, ...searchAliases],
      synonymGroups,
      [title, content, ...tags, ...searchAliases],
    );
    const rawRelativePath = relativePath.replace(/\.(md|mdx)$/i, '.md');
    const rawOutputPath = path.join(rawDocsDir, rawRelativePath);
    const rawUrl = `/raw-docs/${rawRelativePath.replaceAll(path.sep, '/')}`;
    const rawMarkdown = /^#\s+.+$/m.test(cleanBody)
      ? `${cleanBody}\n`
      : `# ${title}\n\n${cleanBody}\n`;

    rawWrites.push(
      mkdir(path.dirname(rawOutputPath), {recursive: true}).then(() =>
        writeFile(rawOutputPath, rawMarkdown),
      ),
    );

    const docId = relativePath.replaceAll(path.sep, '-').replace(/\.(md|mdx)$/i, '');
    const documentRecord = {
      id: docId,
      doc_id: docId,
      record_type: 'document',
      page_type: pageType,
      title,
      document_title: title,
      section: category,
      breadcrumb: buildBreadcrumb(category, breadcrumbPath, title),
      keywords,
      search_tokens: buildSearchTokens([
        title,
        ...tags,
        ...searchAliases,
        content,
      ]),
      content,
      url: buildUrl(relativePath, attributes),
      product: 'qingflow',
      business_priority: businessPriority,
      version: 'current',
      language: 'zh-CN',
      tags,
      raw_url: rawUrl,
      updated_at: generatedAt,
      updated_at_ts: generatedAtTs,
    };
    documentRecords.push(documentRecord);
    records.push(documentRecord);

    extractSearchSections(cleanBody, title).forEach((section, sectionIndex) => {
      const sectionKeywords = buildSynonymKeywords(
        [section.title],
        synonymGroups,
        [section.title, section.body],
      );
      records.push({
        id: `${docId}--section-${sectionIndex + 1}`,
        doc_id: docId,
        record_type: 'section',
        page_type: pageType,
        title: section.title,
        document_title: title,
        section: section.title,
        breadcrumb: buildBreadcrumb(category, breadcrumbPath, title, section.title),
        keywords: sectionKeywords,
        search_tokens: buildSearchTokens([
          section.title,
          section.body,
          title,
          ...tags,
        ]),
        content: normalizeContent(section.body),
        url: `${buildUrl(relativePath, attributes)}#${section.slug}`,
        product: 'qingflow',
        business_priority: businessPriority,
        version: 'current',
        language: 'zh-CN',
        tags,
        updated_at: generatedAt,
        updated_at_ts: generatedAtTs,
      });
    });
  }

  const serializedRecords = JSON.stringify(records, null, 2);
  const suggestionRecords = createSearchSuggestionRecords(documentRecords);
  const serializedSuggestions = JSON.stringify(suggestionRecords);
  const siteUrl = (process.env.DOCS_URL ?? 'https://help-center.qingflow.com').replace(
    /\/$/,
    '',
  );
  const llmsText = [
    '# 轻流帮助中心',
    '',
    '> 轻流产品使用指南、最佳实践、更新日志与开放平台文档。',
    '',
    '## 主要入口',
    '',
    ...llmsSections.map(
      (section) =>
        `- [${section.title}](${siteUrl}${section.path}): ${section.description}`,
    ),
    '',
    '## AI 资源',
    '',
    `- [完整文档索引](${siteUrl}/llms-full.txt): 包含全部 ${documentRecords.length} 篇文档的链接与摘要。`,
    `- [站点地图](${siteUrl}/sitemap.xml): 包含所有可抓取页面。`,
    '',
  ].join('\n');
  const llmsFullText = [
    '# 轻流帮助中心完整文档索引',
    '',
    `> 共 ${documentRecords.length} 篇文档。精简入口请访问 ${siteUrl}/llms.txt。`,
    '',
    ...llmsSections.flatMap((section) => [
      `## ${section.title}`,
      '',
      ...documentRecords
        .filter((record) => record.section === section.section)
        .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))
        .map(
          (record) =>
            `- [${record.title}](${siteUrl}${record.url}): ${record.content.slice(0, 180)}`,
        ),
      '',
    ]),
  ].join('\n');

  await Promise.all([
    mkdir(outputDir, {recursive: true}),
    mkdir(path.dirname(publicOutputFile), {recursive: true}),
  ]);
  await Promise.all([
    ...rawWrites,
    writeFile(outputFile, serializedRecords),
    writeFile(publicOutputFile, serializedRecords),
    writeFile(publicSuggestionsFile, serializedSuggestions),
    writeFile(llmsOutputFile, llmsText),
    writeFile(llmsFullOutputFile, llmsFullText),
    writeFile(publicSynonymsFile, JSON.stringify(synonymGroups, null, 2)),
  ]);

  console.log(
    `Generated ${records.length} search records, ${suggestionRecords.length} search suggestions, Markdown sources, llms.txt, and llms-full.txt`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
