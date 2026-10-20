import { METRO_SDK, type Platform } from '@capybara-devtools/protocol';
import type { ReactNode } from 'react';
import { EmptyPanel } from '../../components/EmptyMessage';
import type { SessionState } from '../../store';

export function NoStores({
  session,
  libraryContexts,
  onShowLibraryContexts,
}: {
  session: SessionState;
  /** React Contexts of libraries the list leaves out. */
  libraryContexts: number;
  onShowLibraryContexts: () => void;
}) {
  const { info, connected } = session.meta;
  if (!info.plugins?.includes('state')) {
    if (info.sdk.name === METRO_SDK) {
      return (
        <EmptyPanel title="State needs the SDK">
          <p>
            Without the SDK, Capybara reads logs, network and storage through Metro, but not Redux, Zustand, TanStack Query, SWR or
            React Context state. Add it to the app to see its stores:
          </p>
          <Code>{`import { init } from '@capybara-devtools/react-native';\n\nif (__DEV__) init();`}</Code>
        </EmptyPanel>
      );
    }
    if (!info.plugins) {
      return (
        <EmptyPanel title="Update the SDK to see state">
          <p>
            {info.appName} uses {info.sdk.name} {info.sdk.version}, which does not report Redux, Zustand, TanStack Query, SWR or React
            Context state.
          </p>
          <pre className="code">npm install {info.sdk.name}@latest</pre>
        </EmptyPanel>
      );
    }
    return (
      <EmptyPanel title="State is turned off">
        <p>
          The app runs {info.sdk.name} {info.sdk.version} without its state plugin. Remove <code>state: false</code> from the
          options passed to <code>init()</code>, or update the SDK if this version came before state.
        </p>
      </EmptyPanel>
    );
  }
  if (!connected) {
    return (
      <EmptyPanel title="The app is offline">
        <p>State is read live from the app. Its stores show up here once it reconnects.</p>
      </EmptyPanel>
    );
  }
  return <Setup platform={info.platform} libraryContexts={libraryContexts} onShowLibraryContexts={onShowLibraryContexts} />;
}

function Setup({
  platform,
  libraryContexts,
  onShowLibraryContexts,
}: {
  platform: Platform;
  libraryContexts: number;
  onShowLibraryContexts: () => void;
}) {
  const web = platform === 'web';
  const sdk = `'@capybara-devtools/${web ? 'web' : 'react-native'}'`;
  // React Native apps usually give SWRConfig a provider of their own, whose cache watchSWR(SWRConfig) does not see.
  const watches = web
    ? `import { watchQueryClient, watchSWR, watchZustand }
  from ${sdk};
import { SWRConfig } from 'swr';

watchQueryClient(queryClient);
watchSWR(SWRConfig);
watchZustand(useCartStore, { name: 'cart' });`
    : `import {
  swrMiddleware, watchQueryClient, watchZustand,
} from ${sdk};
import { SWRConfig } from 'swr';

watchQueryClient(queryClient);
watchZustand(useCartStore, { name: 'cart' });

<SWRConfig value={{ provider: () => new Map(),
  use: [swrMiddleware] }}>`;
  return (
    <EmptyPanel title="No state stores yet" className="state-empty">
      <p>
        Redux, Zustand, TanStack Query, SWR and React Context show up here once the app registers them.
        <br />
        Keep <code>init()</code> in the first file your app imports,{' '}
        {web ? 'before your store modules and react-dom load.' : 'before your store modules load.'}
      </p>
      {libraryContexts > 0 && (
        <p>
          {libraryContexts === 1 ? 'One React Context comes from a library and is' : `${libraryContexts} React Contexts come from libraries and are`}{' '}
          hidden.{' '}
          <button type="button" className="btn small" onClick={onShowLibraryContexts}>
            Show library contexts
          </button>
        </p>
      )}
      <div className="state-snippets">
        <div>
          <h4>Picked up on their own</h4>
          <Code>
            {`// capybara.ts, the first import of ${web ? 'main.tsx' : 'index.ts'}
import { init } from ${sdk};

if (${web ? 'import.meta.env.DEV' : '__DEV__'}) init();

// Redux Toolkit configureStore(), zustand
// devtools() and React Context providers
// need nothing else.`}
          </Code>
        </div>
        <div>
          <h4>One line each</h4>
          <Code>{watches}</Code>
        </div>
      </div>
    </EmptyPanel>
  );
}

// `import.meta` is not the import keyword.
const SYNTAX = /(\/\/.*$)|('[^']*')|\b(import|from|if)\b(?!\.)/gm;

/** A short snippet with comments, strings and keywords colored. */
function Code({ children: code }: { children: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of code.matchAll(SYNTAX)) {
    parts.push(code.slice(last, match.index));
    const className = match[1] ? 'code-comment' : match[2] ? 'code-string' : 'code-keyword';
    parts.push(
      <span key={match.index} className={className}>
        {match[0]}
      </span>,
    );
    last = match.index + match[0].length;
  }
  parts.push(code.slice(last));
  return <pre className="code left">{parts}</pre>;
}
