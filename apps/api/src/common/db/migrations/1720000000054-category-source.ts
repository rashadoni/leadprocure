import { MigrationInterface, QueryRunner } from 'typeorm';

// Откуда взялась категория: её завёл человек в «Параметрах» или она появилась сама, из
// заявки. Колонка нужна ровно для одного решения, и без неё оно разъезжается.
//
// Бюджет отвергает категорию, которой нет в справочнике, — но ТОЛЬКО если справочник
// кто-то вёл: орг, которая его не трогала, работает со свободным текстом, как и раньше.
// Это правило существовало и до 10.11.2026, и держалось на «справочник пуст». С того дня
// заявки начали заводить категории сами («если нет — добавляется само», решение
// владельца), и справочник перестал быть пустым у всех: бюджеты у всех разом стали
// строгими, а форма бюджета в это же время предлагала «создать» то, на что сервер
// отвечал 400. Приёмка поймала это сорока семью падениями.
//
// Поэтому «вёл ли кто-то справочник» теперь спрашивается точно: есть ли в нём хоть одна
// запись, заведённая РУКОЙ. Автоматические строки подсказываются наравне с остальными и
// годятся бюджету, но сами строгий режим не включают.
export class CategorySource1720000000054 implements MigrationInterface {
  name = 'CategorySource1720000000054';

  public async up(q: QueryRunner): Promise<void> {
    // Существующие строки — заведённые человеком: до этой миграции другого пути не было.
    await q.query(`
      ALTER TABLE procurement_categories
        ADD COLUMN IF NOT EXISTS auto_created boolean NOT NULL DEFAULT false
    `);
    await q.query(`INSERT INTO release_versions(version) VALUES ('1.9.3-category-source')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE procurement_categories DROP COLUMN IF EXISTS auto_created`);
  }
}
