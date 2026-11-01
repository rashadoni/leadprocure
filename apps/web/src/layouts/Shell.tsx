import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/auth';
import { useI18n, LANGS } from '../i18n';
import Guide, { useGuidesHidden } from '../components/Guide';

export default function Shell() {
  const { session, logout } = useAuth();
  const { t, lang, setLang } = useI18n();
  const nav = useNavigate();
  const [guidesHidden, setGuidesHidden] = useGuidesHidden();
  if (!session) return null;
  const isFinance = session.org.role === 'BUYER_FINANCE';
  const isBuyer = session.org.kind === 'BUYER' || session.org.kind === 'BOTH';

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">Leadprocure</div>
        {isBuyer ? (
          <>
            <NavLink to="/buyer/dashboard">{t('dashboard')}</NavLink>
            <NavLink to="/buyer/requests">{t('requests')}</NavLink>
            {!isFinance && <NavLink to="/buyer/events">{t('events')}</NavLink>}
            {!isFinance && <NavLink to="/buyer/contracts">{t('contracts')}</NavLink>}
            {!isFinance && <NavLink to="/buyer/invoices">{t('invoices')}</NavLink>}
            {!isFinance && <NavLink to="/buyer/catalogs">{t('catalogs')}</NavLink>}
            <NavLink to="/buyer/budgets">{t('budgets')}</NavLink>
            <NavLink to="/buyer/analytics">{t('analytics')}</NavLink>
            {!isFinance && <NavLink to="/buyer/logistics">{t('logistics')}</NavLink>}
            {!isFinance && <NavLink to="/buyer/suppliers">{t('suppliers')}</NavLink>}
            {!isFinance && <NavLink to="/buyer/verification">{t('verification')}</NavLink>}
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
        {/* The way back after «Больше не показывать», and only then. It lives here, not in
            Settings, because a supplier has no Settings page — the switch has to be
            reachable by whoever threw it. */}
        {guidesHidden && (
          <button className="side-link" onClick={() => setGuidesHidden(false)}>🎥 {t('guide_show')}</button>
        )}
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
