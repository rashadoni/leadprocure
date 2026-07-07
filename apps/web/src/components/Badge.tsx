import { useI18n } from '../i18n';

// Status pill with a hover tooltip that explains the status in the UI language.
// `status` is both the shown text and the tooltip key (st_<STATUS>); `cls` optionally
// overrides the colour class when a page maps several statuses to one colour.
export function Badge({ status, cls }: { status?: string | null; cls?: string }) {
  const { t } = useI18n();
  if (status == null || status === '') return <>—</>;
  const key = `st_${status}`;
  const tip = t(key);
  return (
    <span className={`badge ${cls ?? status}`} data-tip={tip !== key ? tip : undefined}>
      {status}
    </span>
  );
}
