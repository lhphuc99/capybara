import type { Fiber } from './fibers.js';

const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);

export function contextName(context: object): string | undefined {
  try {
    const name = (context as { displayName?: unknown }).displayName;
    return typeof name === 'string' && name !== '' ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The component that rendered the provider: its owner, which development builds keep, else the closest one above.
 * `owned` keeps to the owner, for an element created outside any render (e.g. passed to `root.render()`) has none.
 */
export function ownerName(fiber: Fiber, owned = false): string | undefined {
  try {
    for (let owner = fiber._debugOwner as Fiber | { name?: unknown } | null | undefined, hops = 0; owner != null && hops < 20; hops++) {
      // A Server Component owner is plain info with a name.
      if (!('tag' in owner)) return typeof owner.name === 'string' && owner.name !== '' ? owner.name : undefined;
      const name = componentName(owner);
      if (name !== undefined) return name;
      owner = owner._debugOwner as Fiber | null | undefined;
    }
    if (owned) return undefined;
    for (let node = fiber.return, hops = 0; node != null && hops < 50; node = node.return, hops++) {
      if (!COMPONENT_TAGS.has(node.tag)) continue;
      const name = componentName(node);
      if (name !== undefined) return name;
    }
  } catch {
    // a getter that threw: numbered instead
  }
  return undefined;
}

function componentName(fiber: Fiber): string | undefined {
  if (!COMPONENT_TAGS.has(fiber.tag)) return undefined;
  // memo() and forwardRef() wrap the function, sometimes one inside the other.
  let type = fiber.elementType ?? fiber.type;
  for (let depth = 0; type != null && depth < 3; depth++) {
    const name: unknown = type.displayName ?? (typeof type === 'function' ? type.name : undefined);
    // Bundlers rename clashing functions with a suffix, e.g. Vite's pre-bundling turns SWRConfig into SWRConfig$1.
    if (typeof name === 'string' && name !== '') return name.replace(/\$\d+$/, '') || name;
    if (typeof type !== 'object') return undefined;
    type = type.render ?? type.type;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Library contexts
// ---------------------------------------------------------------------------

/** Contexts that libraries name, by display name. */
const LIBRARY_CONTEXTS = new Map(Object.entries({
  ReactRedux: 'react-redux',
  TextAncestorContext: 'React Native',
  RootTagContext: 'React Native',
  ScrollViewContext: 'React Native',
  VirtualizedListContext: 'React Native',
  ImageAnalyticsTagContext: 'React Native',
  SafeAreaInsetsContext: 'react-native-safe-area-context',
  SafeAreaFrameContext: 'react-native-safe-area-context',
  LinkingContext: 'React Navigation',
  LocaleDirContext: 'React Navigation',
  UnhandledLinkingContext: 'React Navigation',
  HeaderBackContext: 'React Navigation',
  HeaderHeightContext: 'React Navigation',
  HeaderShownContext: 'React Navigation',
  NavigatorContext: 'Expo Router',
  RouteNode: 'Expo Router',
}));

/** Where React Navigation keeps the contexts it names, so that two copies of it share them. */
const REACT_NAVIGATION_CONTEXTS = '__react_navigation__elements_contexts';

/** Library components that render providers, by the names their code gives them. Names an app might use are left out. */
const LIBRARY_COMPONENTS = new Map(Object.entries({
  QueryClientProvider: 'TanStack Query',
  QueryErrorResetBoundary: 'TanStack Query',
  PersistQueryClientProvider: 'TanStack Query',
  HydrationBoundary: 'TanStack Query',
  SWRConfig: 'SWR',
  BaseNavigationContainer: 'React Navigation',
  NavigationContainerInner: 'React Navigation',
  NavigationIndependentTree: 'React Navigation',
  NavigationProvider: 'React Navigation',
  NavigationStateListenerProvider: 'React Navigation',
  PreventRemoveProvider: 'React Navigation',
  EnsureSingleNavigator: 'React Navigation',
  SceneView: 'React Navigation',
  ServerContainer: 'React Navigation',
  FrameSizeProvider: 'React Navigation',
  AnimatedHeaderHeightProvider: 'React Navigation',
  BottomTabView: 'React Navigation',
  CardContainerInner: 'React Navigation',
  DrawerViewBase: 'React Navigation',
  NativeStackView: 'React Navigation',
  MaterialTopTabView: 'React Navigation',
  NavigationContent: 'React Navigation',
  PanGestureHandler: 'React Navigation',
  ExpoRoot: 'Expo Router',
  ContextNavigator: 'Expo Router',
  InnerRoot: 'Expo Router',
  RootModalProvider: 'Expo Router',
  LinkPreviewContextProvider: 'Expo Router',
  NativeTabsNavigator: 'Expo Router',
  SlotNavigator: 'Expo Router',
  SplitViewNavigator: 'Expo Router',
  ExperimentalStackNavigator: 'Expo Router',
  ZoomTransitionSourceContextProvider: 'Expo Router',
  ZoomTransitionTargetContextProvider: 'Expo Router',
  // Expo Router 58, which carries its own copy of React Navigation.
  RoutingQueueProvider: 'Expo Router',
  RemovalEventEmitterRegistryProvider: 'Expo Router',
  RoutesWithRemovalPreventedProvider: 'Expo Router',
  PreventRemovalProvider: 'Expo Router',
  GuardContextProvider: 'Expo Router',
  NavigationActivityProvider: 'Expo Router',
  StandardRouterNavigator: 'Expo Router',
  NativeTabsNavigatorWrapper: 'Expo Router',
  NativeTabsContent: 'Expo Router',
  NativeStackNavigatorContent: 'Expo Router',
  ExperimentalStackNavigatorContent: 'Expo Router',
  HeaderToolbarHostBase: 'Expo Router',
  StackToolbarHeader: 'Expo Router',
  StackToolbarBottom: 'Expo Router',
  NativeToolbarMenu: 'Expo Router',
  LinkWithPreview: 'Expo Router',
  HrefPreview: 'Expo Router',
  PreviewForRootHrefState: 'Expo Router',
  InnerRouter: 'Expo Router',
  FocusedHead: 'Expo Router',
  HeadShim: 'Expo Router',
  WebSafeAreaProvider: 'Expo Router',
  ServerRoot: 'Expo Router',
  ServerRouter: 'Expo Router',
  ServerDocument: 'Expo Router',
  SafeAreaProvider: 'react-native-safe-area-context',
  ScreenStack: 'react-native-screens',
  ScreenStackItem: 'react-native-screens',
  InnerScreen: 'react-native-screens',
  GestureDetectorProvider: 'react-native-screens',
  ReanimatedScreenProvider: 'react-native-screens',
  ReanimatedNativeStackScreen: 'react-native-screens',
  GestureHandlerRootView: 'react-native-gesture-handler',
  InterceptingGestureDetector: 'react-native-gesture-handler',
  ScrollViewResponderProvider: 'react-native-gesture-handler',
  SkipEntering: 'react-native-reanimated',
  AppContainer: 'React Native',
}));

/** Expo Router names each route's component after the route, e.g. `Route(index)`. */
const EXPO_ROUTE = /^Route\(.*\)$/;

/**
 * Library components whose names an app might use too, recognized by the component that rendered them: Expo
 * Router's `Content` comes from ContextNavigator, its `Route` from a route's own component.
 */
const LIBRARY_COMPONENTS_BY_OWNER = new Map<string, (owner: string) => boolean>([
  ['Content', (owner) => owner === 'ContextNavigator'],
  ['Route', (owner) => EXPO_ROUTE.test(owner)],
]);

const NAVIGATION_COLORS = ['primary', 'background', 'card', 'text', 'border', 'notification'];

/** A React Navigation theme, which its ThemeContext holds; an app's ThemeContext usually holds something else. */
function isNavigationTheme(value: Record<string, unknown>): boolean {
  const colors = value.colors as Record<string, unknown> | null | undefined;
  return typeof value.dark === 'boolean' && colors != null && NAVIGATION_COLORS.every((key) => typeof colors[key] === 'string');
}

/**
 * Expo Router's layouts (Stack, Tabs, Drawer…) carry `Screen` and `Protected` as statics, and some are anonymous
 * arrow functions, so the name of the app's layout that renders them would be taken for theirs.
 */
function ownedByExpoRouterLayout(fiber: Fiber): boolean {
  const owner = fiber._debugOwner as Fiber | null | undefined;
  if (owner == null || !('tag' in owner)) return false;
  for (let type = owner.elementType ?? owner.type, depth = 0; type != null && depth < 3; depth++) {
    if (typeof type.Screen === 'function' && typeof type.Protected === 'function') return true;
    if (typeof type !== 'object') return false;
    type = type.render ?? type.type;
  }
  return false;
}

/** The name of the component that rendered the owner: one step past `ownerName(fiber, true)`. */
function ownerOfOwnerName(fiber: Fiber): string | undefined {
  for (let owner = fiber._debugOwner as Fiber | null | undefined, hops = 0; owner != null && 'tag' in owner && hops < 20; hops++) {
    if (componentName(owner) !== undefined) return ownerName(owner, true);
    owner = owner._debugOwner as Fiber | null | undefined;
  }
  return undefined;
}

/**
 * The library a context comes from, or undefined for the app's own. Runs once per store. Only the owner counts, not
 * a component above: an app's provider passed to `root.render()` inside a library's has no owner.
 */
export function vendorOf(fiber: Fiber, context: object, value: unknown): string | undefined {
  try {
    const redux = (globalThis as Record<symbol, unknown>)[Symbol.for('react-redux-context')];
    if (redux instanceof Map) for (const known of redux.values()) if (known === context) return 'react-redux';
    const navigation = (globalThis as Record<string, unknown>)[REACT_NAVIGATION_CONTEXTS];
    if (navigation instanceof Map) for (const known of navigation.values()) if (known === context) return 'React Navigation';
    // Bundlers number names they had to rename, e.g. `SWRConfig$1`.
    const plain = (text: string | undefined) => text?.replace(/(?:\$|_)\d+$/, '');
    const name = plain(contextName(context));
    if (value !== null && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      if (typeof v.getQueryCache === 'function' && typeof v.getMutationCache === 'function') return 'TanStack Query';
      const cache = v.cache as Record<string, unknown> | null | undefined;
      if (typeof v.mutate === 'function' && cache != null && typeof cache.get === 'function' && typeof cache.set === 'function') {
        return 'SWR';
      }
      if (name === 'ThemeContext' && isNavigationTheme(v)) return 'React Navigation';
    }
    if (ownedByExpoRouterLayout(fiber)) return 'Expo Router';
    const owner = plain(ownerName(fiber, true));
    if (owner === undefined) return LIBRARY_CONTEXTS.get(name ?? '') ?? sourcePackage(fiber);
    const byOwner = LIBRARY_COMPONENTS_BY_OWNER.get(owner);
    const byName =
      LIBRARY_CONTEXTS.get(name ?? '') ??
      LIBRARY_COMPONENTS.get(owner) ??
      (EXPO_ROUTE.test(owner) || (byOwner !== undefined && byOwner(plain(ownerOfOwnerName(fiber)) ?? '')) ? 'Expo Router' : undefined);
    return byName ?? sourcePackage(fiber);
  } catch {
    return undefined;
  }
}

/**
 * The package whose code created the provider element, from where React says it was created. Web only: React
 * Native's stacks name the bundle rather than files.
 */
function sourcePackage(fiber: Fiber): string | undefined {
  let path: string | undefined;
  const source = fiber._debugSource as { fileName?: unknown } | null | undefined;
  if (typeof source?.fileName === 'string') {
    path = source.fileName;
  } else {
      // React Native's frames name the bundle, never a file: not worth formatting the stack for.
    if (typeof navigator === 'object' && navigator?.product === 'ReactNative') return undefined;
    const stack = (fiber._debugStack as { stack?: unknown } | null | undefined)?.stack;
    if (typeof stack !== 'string' || stack.includes('UnknownOwner')) return undefined;
    // The first frame is React's jsxDEV or createElement; the next is the code that created the element.
    const frame = stack.split('\n').filter((line) => /:\d+:\d+\)?\s*$/.test(line))[1];
    path = frame && /((?:[a-z][\w+.-]*:\/\/|\/)[^\s()]+?)(?::\d+){1,2}\)?\s*$/i.exec(frame)?.[1]?.replace(/[?#].*$/, '');
  }
  if (path === undefined) return undefined;
  // Turbopack names chunks after the path they hold, with underscores for slashes.
  if (/\/node_modules_[^/]*$/.test(path)) return 'a dependency';
  const at = path.lastIndexOf('node_modules/');
  if (at < 0) return undefined;
  const rest = path.slice(at + 'node_modules/'.length);
  // Vite serves dependencies as `.vite/deps/<name>.js`, with `@scope_name` for scoped ones.
  const vite = /^\.vite\/deps\/([^/]+?)\.js$/.exec(rest)?.[1];
  if (vite !== undefined) return vite.startsWith('chunk-') ? 'a dependency' : vite.replace(/^(@[^_]+)_/, '$1/');
  const parts = rest.split('/');
  return (parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]) || 'a dependency';
}
