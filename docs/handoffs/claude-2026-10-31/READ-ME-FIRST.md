# Пакет передачи Leadprocure → Claude, 31 октября 2026

1. Прочитайте HANDOFF.md: все 20 исходных задач, результаты и границы.
2. Передайте Claude PROMPT-FOR-CLAUDE.txt вместе с архивом или доступом к репозиторию.
3. TASK-INVENTORY.json содержит полный перечень, исходные критерии и ограничения; PR-INVENTORY.json и VERIFIED-MAIN-CI.json — сверку GitHub на дату передачи.

Репозиторий: https://github.com/rashadoni/leadprocure
Ветка с передачей и postmerge-доказательствами: codex/leadprocure-budget-audit-integration
Проверенная версия приложения: main5782aba3e1a03459bea4971ced856720c61359f2
Последний полный CI: https://github.com/rashadoni/leadprocure/actions/runs/41112571528

Из 20 исходных задач 18 технически проверены, LP-A19 частично внешняя, LP-A17 исключена владельцем. Все 20 полностью выполненными не объявлены. Production не менялся; разрешение на него не дано. SMTP/Meta не возвращать в очередь.

В архиве repo-файлы лежат с исходными путями docs/, infra/, scripts/, .github/. Внешние секреты, .env, DB dump, .git, node_modules и LFS-видео не включены. Код/историю получать из GitHub. Архив не является production backup.

FILE-SHA256SUMS.txt позволяет проверить каждое вложение после распаковки. Соседний .sha256 проверяет сам архив.
