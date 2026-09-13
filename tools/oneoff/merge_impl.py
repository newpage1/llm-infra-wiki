#!/usr/bin/env python3
"""从备份里取出若干节，合并成一个「具体实现」节。

各源节的 title 变成 ### 子标题，lead 变成首段。**全部先算好、再写盘。**
"""
import io, re, json

BACKUP = '.backup/analyses.b4-order.js'    # 可被调用方覆盖


def _sections_of(text, mid):
    """在 text 中取出模块 mid 的所有节（原始文本块）。"""
    i = text.index("id: '%s',\n      title:" % mid)
    # 模块结束
    n = re.search(r"\n    \{\n      (?:group: '[^']*',\n      )?id: '[a-z0-9-]+',", text[i:])
    end = i + n.start() if n else text.index("\n      ]\n    }", i)
    seg = text[i:end]
    out = {}
    for m in re.finditer(r"\n      \{\n        id: '([a-z-]+)',", seg):
        sid = m.group(1)
        nn = re.search(r"\n      \{\n        id: '[a-z-]+',", seg[m.end():])
        e = m.end() + nn.start() if nn else len(seg)
        out[sid] = seg[m.start():e]
    return out


def _field(block, name):
    m = re.search(r"\n        %s: `\n([\s\S]*?)\n\s*`\.trim\(\)" % name, block)
    return m.group(1) if m else None


def _lead(block):
    m = re.search(r"\n        lead:\n([\s\S]*?),\n        (?:html|puml|id|title):", block)
    if not m:
        return None
    raw = m.group(1).strip()
    parts = re.findall(r"'((?:[^'\\]|\\.)*)'", raw)
    return ''.join(parts) if parts else None


def build_impl(mid, sids, title='具体实现', backup=None):
    """把 sids 指定的节合并成一个节的 JS 文本。"""
    txt = io.open(backup or BACKUP, encoding='utf-8').read()
    secs = _sections_of(txt, mid)
    chunks = []
    for sid in sids:
        assert sid in secs, "%s / %s 不在备份里" % (mid, sid)
        b = secs[sid]
        t = re.search(r"title: '([^']*)'", b).group(1)
        html = _field(b, 'html') or ''
        lead = _lead(b)
        # 源节标题若是泛称，不重复当子标题（外层已叫「具体实现」）
        piece = "" if t in ('详细设计', '实现', '具体实现') else "### %s\n" % t
        if lead:
            piece += "\n" + lead.strip() + "\n"
        piece += "\n" + html.strip()
        chunks.append(piece)
    body = "\n\n".join(chunks)
    return ("      {\n        id: 'impl',\n        title: '%s',\n        html: `\n%s\n      `.trim()\n      }"
            % (title, body))
