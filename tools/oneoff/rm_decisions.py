#!/usr/bin/env python3
"""删除各模块的「设计决策」节（代码分析不评审设计）。

安全措施：
  1. 模块边界用 sec.module_bounds 限定
  2. 兼容节开头的两种形态：`\\n      {` 与 `},      {`（同行）
  3. 删除前断言该块含「设计决策」，删除后断言节数恰好 -1
"""
import io, re, sys
import sec

P = sec.P
TARGETS = ['periodic-thread', 'mp-transport', 'mp-mq', 'gpu-connector', 'engine']


def count_sections(mid):
    s = io.open(P, encoding='utf-8').read()
    a, b = sec.module_bounds(s, mid)
    return len(re.findall(r"\n?\s*\{\n\s+id: '[a-z-]+',\n\s+title:", s[a:b]))


def delete(mid):
    s = io.open(P, encoding='utf-8').read()
    a, b = sec.module_bounds(s, mid)
    seg = s[a:b]
    # 找 decisions 节的开头（两种形态）
    m = re.search(r"(?:\n      \{|      \{\n)        id: 'decisions',", seg)
    if not m:
        print("  跳过 %s：无 decisions" % mid)
        return False
    # 定位 "[{]" 的起始：从 id 往前找最近的 {
    open_pos = seg.rfind('{', 0, m.end())
    sa = a + open_pos
    # 该节结束：下一个 6 空格 id: 节 或 数组结束
    # 该节结束：decisions 之后的下一个「节开头」。兼容 "\n      {" 与 "},      {" 两种形态。
    nb = re.search(r"\n?\s*\{\n\s+id: '[a-z-]+',\n\s+title: '", s[m.end():])
    assert nb, "decisions 之后找不到下一节"
    sb = m.end() + nb.start()
    # 把 decisions 的收尾 "      },\n" 补回来（作为前一节的收尾）
    sb = s.rindex("},", sa, sb) + len("},")
    rm = s[sa:sb]
    assert '设计决策' in rm, "删除块不含「设计决策」——拒绝执行"
    before = count_sections(mid)
    io.open(P, 'w', encoding='utf-8').write(s[:sa] + s[sb:])
    after = count_sections(mid)
    assert after == before - 1, "节数异常：%d → %d" % (before, after)
    print("  ✅ %-16s 删除 %d 字节，节数 %d → %d" % (mid, len(rm), before, after))
    return True


if __name__ == '__main__':
    for mid in (sys.argv[1:] or TARGETS):
        if not delete(mid):
            continue
        if not io.open(P, encoding='utf-8').read():
            pass
