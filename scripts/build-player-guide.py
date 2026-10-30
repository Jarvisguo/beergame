"""Build the player PDF from docs/player-guide.md (documentation tool only).

Requires reportlab. On another OS, pass a CJK TrueType font with --font.
"""
from pathlib import Path
import argparse
import html
import re

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--font', default='/System/Library/Fonts/Supplemental/Arial Unicode.ttf')
parser.add_argument('--output', type=Path, default=ROOT / 'output/pdf/啤酒游戏玩家指南.pdf')
args = parser.parse_args()
pdfmetrics.registerFont(TTFont('GuideCJK', args.font))
pdfmetrics.registerFontFamily('GuideCJK', normal='GuideCJK', bold='GuideCJK', italic='GuideCJK', boldItalic='GuideCJK')

NAVY = colors.HexColor('#173b50')
MUTED = colors.HexColor('#526572')
WIDTH = A4[0] - 84
styles = {
    'body': ParagraphStyle('body', fontName='GuideCJK', fontSize=10, leading=15, textColor=NAVY,
                           wordWrap='CJK', spaceAfter=5, alignment=TA_LEFT),
    'title': ParagraphStyle('title', fontName='GuideCJK', fontSize=23, leading=31, textColor=NAVY, spaceAfter=11),
    'section': ParagraphStyle('section', fontName='GuideCJK', fontSize=12.2, leading=19, textColor=NAVY,
                              spaceBefore=8, spaceAfter=6, keepWithNext=True),
    'cell': ParagraphStyle('cell', fontName='GuideCJK', fontSize=9.5, leading=14.2, textColor=NAVY, wordWrap='CJK'),
}

def markup(text):
    escaped = html.escape(text)
    escaped = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', escaped)
    escaped = escaped.replace("https://beergame.zeabur.app/", '<link href="https://beergame.zeabur.app/" color="#165d96">https://beergame.zeabur.app/</link>')
    return escaped

def paragraph(text, style='body'):
    return Paragraph(markup(text), styles[style])

def table(lines):
    rows = [[part.strip() for part in line.strip().strip('|').split('|')] for line in lines]
    rows = [row for row in rows if not all(re.fullmatch(r':?-+:?', cell) for cell in row)]
    widths = [WIDTH * 0.30, WIDTH * 0.70] if len(rows[0]) == 2 else [WIDTH / 3] * 3
    obj = Table([[paragraph(cell, 'cell') for cell in row] for row in rows], colWidths=widths, repeatRows=1)
    obj.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#dfeaf0')),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.HexColor('#f5f8fa'), colors.white]),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 9), ('RIGHTPADDING', (0, 0), (-1, -1), 9),
        ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('LINEBELOW', (0, 0), (-1, 0), 0.7, colors.HexColor('#adc2ce')),
    ]))
    return obj

def decoration(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(NAVY)
    canvas.rect(42, A4[1] - 35, 26, 3, fill=1, stroke=0)
    canvas.setFont('GuideCJK', 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(77, A4[1] - 35, 'PLAYER GUIDE / 2026.10')
    canvas.setStrokeColor(colors.HexColor('#cbd9e1'))
    canvas.line(42, 36, A4[0] - 42, 36)
    canvas.drawString(42, 22, '啤酒分销游戏 | 玩家指南')
    canvas.drawRightString(A4[0] - 42, 22, str(doc.page))
    canvas.restoreState()

lines = (ROOT / 'docs/player-guide.md').read_text().splitlines()
story = []
index = 0
while index < len(lines):
    line = lines[index].strip()
    if not line:
        index += 1
        continue
    if line == '<!-- pagebreak -->':
        story.append(PageBreak())
    elif line.startswith('|'):
        block = []
        while index < len(lines) and lines[index].strip().startswith('|'):
            block.append(lines[index]); index += 1
        story.extend([table(block), Spacer(1, 7)])
        continue
    elif line.startswith('## '):
        story.append(paragraph(line[3:], 'section'))
    elif line.startswith('# '):
        story.append(paragraph(line[2:], 'title'))
    else:
        story.append(paragraph(line))
    index += 1

args.output.parent.mkdir(parents=True, exist_ok=True)
doc = SimpleDocTemplate(str(args.output), pagesize=A4, rightMargin=42, leftMargin=42,
                        topMargin=52, bottomMargin=48, title='啤酒游戏玩家指南', author='Beer Distribution Game',
                        subject='玩家操作、提前期、断线恢复与牛鞭效应指标')
doc.build(story, onFirstPage=decoration, onLaterPages=decoration)
print(args.output)
