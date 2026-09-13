#!/usr/bin/env python3
"""按「分析页 id」定位并改写，再原样回写（保持 2 空格缩进 + 2 空格前缀）。

为什么需要它：直接对 data/analyses.js 做文本替换时，
JSON 里的换行是**字面的 \\n 两个字符**，不是真换行——
用带真换行的 Python 字符串去匹配必然 0 命中。走 JSON 解析才可靠。
"""
import io, json, os, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
P = os.path.join(ROOT, 'data', 'analyses.js')


def bounds(s, aid):
    i = s.index('  {\n    "id": "%s",' % aid)
    nxt = None
    import re
    m = re.search(r'\n  \{\n    "id": "[a-z0-9-]+",', s[i + 10:])
    j = i + 10 + m.start() if m else s.rstrip().rfind('\n]')
    return i, j


def load(aid):
    s = io.open(P, encoding='utf-8').read()
    i, j = bounds(s, aid)
    return s, i, j, json.loads(s[i:j].rstrip().rstrip(','))


def save(s, i, j, obj):
    txt = json.dumps(obj, ensure_ascii=False, indent=2)
    txt = '\n'.join(('  ' + ln) if ln.strip() else ln for ln in txt.split('\n'))
    io.open(P, 'w', encoding='utf-8').write(s[:i] + txt + ',\n' + s[j:])


def patch(aid, path, pairs):
    """path: 形如 ('modules', 'topology', 'sections', 'flow')

    用法见文件末尾 __main__ 的示例。
    """
    s, i, j, obj = load(aid)
    node = obj
    for k in path:
        if isinstance(node, list):
            node = next(x for x in node if x.get('id') == k)
        else:
            node = node[k]
    n = 0
    for old, new in pairs:
        if old not in node['html']:
            print('⚠️ 未命中：%r' % old[:70])
            continue
        node['html'] = node['html'].replace(old, new)
        n += 1
        print('✅ %r' % old[:60])
    if n:
        save(s, i, j, obj)
    return n


if __name__ == '__main__':
    print(__doc__)
