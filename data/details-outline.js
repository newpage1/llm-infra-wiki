/* ============================================================
   LLM Infra Wiki — 组件详情（骨架版）
   这些组件已有定位与模块骨架，待逐个补完深度走读。
   draft: true 会在页面上显示「骨架」标记。
   ============================================================ */

Object.assign(window.WIKI_DETAILS, {

/* ================= L1 集群调度 ================= */
aibrix: {
  draft: true,
  overview: `
## 一句话定位

AIBrix 是字节跳动开源、并已进入 vLLM 社区的**K8s 原生推理控制面**。它不重造引擎，而是在 Kubernetes 之上补齐推理服务缺的那一层：KV-aware 路由、分布式 KV 缓存编排、LoRA 动态加载、弹性伸缩。

## 它解决什么问题

原生 K8s 的 Service + HPA 面向的是无状态微服务，而 LLM 推理是**强状态**的：同一个 prompt 在不同 Pod 上的成本可能相差一个数量级（有无前缀缓存）。AIBrix 的核心工作就是把这层状态暴露给调度决策。

## 关键组件

| 组件 | 职责 |
|---|---|
| Gateway / Router | 按 KV 命中率与负载选 Pod，支持 prefix-cache aware 路由 |
| Distributed KV Cache | 跨 Pod 共享 KV，含元数据服务与全局缓存 |
| Runtime | 旁路 sidecar，暴露引擎指标与 LoRA 管理接口 |
| Autoscaler | 按队列深度 / 显存水位而非 CPU 扩缩容 |
| Controller | CRD 化的 ModelAdapter、PodAutoscaler 等 |

## 与 Dynamo 的对比

Dynamo 是**框架**，自己定义数据面与控制面；AIBrix 是**控制面**，尽量复用 K8s 原生机制。前者更彻底、性能上限更高；后者更易与既有 K8s 运维体系融合。

> 观察点：AIBrix 的 Gateway 依赖引擎上报的前缀缓存事件来做路由。**这类"引擎把内部状态暴露给控制面"的接口，是整个 L1 层的关键契约。**
`,
  modules: [
    { id: 'gateway', name: 'Gateway 与 KV-aware 路由', files: ['pkg/plugins/gateway/'], summary: '按前缀缓存命中与负载选 Pod', flow: ['Gateway 扩展 K8s Gateway API，拦截 InferenceService 流量', '订阅各 Pod 上报的前缀缓存事件，维护路由索引', '为每个请求计算候选 Pod 的预估命中长度并打分'], points: ['**路由索引的时效性是核心难点**：缓存事件有延迟，过期索引会导致误判', '与 Dynamo Router 思路一致，但实现落在 Go 与 K8s 生态里'] },
    { id: 'distkv', name: 'Distributed KV Cache', files: ['python/aibrix/'], summary: '跨 Pod 的 KV 共享与元数据服务', flow: ['KV 元数据独立成服务，记录哪段前缀在哪个 Pod', '由 Router 查询以支撑路由决策', '配合引擎侧 connector 完成实际搬运'], points: ['**元数据服务与数据面分离**是常见形态，代价是多一次网络查询', '与 LMCache Controller 解决的问题高度重叠，二者有潜在整合空间'] },
    { id: 'autoscaler', name: '弹性伸缩', files: ['pkg/controller/'], summary: '按推理指标而非 CPU 扩缩容', flow: ['从 Runtime sidecar 抓取引擎指标（队列深度、KV 使用率）', '按目标延迟反推所需副本数', '经 CRD 调整 Deployment 规模'], points: ['**用 CPU 利用率驱动 LLM 扩缩容基本无效**：decode 阶段 CPU 常年空闲而 GPU 打满', '正确的信号是队列等待时间与 KV 显存水位'] }
  ],
},

'llm-d': {
  draft: true,
  overview: `
## 一句话定位

llm-d 是 Red Hat、Google、IBM 等联合推进的 **K8s 原生分布式推理栈**，目标是做「LLM 推理领域的 Kubernetes 标准姿势」：用 Gateway API 做流量入口，用 Inference Scheduler 做 KV-aware 调度，用 InferencePool 抽象引擎实例组。

## 设计主张

llm-d 的立场很明确：**不要把调度逻辑塞进引擎，也不要自造一套封闭框架**，而是尽可能用 K8s 既有的扩展点（Gateway API、CRD、Endpoint Picker）来表达推理调度。

## 核心构件

| 构件 | 职责 |
|---|---|
| Inference Gateway | 基于 Gateway API 的统一入口 |
| Inference Scheduler | KV-aware + 负载感知的实例选择（EPP 模式） |
| InferencePool | 一组同构引擎实例的抽象，支持 PD 分离角色标注 |
| Disaggregation | prefill / decode 分池编排与 KV 交接 |
| Benchmarks | 面向 SLA 的压测与容量规划工具 |

## 值得关注的点

llm-d 与 vLLM、SGLang 的对接是**通过引擎侧的 KV Connector 与指标暴露**完成的，不修改引擎内核。这让它天然支持多引擎。同时它把 PD 分离视为一等公民，在 InferencePool 层面就标注了角色。
`,
  modules: [
    { id: 'gateway', name: 'Inference Gateway 与 EPP', files: ['guides/'], summary: '用 Gateway API 的 Endpoint Picker 承载推理路由', flow: ['Gateway 接收 OpenAI 兼容请求', '转发到 EPP（Endpoint Picker）扩展做实例选择', 'EPP 结合 KV 命中与负载返回目标 Pod'], points: ['**复用 Gateway API 的 EPP 机制**是它区别于 Dynamo 的关键——不引入新的数据面', '代价是受限于 Gateway API 的表达能力'] },
    { id: 'scheduler', name: 'Inference Scheduler', files: ['pkg/'], summary: 'KV-aware + 负载感知的实例打分', flow: ['维护各实例 KV 前缀索引与负载快照', '请求到达时计算候选分数', '返回排序后的实例列表给 Gateway'], points: ['**打分函数是核心竞争力**：命中收益与排队代价必须统一到同一个量纲', '指标采集频率直接决定调度质量'] },
    { id: 'disagg', name: 'PD 分离编排', files: ['guides/'], summary: 'prefill / decode 分池与 KV 交接', flow: ['InferencePool 中按角色标注 prefill 与 decode 实例', 'Scheduler 两段式路由：先选 prefill，再选 decode', 'KV 经引擎侧连接器（NIXL / Mooncake）交接'], points: ['**两段式路由**是 PD 分离的标准形态，难点在两个决策的耦合', 'decode 侧选择要考虑 KV 传输成本，不只是负载'] }
  ],
},

pymotor: {
  draft: true,
  overview: `
## 一句话定位

MindIE PyMotor 是华为昇腾开源的**一键式 PD 分离 / PD 混部部署框架**。它定位在引擎之上、集群之下：基于云原生插件化架构，同时适配 vLLM-Ascend 与 SGLang，提供 PD 编排、高性能调度与负载均衡。

## 它想解决的问题

昇腾生态里，vLLM-Ascend 与 SGLang 各自都实现了 PD 能力，但**部署形态、配置方式、调度策略各不相同**。PyMotor 的价值在于把「怎么把 PD 跑起来」这件事从引擎里抽出来，做成统一的云原生插件层。

## 关键能力

| 能力 | 说明 |
|---|---|
| PD 分离部署 | prefill / decode 分池，独立扩缩 |
| PD 混部 | 同实例内混合承载，提升资源利用率 |
| 插件化适配 | 通过插件适配不同推理引擎 |
| 负载均衡 | 结合 KV 状态与负载的实例选择 |
| 高可用 | 实例故障时的流量摘除与恢复 |

## 为什么「混部」值得单独提

PD 分离并非总是最优：**当请求普遍较短时，KV 传输成本会吃掉分离带来的收益**。混部模式让同一批实例既能处理 prefill 又能处理 decode，在负载波动时资源利用率更高。PyMotor 同时提供两种模式，说明这是一个需要按业务形态取舍的决策，而非技术优劣问题。

> 附带一提：该仓库还包含「代码仓智能体」，说明昇腾在把 AI 辅助工具链也一并开源。
`,
  modules: [
    { id: 'deploy', name: 'PD 部署编排', files: ['docs/'], summary: '一键拉起 prefill / decode 池', flow: ['读取部署配置，生成 PD 拓扑', '分别拉起 prefill 与 decode 实例组', '注入 KV 传输配置与对端发现信息'], points: ['**对端发现是 PD 部署的隐藏难点**：prefill 必须知道 decode 在哪，反之亦然', '配置复杂度是这类框架的主要使用门槛'] },
    { id: 'plugin', name: '引擎插件适配', files: ['docs/'], summary: '同一套编排适配 vLLM-Ascend 与 SGLang', flow: ['定义引擎适配插件接口', 'vLLM-Ascend 与 SGLang 各自实现', '编排层不感知引擎差异'], points: ['**这是「控制面与引擎解耦」的又一实例**，与 Dynamo 的多引擎适配思路相同', '插件边界划在哪，决定了新增引擎的适配成本'] },
    { id: 'lb', name: '调度与负载均衡', files: ['docs/'], summary: '结合 KV 状态选择目标实例', flow: ['采集各实例负载与 KV 状态', '请求到达时打分选择', '支持故障实例摘除'], points: ['**昇腾侧的调度通常还要考虑 HCCL/UB 拓扑**，这比 GPU 侧更依赖物理组网信息', '与 MindIE 原生调度存在职责重叠，需要明确边界'] }
  ],
},

volcano: {
  draft: true,
  overview: `
## 一句话定位

Volcano 是 CNCF 孵化、华为云主导的 **K8s 批处理与高性能计算调度器**。它不在请求路径上，而是决定「一组 Pod 能不能同时被调度起来」。

## 为什么它在推理栈里有一席之地

大规模推理部署（尤其是 PD 分离 + TP/EP 并行）对调度的要求和在线微服务完全不同：

- **gang scheduling**：一个 TP=8 的实例必须 8 张卡同时到位，否则整组等待——默认调度器会制造大量「半启动」的死锁
- **拓扑感知**：卡在不在同一个超节点/NVLink 域，决定通信性能
- **队列与优先级**：在线推理与离线批处理混跑时要做资源隔离与抢占
- **异构资源**：GPU/NPU 型号、RDMA 网卡都要作为可调度资源

## 核心能力

| 能力 | 说明 |
|---|---|
| Gang Scheduling | PodGroup 原子调度，避免死锁 |
| Queue / Priority | 多队列资源配额与优先级抢占 |
| Topology Aware | 按 NUMA / 超节点 / 网卡亲和调度 |
| Heterogeneous | 多类型加速卡与网络设备建模 |
| Co-scheduling | 与训练任务混部时的资源隔离 |

> 位置提醒：Volcano 属于**资源层调度**，Dynamo / llm-d 属于**请求层调度**。两者是不同层次的调度，常被混为一谈。
`,
  modules: [
    { id: 'gang', name: 'Gang Scheduling 与 PodGroup', files: ['pkg/scheduler/'], summary: '一组 Pod 要么全起要么全等', flow: ['用户声明 PodGroup 的最小成员数', '调度器为整个组做一次性资源预留', '资源不足时整组排队而非部分启动'], points: ['**这是分布式推理能稳定拉起的前提**：部分启动会造成实例既占资源又不能服务', '与 K8s 默认调度器的差异在「原子性」而非「算法」'] },
    { id: 'topology', name: '拓扑感知调度', files: ['pkg/scheduler/'], summary: '把通信密集的 Pod 放到同一拓扑域', flow: ['节点标注 NUMA / 超节点 / 网卡拓扑', '调度时按亲和规则约束', '必要时牺牲部分资源利用率换取通信性能'], points: ['**TP 组内通信量随层数线性增长**，拓扑选错会直接吃掉并行收益', '昇腾超节点与 NVIDIA NVLink 域的建模方式不同'] },
    { id: 'queue', name: '队列与抢占', files: ['pkg/scheduler/'], summary: '多队列配额与优先级', flow: ['定义 Queue 的资源配额', '高优先级任务可抢占低优先级', '在线推理通常配置为不可抢占'], points: ['**在线/离线混部是成本优化的主战场**，但必须防止离线任务饿死在线请求', '抢占导致的重启对推理实例代价极高（KV 全丢），需要谨慎配置'] }
  ],
},

'ray-serve': {
  draft: true,
  overview: `
## 一句话定位

Ray Serve 是通用分布式服务框架，RayLLM 是其上的 LLM 服务层。它不提供 LLM 专用调度算法，而是提供一套**灵活到可以自己写调度逻辑**的编排原语。

## 它的取舍

| 优势 | 代价 |
|---|---|
| DAG 组合能力强，prefill/decode 可自由串接 | 没有内置 KV-aware 路由，需自行实现 |
| 同一框架训练 + 推理，复用集群 | 资源模型偏通用，推理专用优化较少 |
| Python 原生，扩展成本低 | 控制面在 Python 里，超大规模下延迟需要care |

## 典型用法

用 %%Deployment%% 分别部署 prefill 与 decode 副本，用 %%DeploymentHandle%% 在路由函数里做实例选择，用 %%RequestRouter%% 表达多样的路由策略。KV 传输则依赖引擎侧连接器或外部 KV 池。

## 什么时候选它

当你的编排需求很「非标」——例如多模型级联、RAG 与推理混布、自定义准入与降级逻辑——通用框架的表达力优势会盖过专用方案的性能优势。

> 反过来说，如果你要的就是标准 PD 分离 + KV-aware 路由，Dynamo / llm-d 这类专用方案会少走很多弯路。
`,
  modules: [
    { id: 'deployment', name: 'Deployment 与副本管理', files: ['python/ray/serve/'], summary: '把引擎实例封装成可扩缩的 Deployment', flow: ['用 Deployment 声明引擎副本与资源需求', 'Ray 负责调度与自动扩缩', '每个副本持有独立的引擎进程'], points: ['**Ray 的资源模型是 CPU/GPU 计数器**，表达不了「KV 显存水位」这类推理指标', '扩缩容信号需要自己从引擎指标里提取'] },
    { id: 'router', name: '路由与组合', files: ['python/ray/serve/'], summary: '用 Python 写任意路由逻辑', flow: ['定义路由函数，按请求特征选择下游 handle', '可组合多个 Deployment 形成 DAG', '支持自定义负载均衡策略'], points: ['**表达力是它的核心价值**：任何你能写出来的策略都能实现', '但你需要自己维护 KV 索引，专用框架已经把这件事做完了'] }
  ],
},

/* ================= L2 推理引擎 ================= */
'tensorrt-llm': {
  draft: true,
  overview: `
## 一句话定位

TensorRT-LLM 是 NVIDIA 官方推理引擎，路线与 vLLM 不同：**以编译期优化与极致 kernel 为核心**，用 CUDA Graph、量化、In-flight Batching 把单卡性能压到硬件极限。

## 与 vLLM 的路线差异

| 维度 | vLLM | TensorRT-LLM |
|---|---|---|
| 优化时机 | 运行时动态 | 更多编译期静态优化 |
| 模型支持 | 极广，社区驱动 | 官方精选，适配滞后于新模型 |
| 量化 | 社区方案并行 | 官方 FP8/FP4/INT4 一站式 |
| 硬件 | 多厂商 | NVIDIA 专用 |
| 扩展性 | 高（Python 为主） | 较低（C++ 内核 + 插件） |

## 核心机制

- **In-flight Batching**：等价于 continuous batching，在 TRT-LLM 里的实现
- **Paged KV Cache**：同样采用分页，且引入了 %%tokens_per_block%% 与注意力窗口的精细控制
- **CUDA Graph 全覆盖**：把整个解码步捕获成图，消除 launch 开销
- **Plugin 体系**：把非标准算子写成 TRT plugin，在引擎内融合

## 它在分层栈里的位置

TRT-LLM 既是引擎，也是 Dynamo 的原生后端之一。它的 KV 也通过 Connector 与外部 KV 系统对接，同时支持 KV 量化格式（FP8 KV Cache），这对 L3/L4 的传输与存储量级有直接影响。

> 值得留意的点：**KV Cache 的精度格式由引擎决定，却决定了传输层与存储层的成本**。这是「跨层耦合」最典型的一例。
`,
  modules: [
    { id: 'build', name: '模型编译与 Engine 构建', files: ['tensorrt_llm/'], summary: '离线把模型编译成 TRT Engine', flow: ['读取模型权重与配置，生成网络定义', '用 TensorRT 编译为 engine 文件（含 kernel 自动调优）', '运行时加载 engine，按配置分配 KV 池'], points: ['**编译期优化带来性能，也带来部署复杂度**：engine 与硬件/TRT 版本强绑定', '这是它与 vLLM「加载即用」体验差异的根源'] },
    { id: 'kv', name: 'Paged KV Cache 与 KV 量化', files: ['cpp/tensorrt_llm/'], summary: '分页 KV + FP8/INT4 KV 格式', flow: ['按 tokens_per_block 分配 KV 池', '支持 KV Cache 量化以降低显存与带宽占用', '支持注意力窗口与循环缓存等长上下文策略'], points: ['**KV 量化在这里是一等公民**，量化后的 KV 直接减少 L3 传输量与 L4 存储量', 'KV 格式的选择必须与传输/存储层协同，否则会出现来回转换的开销'] },
    { id: 'disagg', name: 'PD 分离与 KV 传输', files: ['cpp/tensorrt_llm/'], summary: '与 NIXL / Dynamo 协同的分离部署', flow: ['prefill 与 decode 分别构建 engine', 'KV 经 NIXL 或 Dynamo 传输通道交接', '支持 KV Cache 的重叠传输与逐层发送'], points: ['**TRT-LLM 是 NIXL 的主要合作方之一**，两者常成对出现', '编译期优化的引擎在 PD 分离下需要分别编译两套 engine'] }
  ],
},

xllm: {
  draft: true,
  overview: `
## 一句话定位

xLLM 是京东开源的高性能推理引擎，定位在**大规模 PD 分离部署与国产芯片适配**。相比 vLLM，它更强调端到端的服务化能力与国产硬件支持。

## 特点

- **C++ 核心 + Python 接口**：把调度与执行的关键路径下沉到 C++，减少 Python 开销
- **面向 PD 分离设计**：分离部署不是外挂能力而是内建形态
- **多硬件后端**：同时支持 NVIDIA GPU 与多种国产加速卡
- **服务化配套**：%%xllm-service%% 提供独立的服务层

## 分层位置

xLLM 属于 L2 推理引擎，与 vLLM 是同类竞品。它的差异化在于**对国产芯片的支持深度**和**C++ 实现的性能上限**——这两个方向恰好是国内大规模部署最实际的两个约束。

> 对比视角：vLLM 胜在生态与模型覆盖速度；xLLM 胜在特定硬件上的性能与可控性。这类「生态广度 vs 垂直深度」的取舍在整个推理栈里反复出现。
`,
  modules: [
    { id: 'core', name: 'C++ 调度核心', files: ['xllm/'], summary: '调度与批处理在 C++ 侧完成', flow: ['请求进入 C++ 调度器', '按 continuous batching 组批', '跨语言边界只传必要元数据'], points: ['**把调度放在 C++ 是为了消除 GIL 与序列化开销**，在高 QPS 下差异明显', '代价是迭代速度与可调试性下降'] },
    { id: 'pd', name: 'PD 分离与 KV 管理', files: ['xllm/'], summary: '内建 PD 分离形态', flow: ['区分 prefill 与 decode 角色', 'KV 经传输层交接', '配合多级缓存策略'], points: ['**PD 分离内建意味着接口契约更清晰**，不像插件方案要迁就引擎原有抽象', '但也更难复用 vLLM 生态里已有的 KV 连接器'] },
    { id: 'hardware', name: '多硬件后端', files: ['xllm/'], summary: 'NVIDIA 与国产芯片的算子适配', flow: ['抽象设备与算子层', '各硬件实现专用 kernel', '上层调度逻辑保持一致'], points: ['**国产芯片适配的难点往往在算子覆盖度而非性能**：缺一个算子就要回退，性能断崖', '这类适配层是 vLLM-Ascend 之外的另一条实现路径，可横向对比'] }
  ],
},

lmdeploy: {
  draft: true,
  overview: `
## 一句话定位

LMDeploy 是上海 AI Lab 开源的推理工具箱，核心是 **TurboMind 引擎** + 成熟的量化工具链（W4A16 / KV INT8/INT4）。在量化与长上下文场景有长期积累。

## 能力构成

| 模块 | 说明 |
|---|---|
| TurboMind | C++/CUDA 推理引擎，注重 kernel 效率 |
| 量化工具 | AWQ / W4A16 / KV Cache 量化的一站式支持 |
| PagedAttention | 同样采用分页 KV 管理 |
| 多模态与 VLM | 对视觉语言模型支持较早 |
| 服务化 | 兼容 OpenAI 接口的服务端 |

## 在栈里的位置

与 vLLM 同层。LMDeploy 的差异化在于**量化链路的完整度**——它不只支持权重量化，KV Cache 量化也做了很久，这直接关系到 L3/L4 的成本。

> 一个有用的观察角度：把各引擎的 KV Cache 量化支持程度拉平对比，就能预测它们在长上下文 + 大并发场景下的显存与带宽账本差异。
`,
  modules: [
    { id: 'turbomind', name: 'TurboMind 引擎', files: ['src/turbomind/'], summary: 'C++ 推理核心与 PagedAttention 实现', flow: ['模型转换生成 TurboMind 格式权重', '引擎按分页方式管理 KV', '执行 continuous batching 解码'], points: ['**模型转换是额外一步**，换取的是运行时更极致的 kernel', '持久化 batch 等机制与 vLLM 的调度目标一致但实现不同'] },
    { id: 'quant', name: '量化工具链', files: ['lmdeploy/'], summary: '权重与 KV 的一体化量化', flow: ['支持 AWQ / GPTQ 等权重离线量化', '支持 KV Cache INT8/INT4 在线量化', '提供精度与性能的对比评估'], points: ['**KV 量化对长上下文是刚需**：KV 显存占用随长度线性增长，量化是少数能直接砍半的手段', '量化后的 KV 格式会传导到传输与存储层，需要全链路协同'] }
  ],
},

mindie: {
  draft: true,
  overview: `
## 一句话定位

MindIE 是华为昇腾的原生推理引擎套件（MindIE-LLM / MindIE-Service / MindIE-Motor），与 CANN、ATB 深度绑定，是昇腾上性能上限最高的路径。

## 组成

| 组件 | 职责 |
|---|---|
| MindIE-LLM | 推理引擎本体，含模型与算子实现 |
| MindIE-Service | 服务化封装与 OpenAI 兼容接口 |
| MindIE-Motor（PyMotor） | PD 分离部署与调度编排 |
| MindIE-Torch | PyTorch 昇腾后端适配 |

## 与 vLLM-Ascend 的关系

两者都在昇腾上跑推理，但路线不同：

- **MindIE**：昇腾原生技术栈，性能上限高，与大盘硬件特性结合紧
- **vLLM-Ascend**：复用 vLLM 生态与调度逻辑，模型覆盖与社区迭代速度快

这是「**垂直深度 vs 生态广度**」的又一实例，与 xLLM / vLLM 的对比同构。

> 选择建议通常是：追求极致性能与新硬件特性首发用原生栈；追求模型覆盖速度与新模型快速上线用 vLLM 生态。
`,
  modules: [
    { id: 'llm', name: 'MindIE-LLM 引擎', files: ['docs/'], summary: '昇腾原生模型与算子实现', flow: ['模型经 ATC 转换或直接加载', 'ATB 算子执行推理', 'KV 按分页方式管理'], points: ['**原生栈能第一时间用上昇腾新特性**（新的 attention 加速、新的量化格式）', '代价是模型适配依赖官方节奏'] },
    { id: 'service', name: 'MindIE-Service 服务化', files: ['docs/'], summary: '对外提供标准推理服务接口', flow: ['封装引擎为服务进程', '暴露 OpenAI 兼容接口与指标', '配合 Motor 做 PD 编排'], points: ['**服务层与引擎分离**是昇腾侧的既有设计，PyMotor 正是从这一层长出来的', '与 vLLM-Ascend 的 connector 体系形成两条并行的 KV 接入路径'] }
  ],
},

/* ================= L3 KV 传输 ================= */
nixl: {
  draft: true,
  overview: `
## 一句话定位

NIXL（NVIDIA Inference Xfer Library）是 NVIDIA 推出的**统一数据传输抽象层**，目标是用一套 API 覆盖 RDMA、NVLink、GPUDirect Storage、共享内存等所有搬运路径。它是 Dynamo 的默认传输底座，也是 vLLM / TRT-LLM 的 PD 分离实现所依赖的通道。

## 它抽象掉了什么

| 维度 | 没有 NIXL 时 | 有 NIXL 时 |
|---|---|---|
| 传输方式 | 每种链路一套 API | 统一 %%prep_xfer_dlist%% / %%post_xfer_req%% |
| 内存注册 | 各后端自行处理 | 统一的注册与描述符模型 |
| 拓扑选择 | 应用自己判断 | 由后端实现决定 |
| 可观测性 | 分散 | 统一的传输统计 |

## 核心概念

- **Backend**：具体链路实现（UCX / GDS / NVLink / POSIX …）
- **Descriptor List（dlist）**：描述「要搬哪些内存块」，支持批量与稀疏块
- **Transfer Request**：一次异步传输，可轮询或等待事件
- **Agent**：绑定到具体设备（GPU/NIC）的传输代理

## 与 Mooncake 的传输引擎对比

| 维度 | NIXL | Mooncake TE |
|---|---|---|
| 硬件覆盖 | NVIDIA 生态为主 | NVIDIA + 昇腾 + 鲲鹏 + CXL 更广 |
| 与框架集成 | 深度集成 Dynamo / vLLM / TRT-LLM | vLLM / SGLang / LMCache |
| 抽象层次 | 传输描述符（dlist） | 段注册 + 批量传输 |
| 元数据服务 | 由上层提供 | 内置可插拔 metadata service |

> 两者的设计目标高度重合。**实际选型往往取决于硬件生态与上层框架的默认集成**，而非单纯的性能差异。
`,
  modules: [
    { id: 'api', name: 'API 与传输模型', files: ['src/'], summary: '描述符列表 + 异步传输请求', flow: ['%%nixlAgent%% 绑定设备并初始化后端', '%%registerMem%% 注册本地内存，%%getXferDescList%% 构造描述符', '%%prepXferDlist%% 与对端交换描述符', '%%postXferReq%% 提交异步传输，%%getXferStatus%% 查询完成'], points: ['**描述符列表是核心抽象**：它把「搬什么」与「怎么搬」彻底解耦', '支持稀疏块列表，这对 layerwise / 部分 KV 传输很关键'] },
    { id: 'backends', name: '后端插件', files: ['src/plugins/'], summary: 'UCX / GDS / NVLink 等链路实现', flow: ['后端注册到 agent', '按内存类型与拓扑自动择优', '必要时回退到 TCP'], points: ['**自动择优是它相对裸 UCX 的价值**：应用不必理解 NIC-GPU 亲和性', '回退路径的存在保证了功能可用性，但性能会断崖'] },
    { id: 'integration', name: '框架集成', files: ['src/'], summary: 'vLLM / TRT-LLM / Dynamo 的接入', flow: ['vLLM 侧作为 KV Connector 实现 PD 分离', 'TRT-LLM 侧用于 KV 交接', 'Dynamo 侧作为 KVBM 的传输层'], points: ['**NIXL 已成为 NVIDIA 生态的传输事实标准**，这决定了它的集成广度', '与 Mooncake 的竞争实质是生态之争'] }
  ],
},

memfabric: {
  draft: true,
  overview: `
## 一句话定位

MemFabric 是华为昇腾生态的**内存池化软件**，基于灵衢（UnifiedBus / UB）互联提供跨节点的内存语义访问，把多台机器的内存聚合成一个可寻址的内存池。

## 与 RDMA 路线的本质差异

| 维度 | RDMA（Mooncake TE / NIXL） | 内存语义（MemFabric / UB） |
|---|---|---|
| 编程模型 | 显式注册内存 + 提交传输 + 轮询完成 | 接近 load/store 的全局内存访问 |
| 同步语义 | 显式完成事件 | 更接近内存序语义 |
| 上层代码 | 需要管理传输请求生命周期 | 代码显著简化 |
| 带宽/延迟 | 取决于组网 | 超节点内带宽优势明显 |

> 这个差异是**结构性的**：RDMA 下「传输」是一个需要被调度和重叠的异步操作；内存语义下它更接近一次访存。因此上层 KV 池、P2P 交接的代码形态都会不同。

## 在栈里的位置

MemFabric 属于 L3 传输层，同时因为提供池化能力而与 L4 存储层有重叠。在 vLLM-Ascend 中，它与 Mooncake 的传输引擎并列作为可替换的传输引擎（%%memfabric_transfer_engine.py%%）。

## 关键能力

- 跨节点内存池化与统一寻址
- 基于 UB 的高带宽低延迟互联
- 内存注册与共享
- 与 KV Pool / KV P2P 的对接

> 昇腾超节点（SuperPod）的硬件形态是这套方案的前提：**当互联带宽远高于以太网时，「把内存当远程资源用」才划得来。**
`,
  modules: [
    { id: 'fabric', name: '内存池化与统一寻址', files: ['src/'], summary: '把多机内存聚合成可寻址池', flow: ['各节点向 fabric 注册本地内存', '全局地址空间建立映射', '上层按全局地址直接访问'], points: ['**统一寻址把「分布式」复杂度藏进了 fabric**，上层代码接近单机语义', '代价是故障域变大：一个节点的问题可能影响全局地址空间'] },
    { id: 'integration', name: '与 vLLM-Ascend 的对接', files: ['vllm_ascend/distributed/kv_transfer/utils/memfabric_transfer_engine.py'], summary: '作为可替换的传输引擎接入 KV 通道', flow: ['封装为与 Mooncake 同形的 Python 接口', '上层 connector 无感切换', '用于 KV Pool 与 P2P 搬运'], points: ['**统一接口让两条传输路线可以 A/B 对比**，这是工程上很聪明的做法', '实际性能差异需要结合超节点组网才能评估'] }
  ],
},

'ascend-store-connector': {
  draft: true,
  overview: `
## 一句话定位

AscendStoreConnector 是 **vLLM-Ascend 的 KV Pool 连接器**，用于把引擎的 KV 接入外部 KV 存储系统。它本身不提供存储，而是**统一接入契约**，让 MemCache / Mooncake / Yuanrong 等后端可以插拔替换。

## 为什么它属于引擎层而不是传输层

这是分层时少数需要解释的边界，三条判据指向同一个结论。

**判据一：它没有独立身份。** 它的仓库就是 %%vllm-project/vllm-ascend%%——与 [vLLM-Ascend](#/c/vllm-ascend) 是同一个。
**一个没有独立仓库的组件，是某个组件的子系统，而不是它的同级。**

**判据二：它是引擎的出口，不是传输的实现。** 三个问题要分清：

| 问题 | 由谁回答 | 属于哪层 |
|---|---|---|
| KV 存在哪、活多久、怎么淘汰 | MemCache / Mooncake / Yuanrong | **L4** |
| **搬哪些、什么时候搬** | **AscendStoreConnector** | **L2** |
| 字节实际怎么过去 | Mooncake TE / HIXL / MemFabric | **L3** |

它实现的是 **vLLM 的 %%KVConnectorBase_V1%% 接口**——这个接口定义在引擎里，所以实现它的插件也属于引擎侧。

**判据三：一致性。** [LMCache](#/c/lmcache) 同样是「挂在引擎上的 KV 管理层 + Connector」，它在 L2。
把 AscendStoreConnector 放 L3 会与它自相矛盾。

> 由此得到一条更一般的规则：
> **L2 收「引擎本身 + 挂在引擎上的 KV 管理层」；L3 收「独立部署的传输引擎」。**

## 为什么需要这样一个中间层

如果没有它，N 个推理引擎 × M 个 KV 存储产品需要 N×M 套适配代码。AscendStoreConnector 把问题收敛为：

~~~text
引擎 ──(KVConnectorBase_V1)──► AscendStoreConnector ──(backend 接口)──► MemCache
                                       │             ├─────────────► Mooncake
                                       │             └─────────────► Yuanrong DataSystem
                                       ▼
                              Mooncake TE / MemFabric
                                  （实际搬运）
~~~

适配成本从 N×M 降到 N+M。

## 契约内容

| 阶段 | 方法 | 语义 |
|---|---|---|
| 调度 | %%get_num_new_matched_tokens%% | 这段前缀有多少 token 能在外部池命中 |
| 加载 | %%start_load_kv%% / %%wait_for_layer_load%% | 发起并等待 KV 换入 |
| 保存 | %%save_kv_layer%% | 把新算出的 KV 写回池 |
| 元数据 | 键构造与查询 | KV 块如何被唯一标识 |

## 读它的最快方式

仓库里有配套单测 %%tests/ut/distributed/ascend_store/test_ascend_store_connector.py%%。读单测比读实现更快理解契约——因为单测把每个方法的前置条件与期望行为都写死了。

> 这也是一般规律：**当你想理解一个 Connector 的契约，先看它的单测和基类，再看实现。**
`,
  modules: [
    { id: 'connector', name: 'Connector 接口实现', files: ['vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/ascend_store_connector.py'], summary: '实现 vLLM KVConnectorBase_V1 的四个关键方法', flow: ['初始化时按配置选择后端', '调度阶段返回可命中 token 数', '执行阶段异步发起加载与保存，支持 layerwise 同步'], points: ['**四个方法定义了引擎与任何 KV 系统之间的最小契约**，值得作为设计参考', 'layerwise 支持决定 KV 搬运能否与计算重叠'] },
    { id: 'backend', name: '后端适配层', files: ['vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/backend/'], summary: '每个 KV 存储产品一个适配实现', flow: ['定义后端需实现的 put / get / lookup 协议', '各产品分别实现', '通过配置切换'], points: ['**后端接口的粒度决定了适配难度**：太细会泄露产品实现，太粗则无法发挥性能', '新后端仍在持续接入（如 Yuanrong），说明接口仍在演进'] },
    { id: 'test', name: '测试与契约验证', files: ['tests/ut/distributed/ascend_store/test_ascend_store_connector.py'], summary: '用单测固化契约', flow: ['构造 mock 后端', '逐一验证各方法的输入输出与边界', '覆盖异常与降级路径'], points: ['**单测即契约文档**，这是理解 connector 类组件最高效的入口', '换后端时这套测试可以复用为验收标准'] }
  ],
},

/* ================= L4 KV 存储 ================= */
'yuanrong-ds': {
  draft: true,
  overview: `
## 一句话定位

openYuanrong DataSystem 是 openEuler / 华为的 **Serverless 分布式数据系统**，核心能力是「异构分布式多级缓存」，提供 Object 与 Stream 语义。在推理场景中，它作为 **KV Pool 的存储后端**被 vLLM-Ascend 接入。

## 出身与适配

它最初是为 Serverless 函数计算做数据共享而设计的（函数实例间的数据传递），因此天然具备：

- **跨节点数据共享**：本来就要解决函数实例间传数据
- **多级缓存**：内存 + 盘 + 远端的分层
- **生命周期管理**：数据与函数实例生命周期解耦

把它用作 KV Pool 后端是一次**能力迁移**：KV 本质上也是一种需要在实例间共享的大对象。

## 关键能力

| 能力 | 说明 |
|---|---|
| 分布式对象存储 | Object 语义，支持大对象分片 |
| 多级缓存 | 内存 / 盘 / 远端分层 |
| Stream 语义 | 流式数据传递 |
| 跨语言 | C++ / Python / Java / Go 接口 |
| K8s 部署 | 提供 helm / operator 形态 |

## 值得注意的张力

通用数据系统的**接口抽象是为通用性设计的**，而 KV 访问有极强的模式特征（块大小固定、生命周期与请求绑定、需要注册可被 RDMA 访问的内存）。把它用作 KV 后端时，性能上限往往取决于**能否绕开通用抽象走 KV 专用快路径**。

> 这也是判断一个通用存储能否胜任 KV 池的好问题：**它有没有为「定长块 + 零拷贝 + 远端可访问内存」留出专用通道？**
`,
  modules: [
    { id: 'arch', name: '数据系统架构', files: ['src/'], summary: '分布式对象 + 多级缓存', flow: ['客户端经 SDK 访问对象', '元数据服务定位对象所在节点', '多级缓存决定从内存还是盘上取'], points: ['**异构多级缓存是它的核心卖点**，与 KV 分层需求天然契合', '通用抽象带来的元数据开销是接入 KV 场景时首先要评估的'] },
    { id: 'kvpool', name: 'KV Pool 后端接入', files: ['python/'], summary: '作为 vLLM-Ascend 的 KV 存储后端', flow: ['经 AscendStoreConnector 的 backend 接口接入', 'KV 块按对象方式存取', '配合传输层完成 NPU ↔ 存储的搬运'], points: ['**接入方式由 connector 契约决定**，这也是中间层价值的直接体现', 'vLLM-Ascend 社区仍在推进其支持（PR #6869），说明仍在演进中'] },
    { id: 'deploy', name: '部署形态', files: ['k8s/', 'k8s_deployment/'], summary: 'K8s 原生部署', flow: ['提供 helm chart 与 operator', '按节点角色部署元数据与存储服务', '支持与推理负载同集群或独立集群'], points: ['**存算分离部署是趋势**：KV 集群独立扩缩，与推理集群解耦', '但跨集群访问的网络成本必须计入总账'] }
  ],
},

flexkv: {
  draft: true,
  overview: `
## 一句话定位

FlexKV 是腾讯云 TACO 团队开源的**分布式 KV 存储与多级缓存管理系统**。它的独特之处在于：从 client-server 模式**转型为可直接调用的库**，去掉了进程间通信开销。

## 集成广度是它的亮点

FlexKV 的更新日志本身就是一张集成图谱：

| 时间 | 集成 |
|---|---|
| 2026-03 | 合入 vLLM 主线（v0.17.2 起内建 %%FlexKVConnectorV1%%） |
| 2026-03 | 成为 NVIDIA Dynamo 原生 KV Cache 卸载选项 |
| 2026-01 | 支持 Mooncake 做跨节点复用 |
| 2026-01 | 支持 TensorRT-LLM |
| 2025-12 | 支持 GPU Direct Storage，SSD→GPU 直传 |
| 2025-11 | 从 client-server 改为库形态（v1.0.0 API） |

> 一个值得记住的判断：**「从服务改为库」是 KV 存储这类组件的常见演化方向**。因为 KV 访问在请求关键路径上，一次 IPC 往返就可能是不可接受的开销。

## 多级缓存设计

~~~text
GPU HBM  ──►  Host DRAM  ──►  Local SSD  ──►  Remote (RDMA / Mooncake)
   ▲                                              │
   └────────────── 命中回填 ◄─────────────────────┘
~~~

每级之间的搬运方式不同：HBM↔DRAM 是拷贝，SSD 侧可走 GDS 绕过 CPU，远端走 RDMA。

## 关键能力

| 能力 | 说明 |
|---|---|
| 多级缓存 | GPU / 主机 / SSD / 远端统一管理 |
| 库形态 | 无 IPC 开销，进程内直接调用 |
| GDS 支持 | SSD ↔ GPU 直传，绕过 CPU |
| 跨节点复用 | 基于 Mooncake TE 的分布式 KV 复用 |
| 多引擎 | vLLM / TRT-LLM / Dynamo |
`,
  modules: [
    { id: 'lib', name: '库化的 API 设计', files: ['flexkv/'], summary: '进程内直接调用，去掉 IPC', flow: ['应用链接 FlexKV 库', '进程内直接调用缓存管理接口', 'KV 搬运由库内部调度'], points: ['**去掉 IPC 是它在关键路径上的核心优势**', '代价是升级需要重新链接，运维灵活性不如服务形态'] },
    { id: 'tiering', name: '多级缓存与 GDS', files: ['flexkv/'], summary: 'HBM / DRAM / SSD / 远端的分层搬运', flow: ['按 LRU 类策略在各级间换入换出', 'SSD 路径经 GPU Direct Storage 直连显存', '远端路径经 Mooncake TE 走 RDMA'], points: ['**GDS 的价值在于绕过 CPU 与系统内存**，这在 CPU 带宽成为瓶颈时收益明显', '分层策略的有效性最终取决于「换入是否比重算更快」'] },
    { id: 'adapters', name: '引擎适配', files: ['docs/vllm_adapter/', 'docs/dynamo_integration/', 'docs/dist_reuse/'], summary: 'vLLM / TRT-LLM / Dynamo 三种接入', flow: ['vLLM 走 %%FlexKVConnectorV1%%（已进主线）', 'Dynamo 作为原生卸载选项', 'TRT-LLM 走专用适配'], points: ['**进入 vLLM 主线意味着零补丁可用**，这是社区型组件的重要里程碑', '同一组件适配三个框架，验证了 KV Connector 抽象的有效性'] }
  ],
},

memcache: {
  draft: true,
  overview: `
## 一句话定位

MemCache 是华为昇腾开源的高性能**分布式 KV 缓存**（2025-11 开源），作为 vLLM-Ascend 的 **KV Pool 后端**之一，主要服务于 PrefixCache 加速场景。

## 定位与形态

| 维度 | 说明 |
|---|---|
| 层级 | L4 KV 存储 |
| 角色 | vLLM-Ascend KV Pool 的三个后端之一（另有 Mooncake、Yuanrong） |
| 接入 | 经 %%AscendStoreConnector%% 的 backend 接口 |
| 实现 | %%vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/backend/memcache_backend.py%% |

## 职责边界：为什么它是「后端」而不是「传输」

MemCache 解决的是「**KV 存在哪、怎么被检索**」；把 KV 从 NPU 搬进去这件事，交给 AscendStoreConnector 加传输引擎完成。三层职责分得很清楚：

~~~text
vLLM-Ascend
    │  KVConnectorBase_V1
AscendStoreConnector          ← 契约层：搬哪些、什么时候搬
    │  backend 接口
MemCache                      ← 存储层：键值索引 + 空间管理 + 淘汰
    ▲
    │  传输引擎
Mooncake TE / HIXL / MemFabric  ← 传输层：字节怎么过去
~~~

> 这个划分值得借用到自己的系统设计里：**「决定搬什么」「东西存在哪」「字节怎么过去」是三件独立的事**，混在一起会让每一件都做不好。

## 一个值得注意的差异：目前唯一支持 layerwise 的后端

vLLM-Ascend 的 KV Pool 有一个参数 %%use_layerwise%%（逐层保存/加载 KV），文档明确写着：

> **Only supported on the Prefill node and requires the %%memcache%% backend.**

这不是小事。layerwise 是**让 KV 搬运与逐层计算重叠**的关键手段——[Mooncake](#/c/mooncake) 与 [HIXL](#/c/hixl) 都强调单边通信与逐层流水是隐藏传输延迟的前提，但在这个 KV Pool 的实现里，**只有 MemCache 后端走通了这条路**。

说明什么：

- 存储后端不只是「一块能放 KV 的地方」，它的接口设计**决定了上层能不能做流水线**
- 一个只提供同步 put/get 的后端，无论底层传输多快，都无法与计算重叠
- 反过来，这也是评估任何 KV 存储后端的核心问题：**它支不支持分层的、异步的、可部分完成的读写？**

## 评估这类组件时该看什么

它的开源时间较晚（2025-11）但推进很快，已作为 vLLM-Ascend backend 使能推理加速，并有 PrefixCache 案例实践沉淀。这类**厂商自研 + 社区集成**的组件，除了性能，重点应看：

- **接口稳定性**：KV Pool 的 backend 接口仍在演进（Yuanrong 支持即以 PR 形式推进）
- **跨版本兼容**：与 CANN、vLLM-Ascend 的版本绑定关系
- **能力覆盖**：是否支持 layerwise、异步加载（%%load_async%%）、QoS 等影响上层的开关
`,
  modules: [
    {
      id: 'arch', name: '分布式 KV 缓存架构',
      files: ['src/', 'CMakeLists.txt', 'VERSION'],
      summary: '键值索引与分布式空间管理',
      flow: [
        '客户端经 SDK 接入 MemCache 服务',
        '元数据 / 索引服务定位目标 KV 块所在节点',
        '空间不足时按策略淘汰冷数据',
        '对外提供 KV 块的读写原语'
      ],
      points: [
        '**索引服务在查询关键路径上**，其延迟直接决定「KV 命中」能省下多少——如果查索引比重新 prefill 还慢，缓存就没有意义',
        '与 [Mooncake](#/c/mooncake) 的 Master 属于同类角色，可横向对比元数据分片与快照策略',
        'C++ 实现 + Python 绑定，是昇腾侧存储组件的常见形态'
      ]
    },
    {
      id: 'kvpool', name: 'KV Pool 后端接入',
      files: ['vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/backend/memcache_backend.py', 'tests/ut/distributed/ascend_store/'],
      summary: '实现 backend 契约，并被 KV Pool 调度',
      flow: [
        '在 %%memcache_backend.py%% 中实现 AscendStoreConnector 定义的 backend 接口',
        '提供 KV 块的 put / get / lookup',
        '配合传输引擎（Mooncake TE / HIXL / MemFabric）完成 NPU ↔ 缓存搬运',
        '响应 %%use_layerwise%% 配置，走逐层保存/加载路径'
      ],
      points: [
        '**接入契约由 connector 定义，不由存储产品定义**——这是中间层设计的价值：换后端不改引擎',
        '它是三个后端里唯一支持 layerwise 的，这条能力差异应该进入选型对比表',
        '配套单测在 %%tests/ut/distributed/ascend_store/%% 下，读它可以快速理解契约'
      ]
    },
    {
      id: 'prefix', name: 'PrefixCache 场景与收益核算',
      files: ['doc/', 'example/'],
      summary: '前缀缓存是最直接的收益场景',
      flow: [
        '相同前缀的请求复用缓存中的 KV，跳过对应 prefill',
        '典型场景：固定系统提示词、多轮对话、RAG 共享上下文',
        '官方 wiki 有 PrefixCache 加速的实践案例'
      ],
      points: [
        '**缓存的有效性要用「省下的 prefill 算力」衡量，而不是命中率**：命中率高但每次只省几十个 token 是没有意义的',
        '前缀分布决定一切——通用调参建议的参考价值有限，必须结合自己的流量特征分析',
        '与 KV 量化配合时收益会叠加：存的 KV 更小，同样空间能放更多前缀'
      ]
    },
    {
      id: 'ops', name: '部署与版本约束',
      files: ['config/', 'script/'],
      summary: '环境依赖与配置要点',
      flow: [
        'KV Pool 特性要求 **CANN >= 8.5.0**',
        '部署前需确认 %%hccn.conf%% 存在；昇腾 950 产品还需挂载额外设备与配置文件',
        '启用 KV Pool 时要求各节点 **%%PYTHONHASHSEED%% 一致**，否则哈希不一致会导致缓存永远不命中',
        '按 %%config/%% 配置缓存规模与淘汰策略'
      ],
      points: [
        '**%%PYTHONHASHSEED%% 必须同步这条极易踩坑**：跨节点哈希不一致时，缓存看起来在工作，实际一直不命中，排查成本很高',
        '版本约束是昇腾侧的常态：CANN、torch-npu、vLLM-Ascend 应作为一个整体管理',
        '%%hccn.conf%% 缺失是部署阶段最常见的失败，属于 HCCL 网络层而非 MemCache 自身'
      ]
    }
  ],
},

ucm: {
  draft: true,
  overview: `
## 一句话定位

UCM（Unified Cache Manager）是华为 **ModelEngine** 社区开源的**统一缓存管理框架**，中心是「**KV Cache 多级缓存 + 推理记忆管理**」。它最大的特点是**把稀疏注意力算法做成了可插拔件**——类似 KV Connector 生态，但针对的是「哪些 KV 需要参与计算」这个问题。

## 先澄清一个容易搞错的定位

UCM 出自华为主导的 ModelEngine 社区，但它**不是昇腾专属组件**。证据在它自己的构建配置里：

~~~cmake
set(RUNTIME_ENVIRONMENT "simu" CACHE STRING
    "runtime: simu, ascend, ascend-a3, musa or cuda.")
option(ASCEND_SUPPORTS_REGISTER_PIN
    "enable Ascend register pin optimization (requires CANN >= 8.5)" OFF)
~~~

- 可选 runtime 覆盖 **simu / ascend / ascend-a3 / musa / cuda**——CUDA 是一等公民
- Ascend 相关能力（register pin 优化）是**默认关闭的编译选项**，属于加速项而非身份

它同时提供 **vLLM 与 vLLM-Ascend 两条快速开始路径**，也是同一个道理：先有硬件中立的框架，再有各平台的具体接入。

> 所以在本知识库里，UCM 按**功能**归入 L4（以 KV 多级缓存与外部存储为中心），而不是按厂商血统归类。
> 把它当成「昇腾组件」会误导读者以为它只能在昇腾上跑。同类情况还有 [openYuanrong DataSystem](#/c/yuanrong-ds)——
> 同属国产开源生态，但构建上同时支持 Ascend 与 CUDA 后端。

## 四个关键组件

UCM 的架构是把「稀疏算法」与「存储后端」两层依赖都反转掉：

| 组件 | 职责 |
|---|---|
| **UcmSparseBase** | 稀疏算法的统一基类，负责稀疏 KV block 的卸载、加载与计算，实现「零感知」插拔 |
| **SparseKVManager** | 面向算法定制的 KV block 分配总控；各稀疏算法以多态子类注入自己的分配逻辑 |
| **UcmKVStoreBase** | 与外部存储通信的通用接口，**让稀疏算法与存储后端解耦** |
| **UC Connector** | 桥接存储组件与推理引擎，对接 vLLM 的 %%KVConnectorBase_V1%% |

这个设计的价值在于：**新来一个稀疏算法，不需要改存储；换一个存储后端，不需要改算法。**

## 四大能力与官方数据

| 能力 | 说明 |
|---|---|
| 稀疏注意力 | 只加载真正会被读到的 KV |
| 前缀缓存 | KV 持久化，跨请求跨重启复用 |
| 预填充卸载 | prefill 阶段的 KV 可直接落到外部存储 |
| 异构 PD 解耦 | 基于存算分离的 PD 分离 |

官方给出的收益量级：**首 token 时延最高降低 90%，系统吞吐最大提升 22 倍，上下文窗口 10 倍级扩展**。

> 这三个数字要分开看：时延降低主要来自稀疏检索（少读少算），吞吐提升来自卸载（显存腾出来给更大 batch），上下文扩展来自持久化。**它们不是同一个机制的红利。**

## 稀疏化为什么是长上下文的必答题

长上下文场景下 KV 的有效利用率往往很低——**大部分历史 token 对当前 query 的贡献可以忽略**。稀疏检索直接同时降低三个成本：

- **显存占用**：要放的 KV 少了
- **计算量**：attention 范围小了
- **传输与存储量**：要搬要存的 KV 少了

> 这也是「KV 格式演进」这条主线的又一个例证：**当注意力本身变稀疏，整个栈的成本模型都要重算**——包括 L1 的调度（怎么预估耗时）、L3 的传输（搬哪些块）、L4 的存储（怎么索引子块）。

与 vLLM-Ascend 里的 %%sparse_kv_offload%% 属于同一技术方向的两条独立实现，值得横向对比。
`,
  modules: [
    { id: 'sparse-base', name: 'UcmSparseBase：稀疏算法的插拔基座', files: ['ucm/'], summary: '把稀疏算法做成可插拔件', flow: ['定义稀疏 KV block 的卸载、加载与计算接口', '在 scheduler 与 attention 层植入 hook 点', '各稀疏算法以子类形式接入，互不影响'], points: ['**hook 点是关键设计**：它让稀疏化不需要改推理主流程，做到「零感知」插拔', 'hook 位置选在 scheduler 与 layer 两处，说明稀疏化既要影响「读什么」也要影响「算什么」', '这与 KV Connector 的思路同构——都是把可变部分抽成接口'] },
    { id: 'sparse-mgr', name: 'SparseKVManager：块分配与算法解耦', files: ['ucm/'], summary: '不同稀疏算法有自己的分配策略', flow: ['作为 KV block 分配的「总控」，接收各算法的分配诉求', '算法以多态子类注入自身分配逻辑', '框架统一调用基类接口，具体实现由子类完成'], points: ['**分配策略必须可定制**：不同稀疏算法对 block 的粒度与布局要求不同，硬编码一种会限制算法空间', '把「分配」与「计算」分开，是这个框架能同时容纳多种算法的前提'] },
    { id: 'store-abst', name: 'UcmKVStoreBase 与 UC Connector', files: ['ucm/'], summary: '让存储后端与稀疏算法互不感知', flow: ['%%UcmKVStoreBase%% 定义与外部存储通信的通用接口，以 ID + 偏移量标识数据块', '任何稀疏算法都能与任意存储系统协作', '%%UC Connector%% 把存储组件与 vLLM 的 %%KVConnectorBase_V1%% 桥接起来', '参考实现 %%NFSStore%% 支持单机本地文件系统或 NFS 挂载'], points: ['**「ID + 偏移量」这套寻址天然兼容前缀缓存**：不依赖具体存储的组织方式', '同一条抽象既能服务稀疏场景又能服务前缀缓存，说明接口粒度选得准', '参考实现选 NFS 很务实——它证明了「有持久化文件系统就能接入」这个下限'] },
    { id: 'disagg', name: '异构 PD 解耦与预填充卸载', files: ['ucm/'], summary: '用存储做中介解耦 P/D 两侧', flow: ['prefill 把 KV 直接写入共享存储（预填充卸载）', 'decode 从存储拉取所需 KV，不必与 prefill 直连', '两侧独立扩缩，资源配比更自由'], points: ['**用存储做中介解耦了 P/D 的直接依赖**，部署拓扑更灵活', '代价是多一跳，对存储带宽要求更高——收益取决于存储能否扛住热前缀的读压力', '「异构」指的是 P 与 D 可以跑在不同硬件上，这是解耦带来的直接好处'] }
  ],
},

hf3fs: {
  draft: true,
  overview: `
## 一句话定位

3FS（Fire-Flyer File System）是 DeepSeek 开源的高性能分布式文件系统，为 AI 训练与推理场景设计。在 KV 存储栈中，它是 **Mooncake、LMCache 等系统可选的底层持久化层**。

## 为什么 KV 存储需要它

DRAM 池装不下所有 KV，必然要向 SSD 延伸。而"向盘上延伸"的性能瓶颈不在 SSD 本身，而在**访问路径**：

| 路径 | 说明 | 代价 |
|---|---|---|
| 应用 → 内核 FS → 页缓存 → SSD | 传统路径 | 多次内存拷贝 + 上下文切换 |
| 应用 → USRBIO → SSD | 用户态直接 I/O | 绕过内核，减少拷贝 |
| 应用 → GDS → SSD → GPU | GPUDirect Storage | 直达显存，CPU 不参与 |

3FS 通过 **USRBIO（用户态 I/O）** 与 **FUSE 双路径**设计，让高性能场景能绕开内核开销。

## 在栈里的位置

3FS 属于 L4 存储层的**基础设施**，不是 KV 专用系统。它与 KV 系统是「被依赖」关系：

~~~text
LMCache ──► hf3fs_connector ──┐
Mooncake ──► hf3fs/ ────┼──► 3FS (USRBIO / FUSE)
FlexKV ──► GDS 路径 ──────────┘
~~~

## 关键能力

| 能力 | 说明 |
|---|---|
| 强一致 | 链式复制 CRAQ，保证一致性 |
| USRBIO | 用户态零拷贝 I/O |
| FUSE 客户端 | 标准文件接口，兼容性好 |
| 小文件优化 | 元数据与数据分离，支撑海量小文件 |
| 训练集成 | 与 PyTorch 数据加载集成 |

> 判断要点：一个 KV 存储系统要不要自研底层 FS，取决于它对延迟的要求。**如果只是「慢一点但便宜」的容量层，用现成 FS 更务实；如果进入关键路径，就需要 3FS 这种级别的底层控制。**
`,
  modules: [
    { id: 'arch', name: '架构与一致性', files: ['src/'], summary: '元数据/存储分离 + CRAQ 链式复制', flow: ['元数据服务管理文件到 chunk 的映射', '存储服务按链式复制保证一致性', '客户端并发读写多个 chunk 聚合带宽'], points: ['**元数据与数据分离**是支撑海量小文件的标准手法', 'CRAQ 在保证强一致的同时允许从任意副本读，读吞吐好'] },
    { id: 'usrbio', name: 'USRBIO 与访问路径', files: ['src/client/'], summary: '用户态 I/O 绕过内核开销', flow: ['应用通过 USRBIO API 提交 I/O', '共享内存环传递请求，避免系统调用', '批量提交与完成，摊薄开销'], points: ['**USRBIO 是它区别于通用 FS 的核心**：把 I/O 从「系统调用」变成「共享内存通信」', '不经过页缓存意味着应用要自己管对齐与缓冲'] },
    { id: 'kvuse', name: '作为 KV 存储底座', files: ['src/'], summary: '被 KV 系统作为持久化层使用', flow: ['LMCache 经 hf3fs_connector 接入', 'Mooncake 有 hf3fs/ 子模块', '把冷 KV 下沉到盘，形成 DRAM+SSD 分层'], points: ['**「KV 存储系统 + 高性能 FS」是当前冷 KV 落盘的主流组合**', '要评估端到端收益，必须把 FS 的读延迟与 prefill 重算时间放在一起比'] }
  ],
}

});
