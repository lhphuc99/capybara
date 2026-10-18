import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

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
export function AuthProvider({ children }: { children: ReactNode }) {
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
