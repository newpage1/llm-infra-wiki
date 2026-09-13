#!/usr/bin/env python3
"""去 AI 腔第二轮的施工脚手架：把每个分析页隔离成一个文件，避免并行改同一个大文件。

背景：`data/analyses.js` 是一个 4MB 的数组，五个分析页首尾相接。多个代理同时
load→改→save 整个文件，后写的会把先写的覆盖掉。所以这一轮改成：

    extract <id>      把该页单独导出到 .work/deslop/<id>.json
    check   <id>      用「本页取自 .work/deslop/，其余页取自 data/」拼一个临时
                      analyses.js，跑校验——这样每个代理都能独立自检
    merge             把 .work/deslop/ 下所有页合并回 data/analyses.js（串行执行）

用法：
    python3 tools/oneoff/deslop_work.py extract vllm
    python3 tools/oneoff/deslop_work.py check vllm
    python3 tools/oneoff/deslop_work.py merge
"""
import io, json, os, re, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
P = os.path.join(ROOT, 'data', 'analyses.js')
WORK = os.path.join(ROOT, '.work', 'deslop')
CHECKER = os.path.join(ROOT, 'tools', 'checker', 'check_module.js')
IDS = ['mooncake', 'lmcache', 'lmcache-ascend', 'vllm', 'vllm-ascend']


def bounds(s, aid):
    i = s.index('  {\n    "id": "%s",' % aid)
    m = re.search(r'\n  \{\n    "id": "[a-z0-9-]+",', s[i + 10:])
    j = i + 10 + m.start() if m else s.rstrip().rfind('\n]')
    return i, j


def read_page(aid, src=None):
    s = io.open(src or P, encoding='utf-8').read()
    i, j = bounds(s, aid)
    return json.loads(s[i:j].rstrip().rstrip(','))


def dump(obj):
    txt = json.dumps(obj, ensure_ascii=False, indent=2)
    return '\n'.join(('  ' + ln) if ln.strip() else ln for ln in txt.split('\n'))


def extract(aid):
    os.makedirs(WORK, exist_ok=True)
    obj = read_page(aid)
    out = os.path.join(WORK, aid + '.json')
    io.open(out, 'w', encoding='utf-8').write(json.dumps(obj, ensure_ascii=False, indent=2))
    print('导出 %s（%d 个模块）→ %s' % (aid, len(obj.get('modules', [])), os.path.relpath(out, ROOT)))
    # 同时存一份改动前的快照，便于回退
    bak = os.path.join(WORK, '_before', aid + '.json')
    os.makedirs(os.path.dirname(bak), exist_ok=True)
    if not os.path.exists(bak):
        io.open(bak, 'w', encoding='utf-8').write(io.open(out, encoding='utf-8').read())
        print('  （同时存了改动前快照 _before/%s.json）' % aid)


def assemble(dest):
    """本页取 .work/deslop/，其余取 data/ —— 给单个代理自检用。"""
    s = io.open(P, encoding='utf-8').read()
    out = s
    for aid in IDS:
        f = os.path.join(WORK, aid + '.json')
        if not os.path.exists(f):
            continue
        obj = json.loads(io.open(f, encoding='utf-8').read())
        i, j = bounds(out, aid)
        out = out[:i] + dump(obj) + ',\n' + out[j:]
    io.open(dest, 'w', encoding='utf-8').write(out)
    return out


def check(aid):
    fd, tmp = tempfile.mkstemp(suffix='.js', prefix='deslop-%s-' % aid, dir=WORK)
    os.close(fd)
    assemble(tmp)
    rc = 0
    for flag in ('--all', '--design', '--cross'):
        r = subprocess.run(['node', CHECKER, tmp, aid, flag], capture_output=True, text=True)
        out = r.stdout + r.stderr
        last = [l for l in out.split('\n') if l.startswith('合计：')]
        print('%-8s %s' % (flag, last[-1] if last else out.strip().split('\n')[-1][:80]))
        if r.returncode != 0:
            rc = 1
            for l in out.split('\n'):
                if l.startswith('❌') or '提示：' in l:
                    print('   ' + l.strip())
    # 顺便数一下本页还剩多少目标句式
    obj = json.loads(io.open(os.path.join(WORK, aid + '.json'), encoding='utf-8').read()) \
        if os.path.exists(os.path.join(WORK, aid + '.json')) else read_page(aid)
    blob = json.dumps(obj, ensure_ascii=False)
    blob = re.sub(r'~~~[a-z]*\n[\s\S]*?\n~~~', '', blob)
    blob = re.sub(r'<svg[\s\S]*?</svg>', '', blob)
    print('剩余句式：而是 %d · 这就是 %d · 这正是 %d' % (
        len(re.findall('而是', blob)), len(re.findall('这就是', blob)), len(re.findall('这正是', blob))))
    return rc


def merge():
    s = io.open(P, encoding='utf-8').read()
    for aid in IDS:
        f = os.path.join(WORK, aid + '.json')
        if not os.path.exists(f):
            print('%-14s （没有工作文件，跳过）' % aid); continue
        obj = json.loads(io.open(f, encoding='utf-8').read())
        i, j = bounds(s, aid)
        s = s[:i] + dump(obj) + ',\n' + s[j:]
        print('%-14s 已合并（%d 个模块）' % (aid, len(obj.get('modules', []))))
    io.open(P, 'w', encoding='utf-8').write(s)
    print('→ 已写回 data/analyses.js')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(2)
    cmd = sys.argv[1]
    if cmd == 'extract':
        for a in (sys.argv[2:] or IDS): extract(a)
    elif cmd == 'check':
        sys.exit(check(sys.argv[2]))
    elif cmd == 'merge':
        merge()
    else:
        print(__doc__); sys.exit(2)
