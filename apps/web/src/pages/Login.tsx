import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, Session } from '../auth/auth';
import { api } from '../api/client';
import { useI18n, LANGS } from '../i18n';

export default function Login() {
  const { login, register } = useAuth();
  const { t, lang, setLang } = useI18n();
  const nav = useNavigate();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [kind, setKind] = useState<'buyer' | 'supplier'>('buyer');
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [f, setF] = useState({ email: '', password: '', legalName: '', fullName: '', voen: '' });
  const [showPassword, setShowPassword] = useState(false);

  const forgot = async () => {
    setErr(''); setInfo('');
    if (!f.email) { setErr(t('email')); return; }
    try {
      await api.post('/auth/forgot-password', { email: f.email });
      setInfo(t('reset_sent'));
    } catch { setInfo(t('reset_sent')); }
  };

  const go = (s: Session) =>
    nav(s.org.kind === 'SUPPLIER' ? '/supplier/dashboard' : '/buyer/requests');

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      if (mode === 'login') go(await login(f.email, f.password));
      else go(await register(kind, { legalName: f.legalName, voen: f.voen, email: f.email, password: f.password, fullName: f.fullName }));
    } catch (e: any) {
      setErr(e.response?.data?.message?.toString() ?? t('error_generic'));
    }
  };

  return (
    <div className="auth-wrap">
      <form className="card auth" onSubmit={onSubmit}>
        {/* The only screen in the product where the language could not be changed — and the
            first one a new supplier sees. Everything after sign-in has the switcher in the
            sidebar, which is behind the sign-in. */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
          <div className="lang lang-light">
            {LANGS.map((l) => (
              <button key={l} type="button" className={l === lang ? 'on' : ''}
                onClick={() => setLang(l)}>{l.toUpperCase()}</button>
            ))}
          </div>
        </div>
        <div className="brand" style={{ marginBottom: 4 }}>Leadprocure</div>
        <div className="hint" style={{ marginBottom: 14 }}>{t('app_tagline')}</div>
        <div className="tabs">
          <button type="button" className={`btn ${mode === 'login' ? '' : 'ghost'}`} onClick={() => setMode('login')}>{t('login')}</button>
          <button type="button" className={`btn ${mode === 'register' ? '' : 'ghost'}`} onClick={() => setMode('register')}>{t('register')}</button>
        </div>
        {mode === 'register' && (
          <>
            <div className="tabs">
              <button type="button" className={`btn small ${kind === 'buyer' ? '' : 'ghost'}`} onClick={() => setKind('buyer')}>{t('buyer_org')}</button>
              <button type="button" className={`btn small ${kind === 'supplier' ? '' : 'ghost'}`} onClick={() => setKind('supplier')}>{t('supplier_org')}</button>
            </div>
            <label>{t('company')}</label>
            <input value={f.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} required />
            <label>VÖEN</label>
            <input value={f.voen} onChange={(e) => setF({ ...f, voen: e.target.value })} />
            <label>{t('name')}</label>
            <input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} required />
          </>
        )}
        <label htmlFor="login-email">{t('email')}</label>
        <input id="login-email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
        <label htmlFor="login-password">{t('password')}</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
          <input id="login-password" type={showPassword ? 'text' : 'password'} value={f.password}
            onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={8} />
          <button type="button" className="btn ghost small" style={{ flex: 'none' }}
            onClick={() => setShowPassword(!showPassword)}>
            {showPassword ? t('password_hide') : t('password_show')}
          </button>
        </div>
        <div className="hint" style={{ marginTop: 4 }}>{t('password_min')}</div>
        <div style={{ marginTop: 16 }}>
          <button className="btn" style={{ width: '100%' }}>{mode === 'login' ? t('login') : t('register')}</button>
        </div>
        {err && <div className="error">{err}</div>}
        {info && <div className="hint">{info}</div>}
        {mode === 'login' && (
          <div style={{ marginTop: 8 }}>
            <a href="#" onClick={(e) => { e.preventDefault(); forgot(); }}>{t('forgot')}</a>
          </div>
        )}
        {/* Demo credentials are shown only when the build opts in (dev / demo stand) —
            a production build must never advertise seeded logins. */}
        {(import.meta.env.DEV || import.meta.env.VITE_DEMO_HINT === '1') && (
          <div className="hint">demo: admin@acme.test / seller@supply-one.test · Passw0rd!</div>
        )}
      </form>
    </div>
  );
}
