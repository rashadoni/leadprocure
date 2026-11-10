import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Сводка по логу приёмки (`scripts/acceptance/api-log-summary.mjs`) печатает, насколько
 * маршрут близок к СВОЕМУ пределу частоты, и держит пределы таблицей: читать декораторы из
 * `.mjs`-скрипта нечем. Таблица, разошедшаяся с кодом, хуже отсутствующей — она называет
 * спокойным то, что на пределе. Так и было дважды: сводка сравнивала с 300 всё, а
 * `POST /auth/login` при своём пределе 10 давал измеренный пик 9 в минуту (90 % ведра) и
 * читался как 3 %.
 *
 * Поэтому пределы сверяются с декораторами. Разбираются ИСХОДНИКИ, а не поднятое приложение:
 * предел живёт в декораторе, и спросить его у собранного Nest без обхода приватного реестра
 * нельзя. Приложение здесь не поднимается вовсе — значит эта проверка не занимает соединений
 * в пуле и флакать не может.
 *
 * ПЕРВАЯ ВЕРСИЯ ЭТОГО СТОРОЖА СВОЙ КОНТРАКТ НЕ ДЕРЖАЛА, и это поучительно: она брала файлы
 * по имени, `*.controller.ts`, — а в этом репозитории контроллеры живут в `*.module.ts`.
 * Читалось 3 файла из 20, то есть обещание «добавили `@Throttle` где-нибудь — покраснеет»
 * было ложным для семнадцати, включая `sourcing.module.ts` с подачей заявок. Разбор PR #183
 * это воспроизвёл: предел, добавленный там, проходил молча. Поэтому ниже файлы берутся по
 * СОДЕРЖИМОМУ, а всё, что парсер не смог разобрать, становится красным с правдивым
 * сообщением — проверка обязана отличать «здесь нет `@Throttle`» от «здесь `@Throttle`,
 * который я не понял».
 */
describe('пределы частоты: сводка приёмки знает о них то же, что код', () => {
  const SRC = join(__dirname, '..', 'src');
  const SUMMARY = join(__dirname, '..', '..', '..', 'scripts', 'acceptance', 'api-log-summary.mjs');

  const HANDLER = /@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)/;
  // Начало члена класса: не декоратор, с отступом, и дальше `(` или `<`. Этим размечается
  // блок декораторов ОДНОГО метода, чтобы `@Throttle` нельзя было приписать соседней ручке —
  // Nest порядок декораторов не различает, и `@Throttle` ниже `@Post` законен.
  const MEMBER = /^\s+(?:(?:public|private|protected|static|readonly)\s+)*(?:async\s+)?[A-Za-z_$][\w$]*\s*[(<]/;

  /** Любой файл, в котором есть контроллер — по содержимому, не по имени. */
  const withControllers = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return withControllers(full);
    if (!name.endsWith('.ts')) return [];
    return readFileSync(full, 'utf8').includes('@Controller(') ? [full] : [];
  });

  /** `POST /auth/login` → 10, собранное из `@Controller` + `@Throttle` + метода. */
  const fromCode = (): Record<string, number> => {
    const found: Record<string, number> = {};
    for (const file of withControllers(SRC)) {
      const where = relative(SRC, file);
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      const declared = (text.match(/@Throttle\(/g) ?? []).length;
      let parsed = 0;

      for (let i = 0; i < lines.length; i++) {
        if (!/@Throttle\(/.test(lines[i])) continue;
        // Блок декораторов этого метода: от предыдущего члена класса до следующего.
        let end = lines.length;
        for (let j = i + 1; j < lines.length; j++) {
          if (!lines[j].trim().startsWith('@') && MEMBER.test(lines[j])) { end = j; break; }
        }
        let start = 0;
        for (let j = i - 1; j >= 0; j--) {
          if (!lines[j].trim().startsWith('@') && MEMBER.test(lines[j])) { start = j + 1; break; }
        }
        const block = lines.slice(start, end);
        // `@Throttle` на классе: между ним и первым членом стоит сам `@Controller`.
        if (block.some((l) => /@Controller\(/.test(l))) {
          throw new Error(`${where}:${i + 1}: @Throttle на классе не разбирается — поставьте его на ручку`);
        }
        const blockText = block.join('\n');
        if (!/default\s*:/.test(blockText)) {
          throw new Error(`${where}:${i + 1}: @Throttle без ключа default (именованные ведра) не разбирается`);
        }
        const limit = /default\s*:\s*\{[^}]*limit\s*:\s*(\d+)/.exec(blockText);
        if (!limit) throw new Error(`${where}:${i + 1}: у @Throttle не прочитался limit`);
        const handlers = block.filter((l) => HANDLER.test(l));
        if (handlers.length !== 1) {
          throw new Error(`${where}:${i + 1}: рядом с @Throttle ${handlers.length} ручек, нужна ровно одна`);
        }
        const h = HANDLER.exec(handlers[0]) as RegExpExecArray;
        // Префикс — от БЛИЖАЙШЕГО @Controller выше, а не от первого в файле: в
        // channels.module.ts их два, и с разными префиксами ('channels' и
        // 'channels/whatsapp/webhook'), так что первый дал бы неверный ключ.
        let prefix = '';
        for (let j = i; j >= 0; j--) {
          const c = /@Controller\(\s*(?:'([^']*)')?\s*\)/.exec(lines[j]);
          if (c) { prefix = c[1] ?? ''; break; }
        }
        // Ключ приводится к тому же виду, в котором сводка читает путь из лога: там uuid
        // схлопывается в `:id`. Иначе предел на ручке с параметром попал бы в таблицу под
        // ключом, которого в логе не бывает, — проверка зелёная, а сводка берёт 300.
        // Числовой параметр в логе станет `:n`, таких пределов пока нет.
        const path = [prefix, h[2] ?? ''].filter(Boolean).join('/').replace(/:[A-Za-z_]\w*/g, ':id');
        found[`${h[1].toUpperCase()} /${path}`] = Number(limit[1]);
        parsed++;
      }

      // Сердце сторожа: любая форма записи, которую парсер не взял, краснеет здесь и с
      // правдивым сообщением — а не исчезает тихо из карты.
      if (parsed !== declared) {
        throw new Error(`${where}: @Throttle в файле ${declared}, разобрано ${parsed} — парсер не понял запись`);
      }
    }
    return found;
  };

  /** Та же карта, вычитанная из литерала `ROUTE_LIMITS` в скрипте. */
  const fromSummary = (): Record<string, number> => {
    const text = readFileSync(SUMMARY, 'utf8');
    const block = /const ROUTE_LIMITS = \{([^}]*)\}/.exec(text);
    if (!block) throw new Error(`в ${SUMMARY} не нашёлся литерал ROUTE_LIMITS`);
    const out: Record<string, number> = {};
    const entry = /'([^']+)':\s*(\d+)/g;
    let m = entry.exec(block[1]);
    while (m) { out[m[1]] = Number(m[2]); m = entry.exec(block[1]); }
    return out;
  };

  it('читаются все файлы с контроллерами, а не только *.controller.ts', () => {
    const files = withControllers(SRC).map((f) => relative(SRC, f));
    // 20 файлов с `@Controller` против 3 с таким именем — замерено 10 ноября 2026. Порог
    // стоит ниже с запасом: проверка о том, что сборщик не вернулся к отбору по имени.
    expect(files.length).toBeGreaterThan(10);
    expect(files.filter((f) => f.endsWith('.controller.ts')).length).toBeLessThan(files.length);
    expect(files).toContain(join('modules', 'sourcing', 'sourcing.module.ts'));
    expect(files).toContain(join('modules', 'channels', 'channels.module.ts'));
  });

  it('таблица в сводке совпадает с @Throttle в контроллерах', () => {
    const code = fromCode();
    // Не даём проверке позеленеть впустую: если разбор перестанет находить декораторы,
    // сравнение двух пустых карт прошло бы молча.
    expect(Object.keys(code).length).toBeGreaterThanOrEqual(3);
    expect(code['POST /auth/login']).toBe(10);
    expect(fromSummary()).toEqual(code);
  });

  it('умолчание сводки — это предел из ThrottlerModule, а не отдельное число', () => {
    const root = readFileSync(join(SRC, 'app.module.ts'), 'utf8');
    const limit = /ThrottlerModule\.forRoot\(\[\{[^}]*limit:\s*(\d+)/.exec(root);
    if (!limit) throw new Error('в app.module.ts не нашёлся ThrottlerModule.forRoot с limit');
    expect(readFileSync(SUMMARY, 'utf8')).toContain(`?? ${limit[1]}`);
  });
});
