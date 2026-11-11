import { BadRequestException } from '@nestjs/common';

// Отбор, с которым список открывают из карточки-показателя.
//
// Карточка на рабочем столе открывает список, уже суженный до того, что она посчитала.
// Сузить его НА КЛИЕНТЕ нельзя: списки отдаются страницами по 20, и «5 ждут одобрения»
// привело бы на страницу, где их две, — ровно тот экран, который врёт. Поэтому отбор
// уходит в запрос, и `count(*) OVER()` в каждом списке считает уже отобранное: длина
// списка и число на карточке совпадают по построению.
//
// Имена подмножеств («open», «outstanding») живут в `LIST_FILTER_SETS` в
// @leadprocure/shared — одни и те же для адреса страницы и для запроса.
export function resolveStatusFilter<T extends string>(
  raw: string | undefined | null,
  named: Record<string, readonly T[]>,
  all: readonly T[],
): T[] | null {
  if (!raw) return null;
  const set = named[raw];
  if (set) return [...set];
  // Точное имя статуса тоже годится: список отбирается не только из карточек.
  if ((all as readonly string[]).includes(raw)) return [raw as T];
  // Молчать нельзя: неизвестное имя, понятое как «без отбора», отдало бы ВСЕ строки под
  // заголовком «неоплаченные» — опечатка превратилась бы в неверный экран.
  throw new BadRequestException(
    `Unknown status filter "${raw}" — expected one of: ${[...Object.keys(named), ...all].join(', ')}`,
  );
}

// Окно месяцев из адреса страницы. `<input type="month">` даёт 'YYYY-MM', а Postgres
// такую строку в дату не приводит — каждый запрос с окном отвечал бы 500 (это уже было,
// см. dashboard.module.ts). Всё остальное отвергается здесь, а не доезжает до запроса
// ошибкой приведения типа.
export function monthStart(d?: string | null): string | null {
  if (!d) return null;
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(d)) return `${d}-01`;
  if (/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(d)) return d;
  throw new BadRequestException(`Expected YYYY-MM, got "${d}"`);
}
