#!/usr/bin/env python3
"""把 Google Fonts 拉下来自托管，生成 assets/css/fonts.css。

为什么自托管：站点是中文内容 + 英文/代码标识符，字体只覆盖拉丁字符，
CJK 本来就落到系统字体。但 Google Fonts 在国内经常连不上或很慢，
首屏会出现明显的字体跳动（FOUT），内网/离线环境下更是直接降级。
这三套字体一共十几个 woff2，本地放着最省事。

用法：
    python3 tools/fetch_fonts.py            # 拉取并生成（需要联网，只跑一次）
    python3 tools/fetch_fonts.py --check    # 只检查现状，不联网

只保留 latin 与 latin-ext 两个子集——cyrillic / greek / vietnamese 用不到，
留着会让 CSS 和体积都白白变大。
"""
import io, os, re, sys, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
CSS_OUT = os.path.join(ROOT, 'assets', 'css', 'fonts.css')
FONT_DIR = os.path.join(ROOT, 'assets', 'fonts')

FAMILIES = [
    ('Saira', 'wght@400;500;600;700'),
    ('IBM+Plex+Sans', 'wght@400;500;600'),
    ('IBM+Plex+Mono', 'wght@400;500;600'),
]
KEEP = ('latin', 'latin-ext')          # 保留的子集
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')


def css_url():
    q = '&'.join('family=%s:%s' % (f, w) for f, w in FAMILIES)
    return 'https://fonts.googleapis.com/css2?%s&display=swap' % q


def fetch(url, binary=False):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
    return data if binary else data.decode('utf-8')


def split_blocks(css):
    """把 CSS 按 `/* subset */ @font-face {...}` 切成块。"""
    out = []
    for m in re.finditer(r'/\*\s*([a-z-]+)\s*\*/\s*(@font-face\s*\{[^}]*\})', css):
        out.append((m.group(1), m.group(2)))
    return out


def main():
    if '--check' in sys.argv:
        n = len(os.listdir(FONT_DIR)) if os.path.isdir(FONT_DIR) else 0
        print('assets/fonts/ 下有 %d 个文件；assets/css/fonts.css %s' %
              (n, '存在' if os.path.exists(CSS_OUT) else '不存在'))
        return 0

    os.makedirs(FONT_DIR, exist_ok=True)
    css = fetch(css_url())
    blocks = split_blocks(css)
    print('Google 给了 %d 个 @font-face 块' % len(blocks))

    kept, seen = [], set()
    total = 0
    for subset, block in blocks:
        if subset not in KEEP:
            continue
        m = re.search(r'url\((https://[^)]+\.woff2)\)', block)
        if not m:
            continue
        src = m.group(1)
        name = src.rsplit('/', 1)[-1]
        if name not in seen:
            seen.add(name)
            data = fetch(src, binary=True)
            io.open(os.path.join(FONT_DIR, name), 'wb').write(data)
            total += len(data)
            print('  ↓ %-14s %6d B' % (name[:14], len(data)))
        kept.append(block.replace(src, '../fonts/' + name))

    header = (
        '/* 由 tools/fetch_fonts.py 生成，不要手改。\n'
        ' * 来源：Google Fonts（Saira / IBM Plex Sans / IBM Plex Mono，SIL OFL 1.1）。\n'
        ' * 只保留 latin 与 latin-ext 两个子集——中文本来就落到系统字体。\n'
        ' * 重新拉取：python3 tools/fetch_fonts.py\n'
        ' */\n\n')
    io.open(CSS_OUT, 'w', encoding='utf-8').write(header + '\n'.join(kept) + '\n')
    print('\n共 %d 个 @font-face · %d 个 woff2 · %.0f KB'
          % (len(kept), len(seen), total / 1024))
    print('→ %s' % os.path.relpath(CSS_OUT, ROOT))
    return 0


if __name__ == '__main__':
    sys.exit(main())
