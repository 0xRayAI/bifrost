import { themes as prismThemes } from 'prism-react-renderer';

const config = {
  title: 'Bifrost',
  tagline: 'The live board.',
  url: 'https://bifrost.0xray.dev',
  baseUrl: '/',
  organizationName: '0xRayAI',
  projectName: 'bifrost',
  onBrokenLinks: 'throw',
  markdown: { hooks: { onBrokenMarkdownLinks: 'throw' } },
  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.js',
          routeBasePath: '/',
          editUrl: 'https://github.com/0xRayAI/bifrost/tree/main/docs-site/',
        },
        blog: false,
        theme: { customCss: './src/css/custom.css' },
      },
    ],
  ],
  themeConfig: {
    colorMode: { defaultMode: 'dark', respectPrefersColorScheme: true },
    navbar: {
      title: 'Bifrost',
      items: [
        { href: 'https://bifrost.0xray.dev', label: 'Board', position: 'right' },
        { href: 'https://github.com/0xRayAI/bifrost', label: 'GitHub', position: 'right' },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Board',
          items: [
            { label: 'Live board', href: 'https://bifrost.0xray.dev' },
            { label: 'Health', href: 'https://bifrost.0xray.dev/healthz' },
          ],
        },
      ],
    },
    prism: { theme: prismThemes.github, darkTheme: prismThemes.dracula },
  },
};

export default config;
