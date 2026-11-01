import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/auth';
import { useI18n, LANGS } from '../i18n';
import Guide, { useGuidesHidden } from '../components/Guide';
import { useNarrowLayout } from '../components/narrow';

export default function Shell() {
  const { session, logout } = useAuth();
  const { t, lang, setLang } = useI18n();
  const nav = useNavigate();
  const [guidesHidden, setGuidesHidden] = useGuidesHidden();
  // Narrow screens: the rail becomes a drawer behind the «Menu» button in the top bar.
  // Shut by default and shut again the moment it is used — on a phone it covers the page,
  // and nobody wants to dismiss a menu they have just navigated with.
  const [menuOpen, setMenuOpen] = useState(false);
  useNarrowLayout();
  // Escape closes it, the way the product's own modal does.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);
  if (!session) return null;
  const isFinance = session.org.role === 'BUYER_FINANCE';
  const isBuyer = session.org.kind === 'BUYER' || session.org.kind === 'BOTH';

  return (
    <div className={`shell${menuOpen ? ' menu-open' : ''}`}>
      {/* Above 1100px this bar is not drawn at all and the rail stands in its place. */}
      <div className="topbar">
        <button className="menu-btn" aria-expanded={menuOpen} aria-controls="side-nav"
          onClick={() => setMenuOpen((v) => !v)}>
          ☰ {t('menu')}
        </button>
        <span className="topbar-brand">Leadprocure</span>
      </div>
      {/* One click handler for the whole rail instead of one per link: whichever link is
          followed, the drawer is done with. Above the breakpoint the rail never closes
          because it is never open — it is simply the first column of the page. */}
      <aside className="side" id="side-nav"
        onClick={(e) => { if ((e.target as HTMLElement).closest('a')) setMenuOpen(false); }}>
        <div className="brand">Leadprocure</div>
        <button className="side-close" onClick={() => setMenuOpen(false)}>✕ {t('close')}</button>
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
      {/* Tapping the page beside an open drawer closes it. Not drawn above the breakpoint
          and not drawn while the drawer is shut, so it never covers anything. */}
      <div className="menu-back" onClick={() => setMenuOpen(false)} />
      <main className="main">
        {/* In the flow, ABOVE the section content — a floating overlay covered the page */}
        <Guide />
        <Outlet />
      </main>
    </div>
  );
}
