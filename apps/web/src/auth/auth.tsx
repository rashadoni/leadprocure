import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { api, setToken } from '../api/client';

export interface Session {
  user: { id: string; email: string; fullName: string };
  org: { id: string; role: string; kind: string; name: string };
}

interface AuthCtx {
  session: Session | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<Session>;
  register: (kind: 'buyer' | 'supplier', form: Record<string, string>) => Promise<Session>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>(null as never);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Try silent resume via the httpOnly refresh cookie.
    (async () => {
      try {
        const { data } = await api.post('/auth/refresh');
        setToken(data.accessToken);
        const me = await api.get('/auth/me');
        setSession({
          user: me.data.user,
          org: { ...me.data.activeOrg, name: me.data.memberships?.[0]?.legal_name ?? '', kind: me.data.activeOrg.kind },
        });
      } catch { /* not logged in */ }
      setLoading(false);
    })();
  }, []);

  const finish = (data: any): Session => {
    setToken(data.accessToken);
    const s = { user: data.user, org: data.org };
    setSession(s);
    return s;
  };

  const login = async (email: string, password: string) =>
    finish((await api.post('/auth/login', { email, password })).data);

  const register = async (kind: 'buyer' | 'supplier', form: Record<string, string>) =>
    finish((await api.post(`/auth/register/${kind}`, form)).data);

  const logout = async () => {
    await api.post('/auth/logout');
    setToken(null);
    setSession(null);
  };

  return <Ctx.Provider value={{ session, loading, login, register, logout }}>{children}</Ctx.Provider>;
}

export function Protected({ children, roles }: { children: ReactNode; roles?: string[] }) {
  const { session, loading } = useAuth();
  if (loading) return <div className="center">…</div>;
  if (!session) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(session.org.role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}
