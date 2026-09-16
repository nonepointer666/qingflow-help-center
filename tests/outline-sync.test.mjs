import assert from 'node:assert/strict';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename as fsRename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {getContentPaths, getContentSource} from '../scripts/lib/content-source.mjs';
import {isSearchableDocument} from '../scripts/lib/document-page-type.mjs';
import {
  assignDocumentRoutes,
  classifyOutlineDocument,
  collectOutlineAttachmentIds,
  createOutlineClient,
  disableProxyForOutline,
  fetchAllPages,
  fetchOutlineAttachmentMetadata,
  fetchOutlineSnapshot,
  findRelativeMediaReferences,
  generateOutlineOutput,
  replaceGeneratedOutput,
  rewriteMarkdownUrls,
  serializeGeneratedDocument,
  serializeGeneratedSidebar,
  validateOutlineMarkdown,
  validateRouteMap,
} from '../scripts/lib/outline-sync.mjs';

const baseUrl = 'https://outline.dev.oalite.com';
const docIdOne = '11111111-1111-4111-8111-111111111111';
const docIdTwo = '22222222-2222-4222-8222-222222222222';

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {'content-type': 'application/json', ...headers},
  });
}

test('Outline synchronization disables inherited proxy settings', () => {
  const environment = {
    HTTP_PROXY: 'http://127.0.0.1:7890',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    ALL_PROXY: 'socks5://127.0.0.1:7890',
    http_proxy: 'http://127.0.0.1:7890',
    https_proxy: 'http://127.0.0.1:7890',
    all_proxy: 'socks5://127.0.0.1:7890',
    NODE_USE_ENV_PROXY: '1',
  };

  disableProxyForOutline(environment);

  for (const name of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
  ]) {
    assert.equal(name in environment, false);
  }
  assert.equal(environment.NODE_USE_ENV_PROXY, '0');
  assert.equal(environment.NO_PROXY, '*');
  assert.equal(environment.no_proxy, '*');
});

test('content source paths select one document tree', () => {
  assert.equal(getContentSource({}), 'outline');
  assert.equal(getContentSource({DOCS_CONTENT_SOURCE: 'LEGACY'}), 'legacy');
  assert.equal(getContentPaths('/repo', {DOCS_CONTENT_SOURCE: 'legacy'}).docsRoot, path.join('/repo', 'docs', 'migrated'));
  assert.throws(() => getContentSource({DOCS_CONTENT_SOURCE: 'other'}), /Unsupported/);
});

test('Outline client posts JSON, authenticates, paginates, and retries transient errors', async () => {
  const requests = [];
  let attempts = 0;
  const client = createOutlineClient({
    baseUrl: `${baseUrl}/`,
    token: 'test-secret',
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      requests.push({url, options});
      attempts += 1;
      if (attempts === 1) return jsonResponse({message: 'temporary'}, 500);
      const {offset} = JSON.parse(options.body);
      return jsonResponse({data: offset === 0 ? [{id: '1'}, {id: '2'}] : [{id: '3'}]});
    },
  });

  const items = await fetchAllPages(client, 'collections.list', {}, 2);
  assert.deepEqual(items.map(({id}) => id), ['1', '2', '3']);
  assert.equal(requests[0].url, `${baseUrl}/api/collections.list`);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-secret');
  assert.equal(requests.length, 3);
});

test('Outline client does not retry authorization errors or expose its token', async () => {
  let attempts = 0;
  const client = createOutlineClient({
    token: 'private-token',
    fetchImpl: async () => {
      attempts += 1;
      return jsonResponse({message: 'private-token'}, 403);
    },
  });
  await assert.rejects(client.post('collections.list'), (error) => {
    assert.doesNotMatch(error.message, /private-token/);
    assert.match(error.message, /HTTP 403/);
    return true;
  });
  assert.equal(attempts, 1);
});

test('snapshot uses the collection tree and fetches missing bodies with documents.info', async () => {
  const endpoints = [];
  const client = {
    async post(endpoint, payload) {
      endpoints.push({endpoint, payload});
      if (endpoint === 'collections.list') {
        return {data: payload.offset === 0 ? [{id: 'collection-1', name: '售后知识库'}] : []};
      }
      if (endpoint === 'collections.documents') {
        return {
          data: [
            {
              id: '33333333-3333-4333-8333-333333333333',
              title: '📖 售后知识库',
              children: [
                {
                  id: docIdOne,
                  title: '产品指南',
                  url: '/doc/product-guide-one',
                  children: [
                    {id: docIdTwo, title: '表单', url: '/doc/form-two', children: []},
                  ],
                },
              ],
            },
          ],
        };
      }
      if (endpoint === 'documents.list') {
        return {
          data:
            payload.offset === 0
              ? [{id: docIdOne, title: '产品指南', urlId: 'one', text: 'Parent', updatedAt: '2026-01-01'}]
              : [],
        };
      }
      if (endpoint === 'documents.info') {
        return {data: {id: docIdTwo, title: '表单', urlId: 'two', text: 'Child', updatedAt: '2026-01-02'}};
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    },
  };

  const snapshot = await fetchOutlineSnapshot(client, '售后知识库');
  assert.equal(snapshot.documents.length, 2);
  assert.deepEqual(snapshot.documents[1].parents, ['产品指南']);
  assert.equal(snapshot.documents[1].text, 'Child');
  assert.ok(endpoints.some(({endpoint}) => endpoint === 'documents.info'));
  assert.ok(
    endpoints.some(
      ({endpoint, payload}) =>
        endpoint === 'documents.list' &&
        payload.sort === 'createdAt' &&
        payload.direction === 'ASC',
    ),
  );
});

test('snapshot requires exactly one collection with the configured name', async () => {
  const emptyClient = {post: async () => ({data: []})};
  await assert.rejects(fetchOutlineSnapshot(emptyClient, '售后知识库'), /not found/);

  const duplicateClient = {
    post: async () => ({
      data: [
        {id: 'collection-1', name: '售后知识库'},
        {id: 'collection-2', name: '售后知识库'},
      ],
    }),
  };
  await assert.rejects(fetchOutlineSnapshot(duplicateClient, '售后知识库'), /Multiple/);
});

test('attachment metadata only scans ordinary Markdown links', () => {
  const markdown = [
    '![image](/api/attachments.redirect?id=image)',
    '[video](/api/attachments.redirect?id=video)',
    '[video again](https://outline.dev.oalite.com/api/attachments.redirect?id=video)',
    '```md',
    '[code](/api/attachments.redirect?id=code)',
    '```',
  ].join('\n');
  assert.deepEqual(
    collectOutlineAttachmentIds(markdown, baseUrl),
    ['video'],
  );
});

test('attachment MIME metadata is listed per document without downloading media', async () => {
  const requests = [];
  const client = {
    async post(endpoint, payload) {
      requests.push({endpoint, payload});
      assert.equal(endpoint, 'attachments.list');
      return {
        data: [
          {
            id: 'video',
            documentId: docIdOne,
            contentType: 'video/mp4',
            name: '宣传片.mov',
          },
          {
            id: 'unused-image',
            documentId: docIdOne,
            contentType: 'image/png',
          },
        ],
      };
    },
  };
  const metadata = await fetchOutlineAttachmentMetadata(
    client,
    [
      {
        id: docIdOne,
        text: '[宣传片](/api/attachments.redirect?id=video)\n\n![图片](/api/attachments.redirect?id=unused-image)',
      },
      {id: docIdTwo, text: 'No attachments'},
    ],
    baseUrl,
  );

  assert.deepEqual(requests, [
    {
      endpoint: 'attachments.list',
      payload: {documentId: docIdOne, limit: 100, offset: 0},
    },
  ]);
  assert.deepEqual(metadata.get('video'), {id: 'video', contentType: 'video/mp4'});
  assert.equal(metadata.has('unused-image'), false);
});

test('video attachment links become embedded video elements by MIME type', () => {
  const documents = [{id: docIdOne, urlId: 'one', url: '/doc/one', slug: '/outline/one'}];
  const markdown = [
    '[宣传片 640x360](/api/attachments.redirect?id=video)',
    '[说明文档](/api/attachments.redirect?id=pdf)',
    '![截图](/api/attachments.redirect?id=image)',
  ].join('\n');
  const rewritten = rewriteMarkdownUrls(
    markdown,
    documents,
    baseUrl,
    new Map([
      ['video', {contentType: 'video/mp4'}],
      ['pdf', {contentType: 'application/pdf'}],
      ['image', {contentType: 'image/png'}],
    ]),
  );
  assert.match(rewritten, /<video controls playsInline preload="metadata"/);
  assert.match(
    rewritten,
    /src="https:\/\/outline\.dev\.oalite\.com\/api\/attachments\.redirect\?id=video"/,
  );
  assert.match(rewritten, /\[说明文档\]\(https:\/\/outline\.dev\.oalite\.com\/api\/attachments\.redirect\?id=pdf\)/);
  assert.match(rewritten, /!\[截图\]\(https:\/\/outline\.dev\.oalite\.com\/api\/attachments\.redirect\?id=image\)/);
});

test('snapshot rejects wrong bodies and documents outside the navigation tree', async () => {
  const responses = {
    'collections.list': {data: [{id: 'collection', name: '售后知识库'}]},
    'collections.documents': {
      data: [{id: docIdOne, title: 'Guide', children: []}],
    },
    'documents.list': {data: []},
    'documents.info': {data: {id: docIdTwo, title: 'Guide', text: 'Wrong'}},
  };
  const wrongBodyClient = {post: async (endpoint) => responses[endpoint]};
  await assert.rejects(fetchOutlineSnapshot(wrongBodyClient, '售后知识库'), /wrong document/);

  responses['documents.list'] = {
    data: [
      {id: docIdOne, title: 'Guide', text: 'Guide'},
      {id: docIdTwo, title: 'Extra', text: 'Extra'},
    ],
  };
  const extraBodyClient = {post: async (endpoint) => responses[endpoint]};
  await assert.rejects(fetchOutlineSnapshot(extraBodyClient, '售后知识库'), /outside the navigation tree/);
});

test('media references become absolute and Outline document links become local', async () => {
  const documents = [
    {
      id: 'doc-1',
      urlId: 'one',
      url: '/doc/guide-one',
      slug: '/product-guides/guide',
    },
  ];
  const markdown = [
    '[Guide](/doc/guide-one#part)',
    '![Image](/api/attachments.redirect?id=image)',
    '<video src="/api/attachments.redirect?id=video" poster="/api/attachments.redirect?id=poster"></video>',
    '<source srcset="/api/attachments.redirect?id=small 1x, /api/attachments.redirect?id=large 2x">',
    'First line<br>Second line',
    'Visit <https://example.com/help>',
    '| JSON | {"value":{"enabled":true}} |',
    '文件{序号}.pdf',
    'HP < 60，合格率<不合格率，HP **<** 10，行尾<',
    '正则 ^[a-z]{0,}$ 与 [0-9]{2}',
    '后行断言 (?<=订单号:)(\\S+)',
    '例子：{"name":"贾胜强"}',
    '分页 {{PAGE_INDEX}}、{{accessToken}} 与 {{变量名称}}',
    '钉钉语法 <@userid>',
    '字段 qf_field.{开始日期$$169ACB6B8$$}',
    '输出 qf_output={key}',
    'API /{appKey}，表达式 {process.env.OUTLINE_API_TOKEN}，代码 `{kept}`',
    '文本 <CB>标题</CB> 与 <’ 符号',
    'JSON 示例：{"value":"<p><strong>文本</strong><p>"}',
    '[无效链接](https://) 与 [空链接]()、![空图片]()、[未知目标](undefined) 和 [错误域名](/exiao.tech)',
    '[协议相对链接](//exiao.tech/help)',
    '```md',
    '![Example](/api/attachments.redirect?id=do-not-rewrite-code)',
    '```',
    '> ```json',
    '> {"quoted":"{kept}"}',
    '> <CB> 与 <’ 保持代码原样',
    '> ```',
  ].join('\n');

  const rewritten = rewriteMarkdownUrls(markdown, documents, baseUrl);
  assert.match(rewritten, /\[Guide\]\(\/docs\/product-guides\/guide#part\)/);
  assert.match(rewritten, /https:\/\/outline\.dev\.oalite\.com\/api\/attachments\.redirect\?id=image/);
  assert.match(rewritten, /id=video/);
  assert.match(rewritten, /id=large 2x/);
  assert.match(rewritten, /First line<br \/>Second line/);
  assert.match(
    rewritten,
    /Visit \[https:\/\/example\.com\/help\]\(https:\/\/example\.com\/help\)/,
  );
  assert.match(
    rewritten,
    /\| JSON \| &#123;"value":&#123;"enabled":true&#125;&#125; \|/,
  );
  assert.match(rewritten, /文件&#123;序号&#125;\.pdf/);
  assert.match(
    rewritten,
    /HP &lt; 60，合格率&lt;不合格率，HP \*\*&lt;\*\* 10，行尾&lt;/,
  );
  assert.match(
    rewritten,
    /正则 \^\[a-z\]&#123;0,&#125;\$ 与 \[0-9\]&#123;2&#125;/,
  );
  assert.match(rewritten, /后行断言 \(\?&lt;=订单号:\)\(\\S\+\)/);
  assert.match(rewritten, /例子：&#123;"name":"贾胜强"&#125;/);
  assert.match(
    rewritten,
    /分页 &#123;&#123;PAGE_INDEX&#125;&#125;、&#123;&#123;accessToken&#125;&#125; 与 &#123;&#123;变量名称&#125;&#125;/,
  );
  assert.match(rewritten, /钉钉语法 &lt;@userid&gt;/);
  assert.match(
    rewritten,
    /字段 qf_field\.&#123;开始日期\$\$169ACB6B8\$\$&#125;/,
  );
  assert.match(rewritten, /输出 qf_output=&#123;key&#125;/);
  assert.match(
    rewritten,
    /API \/&#123;appKey&#125;，表达式 &#123;process\.env\.OUTLINE_API_TOKEN&#125;，代码 `\{kept\}`/,
  );
  assert.match(rewritten, /文本 &lt;CB>标题&lt;\/CB> 与 &lt;’ 符号/);
  assert.match(rewritten, /JSON 示例：&#123;"value":"&lt;p&gt;&lt;strong&gt;文本&lt;\/strong&gt;&lt;p&gt;"&#125;/);
  assert.match(rewritten, /无效链接 与 空链接、空图片、未知目标 和 错误域名/);
  assert.match(rewritten, /\[协议相对链接\]\(https:\/\/exiao\.tech\/help\)/);
  assert.match(rewritten, /> \{"quoted":"\{kept\}"\}/);
  assert.match(rewritten, /> <CB> 与 <’ 保持代码原样/);
  await assert.doesNotReject(() => validateOutlineMarkdown(rewritten));
  assert.match(rewritten, /do-not-rewrite-code/);
  assert.deepEqual(findRelativeMediaReferences(rewritten), []);
});

test('generated descriptions preserve Unicode and do not end in a Markdown escape', () => {
  const document = {
    id: docIdOne,
    urlId: 'one',
    title: 'Guide',
    parents: [],
    slug: '/outline/one',
  };
  const emojiAtBoundary = serializeGeneratedDocument(
    document,
    `${'a'.repeat(179)}😀`,
    baseUrl,
  );
  const trailingEscape = serializeGeneratedDocument(
    document,
    `${'a'.repeat(179)}\\.`,
    baseUrl,
  );

  assert.match(emojiAtBoundary, /😀/);
  assert.doesNotMatch(emojiAtBoundary, /\\ud83d/i);
  assert.match(trailingEscape, /description: "a{179}"/);
});

test('Outline conversion removes control characters that break HTML minification', () => {
  assert.equal(rewriteMarkdownUrls('before\u0008after', [], baseUrl), 'beforeafter');
});

test('generated documents keep navigation paths separate from search keywords', () => {
  const generated = serializeGeneratedDocument(
    {
      id: docIdOne,
      urlId: 'one',
      title: '创建关联报表',
      parents: ['帮助文档', '流程引擎', '节点通用属性'],
      slug: '/product-guides/workflow-engine/related-report',
    },
    '正文中没有父级目录关键词。',
    baseUrl,
  );

  assert.match(generated, /navigation_path:\n  - "帮助文档"\n  - "流程引擎"\n  - "节点通用属性"/);
  assert.doesNotMatch(generated, /^keywords:/m);
});

test('Outline Markdown rejects executable MDX and unsafe JSX', async () => {
  await validateOutlineMarkdown('Safe **Markdown**\n\n<video src="https://example.com/video.mp4" controls />');
  await assert.rejects(
    validateOutlineMarkdown('{process.env.OUTLINE_API_TOKEN}'),
    /Executable MDX construct/,
  );
  await assert.rejects(
    validateOutlineMarkdown('export const secret = process.env.OUTLINE_API_TOKEN'),
    /Executable MDX construct/,
  );
  await assert.rejects(
    validateOutlineMarkdown('<img src="https://example.com/a.png" onError={alert(1)} />'),
    /Executable MDX attribute|Unsafe MDX attribute/,
  );
  await assert.rejects(validateOutlineMarkdown('[unsafe](javascript:alert(1))'));
});

test('canonical routes always use urlId while the route map only preserves old URLs', () => {
  const routeMap = validateRouteMap({
    version: 2,
    legacyRoutes: [{
      from: '/product-guides/form/member',
      status: 'active',
      outlineUrlId: 'MemberOne',
    }],
  });
  const first = assignDocumentRoutes([{
    id: docIdOne,
    urlId: 'MemberOne',
    title: '成员',
    parents: ['产品指南', '表单'],
  }], [], routeMap);
  const moved = assignDocumentRoutes([{
    id: docIdOne,
    urlId: 'MemberOne',
    title: '成员管理',
    parents: ['帮助文档', '组织架构'],
  }], [], routeMap);

  assert.equal(first.conflicts.length, 0);
  assert.equal(first.documents[0].slug, '/outline/memberone');
  assert.equal(first.documents[0].routeSource, 'outline-url-id');
  assert.equal(moved.documents[0].slug, first.documents[0].slug);
});

test('route validation fails closed for missing targets, duplicate urlIds, and redirect cycles', () => {
  const missing = assignDocumentRoutes([{
    id: docIdOne,
    urlId: 'current',
    title: 'Current',
    parents: [],
  }], [], {
    version: 2,
    legacyRoutes: [{from: '/old', status: 'active', outlineUrlId: 'deleted'}],
  });
  assert.equal(missing.conflicts[0].type, 'missing-active-legacy-target');

  const duplicate = assignDocumentRoutes([
    {id: docIdOne, urlId: 'Same_ID', title: 'One', parents: []},
    {id: docIdTwo, urlId: 'same-id', title: 'Two', parents: []},
  ], [], {version: 2, legacyRoutes: []});
  assert.equal(duplicate.conflicts[0].type, 'duplicate-url-id');

  assert.throws(() => validateRouteMap({
    version: 2,
    legacyRoutes: [
      {from: '/one', status: 'redirect', to: '/two'},
      {from: '/two', status: 'redirect', to: '/one'},
    ],
  }), /cycle/i);
});

test('new documents receive a stable urlId route and parent documents link from the sidebar', () => {
  const document = {
    id: '0198acbd-0000-0000-0000-000000000001',
    urlId: 'AbC123',
    title: 'New page',
    parents: [],
  };
  const assignment = assignDocumentRoutes([document], [], {version: 2, legacyRoutes: []});
  assert.equal(assignment.documents[0].slug, '/outline/abc123');
  const sidebar = serializeGeneratedSidebar([
    {...document, children: [{...document, id: 'child-id', title: 'Child', children: []}]},
  ]);
  assert.match(sidebar, /"link": \{/);
  assert.match(sidebar, /"id": "generated\/0198acbd-0000-0000-0000-000000000001"/);
});

test('Outline page types depend on meaningful content instead of leaf status', () => {
  const childRoute = '/docs/outline/child';
  const directory = classifyOutlineDocument(
    `## 本章节内容\n\n- [子文档](${childRoute})`,
    {hasChildren: true, descendantRoutes: [childRoute]},
  );
  const hybrid = classifyOutlineDocument(
    `本章节介绍审批流程的配置方式和使用范围。\n\n- [子文档](${childRoute})`,
    {hasChildren: true, descendantRoutes: [childRoute]},
  );
  const content = classifyOutlineDocument('这是没有子文档的完整操作说明。');
  const shortList = classifyOutlineDocument('- 开启\n- 关闭');
  const empty = classifyOutlineDocument('## 暂无内容');

  assert.equal(directory.pageType, 'directory');
  assert.equal(directory.hasMeaningfulContent, false);
  assert.equal(directory.contentMarkdown, '');
  assert.equal(hybrid.pageType, 'hybrid');
  assert.equal(hybrid.hasMeaningfulContent, true);
  assert.doesNotMatch(hybrid.contentMarkdown, /子文档/);
  assert.equal(content.pageType, 'content');
  assert.equal(shortList.pageType, 'content');
  assert.equal(empty.pageType, 'empty');
});

test('directory Outline pages remain searchable while empty pages stay out of search', () => {
  assert.equal(isSearchableDocument({source: 'outline', page_type: 'directory'}), true);
  assert.equal(isSearchableDocument({source: 'outline', page_type: 'empty'}), false);
  assert.equal(isSearchableDocument({source: 'outline', page_type: 'hybrid'}), true);
  assert.equal(isSearchableDocument({source: 'outline', page_type: 'content'}), true);
  assert.equal(isSearchableDocument({source: 'legacy'}), true);
});

test('failed MDX validation leaves the previous generated output intact', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'outline-output-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, 'docs', 'generated'), {recursive: true});
  await mkdir(path.join(root, '.tmp'), {recursive: true});
  await writeFile(path.join(root, 'docs', 'generated', 'old.mdx'), 'old');
  await writeFile(path.join(root, 'sidebars.generated.ts'), 'old sidebar');
  const tree = [{id: docIdOne, title: 'Broken', children: []}];
  const document = {
    id: docIdOne,
    urlId: 'broken',
    title: 'Broken',
    text: 'export const broken = true',
    parents: [],
    slug: '/outline/broken',
    routeSource: 'outline-id',
  };

  await assert.rejects(
    generateOutlineOutput({
      cwd: root,
      snapshot: {collection: {id: 'collection', name: '售后知识库'}, tree},
      assignedDocuments: [document],
      baseUrl,
    }),
  );
  assert.equal(await readFile(path.join(root, 'docs', 'generated', 'old.mdx'), 'utf8'), 'old');
  assert.equal(await readFile(path.join(root, 'sidebars.generated.ts'), 'utf8'), 'old sidebar');
});

test('successful generation replaces the snapshot without creating local media', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'outline-success-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, '.tmp'), {recursive: true});
  const tree = [{id: docIdOne, title: 'Guide', url: '/doc/guide-one', children: []}];
  const document = {
    id: docIdOne,
    urlId: 'one',
    url: '/doc/guide-one',
    title: 'Guide',
    text: [
      'Hello',
      '![Image](/api/attachments.redirect?id=image)',
      '[Demo](/api/attachments.redirect?id=video)',
    ].join('\n\n'),
    updatedAt: '2026-09-09T00:00:00.000Z',
    parents: [],
    slug: '/outline/one',
    routeSource: 'outline-id',
  };
  const report = await generateOutlineOutput({
    cwd: root,
    snapshot: {
      collection: {id: 'collection', name: '售后知识库'},
      tree,
      attachments: new Map([['video', {contentType: 'video/mp4'}]]),
    },
    assignedDocuments: [document],
    baseUrl,
  });

  const output = await readFile(path.join(root, 'docs', 'generated', `${docIdOne}.mdx`), 'utf8');
  assert.match(output, /source: "outline"/);
  assert.match(output, /https:\/\/outline\.dev\.oalite\.com\/api\/attachments\.redirect\?id=image/);
  assert.match(output, /<video controls playsInline preload="metadata"/);
  assert.equal(report.media, 'remote');
  await assert.rejects(access(path.join(root, 'static')));
});

test('generation turns link-only parents into directory pages with child metadata', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'outline-directory-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, '.tmp'), {recursive: true});
  const tree = [{
    id: docIdOne,
    title: 'Parent',
    children: [{id: docIdTwo, title: 'Child', children: []}],
  }];
  const documents = [
    {
      id: docIdOne,
      urlId: 'parent',
      title: 'Parent',
      text: `## 子文档\n\n- [Child](/doc/${docIdTwo})`,
      parents: [],
      slug: '/outline/parent',
      routeSource: 'outline-url-id',
    },
    {
      id: docIdTwo,
      urlId: 'child',
      title: 'Child',
      text: 'This child contains a complete setup guide for administrators.',
      parents: ['Parent'],
      slug: '/outline/child',
      routeSource: 'outline-url-id',
    },
  ];

  const report = await generateOutlineOutput({
    cwd: root,
    snapshot: {
      collection: {id: 'collection', name: '售后知识库'},
      tree,
      attachments: new Map(),
    },
    assignedDocuments: documents,
    baseUrl,
  });

  const parentOutput = await readFile(
    path.join(root, 'docs', 'generated', `${docIdOne}.mdx`),
    'utf8',
  );
  assert.match(parentOutput, /page_type: "directory"/);
  assert.match(parentOutput, /has_meaningful_content: false/);
  assert.match(parentOutput, /outline_children: \[/);
  assert.match(parentOutput, /"url":"\/docs\/outline\/child\/"/);
  assert.doesNotMatch(parentOutput, /\[Child\]/);
  assert.deepEqual(report.pageTypes, {content: 1, directory: 1, hybrid: 0, empty: 0});
});

test('report staging failure preserves the previous generated snapshot', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'outline-report-failure-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, 'docs', 'generated'), {recursive: true});
  await mkdir(path.join(root, '.tmp'), {recursive: true});
  await writeFile(path.join(root, 'docs', 'generated', 'old.mdx'), 'old');
  await writeFile(path.join(root, 'sidebars.generated.ts'), 'old sidebar');
  const document = {
    id: docIdOne,
    urlId: 'one',
    title: 'Guide',
    text: 'Safe content',
    parents: [],
    slug: '/outline/one',
    routeSource: 'outline-id',
  };

  await assert.rejects(
    generateOutlineOutput({
      cwd: root,
      snapshot: {
        collection: {id: 'collection', name: '售后知识库'},
        tree: [{id: docIdOne, title: 'Guide', children: []}],
      },
      assignedDocuments: [document],
      baseUrl,
      writeFileImpl: async (filePath, value) => {
        if (filePath.endsWith('outline-sync-report.json')) throw new Error('report failed');
        await writeFile(filePath, value);
      },
    }),
    /report failed/,
  );
  assert.equal(await readFile(path.join(root, 'docs', 'generated', 'old.mdx'), 'utf8'), 'old');
  assert.equal(await readFile(path.join(root, 'sidebars.generated.ts'), 'utf8'), 'old sidebar');
});

test('swap failure rolls back documents, sidebar, and report', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'outline-swap-failure-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const stagedRoot = path.join(root, '.tmp', 'stage');
  const stagedDocs = path.join(stagedRoot, 'generated');
  const stagedSidebar = path.join(stagedRoot, 'sidebars.generated.ts');
  const stagedReport = path.join(stagedRoot, 'outline-sync-report.json');
  await mkdir(path.join(root, 'docs', 'generated'), {recursive: true});
  await mkdir(stagedDocs, {recursive: true});
  await writeFile(path.join(root, 'docs', 'generated', 'old.mdx'), 'old');
  await writeFile(path.join(root, 'sidebars.generated.ts'), 'old sidebar');
  await writeFile(path.join(root, '.tmp', 'outline-sync-report.json'), 'old report');
  await writeFile(path.join(stagedDocs, 'new.mdx'), 'new');
  await writeFile(stagedSidebar, 'new sidebar');
  await writeFile(stagedReport, 'new report');
  let injected = false;

  await assert.rejects(
    replaceGeneratedOutput({
      cwd: root,
      stagedDocs,
      stagedSidebar,
      stagedReport,
      operations: {
        rename: async (source, target) => {
          if (!injected && source === stagedSidebar) {
            injected = true;
            throw new Error('rename failed');
          }
          await fsRename(source, target);
        },
        rm,
      },
    }),
    /rename failed/,
  );
  assert.equal(await readFile(path.join(root, 'docs', 'generated', 'old.mdx'), 'utf8'), 'old');
  assert.equal(await readFile(path.join(root, 'sidebars.generated.ts'), 'utf8'), 'old sidebar');
  assert.equal(await readFile(path.join(root, '.tmp', 'outline-sync-report.json'), 'utf8'), 'old report');
  assert.equal(
    (await readdir(path.join(root, '.tmp'))).some((name) => name.startsWith('outline-backup-')),
    false,
  );
});
