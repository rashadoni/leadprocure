import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/auth';
import { useI18n, LANGS } from '../i18n';
import Guide from '../components/Guide';

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
            <NavLink to="/buyer/dashboard">{t('dashboard')}</NavLink>
            <NavLink to="/buyer/requests">{t('requests')}</NavLink>
            <NavLink to="/buyer/events">{t('events')}</NavLink>
            <NavLink to="/buyer/contracts">{t('contracts')}</NavLink>
            <NavLink to="/buyer/invoices">{t('invoices')}</NavLink>
            <NavLink to="/buyer/catalogs">{t('catalogs')}</NavLink>
            <NavLink to="/buyer/budgets">{t('budgets')}</NavLink>
            <NavLink to="/buyer/analytics">{t('analytics')}</NavLink>
            <NavLink to="/buyer/logistics">{t('logistics')}</NavLink>
            <NavLink to="/buyer/suppliers">{t('suppliers')}</NavLink>
            <NavLink to="/buyer/verification">{t('verification')}</NavLink>
            <NavLink to="/buyer/settings">{t('settings')}</NavLink>
          </>
        ) : (
          <>
            <NavLink to="/supplier/dashboard">{t('dashboard')}</NavLink>
            <NavLink to="/supplier/market">{t('market')}</NavLink>
            <NavLink to="/supplier/orders">{t('my_orders')}</NavLink>
            <NavLink to="/supplier/contracts">{t('contracts')}</NavLink>
            <NavLink to="/supplier/invoices">{t('invoices')}</NavLink>
            <NavLink to="/supplier/catalogs">{t('catalogs')}</NavLink>
            <NavLink to="/supplier/verification">{t('verification')}</NavLink>
          </>
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
        {/* In the flow, ABOVE the section content — a floating overlay covered the page */}
        <Guide />
        <Outlet />
      </main>
    </div>
  );
}
