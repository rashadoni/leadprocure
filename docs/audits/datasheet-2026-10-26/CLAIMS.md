# Утверждения материалов v3: границы подтверждения

Дата: 28 октября 2026 (Asia/Baku). Проверяется кандидат в feature branch, production не обновлён. «Verified» относится к перечисленным целевым сценариям, не означает полный релизный PASS. Актуальный hosted run40590876331 на code e0cd658:195 API +3 contention tests +9 обычных browser tests, отдельный fresh production HTTPS Chromium scenario, build/schemas/upgrade/restore/fresh installation и modeled storage upgrade PASS. LibreOffice/Google Slides rendering PASS. Факты сохранены в ACCEPTANCE-2026-10-28-EXTENDED.json; полная приёмка и оставшиеся ограничения — STATUS.md.

| Утверждение | Статус | Доказательство / граница |
|---|---|---|
| Lot-scoped award → contract → PO/catalog | Verified в targeted сценариях | multilot + auction-flow: 15 checks; два независимых лота |
| Reverse auction: лучший допустимый tick, итоговые строки PO | Verified в targeted сценариях | auction-flow; серверный winner guard; полный stress NOT RUN |
| Закрытые предложения / чужая организация | Verified в regression suite | Полный security/RLS suite PASS на hosted runner; это не внешняя сертификация |
| Полная оценка по заранее фиксированным критериям | Verified API/UI | HTTP negative tests и native browser custom criteria/re-evaluation PASS |
| AI помогает сравнить предложения | Verified heuristic / conditional external | Нули, lot, currency, AZ объяснение PASS; реальные LLM ответы не испытывались; решение принимает человек |
| Сверка PO/GRN/invoice и контроль количеств | Verified в targeted сценариях | 296 contended HTTP calls с8 параллельными запросами на batch: invoice/GRN/auction/close PASS; это не capacity benchmark; PAID — статус учёта, не банковский перевод |
| НДС INCLUSIVE/EXCLUSIVE и 0% | Verified для проверенных примеров | Integer calculations + HTTP + snapshot exports; старый invoice без snapshot не экспортируется как заведомо корректный |
| UBL 2.1 | Verified структура примеров | Два реальных export XML прошли OASIS XSD; unit mapping; Peppol BIS/network — not verified/not implemented |
| OCDS 1.1.5 | Verified структура примера | Canonical JSON schema; cancelled award; downstream consumer NOT RUN |
| Расходы и экономия | Verified в targeted сценариях | Валюта выбирается отдельно, активные awarded lots, net basis, дата создания PO; автоматический FX не обещается |
| Бюджет и обязательства по закупкам | Verified API +fresh production HTTP | 8 budgets tests входят в195 PASS; fresh HTTP подтверждает отдельного approver, обязательства/остаток и изоляцию покупателей. Категория/год/валюта; превышение предупреждает и **не блокирует** согласование. Это бюджетный контроль закупок, не самостоятельная система финансового планирования |
| Файлы / KYC документы | Verified в проверенных сценариях | Реальные MinIO и ClamAV/EICAR PASS, grant ownership, immutable snapshot, namespace rejection |
| BLOCKED поставщик | Verified проверенные действия | Invitation, bid, catalog HTTP; общий guard для новых договоров/PO; старые обязательства не прекращаются |
| Email/Meta follow-up | Conditional | Outbox/recovery/NOT_CONFIGURED/UNKNOWN и signed webhook tests PASS; реальные подключения отсутствуют, внешняя доставка NOT RUN |
| Лицензируемое размещение | Verified signed controls +fresh isolated installation / conditional client rollout | Production Compose реально собран/запущен на пустых volumes: missing-license restricted, signed file valid; upgrade и disposable backup/restore PASS. Fresh HTTPS/browser PASS на доверенном тестовом CA; modeled legacy storage volume upgrade PASS. Реальный клиент, коммерческая лицензия/public TLS и реальный existing-volume upgrade NOT RUN. Archived storage snapshot не vendor SLA |
| AZ/RU/EN | Verified для проверенных экранов | Web build и native browser analytics для трёх языков PASS; это не исчерпывающий редакторский аудит всех строк |
| ERP, банк, ASAN İmza | Not verified / не заявляется как интеграция | CSV не live ERP; статус PAID не платёж; dev signature не ASAN |

Материалы: `docs/presentations/leadprocure-az/v3/output/`. Все оставшиеся ограничения сохранены явно; полный hosted gate PASS не отменяет provisioning/external limitations и отдельную авторизацию merge/deployment.

Дополнительная совместимость материалов: actual PPTX→LibreOffice и PPTX→native Google Slides→PDF,13+2 страницы;100% текста/шрифты/границы и визуальный осмотр PASS. Desktop Microsoft PowerPoint NOT RUN: подключённой сессии нет. Исходные PPTX и claims не изменены.
