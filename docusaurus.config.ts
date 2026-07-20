import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Qingflow Help Center',
  tagline: '面向客户、实施团队与开发者的统一帮助文档站',
  favicon: 'img/favicon.ico',
  future: {
    v4: true,
  },
  url: 'https://help.qingflow.com',
  baseUrl: '/',
  organizationName: 'qingflow',
  projectName: 'help-center',
  onBrokenLinks: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },
  i18n: {
    defaultLocale: 'zh-CN',
    locales: ['zh-CN', 'en'],
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
            'https://github.com/qingflow/help-center/tree/main/',
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
      title: 'Qingflow Docs',
      logo: {
        alt: 'Qingflow Logo',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'helpCenterSidebar',
          position: 'left',
          label: 'Docs',
        },
        {to: '/docs/api/overview', label: 'API', position: 'left'},
        {to: '/docs/releases/phase-1-scope', label: 'Releases', position: 'left'},
        {to: '/search', label: 'Search', position: 'right'},
        {
          href: 'https://github.com/qingflow/help-center',
          label: 'GitHub',
          position: 'right',
        },
        {
          type: 'localeDropdown',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'light',
      links: [
        {
          title: 'Product',
          items: [
            {
              label: 'Getting Started',
              to: '/docs/getting-started/overview',
            },
            {
              label: 'Workflow Guides',
              to: '/docs/product-guides/workflow/approval-center',
            },
            {label: 'Search', to: '/search'},
          ],
        },
        {
          title: 'Operations',
          items: [
            {
              label: 'Deployment Topology',
              to: '/docs/admin/deployment-topology',
            },
            {
              label: 'Content Governance',
              to: '/docs/admin/content-governance',
            },
            {
              label: 'Search Runbook',
              to: '/docs/operations/search-and-release-runbook',
            },
          ],
        },
        {
          title: 'Resources',
          items: [
            {
              label: 'API Overview',
              to: '/docs/api/overview',
            },
            {
              label: 'GitHub',
              href: 'https://github.com/qingflow/help-center',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Qingflow. Built with Docusaurus and prepared for self-hosted delivery.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.oneDark,
    },
  } satisfies Preset.ThemeConfig,
  customFields: {
    repoUrl:
      process.env.GITHUB_EDIT_URL ??
      'https://github.com/qingflow/help-center/tree/main/',
    typesense: {
      host: process.env.TYPESENSE_HOST ?? '',
      searchApiKey: process.env.TYPESENSE_SEARCH_API_KEY ?? '',
      collection: process.env.TYPESENSE_COLLECTION ?? 'qingflow_help_docs',
      enableSemantic: process.env.TYPESENSE_ENABLE_SEMANTIC === 'true',
    },
  },
};

export default config;
