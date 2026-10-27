import { useI18n } from '../i18n';

// Status pill, localized. The st_<STATUS> dictionary entry is "Label — explanation":
// the short label becomes the pill text, the full sentence stays as the hover tooltip.
// Unknown codes render raw so nothing silently disappears. `cls` optionally overrides
// the colour class when a page maps several statuses to one colour.
export function Badge({ status, cls }: { status?: string | null; cls?: string }) {
  const { t } = useI18n();
  if (status == null || status === '') return <>—</>;
  const key = `st_${status}`;
  const full = t(key);
  const known = full !== key;
  const label = known ? full.split(' — ')[0].split(' (')[0] : status;
  return (
    <span className={`badge ${cls ?? status}`} data-tip={known ? full : undefined}>
      {label}
    </span>
  );
}
