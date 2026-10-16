# Capybara website

The landing page at https://capybara-devtools.vercel.app: what Capybara does, how to start, and downloads. A static page built with Vite, outside the npm workspaces, with its own lockfile so Vercel installs only what the page needs.

```bash
npm install
npm run dev            # http://localhost:5175
npm test               # download links and system detection
npm run build          # dist/
```

## Downloads

The download section reads the latest GitHub release in the visitor's browser, so a new release shows up without redeploying. Files are matched by name (`Capybara-<version>-<os>-<arch>.<ext>`, as electron-builder names them), and the visitor's system picks the main button. Without JavaScript, or when GitHub can't be reached, the links go to the releases page.

Until the packages are on npm, commands that need them carry a "Coming to npm" tag. Set `NPM_PUBLISHED` in `src/config.ts` to `true` once they are published.

## Screenshots

The screenshots show the real Capybara UI with made-up apps (`scripts/demo-data.mjs`). After changing the UI, build the product from the repo root (`npm run build`), then run this here on a Mac with Google Chrome:

```bash
npm run screenshots    # all scenes and public/og.png; or name scenes: network why logs storage og
```

The "why" scene needs port 4000 free for its demo API.

## Deploying

Vercel project `capybara-devtools`, with its Root Directory set to `website`. Settings are in `vercel.json`: Vercel runs the tests before building and skips commits that don't touch this folder.
