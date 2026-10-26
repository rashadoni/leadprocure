#!/usr/bin/env python3
"""Render two-page A4 Azerbaijani product data sheet from reviewed JSON."""
from pathlib import Path
import json
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.colors import HexColor
import pymupdf

ROOT=Path(__file__).resolve().parent; OUT=ROOT/'output'; OUT.mkdir(exist_ok=True)
d=json.loads((ROOT/'datasheet-content.json').read_text())
W,H=595.276,841.89
INK='202B27'; GREEN='087F62'; FOREST='164B3C'; MUTED='607069'; BG='F8F7F3'; MINT='E6F1E9'; LINE='DCE4DE'
for name,path in [('Lato','Lato-Regular.ttf'),('Lato-Bold','Lato-Bold.ttf')]: pdfmetrics.registerFont(TTFont(name,'/usr/share/fonts/truetype/lato/'+path))
c=canvas.Canvas(str(OUT/'Leadprocure_Data_Sheet_AZ.pdf'),pagesize=(W,H))
c.setTitle('Leadprocure — Məhsulun texniki məlumat vərəqi'); c.setAuthor('Leadprocure')
issues=[]
def box(x,y,w,h,fill=BG):
 c.setFillColor(HexColor('#'+fill)); c.roundRect(x,H-y-h,w,h,5,fill=1,stroke=0)
def txt(s,x,y,w,size=10.5,bold=False,color=INK,limit=None):
 font='Lato-Bold' if bold else 'Lato'; lines=[]
 for p in s.split('\n'):
  line=''
  for word in p.split():
   cand=(line+' '+word).strip()
   if line and pdfmetrics.stringWidth(cand,font,size)>w: lines.append(line); line=word
   else: line=cand
  lines.append(line)
 height=len(lines)*size*1.3
 if limit and height>limit: issues.append({'text':s[:65],'height':height,'limit':limit})
 c.setFont(font,size); c.setFillColor(HexColor('#'+color))
 for i,l in enumerate(lines): c.drawString(x,H-y-size*.91-i*size*1.3,l)
 return height
def header(num,sub):
 box(0,0,W,H); txt('Leadprocure',36,29,300,24,True,GREEN)
 txt('MƏHSUL MƏLUMAT VƏRƏQİ',350,36,210,9,True,MUTED)
 c.setStrokeColor(HexColor('#'+LINE)); c.line(36,H-69,W-36,H-69)
 txt(sub,36,86,W-72,22,True)
 txt('26 oktyabr 2026  ·  Korporativ müştərilər üçün',36,809,460,8.5,False,MUTED)
 txt(f'{num} / 2',532,809,40,9,True,GREEN)
def section(title,x,y,w):
 txt(title,x,y,w,13,True,GREEN)
 c.setStrokeColor(HexColor('#'+LINE)); c.line(x,H-y-23,x+w,H-y-23)
 return y+34

header(1,'Satınalma və təchizatçı əməkdaşlığı')
txt(d['intro'],36,126,W-72,11,False,MUTED,limit=60)
box(36,190,W-72,43,MINT)
txt('RFQ / RFP / RFI     Revers-auksion     Müqavilə → PO → Qaimə',49,204,W-98,11,True,FOREST)
txt('Əsas imkanlar',36,253,W-72,16,True)
for i,cap in enumerate(d['capabilities']):
 col=i//5; row=i%5; x=36+col*273; y=294+row*94; w=249
 txt(f'{i+1:02}',x,y,25,9.5,True,GREEN)
 ht=txt(cap['title'],x+28,y,w-28,12,True,limit=32)
 txt(cap['description'],x+28,y+ht+7,w-28,10,False,MUTED,limit=64)
txt('Kimlər üçün?',36,775,100,10,True,GREEN)
txt('Satınalma, maliyyə və əməliyyat bölmələri; korporativ satınalma komandaları.',139,775,420,10,False,MUTED)
c.showPage()

header(2,'Texniki əhatə və tətbiq şərtləri')
left=36; right=309; width=249
y=section('İstifadə və yerləşdirmə',left,136,width)
for title,body in [('İstifadəçi rolları',', '.join(d['roles'])+'.'),('İnterfeys və bələdçilər','Azərbaycan, rus və ingilis dilləri. Bölmələr üzrə video və interaktiv bələdçilər.'),('Lokal məlumatlar','AZN və valyuta məlumatları, ƏDV hesablamaları, VÖEN formatı.')]+[(o['title'],o['description']) for o in d['deployment']]:
 ht=txt(title,left,y,width,11,True); hb=txt(body,left,y+ht+5,width,10,False,MUTED); y+=ht+hb+19
y=section('Nəzarət və təhlükəsizlik',left,y+6,width)
for item in d['security']:
 txt('—',left,y,12,10,True,GREEN); ht=txt(item,left+17,y,width-17,10,False,MUTED); y+=ht+13

y2=section('İxrac və bağlantılar',right,136,width)
for o in d['integrations']:
 ht=txt(o['title'],right,y2,width,11,True); hb=txt(o['description'],right,y2+ht+5,width,10,False,MUTED); y2+=ht+hb+19
y2=section('Tətbiq zamanı nəzərə alınır',right,y2+5,width)
for item in d['caveats']:
 ht=txt(item,right,y2,width,9.8,False,MUTED); y2+=ht+12
bottom=max(y,y2)
if bottom>735: issues.append({'section':'page2 body','bottom':bottom,'limit':735})
box(36,746,W-72,52,MINT)
txt('Pilot başlanğıcı',49,756,130,11,True,FOREST)
txt('Bir kateqoriya, razılaşdırılmış rollar və bir satınalma dövrü. Nəticələrə əsasən tətbiq əhatəsini müəyyən edin.',189,756,355,10,False,FOREST,limit=40)
c.showPage();c.save()
md=['# '+d['title'],d['subtitle'],'',d['intro'],'','## Əsas imkanlar']
for cap in d['capabilities']:md+=['### '+cap['title'],cap['description'],'']
for key,title in [('deployment','Yerləşdirmə'),('integrations','İxrac və bağlantılar')]:
 md+=['## '+title]
 for o in d[key]:md+=['### '+o['title'],o['description'],'']
for key,title in [('security','Təhlükəsizlik'),('caveats','Tətbiq şərtləri')]:md+=['## '+title]+['- '+s for s in d[key]]+['']
md+=['## Pilot',d['pilot']]
(OUT/'Leadprocure_Data_Sheet_AZ.md').write_text('\n'.join(md))
doc=pymupdf.open(OUT/'Leadprocure_Data_Sheet_AZ.pdf')
for i,p in enumerate(doc):p.get_pixmap(matrix=pymupdf.Matrix(1.4,1.4)).save(OUT/f'datasheet-page-{i+1}.png')
(OUT/'qa-datasheet.json').write_text(json.dumps({'pages':len(doc),'issues':issues},ensure_ascii=False,indent=2))
print(json.dumps({'pages':len(doc),'issues':issues},ensure_ascii=False))
