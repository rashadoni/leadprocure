import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, Session } from '../auth/auth';
import { api } from '../api/client';
import { useI18n } from '../i18n';

export default function Login() {
  const { login, register } = useAuth();
  const { t } = useI18n();
  const nav = useNavigate();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [kind, setKind] = useState<'buyer' | 'supplier'>('buyer');
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [f, setF] = useState({ email: '', password: '', legalName: '', fullName: '', voen: '' });

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
      setErr(e.response?.data?.message?.toString() ?? 'Error');
    }
  };

  return (
    <div className="auth-wrap">
      <form className="card auth" onSubmit={onSubmit}>
        <div className="brand" style={{ marginBottom: 14 }}>Leadprocure</div>
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
        <label>{t('email')}</label>
        <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
        <label>{t('password')}</label>
        <input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={8} />
        <div style={{ marginTop: 16 }}>
          <button className="btn" style={{ width: '100%' }}>{mode === 'login' ? t('login') : t('register')}</button>
        </div>
        {err && <div className="error">{err}</div>}
        {info && <div className="hint">{info}</div>}
        {mode === 'login' && (
          <div style={{ marginTop: 8 }}>
            <a href="#" onClick={(e) => { e.preventDefault(); forgot(); }} className="hint">{t('forgot')}</a>
          </div>
        )}
        {/* A sign-in page does not print a password. There used to be a seeded-credentials
            line here behind `import.meta.env.DEV || VITE_DEMO_HINT === '1'`, with a comment
            promising that a production build would never advertise seeded logins — and the
            production image shipped with the flag on anyway, so the live login page handed
            out a working supplier password to anyone who opened it. The guard was the whole
            defence and it failed silently; the flag is documented as "keep empty" in both
            infra/DEPLOY.md and docs/LAUNCH-CHECKLIST.md, which did not help either.
            Whoever seeds a database gets the credentials from `pnpm --filter api seed`,
            which prints them, so nothing is lost by refusing to render them here. */}
      </form>
    </div>
  );
}
