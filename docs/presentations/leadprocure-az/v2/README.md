# Leadprocure — C / Monograph, Azərbaycan dili

User selected concept C on 26 October 2026 and explicitly requested the matching data sheet. This version supersedes the rejected V1 for client presentation use. The earlier files remain preserved.

## Deliverables

- `output/Leadprocure_Korporativ_Teqdimat_AZ_v2.pptx`: 13 slides, native editable text and diagrams, speaker notes on every slide.
- `output/Leadprocure_Korporativ_Teqdimat_AZ_v2.pdf`: presentation PDF with embedded fonts, ready to show.
- `output/Leadprocure_Data_Sheet_AZ.pdf`: separate two-page A4 product data sheet, 10 capabilities plus operating profile, deployment, controls and integration conditions.
- `output/Leadprocure_Data_Sheet_AZ.pptx`: the same two A4 portrait pages as editable PowerPoint text and shapes, added at the user's explicit request. Text parity with the PDF verified; desktop PowerPoint rendering not run.
- `output/Meruzeci_Qeydleri_AZ.md`: presenter notes and source references.
- `output/Leadprocure_Data_Sheet_AZ.md`: editable data-sheet copy.
- `output/Leadprocure_AZ_Monograph_Pack.zip`: client-facing files, notes and fonts for PowerPoint editing.

Native Google Slides: https://docs.google.com/presentation/d/1euJAo_qUy5CRCNruBXUA99Wph5qNwnvU1Bu5WPZ1rio/edit

Approved Canva concept: https://canva.link/cgxz3skr5l533nu . Its corrected draft was committed following the user's selection. This is the three-slide design reference, not the full deck. The full 13-slide deliverable is available above.

## Design and editing

Monochrome black `#161616`, white and silver; Barlow Condensed Bold for titles and IBM Plex Sans for supporting text. Fonts include Azerbaijani `ə Ə ı İ ğ Ğ ş Ş ç Ç ö Ö ü Ü`. No UI screenshots, navy, green/mint palette or Lato. The presenter leads the story; live product demonstration remains separate.

The PDF contains embedded fonts. To preserve typography while editing the PPTX on a computer without these families, install the bundled Barlow Condensed and IBM Plex Sans static fonts. Google Slides rendering was verified with those families. The PPTX uses editable text and native geometric shapes; the cover illustration is a raster asset.

Font licenses and original sources: [Barlow Condensed](https://github.com/google/fonts/tree/main/ofl/barlowcondensed), [IBM Plex Sans](https://github.com/google/fonts/tree/main/ofl/ibmplexsans). Both OFL license texts are in `fonts/`. Static IBM fonts were instanced at normal width from the included variable source using fontTools; no outlines were changed.

## Validation

- 13 PPTX slides, 13 local PDF pages, 13 native Google Slides pages, 2 A4 data-sheet pages.
- All local slides/data-sheet pages inspected by two agents; all native Google Slides PDF pages inspected. Final slide 7 VAT-label change checked again through a fresh native thumbnail.
- No measured text overflows, clipped text or missing Azerbaijani glyphs found.
- Auction: illustrative start 32,000; current best 31,200; minimum step 320; next maximum 30,880 AZN. Final step is dashed and not presented as a placed bid.
- Separate sealed-RFQ demo: 57,000 estimate, 51,500 selected offer, 5,500 / 9.65% difference, excluding VAT. Explicitly demo data, not a real client result or promised ROI.
- AI remains advisory; budget overruns warn without blocking; payment status is bookkeeping; CSV/UBL/OCDS are file exports; real ASAN connection is not active. Data sheet includes relevant boundaries.
- PowerPoint desktop was NOT RUN: no Microsoft PowerPoint runtime on this Contabo host. Office-format import and all slide renders were checked through native Google Slides. Small inherited shape shadows in that renderer differ from the deliberately flat vector PDF; no layout or legibility issue was found.
- App build/API E2E/browser E2E: NOT RUN, not applicable to document-only changes and prohibited as heavy work on this host.

## Rebuild

Required Python libraries: python-pptx, Pillow, reportlab, PyMuPDF. They were already available under `/tmp/leadprocure-presentation-libs`; fontTools was added for font preparation only.

```sh
PYTHONPATH=/tmp/leadprocure-presentation-libs python3 docs/presentations/leadprocure-az/v2/build_presentation.py
PYTHONPATH=/tmp/leadprocure-presentation-libs python3 docs/presentations/leadprocure-az/v2/build_datasheet.py
```

Run sequentially on this host. `content-reviewed.json`, `datasheet-content.json` and `output/slide-manifest.json` preserve the reviewed copy and rendered text. Earlier research is in `../research-and-sources.md`; its V1 visual direction is superseded by C.

## Cover illustration provenance

Asset: `assets/monograph-network.png`. Built-in `image_gen` through the `imagegen` skill; no API-key or CLI fallback. Project copy preserves the original generated asset. Input reference: `../concepts/C-01.png`, used only for style.

Final generation prompt:

> Use case: stylized-concept. Asset type: premium corporate presentation cover illustration for Leadprocure procurement software. Use the attached C concept ONLY as visual style reference; create a clean new image asset WITHOUT ANY TEXT or lettering. Landscape 16:9 composition, 1920x1080 or larger. Matte near-black #161616 seamless background. LEFT 46% entirely empty near-black for native editable typography to be added later. RIGHT 54%: a precise, elegant monochrome sculptural network of one substantial central brushed-silver cube connected by thin polished metal rods to six smaller silver cubes, arranged in balanced three-dimensional perspective above a low dark rectangular plinth. Physical studio product-photography quality, subtle fine grain on brushed aluminum, soft directional illumination from top-left, controlled shadows, restrained silver highlights. Sophisticated, industrial, credible for enterprise procurement. No colorful light, no blue, no gradients across the left empty area, no labels, no words, no symbols, no logo, no watermark, no dashboard, no interface, no ornamental clutter. Whole object fully within frame with clear margins; structure remains on right. Reference shows tone and subject only; don't copy any text.

Generated output is 1672 × 941 px and displayed as the full slide background; all presentation text is native and editable.
