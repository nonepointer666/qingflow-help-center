import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  helpCenterSidebar: [
    {
      type: 'category',
      label: '快速开始',
      items: [
        'getting-started/overview',
        'getting-started/no-code-introduction',
        'getting-started/content-workflow',
      ],
    },
    {
      type: 'category',
      label: '产品指南',
      items: [
        'product-guides/end-user/navigation-and-search',
        'product-guides/workflow/approval-center',
      ],
    },
    {
      type: 'category',
      label: '管理与部署',
      items: [
        'admin/deployment-topology',
        'admin/content-governance',
      ],
    },
    {
      type: 'category',
      label: 'API',
      items: ['api/overview'],
    },
    {
      type: 'category',
      label: '更新日志',
      items: ['releases/phase-1-scope'],
    },
    {
      type: 'category',
      label: '运维手册',
      items: ['operations/search-and-release-runbook'],
    },
  ],
};

export default sidebars;
