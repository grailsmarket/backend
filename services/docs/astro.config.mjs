import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import tailwind from '@astrojs/tailwind';

// https://astro.build/config
export default defineConfig({
  integrations: [
    mdx(),
    tailwind()
  ],
  site: 'https://docs.grails.market',
  markdown: {
    shikiConfig: {
      theme: 'github-dark',
      wrap: true
    }
  },
  server: {
    host: '0.0.0.0'
  }
});
