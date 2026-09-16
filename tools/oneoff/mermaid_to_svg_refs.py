#!/usr/bin/env python3
"""把一篇 md 里的 ```mermaid 代码块换成站内风格的手绘 SVG 图片引用。

本站没有 mermaid 渲染器，mermaid 块在页面上只会显示源码。所以逐张手绘成 SVG
（放在 md 旁边），再把块替换成 `![说明](文件名.svg)`——app.js 会把 SVG 取回来内联，
主题变量与 `.diagram .t-*` 都生效。

**按内容关键字认块**，不按顺序认：这样已经替换掉的块不会被再数一遍，
所以可以一张一张地接进来，重复跑也安全。

用法：
    python3 tools/oneoff/mermaid_to_svg_refs.py            # 干跑，只报告
    python3 tools/oneoff/mermaid_to_svg_refs.py --write    # 真替换（只替换图已就绪的）
"""
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WIKI = os.path.abspath(os.path.join(HERE, '..', '..'))
DIR = os.path.join(WIKI, 'flows', 'vllm-ascend')
MD = os.path.join(DIR, 'vllm-ascend-layerwise-sparse-full-flow.md')

# 认块用的关键字（必须在那个 mermaid 块里出现）→ 图文件名 + 说明
FIGS = [
    (['PHost', 'PNPU'], 'four-storage-regions.svg',
     '四个存储区域与它们之间的搬运关系'),
    (['autonumber', 'READ_READY_BATCH'], 'request-lifecycle.svg',
     '一次请求从客户端到 D 可调度的端到端时序：Rendezvous 与逐层传输两个阶段'),
    (['_request_trackers', 'MF_META'], 'rendezvous-handshake.svg',
     'Rendezvous 会合阶段的三方握手'),
    (['阶段①', '阶段③'], 'three-phases.svg',
     '三个阶段：rendezvous / prefill 传输 / decode'),
    (['wait_for_layer_load', 'prefetch'], 'layer-pipeline.svg',
     '一次 layer 的执行流水，以及 buffer 足够时的重叠回边'),
    (['门闩 1', '门闩 2'], 'slot-reuse-gates.svg',
     'slot 能不能被复用：两道串联的门闩'),
    (['LRU 驻留表', 'qkv_proj'], 'decode-step.svg',
     '一个 Decode Step 内的七个步骤'),
    (['请求到达 Proxy', 'Gate'], 'end-to-end.svg',
     '端到端全流程：从请求到达 Proxy 到生成结束'),
]


def mermaid_blocks(lines):
    """返回 [(起始行, 结束行, 块文本)]，含首尾围栏。"""
    out, cur = [], None
    for i, l in enumerate(lines):
        if cur is None and re.match(r'^```mermaid\s*$', l):
            cur = i
        elif cur is not None and re.match(r'^```\s*$', l):
            out.append((cur, i, '\n'.join(lines[cur + 1:i])))
            cur = None
    if cur is not None:
        sys.exit('有 mermaid 块没闭合')
    return out


def main():
    write = '--write' in sys.argv
    lines = io.open(MD, encoding='utf-8').read().split('\n')
    bs = mermaid_blocks(lines)
    print(f'md 里还有 {len(bs)} 个 mermaid 块', flush=True)

    todo, done, missing = [], [], []
    for s, e, text in bs:
        hit = [(keys, fn, alt) for keys, fn, alt in FIGS
               if all(k in text for k in keys)]
        if not hit:
            sys.exit(f'行 {s + 1} 的 mermaid 块认不出是哪张图，关键字表要更新：\n'
                     + '\n'.join(text.split('\n')[:4]))
        keys, fn, alt = hit[0]
        if os.path.exists(os.path.join(DIR, fn)):
            todo.append((s, e, fn, alt))
        else:
            missing.append(fn)

    for s, e, fn, alt in todo:
        print(f'  行 {s + 1}-{e + 1} → ![{alt}]({fn})')
    for fn in missing:
        print(f'  跳过（图还没画好）：{fn}')

    if write and todo:
        # 从后往前替换，免得行号错位
        for s, e, fn, alt in sorted(todo, reverse=True):
            lines[s:e + 1] = [f'![{alt}]({fn})']
        io.open(MD, 'w', encoding='utf-8').write('\n'.join(lines))
        print(f'\n✅ 替换了 {len(todo)} 块')
    elif not write:
        print('\n（干跑。加 --write 真替换）')

    if missing:
        print(f'\n还差 {len(missing)} 张图：{"、".join(missing)}')
    elif not bs:
        print('\n✅ 8 张图全部就位，md 里没有 mermaid 块了')
    return 0


if __name__ == '__main__':
    sys.exit(main())
