#!/usr/bin/env python3
"""重写某个分析下某个模块的 sections——**分析域限定**。

防三类已踩过的坑：
  1. 跨分析同名模块被误改  → 用 sec.module_bounds_in 限定
  2. 漏掉 `sections: [`    → 显式补上并校验
  3. `body`/`tail` 各带 `]` → 剥掉 body 的尾 `]`
另加：块内裸反引号转 %%（反引号会终止模板字符串）
"""
import io, re, sys
sys.path.insert(0, '/Users/hexiaoying/workspace/llm-infra-wiki')
import sec

BT = chr(96)


def rewrite(analysis, mid, text, expect=None, must_contain=None):
    body = text.split('sections: [', 1)[1].rstrip('\n') if 'sections: [' in text else text.rstrip('\n')
    # 剥掉 body 自带的尾 `]`
    body = re.sub(r"\n\s*\]\s*$", "", body)
    body = body.lstrip('\n')
    body = '\n' + body           # 首节也要有前导换行，否则节数会少算一个
    # 块内裸反引号 → %%
    body = re.sub(BT + r'([^' + BT + r'\n]+)' + BT, r'%%\1%%', body)
    n = len(re.findall(r"\n      \{\n        id: '[a-z-]+',", body))
    if expect:
        assert n == expect, "新内容节数 %d ≠ %d" % (n, expect)
    s, a, b = sec.module_bounds_in(analysis, mid)
    seg = s[a:b]
    if must_contain:
        assert must_contain in seg, "内容校验失败：块内未见 %r（可能改错了模块）" % must_contain
    he = seg.index('      sections: [')
    head = seg[:he]
    tail = seg[seg.rindex('\n      ]'):]
    out = head + '      sections: [' + body + tail
    assert re.search(r"      sections: \[\n      \{", out), "sections: [ 后未接 {"
    assert len(re.findall(r"\n      \{\n        id: '[a-z-]+',", out)) == n, "写回后节数不对"
    assert out.count(BT) % 2 == 0, "反引号未配对"
    io.open(sec.P, 'w', encoding='utf-8').write(s[:a] + out + s[b:])
    print("  ✅ %s / %s → %d 节" % (analysis, mid, n))
