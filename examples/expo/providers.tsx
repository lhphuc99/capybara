import { swrMiddleware, watchQueryClient } from '@capybara-devtools/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { Provider } from 'react-redux';
import { SWRConfig, type SWRConfiguration } from 'swr';
import { getJson, store } from './state';

// SWR's own cache revalidates on browser focus, which React Native lacks, so the app gives SWR a cache of its own and
// tells it when the app comes back to the foreground. swrMiddleware shows that cache in Capybara, and hands over the
// mutate() that its revalidate, clear and reset commands need.
const swrConfig: SWRConfiguration = {
  provider: () => new Map(),
  use: __DEV__ ? [swrMiddleware] : [],
  fetcher: getJson,
  isVisible: () => AppState.currentState === 'active',
  initFocus(revalidate) {
    let current = AppState.currentState;
    const subscription = AppState.addEventListener('change', (next) => {
      if (current !== 'active' && next === 'active') revalidate();
      current = next;
    });
    return () => subscription.remove();
  },
};

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } }));

  // In an effect rather than in the initializer above, which StrictMode calls twice, throwing one client away.
  useEffect(() => {
    if (__DEV__) return watchQueryClient(queryClient);
  }, [queryClient]);

  return (
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>
        <SWRConfig value={swrConfig}>
          <AuthProvider>{children}</AuthProvider>
        </SWRConfig>
      </QueryClientProvider>
    </Provider>
  );
}

interface Session {
  user: { id: number; name: string; email: string } | null;
  token: string | null;
}

interface Auth extends Session {
  signIn: () => void;
  signOut: () => void;
}

const signedOut: Session = { user: null, token: null };

const AuthContext = createContext<Auth | null>(null);

// Nothing for Capybara here either: init() lists the app's context providers on its own. Without a displayName on the
// context, the State tab names it after the component that renders it.
function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState(signedOut);
  const auth = useMemo<Auth>(
    () => ({
      ...session,
      signIn: () =>
        setSession({ user: { id: 1, name: 'Ada Lovelace', email: 'ada@example.com' }, token: `demo.${Date.now().toString(36)}` }),
      signOut: () => setSession(signedOut),
    }),
    [session],
  );
  return <AuthContext value={auth}>{children}</AuthContext>;
}

export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('useAuth() needs an <AuthProvider> above it');
  return auth;
}
