---
section: know-how
summary: 从一个容量公式、逐因子下刀，扩展到对象语义、生命周期成本与端到端闭环的系统优化方法：两张账（静态容量与全生命周期成本）、七类优化方法、六个基本变换，以及一套八步可执行流程和快速检查清单。
---

# KV Cache 公式驱动的优化方法论

> 从“一个容量公式、逐因子下刀”，扩展到“对象语义、生命周期成本和端到端闭环”的系统优化方法。

> **关于文中的引用。** 正文与第 11 节里的 `xxx.md:行号` 指向当前工作区里的同名报告，行号是那些
> 本地副本的行号。其中已经上线的几篇（`position-independent-kv-cache-report`、
> `vllm-ascend-dsa-kv-lmcache-analysis`、`deepseek-v4.1-reuse-group-layer-chunk-scheduling`）
> 可以在本站「联动分析」里按名字找到；其余尚未上线。

## 0. 文档信息

- 整理日期：2026-09-19
- 外部材料：[《KV Cache - 一文读懂 Attention 优化——一个公式，五刀砍尽 KV Cache》](https://mp.weixin.qq.com/s/RS_mjTcv7xIVQVHNtWCMeQ)
- 本地材料范围：当前工作区顶层 KV/KVC 分析报告，以及它们引用的 vLLM、vLLM-Ascend、LMCache、Mooncake 本地审阅仓库。
- 本地审阅仓库快照：vLLM `568afb3a1380`、vLLM-Ascend `4c5ee33208b6`、LMCache `05a013b29da7`、Mooncake `e389a85093cb`。
- 限定：本文总结的是**优化问题的分析方法**，不是对某个线上 workload 的最终选型，也不是一次新的逐行源码审计。

证据标签：

- **文章观点**：来自微信公众号文章的归纳。
- **本地结论**：来自当前工作区已有报告及其中的源码证据。
- **方法论归纳**：在两类材料基础上抽象出的通用方法。

## 1. 核心结论

这篇文章真正有价值的地方，不只是列出了 GQA、MLA、滑动窗口、CLA 和 FlashAttention，而是展示了一种可迁移的优化方法：

> 先把资源成本写成公式，再将公式拆成相互独立的因子，逐项寻找冗余，最后验证各项优化能否组合，以及代价是否转移到了别处。

文章完成的是第一层：**对 KV Cache 静态容量做因子分解**。本地材料进一步说明，真实推理系统还必须补上第二层：**对 KV 的完整生命周期做成本分解**。

因此，可以把 KV 优化的指导思想浓缩为七个问题：

1. **缓存的对象是什么？** 是普通 token KV、MLA latent、稀疏 indexer、recurrent state，还是其他辅助状态？
2. **为什么要保存它？** 是为了当前 decode、跨请求复用、P/D 传输、迁移恢复，还是故障恢复？
3. **保存多少？** 能否减少层、头、维度、token、精度、副本或 padding？
4. **保存在哪里？** HBM、Host DRAM、远端内存和 SSD 应如何分层？
5. **什么时候移动？** 能否按页、按层、按需、异步、预取并与计算重叠？
6. **是否值得复用？** 加载、转换、修复和重放的总成本是否真的小于重算？
7. **如何证明有效？** 质量、TTFT、TPOT、吞吐、容量、字节数和失败回退是否同时达标？

这套方法不是“看到 KV 大就压缩”，而是从**成本模型 → 冗余定位 → 变换选择 → 约束检查 → 组合优化 → 端到端验证**形成闭环。

## 2. 一页总览：从公式到优化闭环

```text
业务目标
  ├─ 更大并发 / 更长上下文 / 更低 TTFT / 更稳 TPOT / 更低成本
  ▼
定义对象与语义
  ├─ TOKEN_KV
  ├─ COMPRESSED / SPARSE KV + INDEXER + SCALE
  ├─ RECURRENT_STATE
  └─ AUX_METADATA
  ▼
建立两张账
  ├─ 静态容量账：保存了多少字节、几份副本、多少无效空间
  └─ 动态时间账：生成、查询、加载、转换、修复、等待、失败各花多久
  ▼
定位主导项
  ├─ 数据太多：少生成、少保留、低精度、去副本、去 padding
  ├─ 复用太少：prefix → chunk → layer/group → cross-model
  ├─ 放置不对：HBM → DRAM → remote memory → SSD
  ├─ 搬运太贵：批量、直接访问、异步、预取、流水、融合
  ├─ 等待太多：cache-aware scheduling、delay-hit 去重、backpressure
  └─ 恢复太贵：load / reshard / replay / recompute 动态决策
  ▼
检查正确性边界
  ├─ model / adapter / RoPE / layout / dtype / TP / generation
  ├─ 原子发布、COW、fencing、ready/done 生命周期
  └─ miss、超时、部分失败时可安全回退重算
  ▼
端到端验证
  ├─ 质量 SLO
  ├─ TTFT / TPOT / JCT / 吞吐
  ├─ HBM / DRAM / SSD / network bytes
  └─ stall、重放比例、失败与回退率
```

图中的关键不是“优化手段很多”，而是优化顺序：**先确认对象和语义，再算容量和时间；先找主导成本，再选择变换；最后用端到端指标确认瓶颈没有被转移。**

## 3. 第一张账：静态容量公式

### 3.1 文章中的基础公式

对传统 MHA/GQA 模型，单请求 KV Cache 的理论容量可以写成：

\[
M_{KV}=2 \times L \times T \times H_{KV} \times D_{head} \times S_{dtype}
\]

其中：

- `2`：K 和 V 两份状态；
- `L`：保存 KV 的层数；
- `T`：保留的 token 数；
- `H_KV`：KV head 数；
- `D_head`：每个 head 的维度；
- `S_dtype`：每个元素的字节数。

考虑并发、物理副本和内存管理开销后，更接近系统真实占用的写法是：

\[
M_{physical}
=N_{req}\times M_{KV}\times R_{copy}
+M_{padding}+M_{metadata}+M_{workspace}
\]

这一步非常重要：文章公式描述的是**逻辑 payload**，而线上 OOM 发生在**物理占用**。分页尾部、统一 page padding、对齐、重复 view、TP 复制、临时 staging 和 kernel workspace 都可能使二者不同。

公式还提供了数量级校验能力。例如文章正文提到“每 token 512 KB”，那么 `1M token × 512 KB` 应约为 `512 GB`，不是 `500 MB`。优化方法论的第一条纪律，就是让每个容量结论都能被公式复算。

### 3.2 “五刀”本质上是逐因子消元

| 优化方向 | 被改变的因子或成本 | 代表方法 | 本质动作 | 主要约束 |
| --- | --- | --- | --- | --- |
| 减少 KV 头 | `H_KV` | MQA、GQA | 多个 Q head 共享 KV | 通常是模型架构决策 |
| 减少保存维度 | `H_KV × D_head` | MLA、低秩表示 | 只保存可恢复的 latent | 需要模型/算子适配，可能有信息损失 |
| 减少 token 数 | `T` | SWA、eviction、稀疏保留 | 只保留窗口或重要历史 | 远距离依赖和召回质量 |
| 减少独立层数 | `L` | CLA、跨层共享 | 多层复用同一份状态 | 模型训练和层间相关性 |
| 减少元素字节 | `S_dtype` | FP8、INT8、INT4、2-bit | 量化 KV 或 snapshot | scale 开销、解码成本和精度 |
| 减少物理副本 | `R_copy` | MLA rank 去重、共享 backing | 不重复保存等价数据 | 并行拓扑和本地读取要求 |
| 减少无效空间 | `M_padding` | 紧凑 layout、按 plane 精确打包 | 不搬 padding、不重复 view | layout/stride/alias 正确性 |
| 减少数据搬运 | 动态 I/O，不直接改变容量 | FlashAttention、融合 kernel | 提高数据局部性，避免中间往返 | 算子和硬件相关 |

这张表体现了文章的核心 know-how：**找到乘法项就做比例缩减，找到加法项就消除固定开销，找到重复项就共享或去重。**

### 3.3 公式必须随模型结构升级

本地材料表明，现代模型已经不能统一简化成一块规则的 `[layer, token, K/V, head, dim]`：

- DSV4 可能同时包含 SWA KV、主压缩 KV、indexer K、scale 和未完成压缩组的 state；`vllm-ascend-dsa-kv-lmcache-analysis.md:1070`。
- GLM5Next 是 MLA、压缩 indexer、incomplete-pool state 与 KDA/Mamba 的混合结构；`vllm-ascend-dsa-kv-lmcache-analysis.md:1093`。
- KDA/GDN 保存的是序列边界上的递归状态，不是可任意拼接的 token KV；`kda-gdn-kvc-evolution-impact-report.md:38`。

因此，更通用的容量模型应按 cache group/plane 求和：

\[
M_{cache}=N_{req}\times
\sum_g
\left(
L_g\times R_g(T)\times D_g\times S_g\times C_g
\right)
+M_{overhead}
\]

其中 `R_g(T)` 表示原始 token 到该 plane 物理 row 的映射。例如未压缩 plane 可能是 `T` 行，C4 是约 `T/4` 行，C128 是约 `T/128` 行；副本数 `C_g` 也可能因 TP/DCP 语义不同而不同。

这引出一个更普遍的规则：

> 不要对“模型名”做优化，要对具有明确语义、几何形状、生命周期和恢复条件的 cache object 做优化。

### 3.4 算例：DeepSeek-V4.1-Flash 的 hybrid cache

对于 DSV4.1 这类 hybrid 模型，传统公式中的 `L`、`T` 和 `D` 都不再只有一个取值：有些层独立产生 global KV，有些层复用 source layer；不同 plane 采用不同压缩率；SWA 与 compressor state 又是有界状态。因此可以把前面的求和公式展开为：

\[
M_{hybrid}(T)
=
\sum_g
L_g^{\mathrm{source}}
\times
\left\lceil\frac{T_g}{r_g}\right\rceil
\times B_g^{\mathrm{row}}
+\sum_s N_sB_s^{\mathrm{state}}
+M_{overhead}
\]

其中：

- `g` 表示 main KV、indexer K/scale、SWA KV 等 cache plane；
- `L_g^source` 是真正独立产生该缓存的 source layer 数，而不是模型总层数；
- `T_g` 是该 plane 保留的 token 数，全局缓存为 `T`，滑动窗口为 `min(T, W_g)`；
- `r_g` 是一条物理 row 代表的原始 token 数，例如 C2、C4、C128；
- `B_g^row` 是一条 row 的 payload，包括 value、RoPE 和 scale；
- `N_sB_s^state` 是 compressor ring、未完成压缩组等 request-local 有界状态。

DSV4.1 的官方配置有四个 Full/KV-source layer：`2、8、14、20`。前三份 global KV 使用 C2，最后一份使用 C1，其余 consumer layer 复用这些 source cache；`vllm-ascend-dsa-kv-lmcache-analysis.md:558`。

主 KV 使用 512-channel E2M1 FP4，每 16 channel 保存一个 1-byte scale：

\[
B_{main}^{\mathrm{row}}
=\frac{512}{2}+\frac{512}{16}\times1
=256+32
=288\text{ B}
\]

Indexer K 使用 128-channel MXFP4，每 32 channel 保存一个 1-byte scale：

\[
B_{indexer}^{\mathrm{row}}
=\frac{128}{2}+\frac{128}{32}\times1
=64+4
=68\text{ B}
\]

将 source layer 数和压缩率代入：

\[
\begin{aligned}
B_{\mathrm{global/token}}
&=3\times\frac{288+68}{2}
+1\times\frac{288+68}{1}\\
&=534+356\\
&=890\text{ B/token}
\end{aligned}
\]

所以随上下文长度线性增长的逻辑 global KV 为：

\[
M_{global}(T)=890\times T\text{ bytes}
\]

例如 `1M` token 的 global KV payload 约为 `0.89 GB`，即 `0.83 GiB`。这个数字体现了两项结构优化的叠加：**只让四个 source layer 保存 global KV，以及将其中三份 cache 按 C2 存储。** 详细拆解见 `vllm-ascend-dsa-kv-lmcache-analysis.md:546`。

但 `890 B/token` 不是单请求的完整物理显存。更完整的账应写成：

\[
M_{single}(T)
=890T
+\sum_l\min(T,W_l)B_{\mathrm{SWA},l}^{\mathrm{row}}
+M_{\mathrm{compressor\ state}}
+M_{\mathrm{page/padding}}
+M_{\mathrm{metadata/workspace}}
\]

其中 global KV 随 `T` 线性增长；每层 SWA 只保留固定窗口，compressor ring state 也是有界的。官方 `890 B/token` 不包含这些项目，也不包含 allocator 对齐和 page padding；`vllm-ascend-dsa-kv-lmcache-analysis.md:556`。

落到某个推理引擎和设备时，还要按物理 page 计算：

\[
M_{physical}
=\sum_g
\left\lceil
\frac{\left\lceil T_g/r_g\right\rceil}{P_g}
\right\rceil
\times PageBytes_g
\times C_g
+M_{\mathrm{state/workspace}}
\]

`P_g` 是每个 page 的物理 row 数，`PageBytes_g` 已包含实际 stride/padding，`C_g` 是 TP/DCP 下的副本因子。main KV 可能按 DCP 切分，而 indexer K/scale 可能在每个 DCP rank 上复制，因此全模型的 `890 B/token` 不能直接当成单卡实际显存。vLLM-Ascend 也分别计算 main cache 的物理 row 和 indexer cache 的独立 page；`vllm-ascend-review/vllm_ascend/core/kv_cache_interface.py:94`、`vllm-ascend-review/vllm_ascend/core/kv_cache_interface.py:184`。

这个例子说明，hybrid 模型的公式化方法仍然没变，只是“逐因子下刀”升级成了“逐 cache object 分账”：

```text
模型总层数 L
  → 独立 KV source 数 L_source
  → 每个 plane 的保留长度 T_g
  → token 到物理 row 的压缩率 r_g
  → 每条 row 的 payload 与 page stride
  → 每种 state、副本和固定开销
```

## 4. 第二张账：全生命周期成本公式

容量公式能回答“占多少”，却不能回答“为什么命中了反而更慢”。本地材料把问题扩展为四层：复用语义、容量与层级、搬运与执行、调度与恢复；`llm-context-kv-cache-paper-report.md:20`。

一次缓存复用的可见成本可以近似写成：

\[
T_{reuse}=
T_{lookup}+T_{queue}+T_{load}+T_{transfer}
+T_{transform}+T_{repair}+T_{replay}+T_{wait}
\]

只有满足以下条件，复用才是优化：

\[
T_{reuse}<T_{recompute}
\quad\land\quad
Quality_{reuse}\ge Quality_{SLO}
\]

或者写成净收益：

\[
Gain=T_{avoided\_compute}-T_{reuse}>0
\]

这比单独看 cache hit rate 更可靠。一个“命中”可能需要远端读取、解压、reshard、re-RoPE、scatter 和部分重算；如果这些成本大于 full prefill，它只是统计命中，不是性能收益。已有本地结论也明确把上线门槛定义为“质量不低于目标 SLO，且端到端成本低于 full prefill”；`position-independent-kv-cache-report.md:342`。

对于 recurrent state，副本选择可以进一步写成：

\[
T_{restore}=T_{metadata}+T_{queue}+T_{load}+T_{reshard}
+N_{replay}T_{token}
\]

因此最新的 checkpoint 未必最优：较早但位于本机 DRAM、无需 reshard 的 snapshot，可能比远端最新 snapshot 更快；`kda-gdn-kvc-evolution-impact-report.md:352`。

## 5. 从本地材料归纳出的七类优化方法

### 5.1 方法一：先减少“生成和保存的数据”

这是文章“五刀”的直接延伸，目标是让缓存从源头变小。

可用动作：

- 头共享：MHA → GQA/MQA；
- 低秩表示：完整 KV → MLA latent；
- 局部/稀疏化：完整历史 → SWA 或 top-k 历史；
- 跨层共享：每层独立 → layer group 共享；
- 低精度：BF16/FP16 → FP8/INT8/更低 bit；
- 压缩 row：原始 token row → C4/C128 等 cache-domain row；
- 不保存不可独立恢复的中间态，或只在完整边界保存。

本地材料进一步给出两条工程化原则：

1. **保存粒度应由恢复语义决定。** recurrent state 只在 checkpoint boundary 保存，而不是逐 token 外存；逐 token 写入会产生明显写放大。建议保存可复用边界，miss 时从最近 checkpoint 重放；`kda-gdn-kvc-update-and-memory-analysis.md:281`。
2. **设备计算精度与外部 snapshot 精度可以不同。** 外部 state 可尝试 BF16/FP16、FP8/INT8 或低秩 delta，但递归误差可能持续累积，必须做长序列质量回归；`kda-gdn-kvc-update-and-memory-analysis.md:293`。

适用判据：容量或带宽确实由 payload 主导，而不是 metadata、固定 RTT、调度等待或临时 workspace 主导。

### 5.2 方法二：扩大“可复用”的边界

减少容量回答的是“每份缓存多大”，提高复用回答的是“这份缓存能替代多少重复计算”。本地材料归纳出一条逐步放宽的复用阶梯：

```text
相同模型、完整连续 prefix
  → schema 约束的模块复用
  → 同模型非前缀 chunk
  → token/layer 级选择性修复
  → 同架构跨模型 KV
  → 带 translator 的跨模型状态
```

不同阶梯的 correctness 来源不同：

- exact prefix 依靠完整 causal history 一致；
- 任意 chunk 需要内容指纹、位置校正和选择性重算；
- 跨模型复用需要 critical layer profile 或 translator；
- 语义结果缓存不等价于 Transformer KV 命中。

`position-independent-kv-cache-report.md:88` 将任意位置复用拆成四层能力：内容身份、位置迁移、上下文修复和系统执行。这个分解很关键，因为 re-RoPE 只能修正显式位置，不能修复前序上下文变化造成的 hidden state 差异。

适用判据：

\[
SavedFLOPs > LoadBytes/BW + Transform + RepairFLOPs + Scatter
\]

同时，cache key 必须纳入 model revision、tokenizer、adapter、RoPE、layout、dtype、量化方式、并行分片和 layer group；否则“扩大复用”会退化成 silent corruption。

### 5.3 方法三：把缓存放到合适的层级

当 HBM 容量不足时，优化不一定是继续压缩，也可以把缓存分层放置：

```text
HBM              当前请求、热 KV、每步高频访问状态
Host DRAM        可预取的 warm prefix、全量 sparse KV 权威副本
远端内存         跨实例复用、高价值共享对象、迁移恢复
SSD              冷对象、大容量低频 snapshot
重算             低复用且加载成本高于重算的对象
```

本地材料把保留价值写成：

```text
保留价值 ≈ 预计复用次数 × 重算成本
          - 容量占用成本
          - 写入与恢复成本
```

因此 eviction 不应只依赖 LRU，而应比较对象热度、重算成本、远端恢复成本、共享程度和迁移概率；`kda-gdn-kvc-evolution-impact-report.md:555`。

层级化还意味着：

- 热数据留在更近层级；
- 冷数据下沉，但不承诺命中一定优于重算；
- metadata 与 payload 可以分离；
- 一个逻辑对象可以有多个不同位置、布局和精度的物理副本；
- 选择副本时比较 load、reshard、replay 和排队成本，而不是永远取“最近 generation”。

### 5.4 方法四：减少搬运，而不只是减少存储

搬运优化可以分成四级：

1. **少搬：** sparse top-k recall、只搬有效 row、去掉重复 view、TP 去副本；
2. **大块搬：** page-close flush、批量 multi-buffer I/O、合并小请求；
3. **边算边搬：** prefetch、双 buffer、layerwise pipeline、producer/consumer warp；
4. **不搬或少一次搬：** zero-copy/direct access、projection-attention fusion、共享 backing。

本地报告给出的 layerwise 关键路径是：

\[
T_{layerwise}\approx\sum_i\max(C_i,R_i+S_i)+\sum_iG_i
\]

其中 `C_i` 是本层计算，`R_i+S_i` 是读取和发送，`G_i` 是无法隐藏的等待；`vllm-ascend-layerwise-sparse-delay-pull-analysis.md:233`。

这说明 layerwise 的收益不是“传输消失了”，而是把容量峰值降下来，并让传输落入计算窗口。若传输已经完全被覆盖，再细化 scheduler 通常只会增加状态机、graph 和 batching 开销；`deepseek-v4.1-reuse-group-layer-chunk-scheduling.md:290`。

适用判据：

- timeline 中存在可稳定覆盖的通信空洞；
- 合批后能够显著提高有效带宽或摊薄固定 RTT；
- buffer 生命周期、ready/done event 和 slot reuse 有严格定义；
- 移除 staging 后，慢速链路没有被 attention 重复读取放大。

### 5.5 方法五：优化物理布局与表示

逻辑 tensor 小，不代表物理传输小。本地 DSA/MLA 分析暴露了几类常见浪费：

- 统一 page size 导致的 padding；
- 多 plane 按逻辑 token 数预留，而有效 row 已按 C4/C128 压缩；
- 多个 tensor view 实际指向同一 backing，却被当成多份 payload；
- transport 逐 tensor 注册，重复注册相同 storage；
- 计算友好 layout 与传输友好 layout 不一致，产生额外 pack/unpack；
- 临时 staging 占用额外 HBM/DRAM 并增加一次拷贝。

`vllm-ascend-dsa-kv-lmcache-analysis.md:1544` 明确指出，overlapping full view 如果逐 tensor 盲拷贝，会重复保存同一 backing；`vllm-ascend-dsa-kv-lmcache-analysis.md:1964` 则说明压缩比可能只体现在有效拷贝量，而没有体现在申请量。

因此布局优化应同时回答：

- logical row、physical row、page、allocation 和 storage view 的关系是什么？
- payload bytes、reserved bytes、registered bytes、transferred bytes 是否一致？
- stride、offset、alignment 和 alias 是否进入描述符？
- CPU/SSD 是否需要 page-first layout，device 是否需要 layer-first layout？
- 转换能否融合到传输 kernel，而不是增加独立 copy？

这类优化经常没有新算法，却可能直接消除 2× 复制、padding 浪费或 pack/unpack。

### 5.6 方法六：在“加载、转换、重放、重算”之间动态选择

外部缓存不应形成“命中就必须加载”的刚性路径。更合理的恢复计划是：

```text
候选逻辑对象
  → 查询可用 ReplicaSet
  → 过滤 layout/dtype/generation/status 不兼容副本
  → 分别估算 load + transform/reshard + replay + queue
  → 与本地 recompute 比较
  → 选择最低成本合法方案
```

对 recurrent state，checkpoint 间隔也应由同一个判断决定：

- checkpoint 太密：写放大、metadata 和一致性成本高；
- checkpoint 太疏：miss 后 replay token 多；
- 最优间隔取决于 snapshot 大小、链路带宽、token replay 成本和复用概率。

本地材料因此建议：token KV 按 page-close 异步 flush，state 按 boundary 独立 checkpoint，并用 replay/load 成本模型自适应选择间隔；`kda-gdn-kvc-update-and-memory-analysis.md:304`、`kda-gdn-kvc-update-and-memory-analysis.md:316`。

这类优化的本质是把二元的 hit/miss 改造成**恢复计划优化问题**。

### 5.7 方法七：让调度器看到数据成本

单个 kernel、单条链路或单个 cache tier 的局部最优，不一定带来服务端到端最优。调度器至少需要看到：

- 当前命中的对象和未命中的 group；
- 数据所在层级、预计加载时间和排队时间；
- 哪些层/segment 已 ready；
- 哪些计算可与传输重叠；
- buffer、pin、lease 和 slot 的占用；
- partial hit 后还要重放/重算多少；
- deadline、SLO 与失败回退成本。

本地材料将未来调度单元定义为：

```text
可执行段 = token range + required TOKEN_KV + required RECURRENT_STATE
```

而不是只调度一个 request 或 token block；`kda-gdn-kvc-evolution-impact-report.md:581`。这使 partial hit 可以成为一等公民：某些层命中就执行某些层，state miss 就重放对应路径，远端数据未到时先做独立计算，而不是退化成全命中/全未命中的二元决策。

## 6. 将方法归纳成六个基本变换

无论具体技术叫什么，最终几乎都能落入六类基本变换：

| 基本变换 | 核心问题 | 典型技术 |
| --- | --- | --- |
| **Reduce：减少** | 能否让对象更小、更少、更稀疏？ | GQA、MLA、SWA、量化、压缩、eviction |
| **Reuse：复用** | 能否不再生成相同或近似状态？ | prefix cache、chunk reuse、CacheBlend、跨模型共享 |
| **Relocate：迁移** | 是否必须放在 HBM？ | CPU/SSD/remote tier、P/D 分离、分布式对象存储 |
| **Reorder：重排** | 能否改变时间和空间顺序隐藏成本？ | prefetch、layerwise、batch I/O、cache-aware scheduling |
| **Recompute：选择性重算** | 取回和修复是否比从头算更便宜？ | tail replay、critical layers、token/layer selective recompute |
| **Fuse：融合** | 能否消除中间态和往返内存？ | FlashAttention、projection-attention fusion、state update fusion |

文章主要覆盖 `Reduce` 和 `Fuse`；本地材料把 `Reuse`、`Relocate`、`Reorder` 和 `Recompute` 补齐了。

真正的系统 know-how 不在于记住技术名，而在于：**面对一个新模型或新硬件，能够把问题重新映射到这六个变换，并明确每个变换改变了哪张账。**

## 7. 一套可执行的优化流程

### Step 1：定义业务目标，不先选技术

先明确主目标：

- 容纳更长上下文；
- 提高并发；
- 降低 TTFT；
- 稳定 TPOT/ITL；
- 降低 GPU 数或外部存储成本；
- 支持迁移、容灾或跨请求复用。

目标不同，最优方案可能相反。例如 offload 能增加容量，却可能恶化 TPOT；压缩能少搬字节，却可能增加 decode kernel 时间。

### Step 2：给缓存对象建模

对每个对象记录：

```text
semantic_role
model / adapter / revision
layer_or_group
token_range or state_position
shape / dtype / quantization
layout / stride / offset / alignment
generation / owner_epoch / status
replicas and locations
```

先区分 TOKEN_KV、RECURRENT_STATE 和 AUX_METADATA，再讨论统一传输和存储。字节可以统一搬，恢复语义不能被抹平。

### Step 3：做容量账和时间账

容量账至少包括：

```text
logical payload
physical allocation
padding/slack
replicas
staging/workspace
metadata/index
```

时间账至少包括：

```text
produce / lookup / queue / load / transfer
transform / reshard / repair / replay / wait / fallback
```

### Step 4：找主导项，而不是平均项

需要看 p50/p95/p99、不同上下文长度、不同并发和不同命中距离。尤其关注：

- OOM 前到底是谁占满 HBM；
- TTFT 中 prefill、cache load 和 queue 各占多少；
- decode step 中通信等待是否真的暴露；
- 搬运字节中有多少是重复、padding 或最终未使用数据；
- cache hit 中有多少真正跳过了 token-layer 计算。

### Step 5：选择最小变换

优先选择能直接击中主导项、且 correctness 边界最清楚的动作。例如：

- 重复副本主导：先去副本，不先做复杂量化；
- 小 I/O 主导：先合批或 page-close，不先换存储系统；
- 传输可覆盖：先做 prefetch/layerwise，不先做 zero-copy kernel；
- 加载比重算贵：直接重算或缩短缓存保留；
- prefix 重复高：先 exact prefix，不急着做任意 chunk 修复。

### Step 6：检查组合是否真正正交

公式上作用于不同因子的技术，工程上仍可能互相冲突：

- 量化减少字节，却增加 scale、解码和专用 kernel；
- sparse 减少回迁，却增加 indexer 和动态 metadata；
- layerwise 降峰值，却增加 event、lease 和 buffer 状态机；
- 非前缀复用减少计算，却增加 re-RoPE、scatter 和质量修复；
- zero-copy 消除 staging，却可能让慢速 Host 链路被 kernel 重复读取。

因此“理论压缩比相乘”不能直接当成端到端收益相乘。

### Step 7：保留安全回退

所有高级路径都应能回到可验证基线：

- cache miss → full prefill；
- layout/dtype 不兼容 → miss；
- timeout/partial failure → invalidate + recompute；
- 非前缀修复失败 → full prefill；
- state generation 不完整 → 从更早边界 replay 或重算。

### Step 8：按端到端指标验收

至少同时记录：

| 维度 | 指标 |
| --- | --- |
| 质量 | F1、ROUGE、pass@1、PPL/KL、logit 偏差 |
| 服务 | TTFT、TPOT/ITL、JCT、吞吐、SLO violation |
| 容量 | HBM/DRAM/SSD peak、可容纳 token/请求数 |
| 搬运 | H2D/D2H/network bytes、有效带宽、I/O stall |
| 复用 | prefix/chunk hit、实际跳过的 token-layer 数 |
| 恢复 | replay token ratio、reshard/repair 时间 |
| 可靠性 | restore failure、rollback、timeout、fallback rate |

## 8. 常见误区

### 8.1 只看压缩比

压缩比不包含编码/解码、scale、workspace、对齐和质量代价。应比较的是端到端容量与时间，而不是 payload 文件大小。

### 8.2 只看 cache hit rate

命中可能仍需大量加载和修复。应看真正跳过的计算、有效 TTFT 和 moved bytes；`llm-context-kv-cache-paper-report.md:311`。

### 8.3 把所有 cache 当成 token KV

recurrent state、indexer、scale、compressor state 和 overlapping view 的生命周期不同。统一成 byte blob 可以用于传输，但不足以决定命中、合并、淘汰和恢复。

### 8.4 把稀疏等同于容量下降

稀疏 attention 可能只减少实际读取和计算，完整 KV 仍保存在 Host 或其他层级。需要分别计算“保存多少”和“每步取回多少”。

### 8.5 把异步等同于免费

异步只有在工作被覆盖时才减少关键路径；否则只是把等待换了位置。必须测未隐藏的 `wait/stall`，而不是只确认 API 是异步的。

### 8.6 把公式正交等同于实现可组合

GQA、量化、SWA、layerwise、offload 在数学因子上可以正交，但可能因 layout、kernel、graph capture、TP/PP、buffer 生命周期而无法直接组合。

### 8.7 优化局部，不看瓶颈迁移

HBM 释放后，瓶颈可能转到 Host 带宽；减少计算后，瓶颈可能转到 network RTT；提高命中后，瓶颈可能转到 metadata 和 scheduler。每轮优化后都要重新画像。

## 9. 最终形成的 know-how

可以把整套方法压缩成一句话：

> 以公式建立可计算的成本模型，以对象语义确定正确性边界，以六类基本变换搜索设计空间，以端到端收益而不是局部指标完成验收。

更完整地说，它包含四层能力：

1. **公式能力：** 能把模糊的“KV 太大、太慢”写成容量和时间公式；
2. **结构能力：** 能看清 head、layer、token、plane、page、replica、tier 和生命周期之间的关系；
3. **系统能力：** 能在压缩、复用、分层、搬运、重算和调度之间做组合；
4. **验证能力：** 能用质量与端到端成本证明优化成立，并识别瓶颈迁移。

文章的“五刀”是一个很好的入口，但完整的方法论不是“沿 KV 公式砍到底”，而是：

```text
静态容量公式
  → 物理内存公式
  → 生命周期时间公式
  → 复用/恢复收益公式
  → 调度与正确性约束
  → 端到端验证闭环
```

这也解释了本地材料为什么逐渐从“KV Cache 管理”走向“Hybrid Memory Coordinator”：系统不再只负责保存一块 KV，而是在决定**什么历史值得保存、保存成什么、放在哪里、何时移动、怎样恢复，以及何时重算反而更便宜**。

## 10. 快速检查清单

在评估一个新的 KV 优化方案时，可以直接逐项检查：

- [ ] 它优化的是容量、带宽、计算、延迟、吞吐还是可靠性？
- [ ] 它改变了公式中的哪个因子或生命周期中的哪个成本项？
- [ ] 对象是 token KV、compressed plane、recurrent state 还是 metadata？
- [ ] logical bytes、allocated bytes 和 transferred bytes 分别是多少？
- [ ] 是否存在重复副本、重复 view、padding 或 staging？
- [ ] 命中后还需要哪些 transform、reshard、repair 或 replay？
- [ ] 加载总成本是否小于重算？阈值如何确定？
- [ ] 能否与计算、其他层或其他请求重叠？未隐藏等待是多少？
- [ ] cache key 是否覆盖模型、位置编码、布局、精度和并行配置？
- [ ] 是否具备 generation、原子发布、COW/fencing 和失败回退？
- [ ] 优化能否与现有量化、layerwise、sparse、TP/PP 和 graph 组合？
- [ ] 是否同时验证了质量、TTFT、TPOT、吞吐、容量、字节数和失败率？
- [ ] 优化后新的瓶颈在哪里？

## 11. 本地材料索引

- `llm-context-kv-cache-paper-report.md:20`：将问题拆成复用语义、容量层级、搬运执行和权重存储。
- `position-independent-kv-cache-report.md:88`：内容身份、位置迁移、上下文修复和系统执行四层能力。
- `position-independent-kv-cache-report.md:266`：从 exact prefix 到 chunk 修复的推荐执行流程。
- `kda-gdn-kvc-evolution-impact-report.md:63`：从 token KV 扩展到多时间尺度的分层记忆。
- `kda-gdn-kvc-evolution-impact-report.md:87`：从 block manager 向 Hybrid Memory Coordinator 演进。
- `kda-gdn-kvc-evolution-impact-report.md:352`：load、reshard、replay 的副本选择成本模型。
- `kda-gdn-kvc-evolution-impact-report.md:555`：成本感知 eviction 和保留价值模型。
- `kda-gdn-kvc-update-and-memory-analysis.md:210`：state 融合、紧凑化、COW、checkpoint 和 page-close flush。
- `vllm-ascend-layerwise-sparse-delay-pull-analysis.md:233`：layerwise 计算/传输重叠模型与观测指标。
- `deepseek-v4.1-reuse-group-layer-chunk-scheduling.md:264`：reuse-group pipeline 的关键路径模型。
- `vllm-ascend-dsa-kv-lmcache-analysis.md:1070`：多 plane、多压缩比和运行中 state 的物理结构。
- `vllm-ascend-dsa-kv-lmcache-analysis.md:2226`：multi-plane、shared backing、padding 和传输边界风险。
- `lmcache-kvc-papers-and-feasibility-report.md:610`：面向 TOKEN_KV、RECURRENT_STATE 和 AUX_METADATA 的逻辑对象模型。
- `lmcache-kvc-papers-and-feasibility-report.md:678`：从可靠恢复到混合模型、跨模型复用的实施路线。
- `lmcache-ascend-vs-ascendstore-mooncake-kvc-comparison.md:439`：tier 编排、去冗余、批量 I/O、对象副本和控制面取舍。
