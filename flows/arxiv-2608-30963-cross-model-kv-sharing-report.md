---
section: know-how
summary: 跨模型 KV 共享论文整理：把 KV 看作可翻译的上下文计算表示——当翻译成本低于目标模型 prefill、且质量损失可接受时，跨模型共享才有价值，复用边界由此从同模型 prefix cache 扩出去。
---

# A Universal Context-Reuse Layer for Cross-Model KV Sharing

> 正确编号：`arXiv:2608.30963`
>
> 论文标题：**A Universal Context-Reuse Layer for Cross-Model KV Sharing**
>
> 作者：Yi Li, Dongming Jiang, Yi Zhao, Bingzhe Li（University of Texas at Dallas）
>
> 提交时间：2026-08-31
>
> 领域：`cs.LG`, `cs.AI`

## 1. 论文定位

这篇论文研究的是 **跨模型 KV Cache 共享**，不是传统的同模型 prefix caching。

传统 KV Cache 的隐含前提是：

```text
生成 KV 的模型 = 消费 KV 的模型
```

本文尝试放宽这个前提：先由源模型处理上下文并生成 KV，再通过一个 learned transport/translation module，把源模型 KV 转换成目标模型可以消费的表示。

```text
source model prefill
        │
        ▼
source KV cache
        │
        ▼
translation layer
        │
        ▼
target-compatible KV
        │
        ▼
target model decode
```

论文把这种能力称为 **context mobility（上下文流动性）**：上下文的计算结果可以随请求从一个模型流向另一个模型，而不是每次换模型都从原始 token 重新 prefill。

## 2. 为什么需要跨模型 KV 共享

现代应用经常让多个模型处理同一份上下文：

- 小模型先处理，困难请求再升级到大模型。
- 多 Agent 共享系统提示词、对话历史、检索文档和工具结果。
- 模型路由在不同成本/能力模型之间切换。
- 一个模型生成，另一个模型验证或批评。

传统执行会重复计算：

```text
C → M1 prefill → KV_M1
C → M2 prefill → KV_M2
C → M3 prefill → KV_M3
```

论文希望变成：

```text
C → M1 prefill → KV_M1
                 │
                 ├─ translate → KV_M2 → M2 decode
                 └─ translate → KV_M3 → M3 decode
```

收益成立的基本条件是：

\[
C_{translation}+C_{transfer}+C_{assembly}<C_{target\_prefill}
\]

并且翻译后的 KV 仍满足质量要求。

## 3. 它到底翻译什么

目标不是简单做 reshape 或 dtype 转换，而是把源模型的内部上下文表示映射到目标模型的表示空间：

\[
\widehat{KV}_B(C)=T_{A\rightarrow B}(KV_A(C))
\]

一般情况下：

\[
\widehat{KV}_B(C)\neq KV_B(C)
\]

也就是说，翻译结果不需要逐元素复现目标模型原生 prefill 得到的 KV；只要能让目标模型在后续 decode 中保留足够的上下文信息即可。

源模型和目标模型可能存在以下差异：

- 参数规模不同。
- 层数不同。
- hidden size 不同。
- KV head 数不同。
- head dimension 不同。
- attention 配置不同。
- tokenizer 不同。
- 模型家族不同。

论文将 translation layer 视为可学习模块。训练目标既可以是 KV 表示距离，也可以更关注 downstream logits、attention 行为、困惑度和任务准确率。作者强调，最小化 raw KV distance 不一定等价于最好的下游行为。

## 4. 实验设置

论文评测三种迁移：

| 场景 | 源模型 | 目标模型 | 变化 |
| --- | --- | --- | --- |
| 同家族不同规模 | Qwen2.5-7B-Instruct | Qwen2.5-1.5B-Instruct | 同家族、规模不同 |
| 跨家族同量级 | Qwen2.5-1.5B-Instruct | Gemma-2-2B-IT | 架构/家族不同，规模接近 |
| 跨家族降尺度 | Llama3.1-70B | Qwen2.5-7B | 家族不同、规模差约 10× |

handoff 流程是：

1. 源模型对 prompt 做 prefill。
2. 得到源模型 native KV。
3. translation module 把源 KV 映射到目标 KV 表示空间。
4. 目标模型跳过完整 prompt prefill，直接从 translated KV 开始 decode。

论文特别说明：handoff latency 测的是“源 KV 已经存在时的增量交接成本”，不包含源模型产生 KV 的 prefill 成本。因此不能把它直接理解成端到端从零开始的总延迟。

## 5. 主要结果

### 5.1 同家族：Qwen2.5-7B → Qwen2.5-1.5B

LongBench2 准确率：

| 模式 | 准确率 |
| --- | ---: |
| Qwen2.5-7B 原生 | 45.69% |
| Qwen2.5-1.5B 原生 | 27.59% |
| 7B KV → 1.5B decode | 34.48% |

相比目标小模型原生推理，提升 **6.89 个百分点**，恢复了约 38.1% 的 1.5B 与 7B 原生准确率差距。

长上下文下性能仍有下降：

| 上下文长度 | handoff 准确率 |
| --- | ---: |
| 8K–16K | 40.74% |
| 16K–32K | 32.58% |

这表明 KV translation 可以携带有效信息，但上下文越长，表示对齐难度越高。

延迟方面：

| 上下文长度 | 1.5B 原生 prefill | handoff |
| --- | ---: | ---: |
| 8K–16K | 158.7 ms | 34.5 ms |
| 16K–32K | 288.3 ms | 53.8 ms |

handoff 相比目标模型 prefill 分别约为 4.6× 和 5.4× 降低。翻译本身约 9.1–12.2 ms，peer copy 和 cache assembly 约 5.7–8.1 ms；论文也指出仍有一部分运行时同步和集成开销没有被当前 instrumentation 解释。

### 5.2 跨家族同量级：Qwen2.5-1.5B → Gemma-2-2B

目标侧 prefill 成本随上下文增长，handoff 的相对收益扩大：

| Prompt 长度 | Gemma 原生 prefill | handoff | 降低 |
| --- | ---: | ---: | ---: |
| 128 | 5.492 ms | 3.007 ms | 45.25% |
| 1K | 40.105 ms | 16.081 ms | 59.90% |
| 4K | 181.706 ms | 59.897 ms | 67.04% |

解码 perplexity 与原生 baseline 接近，但不同 horizon 并非单调更好；在 H=512 时 handoff perplexity 为 14.037，高于 native Gemma 的 13.574。

### 5.3 跨家族降尺度：Llama3.1-70B → Qwen2.5-7B

| 模式 | 准确率 | 延迟 |
| --- | ---: | ---: |
| Llama3.1-70B 原生 | 44.0% | 7,328 ms |
| Qwen2.5-7B 原生 | 45.7% | 899 ms |
| Llama KV → Qwen decode | 44.0% | 138 ms |

handoff 相比目标 Qwen 原生推理约 **6.5×** 更快，相比源 Llama 原生路径约 **53.1×** 更快；准确率只比目标 Qwen 原生低 1.7 个百分点。

## 6. 这篇论文对 KVC 的真正影响

### 6.1 KVC 的对象从“模型本地 KV”变成“可翻译计算状态”

传统 KVC key 通常隐含绑定：

```text
model_id + tokenizer + prefix_hash + block
```

跨模型共享后，KVC 需要区分：

```text
source_model
source_layout
target_model
translation_version
translation_quality/profile
context_prefix
```

一个源 KV 不再只有“存在/不存在”两个状态，还要回答：

```text
能否翻译到目标模型？
翻译成本多少？
目标模型质量损失多大？
目标 TP/layout 是否兼容？
```

### 6.2 ReplicaSet 需要加入“可消费目标”维度

普通 KV 副本主要区分位置、设备和 layout。跨模型 KV 还需要描述：

```text
source_model = Qwen2.5-7B
target_compatibility = {
  Qwen2.5-1.5B: translator-v3,
  Qwen3-4B: translator-v1
}
```

也可以不预生成所有目标副本，而是保存源 KV + translator registry：

```text
source KV object
        │
        ├─ translator A → target model A
        ├─ translator B → target model B
        └─ fallback → native target prefill
```

这会带来新的准入和缓存策略：对于热点源 KV，预生成多个目标 representation 可能划算；对于冷对象，应只保存源 KV，按需翻译。

### 6.3 检索不再是单纯 prefix hit

目标请求到达后，检索器需要评估：

```text
source KV 是否存在
是否有 source→target translator
translation + transfer + assembly 是否小于 target prefill
质量 profile 是否满足业务要求
```

成本选择可写成：

\[
T_{reuse}=T_{lookup}+T_{translate}+T_{transfer}+T_{assembly}
\]

只有当：

\[
T_{reuse}<T_{native\_prefill}
\]

并且质量门槛通过时，才走跨模型复用；否则回退到目标模型 native prefill。

### 6.4 传输协议需要区分 source 与 target layout

论文实验明确测量了 peer copy 和 cache assembly。系统实现上，这意味着跨模型 handoff 至少包括：

1. 源模型 KV 的物理布局。
2. 翻译器所需的输入布局。
3. 目标模型 KV cache spec。
4. 目标 TP/DP/head 分片。
5. 翻译后的 cache 写入位置。

因此它不是简单的 Mooncake raw-byte copy，而是：

```text
source KV
   │
   ├─ transfer / peer copy
   ├─ translation
   └─ target cache assembly
```

### 6.5 质量和版本需要进入 KVC 元数据

跨模型翻译不是无损复用。建议对象元数据增加：

```text
source_model_revision
target_model_revision
translator_id/version
training_domain
quality_profile
context_length_range
expected_accuracy/perplexity delta
```

这与普通 prefix cache 的“token hash 相同即可复用”不同。跨模型对象的可用性是一个带质量约束的条件命中。

## 7. 它与 KDA/GDN state 的区别

这篇论文主要讨论的是 Transformer KV translation，不能直接等同于 KDA/GDN recurrent state transfer。

普通 token KV：

- 可以按 token/layer/head 进行映射。
- 目标是生成另一模型可消费的 K/V 表示。
- 可通过 translator 学习近似关系。

KDA/GDN state：

- 是递归状态，不是完整 token KV 列表。
- 必须对应精确的序列边界。
- 需要满足 recurrent state shape、gate semantics 和 state layout。
- 错误会影响后续整个 decode 轨迹。

因此跨模型 KV sharing 对 KDA/GDN 的启发是“增加 translation layer”，但不能直接把 KDA state 当成普通 Transformer KV 进行跨模型映射。KDA/GDN 需要额外研究：

- recurrent state translator。
- boundary/state-position 对齐。
- gate 和状态转移语义的迁移。
- 翻译误差随递归步数的累积。
- state snapshot 的 generation 和 accepted-token 语义。

## 8. 论文的局限与阅读注意点

1. **实验规模有限**：只评测三组 source-target，不能直接外推到所有模型家族。
2. **handoff 不包含源 prefill 成本**：如果源模型只是为了产生 KV 而额外运行，端到端收益要重新计算。
3. **质量不是无损**：同家族场景有明显收益，跨家族场景也出现 accuracy/perplexity gap。
4. **translator 泛化未知**：换模型 revision、领域、上下文长度或 tokenizer 后需重新验证。
5. **部署数据面尚不完整**：cache transfer、translation、assembly 的系统开销仍有未解释部分。
6. **与 prefix cache 的关系不是替代**：它更像在传统 same-model prefix cache 之上增加跨模型 fallback/复用路径。

## 9. 对 KVC 架构的建议

如果把这项工作纳入 vLLM-Ascend/Mooncake/AscendStore 的路线，建议新增一个独立的对象层：

```text
ContextObject {
  source_model
  source_layout
  prefix_identity
  cache_family = TOKEN_KV
  translation_registry
  quality_profile
  replicas
}
```

目标请求执行：

```text
1. 精确查询 source KV object
2. 查询 source→target translator
3. 估算 transfer + translate + assembly
4. 检查质量门槛
5. 选择 cross-model reuse 或 native prefill
```

这与当前报告中 KDA/GDN 的 `RECURRENT_STATE` 应保持语义隔离：

```text
TOKEN_KV + cross-model translator
RECURRENT_STATE + exact boundary/generation
```

两者可以共享远端传输引擎和 metadata service，但不能共用完全相同的命中规则。

## 10. 最终结论

这篇论文的核心不是“KV Cache 可以跨模型直接复制”，而是：

> KV 可以被视为一种可翻译的上下文计算表示；在翻译成本低于目标模型 prefill、且质量损失可接受时，跨模型共享是有价值的。

它把 KVC 的边界从：

```text
同模型 prefix cache
```

推向：

```text
跨模型 context mobility
```

但目前更适合看作早期可行性证据和系统抽象，距离通用生产级跨模型 KVC 还需要解决 translator 泛化、质量门控、版本管理、layout 适配、传输成本和端到端收益核算。

## 11. 参考链接

- [arXiv 摘要页](https://arxiv.org/abs/2608.30963)
- [arXiv HTML 全文](https://arxiv.org/html/2608.30963v1)
- [公众号原文](https://mp.weixin.qq.com/s/Y9ALxpuKFhxNP-YMl-Jnuw)
