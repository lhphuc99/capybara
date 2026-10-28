import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { detectProject, findPackageManager, resolveProjectDir, runSetupGuide, setupGuide, type AppProject } from '../src/setup-guide.js';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A project folder with these files, objects written as JSON. A .git folder ends the lockfile lookup there, as in a repository. */
function project(files: Record<string, string | object>): string {
  const root = mkdtempSync(join(tmpdir(), 'capybara-guide-'));
  roots.push(root);
  mkdirSync(join(root, '.git'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

function app(dir: string): AppProject {
  const detection = detectProject(dir);
  if (detection.type !== 'app') throw new Error(`Expected an app, got ${detection.type}`);
  return detection.project;
}

const guide = (dir: string, via: 'mcp' | 'cli' = 'mcp') => setupGuide(dir, { version: '0.3.1', via });

const VITE_HTML = '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>';

describe('setup guide', () => {
  it('finds a Vite app, its entry, package manager and state libraries', () => {
    const dir = project({
      'package.json': {
        name: 'shop',
        scripts: { dev: 'vite' },
        dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0', zustand: '^5.0.0', '@tanstack/react-query': '^5.0.0', swr: '^2.0.0' },
        devDependencies: { vite: '^8.0.0', typescript: '^5.0.0' },
      },
      'tsconfig.json': {},
      'index.html': VITE_HTML,
      'src/main.tsx': '',
      'pnpm-lock.yaml': '',
    });
    expect(app(dir)).toMatchObject({
      kind: 'vite',
      entry: 'src/main.tsx',
      typescript: true,
      manager: { name: 'pnpm', root: dir },
      state: ['zustand', 'tanstack-query', 'swr', 'context'],
    });
    const text = guide(dir);
    expect(text).toContain('Vite app, pnpm, TypeScript');
    expect(text).toContain('```sh\npnpm add @capybara-devtools/web\n```');
    expect(text).toContain("Create src/capybara.ts:\n\n```ts\nimport { init } from '@capybara-devtools/web';\n\nif (import.meta.env.DEV) init({ appName: 'shop' });\n```");
    expect(text).toContain("Make this the first line of src/main.tsx, above every other import:\n\n```ts\nimport './capybara';\n```");
    expect(text).toContain("if (import.meta.env.DEV) watchZustand(useCartStore, { name: 'cart' });");
    expect(text).toContain('if (import.meta.env.DEV) watchQueryClient(queryClient);');
    expect(text).toContain('  watchSWR(SWRConfig);');
    expect(text).toContain('(`pnpm dev`)');
    expect(text).toContain('Call list_sessions');
    expect(text).not.toContain('**Redux');
    expect(text).toContain('logs and requests made before it are missed, and Redux Toolkit');
    expect(text).not.toContain('claude mcp add');
  });

  it('adds a line for XState actors and MobX stores', () => {
    const dir = project({
      'package.json': { name: 'flows', dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0', xstate: '^5.0.0', mobx: '^7.0.0' }, devDependencies: { vite: '^8.0.0' } },
      'index.html': VITE_HTML,
      'src/main.tsx': '',
    });
    expect(app(dir).state).toEqual(['xstate', 'mobx', 'context']);
    const text = guide(dir);
    expect(text).toContain("import { watchXState } from '@capybara-devtools/web';\n\nif (import.meta.env.DEV) watchXState(actor);");
    expect(text).toContain("import { watchMobX } from '@capybara-devtools/web';\nimport * as mobx from 'mobx';\n\nif (import.meta.env.DEV) watchMobX(cartStore, mobx, { name: 'cart' });");
  });

  it('uses the packageManager field first, and tells Yarn 1 from later versions', () => {
    const yarn1 = project({ 'package.json': { dependencies: { vite: '*' } }, 'yarn.lock': '# yarn lockfile v1\n' });
    expect(findPackageManager(yarn1)).toMatchObject({ name: 'yarn', berry: false });
    expect(guide(yarn1)).not.toContain('npmMinimalAgeGate');

    const berry = project({ 'package.json': { dependencies: { vite: '*' } }, 'yarn.lock': '__metadata:\n  version: 8\n' });
    expect(findPackageManager(berry)).toMatchObject({ name: 'yarn', berry: true });
    expect(guide(berry)).toContain('npmMinimalAgeGate');
    expect(guide(berry)).toContain('`yarn up @capybara-devtools/web`');

    const yarnrc = project({ 'package.json': { dependencies: { vite: '*' } }, 'yarn.lock': '', '.yarnrc.yml': 'nodeLinker: pnp\n' });
    expect(findPackageManager(yarnrc)).toMatchObject({ name: 'yarn', berry: true });

    const declared = project({ 'package.json': { packageManager: 'bun@1.2.0', dependencies: { vite: '*' } }, 'package-lock.json': '{}' });
    expect(findPackageManager(declared)).toMatchObject({ name: 'bun' });
    expect(guide(declared)).toContain('bun add @capybara-devtools/web');

    const none = project({ 'package.json': { dependencies: { vite: '*' } } });
    expect(findPackageManager(none)).toEqual({ name: 'npm', berry: false, root: none });
  });

  it('installs into a workspace app from where its package manager wants it', () => {
    const npm = project({
      'package.json': { workspaces: ['apps/*'] },
      'package-lock.json': '{}',
      'apps/web/package.json': { name: 'web', dependencies: { vite: '*' } },
      'apps/web/index.html': VITE_HTML,
      'apps/web/src/main.tsx': '',
    });
    expect(guide(join(npm, 'apps/web'))).toContain(`Run in ${npm}:\n\n\`\`\`sh\nnpm install @capybara-devtools/web -w apps/web\n\`\`\``);

    const pnpm = project({
      'package.json': {},
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
      'apps/web/package.json': { dependencies: { vite: '*' } },
    });
    expect(guide(join(pnpm, 'apps/web'))).toContain(`Run in ${join(pnpm, 'apps/web')}:\n\n\`\`\`sh\npnpm add @capybara-devtools/web\n\`\`\``);
  });

  it('lists the apps of a monorepo root instead', () => {
    const dir = project({
      'package.json': { workspaces: { packages: ['apps/*', 'packages/*'] } },
      'apps/web/package.json': { dependencies: { vite: '*' } },
      'apps/web/index.html': VITE_HTML,
      'apps/mobile/package.json': { dependencies: { expo: '*', 'react-native': '*' } },
      'apps/mobile/app.json': {},
      // A library that names react-dom for its tests is not an app.
      'packages/ui/package.json': { devDependencies: { 'react-dom': '*' } },
      'packages/ui/src/index.ts': '',
    });
    expect(detectProject(dir)).toEqual({
      type: 'workspace',
      dir,
      apps: [
        { dir: join(dir, 'apps/mobile'), kind: 'expo' },
        { dir: join(dir, 'apps/web'), kind: 'vite' },
      ],
    });
    expect(guide(dir)).toBe(
      `${dir} is the root of a monorepo. Capybara goes into an app, so call get_setup_guide again with projectDir set to one of these:\n\n` +
        `- ${join(dir, 'apps/mobile')}: Expo app\n- ${join(dir, 'apps/web')}: Vite app`,
    );

    const pnpm = project({
      'package.json': {},
      'pnpm-workspace.yaml': 'packages:\n  - "apps/*" # the apps\n  - tools/site\ncatalog:\n  react: ^19.0.0\n',
      'apps/admin/package.json': { dependencies: { next: '*' } },
      'apps/admin/next.config.ts': '',
      'tools/site/package.json': { dependencies: { 'react-dom': '*' } },
      'tools/site/public/index.html': '',
    });
    const found = detectProject(pnpm);
    expect(found.type === 'workspace' && found.apps.map((entry) => entry.kind)).toEqual(['next', 'web']);
  });

  it('puts init() in instrumentation-client for Next.js 15.3 and later', () => {
    const dir = project({
      'package.json': { name: 'store', scripts: { dev: 'next dev' }, dependencies: { next: '16.4.2', react: '*', '@reduxjs/toolkit': '*' } },
      'tsconfig.json': {},
      'app/page.tsx': '',
    });
    expect(app(dir).next).toEqual({ version: '16.4.2', instrumentation: true, base: '', existing: undefined, appRouter: true });
    const text = guide(dir);
    expect(text).toContain(
      "Create instrumentation-client.ts at the project root:\n\n```ts\nimport { init } from '@capybara-devtools/web';\n\nif (process.env.NODE_ENV === 'development') init({ appName: 'store' });\n```",
    );
    expect(text).not.toContain('Import it first');
    expect(text).toContain('**Redux Toolkit**: nothing to add.');
    expect(text).toContain('server components and route handlers are not');

    const src = project({ 'package.json': { dependencies: { next: '^15.3.0' } }, 'src/app/page.js': '' });
    expect(guide(src)).toContain('Create src/instrumentation-client.js (in src/, where the app keeps its code):');

    const existing = project({ 'package.json': { dependencies: { next: 'latest' } }, 'app/page.tsx': '', 'instrumentation-client.ts': '' });
    expect(guide(existing)).toContain('instrumentation-client.ts exists already. Add this import and the call at the top of its code:');
  });

  it('calls init() from the app itself in older Next.js versions, going by the installed one', () => {
    const appRouter = project({
      'package.json': { dependencies: { next: '^15.3.0' } },
      'node_modules/next/package.json': { name: 'next', version: '15.2.4' },
      'tsconfig.json': {},
      'app/layout.tsx': '',
    });
    const text = guide(appRouter);
    expect(text).toContain('Next.js 15.2.4 is older than 15.3, which added instrumentation-client. Create app/capybara.tsx:');
    expect(text).toContain("'use client';\n\nimport { init } from '@capybara-devtools/web';");
    expect(text).toContain('Render <Capybara /> first inside <body> in app/layout');

    const pages = project({ 'package.json': { dependencies: { next: '14.2.0' } }, 'tsconfig.json': {}, 'pages/_app.tsx': '' });
    const pagesText = guide(pages);
    expect(pagesText).toContain('Create capybara.ts:');
    expect(pagesText).toContain("Make this the first line of pages/_app.tsx, above every other import (create the file if the app has none):\n\n```ts\nimport '../capybara';\n```");
  });

  it('loads Capybara before Expo Router through an entry file of its own', () => {
    const dir = project({
      'package.json': {
        name: 'shop-app',
        main: 'expo-router/entry',
        scripts: { start: 'expo start' },
        dependencies: {
          expo: '*',
          'expo-router': '*',
          'react-native': '*',
          react: '*',
          '@react-native-async-storage/async-storage': '*',
          'react-native-mmkv': '*',
          '@reduxjs/toolkit': '*',
        },
      },
      'app.json': { expo: { name: 'Shop' } },
      'tsconfig.json': {},
    });
    expect(app(dir)).toMatchObject({ kind: 'expo', name: 'Shop', expoRouter: true, asyncStorage: true, mmkv: true });
    expect(app(dir).entry).toBeUndefined();
    const text = guide(dir);
    expect(text).toContain(
      "Create capybara.ts:\n\n```ts\nimport AsyncStorage from '@react-native-async-storage/async-storage';\nimport { asyncStorage, init } from '@capybara-devtools/react-native';\n\nif (__DEV__) init({ appName: 'Shop', storage: [asyncStorage(AsyncStorage)] });\n```",
    );
    expect(text).toContain('mmkvStorage(storage)');
    expect(text).toContain("Create index.ts, which loads Capybara first and then Expo Router:\n\n```ts\nimport './capybara';\nimport 'expo-router/entry';\n```");
    expect(text).toContain('set "main": "index.ts" in package.json');
    expect(text).toContain('Start Metro (`npm run start`)');
    expect(text).toContain('runs `adb reverse`');
    expect(text).not.toContain('allowProduction');
  });

  it('finds the entry of other React Native apps', () => {
    const expo = project({ 'package.json': { main: 'index.ts', dependencies: { expo: '*', 'react-native': '*' } }, 'index.ts': '', 'tsconfig.json': {} });
    expect(app(expo).entry).toBe('index.ts');
    expect(guide(expo)).toContain("Make this the first line of index.ts, above every other import:\n\n```ts\nimport './capybara';\n```");

    const appEntry = project({ 'package.json': { main: 'node_modules/expo/AppEntry.js', dependencies: { expo: '*' } }, 'App.tsx': '' });
    expect(app(appEntry).entry).toBe('App.tsx');

    const bare = project({ 'package.json': { name: 'Bare', dependencies: { 'react-native': '0.86.0' } }, 'index.js': '' });
    const text = guide(bare);
    expect(app(bare)).toMatchObject({ kind: 'react-native', entry: 'index.js', typescript: false });
    expect(text).toContain("Create capybara.js:\n\n```js\nimport { init } from '@capybara-devtools/react-native';\n\nif (__DEV__) init({ appName: 'Bare' });\n```");
    expect(text).not.toContain('AsyncStorage');
  });

  it('says when the SDK is in package.json already, and when it is older', () => {
    const old = project({ 'package.json': { dependencies: { vite: '*', '@capybara-devtools/web': '^0.2.1' } } });
    const text = guide(old);
    expect(text).toContain('@capybara-devtools/web is in package.json already (0.2.1).\nThat is older than this guide; update it:');
    expect(text).toContain('npm install @capybara-devtools/web@latest');

    const current = project({
      'package.json': { dependencies: { vite: '*', '@capybara-devtools/web': '*' } },
      'node_modules/@capybara-devtools/web/package.json': { name: '@capybara-devtools/web', version: '0.3.1' },
    });
    expect(guide(current)).toContain('@capybara-devtools/web is in package.json already (0.3.1).\n\n## 2.');
  });

  it('writes plain web apps with a NODE_ENV check, and warns about folders that may not be apps', () => {
    const webpack = project({ 'package.json': { name: "o'brien", dependencies: { 'react-dom': '*', webpack: '*' } }, 'src/index.js': '' });
    const text = guide(webpack);
    expect(text).toContain("if (process.env.NODE_ENV === 'development') init({ appName: 'o\\'brien' });");
    expect(text).toContain('first line of src/index.js');

    const server = project({ 'package.json': { dependencies: { express: '*' } } });
    expect(guide(server)).toContain('this may not be the app');

    const ssr = project({ 'package.json': { dependencies: { vite: '*', 'react-router': '*' } }, 'vite.config.ts': '' });
    expect(guide(ssr)).toContain('No entry file was found');
  });

  it('says where to look when there is no package.json', () => {
    const empty = project({});
    expect(guide(empty)).toBe(
      `There is no package.json or pubspec.yaml in ${empty}. Call get_setup_guide again with projectDir set to the folder of the app, the one with its package.json or pubspec.yaml.`,
    );
    expect(guide(empty, 'cli')).toContain('Run `npx capybara-devtools setup-guide <folder>` with the folder of the app');
  });

  it('shows how to add the MCP server to assistants that ran the CLI', () => {
    const dir = project({ 'package.json': { dependencies: { vite: '*' } } });
    const text = guide(dir, 'cli');
    expect(text).toContain('claude mcp add capybara -- npx capybara-devtools mcp');
    expect(text).toContain("The app shows up in Capybara's window.");
    expect(text).not.toContain('list_sessions');
  });

  it('takes the folder in the forms an assistant passes it', () => {
    const dir = project({ 'package.json': {} });
    expect(resolveProjectDir(join(dir, 'package.json'))).toBe(dir);
    expect(resolveProjectDir('web', dir)).toBe(join(dir, 'web'));
    expect(resolveProjectDir('~/code/app')).toBe(join(homedir(), 'code/app'));
  });

  it('prints the guide from the command line', async () => {
    const dir = project({ 'package.json': { dependencies: { vite: '*' } } });
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((text: string, done?: () => void) => {
      output += text;
      done?.();
      return true;
    }) as typeof process.stdout.write);
    await runSetupGuide([dir], '0.3.1');
    expect(output).toContain('# Add Capybara to');
    expect(output).toContain('claude mcp add capybara');
    output = '';
    await runSetupGuide(['--help'], '0.3.1');
    expect(output).toMatch(/^Usage: capybara setup-guide \[folder\]/);
    await expect(runSetupGuide(['a', 'b'], '0.3.1')).rejects.toThrow('Pass one folder, not 2.');
  });
});

const PUBSPEC = `name: shop
description: "A new Flutter project."
publish_to: 'none'

environment:
  sdk: ^3.8.0

dependencies:
  flutter:
    sdk: flutter
  dio: ^5.4.0
  # Local data
  shared_preferences: ^2.3.0
  flutter_riverpod: ^3.0.0

dev_dependencies:
  flutter_test:
    sdk: flutter
`;

describe('setup guide for Flutter', () => {
  it('finds a Flutter app by its pubspec.yaml and says there is nothing to add', () => {
    const dir = project({ 'pubspec.yaml': PUBSPEC, 'ios/Runner/Info.plist': '', 'android/app/build.gradle': '' });
    const detection = detectProject(dir);
    expect(detection).toEqual({
      type: 'flutter',
      project: { dir, name: 'shop', platforms: ['ios', 'android'], dependencies: ['flutter', 'dio', 'shared_preferences', 'flutter_riverpod'] },
    });
    const text = guide(dir);
    expect(text).toContain('# Add Capybara to shop');
    expect(text).toContain('There is nothing to change in the app');
    expect(text).toContain('this app uses dio');
    expect(text).toContain('(this app uses flutter_riverpod, shared_preferences)');
    expect(text).toContain('Call list_sessions');
    expect(text).not.toMatch(/npm install|init\(\)/);
    expect(guide(dir, 'cli')).toContain('claude mcp add capybara');
  });

  it('keeps a Flutter app that has a package.json for its tooling a Flutter app', () => {
    const dir = project({ 'pubspec.yaml': PUBSPEC, 'package.json': { name: 'shop-tools', devDependencies: { prettier: '3.0.0' } } });
    expect(detectProject(dir).type).toBe('flutter');
  });

  it('lists the Flutter apps of a Dart workspace', () => {
    const dir = project({
      'pubspec.yaml': 'name: repo\npublish_to: none\nenvironment:\n  sdk: ^3.8.0\nworkspace:\n  - packages/core\n  - apps/shop\n',
      'packages/core/pubspec.yaml': 'name: core\nresolution: workspace\ndependencies:\n  meta: ^1.0.0\n',
      'apps/shop/pubspec.yaml': PUBSPEC,
    });
    expect(detectProject(dir)).toEqual({ type: 'flutter-workspace', dir, apps: [join(dir, 'apps/shop')] });
    expect(guide(dir)).toContain(`- ${join(dir, 'apps/shop')}: Flutter app`);
  });

  it('is not fooled by a Dart package that is not a Flutter app', () => {
    const dir = project({ 'pubspec.yaml': 'name: tool\ndependencies:\n  args: ^2.0.0\n' });
    expect(detectProject(dir).type).toBe('missing');
    expect(guide(dir)).toContain('no package.json or pubspec.yaml');
  });
});
