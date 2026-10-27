# Leadprocure — аудит утверждений data sheet

Дата: 26 октября 2026. Исходный документ: `docs/presentations/leadprocure-az/v2/datasheet-content.json`, версия v2-monograph. Проверяемая ветка: `codex/leadprocure-client-presentation-az`, исходный checkpoint `3b14550`. Продукт в рамках аудита не изменялся.

## Заключение

**Все 10 заявленных функциональных блоков имеют реализацию, но утверждение «всё есть и работает правильно» не подтверждается. Найдены существенные ошибки денежных расчётов, выбора победителя, обработки лотов и доступа к файлам. Data sheet пока нельзя использовать как подтверждение проверенной корпоративной готовности.**

Моя предыдущая подготовка материалов подтверждала наличие функций по исходникам, а не корректность всех сквозных сценариев. Это было недостаточной проверкой для столь уверенного описания. Настоящий аудит отделяет наличие реализации от корректности и готовности установленного экземпляра.

Выполнены 15 изолированных сценариев на реальных TypeScript-методах: 12 сценариев воспроизвели дефекты/пробелы проверок, 3 подтвердили конкретные защитные механизмы. Это **не** 15 HTTP/DB E2E: запросы к БД и внешним сервисам заменены контролируемыми адаптерами. Прочитаны реализации API, DTO, контроллеры, миграции, UI и существующие тесты для всех разделов документа. Дополнительно выполнена проверка работающей установки только на чтение.

Приоритет P1 означает: исправить до обещания корректной работы соответствующего процесса клиенту. P2 — существенное ограничение или дефект, который также должен быть устранён/явно отражён. Ни одна находка не означает, что уже произошла утечка или финансовый ущерб.

## Что проверено в работающей установке

- `leadprocure-prod`: API, web, PostgreSQL, MinIO, ClamAV, AI orchestrator запущены; PostgreSQL и ClamAV имеют Docker health=healthy. API `/health` вернул HTTP 200.
- API подключается как `app_user`, `rolsuper=false`, `rolbypassrls=false`. RLS включён на проверенных таблицах bids, bid_items, bid_sealed_payloads, invoices, invoice_items, supplier_verification_documents, audit_events.
- В действующей схеме нет UNIQUE для `(invoice_id, po_item_id)` и `(evaluation_id, bid_id, criterion)`. Это подтверждает отсутствие ограничений, которые могли бы остановить F01/F04 после проверок сервиса.
- В установленном JS подтверждены: фиксированные 18% в UBL, прямое использование `dto.storageKey` при KYC, отсутствие вставки `bid_items` в auction service. SHA-256 этих четырёх JS-файлов сохранены в `runtime-readonly.txt`. Полное совпадение live image с commit worktree **не устанавливалось**.
- Глобальные SMTP_HOST/WHATSAPP_API_URL не заданы. Это **не** доказывает отсутствие каналов отдельных организаций: их настройки в БД не выгружались. Реальная доставка не проверялась.
- AI_ORCHESTRATOR_URL задан; наличие параметра не доказывает качество ответа/работу LLM.
- Установленных лицензий в таблице 0; LICENSE_FILE и LICENSE_PUBLIC_KEY_B64 отсутствуют. Ответ «enterprise / valid» здесь соответствует dev fallback, а не проверенной коммерческой лицензии.
- Запросы к PostgreSQL выполнялись в `BEGIN READ ONLY`, завершены `ROLLBACK`. Клиентские документы, сообщения, торги, счета и настройки не изменялись; секреты не выводились.

## Матрица 10 возможностей

«Реализовано» ниже означает найденный работающий путь в коде, но не полную приёмку в production. Существующие E2E перечислены как покрытие в репозитории; они не запускались заново.

| Утверждение | Реальная реализация и граница | Вердикт / находки | Существующее покрытие |
|---|---|---|---|
| Реверс-аукцион: лучшая цена, следующий максимум, шаг, продление | AuctionService.state/placeBid, advisory lock, auction_state/auction_try_extend, AuctionPanel. Ограничение числа продлений есть | Базовые механизмы есть; выбор победителя не контролирует минимум, переход к PO нарушен: F03/F10 | auction-flow: шаг, состояние, продление, идемпотентность, award; нет отрицательного выбора худшей цены и PO после аукциона |
| Секретные RFQ/RFP; RFI; общий Q&A | AES-GCM, запрет подачи после срока, buyer opening gate, RFP text+price sealed, RFI без цен/award; опубликованные ответы общие | Реализовано. Криптография проверена локально. Нельзя распространять утверждение изоляции на все файлы: F07. Полная конкурентная проверка открытия не выполнена | sourcing-flow, rfi-rfp, rls-acl, auction-flow Q&A |
| Согласование по сумме; разделение полномочий | Политики материализуются в approval_steps; approve блокирует строку, запрещает автора и повторного согласующего | Реализовано; запрет самосогласования проверен. Политики редактируются администратором; не произвольный workflow/BPM. Полное конкурентное approve/reject/update не проверено | approval, integrity |
| Лоты, заранее заданные критерии, обоснование исключений | Критерии сохраняются при создании; award проверяет наличие evaluation и justification для одного/не первого участника | Частично корректно: оценка допускает пустые/повторные баллы F04; UI F16; дальнейший договор/заказ теряет границы лота F08 | multilot заканчивается на award; integrity — типовые запреты |
| Объяснимый AI по цене, сроку, истории | Локальная формула 50/20/30, scorecards, нейтральные 60 без истории; внешний orchestrator и fallback; winner не назначается автоматически | Название AI требует уточнения: локально это эвристика. Нули F05, несопоставимые суммы F06. Не подтверждена точность LLM | sourcing-flow: рекомендация и gate; нет нулей/разных валют/разного набора лотов |
| Реестр, приглашение, approval/block, KYC, scorecard | CRUD статусов, кейсы/документы, buyer decision, OTIF/QUALITY/COMMS | Статус BLOCKED не общий запрет участия F11. Ключи KYC-файлов не привязаны к загрузке/владельцу F07. Проверка вручную, не государственный KYC | verification; безопасность чужих storageKey не покрыта |
| Договоры, PO, приёмка, изменения с согласием, каталоги/MOQ | PO state machine, GRN, supplier-only amendment decision, MOQ guard | Механизмы есть, MOQ воспроизведён. Многолотовый downstream F08, auction downstream F10; конкурентная приёмка R01 | sourcing-flow, amendments, catalogs, integrity |
| Трёхсторонняя сверка, обоснование спорной оплаты | invoice сравнивает price и received−previously invoiced; rematch после GRN; override reason; PAID статус | F01 позволяет завысить счёт без DISPUTED; R01 гонки. Это не готовый безусловный контроль оплаты | invoices, integrity; нет дублей строк и параллельных счетов |
| Бюджеты, предупреждения, аналитика | Обязательства = APPROVED requests по категории/году/валюте; soft warnings. Spend = ACCEPTED PO | Бюджетный механизм есть. Аналитика содержит F12. Год бюджета берётся из created_at заявки, месяц spend — из created_at PO, не даты приёмки/оплаты | budgets, analytics; нет многолотовых/отменённых awards и mixed currency |
| Плановые email/WhatsApp цепочки, остановка по ответу/вручную | enroll, cron, followup_mark_responded; SMTP/Meta template sender; stop endpoint | Реализовано условно. SENT может означать только console F18; обработка UPDATE у stop F09. Фактическая доставка не проверена | followups использует подменённые отправители, не доказательство доставки Meta/SMTP |

## Остальные утверждения документа

| Раздел | Результат |
|---|---|
| 4 роли | JWT auth + RolesGuard + декораторы контроллеров + DB контекст существуют. Runtime app_user не owner/superuser. Полная матрица всех endpoints для всех ролей не прогнана |
| AZ/RU/EN | Есть три словаря и переключатель, страницы всех перечисленных модулей. Полная языковая локализация не подтверждена: в UI, AI reasons и followup-тексте есть жёстко заданные английские/смешанные строки |
| Валюта/серверные суммы | Серверные пересчёты есть; это не полноценная нормализация валют. Currency принимается у bid, сравнение/контракты F06. JS Number вместо безопасной целочисленной арифметики; экстремальные суммы отдельной проверкой не покрыты |
| VÖEN/построчный НДС/AZN | Валидация VÖEN и ставки по PO-строке есть. Inclusive VAT теряется F14, UBL неверен для иных ставок F02. В типовой форме заявки ставка не предоставляется как полноценный редактор всех налоговых режимов |
| SaaS с разделением организаций | Реальная облачная установка и RLS подтверждены; F07 — исключение на уровне объектного хранилища. Это нельзя описывать как завершённый аудит безопасности |
| On-prem + лицензирование | Compose/env, deploymentMode и лицензирование есть. Отдельное внедрение на инфраструктуре клиента, backup/restore/upgrade и лицензия клиента не испытаны; F17 |
| UBL/OCDS | Файлы формируются; F02/F13 нарушают достоверность содержимого. XSD/Schematron/OCDS schema validation: NOT RUN. Нельзя обещать сертифицированную совместимость |
| 1C CSV | export1cCsv выдаёт UTF-8 BOM, `;`, заголовок и суммы. Реальная загрузка в конкретную конфигурацию 1C не тестировалась; формулировка «адаптируемый CSV» корректнее интеграции |
| SMTP/Meta | Отправители, настройки, шаблоны, webhook есть. Реальная доставка/приём callback/активация конкретной организации не проверены; F18 |
| AES-256-GCM | Реальный алгоритм подтверждён round-trip + отказом при подмене ciphertext. Ключи/ротация/восстановление после утраты ключа не тестировались |
| Неизменяемый аудит | В миграции trigger запрета UPDATE/DELETE и REVOKE, runtime RLS включён; текст data sheet об ограничении app user обоснован. Не означает неуязвимость для администратора БД; независимая проверка hash-chain не проводилась |
| Серверный дедлайн | Основные bid endpoints проверяют время сервера. Но withdraw проверяет только status OPEN, а не close_at; до тика scheduler возможен отзыв после срока. Конкурентное submit/open/close требует интеграционной проверки |
| Ограничения бюджета/PAID | Честно сформулированы: бюджет не блокирует, PAID не переводит деньги |
| CSV ≠ live ERP; отдельный Peppol Access Point | Условие корректно описывает границу реализации; нет доказательства подключения ERP/Peppol |
| Ручной KYC/неактивная ASAN | Соответствует текущей границе: signature provider является dev-провайдером, не реальной ASAN-подписью |
| LLM/каналы зависят от конфигурации | Соответствует архитектуре. Включённый URL не доказательство исправной интеграции |
| Лицензия/не сертификат | Оговорка полезна, но не исправляет F17 и содержательные ошибки экспортов |
| Pilot/целевая аудитория | Предлагаемый процесс внедрения и позиционирование, не исполняемая функция; технического подтверждения не требуют |

## Находки с доказательствами и критериями исправления

### F01 · P1 · Повтор строки обходит трёхстороннюю сверку

Источник: [apps/api/src/modules/invoices/invoices.module.ts:49](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/invoices/invoices.module.ts:49), миграция `1720000000016-invoices.ts:31`, rematch `1720000000025-invoice-rematch.ts:42`.

Принято 10 единиц. Отправляем в одном invoice две строки одного poItemId по 10. Обе сверяются с одним остатком 10, потому что invoice_items вставляются только после цикла проверки. Результат метода: MATCHED, выставлено 20. Нет агрегирования/дедупликации по позиции и нет UNIQUE в действующей БД. Rematch также сравнивает каждую строку отдельно, исключая остальные строки текущего invoice из ранее выставленного количества.

Воспроизведение: `F01_duplicate_invoice_lines`. Это **не** ручное разрешение спорного счёта: спорный статус вообще не появляется. Исправление: сверять агрегированные количества на позицию, отвергать дубли либо объединять их, атомарно резервировать доступное количество; отрицательные HTTP+DB тесты на дубль и rematch.

### F02 · P1 · UBL противоречит реальному построчному НДС

Источник: [apps/api/src/modules/invoices/invoices.module.ts:169](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/invoices/invoices.module.ts:169).

XML каждой позиции содержит category S и Percent=18, независимо от vat_rate_bp. Счёт с 0% даёт общий VAT=0.00 и строку 18%. В живом JS такой шаблон тоже найден. Воспроизведение `F02_ubl_zero_vat` генерирует настоящий XML. Исправление: снапшот ставки/категории налога в invoice, группировка налоговых итогов, экспорт этих данных; проверить смешанные ставки и выбранный профиль UBL независимым валидатором.

### F03 · P1 · Аукцион позволяет назначить не лучшую цену без обоснования

Источник: [apps/api/src/modules/sourcing/sourcing.service.ts:552](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/sourcing/sourcing.service.ts:552).

Для AUCTION/REVERSE ветка пропускает formal evaluation и justification. Далее проверяется только состояние OPENED выбранной заявки. Сравнения с лучшей ценой нет. Комментарий «awards the best bid» не соответствует проверкам. `F03_auction_awards_nonlowest` подтверждает отсутствие запроса рейтинга и успешный award выбранного OPENED bid. Существующий auction-flow сам выбирает минимум в тесте, поэтому дефект не обнаруживает.

Исправление: серверное определение лучшего допустимого участника; для предусмотренного бизнесом исключения — отдельное правило/обоснование; тест отправки худшего bidId. Проверять принадлежность lotId данному event также в auction branch.

### F04 · P1 · «Формальная оценка» допускает пустые и дублированные баллы

Источник: [apps/api/src/modules/sourcing/sourcing.service.ts:482](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/sourcing/sourcing.service.ts:482), [apps/api/src/common/db/migrations/1720000000000-init.ts:264](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/common/db/migrations/1720000000000-init.ts:264).

`scores: []` создаёт evaluation без баллов. Повтор одной пары bidId/key суммируется: два price=100 при весе 100 дают 200/100. Ни сервис, ни действующая схема не требуют полного уникального набора оценок. Award считает само наличие evaluation достаточным; неоценённые eligible bids получают −1, из них всё равно выбирается top.

Воспроизведения `F04_empty_formal_evaluation`, `F04_duplicate_formal_scores`. Исправление: полный набор критериев на допустимую заявку/лот, запрет повторов, уникальность в БД, проверка завершённости оценки перед award. Нельзя сводить исправление к ограничению поля HTML.

### F05 · P2 · AI выдаёт NaN для допустимых нулевых значений

Источник: [apps/api/src/common/ai/ai-scorer.ts:75](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/common/ai/ai-scorer.ts:75), DTO [apps/api/src/modules/sourcing/sourcing.module.ts:43](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/sourcing/sourcing.module.ts:43).

Нулевая цена и deliveryDays=0 допустимы. Формулы bestPrice/total и bestDelivery/deliveryDays дают 0/0; JSON сериализует эти числа в null, rationale содержит NaN. `F05_ai_zero_values` подтверждено. Исправление: явная семантика нулевой цены/доставки, finite score validation, одинаковое поведение внешнего scorer и fallback.

### F06 · P1 · Валюты и объём лотов не нормализованы

Источники: [apps/api/src/modules/sourcing/sourcing.service.ts:381](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/sourcing/sourcing.service.ts:381), [apps/api/src/common/ai/ai-scorer.ts:50](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/common/ai/ai-scorer.ts:50), [apps/api/src/modules/contracts/contracts.module.ts:83](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/contracts/contracts.module.ts:83).

Поставщик может указать валюту, отличную от evaluation_currency. AI сравнивает raw total_minor, не читает currency/fx; HttpAiScorer отправляет одну валюту события и числовые итоги разных bids. Контракт берёт сумму bid, но валюту event. Это может не только исказить рейтинг, но и переименовать валюту суммы. Кроме того, поставщик вправе пропустить целые лоты, однако AI сравнивает общий итог частичного и полного предложения как одинаковую закупку.

`F06_ai_incomparable_currency` воспроизводит сортировку 100 USD перед 150 AZN без FX. Не делается утверждения о текущем обменном курсе; дефект — отсутствие любого курса/нормализации. Исправление: до реализации FX запретить иную валюту; рейтинг и downstream считать по сопоставимому лоту/валюте.

### F07 · P1 · Можно зарегистрировать чужой storageKey и получить подписанную ссылку

Источники: [apps/api/src/modules/verification/verification.module.ts:71](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/verification/verification.module.ts:71), [apps/api/src/common/storage/documents.module.ts:73](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/common/storage/documents.module.ts:73), [apps/api/src/common/storage/documents.module.ts:126](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/common/storage/documents.module.ts:126).

Presign генерирует ключ с orgId, но confirm принимает произвольный storageKey. Привязки к выданному upload, проверки префикса владельца и подтверждения содержимого нет. Затем download подписывает ключ из этой новой «своей» строки БД. RLS на metadata не защищает чужой объект, на который ссылается metadata. KYC дополнительно принимает sha256 клиента как факт и обходит общий AV lifecycle.

`F07_kyc_foreign_storage_key` подтверждает путь реальных методов с подменой signer. Условие эксплуатации — знание действующего чужого ключа; UUID снижает угадываемость, но не заменяет авторизацию. Чужие реальные файлы не запрашивались. Прямой storageKey найден и в установленном KYC JS.

Исправление: upload record с org/entity/nonce, серверная проверка владения и завершения загрузки, безопасная выдача URL, фактический hash/AV lifecycle. Нужен отрицательный E2E с двумя тестовыми организациями и MinIO.

### F08 · P1 · Многолотовый award превращается в договор/PO на всё предложение

Источники: [apps/api/src/modules/contracts/contracts.module.ts:80](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/contracts/contracts.module.ts:80), [apps/api/src/modules/contracts/contracts.module.ts:159](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/contracts/contracts.module.ts:159), [apps/api/src/modules/catalogs/catalogs.module.ts:39](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/catalogs/catalogs.module.ts:39).

Contract header использует b.total_minor всего bid. Выборка PO и catalog-from-contract соединяется с winning_bid_id, но не ограничивает ei.lot_id = a.lot_id. Если поставщик выиграл A, но подавал также B, в заказ попадут A+B. `F08_multilot_po_scope`: выигранный лот 100 + чужой лот 900 → PO 1000.

UI создаёт контракт лишь из `ev.awards[0]` ([apps/web/src/pages/buyer/EventDetail.tsx:139](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/web/src/pages/buyer/EventDetail.tsx:139)); отменённые awards в этом месте не исключаются. API createFromAward также не проверяет cancelled_at. Это дополнительные препятствия достоверному сквозному процессу.

Исправление: единая lot-scoped выборка цены/позиций для договора, PO, каталога; запрещать отменённые awards; UI действий по каждому действующему лоту; E2E два поставщика × два лота до invoice, а не только до award.

### F09 · P2 · UPDATE RETURNING неправильно разобран в ряде методов

Источник: [apps/api/src/modules/followups/followups.module.ts:135](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/followups/followups.module.ts:135); похожий шаблон в supplier setStatus, Q&A answer, contract/catalog activate.

TypeORM PostgreSQL UPDATE отдаёт `[rows, count]`, а методы проверяют `rows.length` и читают `rows[0].id`. У stop теряется entityId аудита; при `[[],0]` запрос отсутствующей записи может сообщать успех. Это не означает, что само UPDATE остановки не выполняется. `F09_followup_stop_returning_shape` воспроизводит обработку документированной формы результата.

Исправление: единый корректный helper или SELECT существующей записи + affected count; тест успешной и отсутствующей записи через настоящий TypeORM.

### F10 · P1 · Аукцион не доведён до заказа с ценовыми строками

Источники: [apps/api/src/modules/sourcing/auction.service.ts:188](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/sourcing/auction.service.ts:188), [apps/api/src/modules/sourcing/auction.service.ts:218](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/sourcing/auction.service.ts:218), [apps/api/src/modules/contracts/contracts.module.ts:168](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/contracts/contracts.module.ts:168).

Аукцион сохраняет items только в auction_bids.payload, total — в bids. Ни placeBid, ни finalize не материализуют bid_items; соответствующего trigger в миграциях нет. Контракт → PO требует bid_items и выдаёт «No priced items on the awarded bid». Catalog-from-contract тоже получает пустой набор. В живом auction JS нет вставки bid_items.

`F10_auction_no_priced_lines_for_po` проверяет настоящий placeBid и отказ createOrder на таком состоянии. Исправление: сохранять согласованный snapshot строк последней принятой ставки победителя при финализации; E2E auction→contract→PO→GRN→invoice.

### F11 · P1 · BLOCKED не блокирует участие во всех каналах

Источники: [apps/api/src/modules/suppliers/suppliers.module.ts:100](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/suppliers/suppliers.module.ts:100), [apps/api/src/modules/sourcing/sourcing.service.ts:165](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/sourcing/sourcing.service.ts:165), [apps/api/src/modules/sourcing/sourcing.service.ts:329](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/sourcing/sourcing.service.ts:329), [apps/api/src/modules/sourcing/auction.service.ts:115](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/sourcing/auction.service.ts:115), [apps/api/src/modules/catalogs/catalogs.module.ts:115](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/catalogs/catalogs.module.ts:115).

Статус сохраняется в supplier_relationships, но sourcing invitation/bid/auction/award и catalog ordering его не проверяют. RLS доступ к событию строит по PUBLIC/invitation, не по BLOCKED. Реальное ограничение APPROVED есть в direct-order path. Поэтому обещание «блокировки» без уточнения вводит клиента в заблуждение: это не единый deny-list.

Подтверждено чтением всех ссылок на supplier_relationships в сервисах/миграциях; полноценный двухпользовательский HTTP сценарий NOT RUN. Исправление: определить, что блокируется для новых и действующих торгов, и централизованно применить это правило; не ломать уже принятые обязательства без бизнес-решения.

### F12 · P2 · Денежная аналитика включает несопоставимые/отменённые суммы

Источник: [apps/api/src/modules/dashboard/dashboard.module.ts:20](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/dashboard/dashboard.module.ts:20), [apps/api/src/modules/dashboard/dashboard.module.ts:114](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/dashboard/dashboard.module.ts:114).

Awarded spend/savings суммируют b.total_minor на каждый award, не стоимость выигранного лота; не исключают cancelled_at. Пример: bid 1000 по двум лотам выигрывает оба — сумма awards 2000 вместо 1000. После отмены и нового award старый остаётся в сумме. Monthly/category/supplier/invoice totals не группируются по валюте и не имеют FX. Наличие поля currency в другом модуле не делает такую сумму корректной.

Месяц берётся из даты создания PO; это надо обозначить, если клиент ожидает месяц фактической приёмки. Исправление: активные awards, цены по лотам, валютная группировка, согласованная дата spend; контрольный fixture с заранее известным итогом.

### F13 · P2 · OCDS экспортирует отменённый результат как действующий

Источник: [apps/api/src/modules/sourcing/sourcing.service.ts:716](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/sourcing/sourcing.service.ts:716).

Все ev.awards преобразуются в status=active, включая cancelled_at. `suppliers` явно undefined; стоимость award не экспортируется. `F13_ocds_cancelled_award_active` подтверждает результат настоящего serializer. Это не полноценный корректный экспорт результата закупки, даже с оговоркой «не сертификат».

Исправление: актуальные статусы, поставщик и lot-scoped value; тест cancel/reaward; затем валидация выбранной версии OCDS. В рамках аудита не заявляется результат внешнего schema validator.

### F14 · P1 · VAT INCLUSIVE теряется на переходе к PO/invoice

Источники: [apps/api/src/modules/requests/requests.module.ts:28](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/requests/requests.module.ts:28), [apps/api/src/modules/contracts/contracts.module.ts:181](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/contracts/contracts.module.ts:181), [apps/api/src/modules/invoices/invoices.module.ts:40](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/invoices/invoices.module.ts:40).

Request/event/contract хранят vat_mode, но PO не переносит налоговый режим, invoice не читает его и всегда считает qty×price как net плюс VAT. Для цены 118.00 с включёнными 18% такой путь приводит к net=118.00, VAT=21.24, gross=139.24, хотя включённая итоговая цена была 118.00. По исходникам; отдельный live/DB сценарий не выполнялся.

Исправление: однозначная нормализация inclusive/exclusive с момента заявки, snapshot net/tax/gross/режима до счета, правила округления; сквозные тесты обоих режимов и смешанных ставок.

### F16 · P2 · UI оценки не соответствует серверным критериям и версиям

Источники: [apps/web/src/pages/buyer/EventDetail.tsx:74](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/web/src/pages/buyer/EventDetail.tsx:74), [apps/web/src/pages/buyer/EventDetail.tsx:105](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/web/src/pages/buyer/EventDetail.tsx:105), [apps/api/src/modules/sourcing/sourcing.service.ts:297](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/sourcing/sourcing.service.ts:297).

API принимает произвольные заранее заданные критерии, но UI всегда отправляет price/delivery и подписывает 70/30. Custom criterion невозможно корректно оценить этим экраном. Detail возвращает scores всех evaluations; UI складывает их, а award использует только последнюю evaluation. После переоценки отображаемый балл не совпадает с основанием выбора. Исправление: render locked criteria, возвращать/использовать одну актуальную версию оценки; проверить переоценку и нестандартные критерии.

### F17 · P2 · Лицензирование не подтверждает обещанную эксплуатационную модель

Источник: [apps/api/src/common/license/entitlement.service.ts:31](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/common/license/entitlement.service.ts:31), [apps/api/src/common/license/entitlement.service.ts:71](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/common/license/entitlement.service.ts:71).

При отсутствии/невалидном файле используется fallback со всеми FEATURE_KEYS. computeStatus вызывается при reload, но canCreateNew/status возвращают сохранённый snapshot; без reload/restart течение времени само не переводит его в expired. В работающей установке нет установленной лицензии, health «valid» — fallback.

Это не отсутствие on-prem deployment, а ограничение enforcement. Исправление: production fail-closed согласно продуктовой политике, проверка времени на обращении/периодическое обновление, испытания valid→grace→expired и обновления лицензии на стенде.

### F18 · P2 · SENT не доказывает реальную доставку напоминания

Источники: [apps/api/src/modules/followups/followups.module.ts:211](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/followups/followups.module.ts:211), [apps/api/src/common/mail/mail.module.ts:15](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/common/mail/mail.module.ts:15), [apps/api/src/common/db/migrations/1720000000024-followups.ts:119](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/common/db/migrations/1720000000024-followups.ts:119).

При отсутствии org/global channel используются console providers, после их успешного возврата логируется SENT. Установка не имеет глобальных SMTP/WA URL; статус конкретного клиента зависит от org channel. Дополнительно шаг цепочки сначала продвигается в БД, потом отправляется: падение между этими действиями теряет отправку, per-step durable retry отсутствует. Ручная остановка/новая заявка после выборки due не отменяет уже взятое на отправку сообщение.

Исправление: отличать SIMULATED/NOT_CONFIGURED от SENT, outbox с retry/idempotency, проверять остановку перед dispatch. Приёмка доставки требует реальных тестовых адресов/согласованного Meta шаблона; в аудите сообщения не отправлялись.

## R01 · высокий риск, требует PostgreSQL-воспроизведения (не объявлен подтверждённым race)

Invoice submit и GRN createReceipt читают остатки до записи без общей блокировки PO/позиции. Две транзакции могут увидеть одинаковое previously invoiced/received. `next_document_no` вызывается после сверки: даже если он сериализует выдачу номера, уже принятая проверка не пересчитывается. Invoice_set_status блокирует invoice, а не весь расходуемый остаток. GRN учитывает дубли внутри одного запроса, но не другую транзакцию.

Источники: [apps/api/src/modules/invoices/invoices.module.ts:40](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/invoices/invoices.module.ts:40), [apps/api/src/modules/contracts/contracts.module.ts:260](/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az/apps/api/src/modules/contracts/contracts.module.ts:260). Требуется отдельный DB-тест с барьерами двух соединений и одинаковыми исходными остатками. До проверки это статически обоснованный риск, а не измеренный факт в production. Нужна одна согласованная стратегия блокировок для invoice/receipt/amendment/rematch.

## Границы и непройденные проверки

- Full API E2E / full browser E2E / build: **NOT RUN** — host contract запрещает тяжёлые проверки на Contabo; в worktree нет зависимостей. Тестовый setup подхватывает корневой .env: без отдельной базы запуск мог бы затронуть рабочие данные.
- HTTP+PostgreSQL adversarial regressions: **NOT RUN** — отдельный проверенный disposable DB+MinIO стенд не подготовлен. Service doubles не проверяют RLS, SQL execution, сериализацию транзакций или DTO pipeline.
- Реальный SMTP/Meta/Peppol/1C/ASAN: **NOT RUN** — нет авторизованного интеграционного прогона с тестовыми получателями/учётными данными/контрагентом.
- Полный browser role/language matrix: **NOT RUN** — выполнено чтение UI; sign-in браузера не проводился.
- UBL/OCDS validation официальными схемами: **NOT RUN**; в отчёте показаны внутренние содержательные ошибки, не выдуманный результат сертификации.
- Backup restore, HA/load, tenancy penetration test, key rotation, customer on-prem install: **NOT RUN**, не входят в выполненные проверки.
- Ошибки не исправлялись, приложение/production не пересобирались, push/merge/deploy отсутствуют. Статус healthy не заменяет перечисленные gates.

## Как изменить коммерческие формулировки до исправлений

Исходные PPTX/PDF сохранены, не переписаны молча. Рекомендуемые временные AZ-формулировки:

- Revers-auksion: «Canlı qiymət rəqabəti, minimum endirim addımı və məhdud vaxt uzadılması. Qalib seçimi və sonrakı sifariş axını pilotda ayrıca yoxlanılır.»
- Üçtərəfli üzləşdirmə: «PO, qəbul və qaimə məlumatlarının müqayisəsi mövcuddur; avtomatik nəzarətin sərhəd halları əlavə sınaq tələb edir.»
- Lotlar: «Lotlar üzrə seçim mövcuddur. Müqavilə və sifarişə ötürülən mövqelər pilot mərhələsində yoxlanılır.»
- Təchizatçılar: «Təchizatçı reyestri, status uçotu və alıcının qərarına əsaslanan sənəd baxışı.» Не обещать полный запрет участия заблокированного поставщика.
- AI: «Qiymət, çatdırılma və tarixçə əsasında izah edilən köməkçi sıralama; eyni valyuta və müqayisə edilə bilən həcm üzrə istifadə olunur.» Нулевые значения требуют исправления даже при такой оговорке.
- İxrac: «UBL və OCDS ixrac modulları mövcuddur; vergi və nəticə məlumatlarının düzgünlüyü inteqrasiya sınaqlarında təsdiqlənməlidir.»
- Xatırlatmalar: «SMTP/Meta kanalları və təsdiqlənmiş şablonlar sazlandıqdan sonra planlı xatırlatmalar; faktiki çatdırılma pilotda yoxlanılır.»

**Оговорки не устраняют F01/F07 и другие P1. Для корпоративного запуска нужны исправления, а не только смягчение текста.**

## Рекомендуемый порядок работ

1. F07: привязка/авторизация файлов; F01+R01: остатки/дубли/конкурентный учёт.
2. F08/F10: сквозные lot/auction → contract → PO; F03/F04/F16: корректное решение и отображение оценки.
3. F06/F14/F02/F12/F13: единая денежная/налоговая модель, аналитика и экспорты.
4. F11/F05/F09/F17/F18: enforcement статусов, крайние значения, возвращаемые результаты, лицензии и доставка.
5. На выделенном стенде выполнить негативные и сквозные сценарии, затем актуализировать утверждения data sheet по фактически пройденной приёмке. Редактирование документов само по себе не закрывает дефекты.

Артефакты: `reproduce.cjs`, `reproduction-results.json`, `runtime-readonly.txt`. Исходный текст data sheet и хеши проверяемых файлов — `manifest.json`.
