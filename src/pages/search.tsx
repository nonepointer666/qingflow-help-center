import type {FormEvent, ReactNode} from 'react';
import {useEffect, useRef, useState} from 'react';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import {
  ArrowRight,
  ChevronRight,
  FileSearch,
  LoaderCircle,
  Search,
  Sparkles,
} from 'lucide-react';

import styles from './search.module.css';

type SearchDocument = {
  title?: string;
  section?: string;
  content?: string;
  url?: string;
  version?: string;
  language?: string;
  product?: string;
  tags?: string[];
};

type SearchHit = {
  document?: SearchDocument;
  highlights?: Array<{
    snippet?: string;
  }>;
};

type SearchState = 'idle' | 'loading' | 'ready' | 'error';

const localDocuments: SearchDocument[] = [
  {
    title: '帮助中心概览',
    section: '快速开始',
    content: '认识轻流帮助中心，了解推荐内容入口、版本策略和文档结构。',
    url: '/docs/getting-started/overview',
    tags: ['入门', '帮助中心'],
  },
  {
    title: '内容协作与发布流程',
    section: '快速开始',
    content: '导入 Markdown 文档，通过 GitHub 协作、审核、修改和发布内容。',
    url: '/docs/getting-started/content-workflow',
    tags: ['Markdown', '发布'],
  },
  {
    title: '导航与搜索',
    section: '产品使用',
    content: '快速找到轻流功能、产品指南和常见问题，了解站内搜索方式。',
    url: '/docs/product-guides/end-user/navigation-and-search',
    tags: ['导航', '搜索'],
  },
  {
    title: '审批中心',
    section: '流程与审批',
    content: '审批中心怎么配置，如何查看待办任务、处理审批并追踪流程进度。',
    url: '/docs/product-guides/workflow/approval-center',
    tags: ['审批', '流程', '待办'],
  },
  {
    title: '私有化部署拓扑',
    section: '管理与运维',
    content: '私有化部署需要的服务、网络、存储、搜索组件和推荐拓扑。',
    url: '/docs/admin/deployment-topology',
    tags: ['私有化', '部署'],
  },
  {
    title: '内容治理',
    section: '管理与运维',
    content: '维护帮助中心目录、角色、版本、多语言和内容审核机制。',
    url: '/docs/admin/content-governance',
    tags: ['目录', '版本', '权限'],
  },
  {
    title: 'API 概览',
    section: '开放平台',
    content: '了解开放平台 API、接口文档和系统集成方式。',
    url: '/docs/api/overview',
    tags: ['API', '开发'],
  },
  {
    title: '搜索与发布运行手册',
    section: '管理与运维',
    content: '维护 Typesense 搜索索引、执行构建和发布帮助中心。',
    url: '/docs/operations/search-and-release-runbook',
    tags: ['搜索', '发布', '运维'],
  },
];

function searchLocalDocuments(query: string, documents: SearchDocument[]): SearchHit[] {
  const normalizedQuery = query.toLowerCase().replace(/\s+/g, '');
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);

  return documents
    .map((document) => {
      const corpus = [
        document.title,
        document.section,
        document.content,
        ...(document.tags ?? []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      const compactCorpus = corpus.replace(/\s+/g, '');
      let score = compactCorpus.includes(normalizedQuery) ? 20 : 0;

      words.forEach((word) => {
        if (corpus.includes(word)) score += 5;
      });

      if (normalizedQuery.length > 2) {
        for (let index = 0; index < normalizedQuery.length - 1; index += 1) {
          if (compactCorpus.includes(normalizedQuery.slice(index, index + 2))) {
            score += 1;
          }
        }
      }

      return {document, score};
    })
    .filter((item) => item.score >= 2)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8)
    .map(({document}) => ({document}));
}

export default function SearchPage(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  const searchPath = useBaseUrl('/search');
  const searchIndexPath = useBaseUrl('/search-records.json');
  const localIndexPromise = useRef<Promise<SearchDocument[]> | null>(null);
  const customFields = (siteConfig.customFields ?? {}) as {
    typesense?: {
      host?: string;
      searchApiKey?: string;
      collection?: string;
      enableSemantic?: boolean;
    };
  };
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>('idle');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [notice, setNotice] = useState('');

  const typesense = customFields.typesense ?? {};
  const canUseTypesense = Boolean(typesense.host && typesense.searchApiKey);

  function getLocalDocuments() {
    if (!localIndexPromise.current) {
      localIndexPromise.current = fetch(searchIndexPath)
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Local search index responded with ${response.status}`);
          }

          const documents: unknown = await response.json();
          return Array.isArray(documents) ? (documents as SearchDocument[]) : localDocuments;
        })
        .catch(() => localDocuments);
    }

    return localIndexPromise.current;
  }

  async function runSearch(nextQuery: string) {
    const trimmedQuery = nextQuery.trim();
    if (!trimmedQuery) {
      setResults([]);
      setState('idle');
      setNotice('');
      return;
    }

    setState('loading');
    setNotice('');

    if (!canUseTypesense) {
      const documents = await getLocalDocuments();
      setResults(searchLocalDocuments(trimmedQuery, documents));
      setState('ready');
      return;
    }

    const host = typesense.host?.replace(/\/$/, '');
    const collection = typesense.collection || 'qingflow_help_docs';
    const queryBy = typesense.enableSemantic
      ? 'title,section,content,tags,embedding'
      : 'title,section,content,tags';

    try {
      const response = await fetch(`${host}/multi_search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-TYPESENSE-API-KEY': typesense.searchApiKey ?? '',
        },
        body: JSON.stringify({
          searches: [
            {
              collection,
              q: trimmedQuery,
              query_by: queryBy,
              highlight_fields: 'title,section,content',
              prefix: 'true,true,false,false',
              num_typos: 2,
              per_page: 8,
              ...(typesense.enableSemantic
                ? {vector_query: 'embedding:([], alpha: 0.65)'}
                : {}),
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`Search service responded with ${response.status}`);
      }

      const payload = await response.json();
      setResults(payload.results?.[0]?.hits ?? []);
      setState('ready');
    } catch {
      const documents = await getLocalDocuments();
      setResults(searchLocalDocuments(trimmedQuery, documents));
      setState('ready');
      setNotice('在线搜索暂不可用，已显示站内索引结果。');
    }
  }

  useEffect(() => {
    const nextQuery = new URLSearchParams(window.location.search).get('q') ?? '';
    setQuery(nextQuery);
    if (nextQuery) void runSearch(nextQuery);
  }, []);

  function updateUrl(nextQuery: string) {
    const nextUrl = nextQuery.trim()
      ? `${searchPath}?q=${encodeURIComponent(nextQuery.trim())}`
      : searchPath;
    window.history.replaceState({}, '', nextUrl);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateUrl(query);
    void runSearch(query);
  }

  function handleSuggestion(nextQuery: string) {
    setQuery(nextQuery);
    updateUrl(nextQuery);
    void runSearch(nextQuery);
  }

  return (
    <Layout title="搜索帮助文档" description="搜索轻流产品帮助、操作指南和开发文档。">
      <main className={styles.searchPage}>
        <header className={styles.searchHero}>
          <div className="container">
            <div className={styles.heroInner}>
              <p className={styles.eyebrow}>
                <Sparkles aria-hidden="true" size={16} />
                站内搜索
              </p>
              <Heading as="h1">搜索帮助文档</Heading>
              <p>描述你遇到的问题，查找相关功能说明、操作步骤和最佳实践。</p>
              <form className={styles.searchForm} onSubmit={handleSubmit}>
                <Search aria-hidden="true" size={21} />
                <input
                  className={styles.searchInput}
                  type="search"
                  placeholder="例如：审批中心怎么配置"
                  aria-label="搜索帮助文档"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  autoFocus
                />
                <button type="submit">
                  搜索 <ArrowRight aria-hidden="true" size={18} />
                </button>
              </form>
              <div className={styles.suggestions}>
                <span>热门搜索</span>
                {['导入 Markdown 文档', '审批中心怎么配置', '私有化部署拓扑'].map(
                  (suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => handleSuggestion(suggestion)}>
                      {suggestion}
                    </button>
                  ),
                )}
              </div>
            </div>
          </div>
        </header>

        <section className={styles.resultsSection}>
          <div className="container">
            <div className={styles.resultsInner}>
              {state === 'loading' ? (
                <div className={styles.stateMessage}>
                  <LoaderCircle className={styles.spinner} aria-hidden="true" size={24} />
                  正在查找相关文档...
                </div>
              ) : null}

              {notice ? <p className={styles.notice}>{notice}</p> : null}

              {state === 'ready' ? (
                <div className={styles.resultsHeader}>
                  <Heading as="h2">搜索结果</Heading>
                  <span>{results.length} 篇相关文档</span>
                </div>
              ) : null}

              {state === 'ready' && results.length === 0 ? (
                <div className={styles.emptyState}>
                  <FileSearch aria-hidden="true" size={30} />
                  <Heading as="h2">没有找到相关内容</Heading>
                  <p>试试缩短问题，或者使用功能名称重新搜索。</p>
                  <Link to="/docs/getting-started/overview">浏览完整文档目录</Link>
                </div>
              ) : null}

              {state === 'idle' ? (
                <div className={styles.emptyState}>
                  <Search aria-hidden="true" size={30} />
                  <Heading as="h2">从一个问题开始</Heading>
                  <p>输入产品功能、操作目标或遇到的问题。</p>
                </div>
              ) : null}

              <div className={styles.results}>
                {results.map((result, index) => {
                  const document = result.document ?? {};
                  const snippet =
                    result.highlights?.[0]?.snippet ??
                    document.content?.slice(0, 180) ??
                    '';
                  const tags = document.tags ?? [];

                  return (
                    <article key={`${document.url ?? 'result'}-${index}`} className={styles.resultRow}>
                      <Link to={document.url ?? '/docs/getting-started/overview'}>
                        <div className={styles.resultTopline}>
                          <span>{document.section ?? '帮助文档'}</span>
                          {document.version ? <small>{document.version}</small> : null}
                        </div>
                        <Heading as="h2">{document.title ?? '未命名文档'}</Heading>
                        <p>{snippet}</p>
                        {tags.length > 0 ? (
                          <div className={styles.tagRow}>
                            {tags.slice(0, 4).map((tag) => (
                              <span key={tag}>{tag}</span>
                            ))}
                          </div>
                        ) : null}
                        <ChevronRight className={styles.resultArrow} aria-hidden="true" size={21} />
                      </Link>
                    </article>
                  );
                })}
              </div>
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
