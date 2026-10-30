> **Актуальное состояние — 30 октября 2026:** [текущая приёмка и claims](CURRENT-ACCEPTANCE-2026-10-30.md). Базовый main `cc25914`, PR33 объединён, полный CI41109942437 PASS:353API/14native/1freshHTTPS. Кандидат PR34 `e140c02`, оба jobs41111209233 SUCCESS; initiallist503/retry200 buyer/supplierAZ/RU/EN. Кандидат ещё не выдан за mergedmain. Действуют 19 задач; 18 VERIFIED, LP-A19 PARTIAL_EXTERNAL. Исключённая владельцем задача не входит в очередь. Production не менялся.
>
> **Ниже сохранена история.** Старые «текущие» статусы, 20 задач, не объединённые кандидаты и прежние разрешения superseded указанной сводкой и прямыми указаниями владельца. Исторические доказательства не удалены.

# Утверждения материалов v3: границы подтверждения

Дата: 28 октября 2026 (Asia/Baku). Проверенный main `0a27fb026618422f852a857bd9ee39e23a441bd2`: [run40666138522](https://github.com/rashadoni/leadprocure/actions/runs/40666138522),283 API +3 contention +10 native browser +1 fresh HTTPS, build/schemas/обе истории миграций/restore/fresh installation PASS. Production не обновлён. Уточнения LP-A09/A10/A13/A19 в кандидате7f52131 прошли собственный run40698739534:285API/3contention/13browser/1fresh HTTPS; новый PPTX render40698739541 PASS(15страниц/100%текста). Кандидат ещё не объединён; это отдельное доказательство от baseline. Актуальные критерии всех20 задач — [TASK-CLOSURE-2026-10-28.md](TASK-CLOSURE-2026-10-28.md).

| Утверждение | Статус | Доказательство / граница |
|---|---|---|
| Lot-scoped award → contract → PO/catalog | Verified в targeted сценариях | multilot + auction-flow: 15 checks; два независимых лота |
| Reverse auction: лучший допустимый tick, итоговые строки PO | Verified в targeted сценариях | auction-flow; серверный winner guard; полный stress NOT RUN |
| Закрытые предложения / чужая организация | Verified в regression suite | Полный security/RLS suite PASS на hosted runner; это не внешняя сертификация |
| Полная оценка по заранее фиксированным критериям | Verified API/UI | HTTP negative tests и native browser custom criteria/re-evaluation PASS |
| AI помогает сравнить предложения | Verified heuristic / conditional external | Нули, lot, currency, AZ объяснение PASS; реальные LLM ответы не испытывались; решение принимает человек |
| Сверка PO/GRN/invoice и контроль количеств | Verified в targeted сценариях | 296 contended HTTP calls с8 параллельными запросами на batch: invoice/GRN/auction/close PASS; это не capacity benchmark; PAID — статус учёта, не банковский перевод |
| НДС INCLUSIVE/EXCLUSIVE и 0% | Verified для проверенных примеров | Integer calculations + HTTP + snapshot exports; старый invoice без snapshot не экспортируется как заведомо корректный |
| UBL 2.1 | Verified структура примеров | Четыре реальных export XML(включая смешанные0/18% для обоих режимов) прошли OASIS XSD; unit mapping; Peppol BIS/network — not verified/not implemented |
| OCDS 1.1.5 | Verified структура примера | Canonical JSON schema; cancelled award; downstream consumer NOT RUN |
| Расходы и экономия | Verified в targeted сценариях | Валюта выбирается отдельно, активные awarded lots, net basis, дата создания PO; автоматический FX не обещается |
| Бюджет и обязательства по закупкам | Verified API/native finance UI | Планы в AZN: подразделения/категории/периоды, lifecycle/ревизии/закрытый snapshot, phasing/plan-fact/YoY. По умолчанию превышение предупреждает; настроенный порог блокирует, исключение администратора требует причины. Department scope, exact zero/one-minor limits, competing approvals и назначенный finance step проверены. Это не банковская система и не автоматический FX |
| Файлы / KYC документы | Verified в проверенных сценариях | Реальные MinIO и ClamAV/EICAR PASS, grant ownership, immutable snapshot, namespace rejection |
| BLOCKED поставщик | Verified проверенные действия | Invitation, bid, catalog HTTP; общий guard для новых договоров/PO; старые обязательства не прекращаются |
| Email/Meta follow-up | Conditional | Outbox/recovery/NOT_CONFIGURED/UNKNOWN и signed webhook tests PASS; реальные подключения отсутствуют, внешняя доставка NOT RUN |
| Лицензируемое размещение | Verified signed controls +fresh isolated installation / conditional client rollout | Production Compose реально собран/запущен на пустых volumes: missing-license restricted, signed file valid; upgrade и disposable backup/restore PASS. Fresh HTTPS/browser PASS на доверенном тестовом CA; modeled legacy storage volume upgrade PASS. Реальный клиент, коммерческая лицензия/public TLS и реальный existing-volume upgrade NOT RUN. Archived storage snapshot не vendor SLA |
| AZ/RU/EN | Verified для проверенных экранов | Web build и native browser analytics для трёх языков PASS; это не исчерпывающий редакторский аудит всех строк |
| ERP, банк, ASAN İmza | Not verified / не заявляется как интеграция | CSV не live ERP; статус PAID не платёж; dev signature не ASAN |

Материалы: `docs/presentations/leadprocure-az/v3/output/`. Все оставшиеся ограничения сохранены явно; полный hosted gate PASS не отменяет внешние/клиентские ограничения и отдельную авторизацию merge/deployment.

Дополнительная совместимость материалов: actual PPTX→LibreOffice и PPTX→native Google Slides→PDF,13+2 страницы;100% текста/шрифты/границы и визуальный осмотр PASS. Desktop Microsoft PowerPoint NOT RUN: подключённой сессии нет. Исходные PPTX и claims не изменены.


Уточнение LP-A19: текущие материалы обновляются под принятую бюджетную модель: настраиваемая блокировка, AZN/подразделения/периоды и финансовая роль. Новый native PPTX render40698739541 PASS; изменённые страницы проверены визуально. Прежний Google Slides render не выдан за проверку изменённых файлов.


## Итог исходных20 задач после разрешённого PR11 — 28 октября2026

PR11 объединён в main `e3e5dbcdcd39dbea67fe0ef3953dfc97b65ddb44`; точное дерево совпадает с проверенным кандидатом7f52131. Полная приёмка [40700763083](https://github.com/rashadoni/leadprocure/actions/runs/40700763083) PASS:285API/3contention/13native browser/1freshHTTPS,4UBL+OCDS/build/обе миграционные истории/restore/fresh private storage+real AV. Материалы не изменились после принятого независимого рендера15страниц40698739541; контрольные суммы совпадают. LP-A09/A10/A13/A19 дополнительные технические пробелы закрыты. Текущая матрица — TASK-CLOSURE-2026-10-28.md; доказательство — ORIGINAL-TASKS-MAIN-ACCEPTANCE-2026-10-28.json. Production не изменён. Реальная SMTP/Meta доставка NOT RUN: подключений нет. Подготовка релиза, установка лицензии и отдельные backup-проекты не подменяют исходные20 задач и сейчас не выполняются.


## Актуальная сверка всех20 критериев — 29 октября2026

[FINAL-CRITERIA-2026-10-29.md](FINAL-CRITERIA-2026-10-29.md) и одноимённый JSON собирают текущие результаты вместо чтения исторических статусов по отдельности. PR17/PR18 объединены; кандидат1494149 прошёл hosted40833169209:28suites/324API,3contention/14nativebrowser/1freshHTTPS,fullbuild/typecheck/4UBL+OCDS/both histories/restore51RLS/fresh signedlicense-private storage-realAV PASS. Точное main3990a7d проверяется отдельным запуском; кандидатный результат не подменяет этот gate.

18задач технически проверены в указанных границах. A17 и A19 остаются частично открыты по внешней/клиентской приёмке: SMTP/Meta подключения отсутствуют по ответу владельца; реальные отправка/получение/callback NOT RUN. Live LLM quality, клиентское внедрение и desktop PowerPoint также не объявлены проверенными. Общая авторизация владельца разрешает push/CI/PR/merge после независимого ревью и необходимых проверок; старые требования нового «давай» для каждого исходного PR superseded. Production не менялся. Никаких новых release/backup проектов.

Окончательный результат точного main3990a7d: [40833937868](https://github.com/rashadoni/leadprocure/actions/runs/40833937868) BOTH jobs SUCCESS,324API/3contention/14nativebrowser/1freshHTTPS и остальные gates PASS. Статус «main проверяется» выше superseded; доказательство FINAL-CRITERIA-MAIN-ACCEPTANCE-2026-10-29.json. Итоговая таблица:18 технически проверенных задач, A17/A19 частично открыты по внешним зависимостям. Production не изменён.


29октября, продолжение LP-A17: обнаружены и исправлены потеря callback-пакетов после первых entry/change и регрессия READ/DELIVERED от поздних SENT/FAILED. NEW migration0040;6actual HTTP/HMAC/PostgreSQL/RLS tests PASS, candidate516314e/run40839644727:330API/3contention/14nativebrowser/1freshHTTPS и остальные gates BOTH SUCCESS. Независимое exact-head ревью без блокеров. META-DELIVERY-ACCEPTANCE-2026-10-29.json. Историческое «нет доступной разработки» уточнено этим конкретным исправлением; реальная внешняя отправка по-прежнему NOT RUN, production не менялся.


LP-A17, продолжение29октября: corrected falseHTTP200 after DB failure and loss of early callback before sender registration. NEW migration0041/private durable receipt+shared provider lock;4real HTTP/HMAC/PostgreSQL/RLS cases PASS, codecff06db/run40844677259 BOTH SUCCESS:334API/3contention/14nativebrowser/1freshHTTPS,build/schemas/both histories/restore52RLS/fresh installation. CALLBACK-PERSISTENCE-ACCEPTANCE-2026-10-29.json. Independent exact-head review no blockers; actual external SMTP/Meta delivery remains NOT RUN, production untouched.


LP-A17, продолжение29октября: worker lease ownership/providerID recovery/confirmed-delivery requeue controls accepted. NEW0042;7actual DB/worker/HTTP cases; sourcebb183be/run40849057531 BOTH SUCCESS:341API/3contention/14nativebrowser/1freshHTTPS,build/schemas/both histories/restore52RLS/fresh installation. DISPATCH-OWNERSHIP-ACCEPTANCE-2026-10-29.json; independent exact-head no blockers. Actual external delivery remains NOT RUN, synthetic transport is not provider acceptance; no exactly-once network guarantee or production change.
