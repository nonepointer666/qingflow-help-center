import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  helpCenterSidebar: [
    {
      type: 'category',
      label: 'Getting Started',
      items: [
        'getting-started/overview',
        'getting-started/content-workflow',
      ],
    },
    {
      type: 'category',
      label: 'Product Guides',
      items: [
        'product-guides/end-user/navigation-and-search',
        'product-guides/workflow/approval-center',
      ],
    },
    {
      type: 'category',
      label: 'Administration',
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
      label: 'Releases',
      items: ['releases/phase-1-scope'],
    },
    {
      type: 'category',
      label: 'Operations',
      items: ['operations/search-and-release-runbook'],
    },
  ],
};

export default sidebars;
