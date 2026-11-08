// Пояс установки — это ИМЯ зоны, а не смещение, и за этим приходится следить в двух местах.
//
// `APP_TIMEZONE` решает, какой день считается днём документа (см.
// `docs/invoice-issue-date-decision.md`). Имя читают ДВА разных движка: Node — при проверке
// здесь, Postgres — когда день считается (`AT TIME ZONE`). Договориться они должны о базе
// имён IANA, и договариваются — но только об именах.
//
// **Смещение они читают с ПРОТИВОПОЛОЖНЫМИ знаками.** Замерено живьём 8 ноября 2026 в
// 22:54 UTC:
//
//     APP_TIMEZONE=+04:00   Postgres → 2026-11-08,  Node → 2026-11-09
//     APP_TIMEZONE=-08:00   Postgres → 2026-11-09,  Node → 2026-11-08
//     APP_TIMEZONE=Asia/Baku  оба → 2026-11-09
//
// Node принимает `+04:00` как идентификатор зоны (и возвращает его же из
// `resolvedOptions()`), а Postgres читает строку-смещение по правилам POSIX, где знак
// обратный: `AT TIME ZONE '+04:00'` это UTC−4. То есть значение, выглядящее как «Баку»,
// положило бы в налоговый документ день, отстоящий от задуманного на восемь часов — и
// положило бы НАВСЕГДА, потому что день фиксируется при выставлении. Проверка, пропускающая
// такое, хуже отсутствующей: она обещает, что мусор не поднимется, и не выполняет обещание.
//
// Поэтому смещения отвергаются по форме, а имя дополнительно сверяется с самой базой
// (`assertZoneKnownToPostgres`): так утверждение «эту зону Postgres знает» становится
// проверенным, а не предположением о совпадении наборов зон ICU и Postgres. Имена вида
// `Etc/GMT+4` сверку проходят и остаются разрешёнными — это настоящее имя IANA, и знак у
// него обратный по правилам самой IANA, то есть оба движка читают его ОДИНАКОВО (замерено
// там же: оба дали 2026-11-08).
//
// Имя зоны IANA начинается с буквы и двоеточий не содержит; этого достаточно, чтобы отсечь
// `+04:00`, `+04`, `-08:00` и `04:00`. Что прошло форму, но не является зоной (`UTC+4`),
// отсекает `Intl`.
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

export const APP_TIMEZONE_DEFAULT = 'Asia/Baku';

export function resolveAppTimezone(raw: string | undefined): string {
  const tz = raw === undefined || raw === '' ? APP_TIMEZONE_DEFAULT : raw;
  const bad = (why: string) =>
    new Error(`APP_TIMEZONE must be an IANA time zone name (e.g. ${APP_TIMEZONE_DEFAULT}), not ${why}: got ${JSON.stringify(raw)}`);
  if (!ZONE_NAME.test(tz)) throw bad('an offset');
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  } catch {
    throw bad('an unknown zone');
  }
  return tz;
}

// Вторая половина: имя должно знать то, что день и считает. Вызывается один раз при старте
// (`DatabaseModule.onModuleInit`), чтобы выкладка с неизвестным Postgres именем не поднялась
// вовсе — иначе первое же выставление счёта упало бы 500-й с текстом про `AT TIME ZONE`, в
// котором про эту переменную ничего нет.
export async function assertZoneKnownToPostgres(
  query: (sql: string, params: unknown[]) => Promise<unknown[]>,
  tz: string,
): Promise<void> {
  const rows = await query(`SELECT 1 FROM pg_timezone_names WHERE name = $1`, [tz]);
  if (!rows.length) {
    throw new Error(`APP_TIMEZONE=${JSON.stringify(tz)} is not a time zone this PostgreSQL knows (pg_timezone_names)`);
  }
}
