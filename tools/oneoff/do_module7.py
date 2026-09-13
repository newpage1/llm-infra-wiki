#!/usr/bin/env python3
"""把一个模块的 sections 重建为指定的节列表。

**关键**：模块块以 `    },` 收尾；本工具显式补上，避免丢收尾（踩过两次）。
全部验证通过后才写盘。
"""
import io, re
import sec

P = sec.P


def build(mid, head_extra_new=None):
    s = io.open(P, encoding='utf-8').read()
    a, b = sec.module_bounds(s, mid)
    return s, a, b


def rewrite(mid, new_sections, dry=False):
    """new_sections: 已拼好的节文本列表（不含模块头与收尾）。"""
    s, a, b = build(mid)
    seg = s[a:b]
    he = seg.index('      sections: [')
    head = seg[:he]
    # **保留原尾部**（`      ]` + 模块收尾 `    },` 或 `    }`）——
    # 自己拼尾部会丢逗号，已踩过两次。
    tail_at = seg.rindex('\n      ]')
    tail = seg[tail_at:]
    # 统一剥掉每节尾部的逗号——留着会在 join 后变成 ",,"，产生数组空位
    norm = [x.rstrip().rstrip(',').rstrip() for x in new_sections]
    body = "      sections: [\n" + ",\n".join(norm) + tail
    new = head + body
    # 验证：节数、模块头完整
    n = len(re.findall(r"\n      \{\n        id: '[a-z-]+',", new))
    assert n == len(new_sections), "节数不符 %d vs %d" % (n, len(new_sections))
    assert re.search(r"\n      id: '%s'," % mid, new), "模块头丢失"
    assert re.search(r"\n      \]\n    \},?\s*$", new), "收尾格式异常"
    assert ',,' not in new and '[,' not in new, "存在空数组位（连续逗号）"
    if not dry:
        io.open(P, 'w', encoding='utf-8').write(s[:a] + new + s[b:])
    print("  ✅ %s → %d 节" % (mid, n))
    return new


def grab(mid, sid):
    """取出某模块的某一节文本（含开头的 {）。"""
    s, a, b = build(mid)
    seg = s[a:b]
    m = re.search(r"\n      \{\n        id: '%s'," % re.escape(sid), seg)
    assert m, "%s / %s" % (mid, sid)
    n = re.search(r"\n      \{\n        id: '[a-z-]+',|\n      \]", seg[m.end():])
    e = m.end() + n.start() if n else len(seg)
    blk = seg[m.start():e].strip('\n')
    return blk[:-1].rstrip() if blk.endswith(',') else blk   # 去掉尾部逗号，避免 join 出空位


def retitle(block, newid, newtitle):
    b = re.sub(r"id: '[a-z-]+',", "id: '%s'," % newid, block, count=1)
    return re.sub(r"title: '[^']*',", "title: '%s'," % newtitle, b, count=1)


def set_notcovered(mid, items):
    """把模块的 notCovered 写成数组字段（替换已有的）。"""
    s, a, b = build(mid)
    seg = s[a:b]
    # 删掉旧的
    seg = re.sub(r"\n      notCovered: \[[\s\S]*?\n      \],", "", seg, count=1)
    lines = "".join("          %s,\n" % __import__('json').dumps(x, ensure_ascii=False) for x in items)
    field = "\n      notCovered: [\n" + lines + "      ],"
    # 插在 lead 之后（lead 以 "',\n" 或 "'\n" 结尾）
    m = re.search(r"\n      lead:\n(?:.*\n)*?.*?(?:',|')\n", seg)
    assert m, "未找到 lead 字段"
    seg = seg[:m.end()] + field + "\n" + seg[m.end():]
    io.open(P, 'w', encoding='utf-8').write(s[:a] + seg + s[b:])
    print("  ✅ %s notCovered ← %d 条" % (mid, len(items)))


def grab_any(mid, *sids):
    """按顺序尝试多个 id，返回第一个存在的节。"""
    s, a, b = build(mid)
    seg = s[a:b]
    for sid in sids:
        m = re.search(r"\n      \{\n        id: '%s'," % re.escape(sid), seg)
        if m:
            n = re.search(r"\n      \{\n        id: '[a-z-]+',|\n      \]", seg[m.end():])
            e = m.end() + n.start() if n else len(seg)
            blk = seg[m.start():e].strip('\n')
            return blk[:-1].rstrip() if blk.endswith(',') else blk
    raise AssertionError("%s: 这些 id 都不存在 %s" % (mid, sids))


def ids_of(mid):
    s, a, b = build(mid)
    return re.findall(r"\n      \{\n        id: '([a-z-]+)',", s[a:b])
