#!/usr/bin/env python3
"""检查数据文件里手绘 SVG 的文字重叠。

手写 SVG 时用绝对坐标定位文本，很容易让同一行的两段文字压在一起
（曾出现「层标签」与「标题」重叠）。这里按估算宽度做一次机械检查。

宽度估算：CJK 记 2 个单位，其余记 1，乘以字号 × 0.55。
这只是估算，用于发现**明显重叠**，不能替代肉眼确认。
"""
import re, sys, pathlib

FILES = ['data/analyses.js', 'data/catalog.js',
         'data/details.js', 'data/details-ascend.js', 'data/details-nvidia.js', 'data/details-outline.js']

# 这里**不查** diagrams/ 与 flows/ 下的独立 SVG：
#   · diagrams/*.svg 是 PlantUML 的输出，布局是它自己算的，没有手工坐标可压；
#   · flows/ 下的图按新口径也是 PlantUML 产物，或是从别处搬来的自带 <style> 的图
#     （那种图有自己的字体栈，下面的字号表是按站内 CSS 类名校准的，认不出会虚报宽度）。
# 也就是说：这个脚本只管**依赖站内样式表的手绘 SVG**。

def units(t):
    return sum(2 if ord(c) > 0x2e80 else 1 for c in t)


# 字号要从 CSS 里认，不能一律按 13px 估。
# 下面两个表抄自 assets/css/style.css 的 `.diagram .t-*` 与 `.topo-svg .t-*`。
# 之前一律按 13px 算，而图里最常用的 t-mono 实际是 10.5px——虚报宽度约 24%，
# 会把本来不压字的标签判成重叠。认不出的 class 仍退回 13.0（偏保守）。
CLASS_FS = {
    'diagram': {'t-title': 17.0, 't-title-sm': 13.5, 't-sub': 12.0, 't-mono': 10.5,
                't-mono-c': 11.0, 't-band': 10.0, 't-chip': 11.0},
    'topo-svg': {'t-title': 17.0, 't-sub': 12.5, 't-mono': 10.5, 't-mono-c': 11.5,
                 't-kv': 14.0, 't-chip': 11.0, 't-cell': 13.0},
}
DEFAULT_FS = 13.0


def font_size(attrs, scope):
    m = re.search(r'font-size:([0-9.]+)px', attrs)
    if m:
        return float(m.group(1))
    cm = re.search(r'class="([^"]*)"', attrs)
    if cm:
        for cls in cm.group(1).split():
            for sc in (scope, 'diagram'):
                if cls in CLASS_FS[sc]:
                    return CLASS_FS[sc][cls]
    return DEFAULT_FS


def span(x, fs, t, anchor):
    w = units(t) * fs * 0.55
    return (x - w / 2, x + w / 2) if anchor == 'middle' else (x, x + w)


def check(path):
    s = pathlib.Path(path).read_text(encoding='utf-8')
    issues = 0
    for sm in re.finditer(r'<svg\b[^>]*>(.*?)</svg>', s, re.S):
        svg = sm.group(1)
        scope = 'topo-svg' if 'topo-svg' in s[sm.start():sm.start() + 200] else 'diagram'
        line0 = s[:sm.start()].count('\n') + 1
        items = []
        for m in re.finditer(r'<text ([^>]*)>(.*?)</text>', svg, re.S):
            a, txt = m.group(1), re.sub('<[^>]+>', '', m.group(2)).strip()
            gx = re.search(r'\bx="(-?[0-9.]+)"', a); gy = re.search(r'\by="(-?[0-9.]+)"', a)
            if not gx or not gy or not txt: continue
            fs = font_size(a, scope)
            items.append((float(gx.group(1)), float(gy.group(1)), fs, txt,
                          'middle' if 'text-anchor="middle"' in a else 'start'))
        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                x1, y1, f1, t1, a1 = items[i]
                x2, y2, f2, t2, a2 = items[j]
                if abs(y1 - y2) > 6: continue
                r1, r2 = span(x1, f1, t1, a1), span(x2, f2, t2, a2)
                if r1[0] < r2[1] - 2 and r2[0] < r1[1] - 2:
                    issues += 1
                    print(f"  ⚠️  {path}:{line0}  y={y1:.0f}  「{t1}」×「{t2}」")
    return issues

# ── 附加检查：SVG 里不该出现 markdown 标记 ──
# SVG 不渲染 markdown，写进去的 **、%%、~~~ 会原样显示成字符。
# 用 <tspan font-weight="600"> 代替 **，用纯文本代替 %%。
# 这些字段在渲染时**不走 markdown**（有的经 esc()、有的是原样传），
# 所以里面写 ** 会当字面星号显示出来。本项目犯过一次（modulesLead）。
RAW_FIELDS = ['files:', 'subtitle:', 'title:', 'h3:']


def check_raw_fields(path):
    s = pathlib.Path(path).read_text(encoding='utf-8')
    n = 0
    for m in re.finditer(r"^\s*(files|subtitle|title):\s*'([^']*)'", s, re.M):
        if '**' in m.group(2) or '%%' in m.group(2):
            n += 1
            print(f"  ⚠️  {path}:{s[:m.start()].count(chr(10))+1}  {m.group(1)} 里的 markdown 不会渲染：{m.group(2)[:50]}")
    return n


def check_markdown(path):
    s = pathlib.Path(path).read_text(encoding='utf-8')
    n = 0
    for sm in re.finditer(r'<svg\b[^>]*>(.*?)</svg>', s, re.S):
        line0 = s[:sm.start()].count('\n') + 1
        for m in re.finditer(r'>([^<>]*(\*\*|%%|~~~)[^<>]*)<', sm.group(1)):
            if m.group(1).strip():
                n += 1
                print(f"  ⚠️  {path}:{line0}  SVG 里有 markdown 标记：{m.group(1).strip()[:60]}")
    return n


if __name__ == '__main__':
    # 带参数时只查这些文件——**草拟阶段必须能查 /tmp 里的图**，
    # 否则作者会以为查过了（本脚本曾因此漏掉两张图里的字面 ** ）。
    files = sys.argv[1:] or FILES
    total = sum(check(f) for f in files if pathlib.Path(f).exists())
    total += sum(check_markdown(f) for f in files if pathlib.Path(f).exists())
    total += sum(check_raw_fields(f) for f in files if pathlib.Path(f).exists())
    missing = [f for f in files if not pathlib.Path(f).exists()]
    for f in missing:
        print(f"  ⚠️  文件不存在，没查：{f}")
    print(f"\nSVG 问题：{total} 处" + ("  ✅" if total == 0 else "  ← 需修"))
    sys.exit(1 if total or missing else 0)
