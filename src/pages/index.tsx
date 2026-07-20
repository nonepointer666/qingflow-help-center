import type {FormEvent, ReactNode} from 'react';
import {useEffect, useRef, useState} from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import {
  ArrowRight,
  BookOpen,
  Boxes,
  ChevronRight,
  CircleHelp,
  Code2,
  Command,
  FileInput,
  GitBranch,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

import styles from './index.module.css';

type Guide = {
  title: string;
  description: string;
  to: string;
  icon: LucideIcon;
  tone: 'green' | 'coral' | 'blue' | 'yellow' | 'mint' | 'ink';
  keywords: string;
};

const guides: Guide[] = [
  {
    title: '快速开始',
    description: '认识轻流、了解核心概念，完成第一次应用搭建。',
    to: '/docs/getting-started/overview',
    icon: Sparkles,
    tone: 'green',
    keywords: '入门 开始 登录 创建应用 新手',
  },
  {
    title: '应用与数据',
    description: '组织表单、导入数据，并为团队建立清晰的数据入口。',
    to: '/docs/getting-started/content-workflow',
    icon: Boxes,
    tone: 'coral',
    keywords: '应用 表单 数据 导入 markdown 内容',
  },
  {
    title: '流程与审批',
    description: '设计业务流程、配置审批节点并追踪处理进度。',
    to: '/docs/product-guides/workflow/approval-center',
    icon: Workflow,
    tone: 'blue',
    keywords: '流程 审批 节点 待办 自动化',
  },
  {
    title: '成员与权限',
    description: '管理成员、角色和内容边界，让协作安全可控。',
    to: '/docs/admin/content-governance',
    icon: ShieldCheck,
    tone: 'yellow',
    keywords: '成员 权限 角色 管理员 安全',
  },
  {
    title: '开放平台',
    description: '通过 API 和集成能力连接现有系统与业务数据。',
    to: '/docs/api/overview',
    icon: Code2,
    tone: 'mint',
    keywords: 'API 开发 接口 集成 webhook',
  },
  {
    title: '部署与运维',
    description: '了解私有化部署拓扑、发布流程和日常维护。',
    to: '/docs/admin/deployment-topology',
    icon: Settings2,
    tone: 'ink',
    keywords: '私有化 部署 运维 版本 发布',
  },
];

const popularQuestions = [
  {
    title: '如何快速找到需要处理的审批任务？',
    category: '流程与审批',
    to: '/docs/product-guides/workflow/approval-center',
  },
  {
    title: 'Markdown 文档如何进入内容发布流程？',
    category: '内容管理',
    to: '/docs/getting-started/content-workflow',
  },
  {
    title: '私有化部署需要准备哪些基础资源？',
    category: '部署与运维',
    to: '/docs/admin/deployment-topology',
  },
  {
    title: '如何规划帮助中心的目录与版本？',
    category: '内容治理',
    to: '/docs/admin/content-governance',
  },
];

function HelpSearch() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const matchedGuides = normalizedQuery
    ? guides.filter((guide) =>
        `${guide.title} ${guide.description} ${guide.keywords}`
          .toLowerCase()
          .includes(normalizedQuery),
      )
    : [];

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;
      const isCommand =
        (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';

      if (isCommand || (event.key === '/' && !isTyping)) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (!query.trim()) {
      event.preventDefault();
      inputRef.current?.focus();
    }
  }

  return (
    <div className={styles.searchShell}>
      <form className={styles.searchBox} action="/search" onSubmit={handleSubmit}>
        <Search aria-hidden="true" size={22} strokeWidth={2} />
        <input
          ref={inputRef}
          type="search"
          name="q"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索功能、操作或问题"
          aria-label="搜索帮助文档"
          autoComplete="off"
        />
        <span className={styles.shortcut} aria-hidden="true">
          <Command size={13} />K
        </span>
        <button type="submit" aria-label="提交搜索">
          <ArrowRight size={19} />
        </button>
      </form>

      {normalizedQuery ? (
        <div className={styles.searchMatches} aria-live="polite">
          {matchedGuides.length > 0 ? (
            matchedGuides.slice(0, 4).map((guide) => {
              const Icon = guide.icon;
              return (
                <Link key={guide.title} to={guide.to} className={styles.searchMatch}>
                  <Icon aria-hidden="true" size={18} />
                  <span>
                    <strong>{guide.title}</strong>
                    <small>{guide.description}</small>
                  </span>
                  <ChevronRight aria-hidden="true" size={17} />
                </Link>
              );
            })
          ) : (
            <Link className={styles.searchAll} to={`/search?q=${encodeURIComponent(query)}`}>
              <Search aria-hidden="true" size={18} />
              搜索“{query}”的全部结果
              <ChevronRight aria-hidden="true" size={17} />
            </Link>
          )}
        </div>
      ) : null}
    </div>
  );
}

function GuideCard({guide}: {guide: Guide}) {
  const Icon = guide.icon;
  return (
    <Link className={styles.guideCard} to={guide.to} data-tone={guide.tone}>
      <span className={styles.guideIcon}>
        <Icon aria-hidden="true" size={22} />
      </span>
      <span className={styles.guideContent}>
        <Heading as="h3">{guide.title}</Heading>
        <span>{guide.description}</span>
      </span>
      <ChevronRight className={styles.guideArrow} aria-hidden="true" size={20} />
    </Link>
  );
}

export default function Home(): ReactNode {
  return (
    <Layout
      title="轻流帮助中心"
      description="轻流产品帮助中心：查找产品操作、流程审批、权限管理、开放平台与私有化部署文档。">
      <header className={styles.homeHero}>
        <div className={styles.heroPattern} aria-hidden="true" />
        <div className="container">
          <div className={styles.heroContent}>
            <p className={styles.eyebrow}>
              <BookOpen aria-hidden="true" size={16} />
              产品帮助中心
            </p>
            <Heading as="h1">轻流帮助中心</Heading>
            <p className={styles.heroLead}>
              从搭建第一个应用到管理复杂业务流程，在这里找到清晰、可靠的答案。
            </p>
            <HelpSearch />
            <nav className={styles.quickLinks} aria-label="常用入口">
              <span>常用入口</span>
              <Link to="/docs/getting-started/overview">新手入门</Link>
              <Link to="/docs/product-guides/workflow/approval-center">审批中心</Link>
              <Link to="/docs/api/overview">API 文档</Link>
              <Link to="/docs/releases/phase-1-scope">更新日志</Link>
            </nav>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.guideSection}>
          <div className="container">
            <div className={styles.sectionHeader}>
              <div>
                <p className={styles.sectionLabel}>浏览文档</p>
                <Heading as="h2">你想了解什么？</Heading>
              </div>
              <Link to="/docs/getting-started/overview" className={styles.textLink}>
                查看全部文档 <ArrowRight aria-hidden="true" size={17} />
              </Link>
            </div>
            <div className={styles.guideGrid}>
              {guides.map((guide) => (
                <GuideCard key={guide.title} guide={guide} />
              ))}
            </div>
          </div>
        </section>

        <section className={styles.questionSection}>
          <div className="container">
            <div className={styles.questionLayout}>
              <div className={styles.questionIntro}>
                <span className={styles.introIcon}>
                  <CircleHelp aria-hidden="true" size={24} />
                </span>
                <p className={styles.sectionLabel}>高频问题</p>
                <Heading as="h2">大家都在看</Heading>
                <p>从最常见的使用场景开始，快速解决眼前的问题。</p>
              </div>
              <div className={styles.questionList}>
                {popularQuestions.map((question, index) => (
                  <Link key={question.title} to={question.to} className={styles.questionRow}>
                    <span className={styles.questionIndex}>0{index + 1}</span>
                    <span className={styles.questionText}>
                      <strong>{question.title}</strong>
                      <small>{question.category}</small>
                    </span>
                    <ArrowRight aria-hidden="true" size={18} />
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className={styles.supportSection}>
          <div className="container">
            <div className={styles.supportBar}>
              <div className={styles.supportCopy}>
                <span className={styles.supportIcon}>
                  <GitBranch aria-hidden="true" size={22} />
                </span>
                <div>
                  <Heading as="h2">没有找到答案？</Heading>
                  <p>查看完整文档目录，或从内容发布与维护指南开始。</p>
                </div>
              </div>
              <div className={styles.supportActions}>
                <Link className={styles.secondaryButton} to="/docs/getting-started/overview">
                  <BookOpen aria-hidden="true" size={18} /> 浏览目录
                </Link>
                <Link className={styles.primaryButton} to="/docs/getting-started/content-workflow">
                  <FileInput aria-hidden="true" size={18} /> 内容发布指南
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
