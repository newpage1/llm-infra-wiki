---
section: know-how
summary: 8 篇 arXiv 论文与 ParaCache 的全景梳理，以及 LMCache 的落地可行性评估：这些工作共同推动 KVC 从显存里的 token-KV 数组变成跨模型、跨介质、可调度、可恢复的推理状态基础设施，并给出按投入产出比排序的路线。
---

# KV Cache 论文全景分析与 LMCache 落地可行性报告

> 调研对象：公众号《899ms 砍到 138ms，只掉 1.7 个点：KV Cache 正在离开显存》提到的 8 篇 arXiv 论文，以及文中提到的中科曙光 ParaCache。
>
> 调研时间：2026-09-09
>
> 结论重点：这些工作并不是 8 个孤立的 KV Cache 技巧，而是在共同推动 KVC 从“显存中的 token-KV 数组”变成“跨模型、跨介质、可调度、可恢复的推理状态基础设施”。

## 1. 先给结论

### 1.1 对 LMCache 最值得做的事情

按投入产出比排序，建议采用下面的路线：

| 优先级 | 方向 | 价值 | 与 LMCache 的关系 |
| --- | --- | --- | --- |
| P0 | Bounded-State Restoration（有界恢复工作集） | 解决外部状态很大、GPU 本地恢复内存很小的问题 | 直接改 LMCache restore/lookup/commit 数据面 |
| P0 | 异步 flush、immutable object、probe/commit、generation fencing | 为 token KV 和 KDA/GDN state 提供可靠快照语义 | 直接改对象生命周期和一致性协议 |
| P1 | Tail-Replay | 让混合注意力模型在任意 token 边界兑现 prefix cache | LMCache 负责 FA KV；vLLM/SGLang 负责 replay 执行 |
| P1 | RWS-aware cost model | 将传输、恢复暂存、重放和重算成本统一进选择器 | LMCache 提供成本和副本信息，scheduler 决策 |
| P1 | TOPAS 式 workflow-aware scheduling | 从“单请求命中率”升级到“整条 Agent 工作流延迟” | 需要 scheduler 与 LMCache 联动 |
| P2 | 跨模型 KV translation / XKV | 让一份上下文跨模型复用 | 需要独立 translator；LMCache 保存和传输对象 |
| P2 | psRL | 将 prefix sharing 扩展到 Agentic RL update 阶段 | 主要改 trainer/rollout 集成，不是 serving 核心 |
| P3 | Elastic KV Cache | 通过 CUDA VMM 临时腾挪本地 KV 容量 | 更适合 vLLM allocator，不建议先塞入 LMCache |

### 1.2 总体架构判断

LMCache 应保持“缓存/数据面”的边界，不把所有论文机制都塞进核心：

```text
LMCache
  lookup / metadata / storage / transport / tiering
  restore / prefetch / replica selection
  generation / checksum / commit / failure semantics

vLLM / SGLang
  scheduler / batch admission / workflow DAG
  hybrid state reconstruction / tail replay
  model-specific state update

Translator service
  cross-model KV translation
  XKV / learned adapter / quality profile

Trainer integration
  psRL 的 global batch visibility、immutable sample graph、update cache
```

### 1.3 重要的边界

以下三类对象必须分开建模：

```text
TOKEN_KV          普通注意力/MLA 的 token 维 KV block
RECURRENT_STATE   KDA/GDN/Mamba 等递归状态快照
AUX_METADATA      position、scale、index、layout、量化和校验信息
```

特别是 KDA/GDN：

- state 在设备侧必须逐 token 原地更新，否则下一个 token 看不到上一个 token 的状态。
- state 不需要每 token 写入远端 KVC；远端可以按 boundary、迁移、抢占或请求结束异步 snapshot。
- 远端副本必须使用 generation fencing 或 Copy-on-Write（COW），避免读到半更新 state。
- 正确性命中必须是精确 token prefix + 精确 state boundary，不能用语义相似度替代。

## 2. 论文清单与来源

| 编号 | 论文 | 核心问题 | arXiv |
| --- | --- | --- | --- |
| 1 | A Universal Context-Reuse Layer for Cross-Model KV Sharing | 不同模型之间能否复用 KV | [2608.30963](https://arxiv.org/abs/2608.30963) |
| 2 | Dual-Cache Latent Space Communication between Heterogeneous Language Models（XKV） | 异构模型之间如何高效通信上下文 | [2608.20617](https://arxiv.org/abs/2608.20617) |
| 3 | What It Costs to Compose, Rebuild, and Correct Precomputed Memory | 预计算记忆如何组合、重建和修正 | [2608.30647](https://arxiv.org/abs/2608.30647) |
| 4 | Bounded-State Restoration: Decoupling Local Restore Capacity from External LLM State | 外部状态很大时如何限制本地恢复内存 | [2608.17826](https://arxiv.org/abs/2608.17826) |
| 5 | Tail-Replay: Escaping the Curse of Linear Attention in Prefix Caching for Hybrid LLMs | 混合注意力模型如何突破离散 checkpoint 命中 | [2608.30310](https://arxiv.org/abs/2608.30310) |
| 6 | TOPAS: Workflow-Aware Prefix-State Scheduling for Multi-Agent LLM Serving | 如何为多 Agent 工作流联合调度前缀状态和请求 | [2608.25523](https://arxiv.org/abs/2608.25523) |
| 7 | psRL: Efficient Training for Agentic AI via Training-Time Prefix Sharing | Agentic RL update 阶段如何共享前缀 | [2608.25683](https://arxiv.org/abs/2608.25683) |
| 8 | Elastic KV Cache for LLM Serving | 是否需要用 CUDA VMM 动态回收本地 KV | [2608.23658](https://arxiv.org/abs/2608.23658) |

公众号原文：[《899ms 砍到 138ms，只掉 1.7 个点：KV Cache 正在离开显存》](https://mp.weixin.qq.com/s/Y9ALxpuKFhxNP-YMl-Jnuw)。

“中科曙光 ParaCache”是产品/产业材料，不是上述 8 篇 arXiv 论文。它可以作为工程落地案例参考，但不应与论文实验结果混为同一证据等级。

## 3. 论文一：跨模型 KV Sharing（2608.30963）

### 3.1 研究问题

传统 prefix cache 默认：生成 KV 的模型和消费 KV 的模型必须相同。论文把这个约束改成：

```text
source model prefill
        -> source KV
        -> learned translator
        -> target-compatible KV
        -> target model decode
```

目标不是逐元素还原目标模型 native KV，而是让目标模型在后续 decode 中获得足够的上下文信息：

\[
\widehat{KV}_B(C)=T_{A\rightarrow B}(KV_A(C))
\]

只要满足：

\[
C_{translation}+C_{transfer}+C_{assembly}<C_{target\_prefill}
\]

且质量损失可接受，迁移才有价值。

### 3.2 方法和实验

论文覆盖三种模型关系：

| 场景 | 源模型 | 目标模型 | 结果 |
| --- | --- | --- | --- |
| 同家族降尺度 | Qwen2.5-7B → Qwen2.5-1.5B | LongBench2 由 27.59% 提升到 34.48%，+6.89 个百分点 |
| 跨家族同级 | Qwen2.5-1.5B → Gemma-2-2B | 4K 上下文目标侧 prefill 成本降低 67.04% |
| 跨家族降尺度 | Llama3.1-70B → Qwen2.5-7B | 899ms → 138ms；准确率 45.7% → 44.0%，损失 1.7 个百分点 |

需要特别注意：论文的 handoff latency 以“源 KV 已经存在”为前提，不包含源模型产生 KV 的 prefill 时间。因此它更适合以下场景：

- 源模型本来就必须运行，例如大模型先做理解，小模型负责低成本生成。
- 多个目标模型共享同一份源上下文。
- 请求迁移或模型路由已经产生源 KV，目标侧不应再次 prefill。

### 3.3 主要贡献和局限

贡献：

- 把 KV 从“模型私有中间结果”变成“可翻译的上下文资产”。
- 证明模型家族内的 KV 迁移可能同时带来质量和延迟收益。
- 给出跨家族迁移的质量-延迟汇率。

局限：

- translator 需要训练，且每一对模型/架构可能需要适配。
- 长上下文下表示对齐难度上升。
- 交接成本不等于端到端成本。
- 质量不能只用 raw KV distance 评估，必须看下游 logits、PPL 和任务准确率。

### 3.4 对 LMCache 的映射

这不是简单修改 `model_id` 字段。对象元数据至少要增加：

```text
source_model
target_model
translator_id / translator_version
source_layout / target_layout
quality_profile
model_revision
```

推荐让 LMCache 保存两种对象：

1. `source KV object`：一次生成，多目标翻译。
2. `translated KV object`：高频目标模型的翻译结果，可作为二级缓存。

LMCache 不应负责 translator 训练。更合理的边界是：LMCache 提供 source KV 的存储、传输、版本和生命周期；translator service 提供转换；vLLM/SGLang 负责把 translated KV 装配到目标模型布局。

可行性：**P2，研究型扩展，中期可做，不能作为 LMCache 第一阶段核心功能。**

## 4. 论文二：XKV / Dual-Cache Latent Space Communication（2608.20617）

### 4.1 研究问题

XKV 进一步研究异构模型之间的 latent/cache communication。它不只看 source/sharer cache，而是同时建模：

- sharer cache：发送方已经算出的上下文状态。
- receiver cache：接收方自身模型的缓存结构。

通过联合使用两边的信息，XKV 支持模型之间存在：

- 不同 model family。
- 不同 layer count。
- 不同 KV head 数。
- 不同 head dimension。
- 不同 tokenizer。

### 4.2 方法结构

论文的关键部件包括：

1. learned-query pooling：从较大或不同结构的 cache 中提取可通信 latent。
2. cross-layer mapping：在层数不一致时建立层间映射。
3. joint memory：联合利用发送方和接收方 cache。
4. position decoder：恢复目标侧需要的位置信息。

与只对 source KV 做一次线性映射相比，XKV 的目标是让 translator 感知“目标模型已有的表示”，因此更适合异构模型通信。

### 4.3 实验结果

论文在 45 个 dataset-model-pair setting 上评估。相对 LCF-X：

- ROPES exact match 提升 4.6 个百分点。
- ROPES F1 提升 4.2 个百分点。
- translator 参数量减少 76%。
- cache translation：5.8ms，相比 59.9ms，约 10.3× 更快。
- 端到端速度比 LCF-X 快 26%。
- 比文本通信快 6.8×。

### 4.4 对 LMCache 的映射

XKV 本质是 translation/control plane，不是现成的 external KV data plane。LMCache 可以提供：

- source cache 的 canonical storage。
- receiver cache descriptor。
- translator 输入输出对象的生命周期管理。
- translated object 的 target-specific 索引。
- 传输、校验、失效和 replica 管理。

LMCache 不应把 XKV 网络或训练逻辑耦合进核心 CacheEngine。更可行的 API 是：

```text
lookup(source_key, target_model, translator_id)
translate(source_object, receiver_descriptor)
publish(translated_object)
```

可行性：**P2，中等偏低的近期工程可行性；需要 translator 原型、质量基线和模型执行侧改造。**

## 5. 论文三：预计算 Memory 的组合、重建和修正（2608.30647）

### 5.1 研究问题

这篇论文不直接提出一个 KV transfer engine，而是研究“预先算好的记忆”是否可以长期复用。实验对象包括：

- saved KV caches。
- trained compressed cartridges。

它关注三条失效路径：

```text
组合退化：分别准备的 memory 拼起来，质量下降
重建昂贵：新增事实后，旧 memory 需要 replay/retrain
修正被忽略：query-time correction 放在旁边却未必被模型采用
```

### 5.2 核心结论

- 分别预计算的 memory 组合时质量会下降，不能默认“可组合即无损”。
- 更新已有 memory 往往需要重建，且需要 replay 历史数据。
- 不重放历史数据的 warm rebuild 很便宜，但收益接近于零。
- half-replay 的质量可以接近 full replay，成本约为 fresh retrain 的一半。
- query-time correction 若明确点名要修正的问题，使用率超过 90%；不点名时约 10%。
- 经过 512 次 revision 后，更新使用率降到 10% 以下。

### 5.3 对 LMCache 的真正启发

它给 cache 系统增加了“新鲜度/折旧”维度：

```text
cache hit != cache still valid
```

建议在 LMCache 元数据中加入：

```text
source_corpus_version
model_revision
memory_revision
created_at / expires_at
rebuild_policy
correction_refs
quality_eval_version
```

调度器不应只优化 hit rate，还要判断：

- 这份 cache 是否已经被新事实淘汰。
- 使用旧 cache 后是否必须挂 correction sidecar。
- 重算或重建的成本是否低于继续复用。
- 哪些 revision 需要触发全量、半量或 warm rebuild。

### 5.4 局限和落地建议

这篇论文主要是策略和一致性研究，不是 LMCache 的直接代码 patch。最现实的落地方式是：

1. 先实现 immutable object + version metadata。
2. 再实现 correction sidecar 和显式 invalidation。
3. 最后根据真实业务的事实更新频率建立 rebuild cadence 模型。

可行性：**P1/P2，作为缓存治理策略高价值；作为独立 LMCache feature 需要业务语义配合。**

## 6. 论文四：Bounded-State Restoration（2608.17826）

### 6.1 研究问题

分层存储可以让外部保存很大的 LLM state，但“存得下”不等于“恢复得了”。如果恢复过程中需要同时 materialize 整个命中计划，本地 GPU/L1 staging 仍可能成为瓶颈。

论文定义 Restoration Working Set（RWS）：恢复期间生命周期重叠的峰值本地暂存状态。

传统做法：

```text
whole-plan lookup
    -> whole-plan materialize
    -> scheduler 才能继续
```

Bounded-State Restoration（BSR）拆成：

1. `probe`：只探测完整命中计划，不物化全部状态。
2. `install`：以最多 `W` 个 chunk 的窗口安装。
3. `commit`：所有 group/rank 成功后，才向 scheduler 暴露可复用前缀。

核心性质：

```text
external state size = O(|S|)
restore working set = O(W)
```

### 6.2 实验结果

实验环境：DeepSeek-V4-Flash、TP=2、两台 DGX Spark。

- external state：1.956 → 31.277 GiB/rank。
- W=32 时，RWS 始终为 500.75 MiB/rank。
- 外部状态/活跃 staging 比例达到 63.959×。
- SSD 并发从 1 提到 4 后，512K restore TTFT：43.1s → 17.6s。
- SSD 并发提升不改变 RWS。

### 6.3 对 LMCache 的直接改造点

这是 8 篇中与 LMCache 数据面最直接的一篇，且论文明确说明已扩展 LMCache 和 vLLM。

建议实现：

```text
lookup_plan(prefix) -> immutable plan
probe(plan) -> hit/miss + complete groups
install(plan, window=W) -> bounded reusable staging
commit(request, generation) -> atomic visibility
abort(plan) -> release + invalidate partial blocks
```

必须保证：

- 任意 group/rank 失败时，不能暴露 partial prefix。
- staging buffer 可复用，而不是每次恢复重新申请。
- HMA/分层内存下要支持 whole-prefix invalidation。
- 发生迁移或 preemption 时可以 force-local recovery。
- external object 和 local installed state 具有可校验的 generation/checksum。

### 6.4 评价

可行性：**P0，最高优先级。**

原因很直接：它不要求改变模型语义，直接解决外存容量与本地恢复内存之间的错配；收益可以用 RWS、TTFT、并发和失败率直接验证。

## 7. 论文五：Tail-Replay（2608.30310）

### 7.1 研究问题

混合模型同时包含：

- Full Attention（FA）：历史 KV 可以按 token boundary 精确寻址。
- Gated DeltaNet/KDA 等线性注意力：历史被压缩为递归 state，不能像普通 KV 一样回滚到任意 token。

如果只保存 recurrent checkpoints，prefix cache 只能在离散 checkpoint 对齐位置命中。

### 7.2 方法

Tail-Replay 的关键选择是：

- 只缓存 exact full-attention KV。
- 不保存 recurrent-state checkpoints。
- 命中 prefix 后，重放匹配 prefix 最近的一小段 tail，重建 linear-attention state。
- 同时保存 FA output hidden，减少不必要的重复计算。

额外优化：

- tail-FFN skip。
- transfer/replay overlap。
- replay budget 控制。

流程可以表示为：

```text
exact FA KV hit at token p
        │
        ├─ install FA KV
        ├─ replay tokens [p-r, p)
        └─ rebuild KDA/GDN state
```

### 7.3 实验结果

在 3 个 Gated DeltaNet hybrid model、LongBench 和 RULER 上：

- replay budget 约为 full prefix 的 5–10%。
- 保持 full-prefill 质量的 92.8–99.9%。
- 32K prefix 的 TTFT speedup 为 9.1–14.3×。

### 7.4 对 LMCache 的映射

LMCache 不能单独完成 Tail-Replay，因为 state reconstruction 依赖具体模型执行。但可以提供：

- FA KV 的精确 prefix lookup。
- `cache_group` 级命中结果。
- replay 起点、尾部 token/hidden 的传输。
- transfer 与 replay 的 pipeline overlap。
- replay budget 和成本估计。

vLLM/SGLang 需要负责：

- 识别 KDA/GDN state builder。
- 从 tail token 重建 recurrent state。
- 处理 conv state、recurrent state 和 speculative decode 的接受/回滚。

可行性：**P1，中高；必须做 model/engine integration。**

## 8. 论文六：TOPAS（2608.25523）

### 8.1 研究问题

多 Agent DAG 中，保留某个长 system prompt 的 KV 有两面性：

- 未来下游请求可以省掉 prefill。
- 占用显存，可能降低当前并发 batch 能力。

只看 cache locality 会导致当前队列拥塞；只看即时调度又会丢掉下游复用收益。TOPAS 联合决定：

```text
keep which prefixes
schedule which requests
```

### 8.2 方法和结果

评分因素包括：

- 每个任务最长剩余服务路径的预计削减。
- 下游 prefix reuse 的近期收益。
- prefix movement cost。
- preemption cost。
- aging，避免低优先级任务 starvation。

实现基于 SGLang：

- synthetic DAG：mean/p99 JCT 最多降低 39.8%/49.4%。
- MetaGPT-SOP：mean JCT 降低 9.8%。
- MetaGPT-TL：mean/p99 JCT 降低 22.0%/26.6%。

### 8.3 对 LMCache 的映射

TOPAS 主要是 scheduler/control-plane feature。LMCache 需要新增可观测接口：

```text
get_residency(prefix)
get_replicas(prefix)
estimate_move_cost(prefix, target)
pin(prefix, ttl)
unpin(prefix)
preempt(prefix)
```

调度器需要提供：

- request DAG/dependency。
- 每个节点的剩余路径和 SLA。
- 下游 prefix 复用预测。
- prefix 的 pin/unpin 和迁移意图。

可行性：**P1，中高；LMCache 提供成本和状态，SGLang/vLLM 负责全局决策。**

## 9. 论文七：psRL（2608.25683）

### 9.1 研究问题

Agentic RL 的 tree/step-wise rollout 会让样本数量迅速膨胀。论文观察到系统瓶颈从 rollout 转移到 update，而 update 阶段有两个适合共享的条件：

- 全局可见：可以看到整个 batch 的样本关系。
- 数据不可变：update 期间样本不会被修改。

### 9.2 方法

psRL 组合了：

- inter-batch sharing。
- self-sequence sharing。
- semantic grouping。
- global load balancing。
- token-wise micro-batching。
- adaptive variable-size block allocation。
- dynamic KV caching。

生产 trace 上最高获得 5.2× throughput。

### 9.3 对 LMCache 的映射

psRL 不是把 serving LMCache 原样接到 trainer 上。可复用的是：

- CacheEngine/BlockPool 的 block 管理。
- prefix hash 和 hierarchical lookup。
- memory manager。
- chunk 生命周期和去重。

需要新增：

- trainer/rollout/update 的接口。
- immutable sample graph。
- global batch visibility。
- advantage/value cache 与 KV cache 的绑定。
- worker 间 prefix ownership 和负载均衡。

风险是：training update 需要梯度、版本和样本语义，不能把 inference cache 的“可丢弃、只读”假设直接照搬。

可行性：**P2，中等；适合做独立 training adapter，而不是修改 serving 核心。**

## 10. 论文八：Elastic KV Cache（2608.23658）

### 10.1 机制

论文利用 CUDA VMM 保留连续 virtual address，再绑定两个 physical handles：

- base handle。
- elastic handle。

decode 阶段把 reserve 借给 KV pool；large prefill 到来前 decommit/recommit。特点是：

- 不改 attention kernel。
- 不改驱动。
- decommit 几毫秒，recommit 几十毫秒。
- 兼容 CUDA graph 和 prefix caching。

### 10.2 关键负结果

论文最重要的价值是给出了边界条件：

- chunk size 8192 vs 32768 的 median TTFT 差约 1%。
- 直接调低 `max_num_batched_tokens` 回收更多 KV，延迟近似。
- TP1 时 reserve 约占 KV 的 16%。
- TP4 时只占约 2.7%。
- 在部分低 TP 场景，曾带来约 18% KV capacity 和约 10% decode throughput，但适用窗口很窄。

### 10.3 对 LMCache 的判断

这是 local GPU allocator 问题，不是 external cache data plane 问题。更适合放在：

- vLLM local allocator。
- CUDA VMM 管理器。
- scheduler 的 one-step lookahead。

LMCache 可以借鉴：

- local capacity pressure signal。
- external tier admission。
- prefetch/eviction timing。

可行性：**P3，低到中；不建议进入 LMCache 第一优先级。**

## 11. 产业材料：ParaCache（非论文）

### 11.1 它做了什么

公众号还介绍了中科曙光 ParaCache。它不是 arXiv 论文，而是面向国产算力和集群部署的工程/产品材料。按公众号披露，ParaCache 将 KV Cache 组织为四级缓存池：

```text
L1 HBM
L2 CPU DRAM
L3 集中式全闪 FlashNexus Neo
L4 分布式全闪 ParaStor F9000
```

披露的工程点包括：

- L3 使用存算解耦的 FlashNexus Neo，单阵列约 160GB/s。
- L4 将分布式存储的 offset 覆盖写改为追加写，并通过目录减少分布式锁。
- PD 分离场景下，节点间尽量只传输增量 KV。
- 使用 best-effort prefetch，利用“判断 KV 是否存在”和“真正取数”之间的时间差提前下沉/提升数据。
- 兼容 vLLM、SGLang，并与 Mooncake 做联合定制。

公众号披露的结果包括：12 万词元输入下 TTFT 最高降低 98.5%，高并发每秒处理词元量最高提升 27×，单轮 TTFT 降到约 0.4 秒，连续 20 轮从 43.1 秒降到 4.9 秒。

### 11.2 如何解读这些数字

这些数字体现的是特定硬件、工作负载、缓存命中率、并发度和软件栈下的系统结果，不能直接与某篇论文的单项 microbenchmark 横向比较。尤其需要确认：

- 是否把 source prefill 成本计入。
- 命中率和 prefix 长度分布是什么。
- “27×”的基线、并发和吞吐口径是什么。
- L3/L4 的数据复制、预取和一致性成本如何计算。

### 11.3 对 LMCache 的启发

ParaCache 证明了外部多级存储的产业价值，但对 LMCache 的直接借鉴应限于：

- tier-aware admission/eviction。
- append-only 或 immutable object 写入。
- 目录服务和 ReplicaSet。
- best-effort prefetch。
- PD 分离下的增量传输。

它不能替代 BSR、Tail-Replay 或 generation fencing 等模型状态语义；硬件层级扩展必须建立在正确的对象和恢复协议之上。

## 12. 横向比较：每篇论文到底改变哪一层

| 论文 | 数据面 | 控制面 | 模型/执行面 | 是否改 LMCache 核心 | 是否改 vLLM/SGLang |
| --- | --- | --- | --- | --- | --- |
| Cross-model KV | source/translated object、layout | translator 选择、质量 profile | target KV 消费 | 部分 | 是 |
| XKV | dual-cache object、translation transport | receiver-aware translation | cross-layer/position decoder | 部分 | 是 |
| Precomputed Memory | version、freshness、correction sidecar | rebuild/invalidation policy | correction/replay | 部分 | 视业务而定 |
| BSR | bounded restore、atomic commit | probe/install/commit | scheduler 可见性 | 是 | 少量 |
| Tail-Replay | FA KV、tail token/hidden | replay budget、pipeline | recurrent state rebuild | 部分 | 是 |
| TOPAS | residency、replica、movement cost | DAG-aware admission/scheduling | request orchestration | 少量 | 是 |
| psRL | immutable block/cache | global batch ownership | trainer/update | 不建议直接改 | 需 trainer adapter |
| Elastic KV | local allocator signal | memory pressure | CUDA VMM/allocator | 否 | 是 |

## 13. LMCache 建议的数据模型

### 13.1 逻辑对象

建议把现有 token block 抽象扩展为：

```text
CacheObject {
  logical_key
  semantic_role: TOKEN_KV | RECURRENT_STATE | AUX_METADATA
  cache_family: FA | MLA | KDA | GDN | MAMBA
  source_model
  target_model / translator_id
  model_revision
  adapter_identity
  layer_or_group
  token_range or state_position
  source_layout
  target_layout
  dtype / quantization
  generation
  owner_epoch
  status: WRITING | COMPLETE | INVALID | EVICTED
  checksum
  replicas
}
```

### 13.2 LogicalStateKey 与 ReplicaSet

KDA/GDN state 的检索不应遍历整个集群：

1. 根据当前请求 token IDs 和有限 replay budget，计算最近 K 个 checkpoint boundary 的精确 prefix hash。
2. 对这些确定 key 做批量 `MULTIGET`。
3. 目录返回命中逻辑对象的 `ReplicaSet`。
4. 仅在该对象的少量副本中比较加载、reshard 和 replay 成本。

示例：当前 prefix 长度 4096、checkpoint 间隔 64、最多重放 256 token 时，只查询：

```text
4096, 4032, 3968, 3904, 3840
```

选择成本可以写为：

\[
T_{total}=T_{metadata}+T_{queue}+T_{load}+T_{reshard}+N_{replay}T_{token}
\]

“相似前缀”“租户热点”只能用于预取、复制和 admission，不能作为 state 正确性命中条件。

### 13.3 Generation fencing 和 COW

以 `position=4032` 为例：

```text
snapshot B: position=4032, generation=38, COMPLETE
decode continues locally
new snapshot C: position=4096, generation=39, WRITING
```

`generation` 表示同一逻辑 state 的版本代次，不是 prefix 检索 key。读取侧只接受 `COMPLETE` 且仍在有效 epoch 内的 generation；写入侧采用：

- COW：新版本写新对象，完成后原子 publish。
- fencing：旧 writer 没有权限覆盖新 owner epoch。

这样即使 decode 持续原地更新，也不会让远端读者看到半写 state。

## 14. 面向 LMCache 的实施路线图

### 阶段 P0：可靠、有界的恢复数据面

目标：先让外部状态真正“可恢复”。

交付项：

- `probe -> bounded install -> commit` API。
- 可复用 staging buffer。
- request-level atomic visibility。
- partial failure rollback 和 failed-block invalidation。
- generation/checksum/owner epoch。
- TOKEN_KV 与 RECURRENT_STATE 分开建模。
- token KV block close 后异步 flush。
- state 在 boundary/迁移时异步 snapshot。

验收指标：

- RWS 是否随外部 state 增长保持近似常数。
- 512K/1M prefix restore TTFT。
- restore 失败时是否绝不暴露 partial prefix。
- HBM、DRAM、远端内存、SSD 的 tier 命中和回滚正确率。

### 阶段 P1：混合模型和调度联动

目标：让 KDA/GDN 混合模型的 prefix cache 具备实际收益。

交付项：

- cache group awareness。
- FA KV 命中后 tail replay。
- replay budget 和 cost model。
- transfer/replay overlap。
- state builder 与 vLLM-Ascend/SGLang 执行侧适配。
- residency、movement cost、pin/unpin API。

验收指标：

- 32K prefix TTFT speedup。
- replay token 比例与质量保持率。
- FA hit 但 state miss 时的降级正确性。
- multi-Agent DAG 的 mean/p99 JCT。

### 阶段 P2：跨模型和训练复用

目标：把缓存资产跨模型、跨 pipeline 使用。

交付项：

- translator registry 和 source/target compatibility。
- translated object 的二级缓存。
- XKV/learned adapter 外部服务接口。
- freshness/rebuild/correction sidecar。
- psRL trainer adapter。

验收指标：

- translation + transfer 是否低于 target prefill。
- PPL/任务准确率损失上限。
- translator cache 命中收益。
- update throughput 和显存节省。

### 阶段 P3：本地 allocator 优化

目标：在确认 chunked prefill 已无法解决的场景下，再评估 VMM elastic reserve。

交付项：

- vLLM local allocator 原型。
- CUDA graph 兼容性测试。
- TP1/TP2/TP4 分别测 reserve 占比和收益。

不应把 P3 的机制作为 LMCache external storage 的前置依赖。

## 15. 需要重点验证的风险

### 15.1 正确性风险

- recurrent state 缺一个 tensor 或 boundary 错位，会影响后续整段 decode。
- partial restore 不得暴露为 cache hit。
- speculative decode 只能提交 accepted token 的 state。
- model revision、LoRA、量化和 layout 不匹配时必须 miss。

### 15.2 性能风险

- state snapshot 可能比若干 token KV 大很多，逐 token远端写入会产生严重写放大。
- cross-model translator 的训练和推理成本可能抵消 prefill 节省。
- tail replay 的收益取决于 replay kernel 是否与传输真正重叠。
- TOPAS 的预测错误可能导致错误 pin，降低整体并发。

### 15.3 一致性风险

- decode 原地更新和远端副本读取并发时必须使用 generation fencing/COW。
- immutable publish 后才能加入全局目录。
- 旧 generation 可以作为历史恢复点，但不能冒充 latest complete snapshot。

### 15.4 评测风险

不能只报 cache hit rate。建议至少同时报告：

```text
TTFT / TPOT / JCT
RWS peak
HBM/DRAM/SSD bytes moved
replay token ratio
restore failure and rollback rate
quality delta / PPL delta
prefix freshness age
```

## 16. 最终判断

这 8 篇论文共同说明：KV Cache 的核心问题已经从“怎么把 KV 放进显存”转向四个预算的联合优化：

```text
迁移费：换模型能不能继续用
折旧费：缓存多久需要重算
兑现费：从外部取回需要多少本地工作集
调度费：保留缓存是否真的降低整条工作流延迟
```

对 LMCache 来说，最现实的成功路径不是一次性实现所有论文，而是：

1. 先用 BSR 和 immutable/generation 协议解决“外部状态可恢复”。
2. 再用 Tail-Replay 解决 KDA/GDN 混合模型的任意边界兑现。
3. 再把 TOPAS 的 residency/movement cost 暴露给 scheduler。
4. 最后以独立 translator service 方式接入跨模型 KV/XKV。

一句话概括：**LMCache 应先成为可靠的异构状态数据面，再逐步接入 replay、workflow scheduling 和 cross-model translation；不要把模型语义、训练逻辑和 CUDA allocator 全部塞进缓存核心。**

## 17. 编号纠错说明

此前提到的 `arXiv:2608.3096` 少了一位数字，正确论文编号是 `arXiv:2608.30963`。此前若出现 `2608.03096`，那是另一篇 deepfake 视频检测论文，与本文主题无关，不应纳入本报告。
