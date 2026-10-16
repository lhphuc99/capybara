import { defineConfig } from 'vite';
import { NPM_PUBLISHED } from './src/config';

export default defineConfig({
  // Relative, so the same build works under /capybara/ on GitHub Pages, in `vite preview` and on a custom domain.
  base: './',
  // 5173 is example-web and 5174 the UI.
  server: { port: 5175, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  plugins: [
    {
      name: 'capybara-npm-status',
      transformIndexHtml: (html) => (NPM_PUBLISHED ? html : html.replace('<html lang="en"', '<html lang="en" data-npm="pending"')),
    },
  ],
});
