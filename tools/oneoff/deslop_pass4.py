#!/usr/bin/env python3
"""去 AI 腔第四遍：收拾公式化的「负责」小标题与表头。

注意区分：散文里的「引擎负责注册」「Client 只负责发起与等待」是正常中文，**保留**。
只改被当成模板用的那些——章节标题与表格标签。
"""
import io, json, os, re

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
P = os.path.join(ROOT, 'data', 'analyses.js')

FIXED = [
    ('### 负责什么 / 不负责什么', '### 做什么 / 不做什么'),
    ('### 负责什么、不负责什么', '### 做什么、不做什么'),
    ('### 负责什么，不负责什么', '### 做什么，不做什么'),
    ('### 负责与不负责', '### 做什么，不做什么'),
    ('### 负责什么', '### 这个模块做什么'),
    ('### 不负责什么', '### 它不做什么'),
    ('**它不负责什么**：', '**它不做什么**：'),
    ('| 不负责 | 实际在哪 |', '| 不做什么 | 实际在哪 |'),
    ('| **不负责** | 实际在哪 |', '| **不做什么** | 实际在哪 |'),
]

def fix(s, st):
    for a, b in FIXED:
        n = s.count(a)
        if n: s = s.replace(a, b); st[a] = st.get(a, 0) + n
    return s

def walk(node, st, key=None):
    if isinstance(node, dict):  return {k: walk(v, st, k) for k, v in node.items()}
    if isinstance(node, list):  return [walk(v, st, key) for v in node]
    if isinstance(node, str) and key in ('lead', 'html', 'summary', 'modulesLead', 'subtitle', 'title'):
        return fix(node, st)
    return node

def bounds(s, aid):
    i = s.index('  {\n    "id": "%s",' % aid)
    m = re.search(r'\n  \{\n    "id": "[a-z0-9-]+",', s[i + 10:])
    j = i + 10 + m.start() if m else s.rstrip().rfind('\n]')
    return i, j

def main():
    s = io.open(P, encoding='utf-8').read()
    tot = {}
    for aid in ['mooncake', 'lmcache', 'lmcache-ascend', 'vllm', 'vllm-ascend']:
        i, j = bounds(s, aid)
        obj = json.loads(s[i:j].rstrip().rstrip(','))
        st = {}
        obj = walk(obj, st)
        for k, v in st.items(): tot[k] = tot.get(k, 0) + v
        print('%-14s %s' % (aid, ' · '.join('%s×%d' % kv for kv in sorted(st.items())) or '（无改动）'))
        txt = json.dumps(obj, ensure_ascii=False, indent=2)
        txt = '\n'.join(('  ' + ln) if ln.strip() else ln for ln in txt.split('\n'))
        s = s[:i] + txt + ',\n' + s[j:]
    io.open(P, 'w', encoding='utf-8').write(s)
    print('\n合计：' + ' · '.join('%s×%d' % kv for kv in sorted(tot.items())))

if __name__ == '__main__':
    main()
