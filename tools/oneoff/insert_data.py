#!/usr/bin/env python3
"""把「关键数据结构」节插到「参与的流程」之后、「具体实现」之前。"""
import io, re, sys
sys.path.insert(0, '/Users/hexiaoying/workspace/llm-infra-wiki')
import do_module7 as M


def insert(mid, text):
    s, a, b = M.build(mid)
    seg = s[a:b]
    # 已存在就替换
    text = text.strip('\n').rstrip().rstrip(',')   # 剥尾逗号，否则 join 出 '},,'
    if re.search(r"\n      \{\n        id: 'data',", seg):
        m = re.search(r"\n      \{\n        id: 'data',", seg)
        n = re.search(r"\n      \{\n        id: '[a-z-]+',|\n      \]", seg[m.end():])
        e = m.end() + n.start() if n else len(seg)
        seg = seg[:m.start()] + "\n" + text.strip('\n') + ",\n" + seg[e:].lstrip('\n')
    else:
        m = re.search(r"\n      \{\n        id: 'impl',", seg)
        assert m, "%s 没有 impl 节" % mid
        seg = seg[:m.start()] + "\n" + text.strip('\n') + ",\n" + seg[m.start() + 1:]
    io.open(M.P, 'w', encoding='utf-8').write(s[:a] + seg + s[b:])
    print("  ✅ %s 关键数据结构已插入" % mid)


if __name__ == '__main__':
    for mid in sys.argv[1:]:
        insert(mid, io.open('/tmp/ds/%s.txt' % mid, encoding='utf-8').read())
