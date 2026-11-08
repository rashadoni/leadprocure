import { MigrationInterface, QueryRunner } from 'typeorm';

// Свой балл без балла победителя отвечает «сколько мне поставили», а не «почему не я».
//
// 0048 дал участнику его собственную оценку по закреплённым критериям. Этого мало, и мерку
// даёт регулируемая закупка: в извещении о решении участнику сообщают не только причины и
// имя победителя, но и СВОЙ балл вместе с баллом победителя — именно это в правилах ЕС и
// Великобритании называется «относительными преимуществами» выбранного предложения. Без
// второго числа первое не сравнить ни с чем.
//
// Балл победителя кладётся СНИМКОМ в присуждение, а не читается из оценок: ровно по той же
// причине, по которой так лежит сумма. Решение принималось на той оценке, которая была в ту
// минуту; переоценка после отзыва присуждения не должна задним числом менять число, по
// которому человеку объяснили отказ. И поставщику не нужен доступ к чужим оценкам: политика
// 0048 по-прежнему отдаёт ему только свои.
//
// NULL — законное значение: у аукциона взвешенной оценки нет вовсе (ценовая борьба И ЕСТЬ
// оценка), и у присуждений, сделанных до этой миграции, числа тоже нет. Выдумывать его
// нельзя — тот же урок, что с суммой в бэкфилле 0047: прочерк честнее придуманной цифры.
//
// Бэкфилл берёт последнюю оценку закупки, если она есть, и ничего не пишет, если её нет.
export class AwardWinnerScore1720000000050 implements MigrationInterface {
  name = 'AwardWinnerScore1720000000050';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE awards ADD COLUMN winning_weighted_total numeric`);
    await q.query(`
      UPDATE awards a SET winning_weighted_total = s.total
      FROM (
        SELECT es.bid_id, sum(es.weighted) AS total, es.evaluation_id
          FROM evaluation_scores es
         GROUP BY es.bid_id, es.evaluation_id
      ) s
      WHERE s.bid_id = a.winning_bid_id
        AND s.evaluation_id = a.evaluation_id
        AND a.winning_weighted_total IS NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE awards DROP COLUMN winning_weighted_total`);
  }
}
