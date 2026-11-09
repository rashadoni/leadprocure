// Номер документа: кто его выдаёт и какой год в нём стоит.
//
// Номер состоит из трёх частей — тип, ГОД и сквозной по организации счётчик
// (`next_document_no`, миграция 0021). Счётчик от года не зависит вообще: он один на
// (организация, тип) и просто растёт, поэтому смена основания года не может дать ни
// коллизию, ни разрыв нумерации.
//
// Год брали из `new Date().getFullYear()` — то есть по поясу ПРОЦЕССА, а в прод-контейнере
// это UTC. В Баку (+04) заказ, выписанный 1 января между 00:00 и 04:00, получал номер
// `PO-2025-…`, и этот номер уходит наружу: он стоит в `<cac:OrderReference>` той же
// УБЛ-выгрузки, в которой `<cbc:IssueDate>` уже называет `2026-01-01`. Один документ,
// один бухгалтер, два разных года.
//
// Поэтому год считает БАЗА, тем же выражением и в том же операторе, что выдаёт счётчик:
//
//     SELECT next_document_no($1,$2) AS n, to_char(now() AT TIME ZONE $3, 'YYYY') AS y
//
// Один оператор — значит одни часы и один момент; второго `now()`, который мог бы с первым
// разойтись, здесь просто нет. Пояс — `APP_TIMEZONE` (`common/config/timezone.ts`: только
// ИМЯ зоны, смещение Postgres читает с обратным знаком). Решение и его границы —
// `docs/invoice-issue-date-decision.md`.
//
// Денормализовать день в `purchase_orders`, `contracts` и `procurement_requests` ради года
// в номере намеренно НЕ стали: у счёта день документа есть по смыслу (его выставляют, и
// `invoices.issue_date` фиксирует именно это), а у заказа, договора и заявки своей
// даты-дня нет — колонка появилась бы только ради префикса номера.
//
// Весь выпуск номеров живёт здесь, в одном месте, чтобы следующий тип документа не завёл
// год по поясу процесса заново.

export type DocumentType = 'REQ' | 'PO' | 'CTR' | 'INV';

const format = (type: DocumentType, year: string, n: unknown) =>
  `${type}-${year}-${String(Number(n)).padStart(4, '0')}`;

// Год — из пояса установки, по часам базы, одним оператором со счётчиком.
export async function nextDocumentNo(
  m: any,
  orgId: string,
  type: DocumentType,
  tz: string,
): Promise<string> {
  const r = await m.query(
    `SELECT next_document_no($1,$2::text) AS n, to_char(now() AT TIME ZONE $3, 'YYYY') AS y`,
    [orgId, type, tz],
  );
  return format(type, r[0].y, r[0].n);
}

// Год — из уже зафиксированного дня документа. Это путь счёта: его день записан в
// `invoices.issue_date` и при чтении не пересчитывается, поэтому год номера обязан быть
// годом ИМЕННО этого дня, а не отдельно посчитанным «сейчас». Так номер и дата в одном
// документе не могут назвать разные годы даже теоретически.
export async function nextDocumentNoForDay(
  m: any,
  orgId: string,
  type: DocumentType,
  day: string,
): Promise<string> {
  const r = await m.query(`SELECT next_document_no($1,$2::text) AS n`, [orgId, type]);
  return format(type, day.slice(0, 4), r[0].n);
}
