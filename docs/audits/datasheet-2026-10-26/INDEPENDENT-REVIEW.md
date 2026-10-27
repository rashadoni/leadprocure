# Независимое ревью исправлений

27 октября 2026. Reviewer: отдельный Codex agent, который не писал исправления. Основание — AGENTS.md / docs/DELIVERY-ARCHITECTURE.md. Это read-only source review, не заменяет hosted acceptance.

Проверен code snapshot383da4e (PR3), затем corrections через bcfc322.

| Находка | Конкретный сценарий | Исправление | Повторный независимый вывод |
|---|---|---|---|
| P1: неподписанный WhatsApp callback | Anonymous POST с известным provider message ID меняет журнал | HMAC-SHA256 original raw body; обязательный Meta app secret; whitelist; HTTP negative/positive tests | Исходная находка закрыта по коду |
| P2: disputed invoice вытесняет корректный match | PO20/receipt10, invoiceA10 matched, invoiceB15 disputed, final receipt10 переводит A в disputed | Новая migration0034: reservation только MATCHED/APPROVED/PAID, приоритет existing matched; submit использует ту же семантику; HTTP/SQL regression | Исходная находка закрыта по коду |
| P2: waiting jobs получают UNKNOWN до отправки | Batch50 с lease5min и медленный первый provider | Claim1 непосредственно перед dispatch, tick overlap guard, bounded HTTP/SMTP; regression проверяет pending jobs | Исходная находка закрыта по коду |

Reviewer не обнаружил новых блокирующих дефектов в этих corrections. Тяжёлые проверки им не выполнялись. Автоматический GitHub Agent review был зелёным через fallback при Anthropic API400; его нельзя выдавать за фактическое ревью. Независимый разбор выше выполнен отдельно. Полный hosted gate должен пройти на фактическом конечном SHA.
