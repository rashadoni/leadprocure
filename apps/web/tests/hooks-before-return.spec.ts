import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Хук после раннего `return` роняет страницу целиком, и ничто дешёвое этого не ловит.
//
// Правило React: на каждой отрисовке вызывается одно и то же число хуков. Страница, которая
// сначала возвращает спиннер (`if (!ev) return …`), а хук зовёт ПОСЛЕ него, на первой
// отрисовке выполнит хуков меньше, чем на второй, — и падает с «Rendered more hooks than
// during the previous render». Не ошибка типов: `tsc` этого не видит. Не ошибка разметки:
// проверка словарей этого не видит. В этом репозитории нет eslint, то есть правила
// `react-hooks/rules-of-hooks` нет вообще.
//
// 8 ноября так и произошло: хук `useDeadlineTick` встал на карточке поставщика после
// раннего возврата, и браузерный набор в CI упал через ОДИННАДЦАТЬ минут таймаутом на
// чужом тесте — читается как сломанный продукт, а не как нарушенное правило React.
// Эта проверка отвечает на тот же вопрос за секунду и без браузера.
const SRC = resolve('src');

const files: string[] = [];
(function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.tsx')) files.push(p);
  }
})(SRC);

test('ни один хук не вызывается после раннего return', () => {
  const offenders: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    // Верхний уровень тела компонента в этом коде — ровно два пробела отступа. Этого
    // достаточно: вложенные `return` внутри обработчиков идут глубже, а хуки на верхнем
    // уровне — единственные, которые правило React вообще касается.
    let returnedAt = -1;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      // Конец функции верхнего уровня — закрывающая скоба без отступа. В одном файле живёт
      // несколько компонентов, и ранний возврат в одном из них ничего не говорит о хуках
      // в следующем; без этой строки проверка ругалась на двадцать мест, из которых
      // настоящим было одно.
      if (/^\}/.test(l)) { returnedAt = -1; continue; }
      if (returnedAt < 0 && /^ {2}if \(.*\) return /.test(l)) { returnedAt = i; continue; }
      if (returnedAt >= 0 && /^ {2}(const .*= )?use[A-Z]\w*\(/.test(l)) {
        offenders.push(`${file.slice(SRC.length + 1)}:${i + 1} — хук после раннего return на строке ${returnedAt + 1}`);
      }
    }
  }
  expect(offenders, 'хук после раннего return — страница упадёт целиком на второй отрисовке')
    .toEqual([]);
});
