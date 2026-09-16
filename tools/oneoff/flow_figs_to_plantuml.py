#!/usr/bin/env python3
"""把那篇 md 里的图片引用从「手绘 SVG（放 md 旁边）」改指到 `diagrams/` 下
PlantUML 渲染出的 SVG，并删掉手绘的那 8 个。

为什么走 `../../diagrams/`：图片路径是相对**这篇 md 所在目录**解析的，
而渲染好的图统一放在仓库的 `diagrams/`（`diagrams/render.sh` 的输出目录）。
app.js 的 fixFlowPaths 会给相对路径补上 `flows/<分组>/` 前缀，
`flows/vllm-ascend/../../diagrams/x.svg` 在浏览器里正好落到 `diagrams/x.svg`。

用法：
    python3 tools/oneoff/flow_figs_to_plantuml.py            # 干跑
    python3 tools/oneoff/flow_figs_to_plantuml.py --write     # 真改
"""
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WIKI = os.path.abspath(os.path.join(HERE, '..', '..'))
DIR = os.path.join(WIKI, 'flows', 'vllm-ascend')
MD = os.path.join(DIR, 'vllm-ascend-layerwise-sparse-full-flow.md')

# 手绘文件名 → PlantUML 源名（渲染出的 .svg 同名）
MAP = [
    ('four-storage-regions.svg', 'vllm-ascend-offload-regions.svg'),
    ('request-lifecycle.svg', 'vllm-ascend-offload-lifecycle.svg'),
    ('rendezvous-handshake.svg', 'vllm-ascend-offload-rendezvous.svg'),
    ('three-phases.svg', 'vllm-ascend-offload-phases.svg'),
    ('layer-pipeline.svg', 'vllm-ascend-offload-layer-pipeline.svg'),
    ('slot-reuse-gates.svg', 'vllm-ascend-offload-reuse-gates.svg'),
    ('decode-step.svg', 'vllm-ascend-offload-decode-step.svg'),
    ('end-to-end.svg', 'vllm-ascend-offload-end-to-end.svg'),
]


def main():
    write = '--write' in sys.argv
    text = io.open(MD, encoding='utf-8').read()

    missing = [new for _, new in MAP
               if not os.path.exists(os.path.join(WIKI, 'diagrams', new))]
    if missing:
        print('还没渲染好：\n  ' + '\n  '.join(missing))
        if write:
            sys.exit('图不齐，先别改 md')

    for old, new in MAP:
        if f']({old})' not in text:
            sys.exit(f'md 里找不到引用：{old}')
        text = text.replace(f']({old})', f'](../../diagrams/{new})')
    print(f'引用已改指 diagrams/（{len(MAP)} 处）')

    if not write:
        print('\n（干跑。加 --write 真改）')
        return 0

    io.open(MD, 'w', encoding='utf-8').write(text)
    for old, _ in MAP:
        p = os.path.join(DIR, old)
        if os.path.exists(p):
            os.remove(p)
            print('  删掉手绘的', old)
    print(f'\n✅ 已改写 {os.path.relpath(MD, WIKI)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
