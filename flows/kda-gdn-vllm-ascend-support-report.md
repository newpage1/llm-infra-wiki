---
section: 新模型
summary: KDA 与 GDN 同属线性注意力，状态大小不随上下文线性增长；KDA 可看作 GDN 的细粒度泛化（遗忘门细化到每个 value head 与 key 特征维度），并对比两者在 vLLM-Ascend 上的支持现状。
---

# KDA 与 GDN 技术对比及 vLLM-Ascend 支持现状

> 调研日期：2026-09-07
>
> 适用范围：Kimi Delta Attention、Gated DeltaNet、Kimi-K3、vLLM-Ascend

## 1. 执行摘要

KDA（Kimi Delta Attention）与 GDN（Gated DeltaNet）属于同一类线性注意力机制。两者都使用固定大小的矩阵状态保存历史信息，并通过“遗忘门 + Delta Rule”更新状态，因此其推理状态大小不随上下文长度线性增长。

KDA 可以理解为 GDN 的细粒度泛化：

- GDN 通常给每个 attention head 使用一个标量遗忘门，整个 head 的历史状态按同一比例衰减。
- KDA 将遗忘门细化到每个 value head、每个 key 特征维度，使模型能够选择性保留或清除不同特征方向的记忆。
- 当 KDA 同一 head 内所有特征维度的门值相等时，其状态衰减形式可以退化为 GDN 的标量门控形式。

截至 2026-09-07，vLLM-Ascend 已经具备 KDA 算子和 Kimi-K3 模型适配，并提供 Kimi-K3 官方部署指南。但官方支持矩阵仍将 Kimi-K3 标记为实验性支持，当前明确验证的主路径是 Atlas A3、W4A8、多机部署。不能仅根据底层 KDA 算子已经存在，就推断所有使用 KDA 的模型 checkpoint 都可以直接运行。

## 2. 背景

标准 Softmax Attention 在推理时通常需要保存随序列长度增长的 KV Cache。对于超长上下文，KV Cache 会带来显著的设备内存和访存压力。

GDN 和 KDA 将历史信息压缩到固定大小的 recurrent state 中。其共同目标包括：

- 将序列维度上的推理复杂度控制在线性范围内。
- 避免线性增长的传统 KV Cache。
- 使用 Delta Rule 对记忆进行定向修改，而不是只做累加。
- 使用遗忘门清除过期信息，缓解有限状态容量下的记忆冲突。

Kimi Linear 采用混合架构，而不是完全移除全局注意力。其公开模型使用 KDA 与全局 MLA 组合，在效率和精确检索能力之间取得平衡。

## 3. GDN 的核心机制

Gated DeltaNet 将遗忘门与 Delta Rule 结合。若使用矩阵状态 \(S_t\)，可以把其核心过程概括为：

\[
\widetilde{S}_t = \alpha_t S_{t-1}
\]

\[
S_t = \widetilde{S}_t
      + \beta_t k_t
        \left(v_t-k_t^\top\widetilde{S}_t\right)^\top
\]

\[
o_t=q_t^\top S_t
\]

其中：

- \(\alpha_t\) 是遗忘门，控制旧状态整体保留多少。
- \(\beta_t\) 是 Delta 更新强度。
- \(k_t^\top\widetilde{S}_t\) 是当前状态对 key 的已有预测。
- \(v_t-k_t^\top\widetilde{S}_t\) 是预测误差。
- Delta Rule 只把预测误差写入与 \(k_t\) 对应的状态方向，因此比无条件累加更适合修改已有记忆。

遗忘门和 Delta Rule 的作用互补：遗忘门可以快速清除旧信息，Delta Rule 可以对指定记忆方向进行精确更新。

## 4. KDA 的核心机制

KDA 保留 Gated Delta Rule 的基本结构，但把标量衰减升级为逐 key 维度衰减。其 recurrent 形式可概括为：

\[
\widetilde{S}_t = D_t S_{t-1},
\qquad
D_t=\operatorname{diag}\left(\exp(g_t)\right)
\]

\[
S_t = \widetilde{S}_t
      + \beta_t k_t
        \left(v_t-k_t^\top\widetilde{S}_t\right)^\top
\]

\[
o_t=q_t^\top S_t
\]

在官方 FLA 参考实现中，KDA 的门张量为：

```text
g: [batch, sequence, value_heads, key_dimension]
```

这意味着不同 value head 的每一个 key channel 都可以具有独立衰减率。其单步实现逻辑可以简化为：

```python
state = state * exp(g_t)
prediction_error = v_t - k_t @ state
state = state + outer(beta_t * k_t, prediction_error)
output = q_t @ state
```

由于状态转移由“对角矩阵衰减 + 低秩 Delta 更新”组成，KDA 的状态转移常被描述为 DPLR（Diagonal Plus Low Rank）结构。

## 5. 相似性

### 5.1 同属线性注意力/线性 RNN

两者都把历史 token 压缩进有限大小的矩阵状态。在逐 token decode 时，只需读取和更新 recurrent state，不需要对全部历史 token 重新执行注意力计算。

### 5.2 都采用 Delta Rule

两者写入的不是原始 value，而是 value 与当前状态预测之间的误差。这使状态具备覆盖和修正已有关联的能力。

### 5.3 都具有显式遗忘机制

遗忘门使模型能主动清除不再需要的历史信息。没有门控时，有限状态更容易被长期累积的信息污染。

### 5.4 都需要两类执行路径

- Prefill：采用 chunk-wise 并行算法，以避免完全串行的 recurrent 计算。
- Decode：采用 recurrent kernel，每步更新一次状态。

### 5.5 都可以与标准注意力组成混合架构

线性状态适合高效维护长程上下文，全局或局部标准注意力则可提供更精确的 token-level 检索。实际模型通常组合使用，而非二选一。

## 6. 关键区别

| 对比维度 | GDN | KDA |
| --- | --- | --- |
| 遗忘门粒度 | 通常每个 head 一个标量 | 每个 value head、每个 key 维度一个门值 |
| 状态衰减 | \(\alpha_t I\) | \(\operatorname{diag}(\exp(g_t))\) |
| 遗忘能力 | 整个 head 同步遗忘 | 可选择性遗忘不同特征方向 |
| 表达能力 | 较强，但门控自由度有限 | 更高的特征级记忆控制能力 |
| 状态转移结构 | 标量衰减加低秩更新 | 对角衰减加低秩更新（DPLR） |
| Head 组织 | 一般使用对齐的 head 结构 | 支持 Q/K heads 与 value heads 分组映射 |
| Chunk 算法 | Gated Delta Rule 的 chunk 并行 | 需处理逐维门控，对并行算法和内核要求更高 |
| 工程成本 | 相对较低 | 门张量更大，算子融合和内存访问更复杂 |

最直观的区别是：

> GDN 决定“这个 head 的历史整体保留多少”；KDA 决定“这个 head 中每个 key 特征方向分别保留多少”。

## 7. KDA 与 GDN 的包含关系

若 KDA 在某个 head 内满足：

\[
g_{t,1}=g_{t,2}=\cdots=g_{t,d_k}
\]

则：

\[
D_t=\alpha_t I
\]

此时 KDA 的逐维衰减退化为统一标量衰减。因此从状态更新表达能力看，可以把 GDN 看作 KDA 的一个受限特例。

但工程上不能把两者当成同一个算子：KDA 的门张量布局、chunk 前缀累积、状态更新和 kernel 参数均更复杂，仍需要专门实现。

## 8. Kimi 架构中的 KDA

KDA 首先公开于 Kimi Linear。Kimi Linear 官方资料将其描述为 Gated DeltaNet 的改进版本，并强调 fine-grained gating。

Kimi Linear 公开模型采用约 3:1 的 KDA 与全局 MLA 混合比例。其设计目的不是完全用有限状态替代所有注意力，而是：

- 大部分层使用 KDA，降低长上下文推理开销。
- 少部分层使用全局 MLA，保留精确检索和全局 token 交互能力。

Kimi-K3 进一步组合了 KDA、Gated MLA、Attention Residuals、SiTU 和大规模稀疏 MoE。因此“支持 KDA kernel”只是支持 Kimi-K3 的必要条件之一，还需要完成模型结构、MoE、量化、多模态、缓存、并行和解析器等完整适配。

## 9. vLLM-Ascend 当前支持状态

### 9.1 已经具备的能力

截至调研日期，vLLM-Ascend `main` 已包含：

- KDA prefill 使用的 `chunk_kda_fwd` AscendC 算子。
- KDA decode 使用的 `recurrent_kda` AscendC 算子。
- `kda_gate_cumsum` 和数据布局转换等辅助算子。
- Triton Ascend KDA 实现与相关单元测试。
- `vllm_ascend/ops/kimi_kda.py` 中的 Kimi-K3 Ascend 后端适配。
- `vllm_ascend/models/kimi_k3.py` 模型适配。
- Kimi-K3 的 operator、unit、pull-request 和 nightly 测试。

Kimi-K3 的首次完整支持 PR 为 `#12950`，已于 2026-07-31 合入 `releases/v0.26.0rc`。PR 描述明确覆盖：

- Kimi-K3 模型架构与混合 MLA/KDA。
- KDA/GDN prefill、decode 和 recurrent state 管理。
- 混合 KV Cache 规格。
- W4A8 量化 MoE 与 SiTU。
- 多模态处理。
- DSpark 推测解码。
- PD 分离与 KV Transfer。
- reasoning、tool call 和 tokenizer/renderer 适配。

### 9.2 官方支持等级

官方支持矩阵中，Kimi-K3 的状态为：

| 项目 | 当前状态 |
| --- | --- |
| 总体支持等级 | 实验性支持（🔵） |
| 明确验证硬件 | Atlas A3 |
| 明确验证权重 | W4A8 |
| Automatic Prefix Cache | 支持 |
| Speculative Decoding | 支持，文档给出 DSpark 配置 |
| Tensor Parallel | 支持 |
| Expert Parallel | 支持 |
| Data Parallel | 支持 |
| Fullgraph ACL Graph | 支持，部署指南采用 `FULL_DECODE_ONLY` |
| LoRA | 支持矩阵未标记支持 |
| BF16 | 支持矩阵未标记支持 |

因此，对“vLLM-Ascend 是否已经支持 KDA Kimi”的准确回答是：

> 如果指 Kimi-K3，答案是已经支持，并且已有部署文档、模型适配、专用算子和测试；但当前仍属于实验性支持，主要验证路径为 Atlas A3 + W4A8。

### 9.3 版本边界

- `releases/v0.26.0rc`：已经合入首个完整 Kimi-K3 支持 PR。
- `v0.26.0rc1`：截至调研日期已发布，包含该 release 分支上的 Kimi-K3 支持。
- `main`：继续包含 Kimi-K3，并已适配 vLLM 0.27 系列；官方当前部署指南基于 `vLLM-Ascend main + vLLM 0.27.1`。
- 生产环境应固定 vLLM-Ascend commit、其匹配的 vLLM commit 和镜像 digest，不建议任意混用版本。

## 10. Kimi-K3 官方参考部署约束

官方部署指南当前针对完整 W4A8 checkpoint 给出的参考条件包括：

- 硬件：Atlas 800 A3。
- 拓扑：4 台节点，每节点 16 个逻辑 NPU，共 64 个逻辑 NPU。
- 并行：DP4、TP16、EP64。
- 权重存储：约 1.49 TB，尚不包含运行时状态、激活和通信 buffer。
- 最大模型长度示例：133,120 tokens。
- ACL Graph：`FULL_DECODE_ONLY`。
- 可选能力：Prefix Cache、DSpark 推测解码、多模态、自动工具调用。

这是一套官方验证参考配置，不表示它是所有 workload 的最优配置，也不表示较小 checkpoint 或其他硬件无法运行。

## 11. “支持 KDA”不等于“支持所有 Kimi 模型”

需要区分以下三个层级：

1. **算子支持**：设备后端能执行 chunk KDA 和 recurrent KDA。
2. **模型架构支持**：推理框架能正确加载模型层、组织混合注意力和管理 recurrent state。
3. **checkpoint 级验证**：特定权重格式、量化方式、并行策略和硬件组合已经通过精度与性能验证。

vLLM-Ascend 已完成 Kimi-K3 的这三层适配，但验证范围仍有限。

对于 `moonshotai/Kimi-Linear-48B-A3B-*`：

- 上游 vLLM 和 Kimi Linear 官方资料给出了部署方式。
- vLLM-Ascend 已有底层 KDA 能力。
- 但该 checkpoint 没有出现在 vLLM-Ascend 官方支持矩阵，也没有对应的官方 Ascend 部署教程。

因此目前不能把它归类为 vLLM-Ascend 官方已验证模型。若要在 Ascend 上运行，需要另外验证模型注册、权重加载、量化方法、KDA cache spec、MoE 路径和输出精度。

## 12. Kimi-K2 系列与 Kimi-K3 的区别

“Kimi 模型”并不是单一架构：

- Kimi-K2、Kimi-K2.5、Kimi-K2.6 等模型在 vLLM-Ascend 中有各自独立的支持条目与部署文档。
- Kimi-K3 的官方架构说明明确包含 KDA，并具有专门的 `KimiK3DeltaAttention` 和 Ascend KDA 后端。
- 不能因为某个 Kimi-K2 checkpoint 已经支持，就推断它使用 KDA；也不能因为 Kimi-K3 使用 KDA，就推断所有 Kimi checkpoint 都走相同执行路径。

## 13. 工程实现映射

vLLM-Ascend 中，KDA 复用了 GDN attention backend 的元数据和 recurrent-state 管理抽象。典型调用关系可以概括为：

```text
Kimi-K3 model layer
        │
        ▼
AscendKimiK3DeltaAttention
        │
        ├── Prefill ──► chunk KDA kernel
        │
        └── Decode ───► recurrent KDA kernel
                           │
                           ▼
                  GDN backend metadata/state
```

这种复用源于两者都属于 gated delta recurrent attention，并不表示 KDA 和 GDN 的数学门控完全一致。

Prefill 和 decode 必须共享一致的 state 布局、head 映射和门控语义，否则会出现 prefill 输出正确但后续 decode 漂移的问题。KDA 适配的验证重点通常包括：

- Chunk 与 recurrent 结果一致性。
- Variable-length 和 continuous batching。
- graph padding token 不污染 recurrent state。
- Prefix Cache 命中后状态恢复正确。
- 推测解码接受/拒绝 token 时状态回滚或更新正确。
- TP/DP/EP 下 state index 和 cache ownership 正确。

## 14. 使用建议

### 14.1 计划部署 Kimi-K3

建议优先采用官方已验证组合：

1. 使用 Atlas A3。
2. 使用官方部署指南指定的 W4A8 checkpoint。
3. 使用 `main` 对应的 nightly A3 镜像，或从同一 commit 构建镜像。
4. 使用仓库 `.github/vllm-main-verified.commit` 指定的上游 vLLM revision。
5. 先执行短上下文功能和精度验证，再逐步增加上下文长度、并发和 Prefix Cache。
6. 将 DSpark、ACL Graph、Prefix Cache 分别开关验证，避免一次引入多个变量。

### 14.2 计划部署 Kimi-Linear-48B-A3B

应先做兼容性验证，不建议直接按“官方支持”处理：

- 检查上游 vLLM 使用的模型类是否会被 vLLM-Ascend 正确替换或接管。
- 确认 KDA tensor shape、head 数量、state layout 与 Ascend kernel 接口一致。
- 检查权重是否为 vLLM-Ascend 已支持的量化格式。
- 用短序列逐层或端到端对比 Hugging Face/FLA reference 输出。
- 分别验证 prefill、单步 decode、连续批处理和长上下文。

### 14.3 生产使用

鉴于官方仍标记为实验性支持，生产上线前至少应完成：

- 固定版本与镜像 digest。
- 目标数据集精度回归。
- 长上下文稳定性测试。
- 多并发和 continuous batching 压测。
- Prefix Cache 冷/热命中正确性测试。
- 多机异常、超时和重启恢复测试。
- 与未启用 DSpark/Graph 的基线输出对比。

## 15. 最终结论

1. KDA 与 GDN 的核心相似性，是都采用带门控的 Delta Rule 和固定大小 recurrent state。
2. 二者最重要的区别，是 GDN 通常进行 head-wise 标量遗忘，而 KDA 进行 key-channel-wise 逐维遗忘。
3. KDA 的逐维门控带来更强表达能力，也增加了 chunk 并行、kernel 融合、内存访问和状态管理的复杂度。
4. vLLM-Ascend 已经支持 Kimi-K3 的 KDA 执行，包括 prefill 和 decode 专用算子，以及模型、缓存、量化、MoE 和并行适配。
5. 当前支持仍为实验级，官方明确验证范围主要是 Atlas A3 + W4A8；不能泛化为所有 Ascend 产品、所有精度或所有 Kimi checkpoint。
6. 原始 Kimi-Linear-48B-A3B checkpoint 尚未出现在 vLLM-Ascend 官方支持矩阵，应视为“底层能力可能具备，但 checkpoint 未经官方验证”。

## 16. 参考资料

1. Moonshot AI, **Kimi Linear: An Expressive, Efficient Attention Architecture**
   <https://github.com/MoonshotAI/Kimi-Linear>

2. Songlin Yang et al., **Gated Delta Networks: Improving Mamba2 with Delta Rule**
   <https://arxiv.org/abs/2412.06464>

3. Flash Linear Attention, **KDA Reference Implementation**
   <https://github.com/fla-org/flash-linear-attention/tree/main/fla/ops/kda>

4. vLLM-Ascend, **Kimi-K3 Deployment Guide**
   <https://github.com/vllm-project/vllm-ascend/blob/main/docs/source/tutorials/models/Kimi-K3.md>

5. vLLM-Ascend, **Supported Models Matrix**
   <https://github.com/vllm-project/vllm-ascend/blob/main/docs/source/user_guide/support_matrix/supported_models.md>

6. vLLM-Ascend PR #12950, **Support Kimi K3 on Ascend**
   <https://github.com/vllm-project/vllm-ascend/pull/12950>

7. vLLM-Ascend, **Ascend Kimi-K3 KDA Backend**
   <https://github.com/vllm-project/vllm-ascend/blob/main/vllm_ascend/ops/kimi_kda.py>
