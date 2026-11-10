import { BadRequestException } from '@nestjs/common';

// Одно место, где решается судьба введённой категории, — потому что мест, где её вводят,
// три: заявка, правка черновика и бюджет. Пока правило жило в каждом своём, они разошлись:
// заявка принимала любой текст, а бюджет отказывал всему, чего нет в справочнике, и
// отказывал ТОЛЬКО если справочник непустой. Пустой справочник означал «принимаем всё».
//
// Это стоило 47 падений приёмки в один присест: стоило заявкам начать пополнять справочник
// («если нет — добавляется само», решение владельца 10.11.2026), как он перестал быть
// пустым — и бюджеты у всех молча переключились в строгий режим. Форма бюджета при этом
// предлагала «+ создать "AZNCAT"», а сервер на то же самое отвечал 400: обещание экрана и
// поведение сервера разошлись ровно в том месте, которое правка и чинила.
//
// Поэтому правило теперь одно на всех:
//  · `*` — всегда можно: это «любая категория»;
//  · точное совпадение со справочником — так и остаётся;
//  · совпадение БЕЗ учёта регистра — возвращается написание из справочника. Это та самая
//    защита, ради которой строгость и заводили: бюджет на «it» не ловит заявки на «IT» и
//    молча стоит на нуле. Теперь он не отвергается и не расходится, а приводится;
//  · незнакомое, но похожее на код, — заводится и дальше подсказывается;
//  · незнакомое и НЕ похожее на код (пробелы, сорок с лишним знаков) — отказ с объяснением:
//    справочник хранит коды, и фраза кодом не становится.
export const CATEGORY_CODE = /^[\p{L}\p{N}_-]{1,40}$/u;

export interface CategoryResolution {
  /** Что записывать в заявку или бюджет. */
  code: string;
  /** id заведённой категории — только если она завелась именно сейчас. */
  createdId: string | null;
}

type Manager = { query(sql: string, params?: unknown[]): Promise<any> };

export async function resolveCategory(
  m: Manager,
  orgId: string,
  raw: string | undefined,
  { strict }: { strict: boolean },
): Promise<CategoryResolution> {
  const code = (raw ?? '').trim();
  if (!code || code === '*') return { code: '*', createdId: null };

  const known: Array<{ id: string; code: string }> = await m.query(
    `SELECT id, code FROM procurement_categories`,
  );
  const exact = known.find((c) => c.code === code);
  if (exact) return { code: exact.code, createdId: null };
  // Совпало без учёта регистра — человек имел в виду существующую категорию. Что делать
  // дальше, у заявки и бюджета по-разному, и это единственное место, где они расходятся:
  //  · заявка приводится к написанию из справочника молча. Иначе заявка на «it» не попадёт
  //    в бюджет «IT» — тот самый тихий ноль, и рассказывать об этом автору заявки нечего:
  //    он написал ту же категорию;
  //  · бюджет отвергается с названным написанием. Бюджет — это план на год, и «создать
  //    второй, отличающийся регистром» здесь не опечатка, а две сущности с одним смыслом,
  //    делящие расход пополам. Поэтому тут вопрос задаётся вслух.
  const sameButCase = known.find((c) => c.code.toLowerCase() === code.toLowerCase());
  if (sameButCase) {
    if (!strict) return { code: sameButCase.code, createdId: null };
    throw new BadRequestException(
      `Category "${code}" differs only in case from "${sameButCase.code}". `
      + `Use "${sameButCase.code}" — two spellings would split the same spend in two.`,
    );
  }

  if (!CATEGORY_CODE.test(code)) {
    // Заявка этим не ограничена: там категория — свободный текст, и так было всегда.
    // Бюджет — ограничен: он СЧИТАЕТ по категории, и фраза с пробелами, не попавшая в
    // справочник, дала бы бюджет, который ничего не ловит и стоит на нуле.
    if (!strict) return { code, createdId: null };
    throw new BadRequestException(
      `Category "${code}" is not a code: 1–40 letters, digits, "-" or "_". `
      + (known.length ? `Known: ${known.map((c) => c.code).join(', ')}. ` : '')
      + 'Leave it empty for all categories.',
    );
  }

  const row = (
    await m.query(
      `INSERT INTO procurement_categories(buyer_org_id, code) VALUES ($1,$2)
       ON CONFLICT DO NOTHING RETURNING id`,
      [orgId, code],
    )
  )[0];
  return { code, createdId: row?.id ?? null };
}
