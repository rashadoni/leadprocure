# Независимое ревью исправлений

27 октября 2026. Reviewer: отдельный Codex agent, который не писал исправления. Основание — AGENTS.md / docs/DELIVERY-ARCHITECTURE.md. Это read-only source review, не заменяет hosted acceptance.

Проверен code snapshot383da4e (PR3), затем corrections через bcfc322.

| Находка | Конкретный сценарий | Исправление | Повторный независимый вывод |
|---|---|---|---|
| P1: неподписанный WhatsApp callback | Anonymous POST с известным provider message ID меняет журнал | HMAC-SHA256 original raw body; обязательный Meta app secret; whitelist; HTTP negative/positive tests | Исходная находка закрыта по коду |
| P2: disputed invoice вытесняет корректный match | PO20/receipt10, invoiceA10 matched, invoiceB15 disputed, final receipt10 переводит A в disputed | Новая migration0034: reservation только MATCHED/APPROVED/PAID, приоритет existing matched; submit использует ту же семантику; HTTP/SQL regression | Исходная находка закрыта по коду |
| P2: waiting jobs получают UNKNOWN до отправки | Batch50 с lease5min и медленный первый provider | Claim1 непосредственно перед dispatch, tick overlap guard, bounded HTTP/SMTP; regression проверяет pending jobs | Исходная находка закрыта по коду |

Reviewer не обнаружил новых блокирующих дефектов в этих corrections. Тяжёлые проверки им не выполнялись. Автоматический GitHub Agent review был зелёным через fallback при Anthropic API400; его нельзя выдавать за фактическое ревью. Независимый разбор выше выполнен отдельно. Полный hosted gate должен пройти на фактическом конечном SHA.

## Дополнительное независимое ревью материалов и runbook

Тот же отдельный reviewer проверил PR4/PR5 и corrections через b552496: SHA256 v2/v3 совпали, native-text PPTX13/2 доступны, блокирующего расхождения в v3 claims не найдено. Найдены unsafe default demo reset target и устаревшие production/cloud-license утверждения в LAUNCH checklist. Исправления: явный isolated target, disposable labels API/DB, DB leadprocure_demo, app_user DB URL, общая сеть и проверенные literal127.0.0.1 Docker HostIp/HostPort; reset failure останавливает reseed/recording; SQL передаётся отдельными argv. 4 guard tests PASS. Checklist требует signed license для любого production и явно отмечает fresh Compose NO-GO. Reviewer подтвердил закрытие этих находок по исходникам; reset/production команды не выполнялись.

После source review hosted acceptance run40518660742 на code82e323a завершился PASS:195 API/9 browser/full build/schema/upgrade/restore. Он не заменяет перечисленную в STATUS.md внешнюю/on-prem приёмку. Автоматический agent-review fallback по-прежнему не считается независимым разбором.

## 2026-10-28 — fresh installation candidate, independent source review

A separate agent reviewed the new storage Dockerfile/bootstrap, Compose dependency
and license wiring, PostgreSQL empty-volume role script, hosted-only fixture
containment, HTTP expectations and revised deployment runbook. No blocking source
findings. Scope: read-only review; no heavy execution on Contabo. Hosted image
build/fresh production Compose gate remains pending. Fresh-stack browser CORS,
HTTPS secure-cookie refresh, ARM, existing-volume upgrades and real commercial
client licensing are not established by this source review or HTTP fixture.

Hosted follow-through: run40584185358 on f5b7e776 completed successfully. Both
full acceptance (195 API,9 browser,build,schemas,upgrade/restore) and actual fresh
production Compose (source-built storage/API/web/AI, signed file license,
budget/approver/RLS/private storage/real ClamAV) passed. Evidence does not remove
the explicitly listed client/TLS/ARM/existing-volume/external-provider limits.

## 2026-10-28 — extended gate review and corrections

Independent reviewer found two evidence gaps in the new tests: closers serialized
on one pg.Client and lazy HTTP requests; client cookie deletion did not prove
server logout revocation. Fixed with8 distinct closer connections, observed DB
barrier overlap and1 close audit, plus genuine same-session cookie replay401.
Cleanup was additionally corrected so failed parallel work cannot skip closing
its connections. Re-review: no remaining material blockers.

Renderer review found default PyMuPDF clipping hid out-of-page text; geometry
now uses INFINITE_RECT. Corrected hosted render40590502221 PASS. Modeled legacy
storage upgrade source review: no material blockers; actual hosted40590876331
PASS,4 versions/checksums/metadata/private reads preserved. Full195 API +3 stress
+9 ordinary UI +1 production HTTPS UI PASS. Native Google Slides13+2 pages also
passed text/bounds and complete visual review; desktop PowerPoint unavailable.
Automated green fallback still is not substituted for these substantive reviews.
