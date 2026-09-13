#!/usr/bin/env python3
"""去 AI 腔第二遍：把「做什么 / 不做什么」换成「职责 / 边界」，并收拾公式化的小标题。

为什么换标签而不是删单元格里的「不」：
  203 个单元格里有 149 个以「不」开头，动词五花八门。逐个删「不」会改错语义——
  「不认识 KV 的语义」删掉就成了相反的意思，「不是配置中心」同理。
  换成「边界」之后，单元格里的「不」正好是读者预期的，一个字都不用动。

顺带收拾：
  · 「### 一句话」「### 一句话记住这一层」这类公式化小标题
  · 「**一句话结论：X**」这种先声明再给结论的写法
"""
import io, json, os, re

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
P = os.path.join(ROOT, 'data', 'analyses.js')

# 公式化的「一句话」小标题 → 直接说这段讲什么
HEADINGS = [
    ('### 一句话记住这一层', '### 这一层为什么长这样'),
    ('### 一句话说清它为什么存在', '### 它为什么存在'),
    ('### 一句话说清它的取舍', '### 它的取舍'),
    ('### 一句话说清', '### '),
    ('### 一句话\n', '### 这一层做什么\n'),
    ('### 一句话：', '### '),
    # 章节内的引子
    ('**一句话结论：', '**结论：'),
]
# 行内的「一句话：」引子（段落中间的）
INLINE = [
    ('**一句话**：', ''),
    ('一句话交代了', '这段交代了'),
]

def walk(node, stats, key=None):
    if isinstance(node, dict):
        return {k: walk(v, stats, k) for k, v in node.items()}
    if isinstance(node, list):
        return [walk(v, stats, key) for v in node]
    if isinstance(node, str) and key in ('lead', 'html', 'summary', 'modulesLead', 'subtitle', 'title'):
        s = node
        n = s.count('**做什么**')
        if n: s = s.replace('**做什么**', '**职责**'); stats['做什么→职责'] = stats.get('做什么→职责', 0) + n
        n = s.count('**不做什么**')
        if n: s = s.replace('**不做什么**', '**边界**'); stats['不做什么→边界'] = stats.get('不做什么→边界', 0) + n
        for a, b in HEADINGS + INLINE:
            n = s.count(a)
            if n: s = s.replace(a, b); stats[a] = stats.get(a, 0) + n
        return s
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
