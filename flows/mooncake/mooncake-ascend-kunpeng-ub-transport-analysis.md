---
title: Mooncake 华为系 Transport 深度解析：昇腾与鲲鹏 UB/URMA
author: MadaoRui
direction: 传输与硬件后端
date: 2026-09-01
tags: [Mooncake, 传输引擎, 昇腾, 鲲鹏, URMA]
summary: 深读 transfer-engine 里除 RDMA 之外的国产硬件后端：昇腾四路（ascend_direct / hccl / heterogeneous_rdma / ubshmem）加鲲鹏 UB/URMA，逐条给编译开关与代码锚点，推测处明确标注。
---
# Mooncake 华为系 Transport 深度解析：昇腾（Ascend）与鲲鹏 UB/URMA

> **代码仓库**：`kvcache-ai/Mooncake`（HEAD = `f2853a8`）
> **本文范围**：`mooncake-transfer-engine` 中除 RDMA 之外的国产硬件后端——昇腾四个后端（ascend_direct / hccl / heterogeneous_rdma / ubshmem）+ 鲲鹏 UB/URMA（ub transport），barex 简述。所有结论出自代码，标注 `文件:行号`；推测处明确标注。
> **姊妹篇**：`mooncake-module-analysis.md`（模块总览）、`mooncake-load-save-kv-flows.md`（vLLM-Ascend 各连接器的 load/save 全流程——上层经 `GlobalTE` 以 `protocol="ascend"` 进入本文的 AscendDirectTransport；`AscendStoreConnector` 的 fabric mem 直传即本文 §2/§5 的 `ASCEND_ENABLE_USE_FABRIC_MEM` 路径）。

---

## 目录

- [0. 全景：六个后端、五套编译开关](#0-全景六个后端五套编译开关)
- [1. 核心概念速查表（RDMA 概念映射）](#1-核心概念速查表rdma-概念映射)
- [2. ascend_direct：ADXL 引擎直连（昇腾主力）](#2-ascend_directadxl-引擎直连昇腾主力)
- [3. hccl：借 HCCL 内部库搭 RMA 通道](#3-hccl借-hccl-内部库搭-rma-通道)
- [4. heterogeneous_rdma：NPU↔GPU 异构中转](#4-heterogeneous_rdmanpugpu-异构中转)
- [5. ubshmem：共享内存式 NPU 直连](#5-ubshmem共享内存式-npu-直连)
- [6. UbTransport：鲲鹏 UB/URMA](#6-ubtransport鲲鹏-uburma)
- [7. barex：一句话](#7-barex一句话)
- [8. 五后端横向对比](#8-五后端横向对比)
- [9. 设计理念：国产化后端的接入模式](#9-设计理念国产化后端的接入模式)
- [10. 已知工程毛边与注意事项](#10-已知工程毛边与注意事项)
- [11. 测试与示例索引](#11-测试与示例索引)

---

## 0. 全景：六个后端、五套编译开关

华为系后端不是"一个 Transport"，而是**按硬件能力拆成的五个互斥/并存的实现**。编译开关定义在 `mooncake-common/common.cmake:70-82`（option 注释本身就是定位说明）：

| 编译开关 | 官方注释（common.cmake） | 类 | `getName()` | MultiTransport 注册 key | 装配点 |
|---|---|---|---|---|---|
| `USE_ASCEND_DIRECT` | "using ascend npu with adxl engine" | `AscendDirectTransport` | `"ascend_direct"` | **`"ascend"`** | multi_transport.cpp:299 |
| `USE_ASCEND` | "using npu with HCCL" | `HcclTransport` | `"hccl"` | **`"ascend"`** | multi_transport.cpp:304 |
| `USE_ASCEND_HETEROGENEOUS` | "transferring between ascend npu and gpu" | `HeterogeneousRdmaTransport` | `"ascend"` | **`"ascend"`** | multi_transport.cpp:309 |
| `USE_UBSHMEM` | "using ascend npu with shmem" | `UBShmemTransport` | `"ubshmem"` | `"ubshmem"` | multi_transport.cpp:336 |
| `USE_UB` | （鲲鹏 UB/URMA） | `UbTransport` | `"ub"` | `"ub"` | multi_transport.cpp:279 |

三个 `USE_ASCEND*` 分支都响应 `proto == "ascend"`，但由 `#ifdef` 互斥——**同一二进制只会编进一个昇腾网络后端**（`src/transport/ascend_transport/CMakeLists.txt:1-10` 的 if/elseif 链同样保证）。注意两个易混点：

1. `AscendDirectTransport::getName()` 返回 `"ascend_direct"`，但它写进 `SegmentDesc.protocol` 的是 **`"ascend"`**（ascend_direct_transport.cpp:149）——对外元数据协议名统一为 "ascend"，MultiTransport 也以 "ascend" 为 key（multi_transport.cpp:390）。
2. **ubshmem ≠ UB**。`ubshmem_transport` 属于昇腾目录（`ascend_transport/`），是 NPU 共享内存传输，名字里的 "ub" 指 NPU 侧统一内存/fabric；鲲鹏的 UB/URMA 在 `kunpeng_transport/` 下，用 jetty/tseg 那套。两者无共享代码。

heterogeneous 模式还有一条特殊路由：目标 segment 的 `protocol=="rdma"` 时，发起端强制改选 `"ascend"` 后端（multi_transport.cpp:402-409，注释："Target side directly reuses RDMA Transport / Initiator side uses heterogeneous_rdma_transport"）——即**对端照常跑标准 RdmaTransport，只有 NPU 侧换后端**。

另外 `local_server_name` 的 `:npu_X` 后缀（transfer_engine_impl.cpp:100-112）只在 **HCCL 后端**路径需要（X = 物理卡号，经 `parseHostNameWithPortAscend` 解析，common.h:289-310）；元数据里存的 segment 名仍是 `ip:port`。

**Slice 协议私有字段**（`transport.h:117-162` 匿名 union，已逐行核实）：

```cpp
struct { uint64_t dest_addr; void *handle;        // adxl::TransferReq
         int64_t start_time; int32_t engine_id; } ascend_direct;   // :154-159
struct { uint64_t dest_addr; } hccl;                                // :151-153
struct { uint64_t dest_addr; } ubshmem;                             // :160-162
struct { uint64_t dest_addr; volatile int *jetty_depth;
         uint32_t retry_cnt, max_retry_cnt;
         void *r_seg; void *l_seg; } ub;                            // :128-135
```

---

## 1. 核心概念速查表（RDMA 概念映射）

**昇腾侧**（均有代码出处）：

| 术语 | 含义 | 代码体现 | RDMA 对应物 |
|---|---|---|---|
| ACL | Ascend Computing Language，`aclrt*` 系运行时 API | `aclrtMemcpy/aclrtSetDevice/aclrtMallocPhysical…` 遍布各后端 | CUDA Runtime |
| ADXL | 华为 CANN 的高性能数据搬运库（宿主 `libllm_datadist.so`，链接见 CMakeLists:35-37）；异步模式对外称 HIXL（文档 docs/.../ascend_direct_transport.md:61） | `adxl::AdxlEngine`（adxl_compat.h:32，mooncake 头文件内重新声明的 pimpl 类） | verbs + 自带连接管理 |
| 引擎（Engine） | 一个 AdxlEngine 实例 = `ip:port` 全局名，**每张卡一个** | `rank_info.endpoints[]`（SegmentDesc） | QP/endpoint 体系 |
| context 亲和 | ACL 的 context 绑定单卡，跨卡操作必须 `aclrtSetCurrentContext` | 代码处处先切 context + ScopeGuard 恢复（utils.h:49-76） | CUDA stream/context 亲和 |
| HCCS | 昇腾卡间高速互连域（A2 系列 8 卡一组） | hccl 后端 cross-HCCS 判定 `phy/8 == 对端phy/8`（hccl_transport_mem_c.cpp:546-552） | NVLink domain |
| fabric mem | CANN 可跨进程/跨节点共享的物理内存（VMM 三步分配） | `aclrtMallocPhysical + ReserveMemAddress + MapMem`，1G 大页 + HOST_NUMA（ascend_allocator.cpp:22-90） | GPUDirect + dmabuf MR |
| dummy-real | mooncake-store 的多进程架构：每卡一个 dummy 进程 + 一个 real 代理进程 | `globalConfig().ascend_agent_mode`（dummy_client.cpp:443 / real_client_main.cpp:101 置 true） | — |

**鲲鹏 UB 侧**：

| 术语 | 含义 | 代码体现 | RDMA 对应物 |
|---|---|---|---|
| UB | Unified Bus，鲲鹏原生互连协议，设备在 `/sys/class/ubcore/` | topology.cpp:237；协议名 "ub" | InfiniBand/RoCE 整体 |
| URMA | Unified Remote Memory Access，UB 的用户态统一 API（openEuler umdk 库，`liburma.so`，FindUrma.cmake 从 atomgit 拉 v25.12.0 头文件） | `urma_*` 前缀函数 | libibverbs |
| jetty | "码头"，收发工作队列载体，一条 ≈ 一条可靠连接 | `urma_create_jetty`（urma_endpoint.cpp:633）；`jetty_num` 走握手 | QP（jetty_id ≈ QPN） |
| tjetty | 对端 jetty 的本地导入句柄 | `urma_import_jetty` + `urma_bind_jetty`（:971-972） | QP RTR/RTS 状态机（URMA 一步 bind，无状态机） |
| tseg | 注册内存段；`urma_seg_t` 是可序列化描述符（含 ubva{eid,uasid,va}+token_id），`urma_target_seg_t` 是本地句柄 | `BufferDesc.tseg[]` 存 hex 序列化串（ub_context.h:271-286） | MR；tseg 串 ≈ (rkey+地址) 打包 |
| JFC / JFCE / JFR | 完成队列 / 完成事件通道 / 接收队列（单边语义下 JFR 闲置，注释明言 "one-side write/read, jfr no used"） | `jfc_list_/jfce_/jfr_list_`（urma_endpoint.cpp:77-146） | CQ / comp channel / SRQ |
| EID | 16 字节全局设备标识（格式 `01:02:...:10`） | `DeviceDesc.eid`（transfer_metadata.h:49） | GID |
| ubva / uasid | 段寻址三元组 {eid, uasid, va} / 用户地址空间 ID | mock_urma.cpp:244-248 | (GID, PD, rkey, va) |

> UBDI / UBEP / TPF 三个词在 mooncake 源码中**从未出现**（grep 验证）；urma_api.h 本体是构建期拉取的外部头文件。上表未收录，需要时去 umdk/ubcore 上游查。

---

## 2. ascend_direct：ADXL 引擎直连（昇腾主力）

### 2.1 类图

```text
Transport
└─ AscendDirectTransport (ascend_direct_transport.h:34)
    ├─ local_engine_contexts_: vector<aclrtContext>   ← 每卡一个 ACL context
    ├─ transfer_executor_: unique_ptr<TransferExecutorBase>
    └─ dispatcher_: unique_ptr<ISliceDispatcher>

ISliceDispatcher (slice_dispatcher.h:40)
    ├─ DefaultSliceDispatcher        共享线程池(默认8线程) 按 target_id 分组
    └─ RoceDummyRealSliceDispatcher  每引擎一个专线程+专队列（16卡代理场景）

TransferExecutorBase (transfer_executor_base.h:42, 抽象)
    ├─ adxl_engines_: vector<shared_ptr<adxl::AdxlEngine>>   ← 每卡一个
    ├─ local_copy_engine_ / addr_to_mem_handles_ / connected_segments_
    ├─ SyncTransferExecutor   → adxl::TransferSync（同步语义）
    └─ AsyncTransferExecutor  → adxl::TransferAsync + 专用查询线程

adxl::AdxlEngine  ← CANN 库里的类，mooncake 头文件重新声明（pimpl + weak 符号兼容旧版）
LocalCopyEngine   ← ACL stream + memcpy（本机捷径）
ContextManager    ← 单例，多卡 context + logic↔physical 卡号映射（context_manager.h:35）
```

**adxl_compat.h 的两个巧思**：`TransferAsync/GetTransferStatus/MallocMem` 等标了 `__attribute__((weak))`（adxl_compat.h:117-146）——旧版 CANN 没有这些符号时运行期判空降级，也让单测能用**强符号直接覆盖 AdxlEngine 全部方法做 mock**（ascend_direct_transport_test.cpp:453-581 的整套无真机测试就是靠这个）。

### 2.2 install 与端口分配

`install`（ascend_direct_transport.cpp:80-128）核心动作：

1. `SegmentDesc.protocol = "ascend"`（:149）；`dummy_real_mode_ = globalConfig().ascend_agent_mode`。
2. **引擎数 = 卡数**：非 dummy-real 模式只注册当前 ACL 环境的 1 张卡（:200-209，调用前必须 `aclrtSetDevice`，官方文档 Important Notes #1）；dummy-real 模式经 `ContextManager` 注册所有卡（:180-199）。
3. 每引擎的监听端口：`FindAdxlListenPort(base_port=20000, device_id)`（utils.cpp:75-126）——**按物理卡号分段，第 i 张卡用 `[base+i*100, base+(i+1)*100)` 区间内随机端口**（bind 探测，最多 500 次）。物理卡号来自 `aclrtGetPhyDevIdByLogicDevId`。引擎名 `ip:port` 追加进 `desc->rank_info.endpoints`——**这就是元数据里对外发布的全部寻址信息**。
4. 环境变量：`HCCL_INTRA_ROCE_ENABLE=1` → roce_mode_；`ASCEND_BASE_PORT`（默认 20000；注意官方文档表格写 11000，与代码不符，以代码为准）。
5. executor 选择：`ASCEND_USE_ASYNC_TRANSFER` → Async，否则 Sync；`ASCEND_BUFFER_POOL="NUM:SIZE_MB"` 中间缓冲模式（与 async 互斥）。

`TransferExecutorBase::initEngines`（transfer_executor_base.cpp:111-231）：组装 ADXL options（`adxl.RdmaTrafficClass/ServiceLevel` ← `ASCEND_RDMA_TC/SL` 回退 `HCCL_RDMA_TC/SL`、`AutoConnect`、`EnableUseFabricMem` 等），逐引擎 `aclrtSetCurrentContext` 后 `new AdxlEngine + Initialize(name, options)`——**"先切 context 再动硬件"是全部昇腾代码的第一守则**。

### 2.3 内存注册

`registerLocalMemory`（ascend_direct_transport.cpp:310-371）：按 `location` 前缀判 `MEM_HOST/MEM_DEVICE`（通配时 `aclrtPointerGetAttributes` 探测）；先写元数据再 `registerMem`，失败回滚。

`TransferExecutorBase::registerMem`（:381-460）的引擎选择策略是理解多卡行为的关键：

- `roce_mode && dummy_real && 是 store 内存`（来自 `ascend_allocate_memory` 的区间，ascend_allocator.cpp:181-194）→ 注册到**所有**引擎（任意卡都要能访问存储池）；
- 单引擎进程 → 注册到它；
- 否则 → 只注册**当前卡**对应的引擎。

任一引擎 `AdxlEngine::RegisterMem` 失败 → 全部回滚。**handle 只在本地持有，不进元数据**（与 RDMA 的 rkey 发布形成对比）。

### 2.4 submit 调用链（到硬件 API）

```text
submitTransferTask (ascend_direct_transport.cpp:215-280)
 ├─ ResolveCurrentEngineId: dummy-real 用 aclrtGetDevice 取当前卡，否则 0 (:38-48)
 ├─ InitializeSlice: 填 slice->ascend_direct.{dest_addr, engine_id} (:50-62)
 └─ dispatcher_->enqueue(slice_list)

DefaultSliceDispatcher::enqueue (slice_dispatcher.cpp:64-98)        [共享线程池]
 └─ worker: aclrtSetCurrentContext(local_engine_contexts_[engine_id])
     └─ TransferExecutorBase::processSliceList (:516-601)
         ├─ 重试循环 kTransferRetryTimes=2 (:548)
         ├─ resolveTargetAdxlEngineName: dummy-real+roce → endpoints[engine_idx]（卡对卡）
         │                                    否则 → endpoints.front() (:500-514)
         ├─ 【本机捷径】!fabric_mem && 目标引擎==本引擎
         │     → LocalCopyEngine::Copy; return (:567-578)
         ├─ execute(...) → Sync 或 Async 执行器
         └─ 失败且可重试 → 强制刷新对端 segment 元数据再来一轮 (:582-587)

SyncTransferExecutor::execute (sync_transfer_executor.cpp:46-92)
 ├─ checkAndConnect: 首次懒建链 adxl::AdxlEngine::Connect(remote_engine_name)
 ├─ 组装 vector<adxl::TransferOpDesc>{local_addr, remote_addr, len}
 ├─ adxl::AdxlEngine::TransferSync(...)                       ← 硬件 API 终点
 └─ 成功 markSuccess；失败 disconnect + retryable=true

AsyncTransferExecutor::execute (async_transfer_executor.cpp:69-143)
 ├─ checkAndConnect；slice->ascend_direct.start_time 记时
 ├─ 流控：active_async_tasks_ 上限 100（kAsyncTaskLimit），cv 等待 (:90-99)
 ├─ adxl::AdxlEngine::TransferAsync(..., req_handle) (:112-115)
 │    handle 存 slice->ascend_direct.handle；入 query_slice_queue_ 唤醒查询线程
 └─ 查询线程 queryThreadLoop (:145-168) 10us 轮询：
      aclrtSetCurrentContext → adxl::AdxlEngine::GetTransferStatus(handle)
      COMPLETED → markSuccess；FAILED/超时 → markFailed + 断链 (:186-285)
```

**LocalCopyEngine**（local_copy_engine.cpp:60-127）按内存类型分派：H2H → `aclrtMemcpy`；D2D → 自有 stream `aclrtMemcpyAsync` + `aclrtSynchronizeStreamWithTimeout`（失败 `aclrtStreamAbort`）；H2D/D2H → `aclrtMemcpyBatch`（批量上限 4096，显式给 device/host 的 `aclrtMemLocation`；不支持时回退 async 路径）。WRITE/READ 语义与 H2D/D2H 方向要做换向组合（GetMemcpyKind, :129-148）。stream 一律带 `ACL_STREAM_FAST_LAUNCH|FAST_SYNC` 创建。**开启 fabric mem 后本机捷径被禁用**（远端 host 内存可直接被 ADXL 网络栈寻址，无需拷贝绕行）。

### 2.5 dummy-real（agent）模式为何存在

mooncake-store 在昇腾上的部署形态：**每张卡一个 dummy 推理进程 + 同机一个 real 存储代理进程**。这决定了 ascend_direct 的三处特化：

1. `ContextManager`（context_manager.cpp:43-131）：real 进程要为**所有卡**建 context，维护 logic↔physical 卡号双向映射（dummy 的 RPC 带物理卡号来，`setCurrentContextByPhysicalId` 切到对应 context）。
2. `RoceDummyRealSliceDispatcher`（slice_dispatcher.cpp:106-207）：每引擎一个专属线程 + 专队列，避免单线程成为 16 卡代理的收发瓶颈（测试 `Install_DummyRealRocePublishes16Endpoints` 验证 16 endpoint 发布）。
3. store 内存注册到所有引擎（§2.3）。

### 2.6 环境变量速查（ascend_direct）

`ASCEND_CONNECT_TIMEOUT`(10s)、`ASCEND_TRANSFER_TIMEOUT`(10s)、`ASCEND_USE_ASYNC_TRANSFER`、`ASCEND_USE_SHORT_CONNECTION`、`ASCEND_AUTO_CONNECT`、`ASCEND_BUFFER_POOL`("NUM:SIZE_MB"，非"0:0"启用)、`ASCEND_BASE_PORT`(20000)、`ASCEND_THREAD_POOL_SIZE`(8/上限16)、`HCCL_INTRA_ROCE_ENABLE`、`ASCEND_RDMA_TC/SL`（回退 `HCCL_RDMA_TC/SL`）、`ASCEND_LOCAL_COMM_RES`、`ASCEND_GLOBAL_RESOURCE_CONFIG`；store 层另有 `ASCEND_ENABLE_USE_FABRIC_MEM`。注意昇腾变量前缀是 `ASCEND_*`/`HCCL_*` 混用，**没有 `MC_ASCEND_*`**。

---

## 3. hccl：借 HCCL 内部库搭 RMA 通道

**最"借力"的实现**：不用 HcclSend/HcclRecv 集合通信，而是直接链接 libhccl 的**内部点对点组件**（`hccl_socket.h/transport_mem.h/notify_pool.h/dispatcher.h/p2p_mgmt_pub.h` 等 HCCL 私有头，hccl_transport_mem_c.h:19-42）搭一套 one-sided RMA。代价：必须 `-D_GLIBCXX_USE_CXX11_ABI=0 -std=c++11` 匹配 HCCL ABI（ascend_transport_c/CMakeLists.txt）+ 读 `/etc/hccn.conf`。

### 3.1 rank 映射与初始化

`install`（hccl_transport.cpp:399-456）→ `rankInfoParse`（:318-397）：

- `/etc/hccn.conf` 里 `address_<devicePhyId>=<deviceIp>` 拿该卡网卡 IP；
- **rankId = 物理卡号**；`hostPort = 10000 + devicePhyId`（自建 TCP 控制通道）；`devicePort = 16666`（数据面）；
- `initTransportMem`（mem_c:266-310）：物理网卡 ctx + HCCS 内 vnic ctx 各一套 `HcclSocket` 监听 + `HcclDispatcherInit` + `NotifyPool::Init`；
- rank 信息**全量写进 `SegmentDesc.rank_info`**（allocateLocalSegmentID, :588-605）——对端信息全靠元数据交换，无需 etcd 之外的通道；
- 起一对线程：`initiatorLoop`（发送）+ `acceptLoop`（接收）（:249-271）。

### 3.2 建链与数据面

懒建链，首次传输触发 `transportMemTask`（mem_c:789-841）：

```text
transportMemTask(key = hostIp+devicePhyId)
 ├─ controlInfoSend: TCP 连对端 hostPort，发 RankControlInfo{deviceLogicId/PhyId/hostIp/deviceIp/pid}
 ├─ createTransportMem (mem_c:543-741):
 │   ├─ cross-HCCS 判定: 同主机 && 本卡phy/8 == 对端phy/8 → 不跨 HCCS
 │   │     不跨 → EnableP2P + vnic IP，TransportMem::TpType::IPC   ← 卡间直连
 │   │     跨   → 物理网卡 + 对端 deviceIp，TpType::ROCE           ← 跨机 RoCE
 │   ├─ 建 ctrl/data 两条 hccl::HcclSocket → TransportMem::Create → Connect
 │   ├─ 对每段注册内存: HcclMemReg + HcclMemExport；不跨 HCCS 还要 HcclMemGrant 授权对端 pid
 │   └─ ExchangeMemDesc（一次建链交换所有 MR）→ 逐个 EnableMemAccess
 └─ transport_mem->Write/Read(remoteMem, localMem, stream)   ← RMA 写进 aclrtStream，异步执行
```

发送线程 `initiatorLoop`（hccl_transport.cpp:62-233）：逐 slice 下发 → `AddOpFence(stream)` 给本批加栅栏 → `aclrtSynchronizeStreamWithTimeout`（默认 20s）→ 失败 `aclrtStreamAbort` + 断链重试（默认 2 次，`ASCEND_TRANSPORT_TRANSFER_MAX_RETRY_COUNT`）；成功直接 `markSuccess`。`registerLocalMemory` 只是登记区间（`g_localMergeMem`），真正的 `HcclMemReg` 发生在建链时——**注册与建链的时序解耦**。

---

## 4. heterogeneous_rdma：NPU↔GPU 异构中转

场景：NPU 节点与 GPU/CPU 节点互传（编译注释 "transferring between ascend npu and gpu"）。**组合而非继承**：内部持 `unique_ptr<RdmaTransport>`（heterogeneous_rdma_transport.h:36），所有 RDMA 细节全委托；对端就是标准 RdmaTransport（multi_transport.cpp:402-409 路由）。

核心问题：NPU HBM 不能被 host 侧 ibverbs 直接注册 MR。解法是 **staging（两级中转）**（install, cpp:102-163）：

- `host_addr_`：`aligned_alloc` 的 **3GB host 环形中转区**（注册成普通 MR）；
- `dev_addr_`：4 × 8MB 的 NPU 侧聚合块（`aclrtMalloc`），块队列管理；
- 后台 `transferLoop` 线程做块 → host 环的搬运。

提交路径按大小分流（submitTransferTask, cpp:414-447）：

```text
CPU 源内存 → 直接透传给 RdmaTransport（不中转）
NPU 源 && length ≥ 2MB → noAggTransport (:304-346):
    逐任务 D2H aclrtMemcpyAsync 到 host 环
    【关键】就地改写 request->source 为 host 地址 (:331)
    → transport_->submitTransferTask(...)        ← 走标准 RDMA
NPU 源 && 小包 → aggTransport (:348-412):
    D2D 聚拢到 8MB block → 后台线程 D2H 到 host 环 → 改写 source → RDMA
    （提交返回前自旋等所有 block 归还 = 小包路径提交即同步离开 NPU）
```

`request->source` 改写就是 `TransferTask::request` 在 `USE_ASCEND_HETEROGENEOUS` 下被 const_cast 成可写指针的原因（multi_transport.cpp:123-128 + transport.h:299-305 注释原文："need to modify the request's source address, changing it from an NPU address to a CPU address"）——**整个 Transport 抽象里唯一为单个后端开的口子**。

---

## 5. ubshmem：共享内存式 NPU 直连

思路：**没有连接、没有协议栈**——把 NPU 内存做成可跨进程导入的共享内存，远端地址映射进本进程后直接 `aclrtMemcpyAsync`。

- 两种可共享内存（`supportFabricMem()`, ubshmem_transport.cpp:161-177，默认 fabric，`MC_USE_UBSHMEM_IPC=1` 强制 IPC）：
  1. **fabric memory（默认）**：CANN VMM 三步（`aclrtMallocPhysical(ACL_HBM_MEM_HUGE@DEVICE 或 ACL_DDR_MEM_P2P_HUGE@HOST_NUMA)` + `ReserveMemAddress` + `MapMem`），`aclrtMemExportToShareableHandleV2` 导出 handle（:594-637）——A3 超节点 Scale-Up 域直接寻址的内存【推测，代码未展开定义】；
  2. **IPC mode**：`aclrtIpcMemGetExportKey` 导出 65 字节 key，对端 `aclrtIpcMemImportByKey` 导入（:59-80）。
- 元数据：handle/key 序列化进 **`BufferDesc.shm_name`**（复用 nvlink/hip 的字段，:599-637）。
- "建链" = 首次访问时 `relocateSharedMemoryAddress`（:645-717）：在对端 SegmentDesc.buffers 里找覆盖 dest 区间的 buffer → 双检缓存 `remap_entries_` → 导入 handle 得本进程映射地址 → `dest_addr = dest - buffer.addr + shm_addr` 换算。
- 数据面（submitSlices, :336-470）：线程池（默认 8）+ `StreamPool`（每传输借 4 条 stream，总量上限 32，`MC_UBSHMEM_MAX_STREAMS`）round-robin `aclrtMemcpyAsync` → 逐 stream `aclrtSynchronizeStream` → `markSuccess`。
- 配套 `ubshmem-allocator/ubshmem_fabric_allocator.cpp`（`mc_probe_ub_fabric_support`/`mc_ub_fabric_malloc`）供 Python wheel 探测/分配；mooncake-store 侧 `ascend_allocator.cpp` 的 `allocatePinnedLocalMemory` 同源。

形态上它就是 nvlink_transport 的昇腾镜像（导出/导入 handle + memcpy 数据面），是五个后端里最"无网络"的一个。

---

## 6. UbTransport：鲲鹏 UB/URMA

官方文档（docs/source/design/transfer-engine/kunpeng_ub_transport.md:7-13）：UB 是与 RDMA/CXL/NVLink/TCP 同层的传输抽象，有两个开源实现——URMA（用户态 API）和 OBMM（内核跨节点共享内存）。代码里 obmm 分支直接报 "not support now"（ub_transport.cpp:478-480,510-512），**实际只有 URMA 完整**。

### 6.1 四层抽象（与 RDMA 骨架一一对应）

```text
UbTransport (ub_transport.h:36)                  ≈ RdmaTransport
 └─ context_list_: vector<shared_ptr<UbContext>>   每块 UB 网卡一个（下标即 device_id）
     UbContext (ub_context.h:130, 抽象)            ≈ RdmaContext
     └─ UrmaContext (urma_endpoint.cpp:29-147)     urma_context_t* / eid_ / jfc_list_ / local_tseg_list_
         ├─ endpoint_store_: UbSIEVEEndpointStore   SIEVE 缓存（写死，无 FIFO 选项）
         └─ worker_pool_: UbWorkerPool              2 个 transfer 线程 + 1 monitor
     UbEndPoint (ub_endpoint.h:24, 状态机 INITIALIZING→UNCONNECTED→CONNECTED)   ≈ RdmaEndPoint
     └─ UrmaEndpoint (:150-196)                    jetty_list_[1] + imported_jetty_map_ + wr_depth_list_
```

连 8 分片队列公式 `(target_id*10007+device_id)%8` 都与 RDMA 版逐字相同（worker_pool.cpp:149 vs ub_context.cpp:253-264）——**UbWorkerPool 就是从 RDMA 版复制的**。

### 6.2 初始化与内存注册

`install`（ub_transport.cpp:37-81）→ `initializeUbResources`（:428-470）：

1. topology 在 `USE_UB` 下枚举 `/sys/class/ubcore/*`（realpath 取 PCI bus id + numa，topology.cpp:206-263；探测完即 `urma_uninit`，与正式使用互不干扰）；
2. 进程级 `urma_init`（容忍 EEXIST）；**topology 为空则回退注入 `"mock_urma_device"`**——无硬件 CI 的关键路径；
3. 每设备 `UrmaContext::construct`（urma_endpoint.cpp:62-155）：`urma_create_context(dev, eid_index=0)` → 创建 JFCE/JFC×N/JFR×N（JFC 的 `user_ctx` 指向各自的 outstanding 计数器——贯穿完成路径的零查找技巧）→ `new UbWorkerPool`；`async_fd` 挂 epoll；
4. `SegmentDesc{protocol="ub"}`，每 context 生成 `DeviceDesc{name, eid}`——**EID 在此刻进入元数据**。

内存注册（ub_transport.cpp:83-123 → urma_endpoint.cpp:261-295）：

- 每网卡 `urma_register_seg(va, len, token=0xACFE)` → `urma_target_seg_t*`；
- **把整个 `urma_seg_t` 结构体按字节序列化成 hex 字符串**存进 `BufferDesc.tseg[]`，段下标存 `l_seg_index[]`（ub_context.h:271-286）；
- 对端使用前 `retrieveRemoteSeg` → 反序列化 → `urma_import_seg` 得本地句柄存 `slice->ub.r_seg`（urma_endpoint.cpp:346-365）。

**"句柄即密钥"模型**：RDMA 用数字 lkey/rkey 对，URMA 用可序列化的 `urma_seg_t`（内含 ubva{eid,uasid,va}+token_id）；本地端 lkey 的等价物就是 `urma_target_seg_t*` 指针本身，直接塞进 WQE 的 `sge.tseg` 字段（:866-871），**没有数字 key、没有查表**。iova 恒 0，纯 VA 注册（无 dma-buf 路径）。

### 6.3 建链：无状态机

- 主动方 `setupConnectionsByActive`（:699-764）：发 `HandShakeDesc{local/peer_nic_path, jetty_num}` 经 metadata RPC 给对端握手 daemon；从**元数据**里查对端 SegmentDesc 拿对端网卡的 `DeviceDesc.eid`；`doSetupConnection(peer_eid, peer_jetty_nums)`。
- 被动方 `onSetupConnections`（ub_transport.cpp:359-381）→ `setupConnectionsByPassive`（:794-837），同样 `doSetupConnection`。
- `doSetupConnection`（:928-985）：对每对 (本端 jetty, 对端 jetty_num)：构造 `urma_rjetty_t{jetty_id={eid,id}, trans_mode=URMA_TM_RC}` → **`urma_import_jetty` + `urma_bind_jetty` 两步完成建链**。

**没有 RDMA 的 INIT→RTR→RTS 状态机，也不需要 rdma_cm**——EID 全局可路由（由组网侧完成路由【推测】），建链被简化成"查表 + bind"。握手交换的全部 UB 字段就两个：`HandShakeDesc.jetty_num`（transfer_metadata.h:122-124）+ `SegmentDesc.devices[].eid`。

### 6.4 一次 WRITE 的完整调用链

```text
[用户线程]
UbTransport::submitTransferTask (ub_transport.cpp:194-310)
 ├─ 本端 selectDevice（NUMA 亲和选网卡, :396-426）
 ├─ 按 64KB 切片: slice->ub.{dest_addr, retry_cnt}; 
 │    slice->ub.l_seg = context->localSegWithIndex(buffers[buf_id].l_seg_index[dev]) (:289-291)
 └─ context->submitPostSend → UbWorkerPool::submitPostSend (ub_context.cpp:160-270)   [只入队]
     ├─ 对端 selectDevice（失败强制刷元数据重试 2 次，仍失败 markFailed + 100ms 熔断）
     ├─ slice->ub.r_seg = retrieveRemoteSeg(buffers[buf_id].tseg[dev]) (:246-248)
     ├─ slice->peer_nic_path = server@device
     ├─ 入 8 分片队列，cond_var 唤醒 worker

[worker 线程（每网卡 2 个）]
UbWorkerPool::transferWorker (:461-495)
 ├─ performPostSend (:272-366)
 │   ├─ endpoint = endpoint_store_ 查/建（SIEVE）；未连接 → setupConnectionsByActive
 │   └─ UrmaEndpoint::submitPostSend (urma_endpoint.cpp:846-918)
 │       ├─ 选 jetty（num_jetty_per_ep=1 → 恒 0 号）
 │       ├─ wr_count = min(jetty 剩余深度, max_jfc_e - JFC 在途)
 │       ├─ 构造 urma_jfs_wr_t[]:
 │       │    l_sge{addr=source, tseg=slice->ub.l_seg}   r_sge{addr=dest, tseg=slice->ub.r_seg}
 │       │    WRITE: src=l_sge,dst=r_sge；READ: 反向 (:878-883)
 │       │    user_ctx=(uint64_t)slice; complete_enable=1; wr.tjetty=imported_jetty_map_[j]
 │       ├─ 原子加 wr_depth_list_ / jfc_outstanding_
 │       └─ urma_post_jetty_send_wr(jetty, wr_list, &bad_wr)          ← 硬件 API 终点
 └─ performPoll (:368-420)
     ├─ UrmaContext::poll → urma_poll_jfc(:519)
     │    cr[i].user_ctx → slice; SUCCESS → slice->markSuccess()
     ├─ 失败 → deleteEndpoint + retry_cnt++ → 重新入队（<9 次）；达上限 markFailed
     └─ 扣减 JFC outstanding 与 jetty_depth（双计数对账）

[monitor 线程（每网卡 1 个）]
 ├─ 每秒 set_active(true) 熔断自愈 + reclaimEndpoint
 └─ epoll async_fd: URMA_EVENT_DEV_FATAL/JFC_ERR/PORT_DOWN/EID_CHANGE → 整卡熔断; PORT_ACTIVE → 复活
```

**双深度流控**（jetty 级 max_wr=256 + JFC 级 max_jfc_e=4096）、slice 级 9 次重试（retry_cnt 驱动 selectDevice 换网卡）、endpoint 懒重建、context 级 32 连败熔断+每秒自愈——**容错骨架与 RdmaTransport 完全同构**，只是动词表从 ibv_* 换成 urma_*。

### 6.5 mock_urma：库内 mock 设计

`kunpeng_transport/CMakeLists.txt:1-22`：`find_library(URMA_LIBRARY urma)` 找到 liburma.so 就链真库；**找不到就把 `urma/mock_urma.cpp` 编进同一个 ub_transport 目标**。mock 用互斥锁 + map 记账，`urma_poll_jfc` 从队列头部取 user_ctx 一律置 `URMA_CR_SUCCESS`（"立即成功"回环），`urma_get_async_event` 恒超时。效果：同一份业务代码在 x86 CI 上全功能跑通（ci.yml coverage job 常态化 `-DUSE_UB=ON`）。代价：发布物可能意外带 mock——官方文档 troubleshooting 专门提醒 `ls /usr/lib64/liburma.so` 检查。

---

## 7. barex：一句话

`USE_BAREX`，基于 `accl/barex/*`（XListener/XConnector/XThreadpool）+ verbs.h，配置项 `eic_max_block_size`（config.cpp:198）——面向 EIC 类自研网卡【推测】；与 UB 平行无共享代码；是唯一用到 Transport 基类特有虚接口 `OpenChannel/CheckStatus`（transport.h:372-375）的后端。

---

## 8. 五后端横向对比

| 维度 | RdmaTransport（基准） | ascend_direct | hccl | heterogeneous | ubshmem | UbTransport |
|---|---|---|---|---|---|---|
| 硬件 API | ibverbs | ADXL（CANN） | libhccl 内部 TransportMem | ibverbs + ACL memcpy | ACL VMM/IPC + memcpy | liburma（umdk） |
| 连接抽象 | QP 状态机 + endpoint store | AdxlEngine 名字懒建链 | ctrl/data 双 HcclSocket + TransportMem | 复用 RDMA | 无连接（地址重映射） | jetty import/bind 两步，无状态机 |
| 寻址发布 | lkey/rkey[] 进元数据 | 引擎名 ip:port（handle 不出本地） | rank_info 全量进元数据 | 委托 RDMA | handle 进 `shm_name` | **序列化 urma_seg_t 进 `tseg[]`** + EID |
| Slice 私有字段 | 7 字段 | 4 字段（含 handle/engine_id） | 1 字段 | rdma 分支 | 1 字段 | 6 字段（含 l_seg/r_seg 指针） |
| 线程模型 | worker pool + CQ 轮询 | 共享池或每引擎一线程 | 1 initiator + 1 accept | 1 staging 线程 | 8 线程池 + stream 池 | 2 worker + 1 monitor/网卡 |
| 本机捷径 | 无（另有 tcp/nvlink 后端） | LocalCopyEngine（fabric 关时） | 同 HCCS 走 vnic IPC | CPU 源透传 | 天然 memcpy | loopback 同机自连分支 |
| 重试 | qp 重试 + redispatch 换网卡 | 2 次 + 强刷元数据 | N 次流级 + 断链 | 委托 RDMA | 无 | 9 次 slice 级 + 换网卡 + 熔断自愈 |
| 完成判定 | poll_cq 计数 | TransferSync 返回 / 查询线程 | SynchronizeStream | 委托 RDMA | SynchronizeStream | poll_jfc 计数 |

共同点：五个后端的 `getTransferStatus` 全是"success+failed == slice_count 的计数聚合"，底层完成探测各自为政（同步返回 / 查询线程 / stream 同步 / CQ/JFC 轮询）。

---

## 9. 设计理念：国产化后端的接入模式

1. **复用骨架，压缩差异到叶子类**。UbTransport 的 WorkerPool/分片/重试/SIEVE 与 RDMA 版近乎逐行相同；ascend_direct 复用 Slice/BatchDesc 状态机。新增硬件后端只需实现 Context/Endpoint 两个叶子 + 注册元数据字段，运维经验（重试、熔断、flush 错误处理）直接迁移。这是 monorepo 多后端共存成本最低的路径。
2. **"句柄即密钥"的内存模型**。URMA 的 tseg 序列化串、ubshmem 的 shm_name、ascend_direct 的引擎名——都不发明新的 key 体系，直接把"能唯一寻址一段内存/一个端点的可序列化对象"塞进现有元数据字段（tseg[]/shm_name/endpoints[]），etcd/P2P 握手通道零改动。
3. **建链力求无状态机**。ADXL 引擎名 Connect 一步、URMA import+bind 两步、ubshmem 干脆无连接。对比 RDMA 的 QP 状态机 + rdma_cm，国产栈普遍把路由下沉到网络层（EID 全局可路由），mooncake 侧的握手只剩"交换 jetty_num / 引擎名"。
4. **对上层封闭，对硬件务实**。heterogeneous_rdma 不动 ibverbs 栈，用 3GB host 环 + 8MB 聚合块两级 staging 换异构互通，代价集中在一个 const_cast 口子（request->source 可写）；hccl 直接借 HCCL 内部库换 HCCS/RoCE 双路径 + 网卡级重传，代价是锁死 libhccl ABI。
5. **可测试性内建**。ADXL 的 weak 符号让单测能强符号覆盖；URMA 的 mock-in-library 让无硬件 CI 全量跑通。两者都把"没有真机也能验证整条异步管线"当成一等需求。
6. **context 亲和是昇腾侧的第一守则**。所有动硬件的路径（dispatcher/executor/allocator/RPC 回调）都先 `aclrtSetCurrentContext` 再操作，ScopeGuard 保证恢复；每卡一 context/一引擎/一（或专属）线程的忠实映射，dummy-real 代理架构由此展开。

## 10. 已知工程毛边与注意事项

- **【疑似缺陷】**`UrmaContext::poll`（urma_endpoint.cpp:516-555）：非 SUCCESS 的完成项 `slices[i]` 未赋值（仅 SUCCESS 分支 :533 赋值），而调用方 performPoll（ub_context.cpp:380-387）对每个返回项解引用判 status——失败路径可能读到栈上未初始化指针。静态阅读结论，供参考。
- `MC_EID_INDEX` 只出现在日志提示（:445），**无任何 getenv 实现**——提示语与实现脱节，别当配置项用。`eid_index`/`num_jetty_per_ep`/`max_jfc_e` 均无环境变量覆盖。
- `ASCEND_BASE_PORT` 文档写默认 11000，代码是 20000（ascend_direct_transport.cpp:164-175），以代码为准。
- UB 的 wr 水位公式仍借用 `num_qp_per_ep`（ub_transport.cpp:202-203），但实际每 endpoint 只有 1 个 jetty（config.h:75）——RDMA 复制痕迹。
- ubshmem 只支持 fabric mem 时才能配 store 的协议（fabric 关 + protocol=="ubshmem" 直接报错，ascend_allocator.cpp:161-165）。
- 昇腾环境变量前缀 `ASCEND_*`/`ASCEND_TRANSPORT_*`/`HCCL_*`/`Ascend_*` 四种混用，没有统一 `MC_` 前缀。

## 11. 测试与示例索引

| 后端 | 测试 | 示例 | 备注 |
|---|---|---|---|
| ascend_direct | tests/ascend_direct_transport_test.cpp（1702 行，全 mock：ACL stub + ADXL 强符号覆盖） | example/transfer_engine_ascend_direct_perf.cpp | init 前必须 aclInit + aclrtSetDevice；location 用 `"npu:<logicid>"` |
| hccl | （无独立单测） | example/transfer_engine_ascend_perf.cpp、transfer_engine_ascend_one_sided.cpp | server_name 需拼 `":npu_"+物理卡号` |
| heterogeneous | — | example/transfer_engine_heterogeneous_ascend_perf_initiator.cpp | initiator 侧不带 npu 后缀 |
| ubshmem | tests/ubshmem_transport_test.cpp（需真机，自带 fabric-device/fabric-host/ipc 三种内存分配） | — | 配套 ubshmem-allocator |
| ub | tests/ub_transport_test.cpp（默认 mock 设备回环；跨机跑法见 kunpeng_ub_transport.md:136-164） | transfer_engine_bench --protocol=ub --device_name=urma0,urma1 | CI coverage job 常态跑 mock 路径 |

---

> 结论速记：**五个华为系后端 = 一套 RDMA 骨架的五种"动词表替换"**——ascend_direct 换成 ADXL 引擎名、hccl 换成 HCCL TransportMem、ubshmem 换成共享内存映射、UbTransport 换成 URMA jetty/tseg、heterogeneous 在 RDMA 之外加一层 NPU staging。差异被压缩在 Context/Endpoint 叶子类与元数据字段（endpoints[]/rank_info/tseg[]/shm_name）里，上层 TransferEngine/Store/PG 完全无感。
