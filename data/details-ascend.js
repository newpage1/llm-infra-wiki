/* ============================================================
   LLM Infra Wiki — 昇腾线深度解读
   包含：CANN（底座）、HIXL（L3 传输）
   ============================================================ */

Object.assign(window.WIKI_DETAILS, {

/* ================================================================
   CANN  —— 底座 / Substrate
   ================================================================ */
cann: {
  overview: `
## 定位

CANN（Compute Architecture for Neural Networks）是华为昇腾的 **AI 异构计算架构**。它不属于四层中的任何一层——它是**四层共同站立的地基**。

用 NVIDIA 侧做类比：CANN 之于昇腾，大致相当于 **CUDA + cuDNN + NCCL + NIXL 的合集**。

## 为什么推理栈的人必须理解它

昇腾栈里那些「看起来奇怪」的设计，答案几乎都能在 CANN 里找到：

| 你观察到的现象 | 在 CANN 里的原因 |
|---|---|
| vLLM-Ascend 自带一大堆 C++ 算子（%%csrc/%%） | CANN 提供了 **Ascend C** 这门算子开发语言，引擎可以自己补缺失的融合算子 |
| KV 传输分出 HIXL 与 MemFabric 两条路 | 它们对应 CANN 的两类通信抽象：**单边通信** 与 **内存语义** |
| vLLM-Ascend 对 CANN 版本异常敏感 | 算子 ABI 与运行时接口随 CANN 版本演进，且 C++ ABI 被显式约束 |
| 部署前要检查 %%hccn.conf%% 与设备节点 | 网络与设备由 CANN 的 Runtime 层管理，不是操作系统标准接口 |

> **不理解 CANN，就只能把昇腾上的性能问题归因于「玄学」。**

## 与 NVIDIA 生态的对应关系

| 能力 | 昇腾 CANN | NVIDIA 对应 |
|---|---|---|
| 算子开发语言 | **Ascend C**（原生 C/C++） | CUDA C |
| 算子加速库 | **AOL**（NN 库 / BLAS） | cuDNN / cuBLAS |
| 图引擎 | **GE**（Graph Engine） | TensorRT（部分职能） |
| 集合通信库 | **HCCL** | NCCL |
| 单边通信库 | **HIXL** | NIXL |
| 编译器 | **毕昇编译器** | nvcc |
| 应用使能接口 | **AscendCL** | CUDA Runtime API |
| 运行时 | **Runtime** | CUDA Runtime |

这张表有两处**不是**一一对应，值得留意：

- **图引擎的定位不同**：GE 在 CANN 里是「计算图编译与运行的控制中心」，是框架接入的必经之路；NVIDIA 侧对应职能散在 TensorRT 与各家框架的图优化里
- **AscendCL 与 Runtime 被显式分成两层**，中间还夹着 %%torch_npu%% 适配层——这比 CUDA 的层次更多，也是昇腾「版本敏感」的结构性原因

## 分层结构

~~~text
┌─────────────────────────────────────────────────────┐
│ 上层框架   MindSpore / PyTorch(torch_npu) / ...      │
├─────────────────────────────────────────────────────┤
│ AscendCL        应用使能接口（资源 / 内存 / 执行）     │
│ GE 图引擎        计算图编译、优化与执行控制            │
│ AOL 算子加速库   NN / BLAS 等硬件亲和算子             │
│ Ascend C        算子开发语言（原生 C/C++）            │
│ 通信库           HCCL（集合通信） / HIXL（单边通信）   │
│ 毕昇编译器       算子与图编译                         │
│ Runtime         任务调度、内存管理、流                │
├─────────────────────────────────────────────────────┤
│ 驱动 / 固件   →   昇腾 NPU（A2 / A3 / A5 代际）        │
└─────────────────────────────────────────────────────┘
~~~

## 在本知识库里的位置

CANN 不参与「调度 → 引擎 → 传输 → 存储」的横向分层，而是**纵向穿透所有层**的底座。
因此它在全景图里单独画成一条地基带，而不是挂在某一层下面。
`,
  modules: [
    {
      id: 'ge', name: 'GE 图引擎：计算图编译与执行控制',
      summary: '框架的计算图如何变成昇腾可执行的图',
      refs: [
        { t: 'CANN 文档 · CANN 是什么', u: 'https://www.hiascend.com/document/detail/zh/CANNCommunityEdition/800alpha002/quickstart/quickstart/quickstart_18_0004.html' }
      ],
      flow: [
        '上层框架（MindSpore / PyTorch 经 %%torch_npu%%）把计算图交给 GE',
        'GE 通过统一的图开发接口，把不同框架的图**转换到 Ascend 图表示**',
        '进行图优化：算子融合、常量折叠、内存复用规划、并行切分',
        '图编译产出可执行形态，交给 Runtime 调度到 NPU 执行'
      ],
      points: [
        '**GE 是框架接入的必经之路**：昇腾侧新模型适配因此常常需要「图层面」的配合，而不只是写算子',
        '图优化里的**内存复用规划**对推理尤其关键——它直接决定 KV 与激活能塞下多少',
        '与 Runtime 的分工：GE 决定「算什么、怎么排」，Runtime 决定「在哪跑、什么时候跑」'
      ]
    },
    {
      id: 'ascendc', name: 'Ascend C 与自定义算子：vLLM-Ascend 的 csrc/',
      files: ['csrc/CMakeLists.txt', 'csrc/attention/', 'csrc/gmm/', 'csrc/moe/', 'csrc/mla_preprocess/', 'csrc/mc2/', 'csrc/aclnn_torch_adapter/', 'csrc/kernels/'],
      summary: '引擎为什么需要自己写算子',
      flow: [
        'Ascend C 是 CANN 的算子开发语言，**原生支持 C 和 C++ 标准规范**，提供多层接口抽象与自动并行计算',
        'vLLM-Ascend 的 %%csrc/%% 就是基于它构建的算子集合：attention、grouped matmul、MoE、MLA 预处理等',
        '%%aclnn_torch_adapter/%% 负责把 CANN 的 aclnn 算子接口适配到 PyTorch 算子体系',
        '%%mc2/%%（Matmul + Communication 融合）把通信与矩阵乘融合在算子内，减少中间结果落盘',
        '编译期经 %%setup.py%% 读取 %%SOC_VERSION%% 与 torch-npu 路径，产出与目标芯片匹配的算子'
      ],
      points: [
        '**「引擎为什么要自带算子」的答案就在这里**：新模型结构（MLA、稀疏注意力、MoE）出现时，通用算子库还没跟上，引擎必须自己补',
        '%%mc2%% 这类融合算子体现了昇腾的一个设计倾向：**把通信融进计算算子**，而不是让通信作为独立步骤——这与 GPU 侧用 NCCL 独立调用的习惯不同',
        '算子编译与 %%SOC_VERSION%% 绑定，意味着同一份代码在不同芯片代际上要分别构建——这是部署复杂度的主要来源之一'
      ]
    },
    {
      id: 'aol', name: 'AOL 算子加速库与 aclnn',
      summary: '通用算子的来源，以及引擎与它的边界',
      refs: [
        { t: 'CANN 文档 · CANN 是什么', u: 'https://www.hiascend.com/document/detail/zh/CANNCommunityEdition/800alpha002/quickstart/quickstart/quickstart_18_0004.html' }
      ],
      flow: [
        'AOL（Ascend Operator Library）提供深度优化、硬件亲和的通用高性能算子',
        '包含神经网络（NN）库与线性代数库（BLAS）等',
        '通过 aclnn 接口对外暴露，vLLM-Ascend 经 %%aclnn_torch_adapter%% 调用',
        '引擎只对 AOL 缺失或不够快的关键路径写自定义算子'
      ],
      points: [
        '**界定边界很重要**：能用 AOL 的就不自己写，自定义算子越多，跨 CANN 版本升级的代价越大',
        '反过来，关键路径上缺一个融合算子就可能造成性能断崖——这是「算子覆盖度」成为国产芯片核心指标的原因',
        'AOL 与自定义算子的关系，类似 cuBLAS 与手写 kernel 的关系'
      ]
    },
    {
      id: 'comm', name: '通信库：HCCL 与 HIXL 的分工',
      summary: '集合通信与单边通信，两条不同的抽象',
      refs: [
        { t: 'HIXL 仓库（cann/hixl）', u: 'https://gitcode.com/cann/hixl' }
      ],
      flow: [
        '**HCCL**（Huawei Collective Communication Library）负责**集合通信**：AllReduce、AllGather、ReduceScatter 等，对应 TP / PP / DP 并行',
        '**HIXL**（Huawei Xfer Library）负责**单边通信**：点对点、单边零拷贝，面向 KV 搬运与参数切换',
        '两者同属 CANN，SIG 都是 hccl（%%cann/community/CANN/sigs/hccl%%）',
        '推理场景里：模型并行走 HCCL，KV 传输走 HIXL'
      ],
      points: [
        '**这两条线必须分清**：并行训练的通信是「所有 rank 一起参与」的集合语义；KV 搬运是「A 直接写 B 的内存」的单边语义。用错抽象会带来不必要的同步开销',
        'HCCL 对应 NVIDIA 的 NCCL，HIXL 对应 NIXL——但 HIXL 与 NIXL 是互补关系而非替代（见 [HIXL 页面](#/c/hixl)）',
        '部署前要检查的 %%hccn.conf%% 就是 HCCL 的网络配置，属于这一层'
      ]
    },
    {
      id: 'runtime', name: 'AscendCL / Runtime 与内存模型',
      summary: '应用接口层、设备管理，以及「KV 必须注册」这条约束的出处',
      refs: [
        { t: 'CANN 文档 · 单边通信', u: 'https://www.hiascend.com/document/detail/zh/CANNCommunityEdition/920beta1/commlib/hixlug/docs/zh/guide/cpp/introduction.md' }
      ],
      flow: [
        '**AscendCL** 是 CANN 的应用使能接口层：设备管理、内存申请、执行流、同步原语都在这里',
        '**Runtime** 负责实际的资源调度：任务下发、内存管理、流与事件',
        '设备侧内存需要通过 CANN 的接口申请并**注册**，才能被 NIC 直接访问（HCCL / HIXL 的硬前置条件）',
        '网络与设备配置走 %%hccn.conf%% 与设备节点（%%/dev/ummu%%、%%/dev/uburma%% 等），不是操作系统标准接口',
        'torch_npu 夹在 AscendCL 与 PyTorch 之间做适配，这是昇腾栈层次比 CUDA 更多的一层'
      ],
      points: [
        '**「KV 必须落在注册过的 buffer 里」这条约束的源头在这一层**，不在引擎、也不在存储系统——与 CUDA 侧同构',
        'AscendCL 与 Runtime 被显式分成两层，中间还要过 torch_npu，**这是昇腾「版本敏感」的结构性原因**',
        '部署前检查 %%hccn.conf%%、挂载设备节点这类动作，都属于这一层的准备工作',
        '理解这一点就能解释：为什么昇腾上的 KV 池必须先建内存池再谈复用，而不能随手申请临时缓冲'
      ]
    },
    {
      id: 'versions', name: '版本、ABI 与依赖管理',
      files: ['setup.py', 'requirements.txt'],
      summary: '为什么昇腾栈对版本如此敏感',
      flow: [
        'vLLM-Ascend 测试基线要求 **CANN == 9.1.0**；KV Pool 特性要求 **CANN >= 8.5.0**',
        '%%setup.py%% 在构建时读取 %%SOC_VERSION%%、CANN 头文件路径与 torch-npu 安装位置',
        'C++ 公开接口有显式的 **ABI 兼容性规范**（HIXL 仓库中即成体系：STL 类型准入、结构体 reserved 预留、符号只增不改）',
        '构建产物中会打包 %%_cann_ops_custom%% 目录'
      ],
      points: [
        '**ABI 规范的存在本身就是信号**：说明这套接口要被多个第三方组件长期链接，稳定性是硬要求',
        '对使用者的实际含义：**升级 CANN 需要整体回归**，不能只升一个组件',
        '部署时把 CANN 版本、torch-npu 版本、vLLM-Ascend 版本三者当成一个整体来管，是最省事的做法'
      ]
    },
    {
      id: 'why', name: '对 KV 这条线意味着什么',
      summary: '把 CANN 的能力映射回四层栈',
      flow: [
        '**L2 引擎**：算子来自 AOL 或 %%csrc/%% 自定义算子；图由 GE 编译',
        '**L3 传输**：单边通信走 HIXL，内存语义走 MemFabric，两者都是 CANN 生态的产物',
        '**L4 存储**：KV 池需要的内存注册与设备内存管理由 CANN Runtime 提供',
        '**跨层约束**：KV 缓冲必须注册为可被 NIC 访问才能走 RDMA——这条规则源自 CANN Runtime 的内存模型'
      ],
      points: [
        '**「KV 必须落在特定 buffer」这条约束的源头就在这里**，而不是在引擎或存储系统里',
        '昇腾超节点（SuperPod）的互联能力由 CANN 与硬件共同定义，直接决定了 HIXL / MemFabric 能跑到什么带宽',
        '做跨层性能分析时，CANN 是那条把四层串起来的暗线'
      ]
    }
  ],
},

/* ================================================================
   HIXL  —— L3 KV 传输
   ================================================================ */
hixl: {
  overview: `
## 定位

HIXL（**Huawei Xfer Library**）是昇腾的**单边通信库**，面向集群场景提供点对点数据传输。它是 CANN 生态里与 [NIXL](#/c/nixl) 对标的那一层，也是昇腾侧 KV 搬运与 PD 分离的底层通路。

> 官方定义：**"一个灵活、高效的昇腾单边通信库，面向集群场景提供简单、可靠、高效的点对点数据传输能力。"**

## 三个核心能力

**1. 单边零拷贝（One-Sided Zero-Copy）**

本地内存数据准备就绪后，通过单边操作**直接向远端内存传输**，无需远端节点执行任何操作。这个性质有两个直接后果：

- 它是「**通信与计算重叠**」的技术前提——A 可以一边算一边往 B 写，B 完全不用停下来配合
- 内存间直接传输避免了冗余拷贝，既省内存带宽也省内存容量

**2. 屏蔽硬件差异，多链路互联**

原生支持 **RDMA、HCCS** 等多种高速互联协议，并屏蔽昇腾各代芯片的底层差异（A2 / A3 / A5 可跨代际互联）。官方数据（A3 芯片传输 128M）：

| 链路 | 带宽 |
|---|---|
| HCCS | **119 GB/s** |
| RDMA | **22 GB/s** |

这个差距本身就很说明问题：**节点内走 HCCS 与跨节点走 RDMA，是两个数量级不同的体验**。

**3. 极简 API**

核心调用精简到 **10 余个**，提供 C++ / Python 双接口。这个设计意图很明确——降低第三方框架的集成门槛。

## 两个核心组件

| 组件 | 职责 |
|---|---|
| **HIXL Engine** | 核心传输引擎：支持 D2D / D2H / H2D 多种内存类型，兼容 HCCS / RDMA 等多协议，支持同构与异构集群、动态扩缩容下的链路适配 |
| **LLM-DataDist** | 构建在 Engine 之上，提供**携带 KV Cache 语义**的传输接口，直接对接 vLLM / SGLang |

> 这个两层划分值得记住：**HIXL Engine 是通用的数据传输，LLM-DataDist 是懂 KV 的那一层**。前者回答「怎么搬字节」，后者回答「怎么搬一个 KV 块」。

## 它能用在哪些场景

- 大模型 **PD 分离**（KV 从 prefill 实例传到 decode 实例）
- **RL 后训练参数切换**（训练完的权重快速分发到推理实例）
- **模型参数缓存**（参数的跨节点共享）

## 一个关键认知：HIXL 与 NIXL 是互补而非替代

社区里已经有把 HIXL 作为 **NIXL 昇腾后端**的实践。这不矛盾——NIXL 定义的是「传输的描述符与请求抽象」，HIXL 提供的是「昇腾上真正能把字节搬过去的能力」。两者的关系类似「接口标准」与「驱动实现」。

同理，Mooncake 的传输引擎也把 HIXL 接成了 **ascend_direct** 传输通路。
`,
  modules: [
    {
      id: 'engine', name: 'HIXL Engine：核心传输引擎',
      files: ['include/hixl/', 'include/llm_datadist/', 'examples/cpp/', 'examples/python/', 'benchmarks/'],
      summary: '多内存类型、多协议的统一传输接口',
      flow: [
        '应用准备本地内存缓冲，经 HIXL API 注册为可被远端访问',
        '构造传输请求，指定对端与内存类型（**D2D** 设备间 / **D2H** 设备到主机 / **H2D** 主机到设备）',
        'HIXL Engine 按可用链路（HCCS / RDMA）发起单边传输',
        '支持**异步传输**，调用方可继续推进自己的计算',
        '集群节点动态扩缩容时，Engine 负责链路适配与资源调度'
      ],
      points: [
        '**三种内存类型并存是关键设计**：KV 可能在设备内存也可能在主机内存，H2D/D2H/D2D 要能统一表达',
        '「无需远端节点执行任何操作」意味着**接收侧不需要预留线程或轮询**，这对 decode 实例尤其重要——它的算力不该被传输协程占走',
        '动态扩缩容下的链路适配，是它区别于「一次性建连」的简单传输库的地方',
        '若遇到传输层问题，日志在 %%/root/ascend/log/debug/plog%% 下'
      ]
    },
    {
      id: 'onesided', name: '单边零拷贝与通信计算重叠',
      summary: '为什么这个机制决定了 KV 传输能不能被藏起来',
      flow: [
        '传统双边通信需要接收方主动参与（post receive / 轮询）',
        '单边通信下，发送方直接写远端内存，**接收方无需知情**',
        '因此 prefill 可以在算出第 N 层 KV 后立即推送，同时继续算第 N+1 层',
        '解码侧在真正需要该层 KV 之前，数据已经在本地了'
      ],
      points: [
        '**这是 layerwise 传输能成立的根本原因**。没有单边语义，"逐层传输"就会退化成一次同步等待',
        '零拷贝省略的是**用户内存之间的中间缓冲**，不等于没有数据搬运——但省掉的那次拷贝正是带宽瓶颈所在',
        '理解这一点后，就能明白为什么 KV 传输的性能问题往往不是"带宽不够"，而是"同步点放错了位置"'
      ]
    },
    {
      id: 'links', name: '多链路与跨代际互联',
      summary: 'HCCS、RDMA、超节点与代际差异',
      flow: [
        '**HCCS**：节点内/超节点内高速互联，A3 上实测可达 119 GB/s',
        '**RDMA**：跨节点通用路径，实测 22 GB/s',
        '2026/03 支持**超节点内 FabricMem 模式**',
        '2026/04 支持 **Device UBoE**，并实现 **A2 / A3 / A5 跨代际异构**互联',
        '2025/12 基于 A3 超平面实现 **D2rH 直传**，新增链路池与 IPv6 支持'
      ],
      points: [
        '**119 GB/s vs 22 GB/s 这个差距，决定了 PD 分离的拓扑设计**：prefill 与 decode 放在同一超节点内与跨节点部署，是完全不同的方案',
        '跨代际互联（A2/A3/A5）意味着**存量设备不必整体替换**即可扩池，这是很实际的工程价值',
        '链路池与 IPv6 支持指向的是大规模集群的组网复杂度，而不是单机性能'
      ]
    },
    {
      id: 'datadist', name: 'LLM-DataDist：携带 KV Cache 语义的接口层',
      files: ['include/llm_datadist/'],
      summary: '从「搬字节」上升到「搬 KV 块」',
      flow: [
        'LLM-DataDist 基于 HIXL Engine 构建',
        '对外提供携带 **KV Cache 语义**的数据传输接口',
        '可直接对接 vLLM、SGLang 等推理引擎',
        '引擎侧无需理解底层链路差异，只表达「把这段 KV 送过去」'
      ],
      points: [
        '**这层抽象的价值与 AscendStoreConnector 类似**：把 N 种底层能力收敛成 1 个引擎可用的接口',
        '区别在于抽象层次：AscendStoreConnector 决定「搬哪些、什么时候搬」，LLM-DataDist 提供「搬 KV」这个动作本身',
        '官方提到 vLLM / SGLang 可直接调用 HIXL API 完成 KV 跨设备传输，实测内存访问延迟降低约 20%'
      ]
    },
    {
      id: 'mooncake', name: '与 Mooncake 的 ascend_direct 集成',
      files: ['mooncake-transfer-engine/src/transport/ascend_transport/'],
      summary: 'HIXL 作为 Mooncake 传输引擎的昇腾通路',
      flow: [
        'Mooncake 在 %%transport/ascend_transport/%% 下提供昇腾链路实现',
        'HIXL 在该路径中承担 **ascend_direct** 传输',
        'Mooncake 通过 %%MooncakeHixl%% 注入 %%LocalCommRes%% 等通信资源',
        '支持 AutoConnect 与 Client-Server 两种模式的自动探测（经 GetCapability）',
        'vLLM-Ascend 侧对应 %%remote_h2d_transport_backend%%，默认值即 **HIXL**'
      ],
      points: [
        '**这是「通用传输框架 + 厂商专用通路」的典型组合**：Mooncake 提供段管理、元数据、批量提交，HIXL 提供昇腾上的高速链路',
        '排障时有个实用判据：**如果错误不是 Mooncake 报的，就很可能是 HIXL（ascend_direct）传输层问题**，此时应去收 plog',
        '与 MemFabric 的关系是**并列可替换**：vLLM-Ascend 把两者封装成同形的 Python 接口，上层 connector 无感切换'
      ]
    },
    {
      id: 'nixl', name: '与 NIXL 的关系：互补而非替代',
      summary: '接口标准与驱动实现的分工',
      flow: [
        'NIXL 定义的是**传输的描述符模型与请求生命周期**（dlist / prep / post / status）',
        'HIXL 提供的是**昇腾上实际搬运数据的能力**',
        '社区已有把 HIXL 适配为 **NIXL 昇腾后端**的实践',
        '因此同一个昇腾集群里，可能同时存在「NIXL 做抽象 + HIXL 做执行」的栈'
      ],
      points: [
        '**不要把它们理解成两个竞争产品**：一个在抽象层，一个在实现层，可以叠起来用',
        '对照 NVIDIA 侧：NIXL 自己就带 UCX / GDS 等后端，昇腾侧只是把后端换成了 HIXL',
        '对使用者的判断依据是：**你用的是谁的框架**。用 Dynamo/NIXL 生态就接 NIXL，用 Mooncake 生态就接 Mooncake TE，底层都可能是 HIXL'
      ]
    },
    {
      id: 'qos', name: 'QoS 与资源配置',
      summary: 'KV 传输与其它业务争抢带宽时怎么办',
      flow: [
        'HIXL 支持通信资源与 QoS 配置（%%comm_resource_config.qos%%）',
        'vLLM-Ascend 的 KV Pool 暴露 %%qos_priority%% 参数，取值为 **[0, 4]** 的整数，越大优先级越高',
        '多租户场景下，不同业务可配置不同优先级',
        'Mooncake 侧说明：其 QoS 来自 HIXL，%%comm_resource_config.qos%% 属于其它 HIXL 使用者，不互相覆盖'
      ],
      points: [
        '**QoS 的存在说明 KV 传输已经进入「多业务共享基础设施」阶段**：早期 KV 搬运是独占的，现在是集群里的一类流量',
        '优先级是有限资源下的取舍手段，不是性能优化——高优先级流量快，意味着低优先级更慢',
        '这条线索也解释了为什么 KV 传输最终一定会走向「独立资源池」而不是「搭在现有网络上」'
      ]
    }
  ],
}

});
