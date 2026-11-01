// Human text for dashboard tasks and notifications: machine codes (INVOICE_SUBMITTED,
// APPROVE_REQUEST…) become i18n sentences with payload fields interpolated. Unknown
// codes fall back to the raw code so nothing silently disappears.
export const taskLabel = (t: (k: string) => string, kind: string): string => {
  const key = `task_${kind}`;
  const v = t(key);
  return v === key ? kind : v;
};

// Status enums inside payloads ({status}: DELIVERED, DISPUTED…) are localized through
// the same st_<STATUS> dictionary the badges use — short label, not the explanation.
export const statusLabel = (t: (k: string) => string, v: unknown): string => {
  const key = `st_${v}`;
  const full = t(key);
  return full === key ? String(v) : full.split(' — ')[0].split(' / ')[0].split(' (')[0];
};

export const notifText = (t: (k: string) => string, n: { type: string; payload?: Record<string, unknown> }): string => {
  const key = `ntf_${n.type}`;
  const tpl = t(key);
  if (tpl === key) return n.type;
  return tpl
    .replace(/\{(\w+)\}/g, (_, k: string) => {
      const v = n.payload?.[k];
      if (v == null) return '';
      return k === 'status' ? statusLabel(t, v) : String(v);
    })
    .replace(/\(\s*\)|«\s*»/g, '') // drop empty brackets when a payload field is missing
    .trim();
};
