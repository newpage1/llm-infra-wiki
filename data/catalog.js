/* ============================================================
   LLM Infra Wiki — 编目数据
   4 个层级 + 27 个组件 + 1 个底座。

   建模原则：**每个组件只属于一层，不做跨层标记。**
   垂直整合的产品（同一个仓库里既有传输又有存储）**不按内部子系统拆卡**——
   拆了同一个仓库就会在两处各出现一次，读者得在两处拼起来才看得全。
   判据是**它的主要用途**：
       Mooncake                → L4（它是个分布式 KV 池，自带的传输引擎只是实现手段）
       HIXL / NIXL / MemFabric → L3（以「把字节搬过去」本身为目的，可脱离存储单独用）
   这样才能回答「这个组件具体在哪一层」，而不是把同一张卡在两处列两遍。

   actions  = 该层在一次请求生命周期中承担的动作（层间"直接交互"）
   handoff  = 本层交给下一层的东西
   ============================================================ */

window.WIKI_LAYERS = [
  {
    id: 'scheduling',
    num: 'L1',
    name: '集群调度',
    en: 'Cluster Scheduling',
    color: '#b8491c',
    colorDim: '#e8c3b1',
    wash: 'rgba(184,73,28,.07)',
    tagline: '决定一个请求落到哪个实例、哪张卡，以及什么时候扩缩容。',
    handoff: '已编排的请求 → 引擎实例',
    questions: [
      '请求怎么路由？按什么打分——队列长度、KV 命中率还是显存水位？',
      '实例怎么编排？PD 分离后 prefill / decode 池如何各自扩缩？',
      'PD 之间、实例之间的 KV 如何被发现与寻址？'
    ]
  },
  {
    id: 'engine',
    num: 'L2',
    name: '推理引擎',
    en: 'Inference Engine',
    color: '#c08a0c',
    colorDim: '#eddcb4',
    wash: 'rgba(192,138,12,.09)',
    tagline: '单实例内部：怎么组批、怎么算 Attention、怎么在显存里摆放 KV。',
    handoff: '新算出的 KV → 传输通道',
    questions: [
      '请求进来后如何被切分、调度、组成 batch？',
      'KV Cache 的物理布局是怎样的（Paged / Radix / 分层）？',
      'KV 复用发生在引擎内的哪一层？跨实例又如何接出去？'
    ]
  },
  {
    id: 'transport',
    num: 'L3',
    name: 'KV 传输',
    en: 'KV Transport',
    color: '#8f5f7d',
    colorDim: '#e0cbd8',
    wash: 'rgba(143,95,125,.08)',
    tagline: '在「注册过的内存段」之间搬字节。这一层不认识 KV 块，也不懂 paged 布局——那是引擎的事。',
    handoff: 'KV 已到位 → 继续解码',
    questions: [
      '谁来搬？CPU memcpy、RDMA、NVLink、还是 UB 内存语义？',
      '搬之前如何握手？元数据、注册内存、地址如何交换？',
      '传输与计算如何重叠？layerwise / chunked 流水线怎么切？',
      '边界：**H2D / D2H（显存 ↔ 主机内存）不属于本层**——它需要按 slot_mapping 把 KV 散进分页池，属于引擎侧的事务',
      '边界：「搬哪些、什么时候搬」由引擎侧的 KV Connector 决定，也不属本层'
    ]
  },
  {
    id: 'storage',
    num: 'L4',
    name: 'KV 存储',
    en: 'KV Storage',
    color: '#5f7a37',
    colorDim: '#cfdaba',
    wash: 'rgba(95,122,55,.09)',
    tagline: 'KV 落在哪里：DRAM 池、SSD、分布式文件系统，以及如何被检索与淘汰。',
    handoff: '本轮算完的 KV → 存储系统',
    questions: [
      'KV 以什么粒度（block / chunk / layer）被寻址与索引？',
      '多级缓存的准入、淘汰、写回策略是什么？',
      '如何做到跨节点共享与一致性？'
    ]
  }
];

/* ---------------------------------------------------------------- */
/* 一条请求与它的 KV —— 全链路                                        */
/*                                                                    */
/* 关键结构：KV 有两次流动，夹着一次计算。                             */
/*                                                                    */
/*     KV 入向（算之前搬进来） → 计算 → KV 出向（算完搬出去）           */
/*                                                                    */
/* 只讲出向是错的：那只描述了 prefill 侧「算完把 KV 送出去」，           */
/* 漏掉了 decode 侧「KV 送进来才能算」。计算没有 KV 就无法进行。        */
/*                                                                    */
/* 因此 order 上「入向」必须排在「计算」之前。                        */
/* ---------------------------------------------------------------- */
window.WIKI_FLOW = {
  title: '一条请求与它的 KV',
  sub: '四层不是四个独立的盒子，而是同一条链路上依次接手的四个环节。' +
       '关键结构是：KV 有**两次**流动，夹着**一次**计算——' +
       '算之前要把命中的 KV 搬进来（入向），算完要把新产生的 KV 送出去（出向）。' +
       '出向落下的 KV，又成为下一个请求入向的来源，链路在这里闭合成环。',
  note: '本表描述**单个实例内**一条请求的 KV 生命周期。标「条件」的步骤只在命中时发生——' +
        '冷启动请求没有入向，直接算。PD 分离是部署形态（见上方拓扑图），不是这里的通用步骤。',
  steps: [
    /* ── 阶段一：决策 ───────────────────────────────── */
    { k: 'phase', title: '决策', desc: '谁来做、能省多少' },

    { k: 'step', n: 1, layer: 'scheduling', kind: 'req', title: '请求到达',
      desc: '网关接收 HTTP 请求，渲染对话模板、解析采样参数，转成内部统一的请求对象。',
      impl: {
        ascend: 'vLLM-Ascend 自带的 OpenAI API Server，或 MindIE-Service',
        nvidia: 'vLLM / TensorRT-LLM 的 OpenAI API Server，Dynamo 的 Frontend 做前置代理'
      } },
    { k: 'step', n: 2, layer: 'scheduling', kind: 'req', title: '路由决策',
      desc: '按候选实例的 KV 命中长度、队列深度、显存水位打分；PD 分离时先选 prefill 池、再选 decode 池。' +
            '**注意这一步查的是 L4 的索引与 L2 上报的状态**——决策本身依赖另外两层。',
      impl: {
        ascend: 'MindIE PyMotor 的 PD 编排与负载均衡',
        nvidia: 'NVIDIA Dynamo 的 KV-aware Router 配合 Planner 做二维扩缩'
      } },

    { k: 'handoff', label: '已编排的请求 → 引擎实例' },

    { k: 'step', n: 3, layer: 'engine', kind: 'req', title: '前缀查询',
      desc: '这段前缀算过没有？**命中的 KV 可能在三个地方**：本实例显存里（自己刚算过）、别的实例显存里（跨实例前缀缓存）、共享 KV 池里。查询结果是后面「入向」的依据。' +
            '**注意与 PD 直传区分**——PD 传给 decode 的是本次请求自己的 KV，不属于「命中」。',
      impl: {
        ascend: 'vLLM-Ascend 的 KV Pool，经 AscendStoreConnector 查询 MemCache / Yuanrong / Mooncake',
        nvidia: 'LMCache 的 lookup，或 Dynamo 的 KV Indexer 做近似前缀索引'
      } },
    { k: 'step', n: 4, layer: 'engine', kind: 'req', title: '分配槽位',
      desc: '为命中部分预留落点、为未命中部分分配新块，产出供 kernel 使用的 block_table。' +
            '**注意：此时分配的是「KV 要落在哪」的地址，不是 KV 本身。**',
      impl: {
        ascend: 'vLLM-Ascend 复用 vLLM 的分页 KV 池，显存由 CANN Runtime 管理',
        nvidia: 'vLLM 的 BlockPool + KVCacheManager；TRT-LLM 则是 Paged KV Cache'
      } },

    /* ── 阶段二：KV 入向 ────────────────────────────── */
    { k: 'phase', title: 'KV 入向', desc: '计算的前置条件——没有 KV，计算无法开始' },

    { k: 'step', n: 5, layer: 'storage', kind: 'kv', optional: true, title: 'KV Pool 命中取回',
      desc: '这段前缀是**之前的请求**算过的，存在共享 KV 池里。L4 先定位它在哪台机器，再经 L3 取回。' +
            '**这才是严格意义上的「命中」**——跨请求、跨实例的前缀复用。' +
            '注意它落地时要过一次 **H2D**（池在主机内存或远端，最终要进设备显存）——那一跳由引擎侧的 connector 完成。',
      impl: {
        ascend: 'AscendStoreConnector 经 MemCache / Yuanrong / Mooncake 后端定位并取回',
        nvidia: 'LMCache 的 retrieve（远端命中会自动回填本地），或 Mooncake / FlexKV 的 get'
      } },
    { k: 'step', n: 6, layer: 'transport', kind: 'kv', optional: true, title: '从邻实例取回',
      desc: '命中的 KV 不在池里，而在**别的实例的显存里**——经 L3 直接读过来，不经过池。' +
            '这是 P2P 路径：延迟比走池低，代价是要知道对端在哪、且对端得留着这段 KV。' +
            '与上一步同属**缓存命中**性质——复用的都是**之前请求**算过的结果。',
      impl: {
        ascend: 'LMCache-Ascend 的 AscendP2PBackend（pull 模式）从邻实例读；或 Mooncake 的 p2p-store',
        nvidia: 'LMCache 的 P2PBackend 走 NixlChannel；或 Mooncake p2p-store'
      } },

    { k: 'handoff', label: 'KV 已就位 → 计算才可以开始' },

    /* ── 阶段三：计算 ───────────────────────────────── */
    { k: 'phase', title: '计算', desc: '消费已就位的 KV，同时生产新的 KV' },

    { k: 'step', n: 7, layer: 'engine', kind: 'req', title: '执行计算',
      desc: '跑 forward，attention 按 block_table 读写分页 KV。' +
            '**这一步既消费 KV（前 5/6 步搬进来的），也生产 KV（本步新算出的层）**——它是 KV 的汇合点与产源地。',
      impl: {
        ascend: 'CANN 的 AOL 算子，加上 vLLM-Ascend csrc/ 里的自定义算子（MLA / MoE / GMM / mc2）',
        nvidia: 'CUDA kernel，走 FlashAttention / FlashInfer 等可插拔后端'
      } },
    { k: 'step', n: 8, layer: 'engine', kind: 'req', title: '采样输出',
      desc: '逐 token 采样、detokenize，流式返回客户端。',
      impl: {
        ascend: '采样在 Worker 侧完成，只把 token id 传回 EngineCore',
        nvidia: '同上——这一步两条栈的实现基本一致'
      } },

    /* ── 阶段四：KV 出向 ────────────────────────────── */
    { k: 'phase', title: 'KV 出向', desc: '把这一步新产生的 KV 送出去' },

    { k: 'handoff', label: '新算出的 KV → 传输通道' },

    { k: 'step', n: 9, layer: 'transport', kind: 'kv', title: '注册与握手',
      desc: 'KV 缓冲注册为可被远端直接访问的段，与对端交换地址、可用链路与网卡拓扑。',
      impl: {
        ascend: 'HIXL 注册内存段（HCCS / RDMA 多链路）；另一条路是 MemFabric 的 UB 内存语义',
        nvidia: 'NIXL 的 registerMem + dlist，或 Mooncake 的传输引擎做段注册'
      } },
    { k: 'step', n: 10, layer: 'transport', kind: 'kv', title: '提交搬运',
      desc: '把新算出的 KV 送给需要它的地方：默认是 KV 池。（PD 分离部署下则直传给 decode 实例——那是同一条出向的另一种落点。）按 block 列表发起单边异步传输。',
      impl: {
        ascend: 'HIXL 单边异步传输（在 Mooncake 里即 ascend_direct 通路）',
        nvidia: 'NIXL 的 postXferReq，或 Mooncake TE 的 RDMA / NVLink 路径'
      } },
    { k: 'step', n: 11, layer: 'transport', kind: 'kv', title: '与计算重叠',
      desc: '逐层流水：第 N 层算完就传第 N 层，不必等整个 forward 结束。' +
            '**入向与出向都适用这条**——传输延迟被藏在计算后面。',
      impl: {
        ascend: 'layerwise 逐层搬运；注意 KV Pool 侧目前只有 MemCache 后端支持 use_layerwise',
        nvidia: 'vLLM KV Connector 的 wait_for_layer_load + NIXL 的 block 列表'
      } },

    { k: 'handoff', label: '本轮算完的 KV → 存储系统' },

    { k: 'step', n: 12, layer: 'storage', kind: 'kv', title: '构造键',
      desc: '按前缀哈希生成 KV 块的全局唯一标识。只要 token 前缀相同，键就相同——与请求顺序、实例重启无关。',
      impl: {
        ascend: 'vLLM-Ascend 的 block 哈希链（跨节点必须同步 PYTHONHASHSEED，否则永不命中）',
        nvidia: 'vLLM 的 block 哈希链，或 LMCache 的 CacheEngineKey（含 chunk 内容哈希）'
      } },
    { k: 'step', n: 13, layer: 'storage', kind: 'kv', title: '写入落存',
      desc: 'KV 落到 DRAM 池 / SSD / 分布式文件系统；冷数据按策略继续向下沉。',
      impl: {
        ascend: 'MemCache（目前唯一支持 layerwise 的后端）、openYuanrong DataSystem，或 Mooncake 的 NPU 版',
        nvidia: 'Mooncake、FlexKV 多级缓存、LMCache 本地盘后端，冷数据沉到 3FS'
      } },
    { k: 'step', n: 14, layer: 'storage', kind: 'kv', title: '登记索引',
      desc: '更新全局「键 → 位置」映射，让集群里任何实例都能查到这段 KV 在哪。',
      impl: {
        ascend: 'MemCache 的索引服务，或 DataSystem 的元数据服务',
        nvidia: 'Mooncake 的 Master，或 LMCache 的 CacheController'
      } },

    { k: 'loop', label: '下一个请求进来时，L4 的索引回到 L1',
      desc: '这次落存的 KV 位置，成为下一个请求在 L1 路由打分的输入；' +
            '下一个请求的「入向」正是从这次「出向」的结果里取的。链路在这里闭合成环——' +
            '这也是为什么四层必须放在一起看：任何一层的状态变化，都会改变其它层的最优解。',
      impl: {
        ascend: '回流到 MindIE PyMotor 的路由打分',
        nvidia: '回流到 Dynamo Router 的 KV Indexer'
      } }
  ]
};
/* ---------------------------------------------------------------- */
/* 组件：每个组件只属于一层（primary），无跨层标记                     */
/* status: deep = 有完整代码流程走读；outline = 有概览+模块骨架        */
/* ---------------------------------------------------------------- */
window.WIKI_COMPONENTS = [
  /* ============ L1 集群调度 ============ */
  {
    id: 'dynamo', name: 'NVIDIA Dynamo', primary: 'scheduling', runs: ['nvidia'], port: 'sdk',
    portNote: "官方支持矩阵只列 NVIDIA Ampere→Blackwell，发行物全是 NGC CUDA 容器，源码无昇腾实现。但它只是引擎之上的编排层，理论上可对接 vLLM-Ascend + NIXL 的 HIXL 后端——属生态缺失，非架构不可能。昇腾侧的对应物是 PyMotor。",
    org: 'NVIDIA', repo: 'https://github.com/ai-dynamo/dynamo',
    lang: 'Rust / Python',
    role: '数据中心级分布式推理框架，KV-aware 路由 + Planner 自动扩缩',
    status: 'deep',
    highlights: [
      "**引擎之上的编排层**：不替换 vLLM / SGLang / TRT-LLM，而是把它们组成多节点系统",
      "**KV-aware 路由**：用近似前缀索引估算每个实例的命中长度，命中率直接决定 prefill 成本",
      "**Planner 依赖离线 profiler**：先测出不同 batch 下的吞吐/延迟曲线，再按 SLA 反推扩缩容——没有性能模型就没有自动扩缩",
      "**Rust + Python 混合**：路由与控制面在 Rust，业务流程在 Python；路由在请求关键路径上，用 Python 写会成为瓶颈",
      "**PD 扩缩是二维问题**：prefill 实例数与 decode 实例数依赖不同资源特征，必须分别决策"
    ]
  },
  {
    id: 'aibrix', name: 'AIBrix', primary: 'scheduling', runs: ['nvidia', 'ascend'], port: 'neutral',
    org: '字节跳动 / vLLM 社区', repo: 'https://github.com/vllm-project/aibrix',
    lang: 'Go / Python',
    role: 'K8s 原生推理控制面：KV-aware 路由、LoRA 管理、弹性伸缩',
    status: 'outline',
    highlights: [
      "**K8s 原生控制面**：不自造数据面，尽量复用 Gateway API / CRD / HPA 等既有扩展点",
      "**前缀缓存事件驱动的路由**：订阅各 Pod 上报的缓存事件维护路由索引——时效性是核心难点",
      "**分布式 KV Cache 元数据独立成服务**：与数据面分离，代价是多一次网络查询",
      "**按推理指标扩缩容**：用队列深度与 KV 显存水位，而不是 CPU 利用率（decode 阶段 CPU 常年空闲）"
    ]
  },
  {
    id: 'llm-d', name: 'llm-d', primary: 'scheduling', runs: ['nvidia', 'ascend'], port: 'neutral',
    org: 'Red Hat / Google / IBM 等', repo: 'https://github.com/llm-d/llm-d',
    lang: 'Go / Python',
    role: 'K8s 原生分布式推理栈：Gateway + Inference Scheduler + PD 编排',
    status: 'outline',
    highlights: [
      "**不造新数据面**：用 Gateway API 的 Endpoint Picker（EPP）承载推理路由",
      "**InferencePool 抽象**：把一组同构引擎实例当作一个池，并在池层面标注 prefill / decode 角色",
      "**PD 分离是一等公民**：两段式路由先选 prefill 再选 decode",
      "**代价是受限于 Gateway API 的表达能力**，换来的是与既有 K8s 运维体系的融合"
    ]
  },
  {
    id: 'pymotor', name: 'MindIE PyMotor', primary: 'scheduling', runs: ['ascend'], port: 'bound',
    org: '华为昇腾', repo: 'https://gitcode.com/Ascend/MindIE-PyMotor',
    lang: 'Python',
    role: '昇腾一键式 PD 分离/混部部署，云原生插件化调度与负载均衡',
    status: 'outline',
    highlights: [
      "**昇腾侧的编排层对应物**——NVIDIA 用 Dynamo，昇腾用 PyMotor",
      "**同时支持 PD 分离与 PD 混部**：请求普遍较短时，混部的资源利用率更高（KV 传输成本会吃掉分离收益）",
      "**插件化适配多引擎**：vLLM-Ascend 与 SGLang 走同一套编排，编排层不感知引擎差异",
      "**一键式部署**：把「怎么把 PD 跑起来」从引擎里抽出来，做成云原生插件层"
    ]
  },
  {
    id: 'volcano', name: 'Volcano', primary: 'scheduling', runs: ['nvidia', 'ascend'], port: 'neutral',
    org: 'CNCF / 华为云', repo: 'https://github.com/volcano-sh/volcano',
    lang: 'Go',
    role: 'K8s 批处理调度器，gang scheduling 支撑大规模推理 pod 组调度',
    status: 'outline',
    highlights: [
      "**资源层调度，不是请求层调度**：与 Dynamo / llm-d 属于不同层次的调度，常被混为一谈",
      "**Gang Scheduling**：TP=8 的实例必须 8 张卡同时到位，否则整组等待——默认调度器会制造大量半启动死锁",
      "**拓扑感知**：卡在不在同一超节点 / NVLink 域，直接决定并行通信性能",
      "**队列与抢占**：在线推理与离线批处理混部时的资源隔离；但抢占导致的重启对推理代价极高（KV 全丢）"
    ]
  },
  {
    id: 'ray-serve', name: 'Ray Serve / RayLLM', primary: 'scheduling', runs: ['nvidia', 'ascend'], port: 'neutral',
    org: 'Anyscale', repo: 'https://github.com/ray-project/ray',
    lang: 'Python',
    role: '通用分布式服务框架，靠 DAG 组合 prefill/decode 与自定义路由',
    status: 'outline',
    highlights: [
      "**表达力优先**：用 Python 写任意路由逻辑，prefill/decode 可自由串接成 DAG",
      "**没有内置 KV-aware 路由**，需要自己维护 KV 索引与实例选择",
      "**资源模型是通用 CPU/GPU 计数器**，表达不了「KV 显存水位」这类推理指标",
      "**适合非标编排**：多模型级联、RAG 与推理混布、自定义准入与降级"
    ]
  },

  /* ============ L2 推理引擎 ============ */
  {
    order: 10,
    id: 'vllm', name: 'vLLM', primary: 'engine', runs: ['nvidia', 'ascend'], port: 'neutral',
    portNote: "vLLM-Ascend 是官方插件，两条栈都有主线支持。",
    org: 'vLLM Project', repo: 'https://github.com/vllm-project/vllm',
    lang: 'Python / CUDA',
    role: 'PagedAttention 开创者，当前 LLM 推理引擎的事实标准',
    status: 'deep',
    highlights: [
      "**v1 引擎没有 prefill / decode 阶段之分**：每个请求用 %%num_computed_tokens%% 与 %%num_tokens_with_spec%% 追踪增量，调度器就是不断推进这个差值",
      "**KVConnector 是 PD 分离 / 跨实例前缀缓存 / KV 卸载的唯一抽象**：不为每种场景改引擎，而是定义一个 hook 接口让实现插进生命周期",
      "**connector 双角色**：SCHEDULER 侧做决策（远程有没有 KV、要不要加载、结束要不要保存），WORKER 侧做执行（真正收发张量）——所以每个 connector 都拆成 %%*Scheduler%% + %%*Worker%% 两个内部类",
      "**%%request_finished%% 返回 True 会延迟释放 block**：直到 %%get_finished%% 报告异步发送完成，避免 KV 还没发完就被覆盖",
      "**返回值里的第二个 bool 表示是否异步加载**：同步加载会阻塞调度循环，异步则是「零步推进」模式"
    ]
  },
  {
    order: 40,
    id: 'lmcache-ascend', name: 'LMCache-Ascend', primary: 'engine',
    runs: ['ascend'], port: 'bound',
    org: 'LMCache 社区 / 昇腾', repo: 'https://github.com/LMCache/LMCache-Ascend',
    lang: 'Python / C++',
    role: '以 monkey-patch 方式把 LMCache 带到昇腾 NPU 的官方插件',
    status: 'deep',
    portNote: "昇腾专属：pin 上游 LMCache 一个 tag，通过 23 个 _patch_*() 替换硬件相关实现。上游的架构与调用链完全保留，昇腾只替换内核、连接器、存储后端、传输通道等与硬件绑定的点。",
    highlights: [
      "**monkey-patch 插件，不是 fork**：pin 上游一个 tag，import 时替换硬件相关属性——上游架构与调用链完全保留",
      "**昇腾专属设备 kernel**：%%third_party/kvcache-ops%%（openEuler 项目）用 AscendC 写 %%multi_layer_kv_transfer_kernel%% 等，编译进 %%libcache_kernels.so%%",
      "**用 PAC 编解码替代 CUDA CacheGen**（%%_patch_cachegen%%）——KV 压缩在昇腾上走另一套算术编码",
      "**昇腾专属内存注册**替代 CUDA 的 %%ibv_reg_mr%%；没有 CUDA 风格的设备 UUID，用 %%npu-smi%% 取",
      "**三个 C++ pybind 模块**：%%c_ops%% / %%hccl_npu_comms%% / %%hixl_npu_comms%%——对应内核、集合通信、单边通信三条线",
      "**异步 store 引入的复杂度泄漏到引擎层**：%%_engine_state_lock%% 串行化 store/lookup，%%wait_for_pending_stores%% 由 vLLM 的 %%handle_preemptions%% 调用"
    ]
  },
  {
    id: 'sglang', name: 'SGLang', primary: 'engine', runs: ['nvidia', 'ascend'], port: 'neutral',
    portNote: "SGLang 在 srt/disaggregation/ascend 下有昇腾实现。",
    org: 'SGL Project', repo: 'https://github.com/sgl-project/sglang',
    lang: 'Python / CUDA',
    role: 'RadixAttention 前缀树复用 + 结构化输出，长前缀与 agent 场景强',
    status: 'deep',
    highlights: [
      "**RadixAttention：token 级前缀树**：比块级哈希粒度更细，系统提示词只差一个 token 也能复用绝大部分 KV",
      "**overlap scheduling**：CPU 侧调度与 GPU 侧执行重叠，把调度延迟从关键路径上拿掉",
      "**结构化输出与采样同层**：XGrammar 直接生成 token 掩码作用于 logits；jump-forward 对确定性片段一次推进多个 token",
      "**缓存结构已经分化**：%%unified_radix_cache%% / %%swa_radix_cache%% / %%mamba_radix_cache%% 并存——一种 KV 布局打天下的时代结束了"
    ]
  },
  {
    order: 20,
    id: 'vllm-ascend', name: 'vLLM-Ascend', primary: 'engine', runs: ['ascend'], port: 'bound',
    org: 'vLLM / 昇腾社区', repo: 'https://github.com/vllm-project/vllm-ascend',
    lang: 'Python / C++',
    role: 'vLLM 昇腾插件：KV Pool、KV P2P、稀疏卸载全部在这里落地',
    status: 'deep',
    highlights: [
      "**昇腾 PD 推荐 MultiConnector 叠加两个 connector**：%%MooncakeConnectorV1%%（per-request P→D 直传）+ %%AscendStoreConnector%%（跨实例前缀缓存池）",
      "**五种 PD 模式**：P2P 直传 / PD+KV Pool / PD-Mixed（单实例 %%kv_both%%）/ Layerwise PD / EPD（多模态三阶段）",
      "**layerwise 强制 %%PIECEWISE%% cudagraph**，并用 %%AttentionComputeStartGate%% 做 NPU event 同步：worker 在 attention 前记 event，传输线程等该 event 才开始搬",
      "**KV 缓冲在引擎初始化时就注册**：%%initialize_kv_cache%% 时经 %%global_te.register_buffer%% 注册，之后才能被单边 RDMA 直读",
      "**同一条 layerwise 能力在两层各有实现**（KV Pool 侧与 P2P 侧），选型时要对齐"
    ]
  },
  {
    id: 'ascend-store-connector', name: 'AscendStoreConnector', primary: 'engine', runs: ['ascend'], port: 'bound',
    org: 'vLLM-Ascend', repo: 'https://github.com/vllm-project/vllm-ascend',
    lang: 'Python',
    role: 'vLLM-Ascend 的 KV 出口插件，统一接入 MemCache / Mooncake / Yuanrong 等 KV 池',
    status: 'outline',
    highlights: [
      "**三个后端可插拔**：%%mooncake%% / %%memcache%% / %%yuanrong%%，统一继承 %%Backend%% 抽象基类",
      "**契约极小**：%%register_buffer%% / %%exists%% / %%put%% / %%get%%，外加可选的 %%batch_alloc%% / %%batch_add_lease%%（仅 memcache layerwise）",
      "**Bulk vs Layerwise 的关键差异**：Bulk 在 %%request_finished%% 后整体发，无重叠；Layerwise 在每层 attention 出口发，**第 i 层传输 ⊕ 第 i+1 层计算**",
      "**layerwise 只有 memcache 后端支持**，且只支持 Prefill 节点——这条能力差异应进入选型对比表",
      "**三个后端的传输原语完全不同**：mooncake 走 %%protocol=\"ascend\"%% 的 Store、memcache 走 %%MmcDirect%% 的 %%COPY_L2G%%，yuanrong 走 %%HeteroClient%% 的 %%MSetD2H%%"
    ]
  },
  {
    order: 30,
    id: 'lmcache', name: 'LMCache', primary: 'engine', runs: ['nvidia', 'ascend'], port: 'neutral',
    portNote: "lmcache-ascend 以 monkey-patch 方式适配昇腾，pin 上游版本运行。",
    org: 'LMCache Project', repo: 'https://github.com/LMCache/LMCache',
    lang: 'Python / C++',
    role: '跨引擎的 KV 复用层：把 KV 从显存接管到 CPU/远端多级缓存',
    status: 'deep',
    highlights: [
      "**多级存储是核心卖点**：本地 CPU RAM → 本地 SSD / GDS → P2P / NIXL / PD → 远端后端",
      "**注意 L1/L2 的含义随形态变化**：嵌入模式按介质顺序数四级；**MP 模式下 L1 专指服务端自己持有的内存，其余（含本地盘）都归 L2 的 adapter 族**",
      "**可插拔后端覆盖极广**：CPU RAM、本地 SSD、Redis/Valkey、Mooncake、InfiniStore、S3、NIXL、GDS",
      "**三套分布式子系统并存**：旧版独立 TCP KV server / P2P-NIXL-PD / 新版 MP 架构（2026-04 主推）",
      "**MP 架构直接接管 GPU 显存**：%%LMCacheMPConnector%% 实现 %%SupportsHMA%%，LMCache 作为独立 daemon，与引擎无 fate-sharing",
      "**非前缀 KV 复用靠 CacheBlend**：不只能复用相同前缀，还能融合不同前缀的 KV",
      "**可插拔 KV 变换（SERDE）**：%%cachegen%% / %%kivi%% / %%naive%% 三套编解码可换"
    ]
  },
  {
    id: 'tensorrt-llm', name: 'TensorRT-LLM', primary: 'engine', runs: ['nvidia'], port: 'bound',
    portNote: "编译期就把模型编译成 NVIDIA engine 文件，与 NVIDIA 硬件和驱动强绑定，无法移植。",
    org: 'NVIDIA', repo: 'https://github.com/NVIDIA/TensorRT-LLM',
    lang: 'C++ / Python',
    role: 'NVIDIA 官方推理引擎，极致 kernel 优化与 FP8/FP4 支持',
    status: 'outline',
    highlights: [
      "**编译期优化换取极致性能**：模型编译成 engine 文件，kernel 自动调优——代价是 engine 与硬件/TRT 版本强绑定",
      "**Paged KV Cache 是一等公民**：精细控制 %%tokens_per_block%% 与注意力窗口，支持循环缓存等长上下文策略",
      "**KV 量化走在最前**：FP8 / INT4 KV 直接减少 L3 传输量与 L4 存储量——**KV 精度格式由引擎决定，却决定了传输层与存储层的成本**",
      "**PD 分离需分别编译两套 engine**，与 NIXL 常成对出现"
    ]
  },
  {
    id: 'xllm', name: 'xLLM', primary: 'engine', runs: ['nvidia', 'ascend'], port: 'neutral',
    org: '京东', repo: 'https://github.com/jd-opensource/xllm',
    lang: 'C++ / Python',
    role: '京东开源的高性能推理引擎，面向大规模 PD 分离与国产芯片',
    status: 'outline',
    highlights: [
      "**C++ 调度核心**：把调度与批处理下沉到 C++，消除 GIL 与序列化开销，高 QPS 下差异明显",
      "**PD 分离是内建形态而非外挂能力**，接口契约更清晰，但更难复用 vLLM 生态已有的 KV 连接器",
      "**多硬件后端**：同时支持 NVIDIA 与多种国产加速卡——国产适配的难点通常在算子覆盖度而非性能"
    ]
  },
  {
    id: 'lmdeploy', name: 'LMDeploy', primary: 'engine', runs: ['nvidia'], port: 'sdk',
    portNote: "主线以 CUDA 为主，昇腾侧适配情况待核实——本页按主线发行判断，标注为待确认。",
    org: '上海 AI Lab', repo: 'https://github.com/InternLM/lmdeploy',
    lang: 'Python / CUDA',
    role: 'TurboMind 引擎，量化与长上下文场景成熟',
    status: 'outline',
    highlights: [
      "**TurboMind C++/CUDA 引擎**：模型需先转换成 TurboMind 格式，换取运行时更极致的 kernel",
      "**量化链路完整**：权重 AWQ/GPTQ + **KV Cache INT8/INT4 在线量化**——KV 量化对长上下文是刚需",
      "**持久化 batch 等机制**与 vLLM 目标一致但实现不同"
    ]
  },
  {
    id: 'mindie', name: 'MindIE', primary: 'engine', runs: ['ascend'], port: 'bound',
    org: '华为昇腾', repo: 'https://gitcode.com/Ascend/MindIE-LLM',
    lang: 'C++ / Python',
    role: '昇腾原生推理引擎，与 CANN/ATB 深度绑定',
    status: 'outline',
    highlights: [
      "**昇腾原生技术栈**，与 CANN / ATB 深度绑定，是昇腾上性能上限最高的路径",
      "**与 vLLM-Ascend 是「垂直深度 vs 生态广度」的取舍**：原生栈首发新硬件特性，vLLM 生态胜在模型覆盖速度",
      "**服务层与引擎分离**（MindIE-Service + MindIE-LLM），PyMotor 正是从服务层长出来的"
    ]
  },

  /* ============ L3 KV 传输 ============ */
  {
    id: 'nixl', name: 'NIXL', primary: 'transport', runs: ['nvidia'], port: 'sdk',
    portNote: "主线发行以 NVIDIA 生态为主。社区已有把 HIXL 适配为 NIXL 昇腾后端的实践，但非官方主线。",
    org: 'NVIDIA', repo: 'https://github.com/ai-dynamo/nixl',
    lang: 'C++ / Python',
    role: 'NVIDIA Inference Xfer Library：统一 RDMA/NVLink/GDS 传输抽象',
    status: 'outline',
    highlights: [
      "**描述符列表（dlist）是核心抽象**：把「搬什么」与「怎么搬」彻底解耦，支持批量与稀疏块",
      "**后端可插拔**：UCX / GDS / NVLink / POSIX，甚至可以把 Mooncake TE 当作后端插件",
      "**深度集成 NVIDIA 生态**：Dynamo 的默认传输底座，vLLM / TRT-LLM 的 PD 分离实现所依赖",
      "**社区已有把 HIXL 适配为 NIXL 昇腾后端的实践**——它定义抽象，HIXL 提供昇腾上的执行能力"
    ]
  },
  {
    id: 'memfabric', name: 'MemFabric', primary: 'transport', runs: ['ascend'], port: 'bound',
    org: '华为昇腾', repo: 'https://gitcode.com/Ascend/memfabric_hybrid',
    lang: 'C++ / Python',
    role: '基于灵衢（UnifiedBus）的内存池化 fabric：DRAM 与 HBM 混合池化，对外给内存语义接口',
    status: 'outline',
    highlights: [
      "**基于灵衢（UnifiedBus）的内存语义**：跨节点内存池化，访问方式接近 load/store，而非 RDMA 的显式提交-轮询",
      "**与 RDMA 路线的差异是结构性的**：内存语义下上层代码显著简化，故障域则变大",
      "**作为可替换传输引擎接入 vLLM-Ascend**：与 Mooncake TE 封装成同形 Python 接口，上层 connector 无感切换",
      "**昇腾超节点是它的前提**：互联带宽远高于以太网时，「把内存当远程资源用」才划得来"
    ]
  },
  {
    id: 'hixl', name: 'HIXL', primary: 'transport', runs: ['ascend'], port: 'bound',
    org: '华为 CANN', repo: 'https://gitcode.com/cann/hixl',
    lang: 'C++ / Python',
    role: '昇腾单边通信库：单边零拷贝、多链路，面向 KV 搬运与 PD 分离',
    status: 'deep',
    highlights: [
      "**单边零拷贝**：本地内存准备好后直接向远端内存传输，**接收方无需执行任何操作**——这是「通信与计算重叠」的技术前提",
      "**多链路屏蔽硬件差异**：原生支持 RDMA 与 HCCS，A3 上传 128M 实测 **HCCS 119 GB/s vs RDMA 22 GB/s**——这个差距决定了 PD 分离的拓扑设计",
      "**极简 API**：核心调用精简到 10 余个，C++/Python 双接口",
      "**两层组件**：HIXL Engine 搬字节，LLM-DataDist 提供**携带 KV Cache 语义**的接口",
      "**与 NIXL 是互补而非替代**：一个在抽象层，一个在实现层，可以叠起来用（社区已有 HIXL 作为 NIXL 昇腾后端）",
      "**QoS 支持多业务共享**：%%qos_priority%% 取值 [0,4]，说明 KV 传输已进入「集群里的一类流量」阶段"
    ]
  },

  /* ============ L4 KV 存储 ============ */
  {
    id: 'mooncake', name: 'Mooncake', primary: 'storage', runs: ['nvidia', 'ascend'], port: 'neutral',
    portNote: "已有 mooncake-transfer-engine-npu wheel 与 AscendDirectTransport，昇腾是主线支持的一等路径。",
    org: 'Moonshot AI / 清华', repo: 'https://github.com/kvcache-ai/Mooncake',
    lang: 'C++ / Python',
    role: '分布式 KV 池（对象层）+ 自带的零拷贝传输引擎（字节层）：上层认 key，下层只认地址',
    status: 'deep',
    highlights: [
      "**一个仓库两层，分界很干净**：上层 Store 认 %%key%% 与副本，下层 Transfer Engine 只认 %%(地址, 长度)%%——**字节全部由下层搬，Store 自己一行都不搬**",
      "**master 不碰数据**：只维护对象元数据与地址账本，数据由 client 与 client 之间用 TE 直传",
      "**镜像分配**：地址分配器跑在 master，内存物理上在 client——master 做纯地址运算，因此能全局统筹配额又不必搬数据",
      "**不可变对象 + 5s 租约读**：KV 是只写一次、读多次、且**读错了可以重算**的数据，所以不需要强一致，但需要租约防「读一半被淘汰」",
      "**%%protocol%% 参数是昇腾关键**：它**同时**选择内存分配器与传输实现；%%protocol=\"ascend\"%% 会经 %%ascend_allocate_memory%% 分配 NPU 内存并装上升腾 transport",
      "**1024 个哈希分片**元数据，每片一把 shared_mutex——单全局锁在这个规模下必然成为瓶颈",
      "**淘汰复用租约信息**：「租约时间近似 LRU」零额外成本拿到近似效果；hard-pin 永不淘汰、soft-pin 30 分钟保护",
      "**dummy-real 分离**解决多 rank 抢资源：推理进程内每个 TP rank 一个轻量代理，共享同机一个 real client 的网卡与内存",
      "**传输内核 + 建在内核上的三层服务**：Store 只是其中最厚的一层，另有 p2p-store / pg / ep",
      "**控制面与数据面分离**是贯穿全仓库的第一原则：小消息走控制通道协商出「句柄」，大数据凭句柄直连；数据面终点是 %%ibv_post_send%% 单边 RDMA，对端 CPU 零参与",
      "**13+ 种 Transport**：RDMA / TCP / NVMe-oF / CXL / NVLink / EFA / UB / 昇腾……链路可插拔是它能在两套生态都落地的前提",
      "**双向选网卡是独门设计**：提交时在本地拓扑为 source 选网卡，worker 下发时又在**对端发布的拓扑副本**上为 dest 选网卡，两侧共同决定 %%peer_nic_path%%",
      "**重试次数本身驱动降级**：%%retry_cnt%% 直接喂给 %%selectDevice%% 依序遍历 preferred→avail，不需要额外状态机",
      "**四级摊薄单点队列**：MultiTransport 按协议 → RdmaTransport 按 NIC → WorkerPool 按 8 shard → EndPoint 按多 QP",
      "**%%BatchID%% 就是 %%BatchDesc*%% 指针的整数重解释**——绕过 map 查找的热路径优化，代价是调用方必须保证 batch 生命周期"
    ]
  },
  {
    id: 'yuanrong-ds', name: 'openYuanrong DataSystem', primary: 'storage', runs: ['nvidia', 'ascend'], port: 'neutral',
    portNote: "构建同时支持 Ascend 与 CUDA 后端（BUILD_HETERO_NPU）。",
    org: 'openEuler 社区', repo: 'https://gitcode.com/openeuler/yuanrong',
    lang: 'C++ / Python / Java',
    role: '异构分布式多级缓存数据系统，KV Pool 的 Yuanrong 后端',
    status: 'outline',
    highlights: [
      "**四种数据语义并存**：KV（共享内存零拷贝）/ Object（近算力本地对象缓存，引用计数 + PRAM/CAUSAL 一致性）/ Stream（pub-sub 元素流）/ **Hetero（NPU HBM 抽象）**",
      "**vLLM-Ascend 用的是 HeteroClient**：%%MSetD2H%%（device→host）/ %%MGetH2D%%（host→device），配合 %%Blob%% / %%DeviceBlobList%%",
      "**datasystem 不分配也不释放 HBM**：用户注册 HBM 指针，系统只协调卡间流——少管一层内存生命周期",
      "**HBM → DRAM → SSD 三级**，用 %%CacheType%% 与 %%WriteMode%% 两个枚举分别控制放置与持久化策略",
      "**传输引擎用 HiXiL / P2P**，服务发现走 etcd",
      "**构建同时支持 Ascend 与 CUDA 后端**（%%BUILD_HETERO_NPU%%），不是昇腾专属"
    ]
  },
  {
    id: 'flexkv', name: 'FlexKV', primary: 'storage', runs: ['nvidia'], port: 'sdk',
    portNote: "官方集成列表为 vLLM / TRT-LLM / Dynamo，均在 NVIDIA 侧；昇腾适配未在主线体现。",
    org: '腾讯云 TACO', repo: 'https://github.com/taco-project/FlexKV',
    lang: 'C++ / Python',
    role: '多层 KV 缓存管理器，已合入 vLLM 主线与 Dynamo 原生卸载',
    status: 'outline',
    highlights: [
      "**库形态而非服务形态**：v1.0.0 从 client-server 改为可直接调用的库，**去掉进程间通信开销**——KV 访问在请求关键路径上，一次 IPC 往返就可能不可接受",
      "**多级缓存**：GPU HBM → Host DRAM → Local SSD → Remote（RDMA / Mooncake TE）",
      "**GPU Direct Storage 支持**：SSD ↔ 显存直传，绕过 CPU 与系统内存",
      "**集成广度是它的亮点**：已合入 vLLM 主线（%%FlexKVConnectorV1%% 内建）、Dynamo 原生卸载选项、支持 TRT-LLM"
    ]
  },
  {
    id: 'memcache', name: 'MemCache', primary: 'storage', runs: ['ascend'], port: 'bound',
    org: '华为昇腾', repo: 'https://gitcode.com/Ascend/memcache',
    lang: 'C++ / Python',
    role: '高性能分布式 KV 缓存，作为 vLLM-Ascend 的 KV Pool 后端',
    status: 'outline',
    highlights: [
      "**vLLM-Ascend KV Pool 的三个后端之一**（另有 Mooncake、Yuanrong）",
      "**唯一支持 layerwise 的后端**：这一条直接决定了「传输能否与计算重叠」",
      "**走 %%MmcDirect%% 的 %%COPY_L2G%% / %%COPY_G2L%%** 做 device ↔ pool 搬运，并提供 %%batch_alloc%% / %%batch_add_lease%%（GVA layerwise）",
      "**启用 KV Pool 必须同步 %%PYTHONHASHSEED%%**：跨节点哈希不一致时缓存看起来在工作、实际一直不命中，排查成本极高",
      "**2025-11 才开源但推进很快**，评估重点在接口稳定性与跨版本兼容"
    ]
  },
  {
    id: 'ucm', name: 'UCM', primary: 'storage', runs: ['nvidia', 'ascend'], port: 'neutral',
    portNote: "构建配置的 runtime 覆盖 simu / ascend / ascend-a3 / musa / cuda，Ascend 是可选编译项而非身份。",
    org: '华为 ModelEngine', repo: 'https://github.com/ModelEngine-Group/unified-cache-management',
    lang: 'C++ / Python',
    role: '统一缓存管理框架：稀疏算法可插拔 + 前缀缓存 + 存算分离 PD（硬件中立）',
    status: 'outline',
    highlights: [
      "**稀疏算法可插拔是核心设计**：%%UcmSparseBase%% / %%SparseKVManager%% / %%UcmKVStoreBase%% / UC Connector 四件套把算法与存储双向解耦",
      "**新来一个稀疏算法不需要改存储，换一个存储后端不需要改算法**",
      "**四大能力**：稀疏注意力 / 前缀缓存 / 预填充卸载 / 异构 PD 解耦；官方数据首 token 时延最高降 90%、吞吐提升 22 倍",
      "**三个数字要分开看**：时延来自稀疏检索，吞吐来自卸载，上下文扩展来自持久化——不是同一个机制的红利",
      "**硬件中立**：构建配置的 runtime 覆盖 simu / ascend / ascend-a3 / musa / cuda，Ascend 优化是默认关闭的编译选项"
    ]
  },
  {
    id: 'hf3fs', name: '3FS / HF3FS', primary: 'storage', runs: ['nvidia', 'ascend'], port: 'neutral',
    portNote: "分布式文件系统本身与加速器无关；但 GPUDirect Storage 加速路径依赖 CUDA。",
    org: 'DeepSeek', repo: 'https://github.com/deepseek-ai/3FS',
    lang: 'C++ / Rust',
    role: '高性能分布式文件系统，KV 池冷数据下沉的底层持久化之一',
    status: 'outline',
    highlights: [
      "**USRBIO 用户态 I/O**：把 I/O 从系统调用变成共享内存通信，绕过页缓存与内核开销",
      "**CRAQ 链式复制**：保证强一致的同时允许从任意副本读，读吞吐好",
      "**元数据与数据分离**，支撑海量小文件",
      "**作为 KV 存储底座使用**：LMCache 有 hf3fs_connector、Mooncake 有 hf3fs 子模块，把冷 KV 下沉到盘形成 DRAM+SSD 分层",
      "**本身与加速器无关**，但 GPUDirect Storage 加速路径依赖 CUDA"
    ]
  },

  /* ============ L0 底座（不属于四层，纵向穿透）============ */
  {
    id: 'cann', name: 'CANN', primary: 'substrate', runs: ['ascend'], port: 'bound',
    org: '华为昇腾', repo: 'https://gitcode.com/cann',
    lang: 'C++ / Ascend C',
    role: '昇腾异构计算架构：GE 图引擎 / Ascend C / AOL 算子库 / HCCL / HIXL / Runtime',
    status: 'deep',
    highlights: [
      "**GE 图引擎是框架接入的必经中心**：这与 NVIDIA 侧「没有单一图编译中心」形成最鲜明的结构差异",
      "**Ascend C 是算子开发语言**（原生 C/C++）：vLLM-Ascend 的 %%csrc/%% 正是基于它补缺失的融合算子",
      "**两类通信抽象**：HCCL 管集合通信（并行），HIXL 管单边通信（KV 搬运）——用错抽象会带来不必要的同步开销",
      "**%%mc2%% 这类融合算子体现昇腾的设计倾向**：把通信融进计算算子，而不是让通信作为独立步骤",
      "**C++ 公开接口有显式的 ABI 兼容性规范**（见 HIXL 仓库），跨版本升级需整体回归",
      "**AscendCL 与 Runtime 被显式分成两层**，中间还要过 torch_npu——这是昇腾「版本敏感」的结构性原因"
    ]
  },
  {
    id: 'cuda', name: 'CUDA', primary: 'substrate', runs: ['nvidia'], port: 'bound',
    org: 'NVIDIA', repo: 'https://github.com/NVIDIA/cuda-samples',
    lang: 'C++ / CUDA C',
    role: 'NVIDIA 异构计算平台：CUDA C / Runtime / Graph / VMM / cuBLAS / NCCL',
    status: 'deep',
    highlights: [
      "**没有单一的图编译中心**：优化散落在 TensorRT、TRT-LLM 与各家框架自己的编译路径（vLLM 的 %%torch.compile%%、%%cudagraph_dispatcher.py%%）中",
      "**CUDA Graph 与 KV 分页存在天然张力**：图要求地址固定，而 KV 块地址每步在变。解法是 **block_table 间接寻址**——图里存的是「查表」这个动作",
      "**这条约束反过来解释了分页设计**：固定大小块 + 块表不仅省显存，还让 CUDA Graph 可用",
      "**VMM（%%cuMemCreate%% / %%cuMemMap%%）是弹性 KV 池的基础**：物理显存与虚拟地址解耦，可按页映射、可回收",
      "**GPUDirect RDMA / Storage 是零拷贝的物理前提**：与昇腾侧 HIXL 的目标完全同构",
      "**库生态是最深的护城河**：新模型结构出现时通常很快有现成 kernel，昇腾侧更常需要自己写"
    ]
  }
];

/* ---------------------------------------------------------------- */
/* 底座（Substrate）                                                  */
/*                                                                    */
/* 不属于四层中的任何一层，而是纵向穿透所有层的地基。                  */
/* 单独建模的原因：CANN 不是 vLLM / Mooncake 的同级组件，              */
/* 把它塞进任何一层都会失真。                                          */
/* ---------------------------------------------------------------- */
window.WIKI_SUBSTRATES = [
  {
    id: 'substrate',
    label: '底座',
    en: 'Substrate',
    color: '#8b7d6b',
    colorDim: '#ddd5c9',
    wash: 'rgba(139,125,107,.09)',
    note: '四层共同站立的地基。这一层不参与横向分层，而是纵向穿透：算子、内存模型、通信原语都由它定义。',
    components: ['cann', 'cuda']
  }
];

/* ---------------------------------------------------------------- */
/* 栈视角（Stack view）                                               */
/*                                                                    */
/* 同一套四层框架下，昇腾与 NVIDIA 各自长出了一条实现脉络。            */
/* eco 标签把每个组件归入 ascend / nvidia / both（跨栈通用）。         */
/* 切换栈视角不会隐藏任何组件，只改变：排序、强调、以及全链路上         */
/* 「这一步由谁实现」的注解——也就是代码脉络。                          */
/* ---------------------------------------------------------------- */
window.WIKI_STACKS = [
  {
    id: 'ascend',
    name: '昇腾栈',
    en: 'Ascend',
    note: '从 CANN 地基到 MindIE / vLLM-Ascend，再到 HIXL、MemFabric、MemCache 的完整实现脉络。',
    substrate: 'cann',
    highlights: [
      "**没有单一的图编译中心**：优化散落在 TensorRT、TRT-LLM 与各家框架自己的编译路径（vLLM 的 %%torch.compile%%、%%cudagraph_dispatcher.py%%）中",
      "**CUDA Graph 与 KV 分页存在天然张力**：图要求地址固定，而 KV 块地址每步在变。解法是 **block_table 间接寻址**——图里存「查表」这个动作",
      "**这条约束反过来解释了分页设计**：固定大小块 + 块表不仅省显存，还让 CUDA Graph 可用",
      "**VMM（%%cuMemCreate%% / %%cuMemMap%%）是弹性 KV 池的基础**：物理显存与虚拟地址解耦，可按页映射、可回收",
      "**GPUDirect RDMA / Storage 是零拷贝的物理前提**：与昇腾侧 HIXL 的目标完全同构",
      "**库生态是最深的护城河**：新模型结构出现时通常很快有现成 kernel，昇腾侧更常需要自己写"
    ]
  },
  {
    id: 'nvidia',
    name: 'NV 栈',
    en: 'NVIDIA',
    note: '从 CUDA 地基到 TensorRT-LLM / vLLM，再到 Dynamo 编排与 NIXL 传输的实现脉络。',
    substrate: 'cuda'
  }
];


/* ---------------------------------------------------------------- */
/* 层间交互（Interactions）                                           */
/*                                                                    */
/* 这是「一个请求进来，层次之间怎么交互」的核心表达：                   */
/* 每一对相邻层之间都有双向的往来——下行是请求/指令，上行是状态/反馈。   */
/* 只画下行会漏掉一半：L1 的路由决策依赖 L2 上报的负载与 KV 命中率，   */
/* L2 能否继续算依赖 L3 的到位通知，L2 的复用收益依赖 L4 的命中响应。   */
/* ---------------------------------------------------------------- */
window.WIKI_INTERACTIONS = [
  {
    lower: 'engine',
    down: { steps: [2, 3], title: '请求下发',
            desc: '已编排的请求 + 目标实例地址 + 采样参数' },
    up: { steps: [], title: '状态回流',
          desc: '实例队列深度 / KV 命中率 / 显存水位 —— 反哺 L1 的路由打分' }
  },
  {
    lower: 'transport',
    down: { steps: [6, 9, 10], title: '搬运指令（双向共用一个通道）',
            desc: '算之前：把命中的 KV 从邻实例读进来；算完：把本实例新产生的 KV 送出去' },
    up: { steps: [7], title: '到位通知',
          desc: 'KV 已落在本地显存 —— 这是「计算可以开始」的信号；失败则触发重算' }
  },
  {
    lower: 'storage',
    down: { steps: [5, 12, 13], title: '检索与落存',
            desc: '算之前：查这段前缀在不在池里（这是「命中」的判断）；算完：把新 KV 写入池供后续请求复用' },
    up: { steps: [5, 14], title: '位置响应与取回',
          desc: '在不在、在哪台机器 —— 命中时数据经 L3 搬回本地，这是「入向」的来源之一' }
  }
];

/* 闭环：L4 的结果回流到 L1，链路成环 */
window.WIKI_LOOPBACK = {
  from: 'storage',
  to: 'scheduling',
  title: 'KV 位置索引回流',
  desc: 'L4 里登记的位置信息，成为下一次请求在 L1 路由打分的输入。链路在这里闭合成环——' +
        '这也是为什么四层必须放在一起看：任何一层的状态变化，都会改变其它层的最优解。'
};

/* ---------------------------------------------------------------- */
/* 归类依据                                                           */
/*                                                                    */
/* 两个正交维度，不要混为一谈：                                        */
/*   org    —— 谁做的 / 为谁做的（厂商血统）                           */
/*   runs   —— 当前实际能跑在哪些硬件栈上（可移植性）                   */
/*                                                                    */
/* 典型反例：Dynamo 出自 NVIDIA（org=nvidia），但它只是引擎之上的编排层，*/
/* 并不像 CANN 那样与硬件绑定。它今天跑不了昇腾的原因是「厂商 SDK 与     */
/* 发行物」而非「架构上不可能」——所以 runs=['nvidia'] 而 port='sdk'。    */
/*                                                                    */
/* port 三个取值：                                                     */
/*   bound   —— 硬件绑定：本身就是硬件抽象层，或直接编译到特定硬件        */
/*   sdk     —— 厂商 SDK / 发行物绑定：架构中立，但当前实现依赖某家栈     */
/*   neutral —— 硬件中立：两栈都有官方或主线落地                        */
/* ---------------------------------------------------------------- */

window.WIKI_RUNS = {
  ascend:  { name: '昇腾', short: '昇腾', color: '#b8491c' },
  nvidia:  { name: 'NV',   short: 'NV',   color: '#4f7a2f' }
};

window.WIKI_PORTS = {
  bound:   { name: '硬件绑定',     desc: '本身就是硬件抽象层，或直接编译到特定硬件' },
  sdk:     { name: '厂商 SDK 绑定', desc: '架构中立，但当前实现与发行物绑在某一栈上' },
  neutral: { name: '硬件中立',     desc: '两栈都有官方或主线落地' }
};

/** 每个 step 归属的阶段名（由 k:'phase' 分隔行推导） */
window.flowPhaseOf = function () {
  const m = {}; let cur = '';
  (window.WIKI_FLOW.steps || []).forEach(s => {
    if (s.k === 'phase') cur = s.title;
    else if (s.k === 'step') m[s.n] = cur;
  });
  return m;
};

/** 组件在某条栈上是否可用 */
window.runsOn = function (component, stackId) {
  return (component.runs || []).includes(stackId);
};/** 底座里的组件也参与搜索与详情页，因此并入统一索引 */
window.WIKI_ALL_IDS = window.WIKI_COMPONENTS.map(c => c.id);

/* 便捷索引 ------------------------------------------------------- */
window.WIKI_BY_ID = Object.fromEntries(window.WIKI_COMPONENTS.map(c => [c.id, c]));
window.WIKI_LAYER_BY_ID = Object.fromEntries(window.WIKI_LAYERS.map(l => [l.id, l]));

/** 取某层的组件 */
window.componentsOfLayer = function (layerId) {
  if (layerId === 'substrate') {
    const ids = (window.WIKI_SUBSTRATES[0] || {}).components || [];
    return ids.map(id => window.WIKI_BY_ID[id]).filter(Boolean);
  }
  // 同层内按 order 排序（未标 order 的按定义顺序排在后面）。
  // 用显式 order 而不是挪动数组位置：意图可见，也不会影响其它层的相对顺序。
  return window.WIKI_COMPONENTS
    .filter(c => c.primary === layerId)
    .map((c, i) => ({ c, i }))
    .sort((a, b) => ((a.c.order ?? 1e6) - (b.c.order ?? 1e6)) || (a.i - b.i))
    .map(x => x.c);
};

/** 组件所属的「层」显示信息（底座组件的 primary 是 substrate） */
window.layerInfoOf = function (component) {
  const sub = window.WIKI_SUBSTRATES[0];
  if (component.primary === sub.id) {
    return { id: sub.id, num: 'L0', name: sub.label, en: sub.en,
             color: sub.color, colorDim: sub.colorDim, wash: sub.wash };
  }
  return window.WIKI_LAYER_BY_ID[component.primary];
};

/** 取全链路中属于某层的 step 编号（首页各层引用它，与流程区共享同一份数据） */
window.flowStepsOfLayer = function (layerId) {
  return (window.WIKI_FLOW.steps || []).filter(s => s.k === 'step' && s.layer === layerId);
};
