#!/usr/bin/env python3
"""把 data/*.js 里「代码块内的 markdown 标记」清掉。

代码块（~~~ 围栏）不经过行内渲染，写进去的 ** 与 %% 会原样显示。
而反引号更麻烦：它会在 JS 模板字符串里**提前终止字符串**，直接语法错误。

规则：
  围栏内 —— 去掉所有反引号；把 **X** 还原为 X
  围栏外 —— `X` / ``X`` 转成 %%X%%
  例外   —— **kwargs / **_kwargs 这类 Python 解包必须保留
"""
import io, re, sys, pathlib

BT = chr(96)
PY_UNPACK = {"kwargs", "args", "_kwargs", "_args", "self", "opts", "options"}


def fix(path):
    s = pathlib.Path(path).read_text(encoding='utf-8')
    lines = s.split('\n')
    out, infence, n_star, n_bt = [], False, 0, 0
    for l in lines:
        if l.strip().startswith('~~~'):
            infence = not infence
            out.append(l)
            continue
        if infence:
            if BT in l:
                n_bt += 1
                l = l.replace(BT, '')
            def strip_em(m):
                nonlocal n_star
                if m.group(1).strip() in PY_UNPACK:
                    return m.group(0)
                n_star += 1
                return m.group(1)
            l = re.sub(r'\*\*([^*]+)\*\*', strip_em, l)
            out.append(l)
        else:
            l = re.sub(BT + BT + r'([^' + BT + r']+)' + BT + BT, r'%%\1%%', l)
            if l.count(BT) >= 2 and l.count(BT) % 2 == 0:
                l = re.sub(BT + r'([^' + BT + r']+)' + BT, r'%%\1%%', l)
            out.append(l)
    if n_star or n_bt:
        pathlib.Path(path).write_text('\n'.join(out), encoding='utf-8')
    return n_star, n_bt


if __name__ == '__main__':
    files = sys.argv[1:] or ['data/analyses.js', 'data/flows.js']
    ts = tb = 0
    for f in files:
        if not pathlib.Path(f).exists():
            continue
        a, b = fix(f)
        if a or b:
            print(f"  {f}: 去掉 {a} 处 ** ，{b} 处行内反引号")
        ts += a; tb += b
    print(f"合计：** {ts} 处，反引号 {tb} 处" + ("  ✅" if not (ts or tb) else ""))
