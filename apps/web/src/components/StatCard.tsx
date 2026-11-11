import { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useI18n } from '../i18n';

// Карточка-показатель, которая открывает то, что посчитала.
//
// Владелец: «смотрю карточки неактивные — например, нажимаю на „неоплаченные", он должен
// мне открывать, а не искать, где это находится». Он прав дважды. Во-первых, число на
// карточке — это ответ на вопрос «сколько», и следующий вопрос всегда «какие именно»;
// отвечать на него поиском по меню — значит заставлять человека делать работу, которую
// система уже сделала. Во-вторых, карточка ВЫГЛЯДИТ как кнопка: карточка с крупным числом
// и подсказкой при наведении обещает нажатие, и молчание в ответ читается как поломка.
//
// Поэтому у карточки есть адрес, и он несёт тот же отбор, по которому считалось число.
// Это не украшение, а условие честности: если «неоплаченные за период» откроют список ВСЕХ
// счетов, числа на двух экранах не сойдутся, и человек решит, что врёт одно из них.
//
// Отбор уходит В ЗАПРОС списка, а не режет уже показанную страницу. Списки отдаются по 20
// строк, поэтому «ждут одобрения: 5» на отборе по странице привело бы на список из двух, и
// это был бы тот же самый лгущий экран, только изнутри. Какие статусы входят в отбор,
// сказано один раз в LIST_FILTER_SETS (@leadprocure/shared) — тем же определением считает
// число панель. Карточка со СУММОЙ (присуждено, экономия) ведёт в свой раздел без отбора:
// сверять там нечего, а выдумывать отбор под сумму значит обещать совпадение, которого
// никто не считал.
export interface StatCardProps {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tip?: string;
  /** Куда ведёт карточка, вместе с отбором: `/buyer/invoices?status=outstanding`. */
  to?: string;
  testid?: string;
}

export function StatCard({ label, value, note, tip, to, testid }: StatCardProps) {
  const { t } = useI18n();
  const body = (
    <>
      <div style={{ color: 'var(--muted)', fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, marginTop: 6 }}>{value}</div>
      {note != null && <div className="hint" style={{ fontSize: 11, marginTop: 4 }}>{note}</div>}
      {/* Слово, а не стрелка: иконка на карточке читается как украшение, и владелец уже
          говорил, что по иконке не видно, что она делает. */}
      {to && <div className="stat-open">{t('stat_open')} →</div>}
    </>
  );
  if (!to) return <div className="card" style={{ marginBottom: 0 }} data-tip={tip} data-testid={testid}>{body}</div>;
  return (
    <Link className="card stat-card" to={to} style={{ marginBottom: 0 }} data-tip={tip} data-testid={testid}>
      {body}
    </Link>
  );
}

// Отбор, пришедший из адреса, и строка, которая об этом говорит.
//
// Список, молча показывающий часть своих строк, — это тот же экран, который врёт: человек
// видит три счёта там, где их двадцать, и не знает почему. Поэтому отбор всегда назван и
// всегда снимается одним нажатием.
export function useUrlFilter(name: string): [string, (v: string) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(name) ?? '';
  const set = (v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(name, v); else next.delete(name);
    setParams(next, { replace: true });
  };
  return [value, set];
}

// Снять НЕСКОЛЬКО параметров разом. Три отдельных вызова `set` этого не делают, и это не
// теория: «Показать все» на счетах снимало только последний из трёх, потому что каждый
// setter строит новый адрес из того, что видел при отрисовке, — а предыдущие изменения в
// него ещё не попали. Поймала это браузерная проверка, нажав кнопку и посмотрев на адрес.
export function useClearUrlFilters(...names: string[]): () => void {
  const [params, setParams] = useSearchParams();
  return () => {
    const next = new URLSearchParams(params);
    for (const n of names) next.delete(n);
    setParams(next, { replace: true });
  };
}

// Подпись сужённого списка: чем сужен, СКОЛЬКО нашлось и как снять.
//
// Число здесь не украшение. Человек пришёл с карточки, на которой написано «5», и пришёл
// именно проверить это пять; страницы по 20 строк показывают не весь отбор, а постраничный
// указатель прячется, когда всё уместилось на одной странице, — то есть на малых числах
// список не называл свой итог ВООБЩЕ, и сверить было не с чем. Берётся из того же конверта
// (`total`), который посчитал сервер по тому же отбору.
export function FilterChip({ label, total, onClear, testid }: {
  label: string; total?: number; onClear: () => void; testid?: string;
}) {
  const { t } = useI18n();
  return (
    <div className="hint filter-chip" data-testid={testid ?? 'list-filter'}>
      {t('filtered_by')}: <b>{label}</b>
      {total != null && <> · <b data-testid="list-filter-total">{total}</b></>}
      <button type="button" className="btn small ghost" onClick={onClear}>✕ {t('filter_clear')}</button>
    </div>
  );
}
