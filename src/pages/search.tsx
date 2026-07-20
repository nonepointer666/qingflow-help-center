import type {FormEvent, ReactNode} from 'react';
import {useEffect, useState} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';

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

export default function SearchPage(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
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
  const [error, setError] = useState('');

  const typesense = customFields.typesense ?? {};
  const canSearch = Boolean(typesense.host && typesense.searchApiKey);

  async function runSearch(nextQuery: string) {
    if (!nextQuery.trim()) {
      setResults([]);
      setState('idle');
      setError('');
      return;
    }

    if (!canSearch) {
      setState('error');
      setError('当前环境还没有配置 Typesense 搜索地址和 Search API Key。');
      return;
    }

    setState('loading');
    setError('');

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
              q: nextQuery,
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
        throw new Error(`Typesense responded with ${response.status}`);
      }

      const payload = await response.json();
      const hits = payload.results?.[0]?.hits ?? [];
      setResults(hits);
      setState('ready');
    } catch (searchError) {
      setState('error');
      setResults([]);
      setError(
        searchError instanceof Error
          ? searchError.message
          : '搜索服务暂时不可用，请稍后重试。',
      );
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const nextQuery = new URLSearchParams(window.location.search).get('q') ?? '';
    setQuery(nextQuery);
    if (nextQuery) {
      void runSearch(nextQuery);
    }
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (typeof window !== 'undefined') {
      const nextUrl = query.trim() ? `/search?q=${encodeURIComponent(query.trim())}` : '/search';
      window.history.replaceState({}, '', nextUrl);
    }
    void runSearch(query);
  }

  return (
    <Layout title="Search" description="Search the Qingflow help center with Typesense.">
      <main className={styles.searchPage}>
        <div className="container">
          <div className={styles.hero}>
            <p className={styles.eyebrow}>Search experience</p>
            <Heading as="h1">为帮助中心预留的自建搜索入口</Heading>
            <p className={styles.heroText}>
              Phase 1 已经准备好前端搜索体验和 Typesense 接入位。接上 Search API Key 后，可以先上线 typo tolerant
              搜索，后续再升级自然语言与 hybrid search。
            </p>
            <form className={styles.searchForm} onSubmit={handleSubmit}>
              <input
                className={styles.searchInput}
                type="search"
                placeholder="例如：如何配置审批流程权限"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button className={clsx('button', 'button--primary', 'button--lg')} type="submit">
                搜索
              </button>
            </form>
            {!canSearch ? (
              <div className={styles.notice}>
                当前为仓库骨架状态。请在部署环境中设置 `TYPESENSE_HOST` 与 `TYPESENSE_SEARCH_API_KEY`。
              </div>
            ) : null}
          </div>

          <div className={styles.suggestions}>
            <span>推荐试试：</span>
            <button type="button" onClick={() => setQuery('如何导入 markdown 文档')}>
              如何导入 markdown 文档
            </button>
            <button type="button" onClick={() => setQuery('审批中心怎么配置')}>
              审批中心怎么配置
            </button>
            <button type="button" onClick={() => setQuery('私有化部署拓扑')}>
              私有化部署拓扑
            </button>
          </div>

          <section className={styles.results}>
            {state === 'loading' ? <p>正在查询 Typesense 搜索服务...</p> : null}
            {state === 'error' ? <p className={styles.error}>{error}</p> : null}
            {state === 'ready' && results.length === 0 ? <p>没有找到结果，可以换一种自然语言描述试试。</p> : null}
            {results.map((result, index) => {
              const document = result.document ?? {};
              const snippet =
                result.highlights?.[0]?.snippet ??
                document.content?.slice(0, 160) ??
                '';
              const tags = document.tags ?? [];

              return (
                <article
                  key={`${document.url ?? 'result'}-${index}`}
                  className={styles.resultCard}>
                  <div className={styles.resultMeta}>
                    <span>{document.product ?? 'help-center'}</span>
                    <span>{document.version ?? 'current'}</span>
                    <span>{document.language ?? 'zh-CN'}</span>
                  </div>
                  <Heading as="h2" className={styles.resultTitle}>
                    <Link to={document.url ?? '/docs/getting-started/overview'}>
                      {document.title ?? '未命名文档'}
                    </Link>
                  </Heading>
                  <p className={styles.resultSection}>
                    {document.section ?? 'General'}
                  </p>
                  <p className={styles.resultSnippet}>{snippet}</p>
                  {tags.length > 0 ? (
                    <div className={styles.tagRow}>
                      {tags.map((tag) => (
                        <span key={tag}>{tag}</span>
                      ))}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </section>
        </div>
      </main>
    </Layout>
  );
}
