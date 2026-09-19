---
section: mooncake
summary: 两者不是完全同层竞争：Mooncake 在 KVCache 专用存储、跨实例复用与 LLM serving 生态上领先，Yuanrong DS 在昇腾原生 RH2D/HIXL/HCCS、统一对象数据系统与可随 worker 分片的 metadata owner 上更深；本轮新增昇腾底层传输专项，把两条实现追到 ACL/ADXL/HCCL 与 HCCS/RoCE 边界，并给出地址发现、内存注册、分组批量、并发与失败路径的源码对照。
---

# openYuanrong datasystem vs Mooncake 竞品报告

**研究日期：** 2026-09-19

**比较对象：** openYuanrong datasystem（下文简称“Yuanrong DS”）与 Mooncake（Transfer Engine + Mooncake Store）
**核心问题：** 昇腾特性支持程度、KV 存储、KV 传输，以及国内互联网厂商使用情况。

## 范围、版本与证据等级

- **Yuanrong DS 基线：** `yuanrong-datasystem`，commit `ae841bfe773c6eef22d187b1077e0a73140b10d7`（`ae841bf`）。
- **Mooncake 基线：** `mooncake-review`，commit `e389a85093cb37a96ccf68dcfbe2dcff0698a99e`（`v0.3.14-rc1-31-ge389a850`）。
- **Observed / 源码已确认：** 直接来自上述 checkout 的源码；报告给出仓库相对路径和行号。
- **Documented / 文档声称：** 项目 README、官方文档、vLLM-Ascend 文档；不能单独当作所有生产环境的 runtime 证明。
- **Inferred / 架构推断：** 根据 API、编译开关和数据路径推导，并明确写出推理依据。
- **Unknown / 未知：** 未获得两家在同一硬件、同一模型、同一请求 trace 下的可复现实测；厂商采用规模、SLA、成本和故障率不应从公开仓库直接外推。

**本轮昇腾专项边界：** 从应用/connector 入口追到 ACL、HIXL、ADXL、HCCL/DSP2P 与 HCCS/RoCE 边界，覆盖地址发现、内存注册、分组批量、并发、多 NPU、回退和硬约束；不把 Store 元数据、KV 淘汰算法或 README 性能数字当成底层传输实现证据。

**未覆盖：** 许可证与商业支持合同、具体云厂商报价、私有部署规模、未公开客户、真实生产 tail latency、CANN/驱动在每个版本组合上的兼容矩阵。

## 一页结论

| 维度 | Yuanrong DS | Mooncake | 结论 | 代码证据 |
|---|---:|---:|---|---|
| 昇腾原生能力 | **4.5/5** | **4.5/5** | Yuanrong 更像昇腾数据系统；Mooncake 更像跨加速器传输平台，昇腾路径已经形成 Direct/ADXL、HCCS/RDMA、UBSHMEM 组合。 | **Observed：** Yuanrong `src/datasystem/common/rdma/npu/hccs_transport.cpp:136-214`、`remote_h2d_manager.cpp:740-759`；Mooncake `mooncake-transfer-engine/src/multi_transport.cpp:467-480`、`ascend_direct_transport.cpp:181-251` |
| KV 存储产品化 | **3.5/5** | **5.0/5** | Mooncake Store 原生围绕 KVCache 做分布式存储、复制、淘汰、分层和放置；Yuanrong DS 强在通用对象/异构缓存与 L2 持久化，KV 语义主要由 vLLM connector 适配。 | **Observed + Documented：** Yuanrong `ObjectPersistenceApi`/`PersistenceApi`；Mooncake placement/replica 源码与 Store 文档 |
| KV 传输效率 | **4.0/5** | **4.5/5** | Yuanrong 的 RH2D/HCCS/RoCE 把远端 Host source 直接送入本地 NPU HBM；Mooncake TE 以统一 task/slice 状态模型组织请求，并按 transport、segment、opcode、endpoint 和 engine 分组。当前 Ascend Direct 是“一 request 一 slice”，不能概括成自动把单请求切碎。 | **Observed：** Yuanrong `object_client_impl.cpp:2037-2170`；Mooncake `ascend_direct_transport.cpp:254-318`、`slice_dispatcher.cpp:65-99,131-160` |
| 统一对象数据系统 | **4.5/5** | **2.5/5** | Yuanrong 源码同时具备 object/device-object、L2 persistence、slot/recovery 和路由/worker 边界；本次 Mooncake 源码范围未见 Stream 语义，因此不能等量齐观。 | **Observed：** Yuanrong `src/datasystem/client/object_cache/object_client_impl.h:581-670`、`src/datasystem/common/l2cache/persistence_api.h:109-122`；Mooncake 的 KV placement 证据为 `mooncake-store/include/placement/target.h:11-33`，未见对等 Stream API |
| 华为/昇腾基础设施集成 | **4.5/5** | **4.0/5** | 两者均有代码级 Ascend runtime 集成；Yuanrong 在 HIXL/HCCS/RH2D/ACL 资源控制更深入。**华为内部产品协同与客户采用不由源码证明。** | **Observed：** Yuanrong `cmake/modules/FindAscend.cmake:27-69,93-123`、`hccs_transport.cpp:136-214`；Mooncake `mooncake-common/common.cmake:104-111,610-627`、`transfer_executor_base.cpp:169-294`；组织协同为 **Unknown** |
| 元数据架构 / 横向扩展 | **4.5/5** | **3.5/5** | Yuanrong 默认启用 distributed master，对象 key 按 topology placement 分配 metadata owner；Mooncake Store 当前是逻辑单 active master，进程内 1024 shard 提升并发，HA standby 不分担在线 metadata 请求。 | **Observed + Inferred：** Yuanrong `object_meta_route_helper.cpp`、`worker_oc_server.cpp`；Mooncake `client_service.cpp`、`master_service.h` |
| 元数据一致性机制 | **4.0/5** | **4.0/5** | Yuanrong 的 topology 有 CAS/version/digest fencing，但 object metadata 的持久化语义随 write mode 改变；Mooncake 的 HA oplog 有 producer view、顺序和 durable-prefix fencing，但部分业务 mutation 是 visible-before-durable。 | **Observed：** Yuanrong `object_meta_store.cpp`、`topology_repository.cpp`；Mooncake `oplog_batch_storage.cpp`、`master_service.cpp` |
| HA / 故障恢复 | **4.0/5** | **4.0/5** | Yuanrong 是分布式 owner/worker/object/slot 恢复；Mooncake 是 master active/standby + lease + oplog/snapshot。两者均存在实际运行路径，也都存在默认关闭或组合受限的关键能力。 | **Observed：** Yuanrong `metadata_recovery_manager.cpp`、`slot_recovery_manager.cpp`；Mooncake `master_service_supervisor.cpp`、`standby_controller.cpp` |
| 特性成熟度 | **4.0/5** | **4.0/5** | 两边均有单测、系统测试和故障路径；源码规模与测试文件数只能证明工程投入，不能替代固定版本矩阵下的故障演练。 | **Observed：** 测试目录与运行时开关；本报告未执行两仓全量测试 |
| 框架可扩展性 | **4.0/5** | **4.5/5** | Yuanrong 的 Object/KV/Hetero/Stream 语义面更广；Mooncake 的 Connector/TE/Store 分层和通用 `TransferRequest` 更利于多 serving engine、多 transport 复用。双方 backend/transport 工厂仍有硬编码分支。 | **Observed + Inferred：** Yuanrong `datasystem.h`、`persistence_api.cpp`；Mooncake `transport.h`、`multi_transport.cpp` |
| 可演进性 | **3.5/5** | **4.0/5** | Yuanrong 有 topology schema 和 compatibility version，但当前 RPC 协议明确存在需要全量重启的变更；Mooncake 的 oplog/snapshot 有 schema version，分层更利于局部替换，但兼容矩阵更复杂。 | **Observed + Inferred：** Yuanrong `meta_zmq.proto`；Mooncake `oplog_batch_codec.cpp`、snapshot metadata codec |
| 国内互联网公开采用证据 | **2.5/5** | **4.5/5** | Mooncake 有 Kimi 生产平台、腾讯 FlexKV、阿里 ROLL、京东 xLLM 等公开生态证据；Yuanrong 的公开采用主要是华为/昇腾体系，互联网公司独立生产案例仍少。 | **Documented only：** 官方 README、公开文章；非源码事实 |

> **不再给单一等权总分。** 新增维度与原维度存在明显相关性，例如 HA 依赖元数据持久化、框架扩展性又影响硬件支持；简单平均会制造虚假精确。应按目标场景设权重：昇腾单栈看 Yuanrong 的设备数据面与统一数据系统，KV serving 平台看 Mooncake 的 Store/Connector/TE 和生态。

**最重要的判断（代码证据版）：** 两者不是完全同层竞争。Yuanrong DS 是“通用分布式数据系统 + 昇腾异构数据面”，Mooncake 是“以 KVCache 为中心的推理传输/存储平台”。源码可以确认 Yuanrong 的 HIXL/HCCS/RH2D/ACL 数据通道、object/L2/slot 语义和 topology fencing，也可以确认 Mooncake 的 Ascend transport、Store placement、active/standby、oplog/snapshot；源码不能确认“华为内部产品协同”或任一方的真实客户规模。Yuanrong 的优势是昇腾专项控制点和统一数据语义，Mooncake 的优势是 KV 专用抽象、HA 日志链路和多框架复用；这不是“谁全面替代谁”的关系。

## 重新分析：三类结论的证据边界

### A. RH2D/HIXL/HCCS：Yuanrong 是代码级强项，Mooncake 是代码级可用

- **Yuanrong（Observed）：** `HCCSTransport` 直接包含 HIXL 头文件，声明 `RegisterMemory`、`PreRegisterDeviceMemory`、`ImportRemoteAddressInfo`、`ScatterBatch`，并保存 per-device HIXL engine 和注册内存表（`src/datasystem/common/rdma/npu/hccs_transport.h:31-53,60-99`）。初始化调用 ACL 设置 device，再调用 `engine->Initialize(...)`；`HCCL_INTRA_ROCE_ENABLE` 选择 `ROCE_DIRECT` 或 `BUFFER_POOL`（`hccs_transport.cpp:54-72,136-214`）。
- **Yuanrong 调用链（Observed）：** `ObjectClientImpl::MGetH2D` 更新 RemoteH2D 配置并进入 `MGetH2DImpl`（`src/datasystem/client/object_cache/object_client_impl.cpp:1816-1840`）；实现显式把 RH2D 标记传入 `Get`，再执行 `HostDataCopy2Device`（`src/datasystem/client/object_cache/object_client_impl.cpp:1930-1965`）。这证明 RH2D 不是只存在于部署文档，而是挂在对象获取的实际调用链上。
- **Mooncake（Observed）：** `multi_transport.cpp` 在 `USE_ASCEND_DIRECT` 下实例化 `AscendDirectTransport`，旧 `USE_ASCEND` 下实例化 `HcclTransport`，另有异构 RDMA 分支（`mooncake-transfer-engine/src/multi_transport.cpp:38-46,467-480`）；`TransferEngine` 负责安装 `ascend` transport（`src/transfer_engine_impl.cpp:227-233`）。
- **边界：** 两边源码都证明“实现存在并能进入数据面”，不证明当前环境中的驱动、CANN、ADXL/HIXL、HCCS 链路一定可运行；运行可用性仍需按版本矩阵和实测验证。

### B. 统一对象数据系统：Yuanrong 可以由源码证明，Mooncake 不应被描述成同类系统

- **Yuanrong（Observed）：** 设备对象 API 同时提供 `MGetH2D`/`MSetD2H`、`DevPublish`/`DevSubscribe`、`DevMGet`/`DevMSet` 等对象生命周期接口（`src/datasystem/client/object_cache/object_client_impl.h:581-670`）；持久化工厂在 `l2_cache_type=distributed_disk` 时选择 `AggregatedPersistenceApi`，否则选择 `ObjectPersistenceApi`（`src/datasystem/common/l2cache/persistence_api.cpp:32-50`）；`PersistenceApi` 还暴露 slot preload/merge/cleanup（`src/datasystem/common/l2cache/persistence_api.h:111-122`）。对象 API、设备对象 API、L2 persistence、slot recovery 因此有代码级连接。
- **Mooncake（Observed）：** Store 源码可以确认 placement target、replica allocator、local SSD metrics 和 NVMe KV executor（`mooncake-store/include/placement/target.h:11-33`；`mooncake-store/src/placement/replica_allocator.cpp:1-5,85-123`；`mooncake-store/src/nvme_kv_executor_ioctl.cpp:1-5`）。这证明它是分布式 KV/对象存储，但在本次 checkout 中没有发现与 Yuanrong Object/Stream/slot recovery 对等的统一语义面。
- **结论：** “Yuanrong 是统一对象数据系统”是 **Observed**；“Mooncake 也是统一对象数据系统”只能说是 **Inferred/不等价**。Mooncake 的优势应表述为 KV 专用存储平台，而不是泛化成 Object/Stream 一体化系统。

### C. 华为基础设施协同：代码只证明技术集成，不证明组织/客户协同

- **可由代码证明的部分（Observed）：** Yuanrong 依赖 `hixl`、ACL、HCCL 类型和 HCCS/RoCE 链路；Mooncake 依赖 Ascend Direct/ADXL、CANN 构建开关和 Ascend transport。两边均有 endpoint、device、内存注册或链路选择的实现。
- **只能由文档证明的部分（Documented）：** vLLM-Ascend connector、容器设备挂载、`/etc/hccn.conf`、CANN/驱动版本要求、A3 fabric memory 等部署契约。
- **本次无法源码证明的部分（Unknown）：** “华为 MetaERP、小艺、华为云、终端云等内部产品广泛使用”、互联网大厂线上规模、SLA、采购量、客户数量。此类信息只能作为公开采用线索，不能升级为源码结论。

## 一页数据路径图

![Yuanrong DS 与 Mooncake 数据路径对比](openyuanrong-mooncake-data-path.svg)

图中把控制面和数据面分开，是为了避免把“依赖 Master 查询”误读成“数据经过 Master 中转”。Yuanrong 默认由 topology 把 key 分到多个 metadata owner；Mooncake Store 的 Query/PutStart/PutEnd 进入单 active Master，但拿到 replica descriptor 后由 client/TE 直连存储副本。另一条决定性边界是“KV 的产品语义在哪里形成”：Mooncake 在 Store/Connector 层直接把 hash block、复制、放置和跨实例复用作为一等对象；Yuanrong DS 在底层提供 object/heterogeneous object、L2 和 NPU 数据通道，KV block、prefix hash 和 vLLM 生命周期由上层 connector 组织。

## 1. 产品定位与架构差异

### Yuanrong DS

openEuler 官方项目页把 openYuanrong 定义为 Serverless 分布式计算引擎，数据系统提供“异构分布式多级缓存”以及 Object/Stream 语义，重点是函数实例之间的数据共享和传递（Documented）。这使它天然覆盖 AI、大数据和微服务，但 KVCache 不是唯一中心对象。

源码侧，设备对象 API 暴露 `MGetH2D`、`MSetD2H`、异步版本、`DevPublish/DevSubscribe` 等接口，并提供 `PreRegisterDeviceMemory`（`src/datasystem/client/object_cache/object_client_impl.h:581-619`）。这是一个“对象 key + device blob”模型：服务端保存对象，客户端指定目标 HBM 地址和 blob 切片。

### Mooncake

Mooncake README 明确将系统拆成 Transfer Engine、Mooncake Store、EP/PG；定位是以 KVCache 为中心的 LLM serving/training 基础设施（Documented，`mooncake-review/README.md:86-88`）。Store 负责分布式 KV cache 和模型权重；TE 负责跨存储、网络和加速器的数据搬运（`README.md:92-118`）。

这带来结构性差异：Mooncake 的调度和存储单元可直接对应 KV block、复制数、preferred segment、soft/hard pin；Yuanrong 的调度单元首先是 object/blob，KV 语义通过 vLLM connector 叠加。

## 2. 昇腾特性支持对比

### 2.1 Mooncake：昇腾路径多，但要选对构建模式

**源码已确认：** `multi_transport.cpp` 在 `USE_ASCEND_DIRECT` 下加载 `AscendDirectTransport`，在旧 `USE_ASCEND` 下加载 `HcclTransport`，还可在 `USE_ASCEND_HETEROGENEOUS` 下加载异构 RDMA transport（`mooncake-transfer-engine/src/multi_transport.cpp:38-46,467-480`）。Transfer Engine 初始化时安装 `ascend` transport（`src/transfer_engine_impl.cpp:227-233`），并把 NPU 物理卡号编码进 endpoint（`src/transfer_engine_impl.cpp:101-113,194-202`）。

**Documented：** 当前官方文档把 Ascend Direct Transport 标为推荐路径，基于 CANN ADXL，支持 Host-to-Device、Device-to-Host、Device-to-Device，并可在 HCCS 与 RDMA 间选择（`docs/source/design/transfer-engine/ascend_direct_transport.md:5-9`）。旧 Ascend Transport 文档明确写着“scheduled for deprecation”，并且旧路径主要是 NPU-to-NPU、Device-to-Device（`docs/source/design/transfer-engine/ascend_transport.md:5-13`）。

**额外能力：** `USE_UBSHMEM` 通过 CANN VMM APIs 提供 NPU shared-memory transport；构建文档要求 CANN、驱动和 Lingqu 版本组合。A3 的 fabric memory 模式允许 Mooncake Store 直接访问远端 host memory，但这依赖 CANN/HDK/驱动条件（Documented）。

**限制与运营成本：** Ascend Direct 文档要求先设置 device、容器挂载 `/etc/hccn.conf`、HCCS device memory 2 MiB 对齐；IPv6 仍有限制；CANN、ADXL、驱动、HCCN 配置是部署前置条件（`ascend_direct_transport.md:72-101`）。因此 Mooncake 的“昇腾支持”是高能力但强依赖版本/构建开关的支持，不等于 CUDA wheel 式开箱即用。

### 2.2 Yuanrong DS：昇腾数据面更深入到 RH2D/HIXL

**源码已确认：** HCCS transport 直接包含 HIXL，定义 `BUFFER_POOL`、`ROCE_DIRECT`、`FABRIC_MEM` 三种模式，支持 `RegisterMemory`、`PreRegisterDeviceMemory`、远端地址导入和 `ScatterBatch`（`src/datasystem/common/rdma/npu/hccs_transport.h:31-53,60-99`）。初始化会设置 ACL device、创建每设备 HIXL engine，并按环境变量 `HCCL_INTRA_ROCE_ENABLE` 选择 buffer-pool 或 RoCE-direct（`hccs_transport.cpp:54-72,136-214`）。

源码还存在 Ascend HCCL/P2P 通信封装，链路类型明确区分 HCCS、RoCE 和自动选择（`src/datasystem/common/device/ascend/p2phccl_types.h:41-52`），说明它不是只在文档层“宣称支持昇腾”。

**Documented：** RH2D 定义为“远端主机共享内存到设备 HBM”的跨节点通道；P2P-Transfer RoCE 与 HIXL HCCS 是两条部署路线。官方最佳实践提供 vLLM-Ascend + `AscendStoreConnector` 示例，并明确 `enable_remote_h2d`（`docs/source_zh_cn/best_practices/best_practices_for_rh2d.md:1-34,478-509`）。

**工程含义：** Yuanrong 更贴近昇腾的内存注册、HCCS、RoCE、ACL 生命周期和 NUMA/大页运维；对 A2/A3 集群，尤其是“远端 DRAM → 本地 HBM”的缓存回填，其路径表达比通用 RDMA 更细。

### 2.3 昇腾维度结论

- **纯 Ascend 原生深度：** Yuanrong DS 略占优，因其核心 API 和 transport 就围绕 ACL/HIXL/HCCS/RH2D 设计。
- **跨加速器和跨框架：** Mooncake 明显占优，TE 同时覆盖 TCP、RDMA、NVMe-oF、NVLink、HIP、CXL、Ascend 等协议，并有 vLLM/SGLang/TensorRT-LLM 接入（Documented，`README.md:94-112`）。
- **昇腾生产可复制性：** 两者都不是“只装 pip 包就完事”。Mooncake 要选 `USE_ASCEND_DIRECT`/`USE_UBSHMEM` 和 CANN/ADXL；Yuanrong 要配置 HIXL、RH2D、HCCN、ACL、共享内存和容器设备映射。

## 3. KV 存储能力

### 3.1 Mooncake Store

Mooncake Store 文档定位为 LLM inference 的分布式 KV cache storage engine，支持：

1. **DRAM + SSD/NVMe 多级容量**；
2. **大对象 striping、并行 I/O、端到端 zero-copy**；
3. **副本数、preferred segment、soft pin、hard pin 等 per-object 策略**；
4. **存储节点与推理 engine 解耦，节点可弹性增删**；
5. **跨实例 hash-prefix KV block 复用**。

这些是 README 的产品声明（`mooncake-review/README.md:116-131,181-190`），源码也能看到 placement/replica allocator、local SSD metrics 和 `PlacementTargetKind::CXL` 等结构（`mooncake-store/src/placement/replica_allocator.cpp:1-5,85-123`；`include/placement/target.h:11-33`）。因此它不只是“把 bytes 存远端”，而是具备 KV 池化所需的容量、放置和生命周期控制。

### 3.2 Yuanrong DS

Yuanrong DS 的核心存储是通用 object cache/heterogeneous object，叠加 L2 persistence、slot、spill/recovery 和共享内存。源码中的 `PersistenceApi` 提供 slot preload、merge、cleanup 等生命周期接口（`src/datasystem/common/l2cache/persistence_api.h:109-122`），worker 侧有 L2 cache、spill、primary copy 和 recovery 管理。

其 vLLM-Ascend 文档示例把后端配置成 `AscendStoreConnector`，KV role 为 `kv_both`，说明已经有面向 KV connector 的适配（`best_practices_for_rh2d.md:489-508`）。不过在本基线中，通用 DS API 并没有 Mooncake Store 那样明显的 prefix-hash block、replica/pin、KV-specific placement 表达；这些语义主要依赖 connector 和上层引擎（Inferred）。

### 3.3 存储维度结论

若需求是“做一个跨实例共享的 KVCache 池”，Mooncake Store 的抽象更短：block lookup → remote store → replica/evict → connector 回填。若需求是“把 KV、对象、流、训练中间态统一放进同一数据系统”，Yuanrong 的广度更好，但要自行定义 KV block 元数据、冷热策略和跨实例一致性。

## 4. KV 传输路径对比

### 4.1 Mooncake：以 Transfer Engine 为中心

TE 的 README 宣称具备批量传输、拓扑感知、多 NIC 带宽聚合和路径故障处理，并报告在 4×200 Gbps RoCE 上最高 87 GB/s、8×400 Gbps 上最高 190 GB/s；这些是项目基准，不是本次独立复测（`README.md:94-110`）。源码侧能确认 `MultiTransport` 的协议选择与批量聚合，但 Ascend Direct 的失败路径是刷新 segment metadata 后重试同一 ADXL 路径，未证明会自动降级到 TCP/RDMA 等另一 transport（`mooncake-transfer-engine/src/multi_transport.cpp:589-692`；`src/transport/ascend_transport/ascend_direct_transport/transfer_executor_base.cpp:653-708`）。

在 vLLM 中，`MooncakeConnector` 用于 PD 解耦，把 prefill worker 的 KV block 传给 decode worker；`MooncakeStoreConnector` 用于跨实例共享和 hash-prefix 复用（`README.md:181-192`）。这使“KV 传输”和“KV 存储”在同一套 object/segment/transport 模型中闭环。

### 4.2 Yuanrong：两类通道

1. **远端 Host → 本地 Device（RH2D）：** 适合 KV 在远端 DRAM/L2、目标是本地 HBM 的回填。HIXL HCCS 直接路径可预注册目标 HBM，避免热路径重复 `RegisterMem(MEM_DEVICE)`；RoCE 路径适合跨节点。
2. **Device ↔ Device / P2P：** HCCL P2P 和设备对象 API 支持 publish/subscribe、MGet/MSet；`P2pLink` 区分 HCCS/RoCE/Auto（源码已确认）。

官方最佳实践明确：预注册只适用于 `enable_remote_h2d=True` 且 HCCS RH2D，不适用于 P2P-Transfer RoCE；预注册和临时注册共享 HIXL 注册预算，建议使用连续 HBM 池（`best_practices_for_rh2d.md:372-382`）。源码进一步把有效设备注册上限控制在 253，并说明长期/临时注册共享 256 `MEM_DEVICE` 预算（`hccs_transport.cpp:49-52`）。

**这句判断如何从代码得出：**

- **Observed，Yuanrong 的接口边界：** `MGetH2D` 接收应用提供的 `DeviceBlobList`，同时公开 `PreRegisterDeviceMemory(void*, size)`（`src/datasystem/client/object_cache/object_client_impl.h:573-600`）；调用链更新 RemoteH2D 配置，随后把 `isRH2DSupported=true` 传入 `Get`，最后执行 `HostDataCopy2Device`（`object_client_impl.cpp:1816-1839,1930-1965`）。HCCS transport 自己持有 per-device HIXL engine、device/host 注册表，并暴露 register/import/scatter（`src/datasystem/common/rdma/npu/hccs_transport.h:31-53,60-99`）；运行时显式设置 ACL device、初始化 HIXL，并按 `HCCL_INTRA_ROCE_ENABLE` 选择 RoCE direct 或 buffer pool（`hccs_transport.cpp:49-60,136-214`）。
- **Observed，Mooncake 的接口边界：** TE 的通用 `TransferRequest` 只有 source pointer、target segment/offset、length、transport hint 和 task group（`mooncake-transfer-engine/include/transport/transport.h:49-75`）；`MultiTransport` 先为每个 request 选择 transport，再按 transport 分组批量提交（`src/multi_transport.cpp:138-204`）。具体 transport 由编译宏和协议字符串选择，包括 RDMA、TCP、NVMe-oF、Ascend Direct/HCCL/heterogeneous、HIP、CXL、UBSHMEM（`multi_transport.cpp:430-517`）。
- **Inferred，架构含义：** Yuanrong 把昇腾设备地址、注册预算和 HCCS/RoCE 模式暴露在数据系统边界，因此做 Ascend 专项内存池、预注册和链路调优时控制点更直接；Mooncake 把调用方约束收敛成统一 request/segment 模型，同一批调度器可复用多种 transport，因此新增 serving engine 或硬件时上层改动通常更小。这是基于接口耦合面的推断，不是性能结论。
- **可证伪条件：** 若 Mooncake connector 必须针对每种硬件复制大量调度逻辑，或 Yuanrong 可在不改上层接口的情况下动态加载非昇腾 transport，上述“专项优化 vs 复用”的差异应下调。最终仍需用同一模型、同一 block size、同一 CANN/驱动版本比较接入代码量和运行指标。

## 5. 昇腾底层传输专项源码比较

![Yuanrong 与 Mooncake 的昇腾底层传输链](openyuanrong-mooncake-ascend-transport.svg)

这张图按相同的四层纵轴排列两条实现，而不是照抄目录。真正拉开差异的是第二、三层：Yuanrong 先判断对象数据来自本地 Host 还是远端 Host，再把远端 source 交给 RH2D strategy；Mooncake 先把调用统一成 `TransferRequest`，再按 transport、segment/opcode、目标 endpoint 和本地 engine 分组。前者把“远端 Host cache 回填到 HBM”做成对象系统内的专项路径，后者把 H2D、D2H、D2D 组织成通用 ADXL 执行模型。

关键类关系见 [PlantUML 类图](openyuanrong-mooncake-ascend-transport.puml)。类图只画传输主干：Yuanrong 的 `RemoteH2DManager` 持有一个 `RH2DTransportStrategy`；Mooncake 的 `AscendDirectTransport` 同时拥有 dispatcher 和 executor，executor 再拥有本地 copy engine。

### 5.1 专项评分

以下是固定源码基线下的“能力与工程完整度评分”，不是吞吐、时延或稳定性实测分。0.1 分差只用于表达代码层面的相对强弱，不应被解读成可量化性能差。

| 底层传输维度 | Yuanrong | Mooncake | 评分依据 |
|---|---:|---:|---|
| RH2D：远端 Host→本地 NPU 专项完整度 | **4.8** | **4.4** | Yuanrong 把 remote source、root info、Host segment import、scatter 和目标 `DeviceBlobList` 串进 `MGetH2D`；Mooncake Ascend Direct 能做 H2D，但入口是通用 READ/WRITE，不携带对象 source-locality 语义（Y: `object_client_impl.cpp:1930-1965,2037-2170`；M: `transport.h:60-75`）。 |
| HCCS/HIXL/ADXL 控制深度 | **4.7** | **4.7** | Yuanrong 直接控制 HIXL mode、engine、注册预算和 `TransferSync`；Mooncake 直接配置 ADXL engine、AutoConnect、buffer pool、fabric mem、sync/async executor（Y: `hccs_transport.cpp:136-214,562-637`；M: `transfer_executor_base.cpp:103-294`）。 |
| HCCS/RoCE 多模式 | **4.6** | **4.7** | Yuanrong 在 `RemoteH2DManager` 选择 HCCS 或 RoCE；Mooncake Ascend Direct 可由 ADXL resource config/HCCL 环境切换底层模式，并另有 UBSHMEM。双方都没有证明运行期跨 transport 自动降级（Y: `remote_h2d_manager.cpp:740-759`；M: `utils.cpp:142-170`、`multi_transport.cpp:467-480`）。 |
| Device 内存注册可控性 | **4.7** | **4.5** | Yuanrong 暴露 HBM 预注册、253 个共享预算和临时注册回收；Mooncake 能识别 Host/NPU、批量 publish metadata、失败回滚，但默认只在当前 engine 注册（Y: `hccs_transport.cpp:412-462,579-637`；M: `ascend_direct_transport.cpp:349-457`、`transfer_executor_base.cpp:475-542`）。 |
| 多 NPU / 并发调度 | **3.7** | **4.6** | Yuanrong 能建立 per-device HIXL engines，但当前 `Connect`、device register 和 `ScatterBatch` 使用 `engines_.begin()`，且有单个 `transferMutex_`；Mooncake agent mode 建立每 NPU endpoint，并有 per-engine queue（Y: `hccs_transport.cpp:217-275,383-394,599-607`；M: `slice_dispatcher.cpp:109-210`）。 |
| H2D / D2H / D2D 对称性 | **4.0** | **4.7** | Yuanrong RH2D 专项只覆盖远端 Host→Device；`MSetD2H` 是本地 D2H 后发布，D2D 走另一套 device-object/P2P API。Mooncake READ/WRITE + pointer type + local/remote endpoint 覆盖三种方向（Y: `object_client_impl.cpp:2181-2233,2290-2327`；M: `local_copy_engine.cpp:99-147`）。 |
| 本地 copy 优化 | **4.3** | **4.7** | 两者都调用 ACL；Mooncake 显式区分 H2H/D2D/H2D/D2H，H2D/D2H 优先 `aclrtMemcpyBatch`，不支持时退回 async（Y: `client_device_object_manager.cpp:294-309`；M: `local_copy_engine.cpp:60-127,150-290`）。 |
| 批处理与分组 | **4.4** | **4.6** | Yuanrong 按 root info 聚合 `P2pScatterEntry`，HIXL 每批 1024 descriptor、RoCE 每批 16384 blobs；Mooncake 有 transport、task group、segment/opcode、endpoint/engine 多级分组（Y: `object_client_impl.cpp:2037-2170`、`hccs_transport.cpp:49-52`；M: `multi_transport.cpp:138-204`、`slice_dispatcher.cpp:65-99,131-160`）。 |
| 失败恢复 / endpoint 刷新 | **4.0** | **4.5** | Yuanrong 有 connection state、初始化回滚、disconnect 清理和 RoCE heartbeat；Mooncake retryable failure 会强制刷新 `SegmentDesc` 后再试一次。两者当前代码都不足以证明 Ascend 路径自动跨协议切换（Y: `remote_h2d_manager.cpp:281-373`；M: `transfer_executor_base.cpp:653-708`）。 |
| 传输可观测性 | **4.6** | **3.9** | Yuanrong 在 Get、source grouping、local/remote copy、comm wait、scatter 等阶段有 `PerfPoint`；Mooncake 有 trace/log 和状态计数，但 Ascend Direct 的阶段化指标较少（Y: `object_client_impl.cpp:1934-1965,2123-2177`；M: `multi_transport.cpp:662-668`）。 |
| 运行约束显式性 | **4.6** | **4.5** | Yuanrong 把 HIXL 8.5.2、253 registrations、1024 descriptors、5/10 秒同步限制写入构建和代码；Mooncake 把 thread/timeout/buffer-pool/async 互斥和 endpoint 配置显式化（Y: `FindAscend.cmake:93-123`、`hccs_transport.cpp:49-52`；M: `slice_dispatcher.cpp:34-55`、`transfer_executor_base.cpp:113-173`）。 |
| 跨硬件 / 跨框架复用 | **3.8** | **4.8** | Yuanrong 的 RH2D strategy 当前是 HCCS/RoCE 两种昇腾实现；Mooncake 的 `TransferRequest`/`MultiTransport` 同时承载多种加速器与网络 transport（Y: `remote_h2d_manager.cpp:740-759`；M: `multi_transport.cpp:430-517,589-692`）。 |

**专项结论：** 如果 workload 的主链就是“对象已在远端 Host cache，按 object key 取回并落入调用方给定的 NPU buffer”，Yuanrong 的代码更短、更显式。若需要同一传输层同时覆盖 H2D、D2H、D2D、多 NPU endpoint，并被多个 serving engine 复用，Mooncake Ascend Direct 的调度层次更完整。Yuanrong 当前最值得优先验证的是 HCCS 的实际多 engine 并行度；Mooncake 最值得验证的是复杂 build/config 组合、metadata plugin 可用性和 retry 后的 P99。

### 5.2 入口语义与实际调用链

**Yuanrong RH2D（Observed）：**

1. `MGetH2D` 接收 `objectKeys + DeviceBlobList`，更新客户端 RH2D 配置后进入 `MGetH2DImpl`（`src/datasystem/client/object_cache/object_client_impl.cpp:1816-1839`）。同步实现把 `isRH2DSupported=true` 传给 `Get`，保留返回的 `Buffer` 生命周期，再执行 `HostDataCopy2Device`（`object_client_impl.cpp:1930-1965`）。异步实现把 RPC Get 和 copy 放在两个线程池阶段（`object_client_impl.cpp:1864-1927`）。
2. `HostDataCopy2Device` 在 RH2D 关闭时统一做 ACL Host→Device copy；开启时依据 `Buffer::GetRemoteHostInfo()` 分成本地 source 与远端 source，远端 source 再按 root info 分组（`object_client_impl.cpp:2123-2170`）。
3. 远端组把远端 Host VA、目标 device pointers 和长度数组装成 `P2pScatterEntry`，导入 Host segment 后调用 `RemoteH2DManager::ScatterBatch`（`object_client_impl.cpp:2037-2118`）。manager 等待连接初始化完成，并用 communicator mutex 保证同一 context 的操作串行，再转给 transport strategy（`src/datasystem/common/rdma/npu/remote_h2d_manager.cpp:675-691`）。
4. `remote_h2d_link_type=ROCE` 创建 `RoCETransport`，`HCCS` 创建 `HCCSTransport`；请求 HCCS 但构建时没有 HIXL 会直接 fatal（`remote_h2d_manager.cpp:740-759`）。

**Yuanrong 的方向边界（Observed）：** `MSetD2H` 先 `MultiCreate` 本地 Host buffer，再调用 `MemCopyBetweenDevAndHost(... DEVICE_TO_HOST ...)`，最后 `MultiPublish`（`object_client_impl.cpp:2181-2233,2290-2327`）。因此 Yuanrong 的 `MGetH2D` 与 `MSetD2H` API 名称虽然对称，底层远端 transport 并不对称：远端专项是 RH2D，D2H 是先落本地 Host object。Device↔Device 由 `DevPublish/DevSubscribe/DevMGet/DevMSet` 等另一组接口承担（`src/datasystem/client/object_cache/object_client_impl.h:620-670`），不能把三条路径合并描述成一个双向 RH2D transport。

**Mooncake Ascend Direct（Observed）：**

1. `TransferRequest` 统一定义 READ/WRITE、local source、remote `target_id + target_offset`、length、retry hint、transport hint 和 task group（`mooncake-transfer-engine/include/transport/transport.h:60-75`）。`MultiTransport` 先逐 request 调 `selectTransport`，再按 transport 聚合 `TransferTask` 提交（`mooncake-transfer-engine/src/multi_transport.cpp:138-204`）。
2. `selectTransport` 读取目标 `SegmentDesc.protocol`；Ascend segment 的 protocol 为 `ascend`，构建宏决定装配 `AscendDirectTransport`、旧 `HcclTransport` 或 `HeterogeneousRdmaTransport`（`multi_transport.cpp:467-480,589-692`）。这是一种 build-time implementation choice，不是一次传输失败后的 runtime failover。
3. Ascend Direct 为每个 request 调一次 `InitializeSlice`，所以当前实现是“一 request 一 slice”；随后 dispatcher 按 `(target_id, opcode)` 分组，RoCE agent 模式再按 `(engine_idx, target_id, opcode)` 分组（`src/transport/ascend_transport/ascend_direct_transport/ascend_direct_transport.cpp:85-97,254-318`；`slice_dispatcher.cpp:65-99,131-160`）。
4. executor 再依据目标地址落在哪个 `BufferDesc`，用 `device_id` 选择远端 ADXL endpoint；同 endpoint 且非 fabric-memory 时走 `LocalCopyEngine`，否则调用 ADXL sync/async transfer（`transfer_executor_base.cpp:47-78,615-689`）。

### 5.3 地址发现、内存注册与链路选择

| 问题 | Yuanrong | Mooncake |
|---|---|---|
| endpoint 如何产生 | RoCE identity 是 HCCL root info 的 Base64；HCCS 为 HIXL `ip:port`。`RemoteH2DContext` 缓存 remote endpoint、local identity、link type、stream 与初始化状态（`remote_h2d_manager.h:49-72`；`roce_transport.cpp:92-97`）。 | `SegmentDesc` 发布 protocol、endpoints、buffers、`BufferDesc.device_id` 和 `metadata_version`（`mooncake-transfer-engine/include/transfer_metadata.h:56-80,90-123`）。agent mode 为所有本地 NPU 建 endpoint，普通模式只使用当前 device（`ascend_direct_transport.cpp:181-251`）。 |
| endpoint 如何交换 | worker 把 root info/endpoint 随 remote-host metadata 返回；client 以 root info 为 communicator key，连接可异步初始化，失败时 rollback、disconnect 并清理 heartbeat map（`remote_h2d_manager.cpp:241-279,281-440`）。 | segment descriptor 由 metadata plugin 或 P2P handshake 发布/获取；远端 lookup 可缓存，`force_update=true` 会重新拉取（`mooncake-transfer-engine/src/transfer_metadata.cpp:1460-1492,1517-1554`）。 |
| Host source 注册 | HCCS buffer-pool 不注册 Host source；HIXL RoCE-direct 在 worker 按当前 device 注册 `MEM_HOST`（`hccs_transport.cpp:329-362`）。RoCE 路径调用 `DSP2PRegisterHostMem`（`roce_transport.cpp:163-165`）。 | location 可明确写 `cpu*`/`npu*`，也可用 `aclrtPointerGetAttributes` 推断；buffer-pool 模式跳过 Host 注册（`ascend_direct_transport.cpp:50-75`；`transfer_executor_base.cpp:475-482`）。 |
| Device destination 注册 | HCCS 可通过公开 API 长期预注册 HBM；未命中时 batch 内临时注册，二者共享 253 个预算（`object_client_impl.cpp:1969-1998`；`hccs_transport.cpp:412-462,579-637`）。 | 先把 `BufferDesc` 加入 metadata，再调用 ADXL `RegisterMem`；失败则移除 metadata。batch 注册最后只 publish 一次（`ascend_direct_transport.cpp:349-397,418-457`）。 |
| HCCS/RoCE 选择 | `RemoteH2DManager::CreateTransport` 依据单一 flag 选择 HCCS 或 RoCE；没有看到同一请求自动改走另一 strategy（`remote_h2d_manager.cpp:740-759`）。 | `HCCL_INTRA_ROCE_ENABLE=1` 或 `ASCEND_GLOBAL_RESOURCE_CONFIG` 中含 RoCE protocol 决定 ADXL 资源模式（`utils.cpp:142-170`）。这仍是 Ascend Direct 内部配置，不等同于跨 TE transport failover。 |

**多 NPU 的关键差异（Observed）：** Yuanrong 的 worker 能为多个 device 创建 HIXL engine，连接 identity 也按 engine round-robin 返回（`hccs_transport.cpp:136-228`），但实际 `Connect`、device memory register 和 `ScatterBatch` 均选 `engines_.begin()`（`hccs_transport.cpp:231-275,383-394,599-607`）。所以“发布多个 device endpoint”不能直接推导成“传输负载自动分摊到多个 engine”。Mooncake Ascend Direct 在 agent mode 为每个本地 NPU 建 context/endpoint，RoCE dispatcher 为每个 ADXL engine 建独立线程和队列，且目标 `BufferDesc.device_id` 参与远端 endpoint 选择（`context_manager.cpp:43-130`；`slice_dispatcher.cpp:109-210`；`transfer_executor_base.cpp:47-78`）。

### 5.4 批处理、并发与本地 copy

**Yuanrong（Observed）：** HCCS 把多个 `P2pScatterEntry` 展开为 HIXL `TransferOpDesc`，达到 1024 descriptors 就 flush；每次 flush 是 `Hixl::TransferSync(... READ ..., 10000)`（`hccs_transport.cpp:49-52,562-637`）。同一个 `HCCSTransport` 的 `ScatterBatch` 被全局 `transferMutex_` 包住，该 mutex 同时保护注册生命周期（`hccs_transport.h:94-99`；`hccs_transport.cpp:599-607`）。RoCE 则按最多 16384 blobs 拆批，每批调用 DSP2P scatter 后同步 stream，超时 5000 ms；连接 map 锁在拿到 `shared_ptr` 后释放，不把所有 endpoint 的网络等待串在一起（`roce_transport.cpp:77-82,187-282`）。

**Mooncake（Observed）：** 默认 dispatcher 线程池为 8、最大 16，buffer-pool 强制为 1；每个工作线程在执行前设置 ACL context（`slice_dispatcher.cpp:34-99`）。本地 endpoint 且非 fabric-memory 时不走 ADXL remote transfer：`LocalCopyEngine` 对 H2H/default 用同步 copy，D2D 用 async，H2D/D2H 优先 `aclrtMemcpyBatch`，单批最多 4096，runtime 不支持 batch 时回退到 async（`local_copy_engine.cpp:27-29,60-127,129-290`）。远端路径的 sync executor 把同组 slices 组成 `TransferOpDesc` 数组后调用一次 `TransferSync`（`sync_transfer_executor.cpp:46-95`）。

**对“Mooncake 传输切片”的修正：** `TransferTask` 确实维护 `slice_count`、成功/失败计数和 `slice_list`（`mooncake-transfer-engine/include/transport/transport.h:337-377`），多种 transport 也可自行产生多个 slice；但在本基线的 Ascend Direct 提交实现中，每个 request 只创建一个 slice（`ascend_direct_transport.cpp:276-285,302-313`）。因此准确表述是“统一 task/slice 状态模型并多级分组”，而不是“Ascend Direct 会自动把大 request 切成多个小片”。

### 5.5 失败路径、硬约束与可观测性

**连接与失败：** Yuanrong 的 `RemoteH2DContext` 有 UNINITIALIZED/INITIALIZING/INITIALIZED 状态，连接失败会 disconnect、清 heartbeat map、删除 communicator 并唤醒等待者（`remote_h2d_manager.cpp:281-373`）；heartbeat 只在 RoCE link 上安装（`remote_h2d_manager.cpp:339-356`）。Mooncake sync/async executor 支持 connect/transfer timeout、short connection 和 AutoConnect；retryable failure 最多两次，第二次以 `force_update=true` 刷新 segment descriptor（`transfer_executor_base.cpp:39,113-167,653-708`）。这证明的是“同一路径刷新 endpoint 后重试”，不是“自动跨协议故障切换”。

**构建与运行包线：** Yuanrong 的 HCCS 编译要求 `cann_hixl`、HIXL headers、`metadef`，且 HIXL 版本不低于 8.5.2；否则不编译 `hccs_transport.cpp`，只保留 RoCE 实现（`cmake/modules/FindAscend.cmake:27-69,93-123`；`src/datasystem/common/rdma/CMakeLists.txt:36-53,79-82`）。`FABRIC_MEM` 枚举已经存在，但当前 `DetermineHixlMemoryMode` 注释明确尚未接入对应 flag，运行时只返回 BUFFER_POOL 或 ROCE_DIRECT（`hccs_transport.cpp:54-60`）。Mooncake 则有 `USE_ASCEND`、`USE_ASCEND_DIRECT`、`USE_UBSHMEM`、`USE_ASCEND_HETEROGENEOUS` 四条构建路径，源码目录的 `if/elseif` 也表明这些实现并非全部叠加到一个 ascend transport 中（`mooncake-common/common.cmake:104-111,610-627`；`mooncake-transfer-engine/src/transport/ascend_transport/CMakeLists.txt:1-12`）。

**额外路径：** Mooncake UBSHMEM 发布 IPC key 或 fabric shareable handle，远端导入后 reserve/map VMM 地址，再用多 stream `aclrtMemcpyAsync`（`ubshmem_transport.cpp:59-111,315-457,577-718`）。`HeterogeneousRdmaTransport` 对 NPU source 先做 D2H 到预分配 Host staging，再交给 RDMA；小块还可先 D2D 聚合到大 device block，因此它不能被描述成 direct NPU RDMA（`heterogeneous_rdma_transport.cpp:102-162,246-303,350-445`）。Yuanrong 另有默认关闭、依赖 `BUILD_WITH_URMA` 的 `BUILD_PIPLN_H2D`（`CMakeLists.txt:140-143`；`cmake/dependency.cmake:34-39`），但 client 和 pipeline API 仍构造 `TargetDeviceType::CUDA`（`src/datasystem/client/object_cache/object_client_impl.cpp:3355-3380`；`src/datasystem/common/os_transport_pipeline/os_transport_pipeline_api_impl.cpp:51-65,257-276`）。在没有补充 runtime/driver 实测前，本报告只确认“pipeline mechanism 存在”，不把它升级为已验证的 Ascend 原生 RH2D。

**可观测性：** Yuanrong 在 `MGetH2D`、Get、copy、source grouping、local/remote copy、comm wait 和 scatter 等边界设置 `PerfPoint`，并为 HCCS/RoCE 的 endpoint、device、batch、timeout 输出结构化日志（`object_client_impl.cpp:1816-1823,1934-1965,2123-2177`；`remote_h2d_manager.cpp:675-691`）。Mooncake 可通过 `globalConfig().trace` 输出 transport 选择，并在 executor/local-copy 中记录状态和错误；不过本基线没有看到与 Yuanrong 同粒度的 Ascend Direct 分阶段指标，因此可观测性评分略低（`multi_transport.cpp:662-668`；`local_copy_engine.cpp:60-127`）。

### 5.6 选型与验证建议

- **优先 Yuanrong：** 目标是远端 Host object/cache 回填本地 HBM，团队需要直接控制 HIXL mode、HBM 预注册、注册预算、HCCS/RoCE 选择，并愿意围绕 Ascend 做专项优化。
- **优先 Mooncake：** 目标是一个统一 READ/WRITE 传输层覆盖 H2D/D2H/D2D、多 NPU endpoint、同机共享内存与跨硬件 connector，且更看重框架复用。
- **必须实测 Yuanrong：** `engines_.begin()` 与 `transferMutex_` 对多 NPU、多连接、多流吞吐和 P99 的影响；253 registration budget 用尽时的临时注册退化；HCCS 与 RoCE 的恢复时间。
- **必须实测 Mooncake：** buffer-pool 单线程、sync/async 互斥、默认只在当前 engine 注册、metadata refresh 重试、UBSHMEM/fabric-memory 版本矩阵，以及 Store TE 与普通 TE 的配置隔离。
- **共同测试法：** 固定 A2/A3、CANN/driver、NUMA、block size 和并发，分别测 local H2D、remote H2D、D2H、D2D；同时记录 registration count、connect 次数、metadata lookup、队列等待、ACL/ADXL/HIXL sync 时间和 P50/P99，避免只看总带宽。

## 6. 元数据架构、一致性、HA 与演进能力

### 6.1 “Yuanrong 去中心化、Mooncake 依赖 Master”是否成立

**结论：对 Mooncake Store 和 Yuanrong 默认 distributed-master 模式而言，这个说法方向上成立。更准确的表述是：Yuanrong 是“分布式 metadata-owner”，Mooncake Store 是“单 active Master 元数据控制面”；但 Yuanrong 不是完全无控制中心，Mooncake 的数据搬运也不经过 Master 中转。**

> **建议对外口径：** Yuanrong 默认把对象元数据 ownership 按 key 分散到多个 worker/master 实例；Mooncake Store 把对象、replica、lease 和 placement 的裁决集中在一个 active Master，因此普通冷查询和写入生命周期需要访问 Master。Mooncake 可复用 lease 未过期的 `QueryResult`，且真正的 KV payload 由 client/TE 与 replica 直接传输，所以不能简化成“每次读都查 Master”或“数据经过 Master”。

| 控制面问题 | Yuanrong DS | Mooncake Store |
|---|---|---|
| 元数据 owner | 默认 `enable_distributed_master=true`；object key 经 topology placement 定位到不同 `committedOwnerAddress`。 | 单个逻辑 active `MasterService` 保存对象、replica、lease、placement/task 状态；standby 用于接管，不共同分担在线读写。 |
| 读路径是否查询 master | worker 根据本地 topology 计算目标 metadata owner；请求仍会发给对应 owner，迁移期间可 redirect。不是“完全不查 master”，而是“查分片 owner，不查单一全局 master”。 | 普通 `Get(key)` 先 `Query`，后者 RPC 调 `GetReplicaList`；拿到 replica descriptor 与 lease 后，数据由 client/TE 直接从 replica 传输，不经过 master。调用方也可复用未过期的 `QueryResult`。 |
| 写路径 | key 可批量按 owner 分组，发往不同 metadata owner；owner 随 topology 迁移并恢复。 | `Put` 先向 master `PutStart` 获取 replica descriptors，传完数据后再 `PutEnd`；对象分配与提交由 master 裁决。 |
| 横向扩展含义 | metadata CPU、锁和容量可随 worker/owner 分片横向扩展，但 topology 变更、跨 owner 操作、迁移和恢复更复杂。 | client 与存储节点可扩展，数据面可并行；metadata 写入与查询入口仍受单 active master 的容量和 failover pause 约束。进程内分片能增大并发，但不等于跨节点 metadata sharding。 |

**Yuanrong 的源码证据（Observed）：**

- 分布式 master 默认开启：`DS_DEFINE_bool(enable_distributed_master, true, ...)`（`src/datasystem/worker/worker_oc_server.cpp:96-100`）。启动时 `centralizedMetadata = !enable_distributed_master`，并把 topology placement、membership 和 metadata mode 注入每个 worker（`worker_oc_server.cpp:1119-1154`）。
- `ResolveMetaOwner` 在 centralized mode 返回固定 `masterAddress`；否则调用 `placement->Locate(objectKey)` 并采用 `committedOwnerAddress`。批量接口用 `LocateBatch` 把 key 分组给不同 owner（`src/datasystem/worker/object_cache/object_meta_route_helper.cpp:46-57,59-109`）。这段分支是“支持中心化和分布式两种部署”的直接证据。
- worker 的查询/恢复/淘汰路径实际调用上述路由；例如 `GetMetaAddress` 用 topology placement 解析 owner（`src/datasystem/worker/object_cache/service/worker_oc_service_get_impl.cpp:2638-2643`），metadata recovery 也按最新 owner 分组回推（`metadata_recovery_manager.cpp:170-214`）。每个 worker 可创建本地 `OCMetadataManager`/`SCMetadataManager`（`src/datasystem/master/metadata_manager_holder.cpp:78-106`）。
- 因此更准确的名称是 **分布式 metadata-owner 架构**，不是“没有 master/control plane”。topology 仍依赖 coordination backend，owner 上仍运行 master service，迁移期仍有 redirect 和 master-to-master/worker RPC。

**Mooncake 的源码证据（Observed）：**

- 普通 `Client::Get(key, slices)` 先调用 `Query(key)`（`mooncake-store/src/client_service.cpp:1139-1145`）；`Query` 调 `master_client_.GetReplicaList`，并把 replica list 和 lease TTL 封装成 `QueryResult`（`client_service.cpp:1211-1222`）。RPC handler 再进入 `MasterService::GetReplicaList`（`mooncake-store/src/rpc_service.cpp:272-290`）。
- 数据搬运本身不是 master 中转：拿到 `QueryResult` 后，client 选 replica 并执行 `TransferRead`/DFS read（`client_service.cpp:1352-1376`）。API 还允许调用者传入之前查询得到且 lease 未过期的 `QueryResult`（`mooncake-store/include/client_service.h:184-198`）。所以准确说法是“metadata lookup 依赖 master，data plane 不依赖 master 转发”。
- `Put` 明确经过 `master_client_.PutStart` 和传输后的 `PutEnd`（`client_service.cpp:1881-1905,1972-1982`）；服务端注册的 RPC 也把 `GetReplicaList`、`PutStart`、`PutEnd` 绑定到同一个 `WrappedMasterService`（`rpc_service.cpp:1748-1774`）。
- `MasterService` 内部有 1024 个 metadata shard，并按 tenant/key hash 加锁（`mooncake-store/include/master_service.h:1691-1730,1940-1953`）。这是 **单 active master 进程内并发分片**，源码未显示把不同 shard 分配给多个同时 serving 的 master。HA supervisor 只在 leadership、恢复和 preflight 通过后开放一个 serving service（`mooncake-store/src/ha/leadership/master_service_supervisor.cpp:443-560`）。
- Mooncake TE 的 segment/RPC metadata 是另一条链路，可选 Redis/HTTP/etcd plugin 或 P2P handshake（`mooncake-transfer-engine/src/transfer_metadata_plugin.cpp:544-595`；`transfer_metadata.cpp:1620-1668`）；不能据此把 Mooncake Store 的对象 placement metadata 也称为去中心化。

**竞争含义（Inferred）：** 在 metadata QPS 或对象数随 worker 数增长的场景，Yuanrong 的 owner 分片提供了更直接的横向扩展路径；Mooncake 的单 active Master 更容易形成单一裁决顺序、统一 placement 和相对简单的故障切换语义。前者付出的成本是 topology、迁移、redirect 和跨 owner 协调，后者付出的成本是 Master 容量上限和 failover 窗口。当前没有同规模压测，不能只凭架构判定实际 QPS、P99、扩展效率或恢复时间。

### 6.2 元数据一致性：两边都不能概括成“全局强一致”

**Yuanrong object metadata 按 write mode 变化（Observed）：** `ObjectMetaStore` 定义 `ROCKS_ONLY`、`ROCKS_ASYNC_ETCD`、`ROCKS_SYNC_ETCD` 三种写入类型（`src/datasystem/master/object_cache/store/object_meta_store.h:90-93`）。映射关系是：无 L2 → Rocks-only，write-back → Rocks + 异步 etcd，write-through → Rocks + 同步 etcd（`src/datasystem/master/object_cache/oc_metadata_manager.cpp:3818-3829`）。同步路径在返回前执行 etcd `Put/BatchPut`；异步路径按 object key hash 进入队列（`object_meta_store.cpp:288-344`）。队列满时源码会移除一个旧 operation（`object_meta_store.cpp:257-285`）。因此：

- write-through 可表述为“单条更新同步传播到 etcd”；
- write-back 存在本地 RocksDB 与 etcd 的暂时不一致窗口，并需把队列溢出纳入故障测试；
- Rocks-only 不提供 etcd 持久化语义；
- 上述行为不能外推为所有对象、引用计数和跨 owner 操作的全局线性一致性。

**Yuanrong topology 是另一套一致性域（Observed）：** topology CAS 强制 `desired.version = expectedVersion + 1`，冲突后 read-back，同版本但 canonical bytes 不同会被拒绝（`src/datasystem/cluster/repository/topology_repository.cpp:172-217`）。snapshot publication 区分 version gap、conflict、rollback（`src/datasystem/cluster/runtime/topology_snapshot_state.h:24-63`），权威状态回滚或同版本 digest 冲突会进入 `ROLE_ISOLATED`（`src/datasystem/cluster/runtime/topology_engine.cpp:386-415`）。这能证明 topology control plane 有单调版本和 digest fencing，不能证明 object metadata 全局强一致。仓库虽有通用 `EtcdElector` 实现，但全仓未发现它在 object metadata master 运行链路中的调用者，因此本报告不把 Yuanrong 描述成“依靠 etcd leader election 的 master HA”。

**Mooncake Store HA oplog 的一致性（Observed）：**

- producer view 只能单调 claim，旧 view 会被 fencing（`mooncake-store/src/ha/oplog/oplog_batch_storage.cpp:175-241`）；写 batch 时一个 backend transaction 同时比较 producer view 和 durable prefix，并同时写 batch record、推进 prefix（`oplog_batch_storage.cpp:323-419`）。
- ordered writer 顺序分配 sequence ID，transaction 成功后才推进本地 durable prefix 并进入 callback 队列；transaction fencing 进入 terminal state，可重试错误指数退避（`ordered_oplog_writer.cpp:198-242,330-478`）。
- standby reader 拒绝 prefix 回退、batch/sequence gap；applier 校验 checksum、去重并按顺序应用（`oplog_batch_standby_reader.cpp:52-183`；`oplog_applier.cpp:25-120`）。

但业务 mutation 的可见性点并不统一：`PutEnd` 先更新 metadata、授予 read lease、发布 stored event，之后才调用 `AppendOpLogVisibleBeforeDurable`（`mooncake-store/src/master_service.cpp:4945-4964,13741-13775`）；部分删除/cleanup 则用 durable callback 完成最终删除（`master_service.cpp:2728-2788,13777-13830`）。因此更准确的结论是：**oplog 对日志顺序、producer view 和 durable prefix 有事务 fencing，但不能写成“所有 metadata mutation 都在可见前同步持久化”。**

### 6.3 HA 与故障恢复

| 故障场景 | Yuanrong DS | Mooncake Store |
|---|---|---|
| metadata owner/master 故障 | topology failure callback 恢复 object/stream owner，并清理失败节点状态。 | lease 选主，standby 恢复完成且再次 renew preflight 后才 serving；丢 leadership 立即关闭 service。 |
| worker 重启 | 可从本地/L2 metadata 恢复，并按最新 topology owner 回推；功能默认关闭且对象类型/write mode 有限制。 | client/segment heartbeat 与 master cleanup 处理存储节点状态；master 自身恢复依赖 snapshot/oplog capability。 |
| 持久化数据/slot | distributed-disk 模式有 incident、claim、complete/fail、重启接管流程。 | snapshot bootstrap + oplog catch-up；无 snapshot/oplog capability 时 standby controller 会退化为 noop。 |
| 默认开关/组合约束 | `enable_metadata_recovery=false`；slot recovery 依赖 `l2_cache_type=distributed_disk`。 | `enable_ha=false`；oplog 要求 HA 且当前要求 etcd backend。 |

**Yuanrong（Observed）：** metadata restart recovery 默认关闭（`src/datasystem/worker/object_cache/metadata_recovery_manager.cpp:36`），只恢复 binary、L2 write-through/write-back/write-back-evict 且非 invalid 的对象（`metadata_recovery_manager.cpp:41-67`）。恢复对象被设为本地 primary copy（`metadata_recovery_manager.cpp:303-350`），再按当前 topology owner 分组回推 metadata（`metadata_recovery_manager.cpp:170-214,502-557`）。topology failure callback 对 object/stream 做恢复和本地清理（`src/datasystem/worker/worker_topology_phase_callbacks.cpp:192-257`）。distributed-disk 模式另有 slot recovery 的 incident 规划、CAS、claim/complete/fail 和重启接管（`src/datasystem/worker/object_cache/slot_recovery_manager.cpp:475-570,636-960,1340-1349`）。

**Mooncake（Observed）：** HA 默认关闭（`mooncake-store/src/master.cpp:185-186`）；启用时必须有 backend connection string，oplog 要求 `enable_ha=true` 且当前要求 etcd（`master.cpp:1446-1462`）。etcd leader acquisition 创建带 lease 的 master-view key 并保存 view version/owner token，keepalive 停止触发 leadership-lost callback（`src/ha/leadership/backends/etcd/etcd_leader_coordinator.cpp:193-259,262-335`）。supervisor 在 promotion state restore 后再次 renew leadership，才开放服务；丢 leadership 或 oplog writer terminal 会立刻 `SetServiceAvailable(false)` 并 stop server（`src/ha/leadership/master_service_supervisor.cpp:352-560`）。standby 只有在 snapshot bootstrap 或 `enable_oplog && backend=etcd` 时具有恢复能力，否则退为 noop controller（`src/ha/standby_controller.cpp:18-45,382-393`）。所以 Mooncake 有真实 active/standby HA 实现，但“开启 HA”不自动等于“standby 拥有可恢复状态”。

### 6.4 特性成熟度

**Observed 的工程信号：** 固定 checkout 中，Yuanrong `tests/` 有 656 个文件，其中名称包含 recovery/fail/dfx/etcd/slot/topology 的约 37 个；覆盖 metadata recovery、slot end-to-end、topology 和 etcd store。Mooncake Store/TE 相关测试目录有 246 个文件，其中名称包含 HA/fail/snapshot/oplog/standby/transport 的约 78 个；包括 etcd leader hang E2E、Redis/K8s leadership、oplog codec/storage/writer/reader/applier、snapshot promotion 和 hot standby。

**评分为什么仍都是 4.0/5：** 测试文件数量说明工程投入，不等于测试通过率或生产 SLA。Yuanrong 的 metadata recovery 默认关闭且恢复对象有边界；Mooncake 的 HA 也默认关闭，oplog/snapshot/backend 存在组合约束和 noop fallback。本报告未在固定 CANN、etcd、Redis、K8s 和 distributed-disk 环境执行两仓全量故障测试，因此不把任一方标为“完整 HA”或“生产成熟度已审计”。

### 6.5 框架可扩展性

**Yuanrong（4.0/5）：** `DsClient` 同时暴露 KV/Hetero/Object（`include/datasystem/datasystem.h:25-71`），另有 producer/subscribe/delete 的 Stream API（`include/datasystem/stream_client.h:41-162`）；coordination backend 抽象可由 etcd 或 DS coordinator 实现。它的优势是语义面广、数据与 metadata owner 可横向分片。限制是 L2 persistence factory 仍用 `l2_cache_type` 的硬编码分支选择 `AggregatedPersistenceApi`/`ObjectPersistenceApi`（`src/datasystem/common/l2cache/persistence_api.cpp:37-50`），新增 backend 通常要修改核心 factory 和构建。

**Mooncake（4.5/5）：** 通用 `TransferRequest` 把 source pointer、target segment/offset、length 和 hint/group 固定成统一契约（`mooncake-transfer-engine/include/transport/transport.h:49-75`）；`MultiTransport` 统一选路并按 transport 批量提交（`src/multi_transport.cpp:138-204`）。Connector/TE/Store 分层使 serving engine、传输协议和存储生命周期可以相对独立演进。限制是 transport 创建仍是编译宏 + 协议字符串分支（`multi_transport.cpp:430-517`），metadata storage plugin 也硬编码 Redis/HTTP/etcd factory（`transfer_metadata_plugin.cpp:544-595`），因此它是“统一接口”，不是完全动态的插件系统。

### 6.6 可演进性

**Yuanrong（3.5/5）：** topology codec 写入并严格校验 `SCHEMA_VERSION="1"`（`src/datasystem/cluster/repository/topology_repository_codec.cpp:35,156-185`），membership value 编解码 `compatibility_version` 且兼容 legacy etcd value（`src/datasystem/cluster/membership/membership_value_codec.cpp:157-204`）。这些机制有助于拒绝不兼容状态。明确扣分项是当前 RPC protobuf 注释写明 timeout 字段单位发生不兼容变化，不支持与旧二进制 rolling upgrade，部署需要 worker + master + client 全量重启（`src/datasystem/protos/meta_zmq.proto:62-67`）。

**Mooncake（4.0/5）：** oplog batch/durable prefix 有 schema version 并在解码时拒绝未知版本（`mooncake-store/include/ha/oplog/oplog_batch_types.h:11-34`；`src/ha/oplog/oplog_batch_codec.cpp:150-183,196-229`）；snapshot manifest 和 batch-oplog metadata 也校验 protocol/version/schema（`src/ha/snapshot/catalog_backed_snapshot_provider.cpp:70-97`；`src/ha/snapshot/batch_oplog/metadata.cpp:123-178`）。TE metadata 用单调 `metadata_version` 和 republish/handshake 处理 endpoint 更新（`mooncake-transfer-engine/src/transfer_metadata.cpp:1517-1554,1620-1717`）。但当前 codec 主要是“未知版本拒绝”，不是多版本 migration 证明；Connector × Store × TE × transport build flags × HA backend 会形成较大的兼容矩阵。

**综合推断：** Mooncake 的层次边界更适合分别替换 connector、transport 和 store，故可演进性略高；Yuanrong 的统一数据系统降低多数据模型的运维碎片，但协议和 owner/recovery 状态耦合更深。要验证这一判断，应做 N/N+1 混部、双版本 client、snapshot/oplog 升级和 topology schema 升级演练，而不是只看 schema 字段是否存在。

## 7. 国内互联网厂商使用与生态

### 已有较强公开证据的 Mooncake 使用者

| 厂商/项目 | 公开证据 | 证据等级
|---|---|---|
| 月之暗面 / Kimi | Mooncake 官方 README 称其为 Kimi 的 serving platform，并报告真实负载下请求承载提升 75%；另有 Kimi-K2 128 H200 PD/EP 部署记录（项目/团队声明）。 | Documented，且有产品归属；具体 75% 未独立审计。
| 腾讯 + NVIDIA / FlexKV | Mooncake README 记录 FlexKV 已支持通过 Mooncake TE 做 distributed KVCache reuse；FlexKV 是腾讯与 NVIDIA 的分布式 KV 系统。 | Documented，项目集成证据；不等于腾讯所有在线业务已切换。
| 阿里 / ROLL | Mooncake README 记录与 Alibaba ROLL 合作；阿里云开发者文章进一步声称阿里云、蚂蚁内部部署。 | 官方项目更新 + 二手文章；内部部署规模未知。
| 京东 / xLLM | Mooncake README 记录 xLLM 基于 Mooncake 构建 hybrid/global KV cache，支持 offload/prefetch。 | Documented，项目集成证据。
| SGLang、vLLM、LMCache、TensorRT-LLM | 官方 upstream 集成 Mooncake TE/Store，覆盖 PD disaggregation、HiCache、KV connector 和 remote connector。 | 源码/官方文档可验证集成；各公司生产规模未知。

### Yuanrong 的公开采用画像

- openEuler 官方项目页确认其产品定位是统一 Serverless 分布式计算引擎，数据系统覆盖异构多级缓存；这是社区/项目层证据，不是互联网客户名单。
- Yuanrong DS 官方最佳实践已经给出 vLLM-Ascend `AscendStoreConnector`、RH2D、HIXL HCCS、P2P RoCE 的端到端样例，说明“昇腾 + vLLM connector”具备公开可调测路径（Documented）。
- 公开新闻/社区材料更多把 openYuanrong 与华为 MetaERP、小艺、华为云、终端云、ICT、海思等华为体系产品联系起来。该信息可作为华为内部采用线索，但不是本报告基线源码或独立客户审计，不能等同于腾讯、阿里、字节、美团等互联网公司的公开生产采用。

**因此不要把“华为体系采用”与“国内互联网厂商广泛采用”混为一谈：** Mooncake 的优势是公开生态网络和 LLM serving 项目密度；Yuanrong 的优势是昇腾基础设施代码集成深度，但外部互联网客户证据需要进一步通过招标、技术分享、镜像/依赖、PR 或客户案例核验。

## 8. 竞争格局与选型建议

### 适合优先 Yuanrong DS 的场景

- 集群以昇腾 NPU 为主，关键路径是远端 DRAM/HBM 回填、HCCS/RoCE 和 ACL/HIXL 资源控制。
- 已有 openYuanrong/数据系统运维团队，希望 KV、对象、训练中间态共用一套服务发现、worker、L2 和恢复体系。
- 需要把“device blob + object key”直接嵌入自有推理引擎，而不是接受 Mooncake Store 的 KV block/connector 模型。
- metadata QPS、对象数和集群规模需要随 worker 数横向扩展，并能接受 topology owner 迁移、redirect 和跨 owner 运维复杂度。

### 适合优先 Mooncake 的场景

- 需要 vLLM/SGLang/TensorRT-LLM 多框架共存，或 NVIDIA/AMD/昇腾混合集群。
- 重点是 PD 解耦、跨实例 prefix KV 复用、远端 DRAM/SSD/NVMe 池、复制/淘汰/放置策略。
- 希望沿用已有 Mooncake TE 生态，减少自研 KV transfer、connector 和多 NIC/RDMA 故障处理。
- 当前规模可由单 active master 承担 metadata QPS，希望用统一 placement/lease 顺序和 active/standby 换取更简单的控制面。

### 推荐的组合策略

在昇腾集群不必把两者视为只能二选一：可以用 Mooncake Store/connector 表达 KV block 和跨实例复用，用 Ascend Direct 或其下层昇腾通道完成高性能数据搬运；也可以在 Yuanrong DS 中保留统一对象/L2/恢复体系，仅借鉴 Mooncake 的 KV 元数据、prefix hash、placement 和可观测性模型。组合前必须做接口和所有权设计，避免同一 KV 同时被两个 eviction/recovery owner 管理。

## 9. 需要补齐的验证项

1. 在同一 A2/A3 硬件、同一 CANN/驱动版本上，对 Mooncake Ascend Direct、Mooncake UBSHMEM、Yuanrong HIXL HCCS、Yuanrong P2P RoCE 做 1 MB–1 GB 的单流/多流带宽与 P50/P99。
2. 用同一 vLLM/SGLang 版本、同一 DeepSeek/Qwen 长上下文 trace，测 prefix hit、TTFT、decode ITL、KV write/read amplification 和 HBM/DRAM/SSD 命中率。
3. 注入 NPU link down、worker 重启、HIXL registration exhaustion、store node 扩缩容，比较数据丢失、请求失败、恢复时间和回退路径。
4. 核验容器内 `/etc/hccn.conf`、device 映射、NUMA、HugeTLB、memlock、HIXL 256 registration budget 对每个版本的实际约束。
5. 对厂商采用逐条收集一手证据：线上技术分享、官方 PR/镜像、依赖锁定、客户案例；将“关注/集成/试点/生产”四种状态分开。
6. 单独压 metadata control plane：对象数、GetReplicaList/Query QPS、PutStart/PutEnd QPS、批量大小、P99；Yuanrong 从 3→10→100 个 owner 扩容，Mooncake 从单 master 压到瓶颈并测 standby 接管窗口。
7. 做一致性故障矩阵：Yuanrong 分别覆盖 Rocks-only、async-etcd、sync-etcd，注入异步队列满、etcd partition、owner 迁移和 version/digest conflict；Mooncake 注入 lease loss、producer fencing、oplog gap、visible-before-durable 崩溃点和 snapshot restore。
8. 做升级演练：Yuanrong 验证 topology schema、membership compatibility 和明确要求全量重启的 RPC 版本；Mooncake 验证 N/N+1 connector、TE metadata、oplog/snapshot schema 和不同 HA backend 的组合。

## 最终判断

**技术产品层面：** Mooncake 在 KVCache 专用存储、跨实例复用、H2D/D2H/D2D 通用调度和 LLM serving 生态领先；Yuanrong DS 在昇腾原生 RH2D/HIXL/HCCS、统一对象数据系统、分布式 metadata owner 和昇腾基础设施代码集成上更深。源码也暴露了各自的现实边界：Yuanrong HCCS 当前受 `engines_.begin()` 与 `transferMutex_` 约束；Mooncake Ascend Direct 当前是一 request 一 slice，retry 是刷新 metadata 后重试同一 ADXL 路径，不是自动跨协议降级。Mooncake Store 当前是单 active master 控制面，但 replica 数据由 client/TE 直传，不能称为“所有数据都经过中心节点”。

**市场层面：** Mooncake 当前拥有更强的公开互联网/开源生态证明；Yuanrong 的公开证明更偏 openEuler/华为/昇腾体系，不能在没有额外证据时表述为“已被国内互联网大厂广泛采用”。

**决策建议：** 若目标是“昇腾专用、高可控、数据系统统一，并让 metadata 随 worker 分片扩展”，优先评估 Yuanrong DS；若目标是“LLM serving KVCache 平台化、跨框架/跨硬件、统一 placement 顺序和快速接入生态”，优先评估 Mooncake。最终采购或架构决策应同时压测数据面和 metadata control plane，并执行故障/升级演练，而不是依据 README 峰值数字、架构标签或 Logo 列表。

## 参考来源

1. [openEuler openYuanrong 项目页](https://www.openeuler.org/zh/projects/yuanrong/)
2. [Mooncake 官方仓库 README](https://github.com/kvcache-ai/Mooncake)
3. [Mooncake Ascend Direct Transport 文档](https://kvcache-ai.github.io/Mooncake/design/transfer-engine/ascend_direct_transport.html)
4. [Mooncake Supported Protocols](https://kvcache-ai.github.io/Mooncake/getting_started/supported-protocols.html)
5. [vLLM-Ascend Mooncake KV pool 文档](https://docs.vllm.ai/projects/ascend/zh-cn/main/user_guide/feature_guide/kv_pool.html)
6. [vLLM-Ascend Mooncake disaggregated prefill 文档](https://docs.vllm.ai/projects/ascend/en/latest/developer_guide/feature_guide/disaggregated_prefill.html)
7. [Mooncake FAST 2025 论文](https://www.usenix.org/conference/fast25/presentation/qin)
8. [Mooncake arXiv 论文](https://arxiv.org/abs/2407.00079)
9. Yuanrong DS vLLM-Ascend/KVCache 最佳实践 —— 上游仓库里的 `docs/source_zh_cn/best_practices/best_practices_for_kvcache.md`（不在本站，按基线 commit `ae841bf` 查阅）
10. Yuanrong DS RH2D 最佳实践 —— 上游仓库里的 `docs/source_zh_cn/best_practices/best_practices_for_rh2d.md`（同上）
11. [阿里云开发者 Mooncake/SGLang 集成文章](https://developer.aliyun.com/article/1663266)（二手采用线索，需一手材料复核）
