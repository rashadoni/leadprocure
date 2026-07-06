import { useI18n } from '../i18n';

// Compact prev/next pager for server-paginated lists. Renders nothing when everything
// fits on one page. `total` is the full row count reported by the API envelope.
export default function Pager({
  total,
  page,
  pageSize,
  onPage,
}: {
  total: number;
  page: number;
  pageSize: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const { t } = useI18n();
  if (total <= pageSize) return null;
  return (
    <div className="pager">
      <button className="btn ghost small" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ‹ {t('prev')}
      </button>
      <span className="pager-info">
        {t('page')} {page} / {pages} · {total}
      </span>
      <button className="btn ghost small" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        {t('next')} ›
      </button>
    </div>
  );
}
