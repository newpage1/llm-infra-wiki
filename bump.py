#!/usr/bin/env python3
"""统一递增 index.html 里所有静态资源的 ?v=N。

为什么单独做成脚本：之前手工用 sed 's/?v=41/?v=42/' 递增，
一旦中间跳号（例如从 55 直接写 57），之后每次 sed 都**静默不匹配**，
版本号再也不动——而 sed 不报错，看起来一切正常，
结果是浏览器一直用缓存的旧文件。
"""
import re, sys, pathlib

p = pathlib.Path(__file__).with_name('index.html')
s = p.read_text(encoding='utf-8')
vs = set(re.findall(r'\?v=(\d+)', s))
if len(vs) != 1:
    print(f"❌ index.html 里的 ?v= 取值不一致: {sorted(vs)}", file=sys.stderr)
    sys.exit(1)
cur = int(vs.pop())
nxt = cur + 1
s, n = re.subn(r'\?v=%d\b' % cur, f'?v={nxt}', s)
if n == 0 or f'?v={cur}' in s:
    print(f"❌ 替换失败（匹配 {n} 处，仍有残留）", file=sys.stderr)
    sys.exit(1)
p.write_text(s, encoding='utf-8')
print(f"?v={cur} → ?v={nxt}（{n} 个资源）")
