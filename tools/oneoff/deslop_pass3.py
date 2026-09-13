#!/usr/bin/env python3
"""去 AI 腔第三遍：删强调虚壳与公式化小标题。

这一遍只做「删掉不损失信息」的操作，凡是要改句子结构的留给人工/逐页精修。
  ① 「一句话」的各种公式化用法（小标题、表头、引子）
  ② 「真正的」当作强调虚壳删掉
  ③ 「其实」删掉（「其实就是」→「就是」）
  ④ 「非常」→「很」；「十分」→「很」（但要避开「二十分之一」这种）
"""
import io, json, os, re

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
P = os.path.join(ROOT, 'data', 'analyses.js')

FIXED = [
    # ① 「一句话」的公式化用法
    ('| 一句话 |', '| 说明 |'),
    ('### 一句话定位\n', '### 定位\n'),
    ('**一句话定位**：', '**定位**：'),
    ('**一句话定位：', '**定位：'),
    ('**一句话对比**：', '**对比**：'),
    ('**一句话结论：', '**结论：'),
    ('### 三个角色，一句话分开', '### 三个角色怎么分'),
    ('### 两侧分工一句话', '### 两侧分工'),
    ('### ② 三个实现的一句话区分', '### ② 三个实现怎么区分'),
    # ③ 「其实」
    ('其实就是', '就是'),
    ('其实并不是', '并不是'),
    ('其实不是', '不是'),
    ('其实用不到', '用不到'),
    ('其实是', '是'),
    ('其实在', '在'),
    ('其实都', '都'),
    ('其实也', '也'),
    ('其实只', '只'),
    ('其实就', '就'),
    ('其实，', ''),
    ('其实', ''),
]

def fix(s, st):
    # ② 「真正的」当虚壳删（保留「不是真正的」这类否定里的，删了会变义）
    n = len(re.findall(r'真正的', s))
    if n:
        s2 = re.sub(r'不(做|是|会|能)真正的', lambda m: '不' + m.group(1), s)   # 先把「不做真正的X」里的删掉
        s2 = s2.replace('真正的', '')
        st['真正的'] = st.get('真正的', 0) + n
        s = s2
    # ④ 程度副词
    n = len(re.findall(r'非常', s))
    if n: s = s.replace('非常', '很'); st['非常→很'] = st.get('非常→很', 0) + n
    n = len(re.findall(r'(?<![一二三四五六七八九十百千万0-9])十分', s))   # 避开「二十分之一」
    if n: s = re.sub(r'(?<![一二三四五六七八九十百千万0-9])十分', '很', s); st['十分→很'] = st.get('十分→很', 0) + n
    # ① 固定搭配
    for a, b in FIXED:
        n = s.count(a)
        if n: s = s.replace(a, b); st[a] = st.get(a, 0) + n
    return s

def walk(node, st, key=None):
    if isinstance(node, dict):
        return {k: walk(v, st, k) for k, v in node.items()}
    if isinstance(node, list):
        return [walk(v, st, key) for v in node]
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
