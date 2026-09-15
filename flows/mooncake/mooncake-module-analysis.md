---
title: Mooncake 代码模块解析：调用流程与设计理念
author: MadaoRui
direction: 整体走读
date: 2026-09-01
tags: [Mooncake, 模块地图, 调用链]
summary: 按「模块地图 → 核心抽象 → 端到端调用链 → 设计理念」建立对 Mooncake 的整体认知，以 RDMA 主力路径讲内核骨架，并点出网上旧文章里已经不存在的几个概念。
---
# Mooncake 代码模块解析：调用流程与设计理念

> **代码仓库**：`kvcache-ai/mooncake`（Kimi/Moonshot AI 的 KVCache-centric 分离式 LLM 服务架构，FAST'25 最佳论文）
> **代码基线**：HEAD = `f2853a8`（2026 年 5 月快照，monorepo 新布局）
> **本文目标**：按"模块地图 → 核心抽象 → 端到端调用链 → 设计理念"的顺序，快速建立对 Mooncake 调用流程设计的整体认知。所有结论均出自本地代码，关键处标注 `文件:行号`。
> **姊妹篇**：`mooncake-ascend-kunpeng-ub-transport-analysis.md`——昇腾四个后端（ascend_direct/hccl/heterogeneous_rdma/ubshmem）与鲲鹏 UB/URMA 的同深度解析；`mooncake-load-save-kv-flows.md`——**vLLM-Ascend / SGLang 调用 KV 到内核数据面的 load/save 全流程（昇腾栈视角）**；`mooncake-store-deep-dive.md`——store 模块单独深度解析（本文 §4 的完整版）。本文 §3 以 RDMA 主力路径为例讲内核骨架。
> **阅读背景**：实际部署在**昇腾 NPU 栈**——上层调用方是 vLLM-Ascend 的连接器（MooncakeConnectorV1 / MooncakeLayerwiseConnector / AscendStoreConnector），mooncake TE 协议为 `protocol="ascend"`（AscendDirectTransport/ADXL）。RDMA 路径仅作为理解通用骨架的标本。
> 注意：本仓库近一年经历了大幅重构，网上旧文章中的 `submitSync`、`data_channel.h`、thrift RPC、C++ 版 p2p-store 等概念在当前代码中已不存在，本文以代码现状为准（详见 §11）。

---

## 目录

- [0. 一页看懂 Mooncake](#0-一页看懂-mooncake)
- [1. 全局架构：一个内核，三层栈](#1-全局架构一个内核三层栈)
- [2. mooncake-common：基础库](#2-mooncake-common基础库)
- [3. mooncake-transfer-engine：传输内核（核心）](#3-mooncake-transfer-engine传输内核核心)
- [4. mooncake-store：分布式 KVCache 池](#4-mooncake-store分布式-kvcache-池)
- [5. mooncake-p2p-store：P2P 对象共享（Go）](#5-mooncake-p2p-storep2p-对象共享go)
- [6. mooncake-pg：PyTorch 分布式通信后端](#6-mooncake-pgpytorch-分布式通信后端)
- [7. mooncake-ep：MoE 专家并行通信内核](#7-mooncake-epmoe-专家并行通信内核)
- [8. integration / wheel / rl：绑定与发行层](#8-integration--wheel--rl绑定与发行层)
- [9. 四条代表性端到端调用链](#9-四条代表性端到端调用链)
- [10. 设计理念总结](#10-设计理念总结)
- [11. 与旧版/旧文档的差异澄清](#11-与旧版旧文档的差异澄清)

---

## 0. 一页看懂 Mooncake

Mooncake 解决的问题：LLM 推理集群里，**KVCache 的搬运速度决定了 Prefill/Decode 分离架构的效率**。GPU 显存不够放、CPU/SSD/远端节点的 KVCache 需要以接近硬件带宽的速度移动，且要在网卡故障、进程崩溃时不停机。

整个仓库其实就是**一个传输内核 + 建在内核上的三层服务**：

```text
┌─────────────────────────────────────────────────────────────────┐
│  应用层（代码不在本仓库，在上游）                                    │
│  vLLM MooncakeConnector / SGLang HiCache / LMCache / TensorRT-LLM │
└───────────────▲─────────────────▲──────────────────▲─────────────┘
                │ mooncake.store  │ mooncake.engine  │ mooncake.pg / mooncake.ep
┌───────────────┴─────────────────┴──────────────────┴─────────────┐
│  服务层（本仓库）                                                   │
│  mooncake-store    分布式 KVCache 池（master 元数据 + 多副本 + SSD） │
│  mooncake-p2p-store checkpoint/大对象 P2P 分发（纯 Go 客户端）       │
│  mooncake-pg       PyTorch 分布式后端（NCCL/Gloo 的容错替代）        │
│  mooncake-ep       MoE dispatch/combine GPU 内核（DeepEP 适配版）   │
├──────────────────────────────────────────────────────────────────┤
│  内核层                                                            │
│  mooncake-transfer-engine (TE)：多协议、拓扑感知、零拷贝传输引擎      │
│    ├─ 13+ 种 Transport：RDMA/TCP/NVMe-oF/CXL/NVLink/EFA/UB/昇腾…  │
│    └─ 元数据面：etcd/redis/http + TCP 握手（控制面与数据面分离）      │
├──────────────────────────────────────────────────────────────────┤
│  mooncake-common：配置加载、环境变量、Go cgo 封装的 etcd/K8s 客户端  │
└──────────────────────────────────────────────────────────────────┘
```

**模块速查表**：

| 模块 | 一句话定位 | 语言 | 与 TE 的关系 |
|---|---|---|---|
| mooncake-transfer-engine | 传输内核：统一接口的多协议数据搬运 | C++ (+Python/Rust/C API) | 就是本体 |
| mooncake-store | TE 之上的分布式 KV 服务（master/client 分离） | C++ (+Go/Rust 绑定) | 数据面完全复用 TE |
| mooncake-p2p-store | 无服务器的对象分发（checkpoint 场景） | Go | cgo 调 TE 的 C API |
| mooncake-pg | `torch.distributed` 后端 "mooncake"，容错集合通信 | C++/CUDA | 直接持有 TE 单例，全部走 TE |
| mooncake-ep | MoE token dispatch/combine 内核，IBGDA + NVLink IPC | CUDA | 不直接调 TE（自研设备侧 RDMA 栈），经 PG 间接依赖 |
| mooncake-integration | `mooncake.engine` / `mooncake.store` 的 pybind 绑定 | C++ | 就是 TE/Store 的 Python 出入口 |
| mooncake-wheel | pip 包 `mooncake-transfer-engine` 的发行工程 | Python | 打包上面所有产物 |
| mooncake-common | 配置/环境变量/etcd wrapper 等基础件 | C++/Go | 被所有模块复用 |
| mooncake-rl | RL rollout→训练传输的入门示例（单文件 dummy） | Python | 经 store API 演示用法 |

---

## 1. 全局架构：一个内核，三层栈

理解 Mooncake 调用流程设计的关键，是先抓住一个反复出现的模式：**控制面与数据面分离**。

- **TE 内部**：元数据（内存地址、rkey、拓扑）走 etcd/redis/http + TCP 握手交换；真正的数据走单边 RDMA（对端 CPU 完全不参与收包）。
- **Store 内部**：对象元数据（key → 副本位置）集中在 master；数据由 client 与 client 之间用 TE 直传，master 不碰数据。
- **PG 内部**：建连/QP 信息经 c10d Store 交换；集合通信数据走 TE 的单边 WRITE。
- **EP 内部**：QP/rkey 经 PG 的集合通信交换；token 数据由 GPU 设备侧直接下发 RDMA WQE。

每一次都是"**小消息走控制通道协商出'句柄'，大数据凭句柄直连**"。这是贯穿全仓库的第一设计原则。

第二条原则是**统一抽象 + 可插拔**：数据搬运被抽象成 `Transport` 接口（TE 内）、`TransferSubmitter`（store 内）、`c10d::Backend`（PG 内），具体介质（RDMA/TCP/文件/memcpy）都变成可替换的实现。

---

## 2. mooncake-common：基础库

重构后已大幅"瘦身"，只剩四类东西：

| 内容 | 位置 | 说明 |
|---|---|---|
| `DefaultConfig` | `mooncake-common/include/default_config.h:16` | 把 YAML/JSON 配置扁平化成 `unordered_map`，支持嵌套 key 取值 |
| `Environ` | `mooncake-common/include/environ.h:9` | 单例，集中读 TE/RDMA 环境变量（CQ 数、QP 数、MTU、`MC_FORCE_TCP` 等） |
| `libetcd_wrapper.so` | `mooncake-common/etcd/etcd_wrapper.go` | Go cgo 共享库，让 C++ 复用 Go etcd 客户端；三组独立 client 分别服务 TE / store HA / 快照，支持前缀 watch + C 回调 |
| `libk8s_lease_wrapper.so` | `mooncake-common/k8s-lease/` | K8s Lease leader 选举 wrapper（store HA 可选） |

注意：`Status`、序列化、hash 等工具已迁到 `mooncake-transfer-engine/include/common/` 下（如 `common/base/status.h`）。

---

## 3. mooncake-transfer-engine：传输内核（核心）

### 3.1 分层结构

```text
TransferEngine (门面, include/transfer_engine.h:42)
 └─ TransferEngineImpl (transfer_engine_impl.h:54)        # 生命周期/内存登记/通知
     ├─ TransferMetadata (transfer_metadata.h:43)          # 元数据面（存储插件+握手插件）
     ├─ Topology (topology.h:61)                           # 本机拓扑：存储位置→网卡亲和
     └─ MultiTransport (multi_transport.h:23)              # proto → Transport 路由
         └─ Transport 抽象基类 (transport/transport.h:42)
             ├─ RdmaTransport  ── RdmaContext(每 NIC 一个) ── RdmaEndPoint(QP组) + WorkerPool + EndpointStore
             ├─ TcpTransport / NVMeoFTransport(cuFile) / CxlTransport(mmap)
             ├─ HipTransport / NvlinkTransport(MNNVL) / EfaTransport / UbTransport(华为)
             └─ AscendDirect/Hccl/UBShmem(昇腾) / Barex …
```

`MultiTransport::installTransport`（`src/multi_transport.cpp:272`）按协议名 new 出具体 Transport 并 `install()`；**选哪个 Transport 由"目标段的 protocol 元数据"决定**（`selectTransport`，`multi_transport.cpp:394`），因此一次 batch 里可以同时走不同协议。华为系后端（昇腾 ascend/ubshmem、鲲鹏 ub）详见姊妹篇 `mooncake-ascend-kunpeng-ub-transport-analysis.md`。

### 3.2 用户视角的 API（C++）

`include/transfer_engine.h:42-181`，典型使用五步（对应 `example/transfer_engine_bench.cpp`）：

```cpp
TransferEngine engine;
engine.init(metadata_conn, local_server_name);          // ① 连元数据服务、发现拓扑
engine.installTransport("rdma", args);                   // ② 安装协议后端
engine.registerLocalMemory(addr, len, "cpu:0");          // ③ 注册本端内存（发布句柄）
SegmentID seg = engine.openSegment("peer_name");         // ④ 打开远端段（取回句柄）
BatchID b = engine.allocateBatchID(batch_size);          // ⑤ 批量提交 + 轮询
engine.submitTransfer(b, {{WRITE, src, seg, offset, len}, ...});
engine.getBatchTransferStatus(b, status);                // WAITING → COMPLETED/FAILED
engine.freeBatchID(b);
```

两个容易误解的点（均已在代码中验证）：

1. **C++ 没有 `submitSync`**。统一是异步 `submitTransfer` + 轮询 `getTransferStatus/getBatchTransferStatus`；"同步"语义是 Python 绑定在轮询外面包了一层（`transferSync`，`mooncake-integration/transfer_engine/transfer_engine_py.cpp:369`，内部还有"失败整批重试、换本地网卡"逻辑）。
2. **`TransferRequest` 的 OpCode 只有 `READ/WRITE` 两种**（`transport.h:59`）。"批量"不是靠 BATCH_READ 之类的操作码，而是一个 batch 塞多个 request。

### 3.3 三个核心数据结构：Batch → Task → Slice

定义全部在 `include/transport/transport.h`：

```text
BatchDesc (:314)                一个批次（allocateBatchID 的产物）
 ├─ batch_size                  容量上限
 ├─ task_list: vector<TransferTask>
 ├─ context                     给 Transport 实现挂私有数据（NVMe-oF 用）
 └─ has_failure / is_finished   原子完成标志（+可选事件驱动 CV）

TransferTask (:281)             一个 TransferRequest 的全部状态
 ├─ request 指针回指
 ├─ slices                      切分后的传输分片
 └─ slice_count/success/failed/transferred_bytes  原子计数

Slice (:104)                    最小传输单元（默认 64KB，config.h:49）
 ├─ source_addr/dest_addr/length/opcode
 ├─ peer_nic_path               "对端服务名@对端网卡名" —— 路径的唯一标识
 ├─ 匿名 union                  协议私有字段（rdma 的 lkey/rkey、ub、nvmeof…）
 └─ markSuccess()/markFailed()  原子累计回填 task/batch 计数
```

一个精妙的细节：**`BatchID` 就是 `BatchDesc*` 指针的整数重解释**（`transport.h:87-100` 注释明说这是绕过 map 查找的热路径优化），所以调用方必须保证 batch 生命周期。

### 3.4 元数据面：句柄如何发布与寻址

- `TransferMetadata`（`transfer_metadata.h:43`）由两个插件组合：
  - **MetadataStoragePlugin**（etcd / redis / http，`transfer_metadata_plugin.cpp:542` 工厂按 conn_string 前缀选择）：key 布局 `mooncake/[cluster_id/]ram/<segment_name>`；
  - **SocketHandShakePlugin**：固定 TCP + JSON，负责 QP 握手、通知、存活探测。
- **SegmentDesc**（`transfer_metadata.h:88`）发布到元数据服务的内容 = 对端的全部可寻址信息：`protocol`、`devices[]`（网卡 lid/gid）、**对端拓扑副本 priority_matrix**、`buffers[]`。
- **BufferDesc**（`:52`）里 `lkey[]/rkey[]` 是**按本端网卡数量排列的数组**——`rkey[device_id]` 的含义是"这块内存在第 device_id 号网卡视角下的远程访问 key"。这是双向拓扑选路的基石。

### 3.5 拓扑感知：双向选网卡

`Topology`（`src/topology.cpp`）做三件事：

1. **发现**（`discover`, topology.cpp:473）：解析 `/sys/class/infiniband/*/device`（realpath 得 PCI bus id、numa_node）、`cudaDeviceGetPCIBusId`、NVMe 设备，构建 `存储位置(cpu:N / cuda:i) → {preferred_hca[], avail_hca[]}` 矩阵；其中 **PCIe 距离 = sysfs realpath 的公共祖先深度**（`getPciDistance`, topology.cpp:343），不依赖 hwloc。
2. **选择**（`selectDevice`, topology.cpp:572）：`retry_count==0` 在 preferred 集合内随机（或 `MC_PATH_ROUNDROBIN` 轮询）做负载均衡；`retry_count>0` 按 preferred→avail 顺序遍历——**重试次数本身驱动降级**。
3. **覆盖**：`MC_CUSTOM_TOPO_JSON` / `installTransport(args[0])` / 段描述里的 priority_matrix 都能覆盖自动发现结果。

**双向选路**是 TE 的独门设计：提交时先在**本地**拓扑上为 source 地址选网卡（`RdmaTransport::submitTransferTask`, rdma_transport.cpp:475），worker 下发时又在**对端发布到元数据里的拓扑副本**上为 dest 地址选网卡（`WorkerPool::submitPostSend` → `RdmaTransport::selectDevice(peer_desc,...)`, worker_pool.cpp:116），两侧共同决定 `peer_nic_path = server@nic`，再取 `rkey[device_id]` 精确配对 NIC-to-NIC。

### 3.6 一次 WRITE 的完整调用链（最重要的图）

```text
用户线程
 TransferEngine::submitTransfer(batch, requests)              transfer_engine.cpp:90
 └─ MultiTransport::submitTransfer                            multi_transport.cpp:104
     ├─ selectTransport: 查目标段 protocol → transport_map_["rdma"]
     ├─ 每个 request 建 TransferTask 挂进 BatchDesc
     └─ RdmaTransport::submitTransferTask(task_list)          rdma_transport.cpp:456
         ├─ 对 source 地址一次 selectDevice 定位 (buffer_id, device_id)   ← 本地拓扑
         ├─ 按 64KB 切 Slice；首片定位失败则 while(retry_cnt<9) 换 NIC 重选  ← 拓扑降级
         ├─ slice->rdma.source_lkey = buffers[buffer_id].lkey[device_id]
         └─ 按 NIC 分组 context->submitPostSend(slices)
             └─ WorkerPool::submitPostSend                    worker_pool.cpp:60
                 ├─ 对每个 slice：在【对端】priority_matrix 上 selectDevice   ← 对端拓扑
                 ├─ slice->rdma.dest_rkey = 对端 buffers[buf_id].rkey[device_id]
                 └─ 按 hash(target_id, device_id) 分入 8 个 shard 队列，唤醒 worker

worker 线程（每 NIC 若干个，NUMA 绑定）
 WorkerPool::transferWorker                                  worker_pool.cpp:383
  ├─ performPostSend(:173)
  │   ├─ context_.endpoint(peer_nic_path)                    ← EndpointStore(SIEVE) 懒建
  │   │   未连接 → sendHandshake：从元数据取对端 TCP ip:port，JSON 交换 QP num
  │   │            双方 doSetupConnection（QP: RESET→INIT→RTR→RTS, rdma_endpoint.cpp:545）
  │   └─ RdmaEndPoint::submitPostSend                        rdma_endpoint.cpp:455
  │       ├─ 按 QP 轮转分摊 slice（受 QP 深度/CQ 余量限制）
  │       ├─ 构造 ibv_send_wr{WRITE, remote_addr=dest_addr, rkey=dest_rkey}
  │       └─ ibv_post_send                                    ← 数据面终点：单边 RDMA，对端 CPU 零参与
  └─ performPollCq(:269)
      ├─ ibv_poll_cq → wc.wr_id 就是 Slice*
      ├─ 成功 → slice->markSuccess()（原子计数；整批完成时 CV 通知）
      └─ 失败 → deleteEndpoint(懒重建) + retry_cnt++ → redispatch(:344)
                  （selectDevice(retry_cnt) 依序遍历 preferred→avail = 自动换路径）

查询路径（用户线程轮询）
 getBatchTransferStatus                                      multi_transport.cpp:226
   快路径：batch_desc.is_finished(atomic acquire) 直接返回
   慢路径：逐 task 聚合 slice 原子计数 → COMPLETED/FAILED

兜底线程（每 NIC 1 个 monitorWorker, worker_pool.cpp:489）
   epoll IBV 异步事件：QP_FATAL→端点失活；DEVICE_FATAL/PORT_ERR→整卡熔断 set_active(false)；
   每秒尝试自愈 set_active(true)、回收空闲 endpoint
```

### 3.7 容错的三级降级 + 上层整批重试

| 层级 | 触发 | 动作 | 代码 |
|---|---|---|---|
| slice 级 | poll_cq 失败 | `redispatch`：retry_cnt++ 驱动 `selectDevice` 换网卡重发（上限 9 次） | worker_pool.cpp:344 |
| 连接级 | QP fatal | endpoint 失活，下次访问懒重建；inactive>1s 回收 | worker_pool.cpp:235 |
| 设备级 | 连续 32 次失败 | 整块网卡 `context.set_active(false)` 熔断，monitorWorker 每秒探测自愈 | worker_pool.cpp:249,489 |
| batch 级（Python 层） | 整批失败 | 以 `advise_retry_cnt=retry` 重新提交，配合 selectDevice 语义实现"换本地网卡重来" | transfer_engine_py.cpp:395 |

`advise_retry_cnt` 字段（`transport.h:66`）是上层把"这是第 N 次重试"的意图传进引擎的通道——接口设计的干净之处。

### 3.8 并行度设计：四级摊薄单点队列

一次批量提交被逐级分组：**MultiTransport 按协议分组 → RdmaTransport 按 NIC(context) 分组 → WorkerPool 按 8 个 shard 分组 → EndPoint 按多 QP 均分**（QP/CQ/comp channel 本身也是 round-robin 创建的，rdma_context.cpp:421）。大传输还有流式水位（`kSubmitWatermark`，rdma_transport.cpp:558），切块过程中先行下发一部分，控制内存占用。锁粒度普遍是 RWSpinlock + 原子计数，网络 IO 全部在锁外。

### 3.9 API 暴露

- **C API**（`include/transfer_engine_c.h`）：给 Go/Rust 绑定用的薄封装（p2p-store 就走这条路）。
- **Python**（`mooncake-integration/transfer_engine/transfer_engine_py.cpp`，模块名 `mooncake.engine`）：`transfer_sync_write/read`、`batch_transfer_async_*`、`get_batch_transfer_status`（可批量等多个 batch）、`transfer_write_on_cuda`（CUDA stream 回调里提交，与计算流水线重叠）、`allocate_managed_buffer`（buddy slab 分配器）等。
- **特殊模式** `metadata_conn_string="P2PHANDSHAKE"`：完全不需要 etcd，段描述直接经 TCP 对等交换——vLLM 的 MooncakeConnector 用的就是它。

---

## 4. mooncake-store：分布式 KVCache 池

### 4.1 进程模型：master + real client + dummy client

```text
                 ┌──────────────────────────────┐
                 │ mooncake_master (master.cpp) │  控制面：对象元数据、地址分配器、
                 │  MasterService               │  副本/租约/淘汰/任务/HA（不碰数据）
                 └──────▲───────────▲───────────┘
             coro_rpc   │           │  coro_rpc (ylantinglibs coro_rpc, 默认 :50051)
      PutStart/PutEnd/GetReplicaList│           │ MountSegment / FetchTasks / Ping
        ┌──────────────┴──┐     ┌───┴──────────────┐
        │ RealClient 进程  │     │ RealClient 进程    │  数据面：client↔client 用 TE 直传
        │ (real_client.cpp)│◄───►│ (每存储节点一个)    │  （本地命中则 memcpy 降级）
        │  持有内存/SSD     │ TE  │                   │
        │  TransferEngine  │     │                   │
        └────▲─────────────┘     └───────────────────┘
   unix socket + 共享内存 (dummy↔real)
        ┌────┴─────────────┐
        │ DummyClient × N   │  推理进程内每个 TP rank 一个轻量代理
        │ (无资源，转发请求)  │  （mooncake.store 的 dummy 模式）
        └──────────────────┘
```

反直觉但关键的设计：**地址分配器跑在 master，内存物理上在 client**。client `MountSegment` 时（client_service.cpp:2142）先 `transfer_engine_->registerLocalMemory` 再上报 master；master 在自己的地址空间里用 CacheLib slab / offset allocator 对 `(base, size)` 区间做纯地址运算的"镜像分配"（segment.cpp:25）。master 因此能全局统筹配额与负载，又不必搬运数据。

三种部署形态（docs/source/design/mooncake-store.md）：① 嵌入式（推理进程内直接链库）；② dummy-real（8 个 rank 共享同机一个 real client 的网卡和内存）；③ 独立 `mooncake_client` 守护进程专职供内存。

### 4.2 元数据与一致性：不可变对象 + 租约读

- 对象元数据 `ObjectMetadata`（master_service.h:582）：1024 个哈希分片、每片一把 shared_mutex，`key → {client_id, size, lease_timeout, replicas[]}`。**当前版本一个对象 = 一段连续缓冲的 N 个副本**（旧版"多 slice 元数据"模型已简化，slice 现在只是传输/分配粒度，上限 ≈16MB-16，types.h:335）。
- **Put 语义**：`PutStart`（分配副本、返回描述符）→ 数据直传 → `PutEnd`（mark_complete）。对象不可变；`PutRevoke` 回滚。
- **读保护靠租约**：`GetReplicaList` 返回前给对象发 5s 租约（master_service.cpp:790），客户端传完校验租约是否过期（client_service.cpp:815），防止"读一半被淘汰"。
- **淘汰**：master 后台线程 10ms 轮询，超高水位（95%）时用"租约时间近似 LRU"批量淘汰（`BatchEvict`，master_service.cpp:3512）；hard-pin 永不淘汰、soft-pin（VIP 对象）30 分钟保护；`offload_on_evict` 模式先把副本落 SSD 再删内存。
- **多副本**：`RandomAllocationStrategy` 保证同一对象的副本落在**不同 segment**（allocation_strategy.h:245）；best-effort——分不到足够副本时降级而非失败。读侧 `FindFirstCompleteReplica` + 客户端本地热点缓存（CountMinSketch 频率准入，client_service.h:536）二级削峰。
- **分层存储**：副本三态 MEMORY/DISK/LOCAL_DISK（replica.h:32）；master 心跳统一调度 offload，SSD 侧三种 backend（file-per-key / bucket 聚合 / offset-log）。

### 4.3 Put 全链路（以 RealClient 为例）

```text
RealClient::put(key, value, config)                          real_client.cpp:1339
 ├─ ClientBufferAllocator::allocate + memcpy + split_into_slices（≈16MB 分段）
 └─ Client::Put(key, slices, config)                         client_service.cpp:1173
     ├─ MasterClient::PutStart(key, slice_lengths, cfg)      ← 控制面 RPC
     │   └─ master: AllocateAndInsertMetadata
     │       └─ allocation_strategy_->Allocate() → vector<Replica>{buffer_address, protocol, transport_endpoint}
     ├─ 对每个 MEMORY 副本: TransferWrite(replica, slices)   ← 数据面
     │   └─ TransferSubmitter::submit(replica, slices, WRITE)  transfer_task.cpp:488
     │       ├─ endpoint 是本机？ → LOCAL_MEMCPY（MemcpyWorkerPool 线程池）
     │       └─ 否则 → TRANSFER_ENGINE:
     │           engine.openSegment(handle.transport_endpoint)
     │           每 slice 一个 TransferRequest{WRITE, src, seg, buffer_address+offset, len}
     │           allocateBatchID + submitTransfer            ← 进入 §3.6 的 TE 链路
     │       失败 → PutRevoke 回滚该副本
     └─ MasterClient::PutEnd(key, MEMORY)                    ← 控制面 RPC（mark_complete + 续租约）
```

`AllocatedBuffer::Descriptor{buffer_address, transport_endpoint}`（allocator.cpp:32）就是"KV 值地址 → TE target"的桥梁——store 层与 TE 层的唯一接缝。

Get 链路对称：`Query(key)` 拿副本列表+租约 → `FindFirstCompleteReplica`（命中本地热点缓存则改写描述符）→ TE READ 拉到用户 buffer → 校验租约。BatchGet 则一次 `BatchGetReplicaList` RPC + 全部传输先提交再统一等待（client_service.cpp:994）。

### 4.4 HA（可选，默认关闭）

master 是唯一有状态组件：leader 选举（etcd/redis lease，`MasterServiceSupervisor`）+ OpLog 回放（REMOVE 强制持久化后才执行，防 stale descriptor；PUT_END 尽力）+ 周期快照。client 崩溃由 Ping TTL（默认 10s）检测并卸段清副本，复活后 `ReMountSegment` 重挂。非 HA 模式元数据仅内存态。

---

## 5. mooncake-p2p-store：P2P 对象共享（Go）

**无服务器**，一组对等客户端 + etcd，面向 checkpoint/大文件分发（生产版即 MoonshotAI/checkpoint-engine 的开源前身思路）：

- 核心类 `P2PStore`（`src/p2pstore/core.go:33`）= Metadata（etcd CAS 乐观锁）+ RegisteredMemory（内存分块并行注册）+Catalog+TransferEngine（**cgo 调 TE 的 C API**）。
- 元数据 schema：`mooncake/checkpoint/<对象名>` → `Payload{Shards[]{Gold[], ReplicaList[]}}`，`Location{SegmentName, Offset=进程虚拟地址}`。
- 典型流（训练侧→推理侧）：
  - `Register`：mmap 缓冲 → 按 4GiB 分块并行 `registerLocalMemory` → 按 maxShardSize 切 shard，CAS 写入 Gold 位置。
  - `GetReplica`：读 payload → 每 shard 一个 goroutine `performTransfer`：`openSegment` → `TransferRequest{READ, 本地addr, 远端seg, 远端offset}` → 轮询状态；失败换下一个副本位置重试 → 成功后把自己追加进 ReplicaList（CAS）。
- 设计精髓：**副本列表就是分发树**——后来者从已有 replica（而非 gold）拉数据，分摊源节点带宽；这一切只靠 etcd CAS，没有中心调度进程。

## 6. mooncake-pg：PyTorch 分布式通信后端

`MooncakeBackend : public c10d::Backend`（`mooncake-pg/include/mooncake_backend.h:18`），注册为 `torch.distributed` 的 `"mooncake"` / `"mooncake-cpu"` 后端，卖点是**容错与弹性**（NCCL 一个 rank 挂就集体卡死，mooncake 后端把坏 rank 从 activeRanks 剔除后继续跑）。

- 初始化：进程级 TE 单例（P2PHANDSHAKE 模式免 etcd，mooncake_backend.cpp:121）→ 分配 2×16MiB 双缓冲 send/recv + CPU 同步信号区并注册 → 经 c10d Store 交换 SegmentInfo 互相 openSegment。
- 集合通信（如 allreduce）的状态机（mooncake_worker_thread.cpp:68）：
  1. 用户 tensor `cudaMemcpyAsync` 进 send_buffer，同时预挂 recv_buffer→tensor 的回拷；
  2. worker 线程为每个活跃 peer 构造 `TransferRequest{WRITE}` 列表交 TE（**一切数据面都是 TE 单边 WRITE**）；
  3. 传输完成后向对端信号区写 4 字节"完成通知"；
  4. 收齐所有活跃 rank 的信号后，本地 reduce kernel 把 N 份 recv_buffer 归约进目标 tensor。
- 容错：传输失败或 `probePeerAliveByID` 超时 → `activeRanks[j]=false`；`get_peer_state` 用一次 allreduce(MIN) 收敛各 rank 视图；恢复走 `recover_ranks` / 新进程 `join_group`（is_extension 模式）。

## 7. mooncake-ep：MoE 专家并行通信内核

官方定位："Mooncake EP is an adaption of DeepEP"（docs/source/python-api-reference/ep-backend.md）。相对 DeepEP 的两点增强：**容错**（API 多了 `active_ranks` 张量 + `timeout_us`）和 **IBGDA**（GPU 设备侧直接构造 mlx5 WQE + doorbell，CPU 不参与收发）。它**不复用 TE 的传输栈**（自研 `mooncake_ibgda`，QP 控制区建在 GPU 显存），对 TE 生态的依赖是间接的：用 PG 交换 QP/rkey 元数据、用 `pg.get_preferred_hca` 选网卡。

dispatch 的"单播信箱"模型（mooncake-ep/src/mooncake_ep_kernel.cu:154）：

```text
发送：每 token 按 topk 选 expert → dst_rank = expert/num_local_experts
      slot = atomicAdd(对端 (expert,src_rank) 计数器)
      NVLink 可达 → ipc_peer_ptrs 直写；否则设备侧发 IBGDA RDMA WRITE 到对端固定槽位
通知：向对端 signal buffer 发 RDMA ATOMIC ADD 作为"信箱有信"
接收：sub-warp 自旋 ld_acquire_sys 轮询信号（超时或 active_ranks[src]==0 → 标记坏 rank）
      按 layout_range 把 token 打包进 packed_recv_x（FP8 时含 scale）
```

combine 对称：把各 expert 输出按 `src_info` 回发原 rank，接收侧按 `topk_weights` 加权求和；支持 `return_recv_hook` 把接收阶段拆成回调与计算重叠。

## 8. integration / wheel / rl：绑定与发行层

- **mooncake-integration**：`mooncake.engine`（TE pybind）与 `mooncake.store`（Store pybind，real/dummy 双模式 + tensor API + TP 并行分片）的源码；`NVLinkAllocator`（CUDAPluggableAllocator，供 SGLang 自定义内存池）。**注意 vLLM/SGLang/LMCache 的 connector 代码在上游仓库**，本仓库只有 OOT 版 `mooncake_connector_v1.py`（在 wheel 里，支持 vLLM 0.10–0.12）。
- **mooncake-wheel**：pip 包 `mooncake-transfer-engine` 工程。纯 Python 部分含 `mooncake_connector_v1.py`、`http_metadata_server.py`（免 etcd 的 HTTP 元数据服务）、`mooncake_store_service.py`（REST 封装）、`pg.py/ep.py`（按 torch 版本动态加载编译扩展的垫片）；二进制（engine.so、libtransfer_engine.so、mooncake_master/client、ep/pg 扩展）由 `scripts/build_wheel.sh` 构建时注入。
- **mooncake-rl**：仅一个 dummy 示例脚本（rollout 引擎 `put_tensor` → 训练引擎 `get_tensor`），演示 store 在 RL 数据传输中的用法，非可构建模块。

---

## 9. 四条代表性端到端调用链

把四条链放在一起看，"控制面协商句柄、数据面直连"的统一模式一目了然：

| 场景 | 控制面（小消息） | 数据面（大数据） |
|---|---|---|
| **vLLM PD 分离传 KV** · `MooncakeConnectorWorker.send_kv_to_decode` | ZMQ side channel 交换 block_id/对端地址；TE 用 P2PHANDSHAKE 直连 | `engine.batch_transfer_sync_write(remote, srcs, dsts, lens)` → TE RDMA WRITE 直写对端 KV 显存（GPU dmabuf 注册） |
| **SGLang HiCache / LMCache 远端缓存** · `MooncakeDistributedStore.get_tensor` | coro_rpc 问 master：GetReplicaList + 发租约 | TE READ 从 replica 副本直拉到本地 buffer；本地命中则 memcpy 降级 |
| **容错集合通信** · `dist.all_reduce`（mooncake 后端） | c10d Store 交换 SegmentInfo；完成通知写 4 字节信号 | N 份 TE 单边 WRITE 扇出 + 本地 reduce kernel |
| **MoE dispatch** · `Buffer.dispatch` | PG 的 all_gather/all_to_all 交换 QPN/rkey/IPC handle | GPU 设备侧 IBGDA WRITE 直写对端显存信箱（CPU 零参与） |

## 10. 设计理念总结

以下八条是走读全部模块后提炼的设计主线，每条都给出了代码落点：

1. **控制面/数据面分离**。元数据（句柄）走 etcd/redis/http/TCP/RPC 小通道协商，数据面凭句柄单边直传（RDMA WRITE/READ、NVLink IPC、cuFile），数据路径上没有中间代理。见 §3.4、§4.3、§6、§9。
2. **统一抽象、介质可插拔**。`Transport` 纯虚接口装下 13+ 种介质（transport.h:341）；`TransferSubmitter` 让 store 在 memcpy/TE/文件读之间策略切换（transfer_task.cpp:785）；`c10d::Backend` 让 PG 替换 NCCL。选择哪个实现由**元数据里的 protocol 字段**决定，而非本地能力（multi_transport.cpp:394），因此混合协议 batch 是自然的。
3. **拓扑感知 + 双向选路**。本地拓扑（sysfs PCIe 距离 + NUMA）选源侧网卡，对端发布到元数据的拓扑副本选宿侧网卡，NIC-to-NIC 精确配对（§3.5）。这是"多网卡带宽聚合"的实现基础（8×400G 实测 190GB/s）。
4. **重试次数驱动降级**。`selectDevice(retry_count)` 把"负载均衡（retry=0 随机）"和"故障降级（retry>0 按 preferred→avail 顺序）"统一在同一个接口里；slice→连接→设备→batch 四级容错（§3.7）。
5. **批量 + 分片 + 异步流水**。Batch→Task→Slice 三级分解，四级并行摊薄队列；BatchID 即指针、线程本地 slice 缓存、流式水位控制内存（§3.3、§3.8）。完成通知可选"轮询原子计数"或"事件驱动 CV"。
6. **全局统筹的元数据、无状态的数据**。store 把分配器放进 master 换来全局配额与负载均衡，内存/盘上的数据不依赖 master 存活；HA 只需要保 master（OpLog+快照）。p2p-store 则反过来验证：没有 master 时用 etcd CAS 也能自组织分发树。
7. **面向推理负载的特化**。不可变对象（KVCache 只写一次）+ 租约读保护；dummy-real 架构适配 TP 多 rank 共享网卡；CUDA stream 回调提交（`transfer_write_on_cuda`）让传输与计算重叠；GPU 内存走 dmabuf 注册免 peermem。
8. **生态位策略**。TE 做成独立 pip 包（`mooncake-transfer-engine`），连接器代码放进 vLLM/SGLang/LMCache/TensorRT-LLM 上游而非本仓库——内核稳、集成活。

## 11. 与旧版/旧文档的差异澄清

写文档/读旧文章时容易踩的坑（本仓库当前代码为准）：

| 旧概念 | 现状 |
|---|---|
| `submitSync/submitAsync` | C++ 只有异步 `submitTransfer` + 轮询；sync 是 Python 绑定的封装 |
| `BATCH_READ/BATCH_WRITE` OpCode | 只有 `READ/WRITE`；批量 = 一个 batch 多个 request |
| `data_channel.h`、`batch_desc.h` 独立头文件 | 不存在；BatchDesc 是 `transport.h` 内嵌结构 |
| ibverbs XRC | 无，QP 固定 RC 类型 |
| mooncake-store 用 thrift | 已换 yalantinglibs coro_rpc + coro_http |
| DRAMAllocator/NVMeAllocator、PageStore | 换成 Cachelib/Offset BufferAllocator + StorageBackend 家族 |
| 对象 = 多 slice 元数据（FAST25 版） | 对象 = 连续缓冲 + N 副本；slice 只是传输/分配粒度 |
| p2p-store 的 C++/Python API | 已重构为纯 Go 模块（cgo 调 TE C API） |
| mooncake-common 里的 status/uuid/base64 | status 在 TE 的 `include/common/`；base64 在 store 的 utils；uuid 已移除 |
| 头文件在 `src/include/` | 在各模块的 `include/`（monorepo 布局） |

另：仓库里还有一套下一代引擎 `mooncake-transfer-engine/tent/`（环境变量 `MC_USE_TENT` 运行时切换，transfer_engine.cpp:224），本文描述的是经典引擎；两者共享同一个 `TransferEngine` 门面 API。

---

## 推荐阅读路线

1. **入门**：`example/transfer_engine_bench.cpp`（TE 全 API 用法）→ `mooncake-transfer-engine/include/transport/transport.h`（三个核心结构）→ `src/worker_pool.cpp`（数据面心跳）。
2. **store**：`docs/source/design/mooncake-store.md`（官方设计文档）→ `src/client_service.cpp` 的 `Put/Get` → `src/master_service.cpp` 的 `PutStart/GetReplicaList/BatchEvict`。
3. **上层**：`mooncake-wheel/mooncake/mooncake_connector_v1.py`（vLLM connector 全貌）→ `mooncake-pg/src/mooncake_worker_thread.cpp`（容错状态机）→ `mooncake-ep/src/mooncake_ep_kernel.cu`（设备侧 RDMA）。

> 相关笔记：`../lmcache-xllm/mooncake-code-walkthrough.md`（基于另一份旧快照的走读，可对照 §11 的差异表阅读）。
