// Offset pagination for RLS-scoped list endpoints. Lists stay bounded even as a tenant's
// transactional data grows. The response envelope is { items, total, page, pageSize };
// `total` comes free from a `count(*) OVER()` window column named `total_count` on each row.

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 200;

export interface Paging {
  page: number;
  pageSize: number;
  limit: number;
  offset: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// Parse ?page/?pageSize with safe defaults and clamping (page ≥ 1, 1 ≤ pageSize ≤ 200).
export function parsePaging(page?: string | number, pageSize?: string | number): Paging {
  const p = Math.max(1, Math.trunc(Number(page)) || 1);
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(pageSize)) || DEFAULT_PAGE_SIZE));
  return { page: p, pageSize: size, limit: size, offset: (p - 1) * size };
}

// Build the envelope from rows that each carry a `total_count` window column (stripped out).
export function pageFrom<T extends { total_count?: number | string }>(
  rows: T[],
  paging: Paging,
): Page<Omit<T, 'total_count'>> {
  const total = rows.length ? Number(rows[0].total_count ?? 0) : 0;
  const items = rows.map(({ total_count, ...rest }) => rest) as Omit<T, 'total_count'>[];
  return { items, total, page: paging.page, pageSize: paging.pageSize };
}
