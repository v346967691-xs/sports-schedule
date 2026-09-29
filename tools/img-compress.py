# 热点图压缩：把 AI 生成的 PNG 压成小程序可用的规格
#
# 为什么必须做：AI 出图是 1024x1536 的 PNG，实测 2.2 MB。
# 小程序 picture 组件加载这种单图会很慢，且占用户流量。
# 目标：宽度 750px（对应 750rpx @2x 屏刚好满宽）、JPEG、单张 < 200 KB。
#
# 运行需要隔离环境的 Pillow：
#   C:/Users/Administrator/.workbuddy/binaries/python/envs/default/Scripts/python.exe tools/img-compress.py <输入> [输出]
#
# ⚠️ 不要用系统 python 跑 —— 按项目约定，第三方包装在隔离 venv 里。

import sys
import os
from PIL import Image

TARGET_W = 750
TARGET_MAX_KB = 200


def compress(src, dst=None, target_w=TARGET_W, max_kb=TARGET_MAX_KB):
    im = Image.open(src)
    if im.mode in ('RGBA', 'LA', 'P'):
        bg = Image.new('RGB', im.size, (255, 255, 255))
        im = im.convert('RGBA') if im.mode != 'RGBA' else im
        bg.paste(im, mask=im.split()[-1] if im.mode == 'RGBA' else None)
        im = bg
    else:
        im = im.convert('RGB')

    w, h = im.size
    new_h = round(h * target_w / w)
    im = im.resize((target_w, new_h), Image.LANCZOS)

    if dst is None:
        base = os.path.splitext(src)[0]
        dst = base + '.jpg'

    # 从高质量往下探，找到第一个落在体积上限内的档位
    for q in (88, 84, 80, 76, 72, 68, 62, 56, 50):
        im.save(dst, 'JPEG', quality=q, optimize=True, progressive=True)
        kb = os.path.getsize(dst) / 1024
        if kb <= max_kb:
            return dst, im.size, kb, q

    return dst, im.size, os.path.getsize(dst) / 1024, q


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('用法：python tools/img-compress.py <输入图片> [输出路径]')
        sys.exit(1)
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else None
    path, size, kb, q = compress(src, dst)
    print('输入：%s  (%.0f KB)' % (src, os.path.getsize(src) / 1024))
    print('输出：%s' % path)
    print('尺寸：%dx%d　体积：%.0f KB　质量档：%d' % (size[0], size[1], kb, q))
