---
section: know-how
summary: 7 篇长上下文缓存论文的原文分析：Strata、ECHO、DirectKV、SYMPHONY、DroidSpeak、Cortex、ZipLLM 各自处理的层并不相同，把它们统称为「非前缀 KV 匹配」会掩盖关键差异。
---

# 长上下文 LLM 缓存与存储论文分析报告

## 0. 说明与论文校正

本报告基于 7 篇论文 PDF 原文（摘要、设计、实验和讨论章节）整理，而不是仅依据论文标题或搜索摘要。用户最初列出的 “Contextra” 在公开论文中对应的是 **Strata: Hierarchical Context Caching for Long Context Language Model Serving**；“No Buffer No Bottleneck”对应正式系统名 **DirectKV**、正式标题 **No Buffer, No Bottleneck: Efficient Zero-Copy KV Cache Offloading for Long-Context LLMs**。

七篇论文的研究对象并不完全相同：Strata、ECHO、DirectKV、SYMPHONY 主要处理 KV 缓存的容量、层级位置、搬运和调度；DroidSpeak 扩大 KV 的复用边界到不同微调模型；Cortex 缓存的是远程知识结果而不是 Transformer KV；ZipLLM 处理模型权重仓库的去重与压缩。把它们都称为“非前缀 KV 匹配”会掩盖关键差异。

## 1. 执行摘要

### 1.1 核心判断

1. **vLLM/SGLang 原生缓存仍以 exact prefix reuse 为主。** vLLM 的 prefix caching 和 SGLang 的 RadixAttention 都要求请求中的 token 序列与已有缓存形成连续前缀；它们解决的是“同一模型、同一前缀”的精确复用，不会自动把两个不相邻的相同片段拼成一个可直接使用的 KV。
2. **CacheBlend 代表“同一模型、非前缀 chunk/token 复用”。** 它把多个检索 chunk 的 KV 拼接后，对部分 token/chunk 重算以修正跨 chunk 的注意力依赖，目标是扩大复用范围，同时承担一定质量和调度开销。
3. **DroidSpeak 进一步跨越模型边界。** 对相同架构、不同权重（典型是同一基座的 fine-tuned variants），只重算少数连续 critical layers，其余层复用发送模型 KV；这是 7 篇论文中最接近“跨模型非前缀复用”的工作。
4. **其余论文主要优化“缓存怎么放、怎么搬、何时搬”，不改变 prefix matching 的语义。** Strata 优化层级 I/O 与调度，ECHO 优化稀疏注意力下的动态 recall，DirectKV 用零拷贝直接访问 CPU KV，SYMPHONY 做会话级迁移和预取。
5. **Cortex 是语义缓存而不是 KV 缓存。** 它用 ANN + 小模型语义判别器判断两个远程查询/结果是否等价，允许非 exact-match；但命中的是知识结果，不能把 Cortex 命中直接当作 Transformer KV 命中。
6. **ZipLLM 与请求级 KV 正交。** 它降低模型权重仓库存储、分发和冷启动成本，可与 DroidSpeak 或层级 KV 缓存组合，但不会提高某个请求的 token-level cache hit。

### 1.2 统一问题模型

长上下文服务的瓶颈可拆成四类：

| 层次 | 主要问题 | 代表论文 | 是否改变匹配边界 |
|---|---|---|---|
| 复用语义 | 哪些历史状态可直接使用 | vLLM/SGLang prefix、CacheBlend、DroidSpeak、Cortex | prefix→chunk/token→跨模型→语义结果 |
| 容量与层级 | HBM 放不下全部 KV | Strata、SYMPHONY、ECHO、DirectKV | 通常不改变 |
| 搬运与执行 | CPU/SSD↔GPU 带宽、拷贝、kernel stall | Strata、ECHO、DirectKV | 不改变 |
| 权重存储 | 多个 fine-tuned 模型重复占空间 | ZipLLM | 不适用请求 KV |

## 2. 逐篇解析

## 2.1 Strata：分层 context caching + GPU-assisted I/O + cache-aware scheduling

**论文定位。** Strata 是 OSDI 2026 论文，集成到 SGLang 并在生产环境部署。它不提出新的语义匹配算法，而是解决“已有 prefix/KV 命中以后，如何高效从 CPU/SSD 取回”的系统问题。

### 问题与观察

- 长上下文使 KV 容量线性增长。论文给出的例子是：40 GB HBM 对 Llama-8B 只能容纳约 0.3M token 的 KV。
- 传统 PagedAttention 把逻辑页分散到多个小块，单次传输可能只有数 KB，无法打满 PCIe/NVLink。增大页大小虽可提高搬运效率，却会降低匹配粒度和命中率。
- 在 LooGLE + Qwen2.5-14B 的分析中，SGLang CPU offload 场景最多有 **74% 的 prefill 时间阻塞在 KV 传输**；即便使用优化 I/O，仍有约 **24%** 的 prefill 时间处于 cache-loading stall。
- 并发请求使用相同长上下文时会产生 **delay hit**：后来的请求在第一次 miss 尚未加载完时到达，无法复用正在生成的缓存，导致重复 prefill。

### 系统设计

1. **GPU-assisted I/O。** 不反复调用小粒度 `cudaMemcpyAsync`，而是启动 CUDA kernel，由大量线程直接把 CPU pinned memory/GPU global memory 中的小块流式搬运到目标地址。最小高效粒度约 128 B，因而不必为了 I/O 强行增大 cache page。
2. **布局解耦。** GPU 采用适合 attention 的 layer-first 布局；CPU/SSD 采用适合大块传输的 page-first 布局。GPU kernel 在搬运时做近乎免费的地址变换，避免在“计算友好”和“传输友好”之间二选一。
3. **受控资源配额。** 通过少量大 CUDA block 把 I/O kernel 限制在很少的 SM 上，并使用 bypass-cache 指令降低污染。H200 微基准中，2 个 1024-thread block 可实现约 48 GB/s 传输，同时 prefill 性能下降小于 5%、decode 下降约 10%。
4. **cache-aware scheduler。** 通过 HiRadixTree 记录页元数据，执行 delay-hit mitigation、按计算量和加载量构造 balanced batch，并在不可避免的 I/O stall 时插入 decode 等互补工作，隐藏等待。
5. **存储层预取。** 发现 SSD 命中后，Cache Controller 在请求排队期间把数据预取到 host memory；支持 best-effort、await-complete 和 timeout 三种策略。

### 实验设置与结果

- 模型/数据：Llama-8B、Llama-70B、Qwen2.5-14B；LooGLE、ReviewMT、NarrativeQA、ShareGPT；H200 等平台。
- 在 LooGLE 上，相同 TTFT 下，Strata 相对 SGLang-HiCache、vLLM-LMCache、TRT-LLM-HiCache 的吞吐最高分别提升约 **3.2×/2.6×/1.9×（Llama-8B）**、**3.9×/2.1×/1.9×（Qwen-14B）**、**5×/5×/3.75×（Llama-70B）**。
- 论文摘要给出的总体上限是相对 vLLM-LMCache **最高 5×**、相对 TensorRT-LLM **最高 3.75×**；短上下文性能没有明显下降。
- warm-cache 的 NarrativeQA 场景中，相对 vLLM-LMCache，Llama-8B/Qwen-14B/Llama-70B 吞吐最高约 **2.3×/2.6×/2.5×**。
- 消融实验显示，单独 scheduling 最高带来约 **1.8×**，单独 Strata-IO 最高约 **2.3×**；高请求率时 I/O 优化更关键。

### 局限与适用条件

- 仍然依赖 exact prefix/radix 命中；未解决两个非前缀 chunk 的拼接和一致性。
- GPU-assisted I/O 会占用 SM、寄存器和内存带宽，需要按模型和硬件调配额。
- SSD/远端存储延迟和抖动更大，best-effort 预取可能在请求真正执行前未完成。
- 论文以 H200/生产级 GPU 为主，普通 PCIe GPU 上的收益取决于 DMA 和 host memory 带宽。

### 对 vLLM/SGLang 的启示

最现实的移植路径是保留现有 RadixTree/prefix cache，只替换 KV tier 的 data plane：增加 page-first host layout、GPU-assisted transfer、按加载成本建 batch 的 scheduler，以及 delay-hit 去重。它与 CacheBlend 是互补关系：CacheBlend 增加“能命中的内容”，Strata 降低“命中后取回的成本”。

## 2.2 ECHO：稀疏注意力 KV offload 与无损预取

**论文定位。** ECHO 是 OSDI 2026 论文，基于 SGLang + DeepGEMM，面向 DeepSeek-V3.2 这类 native sparse-attention 模型。稀疏注意力减少计算和实际访问 token 数，却不减少完整 KV cache 的存储量，因此 HBM 容量仍是瓶颈。

### 核心机制

1. **graph-friendly cache manager。** 动态 eviction/recall 使用定长元数据和并行操作，可全部放在 CUDA Graph 内执行，避免动态 tensor 和 CPU 管理打断 decode graph。
2. **lossless intra-query prefetch（decode）。** 利用 index score 的数值可预测性，在 top-k 边界最终确定前预取候选 KV；如果预测不准确，仍会执行 guaranteed recall，因此不会引入额外质量损失。
3. **lossless inter-query prefetch（prefill）。** 利用 prefill 按 query block 顺序处理的特征，在处理当前 query 时预取后续 query 可能访问的 KV。
4. **融合 kernel + software pipelining。** 让 producer warp 取 KV、consumer warp 做 indexer/attention 计算，重叠 host-GPU recall 与计算。

### 实验结果

- 8×H20、InfiniteBench（318 个 80K–100K token 请求）及 ShareGPT；比较 SGLang、vLLM。
- HBM 不受限、请求同时到达时，ECHO 相对 SGLang/vLLM 的 generation throughput 最高约 **2.15×/4.1×**。
- GPU KV pool 限制为 200K token 时，相对 SGLang 最高约 **3.10×**；限制为 110K token 时最高约 **4.12×**。
- InfiniteBench 分任务吞吐：Code.Debug **+27.07%**、En.MC **+2.83%**、En.QA **+7.11%**，Code.Run 略低于 SGLang **1.74%**。
- 轻负载下 TTFT 最多增加约 **7.9%**，ITL 增加 **2.7%–27.8%**；中高请求率时端到端额外开销降到约 4.6% 以下。全层 offload 管理在一个 decode step 约 1.15 ms，仅占 all-layer decode 的约 0.28%。
- GPU pool hit rate 大多数层为 **0.97–0.99**，第 12/17 层约 0.95/0.88。intra-query prefetch 微基准最高 1.51×，端到端吞吐提升约 4%；inter-query prefetch 最高约 1.1×。

### 局限

- 强依赖稀疏注意力 indexer 的“可提前判断”性质；普通 dense attention 没有对应信号。
- 论文重点是动态稀疏 KV 的 recall 成本，不扩大 cache 的语义匹配范围。
- 端到端收益会被 MoE GEMM/通信占据；prefetch 只减少 recall，无法消除其他主路径瓶颈。

### 落地建议

若 SGLang/vLLM 部署 DeepSeek sparse attention，ECHO 的 cache manager 和 graph 内 recall 很有价值；若是普通 dense 模型，应优先采用 Strata/DirectKV/SYMPHONY 的层级搬运方案。

## 2.3 DirectKV：No Buffer, No Bottleneck 的零拷贝 KV offload

**论文定位。** DirectKV 是 OSDI 2026 论文，目标硬件为 GH200/GB200 的 NVLink-C2C CPU-GPU superchip。它针对的是“KV 已在 CPU，但 attention 前还要先搬进 HBM staging buffer”的额外拷贝和显存占用。

### 为什么朴素 zero-copy 不够好

PCIe 带宽约 40–60 GB/s、HBM 约 3–4 TB/s；即使 NVLink-C2C 可达双向 900 GB/s，也明显低于 HBM。朴素 zero-copy 让 GEMM 反复从 CPU 取同一 KV tile，导致 L2 命中率下降：论文测得在 GH200 上延迟约为 HBM baseline 的 2×，PCIe 上可超过 20×。

### 三个 kernel-memory co-design

1. **CPU-memory-aware tiling。** 不按 CPU KV tile 迭代，而按 GPU 中的 A/C tile 迭代，让每个 CPU KV tile 进入 SMEM 后被重复利用，把瓶颈从慢的 CPU-GPU 链路转移到高带宽 HBM。矩阵乘微基准延迟从 106 ms 降到 54 ms，L2 hit 从 32.3% 升到 75.1%。
2. **warp-level pipelining。** producer warp 预取下一 tile，consumer warp 计算当前 tile。HBM 吞吐从 0.3 TB/s 升到 1.3 TB/s，延迟再降约 11%（54→48 ms）。
3. **projection-attention fusion。** 将 K/V projection 和 attention 融合，K/V 保留在 SMEM 中直接消费，避免“写回 CPU→下一个 kernel 再读回”。简化实验中延迟从 85 ms 降到 57 ms，HBM 吞吐升至 1.9 TB/s。

### 系统结构

离线 Kernel Generator 预编译不同精度、head dimension、prefill/decode tile 配置；运行时 Kernel Adaptor 选择候选；Attention Fusion Engine 执行融合 kernel；KV Cache Manager 用 `cudaHostAlloc` 分配 pinned host memory，使 GPU 可直接访问 CPU-resident KV。

### 实验结果

- GH200（96 GB HBM3 + LPDDR5X）、Llama-3.1-8B、OPT-13B/30B；ShareGPT、Alpaca；对比 SGLang、Pie、FlexGen、Neo。
- 端到端相对现有 offload 方案最高约 **1.2×**；CPU-GPU transfer volume 最高减少 **50%**；GPU memory 使用约 **47 GB**，比其他 offload 方案平均节省 35 GB，约 **43%**。
- 在 30 req/s，Llama-8B per-token latency 约 0.75 s，而其他 offload baseline 约 1.55–2.95 s；OPT-13B 在 SGLang OOM 的负载下仍可运行。
- 32K context 时 Neo/Pie/SGLang 出现 OOM 或严重退化，DirectKV 保持可用；相对可运行系统平均约 **1.2×** 加速。
- CPU-aware zero-copy 相对 naive zero-copy 最多降低 **50%** 传输量和 **70%** 延迟；融合 kernel 带来 **2.5–3.0×** 延迟降低、最高 3.5× HBM 吞吐提升。
- NVLink-C2C 相对 PCIe 可带来最高约 **4.2×** attention latency 改善。

### 局限

- 主要收益依赖 NVLink-C2C；PCIe 上更像容量扩展机制，吞吐仍受链路限制。
- 需要重写 attention/projection CUDA kernel，工程成本高，且 tile、SMEM、精度配置与硬件强相关。
- 它不负责请求路由、批处理、淘汰和 prefix 匹配；这些仍由 vLLM/SGLang 的上层管理完成。

### 与 vLLM/SGLang 的集成点

DirectKV 可以作为 CPU-resident KV 的执行后端：保留 vLLM/SGLang 的 prefix cache、continuous batching 和 eviction，只把“从 host KV 执行 attention”替换为 DirectKV kernel。它与 Strata 的区别是：Strata 优化搬运，DirectKV 尽量取消搬运；在 NVLink-C2C 平台上二者可以按 workload 选择或组合。

## 2.4 DroidSpeak：跨微调模型的选择性层重算

**论文定位。** DroidSpeak 是跨 LLM KV 共享论文，集成 LMCache 与 vLLM。假设发送模型和接收模型架构相同但权重不同，典型场景包括同一基座的多个 fine-tuned variants、多 LoRA/模型版本和多 agent 协作。

### 为什么不能直接复用全部 KV

不同权重会改变每层 E/Q/K/V。论文在 8 个模型对上发现，直接复用发送模型的完整 KV 会严重降低接收模型质量；HotpotQA 多数模型对的 F1 下降可超过 50 个百分点。问题不是 token 是否相同，而是不同层对权重差异的敏感度不同。

### 关键发现与算法

1. **critical layers。** 通常约 10% 的层对跨模型 KV 差异敏感；同一模型对的 critical layer 身份对不同输入较稳定。
2. **离线 profiling。** 在 held-out 数据集上枚举连续层组，得到“重算层数—质量”的 Pareto frontier；论文用 2-layer group 粒度，Llama-3-8B 32 层模型的完整 profiling 约需 3 小时/A100，一次性成本可摊销。
3. **连续层组而非离散 critical layers。** 若只重算散落的敏感层，会在多个 transition point 注入发送模型 E cache 误差，并沿后续层传播。将中间非关键层一起纳入连续重算组可显著降低误差。
4. **E cache transition。** 在从复用层切换到重算层时，需要发送对应层的 E cache；E cache 可能是 KV cache 的 2–4 倍（Llama-3.1-70B 尤其明显），因此不能忽略其传输/存储成本。
5. **流水化加载。** 先传 transition E cache，接收模型立即重算；同时异步加载将复用的 KV 层。论文示例中 TTFT 从 30 降到 17 个时间单位，约 2× 改善。

### 实验结果

- 8 个模型对、6 个数据集、QA（F1）、摘要（Rouge-L）、代码（edit/code similarity），两台 Azure 节点、每台 8×A100、InfiniBand。
- 相对 full prefill，prefill latency 降低 **1.7–3.1×**，平均约 **2.1×**；在线服务吞吐最高 **4×**。
- 在与 CacheBlend 相近的 prefill latency 下，质量高 **5%–33%**（平均约 16%）。
- 选定配置可将质量损失控制在约 1% 以内；profile 从 HotpotQA 泛化到其他测试集时，Pareto frontier 平均差约 2 个百分点、最大差 4 个百分点。
- 多 agent MetaGPT coding workflow 的 TTFT 最高改善 **2.7×**；在 Mixtral MoE 对上也有效。

### 与 CacheBlend 的本质区别

| 维度 | CacheBlend | DroidSpeak |
|---|---|---|
| 模型关系 | 通常同一模型 | 不同权重、相同架构模型 |
| 复用粒度 | token/chunk | layer group |
| 修正方法 | 重算部分 token/chunk | 重算连续 critical layers |
| 主要风险 | chunk 拼接后的跨边界误差 | 权重差异导致层间误差传播 |
| 额外状态 | 主要是 KV | KV + transition E cache |
| 典型收益 | 扩大非前缀 chunk 命中 | 跨模型复用、减少 prefill |

### 局限与落地条件

- 必须有相同架构（层数、hidden/head 维度、位置编码等兼容）；完全不同模型不能直接使用。
- 每个模型对需要离线 profiling；模型更新、任务分布变化可能使 critical layer 配置失效。
- E cache 体积可能大于 KV，远端传输成本会抵消部分收益。
- 质量保证是经验性的 profiling，不是数学等价；上线必须持续做任务级质量抽检。

### 对 vLLM/SGLang 的启示

DroidSpeak 已证明 vLLM + LMCache 可以把“prefix cache key”扩展为 `(context, sender_model, receiver_model, layer_group)`。若要在 SGLang 实现，需要在 RadixTree 命中后增加跨模型版本索引、transition E cache、连续层重算调度，以及质量 profile 管理。这是 7 篇论文中最值得作为“非前缀/跨模型 KV 复用”原型起点的工作。

## 2.5 Cortex：语义感知的远程知识缓存

**论文定位。** Cortex 面向 Search-R1、coding agent 等需要频繁调用远程搜索/RAG/API 的 agent。它缓存的是“查询—工具交互—返回结果”语义单元，不是 Transformer 的 K/V 张量。

### 设计

- **Semantic Element（SE）。** 以 query/tool action 为 key、retrieved response 为 value，并保存 embedding、访问频率、远程 latency、调用 cost、staticity、TTL、大小等元数据。
- **Seri 两阶段检索。** 第一阶段用 ANN（实验采用 Faiss）召回高召回候选；第二阶段用约 1B 规模的 semantic judge 判定 cached response 是否真正回答当前 query。只有 judge 通过才算 cache hit。
- **LCFU eviction。** 综合频率、远程成本、延迟、staticity，并按大小归一化；TTL 到期强制淘汰，避免热门但过期的信息长期驻留。
- **预测预取。** 用一阶 Markov 模型学习 query→query 转移概率，异步预取可能的下一条查询；预取条目初始频率为 0，未命中时容易被淘汰。
- **GPU 共置。** 0.6B embedding/judge 模型与主 agent LLM 共置，静态约 80%/20% 的 MPS 资源划分，加上 agent 优先的 admission controller，保证 judge 不阻塞用户请求。
- **周期校准。** 通过重新请求一小部分近期 query 获取 ground truth，重新调整 judge threshold，以目标 precision（例如 0.99）为约束。

### 实验结果

- H100；搜索使用 Google Cloud Search API（约 300–500 ms）；coding 使用 300 ms 的 FAISS RAG；主模型 Search-R1-7B/Qwen-3-8B，embedding/judge 为 Qwen-3-0.6B。
- Zilliz-GPT、HotpotQA、Musique、2Wiki 的 Zipf/bursty workload 中，Cortex 命中率超过 **85%**，吞吐最高约 **3.6×**，端到端延迟最高降低约 4×。
- Google Trends 驱动的突发流量中命中率接近 **95%**，吞吐最高约 **3.8×**。
- SWE-Bench coding workload 命中率约 45%，吞吐约 **+20%**。
- Musique 并发扩展实验中，在 request rate=8 时吞吐 4.89 req/s，相对 exact cache 1.09 req/s、vanilla 0.86 req/s，分别约 **4.5×/5.7×**。
- 只用 ANN 的 naive semantic cache 会损失正确性；加入 semantic judge 后准确率接近 non-cached baseline。这说明 judge 是正确性机制，不是可有可无的优化。

### 局限

- 命中语义相似不等于结果在当前时间、权限和上下文下仍然有效；动态事实必须依赖 staticity/TTL 和周期校准。
- judge 的错误会造成 false hit；阈值越低命中率越高但错误风险越大。
- 每次 miss 仍需远程调用，且 ANN/judge 本身会占用 CPU/GPU；低延迟本地工具场景收益主要体现为成本节省。
- Cortex 不能直接替代 KV cache，也不能把其 semantic hit 当成 exact KV 可拼接证明。

### 对 vLLM/SGLang 的启示

可在 tool-call 层做 Cortex，在模型 prefill 层继续用 prefix/chunk KV cache：先语义命中远程知识，减少外部调用；随后对返回内容做普通 prompt/prefix 缓存。两级缓存的正确顺序是“知识结果语义验证 → token/KV exact reuse”，而不是直接用 embedding 相似度索引 KV block。

## 2.6 SYMPHONY：会话感知的 KV 迁移、预取和计算—内存协同

**论文定位。** SYMPHONY 解决多轮会话和 agent workflow 中的 session stickiness、GPU HBM 耗尽和集群负载不均衡。它基于 vLLM 集成，重点是控制面和层级内存管理。

### 关键机制

1. **advisory request。** 用户开始输入时、或上游 agent 已知下游调用即将发生时，提前发送 session/model/预计到达时间/优先级等信息。ShareGPT 中平均可提前 **11.3 s**，MetaGPT 中可提前 **5.8 s**。
2. **请求粒度调度。** 不要求整个 session 固定在拥有 KV 的节点；scheduler 可把新请求迁移到较空节点，同时 node manager 在后台拉取 KV。
3. **三级 KV 层级。** GPU HBM、host DRAM、SSD；支持 layerwise asynchronous read/write，使低层先到即可开始执行高层计算。
4. **priority-based KV management。** 低编号层更早被计算，优先放入 HBM；内存压力上升时优先清理后续层和小块。
5. **cooperative memory management。** node manager 可以贪心利用空闲 HBM，但 vLLM scheduler 需要空间时可直接覆盖低优先级 KV；因为 host 已有副本，不需要额外迁移。

### 实验结果

- 两节点、每节点 4×A100 80GB，256GB DRAM、4TB SSD、100Gbps Ethernet；Llama-3.1-8B（128K）与 Llama-2-13B（32K）；1000 条 ShareGPT 会话。
- 相对 vLLM，normalized latency 降低约 **1.4–1.9×**（Llama-3.1-8B），Llama-2-13B 约 **1.31–1.9×**；TTFT 最高约 **2.4×**。
- 在相近 TPOT 下可服务约 **4×** 用户：示例中 vLLM 64 用户约 18.5 ms/token，SYMPHONY 256 用户约 20.5 ms/token；论文总体声称最高可承载 **8×** 请求。
- 与 InferCept 比，吞吐最高约 **2.5×**；InferCept 的单机负载可能达到集群中位数的 **3.1×**。
- MetaGPT agent workflow 总时间降低约 **2.8×**。
- 10% advisory request 丢失时，token latency 从 21.3 ms 增至 24.4 ms，约 **6%**。

### 局限

- 依赖提前信号；没有 advisory 或提前时间不足时，预取无法隐藏迁移延迟。
- 需要修改客户端/UI 或 agent orchestrator 生成 advisory request，并维护 session metadata。
- KV 迁移仍可能消耗网络带宽；层级读写只能隐藏、不能消除传输成本。
- 论文主要处理同一模型多轮会话，不解决跨模型 KV 语义不一致。

### 对 vLLM/SGLang 的启示

适合实现为 serving control plane：将 vLLM 的 block allocator 与节点级 KV store 解耦，增加 session-level advisory API、跨节点预取和层优先级。若与 Strata 结合，SYMPHONY 决定“何时、迁到哪里”，Strata 决定“如何高效搬运”。

## 2.7 ZipLLM：模型仓库的张量去重与 XOR 增量压缩

**论文定位。** ZipLLM 处理的是模型权重存储，不是请求级 KV cache。它针对 Hugging Face 中大量同一基座的 fine-tuned 模型，通过结构感知去重和无损压缩降低仓库、分发和冷启动成本。

### 设计

- **bit distance。** 用位级 Hamming distance 衡量模型相似度，辅助模型家族聚类和 base/variant lineage 识别。
- **TensorDedup。** 利用 safetensors 的 tensor 边界逐张量哈希；比 CDC chunk 更少元数据、更容易并行。
- **BitX。** 对 base 与 fine-tuned variant 的对应 tensor 做 XOR delta，再进行无损压缩；解压后可精确恢复原始浮点权重。
- **dedup-then-compress。** 先利用模型结构去重，再对剩余差分压缩；论文证明 compress-then-dedup 会隐藏可去重冗余。
- **base 缺失回退。** 选择 bit distance 最近的模型作为 surrogate base，再保存额外 XOR mask，确保精确重建；并与 ZipNN 比较后选择更优方案。

### 实验结果

- 从 Hugging Face 采样 **3,048** 个完整 fine-tuned 模型、原始 **43.19 TB**；覆盖 Qwen、Llama、Mistral、Gemma 等系列，排除仅 LoRA 仓库。
- ZipLLM 总存储 reduction **54.1%**；ZipNN 约 33%，FastCDC 约 14.8%，FileDedup 约 3.2%，TensorDedup 约 8.3%。
- 192 线程下，ingestion **5,893 MB/s**，retrieval/decompression **7,872 MB/s**；ZipNN ingestion 约 1,424 MB/s。
- TensorDedup 产生约 923,384 个 unique hashes，估算全 Hugging Face 元数据约 22.1 GB；ChunkDedup 约 520,551,953 个 chunk，投射元数据约 **12.5 TB**。
- 相比 ChunkDedup，TensorDedup 吞吐约 **15×**；BitX 压缩吞吐约为 ZipNN 的 **4×**。
- 以 17 PB 模型仓库存储、50% reduction 粗估，可节省约 8.5 PB 和每年约 220 万美元 S3 存储费用（论文估算）。

### 局限

- 依赖 tensor 对齐、命名和模型家族识别；Qwen 等包含多个 base 变体或模型卡不完整时，压缩收益波动较大。
- 论文排除纯 LoRA 仓库；LoRA adapter 的结构异质性和小体积需要单独策略。
- 压缩无损但不等于推理时零开销；下载后仍需解压，且 base/variant 依赖关系需要可靠管理。

### 与 KV 系统的组合

ZipLLM 可降低多模型 serving 集群的模型驻留、镜像分发和冷启动成本；DroidSpeak 则降低这些模型在共享上下文上的 prefill 成本。二者分别作用于“权重存储”和“运行时中间状态”，组合后才覆盖跨模型服务的完整成本链路。

## 3. 横向比较：七篇论文解决了什么

| 论文 | 缓存对象 | 复用/管理粒度 | 主要瓶颈 | 关键技术 | 代表结果 | 是否是非前缀 KV 匹配 |
|---|---|---|---|---|---|---|
| Strata | 同模型 KV/context | page + memory tier + request | 小 I/O、加载 stall、delay hit | GPU-assisted I/O、布局解耦、cache-aware scheduler | 相对 vLLM-LMCache 最高 5× | 否，仍依赖已有命中 |
| ECHO | 稀疏注意力 KV | token recall + layer pipeline | HBM 容量、动态 recall | graph-friendly manager、无损预取、融合 kernel | generation throughput 最高 2.1×（摘要） | 否，优化 recall |
| DirectKV | CPU-resident KV | tile/kernel | staging buffer、CPU-GPU 带宽 | zero-copy、CPU-aware tiling、warp pipeline、fusion | GPU memory -43%，性能最高 1.2× | 否，执行后端 |
| SYMPHONY | 会话 KV | session/request/layer | stickiness、负载不均、迁移 | advisory request、分层存储、协同内存 | 相近 TPOT 下用户数最高 8× | 否，调度与迁移 |
| DroidSpeak | 跨模型 KV/E cache | contiguous layer group | 权重差异导致质量下降 | critical-layer profiling、选择性重算、流水传输 | prefill 1.7–3.1×，吞吐最高 4× | **是，跨模型** |
| Cortex | 远程知识结果 | semantic element/query | API 延迟、费用、语义重复 | ANN + semantic judge、LCFU、prefetch | 命中率 >85%，吞吐最高 3.6× | 语义缓存，但不是 KV |
| ZipLLM | 模型权重 | tensor/model family | 仓库存储与分发 | TensorDedup、XOR BitX | 存储 reduction 54.1% | 不适用 |

## 4. 对 vLLM、SGLang 和 CacheBlend 的结论

### 4.1 原生能力边界

- **vLLM prefix caching：** 以 token block hash/前缀链为核心；命中要求从序列开头连续匹配。它可以把 KV block 放到外部存储（例如 LMCache），但外部存储本身不自动提供任意非前缀拼接。
- **SGLang RadixAttention/HiCache：** radix tree 擅长共享连续前缀，并通过 HiCache 扩展 GPU/CPU/存储层级。Strata 是对这一条路径的 I/O 和调度增强。
- **CacheBlend：** 面向同一模型的非前缀检索 chunk/KV 组合，通过重算部分 token 缓解跨 chunk 依赖；部署时要关注 chunk 选择、重算比例、质量回归和调度开销。
- **DroidSpeak：** 不是 CacheBlend 的简单升级版，而是把复用维度从 token/chunk 改成 layer group，并从同模型扩展到同架构跨模型。

### 4.2 推荐的工程路线

如果目标是“在 vLLM/SGLang 中增加类似 CacheBlend 的能力”，建议按风险递增分三阶段：

1. **阶段 A：同模型非前缀 chunk。** 在 LMCache/HiCache 之上增加 chunk-level 内容寻址、位置 metadata 和重算比例；先做离线质量校准，再接 scheduler。
2. **阶段 B：把搬运成本降下来。** 在命中率稳定后引入 Strata 的 page-first host layout、GPU-assisted I/O；GH200/GB200 可评估 DirectKV，普通 PCIe 机器优先做批量 DMA 和 pinned-memory pipeline。
3. **阶段 C：跨 fine-tuned 模型。** 参考 DroidSpeak，为每个模型对维护 critical-layer profile 和 transition E cache；用质量 SLO 选择 Pareto 配置，并把模型版本纳入 cache key。

对于多轮会话/agent，额外引入 SYMPHONY 风格 advisory request；对于远程搜索/RAG，再在 tool 层叠加 Cortex。ZipLLM 作为模型仓库/镜像层优化，不应混入请求级 KV 命中率指标。

### 4.3 评测指标建议

不要只看 cache hit rate，应同时记录：

- **质量：** QA F1、Rouge-L、代码 pass@1/edit similarity，及 semantic cache 的 precision/false-hit rate。
- **服务：** TTFT、ITL/TPOT、端到端延迟、吞吐、SLO violation。
- **资源：** HBM/DRAM/SSD 占用、CPU-GPU/节点间字节数、有效带宽、I/O stall 比例。
- **成本：** 外部 API 调用数与费用、GPU-hours、模型下载/解压时间。
- **鲁棒性：** cache distance、请求突发、模型版本漂移、advisory 丢失、远程链路抖动。

## 5. 主要局限与研究空白

1. **非前缀复用的正确性仍缺少统一理论。** CacheBlend 用 token/chunk 重算，DroidSpeak 用 layer group 重算，二者的误差传播模型不同，尚无统一的可验证条件。
2. **语义命中与 KV 等价之间存在鸿沟。** Cortex 的 semantic judge 可以判断知识结果是否足够，但不能证明中间表示可直接复用；未来可能需要“知识级缓存 → 可验证重编码 → KV”的分层协议。
3. **带宽与容量优化强依赖硬件。** DirectKV 适合 NVLink-C2C，Strata 适合高并发 DMA，PCIe、CXL、NVLink 平台的最优策略不同。
4. **缓存索引、质量 profile 和模型版本管理会成为控制面瓶颈。** 跨模型场景需要保存 sender/receiver、层组、位置编码、量化精度和 profile 版本，不能只用一个 token hash。
5. **动态 agent 工作负载的可预测性有限。** SYMPHONY 的 advisory request 在聊天输入和固定 agent graph 中有效，但开放式 agent 可能出现误报、漏报和到达时间漂移。

## 6. 最终结论

如果问题是“vLLM/SGLang 有没有 CacheBlend 类非前缀匹配”，准确回答是：**原生 prefix cache 仍不是任意非前缀匹配；CacheBlend/DroidSpeak 代表需要额外算法和运行时支持的扩展路径。**

七篇论文可以组成一条清晰的技术谱系：

```text
同模型连续前缀（vLLM/SGLang）
        ↓ CacheBlend：同模型非前缀 token/chunk
        ↓ DroidSpeak：同架构跨 fine-tuned 模型 layer-group
        ↓ Cortex：远程知识结果的语义相似复用（非 KV）

容量与搬运横向支撑：Strata / ECHO / DirectKV / SYMPHONY
模型仓库存储支撑：ZipLLM
```

工程上最可行的组合是：**SGLang/vLLM prefix cache + CacheBlend 式 chunk 重算 + Strata/DirectKV 的分层 I/O + SYMPHONY 的会话调度**；当多模型协作成为主要负载时，再加入 DroidSpeak；当瓶颈来自远程搜索/RAG 时，在 tool 层加入 Cortex。

## 7. 原文链接

1. [Strata（OSDI 2026，USENIX）](https://www.usenix.org/conference/osdi26/presentation/xie-zhiqiang) · [PDF](https://www.usenix.org/system/files/osdi26-xie-zhiqiang.pdf)
2. [ECHO（OSDI 2026，USENIX）](https://www.usenix.org/conference/osdi26/presentation/liu-guangda) · [PDF](https://www.usenix.org/system/files/osdi26-liu-guangda.pdf)
3. [DirectKV / No Buffer, No Bottleneck（OSDI 2026，USENIX）](https://www.usenix.org/conference/osdi26/presentation/luo) · [PDF](https://www.usenix.org/system/files/osdi26-luo.pdf)
4. [DroidSpeak（arXiv:2411.02820）](https://arxiv.org/abs/2411.02820) · [PDF](https://arxiv.org/pdf/2411.02820)
5. [Cortex（arXiv:2509.17360）](https://arxiv.org/abs/2509.17360) · [PDF](https://arxiv.org/pdf/2509.17360)
6. [SYMPHONY（arXiv:2412.16434）](https://arxiv.org/abs/2412.16434) · [PDF](https://arxiv.org/pdf/2412.16434)
7. [ZipLLM（arXiv:2505.06252）](https://arxiv.org/abs/2505.06252) · [PDF](https://arxiv.org/pdf/2505.06252)

> 注：OSDI 2026 论文按 PDF 标注的会议年份列出；vLLM、SGLang、CacheBlend 等开源项目的具体接口和默认行为会随版本变化，实际落地前应针对目标 commit 做兼容性验证。
