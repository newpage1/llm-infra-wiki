#!/usr/bin/env python3
"""把 sglang 模块里被误写成「预渲染 HTML」的 `html` 字段转回 markdown。

为什么必须转：渲染器 `assets/js/markdown.js:31` 是 `let s = esc(raw)`——
**先把整段输入转义，再解析 markdown**。所以 `html` 字段里写 `<p>` / `<table>`
不会当 HTML 渲染，读者看到的是 `<p>`、`<table>` 这些**字面标签**。

这批字段是 agent 的生成脚本直接吐 HTML 造成的（6 个模块 73 个字段）。
本脚本做等价的 HTML → markdown 转换，并在转换后由 check_publish.js
跑真渲染器验收。

用法：
    python3 tools/oneoff/html_to_md.py            # 干跑
    python3 tools/oneoff/html_to_md.py --write
"""
import io, json, os, re, sys

D = '.work/sglang-analysis'
PROSE = ('html', 'lead')


def unescape(s):
    # 只解一层（生成器转义过一次）
    return (s.replace('&lt;', '<').replace('&gt;', '>')
             .replace('&quot;', '"').replace('&#39;', "'").replace('&nbsp;', ' ')
             .replace('&amp;', '&'))


def table_to_md(tbl):
    rows = []
    for tr in re.findall(r'<tr[^>]*>(.*?)</tr>', tbl, re.S):
        cells = [re.sub(r'\s+', ' ', unescape(re.sub(r'<[^>]+>', '', c))).strip()
                 for c in re.findall(r'<t[hd][^>]*>(.*?)</t[hd]>', tr, re.S)]
        if cells:
            rows.append(cells)
    if not rows:
        return ''
    w = max(len(r) for r in rows)
    rows = [r + [''] * (w - len(r)) for r in rows]
    out = ['| ' + ' | '.join(rows[0]) + ' |',
           '|' + '|'.join(['---'] * w) + '|']
    out += ['| ' + ' | '.join(r) + ' |' for r in rows[1:]]
    return '\n'.join(out)


def inline_html(s):
    s = re.sub(r'<code[^>]*>(.*?)</code>', lambda m: '%%%s%%' % unescape(m.group(1)).strip(), s, flags=re.S)
    s = re.sub(r'<strong[^>]*>(.*?)</strong>', lambda m: '**%s**' % unescape(m.group(1)).strip(), s, flags=re.S)
    s = re.sub(r'<em[^>]*>(.*?)</em>', lambda m: '*%s*' % unescape(m.group(1)).strip(), s, flags=re.S)
    s = re.sub(r'<br\s*/?>', '\n', s)
    s = re.sub(r'<[^>]+>', '', s)
    return unescape(s).strip()


def html_to_md(h):
    s = h
    # 表格
    s = re.sub(r'<table[^>]*>([\s\S]*?)</table>', lambda m: '\n' + table_to_md(m.group(1)) + '\n', s)
    # 标题
    for lvl in (2, 3, 4, 5, 6):
        s = re.sub(r'<h%d[^>]*>(.*?)</h%d>' % (lvl, lvl),
                   lambda m, lvl=lvl: '\n' + '#' * lvl + ' ' + inline_html(m.group(1)) + '\n', s, flags=re.S)
    # 列表
    def ul(m):
        items = [inline_html(x) for x in re.findall(r'<li[^>]*>(.*?)</li>', m.group(1), re.S)]
        return '\n' + '\n'.join('- ' + x for x in items) + '\n'
    s = re.sub(r'<ul[^>]*>([\s\S]*?)</ul>', ul, s)
    def ol(m):
        items = [inline_html(x) for x in re.findall(r'<li[^>]*>(.*?)</li>', m.group(1), re.S)]
        return '\n' + '\n'.join('%d. %s' % (i + 1, x) for i, x in enumerate(items)) + '\n'
    s = re.sub(r'<ol[^>]*>([\s\S]*?)</ol>', ol, s)
    # 段落
    s = re.sub(r'<p[^>]*>(.*?)</p>', lambda m: '\n' + inline_html(m.group(1)) + '\n', s, flags=re.S)
    # 其余标签去掉（含 blockquote / div / span）
    s = re.sub(r'</?(blockquote|div|span|section|figure|figcaption)[^>]*>', '', s)
    s = inline_html(s)
    # 压掉三个以上连续空行
    s = re.sub(r'\n{3,}', '\n\n', s)
    return s.strip()


def fix_svg_in_html(node):
    """`html` 以 <svg> 开头：把 SVG 移到 svg 字段（figCanvas 才走图号与缩放），
    剩下的正文继续按 markdown 处理。"""
    n = 0
    if isinstance(node, dict):
        h = node.get('html')
        if isinstance(h, str) and h.lstrip().startswith('<svg'):
            m = re.match(r'\s*(<svg[\s\S]*?</svg>)\s*([\s\S]*)', h)
            if m:
                if not node.get('svg'):
                    node['svg'] = m.group(1)
                rest = m.group(2).strip()
                if rest:
                    node['html'] = rest
                else:
                    node.pop('html', None)
                n += 1
        for v in node.values():
            n += fix_svg_in_html(v)
    elif isinstance(node, list):
        for v in node:
            n += fix_svg_in_html(v)
    return n


def fix_html_fields(node):
    n = 0
    if isinstance(node, dict):
        for k in PROSE:
            v = node.get(k)
            if isinstance(v, list):                      # 数组 → 拼成字符串
                v = '\n\n'.join(str(x) for x in v)
                node[k] = v
                n += 1
            if isinstance(v, str) and re.search(r'<(p|h[1-6]|table|ul|ol|div)\b', v, re.I):
                node[k] = html_to_md(v)
                n += 1
        for v in node.values():
            n += fix_html_fields(v)
    elif isinstance(node, list):
        for v in node:
            n += fix_html_fields(v)
    return n


def main():
    write = '--write' in sys.argv
    svg_n = md_n = 0
    for fn in sorted(os.listdir(D)):
        if not (fn.startswith('mod-') and fn.endswith('.json')):
            continue
        p = os.path.join(D, fn)
        m = json.load(io.open(p, encoding='utf-8'))
        s = fix_svg_in_html(m.get('sections') or [])
        h = fix_html_fields(m.get('sections') or [])
        if s or h:
            svg_n += s; md_n += h
            print('  %-42s SVG 归位 %d · HTML→md %d' % (fn, s, h))
            if write:
                io.open(p, 'w', encoding='utf-8').write(json.dumps(m, ensure_ascii=False, indent=2))
    print('\n合计：SVG 归位 %d 处，HTML→markdown %d 个字段' % (svg_n, md_n))
    if not write:
        print('（干跑。加 --write 写盘）')


if __name__ == '__main__':
    main()
