/* ============================================================
   LLM Infra Wiki — NVIDIA 线
   包含：CUDA（底座）
   ============================================================ */

Object.assign(window.WIKI_DETAILS, {

/* ================================================================
   CUDA  —— 底座 / Substrate
   ================================================================ */
cuda: {
  overview: `
## 一句话定位

CUDA 是 NVIDIA 的**异构计算平台与编程模型**。与 [CANN](#/c/cann) 在昇腾栈中的位置完全对应：它不参与四层的横向分层，而是**纵向穿透所有层**的地基。

一个 infra wiki 如果不讲底座，就没法解释「为什么两条栈的上层长得不一样」。把两条底座并排放，很多设计差异会立刻变得可解释：

| 能力 | NVIDIA 栈 | 昇腾栈 |
|---|---|---|
| 地基 | **CUDA** | [CANN](#/c/cann) |
| 算子语言 | CUDA C / C++（nvcc / NVRTC） | Ascend C |
| 算子库 | cuBLAS / cuDNN / CUTLASS | AOL（NN / BLAS） |
| 图与编译 | **无单一中心**：TensorRT + 框架各自的图优化 | GE 图引擎（必经中心） |
| 集合通信 | NCCL | HCCL |
| 单边通信 | [NIXL](#/c/nixl) | [HIXL](#/c/hixl) |
| 互联 | NVLink / NVSwitch / NVSHMEM | HCCS / 灵衢 UB |
| 直连访存 | GPUDirect RDMA / Storage | HIXL 零拷贝 / SDMA |

> **最值得注意的一处结构差异**：CANN 里 GE 图引擎是框架接入的必经中心；而 NVIDIA 侧没有对应的单一中心——图优化散落在 TensorRT、TensorRT-LLM 与各家框架自己的编译路径（vLLM 的 %%torch.compile%%、%%cudagraph_dispatcher.py%%）中。
> 这直接解释了为什么「在昇腾上适配新模型」与「在 NVIDIA 上适配新模型」的工作量分布很不一样。

## CUDA 在推理栈里决定了什么

| 决定的东西 | 具体是什么 | 影响哪一层 |
|---|---|---|
| **算子生态** | FlashAttention / FlashInfer / CUTLASS 等关键 kernel | L2 |
| **显存模型** | 分配方式、内存池、VMM、流与事件 | L2 / L4 |
| **图捕获** | CUDA Graph，消除 kernel launch 开销 | L2 |
| **直连访存** | GPUDirect RDMA / Storage，零拷贝 | L3 / L4 |
| **互联与集合通信** | NVLink / NCCL / NVSHMEM | L2 / L3 |

## 在本知识库里的位置

与 CANN 一样属于 **L0 底座**。切换页面右上角的栈视角到「NV 栈」时，本页会被强调、CANN 淡化。
`,
  modules: [
    {
      id: 'layers', name: '平台分层：从语言到驱动',
      summary: 'CUDA 各层各自负责什么',
      refs: [{ t: 'CUDA 官方文档', u: 'https://docs.nvidia.com/cuda/' }],
      flow: [
        '**CUDA C / C++**：算子开发语言，经 nvcc 离线编译或 NVRTC 运行时编译',
        '**CUDA Runtime API**：%%cudaMalloc%% / %%cudaMemcpy%% / stream / event / graph，最常用的上层接口',
        '**CUDA Driver API**：%%cuInit%% / %%cuMemCreate%% / context 管理，提供 Runtime 覆盖不到的底层能力（如 VMM）',
        '**库生态**：cuBLAS（线性代数）、cuDNN（深度学习原语）、CUTLASS（模板化高性能 kernel）、CUB（并行原语）',
        '**互联**：NVLink / NVSwitch（节点内）、NCCL（集合通信）、NVSHMEM（跨 GPU 共享内存语义）'
      ],
      points: [
        '**Runtime 与 Driver 是两套 API 而非两个层次**：Runtime 更易用，Driver 更底层。引擎在需要细粒度控制时（VMM 弹性显存、跨进程共享显存）会下探到 Driver API',
        'vLLM 的 %%vllm/device_allocator/%% 与 SGLang 的 %%kv_vmm_backing.py%% 就是 Driver 层的使用者——**KV 池的可伸缩能力来自这里**',
        '对比 CANN 的 AscendCL + Runtime 显式分层，CUDA 这两套 API 的边界更模糊，也更容易写错'
      ]
    },
    {
      id: 'graph', name: 'CUDA Graph：把整个解码步捕获成图',
      summary: 'decode 低延迟的关键设施',
      flow: [
        '解码阶段每一步只产出 1 个 token，**kernel launch 开销占比极高**——一个 step 可能要启动几十上百个 kernel',
        'CUDA Graph 把一整个 step 的 kernel 序列**捕获**成一张图，之后每次 replay 只需一次提交',
        '捕获要求**地址与形状固定**，因此引擎需要为常见 batch 形状预捕获多张图',
        'vLLM 在 %%vllm/v1/cudagraph_dispatcher.py%% 中按 batch 形状分派对应的图；SGLang 有独立的 CudaGraphRunner'
      ],
      points: [
        '**这与 KV 分页存在天然张力**：KV 块地址每步都在变，而图要求固定地址。业界解法是用 **block_table 间接寻址**——图里存的是「查表」这个动作，真实地址在表里变',
        '这条约束反过来解释了 vLLM 为什么坚持「固定大小分页块 + 块表」而不是变长连续内存：**分页不仅省显存，还让 CUDA Graph 可用**',
        '预捕获多少张图是个权衡：形状太细碎会浪费显存与启动时间，太粗则命中率低'
      ]
    },
    {
      id: 'memory', name: '显存模型：KV 池的物理基础',
      summary: '分配方式决定了 KV 池能做成什么样',
      flow: [
        '**%%cudaMalloc%%**：传统分配，同步、开销大，但最通用',
        '**stream-ordered 分配（%%cudaMallocAsync%%）**：把分配纳入流的顺序语义，避免全局同步',
        '**VMM（%%cuMemCreate%% / %%cuMemMap%%）**：物理显存与虚拟地址解耦，可按页映射、可回收——**弹性 KV 池的基础**',
        '**Unified Memory（%%cudaMallocManaged%%）**：CPU/GPU 统一寻址，由驱动按需迁移',
        '**pinned memory（%%cudaHostAlloc%%）**：主机侧不可换页内存，异步拷贝与 RDMA 注册都要求它'
      ],
      points: [
        '**「KV 缓冲必须注册才能被网卡访问」这条约束源自这里**：只有固定地址且不可换页的内存才能被 RDMA 网卡直接读写',
        'VMM 让 KV 池可以**按需扩容与缩容**，这是「显存休眠 / 弹性伸缩」类特性的底层支撑',
        'SGLang 的 %%kv_vmm_backing.py%% 就是在做这件事：用 VMM 把 KV 池做成可回收的映射',
        '选哪种分配方式会一路传导到 L3 与 L4：能否零拷贝、能否异步、能否跨进程共享，都取决于此'
      ]
    },
    {
      id: 'gpu-direct', name: 'GPUDirect：让网卡与 SSD 直连显存',
      summary: '零拷贝搬运的物理基础',
      flow: [
        '**GPUDirect RDMA**：网卡直接读写 GPU 显存，数据不经过主机内存与 CPU',
        '**GPUDirect Storage（GDS）**：通过 %%cuFile%% API 让 SSD 直连显存，绕过页缓存与系统内存',
        '**P2P over NVLink**：节点内 GPU 之间用 %%cudaDeviceEnablePeerAccess%% 建立直接访问',
        '**NVSHMEM**：把上述能力抽象成跨 GPU 的共享内存语义（PGAS）'
      ],
      points: [
        '**这是 KV 传输能做成「零拷贝」的物理前提**，与昇腾侧 [HIXL](#/c/hixl) 的目标完全同构——两条栈在这一层的追求是一样的',
        '没有 GDS 时，KV 落盘要经历「显存 → 主机内存 → 页缓存 → SSD」三次搬运；GDS 把中间两步省掉',
        'GDS 的收益判据与昇腾侧一致：**读回来的时间是否显著小于重新 prefill 的时间**',
        'P2P 的可用性取决于拓扑（NVLink 域 / PCIe 树），这也是为什么需要拓扑感知'
      ]
    },
    {
      id: 'libs', name: '库生态：推理引擎站在谁的肩膀上',
      summary: '关键 kernel 来自哪里',
      flow: [
        '**cuBLAS / cuBLASLt**：GEMM 与批量 GEMM，MoE 的 grouped GEMM 也常从这里出发',
        '**cuDNN**：卷积、归一化、attention 原语等深度学习算子',
        '**CUTLASS**：header-only 的模板化高性能 kernel 库，FlashAttention 等实现大量基于它',
        '**FlashAttention / FlashInfer**：attention 专用 kernel，vLLM 与 SGLang 都做成可插拔后端',
        '**TensorRT**：面向推理的图编译与 kernel 自动调优（见 [TensorRT-LLM](#/c/tensorrt-llm)）'
      ],
      points: [
        '**库生态的成熟度是 NV 栈最深的护城河**：新模型结构出现时，通常很快就有现成 kernel 可用，而不必自己写',
        '对照昇腾侧：vLLM-Ascend 需要自带 %%csrc/%% 自定义算子，正是因为库的覆盖度还在追赶',
        'attention 后端可插拔（FlashAttention / FlashInfer / Triton / MLA）本质上是**把库生态的多样性收敛到一个接口后面**'
      ]
    },
    {
      id: 'collective', name: '互联与集合通信：NCCL / NVLink / NVSHMEM',
      summary: '并行推理与 KV 传输的通信底座',
      flow: [
        '**NVLink / NVSwitch**：节点内 GPU 高速互联，带宽远高于 PCIe',
        '**NCCL**：集合通信库，提供 AllReduce / AllGather / ReduceScatter / AllToAll，支撑 TP / PP / DP',
        '**NVSHMEM**：跨 GPU 的共享内存语义，适合细粒度、单边的数据交换',
        '**P2P 访问**：%%cudaDeviceEnablePeerAccess%% 建立 GPU 间直接寻址'
      ],
      points: [
        '**集合通信与单边通信是两类不同的抽象**：并行训练的通信是所有 rank 一起参与的集合语义；KV 搬运是「A 直接写 B」的单边语义。用错会带来不必要的同步开销',
        'NCCL 对应昇腾的 HCCL，NVSHMEM 在定位上更接近昇腾的灵衢 UB 内存语义',
        'KV 传输走哪条路（[NIXL](#/c/nixl) 的 RDMA / NVLink / GDS 后端）取决于拓扑与数据位置，这正是传输层要解决的择优问题'
      ]
    },
    {
      id: 'kv', name: '对 KV 这条线意味着什么',
      summary: '把 CUDA 的能力映射回四层栈',
      flow: [
        '**L2 引擎**：attention / GEMM 关键 kernel 来自 CUTLASS、FlashAttention 等；CUDA Graph 消除 launch 开销',
        '**L3 传输**：[NIXL](#/c/nixl) 的 UCX / GDS 后端、Mooncake 的 NVLink 与 RDMA 路径都建立在 CUDA 与 GPUDirect 之上',
        '**L4 存储**：KV 池的显存与主机内存管理依赖 CUDA；GDS 让 SSD 直连显存',
        '**跨层约束**：KV 缓冲必须注册为可被网卡访问，这条规则源自 CUDA 的显存模型'
      ],
      points: [
        '**「KV 必须落在特定 buffer」这条约束在两条栈上是同构的**——原因都是网卡只能直接访问注册过的、不可换页的内存',
        '把这一条记住，就能理解为什么几乎所有 KV 系统都要自己管理内存池，而不是随手申请',
        '做跨栈性能对比时，先对齐底座再看上层，否则容易把「底座差异」误判成「组件实现差异」'
      ]
    },
    {
      id: 'vs-cann', name: '与 CANN 的关键差异',
      summary: '两条底座决定了两种工程体感',
      flow: [
        '**图引擎的中心化程度**：GE 是 CANN 的必经中心；NVIDIA 侧无对应单一中心，优化散落在 TensorRT 与框架编译路径中',
        '**算子生态**：CUDA 侧缺算子通常能找到现成实现；昇腾侧更常需要自己写并维护',
        '**ABI 与版本**：CANN 的 C++ ABI 被显式约束（见 [HIXL](#/c/hixl) 的 ABI 规范），跨版本升级需整体回归；CUDA 的兼容性策略不同，但驱动版本仍有下限',
        '**互联抽象**：NVLink / NVSHMEM 与昇腾 HCCS / UB 在带宽与语义上各有取舍'
      ],
      points: [
        '**这些差异会一路传导到上层**：引擎的自定义算子数量、KV 传输的链路选择、部署的版本管理策略，都源于底座',
        '一个具体的例子：昇腾栈的 KV 传输分出 HIXL（单边）与 MemFabric（内存语义）两条路，这在 CUDA 侧对应的是 NIXL 与 NVSHMEM——**问题相同，解法相似，但边界划分不同**',
        '补完方向：CUDA Graph 与 KV 动态性的具体解法、GDS 在 KV 落盘中的实测路径与收益'
      ]
    }
  ],
}

});
