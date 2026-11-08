import { ArgumentsHost, BadRequestException, Catch } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { QueryFailedError } from 'typeorm';

// Опечатка в адресе отвечала 500 — а первая попытка это починить оставляла запрос БЕЗ
// ОТВЕТА, и это было хуже исходной беды.
//
// Идентификаторы в этом API — uuid, и они уходят в SQL параметром. Если в адресе стоит не
// uuid (оборванная ссылка, слово вместо идентификатора, битое письмо), Postgres отвечает
// `invalid input syntax`, код 22P02, а Nest отдавал это как 500 — «мы сломались».
// Пятисотка будит дежурного там, где человек просто ошибся в ссылке.
//
// ПОЧЕМУ `BaseExceptionFilter`, а не `throw` из фильтра. Первая редакция делала
// `if (err.code !== '22P02') throw err;` — и это не передаёт ошибку дальше: Nest брошенное
// из фильтра не подхватывает, базовый фильтр не вызывается, в сокет не пишется ничего.
// `GET /budgets?from=abc` (код 22007, а не 22P02) вис до таймаута клиента. То есть
// пятисоток бы не стало — потому что не стало бы ОТВЕТОВ, и мониторинг на этом замолчал
// бы. Теперь обе ветки идут через `super.catch`: 22P02 — как 400, всё прочее — ровно как
// было, с телом и записью в журнал.
//
// Сообщение про «значение», а не «идентификатор», намеренно: 22P02 ловит и `?year=abc`,
// где сломан числовой параметр, а не идентификатор.
//
// Единственное место, где 22P02 означает испорченные ДАННЫЕ, а не опечатку в запросе, —
// приведения из хранимого `auction_bids.payload` (`auction.service.ts`). Там 400 скажет
// «вы прислали неверное значение», хотя прислал его не пользователь. Случай редкий и
// лучше, чем общее 500, но если он когда-нибудь встретится по-настоящему — чинить надо
// там, а не здесь.
@Catch(QueryFailedError)
export class MalformedIdFilter extends BaseExceptionFilter {
  catch(err: QueryFailedError & { code?: string }, host: ArgumentsHost) {
    if (err.code === '22P02') {
      super.catch(new BadRequestException('Malformed value in the request'), host);
      return;
    }
    super.catch(err, host);
  }
}
