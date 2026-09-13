#!/usr/bin/env python3
"""模块限定的节替换工具。

**为什么需要它**：多次事故都源于用 `id: 'quality'` 这类**节 id 直接定位**——
而多个模块都有同名节，于是替换落到了文件里最先出现的那个模块上。

本工具强制要求「模块 id + 节 id」两个参数，替换前会打印命中位置供确认。
"""
import io, re, sys

P = 'data/analyses.js'


def module_bounds(s, mid):
    """返回模块的 [start, end)。同时支持 group 在前 / id 在前两种字段顺序。"""
    for pat in [r"\n    \{\n      id: '%s',\n", r"\n    \{\n      group: '[^']*',\n      id: '%s',\n"]:
        m = re.search(pat % re.escape(mid), s)
        if m:
            a = m.start()
            # 模块结束：下一个 "\n    {"（同级模块）或 "\n  ]"（数组结束）
            n = re.search(r"\n    \{|\n  \]", s[a + 10:])
            b = a + 10 + (n.start() if n else len(s) - a - 10)
            return a, b
    raise AssertionError("未定位模块 " + mid)


def replace_section(mid, sid, new_body):
    s = io.open(P, encoding='utf-8').read()
    a, b = module_bounds(s, mid)
    seg = s[a:b]
    m = re.search(r"\n      \{\n        id: '%s'," % re.escape(sid), seg)
    if not m:
        raise AssertionError("模块 %s 内未找到节 %s" % (mid, sid))
    sa = a + m.start()
    n = re.search(r"\n      \{\n        id: '[a-z-]+',|\n      \]", s[sa + 10:b])
    sb = sa + 10 + (n.start() if n else b - sa - 10)
    old = s[sa:sb]
    t = re.search(r"title: '([^']*)'", old)
    print("  替换 %s · %s → 「%s」（%d 字节）" % (mid, sid, t.group(1) if t else '?', len(old)))
    s = s[:sa] + new_body + s[sb:]
    io.open(P, 'w', encoding='utf-8').write(s)


if __name__ == '__main__':
    print("用法：import sec; sec.replace_section('模块id','节id', 新内容)")


def fix_in_section(mid, sid, pairs, dry=False):
    """在指定模块的指定节内做定点文本替换。**全部命中才写盘。**

    pairs: [(old, new), ...]
    """
    s = io.open(P, encoding='utf-8').read()
    a, b = module_bounds(s, mid)
    seg = s[a:b]
    m = re.search(r"\n      \{\n        id: '%s'," % re.escape(sid), seg)
    assert m, "模块 %s 内未找到节 %s" % (mid, sid)
    sa = a + m.start()
    n = re.search(r"\n      \{\n        id: '[a-z-]+',|\n      \]", s[sa + 10:b])
    sb = sa + 10 + (n.start() if n else b - sa - 10)
    body = s[sa:sb]
    hits = []
    for old, new in pairs:
        hits.append(body.count(old))
    if any(h != 1 for h in hits):
        print("  ⚠️ %s · %s 命中数 %s —— 未写盘" % (mid, sid, hits))
        return False
    for old, new in pairs:
        body = body.replace(old, new)
    if not dry:
        io.open(P, 'w', encoding='utf-8').write(s[:sa] + body + s[sb:])
    print("  ✅ %s · %s 替换 %d 处" % (mid, sid, len(pairs)))
    return True


def module_bounds_in(analysis_id, mid):
    """在指定分析内定位模块——**避免跨分析的同名 id 冲突**。

    踩过的坑：`storage-backend` 在 lmcache 与 mooncake-store 里都有，
    不加限定就会改到另一个。
    """
    s = io.open(P, encoding='utf-8').read()
    lo = s.index("  id: '%s'," % analysis_id)
    mods = s.index("  modules: [", lo)
    # 分析结束：下一个顶层分析定义 `\n{\n  id: '` 或文件末
    nxt = re.search(r"\n\{\n  id: '[a-z0-9-]+',", s[mods:])
    hi = mods + nxt.start() if nxt else len(s)
    for pat in [r"\n    \{\n      id: '%s',\n", r"\n    \{\n      group: '[^']*',\n      id: '%s',\n"]:
        m = re.search(pat % re.escape(mid), s[mods:hi])
        if m:
            a = mods + m.start()
            n = re.search(r"\n    \{|\n  \]", s[a + 10:])
            b = a + 10 + (n.start() if n else hi - a - 10)
            print("    [scoped] %s / %s @ %d" % (analysis_id, mid, a))
            return s, a, b
    raise AssertionError("分析 %s 内未找到模块 %s" % (analysis_id, mid))
