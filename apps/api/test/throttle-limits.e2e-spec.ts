import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Сводка по логу приёмки (`scripts/acceptance/api-log-summary.mjs`) печатает, насколько
 * маршрут близок к СВОЕМУ пределу частоты, и держит пределы таблицей: читать декораторы из
 * `.mjs`-скрипта нечем. Таблица, которая расходится с кодом, хуже отсутствующей — она
 * называет спокойным то, что на пределе. Так и было: до второго разбора PR #182 сводка
 * сравнивала с 300 ВСЁ, а `POST /auth/login` при своём пределе 10 давал измеренный пик 9 в
 * минуту (90 % ведра) и в сводке читался как 3 %.
 *
 * Поэтому пределы сверяются с декораторами, а не с памятью автора: добавили `@Throttle`
 * где-нибудь — эта проверка краснеет, пока сводка о нём не узнает.
 *
 * Разбираются ИСХОДНИКИ, а не поднятое приложение: предел живёт в декораторе, и спросить его
 * у собранного Nest без обхода приватного реестра нельзя.
 */
describe('пределы частоты: сводка приёмки знает о них то же, что код', () => {
  const SRC = join(__dirname, '..', 'src');
  const SUMMARY = join(__dirname, '..', '..', '..', 'scripts', 'acceptance', 'api-log-summary.mjs');

  const controllers = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return controllers(full);
    return name.endsWith('.controller.ts') ? [full] : [];
  });

  /** `POST /auth/login` → 10, собранное из `@Controller` + `@Throttle` + метода. */
  const fromCode = (): Record<string, number> => {
    const found: Record<string, number> = {};
    for (const file of controllers(SRC)) {
      const text = readFileSync(file, 'utf8');
      const prefix = /@Controller\(\s*'([^']*)'\s*\)/.exec(text)?.[1] ?? '';
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const t = /@Throttle\(\{\s*default:\s*\{\s*limit:\s*(\d+)/.exec(lines[i]);
        if (!t) continue;
        // Ближайший ниже декоратор HTTP-метода — тот, который этот @Throttle и накрывает.
        let route = '';
        for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
          const m = /@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)/.exec(lines[j]);
          if (m) { route = `${m[1].toUpperCase()} /${[prefix, m[2] ?? ''].filter(Boolean).join('/')}`; break; }
        }
        if (!route) throw new Error(`@Throttle в ${file}:${i + 1} ни над чем: ниже нет декоратора метода`);
        found[route] = Number(t[1]);
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

  it('таблица в сводке совпадает с @Throttle в контроллерах', () => {
    const code = fromCode();
    // Не даём проверке позеленеть впустую: если разбор перестанет находить декораторы
    // (переформатировали, переехали), сравнение двух пустых карт прошло бы молча.
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
