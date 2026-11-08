import { ArgumentsHost, BadRequestException, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

// Опечатка в адресе отвечала 500.
//
// Идентификаторы в этом API — uuid, и они уходят в SQL параметром. Если в адресе стоит не
// uuid (человек оборвал ссылку, подставил слово, кликнул по битому письму), Postgres
// отвечает `invalid input syntax for type uuid`, а Nest отдаёт это как 500 — «мы
// сломались». Пятисотка попадает в мониторинг как авария и будит того, кто дежурит, хотя
// произошла обычная опечатка.
//
// Фильтр узкий намеренно: ловится ровно код 22P02 (invalid_text_representation) и ровно он
// превращается в 400. Любая другая ошибка базы остаётся тем, чем была, — иначе фильтр начал
// бы прятать настоящие поломки за «неверный запрос», а это хуже исходной беды.
@Catch(QueryFailedError)
export class MalformedIdFilter implements ExceptionFilter {
  catch(err: QueryFailedError & { code?: string }, host: ArgumentsHost) {
    if (err.code !== '22P02') throw err;
    const res = host.switchToHttp().getResponse();
    const body = new BadRequestException('Malformed identifier in the request').getResponse();
    res.status(HttpStatus.BAD_REQUEST).json(
      typeof body === 'string' ? { statusCode: 400, message: body, error: 'Bad Request' } : body,
    );
  }
}
void HttpException;
