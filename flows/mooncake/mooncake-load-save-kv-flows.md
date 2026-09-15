---
title: Mooncake Load/Save KV 全流程解析（昇腾 NPU 栈视角）
author: MadaoRui
date: 2026-09-03
tags: [Mooncake, vLLM-Ascend, 昇腾, 存取全链路]
summary: 一次 KV 的存与取，从 vLLM-Ascend 的各连接器一路走到内核数据面：mooncake 侧走 protocol="ascend" 与 fabric mem，GPU 栈的差异压缩到对照表里，只作迁移参考。
---
# Mooncake Load/Save KV 全流程解析（昇腾 NPU 栈视角）

> **代码依据**：
> - mooncake 仓库 `kvcache-ai/Mooncake`（HEAD = `f2853a8`）
> - **vLLM-Ascend**：`vllm_ascend/distributed/kv_transfer/`，约 1.2 万行 mooncake 集成代码全文走读）
> **视角声明**：本文以**昇腾 NPU 栈**为准——vLLM 侧只看 vLLM-Ascend 的连接器，mooncake 侧 Transport 走 `protocol="ascend"`（AscendDirectTransport/ADXL）与 fabric mem；GPU 栈（GPUDirect/dmabuf、vLLM 主线 connector）的差异压缩到 §7 对照表，仅供迁移参考。
> **姊妹篇**：`mooncake-module-analysis.md`（模块总览）、`mooncake-ascend-kunpeng-ub-transport-analysis.md`（昇腾/鲲鹏 Transport 内部实现，本文 §5 直接引用）。

---

## 目录

- [0. 昇腾栈上的四条 KV 传输路径总览](#0-昇腾栈上的四条-kv-传输路径总览)
- [1. 公共底座：GlobalTE、NPU 内存注册与传输语义](#1-公共底座globaltenpu-内存注册与传输语义)
- [2. 路径一：P2P 整体拉取（MooncakeConnectorV1，D 侧拉）](#2-路径一p2p-整体拉取mooncakeconnectorv1d-侧拉)
- [3. 路径二：P2P 逐层推送（MooncakeLayerwiseConnector，P 侧推）](#3-路径二p2p-逐层推送mooncakelayerwiseconnectorp-侧推)
- [4. 路径三：共享 KV 池（AscendStoreConnector，Store 模式）](#4-路径三共享-kv-池ascendstoreconnectorstore-模式)
- [5. 进入 mooncake 内核后的路径（昇腾）](#5-进入-mooncake-内核后的路径昇腾)
- [6. 四路径横向对比](#6-四路径横向对比)
- [7. GPU 栈差异对照（仅供迁移参考）](#7-gpu-栈差异对照仅供迁移参考)
- [8. SGLang on Ascend 的说明](#8-sglang-on-ascend-的说明)

---

## 0. 昇腾栈上的四条 KV 传输路径总览

vLLM-Ascend 的连接器注册表（`kv_transfer/__init__.py:21-93`）里与 mooncake 相关的有三条，外加一条非 mooncake 的 SFA 路径：

| 路径 | 连接器 | 传输方向 | 控制面 | 场景 |
|---|---|---|---|---|
| **① P2P 整体拉取** | `MooncakeConnectorV1` | **D 侧拉**（`batch_transfer_sync_read`） | ZMQ side channel（P 侧只服务元数据） | PD 分离，跨机，支持 CP/PP/GQA/MLA/Mamba/SWA |
| **② P2P 逐层推送** | `MooncakeLayerwiseConnector` | **P 侧推**（`batch_transfer_sync_write`，每层 forward 完即推） | HTTP metaserver（layerwise proxy 的 `/v1/metaserver`） | PD 分离，传输与计算重叠（chunked prefill 下逐步推已算完块） |
| **③ 共享 KV 池** | `AscendStoreConnector`（旧名 MooncakeConnectorStoreV1） | put/get（`batch_put/get_from/into_multi_buffers`） | mooncake master（coro_rpc） | 前缀缓存跨请求/跨实例复用、decode offload、单机 kv_both 亦可 |
| ④ SFA RD2H | `SfaRemoteD2HConnector` | D 侧拉（memfabric） | memfabric 自带 | **与 mooncake 无关**（强制 `memfabric_hybrid` 包），A3 超节点 SFA 模型 decode offload 到 CPU 池 |

另有 `MooncakeHybridConnector`（路径①的混合布局变体，HMA/Mamba/compress 多 KV group，同为 D 侧拉，限制 pcp×dcp=1）。

**所有 mooncake 路径的 TE 协议都是 `protocol="ascend"`**（硬编码，见 §1），对应 mooncake 的 AscendDirectTransport（ADXL 引擎）；Store 模式在 A3 800 I/T 系列上还可开 `ASCEND_ENABLE_USE_FABRIC_MEM=1` 走统一编址直传（§4.2）。

**与 GPU 栈最大的认知差异（先记住这一条）**：昇腾版 P2P 是 **Decode 主动拉（READ）**，P 侧只被动服务元数据；GPU 主线版（含 mooncake 自带的 OOT connector）是 **Prefill 主动推（WRITE）**。逐层版则是 P 推——所以三条路径两种方向都有。

---

## 1. 公共底座：GlobalTE、NPU 内存注册与传输语义

### 1.1 GlobalTE 进程单例（`utils/mooncake_transfer_engine.py`）

```python
TransferEngine().initialize(hostname, "P2PHANDSHAKE", "ascend", device_name)   # :26
```

- **P2PHANDSHAKE**：无 etcd/master，段描述经 TCP 对等交换——PD 分离不需要中心服务；
- **protocol="ascend"**：mooncake 侧装载 AscendDirectTransport（ADXL，每卡一个引擎，引擎名 `ip:port` 即全局地址，详见姊妹篇 §2）；
- **device_name**：PP>1 时传 `torch.npu.current_device()`——对应"每卡一引擎"（一个进程多卡时引擎按卡区分）；
- **P2P 与 Store 复用同一个 TE**：`MooncakeBackend._setup_store` 把 `global_te.get_transfer_engine(...).get_engine()` 直接传给 `store.setup(engine=...)`（mooncake_backend.py:122-132），避免两套引擎抢资源。

### 1.2 注册的内存是什么：NPU tensor 的 data_ptr（HBM）

所有连接器注册的都是 **torch NPU tensor 的 `data_ptr()`（device/HBM 地址）**，没有任何连接器直接调 aclrtMemcpy。注册前统一处理（`utils/utils.py`）：

- `collect_storage_merged_register_regions`（:363-425）：按 `untyped_storage().data_ptr()` 分组排序、间隔 ≤4096B 合并——把每层张量合并成尽量少的注册区域；
- **HCCL 256 区域上限**（`MAX_HCCL_REGISTER_REGIONS`，:14）：超限直接报错（底层 ADXL/HCCL 的注册区域限制）；
- **2MB 对齐**断言/向下对齐（mooncake_connector.py:2359、pool_worker.py:739-756 `_align_kv_ptrs`）——昇腾 RDMA 传输的地址对齐要求。

### 1.3 TE Python API 的方向语义（读代码必备）

mooncake pybind 定义（transfer_engine_py.cpp）：
- `batch_transfer_sync_read(target, buffers, peer_buffer_addresses, lengths)`——第 1 组是**本地**地址，第 2 组是**远端**地址；READ = 从远端拉到本地；
- `batch_transfer_sync_write` 同形参，WRITE = 本地推远端。

所以 vllm-ascend 代码里的 `src_list/dst_list` 实际含义是"**本地/远端**"，不是"源/目的"——按直觉读会得出方向相反的错误结论。

### 1.4 NPU 特有的同步与线程纪律

| 机制 | 用途 | 代表位置 |
|---|---|---|
| `torch.npu.Event().record()` + `synchronize()` | put/传输前**等 NPU 上 KV 写完**（异步计算与异步传输的衔接点） | pool_worker.py:1763/888、layerwise:1722 |
| `ThreadPoolExecutor(initializer=torch.npu.set_device)` | 传输线程**绑定 NPU 设备**（ACL context 亲和，见姊妹篇 §2.5） | mooncake_connector.py:471-480、kv_transfer.py:499 |
| `torch.npu.Stream` + `npu_stream_switch` | head 重排/量化的 resharding 旁路流 | layerwise:1196/1740 |
| `ASCEND_TRANSFER_TIMEOUT` | 由 `HCCL_RDMA_TIMEOUT`(20s)/`HCCL_RDMA_RETRY_CNT`(7) 推导写入 | utils.py:55-61 |

---

## 2. 路径一：P2P 整体拉取（MooncakeConnectorV1，D 侧拉）

组件（`kv_p2p/mooncake_connector.py`，3939 行）：

| 组件 | 位置 | 职责 |
|---|---|---|
| `MooncakeConnectorScheduler` | :1655 | P：`request_finished` 产出 kv_transfer_params（含 remote_block_ids/engine_id/host/port）；D：matched tokens + 分配记录 |
| `MooncakeConnectorWorker` | :2000 | GlobalTE 初始化、NPU 内存注册、启动收发线程 |
| `KVCacheSendingThread` | :247 | **P 侧：不发数据**，纯 ZMQ ROUTER 元数据服务（回 `MooncakeAgentMetadata`）+ DONE 信号回收后释放块 |
| `KVCacheRecvingThread` | :411 | **D 侧：真正执行拉取**，32 线程池（initializer=绑卡） |

### Save KV（P 侧）——"被动被拉"，无主动发送

```text
P·Scheduler.request_finished (:1906-1952)
  ├─ 仅 do_remote_decode 且 FINISHED_LENGTH_CAPPED：裁剪块（掉 MTP 尾块 :1736、SWA 只留窗口尾 :1761）
  ├─ 返回 (delay_free=True, params{do_remote_prefill, remote_block_ids, remote_engine_id,
  │        remote_host/port=side_channel_port, remote_pcp/dcp/ptp_size, num_prompt_blocks, ...})
  │        —— 经 P2P proxy 转交 D 实例
  └─ P·Worker.start_load_kv (:3582) 把请求登记进 TaskTracker（延迟释放，超时 120s 强制回收 :223-244）

P·SendingThread.run (:324-408)  —— 只响应两种 ZMQ 消息：
  ├─ GET_META_MSG → 回 MooncakeAgentMetadata{te_rpc_port, 每层基址/block_len/block_stride,
  │                  kv_group2layeridx, num_blocks}（D 首次拉取时来问 :1369-1403 缓存）
  └─ DONE_RECVING_MSG → 按 remote_port_send_num 收齐后释放 P 的块 (:364-388)
```

`save_kv_layer/wait_for_save/wait_for_layer_load` 全部空操作（:1613-1621）——请求级、传输由 D 驱动。

### Load KV（D 侧）完整调用链

```text
D·Scheduler: get_num_new_matched_tokens(:1810, params.do_remote_prefill → (count, True))
          → update_state_after_alloc(:1848, 记录分配的本地块)
          → build_connector_meta → MooncakeConnectorMetadata.ReqMeta
D·Worker.start_load_kv (:3488-3591)
  ├─ _get_kv_split_metadata (:2740-3150)：hash(remote_req_id) 选 prefill TP ranks；逻辑块展开成
  │   kernel 块（_get_kernel_block_ids :2663）；CP 场景按 head_group/cp_group 算 port 映射
  └─ kv_recv_thread.add_request（每个 CP 分片/TP offset 一条）
D·KVCacheRecvingThread → ThreadPoolExecutor(32, 绑卡) → _handle_request (:698)
  ├─ 首次对端：ZMQ GET_META_MSG 拉 P 的元数据并缓存 (:1369-1403)
  ├─ session_id = f"{remote_host}:{remote_te_rpc_port}" (:786)
  ├─ 地址计算 (:927-962)：对每个 group_pull/layer：
  │     本地(D) = D层基址 + local_block_id*block_stride + remote_tp_offset*inner_block_len
  │     远端(P) = P层基址 + remote_block_id*remote_block_stride
  │     length = inner_block_len * 连续块数      ← GQA 时 inner_block_len=block_len/tp_num_need_pulls
  │   连续块合并(:3769) + 块内跨 cache 不连续再切(:3795) + Mamba conv/ssm 特例(:1107)
  ├─ ★ engine.batch_transfer_sync_read(session, src_list=本地D地址, dst_list=远端P地址, lens) (:986)
  │     —— READ：ADXL 引擎从 P 的 HBM 直拉进 D 的 HBM（跨机走 RDMA，本机走 LocalCopyEngine 捷径）
  ├─ 传输后 reformat (:1006-1076)：tp_num_need_pulls>1 时按 head 拉来的数据错位 →
  │     npu_gather_pa_kv_cache(:1283)+transpose+scatter(:1340)，或融合算子
  │     torch.ops._C_ascend.transpose_kv_cache_by_block(:1056/1215)，NZ 格式(:1349)
  └─ 收齐 → get_finished 上报 done_recving（调度器放行请求）
          + ZMQ DONE_RECVING_MSG 通知 P 释放块 (:1405-1439)
失败处理：异常 → _mark_failed_recv_request → invalid_block_ids → 调度器重算失败块（不致命）
```

---

## 3. 路径二：P2P 逐层推送（MooncakeLayerwiseConnector，P 侧推）

"逐层"的含义：**P 每算完一层的 KV 就立刻推给 D**，把传输藏进后续层的计算里（chunked prefill 下每个 step 推已算完的块）。组件：P 侧 `KVCacheSendingLayerThread`（:204，真发数据）+ D 侧 `KVCacheRecvingLayerThread`（:530，只收 DONE 信号，不搬数据）。

### 控制面与路径①最大的不同

D 侧 `update_state_after_alloc`（:930-1000）分配完块后，把 `{do_remote_decode:True, remote_block_ids, remote_host/port, remote_tp/pcp/dcp_size, remote_cached_tokens}` **httpx POST 到 `params["metaserver"]`**（`/v1/metaserver`，layerwise proxy 转给 P）。P 的 `request_finished` 恒返回 `(False, None)`——层推完即释放，无需延迟释放。

### Save（P 侧每层，与 forward 交织）

```text
每层 forward 结束：
connector.save_kv_layer (:779) → worker.save_kv_layer (:1693-1840)
  ├─ reshape_cache_event = attn_metadata[layer].reshape_cache_event（或新建 npu.Event）
  ├─ (pd_head_ratio≠1 或量化层) 在 resharding_stream 上：gather → head 重排/alltoall → c8/kv 量化
  │   （pd_head_ratio>1 时先 write 128B 预建链路防 alltoall OOM :1907-1916）
  └─ send_queue.put(SendTask)

KVCacheSendingLayerThread._transfer_kv_cache (:447-527)
  ├─ k/v 拷入 k_buffer/v_buffer（2MB 对齐中转 device buffer，register_kv_caches 时单独注册 :1244）
  ├─ 按 session 聚合；get_transfer_meta (:285-445)：
  │     src = P 本地层基址 + local_block_id*block_len（或重排后 buffer 基址）
  │     dst = D 远端基址 + remote_block_id*block_len (+head offset)
  ├─ 同步：pd_head_ratio==1 → wait_event.synchronize()（:490，注释：ADXL bug，
  │   CANN<8.5.RC1 偶发挂，故显式同步）；否则 resharding_stream.synchronize()
  └─ ★ engine.batch_transfer_sync_write(session_id, src, dst, length) (:497-499)
最后一层且 chunk_finish → ZMQ 发 DONE_SENDING_MSG/FAILED_SENDING_MSG 给 D (:1923-1977)
```

### Load（D 侧）

`start_load_kv` 只登记请求映射；`wait_for_layer_load` 为 **pass**（:1979）——D 不逐层等，数据早已在 P 的计算期间到位。完成判定：D 的 RecvingLayerThread 按 `trans_count` 收齐 DONE（:589-601）→ `get_finished` 报 done_recving；FAILED → 失败块重算。启用示例：`examples/epd_disaggregated/epd_disaggregated_guide.md:205-218`（extra_config `use_ascend_direct:true`）。

---

## 4. 路径三：共享 KV 池（AscendStoreConnector，Store 模式）

架构与 vLLM 主线 MooncakeStoreConnector 同源（后者即从此移植），但为 NPU 栈独立增强。组件与职责：

| 组件 | 文件 | 进程 | 职责 |
|---|---|---|---|
| `AscendStoreConnector` | ascend_store_connector.py:76 | 两侧 | 门面：按 role 分派钩子；`use_layerwise` 决定走层钩子还是整存钩子；`consumer_is_to_put` 控制 consumer 是否也写；PP 用 pool key 维度处理（handshake 钩子 pass） |
| `KVPoolScheduler` | pool_scheduler.py | scheduler | lookup 编排（ZMQ→worker）、LoadSpec、RequestTracker、`bind_gpu_block_pool`（延迟释放块） |
| `LookupKeyServer` | ascend_store_connector.py:293 | worker rank0 | ZMQ REP 线程：收 (token_len, group_ids, hbm_hit_tokens, 哈希) → `lookup_scheduler` |
| `KVPoolWorker` | pool_worker.py | worker | 地址记账与 TE 注册、start_load_kv、wait_for_save（npu.Event+join）、线程选择、lookup_scheduler、strided I/O |
| 收发线程 | kv_transfer.py | worker | 整体版 Sending/RecvingThread + layerwise Key 版 + GVA 版（memcache 专属） |
| `MooncakeBackend` | backend/mooncake_backend.py | worker | Backend 抽象的 mooncake 实现（mooncake/memcache/yuanrong 三选一）：setup/exists/put/get |
| `PoolKey`/数据结构 | config_data.py | 两侧 | 块哈希 ↔ store key 翻译（pp/tp/head_rank/group/cache_family 维度 + split_layers）；`prepare_value` 地址公式 |
| `Coordinator` | coordinator.py | worker | store_mask/load_mask（SWA/HMA 等按 spec 裁剪该存/该载的 chunk）、lcm_block_size |

### 4.1 MooncakeBackend（backend/mooncake_backend.py）

- **protocol 强制 "ascend"**，其他值直接 `NotImplementedError`（:66-67）；
- **复用 GlobalTE**：`store.setup(..., engine=transfer_engine.get_engine())`（:121-134）；
- API 封装：`exists→batch_is_exist`、`put→batch_put_from_multi_buffers(keys, addrs, sizes, ReplicateConfig{preferred_segment, prefer_alloc_in_same_node})`、`get→batch_get_into_multi_buffers`（:189-240）——**multi_buffers 变体**，地址就是 NPU KV tensor 的显存地址；
- 配置经 `MOONCAKE_CONFIG_PATH` 的 mooncake.json（metadata_server/master/global_segment_size 默认 1GiB…），支持 SSD offload（mooncake≥0.3.11，per-rank 目录隔离 ：110-117）。

### 4.2 两种数据通路：常规 vs fabric mem 统一编址

| | 常规（默认） | `ASCEND_ENABLE_USE_FABRIC_MEM=1`（仅 A3 800 I/T 系列） |
|---|---|---|
| local_seg 名 | `ip:te_rpc_port`，复用 GlobalTE | `ip`（不传 engine） |
| 贡献的池内存 | client 侧分配的注册内存（`ascend_allocate_memory`：ADXL MallocMem / aclrtMallocHost，见姊妹篇 §2.3/§5） | **KV 的 NPU 内存本身经 fabric 统一编址直接作为全局段**（:118-146 注释 "unified memory address direct transmission"） |
| local_buffer_size | 默认 1GiB（本地暂存） | 强制 0 |
| put/get 数据流 | NPU 源 → TE(ADXL) → 存储节点 | NPU ↔ 池内存统一编址直达（ADXL fabric mem 使能） |

### 4.3 Save KV（pool_worker，后台线程）

```text
每请求：torch.npu.Event().record() → 入队 → request_queue.join()（wait_for_save :1753-1771）
KVCacheStoreSendingThread._handle_stored_request (kv_transfer.py:717-892)
  ├─ store_mask 跳过已存/已命中的 chunk
  ├─ process_token_key_strings_with_block_ids 生成 key（block hash → PoolKey.to_string()，
  │   维度含 pcp/dcp/pp/head_rank/group/cache_family，config_data.py:95-172）
  ├─ lookup 去重（已存在的块跳过 :809-818）
  ├─ _prepare_value：addr = 层基址 + block_id*block_stride（NPU 显存地址）
  ├─ ★ current_event.synchronize()（:888，等 NPU 写完）
  └─ m_store.put(keys, addrs, sizes) → batch_put_from_multi_buffers（源=NPU 显存直读）
```

### 4.4 Load KV

```text
KVPoolScheduler.get_num_new_matched_tokens (pool_scheduler.py:521)
  ├─ LookupKeyClient（ZMQ IPC）→ worker 进程的 LookupKeyServer（仅 rank0 启动）
  │   → pool_worker.lookup_scheduler (:2339)：按 pp×tp 展开 key → m_store.exists
  │     → 连续命中位置；多 KV group 取最大公共命中 (:2430)
  ├─ layerwise Key 模式：所有层的 key 都存在才算命中 (:288-329)
  └─ 返回 (need_to_allocate, load_async) + LoadSpec
D·Worker：start_load_kv 同步路径（:871-1017）或 load_async 的 RecvingThread（kv_transfer.py:923）
  └─ m_store.get(key, addr, size) → batch_get_into_multi_buffers
        —— 目标地址=NPU 显存，直接落进 D 的 KV cache 块；失败块 → 重算
```

**Layerwise Key 变体**（`use_layerwise=True` 且 backend=mooncake）：key 用 `pool_key.split_layers(num_layers)[layer_id]` 拆成层粒度（kv_transfer.py:1108-1305），逐层 put/get + 每层独立 `sync_save_events[layer].synchronize()`——Store 模式也能做到层粒度流水。（GVA/batch_copy 变体是 memcache 后端专属，mooncake 未实现。）

**三个 backend 的关系**（backend_map，backend/__init__.py）：mooncake / memcache / yuanrong 是 `Backend` 抽象（backend.py:9）下的并列实现，上层完全无感知。**memcache 不是 memcached**——它包的是 `memcache_hybrid.DistributedObjectStore`，来自 gitee.com/ascend/memfabric_hybrid（与 SfaRemoteD2H 的 TransferEngine 同仓库），即昇腾 MemFabric 超节点生态。根本差异在内存模型：mooncake = 对象 + master 分配的远端段内 VA + TE/ADXL 点对点；memcache = **全局虚拟地址（GVA）**：`batch_alloc` 返回 GVA，`batch_copy` 按方向枚举（L2G/G2L/G2H/H2G）做 SDMA 直拷，配 lease（TTL 5min）。GVA 地址持久可反复写，这是 `use_gva_layerwise`（HBM 槽位复用 + prefetch_layer_map）只在 memcache 实现的原因；mooncake 的 layerwise 只能走 Key 路径。yuanrong 包 openYuanrong datasystem 的 HeteroClient（可选 HIXL 做远端 H2D 后端）。

### 4.5 地址生命周期：分配、传递、传输（本路径最核心的机制）

**四种地址**：① NPU HBM 基址（vLLM KV tensor `data_ptr`，每 group 每 cache 一个）；② 段绝对 VA（存储节点贡献内存的起始地址）；③ 副本描述符 `{buffer_address=②段内绝对VA, transport_endpoint}`（master 分配）；④ ADXL 引擎名 `ip:port`（存储节点寻址身份，发布在元数据）。

**启动期**：(a) `register_kv_caches` 记账 `base/block_len/block_stride`，storage 合并 + 2MB 对齐 + HCCL 256 上限后经 `global_te.register_buffer` 注册进 TE（MEM_DEVICE）；(b) 存储节点 MountSegment 两步：先 `registerLocalMemory`（段内存来自 `ascend_allocate_memory`：fabric→VMM/ADXL MallocMem，否则 `aclrtMallocHost`，登记 `g_store_mem_ranges`）再上报 master——**master 的 Offset 分配器对该 VA 区间做纯地址运算（镜像分配），分出的地址天然是存储节点的合法 VA**。

**运行期公式**（config_data.py `prepare_value`）：`addr = cache_base + block_id × block_stride`，`size = block_len × (end-start)/block_size`（部分块按比例）；一个 key 可含多片段（k/v、层粒度）→ 对应 `batch_put_from_multi_buffers(keys, list[list[addr]], list[list[size]])` 的 per-key 多地址语义（store_py.cpp:2486）。

**三次交接**：①key+源地址随 BatchPutStart 走 coro_rpc（源地址不进 master，留在本地）；②descriptor 经 coro_rpc 返回；③客户端 `openSegment(endpoint)` 解析 SegmentDesc，构造 `TransferRequest{source=NPU VA, target_offset=buffer_address+offset}`（transfer_task.cpp:678-716）——**注意 target_offset 实为远端绝对 VA**（远端按 buffers[].addr≤offset<len 定位注册区间），"段内偏移"是误导性命名。传输：AscendDirectTransport `TransferOpDesc{local_addr=①, remote_addr=③}`，本机段命中走 LocalCopyEngine 的 aclrtMemcpy 捷径（`isLocalTransfer`，transfer_task.cpp:785）。get 对称：同一公式算**目的**地址，opcode=READ。fabric mem 模式下①③统一编址，"地址传递"被硬件消掉。TP mismatch 时另有 strided I/O 重算 stride（pool_worker.py:1945-2076）。

---

## 5. 进入 mooncake 内核后的路径（昇腾）

上层最终都收敛到两个 mooncake 入口：**TE 直连**（路径①②）与 **Store**（路径③）。

### 5.1 TE 路径：protocol="ascend" → AscendDirectTransport

```text
engine.batch_transfer_sync_read/write(session, 本地地址, 远端地址, lens)   Python
└─ TransferEnginePy::transferSync → submitTransfer（姊妹篇主文档 §3.6 骨架不变）
    └─ MultiTransport: 目标段 protocol=="ascend" → AscendDirectTransport
        ├─ submitTransferTask (ascend_direct_transport.cpp:215)
        │   ├─ ResolveCurrentEngineId：PP/多卡时按 aclrtGetDevice 定引擎
        │   └─ dispatcher_->enqueue(slice_list)（8 线程池或每引擎专线程）
        ├─ TransferExecutorBase::processSliceList (:516)
        │   ├─ resolveTargetAdxlEngineName：从元数据取对端引擎名（ip:port）
        │   ├─ 【本机捷径】同引擎 → LocalCopyEngine（aclrtMemcpy/Batch，H2D/D2H/D2D 分派）
        │   └─ checkAndConnect → adxl::AdxlEngine::Connect(远端引擎名)（首次懒建链）
        └─ Sync: AdxlEngine::TransferSync / Async: TransferAsync + 10us 查询线程
              —— 底层由 ADXL（libllm_datadist）走 RoCE/HCSS，细节封装在 CANN 库内
```

要点（详见姊妹篇 §2）：每卡一个 ACL context + 一个 ADXL 引擎，"先切 context 再动硬件"；引擎名即元数据里发布的全部寻址信息；传输级重试 2 次 + 强刷元数据；源/目的都是 NPU HBM 地址（注册时 location `"npu:<id>"` → `MEM_DEVICE`）。

### 5.2 Store 路径：master 控制面 + TE 数据面

```text
batch_put_from_multi_buffers(keys, NPU地址s, sizes)          store_py.cpp
└─ RealClient::batch_put → Client::BatchPut (client_service.cpp:1991)
    ├─ [控制面] BatchPutStart → master AllocateAndInsertMetadata
    │    └─ 策略分配副本（异 segment、best-effort）→ {buffer_address, transport_endpoint}
    ├─ [数据面] TransferSubmitter::submit → TRANSFER_ENGINE：
    │    engine.openSegment(endpoint) + TransferRequest{WRITE, source=NPU地址, ...}
    │    → 协议为 ascend → 同 §5.1；本地命中则 LOCAL_MEMCPY 降级（transfer_task.cpp:785）
    │    （池内存由 ascend_allocate_memory 分配：fabric mem 开→VMM/ADXL MallocMem，
    │      关→aclrtMallocHost pinned host，登记进 g_store_mem_ranges 供全引擎注册）
    └─ [控制面] BatchPutEnd（mark_complete + 租约；淘汰/SSD offload 由 master 心跳调度）

batch_get_into_multi_buffers 对称：BatchGetReplicaList（+5s 读租约）→ TE READ → 校验租约
```

---

## 6. 四路径横向对比

| 维度 | ①P2P 整体拉取 | ②P2P 逐层推送 | ③Store 共享池 | ④SFA RD2H（非 mooncake） |
|---|---|---|---|---|
| 传输驱动 | D 拉（READ） | P 推（WRITE，逐层） | 各实例独立 put/get | D 拉（memfabric） |
| 控制面 | ZMQ（P 服务元数据） | HTTP metaserver（proxy） | mooncake master | memfabric store |
| KV 复用 | 单请求 P→D 一次 | 单请求 P→D 一次 | **跨请求/跨实例按块哈希** | decode offload（CPU 池） |
| 与计算重叠 | 调度步之间（async load） | **逐层重叠**（最优） | 后台线程 + npu.Event | 层事件门控 |
| 额外部署 | P2P proxy | **专用 layerwise proxy** | master（+metadata） | memfabric 环境 |
| 传输后处理 | GQA head 重排/NZ/融合转置 | 重排+量化（旁路流） | TP mismatch strided I/O | — |
| 典型场景 | 通用 PD 分离、CP/PP 复杂并行 | EPD、追求 TTFT 极致 | 长多轮会话、前缀复用 | A3 超节点 SFA 模型 |

## 7. GPU 栈差异对照（仅供迁移参考）

| 维度 | GPU 栈（vLLM 主线） | 昇腾栈（本文） |
|---|---|---|
| 协议 | `"rdma"`（ibverbs + GPUDirect/dmabuf MR） | `"ascend"`（ADXL 引擎） |
| P2P 方向 | P 推（`batch_transfer_sync_write`） | **D 拉**（`batch_transfer_sync_read`） |
| TE 生命周期 | connector 内初始化 | 进程级 GlobalTE 单例，P2P/Store 共享 |
| 内存注册 | 按层 tensor 直接注册 | storage 合并 + HCCL 256 区域上限 + 2MB 对齐 |
| 传输后处理 | 无 | GQA head 重排（gather/scatter/融合转置）、NZ 格式 |
| Store 后端 | MooncakeStoreConnector（内置） | AscendStoreConnector（多 backend 抽象 + fabric mem + layerwise Key） |
| 同步原语 | CUDA event | torch.npu.Event / npu.Stream + ADXL bug 规避显式同步 |

## 8. SGLang on Ascend 的说明

SGLang HiCache 的调用流程（L1 GPU→L2 host→L3 mooncake，write-through/back、page_first 布局，见上一版 §3 描述，语义不变）在昇腾栈上同样经 `MooncakeDistributedStore` 的 put/get 落到 §5.2 的 store 路径。两点差异需要注意：① 协议需配 `"ascend"`（store 的 python setup 同样支持）；② HiCache 的 L2 是 **host 内存**页（注册为 MEM_HOST），池内存走 `ascend_allocate_memory` 的 host pinned 分支——NPU↔池的传输由 ADXL 的 H2D/D2H 能力承担（fabric mem 模式则统一编址直达）。SGLang-Ascend 侧的具体集成代码不在本地，此节为按 store API 语义的推演，落地时建议对照 sglang-ascend 仓库核实。

---

> **一句话总结**：昇腾栈上，vLLM-Ascend 的三条 mooncake 路径（P2P 整体拉 / P2P 逐层推 / Store 共享池）全部收敛到 `protocol="ascend"` 的 AscendDirectTransport——每卡一个 ADXL 引擎、NPU HBM 地址直接注册直传、本机走 LocalCopyEngine 捷径、A3 上可开 fabric mem 统一编址；上层各连接器的差异只在于**谁驱动传输（D 拉/P 推）、什么粒度（请求级/层粒度/块哈希对象）、控制面走哪（ZMQ/metaserver/master）**。
