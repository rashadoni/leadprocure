# Исполнение LP-A00–LP-A19

## Актуальный результат — 27 октября 2026

Действующий репозиторий — `rashadoni/leadprocure`. Code PR [#3](https://github.com/rashadoni/leadprocure/pull/3), материалы [#4](https://github.com/rashadoni/leadprocure/pull/4), доказательства [#5](https://github.com/rashadoni/leadprocure/pull/5). Aggregate PR2 закрыт без merge. Production не обновлялся; merge/deploy не разрешены.

**Полный hosted acceptance PASS:** [run40518660742](https://github.com/rashadoni/leadprocure/actions/runs/40518660742), code SHA `82e323a8183614cd6c853e223ddb783cb5e6c570` (integration checkpoint `29efa30`). Проверено на GitHub runner, не на Contabo:

| Проверка | Фактический результат |
|---|---|
| Upgrade baseline0027 → current + rollback при историческом дубле | PASS, финансовые fixtures сохранены; повторный migration run PASS |
| API typecheck | PASS |
| Полный API/security/RLS regression suite | **23 suites, 195/195 PASS**, включая ClamAV/EICAR и подписанные webhook callbacks |
| Официальные схемы export | PASS: OASIS UBL2.1 для двух примеров, OCDS1.1.5 package |
| Полная сборка monorepo | PASS |
| Native Chromium на изолированном API/DB/MinIO | **9/9 PASS**: buyer/supplier sections, create draft, role guard, custom criteria/re-evaluation и AZ/RU/EN analytics |
| Dump/restore disposable DB | PASS: 35 миграций, 9 invoices, 47 RLS-enabled tables |
| Независимое source review | Найденные code/materials/runbook defects исправлены и повторно проверены; см. INDEPENDENT-REVIEW.md |
| v3 PPTX/PDF | 13 слайдов + 2 страницы; native text/структура, локальный PDF visual QA и SHA256 PASS |

LP-A01–LP-A18 реализованы и входят в указанный regression gate; это не доказательство всех возможных нагрузок, налоговых сочетаний или коммерческих интеграций. **LP-A19 остаётся частично открытой по on-prem provisioning и внешней приёмке**, а не из-за неработающего CI. Нельзя объявлять все 20 задач полностью принятыми.

Оставшиеся границы:

- **Fresh bundled Docker Compose installation: NO-GO.** Используемые MinIO Docker images недоступны upstream. Pinned официальный binary в disposable CI является тестовой инфраструктурой и не исправляет production/on-prem provisioning. Рабочий runtime не менялся.
- **Real SMTP/Meta sends: NOT RUN** — пользователь подтвердил, что тестовых подключений нет. Outbox, подпись callbacks и failure/recovery paths проверены; реальная доставка не подтверждена.
- Реальный клиентский on-prem + коммерческая лицензия: NOT RUN; signed PASETO controls проверены в suite.
- Внешний LLM, live ERP/банк, ASAN/Peppol не подтверждены; CSV не live ERP, PAID не банковский перевод, dev signature не ASAN.
- Полный concurrency/load stress и native PowerPoint/Google Slides visual rendering: NOT RUN. Проверенные сценарии и PDF QA не заменяют эти проверки.

Следующее действие по Leadprocure: устранить подтверждённый Compose provisioning blocker и выполнить отдельную fresh-install приёмку на изолированном hosted worker; внешние sends — после появления согласованных тестовых подключений. Перед любым production update нужны read-only preflight/backup и отдельное разрешение.

## История до завершения hosted gate — SUPERSEDED

Ниже сохранена прежняя матрица и диагностика. Сведения о retired owner, startup_failure, PR10/aggregate PR2 как активном и «полный gate NOT RUN» являются историческими и заменены актуальным результатом выше. Не использовать прежний аккаунт или старые маршруты.

## Проверки, которые выполнены

- 39 targeted checks: audit-regressions (11), multilot + auction-flow (15), followups (10), signed licensing (3). Изолированные PostgreSQL/MinIO, реальные HTTP для сценариев приложения. Signed-license тесты используют реальную Ed25519/PASETO подпись и подменённые часы/хранилище лицензий.
- API TypeScript и отдельная web TypeScript проверка прошли; окончательная hosted сборка ещё не выполнена.
- Upgrade: baseline schema 0027 → ожидаемый отказ на историческом дубле с полным rollback → согласованный синтетический fixture → current schema; суммы старого invoice сохранены, повторный migration run пустой.
- Dump/restore: PASS; сохранены тестовый invoice, 34 миграции и 47 таблиц с RLS; app_user без контекста видит 0 invoices. Только disposable database; рабочая база не менялась.
- Реальные UBL invoices с 0% и INCLUSIVE 18% прошли официальную OASIS UBL 2.1 XSD. OCDS result package прошёл canonical OCDS 1.1.5 JSON Schema. Это проверка структуры и конкретных примеров, не Peppol/правовая сертификация.
- Workflow принят actionlint. На GitHub Actions старты завершены до создания jobs: `startup_failure`, `path=BuildFailed`, 0 jobs, 0 check runs, нет логов runner. Примеры: [40404183594](https://github.com/rashadrahimov/leadprocure/actions/runs/40404183594), [40404978676](https://github.com/rashadrahimov/leadprocure/actions/runs/40404978676). Точная внешняя причина не установлена; это не PASS и не падение теста приложения.

## Матрица задач

| Задача | Реализация и подтверждение | Оставшаяся приёмка |
|---|---|---|
| LP-A00 стенд | Изолированные сети/БД/MinIO, fail-closed test env, hosted workflow; upgrade/restore PASS | Полный hosted gate не стартует |
| LP-A01 файлы | Upload grants, immutable snapshot, hash/size, KYC AV lifecycle, owner namespace при скачивании; негативный HTTP/MinIO test | Полный suite; реальный AV прогон на configured ClamAV |
| LP-A02 количества | Дедупликация, общий order lock для invoice/GRN/amendment; реальные параллельные HTTP tests PASS | Полный regression suite |
| LP-A03 лоты | Lot-scoped contract/PO/catalog, cancelled award rejection, действия UI по awards; multi-lot PASS | Полный browser gate |
| LP-A04 auction downstream | Финализация материализует строки принятой ставки; auction→contract→PO PASS | Полная цепочка до invoice в hosted gate |
| LP-A05 winner | Серверный минимум и проверка принадлежности lot; худшая ставка отклоняется | Полный suite |
| LP-A06 evaluation | Полный уникальный набор критериев, DB unique index, завершённость до award; HTTP negatives PASS | Полный suite, дополнительные конкурентные сценарии |
| LP-A07 экран оценки | Динамические locked criteria, актуальная evaluation, ввод без скрытых 50 баллов; types PASS | Browser custom-criteria/re-evaluation acceptance |
| LP-A08 валюта/объём | Разная валюта bid отклоняется; AI по выбранному lot; legacy mismatch не переименовывается; safe integer guards | FX намеренно не обещается; полный suite |
| LP-A09 НДС | Режим PO и line tax snapshot invoice, целочисленные вычисления; INCLUSIVE/0%/EXCLUSIVE PASS | Сложные налоговые сочетания и старые документы требуют согласованной проверки |
| LP-A10 UBL | Убраны fixed S/18% и ложный Peppol profile; реальные snapshot totals; XSD PASS | Peppol integration отсутствует, не входит в generic UBL |
| LP-A11 BLOCKED | Общая проверка с блокировкой статуса; invitation/bid/catalog/direct/new contract/PO | Полный role/endpoint matrix; исполнение старых обязательств разрешено |
| LP-A12 AI | Нули дают конечные баллы, сопоставимый lot/currency, проверка внешнего результата, локализованные объяснения | Реальный LLM endpoint не испытывался |
| LP-A13 аналитика | Активные lot totals, валюта отдельно, net нормализация и явно заданная дата; HTTP fixture PASS | Полный suite/browser |
| LP-A14 OCDS | Cancelled status, supplier/value, content revision, стабильная дата; JSON Schema PASS | Реальное downstream потребление отдельно |
| LP-A15 TypeORM | Нормализация UPDATE/DELETE returning, корректный ID/count в stop/status/activate и аналогах; HTTP tests PASS | Полный suite |
| LP-A16 лицензии | Production restricted без лицензии, signed claims/time/renewal, metadata new-work guard, SaaS tenant не ставит server license; 3 PASS | Приёмка реального on-prem клиента и коммерческой лицензии |
| LP-A17 доставка | Durable outbox, bounded pre-dispatch retry, UNKNOWN/manual reconcile, NOT_CONFIGURED, dispatch stop checks; 10 PASS | Реальные SMTP/Meta не подключены — пользователь подтвердил отсутствие |
| LP-A18 дедлайны | Event advisory lock, общий close/extend протокол, поздний withdraw запрещён; принятый ledger хранит committed accepted ticks | Полный concurrency stress не выполнялся |
| LP-A19 итог | Подготовлен hosted build/API/browser/languages/schema/upgrade/restore gate; v3 PPTX/PDF готовы, проверены 13 слайдов и 2 страницы | **Не закрыта: полный CI/browser gate не стартует у провайдера** |

## Границы выпуска

Production не обновлялся. Push ветки, снятие архивирования и запуск CI явно разрешены пользователем; merge/deploy не разрешались. Реальные SMTP/Meta не проверяются без существующих подключений и согласованных получателей. Полный build/browser E2E на Contabo запрещён host contract; он не заменён набором локальных запусков и остаётся NOT RUN.

Перед отдельно разрешённым обновлением: выполнить `scripts/acceptance/preflight-readonly.sql`, проверить резервную копию и согласовать исторические дубли/налоговые снимки. Миграция намеренно не удаляет и не пересчитывает старые финансовые документы. Старые документы без налогового snapshot требуют документированной сверки перед UBL.

Следующая обязательная точка: рабочий GitHub runner или разрешённый ephemeral worker, зелёный полный gate, затем итоговое решение о готовности. До этого нельзя объявлять все 20 задач полностью принятыми.

## Последняя контрольная точка

Commit `dff5b79` отправлен в feature branch; PR #10 остаётся draft. Новые push/PR runs [40407106728](https://github.com/rashadrahimov/leadprocure/actions/runs/40407106728) и [40407114230](https://github.com/rashadrahimov/leadprocure/actions/runs/40407114230) также `startup_failure`. Временные task-labelled PostgreSQL/MinIO/upgrade containers и internal network удалены после сохранения доказательств. Следующий шаг — восстановить hosted runner или использовать предусмотренный host contract ephemeral worker и выполнить полный gate.

## Повторная диагностика по запросу пользователя — 27 октября

Отказ подтверждён на последнем commit542ee10; ручной rerun403. В историческом public diagnostic run того же аккаунта найден явный billing lock, однако текущий billing state недоступен через имеющийся API. Проверены альтернативы: Codespaces (недостаточно доступа), Azure DevOps (disabled LeadDrive definitions, pools/queues401), Mac worker (маршрут отсутствует). В аккаунте rashadoni найден успешный Leadprocure Actions run; предложен отдельный PRIVATE task repo, согласие на передачу ветки между аккаунтами запрошено. Подробности и подготовленный следующий шаг: [CI-OPTIONS.md](CI-OPTIONS.md). До разрешения source transfer не выполняется, LP-A19 остаётся открытой.
