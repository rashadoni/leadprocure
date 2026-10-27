# Полная приёмка: проверенные варианты — 27 октября 2026

Исходная ветка сохранена в `rashadrahimov/leadprocure`; production не менялся. Состояние API зафиксировано в `ci-options-2026-10-27.json`.

| Вариант | Результат проверки | Что нужно для запуска |
|---|---|---|
| Текущий GitHub account rashadrahimov | Последний push и PR: startup_failure до создания jobs. Rerun403. Actions enabled, YAML actionlint PASS | Восстановить запуск в аккаунте; причина текущего ограничения не раскрывается API |
| Отдельный приватный repo у rashadoni | Существующий Leadprocure у этого owner имеет успешный run38175611519, но repo public. Сам аккаунт доступен с admin rights | Согласие пользователя на перенос текущей ветки в task-owned PRIVATE `rashadoni/leadprocure-acceptance`; использовать тот же acceptance.yml без production secrets |
| GitHub Codespaces | API отклоняет доступ текущего token | Доступ к Codespaces в подходящем аккаунте и подтверждённая доступная квота |
| Azure DevOps org rashadrahimov | Existing build definitions доступны; LeadDrive definitions disabled; pool/agent queue API401 | Отдельная разрешённая очередь/права на worker для Leadprocure. LeadDrive pipelines не включались и не запускались |
| Mac-managed ephemeral worker | Нет настроенного SSH alias/инструмента вызова | Координатор должен предоставить предусмотренный host contract worker |

Найденный `codex-heavy-run` ограничивает процессы на том же Contabo, не является внешним worker. Он не отменяет host contract. Полный suite здесь не запускался.

## Billing: подтверждённое и неизвестное

[Исторический публичный ping](https://github.com/rashadrahimov/actions-lock-test/actions/runs/33473921959) содержит annotation о блокировке аккаунта из-за billing. Это делает ограничение аккаунта обоснованной гипотезой для текущего private repo, но не подтверждает нынешнее состояние оплаты. Старый ping нельзя повторить: GitHub возвращает403, потому что run старше месяца. Billing usage API404 не даёт проверить текущие лимиты. Платёжные настройки не менялись.

GitHub рекомендует проверять billing errors при диагностике старта workflows: [официальная документация](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows). Для Codespaces API требуется scope/permission Codespaces: [официальный API](https://docs.github.com/en/rest/codespaces/codespaces). Azure hosted workers требуют выделенной capacity: [Microsoft Learn](https://learn.microsoft.com/en-us/azure/devops/pipelines/licensing/concurrent-jobs?tabs=self-hosted&view=azure-devops).

## Подготовленный следующий шаг

После разрешения создать приватный `rashadoni/leadprocure-acceptance`, проверить API `private=true`, отправить только текущую feature branch без изменения origin исходного worktree и выполнить существующий `.github/workflows/acceptance.yml`. Обязательны полный build, все API suites, browser/language scenarios, официальные export schemas, upgrade и dump/restore. Репозиторий временный, без production secrets. Отчёт должен ссылаться на фактический tested SHA и artifact/run; наличие другого успешного run само по себе не считается приёмкой текущего кода.
