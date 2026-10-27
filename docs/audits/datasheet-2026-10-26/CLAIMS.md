# Утверждения материалов v3: границы подтверждения

Дата: 27 октября 2026. Проверяется кандидат в feature branch, production не обновлён. «Verified» относится к перечисленным целевым сценариям, не означает полный релизный PASS. Полный hosted gate прошёл на code82e323a: run40518660742 (195 API + 9 browser tests, build, schemas, upgrade/restore). Полная приёмка и оставшиеся ограничения описаны в STATUS.md.

| Утверждение | Статус | Доказательство / граница |
|---|---|---|
| Lot-scoped award → contract → PO/catalog | Verified в targeted сценариях | multilot + auction-flow: 15 checks; два независимых лота |
| Reverse auction: лучший допустимый tick, итоговые строки PO | Verified в targeted сценариях | auction-flow; серверный winner guard; полный stress NOT RUN |
| Закрытые предложения / чужая организация | Verified в regression suite | Полный security/RLS suite PASS на hosted runner; это не внешняя сертификация |
| Полная оценка по заранее фиксированным критериям | Verified API/UI | HTTP negative tests и native browser custom criteria/re-evaluation PASS |
| AI помогает сравнить предложения | Verified heuristic / conditional external | Нули, lot, currency, AZ объяснение PASS; реальные LLM ответы не испытывались; решение принимает человек |
| Сверка PO/GRN/invoice и контроль количеств | Verified в targeted сценариях | Одновременные invoice/GRN HTTP tests PASS; PAID — статус учёта, не банковский перевод |
| НДС INCLUSIVE/EXCLUSIVE и 0% | Verified для проверенных примеров | Integer calculations + HTTP + snapshot exports; старый invoice без snapshot не экспортируется как заведомо корректный |
| UBL 2.1 | Verified структура примеров | Два реальных export XML прошли OASIS XSD; unit mapping; Peppol BIS/network — not verified/not implemented |
| OCDS 1.1.5 | Verified структура примера | Canonical JSON schema; cancelled award; downstream consumer NOT RUN |
| Расходы и экономия | Verified в targeted сценариях | Валюта выбирается отдельно, активные awarded lots, net basis, дата создания PO; автоматический FX не обещается |
| Файлы / KYC документы | Verified в проверенных сценариях | Реальные MinIO и ClamAV/EICAR PASS, grant ownership, immutable snapshot, namespace rejection |
| BLOCKED поставщик | Verified проверенные действия | Invitation, bid, catalog HTTP; общий guard для новых договоров/PO; старые обязательства не прекращаются |
| Email/Meta follow-up | Conditional | Outbox/recovery/NOT_CONFIGURED/UNKNOWN и signed webhook tests PASS; реальные подключения отсутствуют, внешняя доставка NOT RUN |
| Лицензируемое размещение | Verified signed controls / conditional installation | PASETO controls, upgrade и backup/restore PASS; приёмка клиентского on-prem NOT RUN, fresh bundled Compose NO-GO из-за недоступных MinIO images |
| AZ/RU/EN | Verified для проверенных экранов | Web build и native browser analytics для трёх языков PASS; это не исчерпывающий редакторский аудит всех строк |
| ERP, банк, ASAN İmza | Not verified / не заявляется как интеграция | CSV не live ERP; статус PAID не платёж; dev signature не ASAN |

Материалы: `docs/presentations/leadprocure-az/v3/output/`. Все оставшиеся ограничения сохранены явно; полный hosted gate PASS не отменяет provisioning/external limitations и отдельную авторизацию merge/deployment.
