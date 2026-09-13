#!/usr/bin/env python3
"""去 AI 腔第一遍：只做机械、可复核的替换。改完用 git diff 逐条看。

改什么：
  ① 表格标签 负责 / 不负责 → 做什么 / 不做什么
  ② 导语开头的「一句话：」引子 → 删（lead 本身就是导语）
  ③ 「值得注意（的是）」强调虚壳 → 删引子
  ④ 「接缝」→ 按语境换（vllm-ascend 统一「扩展点」，其余按词搭配）

不改：代码围栏、%%标识符%%、路径:行号、SVG 的结构属性。
"""
import io, json, re, os, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
P = os.path.join(ROOT, 'data', 'analyses.js')

# ④ 接缝的替换规则：先专有搭配，再通用
JIE = [
    # 专有搭配（vllm-ascend/ops 里的三个）
    ('类名接缝', '类名扩展点'), ('算子名接缝', '算子名扩展点'), ('工厂接缝', '工厂扩展点'),
    ('连接器接缝', '连接器扩展点'), ('实现接缝', '实现扩展点'), ('引擎接缝', '引擎扩展点'),
    ('补丁接缝', '补丁扩展点'), ('挂载接缝', '挂载点'),
    # 编号指代
    ('接缝 A', '路径 A'), ('接缝 B', '路径 B'), ('接缝 C', '路径 C'),
    # 表头
    ('| 接缝 |', '| 接口 |'),
]
# 通用替换：vllm-ascend 全页用「扩展点」，其余用「接口」
PAGE_TERM = {'vllm-ascend': '扩展点'}

def fix_text(s, page_id, stats):
    # ① 标签
    n = s.count('**不负责**'); 
    if n: s = s.replace('**不负责**', '**不做什么**'); stats['标签 不负责'] = stats.get('标签 不负责', 0) + n
    n = s.count('**负责**')
    if n: s = s.replace('**负责**', '**做什么**'); stats['标签 负责'] = stats.get('标签 负责', 0) + n

    # ② 一句话：引子（只处理行首/段首）
    n = len(re.findall(r'(^|\n)一句话：', s))
    if n:
        s = re.sub(r'(^|\n)一句话：', r'\1', s); stats['一句话：'] = stats.get('一句话：', 0) + n

    # ③ 值得注意（的是）
    n = len(re.findall(r'值得注意(的是)?[，,：:]?\s*', s))
    if n:
        s = re.sub(r'值得注意(的是)?[，,：:]?\s*', '', s); stats['值得注意'] = stats.get('值得注意', 0) + n

    # ④ 接缝
    for a, b in JIE:
        c = s.count(a)
        if c: s = s.replace(a, b); stats['接缝:' + a] = stats.get('接缝:' + a, 0) + c
    term = PAGE_TERM.get(page_id, '接口')
    c = s.count('接缝')
    if c: s = s.replace('接缝', term); stats['接缝→' + term] = stats.get('接缝→' + term, 0) + c
    return s

def walk(node, page_id, stats, key=None):
    if isinstance(node, dict):
        return {k: walk(v, page_id, stats, k) for k, v in node.items()}
    if isinstance(node, list):
        return [walk(v, page_id, stats, key) for v in node]
    if isinstance(node, str) and key in ('lead', 'html', 'summary', 'modulesLead', 'subtitle', 'title', 'svg'):
        return fix_text(node, page_id, stats)
    return node

def bounds(s, aid):
    i = s.index('  {\n    "id": "%s",' % aid)
    m = re.search(r'\n  \{\n    "id": "[a-z0-9-]+",', s[i + 10:])
    j = i + 10 + m.start() if m else s.rstrip().rfind('\n]')
    return i, j

def main():
    s = io.open(P, encoding='utf-8').read()
    all_stats = {}
    for aid in ['mooncake', 'lmcache', 'lmcache-ascend', 'vllm', 'vllm-ascend']:
        i, j = bounds(s, aid)
        obj = json.loads(s[i:j].rstrip().rstrip(','))
        stats = all_stats.setdefault(aid, {})
        obj = walk(obj, aid, stats)
        txt = json.dumps(obj, ensure_ascii=False, indent=2)
        txt = '\n'.join(('  ' + ln) if ln.strip() else ln for ln in txt.split('\n'))
        s = s[:i] + txt + ',\n' + s[j:]
    io.open(P, 'w', encoding='utf-8').write(s)
    tot = {}
    for aid, st in all_stats.items():
        for k, v in st.items():
            tot[k] = tot.get(k, 0) + v
        print('%-14s %s' % (aid, ' · '.join('%s×%d' % (k, v) for k, v in sorted(st.items())) or '（无改动）'))
    print('\n合计：' + ' · '.join('%s×%d' % (k, v) for k, v in sorted(tot.items())))

if __name__ == '__main__':
    main()
