import { MigrationInterface, QueryRunner } from 'typeorm';

// Терминальный исход для документа, объекта которого в хранилище нет.
//
// До этой миграции у сканера было три исхода — CLEAN, INFECTED, SKIPPED, — и ни один не
// описывал «файла нет». Неудача любого рода оставляла строку PENDING, а `documents_pending_scan`
// отдаёт PENDING снова и снова, так что повтор, который не может завершиться успехом НИ ПРИ
// ОДНОЙ попытке, шёл по кругу вечно. Замерено на проде 9 ноября 2026: `eicar-live.txt`,
// созданный 7 июля, четыре месяца висел PENDING и каждые 30 секунд писал в лог
// `scan failed … The specified key does not exist. — will retry`.
//
// Шум — меньшая часть беды. `documents_pending_scan` берёт `ORDER BY created_at LIMIT 5`, то
// есть навсегда падающая СТАРЕЙШАЯ строка занимает слот в каждой партии. Пять таких строк — и
// антивирус перестаёт сканировать новые загрузки вообще, молча: в логе те же пять предупреждений,
// что и до, а свежие файлы просто не доходят до clamd. На проде такая строка одна, и это
// единственная причина, по которой сегодня это шум, а не остановка проверки.
//
// Почему не SKIPPED, который уже есть. SKIPPED значит «сознательно не сканировали» (файл больше
// лимита потока clamd), и `assertDownloadable` отдаёт такой документ, когда антивирус выключен.
// «Объекта нет» — не решение оператора, а потерянная ссылка, и отдавать на него ссылку для
// скачивания нельзя: подписанный URL привёл бы в пустоту. Разные причины — разные состояния,
// иначе отчёт по документам перестаёт отвечать на вопрос «что с этим файлом».
export class AvScanMissingObject1720000000052 implements MigrationInterface {
  name = 'AvScanMissingObject1720000000052';

  public async up(q: QueryRunner): Promise<void> {
    // Тот же сид, что в 0022: переход разрешён только из PENDING, поэтому он идемпотентен при
    // наложении воркеров. Добавлено ровно одно значение.
    await q.query(`
      CREATE OR REPLACE FUNCTION document_set_av_status(p_src text, p_id uuid, p_status text)
      RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE v_n int;
      BEGIN
        -- SKIPPED = сознательно не сканировали (например, больше лимита потока clamd)
        -- MISSING = объекта нет в хранилище: пересканировать нечего, повторять бессмысленно
        IF p_status NOT IN ('CLEAN','INFECTED','SKIPPED','MISSING') THEN RAISE EXCEPTION 'Bad AV status %', p_status; END IF;
        IF p_src = 'doc' THEN
          UPDATE documents SET av_status = p_status WHERE id = p_id AND av_status = 'PENDING';
        ELSIF p_src = 'bid' THEN
          UPDATE bid_documents SET av_status = p_status WHERE id = p_id AND av_status = 'PENDING';
        ELSE
          RAISE EXCEPTION 'Bad AV source %', p_src;
        END IF;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        RETURN v_n > 0;
      END $$`);

    await q.query(`INSERT INTO release_versions(version) VALUES ('1.9.1-av-missing-object')`);
  }

  // Откат возвращает прежний список значений. Строки, уже помеченные MISSING, не трогаются
  // намеренно: вернуть их в PENDING значило бы заново запустить тот самый вечный повтор, а
  // придумать им другое состояние нельзя — объекта по-прежнему нет. Функция после откату
  // просто откажется ставить MISSING впредь.
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE OR REPLACE FUNCTION document_set_av_status(p_src text, p_id uuid, p_status text)
      RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE v_n int;
      BEGIN
        IF p_status NOT IN ('CLEAN','INFECTED','SKIPPED') THEN RAISE EXCEPTION 'Bad AV status %', p_status; END IF;
        IF p_src = 'doc' THEN
          UPDATE documents SET av_status = p_status WHERE id = p_id AND av_status = 'PENDING';
        ELSIF p_src = 'bid' THEN
          UPDATE bid_documents SET av_status = p_status WHERE id = p_id AND av_status = 'PENDING';
        ELSE
          RAISE EXCEPTION 'Bad AV source %', p_src;
        END IF;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        RETURN v_n > 0;
      END $$`);
  }
}
