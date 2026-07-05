import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, Session } from '../auth/auth';
import { useI18n } from '../i18n';

export default function Login() {
  const { login, register } = useAuth();
  const { t } = useI18n();
  const nav = useNavigate();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [kind, setKind] = useState<'buyer' | 'supplier'>('buyer');
  const [err, setErr] = useState('');
  const [f, setF] = useState({ email: '', password: '', legalName: '', fullName: '', voen: '' });

  const go = (s: Session) =>
    nav(s.org.kind === 'SUPPLIER' ? '/supplier/market' : '/buyer/requests');

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
        <div className="hint">demo: admin@acme.test / seller@supply-one.test · Passw0rd!</div>
      </form>
    </div>
  );
}
