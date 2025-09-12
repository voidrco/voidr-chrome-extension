import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    manifest_version: 3,
    name: 'Voidr Testing Assistant v2',
    version: '0.0.1',
    description: 'Widget for test planning and bug reporting directly on web pages',
    action: {
      default_title: 'Voidr Testing Assistant',
    },
    permissions: ['activeTab', 'storage', 'scripting', 'notifications'],
    host_permissions: ['http://*/*', 'https://*/*'],
    icons: {
      '16': 'icons/icon16.png',
      '32': 'icons/icon32.png',
      '48': 'icons/icon48.png',
      '128': 'icons/icon128.png',
    },
    web_accessible_resources: [
      {
        resources: ['assets/*', 'icons/*'],
        matches: ['<all_urls>'],
      },
    ],
  },
});
