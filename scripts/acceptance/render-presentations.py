#!/usr/bin/env python3
"""Inspect PDFs independently rendered from the shipped PPTX files by LibreOffice.

This is not native Microsoft PowerPoint/Google Slides certification. Output is
standalone evidence; source PPTX/PDF files are never overwritten.
"""
import collections
import json
import re
import sys
import unicodedata
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import pymupdf as fitz
from PIL import Image, ImageDraw

source, rendered = map(Path, sys.argv[1:3])
specs = [('Leadprocure_Korporativ_Teqdimat_AZ_v3', 13), ('Leadprocure_Data_Sheet_AZ', 2)]
ns = {'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}

def tokens(text):
    text = re.sub(r'-\s*\n\s*', '', text)
    text = ''.join(c for c in unicodedata.normalize('NFKD', text.casefold()) if unicodedata.category(c) != 'Mn')
    return collections.Counter(re.findall(r'\w+', text, flags=re.UNICODE))

results, problems, thumbnails = [], [], []
for name, expected_pages in specs:
    pdf = fitz.open(rendered / f'{name}.pdf')
    if len(pdf) != expected_pages:
        problems.append(f'{name}: expected {expected_pages} pages, got {len(pdf)}')
    with zipfile.ZipFile(source / f'{name}.pptx') as pptx:
        for index, page in enumerate(pdf):
            xml = ET.fromstring(pptx.read(f'ppt/slides/slide{index+1}.xml'))
            expected = tokens(' '.join(n.text or '' for n in xml.findall('.//a:t', ns)))
            text = page.get_text()
            missing = expected - tokens(text)
            coverage = 1 - sum(missing.values()) / max(1, sum(expected.values()))
            fonts, overflow = set(), []
            for block in page.get_text('dict')['blocks']:
                for line in block.get('lines', []):
                    for span in line['spans']:
                        if not span['text'].strip():
                            continue
                        fonts.add(span['font'])
                        rect = fitz.Rect(span['bbox'])
                        if rect.x0 < -1 or rect.y0 < -1 or rect.x1 > page.rect.width+1 or rect.y1 > page.rect.height+1:
                            overflow.append(span['text'][:100])
            unexpected_fonts = [f for f in fonts if not any(family in re.sub(r'[^a-z]', '', f.lower()) for family in ['barlowcondensed', 'ibmplexsans'])]
            if coverage < 0.99 or overflow or '\ufffd' in text or unexpected_fonts:
                problems.append(f'{name} page {index+1}: coverage={coverage:.3f}, overflow={overflow}, fallback={unexpected_fonts}')
            results.append({'file': name, 'page': index+1, 'textCoverage': coverage,
                'missingTokens': dict(missing), 'outOfPageText': overflow, 'fonts': sorted(fonts),
                'replacementCharacter': '\ufffd' in text})
            pix = page.get_pixmap(matrix=fitz.Matrix(1, 1), alpha=False)
            image = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
            image.save(rendered / f'{name}-{index+1:02d}.png')
            image.thumbnail((440, 290))
            thumbnails.append((f'{name} / {index+1}', image))
    # Do not compare pixels as an exact gate: the independent font engines have
    # different antialiasing. Native rendered pages are retained for human review.

for batch in range(0, len(thumbnails), 6):
    group = thumbnails[batch:batch+6]
    sheet = Image.new('RGB', (960, 1000), '#e7e7e7')
    draw = ImageDraw.Draw(sheet)
    for n, (label, image) in enumerate(group):
        x, y = 20 + (n % 2)*480, 20 + (n // 2)*325
        draw.text((x, y), label, fill='#161616')
        sheet.paste(image, (x, y+22))
    sheet.save(rendered / f'contact-sheet-{batch//6+1}.jpg', quality=90)
report = {'renderer': 'LibreOffice Impress (independent PPTX render)',
    'status': 'FAIL' if problems else ('REVIEW_REQUIRED' if any(p['missingTokens'] for p in results) else 'PASS'),
    'checks': results, 'problems': problems,
    'nativeMicrosoftPowerPointOrGoogleSlides': 'NOT RUN', 'humanVisualReview': 'PENDING'}
(rendered / 'render-qa.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
print(json.dumps({'status': report['status'], 'pages': len(results), 'problems': problems}, ensure_ascii=False))
if problems:
    raise SystemExit(1)
