# Leadprocure — korporativ təqdimat və data sheet (AZ)

Audience: potential enterprise customers. Language: Azerbaijani. Visual direction: warm white, graphite, emerald/mint; no dark blue design.

## Deliverables

- `output/Leadprocure_Korporativ_Teqdimat_AZ.pptx` — editable 22-slide presentation; native text and screenshots.
- `output/Leadprocure_Korporativ_Teqdimat_AZ.pdf` — matching 22-page PDF with embedded fonts.
- `output/Leadprocure_Data_Sheet_AZ.pdf` — 2-page A4 product specification.
- `output/Leadprocure_Data_Sheet_AZ.md` — editable data-sheet copy.
- `output/Meruzeci_Qeydleri_AZ.md` — Azerbaijani presenter notes and source map.
- `output/contact-sheet-*.jpg` — slide overview.
- Native Google Slides: https://docs.google.com/presentation/d/1SfGG-D0eyIlG-5ubyKpp9tSyGHETMw3fMYwd7_KmV1Q/edit

## Sources and reproducibility

Research is based on repository commit `2a94cc5`, current service code, `scripts/demo-fill.mjs`, `scripts/produce-guides.mjs`, and existing Azerbaijani demo recordings. No production access, app builds, database writes, newly recorded sessions or generated UI mockups were used.

Screenshots are authentic saved AZ demo frames. The renderer may show a labelled excerpt; screenshot proportions and meaningful selected content are preserved. Historical demo dates are not presented as live customer data. The server procurement example is 57,000 AZN estimated, 51,500 AZN awarded (5,500 / 9.65% difference), and 60,770 AZN invoice including the demo's 18% VAT. These are explicitly demonstration results.

Python dependencies: `python-pptx`, `Pillow`, `reportlab`, `pymupdf`; font: installed Lato Regular/Bold. `build_presentation.py` writes editable PPTX and matching PDF using the same text and geometry. `build_datasheet.py` renders `datasheet-content.json`. Both run offline and do not execute application code. The environment used temporary Python packages under `/tmp/leadprocure-presentation-libs` rather than changing app dependencies.

```bash
PYTHONPATH=/tmp/leadprocure-presentation-libs python3 docs/presentations/leadprocure-az/build_presentation.py
PYTHONPATH=/tmp/leadprocure-presentation-libs python3 docs/presentations/leadprocure-az/build_datasheet.py
```

`slide-content.json` and `research-and-sources.md` preserve exact wording and evidence. Native Google Slides was imported, read back as 22 slides, updated for final language corrections, and placed in the ChatGPT Drive folder. All 26 changed text elements were acknowledged by the connector. Its reverse-auction slide was visually inspected after the final edits.

## Verification

- 22 PPTX slides and 22 PDF pages; 15 embedded screenshots; 2 data-sheet pages.
- All local pages visually reviewed via rendered contact sheets; corrected pages individually inspected.
- No layout overflow findings; native editable text retained.
- Azerbaijani characters, demo arithmetic and source file existence checked.
- Google-native full PDF export: NOT RUN to completion. The connector returned an authenticated file reference without a materialized workspace file; a native slide thumbnail was used for targeted rendering verification instead. Local PDF is fully rendered and reviewed.
- Application builds, API E2E and browser E2E: NOT RUN — documentation/media-only task, no application changes; host policy excludes heavy checks.
- No push, merge, production inspection or deploy.
