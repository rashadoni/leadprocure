import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useI18n } from '../i18n';

// Per-org sending channels (Email/SMTP + WhatsApp gateway) the buyer connects for the
// follow-up reminders. Catalog-style cards → inline connect form → test / disconnect.
// Secrets are write-only: the API returns has_password/has_token booleans, never the value.
interface ChannelState {
  channel: 'EMAIL' | 'WHATSAPP';
  connected: boolean;
  isActive: boolean;
  lastTestAt: string | null;
  config: Record<string, any>;
}

const META = {
  EMAIL: { ico: '✉️', accent: '#eef2ff' },
  WHATSAPP: { ico: '📱', accent: '#e7f6ec' },
} as const;

export function ChannelsCard({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<ChannelState[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.get('/channels').then((r) => setRows(r.data)).catch(() => setRows([])), []);
  useEffect(() => { load(); }, [load]);

  const openForm = (c: ChannelState) => {
    // prefill non-secret fields; secrets stay blank (means "keep existing" on save)
    const { has_password, has_token, ...rest } = c.config;
    setDraft({ ...rest, isActive: c.connected ? c.isActive : true });
    setEditing(c.channel);
  };

  const save = async (channel: string) => {
    setBusy(true);
    try { await api.put(`/channels/${channel}`, draft); await load(); setEditing(null); }
    catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
    finally { setBusy(false); }
  };
  const test = async (channel: string) => {
    const to = window.prompt(channel === 'EMAIL' ? t('ch_test_email_prompt') : t('ch_test_wa_prompt'));
    if (!to) return;
    setBusy(true);
    try { await api.post(`/channels/${channel}/test`, { to }); alert(t('ch_test_ok')); await load(); }
    catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
    finally { setBusy(false); }
  };
  const disconnect = async (channel: string) => {
    if (!window.confirm(t('ch_disconnect_confirm'))) return;
    try { await api.delete(`/channels/${channel}`); await load(); }
    catch (e: any) { alert(e.response?.data?.message?.toString() ?? 'Error'); }
  };

  const field = (key: string, label: string, type = 'text', ph = '') => (
    <div style={{ marginBottom: 8 }}>
      <label>{label}</label>
      <input type={type} value={draft[key] ?? ''} placeholder={ph}
        onChange={(e) => setDraft({ ...draft, [key]: type === 'number' ? Number(e.target.value) : e.target.value })} />
    </div>
  );

  return (
    <div className="card">
      <h3>📡 {t('channels_hdr')}</h3>
      <p className="hint" style={{ marginTop: 2 }}>{t('channels_desc')}</p>

      <div className="ch-grid">
        {rows.map((c) => {
          const m = META[c.channel];
          const open = editing === c.channel;
          const secretSaved = c.config.has_password || c.config.has_token;
          return (
            <div key={c.channel} className="ch-item" style={{ borderLeft: `4px solid ${c.connected && c.isActive ? 'var(--accent)' : 'var(--border)'}` }}>
              <div className="ch-head">
                <span className="ch-ico" style={{ background: m.accent }}>{m.ico}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{t(`ch_${c.channel}`)}</div>
                  <div className="hint">
                    {c.connected
                      ? <span className="badge APPROVED">✓ {t('ch_connected')}</span>
                      : <span className="badge" style={{ opacity: 0.6 }}>{t('ch_not_connected')}</span>}
                    {c.connected ? ` · ${c.channel === 'WHATSAPP'
                      ? (c.config.verifiedName || c.config.displayPhone || t('ch_wa_meta'))
                      : (c.config.from || '')}` : ''}
                  </div>
                </div>
              </div>

              {open ? (
                <div className="ch-form">
                  {c.channel === 'EMAIL' ? (
                    <>
                      {field('host', 'SMTP host', 'text', 'smtp.gmail.com')}
                      {field('port', 'Port', 'number', '587')}
                      {field('user', t('ch_login'), 'text', 'you@company.com')}
                      {field('password', t('ch_password'), 'password', secretSaved ? '•••••• ' + t('ch_keep_hint') : '')}
                      {field('from', t('ch_from'), 'text', 'Acme <no-reply@acme.az>')}
                    </>
                  ) : (
                    <>
                      <p className="hint" style={{ margin: '0 0 8px' }}>{t('ch_wa_meta_hint')}</p>
                      {field('accessToken', t('ch_wa_token'), 'password', secretSaved ? '•••••• ' + t('ch_keep_hint') : 'EAAG...')}
                      {field('phoneNumberId', t('ch_wa_phone_id'), 'text', '1012345678901234')}
                      {field('businessAccountId', t('ch_wa_waba'), 'text', '(optional)')}
                      {field('templateName', t('ch_wa_template'), 'text', 'tender_reminder')}
                      {field('templateLang', t('ch_wa_lang'), 'text', 'az / en_US')}
                    </>
                  )}
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0 10px' }}>
                    <input type="checkbox" style={{ width: 'auto' }} checked={draft.isActive ?? true}
                      onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} />
                    <span className="hint">{t('ch_active')}</span>
                  </label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn small" disabled={busy} onClick={() => save(c.channel)}>{t('followups_save')}</button>
                    <button className="btn small ghost" onClick={() => setEditing(null)}>{t('followups_cancel')}</button>
                  </div>
                </div>
              ) : (
                isAdmin && (
                  <div className="ch-actions">
                    <button className="btn small" onClick={() => openForm(c)}>
                      {c.connected ? `✎ ${t('ch_edit')}` : `＋ ${t('ch_connect')}`}
                    </button>
                    {c.connected && <button className="btn small ghost" disabled={busy} onClick={() => test(c.channel)}>✈ {t('ch_test')}</button>}
                    {c.connected && <button className="btn small ghost" onClick={() => disconnect(c.channel)}>{t('ch_disconnect')}</button>}
                  </div>
                )
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
