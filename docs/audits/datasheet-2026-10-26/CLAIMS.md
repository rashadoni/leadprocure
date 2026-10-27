# Утверждения материалов v3: границы подтверждения

Дата: 27 октября 2026. Проверяется кандидат в feature branch, production не обновлён. «Verified» относится к перечисленным целевым сценариям, не означает полный релизный PASS. Полная приёмка описана в STATUS.md.

| Утверждение | Статус | Доказательство / граница |
|---|---|---|
| Lot-scoped award → contract → PO/catalog | Verified в targeted сценариях | multilot + auction-flow: 15 checks; два независимых лота |
| Reverse auction: лучший допустимый tick, итоговые строки PO | Verified в targeted сценариях | auction-flow; серверный winner guard; полный stress NOT RUN |
| Закрытые предложения / чужая организация | Conditional для релиза | Существующий security suite включён в hosted gate; полный повторный прогон NOT RUN |
| Полная оценка по заранее фиксированным критериям | Verified API / conditional UI | audit-regressions negatives PASS; новый custom-criteria browser test подготовлен, NOT RUN |
| AI помогает сравнить предложения | Verified heuristic / conditional external | Нули, lot, currency, AZ объяснение PASS; реальные LLM ответы не испытывались; решение принимает человек |
| Сверка PO/GRN/invoice и контроль количеств | Verified в targeted сценариях | Одновременные invoice/GRN HTTP tests PASS; PAID — статус учёта, не банковский перевод |
| НДС INCLUSIVE/EXCLUSIVE и 0% | Verified для проверенных примеров | Integer calculations + HTTP + snapshot exports; старый invoice без snapshot не экспортируется как заведомо корректный |
| UBL 2.1 | Verified структура примеров | Два реальных export XML прошли OASIS XSD; unit mapping; Peppol BIS/network — not verified/not implemented |
| OCDS 1.1.5 | Verified структура примера | Canonical JSON schema; cancelled award; downstream consumer NOT RUN |
| Расходы и экономия | Verified в targeted сценариях | Валюта выбирается отдельно, активные awarded lots, net basis, дата создания PO; автоматический FX не обещается |
| Файлы / KYC документы | Verified access flow / conditional AV | Реальный MinIO, grant ownership, immutable snapshot, namespace rejection; реальный ClamAV scan NOT RUN |
| BLOCKED поставщик | Verified проверенные действия | Invitation, bid, catalog HTTP; общий guard для новых договоров/PO; старые обязательства не прекращаются |
| Email/Meta follow-up | Conditional | Outbox/recovery/NOT_CONFIGURED/UNKNOWN — 10 PASS; реальные подключения отсутствуют, внешняя доставка NOT RUN |
| Лицензируемое размещение | Verified signed controls / conditional installation | 3 PASETO checks, upgrade и backup/restore; приёмка реального клиентского on-prem NOT RUN |
| AZ/RU/EN | Conditional | Web types PASS, рекомендации и значимые подсказки обновлены; браузерный языковой gate NOT RUN |
| ERP, банк, ASAN İmza | Not verified / не заявляется как интеграция | CSV не live ERP; статус PAID не платёж; dev signature не ASAN |

Материалы: `docs/presentations/leadprocure-az/v3/output/`. Все оставшиеся ограничения сохранены явно; коммерческий выпуск требует полного gate и отдельной авторизации deployment.
