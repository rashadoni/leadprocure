import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/auth';
import { useI18n, LANGS } from '../i18n';

export default function Shell() {
  const { session, logout } = useAuth();
  const { t, lang, setLang } = useI18n();
  const nav = useNavigate();
  if (!session) return null;
  const isBuyer = session.org.kind === 'BUYER' || session.org.kind === 'BOTH';

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">Leadprocure</div>
        {isBuyer ? (
          <>
            <NavLink to="/buyer/requests">{t('requests')}</NavLink>
            <NavLink to="/buyer/events">{t('events')}</NavLink>
            <NavLink to="/buyer/suppliers">{t('suppliers')}</NavLink>
          </>
        ) : (
          <NavLink to="/supplier/market">{t('market')}</NavLink>
        )}
        <div className="spacer" />
        <div className="lang">
          {LANGS.map((l) => (
            <button key={l} className={l === lang ? 'on' : ''} onClick={() => setLang(l)}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="who">
          {session.org.name || session.org.kind}
          <br />
          {session.user.email}
          <br />
          <a href="#" onClick={async (e) => { e.preventDefault(); await logout(); nav('/login'); }}>
            {t('logout')}
          </a>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
