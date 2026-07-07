// Human text for dashboard tasks and notifications: machine codes (INVOICE_SUBMITTED,
// APPROVE_REQUEST…) become i18n sentences with payload fields interpolated. Unknown
// codes fall back to the raw code so nothing silently disappears.
export const taskLabel = (t: (k: string) => string, kind: string): string => {
  const key = `task_${kind}`;
  const v = t(key);
  return v === key ? kind : v;
};

export const notifText = (t: (k: string) => string, n: { type: string; payload?: Record<string, unknown> }): string => {
  const key = `ntf_${n.type}`;
  const tpl = t(key);
  if (tpl === key) return n.type;
  return tpl
    .replace(/\{(\w+)\}/g, (_, k: string) => String(n.payload?.[k] ?? ''))
    .replace(/\(\s*\)|«\s*»/g, '') // drop empty brackets when a payload field is missing
    .trim();
};
