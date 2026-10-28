# Leadprocure — итог глубокого аудита data sheet

28 октября 2026. Репозиторий: rashadoni/leadprocure. Проверяемый main:11c351bb7b82209fb2a25d27b69a3f9ac9cb82d8.

## Результат

PR3–6 и затем PR7–9 объединены по двум явным разрешениям владельца. Закупочные исправления согласованы с существующим расширенным бюджетированием; исходная несовместимость period_year устранена переносом действующего процесса, без восстановления устаревшей модели и переписывания применённых миграций.

**Полная приёмка конечного main PASS:** [run40654892904](https://github.com/rashadoni/leadprocure/actions/runs/40654892904).25 suites/283 API +3 contention tests +10 native Chromium +1 отдельный fresh HTTPS scenario; full build/typecheck, UBL/OCDS schemas, два migration baselines, rollback/idempotency и dump/restore PASS.47 миграций и51 RLS-enabled table. Fresh signed-file license, private S3 и реальные clean/EICAR verdicts PASS. Доказательства: [ACCEPTANCE-MAIN-RECONCILED-2026-10-28.json](ACCEPTANCE-MAIN-RECONCILED-2026-10-28.json).

Production не обновлялся. Проверки ниже выполнены на изолированных GitHub workers с синтетическими данными; действующий runtime остаётся отдельной веткой400f861 до отдельно разрешённого выпуска. Утверждение «все20 задач полностью приняты в production» было бы неверным.

## Все20 исходных задач

| ID | Область | Проверенный результат и существенная граница |
|---|---|---|
| LP-A00 | Изолированный стенд | Hosted API/DB/storage, guard, upgrade и restore PASS; runtime не использован для записей |
| LP-A01 | Файлы | Upload grants, неизменяемый hash/snapshot, namespace/RLS, private presigned URLs, real CLEAN/EICAR PASS |
| LP-A02 | Количества | Блокировки и duplicate guards для invoice/GRN/amendment, concurrent HTTP PASS |
| LP-A03 | Лоты | Award→contract→PO/catalog ограничены выигранным лотом; отменённый award отклоняется |
| LP-A04 | Reverse auction downstream | Принятые позиции ставки доходят до PO/приёмки/счёта; проверена настоящая API-цепочка |
| LP-A05 | Выбор победителя | Сервер проверяет лучший допустимый bid и принадлежность лоту |
| LP-A06 | Оценка | Критерии фиксируются до bidding; полный уникальный набор, актуальная оценка и award guards |
| LP-A07 | Экран оценки | Native Chromium проверяет собственные критерии и повторную оценку без суммирования старого результата |
| LP-A08 | Валюта и объём | Несопоставимая валюта отклоняется, расчёты scoped по лоту, safe integer money; автоматический FX не обещается |
| LP-A09 | НДС | Integer net/tax/gross и tax snapshots; существующие исторические строки не пересчитываются автоматически |
| LP-A10 | UBL |2 реальных экспорта проходят OASIS UBL2.1 XSD; Peppol Access Point/network не реализован |
| LP-A11 | BLOCKED supplier | Новые действия запрещены, существующие обязательства продолжаются |
| LP-A12 | AI | Heuristic edge cases, проверка внешнего ответа/fallback и локализованные объяснения; действующий внешний LLM не принят |
| LP-A13 | Аналитика/бюджет | Действующие лоты, net/валюта/даты; отделы, периоды, план/факт/YoY, lifecycle, exact limits, access, finance API/UI и конкурирующее согласование PASS |
| LP-A14 | OCDS | Отмена/re-award, value/supplier и canonical1.1.5 schema PASS; отдельный downstream consumer не принят |
| LP-A15 | TypeORM | UPDATE/DELETE RETURNING нормализован; IDs/affected rows проверены на PostgreSQL |
| LP-A16 | Лицензирование | Реальная подпись/сроки/grace/restriction/tenant controls и fresh file mount PASS; коммерческая лицензия оператора ещё не установлена |
| LP-A17 | Доставка | Durable outbox, NOT_CONFIGURED/UNKNOWN/reconcile и HMAC callbacks PASS; реальная SMTP/Meta доставка NOT RUN — подключений нет |
| LP-A18 | Дедлайны | Серверное время, advisory locks, параллельные close/late requests;1 close audit и0 late accepted |
| LP-A19 | Общая приёмка | Изолированная техническая приёмка выполнена; внешняя/клиентская и production приёмка остаются отдельными |

## Что дополнительно исправлено в действующем бюджетном процессе

- Сохранены подразделения, месячные/квартальные периоды, документ бюджета, финансовый шаг согласования, ревизии, закрытие со снимком, помесячный план и связи request/PO/invoice.
- Прямой UUID не обходит ограничения подразделения для documents/revisions/phasing/impact и изменений бюджета.
- Черновик не скрывает действующий лимит; нулевой лимит и превышение на1minor unit сравниваются точно, отдельно от округлённого процента.
- По умолчанию превышение бюджета предупреждает; блокировка действует при настроенном пороге, а override администратора требует причины.
- Конкурирующие заявки сериализуют проверку общего лимита. Изменения плана используют ту же блокировку организации.
- Финансовый сотрудник проходит обычный browser login, выполняет назначенный финансовый шаг, создаёт план через форму; закупочные полномочия не расширены.
- Подразделение с финансовой историей нельзя удалить; нормализованы результаты назначения подразделения и UPDATE.
- Обе существующие истории миграций сохранены по именам/timestamps/SHA256 файлов:35+12 и40+7 →47, суммы старого плана сохранены, повторный запуск пустой.

Независимое ревью выполнено отдельным Codex-агентом: он нашёл реальные дефекты и повторно проверил исправления. Зелёный GitHub agent-review получен по fallback из-за недостаточного баланса Anthropic, автоматического семантического разбора workflow не было. Это различие явно отражено в PR.

## Материалы

Презентация на азербайджанском:13 слайдов; data sheet:2 страницы A4, оба в редактируемом PPTX и PDF. Файлы v3 не менялись при интеграции бюджетов. LibreOffice и native Google Slides импорт/экспорт:15 страниц,100% текста, нужные шрифты, отсутствие overflow/missing glyphs; визуальный просмотр выполнен. Desktop Microsoft PowerPoint NOT RUN — подключённого приложения нет.

Существующие AZ guide assets сохранены и проверены по LFS hash/size,17 route keys имеют PNG/WEBM. Это не полная повторная редакционная приёмка озвучки. Старый отладочный probe с retired public default исключён из итогового дерева; история сохранена.

## Граница будущего выпуска

Нет production-разрешения и обновления. Read-only inspection выявил смешанные Compose working directories, dirty runtime checkout и отсутствие установленной подписанной лицензии. Перед выпуском нужны единый согласованный route, подходящая лицензия оператора, защищённый реальный backup с проверенной процедурой восстановления и5 исторических invoice lines с согласованной tax export policy. Никакие клиентские суммы, env или ключи в отчёт не перенесены.

Нет SMTP/Meta test connections и отдельного клиентского commercial/public-TLS окружения. ARM, capacity/SLA benchmark, реальный production storage upgrade, live ERP/банк/ASAN/Peppol не приняты. PAID — учётная отметка, CSV — файловый обмен, dev signature — не ASAN.

Полные сборки, browser E2E и source-built container images выполнялись только на hosted ephemeral workers. На persistent Contabo — редактирование, чтение runtime и небольшие последовательные проверки.
