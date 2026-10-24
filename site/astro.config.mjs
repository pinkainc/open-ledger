// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Canonical host (plan W7). Nothing is deployed from this repo until step D1.
export default defineConfig({
  site: 'https://open-ledger.mpt.hr',
  trailingSlash: 'always',
  i18n: {
    locales: ['en', 'hr'],
    defaultLocale: 'en',
    routing: {
      // Both languages live under a prefix (/en/, /hr/); `/` is src/pages/index.astro,
      // which picks the language from the browser.
      prefixDefaultLocale: true,
      redirectToDefaultLocale: false,
    },
  },
  integrations: [
    sitemap({
      filter: (page) => page !== 'https://open-ledger.mpt.hr/',
      i18n: { defaultLocale: 'en', locales: { en: 'en', hr: 'hr' } },
    }),
  ],
});
