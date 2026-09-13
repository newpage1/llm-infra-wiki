#!/usr/bin/env python3
"""安全删除某个模块下的某一节。

**教训**：早先版本「先写盘、后断言」——断言失败时坏数据已经落盘。
本版本**先算好、先验证、通过后才写**。
"""
import io, re, sys
import sec


def plan(mid, sid):
    """返回要删除的 [start, end)，不修改文件。"""
    s = io.open(sec.P, encoding='utf-8').read()
    a, b = sec.module_bounds(s, mid)
    seg = s[a:b]
    m = re.search(r"\{\s*\n\s+id: '%s'," % re.escape(sid), seg)
    if not m:
        return None
    open_pos = seg.rfind('{', 0, m.end())
    sa = a + open_pos
    # 下一节的开头（兼容 "},      {" 同行形态）
    nb = re.search(r"\{\s*\n\s+id: '[a-z-]+',\n\s+title: '", s[m.end():b])
    assert nb, "节 %s 之后找不到下一节" % sid
    sb = m.end() + nb.start()
    return s, sa, sb


def apply(mid, sid):
    r = plan(mid, sid)
    if not r:
        print("  跳过 %s · %s：未找到" % (mid, sid)); return False
    s, sa, sb = r
    rm = s[sa:sb]
    # ── 验证（写盘之前）──────────────────────────
    t = re.search(r"title: '([^']*)'", rm)
    assert t, "删除块无 title"
    assert len(re.findall(r"id: '[a-z-]+',\n\s+title: '", rm)) == 1, \
        "删除块含多个节，拒绝执行"
    # ─────────────────────────────────────────
    io.open(sec.P, 'w', encoding='utf-8').write(s[:sa] + s[sb:])
    print("  ✅ %-16s 删除「%s」（%d 字节）" % (mid, t.group(1), len(rm)))
    return True


if __name__ == '__main__':
    print("用法：import sec_del; sec_del.apply('模块id','节id')")
