# Leadprocure — audit sonrası materiallar / v3

C / Monograph saxlanılıb: 13 slayd, ayrıca 2 səhifəlik A4 data sheet; PPTX redaktə ediləndir. V2 saxlanılır.

Nüsxə eyni valyuta/lot üzrə AI müqayisəsini, ümumi UBL 2.1 sərhədini, xərc tarixinin əsasını və xarici kanalların qoşulma şərtini dəqiqləşdirir. Bu materiallar audit düzəlişləri olan namizəd versiyanı təsvir edir. Production yenilənməyib; tam qəbul statusuna `docs/audits/datasheet-2026-10-26/STATUS.md` faylında baxın.

Yenidən yaratmaq:

```bash
LEADPROCURE_MATERIAL_ROOT="$PWD/docs/presentations/leadprocure-az/v3" LEADPROCURE_MATERIAL_VERSION=v3 PYTHONPATH=/tmp/leadprocure-presentation-libs python3 docs/presentations/leadprocure-az/v2/build_presentation.py
LEADPROCURE_MATERIAL_ROOT="$PWD/docs/presentations/leadprocure-az/v3" PYTHONPATH=/tmp/leadprocure-presentation-libs python3 docs/presentations/leadprocure-az/v2/build_datasheet.py
```

Fonts və üz qabığı əvvəlki v2 resurslarından istifadə olunur. Canlı ERP, bank ödənişi, ASAN/Peppol qoşulması və faktiki xarici göndəriş təsdiqlənmiş kimi təqdim edilmir.

28 oktyabr yeniləməsi (LP-A19): büdcə mətnləri şöbə/dövr planları, sazlanan bloklama həddi və maliyyə roluna uyğunlaşdırılıb. Dəyişmiş PPTX/PDF üçün əvvəlki native render nəticəsi tətbiq edilmir; yeni hosted render tələb olunur. Dizayn dəyişdirilməyib.
