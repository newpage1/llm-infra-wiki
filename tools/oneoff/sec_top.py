#!/usr/bin/env python3
"""组件级（顶层）节的替换工具——在 `id: '<analysis>'` 与 `modules: [` 之间定位。

与 sec.py 同理：**先验证、后写盘**，避免坏数据落盘。
"""
import io, re
import sec

P = sec.P


def bounds(analysis_id, sid):
    s = io.open(P, encoding='utf-8').read()
    lo = s.index("  id: '%s'," % analysis_id)
    hi = s.index("  modules: [", lo)
    m = re.search(r"\n  \{\n    id: '%s'," % re.escape(sid), s[lo:hi])
    if not m:
        return None
    sa = lo + m.start() + 1
    n = re.search(r"\n  \{\n    id: '[a-z-]+',|\n  \],", s[sa + 10:hi])
    sb = sa + 10 + (n.start() if n else hi - sa - 10)
    return s, sa, sb, hi


def replace(analysis_id, sid, new_body):
    r = bounds(analysis_id, sid)
    assert r, "未找到 %s · %s" % (analysis_id, sid)
    s, sa, sb, hi = r
    old = s[sa:sb]
    mods = len(re.findall(r"\n    id: '[a-z-]+',\n      (?:group|title):", s[hi:hi + 200000]))
    assert len(re.findall(r"\n    id: '[a-z-]+',\n      (?:group|title):", old)) == 0, \
        "被替换块含模块定义，拒绝执行"
    io.open(P, 'w', encoding='utf-8').write(s[:sa] + new_body + s[sb:])
    print("  ✅ 替换 %s · %s（%d → %d 字节）" % (analysis_id, sid, len(old), len(new_body)))
    return True


if __name__ == '__main__':
    print("用法：import sec_top; sec_top.replace('lmcache','quality', 新内容)")

def delete(analysis_id, sid):
    """删除组件级的一个节。**先验证、后写盘。**"""
    r = bounds(analysis_id, sid)
    assert r, "未找到 %s · %s" % (analysis_id, sid)
    s, sa, sb, hi = r
    rm = s[sa:sb]
    t = re.search(r"title: '([^']*)'", rm)
    assert t, "删除块无 title"
    assert len(re.findall(r"\n  \{\n    id: '[a-z-]+',", rm)) == 0, "删除块含多个节，拒绝"
    io.open(P, 'w', encoding='utf-8').write(s[:sa] + s[sb:])
    print("  ✅ 删除 %s · %s（「%s」，%d 字节）" % (analysis_id, sid, t.group(1), len(rm)))
    return True
