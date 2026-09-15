#!/usr/bin/env python3
"""把 /Users/hexiaoying/workspace/notes 下的 15 篇一off性搬进站点的 flows/。

做四件事：补 front-matter、摘掉不宜公开的绝对本地路径、修渲染会坏的地方
（<br> 被转义成字面量、裸围栏没有语言标记）、以及删掉 datasystem 文末那个游离围栏。
源文件不动，全部改动落在这里。
"""
import os, re, sys

SRC = '/Users/hexiaoying/workspace/notes'
DST = 'flows'

# 源相对路径 -> (分组, date, title, tags, summary)
META = {
 'cross-layer-e2e-tracing-design.md': ('', '2026-08-02',
   '跨层端到端追踪设计：把观测契约钉在 vLLM 的两个稳定边界上',
   ['可观测性', 'tracing', 'vLLM', 'LMCache', 'Mooncake'],
   'vLLM / LMCache / Mooncake / 调度框架四层各自都有观测，却串不成一条链。这里给出一个不碰上游源码的接法：契约锚在不可变的 vLLM 边界上，上层靠 traceparent 透明接入，下层用 KV connector 包装任意后端。'),
 'glm52-pd-ttft-tpot.md': ('', '2026-08-02',
   'GLM-5.2 集群级端到端推理时延估算（W8A8 + PD 分离）',
   ['时延', 'PD分离', '量化', '昇腾', 'GLM'],
   '744B/40B MoE·MLA 在 W8A8、PD 分离、五级 KV 存储、90% 前缀命中下的全链路时延拆解：从请求进网关到首 token / 末 token，逐段算账，覆盖昇腾 950 PR 与 950 DT 两档硬件。'),
 'kv-layered-quant-backend-guide.md': ('', '2026-08-02',
   '推理后端的 KV Cache 分层量化：架构设计与避坑指南',
   ['KV量化', '分层量化', 'PD分离', '综述'],
   'PD 分离与跨卡场景下对 KV 做分层量化（per-layer / per-channel 在 c8 / c6 / c4 间选档），同时服务省显存与压传输两个目标。综合 CacheGen、KVTuner、UltraQuant、FlowKV 等 7 篇工作，并记下初版被查证推翻的三个结论。'),

 'lmcache-xllm/datasystem-code-walkthrough.md': ('lmcache-xllm', '2026-08-02',
   'openYuanrong datasystem 代码走读',
   ['datasystem', 'openYuanrong', '代码走读', '多级缓存'],
   'openYuanrong 的「数据系统」子系统 v0.8.1 代码级走读：一个异构分布式多级缓存，把集群的 HBM/DRAM/SSD 拼成近计算缓存。它与 Mooncake 是两个独立项目，连仓内的 transfer_engine 都是自研实现。'),
 'lmcache-xllm/lmcache-ascend-code-walkthrough.md': ('lmcache-xllm', '2026-08-02',
   'LMCache + LMCache-Ascend 代码走读',
   ['LMCache', 'lmcache-ascend', '昇腾', '代码走读'],
   '先讲上游 LMCache 的架构与热路径，再讲 lmcache-ascend 这个 monkey-patch 插件如何在其上做 NPU 适配，最后给出两者对比与合并后的热路径图。'),
 'lmcache-xllm/lmcache-ascend-xllm-hierarchy-design.md': ('lmcache-xllm', '2026-08-02',
   '方案 D：分层组合 —— Mooncake 管 PD 跨节点，LMCache 管节点内池化',
   ['xllm', 'LMCache', 'Mooncake', '方案设计'],
   '不替换 Mooncake，也不动任何已验证路径：把 LMCache 接到 xllm 已有的 HierarchyKVCacheTransfer 机制上做「节点内 KV 池化层」，与 Mooncake 的跨节点搬运正交并存，各司其职。'),
 'lmcache-xllm/lmcache-ascend-xllm-integration-design.md': ('lmcache-xllm', '2026-08-02',
   '方案 B 详细设计：为 xllm 新增 LMCache KV 传输后端',
   ['xllm', 'LMCache', '方案设计', 'C-ABI'],
   '在 xllm 的 KVCacheTransferFactory 里加第三个分支，经一个 C ABI 桥接库复用 LMCache 全栈（层级缓存、前缀命中、CacheBlend、PD 分离），对上层一行配置切换。'),
 'lmcache-xllm/lmcache-ascend-xllm-native-layerwise-design.md': ('lmcache-xllm', '2026-08-02',
   '方案 N：xllm 原生逐层 KV 传输（不移植 lmcache 算子）',
   ['xllm', '逐层传输', '昇腾', '方案设计'],
   '方案 B 与方案 D 的最小闭环前置：暂不移植 AscendC 的 scatter/gather kernel、不引入跨语言桥接，仅用 xllm 原生的 aclrtMemcpyBatch 加 device-side event overlap，先把逐层传输与 attention 重叠跑通。'),
 'lmcache-xllm/mooncake-code-walkthrough.md': ('lmcache-xllm', '2026-08-02',
   'Mooncake 代码走读',
   ['Mooncake', '代码走读', '传输引擎'],
   '覆盖 Mooncake 全部子模块的代码级走读，重点深读 transfer-engine：多协议传输、分布式 KVCache 池、P2P Store 三层各自的关键类、函数签名与端到端调用链。'),

 'mooncake/huawei-pr-analysis-2026-09-09.md': ('mooncake', '2026-09-09',
   'Mooncake 按现有模块的华为相关 PR 梳理',
   ['Mooncake', 'PR分析', '华为', '昇腾'],
   '按技术栈关键词筛出 98 个候选 PR（高置信 53 + 弱置信 45），逐模块统计变更量与合入状态：已合并候选共 +35116 / -6996 行，占当前代码量 7.42%。'),
 'mooncake/mooncake-ascend-kunpeng-ub-transport-analysis.md': ('mooncake', '2026-09-01',
   'Mooncake 华为系 Transport 深度解析：昇腾与鲲鹏 UB/URMA',
   ['Mooncake', '传输引擎', '昇腾', '鲲鹏', 'URMA'],
   '深读 transfer-engine 里除 RDMA 之外的国产硬件后端：昇腾四路（ascend_direct / hccl / heterogeneous_rdma / ubshmem）加鲲鹏 UB/URMA，逐条给编译开关与代码锚点，推测处明确标注。'),
 'mooncake/mooncake-huawei-pr-analysis.md': ('mooncake', '2026-09-09',
   'Mooncake 社区中华为系 PR 贡献分析',
   ['Mooncake', 'PR分析', '华为', '社区'],
   '全仓 2779 个 PR 的模块归属统计，按「已合入 PR 是否触达该目录」算占比，看华为系的贡献落在 Mooncake 的哪些模块上。'),
 'mooncake/mooncake-load-save-kv-flows.md': ('mooncake', '2026-09-03',
   'Mooncake Load/Save KV 全流程解析（昇腾 NPU 栈视角）',
   ['Mooncake', 'vLLM-Ascend', '昇腾', '存取全链路'],
   '一次 KV 的存与取，从 vLLM-Ascend 的各连接器一路走到内核数据面：mooncake 侧走 protocol="ascend" 与 fabric mem，GPU 栈的差异压缩到对照表里，只作迁移参考。'),
 'mooncake/mooncake-module-analysis.md': ('mooncake', '2026-09-01',
   'Mooncake 代码模块解析：调用流程与设计理念',
   ['Mooncake', '模块地图', '调用链'],
   '按「模块地图 → 核心抽象 → 端到端调用链 → 设计理念」建立对 Mooncake 的整体认知，以 RDMA 主力路径讲内核骨架，并点出网上旧文章里已经不存在的几个概念。'),
 'mooncake/mooncake-store-deep-dive.md': ('mooncake', '2026-09-01',
   'Mooncake Store 模块深度解析',
   ['Mooncake', 'Store', '分布式缓存'],
   'TransferEngine 之上的分布式 KVCache 对象存储：把各节点贡献的 DRAM 与 SSD 拼成一个全局池，对外提供带多副本、租约、淘汰、分层落盘的 put/get。约 6 万行自有代码的走读。'),
}

# 逐文件的定点替换。先做替换再删行——否则「本地路径」那行会先被删掉。
FIX = {
 'mooncake-store-deep-dive.md': [
   ('> **代码仓库**：`/Users/hexiaoying/cc_workspace/mooncake/mooncake-store`（v2.0.0',
    '> **代码仓库**：`kvcache-ai/Mooncake` 的 `mooncake-store/`（v2.0.0'),
 ],
 'mooncake-load-save-kv-flows.md': [
   ('> - mooncake 仓库 `/Users/hexiaoying/cc_workspace/mooncake`（HEAD = `f2853a8`）',
    '> - mooncake 仓库 `kvcache-ai/Mooncake`（HEAD = `f2853a8`）'),
   ('> - **vLLM-Ascend** `/Users/hexiaoying/workspace/code/kvcache/vllm-ascend`（`vllm_ascend/distributed/kv_transfer/`',
    '> - **vLLM-Ascend**：`vllm_ascend/distributed/kv_transfer/`'),
 ],
 'mooncake-ascend-kunpeng-ub-transport-analysis.md': [
   ('> **代码仓库**：`/Users/hexiaoying/cc_workspace/mooncake`（HEAD = `f2853a8`）',
    '> **代码仓库**：`kvcache-ai/Mooncake`（HEAD = `f2853a8`）'),
 ],
 'mooncake-module-analysis.md': [
   ('> **本地路径**：`/Users/hexiaoying/cc_workspace/mooncake`（HEAD = `f2853a8`，2026 年 5 月快照，monorepo 新布局）',
    '> **代码基线**：HEAD = `f2853a8`（2026 年 5 月快照，monorepo 新布局）'),
 ],
}


def fix_fences(text, rel):
    """裸围栏补 text。只动开围栏，保留缩进（有的代码块在列表项里）。"""
    out, depth = [], 0
    for l in text.split('\n'):
        m = re.match(r'^(\s*)```(\S*)\s*$', l)
        if m:
            if depth == 0:
                depth = 1
                out.append(f"{m.group(1)}```{m.group(2) or 'text'}")
            else:
                depth = 0
                out.append(l)
            continue
        out.append(l)
    if depth != 0:
        sys.exit(f'{rel}: 围栏没配平')
    return '\n'.join(out)


def main():
    n = 0
    for rel, (group, date, title, tags, summary) in META.items():
        text = open(os.path.join(SRC, rel), encoding='utf-8').read()

        # 1) 定点替换要在删行之前
        for a, b in FIX.get(os.path.basename(rel), []):
            if a not in text:
                sys.exit(f'{rel}: 找不到待替换片段 {a[:60]}')
            text = text.replace(a, b, 1)

        # 2) 整行删掉本机绝对路径
        text = '\n'.join(l for l in text.split('\n')
                         if not l.startswith('> **本地路径**：'))

        # 3) <br> 会被 md() 转义成字面量
        text = text.replace('<br>', ' · ')

        # 4) datasystem 文末多一个游离围栏
        if os.path.basename(rel) == 'datasystem-code-walkthrough.md':
            lines = text.rstrip('\n').split('\n')
            if lines[-1].strip() != '```':
                sys.exit('datasystem: 文末不是游离围栏，结构变了')
            text = '\n'.join(lines[:-1]) + '\n'

        text = fix_fences(text, rel)

        # 5) 公开前断言
        for bad in ('/Users/', '<br>', 'shawnrzhu'):
            if bad in text:
                sys.exit(f'{rel}: 还剩 {bad}')

        fm = ['---', f'title: {title}', 'author: MadaoRui', f'date: {date}',
              f'tags: [{", ".join(tags)}]', f'summary: {summary}', '---', '']
        dst = os.path.join(DST, group, os.path.basename(rel)) if group \
            else os.path.join(DST, os.path.basename(rel))
        with open(dst, 'w', encoding='utf-8') as fh:
            fh.write('\n'.join(fm) + text.lstrip('\n'))
        n += 1
    print(f'落盘 {n} 篇')


if __name__ == '__main__':
    main()
