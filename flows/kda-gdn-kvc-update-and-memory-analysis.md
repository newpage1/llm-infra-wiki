---
section: 新模型
summary: 区分「计算状态更新」「设备内存写回」「外部持久化」三件事：KDA/GDN 的 recurrent state 必须逐 token 更新，但不需要逐 token 保存——可按 checkpoint 边界、固定间隔或请求迁移时机批量落盘，这里就是内存访问与调度的机会。
---

# KDA/GDN State 是否需要逐 token 保存：论证与内存访问机会

> 调研日期：2026-09-07

## 1. 先给结论

需要严格区分三个动作：

1. **计算状态更新**：KDA/GDN 的 recurrent state 必须随着每个已接受 token 更新，才能生成下一个 token。
2. **本地 HBM/设备内存写回**：这个更新通常在设备内存中的 state cache 原地完成，属于推理计算路径的一部分。
3. **外部 KVC 持久化或跨节点传输**：不需要每个 token 都保存；可以按 checkpoint boundary、固定 token 间隔、请求迁移时机或请求结束批量保存。

因此：

> **KDA/GDN state 要逐 token 更新，但不需要逐 token 写入 Mooncake、AscendStore、DRAM 或远端 SSD。**

普通 attention 的 token KV 也要区分本地 cache 和外部 KVC：

- 本地 HBM 中，当前生成 token 的 K/V 必须及时写入，后续 token 才能读取它们。
- 外部 KVC 中，可以等 block 填满、请求迁移、达到快照间隔或请求结束后再异步保存。
- 如果等整个请求结束才保存，当前请求本身没有问题，但运行中的 prefix 复用、请求迁移和中途抢占无法受益。

## 2. 为什么 KDA/GDN 必须逐 token 更新

以 KDA/GDN 的状态递推为例：

\[
\widetilde{S}_t = D_tS_{t-1}
\]

\[
S_t=\widetilde{S}_t+\beta_t k_t(v_t-k_t^\top\widetilde{S}_t)^\top
\]

\[
o_t=q_t^\top S_t
\]

下一个 token 的计算依赖上一个 token 更新后的 \(S_t\)。如果 token \(t\) 已经吐出，却不把它对 state 的影响写回，那么 token \(t+1\) 仍使用 \(S_{t-1}\)，模型实际计算的序列就缺少 token \(t\) 的记忆更新。

因此在 decode 中，以下数据必须在设备侧保持最新：

- KDA/GDN recurrent state。
- 因果卷积的 `conv_state`（如果模型有 causal convolution）。
- speculative decoding 场景下用于候选 token 的临时 state，以及接受 token 后的提交状态。

当前 vLLM-Ascend 的 KDA 路径正是这种语义：recurrent kernel 接收 `recurrent_state`，执行状态更新；prefill 的 chunk kernel 返回 `output_final_state=True`，然后把最终状态写回 state cache。它不是每个 token 生成一个远端对象，而是更新设备侧 cache 中对应 request/state slot。

## 3. 为什么不需要每 token 外部保存

设备侧 state 与外部持久化对象的用途不同。

### 3.1 正常连续 decode

正常 decode 的下一步仍在同一个 worker 上执行。只要设备侧 state 已更新，下一步即可直接使用。此时每 token 做一次远端写入只会增加：

- 网络/PCIe/RDMA 往返。
- 小 I/O 数量和 doorbell 开销。
- snapshot 一致性处理。
- 远端存储写放大。
- state 写入与 recurrent kernel 的同步依赖。

对正常 decode，外部保存不是正确性要求，而是容灾、迁移、复用或内存回收要求。

### 3.2 逐 token 外存的恢复价值很低

逐 token snapshot 的确能提供最细恢复点，但通常不划算：

- 相邻两个 token 的 state 差异很小，但完整 state 可能很大。
- 恢复时通常只需要最近一个可用边界，而不是每个 token 的历史版本。
- 如果每次更新都覆盖远端对象，会遇到读写并发、半更新和 generation 冲突。
- 对 prefix cache 来说，任意 token 都不是同样有价值；固定 block boundary 更容易被其他请求复用。

因此合理做法是本地连续更新、外部稀疏 checkpoint。

## 4. 普通 token KV 是否可以“所有 token 搞完再 save”

答案要分为本地和外部两种情况。

### 4.1 本地 HBM KV：不可以推迟到请求结束

标准 attention/MLA 的后续 token 需要访问之前 token 的 K/V。生成 token \(t\) 后，其 K/V 通常需要写入本地 cache，后续 token 才能参与 attention：

```text
token t 生成
   │
   ├─ K/V 写入本地 cache
   │
   ▼
token t+1 读取历史 K/V
```

如果直到请求完成才写入本地 cache，后续 decode 就无法使用这些历史 K/V，除非每一步都重新计算整个历史前缀，这会失去 KV cache 的意义。

### 4.2 外部 KVC：可以延迟，但不能无限延迟

写入 Mooncake、AscendStore、DRAM 或远端 SSD 的副本可以延迟到：

- 一个 token block 填满时。
- 一个 prefill chunk 完成时。
- 固定 checkpoint interval 到达时。
- 请求即将迁移、抢占或进入低活跃状态时。
- 请求结束时。

如果只关心“请求结束后供未来请求复用”，请求结束再保存是可行的；但会失去：

- 长请求运行期间的中途迁移。
- 生成过程中的跨请求 prefix 复用。
- 设备内存压力下的提前下沉。
- 失败恢复和增量容灾。

所以更准确的策略是：**本地即时写，远端按 block/boundary 异步写。**

## 5. 推荐的保存粒度

### 5.1 KDA/GDN state

推荐优先考虑以下粒度：

| 场景 | 推荐保存粒度 |
| --- | --- |
| 正常 decode | 只更新本地当前 state，不做每 token 外存 |
| 长请求运行 | 每 32/64/128 token 或固定 block boundary 做 checkpoint，需压测选择 |
| Prefix Cache | 保存可复用的精确 boundary snapshot |
| 请求迁移 | 迁移前保存完整、可验证的最新 state snapshot |
| 抢占/换入换出 | 保存最近稳定 boundary；必要时重放少量 token |
| 请求结束 | 按复用概率决定保存最终 state 或最后一个可复用 boundary |
| Speculative Decoding | 只提交已接受 token 对应的 state；拒绝 token 的临时 state 不外存 |

### 5.2 普通 token KV

推荐采用：

- 本地按 page/block 即时写入。
- 外部按完整 block 或 layer bundle 异步写入。
- block 未填满时保留在本地，避免大量小对象。
- 对已封闭 block 做 immutable publish，避免远端读到半写对象。

### 5.3 KDA state 与 token KV 不建议强行共用保存周期

两者访问模式不同：

- token KV：生成时 append，后续被历史 attention 读取。
- KDA state：每 token read-modify-write，当前 state 是热数据。

如果把两者绑定为“每次 token KV flush 都同步保存 state”，会让 state 的外部写频率被普通 KV 的 append 节奏拖高，增加写放大。更好的方式是：

```text
token KV:       block close -> async flush
KDA state:      checkpoint boundary / migration -> async snapshot
```

## 6. 当前 vLLM 状态缓存语义给出的证据

当前 vLLM 的 `MambaSpec` 已经体现出 state 与普通 token KV 不同的生命周期：

- `mamba_cache_mode="none"`：主要保留当前运行所需 state。
- `mamba_cache_mode="all"`：按 block/boundary 保留多个 state snapshot，支持更细粒度复用。
- `mamba_cache_mode="align"`：在与 token block 对齐的边界上保留有限 checkpoint，避免保存完整序列的所有 state。

这说明框架层面已经采用“按模式选择 snapshot 数量”的思路，而不是默认每个 token 永久保存 state。

当前 KDA Ascend 实现也体现出相同原则：

- recurrent decode 直接传入并更新 `recurrent_state`。
- chunk prefill 设置 `output_final_state=True`。
- chunk prefill 设置 `return_intermediate_states=False`，默认不返回每个 token 的中间 state。
- prefill 完成后只把最终 state 写回对应 cache slot。

这可以直接证明：**计算过程中逐 token 递推，缓存层面默认只保留当前/最终状态，而不是所有中间状态。**

## 7. 内存访问瓶颈在哪里

### 7.1 KDA recurrent state 是 read-modify-write 热点

每个 token 大致需要：

1. 读取当前 state。
2. 按 gate 对 state 做衰减。
3. 读取当前 \(k,v,q,\beta\)。
4. 计算预测误差。
5. 更新 state。
6. 计算输出。
7. 写回新 state。

因此 decode 的主要压力不一定是算力，而可能是 state 的 HBM 带宽和反复读写。

### 7.2 一个数量级示例

假设某一层：

- value heads = 32。
- key/value head dimension = 128。
- BF16，每元素 2 bytes。

仅 recurrent state 的大小约为：

\[
32\times128\times128\times2\approx1\text{ MiB}
\]

而一个 token 的普通 K/V（32 个 head、每个 128 维、K 和 V 各一份）约为：

\[
2\times32\times128\times2\approx16\text{ KiB}
\]

这个例子中，一次完整 state snapshot 的字节量约相当于 64 个普通 token 的 K/V。实际模型维度、head 数、量化和 TP 分片会改变比例，但结论不变：**state 不是一个很小的 token cache entry，逐 token 外存可能造成明显写放大。**

## 8. 内存访问优化机会

### 8.1 第一优先级：不要逐 token 远端保存

这是收益最大、风险最低的优化：

- state 只在设备侧原地更新。
- 远端按 boundary 批量 snapshot。
- 通过异步 DMA/RDMA 在计算和传输之间重叠。
- 远端对象使用 immutable generation，完成后一次 publish。

这通常比优化远端存储协议本身更有效。

### 8.2 融合 state 更新，减少中间读写

将以下操作尽可能放在同一 kernel 或同一 fused pipeline 中：

```text
gate decay
prediction error
beta scaling
outer-product update
q-state projection
```

目标是避免：

- state 在多个 kernel 之间重复落回 HBM。
- 中间 tensor（例如完整 prediction error）单独分配和读写。
- q/k/v/gate 多次从全局内存加载。

KDA 使用逐维 gate 后，门控张量本身也变大，融合和 tile 复用的收益会高于简单增加 FLOPS。

### 8.3 按 active request 做 state slot 紧凑化

当前 batch 中的 request 可能对应离散的 `state_indices`。如果 state page 在物理内存中分散，recurrent kernel 会出现：

- 非连续 global memory 访问。
- cache line 利用率低。
- gather/scatter 地址计算开销。
- 不同 request 的 state 访问互相干扰。

可考虑：

- 将活跃 request 的 state slot 临时重排到连续区域。
- 按 state shape、TP rank、sequence length 对 batch 分组。
- 使用稳定的 slot allocator，减少频繁迁移。
- 对同一 batch 的 state index 做 locality-aware 排序。

需要注意，重排不能破坏 scheduler、speculative decode 和 request-to-state 的索引关系。

### 8.4 checkpoint snapshot 使用双缓冲或 COW

不能一边 recurrent kernel 原地更新 state，一边让远端 DMA 无保护地读取同一 buffer。否则可能读到半更新矩阵。

可选方案：

```text
active state A  ── recurrent update ──► active state A'
snapshot buffer B ── async copy ───────► remote
```

或使用：

- double buffering。
- device-side event + generation fence。
- checkpoint 时对 state 做 COW。
- 按 layer group 分段冻结后复制。

在不希望复制完整 state 的情况下，可以让 snapshot copy 与下一次计算按 layer/group 流水，但必须保证每个对象有明确的 ready event 和 generation。

### 8.5 只保存可复用边界，避免中间 state 泛滥

不是所有 token 位置都值得做 checkpoint。可优先选择：

- hash block boundary。
- prefill chunk boundary。
- 迁移安全点。
- sequence segment boundary。
- 预计会被重复访问的公共 prefix 位置。

例如 chunk size 为 64 时，可以优先保存每 64 token 的 state，而不是 64 个单 token snapshot。若 miss，最多从最近 checkpoint 重放一小段 token。

### 8.6 state 压缩或低精度 snapshot

设备侧计算 state 和远端 snapshot 不一定要使用同一精度。可以研究：

- BF16/FP16 state snapshot。
- 分块 FP8/INT8 snapshot，并在恢复时转回计算格式。
- 仅对远端冷副本做压缩。
- 对 state delta 或低秩增量做编码。

但必须做精度回归。KDA state 是递归量，恢复误差会在后续 token 中累积，不能只看一次输出误差。

### 8.7 token KV 采用 page-close 异步 flush

普通 KV 的优化重点不同：

- 让 token K/V 按物理 page 连续写入。
- page 未关闭时只保留本地副本。
- page close 后批量提交远端对象。
- 将多个 layer 的小写入合并成 layer bundle，降低对象和 DMA 数量。
- 避免为了写远端副本阻塞 decode 主流。

这类优化不会改变 token KV 的本地可见性，只改变外部副本的可见时间。

### 8.8 用“重放还是加载”决定 checkpoint 间隔

对一个 state snapshot，远端加载成本可以粗略写成：

\[
T_{load}=L_{remote}+\frac{S_{state}}{B_{remote}}
\]

从上一个 checkpoint 重放 \(R\) 个 token 的成本可以写成：

\[
T_{replay}=R\cdot C_{token}
\]

当 \(T_{replay}<T_{load}\) 时，直接重放可能更快；当请求迁移、state 很大或重放 token 很多时，加载 snapshot 更划算。

因此 checkpoint 间隔不应固定写死，而应结合：

- state 字节数。
- 远端带宽和尾延迟。
- recurrent kernel 的每 token 成本。
- 请求迁移概率。
- prefix 复用概率。
- HBM 压力。

## 9. Speculative Decoding 的特殊情况

推测解码一次可能计算多个候选 token，但最终只接受其中一部分。此时不能把所有候选 token 的 state 都当作最终状态保存。

正确语义是：

```text
base state
   │
   ├─ 计算 draft tokens，得到临时 state
   │
   ├─ 接受 N 个 token
   │
   └─ 丢弃未接受 token 的 state 更新
          │
          ▼
      提交 accepted-state
```

因此：

- 临时 state 可以在本地工作区中存在。
- 远端 KVC 只发布已接受 token 对应的 state boundary。
- state snapshot 的 generation 必须与 accepted length 一致。
- 请求回滚时不能让旧的 speculative state 覆盖已提交 state。

这也是为什么 KDA/GDN 的 state 管理不能简单复用 append-only token KV 的写入协议。

## 10. 建议的分层数据路径

```text
                 ┌────────────────────────┐
                 │ KDA/GDN recurrent path │
                 └───────────┬────────────┘
                             │
          每 token 原地更新 │ 低频 checkpoint
                             ▼
HBM active state ───────► immutable state snapshot
       │                         │
       │                         └──► DRAM / remote memory / SSD
       │
       └── recurrent kernel 直接消费

                 ┌────────────────────────┐
                 │ ordinary token-KV path │
                 └───────────┬────────────┘
                             │
             每 token 本地写 │ page close 后异步 flush
                             ▼
HBM KV pages ───────────► remote KV blocks
       │                         │
       └── attention 直接读取     └── prefix reuse / migration
```

## 11. 可验证的实验设计

建议先做四组实验，而不是直接改协议：

### 实验 A：state 外存频率

- 每 token snapshot。
- 每 16 token snapshot。
- 每 64 token snapshot。
- 请求结束 snapshot。

测量：端到端 TPOT、HBM 带宽、远端写带宽、恢复延迟和输出一致性。

### 实验 B：state miss 时 replay/load

对不同缺口长度比较：

- 直接远端加载 state。
- 从更早 state replay。
- 两者混合。

测量交叉点，得到实际 checkpoint 间隔。

### 实验 C：state 与 token KV 分离 flush

比较：

- KV 和 state 同步 flush。
- KV page-close flush、state boundary flush。
- 两者完全独立的异步队列。

重点观察 decode 主流是否被远端写入反压。

### 实验 D：snapshot 一致性与 speculative decode

验证：

- snapshot copy 与 recurrent update 并发。
- request migration 发生在 speculative accept/reject 前后。
- generation fence 能否阻止旧 state 覆盖新 state。
- 恢复后的输出是否与无迁移基线一致。

## 12. KDA/GDN state 的匹配原则

这里的“匹配”不是判断一个 state 数值上“看起来像不像”，而是判断：

> 这个远端 snapshot 是否可以作为当前请求、当前 layer/group、当前 token 边界的合法 `initial_state`。

KDA 和 GDN 的匹配可以分成两层。

### 12.1 先匹配 cache family 和 state spec

第一步必须确认对象类型相同：

```text
KDA state  ↔ KDA state
GDN state  ↔ GDN state
Mamba state ↔ Mamba state
```

不能因为 KDA 和 GDN 都使用 gated delta rule，就直接互相复用 state。至少以下字段需要一致或存在明确转换：

| 字段 | 说明 |
| --- | --- |
| `semantic_role` | 必须是 `RECURRENT_STATE`，不能把普通 `TOKEN_KV` 当 state |
| `cache_family` | `KDA`、`GDN`、`MAMBA` 等；不同 family 默认不匹配 |
| `model_revision` | 模型权重、配置和算子语义版本 |
| `adapter_identity` | LoRA/adapter 不同，状态通常不能互用 |
| `layer_id/group_id` | 必须对应同一层或同一 hybrid group |
| `state_shapes` | conv state、recurrent state 等 tensor shape |
| `dtype/quantization` | BF16、FP16、FP8/INT8 等 |
| `layout_version` | `[H,V,K]`、`[H,K,V]`、stride 和 TP 排布 |
| `tp/dcp/pcp layout` | 源状态是否能直接被目标 rank 消费，或需要 reshard |
| `gate semantics` | KDA 逐 key 维 gate 与 GDN head-wise gate 不能混用 |

### 12.2 再匹配序列边界和版本

cache family 匹配后，还要确认它描述的是同一段历史：

```text
prefix_token_hash
accepted_token_count / state_position
parent_sequence_id（生成分支场景）
generation / ownership_epoch
```

这里的 `generation` 需要特别说明：它是 **state 对象的版本号/所有权代际**，不是 token 序号，也不是 state 所在的模型层数。前文示例中的 `generation=38`、`generation=41` 是为了表示不同次提交的版本，数值本身没有固定含义。

建议把几个容易混淆的字段分开：

| 字段 | 含义 | 示例 |
| --- | --- | --- |
| `token_position` / `state_position` | state 已经吸收到哪个 token 边界 | `4032`、`4096` |
| `request_id` / `sequence_id` | 属于哪个请求或序列 | `req-A` |
| `parent_sequence_id` | speculative 或 beam 分支的父序列 | `req-A` |
| `generation` | 该逻辑 state 的第几个已提交版本 | `38`、`41` |
| `owner_epoch` | 当前 worker/lease 的所有权代际 | `worker-B:7` |

例如：

```text
snapshot B:
  request_id    = req-A
  state_position= 4032
  generation    = 38
  owner_epoch   = worker-A:12

snapshot C:
  request_id    = req-A
  state_position= 4096
  generation    = 41
  owner_epoch   = worker-B:13
```

`generation=41` 并不意味着 state 一定处理了 41 个 token；它只表示这个请求的逻辑 state 在提交协议中已经产生了第 41 个版本（具体是每次 checkpoint、迁移提交，还是 accepted-state 提交递增，由实现定义）。

生产实现通常有两种版本策略：

1. **请求内单调版本**：每次发布一个新的 committed snapshot 就递增，例如 38、39、40、41。适合检查同一请求的旧写入是否迟到。
2. **存储层全局版本/时间戳**：由远端对象服务分配单调序列或使用带条件写的版本。适合多个 producer 竞争同一对象，但不能替代请求内的状态位置校验。

无论采用哪一种，`generation` 都必须与 `state_position`、`prefix_token_hash` 和 `model/layout` 一起校验，不能单独使用。真正的可用条件类似：

```text
same request/prefix
same model + adapter + cache family + layout
state_position <= requested_position
status == COMPLETE
generation is not stale
all state entries are present and checksums pass
```

如果 B 的 `state_position=4032` 而请求需要 4096，它不是“错误版本”，而是一个较早的合法恢复点：加载 B 后重放 token 4032 到 4095。若 C 已经是同一请求、同一布局下 `position=4096` 的最新完整快照，则应优先选 C。

`owner_epoch` 与 `generation` 也不相同：

- `generation` 回答“这是该 state 的第几个提交版本”。
- `owner_epoch` 回答“哪个 worker/租约有权提交新版本”。

请求从 Worker A 迁移到 Worker B 后，即使 A 手上仍有 `generation=42` 的延迟写任务，只要它的 `owner_epoch` 已失效，远端也应拒绝该写入。这就是 generation fencing 通常还需要结合 ownership/lease fencing 的原因。

普通 token KV 可以用连续 block hash 找到最长前缀。KDA/GDN state 则必须找到一个精确 boundary：

```text
state_position = 4096
```

它表示这个 state 已经吸收了 token `[0, 4095]`，下一次计算必须从 token `4096` 开始，而不是从任意相邻 block 拼接出来。

### 12.3 Token hash 与 state hash 的关系

实际可以用同一段 token prefix 生成两种不同用途的标识：

```text
token_prefix_hash = H(model-independent token IDs + parent hash)
state_object_key  = H(model revision, adapter, cache family, layer/group,
                       token_prefix_hash, state_position, layout version)
```

`token_prefix_hash` 用于判断“历史 token 是否相同”；`state_object_key` 用于判断“这个特定执行状态是否可直接恢复”。

不能只拿 token hash 命中就直接加载 state，因为同一 token 前缀在以下情况下可能有不同状态布局或不可直接消费：

- 模型权重或 KDA/GDN 配置不同。
- adapter/LoRA 不同。
- TP 分片或 dtype 不同。
- KDA state layout 版本不同。
- speculative 分支的 accepted length 不同。

候选 snapshot 也不需要遍历所有副本。实际采用两级索引：

```text
LogicalStateKey -> ReplicaSet
```

先根据当前请求的 token IDs 和最近几个 checkpoint boundary，批量查询少量精确 key；命中某个逻辑对象后，目录服务直接返回它的副本集合，选择器只在这些副本中比较本地/远端位置、队列延迟、layout 转换和 replay 成本。

例如目标位置为 4096、checkpoint 间隔为 64、最多允许回放 256 token，则只查询：

```text
KDA/group2/position4096/H4096
KDA/group2/position4032/H4032
KDA/group2/position3968/H3968
KDA/group2/position3904/H3904
KDA/group2/position3840/H3840
```

若查询得到 `position=4032` 的逻辑对象 `O4032`，其副本列表为“本机 DRAM、远端 HBM、SSD”，系统只比较这几个副本，再与 `position=3968` 等其他命中的 boundary 比较。不会扫描整个远端对象库，也不会向所有节点广播查询。

“相似前缀”只能用于预取、热点判断或缩小索引范围，不能作为 state 正确性命中条件。真正恢复仍必须满足精确 token prefix hash、state position、model/adapter、cache family、layout、generation 和完整性校验。

## 13. 一个具体匹配例子

假设 Kimi-K3 是一个混合模型：

- 部分层是 KDA。
- 另一部分层是全局 MLA。
- 每个 KDA layer 都维护 `conv_state` 和 `recurrent_state`。

### 13.1 请求 A 先完成共享前缀

请求 A 的 token 序列为：

```text
[system, developer, user_prefix ...] + "请分析 KDA 和 GDN 的区别"
```

当它处理完前 4096 个 token 后，设备侧有：

```text
TOKEN_KV group 0: blocks 0..63
TOKEN_KV group 1: blocks 0..63
RECURRENT_STATE KDA group 2:
  state_position = 4096
  conv_state[layer 12]
  recurrent_state[layer 12]
  ...
  conv_state[layer 69]
  recurrent_state[layer 69]
```

将其保存到外部 KVC 时，不能只保存一个普通 prefix key。可以生成如下 manifest：

```json
{
  "model_revision": "kimi-k3-2026-08-31",
  "adapter_identity": "base",
  "semantic_role": "RECURRENT_STATE",
  "cache_family": "KDA",
  "group_id": "kda_group_2",
  "state_position": 4096,
  "accepted_token_count": 4096,
  "layout_version": "kda-v1-HVK-tp16",
  "dtype": "bfloat16",
  "generation": 41,
  "status": "COMPLETE",
  "entries": [
    "conv_state.layer12",
    "recurrent_state.layer12",
    "...",
    "conv_state.layer69",
    "recurrent_state.layer69"
  ]
}
```

同时，普通 MLA token KV 可能有独立 manifest：

```text
TOKEN_KV / mla_group_0 / prefix_hash=P / blocks=0..63
```

### 13.2 请求 B 共享同一个 4096-token 前缀

请求 B 的输入为：

```text
[system, developer, user_prefix ...] + "请重点说明 KVC 传输影响"
```

它的前 4096 个 token 与请求 A 完全一致，之后的 token 不同。KVC 检索流程如下：

```text
1. tokenizer 得到 B 的 token IDs
2. 计算 prefix hash P
3. 查询 TOKEN_KV group
4. 查询 RECURRENT_STATE(KDA, position=4096)
5. 校验 model/adapter/layout/generation/status
6. 加载 MLA token KV blocks
7. 加载完整 KDA state snapshot
8. 从 token 4096 开始处理 B 的后续 token
```

命中结果可能是：

```text
TOKEN_KV MLA group:       hit through block 63
KDA state group:          hit at position 4096
KDA auxiliary metadata:   hit
```

此时 B 不需要重新处理前 4096 个 token 的 KDA 层。它直接把恢复出的 state 作为 `initial_state`，从自己的第 4097 个 token 继续递归更新。

### 13.3 只有普通 KV 命中时会怎样

如果查询结果是：

```text
TOKEN_KV MLA group:       hit through block 63
KDA state group:          miss
```

不能直接认为整个 prefix cache 命中。系统有三种选择：

1. 从更早的 KDA state boundary 恢复，例如 position 3968，然后重放 128 token。
2. 在 KDA 层重新 prefill 前 4096 个 token，但 MLA 层继续使用命中的 token KV。
3. 如果远端加载成本明显高于重放成本，直接放弃 state load，选择 replay。

这就是 hybrid 模型中的 **partial hit**：不同 cache group 可以有不同命中结果。

### 13.4 KDA 与 GDN 为什么不能互相命中

假设请求 B 使用的是某个 GDN 模型，而远端对象来自 Kimi-K3 KDA：

```text
远端对象：cache_family=KDA
当前请求：cache_family=GDN
```

即使两者的 token prefix hash 完全相同，也必须拒绝：

- KDA 的 gate 是逐 key 维度。
- GDN 的 gate 通常是 head-wise 标量。
- 两者 recurrent state 的 shape、转移函数和 kernel 解释不同。
- 用 KDA state 作为 GDN initial state，数值上可能能读出来，但语义完全错误。

因此 `cache_family` 不是一个用于统计的标签，而是 state 恢复安全性的硬约束。

### 13.5 Generation fencing 的具体时序

继续使用请求 A。A 在 position 4096 发布 generation 41 后，又继续生成：

```text
generation 41: state_position=4096
generation 42: state_position=4160
```

如果 generation 41 的远端写入比 generation 42 晚完成，没有 fencing 就可能发生：

```text
远端先看到 generation 42
旧的 generation 41 迟到并覆盖它
```

正确做法是：

```text
publish generation=42 only if owner_epoch is current
reject generation=41 if latest_generation >= 42
```

这样旧 worker、超时重试或 speculative rejected branch 都不能覆盖已提交的新状态。

### 13.6 COW 的具体时序

当 position 4096 的 state 正在准备上传：

```text
active buffer A = S4096
snapshot buffer  = A（冻结为 generation 41）
```

后续 decode 不能继续修改 A，因此需要：

```text
1. A 标记为 immutable snapshot
2. A clone 到 buffer B，或切换到预分配的 B
3. decode 在 B 上生成 S4097、S4098...
4. A 异步上传远端
5. A 上传完成后发布 generation 41
```

如果没有第二个 buffer，系统只能暂时暂停 decode，等 A 复制完成后再继续。这就是 COW/双缓冲与冻结复制之间的取舍。

### 13.7 Speculative decoding 的匹配

假设请求 A 当前已经提交到 position 4096，generation 41。一次 speculative decode 产生 4 个候选 token：

```text
S4096 -> S4097? -> S4098? -> S4099? -> S4100?
```

验证后只接受前两个 token，那么合法状态是：

```text
state_position = 4098
generation = 42
```

position 4099 和 4100 的临时状态必须丢弃，不能发布到 KVC。否则后续请求可能从一个模型实际上没有接受过的 token 序列继续生成。

## 14. 最终判断

### 关于 KDA/GDN state

- **每个已接受 token 都必须更新本地 state。**
- **不需要把每个 token 的 state 都保存到外部 KVC。**
- 只有在 prefix 复用、请求迁移、抢占、容灾或 HBM 回收需要时，才做 boundary snapshot。

### 关于普通 token KV

- **本地 HBM KV 不能等请求结束才写**，否则后续 token 无法读取历史 K/V。
- **外部 KVC 可以延迟保存**，推荐按完整 block/page 异步 flush。
- 请求结束再保存适合低复用、无迁移需求的简单场景，但不是通用最优策略。

### 关于内存访问机会

最值得优先投入的方向依次是：

1. 禁止逐 token 远端 state 写入。
2. 融合 gate、Delta update 和 output projection，减少 state 往返 HBM。
3. 让 active state slot 连续化，降低 gather/scatter 成本。
4. 用双缓冲/COW + event 做一致的异步 snapshot。
5. token KV 按 page-close 批量 flush，state 按 boundary 独立 checkpoint。
6. 用 replay/load 成本模型自适应选择 checkpoint 间隔。

一句话总结：

> **KDA/GDN 是“每 token 更新、低频快照”；普通 KV 是“每 token 本地可见、按 block 外部落盘”。**
