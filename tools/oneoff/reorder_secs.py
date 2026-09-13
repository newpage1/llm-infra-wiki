# -*- coding: utf-8 -*-
"""按统一顺序重排模块的节，并把 flow/impl 改成「关键流程」「关键实现」。"""
import io, re, sys, sec

P = 'data/analyses.js'
WANT = ['position', 'structure', 'interface', 'flow', 'impl', 'data', 'files', 'deps']
RENAME = {'flow': '关键流程', 'impl': '关键实现'}
SPLIT = re.compile(r"(?=\n      \{\n        id: ')")


def _split(inner):
    """把 sections 数组内部分成 {id: block} 与顺序。"""
    blocks, order = {}, []
    for b in SPLIT.split(inner):
        m = re.match(r"\n      \{\n        id: '(\w+)'", b)
        if not m:
            continue
        b = b.strip('\n').rstrip()
        if b.endswith(','):
            b = b[:-1]
        blocks[m.group(1)] = b
        order.append(m.group(1))
    return blocks, order


def _join(blocks, order):
    out = ''
    for i, sid in enumerate(order):
        out += '\n' + blocks[sid] + (',' if i < len(order) - 1 else '')
    return out


def _rename_title(block, new_title):
    return re.sub(r"(\n        id: '\w+',\n        title: ')[^']*(')",
                  lambda m: m.group(1) + new_title + m.group(2), block, count=1)


def run(mid, analysis='lmcache', dry=False):
    s = io.open(P, encoding='utf-8').read()
    _, a, b = sec.module_bounds_in(analysis, mid)
    seg = s[a:b]
    m = re.search(r"(\n      sections: \[)([\s\S]*?)(\n      \]\n)", seg)
    if not m:
        return '%s：无 sections 数组' % mid
    inner = m.group(2)
    blocks, order = _split(inner)
    if sorted(order) != sorted(WANT):
        return '%s：节集合不符 %s' % (mid, ','.join(order))
    for sid, t in RENAME.items():
        if sid in blocks:
            blocks[sid] = _rename_title(blocks[sid], t)
    new_inner = _join(blocks, WANT)
    if new_inner == inner:
        return '%s：已是目标顺序' % mid
    seg2 = seg[:m.start(2)] + new_inner + seg[m.end(2):]
    if dry:
        return '%s：可重排 %s → %s' % (mid, ','.join(order), ','.join(WANT))
    io.open(P, 'w', encoding='utf-8').write(s[:a] + seg2 + s[b:])
    return '%s：%s → %s ✅' % (mid, ','.join(order), ','.join(WANT))


if __name__ == '__main__':
    targets = sys.argv[1:] or None
    if targets:
        for t in targets:
            print('  ' + run(t))
    else:
        import json
        # 找出所有 8 节标准模块
        for mid in re.findall(r"id: '([a-z0-9-]+)',\n        title:", ''):
            pass
