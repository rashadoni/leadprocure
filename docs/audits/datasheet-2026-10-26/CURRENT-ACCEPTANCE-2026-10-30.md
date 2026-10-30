# Текущая приёмка и утверждения материалов — 30 октября 2026

Репозиторий: **rashadoni/leadprocure**. Принятый исходный код: `7d5d7c3a236e757791dbe2da248fc0da374de2c7` (PR31). [Полная приёмка итогового main](https://github.com/rashadoni/leadprocure/actions/runs/41027721940): оба jobsSUCCESS;30suites/353API,3contention/14native/1freshHTTPS/52RLS, включая nativeRFP AZ/RU/EN и отрицательные операции со счётом. Точные границы: [доказательство](INVOICE-NEGATIVE-MAIN-ACCEPTANCE-2026-10-30.json).

Действующий объём: **19 задач LP-A00–LP-A16, LP-A18, LP-A19**. 18 технически VERIFIED; LP-A19 — PARTIAL_EXTERNAL. Исключённая владельцем задача не входит в текущую очередь. Полная [матрица критериев](FINAL-CRITERIA-2026-10-29.md) и [машиночитаемый статус](FINAL-CRITERIA-2026-10-29.json) сохраняют точные ограничения. Исторические даты, кандидаты, числа тестов и разрешения в прежних записях не являются текущим состоянием.

Дополнение LP-A19: кандидат `281ca64` прошёл [полный run41023648853](https://github.com/rashadoni/leadprocure/actions/runs/41023648853). Native RFP до PAID теперь проверен на AZ/RU/EN у обеих сторон; [точное доказательство](RFP-LANGUAGES-ACCEPTANCE-2026-10-30.json). Это расширение тестов, приложение и материалы не изменены. Прежнее ограничение полного downstream только EN superseded; внешние ограничения ниже сохранены.

Дополнение отрицательных сценариев LP-A19: кандидат `59ef4ed` прошёл [run41026654540](https://github.com/rashadoni/leadprocure/actions/runs/41026654540). Approve/pay503 и отмена override проверены на AZ/RU/EN, фактический reject — EN; [точная граница](INVOICE-NEGATIVE-ACCEPTANCE-2026-10-30.json). Управляемая HTTP-ошибка не выдана за серверный rollback. Приложение/материалы неизменны.

Дополнение LP-A19 по деталям счёта: UIкандидат `81ea3a5` прошёл [run41029977827](https://github.com/rashadoni/leadprocure/actions/runs/41029977827). Старые detailGET после nativeapproveAZ/payRU не меняют новый статус; pendingclose и detailerrorretry провереныAZ/RU/EN. [Точная граница](INVOICE-READ-ACCEPTANCE-2026-10-30.json). Сервер/материалы не менялись; внешние ограничения сохранены.

## Что подтверждено для презентации и data sheet

| Утверждение | Подтверждение | Граница |
|---|---|---|
| Revers-auksion | Auction API, concurrency и native сценарии до downstream документов | Не capacity/SLA benchmark |
| Məxfi RFQ / RFP, RFI | Sealed payload, buyer secrecy до открытия, supplier own response; RFI без цен/award | Полный native RFP до PAID — AZ/RU/EN в выбранных сценариях |
| Выбор победителей по лотам | Раздельные award/contract/PO, актуальная оценка и отмена/повторное назначение | AI не назначает победителя |
| Согласования и роли | SoD, серверные политики, finance step, изоляция организаций/подразделений | Это проверенные сценарии, не внешняя сертификация |
| Бюджетирование | AZN планы, периоды/подразделения, lifecycle/phasing, thresholds и документированное исключение | По умолчанию предупреждение; блокировка зависит от политики |
| Бюджетная сводка | Текущий фильтр, явные ошибки/retry; оплата по периоду обязательства и доступной области | Не банковский cash-flow; PAID отдельно от actual, без удвоения |
| Частичная приёмка и счета | Billable остаток, 3-way match, блокировка конкурентных операций, обновление открытой карточки | PAID — зарегистрированный статус, не банковский перевод |
| Деньги и НДС | Integer minor units, проверенные mixed 0/18% INCLUSIVE/EXCLUSIVE примеры | Нет обещания автоматического FX |
| Файлы и KYC | Private storage, grants/immutable copy, real ClamAV clean/EICAR, RLS | Не внешний pentest |
| UBL / OCDS | Четыре UBL XML по OASIS XSD; OCDS 1.1.5, secrecy и active/cancelled awards | Не Peppol network/BIS и не приёмка downstream потребителя |
| Помощь AI | Heuristic и controlled HTTP provider boundary/fallback tests | Live внешний LLM и качество его объяснений NOT RUN |
| Лицензируемое размещение | Signed file license, restricted production без лицензии, fresh isolated Compose, modeled upgrade/restore | Не реальное клиентское внедрение/коммерческая лицензия/public TLS |
| AZ/RU/EN | Проверенные native экраны, детали счетов, бюджетные ошибки/retry и tooltip | Не исчерпывающий редакторский аудит всех строк |

Подробные сценарии и доказательства по каждой функции находятся в матрице критериев. Новых утверждений об интеграциях не добавлено: CSV не live ERP, dev signature не ASAN İmza; внешний банк/ERP/ASAN/Peppol NOT RUN.

## Готовые материалы

- [Корпоративная презентация AZ — PPTX](../../presentations/leadprocure-az/v3/output/Leadprocure_Korporativ_Teqdimat_AZ_v3.pptx), [PDF](../../presentations/leadprocure-az/v3/output/Leadprocure_Korporativ_Teqdimat_AZ_v3.pdf).
- [Data sheet AZ — PPTX](../../presentations/leadprocure-az/v3/output/Leadprocure_Data_Sheet_AZ.pptx), [PDF](../../presentations/leadprocure-az/v3/output/Leadprocure_Data_Sheet_AZ.pdf).
- [Заметки докладчика AZ](../../presentations/leadprocure-az/v3/output/Meruzeci_Qeydleri_AZ.md).

На 30 октября контрольные суммы всех 9 файлов манифеста совпали. Файлы не изменены после принятого [рендера 15 страниц](https://github.com/rashadoni/leadprocure/actions/runs/40698739541); он не выдаётся за новый рендер. Desktop Microsoft PowerPoint **NOT RUN**: повторная проверка Document Control не нашла подключённых сессий.

## Оставшиеся границы LP-A19

Реальное клиентское окружение/коммерческая лицензия/public TLS/existing-volume upgrade, live LLM quality, внешние ERP/банк/ASAN/Peppol и PowerPoint desktop остаются NOT RUN. Наличие полного CI не закрывает эти проверки. Производственная выкладка не выполнялась и общим разрешением на разработку не разрешена. Существующий IP и резервное копирование не менялись.

Это синхронизация сводки с уже принятым кодом, без изменения приложения, тестов, PPTX/PDF или критериев завершения. Для этой правки достаточны независимое ревью, проверка локальных ссылок/JSON/контрольных сумм и равенство исходников принятому main; повтор полного build/E2E не заявляется новым PASS.
