import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_PORT, isNewerVersion } from '@capybara-devtools/protocol';

export type AppKind = 'vite' | 'next' | 'expo' | 'react-native' | 'web';
export type PackageManagerName = 'npm' | 'yarn' | 'pnpm' | 'bun';
export type StateLibrary = 'redux-toolkit' | 'redux' | 'zustand' | 'xstate' | 'mobx' | 'tanstack-query' | 'swr' | 'context';

interface PackageJson {
  name?: string;
  main?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

export interface PackageManager {
  name: PackageManagerName;
  /** Yarn 2 or later. */
  berry: boolean;
  /** The folder whose lockfile or `packageManager` field names it: above the app in a monorepo. */
  root: string;
}

export interface AppProject {
  dir: string;
  name: string;
  kind: AppKind;
  /** package.json names no framework Capybara knows, so this may not be an app. */
  unsure: boolean;
  typescript: boolean;
  manager: PackageManager;
  /** The file that loads first, relative to `dir`, when it was found. */
  entry?: string;
  /** Expo Router starts from `expo-router/entry`, so the app needs an entry file of its own to load Capybara first. */
  expoRouter: boolean;
  next?: NextInfo;
  state: StateLibrary[];
  /** The SDK as package.json names it, with the installed version when it can be read. */
  sdk?: { range: string; version?: string };
  asyncStorage: boolean;
  mmkv: boolean;
  scripts: Record<string, string>;
}

export interface NextInfo {
  version?: string;
  /** Next.js 15.3 and later run `instrumentation-client` in the browser before the app's code. */
  instrumentation: boolean;
  /** `src/` when the app keeps its code there, which is where Next.js looks for the file then. */
  base: string;
  /** An `instrumentation-client` file the app has already. */
  existing?: string;
  appRouter: boolean;
}

export interface FlutterProject {
  dir: string;
  name: string;
  /** Platform folders the app has, e.g. ios, android, macos. */
  platforms: string[];
  /** Packages under `dependencies` in pubspec.yaml. */
  dependencies: string[];
}

export type Detection =
  | { type: 'app'; project: AppProject }
  | { type: 'workspace'; dir: string; apps: Array<{ dir: string; kind: AppKind }> }
  | { type: 'flutter'; project: FlutterProject }
  | { type: 'flutter-workspace'; dir: string; apps: string[] }
  | { type: 'missing'; dir: string };

export interface GuideOptions {
  version: string;
  /** Through the MCP server the assistant checks the result with list_sessions; from the CLI it has no such tool yet. */
  via: 'mcp' | 'cli';
}

const SDK_WEB = '@capybara-devtools/web';
const SDK_NATIVE = '@capybara-devtools/react-native';
const DOCS = 'https://github.com/lhphuc99/capybara#readme';

const KIND_TITLES: Record<AppKind, string> = {
  vite: 'Vite app',
  next: 'Next.js app',
  expo: 'Expo app',
  'react-native': 'React Native app',
  web: 'Web app',
};
const STATE_TITLES: Record<StateLibrary, string> = {
  'redux-toolkit': 'Redux Toolkit',
  redux: 'Redux',
  zustand: 'zustand',
  xstate: 'XState',
  mobx: 'MobX',
  'tanstack-query': 'TanStack Query',
  swr: 'SWR',
  context: 'React Context',
};
const TANSTACK_PACKAGES = [
  '@tanstack/react-query',
  '@tanstack/vue-query',
  '@tanstack/svelte-query',
  '@tanstack/solid-query',
  '@tanstack/angular-query-experimental',
  '@tanstack/query-core',
];
/** Packages only apps that run in a browser have. */
const WEB_PACKAGES = [
  'react-dom',
  'vue',
  'svelte',
  '@angular/core',
  'solid-js',
  'preact',
  'lit',
  'webpack',
  'parcel',
  '@rsbuild/core',
  'react-scripts',
  'astro',
  'nuxt',
  '@sveltejs/kit',
  'react-router',
  '@remix-run/react',
];
const LOCKFILES: Array<[string, PackageManagerName]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['pnpm-workspace.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];
const SCRIPT_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js'];

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** The first bytes of a file: enough to tell a lockfile's format without reading megabytes. */
function readStart(file: string, bytes = 2048): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(bytes);
    return buffer.toString('utf8', 0, readSync(fd, buffer, 0, bytes, 0));
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const dependenciesOf = (pkg: PackageJson): Record<string, string> => ({ ...pkg.devDependencies, ...pkg.dependencies });
const toPosix = (path: string) => path.split(sep).join('/');
const withExtensions = (base: string) => SCRIPT_EXTENSIONS.map((extension) => `${base}.${extension}`);
const firstExisting = (dir: string, files: string[]) => files.find((file) => existsSync(join(dir, file)));

/** `^15.3.0` gives `15.3.0`; tags, `workspace:` and ranges with more than one version give nothing. */
function plainVersion(range: string | undefined): string | undefined {
  return range?.trim().match(/^[\^~=v]*(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/)?.[1];
}

/** The version installed for the app, else the one its package.json names. */
function versionOf(dir: string, name: string, range: string | undefined): string | undefined {
  try {
    const version = readJson<{ version?: string }>(createRequire(join(dir, 'package.json')).resolve(`${name}/package.json`))?.version;
    if (version) return version;
  } catch {
    // Not installed yet, hidden by the package's exports, or installed by Yarn's Plug'n'Play.
  }
  return plainVersion(range);
}

function atLeast(version: string | undefined, major: number, minor: number): boolean | undefined {
  const match = version?.match(/(\d+)\.(\d+)/);
  if (!match) return undefined;
  const [have, haveMinor] = [Number(match[1]), Number(match[2])];
  return have > major || (have === major && haveMinor >= minor);
}

export function findPackageManager(dir: string): PackageManager {
  for (let current = dir; ; ) {
    const declared = readJson<PackageJson>(join(current, 'package.json'))?.packageManager?.match(/^(npm|yarn|pnpm|bun)@(\d+)/);
    if (declared) {
      const name = declared[1] as PackageManagerName;
      return { name, berry: name === 'yarn' && Number(declared[2]) >= 2, root: current };
    }
    const lock = LOCKFILES.find(([file]) => existsSync(join(current, file)));
    if (lock) {
      // Yarn 2 and later keep their settings in .yarnrc.yml and start the lockfile with __metadata.
      const berry = lock[1] === 'yarn' && (existsSync(join(current, '.yarnrc.yml')) || readStart(join(current, 'yarn.lock')).includes('__metadata:'));
      return { name: lock[1], berry, root: current };
    }
    const parent = dirname(current);
    // A lockfile above the repository belongs to something else.
    if (parent === current || existsSync(join(current, '.git'))) break;
    current = parent;
  }
  return { name: 'npm', berry: false, root: dir };
}

/** The local script an index.html loads, which Vite and similar tools take for the entry. */
function htmlEntry(dir: string): string | undefined {
  for (const page of ['index.html', 'src/index.html']) {
    let html: string;
    try {
      html = readFileSync(join(dir, page), 'utf8');
    } catch {
      continue;
    }
    for (const [, src] of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
      if (!src || /^([a-z]+:)?\/\//i.test(src) || !/\.[cm]?[jt]sx?$/.test(src)) continue;
      const file = src.startsWith('/') ? join(dir, src) : join(dir, dirname(page), src);
      if (existsSync(file)) return toPosix(relative(dir, file));
    }
  }
  return undefined;
}

function appKind(dir: string, pkg: PackageJson): AppKind | undefined {
  const dependencies = dependenciesOf(pkg);
  if (dependencies.expo) return 'expo';
  if (dependencies['react-native']) return 'react-native';
  if (dependencies.next) return 'next';
  if (dependencies.vite) return 'vite';
  if (WEB_PACKAGES.some((name) => dependencies[name]) || htmlEntry(dir)) return 'web';
  return undefined;
}

/** Libraries in a monorepo name these frameworks too; an app has the files that start it. */
function looksLikeApp(dir: string, kind: AppKind): boolean {
  const has = (...files: string[]) => files.some((file) => existsSync(join(dir, file)));
  switch (kind) {
    case 'expo':
      return has('app.json', 'app.config.js', 'app.config.ts');
    case 'react-native':
      return has('ios', 'android', ...withExtensions('index'));
    case 'next':
      return has('app', 'pages', 'src/app', 'src/pages', 'next.config.js', 'next.config.mjs', 'next.config.ts');
    case 'vite':
      return has('index.html', 'vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts');
    case 'web':
      return has('index.html', 'src/index.html', 'public/index.html', 'webpack.config.js', 'webpack.config.ts', 'rsbuild.config.ts', 'rsbuild.config.js');
  }
}

/** The `packages:` list of pnpm-workspace.yaml, read line by line: enough to find apps without a YAML parser. */
function pnpmWorkspacePatterns(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const patterns: string[] = [];
  let inList = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) inList = true;
    else if (inList && /^\s+-\s/.test(line)) {
      patterns.push(line.replace(/^\s+-\s+/, '').replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, ''));
    } else if (/^\S/.test(line)) inList = false;
  }
  return patterns;
}

/** Folders that `apps/*` or `apps/web` name; deeper globs and negations are left out. */
function expandPattern(dir: string, pattern: string): string[] {
  if (pattern.startsWith('!')) return [];
  const clean = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  const wildcard = clean.match(/^(.*)\/\*{1,2}$/);
  if (wildcard) {
    const base = join(dir, wildcard[1]!);
    try {
      return readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
        .map((entry) => join(base, entry.name));
    } catch {
      return [];
    }
  }
  return clean.includes('*') ? [] : [join(dir, clean)];
}

function workspaceApps(dir: string, pkg: PackageJson): Array<{ dir: string; kind: AppKind }> | undefined {
  const listed = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
  const patterns = [...listed, ...pnpmWorkspacePatterns(join(dir, 'pnpm-workspace.yaml'))];
  if (patterns.length === 0) return undefined;
  const apps: Array<{ dir: string; kind: AppKind }> = [];
  for (const folder of new Set(patterns.flatMap((pattern) => expandPattern(dir, pattern)))) {
    const member = readJson<PackageJson>(join(folder, 'package.json'));
    const kind = member && appKind(folder, member);
    if (kind && looksLikeApp(folder, kind)) apps.push({ dir: folder, kind });
  }
  return apps.sort((a, b) => a.dir.localeCompare(b.dir));
}

function nextInfo(dir: string, range: string | undefined): NextInfo {
  const version = versionOf(dir, 'next', range);
  const usesSrc =
    !existsSync(join(dir, 'app')) && !existsSync(join(dir, 'pages')) && (existsSync(join(dir, 'src/app')) || existsSync(join(dir, 'src/pages')));
  const base = usesSrc ? 'src/' : '';
  return {
    version,
    // A version that can't be read, such as a tag, is most likely a recent one.
    instrumentation: atLeast(version, 15, 3) ?? true,
    base,
    existing: firstExisting(dir, withExtensions(`${base}instrumentation-client`)),
    appRouter: existsSync(join(dir, `${base}app`)),
  };
}

function nativeEntry(dir: string, pkg: PackageJson, kind: AppKind): { entry?: string; expoRouter: boolean } {
  const main = pkg.main?.replace(/^\.\//, '');
  if (main && /^expo-router\/entry(\.js)?$/.test(main)) return { expoRouter: true };
  if (main && !main.startsWith('node_modules/') && !main.startsWith('expo/')) {
    const file = existsSync(join(dir, main)) ? main : firstExisting(dir, withExtensions(main.replace(/\.[cm]?[jt]sx?$/, '')));
    if (file) return { entry: file, expoRouter: false };
  }
  const index = firstExisting(dir, withExtensions('index'));
  if (index) return { entry: index, expoRouter: false };
  // Older Expo templates start from expo/AppEntry.js, which loads App first.
  return { entry: kind === 'expo' ? firstExisting(dir, withExtensions('App')) : undefined, expoRouter: false };
}

function stateLibraries(dependencies: Record<string, string>): StateLibrary[] {
  const found: StateLibrary[] = [];
  if (dependencies['@reduxjs/toolkit']) found.push('redux-toolkit');
  else if (dependencies.redux) found.push('redux');
  if (dependencies.zustand) found.push('zustand');
  if (dependencies.xstate) found.push('xstate');
  if (dependencies.mobx) found.push('mobx');
  if (TANSTACK_PACKAGES.some((name) => dependencies[name])) found.push('tanstack-query');
  if (dependencies.swr) found.push('swr');
  if (dependencies.react) found.push('context');
  return found;
}

/** Accepts the folder or its package.json, absolute, relative to `cwd` or starting with `~`. */
interface Pubspec {
  name?: string;
  dependencies: string[];
  /** `flutter: sdk: flutter` under `dependencies`. */
  flutter: boolean;
  workspace: string[];
}

/** pubspec.yaml read line by line, the way `flutter create` and `dart pub add` write it: enough without a YAML parser. */
function readPubspec(file: string): Pubspec | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const pubspec: Pubspec = { dependencies: [], flutter: false, workspace: [] };
  let section: string | undefined;
  let dependency: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const top = /^([A-Za-z_][\w-]*):\s*(.*?)\s*(#.*)?$/.exec(line);
    if (top) {
      section = top[1];
      if (section === 'name') pubspec.name = top[2]!.replace(/^['"]|['"]$/g, '');
      continue;
    }
    if (section === 'dependencies') {
      const entry = /^ {2}([A-Za-z_]\w*):/.exec(line);
      if (entry) {
        dependency = entry[1]!;
        pubspec.dependencies.push(dependency);
      } else if (dependency === 'flutter' && /^\s{4,}sdk:\s*['"]?flutter['"]?\s*$/.test(line)) {
        pubspec.flutter = true;
      }
    } else if (section === 'workspace') {
      const member = /^\s*-\s*(.+?)\s*$/.exec(line);
      if (member) pubspec.workspace.push(member[1]!.replace(/^['"]|['"]$/g, '').replace(/\/+$/, ''));
    }
  }
  return pubspec;
}

const FLUTTER_PLATFORMS = ['ios', 'android', 'macos', 'linux', 'windows', 'web'];

function detectFlutter(dir: string): Detection | undefined {
  const pubspec = readPubspec(join(dir, 'pubspec.yaml'));
  if (!pubspec) return undefined;
  if (pubspec.flutter) {
    return {
      type: 'flutter',
      project: {
        dir,
        name: pubspec.name ?? basename(dir),
        platforms: FLUTTER_PLATFORMS.filter((platform) => existsSync(join(dir, platform))),
        dependencies: pubspec.dependencies,
      },
    };
  }
  if (pubspec.workspace.length === 0) return undefined;
  const apps = pubspec.workspace.filter((member) => readPubspec(join(dir, member, 'pubspec.yaml'))?.flutter);
  return { type: 'flutter-workspace', dir, apps: apps.map((member) => join(dir, member)) };
}

export function resolveProjectDir(target: string, cwd = process.cwd()): string {
  const path = target === '~' || target.startsWith('~/') ? join(homedir(), target.slice(1)) : resolve(cwd, target);
  try {
    return statSync(path).isFile() ? dirname(path) : path;
  } catch {
    return path;
  }
}

export function detectProject(dir: string): Detection {
  const pkg = readJson<PackageJson>(join(dir, 'package.json'));
  // A Flutter app can have a package.json for its tooling; it stays a Flutter app unless that names a JS app.
  const kind = pkg && appKind(dir, pkg);
  if (!kind) {
    const flutter = detectFlutter(dir);
    if (flutter) return flutter;
  }
  if (!pkg) return { type: 'missing', dir };
  if (!kind) {
    const apps = workspaceApps(dir, pkg);
    if (apps) return { type: 'workspace', dir, apps };
  }
  const dependencies = dependenciesOf(pkg);
  const native = kind === 'expo' || kind === 'react-native';
  const sdkRange = dependencies[native ? SDK_NATIVE : SDK_WEB];
  const expoName = kind === 'expo' ? readJson<{ expo?: { name?: string } }>(join(dir, 'app.json'))?.expo?.name : undefined;
  const project: AppProject = {
    dir,
    name: expoName ?? pkg.name ?? basename(dir),
    kind: kind ?? 'web',
    unsure: !kind,
    typescript: existsSync(join(dir, 'tsconfig.json')),
    manager: findPackageManager(dir),
    expoRouter: false,
    state: stateLibraries(dependencies),
    sdk: sdkRange === undefined ? undefined : { range: sdkRange, version: versionOf(dir, native ? SDK_NATIVE : SDK_WEB, sdkRange) },
    asyncStorage: Boolean(dependencies['@react-native-async-storage/async-storage']),
    mmkv: Boolean(dependencies['react-native-mmkv']),
    scripts: pkg.scripts ?? {},
  };
  if (native) Object.assign(project, nativeEntry(dir, pkg, project.kind));
  else if (kind === 'next') project.next = nextInfo(dir, dependencies.next);
  else {
    project.entry =
      htmlEntry(dir) ?? (kind === 'vite' ? undefined : firstExisting(dir, [...withExtensions('src/main'), ...withExtensions('src/index')]));
  }
  return { type: 'app', project };
}

const quote = (text: string) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const code = (language: string, text: string) => [`\`\`\`${language}`, text, '```'];

function importPath(fromFile: string, toFile: string): string {
  const path = toPosix(relative(dirname(fromFile), toFile)).replace(/\.[cm]?[jt]sx?$/, '');
  return path.startsWith('.') ? path : `./${path}`;
}

function installCommand(project: AppProject, spec: string): { command: string; where: string } {
  const { manager } = project;
  switch (manager.name) {
    case 'npm':
      return manager.root === project.dir
        ? { command: `npm install ${spec}`, where: project.dir }
        : { command: `npm install ${spec} -w ${toPosix(relative(manager.root, project.dir))}`, where: manager.root };
    case 'yarn':
      return { command: `yarn add ${spec}`, where: project.dir };
    case 'pnpm':
      return { command: `pnpm add ${spec}`, where: project.dir };
    case 'bun':
      return { command: `bun add ${spec}`, where: project.dir };
  }
}

function runScript(manager: PackageManager, script: string): string {
  return manager.name === 'npm' ? `npm run ${script}` : manager.name === 'bun' ? `bun run ${script}` : `${manager.name} ${script}`;
}

function managerTitle({ name, berry }: PackageManager): string {
  return name === 'yarn' ? (berry ? 'Yarn 2 or later' : 'Yarn 1') : name;
}

/** The file that calls init(): next to the entry, or at the root for React Native. */
function initFilePath(project: AppProject): string {
  const extension = project.typescript ? 'ts' : 'js';
  const { next } = project;
  if (project.kind === 'expo' || project.kind === 'react-native') return `capybara.${extension}`;
  if (next?.instrumentation) return next.existing ?? `${next.base}instrumentation-client.${extension}`;
  if (next?.appRouter) return `${next.base}app/capybara.${extension}x`;
  if (next) return `${next.base}capybara.${extension}`;
  if (project.entry) return toPosix(join(dirname(project.entry), `capybara.${extension}`));
  return existsSync(join(project.dir, 'src')) ? `src/capybara.${extension}` : `capybara.${extension}`;
}

function whyFirst(project: AppProject): string {
  const stores = project.state.some((library) => library === 'redux-toolkit' || library === 'redux' || library === 'zustand');
  return `Imports run in order, each before its file's own code, so init() has to be in the very first import: logs and requests made before it are missed${stores ? ", and Redux Toolkit and zustand's devtools() look for Capybara when they load" : ''}.`;
}

function appGuide(project: AppProject, options: GuideOptions): string[] {
  const native = project.kind === 'expo' || project.kind === 'react-native';
  const sdk = native ? SDK_NATIVE : SDK_WEB;
  const dev = native ? '__DEV__' : project.kind === 'vite' ? 'import.meta.env.DEV' : "process.env.NODE_ENV === 'development'";
  const initFile = initFilePath(project);
  const lines: string[] = [];
  let steps = 0;
  const step = (title: string) => lines.push('', `## ${++steps}. ${title}`, '');

  const facts = [KIND_TITLES[project.kind], managerTitle(project.manager), project.typescript ? 'TypeScript' : 'JavaScript'];
  lines.push(`# Add Capybara to ${project.name}`, '', `${facts.join(', ')}, in ${project.dir}.`);
  if (project.state.length > 0) lines.push(`State libraries: ${project.state.map((library) => STATE_TITLES[library]).join(', ')}.`);
  lines.push(
    '',
    `This guide is for Capybara ${options.version} and changes no file itself. Make the changes below, then check that the app connects (last step). Where the app already has some of this, keep its code and add only what is missing.`,
  );
  if (project.unsure) {
    lines.push(
      '',
      'package.json names no web or React Native framework, so this may not be the app. Capybara records apps that run in a browser or in React Native, not Node.js servers.',
    );
  }

  step('Install the SDK');
  const install = (spec: string) => {
    const { command, where } = installCommand(project, spec);
    lines.push(`Run in ${where}:`, '', ...code('sh', command));
  };
  if (project.sdk) {
    lines.push(`${sdk} is in package.json already${project.sdk.version ? ` (${project.sdk.version})` : ''}.`);
    if (isNewerVersion(options.version, project.sdk.version)) {
      lines.push('That is older than this guide; update it:', '');
      install(`${sdk}@latest`);
    }
  } else {
    install(sdk);
  }
  if (project.manager.name === 'yarn' && project.manager.berry) {
    lines.push(
      '',
      `Recent Yarn versions leave out releases less than a day old (npmMinimalAgeGate), so right after a release Yarn installs the one before. If package.json then names a version older than ${options.version}, ask the user whether to add "@capybara-devtools/*" to npmPreapprovedPackages in .yarnrc.yml, then run \`yarn up ${sdk}\`.`,
    );
  }

  const storage = project.asyncStorage ? ', storage: [asyncStorage(AsyncStorage)]' : '';
  const call = `init({ appName: ${quote(project.name)}${storage} })`;
  const initCode = (names: string[]) => {
    const imports = native && project.asyncStorage ? ["import AsyncStorage from '@react-native-async-storage/async-storage';"] : [];
    imports.push(`import { ${names.sort().join(', ')} } from '${sdk}';`);
    return imports;
  };
  const initSource = initCode(native && project.asyncStorage ? ['asyncStorage', 'init'] : ['init']).concat('', `if (${dev}) ${call};`).join('\n');

  if (project.next?.instrumentation) {
    step('Call init() in instrumentation-client');
    lines.push(
      project.next.existing
        ? `${initFile} exists already. Add this import and the call at the top of its code:`
        : `Create ${initFile}${project.next.base ? ' (in src/, where the app keeps its code)' : ' at the project root'}:`,
      '',
      ...code(project.typescript ? 'ts' : 'js', initSource),
      '',
      "Next.js runs this file in the browser before the app's code, so nothing has to import it.",
    );
  } else if (project.next) {
    const { base, version } = project.next;
    if (project.next.appRouter) {
      step('Call init() from a client component');
      lines.push(
        `Next.js${version ? ` ${version}` : ''} is older than 15.3, which added instrumentation-client. Create ${initFile}:`,
        '',
        ...code(project.typescript ? 'tsx' : 'jsx', ["'use client';", '', initSource, '', 'export function Capybara() {', '  return null;', '}'].join('\n')),
        '',
        `Render <Capybara /> first inside <body> in ${base}app/layout, before the app's providers. On the server init() does nothing.`,
      );
    } else {
      const appFile = firstExisting(project.dir, withExtensions(`${base}pages/_app`)) ?? `${base}pages/_app.${project.typescript ? 'tsx' : 'jsx'}`;
      step('Call init() in a file of its own');
      lines.push(`Create ${initFile}:`, '', ...code(project.typescript ? 'ts' : 'js', initSource));
      step('Import it first');
      lines.push(
        `Make this the first line of ${appFile}, above every other import (create the file if the app has none):`,
        '',
        ...code(project.typescript ? 'ts' : 'js', `import '${importPath(appFile, initFile)}';`),
        '',
        `${whyFirst(project)} On the server init() does nothing.`,
      );
    }
  } else {
    step('Call init() in a file of its own');
    lines.push(`Create ${initFile}:`, '', ...code(project.typescript ? 'ts' : 'js', initSource));
    if (native && project.mmkv) {
      lines.push(
        '',
        "The app uses react-native-mmkv: add each MMKV instance to storage, e.g. `storage: [asyncStorage(AsyncStorage), mmkvStorage(storage)]`, with mmkvStorage from the SDK and the instance imported from where the app creates it. Without that Capybara still reads MMKV through Metro, but can't edit it.",
      );
    }
    step('Import it first');
    if (project.expoRouter) {
      const entry = `index.${project.typescript ? 'ts' : 'js'}`;
      lines.push(
        `The app starts from expo-router/entry. Create ${entry}, which loads Capybara first and then Expo Router:`,
        '',
        ...code(project.typescript ? 'ts' : 'js', `import '${importPath(entry, initFile)}';\nimport 'expo-router/entry';`),
        '',
        `Then set "main": "${entry}" in package.json. ${whyFirst(project)}`,
      );
    } else if (project.entry) {
      lines.push(
        `Make this the first line of ${project.entry}, above every other import:`,
        '',
        ...code(project.typescript ? 'ts' : 'js', `import '${importPath(project.entry, initFile)}';`),
        '',
        whyFirst(project),
      );
    } else if (native) {
      lines.push(`Import it on the first line of the app's entry file (package.json "main"), above every other import. ${whyFirst(project)}`);
    } else {
      lines.push(
        `No entry file was found: there is no index.html that loads a script, so the framework probably renders pages on a server. Import ${initFile} on the first line of the code that runs first in the browser, such as the client entry (app/entry.client.tsx in React Router, which \`npx react-router reveal\` creates). On the server init() does nothing. ${whyFirst(project)}`,
      );
    }
  }

  if (project.state.length > 0) {
    step('State libraries');
    const sdkImport = (name: string) => `import { ${name} } from '${sdk}';`;
    for (const library of project.state) {
      switch (library) {
        case 'redux-toolkit':
          lines.push(
            "**Redux Toolkit**: nothing to add. configureStore() stores show up with each action, since init() now runs before Redux Toolkit loads. Only a store made with `devTools: false` needs the enhancer:",
            '',
            ...code(
              'ts',
              [
                sdkImport('capybaraReduxEnhancer'),
                '',
                'export const store = configureStore({',
                '  reducer,',
                `  enhancers: (getDefaultEnhancers) => (${dev} ? getDefaultEnhancers().concat(capybaraReduxEnhancer({ name: 'store' })) : getDefaultEnhancers()),`,
                '});',
              ].join('\n'),
            ),
          );
          break;
        case 'redux':
          lines.push(
            '**Redux**: a store made with `createStore(reducer, window.__REDUX_DEVTOOLS_EXTENSION__?.())` shows up on its own. Otherwise add the enhancer where the store is made, last in compose() when there is middleware:',
            '',
            ...code('ts', [sdkImport('capybaraReduxEnhancer'), '', `const store = createStore(reducer, ${dev} ? capybaraReduxEnhancer({ name: 'store' }) : undefined);`].join('\n')),
          );
          break;
        case 'zustand':
          lines.push(
            "**zustand**: stores made with devtools() show up on their own, with the action names their set() calls pass (`set(fn, false, 'cart/add')`). Find the stores made without it (`create` from 'zustand') and add a line after each:",
            '',
            ...code('ts', [sdkImport('watchZustand'), '', `if (${dev}) watchZustand(useCartStore, { name: 'cart' });`].join('\n')),
          );
          break;
        case 'tanstack-query':
          lines.push(
            '**TanStack Query**: where the QueryClient is made, add:',
            '',
            ...code('ts', [sdkImport('watchQueryClient'), '', `if (${dev}) watchQueryClient(queryClient);`].join('\n')),
            '',
            "If it is made in a component (`useState(() => new QueryClient())`), watch it from an effect instead, since StrictMode makes a second client that would show up too:",
            '',
            ...code('tsx', ['useEffect(() => {', `  if (${dev}) return watchQueryClient(queryClient);`, '}, [queryClient]);'].join('\n')),
            '',
            "With several clients, name each: `watchQueryClient(queryClient, { name: 'api' })`.",
          );
          break;
        case 'swr': {
          const defaultCache = code(
            project.typescript ? 'ts' : 'js',
            initCode(native && project.asyncStorage ? ['asyncStorage', 'init', 'watchSWR'] : ['init', 'watchSWR'])
              .concat("import { SWRConfig } from 'swr';", '', `if (${dev}) {`, `  ${call};`, '  watchSWR(SWRConfig);', '}')
              .join('\n'),
          );
          const middleware = code(
            'tsx',
            [sdkImport('swrMiddleware'), '', `<SWRConfig value={{ provider: () => new Map(), use: ${dev} ? [swrMiddleware] : [] }}>`].join('\n'),
          );
          const where = project.next ? ", in a 'use client' file" : '';
          // React Native apps give SWR a cache of their own for focus handling; on the web the default one is usual.
          lines.push(
            ...(native
              ? [
                  `**SWR**: an <SWRConfig> with a \`provider\` of its own, as React Native apps usually have, needs the middleware:`,
                  '',
                  ...middleware,
                  '',
                  `With SWR's default cache (no provider anywhere), make ${initFile} watch it instead:`,
                  '',
                  ...defaultCache,
                ]
              : [
                  `**SWR**: for SWR's default cache, make ${initFile} watch it:`,
                  '',
                  ...defaultCache,
                  '',
                  `An <SWRConfig> with a \`provider\` of its own needs the middleware instead${where}:`,
                  '',
                  ...middleware,
                ]),
          );
          break;
        }
        case 'xstate':
          lines.push(
            '**XState**: where an actor is made with `createActor(machine)`, add a line after it. Each transition shows with the event behind it:',
            '',
            ...code('ts', [sdkImport('watchXState'), '', `if (${dev}) watchXState(actor);`].join('\n')),
          );
          break;
        case 'mobx':
          lines.push(
            '**MobX**: after each store is made, add a line. The mobx module is passed in, so the SDK does not depend on MobX:',
            '',
            ...code('ts', [sdkImport('watchMobX'), "import * as mobx from 'mobx';", '', `if (${dev}) watchMobX(cartStore, mobx, { name: 'cart' });`].join('\n')),
          );
          break;
        case 'context':
          lines.push(
            "**React Context**: shows up on its own. Optionally set displayName on the app's contexts (`AuthContext.displayName = 'Auth'`), so each is listed by name.",
          );
          break;
      }
      lines.push('');
    }
    lines.pop();
  }

  step('Check that the app connects');
  const { scripts } = project;
  const startScript = native ? (scripts.start ? 'start' : undefined) : scripts.dev ? 'dev' : scripts.start ? 'start' : undefined;
  const start = startScript ? ` (\`${runScript(project.manager, startScript)}\`)` : '';
  lines.push(
    `1. Capybara has to be running: the Capybara desktop app, or \`npx capybara-devtools\` in a terminal that stays open (its UI is at http://localhost:${DEFAULT_PORT}). Start it, or ask the user to.`,
    native
      ? `2. Start Metro${start} and open the app on a simulator, an emulator or a phone in development mode.`
      : `2. Start the app in development${start} and open it in a browser.`,
    options.via === 'mcp'
      ? '3. Call list_sessions: the app is listed as connected. From then on get_logs, get_network, get_state and the other tools read it.'
      : "3. The app shows up in Capybara's window.",
    '',
    `If it doesn't, check that ${initFile} runs first, that the app runs in development, and that it can reach port ${DEFAULT_PORT} on this computer.`,
  );

  lines.push('', '## Notes', '');
  if (native) {
    lines.push(
      '- Simulators and phones on the same Wi-Fi find Capybara through the address of Metro. For Android devices on USB, Capybara runs `adb reverse`.',
      '- In a release build (`__DEV__` false) init() does nothing.',
    );
  } else {
    lines.push(
      `- The \`${dev}\` check keeps the SDK out of production bundles. init() does nothing in a production build anyway, unless it gets \`allowProduction: true\`.`,
    );
  }
  if (project.next) lines.push('- Only the browser side is recorded: logs and requests of server components and route handlers are not.');
  lines.push(`- If Capybara runs on another port (\`--port\` or \`CAPYBARA_PORT\`), pass the same \`port\` to init().`, `- Docs: ${DOCS}`);

  if (options.via === 'cli') lines.push(...assistantSection());
  return lines;
}

/** For an assistant that ran the CLI: how to get the MCP server, which reads the app once it runs. */
function assistantSection(): string[] {
  return [
    '',
    '## Let the assistant read the app',
    '',
    "Capybara's MCP server lets an AI assistant read the app's logs, network requests, storage and state. In Claude Code:",
    '',
    ...code('sh', 'claude mcp add capybara -- npx capybara-devtools mcp'),
    '',
    'For other clients, add it to their MCP settings:',
    '',
    ...code('json', '{ "mcpServers": { "capybara": { "command": "npx", "args": ["capybara-devtools", "mcp"] } } }'),
  ];
}

/** HTTP clients Capybara reads through dart:io's HTTP profile, by package name. */
const DART_HTTP = ['http', 'dio', 'chopper', 'retrofit', 'cupertino_http', 'cronet_http', 'cached_network_image'];
/** What the Capybara package for Flutter will add: the state and storage these packages keep. */
const DART_NEEDS_PACKAGE = [
  'flutter_riverpod',
  'hooks_riverpod',
  'riverpod',
  'flutter_bloc',
  'bloc',
  'provider',
  'get',
  'shared_preferences',
  'flutter_secure_storage',
  'hive_ce',
  'hive',
  'web_socket_channel',
];

function flutterGuide(project: FlutterProject, options: GuideOptions): string[] {
  const http = DART_HTTP.filter((name) => project.dependencies.includes(name));
  const later = DART_NEEDS_PACKAGE.filter((name) => project.dependencies.includes(name));
  const lines = [
    `# Add Capybara to ${project.name}`,
    '',
    `Flutter app${project.platforms.length > 0 ? ` for ${project.platforms.join(', ')}` : ''}, in ${project.dir}.`,
    '',
    `This guide is for Capybara ${options.version}. There is nothing to change in the app: Capybara reads Flutter apps in debug mode through the Dart VM service, the way Flutter DevTools does.`,
    '',
    '## 1. Run the app and Capybara',
    '',
    '1. Start the app in debug mode with `flutter run` (or from VS Code or Android Studio), on a simulator, an emulator, a desktop or a phone.',
    '2. Start Capybara on the same computer, or open its desktop app:',
    '',
    ...code('sh', 'npx capybara-devtools'),
    '',
    'Capybara finds apps that flutter run or an IDE started, within a few seconds. It shows:',
    '',
    '- `print`, `debugPrint` and `developer.log` output, with the logs from before it attached;',
    '- Flutter errors with their stack;',
    `- HTTP requests with their bodies: those of dart:io's HttpClient (package:http, dio, Image.network), cupertino_http and cronet_http${http.length > 0 ? `; this app uses ${http.join(', ')}` : ''}.`,
    '',
    '## 2. Check it',
    '',
    options.via === 'mcp'
      ? '- Call list_sessions: the app is listed with "via Dart VM service". From then on get_logs and get_network read it.'
      : '- The app shows up in Capybara\'s window, with "via Dart VM service".',
    '- If it does not, start Capybara with the address flutter run prints ("A Dart VM Service on … is available at"): `npx capybara-devtools --flutter-vm-service <address>`, or paste it in the UI. Run with `CAPYBARA_DEBUG=1` to see why an app is skipped.',
    '',
    '## Notes',
    '',
    '- Requests the app made before Capybara attached are missing; a hot restart (R in flutter run) records them from the start.',
    `- WebSocket messages, storage and state need the Capybara package for Flutter, which is coming to pub.dev${later.length > 0 ? ` (this app uses ${later.join(', ')})` : ''}.`,
    '- Release builds have no Dart VM service, so Capybara reads nothing from them. Profile builds show logs and requests.',
    '- Errors in async code nobody awaited appear only in the device log, not in Capybara.',
    `- Docs: ${DOCS}`,
  ];
  if (options.via === 'cli') lines.push(...assistantSection());
  return lines;
}

/** Steps to add Capybara to the app in `dir`, as Markdown for an AI assistant to follow. */
export function setupGuide(dir: string, options: GuideOptions): string {
  const detection = detectProject(dir);
  const retry =
    options.via === 'mcp' ? 'call get_setup_guide again with projectDir set to' : 'run `npx capybara-devtools setup-guide <folder>` with';
  const Retry = retry[0]!.toUpperCase() + retry.slice(1);
  switch (detection.type) {
    case 'missing':
      return `There is no package.json or pubspec.yaml in ${detection.dir}. ${Retry} the folder of the app, the one with its package.json or pubspec.yaml.`;
    case 'flutter':
      return flutterGuide(detection.project, options).join('\n');
    case 'flutter-workspace': {
      if (detection.apps.length === 0) {
        return `${detection.dir} is the root of a Dart workspace, and none of its members is a Flutter app. ${Retry} the folder of the app.`;
      }
      const apps = detection.apps.map((app) => `- ${app}: Flutter app`);
      return [`${detection.dir} is the root of a Dart workspace. Capybara reads an app, so ${retry} one of these:`, '', ...apps].join('\n');
    }
    case 'workspace': {
      if (detection.apps.length === 0) {
        return `${detection.dir} is the root of a monorepo, and none of its workspaces looks like a web or React Native app. ${Retry} the folder of the app.`;
      }
      const apps = detection.apps.map((app) => `- ${app.dir}: ${KIND_TITLES[app.kind]}`);
      return [`${detection.dir} is the root of a monorepo. Capybara goes into an app, so ${retry} one of these:`, '', ...apps].join('\n');
    }
    case 'app':
      return appGuide(detection.project, options).join('\n');
  }
}

const HELP = `Usage: capybara setup-guide [folder]

Prints how to add Capybara to the app in this folder, or in the one given: the
install command, the file that calls init(), where to import it and what its
state libraries need, worked out from its package.json, or for a Flutter app
from its pubspec.yaml. Written for AI assistants: ask yours to run it and
follow it. It changes no file.
`;

/** `capybara setup-guide`: the guide on stdout, for assistants without the MCP server. */
export async function runSetupGuide(argv: string[], version: string): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, options: { help: { type: 'boolean', short: 'h' } }, allowPositionals: true });
  if (positionals.length > 1) throw new Error(`Pass one folder, not ${positionals.length}.\n\n${HELP}`);
  const text = values.help ? HELP : `${setupGuide(resolveProjectDir(positionals[0] ?? '.'), { version, via: 'cli' })}\n`;
  // The caller exits right after, and on macOS a pipe takes the text asynchronously.
  await new Promise<void>((done) => process.stdout.write(text, () => done()));
}
