---
title: Mooncake Store 模块深度解析
author: MadaoRui
direction: KV 存储与池化
date: 2026-09-01
tags: [Mooncake, Store, 分布式缓存]
summary: TransferEngine 之上的分布式 KVCache 对象存储：把各节点贡献的 DRAM 与 SSD 拼成一个全局池，对外提供带多副本、租约、淘汰、分层落盘的 put/get。约 6 万行自有代码的走读。
---
# Mooncake Store 模块深度解析

> **代码仓库**：`kvcache-ai/Mooncake` 的 `mooncake-store/`（v2.0.0，monorepo 布局；src+include 约 6 万行自有代码 + 1.8 万行内嵌 CacheLib/folly/offset_allocator，测试另有 4 万行）
> **定位**：TransferEngine 之上的**分布式 KVCache 对象存储**——把集群各节点贡献的 DRAM（和 SSD）拼成一个全局池，对外提供带多副本、租约、淘汰、分层落盘的 put/get。上层调用方：vLLM-Ascend AscendStoreConnector、vLLM MooncakeStoreConnector、SGLang HiCache L3、LMCache remote。
> **姊妹篇**：`mooncake-module-analysis.md`（§4 为本文的浓缩版）、`mooncake-load-save-kv-flows.md`（上层连接器怎么调它）、`mooncake-ascend-kunpeng-ub-transport-analysis.md`（底层 Transport）。

---

## 目录

- [1. 一张图看懂：组件与进程模型](#1-一张图看懂组件与进程模型)
- [2. 部署形态：一个组件五种玩法](#2-部署形态一个组件五种玩法)
- [3. 核心数据模型：对象 / 副本 / 段](#3-核心数据模型对象--副本--段)
- [4. 关键子系统逐个拆](#4-关键子系统逐个拆)
- [5. put / get 全链路（函数级）](#5-put--get-全链路函数级)
- [6. 客户端侧组件](#6-客户端侧组件)
- [7. 昇腾栈专节](#7-昇腾栈专节)
- [8. 调参与排障速查](#8-调参与排障速查)
- [9. 设计理念总结](#9-设计理念总结)

---

## 1. 一张图看懂：组件与进程模型

```text
┌────────────────── 推理实例进程 × N（P 或 D，每 TP rank 一个客户端）──────────────────┐
│                                                                                     │
│  Python: MooncakeDistributedStore (store_py.cpp)                                    │
│      │ real 模式: 进程内直接持有 RealClient（setup 时可传入共享 TE）                   │
│      │ dummy 模式: DummyClient ──unix socket + 共享内存──→ 本机 RealClient           │
│      ▼                                                                              │
│  RealClient (real_client.cpp, 4642 行, 资源持有型)                                    │
│   ├─ Client (client_service.cpp, 3154 行, 核心逻辑)                                   │
│   │    ├─ TransferEngine（数据面；protocol=rdma/tcp/ascend/ubshmem…）                 │
│   │    ├─ MasterClient（控制面 coro_rpc 封装 + client pool）                          │
│   │    ├─ TransferSubmitter（策略：本机 memcpy / TE / 文件读）                         │
│   │    ├─ ClientBufferAllocator（本地暂存缓冲）                                        │
│   │    └─ LocalHotCache（客户端热点缓存 + CountMinSketch 准入）                        │
│   ├─ global segment（贡献给全局池的内存，按 max_mr_size 分片挂载）                      │
│   ├─ IPC server（收 dummy 的 shm fd 注册，unix socket）                                │
│   └─ offload RPC server（SSD 模式：batch_get_offload_object 等）                       │
└──────────┬──────────────────────────────┬─────────────────────────────┬──────────────┘
           │ 控制面 coro_rpc（小消息）       │ 数据面 TE（大数据，单边 RDMA） │ 元数据（可选）
           ▼                              ▼                             ▼
┌─────────────────────┐      ┌──────────────────────────┐   ┌────────────────────┐
│ mooncake_master     │      │ 存储节点 × k             │   │ etcd / redis / http│
│ (master_service.cpp │      │ = 任何 MountSegment 了    │   │ （TE 的段表；与     │
│  5197 行)           │      │   global segment 的实例  │   │  master 的对象元   │
│ · 对象元数据(1024分片)│      │ client↔client TE 直传，  │   │  数据无关，勿混淆） │
│ · 地址分配器(镜像分配)│      │ master 不碰数据          │   └────────────────────┘
│ · 副本策略/租约/淘汰  │      └──────────────────────────┘
│ · 任务下发/HA(可选)  │
└─────────────────────┘
```

三个最重要的角色认知（理解 store 的钥匙）：

1. **master 是控制面，不是数据面**：对象元数据（key→副本）、地址分配、租约、淘汰全部集中在 master；数据永远走 client↔client 的 TE 直传，master 一个字节都不搬。
2. **地址分配器跑在 master，内存物理上在 client**：client `MountSegment` 时把 `(base, size)` 上报，master 在自己进程里对这个区间做**纯地址运算的镜像分配**（segment.cpp:25）——master 由此获得全局配额与负载视角，又不必然搬运数据。
3. **“段”是存储节点的身份**：一个贡献内存的进程 = 一个 segment（名字默认 `ip:port`），多副本强制落在不同 segment = 不同故障域。

## 2. 部署形态：一个组件五种玩法

| 形态 | 做法 | 适用 |
|---|---|---|
| ① 嵌入式 | 推理进程内直接 `MooncakeDistributedStore()`（real 模式），`global_segment_size>0` 时自己也贡献内存 | 最简部署（SGLang HiCache 默认） |
| ② dummy-real | 每个 TP rank 一个 DummyClient（零资源），同机唯一 RealClient（`mooncake_client` 守护进程或嵌入式 real）持有内存/RDMA，走 unix socket + 共享内存 | 多卡推理共享一份 NIC/内存；进程重启缓存不丢 |
| ③ 独立 store 服务 | `mooncake_client` 进程专职供内存（`global_segment_size=4GB`，`local_buffer_size=0`），推理实例 `global_segment_size=0` 纯读写 | 存储/计算分离部署 |
| ④ REST 服务 | `python -m mooncake.mooncake_store_service`（wheel 内 557 行）把 store 包成 HTTP API | 实验/跨语言 |
| ⑤ master HA | `mooncake_master --enable_ha=true`：etcd/redis 选主 + OpLog 回放 + 快照 | 生产高可用 |

master 另可内嵌 HTTP 元数据服务（`--enable_http_metadata_server`），把 TE 的段表也一并管掉，免独立部署（SGLang 集成文档的单机形态）。

## 3. 核心数据模型：对象 / 副本 / 段

- **对象 = 一段连续缓冲 + N 个副本**（与 FAST25 旧版"多 slice 元数据"不同，v2 已简化）。"slice"只是传输/分配粒度：客户端 buffer 按 `kMaxSliceSize ≈ 16MB`（CacheLib slab 上限 `1<<24`-16，types.h:335）切段。
- **Replica**（replica.h:151）：`variant<MemoryReplicaData{AllocatedBuffer}, DiskReplicaData{file_path,size}, LocalDiskReplicaData{client_id,transport_endpoint}>`；状态机 UNDEFINED→INITIALIZED→PROCESSING→COMPLETE→REMOVED/FAILED；`refcnt_` 防淘汰（offload/读时 +1）。
- **ObjectMetadata**（master_service.h:582）：`{client_id, size, per-object SpinLock, lease_timeout, soft/hard_pin, replicas[]}`；全集群 1024 个哈希分片、每片一把 shared_mutex（`hash(key)%1024`）。锁序：client_mutex_ → shard mutex → segment_mutex。
- **SegmentDesc**（TE 元数据）：一个存储节点的全部可寻址信息（protocol/devices/拓扑副本/buffers 的 addr+len+rkey[]…）——store 的 `AllocatedBuffer::Descriptor{buffer_address, transport_endpoint}`（allocator.cpp:32）就是"KV 值地址 → TE target"的唯一桥梁。

## 4. 关键子系统逐个拆

### 4.1 Allocator：master 内的地址分配器

`BufferAllocatorBase` 接口（allocator.h:95）：`allocate/deallocate/capacity/getLargestFreeRegion…`，两种实现：

| | CachelibBufferAllocator | OffsetBufferAllocator（默认，conf/master.json） |
|---|---|---|
| 底层 | Facebook CacheLib Slab 子集（16MiB slab，自带来 1.8 万行内嵌代码） | 自研 bin-based offset allocator |
| 精确空闲率 | 只能返回 Unknown（allocator.h:165） | `getLargestFreeRegion()` 精确（allocator.cpp:269） |
| 用途 | 兼容旧版 | 供 FreeRatioFirst 分配策略决策 |

要点：**分配器不拥有内存**（只做地址运算）；`AllocatedBuffer` 是 RAII weak 句柄，`get_descriptor()` 产出可序列化的传输描述符。

### 4.2 分配策略：副本放哪

`AllocationStrategy` 三种（allocation_strategy.h）：
- **Random**（默认）：保证同一对象的各副本**落在不同 segment**（used_segments 集合去重，:245-297）；best-effort——分不满 `replica_num` 个不报错，全失败才 `NO_AVAILABLE_HANDLE`（:126-131 注释）；
- **FreeRatioFirst**：采样 6×候选数个 segment 按空闲率降序取 top-N（:424-505）——低开销近似负载均衡（依赖 Offset 分配器的精确空闲率）；
- **CXL**：强制从 preferred 的 CXL 全局分配器分（实验特性）。

客户端可通过 `ReplicateConfig` 影响策略：`replica_num / preferred_segment / prefer_alloc_in_same_node（昇腾默认开）/ with_soft_pin（30min 防逐）/ with_hard_pin`。

### 4.3 一致性模型：不可变对象 + 租约读

- **写**：`PutStart`（分配副本、PROCESSING、key 进 processing_keys）→ 数据传输 → `PutEnd`（mark_complete、续租约）；对象不可变；`PutRevoke` 回滚。PutStart 校验 client_id 防误写（master_service.cpp:921-925）。
- **读保护**：`GetReplicaList` 返回前给对象发 5s 硬租约（`GrantLease(default_kv_lease_ttl_)`，master_service.cpp:790，已验证）；客户端传完校验 `IsLeaseExpired` → `LEASE_EXPIRED`（client_service.cpp:815）——防止"读一半被淘汰"。
- **客户端存活**：client 周期 Ping；master `ClientMonitorFunc` 1s 扫描，超 `client_live_ttl_sec`（10s）判死 → 卸其 segment、清其副本；复活后 Ping 收 `NEED_REMOUNT` → `ReMountSegment` 重挂。

### 4.4 淘汰：master 的近似 LRU

`EvictionThreadFunc`（master_service.cpp:2260）10ms 轮询：使用率 > `eviction_high_watermark_ratio`（默认 0.95）或 PutStart 分配失败置位时 → `BatchEvict`（:3512）两遍扫 1024 分片：
- 第一遍用 `nth_element` 选 lease_timeout 阈值（**租约时间近似 LRU**，不是精确 LRU 链表），只逐非 soft-pin、租约过期、refcnt==0、COMPLETE 的 MEMORY 副本；
- 第二遍才允许 soft-pinned（`allow_evict_soft_pinned_objects`）；hard-pin 永不淘汰；
- `offload_on_evict` 模式：先 push 进 offloading 队列（pin 住排队落 SSD）再删内存副本——用内存换 I/O 峰值。

注：`eviction_strategy.h` 里的 LRU/FIFO 类是历史遗留，主流程未引用（仅单测）。

### 4.5 分层存储：DRAM → SSD

- **触发**：`enable_offload` 且非 offload_on_evict 时，PutEnd 即推 offloading 队列（:933-945）；master `OffloadObjectHeartbeat` 收集热度并**统一下发**待 offload 名单（避免各节点盲写）。
- **执行**：client 侧 `FileStorage::Heartbeat`（10s）领任务 → `BatchOffload` 写盘 → `NotifyOffloadSuccess` 回写 `StorageObjectMetadata{bucket_id,offset,…}` → master 把副本转成 DISK/LOCAL_DISK 态。
- **SSD backend 三种**（storage_backend.h:1223 工厂）：file-per-key / bucket 聚合（256MB 或 500 keys 一桶，两阶段删除：先摘元数据、等 in-flight 读排空、再删文件）/ offset 分配器日志式（单 kv_cache.data + 1024 分片内存索引）。文件 I/O 可选 posix/io_uring/3FS（file_interface.h）。
- **读回退**：对象只剩 DISK 副本 → 本地有盘直接 pread（FilereadWorkerPool）；LOCAL_DISK（数据在**远端**节点盘上）→ coro_rpc `batch_get_offload_object` 让远端 RealClient 读进其缓冲再 TE 拉回（real_client.h:663）。
- 客户端级开关：`MooncakeDistributedStore.setup(enable_ssd_offload=true, ssd_offload_path=...)`（mooncake ≥0.3.11；vllm-ascend 的 MooncakeBackend 会按全局 rank 隔离目录防桶文件冲突，mooncake_backend.py:110-117）。

### 4.6 HA（可选）

master 是唯一有状态组件：`MasterServiceSupervisor` 经 etcd/redis lease 选主（:92-120）；standby 持续回放 **OpLog**（PUT_END/PUT_REVOKE/REMOVE；其中 REMOVE 强制 `AppendAndPersist` 持久化后才执行——防"指向复用内存的 stale descriptor"，oplog_manager.h:86-99）+ 周期快照（默认 10min，落本地/S3）。client 端 watch leader 视图自动 SwitchLeader 重连。**非 HA 模式元数据纯内存**，master 挂了索引丢失（数据还在节点内存/盘上，但需重建）。

### 4.7 RPC 层

yalantinglibs **coro_rpc**（默认 :50051，`rpc_thread_num=4` 个 IO 线程跑协程；重活 `co_await coro_io::post` 丢线程池防阻塞）+ coro_http（:9003 metrics/health）。序列化 struct_pack + `YLT_REFL` 反射。错误模型 `tl::expected<T, ErrorCode>`。`MC_RPC_PROTOCOL=rdma` 时可走 RDMA socket。

## 5. put / get 全链路（函数级）

### 5.0 准备：MountSegment（谁想贡献内存，谁挂段）

```text
RealClient::setup_internal (real_client.cpp ~560-842)
 ├─ Client::Create → ConnectToMaster（HA 时 etcd 入口→读视图→SwitchLeader）
 ├─ 按 max_mr_size 分片分配内存（hugepage/NUMA 绑定/普通；昇腾→ascend_allocate_memory，见 §7）
 ├─ 每片: Client::MountSegmentAndGetId (client_service.cpp:2142，已验证)
 │    ├─ ① transfer_engine_->registerLocalMemory(ptr, size)   ← 先注册进 TE（发布句柄）
 │    └─ ② master_client_.MountSegment(segment)               ← 再上报 master（建镜像分配器）
 └─ ClientBufferAllocator::create(local_buffer_size) + 注册进 TE（本地暂存）
master 侧: ScopedSegmentAccess::MountSegment (segment.cpp:25) → 创建 Offset/Cachelib 分配器 → 登记
```

### 5.1 Put（单对象）

```text
RealClient::put(key, value, config)                         real_client.cpp:1339
 └─ put_internal (:1290)
     ├─ ClientBufferAllocator::allocate + memcpy + split_into_slices(≈16MB)
     └─ Client::Put(key, slices, config)                    client_service.cpp:1173
         ├─ [控制面] PutStart(key, slice_lengths, cfg) ─→ master:
         │     AllocateAndInsertMetadata (:796)
         │       ├─ allocation_strategy_->Allocate()（§4.2）→ vector<Replica>(PROCESSING)
         │       └─ 元数据入 shard + processing_keys
         │     ←─ 返回 {buffer_address, protocol, transport_endpoint} × 副本数
         ├─ [数据面] 对每个 MEMORY 副本: TransferWrite (client_service.cpp:2635)
         │     └─ TransferSubmitter::submit (transfer_task.cpp:488)
         │         ├─ selectStrategy (:785，已验证)：MC_STORE_MEMCPY=1 可强制 TE；
         │         │   isLocalTransfer(handle)（transport_endpoint==本机段）→ LOCAL_MEMCPY
         │         │   否则 → TRANSFER_ENGINE
         │         ├─ LOCAL_MEMCPY → MemcpyWorkerPool（异步线程池 memcpy）
         │         └─ TRANSFER_ENGINE → submitTransferEngineOperation (:678)
         │             ├─ engine.openSegment(handle.transport_endpoint)
         │             ├─ 每 slice: TransferRequest{WRITE, source, target_id,
         │             │   target_offset=buffer_address+offset, length}
         │             └─ allocateBatchID + submitTransfer ─→ 进入 TE（RDMA/ADXL…）
         │         失败 → PutRevoke 回滚该副本
         └─ [控制面] PutEnd ─→ master mark_complete + GrantLease (:910-961)
```

**multi_buffers 变体**（vLLM-Ascend / vLLM 主线 connector 实际用的）：`batch_put_from_multi_buffers(keys, 显存addrs[][], sizes[][])` —— 用户 buffer 直接当源（通常 NPU/GPU 显存地址），省掉本地暂存与 memcpy，BatchPutStart 一次 RPC 拿全部 key 的副本描述符，传输并发提交后统一等待（client_service.cpp:1991 BatchPut 五段式：CreatePutOperations→StartBatchPut→SubmitTransfers→WaitForTransfers→FinalizeBatchPut）。

### 5.2 Get（含 range/batch）

```text
RealClient::get_into(key, buffer, size)                     real_client.cpp:2680
 └─ get_into_range_internal (:2662)
     ├─ [控制面] Query(key) → master GetReplicaList (:758)
     │     └─ 收集 COMPLETE 副本 + GrantLease(5s)（:790，已验证）→ {replicas, lease_ttl}
     ├─ [数据面] FindFirstCompleteReplica
     │     ├─ 命中 LocalHotCache（CMS 频率准入）→ 改写描述符走本地（免网络）
     │     └─ transfer_submitter_->submitRangeRead → 同 §5.1 二选一（memcpy/TE READ）
     ├─ 传输后校验 IsLeaseExpired → LEASE_EXPIRED（:815）
     └─ ShouldAdmitToHotCache → ProcessSlicesAsync 异步回填本地热点缓存
BatchGet：BatchGetReplicaList 一次 RPC + 全部传输先提交再统一等待（client_service.cpp:994）
          batch_get_into_multi_buffers 为其 multi_buffers 变体
```

## 6. 客户端侧组件

| 组件 | 文件 | 职责 |
|---|---|---|
| ClientBufferAllocator | client_buffer.hpp | 本地暂存缓冲（OffsetAllocator），`split_into_slices` 按 slab 上限切段 |
| TransferSubmitter | transfer_task.cpp | 策略路由（memcpy/TE/文件读）+ TransferFuture 等待句柄；`submit_batch` 可合批 |
| MemcpyWorkerPool / FilereadWorkerPool | transfer_task.cpp | 本机拷贝线程池 / SSD pread 线程池 |
| LocalHotCache + CountMinSketch | local_hot_cache.h | 客户端本地二级热点缓存，频率准入（client_service.h:536） |
| DummyClient | dummy_client.cpp | 零资源代理；地址经 unix socket 注册的 shm fd 表翻译成 real 地址（real_client.cpp:3476 `map_dummy_addrs_to_real_ptrs`） |
| 后台线程 | client_service.h:699 | task poll(1s，拉 master 下发的 copy/move 任务)、leader monitor、storage heartbeat |

## 7. 昇腾栈专节

上层入口即 `MooncakeBackend`（vllm-ascend，见 flows 文档 §4），store 侧的昇腾特化集中在**内存分配与传输协议**两处：

1. **贡献内存的分配**：`allocate_buffer_allocator_memory`（mooncake-store/src/utils.cpp:82-98）在 `protocol=="ascend"/"ubshmem"` 时改调 `ascend_allocate_memory`（实现在 TE 侧 `mooncake-transfer-engine/src/transport/ascend_transport/ascend_allocator.cpp`）：
   - **fabric mem 开**（`ASCEND_ENABLE_USE_FABRIC_MEM=1`，仅 A3 800 I/T）：优先 `adxl::AdxlEngine::MallocMem`，否则 ACL VMM 三步（MallocPhysical 1G 大页@HOST_NUMA + Reserve + Map，NUMA id=(phy/4)×2）；段内存可被 ADXL 网络栈统一编址直达——此时 `MooncakeBackend` 不再传 engine、`local_buffer_size=0`；
   - **fabric mem 关**：`aclrtMallocHost` pinned host 内存，登记进 `g_store_mem_ranges`（ascend_allocator.cpp:98/:176）——这个注册表让 AscendDirectTransport 的 `registerMem` 识别"store 内存"，roce+dummy-real 时注册到**所有**引擎（任意卡可访问）。
2. **传输协议**：`protocol="ascend"` → TransferSubmitter 的 TE 走 AscendDirectTransport（ADXL）：`source` 是 NPU HBM 地址（location `npu:<id>`→MEM_DEVICE，multi_buffers 变体直接显存直读），`target` 是存储节点段内偏移；同机命中 `LOCAL_MEMCPY` 捷径会退化成 LocalCopyEngine 的 aclrtMemcpy。
3. **agent（dummy-real）模式**：`globalConfig().ascend_agent_mode=true`（real_client_main.cpp:101 / dummy_client.cpp:443）时 real 进程为**所有卡**建 context（ContextManager），每卡一个 ADXL 引擎、每引擎专属收发线程——vllm-ascend 侧的连接器自身不用 agent 模式（grep 无 ascend_agent_mode），它是独立部署 `mooncake_client` 供内存时的形态。
4. **SSD offload**：per-rank 目录隔离（mooncake_backend.py:110-117）；eviction/心跳逻辑与平台无关。

## 8. 调参与排障速查

| 参数 | 默认 | 说明 |
|---|---|---|
| `global_segment_size` | python setup 16MB / 独立服务 4GB | 该实例贡献给全局池的内存；TP>1 时每 rank 一份（总消耗=×TP）；设 0 则纯客户端 |
| `local_buffer_size` | 16MB | 本地 put/get 暂存缓冲；纯存储节点设 0；fabric mem 强制 0 |
| `--eviction_high_watermark_ratio` | 0.95 | master 淘汰高水位；分配频繁失败（碎片）时调低 |
| `--allocation_strategy` | random | random / free_ratio_first / cxl |
| `--memory_allocator` | offset | offset（精确空闲率）/ cachelib |
| `client_live_ttl_sec` | 10s | client 判死阈值 |
| `MC_STORE_MEMCPY` | 关 | =1 禁用本机 memcpy 捷径，强制走 TE |
| `MC_MS_AUTO_DISC` / `MC_FORCE_TCP` 等 | — | TE 侧网卡自动发现/协议强制（见主文档 §3） |
| 排障：段元数据 WARNING（`tseg` 空） | — | protocol 配错（rdma vs ascend）的典型症状 |

## 9. 设计理念总结

1. **控制面集中、数据面分散**：master 管元数据/分配/租约/淘汰（小消息 coro_rpc），数据 client↔client TE 单边直传（master 零参与）——与 TE 内部"元数据面/数据面分离"同构，两层各做一遍。
2. **分配器上移到 master 换全局视角**：地址在 master 分、内存在 client 持，代价只是一次 RPC 往返，换来跨 segment 的配额、负载均衡与故障域隔离（副本异 segment）。
3. **不可变对象 + 租约，而非分布式共识**：KVCache 写一次读多次的特性让 store 避开 Raft 类协议——用"PutStart/PutEnd 两阶段 + 读租约 + client TTL"以极低复杂度达成足够的一致性；HA 也只需保 master 单点（OpLog+快照）。
4. **best-effort 副本 + 客户端缓存削峰**：分不满副本不失败；读侧 FindFirstCompleteReplica + LocalHotCache（CMS 准入）两级削峰——面向"缓存可丢、性能优先"的负载。
5. **数据无状态、可重建**：节点上的数据不依赖 master 存活；client 死由 TTL 清理；offload 由 master 心跳统一调度——每个组件都可独立重启。
6. **面向推理的特化接口**：multi_buffers 变体让上层（vLLM/Ascend connector）把 NPU/GPU 显存直接当源/目的，免暂存拷贝；`prefer_alloc_in_same_node` 默认开（同节点传输走 memcpy 捷径）。

---

> **阅读路线**：`docs/source/design/mooncake-store.md`（官方设计文档）→ `src/client_service.cpp` 的 Put/Get → `src/master_service.cpp` 的 PutStart/GetReplicaList/BatchEvict → `src/transfer_task.cpp`（策略路由）→ 昇腾栈再叠加本文 §7。
