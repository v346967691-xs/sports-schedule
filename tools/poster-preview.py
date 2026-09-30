# -*- coding: utf-8 -*-
"""
按 utils/poster.js 的坐标与字号，把用户底图 + 动态文字拼成分享卡预览。
坐标全部是 500x400 逻辑坐标 x2（底图为 1000x800）。
"""
from PIL import Image, ImageDraw, ImageFont
import os

SRC = r"C:\Users\Administrator\Documents\Codex\2026-09-30\x20\outputs"
OUT = r"D:\work\wbzone\mp-materials\poster-preview"
os.makedirs(OUT, exist_ok=True)

F_REG = r"C:\Windows\Fonts\msyh.ttc"
F_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
if not os.path.exists(F_BOLD):
    F_BOLD = F_REG


def font(size, bold=False):
    return ImageFont.truetype(F_BOLD if bold else F_REG, size)


def rgba(hex_color, alpha=255):
    h = hex_color.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), alpha)


def wrap(draw, text, max_width, fnt, max_lines):
    lines, cur = [], ''
    for ch in text:
        if draw.textlength(cur + ch, font=fnt) > max_width and cur:
            lines.append(cur)
            cur = ch
            if len(lines) == max_lines:
                break
        else:
            cur += ch
    if len(lines) < max_lines and cur:
        lines.append(cur)
    return lines


def text(draw, s, xy, size, color, anchor, bold=False, alpha=255):
    draw.text(xy, s, font=font(size, bold), fill=rgba(color, alpha), anchor=anchor)


# ---------- 比赛卡 ----------
img = Image.open(os.path.join(SRC, 'share-match.jpg')).convert('RGBA')
d = ImageDraw.Draw(img)
WHITE = '#ffffff'

text(d, '亚运会男足', (56, 80), 34, WHITE, 'lm', alpha=219)
text(d, '半决赛', (944, 80), 30, WHITE, 'rm', alpha=158)
text(d, '中国U23亚运队', (500, 280), 60, WHITE, 'mm', bold=True)
text(d, '1 - 2', (500, 436), 124, WHITE, 'mm', bold=True)
text(d, '韩国U23', (500, 592), 60, WHITE, 'mm', bold=True)
text(d, '9月30日 14:00', (56, 756), 32, WHITE, 'ls', alpha=184)
text(d, '已结束', (700, 756), 32, WHITE, 'rs', alpha=184)

img.convert('RGB').save(os.path.join(OUT, 'preview-match.jpg'), quality=92)
print('match ok')

# ---------- 日报卡 ----------
img = Image.open(os.path.join(SRC, 'share-brief.jpg')).convert('RGBA')
d = ImageDraw.Draw(img)

text(d, '9月30日', (500, 184), 44, '#8A93A6', 'mm')
text(d, '闪现晚报', (500, 336), 100, '#1f2430', 'mm', bold=True)
sub = '今夜看点：德玛西亚杯与亚运会电竞，三场值得留意的比赛'
f38 = font(38)
# 2026-09-30 用户定：换行后左对齐（块整体居中，块宽 800 → 左边缘 x=100）
for i, ln in enumerate(wrap(d, sub, 800, f38, 2)):
    text(d, ln, (100, 472 + i * 60), 38, '#5A6272', 'lm')
# 底部「晚报」徽标已按用户要求去掉

img.convert('RGB').save(os.path.join(OUT, 'preview-brief.jpg'), quality=92)
print('brief ok')
