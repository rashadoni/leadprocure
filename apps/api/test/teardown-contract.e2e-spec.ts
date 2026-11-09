import { teardown } from './helpers';

// Договор чистки: закрыть всё, даже если удаление упало, и всё равно упасть громко.
//
// Цена этого инварианта измерена: 9 ноября 2026 чистка `rfi-rfp` споткнулась об FK, строки
// `db.end()` и `app.close()` под ней не выполнились, jest напечатал `Jest did not exit` — и
// джоба висела до таймаута 30 минут, показывая в логе «отменено», а не настоящую причину.
// Набор без базы и без Nest: проверяется ровно порядок и то, что ошибка не теряется.
describe('договор чистки за набором', () => {
  const fakes = (opts: { cleanupThrows?: boolean; endThrows?: boolean } = {}) => {
    const calls: string[] = [];
    return {
      calls,
      db: { end: async () => { calls.push('db.end'); if (opts.endThrows) throw new Error('end упал'); } },
      app: { close: async () => { calls.push('app.close'); } },
      cleanup: async () => {
        calls.push('cleanup');
        if (opts.cleanupThrows) throw new Error('удаление организаций упало');
      },
    };
  };

  it('в обычном случае порядок прежний: сначала удаление, потом закрытие', async () => {
    const f = fakes();
    await teardown(f.db, f.app, f.cleanup);
    expect(f.calls).toEqual(['cleanup', 'db.end', 'app.close']);
  });

  // Тот самый случай: без этого набор оставлял бы соединение и приложение открытыми.
  it('упавшее удаление НЕ мешает закрыть соединение и приложение', async () => {
    const f = fakes({ cleanupThrows: true });
    await expect(teardown(f.db, f.app, f.cleanup)).rejects.toThrow('удаление организаций упало');
    expect(f.calls).toEqual(['cleanup', 'db.end', 'app.close']);
  });

  // Ошибку не глотаем намеренно: именно упавшая чистка нашла настоящий дефект в схеме, и
  // проглоти её — он остался бы незамеченным.
  it('ошибка удаления доходит наружу, а не тонет', async () => {
    const f = fakes({ cleanupThrows: true });
    await expect(teardown(f.db, f.app, f.cleanup)).rejects.toThrow(/удаление/);
  });

  it('упавшее закрытие соединения не мешает закрыть приложение', async () => {
    const f = fakes({ endThrows: true });
    await expect(teardown(f.db, f.app, f.cleanup)).rejects.toThrow('end упал');
    expect(f.calls).toEqual(['cleanup', 'db.end', 'app.close']);
  });

  it('без чистки и без приложения ничего не ломается', async () => {
    const f = fakes();
    await teardown(f.db, undefined);
    expect(f.calls).toEqual(['db.end']);
  });
});
