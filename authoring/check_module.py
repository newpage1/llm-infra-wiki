#!/usr/bin/env python3
"""单模块自检：把若干个「关键模块」JSON 拼成一个临时分析页，跑 tools/checker/check_module.js。

用法：
    python3 authoring/check_module.py <analysis-id> <module.json> [<module.json> …]

示例（在写 vllm 页的某个模块时）：
    python3 authoring/check_module.py vllm /tmp/mod-worker.json

它会：
  1. 取 data/analyses.js 里该分析页的**页面级字段**当骨架；
  2. 用给定的模块 JSON 替换 `modules`；
  3. 写出临时 analyses.js，跑校验并打印结果。

注意：不带 `--repo` 时只校验**结构**（8 小节顺序、%% 成对、图数、跨节重复），
     不带行号与逐字围栏。要完整校验，见 CONTRIBUTING.md 的三条命令。
"""
import json, os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
WIKI = os.path.abspath(os.path.join(HERE, '..'))
CHECKER = os.path.join(WIKI, 'tools', 'checker', 'check_module.js')


def load_analysis(analysis_id):
    """从 data/analyses.js 里抠出指定分析页的对象（顶层是 JSON，缩进 2）。"""
    s = open(os.path.join(WIKI, 'data', 'analyses.js'), encoding='utf-8').read()
    pat = '\n  {\n    "id": "%s",' % analysis_id
    i = s.find(pat)
    if i < 0:
        raise SystemExit('未在 data/analyses.js 里找到分析页 %s' % analysis_id)
    nxt = re.search(r'\n  \{\n    "id": "[a-z0-9-]+",', s[i + 10:])
    j = i + 10 + (nxt.start() if nxt else len(s) - i - 10)
    return json.loads(s[i:j].rstrip().rstrip(','))


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    analysis_id, paths = argv[1], argv[2:]
    top = load_analysis(analysis_id)
    mods = []
    for p in paths:
        mods.append(json.load(open(p, encoding='utf-8'))
                    if p.endswith('.json') else json.loads(p))
    top['modules'] = mods

    fd, tmp = tempfile.mkstemp(suffix='.js', prefix='scratch-%s-' % analysis_id)
    os.close(fd)
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write('window.WIKI_ANALYSES = ')
        json.dump([top], f, ensure_ascii=False, indent=1)
        f.write(';\n')

    print('模块: %s' % [m['id'] for m in mods])
    print('临时文件: %s' % tmp)
    r = subprocess.run(['node', CHECKER, tmp, analysis_id, '--all'],
                       capture_output=True, text=True)
    out = r.stdout + r.stderr
    print(out)
    bad = [l for l in out.split('\n') if l.startswith('❌')]
    print('===== 结论 =====')
    print('  失败模块: %s' % (bad if bad else '无'))
    print('  %s' % (out.strip().split('\n')[-1] if out.strip() else '(无输出)'))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
