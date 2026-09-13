"""用仓库原文替换页面围栏。run([(模块id, 旧围栏内某行片段, repo文件, 起行, 止行), ...])"""
import re, json, subprocess
REPO = '/Users/hexiaoying/workspace/codex/lmcache-review'
P = 'data/analyses.js'
FENCE = '~' * 3

def real(f, a, b):
    t = subprocess.run(['git', '-C', REPO, 'show', 'HEAD:' + f],
                       capture_output=True, text=True).stdout.split('\n')
    return '\n'.join(t[a-1:b])

def run(fixes):
    src = open(P, encoding='utf-8').read()
    A = json.loads(re.search(r'window\.WIKI_ANALYSES\s*=\s*(\[[\s\S]*\]);', src).group(1))
    n = 0
    for mid, anchor, f, a, b in fixes:
        done = False
        for an in A:
            for m in an['modules']:
                if m['id'] != mid or done:
                    continue
                js = json.dumps(m, ensure_ascii=False)
                i = js.find(anchor)
                if i < 0:
                    continue
                s = js.rfind(FENCE, 0, i)
                e = js.find(FENCE, i)
                if s < 0 or e < 0:
                    continue
                esc = json.dumps(real(f, a, b))[1:-1]
                new = js[:s] + FENCE + 'python\\n' + esc + '\\n' + FENCE + js[e+3:]
                # 锚点可能落在正文而不是围栏里——那时 rfind/find 会切错一段，
                # 拼出非法 JSON。以前它会带着破损内容继续跑；现在先试解析，
                # 不通过就不写，并明确指出原因。
                try:
                    parsed = json.loads(new)
                except json.JSONDecodeError as exc:
                    print(f'  SKIP {mid}: 锚点不在围栏内（{exc.msg} @ {exc.pos}）')
                    continue
                m.clear()
                m.update(parsed)
                n += 1
                done = True
                print(f'  OK {mid:16} <- {f}:{a}-{b}  ({b-a+1} 行)')
        if not done:
            print(f'  MISS {mid}: {anchor[:50]!r}')
    head = src[:src.index('window.WIKI_ANALYSES')]
    open(P, 'w', encoding='utf-8').write(
        head + 'window.WIKI_ANALYSES = ' + json.dumps(A, ensure_ascii=False, indent=2) + ';\n')
    return n
