import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AppConfig } from '../config/config.service';

/**
 * Одна строка на запрос: метод, путь, код, время. Больше ничего.
 *
 * ЗАЧЕМ. Nest сам по себе не пишет о запросах НИЧЕГО: `/tmp/leadprocure-api.log` в артефакте
 * `acceptance-evidence` — это 217 строк разбора маршрутов на старте и письма, которые
 * отправил стенд. Отказ 401 на `/auth/refresh`, отказ 429 от ограничителя частоты и запрос,
 * который до api вовсе не дошёл, выглядят в этом файле ОДИНАКОВО — то есть не выглядят
 * никак. Четыре падения приёмки 10 ноября 2026 (`42801928746`, `42810624269`, `42817743475`,
 * `42850811713`) поэтому и перезапускали: в артефакте не было ни одного свидетельства о том,
 * почему браузер оказался на странице входа, и отсутствие слова «429» в этом логе читали как
 * «ограничитель не срабатывал», хотя оно не значило вообще ничего.
 *
 * Правило, ради которого это заведено: гейт обязан записывать то, что он измеряет. Иначе его
 * красный цвет — монетка, а монетку перезапускают.
 *
 * ЧЕГО ЗДЕСЬ НАРОЧНО НЕТ. Ни тел запросов, ни заголовков, ни cookie, ни адреса клиента, ни
 * строки запроса: `?q=` несёт то, что человек набрал руками, а `Authorization` и
 * `Cookie` — доступ. Остаётся ровно то, что нужно, чтобы посчитать частоту и увидеть код
 * ответа. Поэтому строку можно включить и на проде, а не только на одноразовом стенде.
 */
@Injectable()
export class AccessLogMiddleware implements NestMiddleware {
  private readonly log = new Logger('Http');

  constructor(private readonly cfg: AppConfig) {}

  use(req: Request, res: Response, next: NextFunction): void {
    // Выключено — не навешиваем даже обработчик `finish`: выключенный журнал не должен
    // стоить запросу ничего.
    if (!this.cfg.httpAccessLog) {
      next();
      return;
    }
    const started = Date.now();
    res.on('finish', () => {
      const path = (req.originalUrl || req.url).split('?')[0];
      const line = `${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms`;
      // Всё, что не 2xx/3xx, — предупреждением: отказ в логе должен быть виден глазом, а не
      // только через grep. 429 здесь единственный способ узнать, что ограничитель частоты
      // сказал «нет», — своего сообщения он не пишет.
      if (res.statusCode >= 400) this.log.warn(line);
      else this.log.log(line);
    });
    next();
  }
}
