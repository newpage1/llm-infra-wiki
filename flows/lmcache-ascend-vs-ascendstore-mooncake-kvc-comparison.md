---
section: lmcache
summary: 比较两套完整方案而不是两个同层组件：LMCache-Ascend + LMCache（KV 管理、分层缓存与控制器 + NPU 搬运/P2P/PD backend）对比 vLLM-Ascend AscendStoreConnector + Mooncake（block 语义与调度 + key/layout 适配 + 分布式对象与传输）。
---

# LMCache-Ascend 与 AscendStoreConnector + Mooncake 的 KV Cache 特性对比

> 分析日期：2026-09-06；A5/UB 代码补充于 2026-09-08。本文比较的是两套完整方案，而不是两个同层组件：
>
> - **方案 A：LMCache-Ascend + LMCache**：LMCache 提供 KV 管理、分层缓存和控制器，LMCache-Ascend 提供 NPU 搬运、P2P 与 PD backend。
> - **方案 B：vLLM-Ascend AscendStoreConnector + Mooncake**：vLLM/vLLM-Ascend 管 KV block 语义与调度，AscendStoreConnector 做 key/layout 适配，Mooncake 管分布式对象、segment、replica 和数据传输。
>
> 本文只做**特性对比**，不再按 Save/Load 调用链展开。结论基于当前本地 checkout 的静态代码分析，未在昇腾集群上做性能和故障注入验证。未合入 PR 单列，不能算作当前能力。

> **关于文中的引用。** 文中 `路径:行号` 指向工作区里对应仓库的本地检出，`xxx.md:行号` 指向工作区的本地报告；站上没有这些文件、点不开，已按纯文本保留，已上线的姊妹报告则保留为可点击链接。

## 1. 一张总表

符号：✅ 完整或相对成熟；◐ 有实现但有边界；⚠️ 当前存在明显正确性/接线问题；❌ 当前未见实现。

表格已收窄到昇腾部署直接相关的能力：保留 vLLM KV 语义、HCCL/HIXL、A5 UBOE/UB、A3 Fabric、Mooncake transport/replica 等项目；删除与昇腾方案无直接决策关系的通用网络或 GPU 专属项目。标为 ❌ 的项目仍保留，是为了明确当前方案的能力边界，不代表其他硬件结论。

| 类别 | 能力项（昇腾关注） | LMCache-Ascend + LMCache | AscendStoreConnector + Mooncake | 当前判断 | 需要补强 |
| --- | --- | --- | --- | --- | --- |
| KV 管理 | KVC 调度集成 | ✅ 自己提供 async lookup、跨 tier prefetch、pin/touch、回填和 eviction | ✅ 复用 vLLM 原生 KV manager、block hash、hybrid group 和 reachable 语义 | **各有优势**：LMCache 的外部缓存编排更强；AscendStore 与 vLLM 新 KV 类型更一致 | LMCache 要减少自建状态机；AscendStore 要补独立 QoS、准入和可观测性 |
| KV 管理 | 前缀匹配 | ✅ 链式 chunk prefix hash，可跨 CPU/Disk/Remote/P2P tier 接续查找 | ✅ 直接复用 vLLM block hash，并要求 PP/TP/group 所需 key 一致命中 | **LMCache 略强于跨 tier；AscendStore 略强于模型语义一致性** | 两边都主要服务连续前缀；中间洞、非前缀复用仍弱 |
| KV 管理 | Hybrid / Sliding Window / Mamba | ◐ 有 MP/hybrid 支持，但内容感知压缩、layerwise、P2P/PD 组合存在限制 | ✅ Coordinator 复用不同 `KVCacheSpec` manager，原生维护 group mask、SWA clip、Mamba state | **AscendStore 更好** | AscendStore 的若干 layerwise correctness PR 尚未合入 |
| KV 管理 | DSV4 / 结构化稀疏 KV | ◐ 能搬运不同 KV tensor/layout；Ascend P2P/PD 以 `MemoryObj`、shape、dtype 和 chunk key 为边界，不直接消费 vLLM `reachable_block_mask` | ◐ 已有 compress family、group granularity、reachable mask；当前 layerwise 仍可能保存大量不可达 block | **AscendStore 设计更贴近昇腾 vLLM 语义，但当前有冗余缺陷** | LMCache 需由上层先过滤 reachable block；AscendStore 合入并验证 `#15854`，`#15883` 仍只是资源层 |
| KV 管理 | MLA / DSA TP 冗余消除 | ✅ `save_only_first_rank` 默认对 MLA 生效，key 的逻辑 world size 折叠为 1，被动 rank 不保存 | ✅ `num_kv_head=1` 后用 `put_step/head_or_tp_rank` 合并共享 rank；不同路径选择首 rank 写或按 block 预分片 | **LMCache 语义更直接、跨部署 key 更清晰；两边都能去掉同组重复写** | AscendStore 仍需统一不同 layerwise/非 layerwise 路径的写入分工 |
| KV 管理 | Layerwise KV | ⚠️ 不支持 async store；与 Ascend P2P/PD 不兼容；MLA 也有限制 | ◐ 支持 key-layer 与 GVA `batch_copy` 两条模式，但 PP layer id、多 main spec、reachable block 均有开放修复 | **AscendStore 能力更宽，但当前成熟度不足** | LMCache 补组合矩阵；AscendStore 合入 `#15507/#15442/#15854` |
| KV 管理 | KV 量化/序列化压缩 | ✅ 有 CacheGen，以及 MP serde 的 FP8、TurboQuant、asym K16/V8 等 | ❌ 当前 AscendStore/Mooncake 按原始 byte slice 存取；`compress_ratio` 是模型布局，不是通用 serde 量化 | **LMCache 明显更好** | LMCache 需补 Ascend kernel/性能验证；AscendStore 需要 codec/版本/误差元数据层 |
| KV 管理 | P/D 不同 TP 的 KV 重排 | ❌ Ascend PD backend 按同 `tp_rank` 连接、按发送端 shape/dtype 搬 raw bytes，没有通用 reshard | ⚠️ dense GQA 的 strided head-slice 代码已存在，但主分支 transfer thread 没传 `worker`，生产入口不可达 | **两边当前都不能视为可靠支持** | AscendStore 优先合入 `#15835`；MLA/hybrid/sparse/layerwise mismatch 仍需新设计 |
| KV 传输 | 通用 P2P | ✅ Ascend P2P backend，经 Controller 找 peer，支持 push/pull、host staging、lease/Done | ◐ Mooncake 可从任意已注册 segment 读写，但语义是对象存储数据面，不是专门的 peer cache 协议 | **LMCache 更贴近推理实例间 P2P** | LMCache Controller 当前只选一个 peer，location/suffix 策略简单 |
| KV 传输 | 专用 PD backend | ✅ Ascend PD backend 支持 HCCL/HIXL、push、pull、delay-pull、CPU offload、NPU direct | ◐ 没有独立 PD backend；P 和 D 通过同一外部 Store 交换对象 | **LMCache 更灵活、更低语义层开销** | LMCache 补异构 TP/layout conversion 与更简单的控制协议 |
| KV 传输 | 注册内存与多段搬运 | ✅ CPU/NPU allocator buffer 注册给 HCCL/HIXL channel | ✅ 从真实 KV tensor 合并 storage region，普通模式注册 TransferEngine；多 buffer batch put/get；Fabric 模式走统一地址 | **Mooncake 的通用 registered-memory fabric 更完整** | 两边都需要地址生命周期、越界和重注册压力测试 |
| KV 传输 | A5 / Ascend 950：UBOE 与 UB | ◐ vLLM-Ascend 可按 `SOC_VERSION=ascend950*` 构建，但 LMCache-Ascend P2P/PD 未见 A5 `ASCEND_LOCAL_COMM_RES`/UB endpoint 专用接线 | ✅ vLLM-Ascend 明确要求 A5 使用 UBOE 的 `ASCEND_GLOBAL_RESOURCE_CONFIG` 或 UB 的 `ASCEND_LOCAL_COMM_RES`；Mooncake AscendDirect 把两者传给 ADXL/HIXL | **AscendStore + Mooncake 的 A5 接线证据更完整** | 增加 A5 UBOE/UB 两条路径的多机 KV correctness、带宽和故障回归 |
| KV 传输 | A3 Fabric memory | ❌ LMCache-Ascend backend 未见对应 Store 统一地址模式 | ✅ A3 可用 `ASCEND_ENABLE_USE_FABRIC_MEM=1`；AscendStore 跳过显式 buffer 注册，Mooncake/HIXL 处理 Fabric 可共享地址 | **AscendStore + Mooncake 明显更强；这行不是 A5 能力** | A3 需校验 CANN/HDK/LingQu 版本、1GB 内存对齐和每 rank Fabric 配额 |
| KV 传输 | Mooncake `ubshmem` / `ub` transport | ❌ 当前未见接入 | ◐ Mooncake 同时有 `USE_UBSHMEM` + `UBShmemTransport` 和独立的 `USE_UB` + `UbTransport`；它们是不同低层 protocol，也不等同于上面 A5 的 UBOE/UB 环境配置 | **Mooncake 低层传输选项更多，但不能仅凭编译宏认定 AscendStore 端到端可用** | 分别验证 allocator、设备发现、地址注册和 Store multi-buffer 接线 |
| KV 传输 | HCCL / HIXL | ✅ HCCL 可注册 HOST/DEVICE memory；CANN 8.5+ 可构建 HIXL 通道，P2P/PD 已接入 | ◐ Mooncake `ascend` transport 走 TransferEngine；不是 LMCache HCCL/HIXL backend | **LMCache-Ascend 更强**（专用 P2P/PD） | 补充 HIXL 在 A5 上的实测矩阵，并与 UBShmem 路径分开统计 |
| KV 传输 | 并发与隔离 | ◐ 独立 event loop/线程，但 ZMQ、lease、buffer pin 状态复杂 | ⚠️ 当前主要是 Python transfer thread，存在 GIL/请求级并发瓶颈 | **LMCache 当前略好；Mooncake C++ 数据面潜力更高** | AscendStore 的 subprocess/server 方向见 `#15832/#15652` |
| KV 传输 | 失败传播 | ✅ P2P 返回明确 error，PD allocation failure 有 backoff，pull 总是发 Done 释放资源 | ⚠️ `MooncakeBackend.put()` 捕获异常/负返回后只记日志，不把失败可靠返回给发送线程 | **LMCache 更好** | AscendStore 需结构化错误、超时、circuit breaker 和 request fallback |
| KV 存储 | 本地多级缓存 | ✅ Local CPU 是热缓存和其他 backend staging；可组合 Disk、Remote、P2P、PD；支持 LRU/LFU/FIFO/MRU | ◐ Mooncake 可配 DRAM/SSD/NoF/DFS，但它们是对象 replica 层，不是推理进程内热缓存策略 | **LMCache 更好** | LMCache 要降低 tier 之间重复拷贝；Mooncake Connector 可补近端热度策略 |
| KV 存储 | 分布式对象、副本、配额、淘汰 | ◐ backend 丰富，但 LMCache Controller 主要维护 key → worker/location 注册信息 | ✅ Master 管 object、segment、replica、read lease、tenant quota、高低水位 eviction、promotion/replication | **Mooncake 明显更好** | Mooncake 仍需为 KV workload 做副本成本和热点策略调优 |
| KV 存储 | 存储节点故障 | ◐ worker heartbeat 超时后从 RegistryTree 注销；请求可以 miss 后重算 | ✅ client 超时会 unmount segment、使失效 handle 不可读；有其他完整 replica 时可继续读 | **Mooncake 更完整** | 两边都必须明确“单副本节点宕机 = 该 KV 对象丢失，只能重算” |
| KV 存储 | 控制面 HA | ⚠️ 当前 LMCache Controller registry 是进程内结构；有 full-sync 重建，但未见 leader election/oplog/snapshot | ✅ Mooncake 有 leader coordinator、standby promotion、oplog、snapshot/restore | **Mooncake 明显更好** | LMCache 若承担集群级控制面，需要主备、一致性日志和恢复 SLO |
| 运维 | 复杂度与耦合（昇腾部署） | 功能面宽，但 Controller、ZMQ side channel、event loop、pin/lease、staging 状态多 | 分层较清晰，但 key/layout 与 vLLM-Ascend 强耦合；A5 UBOE/UB、A3 Fabric memory 依赖不同 CANN/HDK 和环境配置 | **按硬件和故障目标选型** | 发布 A2/A3/A5、HCCL/HIXL/UBOE/UB/Fabric 的兼容矩阵，不用未验证能力做默认配置 |

### 结论先说

1. **要“KV 管理平台”能力，LMCache 更强**：跨 tier 前缀查找、pin/prefetch、回填、淘汰、P2P、PD、serde 都在同一套抽象里。
2. **要“分布式 KV 对象存储”能力，Mooncake 更强**：segment、replica、配额、淘汰和 Master HA 都不是 LMCache Controller 当前的强项。
3. **要跟随 vLLM 的 hybrid/DSV4/sparse/layerwise 语义，AscendStore 更贴近源头**，但当前主分支存在若干 correctness 和并发缺口，不能把开放 PR 当成已交付。
4. **P/D 不同 TP 是两边当前共同短板**：LMCache Ascend PD 是同 rank raw-byte 协议；AscendStore 有 dense GQA reshard 代码，但接线尚未合入，而且 MLA/hybrid/sparse/layerwise mismatch 仍明确不支持。
5. **“DSV4 compress/sparse”不等于 KV 量化**：前者是模型/attention 原生布局和 reachable block 语义；真正减少存储字节的通用 serde 目前 LMCache 明显领先。

## 2. 比较边界：两边分别负责什么

| 层次 | LMCache-Ascend + LMCache | AscendStoreConnector + Mooncake |
| --- | --- | --- |
| vLLM 调度接入 | LMCache connector/adapter 返回外部命中长度，维护 LMCache 请求状态 | AscendStore scheduler/worker connector 直接使用 vLLM block hash 与 KV cache group |
| KV 索引 | `CacheEngineKey`、链式 chunk hash、tier location | `PoolKey = model + parallel ranks + group/role/family + block hash` |
| KV 内存布局 | NPU connector 把 vLLM KV layout gather/scatter 为 LMCache memory object | AscendStore 直接从 vLLM KV tensor 计算每个 block/layer/head slice 地址 |
| 传输 | LMCache-Ascend HCCL/HIXL channel，P2P/PD backend | Mooncake TransferEngine/Ascend transport，multi-buffer/GVA copy |
| 存储控制面 | LMCache StorageManager + CacheController | Mooncake Master |

因此，“LMCache 前缀匹配强”与“Mooncake 副本 HA 强”并不矛盾：它们本来就位于不同层。真正公平的比较对象必须是两套完整方案。

两者也不是绝对互斥。LMCache 本身已有 `mooncakestore://` remote connector adapter，`lmcache/v1/storage_backend/connector/mooncakestore_adapter.py:15` 因而架构上可以形成“LMCache 负责 prefix/tier/P2P/PD，Mooncake 负责远端 object/replica/HA”的组合。不过这条组合路径仍需单独验证 Ascend 直连、serde、错误传播和双层 eviction，不能因为类已经存在就默认等价于 AscendStoreConnector 的 NPU multi-buffer/GVA 能力。

版本基线：

| 仓库 | 本地 commit | 分支 |
| --- | --- | --- |
| LMCache-Ascend | `1b6e3a4` | `main` |
| LMCache | `8fc50f1` | `dev` |
| vLLM-Ascend | `af337df` | `main` |
| Mooncake | `408b831` | `main` |

## 3. KV 管理特性

### 3.1 KVC 调度与缓存编排

#### LMCache-Ascend + LMCache

LMCache 的核心优势不是“能把一块 KV 搬走”，而是 StorageManager 把多个 backend 看成有顺序的 tier：

- `async_lookup_and_prefetch()` 在所有活动 backend 上按连续前缀查找和预取；命中可以由不同 tier 接续组成。`lmcache/v1/storage_backend/storage_manager.py:653`
- remote/P2P 命中后可回填 Local CPU，形成下一次的本地热命中。`lmcache/v1/storage_backend/storage_manager.py:480`
- Local CPU backend 在 lookup 时 pin，在请求完成后 touch，并委托 cache policy 更新热度。`lmcache/v1/storage_backend/local_cpu_backend.py:127`
- policy 目录中同时实现 LRU、LFU、FIFO、MRU。cache_policy —— `lmcache/v1/storage_backend/cache_policy`

短板是它维护了一套 vLLM 之外的 chunk/tier/request 状态。功能越多，pin/unpin、异步任务、回填和 backend 顺序之间的状态组合越复杂。

#### AscendStoreConnector + Mooncake

AscendStore 不重建完整的 attention cache manager，而是尽量复用 vLLM 原生语义：

- Coordinator 根据实际 `KVCacheSpec` 找对应 `SingleTypeKVCacheManager`，包括 compress manager 和 registry manager。`vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/coordinator.py:342`
- Hybrid group 使用各自的 block size、cache family 和 manager 生成命中 mask。`vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/coordinator.py:55`
- Sliding Window group 会裁剪只需保留的尾部 block；Mamba group 会触发额外 truncate 语义。`vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/pool_scheduler.py:500`

这使它对 vLLM 新模型布局更“原生”，代价是 Connector 与 vLLM-Ascend 的 KV spec、group、layer、rank namespace 深度耦合。

### 3.2 前缀匹配

#### LMCache

LMCache 将 token 按 chunk 切分，并把前一个 chunk hash 作为下一个 hash 的输入，形成链式前缀 key。`lmcache/v1/token_database.py:334`

优点：

- key 天然表达“到当前位置为止的完整前缀”；
- StorageManager 可以先取 CPU 的前半段，再从 Disk/Remote/P2P 取后半段；
- lookup、pin、prefetch 和回填属于同一套管理语义。

限制：当前 retrieval 明确假设连续前缀；一旦中间 chunk 缺失，后面的孤立命中不再贡献可复用长度。`lmcache/v1/storage_backend/storage_manager.py:690`

P2P Controller 也只返回一个实例的最长连续前缀，并在代码中留下了 location 和 prefix eviction 的 TODO。`lmcache/v1/cache_controller/controllers/kv_controller.py:380`

#### AscendStore

AscendStore 直接使用 vLLM 生成的 block hash，再叠加布局 namespace：

```text
model
+ head_or_tp_rank
+ pcp_rank / dcp_rank / pp_rank
+ kv_cache_group_id
+ cache_role / cache_family
+ chunk_hash
```

代码见 `vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/config_data.py:74`。这些字段不是冗余标签，而是防止不同物理 KV 片段共用同一个 block hash 后互相覆盖：

- `head_or_tp_rank`：普通 MHA/GQA 下通常代表 TP shard；当 KV head 少于 TP 数或 MLA 多 rank 持有相同 KV 时，它代表合并后的“有效 KV head 组”。
- `pcp_rank`：prefill context parallel rank；不同 rank 负责 prompt 上不同 context slice。
- `dcp_rank`：decode context parallel rank；decode 阶段的 context shard 也可能不同。
- `pp_rank`：pipeline stage；不同 stage 持有不同 layer，必须隔离 key 空间。
- DP rank 没进入 key：相同模型、相同并行布局的 DP replica 理论上可以共享同一份外部 KV；DP 是请求副本关系，不改变 KV head/layer 的逻辑内容。

AscendStore 的优势是 lookup 结果可直接交回 vLLM 的 group manager 判断“哪些 block 对这个 spec 可达”。弱点是一个请求需要的 PP/TP/group variant 必须完整，缺一个 shard 就不能宣称整段前缀可用。

### 3.3 MLA/DSA：TP 下的重复 KV 怎么处理

#### LMCache 的做法

LMCache 对 MLA 默认启用 `save_only_first_rank`，并且只允许该语义在 `metadata.use_mla` 时生效。`lmcache/v1/token_database.py:112`

它做了两件关键事情：

1. key 中的逻辑 `world_size` 折叠为 1，使兼容的不同 TP 部署能使用同一个 MLA cache namespace。`lmcache/v1/token_database.py:234`
2. 非 first rank 成为 passive rank，整个 store 路径直接短路，避免把相同 latent KV 保存多份。`lmcache_ascend/integration/vllm/vllm_v1_adapter.py:115`

这不是“任意模型只存 rank 0”。普通 GQA/MHA 的 TP rank 持有不同 KV head，不能覆盖；只在 MLA/DSA 的 KV 内容确实跨 TP 冗余时折叠。

#### AscendStore 的做法

AscendStore 在 MLA 下把 `num_kv_head` 设为 1。当 `num_kv_head < tp_size` 时：

```python
put_step = tp_size // num_kv_head
head_or_tp_rank = tp_rank // put_step
```

也就是多个物理 TP rank 映射为同一个有效 KV head 组，避免每个 rank 使用不同 key 保存相同 latent。具体写入分工依路径而异：非 layerwise 路径可通过 `shard_rank/shard_size` 对 block 预分片，`vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/kv_transfer.py:788`；当前 layerwise/GVA 路径则只让 `put_step` 组内第一个 rank 保存，代码还留有“未来按 block 分摊”的 TODO。`vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/pool_worker.py:1019`

二者都能去掉 MLA 的同组冗余，但抽象不同：LMCache 是“只让一个逻辑 rank 保存完整共享 KV”；AscendStore 是“先合并 key namespace，再让组内 rank 对 block 分片写”。

### 3.4 Hybrid、DSV4、稀疏与 layerwise

#### “不是围绕 vLLM reachable-block 语义构建”是什么意思

这里的 **reachable block** 不是“这段地址能不能被 NPU 指针访问”，而是 vLLM 根据 attention/cache 规则计算出的**逻辑可达块**：当前请求在该 KV cache group 中真正会读取、因此值得保存或加载的 block。普通 dense attention 中，已提交 token 对应的 block 通常都可达，所以“block hash + 连续地址”近似足够；DSV4、滑窗、压缩和稀疏 attention 中则可能存在：

- 位于窗口外、不会再参与 attention 的 block；
- 压缩域和 raw-token span 不一一对应的 block；
- 某个 hybrid cache group 有效、另一个 group 不有效的 block。

AscendStore Coordinator 会调用 vLLM manager 的 `reachable_block_mask`，再决定外部 KV pool 只写哪些 block，代码见 _reachable_block_mask() —— `vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/coordinator.py:396`。LMCache-Ascend 的 P2P/PD backend 接收的是上层已经组织好的 `MemoryObj`、shape/dtype 和 chunk key（例如 `lmcache_ascend/v1/storage_backend/p2p_backend.py:979`），传输层本身不会调用这个 mask。因此原表中那句话的准确含义是：**LMCache 不是不能搬 sparse/DSV4 的 tensor，而是默认不会自动知道哪些逻辑 block 对 vLLM attention 可达；上层若不先过滤，就可能把不可达 block 一并搬运或存储。**

需要先区分两个经常混在一起的概念：

| 概念 | 实质 | 是否减少对象字节 |
| --- | --- | --- |
| DSV4 `compress_ratio` / sparse KV | attention 模型本身只为部分 token/block 形成 cache，或用压缩域 block 对应更长 raw-token span | 由模型 KV layout 决定，不是序列化 codec |
| FP8/CacheGen/TurboQuant | 保存前对 KV 数值编码，读取后解码 | 是，属于存储/网络 serde 压缩 |

AscendStore 对第一类更贴近 vLLM：Coordinator 根据 `compress_ratio`、cache family、group block size 和 manager 计算 external key granularity 与 reachable mask。`vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/coordinator.py:103`

但当前 layerwise DSV4 路径仍有明显冗余问题：开放 PR `#15854` 的目标就是只保存 reachable block；PR 描述的 131072 token case 从约 45.6 GB 降到 1.4 GB，说明当前路径可能把不可达 block 也存入外部池。这是**当前缺陷证据**，不是已获得的优化。

LMCache layerwise 当前限制更直接：

- async store 与 layerwise 互斥。`lmcache_ascend/integration/vllm/vllm_v1_adapter.py:129`
- Ascend P2P、PD backend 与 layerwise 在 backend 创建时直接报错。`lmcache_ascend/v1/storage_backend/__init__.py:65`
- Ascend layerwise NPU connector 也明确标注当前不支持 MLA。`lmcache_ascend/v1/npu_connector/npu_connectors.py:1169`
- Hybrid model 的 byte-opaque page 可以搬，但 CacheGen 等内容感知处理不一定适用。

AscendStore layerwise 的能力面更宽：普通 key-layer 模式和 GVA `batch_copy` 模式都存在；后者会按最大 block 数和最大字节数拆包。`vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/kv_transfer.py:435`

但是它当前至少还有三个开放 correctness 修复：PP global layer id、DSV4 多 main cache spec、reachable block，详见第 6 节。

### 3.5 DSV4 Flash/Pro、KDA/GDN/MLA 与 KV 格式演进

#### Flash 和 Pro 到底特殊在哪里

从 KV 角度看，**DeepSeek-V4-Flash 和 DeepSeek-V4-Pro 不是两种不同的 KV 语义**。两者都采用 DSV4 的混合 attention：不同层通过 `compress_ratios` 选择普通/滑窗、Compress-4 或 Compress-128 路径；vLLM-Ascend 对每层读取该 ratio，并在 ratio 大于 1 时创建 compressor，在 ratio 等于 4 时额外创建 indexer（`vllm_ascend/models/deepseek_v4.py:802`、`vllm_ascend/models/deepseek_v4.py:827`）。

两者的主要差异是模型规模、权重量化和部署规模，而不是外部 KV 的基本协议：Flash 文档给出 w8a8、单 A3 节点和 1M context 的部署组合（`docs/source/tutorials/models/DeepSeek-V4-Flash.md:144`）；Pro 使用 w4a8，至少需要两台 A3 节点（`docs/source/tutorials/models/DeepSeek-V4-Pro.md:26`）。因此做 KV store 时不能按“Flash 一种格式、Pro 另一种格式”设计，而应按实际 checkpoint 的 `compress_ratios`、dtype、block size 和 cache family 建立格式版本。

#### DSV4 实际上有几类 KV/state

一个 DSV4 layer 可能同时涉及以下对象，不能只抽象成一对 `K/V`：

| 对象 | 作用 | 复用/存储含义 |
| --- | --- | --- |
| Compress-4/128 主 cache | 压缩域的 latent KV，`num_kv_heads=1`；一个 cache token 对应 4 或 128 个 scheduler token | block hash 必须带 `compress_ratio` 和 logical token span，不能直接按 raw token 数解释 |
| Compressor state | compressor 的运行状态；代码明确包含 `kv_state + score_state`，C4 还使用 overlap | 更接近 recurrent state，边界和版本必须一致，不能与主 cache 脱离发布 |
| C4 indexer K/scale cache | lightning indexer 使用的 K、量化 scale；根据 query 选择 top-k block | K/scale 是数据，top-k 是请求/步骤相关 metadata；`use_index_cache` 时 top-k 还可能跨层复用（`vllm_ascend/attention/dsa_v1.py:1730`） |
| SWA cache | 滑窗 attention 使用的局部 token KV；每层都创建，ratio<=1 时它是主要 cache | 只能按窗口和 retention 语义保留，不能把窗口外 block 当普通 prefix 永久保存 |

代码中的 `DSV4_BLOCK_SIZES` 甚至把 MLA、SWA、C4 state、C128 state 分成四组 block size，并且 A5 使用另一套物理 page size（`vllm_ascend/models/layer/attention/layer.py:32`）。这就是 DSV4 对 KV 格式最直接的启示：**cache family、压缩比例、物理 block、dtype/scale 和可达性必须成为显式 schema，而不是把 tensor bytes 交给一个通用 key。**

#### 和 KDA、GDN、MLA 放在一起看

- **MLA**：仍然是 token/block 可寻址的 latent KV。只要 layout、TP namespace 和 RoPE/scale 一致，就适合做 prefix hash、远端 block 存储和跨请求复用；MLA 的主要特殊点是 KV head/latent 维度以及 TP 下可能存在共享冗余。
- **GDN/KDA**：核心是递推状态（例如 recurrent `h`、conv state），新 token 会更新旧状态。它不是“每个 token 一块独立 K/V”，外存对象应按状态检查点/序列边界管理；任意中间 token block 不能像 MLA 一样独立加载后继续计算。
- **DSV4**：把两种思想组合起来：SWA/主压缩 cache 保留 token/block 访问能力，compressor state 又有递推状态特征，C4 indexer 还引入动态 top-k 和 reachable block。因此它是从“静态 KV page”走向“数据 + 状态 + 访问计划”的混合格式。

#### 对 KV 存储系统的启示

1. **对象身份要带语义**：至少包含 `model/checkpoint`、`target|draft` role、global layer id、cache family、`compress_ratio`、logical token span、block size、dtype/quant/scale layout 和并行 namespace。
2. **数据和控制 metadata 分离但要版本绑定**：主 KV、compressor state、indexer K/scale 可以分对象传输，但必须由同一个 manifest/version 原子提交；top-k/reachable mask 通常是请求相关，不能当成永久模型 KV 数据。
3. **prefix 命中不再等于“连续 raw token bytes 命中”**：C4/C128 需要把 scheduler token 映射到 compressed-cache token；sparse attention 还要检查 block 是否 reachable。LMCache 若继续用 raw `MemoryObj`，应由上层先生成 canonical manifest 和过滤后的 block list。
4. **存储策略要区分 authoritative 与 speculative**：target KV 是可长期复用的权威 cache；MTP/DSpark draft KV 只对对应 draft model、layer 和已接受 token 前缀有效，拒绝的 speculative suffix 不能发布为稳定对象。

#### MTP/DSpark 的 target KV 与 draft KV 分层

这里的“分层”不是把同一份 target KV 再复制一份，而是**两个模型域、两组 attention layer、两套可独立失效的 cache**：

- 普通 DSV4 MTP 的 `DeepSeekMultiTokenPredictorLayer` 明确以 `is_draft_layer=True` 创建 MTP attention；它接收 target 的 hidden state，再用自己的 `e_proj/h_proj` 和 attention 产生 draft KV（`vllm_ascend/models/deepseek_v4_mtp.py:56`、`vllm_ascend/models/deepseek_v4_mtp.py:121`）。因此 draft KV 数值不能用 target layer 的 KV object 覆盖。
- DSpark 更明显：draft layer 的逻辑编号从 `config.num_hidden_layers` 之后开始，权重仍位于 checkpoint 的 `mtp.*` namespace；`target_layer_ids` 只用于把若干 target hidden states 汇入 `main_proj`，不是复用 target KV（`vllm_ascend/models/deepseek_v4_dspark.py:98`、`vllm_ascend/models/deepseek_v4_dspark.py:109`、`vllm_ascend/models/deepseek_v4_dspark.py:128`）。
- DSpark 会为每个 draft layer 返回独立的 `swa_cache_layer.prefix`，并可用 target context hidden states 预计算、写入 draft 自己的 SWA cache（`vllm_ascend/models/deepseek_v4_dspark.py:169`、`vllm_ascend/models/deepseek_v4_dspark.py:210`）。这解释了为什么 vLLM 要把 draft attention groups 单独找出来，而不是将它们并入 target group。
- 对带线性/递推 cache 的 speculative group，scheduler 还会额外分配 `num_speculative_blocks` 作为 lookahead 临时容量；这类 block 不代表已经被 target 接受的稳定 prefix（`vllm/v1/kv_cache_interface.py:716`、`vllm/v1/core/single_type_kv_cache_manager.py:1471`）。vLLM 甚至把 KV connector 的 finalize 延后到 draft forward 之后，以便 draft 也能触发 KV 保存，再统一收尾（`vllm/v1/worker/gpu_model_runner.py:4843`）。

对 LMCache 的具体启示是：

1. 持久 key 至少增加 `role=target|draft`、`draft_method`（MTP/DSpark）、draft checkpoint hash、draft layer id 和 cache family；不能只使用 token prefix hash。`spec_step/branch` 更适合作为未确认 suffix 的临时事务字段，accepted prefix 提交后不应继续按运行时 step 隔离。
2. target KV 可以进入跨请求、跨节点的长期缓存；draft KV 默认只建议做进程内/同 worker 的短期缓存。若要放远端，必须带 tentative/accepted 状态，只提交 rejection 后仍有效的前缀。
3. DSV4 的 draft layer 仍可能是 SFA/压缩 attention，因此 draft KV 还要带完整的 cache family、compress ratio、indexer/state 依赖；不能因为它叫“draft”就退化成一个普通 dense page。
4. target 命中不能直接推导 draft 命中：target context hidden state 可以作为 draft KV 的输入，但 draft attention 的投影权重和 cache layout 不同，LMCache 应分别 lookup/evict 两个 namespace。

### 3.6 KV 量化和压缩

LMCache 当前代码中能看到两代 serde：

- 经典 remote serde：`naive`、CacheGen。`lmcache/storage_backend/serde/cachegen_encoder.py:341`
- MP/L2 serde：FP8、TurboQuant、asym K16/V8，并通过 factory 注册选择。`lmcache/v1/distributed/serde/factory.py:27`

因此在“降低网络和存储字节”这一项上，LMCache 明显领先。

但不能直接推导为“Ascend 上已经高性能”：CacheGen 主实现有手写 CUDA/XPU kernel，Ascend 需要单独验证可用路径；不同 serde 也需要评估 encode/decode 延迟、临时 headroom、精度损失和 NPU kernel 占用。结论应是**功能和抽象领先，Ascend 性能成熟度仍需实测**。

AscendStore + Mooncake 当前 `put/get` 接口接收的是 `addrs/sizes`，直接把这些 byte slice 写入或读出，没有 codec、scale、版本或误差元数据层。`vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/backend/mooncake_backend.py:189`

## 4. KV 传输特性

### 4.1 LMCache-Ascend P2P backend

P2P backend 是“任意推理实例之间共享已有 KV”，不是只服务 P/D：

- Controller 根据 chunk hash 找到持有最长前缀的 peer；worker 再直接与 peer 数据面连接。`lmcache_ascend/v1/storage_backend/p2p_backend.py:1272`
- push 模式由源端写入接收端预分配 buffer；pull 模式由接收端读取源端已注册 buffer。`lmcache_ascend/v1/storage_backend/p2p_backend.py:979`
- pull 支持 host staging，源对象会 pin，并由 lease TTL 防止 peer 永不回 Done 导致永久占用。`lmcache_ascend/v1/storage_backend/p2p_backend.py:1021`
- 读成功或失败后都发送 Done，释放源端资源。`lmcache_ascend/v1/storage_backend/p2p_backend.py:1621`

优势是按需从 peer 拉取，能够避免“先写中心 Store、再从中心 Store 读”的额外对象发布语义。弱点是 Controller 当前只选一个 peer，而且明确没有解决复杂 location、多个 peer 拼前缀、prefix 已淘汰但 suffix 尚存等策略。

### 4.2 LMCache-Ascend PD backend

PD backend 是面向 prefill sender → decode receiver 的专用协议，代码能力比只看 upstream LMCache 会更完整：

- 同时初始化 CPU/NPU allocator，并把一个或多个 buffer 注册到 HCCL/HIXL transfer channel。`lmcache_ascend/v1/storage_backend/pd/backend.py:42`
- 默认 push；可切到 pull；`delay_pull` 只允许 NPU buffer 且必须建立在 pull 上。`lmcache_ascend/v1/storage_backend/pd/backend.py:85`
- push 前让 D 端远程分配；allocation failure 会释放已 pin 对象并对该 peer 做 TTL backoff。`lmcache_ascend/v1/storage_backend/pd/sender_mixin.py:283`
- pull 用 `ProxyMemoryObj` 延迟到消费时读取；D 端用发送端 shape/dtype 构造 transfer context，完成 scatter 后回 Done。`lmcache_ascend/v1/storage_backend/pd/receiver_mixin.py:270`

它的边界同样很明确：连接端口按 `self.tp_rank` 取，消息携带发送端 raw shape/dtype，接收端按该布局分配/散射。代码中没有“P TP=8 → D TP=4”的 head gather/scatter 或 collective reshard，因此不能把它理解为异构 TP 转换器。

### 4.3 AscendStore + Mooncake 数据面

AscendStore 的强项是直接从 vLLM 的真实 KV tensor 构造多段地址：

这里表格里“Mooncake 不是专门的 peer cache 协议”指的是**语义层边界**，不是说 Mooncake 不能在两个推理节点之间直连传输。Mooncake TransferEngine 可以根据远端地址、本地地址和长度执行数据搬运；Mooncake Store 再把这次搬运纳入 `object → replica → segment` 生命周期，但默认不理解以下 KV 专用语义：

- 哪个推理 worker 持有某个 KV chunk；
- 多个 chunk 能否拼成请求的最长连续 prefix；
- 拉取期间源端 KV 是否需要 pin；
- 接收端完成消费后何时发送 `Done` 释放源端资源；
- 某个 peer 失效后是否切换到另一个 peer，还是让请求 miss/recompute。

LMCache-Ascend P2P backend 则直接围绕这些语义实现：Controller 按 chunk hash 找 peer，worker 执行 push/pull，pull 期间维护 lease/pin，并在完成或失败后发送 `Done`（`lmcache_ascend/v1/storage_backend/p2p_backend.py:979`、`lmcache_ascend/v1/storage_backend/p2p_backend.py:1621`）。Mooncake 的对象发布则是 `PutStart → transfer → PutEnd/PutRevoke`：Master 先分配 replica，传输完成后才把对象提交为可读（`mooncake-store/src/client_service.cpp:1881`）。因此更准确的表述是：**Mooncake 是通用的 registered-memory/object 数据面；LMCache P2P 是带 KV chunk、prefix、lease 和 peer 选择语义的专用协议。**

- 每个 cache entry 记录 `base_addr`、`block_len`、`block_stride`；block 地址是 `base + block_id * stride`。`vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/pool_worker.py:711`
- 同一个 PyTorch storage 的多个 view 会合并为一个注册区间，避免重复注册；hybrid view 的起始地址按 2 MB 向下对齐。`vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/pool_worker.py:739`
- 普通 NPU 内存模式把合并区间注册到 TransferEngine；Fabric memory 模式不再显式注册。`vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/backend/mooncake_backend.py:173`
- backend 使用 `batch_put_from_multi_buffers` / `batch_get_into_multi_buffers`，一个 object 可以由多个不连续 KV slice 构成。`vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/backend/mooncake_backend.py:189`

Mooncake Client 内部将对象发布拆成 `PutStart → transfer → PutEnd/PutRevoke`：Master 先分配 replica descriptor，TransferEngine 搬数据，成功后才将 metadata 提交为可读。`mooncake-store/src/client_service.cpp:1881`

这套数据面比专用 PD backend 更通用，能承载 memory、local disk、NoF SSD、DFS 等 replica；但通用对象协议也带来 Master RPC、对象分配和发布语义，不一定是同机/邻机 P→D 最短路径。

### 4.4 不同 TP：当前到底谁能转换

#### LMCache-Ascend

普通 GQA/MHA 的 `CacheEngineKey` 含 world/rank，PD/P2P 又是 rank 对 rank 搬同形状 raw bytes，所以 P、D 的 TP 不同会同时遇到：

1. key namespace 不一致；
2. 每 rank 的 head 数和 tensor shape 不一致；
3. 没有把多个 P shard gather 成 D shard，或把一个 P shard split 给多个 D rank 的实现。

MLA 的 `save_only_first_rank` 能消除“所有 TP rank 持有相同 latent KV”的冗余，但这不等价于通用 GQA TP reshard。

#### AscendStore

主分支已经存在 dense GQA mismatch 算法：

- 用 `effective_tp_size` 建公共 key namespace；
- 一个本地 shard 可拆成多个 sub-key；
- `_build_strided_addrs()` 对每个 token 计算 head slice 地址；
- store/load 分别调用 `_store_kv_tp_mismatch()` 和 `_load_kv_tp_mismatch()`。`vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/pool_worker.py:1919`

但当前生产接线是断的：`KVCacheStoreSendingThread` 和 `KVCacheStoreRecvingThread` 只有在 `self.worker` 非空时才分发 mismatch 路径，`vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/kv_transfer.py:679`；而 `pool_worker.py` 创建这两个线程时没有传入 `worker=self`。`vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/pool_worker.py:546`

因此当前结论必须是：**算法代码存在，但主分支不可视为可用；PR `#15835` 正在恢复 wiring。**

即使该 PR 合入，当前 mismatch 仍只允许单一 dense KV group，代码明确拒绝：

- sparse KV；
- layerwise；
- hybrid/DSV4；
- MLA。

限制检查见 `vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/pool_worker.py:213`。根因不是“这些模型名字特殊”，而是 strided 算法假设所有 entry 具有统一的 dense `[block, token, local_head, head_dim]`：

- MLA 没有普通 GQA 的可切分 KV head 轴；
- hybrid 有多个 group、不同 block size/stride；
- sparse/compress 的 raw token 与 cache-domain block 不是一一对应；
- layerwise 是逐层异步提交，现有线程没有 mismatch 的 sub-key/head-slice 协议。

### 4.5 A5/Ascend 950、UBOE/UB 与 Fabric

代码里的 **A5** 具体对应 Ascend 950/950DT：vLLM-Ascend 安装文档要求 A5 设置 `SOC_VERSION=ascend950dt_9582`，构建脚本也对 `ascend950` 走专门分支（`setup.py:151`、`CMakeLists.txt:68`）。真正与 A5 KV 传输相关的配置在 `docs/source/user_guide/feature_guide/kv_pool.md:88`：

- **UBOE**：`ASCEND_GLOBAL_RESOURCE_CONFIG='{"comm_resource_config.protocol_desc":["uboe:device"]}'`；
- **UB**：`ASCEND_LOCAL_COMM_RES='{"version":"1.3"}'`，也可以由 `ascend_local_comm_res_path` 为每张 NPU 加载 `ub_endpoint_npu_<id>.json`，`vllm_ascend/utils.py:539`。

Mooncake AscendDirect 把 `ASCEND_LOCAL_COMM_RES` 传入 `adxl.LocalCommRes`，把 `ASCEND_GLOBAL_RESOURCE_CONFIG` 解析后传入 `GlobalResourceConfig`，代码见 `mooncake-transfer-engine/src/transport/ascend_transport/ascend_direct_transport/transfer_executor_base.cpp:215`。因此“支持 A5/UB”的代码依据不是出现一个名为 `ub` 的字符串，而是 **A5 endpoint/resource 配置确实进入了 ADXL/HIXL engine 初始化**。

另外三个名字必须区分：

1. **A3 Fabric memory：** `ASCEND_ENABLE_USE_FABRIC_MEM=1` 在当前 Mooncake/vLLM-Ascend 文档中明确限定为 A3。此时 AscendStore 使用本机 hostname 作为 `local_seg`、`local_buffer_size=0`，并跳过显式 `TransferEngine.register_buffer()`（`vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/backend/mooncake_backend.py:118`、`vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/backend/mooncake_backend.py:173`）。这不能直接算成 A5 支持。
2. **Mooncake `ubshmem`：** `USE_UBSHMEM` 会编译 `UBShmemTransport` 和 `ubshmem_fabric_allocator.so`，并以 `protocol="ubshmem"` 安装 transport（`mooncake-common/common.cmake:109`、`mooncake-transfer-engine/src/multi_transport.cpp:506`）。
3. **Mooncake `ub` transport：** `USE_UB` 会创建独立的 `UbTransport` 和 UB allocator（`mooncake-transfer-engine/src/multi_transport.cpp:435`、`mooncake-store/src/common/client_buffer_allocation.cpp:82`）。它与 `ubshmem` 是不同低层插件，也不能只凭名称等同于 A5 的 `ASCEND_LOCAL_COMM_RES` 配置。

LMCache-Ascend 目前能证明的是 HCCL/HIXL 的 HOST/DEVICE memory 注册和 P2P/PD 通道（`csrc/hccl/hccl_agent.cpp:94`、`setup.py:75`）；未见 A5 UB endpoint 配置或 `UBShmemTransport` 接入。因此结论是：**LMCache-Ascend 在 HCCL/HIXL 专用 P2P/PD 更完整；AscendStore + Mooncake 在 A5 UBOE/UB 的芯片接线和 A3 Fabric memory 方向更完整。**

vLLM-Ascend 另有 `SfaRemoteD2HConnector + memfabric_hybrid` 的 P/D pull 路径，它会独立初始化 MemFabric engine、注册 KV 地址并调用 `batch_transfer_sync_read()`（`vllm_ascend/distributed/kv_transfer/utils/memfabric_transfer_engine.py:22`）。这不是 AscendStore + Mooncake 路径，所以本表不把它记到方案 B 的已实现能力中。

### 4.6 失败处理与并发

LMCache P2P/PD 的状态机虽然复杂，但失败语义相对完整：明确 error message、allocation backoff、lease TTL、Done 清理，最终 miss 时可让 vLLM 重算。

AscendStore 的主要问题在 Python adapter：`MooncakeBackend.put()` 检查到负返回或捕获异常后只记录日志，没有把结构化失败返回给发送线程。`vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/backend/mooncake_backend.py:189` 这会让“对象没真正发布”和“上层认为请求保存完成”之间出现可观测性缺口。

Mooncake C++ Client 自身对每个 replica 有明确的 transfer summary 和 `PutEnd/PutRevoke` 决策，`mooncake-store/src/client_service.cpp:1967`；问题主要是 Python Connector 没把结果完整上抛。

当前 AscendStore transfer worker 仍以 Python thread 为主。开放 PR `#15832/#15652` 分别尝试 worker-owned subprocess 和独立 KV cache server，说明现有 GIL、NPU IPC 和多 engine 隔离是已知演进方向。

## 5. KV 存储特性

### 5.1 LMCache：强在 tier 编排，不强在分布式副本元数据

LMCache-Ascend 创建 backend 的顺序和依赖非常清楚：

- PD backend 可独立启用；
- Local CPU 通常总是创建，因为 Disk/Remote/P2P 都可能把它当 staging；
- P2P 依赖 Local CPU；
- Local Disk 与任意 remote plugin 可以继续叠加。`lmcache_ascend/v1/storage_backend/__init__.py:49`

它擅长的是一个推理实例周边的 L1/L2 多级缓存生命周期：热度、pin、回填、逐 tier 查找、淘汰、P2P borrowing。

LMCache Controller 维护的是进程内 `RegistryTree(instance → worker → kv)`。`lmcache/v1/cache_controller/utils.py:339` worker 心跳超时会完整 deregister。`lmcache/v1/cache_controller/controller_manager.py:477` worker 也有 full-sync 机制，可在控制器重启后重新上报状态。

但是当前本地实现未看到 Controller 自身的 leader election、持久化 oplog、snapshot 和自动 standby promotion。因此：

- worker 挂了：注册信息会清理，后续请求 miss/recompute；
- Controller 挂了：可以通过重启 + worker full sync 重建，但不是透明主备切换；
- 某个 remote backend 自身若有 HA，那是该 backend 的能力，不能算成 LMCache Controller 的一致性协议。

### 5.2 Mooncake：强在对象、replica、淘汰和 HA

Mooncake Master 管的是全局对象元数据：

- Client mount segment 后，Master 将 segment 容量和 TransferEngine endpoint 加入 allocator，并开始监控 client heartbeat。`mooncake-store/src/master_service.cpp:881`
- `PutStart` 为对象选择并分配 replica；数据完成后 `PutEnd` 才把对象变为可读；失败则 `PutRevoke`。
- replica 可以位于 MEMORY、local disk/SSD、NoF SSD、DFS；Client 对各类 replica 分别传输并汇总成功状态。`mooncake-store/src/client_service.cpp:1907`
- Master 还负责 tenant quota、高低水位淘汰、promotion 和 dynamic replication。

节点故障语义比 LMCache registry 更完整：client heartbeat 超时后 unmount segment，allocator 与失效 handle 被清理；对象若还有完整 replica 可以继续读，没有 replica 则返回 miss/recompute。

控制面 HA 也更完整：

- leader coordinator 负责获取/续租 leadership；
- standby 持续接收元数据状态；
- promotion 时先恢复 objects/segments，再开放服务；
- leadership 丢失会停止对外服务，避免双主。`mooncake-store/src/ha/leadership/master_service_supervisor.cpp:248`
- 配置中提供 oplog 和 snapshot/restore。`mooncake-store/src/master.cpp:309`

必须强调：**Master HA 保护的是元数据控制面，不凭空增加数据副本。** 如果一个 KV object 只有一个 MEMORY replica，承载它的 segment 节点宕机，该对象仍然会丢，只能重新计算。

## 6. vLLM-Ascend 待合入 PR：哪些结论可能变化

以下 PR 在 2026-09-06 检查时仍为 Open。它们只说明维护者正在解决问题，不计入当前主分支能力。

| PR | 状态 | 解决的问题 | 对当前判断的影响 |
| --- | --- | --- | --- |
| [#15835](https://github.com/vllm-project/vllm-ascend/pull/15835) | Draft | 恢复 AscendStore TP mismatch 的 worker wiring 和同步 load dispatch | 合入并验证后，dense GQA 异构 TP 才能从“不可依赖”升为“有限支持” |
| [#15854](https://github.com/vllm-project/vllm-ascend/pull/15854) | Draft | DSV4 layerwise 只保存 reachable block | 直接修复长上下文下约 32 倍冗余的报告案例 |
| [#15507](https://github.com/vllm-project/vllm-ascend/pull/15507) | Open | layerwise key 从 PP stage-local layer id 改成 global layer id | 当前多 PP 可能 key 覆盖、decode 不命中；属于 correctness 修复 |
| [#15442](https://github.com/vllm-project/vllm-ascend/pull/15442) | Open | DSV4 layerwise 支持多个 main cache spec | 扩大 hybrid/layerwise 可用模型范围 |
| [#15832](https://github.com/vllm-project/vllm-ascend/pull/15832) | Draft | transfer 放入 worker-owned subprocess，加入 NPU IPC/event/buffer registration | 解决 GIL 和推理线程争用；后续提交声称覆盖 hybrid/compress/mismatch/layerwise，仍需 NPU 验证 |
| [#15652](https://github.com/vllm-project/vllm-ascend/pull/15652) | Draft | 独立 KV cache server，多 engine attach、session heartbeat | 比 `#15832` 更大粒度的进程隔离方向 |
| [#15883](https://github.com/vllm-project/vllm-ascend/pull/15883) | Open | sparse KV 的 Mooncake Host DRAM allocator | 当前 PR 主要是资源池/view；PR 明确 Mooncake backend/write-back 尚未启用，不能算完整 sparse offload |
| [#14773](https://github.com/vllm-project/vllm-ascend/pull/14773) | Draft | 非 layerwise Mooncake 多接收线程 | 侧面说明当前单接收线程有 request-level 并发瓶颈 |
| [#11315](https://github.com/vllm-project/vllm-ascend/pull/11315) | Open | put timeout / circuit breaker | 当前 Connector 的错误传播和故障隔离仍偏弱 |
| [#11037](https://github.com/vllm-project/vllm-ascend/pull/11037) | Draft | SSD `batch_is_exist` 时预取到 DRAM | 当前 Connector 未获得完整 SSD lookup-prefetch 热路径 |

需要特别注意三类 PR：

1. `#15835/#15507/#15854` 是**正确性修复**，不是单纯性能优化；未合入前应影响生产准入判断。
2. `#15832/#15652/#14773` 是**并发与进程隔离**，说明当前 Python thread 模式还没有最终收敛。
3. `#15883/#11037` 是**存储层扩展**，但 allocator 或预取能力不等于端到端 KV backend 已可用。

## 7. 哪边做得不好，以及优先补什么

### 7.1 LMCache-Ascend + LMCache

#### 做得好的

- 外部 KV 不是单一 Store，而是统一的 tier orchestration；
- P2P 和 PD 是一等 backend，支持 push/pull/delay-pull、CPU/NPU buffer 与失败回收；
- MLA `save_only_first_rank` 的去冗余语义明确；
- serde/量化压缩能力显著领先；
- miss/recompute 的降级闭环相对完整。

#### 做得不好的

- Ascend P2P/PD、layerwise、MLA、hybrid 之间组合限制多；
- PD/P2P 按 rank 和 raw layout 工作，不支持通用 P/D TP mismatch；
- Controller peer 选择和 prefix/location 策略简单；
- side channel、独立 event loop、buffer pin、lease、Done、staging 使状态机复杂；
- Controller HA 弱于 Mooncake Master。

#### 建议补强

| 优先级 | 建议 |
| --- | --- |
| P0 | 明确发布 P/D compatibility matrix：TP/PP/PCP/DCP、MLA/GQA、layerwise、dtype、block size，不兼容时启动即失败 |
| P0 | 为异构 TP 设计 canonical KV shard namespace + gather/split/scatter，不要把 `save_only_first_rank` 泛化成普通 GQA reshard |
| P0 | 为 P2P/PD 做端到端故障注入：peer crash、Done 丢失、allocation exhaustion、NPU event timeout、host staging 满 |
| P1 | Controller 支持多 peer 评分、多个 peer 拼接 tier、location-aware cost model |
| P1 | 将 transport lease/Done/backoff 抽成统一状态机，减少 P2P 与 PD 重复逻辑 |
| P1 | 给 Ascend serde 建独立 benchmark：压缩比、encode/decode、TTFT、临时 HBM、精度 |
| P2 | 若 Controller 成为集群关键控制面，加入 leader election、持久化日志、snapshot 和有界恢复时间 |

### 7.2 AscendStoreConnector + Mooncake

#### 做得好的

- KV key/layout 与 vLLM 原生 block manager、hybrid group、SWA/Mamba/compress 语义紧密对齐；
- 真实 tensor 地址、多 view storage region 合并、多 buffer batch I/O 设计适合零额外 pack 的数据面；
- Mooncake object/segment/replica/quota/eviction/HA 完整；
- layerwise GVA copy 能按 layer、block、字节拆包；
- dense GQA TP mismatch 已有合理的 effective-rank + strided head-slice 设计基础。

#### 做得不好的

- 当前主分支 TP mismatch wiring 断开；
- layerwise 还有 PP layer id、multi-main-spec、reachable block 三个 correctness 缺口；
- Python backend 对 put/get 失败的上抛不足；
- transfer thread 的 GIL/隔离问题尚未收敛；
- 没有通用 KV serde/量化层；
- Mooncake 的通用对象协议对短路径 P→D 可能偏重。

#### 建议补强

| 优先级 | 建议 |
| --- | --- |
| P0 | 合入并做 NPU 端到端验证：`#15835/#15507/#15854/#15442`；为每个缺陷加多机 correctness test |
| P0 | `MooncakeBackend.put/get` 返回逐 key 结构化结果，让 worker 只把真正成功的 block 标记完成 |
| P0 | 加 timeout、circuit breaker、Master/segment/transfer failure 的 request-level fallback |
| P1 | 在 `#15832` 与 `#15652` 两条进程化路线中确定唯一主方向，避免维护两套 IPC 生命周期 |
| P1 | 设计 codec envelope：format/version/dtype/scale/checksum/layout-id，使 Mooncake object 能存 FP8/量化 KV |
| P1 | 扩展 mismatch 到多 group：先 canonicalize 每个 group 的 logical token span，再分别做 head/layout conversion |
| P2 | 对本地 P→D 增加 fast path 或 peer-preferred replica，减少不必要的中心对象发布开销 |

## 8. 场景化选择

| 场景 | 更推荐 | 原因 |
| --- | --- | --- |
| 单集群内 P/D，TP 相同，追求 push/pull 灵活和最短数据路径 | LMCache-Ascend PD | 专用 PD backend、HCCL/HIXL、pull/delay-pull、CPU/NPU buffer 已成体系 |
| 多实例之间借用 KV，强调按需 peer fetch | LMCache-Ascend P2P | Controller + direct P2P + pull lease 语义更直接 |
| CPU/Disk/Remote 多级缓存和通用前缀复用 | LMCache | tier lookup/prefetch/回填/eviction 是核心能力 |
| 大规模共享池、多个存储节点、replica、配额、淘汰和 Master HA | AscendStore + Mooncake | Mooncake 的分布式对象存储控制面明显更完整 |
| vLLM hybrid/Sliding Window/Mamba/DSV4，新 KV spec 跟进速度重要 | AscendStore + Mooncake | 直接复用 vLLM manager/spec/group 语义，但需核对开放 correctness PR |
| 存储成本受限，需要 FP8/CacheGen/TurboQuant | LMCache | 当前有 serde 抽象和实现；AscendStore 尚无同等通用层 |
| P/D TP 不同的普通 dense GQA | 当前两边都不应直接承诺 | AscendStore 等 `#15835` 合入并验证后可成为有限可选项 |
| P/D TP 不同且模型是 MLA/DSV4/sparse/layerwise | 当前都不推荐 | 不是简单地址搬运，需要 canonical layout 和模型语义感知的重排 |

## 9. GLM indexer 与 DSV4 indexer：不是同一种 KV 对象

这里的 GLM 指 `GLM-5/5.1/5.2`，即 `model_type="glm_moe_dsa"` 的 DSA/SFA 模型。它确实有 indexer，但不能因此把 GLM 的 indexer cache 和 DSV4 的 indexer cache 当成同一种对象。

### 9.1 GLM indexer 的语义

GLM 复用 DeepSeek-V3.2 风格的 `DeepseekV32Indexer`。Indexer 对每个 token 生成轻量 indexer K，并通过 query/indexer-K 的得分选择 sparse attention 的 top-k block；它本身不是正常 attention 的 K/V。vLLM 的 `DeepseekV32IndexerCache` 明确只保存一个向量，不是 K+V 两个缓存：`vllm/model_executor/models/deepseek_v2.py:616`。

在当前实现中，GLM 的 indexer cache 可以抽象成：

```text
indexer_k (+ scale)
        ↓ LightningIndexer
topk block indices
        ↓
从主 SFA/MLA KV 中取 sparse block
```

昇腾侧将 indexer 作为独立 cache layer 暴露给 allocator，再由 SFA forward 将主 KV 和 indexer cache 临时重新组合：`vllm_ascend/attention/indexer.py:14`、`vllm_ascend/attention/sfa_v1.py:1685`。

### 9.2 DSV4 indexer 的语义

DSV4 只有 `compress_ratio == 4` 的层创建 indexer；C128 层没有独立 indexer：`vllm_ascend/models/deepseek_v4.py:827`。DSV4 的 indexer 还绑定自己的 compressor：`vllm_ascend/models/deepseek_v4.py:584`。它产生的 top-k 不是直接从普通 token KV 中挑选，而是用于选择 C4 compressed KV block；Ascend metadata 也只在 C4 时设置 `cmp_topk`：`vllm_ascend/attention/dsa_v1.py:623`。

因此 DSV4 的 cache family 是复合的：

```text
SWA KV
C4 compressed KV + C4 compressor state
C128 compressed KV + C128 compressor state
C4 indexer K (+ scale)
topk indices
```

DSV4 的 indexer 是“压缩 KV attention 的访问计划生成器”；GLM 的 indexer 更接近“主 SFA KV 的稀疏 block 选择器”。

| 对比项 | GLM-5/5.1/5.2 | DSV4 Flash/Pro |
| --- | --- | --- |
| 主 attention | DSA/SFA + MLA 主 KV | SWA + C4/C128 compressed attention |
| indexer 作用 | 选 sparse SFA KV block | 选 C4 compressed KV block |
| indexer 是否带 compressor | 没有独立 compressor | `indexer.compressor` 与 C4 强绑定 |
| indexer cache | indexer K，启用 C8 时另有 scale | C4 indexer K/scale；另有 compressor state |
| 非 indexer 层 | 可复用前一 indexer 层 top-k | C4 层按 IndexCache 规则复用 top-k；C128 本身不建 indexer |
| 主 cache family | 主 SFA/MLA K/V | SWA、C4、C128、state、indexer 多组 |
| 传输对象 | 不能只传主 K/V，需考虑 indexer K、scale、top-k 关系 | 不能只传 C4 K/V，需连同 compressor state、SWA 和 indexer 版本 |

### 9.3 GLM-5.1 与 GLM-5.2 还不完全一样

`skip_topk` 只表示本层不重新计算 top-k，不必然表示本层没有 indexer 权重。昇腾 patch 对两种 checkpoint 做了区分：`vllm_ascend/patch/worker/patch_deepseek_v2.py:36`。

- **GLM-5.1**：IndexCache 通常只跳过部分层的 top-k 计算，但每层仍可能保留 indexer 权重和本地 indexer cache 描述。
- **GLM-5.2**：checkpoint 可以通过 `indexer_types="shared"` 明确表示共享 indexer；共享层可以不构造自己的 indexer，只读取共享的 `topk_indices_buffer`。

所以 GLM-5.2 常见的物理布局是：

```text
A 层：主 SFA KV + indexer K/scale
B 层：主 SFA KV，复用 A 层 top-k
```

这不是“B 层没有 KV”，而是“B 层没有自己的 indexer 表示”。主 KV 和 indexer cache 必须分开做 namespace、容量统计和 eviction。

### 9.4 昇腾 C8 与 DCP 的额外差异

昇腾 SFA 中有两个独立的 C8 概念：

- `enable_sparse_sfa_c8`：主 SFA K/V 的 packed C8 cache；
- `enable_sparse_li_c8`：LightningIndexer K/scale 的 C8 cache。

代码明确将两者分开处理：`vllm_ascend/attention/sfa_v1.py:607`。因此 Mooncake/LMCache 的 codec 不能只写一个 `dtype=int8`，至少要记录 `cache_family`、`scale_dtype`、`layout_version` 和 C8 类型。

GLM-5.2 的 DCP 还存在“indexer 复制、主 KV 分片”的特殊布局：indexer 为了让每个 DCP rank 看到完整序列而复制，主 SFA KV 仍按 DCP 分片：`docs/source/developer_guide/Design_Documents/context_parallel.md:56`。这属于有意的 indexer 冗余，不等于主 KV 冗余。

### 9.5 对 KVC 传输和存储的结论

对 GLM，远端对象至少应区分：

```text
main_sfa_kv/{layer, token_block, tp/dcp shard, layout}
indexer_k/{indexer layer, token_block, quant format}
indexer_scale/{indexer layer, token_block, scale dtype}
topk_indices/{request or accepted prefix, indexer source layer, topk version}
```

不能把 `topk_indices` 当作普通 KV block 的永久替代品：它依赖 query、indexer 参数版本、序列长度和 sparse policy。GLM-5.2 shared indexer 层可以复用 indexer/top-k 元数据，但仍要保留主 KV 的层归属；DCP 复制的 indexer 也不能误判为 TP shard 重复写入。

对 DSV4，则应进一步增加：

```text
compress_ratio=4|128
compressor_state_type=kv_state|score_state
swa_window
indexer_source_c4_layer
```

因此，GLM 与 DSV4 可以共用“indexer 生成 top-k block”的抽象接口，但不能共用不带 `cache_family` 和 `layout_version` 的 raw-byte KV object。

## 10. 最终判断

如果把 KVC 看成“命中、缓存层级、调度、压缩、P2P/PD”的**管理系统**，LMCache-Ascend + LMCache 当前更完整。

如果把 KVC 看成“把大量 KV 变成全局对象，由集群管理 segment、replica、容量、淘汰和故障恢复”的**分布式存储系统**，AscendStoreConnector + Mooncake 当前更强。

两套方案最关键的共同缺口不是带宽，而是**异构并行布局的 canonical representation**。只要 P、D 的 TP/hybrid/layerwise 布局不同，raw byte transfer 就不够；必须先定义“一个 object 表示哪些 layer、哪些 logical token、哪些 KV head/latent、什么 dtype/layout 版本”，然后才能可靠地 split/gather/scatter。AscendStore 的 dense mismatch 已经走出了第一步，但主分支 wiring 和模型覆盖仍未完成；LMCache 的 MLA 去冗余解决的是共享 latent 的特例，不是通用 reshard。

## 11. 主要源码索引

### LMCache / LMCache-Ascend

- `lmcache/v1/token_database.py:112`：prefix hash、`save_only_first_rank`、key world size。
- `lmcache/v1/storage_backend/storage_manager.py:480`：tier lookup、prefetch、remote 回填。
- `lmcache/v1/storage_backend/local_cpu_backend.py:127`：pin/touch/cache policy。
- `lmcache_ascend/v1/storage_backend/__init__.py:49`：Ascend backend 组合和 layerwise 限制。
- `lmcache_ascend/v1/storage_backend/p2p_backend.py:979`：P2P push/pull、staging、lease、Done。
- `lmcache_ascend/v1/storage_backend/pd/backend.py:42`：Ascend PD allocator/channel/buffer registration。
- `lmcache_ascend/v1/storage_backend/pd/sender_mixin.py:283`：PD push/pull、remote allocation、backoff。
- `lmcache_ascend/v1/storage_backend/pd/receiver_mixin.py:270`：ProxyMemoryObj、sender layout、Done。
- `lmcache/v1/cache_controller/controllers/kv_controller.py:380`：Controller prefix/P2P lookup。
- `lmcache/v1/cache_controller/controller_manager.py:477`：heartbeat timeout 和 deregister。

### vLLM-Ascend / AscendStore

- `vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/config_data.py:74`：PoolKey 的并行布局 namespace。
- `vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/coordinator.py:55`：hybrid/compress/reachable manager 协调。
- `vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/pool_scheduler.py:500`：SWA/Mamba/外部命中语义。
- `vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/pool_worker.py:191`：MLA rank 合并、storage region、TP mismatch。
- `vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/kv_transfer.py:311`：transfer threads、layerwise GVA copy、mismatch dispatch。
- `vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/backend/mooncake_backend.py:118`：Fabric/普通内存 setup、buffer registration、multi-buffer put/get。
- `vllm_ascend/models/deepseek_v4.py:802`：DSV4 per-layer `compress_ratio`、compressor、C4 indexer 与 SWA cache。
- `vllm_ascend/models/deepseek_v4_dspark.py:98`：DSpark target-layer 汇聚、`mtp.*` draft layers 和 draft SWA cache。
- `vllm_ascend/models/deepseek_v4_mtp.py:56`：普通 DSV4 MTP draft layer 的独立 attention/KV。
- `docs/source/user_guide/feature_guide/kv_pool.md:88`：A5 UBOE/UB、A3 Fabric memory 的依赖和环境变量。
- `vllm_ascend/distributed/kv_transfer/utils/memfabric_transfer_engine.py:22`：独立 MemFabric P/D connector 的注册和批量读接口（不计入 AscendStore 方案）。
- `vllm_ascend/attention/sfa_v1.py:603`：GLM DSA 在昇腾上的 LightningIndexer 分支、RoPE 布局和算子选择。
- `vllm_ascend/device/device_op.py:455`：GLM/SFA indexer 的 top-k 选择及 C8 量化 indexer 路径。
- `vllm_ascend/patch/worker/patch_deepseek_v2.py:36`：GLM-5.2 shared indexer 与 GLM-5.1 per-layer indexer 的初始化差异。
- `vllm_ascend/attention/indexer.py:14`：将 SFA indexer cache 作为独立 cache layer 暴露给 KV allocator。
- `docs/source/developer_guide/Design_Documents/context_parallel.md:56`：GLM-5.2 DCP 中复制 indexer、分片主 SFA KV 的布局。

### Mooncake

- `mooncake-store/src/client_service.cpp:1881`：对象分配、replica transfer、PutEnd/PutRevoke。
- `mooncake-store/src/master_service.cpp:881`：segment mount/unmount、对象和 replica 生命周期。
- `mooncake-transfer-engine/src/transport/ascend_transport/ascend_direct_transport/transfer_executor_base.cpp:215`：A5 `ASCEND_LOCAL_COMM_RES`、`ASCEND_GLOBAL_RESOURCE_CONFIG` 到 ADXL/HIXL 的接线。
- `mooncake-transfer-engine/src/multi_transport.cpp:435`：`ub`、`ascend`、`ubshmem` transport 的独立注册分支。
- common.cmake —— `mooncake-common/common.cmake:108`：`USE_ASCEND`、`USE_ASCEND_DIRECT`、`USE_UBSHMEM`、`USE_UB` 编译开关。
- `mooncake-store/src/ha/leadership/master_service_supervisor.cpp:248`：leader election、standby promotion、恢复和 fencing。
- `mooncake-store/src/master.cpp:309`：oplog、snapshot、allocator、eviction 等配置。
