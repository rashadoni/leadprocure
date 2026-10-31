# Leadprocure — передача Claude, 31 октября 2026

Часовой пояс: Asia/Baku. Это полный снимок задач, результатов и ограничений. Приложение при подготовке передачи не менялось.

## Итог

Из исходных **20 задач LP-A00–LP-A19**:

- **18 технически выполнены и проверены:** LP-A00–LP-A16 и LP-A18, в указанных ниже границах.
- **LP-A19 выполнена частично:** техническая приёмка и материалы готовы; часть внешних проверок NOT RUN.
- **LP-A17 SMTP/Meta исключена владельцем.** Часть исторического кода была исправлена, реальная внешняя доставка не проверена. Не возвращать в очередь.

Действующий объём — **19 задач**. Полностью нетронутых активных задач в матрице нет. Это не означает полной внешней или production-приёмки. NOT RUN не является PASS.

Последняя доставка — [PR34](https://github.com/rashadoni/leadprocure/pull/34), main **5782aba3e1a03459bea4971ced856720c61359f2**. [Полный CI41112571528](https://github.com/rashadoni/leadprocure/actions/runs/41112571528) повторно проверен на дату передачи: оба jobs SUCCESS. **30 suites, 353 API-теста, 3 проверки конкуренции, 14 браузерных сценариев, 1 fresh HTTPS, восстановление 52 RLS-таблиц.** Build/typecheck, четыре UBL и OCDS, обе истории миграций, изолированная fresh installation с подписанной тестовой лицензией/private storage/реальным ClamAV также прошли. Это isolated CI, не публичный production.

Checkpoint перед созданием передачи — **58672e4**, на feature-ветке. Он содержит postmerge-доказательства, которых ещё нет в main. Передача добавляется в эту же ветку. На начало передачи **нет ожидающих изменений приложения, ревью, PR или CI этой задачи**.

## Репозиторий и продолжение

- GitHub: **rashadoni/leadprocure**, origin `https://github.com/rashadoni/leadprocure.git`. Прежний GitHub owner выведен владельцем из использования; не возвращаться к нему при ошибке доступа.
- Текущий worktree: `/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-budget-audit-integration`.
- Ветка: `codex/leadprocure-budget-audit-integration`. Получать передачу и postmerge receipts из неё, не только из main.
- Первоначальный worktree `/mnt/HC_Volume_106454338/codex-alt-data/worktrees/leadprocure-client-presentation-az` сохранён. Canonical `/home/codex-alt/projects/Leadprocure` и runtime не перезаписывать.
- В Codex Cloud использовать окружение проекта и `/workspace/leadprocure`, не Contabo-пути.

Читать `AGENTS.md`, `docs/DELIVERY-ARCHITECTURE.md`, этот пакет и последние записи `docs/budget-audit-integration-session-log.md`. Первоначальный журнал — `docs/presentation-az-session-log.md`.

`codex-project-context` подтверждает root/branch/origin, но возвращает production_alias=none/path=unverified/release_route=none. Это не доказательство отсутствия runtime. Исторический runtime-контекст ниже не даёт разрешения менять его.

## Разрешения и запреты

Владелец заранее разрешил push рабочих веток, CI, PR и merge после независимого ревью без блокеров и успешных необходимых проверок. Общее разрешение заменяет отдельное «давай» на каждый PR. **Production-выкладка НЕ разрешена.** Передача не выдаёт новых прав на внешние системы или проекты.

**SMTP/Meta полностью исключена**, а не оставлена последней. Не разрабатывать, не настраивать, не считать блокером текущих задач. Аптеки/LeadDrive — другой проект. Не начинать отдельные release/backup/инфраструктурные улучшения. Владелец оставил текущий IP и имеющийся Contabo backup.

Contabo — постоянный development/inspection host. Полные build/API/browser/Docker проверки проводить на GitHub CI или назначенном ephemeral worker. Здесь только небольшие последовательные проверки после RAM/disk/pressure. Не SSH на публичный IP этого же хоста, не reset/clean/force-push и не переписывать применённые миграции. Журналы только дополнять. Browser — native Codex/Playwright Chromium, **не TinyFish**, настоящая авторизация без переноса cookies/паролей.

GitHub `agent-review` был зелёным при Anthropic400 insufficient-credit fallback. Это **не смысловое ревью**. PR34 source `e140c02` и final head `18e7f1c` реально проверены отдельным `invoice_list_retry_review` без блокеров. Собственное ревью или зелёная заглушка не заменяют независимого ревью.

## Все исходные задачи

VERIFIED означает техническое выполнение в описанном покрытии, не сертификацию, гарантию отсутствия любых ошибок или успешный production deploy. Полные исходные критерии — `docs/audits/datasheet-2026-10-26/TASKS.md`, также `originalCriteria` каждой задачи в TASK-INVENTORY.json. API suites находятся в `apps/api/test/`, browser helpers — в `apps/web/tests/helpers/`.

### LP-A00 — Изолированная приёмка

**VERIFIED**

**Выполнено и проверено:** Отдельные PostgreSQL/MinIO, app_user без BYPASSRLS, защита от production URL, миграции с нуля и обеих применённых историй, восстановление с 52 RLS-таблицей. Полные проверки только hosted CI.

**Граница:** Не доказывает готовность любого клиентского окружения.

**Доказательства:** acceptance.yml; assert-isolated.cjs; upgrade-branches.cjs; upgrade-check.cjs; backup-restore.sh.

### LP-A01 — Файлы и KYC

**VERIFIED**

**Выполнено и проверено:** Одноразовый grant своей организации, фактические bytes/hash, неизменяемая подтверждённая копия. Общий lifecycle для document/bid/KYC. HTTP foreign-grant/foreign-download и buyer-before/after-opening; реальный MinIO и ClamAV clean/EICAR. Исторический read-only анализ namespace: 0 несовпадений, файлы не удалялись.

**Граница:** Отрицательные проверки разных типов опираются также на общий consumeUpload/download seam; это не внешний pentest.

**Доказательства:** audit-regressions; clamav; verification; sourcing-flow; DocumentsService.consumeUpload/assertDownloadable.

### LP-A02 — Сверка количеств и R01

**VERIFIED**

**Выполнено и проверено:** Дубли poItemId отклоняются; совокупный billable остаток и rematch пересчитываются под общей блокировкой PO. Повторные invoices/GRN, частичная приёмка и disputed→matched проверены. Новые 4 теста явно наблюдают queued HTTP в PostgreSQL: два счёта, две приёмки и оба порядка счёт/приёмка. Интерфейс поставщика выставляет только принятый невыставленный остаток; после4болтов+5шайб следующий счёт содержит только6болтов. При нуле нет нового POST, пояснение AZ/RU/EN. Реальные API-проверки статусов резерва/отклонения/поздней приёмки и foreign buyer/supplier.

**Граница:** Стресс 12×8 не является capacity/SLA тестом. Остаток чтения — подсказка; при конкурентном изменении сервер повторяет сверку под блокировкой PO.

**Доказательства:** audit-regressions; invoices; amendments; procurement.stress-spec; common/procurement/invariants.ts; PARTIAL-INVOICE-ACCEPTANCE-2026-10-29.json; web/tests/helpers/partial-invoice.ts.

### LP-A03 — Границы лота

**VERIFIED**

**Выполнено и проверено:** Два поставщика на два лота: договор/PO/catalog содержат только выигранные строки. Восемь реально ожидающих повторов дают один договор и audit. Cancel/create проверены в обоих порядках; UI действия и победители по каждому award.

**Граница:** Отменить award с уже созданным договором нельзя; это выбранное правило защиты обязательства.

**Доказательства:** multilot; integrity; award-contract-concurrency; web/evaluation.spec.ts.

### LP-A04 — Аукцион до счёта

**VERIFIED**

**Выполнено и проверено:** Принятые tick-строки материализуются в bid; повторная финализация не дублирует строки. Native finalize→award→contract, реальные PO→GRN→MATCHED invoice сохраняют цену победителя 80000 minor.

**Граница:** Это проверенный пример, не обещание процента экономии.

**Доказательства:** auction-flow; procurement.stress-spec; web/evaluation.spec.ts.

### LP-A05 — Серверный победитель аукциона

**VERIFIED**

**Выполнено и проверено:** Худшая ставка/чужая принадлежность не принимается. Сервер определяет лучшую допустимую ставку, сохраняет цену/обоснование в аудите; повтор award идемпотентен. Положительный decrement не допускает равный следующий tick.

**Граница:** Исключение с выбором худшей ставки не обещается. Для исторических равных сумм применяется серверный порядок.

**Доказательства:** auction-flow; SourcingService.award; procurement.stress-spec.

### LP-A06 — Полная актуальная оценка

**VERIFIED**

**Выполнено и проверено:** Пустые/неполные/дублированные scores и неизвестные criteria отклоняются; DB uniqueness. Locked criteria, допустимые диапазоны и актуальная evaluation у award. Реально queued reevaluate/award и disqualify/award проверены в обоих порядках.

**Граница:** Формальная оценка и AI recommendation — отдельные механизмы.

**Доказательства:** integrity; audit-regressions; award-contract-concurrency; migrations.

### LP-A07 — Экран оценки

**VERIFIED**

**Выполнено и проверено:** Поля из locked criteria; текущая оценка отдельно от истории. Переоценка 62/68 меняет лидера, самая низкая цена его не подменяет; ничья не рисует единственного лидера. Выбор после частичного award работает по оставшемуся лоту.

**Граница:** Native сценарий проверяет конкретный custom-набор, не все возможные наборы.

**Доказательства:** web/evaluation.spec.ts; EventDetail.tsx.

### LP-A08 — Валюта, объём, safe money

**VERIFIED**

**Выполнено и проверено:** Разная валюта bid/event отклоняется. Сравнение и downstream по одному лоту/объёму; внешний AI не заменяет исходные суммы/имена/срок. Safe integer guards на цену/произведение/итог; новые HTTP отрицательные сценарии подтверждают rollback заявки и сохранность старого sealed bid.

**Граница:** Автоматический FX не реализован в этом потоке и не обещается.

**Доказательства:** audit-regressions; integrity; multilot; ai-provider; deadline-boundaries; invariants.ts.

### LP-A09 — НДС и денежные snapshots

**VERIFIED**

**Выполнено и проверено:** Целые minor units, integer VAT rounding. INCLUSIVE/EXCLUSIVE, 0% и смешанные 0/18% проходят реальные GRN/invoice цепочки; net/tax/gross 20000/1800/21800. Режим и ставки сохраняются в snapshots.

**Граница:** Исторические invoices без достоверного snapshot не пересчитываются автоматически.

**Доказательства:** audit-regressions; invoices; amendments; catalogs; common/procurement/invariants.ts.

### LP-A10 — UBL

**VERIFIED**

**Выполнено и проверено:** Четыре реально выгруженных XML, включая смешанные ставки обоих режимов, проходят официальную OASIS UBL 2.1 XSD. Категории/ставки/валюта/итоги берутся из snapshot.

**Граница:** Generic UBL: не Peppol BIS/Schematron, Access Point или подтверждённая доставка по сети.

**Доказательства:** audit-regressions; scripts/acceptance/validate_exports.py.

### LP-A11 — BLOCKED поставщик

**VERIFIED**

**Выполнено и проверено:** Общий guard новых приглашений, bids/ticks, awards, договоров/PO и catalog orders. HTTP блокировка уже активного каталога; ранее подтверждённый PO доходит до приёмки. Статус и audit IDs проверены на PostgreSQL.

**Граница:** Старые обязательства не прекращаются автоматически.

**Доказательства:** audit-regressions; catalogs; assertSupplierAllowed call sites.

### LP-A12 — AI edge cases и fallback

**VERIFIED**

**Выполнено и проверено:** Нулевая цена/доставка в тот же день, neutral reliability=60, finite scores. 18 реальных HTTP boundary тестов: структура/фиксированные веса/порядок/weighted total/IDs, malformed JSON/503/disconnect, secrecy/foreign buyer. Facts берутся из открытых локальных строк; invalid response→heuristic fallback.

**Граница:** Живой внешний LLM и качество его объяснений NOT RUN. Loopback HTTP fixture не выдан за внешнюю приёмку; AI не назначает winner.

**Доказательства:** ai-provider; audit-regressions; ai-scorer.ts; recommendationCopy.

### LP-A13 — Аналитика и бюджет

**VERIFIED**

**Выполнено и проверено:** Активные award totals по лоту, cancel/reaward, net basis, валюты отдельно. Принятые PO считаются по дате создания заказа; обязательства/приёмка/оплата различены. Stale response/31-е число, AZ/RU/EN и текущая budget policy/SoD проверены. AZN бюджеты, подразделения/периоды, exact limits, finance role и concurrent approvals сохранены. Native budget report: задержанные list/rollup старого2031 не заменяют выбранный2032/20002minor. При отказе любого из3reportendpoint данные скрыты, локализованные AZ/RU/EN retry загружают выбранный год; CSV выключен до готовности. BUYER_USER не запрашивает запрещённый org-report. Оплата в rollup отбирается по бюджетной дате обязательства и выбранным периодам без разрывов/повторного счёта; чужой период соседнего подразделения не расширяет доступ. Проверены UTC/смена года/валюта/каталог и BUYER_USER/foreign buyer; PAID не увеличивает actual/used.

**Граница:** Это не баланс банковского счёта и не автоматический FX. Согласованное UI-обновление не является общим DB snapshot. Новый native кейс роли finance и смены года; BUYER_USER source+прежние API checks, остальные фильтры используют общий loader. Это оплата обязательств выбранного периода, не движение денег по дате банковского платежа. Новые period/scope кейсы — actual API; отдельный native browser кейс периода оплаты не заявлен.

**Доказательства:** analytics; budgets; budget-integration; departments; web/analytics,finance,budget-approval; BUDGET-REPORT-ACCEPTANCE-2026-10-29.json; web/tests/helpers/budget-report.ts; budget-paid-period; BUDGET-PAID-ACCEPTANCE-2026-10-30.json.

### LP-A14 — OCDS

**VERIFIED**

**Выполнено и проверено:** Корректные active/cancelled awards, lot value/currency/supplier и release data; canonical OCDS 1.1.5 schema. Отдельный actual HTTP негативный тест до opening исключает bid ID/цены/payload и tender value; foreign supplier 404.

**Граница:** Реальный downstream потребитель NOT RUN; schema validation не является его интеграционной приёмкой.

**Доказательства:** sourcing-flow; audit-regressions; validate_exports.py.

### LP-A15 — TypeORM RETURNING

**VERIFIED**

**Выполнено и проверено:** UPDATE/DELETE rows отделены от affected count. Проверены реальные supplier status, followup stop и audit entity ID, отсутствующая membership. Все найденные аналогичные RETURNING-пути используют helper либо предварительный SELECT.

**Граница:** Source inspection дополняет реальные PostgreSQL тесты; не утверждается отдельный новый тест каждого SQL выражения.

**Доказательства:** returnedRows; followups; audit-regressions; budget-integration; settings/categories/catalogs/contracts call sites.

### LP-A16 — Лицензирование

**VERIFIED**

**Выполнено и проверено:** Production missing-license restricted; dev fallback явно отделён. Реальная PASETO подпись, valid_from, valid→grace→restricted без рестарта, renewal, revoked/tampered. Fresh production Compose использует signed file license и проверяет завершение разрешённых операций.

**Граница:** Клиентская коммерческая лицензия/установка NOT RUN; выпуск такой лицензии не подменяет разработку.

**Доказательства:** audit-license; scripts/acceptance/fresh-install.sh.

### LP-A17 — SMTP/Meta — историческая задача, исключена владельцем

**REMOVED_BY_OWNER**

Исторически внесены исправления обработки callback batches/статусов, сохранения ранних callbacks, dispatch lease/provider evidence и обязательного Meta message ID — PR20–23. Уже включённый код не удалялся.

**Не выполнено:** реальная внешняя SMTP/Meta отправка, получение и callbacks на разрешённые адреса/номера. По ответу владельца подключений не было.

**Дальше:** ничего не делать без нового явного поручения. Исключена из текущих 19 задач.

### LP-A18 — Дедлайны и конкуренция

**VERIFIED**

**Выполнено и проверено:** Время сервера, withdrawal после close_at отклонён. Auction tick/extension/closer сериализованы. Новые реальные queued resubmit/withdraw при TRY-lock skip сохраняют исходный sealed payload; два opening дают 201/400 и один audit; положительный withdrawal/replacement сохранён.

**Граница:** Отклонённая транзакция не сохраняет domain audit/tick; журнал принятых изменений не выдаётся за журнал всех атак/отклонённых запросов.

**Доказательства:** deadline-boundaries; auction-flow; procurement.stress-spec; audit-regressions.

### LP-A19 — Общая приёмка, языки, материалы

**PARTIAL_EXTERNAL**

**Выполнено и проверено:** Full API/security/build/native browser и fresh isolated install, upgrade/restore. RFQ и auction downstream до GRN/invoice, direct/catalog и payment-status API. RFI AZ/RFP AZ/RU/EN: own response после reload/close, buyer secrecy/opening, foreign supplier deny, RFI без цен/award. Текущие PPTX/PDF/notes синхронизированы; независимый render 15 страниц, 100% текста. AZ/RU/EN RFP native flow: оценка→победитель→договор→PO→доставка→GRN→MATCHED→APPROVED→PAID; все downstream записи реальными browser controls. Net/VAT/gross1200/216/1416; PAID после reload у обеих сторон. Детали оплаченного счёта AZ/RU/EN проверены переключателем языка. Открытая карточка счёта синхронно со строкой показывает APPROVED/PAID после фактического успеха без переоткрытия/reload; таблица сверки сохраняется. Оба browser context выбирают язык через UI, он сохраняется при полной навигации/reload; все3RFP проходят1200net/216VAT/1416gross и открытые детали MATCHED→APPROVED→PAID. RFI buyer opening также AZ. Native approve/pay controlled503AZ/RU/EN сохраняют строку/карточку и реальные status/net/VAT/gross/match; после unroute реальный повтор успешен. Отмена override AZ/RU/EN не отправляет POST и сохраняет DISPUTED/gross201. Reject503 сохраняет данные; реальный reject201EN обновляет строку/карточку и сохраняется после reload у покупателя/поставщика. Поздний реальный detailGET не возвращает старые MATCHED/APPROVED после native approveAZ/payRU; отмена ожидающего открытия не запускает второй GET/не открывает карточку повторно. DetailGET503 даёт локализованный AZ/RU/EN alert, затем реальный retry открывает PAID. Прежние nativeRFP/negative/partial сценарии сохранены. Новый nativeEN сценарий: detailGET начат до approve, выполнен после оплаты отдельным авторизованным APIклиентом и реально возвращает PAID; строка/карточка остаются PAID также после позднего реального списка APPROVED. Пересекающийся с локальной успешной операцией GET перечитывается; кеш больше не перекрывает новый серверный ответ. Первоначальный GETсписка503 и реальный повтор200 проверены AZ/RU/EN дляbuyer/supplier (6случаев): loading/локализованныйerror/retry, затемреальный PAID1200/216/1416 и отсутствиеpageerror. Ошибка не выдаётся за успешно пустой список.

**Граница:** Full native RFP downstream подтверждён для AZ/RU/EN в выбранных сценариях. RFI не имеет финансового downstream по модели. PAID не означает банковский платёж. Не исчерпывающий редакторский аудит всех строк. Внешние/клиентские ограничения из externalNotRun остаются NOT RUN. Новые controlled503 подтверждают обработку HTTP-ошибки UI, не серверный rollback/transport disconnect. Cancellation проверяет noPOST/status/gross/UI; не полный аудит всех полей. Реальное отклонение проверено на EN; отмена и approve/pay503 — AZ/RU/EN. Новые detail-race сценарии: approveAZ/payRU; pendingclose/loaderrorretryAZ/RU/EN. Новый внешний PAID проверен actualauthorized APIклиентом и nativeUI; не иной пользователь и не новый полностью nativeпоток. Unmount/устаревшие ошибки дополнительно source-reviewed; отдельный новый unmounttest не заявлен. Новый listretrytest проверяет первоначальную загрузку; postmutation refresh503/stalefailure/unmount дополнительно source-reviewed, не новые nativeкейсы.

**Доказательства:** full acceptance.yml; web tests/helpers/rfx.ts; rfi-rfp; render-presentations; v3/output; CLAIMS.md; RFP-NATIVE-PAYMENT-ACCEPTANCE-2026-10-29.json; INVOICE-DETAIL-ACCEPTANCE-2026-10-29.json; RFP-LANGUAGES-ACCEPTANCE-2026-10-30.json; INVOICE-NEGATIVE-ACCEPTANCE-2026-10-30.json; web/tests/helpers/invoice-negative.ts; INVOICE-READ-ACCEPTANCE-2026-10-30.json; web/tests/helpers/invoice-detail-race.ts; INVOICE-NEWER-ACCEPTANCE-2026-10-30.json; INVOICE-NEWER-MAIN-ACCEPTANCE-2026-10-30.json; INVOICE-LIST-ACCEPTANCE-2026-10-30.json; web/tests/helpers/invoice-list-retry.ts.

## Дополнительные поручения

| Поручение | Сделано | Ограничение |
|---|---|---|
| Корпоративная презентация AZ | Выбранный вариант C реализован: редактируемый PPTX на 13 слайдов, PDF, заметки. Светлый белый/чёрный/серебристый стиль, Barlow Condensed и IBM Plex Sans; возможности и процессы, включая реверсный аукцион. Демо отдельно. | Внешнее клиентское одобрение и desktop PowerPoint не подтверждены. Ранние варианты заменены. |
| Data sheet AZ | PPTX на 2 страницы A4, PDF и текст; claims ограничены проверенными возможностями. | Не обещаны неподтверждённые интеграции/сертификации. |
| Изучение проекта и гидов | Изучены код, документация и scripts; существующие AZ/RU/EN assets и маршруты сохранены, LFS восстановлен, PR9. | Все видео заново после последних изменений не записывались. Это не текущая задача. |
| Совместимость расширенного бюджетирования с аудитом | PR7–9: две истории миграций сохранены; finance UI, SoD, подразделения, точные лимиты и конкуренция проверены. | Реальные production volumes не обновлялись. |
| Изолированная установка и исторический релизный пакет | PR6/10: signed test license, private storage, ClamAV, образы API/web, checksums/restore в CI. | Старый пакет не является свежим артефактом main5782aba. Отдельную release/backup-работу не продолжать. |
| GitHub, PR, критерии и доказательства | Owner rashadoni; PR3–34 объединены; TASKS/current matrix/receipts/оба журнала сохранены. | PR1 предшествовал этой работе. PR2 закрыт без merge, заменён разделёнными PR. |
| Production, публичный TLS, новая система backup | **Не выполнялись**, production не менялся. Владелец оставил IP и имеющийся backup. | Это не незавершённая разрешённая разработка: deploy не разрешён. |

## Что не выполнено до конца / не выполнялось

| Пункт | Статус и существующее подтверждение | Что необходимо для продолжения |
|---|---|---|
| Живой внешний LLM, доступность и качество объяснений | NOT RUN. Проверены 18 реальных HTTP boundary cases и fallback, не live-провайдер. | Реальный согласованный AI_ORCHESTRATOR_URL, доступ и критерии. Не подменять loopback fixture. |
| Реальная клиентская установка/коммерческая лицензия | NOT RUN. Fresh isolated production-mode и подписанная тестовая лицензия прошли. | Выбранный stand, конфигурация/лицензия и разрешение на изменения. Самостоятельно коммерческую лицензию не выпускать. |
| Upgrade реального existing-volume окружения | NOT RUN. Обе истории миграций, modeled storage upgrade/restore прошли на disposable CI. | Выбранная среда, разрешение и реальные данные. Сохранить dirty runtime и mixed Compose labels. |
| Публичный TLS | NOT RUN, владелец оставил IP. Isolated trusted HTTPS browser test прошёл. | Новое решение владельца. Не создавать самостоятельный инфраструктурный проект. |
| Live ERP/банк/ASAN İmza/Peppol network и реальный OCDS-потребитель | Не реализованы как заявленные live-интеграции и/или не проверены с реальными системами. CSV не ERP; PAID не банковский перевод; dev signature не ASAN; generic UBL не Peppol BIS/AP; OCDS schema не consumer acceptance. | Сохранять ограничения claims. Новые интеграции — отдельное поручение, контракт и тестовые подключения, не автоматическое расширение аудита. |
| Microsoft PowerPoint desktop | NOT RUN. LibreOffice render прошёл 15 страниц/100% ожидаемого текста; шрифты и верстка проверялись. Document Control не нашёл сессий. | Доступная реальная PowerPoint-сессия/desktop worker; открыть оба PPTX. PDF preview не заменяет этот шаг. |
| SMTP/Meta | Реальная доставка NOT RUN, задача исключена. | **Не продолжать** без нового явного поручения. Не блокирует текущий объём. |

Не превращать ограничения доказательств автоматически в новый backlog. Также не выполнялись внешний pentest, capacity/SLA benchmark и исчерпывающий редакторский аудит каждой строки. В PR34 новые browser cases — initial GET503/retry для двух ролей × три языка; postmutation refresh503/stale failed read/unmount проверены по исходникам, не отдельными новыми browser tests. PR33 использует настоящий PAID после оплаты отдельным авторизованным API-клиентом, но не другим пользователем или в новой полностью native закупке. Отмена override проверяет noPOST/status/gross/UI, не каждое поле. Это границы, а не выдуманные найденные дефекты.

## История доставки

Полный список с названиями, state и merge SHA: PR-INVENTORY.json. **PR3–34 MERGED**, PR2 CLOSED без merge, PR1 предшествовал аудиту.

| PR | Изменения |
|---|---|
| 3–6 | Закупочные/финансовые/security исправления, AZ-материалы, доказательства и fresh install. |
| 7–9 | Совместимость budget runtime и audit, finance UI, сохранение гидов. |
| 10 | Историческая сборка пакета, не deploy. |
| 11–16 | Аналитика/mixed VAT/claims; award/catalog concurrency; OCDS до открытия; budget policy-диалоги; рейтинг/лоты/аукцион до документов; собственные RFI/RFP-ответы и privacy. |
| 17–19 | AI boundary, deadline/money concurrency, матрица исходных критериев. |
| 20–23 | Исторические SMTP/Meta-исправления. Затем задача исключена; не продолжать. |
| 24–26 | RFP native до PAID, invoice AZ/RU/EN, billable остатки/partial receipt, открытая карточка. |
| 27–28 | Актуальные budget report/error/retry/CSV/роли; периоды обязательств и оплат, границы подразделений. |
| 29–31 | Claims/material handoff, полный RFP native AZ/RU/EN, invoice отмена/reject/controlled503. |
| 32 | Старый detail GET/закрытие/error/retry. Остаточный newer-PAID дефект записан CONFIRMED_OPEN на f90bef1. |
| 33 | Guarded reread вместо local overlay; настоящий newer PAID и поздний APPROVED list не откатывают карточку/строку. Закрывает найденный дефект PR32. |
| 34 | Локализованная загрузка/error/retry списка, шесть initial503/retry cases. Полный main CI прошёл. |

Последние commits: source `e140c022db582e77df02323d991779a2fc2bf3e5`; независимо проверенный final `18e7f1c4a8b957d4508be1529b19d7d045844f98`; main `5782aba3e1a03459bea4971ced856720c61359f2`; checkpoint postmerge evidence `58672e4`.

Последнее доказательство — `docs/audits/datasheet-2026-10-26/INVOICE-LIST-MAIN-ACCEPTANCE-2026-10-30.json`. Main совпадает с проверенным final tree, application/test tree — с source, прошедшим полный CI. Current-сводки, написанные перед merge, ещё называют PR34 кандидатом; это старый снимок, superseded итоговым receipt и этой передачей. /tmp raw logs не гарантированно долговечны; tracked JSON и CI URL — постоянные ориентиры. История ошибок/отмен сохранена; CANCELLED не PASS. Не повторять полный CI без причины ради документационного commit.

## Готовые материалы

Каталог `docs/presentations/leadprocure-az/v3/output/`:

- Leadprocure_Korporativ_Teqdimat_AZ_v3.pptx — 13 редактируемых слайдов, одноимённый PDF.
- Leadprocure_Data_Sheet_AZ.pptx — 2 редактируемые страницы A4, одноимённые PDF и MD.
- Meruzeci_Qeydleri_AZ.md — заметки докладчика.
- SHA256SUMS, QA JSON, contact sheets и preview.

Контент — v3/content-reviewed.json и v3/datasheet-content.json; генераторы — scripts/ репозитория. [Последний реальный render40698739541](https://github.com/rashadoni/leadprocure/actions/runs/40698739541) прошёл 15 страниц/100% ожидаемого текста. Он не выдаётся за новый рендер или native PowerPoint. После него материалы не менялись. На дату передачи SHA256SUMS проверен: 9/9 совпали. Материалы включены в архив.

## Runtime: исторический контекст, не разрешение

IP **75.119.156.234**, web8180/API3100/files9002; владелец попросил оставить IP. Endpoints не переаттестованы при подготовке передачи. Compose project leadprocure-prod.

Ранее read-only инспекция нашла mixed labels: app/DB из `/home/rashad/projects/Leadprocure/.claude/worktrees/budget-by-department-audit-4e2173/infra`, storage/AV/AI из `/home/rashad/projects/Leadprocure/infra`. Dirty runtime сохранён. Не объединять/перезаписывать каталоги и не rebuild по этим историческим сведениям.

Aliases contabo-admin/leadprocure-prod относятся к loopback этого же Contabo. Release path — infra/DEPLOY.md; GitHub workflow автоматического production deploy у Leadprocure нет. Перед любой production-мутацией нужны новое разрешение, актуальная сверка routing/runbook и preflight. **Этот handoff такого разрешения не даёт.**

## Первые действия Claude

1. Прочитать передачу, JSON, main receipt и последние записи журналов. Не возобновлять старые списки «20 задач» или очередь SMTP.
2. Проверить root/branch/origin/status; получить feature-ветку с postmerge-доказательствами и передачей. Не reset dirty checkout. В другой среде использовать правильный workspace path.
3. Проверить, появились ли реальные предпосылки внешних проверок. При их отсутствии сохранить PARTIAL_EXTERNAL, не имитировать результат fixture и не создавать новые интеграции ради галочки.
4. Доступные применимые критерии исходного плана выполнять автономно с проверками, независимым ревью и журналом. Конкретные найденные ошибки исправлять в узком объёме.
5. Если доступной работы нет, показать точный остаток и предпосылки; не объявлять все 20 полностью завершёнными и не переходить к production/исключённой задаче.

## Состав архива

Передача, готовый prompt, JSON-перечень задач и PR/CI inventory, исходные TASKS/current matrix/receipts, оба журнала, инструкции/runbook/CI workflow, AZ-материалы и контент v3. Код и полную историю получать из GitHub. Архив не является runtime backup; нет production .env, DB dump, node_modules, .git или большого массива LFS-видео. Свежие инструкции репозитория имеют приоритет, если изменятся после даты снимка. Секреты в чат не присылать.
