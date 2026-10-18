'use client';

import { watchQueryClient } from '@capybara-devtools/web';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Provider } from 'react-redux';
import { SWRConfig } from 'swr';
import { getJson, makeStore, type AppStore } from './state';

export function Providers({ children }: { children: ReactNode }) {
  const store = useRef<AppStore | null>(null);
  if (!store.current) store.current = makeStore();
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } }));

  // In an effect rather than in the initializer above, which StrictMode calls twice, throwing one client away.
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') return watchQueryClient(queryClient);
  }, [queryClient]);

  return (
    <Provider store={store.current}>
      <QueryClientProvider client={queryClient}>
        <SWRConfig value={{ fetcher: getJson }}>
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

// Nothing for Capybara here: init() lists the app's context providers on its own. Without a displayName on the
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
