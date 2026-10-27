# Приёмка и отдельно разрешённый выпуск

Обновлено 28 октября 2026 (Asia/Baku). Это кандидат после аудита, **не разрешение на production**. Действующий репозиторий — `rashadoni/leadprocure`. Код: PR3; установка: PR6 поверх PR3; материалы: PR4; доказательства: PR5. Итог приёмки — в [STATUS.md](audits/datasheet-2026-10-26/STATUS.md).

Историческая запись от12 июля о готовности к production и172 тестах superseded текущим аудитом. Действующий runtime уже существует на Contabo: `/home/rashad/projects/Leadprocure/infra`, Compose project `leadprocure-prod`. Его dirty checkout нельзя сбрасывать или заменять.

## Перед решением о выпуске

- [x] Hosted build/API/browser/schema/upgrade/restore/fresh gate пройден на code f5b7e776, run40584185358. Если code SHA изменится при интеграции, нужен gate нового кандидата.
- [x] Независимое ревью выполнено по существу; зелёный fallback при сбое API не считается ревью.
- [ ] Выполнен read-only preflight `scripts/acceptance/preflight-readonly.sql`; исторические дубли согласованы без удаления финансовых данных.
- [ ] Резервная копия production проверена отдельным восстановлением. Тестовый dump/restore не заменяет backup реальной базы.
- [ ] Отдельно разрешены merge и production deployment по [infra/DEPLOY.md](../infra/DEPLOY.md) и [DELIVERY-ARCHITECTURE.md](DELIVERY-ARCHITECTURE.md).

## Fresh bundled installation: PASS в изолированном amd64 CI

Исправления выделены в PR6 (поверх PR3): pinned source-built storage, приватный bucket, configurable empty-volume app role и file-license mount. Source review без blockers; fresh hosted gate40584185358 **PASS** на пустых volumes. Реально проверены restricted/valid license, budget warning/second approver, private signed storage, ClamAV clean/EICAR, runtime DB role и no-context RLS. Client TLS/browser, ARM, коммерческая лицензия и существующие volumes остаются отдельными проверками. Архивированный upstream snapshot не даёт vendor maintenance/SLA.

Исторический blocker до PR6:

На hosted runner подтверждено, что `minio/minio` / `minio/mc` из Docker Hub недоступны. Quay probes также не дали manifest. Текущие Compose templates используют эти images, поэтому команду fresh `docker compose up --build` нельзя считать рабочим сценарием установки. CI использует закреплённый официальный release binary только как disposable fixture; это не исправление production Compose. До отдельного выбора/проверки поддерживаемого S3-compatible storage установка нового on-prem/демо по bundled stack не принята. Существующие runtime volumes/images не менялись.

## Конфигурация, которую проверяет оператор

- TLS и реальные `WEB_ORIGIN` / `PUBLIC_API_URL`; `VITE_DEMO_HINT` выключен.
- Раздельные owner/runtime DB roles: app_user без superuser/BYPASSRLS. Новый empty-volume init берёт APP_DB_PASSWORD из env; существующий volume сохраняет прежний пароль.
- Отдельные JWT secrets и32-byte BID_MASTER_KEY_B64; подписывающий private key лицензии не передаётся клиентскому приложению.
- **Во всех production modes нужна действительная подписанная лицензия.** Dev fallback действует только вне production. Без лицензии новые операции ограничены; существующие обязательства завершаются по предусмотренным guards.
- Лицензию устанавливает оператор deployment: public verification key и подписанный file/DB token. SaaS tenant admin не может ставить server license через `/admin/license`; on-prem admin renewal требует настроенного public key. Фактическая установка у клиента остаётся отдельной приёмкой.
- Реальный ClamAV включён и доступен; конкретный hosted EICAR результат должен быть указан в STATUS.
- Не запускать seed/demo reset в production. Demo filler теперь требует явно изолированные API/DB containers, disposable labels и совпадение маршрутов.

## Внешняя доставка

Пользователь подтвердил отсутствие тестовых SMTP/Meta подключений. Их реальная доставка — NOT RUN. Console provider не даёт доказательства SENT: outbox показывает NOT_CONFIGURED; неопределённая отправка — UNKNOWN с ручной сверкой, без слепого повтора. Для Meta POST callback нужен отдельный `WHATSAPP_APP_SECRET` и HMAC по raw body; GET verify token его не заменяет.

## После отдельно разрешённого обновления

Проверить health вместе с license status/source, доступ двух организаций и ролей, создание новой операции при действующей лицензии, sealed amounts до opening, скачивание только разрешённых документов, refresh cookie/CORS и отсутствие demo credentials. Статус PAID — учётный статус, не банковский перевод; CSV — не live ERP; dev signature — не ASAN.
