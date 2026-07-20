import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const isGitHubPages = process.env.GITHUB_PAGES === 'true';
const siteUrl =
  process.env.DOCS_URL ??
  (isGitHubPages ? 'https://nonepointer666.github.io' : 'https://help.qingflow.com');
const baseUrl =
  process.env.DOCS_BASE_URL ??
  (isGitHubPages ? '/qingflow-help-center/' : '/');

const config: Config = {
  title: '轻流帮助中心',
  tagline: '轻流产品使用指南、最佳实践与开发文档',
  favicon: 'img/qingflow-favicon.png',
  future: {
    v4: true,
  },
  url: siteUrl,
  baseUrl,
  organizationName: 'nonepointer666',
  projectName: 'qingflow-help-center',
  onBrokenLinks: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },
  i18n: {
    defaultLocale: 'zh-CN',
    locales: ['zh-CN'],
  },
  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: 'docs',
          sidebarPath: './sidebars.ts',
          editUrl:
            process.env.GITHUB_EDIT_URL ??
            'https://github.com/nonepointer666/qingflow-help-center/tree/main/',
          showLastUpdateTime: false,
          showLastUpdateAuthor: false,
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],
  themeConfig: {
    image: 'img/qingflow-social-card.svg',
    colorMode: {
      defaultMode: 'light',
      disableSwitch: false,
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: '轻流帮助中心',
      logo: {
        alt: '轻流 Logo',
        src: 'img/qingflow-logo.png',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'helpCenterSidebar',
          position: 'left',
          label: '产品指南',
        },
        {to: '/docs/api/overview', label: 'API', position: 'left'},
        {to: '/docs/releases/phase-1-scope', label: '更新日志', position: 'left'},
        {to: '/search', label: '搜索', position: 'right'},
        {
          href: 'https://github.com/nonepointer666/qingflow-help-center',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'light',
      links: [
        {
          title: '产品使用',
          items: [
            {
              label: '快速开始',
              to: '/docs/getting-started/overview',
            },
            {
              label: '流程与审批',
              to: '/docs/product-guides/workflow/approval-center',
            },
            {label: '搜索文档', to: '/search'},
          ],
        },
        {
          title: '管理与运维',
          items: [
            {
              label: '部署拓扑',
              to: '/docs/admin/deployment-topology',
            },
            {
              label: '内容治理',
              to: '/docs/admin/content-governance',
            },
            {
              label: '搜索与发布',
              to: '/docs/operations/search-and-release-runbook',
            },
          ],
        },
        {
          title: '开发资源',
          items: [
            {
              label: 'API 概览',
              to: '/docs/api/overview',
            },
            {
              label: 'GitHub',
              href: 'https://github.com/nonepointer666/qingflow-help-center',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Qingflow`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.oneDark,
    },
  } satisfies Preset.ThemeConfig,
  customFields: {
    repoUrl:
      process.env.GITHUB_EDIT_URL ??
      'https://github.com/nonepointer666/qingflow-help-center/tree/main/',
    typesense: {
      host: process.env.TYPESENSE_HOST ?? '',
      searchApiKey: process.env.TYPESENSE_SEARCH_API_KEY ?? '',
      collection: process.env.TYPESENSE_COLLECTION ?? 'qingflow_help_docs',
      enableSemantic: process.env.TYPESENSE_ENABLE_SEMANTIC === 'true',
    },
  },
};

export default config;
