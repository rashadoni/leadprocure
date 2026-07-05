import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useI18n } from '../i18n';

export default function ResetPassword() {
  const { t } = useI18n();
  const nav = useNavigate();
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg('');
    try {
      await api.post('/auth/reset-password', { token, password });
      setMsg('OK');
      setTimeout(() => nav('/login'), 1200);
    } catch (e: any) { setMsg(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  return (
    <div className="auth-wrap">
      <form className="card auth" onSubmit={submit}>
        <div className="brand" style={{ marginBottom: 14 }}>Leadprocure</div>
        <h3>{t('reset_password')}</h3>
        {!token && <div className="error">Missing token</div>}
        <label>{t('password')}</label>
        <input type="password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />
        <div style={{ marginTop: 16 }}>
          <button className="btn" style={{ width: '100%' }} disabled={!token}>{t('reset_password')}</button>
        </div>
        {msg && <div className={msg === 'OK' ? 'hint' : 'error'}>{msg}</div>}
      </form>
    </div>
  );
}
