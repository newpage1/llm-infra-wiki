#!/usr/bin/env python3
"""给已有分析页的模块补站内互链：把散文里的 `<模块 id> 模块` 变成
`[<id>](#/a/<页>/<id>) 模块`。

为什么：lmcache 页有 391 处站内链接（11.8/模块），而 vllm 只有 5 处（0.3/模块）、
vllm-ascend 1 处、mooncake 21 处。同一个 wiki 里导航密度差两个数量级，
读者在 vllm 页读到「细节归 attention 模块」时没有可点的地方。

只动 `lead` / `html` / `notCovered` 三个字段——`title`/`subtitle`/`files` 是标签或
纯文本，加链接要么不渲染要么破坏版面。SVG 整段跳过。
"""
import io, json, re, sys

SRC = 'data/analyses.js'
PAGES = ['mooncake', 'vllm', 'vllm-ascend']


def find_array(text, start, key):
    i = text.index('"%s": [' % key, start)
    j = text.index('[', i)
    depth, k, instr, esc = 0, j, False, False
    while k < len(text):
        c = text[k]
        if instr:
            if esc: esc = False
            elif c == '\\': esc = True
            elif c == '"': instr = False
        else:
            if c == '"': instr = True
            elif c in '[{': depth += 1
            elif c in ']}':
                depth -= 1
                if depth == 0: return j, k
        k += 1
    raise ValueError('方括号不配平')


def reserialize(lst, shift=4):
    s = json.dumps(lst, ensure_ascii=False, indent=2)
    s = '\n'.join((' ' * shift + l if l.strip() else l) for l in s.split('\n'))
    return s[shift:]


def link(s, page, ordered):
    out = s
    for mid in ordered:
        pat = re.compile(r'(?<![\w\-/])' + re.escape(mid) + r'(\s*模块)')
        out = pat.sub(lambda m, mid=mid: '[%s](#/a/%s/%s)%s' % (mid, page, mid, m.group(1)), out)
    return out


def walk(node, page, ordered):
    n = 0
    if isinstance(node, dict):
        for k, v in list(node.items()):
            if isinstance(v, str):
                if k not in ('lead', 'html'):
                    continue
                if v.lstrip().startswith('<svg'):
                    continue
                nv = link(v, page, ordered)
                if nv != v: node[k] = nv; n += 1
            else:
                n += walk(v, page, ordered)
    elif isinstance(node, list):
        n += sum(walk(v, page, ordered) for v in node)
    return n


def main():
    write = '--write' in sys.argv
    text = io.open(SRC, encoding='utf-8').read()
    report = []
    for page in PAGES:
        start = text.index('"id": "%s",' % page)
        a, b = find_array(text, start, 'modules')
        mods = json.loads(text[a:b + 1])
        ids = [m['id'] for m in mods]
        ordered = sorted(ids, key=len, reverse=True)

        n = 0
        for m in mods:
            n += walk(m.get('sections') or [], page, ordered)
            nc = m.get('notCovered')
            if isinstance(nc, list):
                for i, x in enumerate(nc):
                    if isinstance(x, str):
                        nx = link(x, page, ordered)
                        if nx != x: nc[i] = nx; n += 1

        links = sum(len(re.findall(r'#/a/%s/[\w-]+' % page, json.dumps(mods, ensure_ascii=False))) for _ in [0])
        report.append('  %-16s %2d 模块  改 %2d 个字段  页内链接 %d 处' % (page, len(ids), n, links))
        if n:
            text = text[:a] + reserialize(mods) + text[b + 1:]

    print('\n'.join(report))
    if not write:
        print('\n（干跑。加 --write 写盘）')
        return 0
    io.open(SRC, 'w', encoding='utf-8').write(text)
    print('\n✅ 已写入 %s' % SRC)
    return 0


if __name__ == '__main__':
    sys.exit(main())
