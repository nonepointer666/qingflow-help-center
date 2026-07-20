import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';

import styles from './index.module.css';

const featureCards = [
  {
    title: '文档资产回到 Git',
    body: '内容、图片、版本记录全部保存在 GitHub，避免被单一平台锁定。',
  },
  {
    title: '面向帮助中心的目录治理',
    body: '按产品、角色、模块、版本和语言组织内容，结构清晰且适合长期迭代。',
  },
  {
    title: '自建搜索与 AI 检索扩展',
    body: 'Phase 1 先接入 Typesense 基础搜索骨架，后续可直接升级 hybrid search 与 AI 问答。',
  },
];

const tracks = [
  {
    title: '新手入门',
    description: '帮助新客户在最短时间内找到核心路径、登录方式和常见入口。',
    to: '/docs/getting-started/overview',
  },
  {
    title: '产品使用',
    description: '面向终端用户、审批人和业务管理员的操作指引与最佳实践。',
    to: '/docs/product-guides/end-user/navigation-and-search',
  },
  {
    title: '实施与运维',
    description: '记录部署拓扑、版本节奏、搜索索引和发布流程，支持私有化场景。',
    to: '/docs/admin/deployment-topology',
  },
];

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={styles.heroBanner}>
      <div className={clsx('container', styles.heroGrid)}>
        <div className={styles.heroCopy}>
          <p className={styles.kicker}>Phase 1 help center blueprint</p>
          <Heading as="h1" className={styles.heroTitle}>
            {siteConfig.title}
          </Heading>
          <p className={styles.heroSubtitle}>{siteConfig.tagline}</p>
          <div className={styles.buttons}>
            <Link className="button button--primary button--lg" to="/docs/getting-started/overview">
              查看文档结构
            </Link>
            <Link className="button button--secondary button--lg" to="/search">
              体验搜索入口
            </Link>
          </div>
          <div className={styles.metaStrip}>
            <span>GitHub 驱动</span>
            <span>Docusaurus 主站</span>
            <span>Typesense 搜索</span>
            <span>支持私有化</span>
          </div>
        </div>
        <div className={styles.heroPanel}>
          <div className={styles.panelLabel}>本期交付</div>
          <Heading as="h2" className={styles.panelTitle}>
            低成本上线一套真正可演进的帮助中心底座
          </Heading>
          <ul className={styles.panelList}>
            <li>统一文档入口、品牌化首页与阅读体验</li>
            <li>Markdown 内容结构与版本治理约定</li>
            <li>GitHub PR 审核与 CI 验证基础链路</li>
            <li>Typesense 搜索接入位与索引脚本</li>
          </ul>
        </div>
      </div>
    </header>
  );
}

function HomepageOverview() {
  return (
    <section className={styles.section}>
      <div className="container">
        <div className={styles.sectionHeading}>
          <p className={styles.sectionEyebrow}>What Phase 1 solves</p>
          <Heading as="h2">先把主站、内容资产和搜索链路打稳</Heading>
          <p>
            这一期不追求一次把后台、AI 问答和导出体系全部做满，而是先让帮助中心具备稳定的信息架构和上线能力。
          </p>
        </div>
        <div className={styles.featureGrid}>
          {featureCards.map((card) => (
            <article key={card.title} className={styles.featureCard}>
              <Heading as="h3">{card.title}</Heading>
              <p>{card.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function HomepageTracks() {
  return (
    <section className={styles.sectionAlt}>
      <div className="container">
        <div className={styles.sectionHeading}>
          <p className={styles.sectionEyebrow}>Information architecture</p>
          <Heading as="h2">内容按用户任务组织，不再按页面自然生长</Heading>
        </div>
        <div className={styles.trackGrid}>
          {tracks.map((track) => (
            <Link key={track.title} className={styles.trackCard} to={track.to}>
              <Heading as="h3">{track.title}</Heading>
              <p>{track.description}</p>
              <span>查看内容</span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function HomepageCallout() {
  return (
    <section className={styles.section}>
      <div className="container">
        <div className={styles.callout}>
          <div>
            <p className={styles.sectionEyebrow}>Phase 2 ready</p>
            <Heading as="h2">后续可无缝升级到 AI 搜索、在线编辑和自动 PDF 导出</Heading>
            <p>
              这套仓库已经为 Typesense、版本化和 GitHub 工作流预留扩展位，后续加功能不会推倒重来。
            </p>
          </div>
          <Link
            className="button button--primary button--lg"
            to="/docs/operations/search-and-release-runbook">
            查看实施说明
          </Link>
        </div>
      </div>
    </section>
  );
}

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout
      title={siteConfig.title}
      description="Qingflow 帮助中心 Phase 1，使用 GitHub + Docusaurus + Typesense 的自建方案。">
      <HomepageHeader />
      <main>
        <HomepageOverview />
        <HomepageTracks />
        <HomepageCallout />
      </main>
    </Layout>
  );
}
