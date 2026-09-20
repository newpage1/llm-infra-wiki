---
section: 新模型
summary: KDA/GDN 会把 KVC 从单一的 token-KV block 管理器推向异构推理状态平台：缓存对象从一种变成多种、检索从 prefix block 命中变成 boundary state 恢复、传输从 raw bytes 变成 layout-aware、一致性要求显著提高。
---

# KDA/GDN 对 KVC 组件的影响与演进趋势

> 调研日期：2026-09-07
>
> 讨论对象：KDA、GDN、Mamba/SSM、混合注意力模型，以及 vLLM-Ascend、Mooncake、AscendStore 等 KVC 组件

> **关于文中的引用。** 文中 `路径:行号` 指向工作区里对应仓库的本地检出，`xxx.md:行号` 指向工作区的本地报告；站上没有这些文件、点不开，已按纯文本保留，已上线的姊妹报告则保留为可点击链接。

## 1. 核心判断

KDA/GDN 的引入不会简单地让 KVC 变成“更小的 KV Cache”。它会推动 KVC 从单一的 **token-KV block 管理器**，演进为同时管理多种计算状态的 **异构推理状态平台**。

最重要的变化是：

1. **缓存对象从一种变成多种**：除了普通 attention 的 token KV，还要管理 KDA/GDN/Mamba 的 recurrent state，以及 index、scale、路由和版本等辅助元数据。
2. **检索从 prefix block 命中扩展为 boundary state 恢复**：普通 KV 可以按连续 token block 命中；recurrent state 必须命中某个精确序列边界的完整 snapshot。
3. **传输从 raw bytes 搬运转向带语义的 layout-aware transfer**：必须知道对象属于哪种 cache family、对应哪个 layer/group、由哪个 TP/DP 布局产生，以及目标侧如何重排。
4. **一致性要求明显提高**：普通 KV 缺一个 block 通常只影响一段前缀；state snapshot 不完整、位置错误或代际混淆，可能导致后续所有 decode 输出错误。
5. **KVC 的优化目标从带宽优先变成端到端成本优先**：需要同时权衡 state snapshot 大小、保存频率、恢复延迟、重算成本、跨节点带宽和 HBM 占用。

简化地说，KDA/GDN 会让 KVC 从“缓存历史 K/V”转向“保存可继续执行模型计算所需的状态”。

## 2. 两种缓存语义

### 2.1 普通 attention KV

普通 Transformer、MLA 等路径通常把历史信息表示为 token 维度上的 K/V block：

```text
prefix tokens -> block 0 -> block 1 -> block 2 -> ...
```

其典型特点：

- 可以按 token/chunk/block 分段保存。
- 相邻 block 可以拼接成更长的前缀。
- 命中条件主要是 token prefix hash、模型/adapter/采样上下文等匹配。
- 读取若干缺失 block 后，可以继续执行 attention。
- 传输常以 layer bundle、token chunk 或 page 为粒度。

### 2.2 KDA/GDN recurrent state

KDA/GDN 不保存完整的历史 token K/V 列表，而是递归更新状态：

\[
S_t=F(S_{t-1},x_t)
\]

因此外部 KVC 需要保存的是某个边界位置的状态快照：

```text
tokens 0..4095 -> state snapshot(position=4096)
tokens 4096..8191 -> state snapshot(position=8192)
```

其典型特点：

- 一个 state 对应一个序列边界，而不是一个普通 token block。
- state 是历史的递归摘要，不是可任意拼接的 K/V 列表。
- 恢复时需要完整、位置正确的 state，通常包括卷积状态和 recurrent/temporal state。
- decode 中 state 会持续原地更新，远端副本需要 generation fencing 或 Copy-on-Write（COW）。
- 缺少一个关键 state 时，通常只能从更早 snapshot 重放，或者放弃命中并重新 prefill。

这也是 KDA/Mamba state 必须在 KVC 内部拥有独立语义的根本原因。

## 2.3 从 KV Cache 到分层记忆

如果把模型的上下文能力类比为记忆系统，MHA/GQA/MQA 更像“把历史逐条存档”，MLA 更像“把历史压缩成潜变量”，DSA（此处指 DeepSeek Sparse Attention）更像“给历史建立索引，只读取可能相关的部分”，而 KDA/GDN/DeltaNet/Mamba 则更接近固定容量的“工作记忆”：状态会持续写入、更新和遗忘。

因此，KV/context 存储的演进重点不再只是扩大窗口或压缩每个 KV，而是管理不同语义、不同时间尺度的记忆。

| 记忆层 | 模型/机制 | 保存内容 | 主要优势 | 主要代价 |
| --- | --- | --- | --- | --- |
| 近期精确记忆 | MHA/GQA/MQA、局部 attention | token 级 K/V | 任意细节可精确读取 | 容量和读取成本随长度增长 |
| 压缩记忆 | MLA、KV quantization、低秩表示 | latent KV 或压缩 KV | 显著降低显存和带宽 | 需要重建，存在信息损失 |
| 稀疏记忆 | DSA、token selection、检索式 attention | KV 加索引/重要性元数据 | 避免读取无关历史 | 召回错误会直接影响质量 |
| 工作记忆 | KDA/GDN、DeltaNet、Mamba/SSM | recurrent/temporal state | 状态大小近似固定，适合流式 decode | 不能像 token KV 一样任意拼接，依赖正确的写入和边界 |
| 长期记忆 | 摘要、RAG、向量库、持久化 memory | 语义结果或外部对象 | 可跨请求、跨会话保存 | 需要检索和一致性协议，不等价于 KV 命中 |

最可能的模型形态是多时间尺度的混合结构：

```text
最近几十到几百个 token        -> 完整/局部 attention KV
较远但可能相关的历史          -> 稀疏 attention、压缩 KV、检索
长期历史与用户信息            -> recurrent state、摘要、外部 memory
```

这意味着“上下文长度”会逐渐让位于“有效记忆容量”。百万 token window 不代表模型能够等价地使用百万 token；系统真正需要优化的是相关信息的写入、保留、召回、重放和遗忘。

### 2.4 对 KVC 架构的直接推论

上述趋势会把 KVC 从单纯的 `token-KV block manager` 推向 **Hybrid Memory Coordinator**：

1. **缓存对象分层。** `TOKEN_KV`、`RECURRENT_STATE` 和 `AUX_METADATA` 需要独立的生命周期、命中条件和一致性语义；不能只用一个通用 byte blob 表示。
2. **命中结果从布尔值变成恢复计划。** 调度器需要同时回答“哪些 KV 可直接读取”“哪个 state boundary 可恢复”“需要 replay 多少 token”“读取还是重新计算更便宜”。
3. **存储层级与模型记忆层级对齐。** 最新 token KV 放在 HBM，压缩/稀疏 KV 可放在 DRAM 或远端内存，长期 state/summary 才适合 SSD 或外部 memory；迁移时要携带 layout、dtype、generation 和 checksum。
4. **写入策略从逐 token 持久化变成更新与快照分离。** recurrent state 在设备侧逐 token 更新，但外部 KVC 按 checkpoint boundary、迁移、抢占或高复用概率异步 snapshot，避免大量小 I/O。
5. **调度目标从命中率变成端到端成本。** 选择器要比较 `load + reshard + replay` 与重新 prefill 的成本，并把质量风险、state 召回失败和副本可用性纳入决策。

可以把未来一次请求的恢复过程抽象为：

```text
精确 prefix KV       ──直接读取──┐
稀疏/压缩 KV          ──选择/重排─┼─> 混合执行
recurrent snapshot    ──恢复/replay┘
长期 memory           ──检索后重新编码（不直接当作 KV 命中）
```

短期内，MLA、KV 量化、分页和 token eviction 仍会是最容易落地的优化；中期更可能普及“局部 attention + 稀疏全局 attention + recurrent state”；长期则是模型显式学习何时写入、更新和遗忘记忆。对 KVC 而言，核心抽象将从“保存所有历史”转向“保存、压缩并读取有价值的历史”。

## 3. 对 KVC 检索的影响

### 3.1 从单一 prefix hash 到多级检索键

传统 prefix cache 的查询键通常可以抽象成：

```text
model + adapter + prefix_token_hash + block_index
```

混合 MLA/KDA 后，建议至少区分三类对象：

```text
TOKEN_KV
  model/config revision
  adapter/LoRA identity
  token prefix hash
  layer/group/cache spec
  block index

RECURRENT_STATE
  model/config revision
  adapter/LoRA identity
  sequence/prefix identity
  state_position
  layer/group
  state layout/dtype version
  generation/checkpoint revision

AUX_METADATA
  model/config revision
  token or state position
  auxiliary tensor kind
  layout/quantization version
```

不能只在原有 token hash 后面增加一个 `cache_role=state` 字段就结束。state 的命中还必须确认位置、state 组成、布局版本和代际信息。

### 3.2 命中判断从“最长前缀”变成“可恢复边界”

普通 KV 的目标通常是找到最长连续命中前缀：

```text
命中 block 0,1,2,3 -> 从 block 4 开始计算
```

KDA/GDN 的目标更接近：

```text
找到 <= 当前 token 位置的最近可用 state boundary
加载完整 state snapshot
从 boundary+1 重放剩余 token
```

因此检索器需要新增以下能力：

- 查询某个序列的可用 state boundary 集合。
- 选择最近边界，而不是简单选择最长 token prefix。
- 判断 state 是否覆盖所有必需 tensor（例如 conv state + recurrent state）。
- 在 state 缺失时估算从哪个更早 snapshot 重放最划算。
- 对不同 cache group 分别计算命中，而不是使用一个全局 hit/miss。

### 3.3 混合模型的命中结果是向量，而不是单个布尔值

Kimi-K3、Qwen3-Next 等混合模型可能同时存在普通 attention/MLA group 和 KDA/GDN group。一次查询应返回类似：

```text
TOKEN_KV group 0: hit through block 31
TOKEN_KV group 1: hit through block 31
RECURRENT_STATE group 2: hit at position 2048
AUX_METADATA group 3: miss
```

调度器不能把它压缩成简单的 `cache_hit=True`。否则容易出现：

- MLA KV 命中，但 KDA state 没命中，却错误跳过 KDA prefill。
- state 命中，但辅助布局/量化元数据缺失，恢复后 shape 或 dtype 不一致。
- 某个 group 的前缀长度不同，导致各层计算边界不一致。

### 3.4 “候选对象”如何查询：不是遍历所有副本

前文使用“候选层”这个说法容易让人误解为需要扫描全库或遍历所有机器。更准确的名称应是 **检索规划阶段**。它的工作不是搜索语义相似的请求，而是：

1. 根据当前请求已经确定的 token prefix，构造有限数量的精确 state key。
2. 批量查询这些 key 是否存在。
3. 对命中的逻辑对象读取其 `ReplicaSet`。
4. 只在少量副本之间比较加载、重排和 replay 成本。

完整关系是：

```text
当前请求的 token IDs
        │
        ▼
计算各 checkpoint boundary 的精确 prefix hash
        │
        ▼
批量查询最近 K 个 LogicalStateKey
        │
        ▼
得到 0..K 个逻辑 state 对象
        │
        ▼
目录服务返回每个对象的 ReplicaSet
        │
        ▼
过滤无效 generation/layout/状态
        │
        ▼
比较 load + reshard + replay 成本
        │
        ▼
选择一个副本，或决定重新计算
```

所以系统不会执行：

```text
遍历集群所有节点
遍历远端存储所有对象
尝试匹配所有请求的 state
```

它只查询一组由当前请求直接推导出的确定 key。

### 3.5 第一级索引：LogicalStateKey

一个逻辑 state key 可以定义为：

```text
LogicalStateKey {
  tenant_id,
  model_revision,
  adapter_identity,
  cache_family,       // KDA / GDN / MAMBA
  group_id,
  state_position,
  prefix_hash,
  state_semantic_version
}
```

这些字段回答的是：

> “哪个模型、哪个 cache group，在处理完哪一段完全相同的 token 前缀后产生的 state？”

它们不包含具体副本地址。相同的逻辑 state 可以在 HBM、DRAM、远端内存或 SSD 中存在多个物理副本。

### 3.6 第二级索引：ReplicaSet

逻辑对象命中后，元数据目录直接返回它的副本集合：

```text
ReplicaSet {
  replica-1: Node A HBM, TP16, layout=HVK, generation=41
  replica-2: Node B DRAM, TP16, layout=HVK, generation=41
  replica-3: Mooncake remote memory, canonical layout, generation=41
  replica-4: SSD, compressed BF16, generation=40
}
```

系统只遍历这个对象的少量副本，通常是个位数，而不是遍历整个集群。目录服务可以由以下任一方式实现：

- 分布式哈希表：`LogicalStateKey -> ReplicaSet`。
- 元数据数据库或 KV Store。
- Mooncake/对象存储的 object metadata。
- 节点本地目录加全局目录的两级缓存。

副本元数据通常包含：

```text
node/tier
object_id 或内存地址
source TP/layout
dtype/compression
generation
owner_epoch
status
checksum
estimated queue/load latency
```

### 3.7 具体例子：查询 position=4096 的 KDA state

假设：

- 当前请求已经有 4096 个 prompt token。
- state checkpoint 间隔为 64 token。
- 最多允许从较早 snapshot 重放 256 token。

调度器只需要考虑最近五个边界：

```text
4096, 4032, 3968, 3904, 3840
```

请求 token 已经在 tokenizer/scheduler 中，因此可以增量得到这些边界的 prefix hash：

```text
H4096 = hash(tokens[0:4096])
H4032 = hash(tokens[0:4032])
H3968 = hash(tokens[0:3968])
H3904 = hash(tokens[0:3904])
H3840 = hash(tokens[0:3840])
```

实际通常采用链式 block hash，而不是每次从 token 0 重新计算：

```text
block_hash[0] = H(model_salt, tokens[0:64])
block_hash[n] = H(block_hash[n-1], tokens[n*64:(n+1)*64])
```

然后构造五个精确 key，并发出一次批量查询：

```text
MULTIGET [
  KDA/group2/position4096/H4096,
  KDA/group2/position4032/H4032,
  KDA/group2/position3968/H3968,
  KDA/group2/position3904/H3904,
  KDA/group2/position3840/H3840
]
```

目录可能返回：

```text
position 4096 -> MISS
position 4032 -> HIT, object O4032, replicas={R1,R2,R3}
position 3968 -> HIT, object O3968, replicas={R4}
position 3904 -> MISS
position 3840 -> HIT, object O3840, replicas={R5,R6}
```

此时才形成有限的恢复候选：

```text
方案 A：从 O4032 恢复，再 replay 64 token
方案 B：从 O3968 恢复，再 replay 128 token
方案 C：从 O3840 恢复，再 replay 256 token
方案 D：不读取 state，重新执行 prefill
```

### 3.8 副本选择的成本模型

对于命中的每个逻辑对象，只比较其 `ReplicaSet` 中可用副本。总成本可以估算为：

\[
T_{total}=T_{metadata}+T_{queue}+T_{load}+T_{reshard}+N_{replay}T_{token}
\]

例如：

| 恢复方案 | 副本位置 | 布局 | 操作 | 预计总成本 |
| --- | --- | --- | --- | ---: |
| O4032/R1 | 本机 DRAM | TP16/HVK | 加载 + replay 64 | 0.79 ms |
| O4032/R2 | 远端 HBM | TP16/HVK | RDMA + replay 64 | 0.89 ms |
| O4032/R3 | SSD | TP8 | 读取、reshard + replay 64 | 2.44 ms |
| O3968/R4 | 本机 DRAM | TP16/HVK | 加载 + replay 128 | 1.38 ms |
| 无缓存 | 无 | 当前布局 | 重新 prefill 4096 token | 20 ms |

最终选择 O4032/R1。虽然它不是 position=4096 的精确 snapshot，但它是当前请求共同 token 前缀上的合法较早边界，总恢复成本最低。

### 3.9 Generation 在查询中的作用

`generation` 不是用来发现 prefix，也不是检索 key 的主要搜索维度。它主要用于命中逻辑对象后的副本过滤和版本提交：

```text
status == COMPLETE
generation 未被更新版本淘汰
owner_epoch 仍合法
所有 entries 和 checksum 完整
```

例如 O4032 返回三个副本：

```text
R1: generation=41, COMPLETE
R2: generation=41, COMPLETE
R3: generation=40, WRITING
```

R3 会被排除；选择器只比较 R1 和 R2。旧 generation 可以保留作历史恢复点，但不能覆盖 `latest_generation`，也不能冒充最新完整副本。

### 3.10 “相似前缀”不参与正确性命中

KDA/GDN state 不能使用向量检索或语义相似度直接复用：

```text
“分析 KDA” 与 “介绍 KDA”
```

即使语义接近，只要 token 序列不同，对应的 recurrent state 就不同。“相似请求、租户热点”等信号最多用于：

- 提前复制或预取热门的精确 prefix 对象。
- 判断某个 snapshot 是否值得进入远端缓存。
- 调整副本数量和存储层级。
- 优化元数据索引的缓存热度。

真正恢复时仍必须满足：

```text
精确 token prefix hash
+ 精确 state boundary
+ 精确 model/adapter/cache family/spec
+ 合法完整的 generation
```

因此，“候选对象筛选”的本质不是模糊搜索，而是对 **最近有限个精确 checkpoint key** 做批量查询，再对命中对象的少量副本做成本选择。

## 4. 对 KVC 传输的影响

### 4.1 传输对象需要携带语义

当前很多 KV transfer 路径本质上是：

```text
key -> remote object -> raw bytes -> destination buffer
```

对于 KDA/GDN，object descriptor 至少需要包含：

| 字段 | 作用 |
| --- | --- |
| `semantic_role` | `TOKEN_KV`、`RECURRENT_STATE`、`AUX_METADATA` |
| `payload_kind` | main KV、indexer、scale、conv state、recurrent state 等 |
| `model_revision` | 防止不同模型结构或权重混用 |
| `layer/group` | 区分混合注意力组和 layerwise 对象 |
| `state_position` 或 `token_begin/end` | 描述恢复边界 |
| `source_layout` | 源 TP/DP/DCP/PCP、head 组织、stride、dtype |
| `target_layout` | 目标执行侧需要的布局 |
| `generation` | 防止读取正在更新的旧/半成品状态 |
| `checksum/entry_count` | 校验多 tensor snapshot 是否完整 |

### 4.2 raw-byte transfer 的适用范围下降

同 TP、同 dtype、同 layout 的普通 KV 仍然适合高性能 raw-byte 搬运。问题主要出现在：

- P/D 使用不同 TP 或不同 head 分片。
- MLA、KDA、GDN、Mamba 等 cache family 混合。
- layerwise KV 或每层不同 block size。
- sparse KV、压缩 KV、量化 KV。
- 源端保存的是完整 state，目标端只需要某些 TP slice，或反之。

这类场景需要从“字节拷贝”升级为 **canonical representation + reshard/scatter/gather**：

```text
source local layout
        │
        ▼
canonical logical object
        │
        ▼
target TP/DP/layout representation
```

canonical representation 不一定要物理 materialize 成完整大 tensor，也可以通过 manifest 描述逻辑分片和映射关系。但协议必须明确逻辑对象是什么，不能只记录源 buffer 的地址和长度。

### 4.3 state 传输粒度会变大，但频率会降低

普通 KV 适合细粒度 token block 传输；KDA state 更适合：

- recurrent layer group。
- 固定 checkpoint interval。
- 请求迁移时的完整 state bundle。
- prefill/decode 边界的 snapshot。

如果每生成一个 token 就把 KDA state 写回远端，会产生明显的小 I/O、同步和一致性成本。因此趋势是：

- 本地 HBM 中频繁更新。
- 在稳定边界批量 snapshot。
- 通过异步、压缩或增量日志降低远端写放大。
- 只有请求迁移、长时间挂起、显存压力或高复用概率时才提升 snapshot 优先级。

### 4.4 state 需要原子提交协议

一个 KDA snapshot 往往包含多个 tensor。建议采用类似以下状态机：

```text
ALLOCATED
   │
   ▼
WRITING  ──(任一 entry 失败)──► ABORTED
   │
   ├─ 写 conv_state
   ├─ 写 recurrent_state
   ├─ 写 manifest/checksum
   │
   ▼
COMPLETE
```

消费者只能读取 `COMPLETE` 对象，并校验：

- 所有必需 entry 都存在。
- state position 与请求边界一致。
- generation 没有过期。
- layout、dtype、shape 与本地 cache spec 一致。

### 4.5 传输趋势：从同构 P2P 到异构 reshard

未来 P/D 分离不再只需要“Prefill rank 把 KV 发给 Decode rank”。更常见的是：

- Prefill 侧使用 TP16，Decode 侧使用 TP8 或不同 DP 组。
- 不同节点使用不同 cache group 排布。
- MLA 与 KDA 状态的传输路径和生命周期不同。
- 一个请求迁移时同时搬运 token KV、recurrent state 和辅助元数据。

因此 KV Transfer API 需要逐步增加：

- capability negotiation。
- source/target layout descriptor。
- 逻辑对象到物理 shard 的映射。
- group-level partial success。
- state snapshot 的原子提交和失败重试。

## 5. 对 KVC 管理和调度的影响

### 5.1 从 BlockPool 到 Hybrid Cache Coordinator

传统 `BlockPool` 主要负责：

- block 分配和释放。
- 引用计数。
- prefix 命中和 eviction。
- token slot 映射。

混合模型需要更上层的 coordinator，统一协调：

```text
TOKEN_KV manager
RECURRENT_STATE manager
AUX metadata manager
        │
        ▼
Hybrid Cache Coordinator
        │
        ├── scheduler visibility
        ├── admission/eviction
        ├── local HBM budget
        ├── remote tier placement
        └── transfer/recompute decision
```

vLLM 已经通过不同 `KVCacheSpec`、hybrid group 和 manager 抽象朝这个方向发展。后续 KDA/GDN 会迫使这类抽象从“兼容几种 spec”进一步演进为“显式管理不同语义对象”。

### 5.2 eviction 策略从 LRU 变成成本感知

普通 KV 的 eviction 可以较多依赖 LRU、引用计数和 prefix 热度。state eviction 需要增加：

- 从更早 state 重放需要多少 token。
- state snapshot 的恢复延迟和大小。
- 该请求是否即将迁移或继续 decode。
- state 是否可由本地其他副本重建。
- 该 snapshot 是否是多个后续请求的共享边界。
- 远端读取成本与重新 prefill 成本的比较。

一个实用的优先级模型可以写成：

```text
保留价值 ≈ 预计复用次数 × 重算成本
          - HBM 占用成本
          - 远端写入/恢复成本
```

未来更可能是分层策略：

- 热的当前 state：留在 HBM。
- 可能复用的 boundary snapshot：异步下沉到本机 DRAM/远端内存。
- 低复用、重算便宜的 state：直接驱逐。
- 跨请求共享的稳定前缀：提高优先级并保留更长时间。

### 5.3 调度单元从 token block 变成可恢复计算段

对普通 attention，可以按 token block 调度 prefill 和 decode。对 KDA/GDN，调度器还需要知道：

- 当前请求拥有哪个 state snapshot。
- state 对应哪个位置。
- 从该位置到当前 token 还需重放多少 token。
- 哪些层的 state 已就绪，哪些层仍在传输。
- state load 与后续 recurrent kernel 是否可以流水重叠。

因此未来调度单元更接近：

```text
可执行段 = token range + required TOKEN_KV + required RECURRENT_STATE
```

这会影响 `num_batched_tokens`、prefill chunk size、continuous batching 和请求迁移策略。

### 5.4 partial hit 需要变成一等公民

混合模型很难保证所有 group 同时命中。调度器应支持：

- 普通 KV 命中、state 未命中：只对 KDA 层重放，或从更早边界恢复。
- state 命中、普通 KV 未命中：按模型语义决定是否仍需补齐 attention KV。
- 某些 layer 命中、其他 layer 未命中：按 layerwise 计划执行。
- 远端 state 正在传输：先调度可独立执行的计算，等待依赖 ready event。

这比传统的全命中/全未命中二元状态机复杂得多，但能显著减少不必要的全量重算。

## 6. 对各类组件的直接影响

| KVC 组件 | 近期需要变化 | 中期趋势 |
| --- | --- | --- |
| Key/索引服务 | 增加 role、group、position、layout、generation 字段 | 统一的 typed object descriptor 和多级索引 |
| 本地 HBM manager | 同时分配 token block 和 state page | 按 cache family 分池、统一 budget、成本感知 eviction |
| Prefix cache | 支持普通 block 连续命中 | 支持 boundary snapshot、partial hit、state-aware replay |
| Mooncake/远端内存 | 支持 state object 独立 key 和完整 bundle | 支持异构布局协商、reshard、RDMA/NPU IPC 混合路径 |
| AscendStore | 补齐 state buffer 注册、读写和恢复数据面 | 形成 `TOKEN_KV/RECURRENT_STATE/AUX` 统一对象模型 |
| KV Transfer | 从同构 raw bytes 复制起步 | canonical representation、拓扑感知和 group 级传输计划 |
| Scheduler | 处理 hybrid group 的 mask 和 block table | 依据恢复成本选择 load、recompute 或 replay |
| 监控系统 | 统计 KV hit、传输带宽、延迟 | 分别统计 state hit、snapshot size、replay tokens、恢复失败率 |
| 一致性协议 | 主要防止 block 丢失或重复 | generation fence、原子 snapshot、checksum、COW |

## 7. 对当前 vLLM-Ascend/KVC 实现的具体判断

根据当前代码和已有调研，vLLM-Ascend 在 **hybrid spec、group 管理、SWA/Mamba 语义、KDA/GDN 内核执行** 方面已经有基础，但远端 recurrent state 数据面仍需谨慎判断。

### 已具备的基础

- KDA chunk prefill 和 recurrent decode 算子。
- Kimi-K3 的 hybrid MLA/KDA 模型适配。
- vLLM hybrid cache spec、group 和 manager 抽象。
- 对 Mamba/state 类对象的 boundary、truncate 和 cache mode 语义已有讨论或实现基础。
- `cache_role=state` 等接口为 state 逻辑隔离预留了位置。

### 不能直接假设已经完成的能力

- `cache_role=state` 不等于远端 SSD/NoF 已能自动保存并恢复 KDA state。
- 普通 KV 的 block hash 不能直接充当 state snapshot key。
- 同 TP raw-byte transfer 不能覆盖不同 TP、MLA、hybrid、sparse、layerwise 的通用重排。
- KDA state 不能只恢复某一个 tensor；conv state、recurrent state 和辅助信息必须满足完整恢复合同。
- 公开 PR 或设计文档中的拟议支持，不等于当前 release 已经通过目标硬件验证。

## 8. 建议的目标架构

### 8.1 统一对象模型

建议在 KVC 内部把缓存对象显式建模为：

```text
CacheObject {
  semantic_role: TOKEN_KV | RECURRENT_STATE | AUX_METADATA
  payload_kind: MAIN_KV | INDEXER | SCALE | CONV_STATE | RECURRENT_STATE | ...
  model_revision
  adapter_identity
  layer_id / group_id
  token_range or state_position
  source_layout
  target_layouts
  dtype / quantization
  generation
  checksum
  readiness_state
}
```

### 8.2 两条独立但可协调的数据面

```text
Token-KV data plane
  token prefix -> block lookup -> block transfer -> attention cache

Recurrent-state data plane
  boundary -> snapshot lookup -> atomic state transfer -> initial_state
```

两条数据面可以共享：

- 元数据服务。
- 容量预算。
- 传输引擎。
- 调度器的依赖图。

但不应共享完全相同的命中、拼接、更新和一致性语义。

### 8.3 Manifest 与 payload 分离

建议把一个 state snapshot 分成：

```text
manifest
  state_position
  required entries
  shapes/strides/dtype
  generation
  checksum

payload
  conv_state
  recurrent_state
  optional auxiliary tensors
```

这样可以先做轻量级 manifest lookup，再决定是否传输较大的 payload；也便于失败重试和跨设备 layout 转换。

## 9. 未来两到三阶段趋势

### 阶段一：混合缓存可用化

重点是保证正确性：

- 明确区分 `TOKEN_KV` 与 `RECURRENT_STATE`。
- 支持 KDA/Mamba state 的本地分配、释放、boundary 命中和恢复。
- 为 state 增加完整性校验和 generation fence。
- 支持 hybrid 模型的 partial hit。

此阶段性能可能不是最优，但首先要避免“MLA 命中、KDA state 未命中却错误继续”的一致性问题。

### 阶段二：异构并行与高效传输

重点是 P/D 和多机异构布局：

- source/target TP mismatch。
- layerwise、sparse、MLA、KDA 混合对象的 canonical descriptor。
- state snapshot 的异步批量传输。
- NPU IPC、RDMA、远端内存和本地 DRAM 的分层路径。
- transfer 与 prefill/recurrent compute 的流水重叠。

### 阶段三：统一推理状态平台

重点是全局资源优化：

- 由统一 coordinator 管理 token KV、recurrent state、MoE/索引辅助状态。
- 使用请求热度、重算成本和迁移概率做 admission/eviction。
- 根据负载自动决定保存 snapshot、远端下沉还是直接重算。
- 以“可恢复计算段”而不是“缓存 block 数量”作为调度和容量指标。

## 10. 需要重点监控的新指标

仅看 KV cache hit rate 已经不够，建议增加：

| 指标 | 含义 |
| --- | --- |
| `token_kv_hit_rate` | 普通 token KV 命中率 |
| `recurrent_state_hit_rate` | state boundary 命中率 |
| `hybrid_full_hit_rate` | 所有必需 group 都命中的比例 |
| `partial_hit_rate` | 只有部分 group 命中的比例 |
| `state_snapshot_bytes` | state 快照大小 |
| `state_restore_latency` | state 恢复延迟 |
| `replay_tokens` | 因 state 缺失而重放的 token 数 |
| `state_transfer_retry_rate` | state 传输重试率 |
| `incomplete_snapshot_rate` | 不完整快照比例 |
| `generation_conflict_rate` | 代际冲突或陈旧状态读取比例 |
| `remote_read_amplification` | 为一个 state 恢复读取的额外字节量 |
| `recompute_vs_load_cost` | 重算和远端加载的实际成本对比 |

其中最有价值的两个运营指标通常是：

1. `recurrent_state_hit_rate`：判断 state 缓存是否真的产生收益。
2. `replay_tokens`：衡量 state miss 对端到端延迟和算力的实际影响。

## 11. 对产品和架构决策的建议

### 如果目标是 Kimi-K3 / KDA 线上部署

- 先把 KDA state 当作独立 cache family 管理，不要把它直接塞进普通 KV block 表。
- 优先保证本地 HBM state 的生命周期和请求迁移正确，再做远端持久化。
- 远端传输先支持同构布局和完整 snapshot，再扩展 TP mismatch/reshard。
- Prefix Cache 评估必须同时报告 token KV 命中和 recurrent state 命中。
- DSpark、请求迁移、Prefix Cache 三者叠加时，重点验证 state 回滚和 generation fencing。

### 如果目标是通用 KVC 平台

- API 层面尽早采用 typed cache object，而不是继续假设所有对象都是 KV block。
- 把 `semantic_role`、`payload_kind`、`position`、`layout`、`generation` 设计为一等字段。
- 把“load / recompute / replay”统一纳入调度决策。
- 把 state 的一致性协议独立出来，不要依赖普通 KV 的 append-only 假设。
- 设计可插拔的 reshard planner，为未来不同 TP、DCP、量化和 cache family 组合留接口。

## 12. 最终结论

KDA/GDN 对 KVC 的最大影响，不是缓存字节数减少，而是**缓存语义发生变化**：

- 从 token 级历史 K/V，扩展到 token KV、recurrent state、辅助元数据三类对象。
- 从最长前缀检索，扩展到精确 boundary snapshot 检索和 partial hit。
- 从同构 raw-byte 传输，扩展到带 layout、generation 和一致性合同的异构传输。
- 从 LRU + block refcount 管理，扩展到 state 生命周期、COW、原子提交、重放和成本感知驱逐。
- 从 KV 带宽优化，扩展到 load、recompute、replay 的端到端决策。

趋势可以概括为：

> **KVC 将从 KV Cache 管理器，演进为面向混合注意力模型的统一推理状态管理平台。**

## 13. 关联资料

- `./kda-gdn-vllm-ascend-support-report.md`
- LMCache、AscendStore、Mooncake 对比 —— `./lmcache-ascend-vs-ascendstore-mooncake-kvc-comparison.md`
- `./vllm-ascend-mooncake-ascend-call-path.md`
- [MoonshotAI Kimi Linear](https://github.com/MoonshotAI/Kimi-Linear)
- [Gated Delta Networks 论文](https://arxiv.org/abs/2412.06464)
- [vLLM-Ascend Kimi-K3 部署指南](https://github.com/vllm-project/vllm-ascend/blob/main/docs/source/tutorials/models/Kimi-K3.md)
