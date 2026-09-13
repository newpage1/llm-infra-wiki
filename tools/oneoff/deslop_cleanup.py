#!/usr/bin/env python3
"""合并前的最后清理：把非正文散文字段（h3 / caption / group / svg）里的 AI 腔也清掉。

为什么单独一步：第一轮的替换只覆盖 lead/html/summary/modulesLead/subtitle/title，
漏了 h3（189 个）、caption（40）、group（33）、以及 svg 里的图内标签。
其中 h3 是 vllm-ascend 的代理发现的——「补丁接缝」这类小标题一直没被处理。

svc 里只做**删除**（真正的 / 其实 / 值得注意），删完文字更短，
不会造成 lint_svg 报的文字重叠。
"""
import io, json, glob, re, sys

SVG_FIX = [
    ('可能其实不在', '可能并不在'),
    ('（ProxyMemoryObj），真正的页在取用时才分配', '（ProxyMemoryObj），页在取用时才分配'),
    ('其实都绕开了这个参数', '都绕开了这个参数'),
    ('以为压缩了，其实没有', '以为压缩了，实际没有'),
    ('真正的', ''),
    ('值得注意的', ''), ('值得注意', ''),
    ('其实', ''),
]
FIELD_FIX = [
    ('补丁接缝', '补丁扩展点'), ('适配器的接缝', '适配器的扩展点'),
    ('两种形态的接缝', '两种形态的接口'),
    ('接缝', '扩展点'),
]

def fix(fields, rules, st):
    for a, b in rules:
        c = fields.count(a)
        if c:
            fields = fields.replace(a, b)
            st[a + '→' + (b or '删除')] = st.get(a + '→' + (b or '删除'), 0) + c
    return fields

def walk(obj, st, key=None):
    if isinstance(obj, dict):
        return {k: walk(v, st, k) for k, v in obj.items()}
    if isinstance(obj, list):
        return [walk(v, st, key) for v in obj]
    if isinstance(obj, str):
        if key in ('h3', 'caption', 'group'):
            return fix(obj, FIELD_FIX, st)
        if key == 'svg':
            return fix(obj, SVG_FIX, st)
    return obj

targets = sys.argv[1:] or (['data/analyses.js'] + sorted(glob.glob('.work/deslop/*.json')))
for path in targets:
    raw = io.open(path, encoding='utf-8').read()
    if not any(t in raw for t in ['接缝', '真正的', '其实', '值得注意']):
        print('%-34s （无需清理）' % path); continue
    if path.endswith('.json'):
        obj = json.loads(raw); st = {}
        walk(obj, st)
        io.open(path, 'w', encoding='utf-8').write(json.dumps(obj, ensure_ascii=False, indent=2))
    else:
        # data/analyses.js：逐页处理，保持格式
        def bounds(s, aid):
            i = s.index('  {\n    "id": "%s",' % aid)
            m = re.search(r'\n  \{\n    "id": "[a-z0-9-]+",', s[i + 10:])
            return i, (i + 10 + m.start() if m else s.rstrip().rfind('\n]'))
        st = {}
        s = raw
        for aid in ['mooncake', 'lmcache', 'lmcache-ascend', 'vllm', 'vllm-ascend']:
            i, j = bounds(s, aid)
            obj = json.loads(s[i:j].rstrip().rstrip(','))
            walk(obj, st)
            txt = json.dumps(obj, ensure_ascii=False, indent=2)
            txt = '\n'.join(('  ' + ln) if ln.strip() else ln for ln in txt.split('\n'))
            s = s[:i] + txt + ',\n' + s[j:]
        io.open(path, 'w', encoding='utf-8').write(s)
    print('%-34s %s' % (path, ' · '.join('%s×%d' % kv for kv in sorted(st.items())) or '（无改动）'))
