/* ============================================================
   LLM Infra Wiki — 组件详情
   约定：正文用轻量 Markdown。为避免 JS 模板串转义，
   行内代码用 %%...%%，代码块用 ~~~ 围栏（均为标准 Markdown 之外的
   友好约定，渲染器同时支持标准反引号写法）。
   字段：overview(md) / modules[]
   ============================================================ */

window.WIKI_DETAILS = {};

/* ================================================================
   vLLM
   ================================================================ */
window.WIKI_DETAILS.vllm = {
  overview: `
## 一句话定位

vLLM 是当前 LLM 推理引擎的事实标准。它最有价值的贡献不是某个 kernel，而是把 KV Cache 从「每请求一整块连续显存」改造成**按固定大小 block 分页管理**——分页一旦成立，continuous batching、前缀共享、PD 分离、KV 卸载这些上层能力才全部变得可实现。

## 它解决的核心矛盾

自回归 decode 阶段算力利用率常常低于 5%：瓶颈在显存带宽与显存容量。要提升吞吐就必须**加大并发 batch**，而限制 batch 大小的第一因素正是 KV Cache 占用的显存。vLLM 的思路很直接——把 KV 的内部碎片和预留浪费消掉，同样显存就能装下更多请求。

> 一条经验判据：分页把 KV 的**最小分配粒度**从「整条序列」降到「16 个 token」，碎片率从数十 % 降到 < 4%，因此在同一张卡上并发数可以翻数倍。

## 核心抽象

| 抽象 | 代码位置 | 职责 |
|---|---|---|
| AsyncLLM | %%vllm/v1/engine/async_llm.py%% | API 侧门面，管理每个请求的输出流 |
| EngineCore | %%vllm/v1/engine/core.py%% | 引擎主循环：调度 → 执行 → 输出 |
| Scheduler | %%vllm/v1/core/sched/scheduler.py%% | 决定这一步跑哪些请求、跑多少 token |
| KVCacheManager | %%vllm/v1/core/kv_cache_manager.py%% | block 分配 / 释放 / 前缀命中 |
| BlockPool | %%vllm/v1/core/block_pool.py%% | 物理 block 空闲链表 + 哈希去重 |
| ModelRunner | %%vllm/v1/worker/gpu_model_runner.py%% | 组 batch、准备输入、跑 forward |
| KVConnector | %%vllm/distributed/kv_transfer/kv_connector/%% | 把 KV 接出引擎（PD / 卸载 / 远端池） |

## 进程模型

vLLM v1 把「请求编排」和「模型执行」拆成两个进程角色：

- **API Server / AsyncLLM** 负责 HTTP、tokenize、流式返回，是 IO 密集的；
- **EngineCore** 跑调度循环，独占模型与显存，必须保持忙等不阻塞。

两者通过 %%EngineCoreClient%%（ZeroMQ / 共享内存）通信。这样拆分的原因很实际：如果把调度循环和 HTTP 事件循环放在一起，一个慢客户端就能拖垮整个 batch 的节奏。

## 为什么值得作为第一站

%%vllm/v1/core/sched/scheduler.py%% 与 %%vllm/v1/core/block_pool.py%% 定义了整个行业后来都在复用的接口形状。读懂这两个文件之后，LMCache、Mooncake、Dynamo 的很多设计会立刻变得可解释——因为它们本质上都在回答「分页之后，KV 还能怎么用」。
`,
  modules: [
    {
      id: 'api', name: '请求入口：OpenAI 兼容 API Server',
      files: ['vllm/entrypoints/openai/api_server.py', 'vllm/entrypoints/openai/chat_completion/serving.py', 'vllm/entrypoints/openai/completion/serving.py', 'vllm/entrypoints/openai/chat_completion/protocol.py'],
      summary: '把 HTTP 请求校验、模板渲染后翻译成内部请求',
      flow: [
        'FastAPI 应用在 %%api_server.py%% 中由 %%build_app()%% 装配；%%/v1/chat/completions%% 与 %%/v1/completions%% 分别挂到 %%OpenAIServingChat%%、%%OpenAIServingCompletion%%',
        '请求体先经 %%protocol.py%% 的 Pydantic 模型校验，得到 %%ChatCompletionRequest%%',
        '%%chat_completion/serving.py%% 完成对话模板渲染（%%apply_chat_template%%）、多模态内容拆解、采样参数归一化',
        '调用 %%engine_client.generate(...)%% 拿到异步生成器',
        '每个 chunk 经 %%request_output_to_chat_completion_response%% 转回 OpenAI SSE 格式写出'
      ],
      points: [
        '**校验与业务是分开的**：%%api_server.py%% 只管装配与生命周期，业务逻辑都在 %%serving_*.py%%',
        '采样参数（temperature / top_p / logprobs）在这里被翻译成 %%SamplingParams%%；引擎层之后只认这个结构',
        '流式与非流式复用同一条 generate 路径，差别只在消费生成器的方式'
      ]
    },
    {
      id: 'input', name: '输入处理：从 prompt 到 EngineCoreRequest',
      files: ['vllm/v1/engine/input_processor.py', 'vllm/v1/engine/async_llm.py', 'vllm/multimodal/registry.py'],
      summary: 'tokenize、拆多模态、生成贯穿全链路的 request_id',
      flow: [
        '%%InputProcessor.process_inputs()%% 负责 tokenize，产出 %%EngineCoreRequest%%',
        '多模态输入在此拆成 %%mm_inputs%% 交给 %%MultiModalRegistry%% 做 encoder 前处理',
        '%%AsyncLLM.add_request%% 在 API 侧包装：序列化后经 %%EngineCoreClient%% 送入 EngineCore 进程',
        '%%AsyncLLM%% 为每个请求建 %%asyncio.Queue%% 收集回流的 %%EngineCoreOutput%%'
      ],
      points: [
        '**跨进程只传轻量元数据**：token id 与参数，不含任何 tensor',
        '%%request_id%% 在这里生成，是后续日志、KV 事件、连接器里追踪同一请求的唯一锚点——做端到端 trace 时从它入手'
      ]
    },
    {
      id: 'scheduler', name: '调度器：continuous batching 的核心',
      files: ['vllm/v1/core/sched/scheduler.py', 'vllm/v1/core/sched/async_scheduler.py', 'vllm/v1/core/sched/request_queue.py', 'vllm/v1/core/sched/output.py'],
      summary: '每一步决定跑谁、跑 prefill 还是 decode、跑几个 token',
      flow: [
        '调度循环每步调用 %%Scheduler.schedule()%%，返回一份 %%SchedulerOutput%%',
        '**先处理 running 队列**：为在跑的 decode 请求追加一个 token 的 slot，必要时触发抢占',
        '**再处理 waiting 队列**：新请求先做 prefix cache 查询，命中则只算未命中部分',
        '**chunked prefill**：长 prompt 切成多个 chunk 分步执行，避免独占整个 step',
        '显存不足时按优先级抢占请求，被抢占的 KV 直接丢弃、下次重算（或交给连接器卸载）'
      ],
      points: [
        '%%SchedulerOutput%% 是引擎的**唯一施工图**：它同时描述 token 分配、block 分配与这一步是否执行',
        '前缀命中查询 %%get_computed_blocks()%% 在调度阶段完成，因此**命中率直接决定 prefill 工作量**',
        'chunked prefill 让 prefill 与 decode 能混进同一个 batch，这是「长 prompt 打断线上服务」的正解'
      ]
    },
    {
      id: 'kv', name: 'KV Cache 管理：BlockPool 与分页',
      files: ['vllm/v1/core/block_pool.py', 'vllm/v1/core/kv_cache_manager.py', 'vllm/v1/core/single_type_kv_cache_manager.py', 'vllm/v1/core/kv_cache_coordinator.py', 'vllm/v1/core/kv_cache_utils.py'],
      summary: '固定大小 block + 内容哈希链，实现去重与前缀共享',
      flow: [
        '显存切成固定大小 **block**（默认 16 token），由 %%BlockPool%% 统一持有',
        '%%KVCacheManager.allocate_slots()%% 为一次调度分配所需 block；不足则返回 None，倒逼调度器重排',
        'block 的 key 是 **token 序列的哈希链**：%%hash(前缀 hash, 本块 tokens)%%——内容相同的 block 天然复用',
        '同一物理 block 可被多个请求以 copy-on-write 共享，靠 %%ref_cnt%% 维护生命周期',
        '%%kv_cache_coordinator.py%% 把逻辑 block 映射到各层物理张量，产出供 kernel 使用的 %%block_table%%'
      ],
      points: [
        '**分页是地基**：没有 page，就没有 prefix sharing，也没有 PD 传输的定长块与 KV 卸载的迁移单位',
        '哈希链让「前缀匹配」退化成一次字典查询，这是 vLLM 前缀缓存快的根本原因',
        '%%block_table%% 是传给 attention kernel 的核心元数据：每个请求的逻辑位置 → 物理 block 号'
      ]
    },
    {
      id: 'worker', name: '模型执行：Worker 与 ModelRunner',
      files: ['vllm/v1/worker/gpu_worker.py', 'vllm/v1/worker/gpu_model_runner.py', 'vllm/v1/worker/gpu_input_batch.py', 'vllm/v1/executor/'],
      summary: '把 SchedulerOutput 翻译成 GPU 上的一次 forward',
      flow: [
        '%%GPUWorker.execute_model()%% 接收 %%SchedulerOutput%%',
        '%%GPUModelRunner%% 组装输入张量：input_ids、positions、attn_metadata、slot_mapping',
        '%%slot_mapping%% 告诉 kernel 每个 token 的 KV 该写进哪个物理 slot',
        '执行 forward、采样得到 token id，组装 %%ModelRunnerOutput%% 回传',
        '按需走 CUDA Graph / torch.compile 路径以减少 launch 开销'
      ],
      points: [
        '**%%slot_mapping%% 是理解 vLLM 的钥匙**：它把「逻辑 token 位置」翻译成「物理显存偏移」，是分页显存与 kernel 的接缝',
        '采样在 Worker 侧完成，只把 token id 传回 EngineCore，避免跨进程搬 logits 大张量',
        '%%gpu_input_batch.py%% 维护**常驻输入缓冲**，每步增删改而不是重新分配'
      ]
    },
    {
      id: 'attn', name: 'Attention 后端与 PagedAttention',
      files: ['vllm/v1/attention/backends/', 'vllm/v1/attention/backends/registry.py', 'vllm/v1/attention/backends/mla/', 'vllm/v1/attention/ops/'],
      summary: '可插拔后端，在 kernel 内按 block_table gather KV',
      flow: [
        '%%registry.py%% 按平台与模型结构选择后端（FlashAttention / FlashInfer / Triton / MLA …）',
        '各后端实现统一接口：%%build()%% 构造 metadata，%%forward()%% 执行',
        'PagedAttention 在 kernel 内按 %%block_table%% 逐块 gather KV 参与计算',
        'MLA 后端单独处理 DeepSeek 系的压缩 KV 布局',
        'prefill 与 decode 通常走不同的 kernel 路径'
      ],
      points: [
        '后端可插拔是 vLLM 能快速适配新硬件的关键：**换后端不动调度与显存管理**',
        'MLA 的 KV 布局与常规 MHA/GQA 不同，是「KV 格式演进」这条线的重要节点'
      ]
    },
    {
      id: 'connector', name: 'KV Connector：把 KV 接出引擎',
      files: ['vllm/distributed/kv_transfer/kv_connector/base.py', 'vllm/distributed/kv_transfer/kv_connector/factory.py', 'vllm/distributed/kv_transfer/kv_connector/v1/', 'vllm/distributed/kv_transfer/kv_transfer_state.py'],
      summary: 'PD 分离、远端 KV 池、KV 卸载的统一入口',
      flow: [
        '%%KVConnectorBase_V1%% 定义接口：%%start_load_kv%% / %%wait_for_layer_load%% / %%save_kv_layer%% / %%get_num_new_matched_tokens%%',
        '%%factory.py%% 按配置实例化连接器（NIXL、Mooncake、LMCache、FlexKV、AscendStore…）',
        '**调度阶段**：%%get_num_new_matched_tokens()%% 告诉调度器「这个请求有多少 token 能从外部 KV 池直接命中」',
        '**执行阶段**：%%start_load_kv()%% 发起异步加载，%%wait_for_layer_load()%% 做逐层同步'
      ],
      points: [
        '这是**反向接口**设计：不是引擎去调存储，而是引擎把「我什么时候需要 KV」暴露给连接器',
        'layerwise 接口（%%wait_for_layer_load%%）的存在，是为了让 KV 搬运与逐层计算重叠——这是传输层隐藏延迟的前提',
        '所有外部 KV 系统（LMCache / Mooncake / FlexKV / UCM / MemCache）最终都从这一层接进 vLLM'
      ]
    },
    {
      id: 'offload', name: 'KV Offload 与分层卸载',
      files: ['vllm/v1/kv_offload/base.py', 'vllm/v1/kv_offload/cpu/', 'vllm/v1/kv_offload/tiering/', 'vllm/v1/kv_offload/file_mapper.py', 'vllm/v1/simple_kv_offload/'],
      summary: '引擎内置的 CPU / 文件层卸载路径',
      flow: [
        '%%kv_offload/base.py%% 定义卸载管理器接口',
        '%%cpu/%% 实现显存 ↔ 主机内存的搬运',
        '%%tiering/%% 编排多级层级',
        '%%file_mapper.py%% 把 block 映射到本地文件'
      ],
      points: [
        '这是引擎内置的「轻量版 LMCache」，优势是**零额外依赖**',
        '与 Connector 的分工：Offload 由引擎自己管，Connector 交给外部系统管'
      ]
    },
    {
      id: 'spec', name: '投机解码',
      files: ['vllm/v1/spec_decode/eagle.py', 'vllm/v1/spec_decode/medusa.py', 'vllm/v1/spec_decode/ngram_proposer.py', 'vllm/v1/spec_decode/suffix_decoding.py'],
      summary: '一次 forward 验证多个 token，提高每步产出',
      flow: [
        '%%Proposer%% 生成候选 token 序列（EAGLE / Medusa / N-gram / Suffix）',
        '%%ModelRunner%% 一次 forward 验证全部候选',
        '按接受率截断，接受的部分直接推进 KV'
      ],
      points: [
        '投机解码改变的是**每步产出 token 数**，与 KV 管理正交，但会显著加快 KV 增长——做容量规划时必须一起算',
        '%%ngram_proposer%% 不需要额外模型，对重复性强的场景性价比高'
      ]
    }
  ],
};

/* ================================================================
   SGLang
   ================================================================ */
window.WIKI_DETAILS.sglang = {
  overview: `
## 一句话定位

SGLang 是 vLLM 之外的另一条主线：它把**前缀复用从「块级哈希」推进到「token 级 Radix Tree」**，并把「结构化输出」做成了与调度器深度耦合的一等能力。在长系统提示、多轮 agent、共享前缀密集的场景下，它的命中粒度和复用效率通常优于固定块方案。

## 与 vLLM 的路线差异

| 维度 | vLLM | SGLang |
|---|---|---|
| 前缀复用结构 | 固定大小 block + 哈希链去重 | token 级 Radix Tree（%%radix_cache.py%%） |
| 复用粒度 | 16 token 对齐 | token 精确对齐 |
| 淘汰策略 | LRU on block | Radix Tree 节点 LRU + 引用计数 |
| 批调度 | 每步构造 SchedulerOutput | overlap scheduling，CPU 调度与 GPU 执行重叠 |
| 结构化输出 | 后置处理 | XGrammar 与采样/调度同层协作 |

> 一个直觉：vLLM 的 block 哈希让复用查询 O(1) 但粒度粗；SGLang 的 radix tree 让复用精确到 token，代价是需要维护树结构与节点级回收。两者没有绝对优劣，取决于你的前缀分布。

## 核心抽象

| 抽象 | 代码位置 | 职责 |
|---|---|---|
| Scheduler | %%srt/managers/scheduler.py%% | 调度主循环与 PD 角色分发 |
| ScheduleBatch | %%srt/managers/schedule_batch.py%% | 一步执行的完整描述 |
| RadixCache | %%srt/mem_cache/radix_cache.py%% | 前缀树复用与淘汰 |
| HiRadixCache | %%srt/mem_cache/hiradix_cache.py%% | 分层（显存 + 主机）前缀缓存 |
| MemoryPool | %%srt/mem_cache/memory_pool.py%% | token 级 KV 槽位池 |
| ModelRunner | %%srt/model_executor/model_runner.py%% | 组 batch 与 forward |
| GrammarManager | %%srt/constrained/grammar_manager.py%% | 结构化输出约束 |

## 值得注意的演化方向

近几个版本的 %%mem_cache/%% 目录已经膨胀到几十个文件：%%unified_radix_cache.py%%、%%swa_radix_cache.py%%、%%mamba_radix_cache.py%%、%%deepseek_v4_memory_pool.py%%……这说明一件事——**「一种 KV 布局打天下」的时代结束了**，滑动窗口、混合注意力、稀疏注意力各自需要自己的缓存结构与淘汰策略。
`,
  modules: [
    {
      id: 'entry', name: '入口与引擎骨架',
      files: ['python/sglang/srt/entrypoints/engine.py', 'python/sglang/srt/entrypoints/http_server.py', 'python/sglang/srt/managers/tokenizer_manager.py'],
      summary: 'HTTP → tokenizer → scheduler 的三段式',
      flow: [
        '%%http_server.py%% 起 FastAPI，%%/generate%% 与 OpenAI 兼容路由进入 %%Engine%%',
        '%%Engine%% 拉起子进程：%%TokenizerManager%%、%%Scheduler%%、%%DetokenizerManager%%',
        '%%tokenizer_manager.py%% 负责 tokenize 与请求生命周期，通过 ZMQ 与 Scheduler 通信',
        '输出经 Detokenizer 还原为文本流回客户端'
      ],
      points: [
        'SGLang 把 **tokenize 与 detokenize 也拆成独立进程**，避免 Python GIL 拖慢调度循环',
        '%%io_struct.py%% 定义了跨进程的消息协议，是理解整个数据流的地图'
      ]
    },
    {
      id: 'scheduler', name: '调度器与 overlap scheduling',
      files: ['python/sglang/srt/managers/scheduler.py', 'python/sglang/srt/managers/schedule_batch.py', 'python/sglang/srt/managers/schedule_policy.py', 'python/sglang/srt/managers/overlap_utils.py'],
      summary: 'CPU 侧调度与 GPU 侧执行重叠，掩盖调度开销',
      flow: [
        '%%Scheduler%% 主循环：收请求 → 组 batch → 发 GPU → 收结果',
        '%%ScheduleBatch%% 是这一步的完整描述（请求集合、KV 索引、采样参数）',
        '%%schedule_policy.py%% 决定 waiting 队列中谁先上（FCFS / LOF / 最长前缀优先）',
        '**overlap**：CPU 在准备下一步 batch 的同时，GPU 正在执行上一步，%%overlap_utils.py%% 负责两者的 Future 对齐'
      ],
      points: [
        'overlap scheduling 的目标是让**调度延迟从关键路径上消失**，在小 batch 高频场景收益明显',
        '%%schedule_policy.py%% 里的「最长前缀优先」策略与 RadixCache 是一对：前者决定收益上限，后者决定能否兑现'
      ]
    },
    {
      id: 'radix', name: 'RadixAttention：token 级前缀树复用',
      files: ['python/sglang/srt/mem_cache/radix_cache.py', 'python/sglang/srt/mem_cache/base_prefix_cache.py', 'python/sglang/srt/mem_cache/evict_policy.py', 'python/sglang/srt/mem_cache/cpp_radix_tree/'],
      summary: '用 Radix Tree 索引所有已计算前缀，命中即跳过计算',
      flow: [
        '每个请求的 token 序列在树中做**最长前缀匹配**（%%match_prefix%%）',
        '命中部分的 KV 槽位被直接复用，只对未命中后缀执行 prefill',
        '新算出的前缀插入树中，节点持 KV 槽位索引与引用计数',
        '显存压力下按 LRU 淘汰叶子节点，%%evict_policy.py%% 抽象策略',
        '热点路径已下沉到 C++（%%cpp_radix_tree/%%）以减少 Python 开销'
      ],
      points: [
        '**token 级对齐**意味着「系统提示词只差一个 token」也能复用绝大部分 KV，而块级方案会因对齐损失一整块',
        '引用计数决定节点能否被淘汰——**正在被 decode 的请求会钉住它的整条前缀路径**',
        'Radix Tree 与 PagedAttention 并非互斥：SGLang 同样用分页池存 KV，只是索引结构不同'
      ]
    },
    {
      id: 'hicache', name: 'HiRadixCache：分层前缀缓存',
      files: ['python/sglang/srt/mem_cache/hiradix_cache.py', 'python/sglang/srt/mem_cache/memory_pool_host.py', 'python/sglang/srt/mem_cache/hicache_storage.py', 'python/sglang/srt/mem_cache/l2_transfer.py'],
      summary: '显存 → 主机内存 → 远端存储的三级 KV 层次',
      flow: [
        '%%HiRadixCache%% 继承 Radix Tree 语义，但节点标注 KV 当前所在的层级',
        'GPU 显存不足时按策略把节点**下刷**到主机内存池（%%memory_pool_host.py%%）',
        '再下一级交给 %%hicache_storage.py%%（文件 / 远端后端）',
        '再次命中时反向**上拉**，%%l2_transfer.py%% 负责二级传输的发起与同步'
      ],
      points: [
        '这就是「引擎内置的 KV 分层缓存」，与 LMCache 的思路一致但**实现埋在引擎内**——部署更简单，扩展性弱一些',
        '分层的关键不是能存多少，而是**上拉带宽能否追上重算成本**：如果拉回来比重新 prefill 还慢，缓存就没有意义'
      ]
    },
    {
      id: 'memory', name: '显存池与 KV 布局',
      files: ['python/sglang/srt/mem_cache/memory_pool.py', 'python/sglang/srt/mem_cache/unified_memory_pool.py', 'python/sglang/srt/mem_cache/kv_cache_configurator.py', 'python/sglang/srt/mem_cache/layout/'],
      summary: '按 token 索引的 KV 槽位池，支持异构层布局',
      flow: [
        '%%MemoryPool%% 以 **token 为索引单位**分配 KV 槽位（%%req_to_token%% 映射）',
        '%%kv_cache_configurator.py%% 依据模型结构与可用显存决定池大小与层布局',
        '%%unified_memory_pool.py%% 统一管理多种缓存（full / SWA / mamba）',
        '%%layout/%% 描述物理排布，供 kernel 直接按索引寻址'
      ],
      points: [
        '**token 级索引 vs block 级索引**是 SGLang 与 vLLM 在显存管理上的根本分歧，也解释了为何两者前缀复用的最优场景不同',
        '%%req_to_token%% 的作用等价于 vLLM 的 %%block_table%%：把请求内位置映射到物理槽位'
      ]
    },
    {
      id: 'runner', name: '模型执行与 Attention 后端',
      files: ['python/sglang/srt/model_executor/model_runner.py', 'python/sglang/srt/layers/attention/attention_registry.py', 'python/sglang/srt/layers/attention/flashattention_backend.py', 'python/sglang/srt/layers/attention/dsa_backend.py'],
      summary: '统一 ModelRunner + 可插拔 attention 后端',
      flow: [
        '%%ModelRunner%% 从 %%ScheduleBatch%% 组装 forward 输入',
        '%%attention_registry.py%% 按模型/平台选后端',
        '常规路径走 FlashAttention / FlashInfer；DeepSeek 系走 MLA / DSA 专用后端',
        'CUDA Graph 覆盖常见 batch 形状'
      ],
      points: [
        '%%dsa_backend.py%%（DeepSeek Sparse Attention）说明**稀疏注意力已经进入主流程**，不再是论文里的实验',
        '后端注册表模式与 vLLM 一致：把硬件差异收敛到一层，保护上层调度逻辑'
      ]
    },
    {
      id: 'disagg', name: 'PD 分离与 KV 传输对接',
      files: ['python/sglang/srt/disaggregation/prefill.py', 'python/sglang/srt/disaggregation/decode.py', 'python/sglang/srt/disaggregation/mooncake/', 'python/sglang/srt/disaggregation/nixl/', 'python/sglang/srt/disaggregation/ascend/'],
      summary: 'prefill / decode 分池，KV 经传输后端交接',
      flow: [
        'prefill 实例算完 KV 后，经 %%disaggregation/<backend>/%% 把 KV 发给 decode 实例',
        '%%prefill.py%% 管理发送侧生命周期与完成通知',
        '%%decode.py%% 管理接收侧：先分配槽位，再等待 KV 到位',
        '已内置 mooncake / nixl / ascend / mori 等多种传输后端'
      ],
      points: [
        '**PD 分离的本质是把两类完全不同的负载（compute-bound 与 memory-bound）放到不同硬件配比上**，KV 传输只是实现手段',
        '%%decode_hicache_mixin.py%% 说明分层缓存与 PD 分离正在融合——decode 侧也可以直接从远端 KV 池取数'
      ]
    },
    {
      id: 'grammar', name: '结构化输出约束',
      files: ['python/sglang/srt/constrained/grammar_manager.py', 'python/sglang/srt/constrained/xgrammar_backend.py', 'python/sglang/srt/constrained/outlines_jump_forward.py'],
      summary: '把语法约束编译成 token 级掩码，与采样同层',
      flow: [
        '请求携带 JSON Schema / 正则，%%grammar_manager.py%% 编译为语法对象并缓存',
        '%%xgrammar_backend.py%% 生成每步的 token 位掩码',
        '掩码直接作用于 logits，非法 token 被置为 -inf',
        '%%outlines_jump_forward.py%% 对确定性片段做跳跃，减少无效解码步'
      ],
      points: [
        '**jump-forward 是这里最容易被忽略的优化**：当语法确定接下来必须输出某段字面量时，可一次推进多个 token',
        '结构化输出与投机解码配合时容易互相干扰，需要在接受率与约束满足之间取舍'
      ]
    }
  ],
};

/* ================================================================
   LMCache  (L2 推理引擎 · KV 复用层)
   依据本地 call-path 走读笔记重写
   ================================================================ */
window.WIKI_DETAILS.lmcache = {
  overview: `
## 一句话定位

LMCache 是**跨引擎的 KV 复用层**：把 KV Cache 从推理引擎的显存里「接管」出来，放进 CPU 内存、本地盘、远端存储，下一个请求到来时再塞回去。引擎自带的前缀缓存只活在单实例显存的运行期；LMCache 要解决的是**跨请求、跨实例、跨进程重启**的复用。

**它有两种形态，且以 MP 模式为主：**

| | **MP 模式（生产形态）** | **嵌入模式** |
|---|---|---|
| 缓存住在哪 | **独立进程** %%MPCacheServer%% | 与推理引擎同进程 |
| 引擎的角色 | 退化为客户端，用 %%register_kv_cache%% 把自己的显存交给服务端 | 直接调用 %%LMCacheEngine%% |
| 控制面 | 另有独立进程 %%mp_coordinator%% 协调整个 fleet | 无独立控制面 |
| 代码规模 | %%multiprocess%% + %%distributed%% + %%mp_coordinator%% + %%mp_observability%% 约 6 万行 | 本页下面讲的主干 |

**本页讲两者共用的机制基础**（StorageManager、后端族、显存桥）。MP 特有的服务端组装、L1/L2 分层、fleet 控制面见 [深度分析](#/a/lmcache)。

## 昇腾侧是独立项目

LMCache 本身硬件中立，昇腾侧的实现**不在本仓库**，而是官方组织下的独立仓库
[LMCache-Ascend](#/c/lmcache-ascend)：它以 monkey-patch 方式替换掉内核、连接器、
存储后端与传输通道，并额外增加了上游没有的 Fetch-vs-Recompute 门控。

> **本页只讲上游主线**（通用 / CUDA 部分）。昇腾侧的异步 store、NPU Connector、
> 三条传输通道、cost_model 等内容都在 [LMCache-Ascend](#/c/lmcache-ascend) 页面。

## 全局调用链

### MP 模式（生产形态）

~~~text
vLLM 进程                              MP server 进程（独立）
LMCacheEngine（客户端）                MPCacheServer（compositor）
     │  RequestClient 契约                   ├ LookupModule
     │  gRPC 或 ZMQ                          ├ P2PController
     └──────────►────────────────────────────┤ ManagementModule
     register_kv_cache：把本进程显存交给服务端   └ TransferModule
                                                    │
                     L1（服务端自己的内存） + L2（adapter 族，约 20 个）
                                                    ▲
                                                    │ REST
                                         mp_coordinator（又一个独立进程）
                                         fleet 级配额 / 淘汰 / 键目录 / 预取
~~~

### 嵌入模式（本页其余部分讲这个）

~~~text
vLLM / SGLang / TRT-LLM worker
     │  KVConnectorBase_V1 adapter
     ▼
integration/<engine>/..._adapter.py     LMCacheConnectorV1Impl
     │
     ▼
v1/cache_engine.py   LMCacheEngine      ◄── 中心 API：store / retrieve / lookup
     │   用 gpu_connector（H2D/D2H 内核）+ token_database（前缀哈希）
     ▼
v1/storage_backend/storage_manager.py   StorageManager   ◄── 编排
     │   owns asyncio loop + OrderedDict[str, StorageBackendInterface]
     ▼
LocalCPUBackend(热) → LocalDiskBackend → GdsBackend
P2PBackend / NixlStorageBackend / PDBackend / RemoteBackend
                                          │
              remote connector: mooncakestore / redis / s3 / valkey ...
              transfer channel: nixl_channel / py_socket_channel（跨节点）
~~~

C++/CUDA 扩展 %%lmcache.c_ops%%（%%csrc/%%）提供 H2D/D2H 分页内存传输内核、CacheGen 算术编码、反向 RoPE、钉内存分配器。

> 注意包结构：%%lmcache/v1/%% **就是**当前架构，不是「遗留 v1」——%%v1/%% 只是命名空间。仓库里没有并行的 legacy 包。

## 模块关系

下表是**嵌入模式**的模块关系。MP 模式的模块（服务端组装、L1/L2 分层、fleet 控制面等）见 [深度分析的关键模块](#/a/lmcache)。

| 模块 | 角色 | 与中心的关系 |
|---|---|---|
| %%cache_engine.py%% | **中心 API** | store / retrieve / lookup 三个入口 |
| %%manager.py%% | 生命周期编排 | 构造 engine 与各服务，失败降级为「纯重算」 |
| %%token_database.py%% | token → key | 被 store/retrieve 调用，决定切块粒度 |
| %%gpu_connector/%% | 显存桥 | 被 engine 调用，做 paged 显存 ↔ MemoryObj 的搬运 |
| %%memory_management.py%% | 内存分配 | 被 StorageManager 调用，产出 MemoryObj |
| %%storage_backend/%% | 多级后端 | 被 StorageManager 编排 |
| %%transfer_channel/%% | 跨节点传输 | 被 P2PBackend / PDBackend 使用 |
| %%cache_controller/%% | 多实例控制面 | 独立进程，管 admit / evict / migrate |`,
  modules: [
    {
      id: 'store-path', name: 'store 全链路：从引擎 worker 到多级后端',
      files: ['lmcache/v1/cache_engine.py', 'lmcache/v1/storage_backend/storage_manager.py', 'lmcache/v1/gpu_connector/gpu_connectors.py'],
      summary: '一次 KV 落存经过哪些模块',
      flow: [
        '%%vllm_v1_adapter.py:1174%% 的 %%wait_for_save%% 触发落存',
        '进入 %%LMCacheEngine.store%%（%%cache_engine.py:363%%）',
        '%%token_database.process_tokens%%（:460）——**按 chunk 切分 token**，每块产出一个 key',
        '%%storage_manager.allocate%%（:474）→ %%allocator_backend.allocate%%（%%storage_manager.py:343%%）——申请 MemoryObj',
        '%%gpu_connector.batched_from_gpu%%（:533）——**D2H**，进 %%VLLMPagedMemGPUConnectorV3.from_gpu%%（%%gpu_connectors.py:541%%）',
        '→ %%lmc_ops.multi_layer_kv_transfer%%（D2H 方向）→ ★ %%csrc/mem_kernels.cu:620%%',
        '%%storage_manager.batched_put%%（:539）——分发给各级后端',
        '├ %%LocalCPUBackend.batched_submit_put_task%%（热缓存插入）',
        '├ %%MooncakestoreConnector.batched_put%% → %%batch_put_from%%（零拷贝）',
        '├ %%LocalDiskBackend%%（asyncio serde 写盘）',
        '└ %%P2PBackend%% → %%NixlChannel%%（RDMA）'
      ],
      points: [
        '**三步骨架**：分块 → 分配 → D2H 搬运 → 分发落存。读 %%cache_engine.py:363%% 的这一段就能抓住主线',
        '**切块粒度由 token_database 决定**，它同时决定了 key 的粒度与传输效率——是整条链路里最值得调的参数',
        '**各级后端是并行分发而非串行下沉**：%%batched_put%% 一次投递给所有注册的后端，本地热缓存与远端池同时收到',
        '真正的数据拷贝发生在 %%mem_kernels.cu%%——上面的 Python 层都在做编排，不在搬数据'
      ]
    },
    {
      id: 'retrieve-lookup', name: 'retrieve / lookup：命中查询与装回',
      files: ['lmcache/v1/cache_engine.py', 'lmcache/v1/lookup_client/', 'lmcache/v1/storage_backend/storage_manager.py'],
      summary: '为什么查询与取数是分开的两步',
      flow: [
        '**调度侧**先调 %%lookup(token_ids)%%（%%cache_engine.py:1058%%）——只问「能命中多少 token」，不搬数据',
        '请求经 %%LookupClient%%（ZMQ）跨进程问到 engine，engine 调 %%StorageManager.batched_contains%% 逐级询问',
        '各 backend 返回命中块，engine 汇总为命中 token 数 %%n_hit%% 回给 vLLM scheduler',
        '**执行侧**再调 %%retrieve%%（:754）——%%StorageManager.get_block_mapping%% + %%batched_get%% 真正取出',
        '远端命中会自动**写回 LocalCPU**，下次就是本地命中',
        '取到的 %%List[MemoryObj]%% 交给 %%gpu_connector.batched_to_gpu%% 做 H2D 装回显存',
        '返回 %%ret_mask%% 告诉引擎哪些 token 的 KV 已就绪'
      ],
      points: [
        '**lookup 与 retrieve 分离是设计要点**：调度器需要在「决定这一步跑什么」之前就知道能省多少 prefill，而不是等到执行时才发现',
        '%%lookup_client/%% 独立成进程/客户端（ZMQ RPC），是为了让查询不阻塞引擎主循环',
        '**远端命中自动写回本地**这一条比多级缓存本身更重要——一次跨机传输能换来后续多次本地命中',
        '%%ret_mask%% 的存在意味着**部分命中是被支持的**：命中多少就省多少，没命中的照常算'
      ]
    },
    {
      id: 'gpu-connector', name: 'GPUConnector：显存桥与版本演进',
      files: ['lmcache/v1/gpu_connector/__init__.py', 'lmcache/v1/gpu_connector/gpu_connectors.py', 'lmcache/v1/gpu_connector/gpu_ops.py'],
      summary: '引擎的分页显存布局与 LMCache 的 chunk 布局之间的翻译层',
      flow: [
        '入口 %%gpu_connector/__init__.CreateGPUConnector(config, metadata, engine, layout_hints)%%（:14）按 %%EngineType%% / 设备 / layerwise / %%use_gpu_connector_v3%% 派发',
        '抽象基类 %%GPUConnectorInterface%%（%%gpu_connectors.py:39%%）定义四个方法：%%to_gpu%% / %%from_gpu%% / %%batched_from_gpu%% / %%batched_to_gpu%%',
        '**%%VLLMPagedMemGPUConnectorV3%%（:417）是当前默认**：%%to_gpu%%(:503) 与 %%from_gpu%%(:541) 都调 %%lmc_ops.multi_layer_kv_transfer(...)%%',
        '%%batched_to_gpu%%(:601) 把搬运包进 %%load_stream%% 做异步',
        '另有 V2(:142)、%%VLLMBufferLayerwiseGPUConnector%%(:615)、%%VLLMPagedMemLayerwiseGPUConnector%%(:1028)',
        'SGLang 与 TRT-LLM 各有独立实现（:1400 / :1607 / :1904）'
      ],
      points: [
        '**这一层是 LMCache 与具体引擎耦合最深的地方**，也是换引擎适配成本的主要来源',
        '%%gpu_ops.py%% 只是 %%import lmcache.c_ops as lmc_ops%% 的一层薄封装——**昇腾侧正是通过替换这个模块实现内核重定向的**',
        'V3 用一次 %%multi_layer_kv_transfer%% 处理多层，比 V2 的逐层调用减少了 launch 开销',
        'layerwise 变体的存在，说明「逐层搬运以重叠计算」是 LMCache 的一等能力，而不只是 PD 分离的附属品'
      ]
    },
    {
      id: 'token-db', name: 'TokenDatabase：token 到 key 的两种切法',
      files: ['lmcache/v1/token_database.py'],
      summary: '切块粒度决定了缓存的最小复用单位',
      flow: [
        '%%TokenDatabase%%（:38 ABC）的唯一职责是 %%process_tokens%%（:170 抽象），产出 %%(start, end, CacheEngineKey|hash)%% 三元组',
        '%%_hash_tokens%%（:242）调 vLLM 的 %%sha256_cbor%% 做前缀哈希',
        '**%%ChunkedTokenDatabase%%（:269）**：按固定 %%chunk_size%% 切块，blending **关闭**时使用',
        '**%%SegmentTokenDatabase%%（:423）**：按 %%blend_special_str%% 分隔符切，blending **开启**时使用',
        '%%LMCacheEngineBuilder._Create_token_database%%（:1949）按是否 blending 二选一'
      ],
      points: [
        '**key 里带内容哈希**是设计要点：即使实例重启、请求顺序变化，只要前缀 token 相同，key 就相同，缓存依然可命中',
        '两种切法的取舍很实际：固定切块简单高效但与语义边界不对齐；按分隔符切能对齐对话轮次，但依赖 tokenizer 的分隔符约定',
        '切块粒度直接决定元数据开销与传输效率的平衡点，是最值得按业务调的参数之一'
      ]
    },
    {
      id: 'memory', name: 'MemoryManagement：格式抽象与分配器家族',
      files: ['lmcache/v1/memory_management.py', 'lmcache/v1/memory_allocators/'],
      summary: 'MemoryObj 是 KV 在主机侧的统一载体',
      flow: [
        '%%MemoryFormat(Enum)%%（:49）：%%KV_2LTD%% / %%KV_2TD%% / %%KV_T2D%% / %%KV_MLA_FMT%% ……描述 KV 张量的排布格式',
        '%%MemoryObj%%（:184 ABC）：核心接口 %%raw_tensor%% / %%tensor%% / %%ref_count_up|down%% / %%pin|unpin%%',
        '%%MemoryAllocatorInterface%%（:836 ABC）定义 %%allocate%%(:838)',
        '**%%MixedMemoryAllocator%%（:2058）是默认分配器**',
        '%%PinMemoryAllocator%%（:1972）：钉内存，底层走 c_ops 的 %%alloc_pinned_ptr%%',
        '另有 HostMemoryAllocator(:1895)、GPUMemoryAllocator(:2239)、TensorMemoryAllocator(:1274) + PagedTensorMemoryAllocator(:1563)'
      ],
      points: [
        '**%%PinMemoryAllocator%% 是暴露给 Mooncake 零拷贝的那一个**——钉内存才能被网卡直接注册访问，这是 LMCache 与月之暗面 Store 的接缝',
        '%%ref_count%% 与 %%pin%% 是两套不同语义：前者管内存回收，后者管「不许淘汰」',
        '%%MemoryFormat%% 的价值在 MLA / GQA 等异构布局上体现——不同注意力的 KV 形状完全不同，硬编码形状会在换模型时立刻失效'
      ]
    },
    {
      id: 'storage-mgr', name: 'StorageManager：多级后端的编排',
      files: ['lmcache/v1/storage_backend/storage_manager.py', 'lmcache/v1/storage_backend/local_cpu_backend.py', 'lmcache/v1/storage_backend/local_disk_backend.py', 'lmcache/v1/storage_backend/p2p_backend.py'],
      summary: 'OrderedDict 里的一条后端链',
      flow: [
        '%%StorageManager%% 持有 %%OrderedDict[str, StorageBackendInterface]%% 并自管一个 asyncio loop',
        '%%LocalCPUBackend%%：热缓存，pin 内存',
        '%%LocalDiskBackend%%：asyncio + serde 写盘',
        '%%GdsBackend%%：GPUDirect Storage，GPU ↔ disk 直读',
        '%%P2PBackend%%（%%p2p_backend.py:788%%）：跨实例 P2P，走 %%NixlChannel%%',
        '%%RemoteBackend%%：远端（mooncake / redis / s3 / hfbucket / valkey…）'
      ],
      points: [
        '**后端链的顺序即是性能模型**：把慢的后端放在前面会让每次读都被拖慢',
        '%%P2PBackend%% 与 %%RemoteBackend%% 的区别是「实例间直取」与「经共享存储中转」，前者延迟更低但需要拓扑可发现',
        '%%connector/%% 下几十个 adapter（redis / s3 / hf3fs / infinistore / mooncakestore…）说明后端生态是它真正的护城河'
      ]
    },
    {
      id: 'mooncake-backend', name: 'Mooncake 作为远端后端：零拷贝接缝',
      files: ['lmcache/v1/storage_backend/connector/mooncakestore_connector.py'],
      summary: 'LMCache 与 Mooncake Store 的唯一接缝',
      flow: [
        '%%MooncakestoreConnectorAdapter%%（scheme %%mooncakestore://%%）构造出 %%MooncakestoreConnector(RemoteConnector)%%（:323）',
        '构造时建 %%MooncakeDistributedStore()%%（:348）并 %%setup_mooncake_store%%（:413）',
        '关键一步：%%self._register_cpu_buffer(...)%%（:436）——**把 LMCache 的 CPU buffer 注册给 Mooncake**',
        '写入走 %%batched_put%% → %%_batched_put_zero_copy(...)%%（:716）',
        '读取走 %%batch_put_from%%（:732）等零拷贝接口'
      ],
      points: [
        '**「注册 CPU buffer」这一步就是零拷贝的全部秘密**：注册过之后，Mooncake 的 TE 可以直接往这块内存写，不需要中间缓冲',
        '这也解释了为什么 LMCache 需要 %%PinMemoryAllocator%%——只有钉内存才能被注册，普通可换页内存不行',
        '这条接缝很窄（一个 connector、一个注册调用），**是两个系统耦合最紧也最容易出问题的地方**'
      ]
    },
  ],
};

/* ================================================================
   LMCache-Ascend  (L2 推理引擎 · 昇腾侧 KV 复用层)
   依据本地 call-path 走读笔记 + 仓库实测重写
   ================================================================ */
window.WIKI_DETAILS['lmcache-ascend'] = {
  overview: `
## 一句话定位

LMCache-Ascend 是把 [LMCache](#/c/lmcache) 的 KV 复用能力带到**昇腾 NPU** 上的官方插件。它解决的是同一个问题——把 KV 从显存接管出来、放进多级缓存、下一个请求再塞回去——但全部换成昇腾的实现。

> **本页依据的基线**：\`dsv4_support_045\`（in-process 模式）+ 两个未合并的 PR
> （#291 PD/P2P 合流 + token-aware 代理、#292 Qwen3.5 的 GDN 状态缓存）。
> \`main\` 是 MP 模式的跟进位，那条路线目前还是空壳。

## 架构上最重要的一条：它是插件，不是 fork

~~~python
# lmcache_ascend/__init__.py
LMCACHE_UPSTREAM_TAG = "v0.4.5"     # pin 上游版本
LMCACHE_ASCEND_PATCHED = False
if not LMCACHE_ASCEND_PATCHED:
    LMCACHE_ASCEND_PATCHED = True
    # 随后执行 27 个 _patch_*()，外科手术式替换上游属性
~~~

工作方式是 import 上游 \`lmcache\`，在 import 时**替换特定属性**。这个选择带来两个直接后果：

- **上游的架构与调用链完全保留**，昇腾只替换「与硬件相关的那几个点」
- **与上游版本强耦合**：pin 死一个 tag，升级上游要重新核对全部替换点是否仍然成立

**注意有两条接管路径，不是一条**：上面这条是「导入时改内存」；
另有 \`integration/patch/\` 一套**文件级补丁器**（改第三方包源码、打前备份、按版本区间择时），
用来处理光靠改属性解决不了的地方（SGLang 的循环依赖、CacheBlend 的注意力接缝）。

## 依赖与兼容矩阵

| 项 | 要求 |
|---|---|
| 硬件 | Atlas 800I A2 推理系列（A3、300I Duo 为实验性） |
| CANN | **>= 8.2.RC1** |
| Ascend Driver | >= 24.1.0 |
| PyTorch | >= 2.7.1 |
| vLLM / vLLM-Ascend | >= v0.11.0 |

| LMCache-Ascend | LMCache | vLLM | SGLang |
|---|---|---|---|
| **main** | v0.4.5 | >= v0.14.0 | 0.5.8 |
| **dsv4_support_045** | v0.4.5 | >= v0.14.0 | 0.5.8 |

> 这张表值得单独看：**插件版本、上游版本、引擎版本三者必须成套匹配**。这是插件式架构最实际的运维代价。

## 昇腾版调用链

~~~text
vLLM-Ascend worker                        SGLang（另一个运行时，接管方式相反）
     │  KVConnectorBase_V1                      │ 只要 --enable-lmcache
     ▼                                          ▼
AscendLMCacheEngine                       （同样落到引擎与后端）
     │   ├ npu_connector（H2D/D2H）
     │   └ token_database（切 chunk 与算哈希）
     ▼
StorageManager ── 后端按固定顺序装配，上游 NIXL 被删除
     ├ AscendPDBackend   —— PD 分离：sender 卸 CPU、receiver 落 NPU
     ├ AscendP2PBackend  —— 跨节点主力：查与取拆开 + 完成协议
     └ LocalCPUBackend / LocalDisk / Remote
     │
TransferChannel：HCCL │ HIXL                ◄── 昇腾独有，上游是 NIXL
     │
csrc（主机侧 C++ 绑定与发射）
     │
kvcache-ops（设备侧 AscendC 内核，git submodule）  ◄── 真正跑在 NPU 上的那层
~~~

## 与上游的分工

| 层次 | 上游 LMCache | LMCache-Ascend |
|---|---|---|
| 中心 API（store / retrieve / lookup） | ✅ 提供 | 继承，**store 改为异步**；PD 路径再加请求级租约 |
| 缓存键与切块 | ✅ 提供 | 换 \`process_tokens\` 并加边界守卫；哈希一致性改由 \`PYTHONHASHSEED=0\` 保证 |
| 显存桥 | CUDA 内核 | **NPU connector（2796 行，最大差异）** |
| 多组 KV | 不做 | **multi-group / multi-plane（dsv4 的核心新增）** |
| 跨节点传输 | NIXL | **HCCL / HIXL（昇腾独有，NIXL 被删除）** |
| 跨节点后端 | P2PBackend / PDBackend | **AscendP2PBackend（查取分离）/ AscendPDBackend（角色感知 + 背压 + 熔断）** |
| 设备侧内核 | CUDA / Triton | **kvcache-ops：AscendC 写的 multi_layer / single_layer / PAC 编解码 / fused RoPE** |
| 混合模型状态 | 不做 | **GDN 状态检查点（PR #292，独立存储 + 公共恢复边界）** |
| 计算融合 | CacheBlend（CUDA） | **blend：昇腾的注意力重算与位置编码复原** |
`,
  modules: [
    {
      id: "npu-connector", name: "分页显存搬运：五个覆写类",
      files: ["lmcache_ascend/v1/npu_connector/"],
      summary: "它把 KV 在分页显存与宿主缓冲之间双向搬运，按 slot_mapping 散入页表，是宿主 GPUConnector 契约在 Ascend 上的纯覆写实现。",
      flow: [
        "%%batched_to_gpu%% 先做批量预计算：只有拿到分组 slot 与 %%starts%% 时，才把每个 chunk 的 plane 行列写进 %%mp_launch_meta%%（npu_connectors.py:1595、npu_connectors.py:1623），否则直接返回。",
        "没有 %%ProxyMemoryObj%% 时走扁平循环，逐个对象调 %%to_gpu%%（310P 换成 %%to_gpu_310p%%，npu_connectors.py:1927），循环完 %%load_stream.synchronize()%%（npu_connectors.py:1931）。",
        "有代理对象时整批交给 %%_remote_batched_to_gpu%%（npu_connectors.py:1968）：两组缓冲 ping-pong，第 k 批在 transport_stream 上发起 RDMA 读（npu_connectors.py:2062），load_stream 同时散第 k-1 批（npu_connectors.py:2068）。",
        "回到 %%batched_to_gpu%% 还要补一句 %%current_stream().wait_stream(load_stream)%%（npu_connectors.py:1921）——%%synchronize()%% 只挡主机，挡不住计算流（npu_connectors.py:1918）。",
        "两条路最后都进同一个 %%to_gpu%%：先问 %%_try_multi_plane_dispatch%%（npu_connectors.py:1544），返回 %%False%% 才退回扁平的 %%multi_layer_kv_transfer%%（npu_connectors.py:1573）。",
        "存回方向是镜像的：%%batched_from_gpu%%（npu_connectors.py:2124）同样先预计算再逐个 %%from_gpu%%，区别是置上 %%no_sync%%（npu_connectors.py:2132），最后只同步一次（npu_connectors.py:2146）。"
      ],
      points: [
        "五个类**全部继承**宿主的 %%GPUConnector%% 基类，没有一个实现接口——它继承谁就服务谁，形态由宿主决定（npu_connectors.py:365、npu_connectors.py:745、npu_connectors.py:2169、npu_connectors.py:2517、npu_connectors.py:2521）。",
        "npu_connectors.py:49 起的 7 个模块级函数是这一版新增的分组搬运辅助，不挂在任何类上、只被 V2 调用；%%SGLangNPUConnector%% 类体只有一行 %%pass%%（npu_connectors.py:2518），是有意为之而非占位。",
        "310P 必须单独两条路：页布局里 %%block_size%% 取 %%shape[-2]%%（npu_connectors.py:1339），%%__init__%% 就 assert 要求传 %%num_kv_head%% 与 %%head_size%%（npu_connectors.py:792），批量 P2P 在 310P 上直接拒绝（npu_connectors.py:1911）。",
        "失败记账是一条**一次性通道**：没有 %%req_id%% 只记一条日志就丢弃（npu_connectors.py:1934），有才进集合，由上层 %%drain_failed_load_req_ids()%% 取走并清空（npu_connectors.py:1943、npu_connectors.py:1945），再把请求标成要重算。"
      ]
    },
    {
      id: "multi-group", name: "多组 KV 的元数据、槽位与落盘",
      files: ["lmcache_ascend/v1/kv_format.py", "lmcache_ascend/v1/kv_layer_groups.py", "lmcache_ascend/v1/slot_mapping_utils.py", "lmcache_ascend/integration/vllm/multi_spec_flatten.py", "lmcache_ascend/integration/vllm/multi_group_vllm_adapter.py", "lmcache_ascend/v1/memory_management.py", "lmcache_ascend/v1/storage_backend/local_disk_backend.py"],
      summary: "把宿主「一组 KV」的单一假设推广成「多组、且每组形态可以不同」，并为每组各自维护格式判定、槽位切片与落盘元数据。",
      flow: [
        "注册时先摘出状态层，其余注意力层交给 %%build_flat_kv_caches()%% 展平成一条扁平 KV 表，决定后续每一层的下标（%%vllm_v1_adapter.py:152%%）。",
        "把每组的 %%block_size%%、压缩比、滑动窗口与逐层调度组号写进 %%layout_hints%%（%%vllm_v1_adapter.py:179%%），这是多组信息从 vLLM 传到 NPU 侧的唯一通道。",
        "%%ensure_kv_layer_groups()%% 在 %%post_init()%% 之前建好层组（%%vllm_v1_adapter.py:203%%），内部走 %%build_kv_layer_groups()%%（%%npu_connectors.py:909%%），这样 %%get_shapes()%% 才能按组分配。",
        "每个 new / cached 请求各建一次按组元数据：new 走 %%RequestTracker.from_new_request()%%（%%multi_group_vllm_adapter.py:896%%），cached 走 %%ReqMeta.from_request_tracker()%%（%%multi_group_vllm_adapter.py:957%%）。",
        "worker 侧 %%_multi_group_kv_transfer()%% 对每个 NPU 组取一张 %%MemoryObj%% 子张量并发射一次（%%npu_connectors.py:1710%%）。"
      ],
      points: [
        "**分组键只有五个字段**：%%kv_size%%、%%hidden%%、%%block_size%%、%%dtype_key%%、%%num_tensors%%，共享这五个字段的层才能共用一次内核发射（%%kv_layer_groups.py:30%%）。",
        "%%MultiPlaneBundle%% 是空的 %%tuple%% 子类，不增字段也不增内存；block_size 相同时它是区分多平面打包与普通 (K, V) 的唯一正身证明（%%kv_format.py:19%%）。",
        "槽位是一条三段流水线：先按压缩比把 token 区间切成槽位区间（%%slot_mapping_utils.py:48%%），再按 %%-1%% 压实并记一张前缀表，之后每块切片只需两次查表相减（%%slot_mapping_utils.py:73%%）。",
        "落盘覆盖的只有「形状」：读回时优先按 %%disk_meta.shapes%% 与 %%dtypes%% 做多组分配，缺失才退回单组，旧条目仍可读（%%local_disk_backend.py:196%%）；%%group_prefix_sum%% 必须在每次分配后刷新（%%memory_management.py:10%%）。"
      ]
    },
    {
      id: "engine-integration", name: "vLLM 连接器与引擎接缝",
      files: ["lmcache_ascend/v1/cache_engine.py", "lmcache_ascend/integration/vllm/vllm_v1_adapter.py", "lmcache_ascend/integration/vllm/lmcache_ascend_connector.py", "lmcache_ascend/integration/vllm/lmcache_ascend_connector_v1.py"],
      summary: "把 vLLM 的 KV 连接器接口、连接器实现与被替换的引擎子类这三层接起来，让 import lmcache_ascend 之后的 vLLM 在 in-process 主路径上不写一行 Ascend 代码就能走到 NPU 缓存。",
      flow: [
        "vLLM 按注册名 %%LMCacheAscendConnector%% 取到只有 66 行的连接器壳（%%lmcache_ascend_connector.py:32%%），壳本身几乎没有逻辑，只做转发。",
        "构造时先存下 %%_kv_cache_config%%（%%lmcache_ascend_connector.py:43%%）再调 %%super().__init__()%%，内层实现才拿得到这个参数。",
        "补丁把宿主模块里的类名重绑：内层 impl、%%RequestTracker%%、%%ReqMeta%% 换成本模块的实现，%%LMCacheEngine%% 换成 %%AscendLMCacheEngine%%（%%cache_engine.py:74%%）。",
        "引擎 %%post_init%% 懒启动异步写 worker（%%cache_engine.py:160%%），此后适配器与连接器只是两个引用名，指向同一个引擎实例。",
        "每次请求落到 %%lookup%%（%%cache_engine.py:1112%%）：先按保留键分派状态查询，未命中才走普通 KV 查询与 PD 请求租约。",
        "保存路径 %%store%% 在异步模式下只入队（%%cache_engine.py:1319%%），由后台线程真正落盘，完成状态经 %%get_finished_stores%% 回报给 vLLM。",
        "抢占时先释放查询 pin 再排空后台写（%%vllm_v1_adapter.py:1084%%）；关闭时先投毒丸排空 worker，最后才 %%super().close()%%（%%cache_engine.py:1349%%）。"
      ],
      points: [
        "**三条接缝**各司其职：连接器壳只转发、内层 impl 管设备侧、引擎子类替宿主兜住异步写、分片广播、PD 租约与有序关闭。",
        "本模块新增的数据结构只有两个：%%ThreadSafeEventList%%（%%cache_engine.py:38%%）与 %%LMCacheAscendConnectorMetadata%%（%%vllm_v1_adapter.py:55%%），其余全部沿用宿主类型。",
        "引擎子类多数是覆写宿主已有方法名，净增接口很少，所以使用者需要额外学的接口不多。",
        "%%lookup%% 与 %%lookup_unpin%% 是合并冲突后自行解析出的合成形态，状态分派与 PD 租约共处一个函数，读上游任一分支都对不上。"
      ]
    },
    {
      id: "state-cache", name: "循环状态缓存与公共恢复边界",
      files: ["lmcache_ascend/v1/state_cache.py", "lmcache_ascend/v1/state_transfer.py", "lmcache_ascend/v1/state_lookup.py", "lmcache_ascend/integration/vllm/state_groups.py", "lmcache_ascend/integration/vllm/skip_state_groups.py"],
      summary: "把混合模型里 GDN 的循环状态 S(R) 做成可独立存储与复用的检查点，并借 OP_KEY 接进引擎既有的 lookup 通道。",
      flow: [
        "调度器调 %%lookup_state%%（%%state_lookup.py:63%%），把控制字段塞进 %%request_configs%% 走引擎既有的同步查询通道。",
        "引擎的 %%lookup%% 先认出保留键 %%OP_KEY%%（%%state_lookup.py:17%%），有就把配置原样转交给 %%dispatch_state_lookup%%（%%state_lookup.py:219%%），不再走普通 KV 查询。",
        "%%local_candidate%%（%%state_lookup.py:151%%）按边界从大到小试候选，每个组在 CPU 与磁盘两级各取一次，只有所有组的缓冲都凑齐才继续。",
        "跨 rank 协商：只有所有 worker 回的最大可用边界完全相等才成立（%%state_lookup.py:108%%），否则取最小值收缩上界再试（%%state_lookup.py:111%%），试不到就返回 0。",
        "覆盖检查：对缺口区间里的每个 chunk 调 %%manager.contains(key, locations, pin=True)%%（%%state_lookup.py:197%%），任一个找不到就整体作废，换更小的候选。",
        "选中后记进引擎选中表与 %%lookup_pins%%（%%state_lookup.py:257%%），再挂一个 %%pin_timeout_sec%% 的兜底定时器（%%state_lookup.py:267%%）。",
        "恢复时 %%StateCache.prepare_load%%（%%state_cache.py:50%%）不重新取数，只预检已借出的缓冲；保存由 %%StateCache.save%%（%%state_cache.py:122%%）分配新缓冲并同步搬完后才发布。"
      ],
      points: [
        "**Attention 命中不代表 state 存在**：公共恢复边界 %%R%% 必须同时满足「Attention 覆盖 %%[C,R)%%」与「所有 GDN 组、所有 rank 都有 %%S(R)%%」，取不到交集就不恢复（%%state_lookup.py:167%%）。",
        "检查点身份是独立对象键：%%state_checkpoint_key%% 在既有前缀链式键后追加三个保留标签（%%state_checkpoint.py:121%%），派生规则单点定义（%%state_checkpoint.py:112%%），同一前缀下每个组各占一个对象。",
        "布局是 **plane-major**：%%build_state_group_layout%% 把 %%conv%% 与 %%ssm%% 两个平面按层打包（%%state_layout.py:50%%、%%state_layout.py:68%%），平面偏移按元素字节数最小公倍数对齐（%%state_layout.py:84%%），检查点大小只由组布局决定。",
        "%%CheckpointRef%% 只是身份、不是可用性证明；拷贝失败时保存侧对象绝不发布，恢复侧的运行时却可能已被改了一半，模块不做回滚，失败后继续推理不安全。"
      ]
    },
    {
      id: "disagg-proxy", name: "PD 分离代理：一次请求拆两段",
      files: ["examples/disagg_prefill/"],
      summary: "一个可直接部署的 HTTP 代理服务，对客户端装着 vLLM 的 OpenAI 接口，对上游把一次请求拆成 prefill 段与 decode 段分别转发。",
      flow: [
        "取 token 数：向实例调用 %%/tokenize%% 拿到 %%prompt_token_count%%，它既是负载权重也是准入权重（%%examples/disagg_prefill/disagg_proxy_server.py:1107%%）。",
        "拆两段请求体：prefill 段 %%max_tokens=1%%、%%stream=False%%，decode 段取 %%max_tokens-1%% 且保持流式（%%examples/disagg_prefill/disagg_proxy_request.py:101%%）。",
        "先选 decode 实例、再选 prefill 实例：准入闸门挂在 decode 实例上，顺序不能反（%%examples/disagg_prefill/disagg_proxy_server.py:1171%%）。",
        "只发 prefill 段，把 decode 实例的接收地址写进 %%disagg_spec%% 交出去，代理自己不搬 KV（%%examples/disagg_prefill/disagg_proxy_server.py:1200%%）。",
        "等 %%wait_decode_kv_ready%% 数够 TP rank 份 ZMQ 通知才开流，随后透传 decode 段的结果（%%examples/disagg_prefill/disagg_proxy_server.py:1050%%）。",
        "失败与取消分两条路收口，%%except%% 分支与流式生成器的 %%finally%% 都用三个布尔标记保证每段只归还一次（%%examples/disagg_prefill/disagg_proxy_server.py:1346%%）。"
      ],
      points: [
        "它是**可直接部署的 HTTP 代理**而非库：对外只有 %%POST /v1/completions%% 与 %%POST /v1/chat/completions%% 两个端点，对宿主只 import 一个通知消息类（%%examples/disagg_prefill/disagg_proxy_server.py:1082%%）。",
        "路由输入是 token 的**数量**而不是身份：两侧都选在飞负载最小的实例，prefill 侧另按 %%PREFILL_REQUEST_ALPHA=256%% 把在飞请求折算成 token，**不做前缀亲和**（%%examples/disagg_prefill/disagg_proxy_server.py:470%%）。",
        "准入按转移模式启停：%%push%% 与 %%eager_pull%% 会先在 decode 侧占下整段 KV，所以要按 %%pd_buffer_size%% 与 %%chunk_size%% 预算容量；%%delay_pull%% 不预占，直接跳过闸门（%%examples/disagg_prefill/disagg_proxy_server.py:192%%）。",
        "KV 就绪通知走与 HTTP 无关的 ZMQ 反向通道，%%req_id%% 是进程内自增计数而非全局唯一 ID，代理重启后并存的旧请求会串号（%%examples/disagg_prefill/disagg_proxy_server.py:1086%%）。"
      ]
    },
    {
      id: "pd-backend", name: "PD 交接后端与请求级租约",
      files: ["lmcache_ascend/v1/storage_backend/pd/"],
      summary: "PD 分离部署时在 prefill 与 decode 节点间交接 KV 的后端，push 与 pull 共用一条侧信道，并叠了一层按请求计数的接收租约。",
      flow: [
        "sender 的 %%batched_submit_put_task%% 先查按对端的熔断表，退避期内整批跳过传输（%%pd/sender_mixin.py:348%%）。",
        "push：sender 发 %%AllocRequest%%，receiver 用 %%_partition_keys%% 跳过已存在 key（%%pd/receiver_mixin.py:95%%）。",
        "sender 用 %%batched_write%% 写进远端页，仅 %%is_last_prefill%% 时补发 %%ProxyNotif%%（%%pd/sender_mixin.py:486%%）。",
        "pull：sender 发 %%PullReadyNotif%% 报出缓冲 UUID，receiver 主动 %%batched_read%% 读 pin 缓冲（%%pd/messages.py:52%%）。",
        "receiver 先把 ack 发回 REP、再触发回调发 %%PullDoneSignal%%，避免 Done 早于 ack 到达（%%pd/receiver_mixin.py:511%%）。",
        "delay 模式把取数推迟到 %%batched_to_gpu%%，Done 由 %%send_done_now%% 补发（%%v1/transfer_context.py:414%%）。",
        "命中即加租约：%%batched_contains_and_lease%% 把请求名写进 %%PDEntry.owners%%，最后一个 owner 退出才删（%%pd/backend.py:392%%）。"
      ],
      points: [
        "形态是**继承 + 两个 mixin**：%%AscendPDBackend%% 同时继承收发 mixin 与宿主类，mixin 因此能截住宿主同名实现（%%pd/backend.py:54%%）。",
        "租约是**请求级**而非对象级引用计数：同一个 key 被两个请求命中时 %%owners%% 里有两个名字，回收只看最后一个 owner（%%pd/backend.py:440%%）。",
        "delay 模式靠**共享原型 + 每请求克隆**隔离：请求消费的是 %%clone_for_request%% 的克隆，原型不动，别的请求仍能命中（%%pd/backend.py:430%%）。",
        "熔断与背压是**两个独立的刹车**：前者按对端 %%receiver_id%% 做时间退避，后者只看本端水位（%%pd/sender_mixin.py:118%%）。"
      ]
    },
    {
      id: "p2p-backend", name: "P2P 后端：补齐宿主留白",
      files: ["lmcache_ascend/v1/storage_backend/p2p_backend.py"],
      summary: "AscendP2PBackend（p2p_backend.py:172）继承宿主的 P2PBackend，把只做了一半的 P2P 取数路径补完，代价是换掉 socket 类型与地址表示两个前提。",
      flow: [
        "调用方先经 %%batched_contains%%（p2p_backend.py:1860）同步问控制器，拿到对端地址与命中块数。",
        "为对端建 %%DEALER%% 连接与回复读取协程（p2p_backend.py:582），带 %%req_id%% 发查询（p2p_backend.py:1365），超时即当未命中（p2p_backend.py:1405）。",
        "对端用 %%ROUTER%% 收包，每包起一个任务（p2p_backend.py:818），本地 %%contains%% 命中时顺手 pin 住对象（p2p_backend.py:1004）。",
        "pull 模式只回 %%buffer UUID%% 与 %%index%%（p2p_backend.py:1063），对象留在对端的 %%pending_pull_resources%% 表里（p2p_backend.py:1032）；非 pull 模式当场写回（p2p_backend.py:1078）。",
        "本端读完无论成败都要发 Done（p2p_backend.py:1710），这条 Done 走单独的 %%REP%% 连接（p2p_backend.py:1539）。",
        "对端收到 Done 就从表里取出对象释放（p2p_backend.py:1103）；等不到 Done 就由 TTL 巡检兜底释放（p2p_backend.py:1115）。"
      ],
      points: [
        "换掉的两个前提是 socket 与地址表示：%%zmq.REQ%% 变 %%zmq.DEALER%%（p2p_backend.py:142），裸 %%mem_addrs%% 变 %%UUID + mem_index%%（p2p_backend.py:113），全文件大部分方法都在应付它们的连锁反应。",
        "**配对责任从 socket 状态机挪到应用层**：pending 表按 %%req_id%% 配对 Future（p2p_backend.py:727），断连时把在飞查询一次性置 %%ConnectionError%%（p2p_backend.py:747）。",
        "**Done 是完成协议的核心**：查与取拆开后对端 pin 住的资源必须活到第二次调用，Done 收不到就靠 TTL 兜底（p2p_backend.py:1115，默认 60 秒见 p2p_backend.py:242）——这不是优化，而是正确性的一部分。",
        "延迟取数时本模块只负责造代理对象并交出（%%backing_obj%% 传 %%None%%，p2p_backend.py:1806），代理语义与失败记账都在别处。"
      ]
    },
    {
      id: "transfer-channel", name: "传输通道：两条实现一个基类",
      files: ["lmcache_ascend/v1/transfer_channel/", "lmcache_ascend/v1/transfer_context.py"],
      summary: "在两个节点之间搬一段已经算好的 KV 字节：先登记两端内存，再用一次单向读或单向写把页搬过去。",
      flow: [
        "%%CreateTransferChannel()%%（%%transfer_channel/__init__.py:94%%）按配置建通道，%%get_correct_device()%%（%%transfer_channel/__init__.py:14%%）把 worker_id 折成 %%npu:N%%。",
        "两条实现共享一个基类：%%HcclChannel%%（%%hccl_channel.py:95%%）与 %%HixlChannel%%（%%hixl_channel.py:42%%）都继承 %%BaseMultiBufferChannel%%（%%base_channel.py:38%%），差别只在「怎么发」，握手与地址规范化是同一套。",
        "握手循环只在基类写一遍：%%_init_loop%%（%%base_channel.py:143%%）与 %%_async_init_loop%%（%%base_channel.py:186%%）都按 %%self._init_msg_type%% 解包，子类只提供消息类型与处理函数。",
        "地址解析只认两个坐标：%%(buffer_uuid, page_index)%% 先按 uuid 查句柄（%%buffer_config.py:76%%），再算 %%buffer_ptr + page_index * page_size%%（%%buffer_config.py:91%%），页号越界立刻抛 %%IndexError%%（%%buffer_config.py:86%%）。",
        "单向动作用异步读入口下发（%%hccl_channel.py:787%%、%%hixl_channel.py:379%%）；HCCL 另有一个提交不等待的 %%submit_batched_read()%%（%%hccl_channel.py:814%%），让调用方一边读一边散。",
        "生命周期都在另一个目录的 %%transfer_context.py%%：取之前的 %%check_lease()%%（%%transfer_context.py:160%%）、取之后的 %%decref()%%（%%transfer_context.py:137%%）与 %%send_done_now()%%（%%transfer_context.py:148%%），Done 由锁内的 %%_done_sent%% 保证恰好发一次（%%transfer_context.py:140%%）。"
      ],
      points: [
        "**这是插件里唯一完全走正门的扩展**：继承宿主抽象而不是复制它、复用宿主的消息基类族、十个文件里没有一处对宿主符号赋值；唯一的例外是包级 bootstrap 把本模块的 %%get_correct_device%% 装回宿主（%%lmcache_ascend/__init__.py:576%%）。",
        "**成对的收发它故意不实现**：%%batched_send%% / %%batched_recv%% 与两个异步版一律 %%raise NotImplementedError%%（%%base_channel.py:261%%），因为单向读写只需要一端发起。",
        "远端缓冲是四层描述：%%MemHandleMeta%%（%%buffer_config.py:29%%）是登记后的本地视图，%%PeerBufferInfo%%（%%buffer_config.py:45%%）是唯一跨进程的那一层（msgspec 可编码），收到之后重建为 %%RemotePeerBufferHandle%%（%%buffer_config.py:53%%）与 %%RemotePeerBufferList%%（%%buffer_config.py:64%%）。",
        "**HCCL 与 HIXL 的差别只在传输动作**：两者最终产出同一个对端描述类型，这正是地址解析能收进基类的前提。"
      ]
    },
    {
      id: "proxy-memory", name: "ProxyMemoryObj：只写坐标",
      files: ["lmcache_ascend/v1/proxy_memory_obj.py"],
      summary: "一个只写坐标、不含数据的 MemoryObj：把一个「已经查到、但还没取回」的远端命中表示成可以继续往下传的对象，取数推迟到真正被读的那一刻。",
      flow: [
        "命中之后按 chunk 造轻量代理（%%p2p_backend.py:1806%%）：只记三个坐标——对端地址、远端缓冲 uuid、远端页下标（%%proxy_memory_obj.py:84%%），并共享一个覆盖整批命中的 transfer context。",
        "它作为普通 %%MemoryObj%% 往下传，插入是透明的：整个仓库只有 %%is_proxy%% 一个标记点（%%proxy_memory_obj.py:119%%），宿主的写回路径在 %%storage_manager.py:196%% 用它把代理挡在写回本地 CPU 之外。",
        "真正要读时由 NPU 连接器推进：先借一块 ping-pong 缓冲绑上（%%npu_connectors.py:2056%%），再 %%submit_resolve_batch()%% 提交批量读（%%npu_connectors.py:2062%%），等事件落地后散射进 KV cache（%%npu_connectors.py:1955%%）。",
        "三条取数通路共用同一套坐标与租约检查：单块阻塞 %%resolve()%%（%%proxy_memory_obj.py:198%%）、批量阻塞 %%resolve_batch()%%（%%proxy_memory_obj.py:261%%，只查第一块的租约 :280）、提交不等待的 %%submit_resolve_batch()%%（%%proxy_memory_obj.py:298%%）；租约检查就在提交读之前（%%proxy_memory_obj.py:211%%）。",
        "散射完成后收尾：%%mark_consumed()%% 让代理作废（%%npu_connectors.py:2113%%），再对每个上下文发一次 Done（%%npu_connectors.py:2115%%），放掉发送端 pin 住的缓冲。",
        "放弃路径由宿主驱动：散射事件落地后逐个降计数（%%cache_engine.py:282%%），计数归零时调上下文的 %%decref()%%（%%proxy_memory_obj.py:490%%）——两条路径共享同一个完成标记，Done 恰好发一次。"
      ],
      points: [
        "**这个窗口是真实存在的**：跨节点钉不住对方的引用计数，于是换成两样东西——取之前的租约检查、取之后的 Done 信号，模块的全部复杂度就来自这两件事要在没有共享内存的前提下做到。",
        "代理不调用父类构造函数、自己管元信息（%%proxy_memory_obj.py:81%%），轻量模式下造一个 %%address=0%% 的桩（%%proxy_memory_obj.py:367%%）——**延迟取数在数据结构上的全部含义就是这个 %%address=0%%**。",
        "两个子类只差「有没有租约」：%%P2PTransferContext%% 按时间租约（%%transfer_context.py:237%%），%%PDTransferContext%% 不看代理引用计数、看请求租约（%%transfer_context.py:404%%）；租约过期被当一次未命中处理，而不是取到错误数据。",
        "%%get_ref_count%% 恒返回 1（%%proxy_memory_obj.py:492%%）是刻意为之：宿主的清理路径拿「计数等于 1」当可删的判据——**这是宿主契约泄漏进插件的一处**。"
      ]
    },
    {
      id: "token-database", name: "算键入口：一个模块级函数",
      files: ["lmcache_ascend/v1/token_database.py"],
      summary: "插件侧的算键入口：换掉宿主的 process_tokens，按分隔符切段、逐段哈希、组装成 CacheEngineKey。",
      flow: [
        "%%_patch_hash_token()%% 直接把本函数赋到宿主类的 %%process_tokens%% 槽位（%%lmcache_ascend/__init__.py:867%%）——插件不继承、不实例化宿主类，只提供一个模块级函数，第一个参数接宿主实例。",
        "进函数先把 %%tokens%% 规整成 CPU 长整型：张量走 %%.to(device=cpu, dtype=long)%%（%%token_database.py:56%%），列表则新建一个 CPU 长整型张量（%%token_database.py:54%%），之后的链路只面对张量。",
        "边界守卫排在宿主那句断言之前：空序列告警后返回（%%token_database.py:64%%），全 %%False%% 掩码同样告警后返回（%%token_database.py:70%%）；断言本身仍留在后面（%%token_database.py:77%%）。",
        "切段与下标全靠累加：用宿主的 %%self._fast_split_by_subtensor()%%（%%token_database.py:82%%）切段，非首段在 %%start_idx%% 与 %%end_idx%% 上各补一次 %%self.sep_len%%（%%token_database.py:88%%），被掩掉的前缀段按 %%start_idx >= num_falses%% 跳过（%%token_database.py:90%%）。",
        "逐段产键：先调宿主的 %%self._hash_tokens()%%（%%token_database.py:96%%），再用 %%self._make_key_by_hash()%% 连同 %%request_configs%% 组装成 %%CacheEngineKey%%（%%token_database.py:95%%）。",
        "%%make_key%% 是唯一开关：真给完整的键（存取路径要按它分配与取回），假只给整数哈希（查找路径只需把哈希发出去，%%token_database.py:100%%）；另一条 %%hashes%% 分支不再哈希，直接用现成哈希与 %%offsets%% 配对（%%token_database.py:102%%）。"
      ],
      points: [
        "**边界守卫是相对宿主的唯一行为差异**：没改哈希、没改切段，只把「抛异常」换成「告警后空手返回」，调用方的 %%for%% 循环因此拿到 0 个元素而不是被打断。",
        "**算错不报错，只是永不命中**：哈希算法由宿主的 %%hash_func%% 决定，退回内建 %%hash()%% 时字符串哈希带进程级随机种子，不设 %%PYTHONHASHSEED%% 时两侧键不同——没有栈，只有命中率。",
        "第三元的一致性约束是两侧契约：两侧调用的是同一份被换上去的函数，所以切段逻辑不会分叉，分叉只可能来自进程级输入。"
      ]
    },
    {
      id: "blend", name: "blend：昇腾版 CacheBlend",
      files: ["lmcache_ascend/v1/blend/"],
      summary: "把宿主的 CacheBlend 子系统整段搬到插件命名空间，换成昇腾的 RoPE 与注意力，在少数层上挑出新旧 K 差得最多的那批 token 重算并覆写回缓存 KV。",
      flow: [
        "宿主适配器在 %%enable_blending%% 为真时取 blender，构造时校验 %%recomp_ratios%% 长度并为每层建 %%ZLMCFlashAttnBackend%%（blender.py:49-55、models/models.py:23-26）。",
        "%%blend_layer%% 是两条流的生成器：先 %%next()%% 一次取数再 %%yield%%（blender.py:199-200），此后每轮各推进一层（blender.py:202-205），搬运与计算因此并行。",
        "每层在 %%process_qkv%% 里把重算的新 K 与缓存 K 逐 token 求平方差（blender.py:146-149），按比例取差值最大的一批并排序（blender.py:157）。",
        "这批下标既用来覆写缓存 KV 的对应行（blender.py:176-177），也当作注意力里 q 的真实位置（attention/attention.py:251-252），q/v/residual 只留这批（blender.py:165-167）。",
        "收尾调用 %%metadata.clean()%% 清掉本层下标（blender.py:209），下一次请求重新选批。"
      ],
      points: [
        "**整段平移 + 单点替换**：与宿主同名同形但不继承（blender.py:17），元数据仍 import 自宿主（blender.py:7），接回宿主只在工厂上打一个补丁（lmcache_ascend/__init__.py:586）。",
        "**融合是覆写，不是替换**：选中的行被新值盖掉，KV 总长度不变，未选中的行继续用缓存值（blender.py:176-177）。",
        "三个注意力后端里只有 %%ZLMCFlashAttnBackend%% 被逐层模型真正 new 出来（models/models.py:23-26），另两个是死代码，只能当语义参照。",
        "RoPE 自检不通过时 %%get_fused_rope%% 直接 %%return None%%——静默禁用 blending 而不抛异常（positional_encoding.py:244-248），代价在调用方取用时才炸。"
      ]
    },
    {
      id: "sglang-adapter", name: "SGLang 适配：77 行两个函数",
      files: ["lmcache_ascend/integration/sglang/"],
      summary: "SGLang 侧不配连接器，插件在 import 时把宿主连接器的两个方法换成昇腾版——全模块 77 行、两个模块级函数、没有一个类。",
      flow: [
        "接管的全部动作只有两次属性赋值：%%_patch_sgl()%%（%%lmcache_ascend/__init__.py:911%%）把插件版赋到 %%LMCacheConnector.__init__%%（%%lmcache_ascend/__init__.py:921%%）与 %%LMCacheLayerwiseConnector.global_min_tokens%%（%%lmcache_ascend/__init__.py:923%%），函数体里只有 import 与赋值。",
        "构造替换只改两处：判空从 %%if not k_pool%% 换成显式判长度（%%sglang_adapter.py:28%%），理由写在 :26 的 NOTE 里（避开与 Tensor-like 对象的歧义）。",
        "第二处改动是把交给引擎的 %%self.kvcaches%% 从「K 与 V 首尾相接」改成两个元素、各自逐层（%%sglang_adapter.py:53%%），因为 NPU 期望 %%[K_tensor, V_tensor]%%（NOTE 在 :50）。",
        "其余逐字保留宿主的写法：%%kv_dtype%%、%%local_rank%% 的取法、%%init_lmcache_engine()%% 的五个实参（%%sglang_adapter.py:39%%）、%%self.num_layer%% 与最后的 %%post_init()%%（%%sglang_adapter.py:57%%）。",
        "逐层求「大家都能加载多少 token」时 %%tp_size%% 为 1 直接返回（%%sglang_adapter.py:66%%），否则在 MIN 归约前先做一次 %%torch_dev.synchronize()%%（%%sglang_adapter.py:73%%），再 %%dist.all_reduce%% 取最小（%%sglang_adapter.py:75%%）。",
        "那句同步是插件加的，原因是高负载下 compute kernel 与 HCCL 归约之间可能竞争、导致整个 TP 组永久死锁（NOTE 在 %%sglang_adapter.py:70%%）。"
      ],
      points: [
        "**这 77 行量的不是实现质量，而是宿主留了多大口子**：vLLM 侧允许整类替换（四个文件 2,749 行），SGLang 只允许换方法。",
        "**接管完全发生在进程启动期、没有 undo**：用户在 SGLang 侧能控制的只有开不开 %%--enable-lmcache%%，一旦 import，两个方法就同时被换掉。",
        "失败模式里真正有风险的是第二条：宿主改了签名而属性名还在时，错误会出现在别处而不是这里。",
        "版本耦合很硬：%%sglang_adapter.py:8%% 直接 import SGLang 内部模块且只用在类型标注上（%%sglang_adapter.py:17%%），文件又没有 %%from __future__ import annotations%%，所以这是一个真实的运行时导入。"
      ]
    },
    {
      id: "csrc-kernels", name: "C++ 绑定与算子发射",
      files: ["csrc/"],
      summary: "主机侧 C++ 绑定与发射：Python 的每一次 lmc_ops 调用都在这里翻成一次 NPU 算子提交，设备侧 kernel 本体在 kvcache-ops 子模块里。",
      flow: [
        "Python 入口先落到三个独立的扩展模块：%%lmcache_ascend.c_ops%%（%%pybind.cpp:53%%）、%%hccl_npu_comms%%（%%hccl/bindings.cpp:27%%）与 %%hixl_npu_comms%%（%%hixl/bindings.cpp:29%%）。",
        "一次多层搬运的六跳：%%npu_connectors.py:1573%% 把张量、%%kv_cache_pointers%% 与 %%slot_mapping%% 交给 %%lmc_ops.multi_layer_kv_transfer()%%，%%pybind.cpp:67%% 只做转发，落点 %%mem_kernels.cpp:164%% 先准备配置与 UB 预算，最后用一次 %%OpCommand%% 提交（%%mem_kernels.cpp:183%%）。",
        "提交是异步的：回调按值捕获一份配置结构体（%%mem_kernels.cpp:185%%），因此回调里没有对 Python 侧对象的引用——%%mem_kernels.h:78%% 要求调用方自己保住这些张量直到流完成。",
        "UB 预算由 %%compute_multi_layer_ub_params()%% 算（%%utils.cpp:104%%）：UB 大小问平台不写死（%%utils.cpp:117%%），每 token 缓冲按双缓冲算，算完再压到 token 数以内（%%utils.cpp:150%%）。",
        "主机内存要换设备地址，而 ACL 没有这个查询接口，于是自己记一本账：%%RegisteredMemoryRecord%%（%%managed_mem.h:8%%）登记主机指针、设备指针与区间，%%get_device_ptr()%%（%%managed_mem.cpp:393%%）做线性搜索。",
        "两条通道只暴露原始动词：登记内存、建连与批量读写的操作结构体，谁该发、什么时候算完全在 Python 的传输通道里。"
      ],
      points: [
        "**目录名里的 kernels 会误导**：设备侧 AscendC kernel 的实现来自 %%third_party/kvcache-ops%% 子模块，csrc 只到声明（%%mem_kernels.h:9%% 起）；本模块讲的是主机侧包装与绑定。",
        "**三个 .so 不能合并的唯一原因是 ABI**：%%hccl_npu_comms%% 与 %%hixl_npu_comms%% 强制旧 C++ ABI，而 %%c_ops%% 必须链 torch、只能跟着 torch 走默认 ABI。",
        "Python 名与 C++ 名有三处对不上，读代码时容易找不到：%%get_gpu_pci_bus_id%%→%%get_npu_pci_bus_id%%（%%pybind.cpp:89%%）、%%encode_fast_new%%→%%encode_ascend_new%%（%%pybind.cpp:80%%）、%%single_layer_kv_transfer%%→%%single_layer_kv_transfer_wrapper%%（%%pybind.cpp:73%%）。",
        "**主机指针表是 ACL 缺的那个查询**：两个来源共用一张表——自己分配的 pinned 在分配后立刻登记，通道侧则把已经映射好的一对直接记进去。"
      ]
    },
    {
      id: "peripherals", name: "外围组件：四块边角补丁",
      files: ["lmcache_ascend/v1/internal_api_server/", "lmcache_ascend/v1/cache_controller/", "lmcache_ascend/v1/lookup_client/", "lmcache_ascend/serde/", "lmcache_ascend/v1/rpc_utils.py", "lmcache_ascend/v1/system_detection.py"],
      summary: "四块互不 import 的外围小组件，分别补上 HTTP 内存写端点、控制器 RPC 的跨 loop 调度、查找入参归一与哈希回执、昇腾版 cachegen 编解码，彼此只在运行期通过哈希数据相遇。",
      flow: [
        "异步查找客户端在 %%lookup%% 里显式传 %%make_key=False%%（%%lmcache_async_lookup_client.py:40%%），逐段拿到整数哈希后格式化成十六进制记进缓存（%%lmcache_async_lookup_client.py:53%%）。",
        "vLLM 适配器在 %%request_finished%% 里用 %%get_cached_hashes%% 取回哈希，写进 %%return_params%% 的 %%chunk_hashes%%（%%vllm_v1_adapter.py:1178%%）。",
        "上层服务拿哈希 POST 回 %%POST /memory/prefetch%%（%%memory_api.py:95%%），body 只有 %%chunk_hashes%% 与 %%lookup_id%%，缺一个就返回 400（%%memory_api.py:107%%）。",
        "调度器进程没有引擎，于是把同一份 body 按 %%port_start + 1 + i%% 转发到每个 worker 端口（%%memory_api.py:44%%），全部成功时只回第一个 worker 的响应。",
        "worker 把十六进制还原成 %%CacheEngineKey%%、按 %%chunk_size%% 累加出长度，再投到存储管理器的 loop（%%memory_api.py:120%%），端点立刻返回 %%prefetch_started%%（%%memory_api.py:134%%）。",
        "另外三块各自独立：控制器 RPC 投回 %%worker.loop%% 后加锁串行 send/recv（%%worker.py:134%%），同步查找只把 %%token_ids%% 归一成 list（%%lmcache_lookup_client.py:22%%），PAC 在 NPU 上按 256 token 一块编解码（%%pac.py:113%%）。"
      ],
      points: [
        "四块都不在 KV 主存取通路上，各补宿主一处假设：一个 HTTP 面、一个并发 loop 假设、一个入参类型、一个编解码内核；唯一的新类是继承宿主同名类的异步查找客户端（%%lmcache_async_lookup_client.py:19%%）。",
        "%%make_key=False%% 是闭环的硬约束：只有整数哈希能同时通过 msgpack 与十六进制格式化，换成 %%CacheEngineKey%% 两者都不成立（%%lmcache_async_lookup_client.py:40%%）。",
        "四块之间没有一行 import，唯一的交接物就是十六进制哈希字符串，因此查找侧与存取侧必须共用同一份算键实现。",
        "路由挂在模块级 %%app%% 上（%%internal_api_server/__init__.py:18%%），与每个实例自建 app 的宿主版本存在漂移风险，待核；控制器 worker 则装上即生效、无开关（%%lmcache_ascend/__init__.py:893%%）。"
      ]
    },
    {
      id: "patch-infra", name: "文件级源码补丁基础设施",
      files: ["lmcache_ascend/integration/patch/"],
      summary: "唯一在磁盘上改写 vllm_ascend / sglang 源码的基础设施：按版本区间挑补丁、改前先备份，运行时完全不参与。",
      flow: [
        "调用方只有安装脚本与命令行两处：按**字符串模块名**先 %%is_installed(pkg)%% 探包，再 %%import_module%% 拿到补丁器类（apply_patch.py:38、apply_patch.py:41）。",
        "每个补丁器在 %%apply_all()%% 里从安装元数据读版本号，再交给基类的任务循环（base_patcher.py:38）。",
        "版本筛选：%%run_patch_tasks%% 把任务表里的 %%required_versions%% 逐条过区间判断，未命中的任务连目标文件都不去找（base_patcher.py:64）。",
        "命中的任务才定位物理文件、在内存里改行，然后备份原文件并覆盖写回去（base_patcher.py:112）。",
        "逐任务 try/except 吞掉异常继续下一条，最后用 %%success_count == len(enabled_tasks)%% 汇总成败（base_patcher.py:90）。"
      ],
      points: [
        "它和 import 时的**内存改写**是两套机制：这里改的是磁盘源码，只在安装期或手工跑一次，之后**每个进程**都生效（apply_patch.py:18）。",
        "版本区间是**硬编码闭区间**（cacheblend_patch.py:32）；升级后不命中就一个任务都不启用，%%0 == 0%% 仍报成功（base_patcher.py:90）。",
        "改前先把原文件备份到同目录、名字精确到秒（base_patcher.py:112），但全仓库**没有任何 restore 代码**，回滚只能手工拿备份盖回去。",
        "任务函数返回值被丢弃（base_patcher.py:84），「找不到目标」也算成功；幂等不靠版本，靠各补丁器搜特征串，如 %%enable_lmcache%%（sglang_patch.py:101）。"
      ]
    },
    {
      id: "kvcache-ops", name: "设备侧 AscendC 内核",
      files: ["third_party/kvcache-ops/"],
      summary: "设备侧 AscendC 内核：一个 git submodule，csrc 的每一次 kernel 发射最终都落到这里，本基线的子模块目录已被物化。",
      flow: [
        "构建入口在根 %%CMakeLists.txt:36%% 的 %%add_subdirectory(third_party/kvcache-ops)%%；子模块的 %%CMakeLists.txt%% 用 %%file(GLOB KERNEL_FILES ...)%% 收五组源文件编成 %%cache_kernels%%，再由根 %%CMakeLists.txt:105%% 与 %%c_ops%% 一起安装。",
        "kernel 按能力分五类：多层搬运（%%multi_layer/%%：v2、multi_plane、310p、GDN 状态）、单层搬运（%%single_layer/%%：v2 合并与分离版）、%%fused_rope/%%、%%pac_coder/%% 编解码，以及 %%load_and_reshape_flash.cpp%%（%%load_and_reshape_flash.cpp:1%%）。",
        "设备侧入口写成 %%extern \"C\" __global__ __aicore__%%（%%multi_layer_mem_kernels_v2.cpp:242%%），按数据类型与槽位类型展开、再按格式展开出四个变体。",
        "主机侧发射与 tiling 留在同一批 .cpp 里，收在 %%namespace kvcache_ops%%（%%multi_layer_mem_kernels_v2.cpp:283%%），把设备入口按 %%<<<blockDim, nullptr, stream>>>%% 启起来（%%multi_layer_mem_kernels_v2.cpp:290%%）。",
        "格式枚举同时是语义表：%%MERGED_KV%% / %%SEPARATE_KV%% 对应 vLLM 两个版本的页布局，%%MLA_KV%% 与 %%DSA_KV%% 的平面不等长（%%types.h:20%% 起）。"
      ],
      points: [
        "**设备侧用 %%__CCE_AICORE__%% 切编译，主机侧另有一个专用宏 %%ASCEND_AICORE_ARCH%%**——README 自己写明：主机侧执行代码就嵌在同一批 kernels 文件里。",
        "**格式枚举就是一份布局代际表**：%%MERGED_KV%% 是 %%[2, num_blocks, block_size, num_heads, head_dim]%%（vllm0.9.2），%%SEPARATE_KV%% 是 %%tuple(K, V)%%（vllm0.11.0），说明页布局的变化在设备侧是有分支的。",
        "README 把「把参数拆成独立的 op host tiling 结构、改构建步骤」写进了 Future work——**主机与设备同文件是当前形态，不是终态**。"
      ]
    },
    {
      id: "storage-assembly", name: "后端装配与存储管理器",
      files: ["lmcache_ascend/v1/storage_backend/storage_manager.py", "lmcache_ascend/v1/storage_backend/__init__.py", "lmcache_ascend/v1/storage_backend/utils.py"],
      summary: "昇腾版的后端链怎么拼出来、以及插件在宿主的 StorageManager 上打的那几个补丁。",
      flow: [
        "%%_patch_storage_backend_init()%% 把宿主的 %%CreateStorageBackends%% 整个换掉，文件顶部就写明意图：%%Also remove NIXL as it is not supported%%（%%storage_backend/__init__.py:41%%）。",
        "%%dst_device%% 按 worker 类型决定：NPU worker 用 %%npu:{当前设备}%%，否则退回 %%cpu%%（%%storage_backend/__init__.py:59%%）。",
        "装配顺序固定，且先做互斥校验：%%enable_pd%% 不能与 %%use_layerwise%% 共存（%%storage_backend/__init__.py:70%%），%%enable_p2p%% 也不能与 %%use_layerwise%% 共存（%%storage_backend/__init__.py:111%%）——两条都是启动时直接 raise，而不是静默降级。",
        "%%LocalCPUBackend%% 总是要造或复用（%%storage_backend/__init__.py:84%%），因为其它后端要拿它当中转 buffer；%%enable_p2p%% 时它会断言存在（%%storage_backend/__init__.py:121%%）。",
        "%%_patch_storage_manager()%%（%%lmcache_ascend/__init__.py:488%%）再叠五个补丁：%%get%% / %%batched_get%% 加延迟取数代理的写回守卫、%%batched_contains%% 加 PD 接收侧请求租约、%%prefetch_all_done_callback%% 镜像热缓存、两个 %%touch_cache%% 改成 best-effort、以及 %%allocate_and_copy_objects%% 改走复数的 shapes/dtypes。",
        "代理守卫的判据只有一个：%%is_proxy%% 为真就不写回本地 CPU（%%storage_manager.py:196%%、%%storage_manager.py:241%%）——把没有数据的占位对象镜像进热缓存，会污染缓存并挡住真正的落盘。",
        "请求身份靠 %%contextvars%% 从 cache_engine 透传到 storage_manager，而不是改函数签名：%%_current_pd_lookup_id%%（%%storage_manager.py:84%%）与 %%_current_pd_retrieve_id%%（%%storage_manager.py:87%%）。"
      ],
      points: [
        "**「NIXL 被移除」是这一层最值得记住的一条**：上游的跨节点能力建立在 NIXL 上，昇腾直接删掉了它——这正是三条昇腾传输通道存在的原因。",
        "**顺序即性能模型**：装配顺序被代码注释写成 %%The hierarchy is fixed for now%%（%%storage_backend/__init__.py:78%%），改顺序需要改代码。",
        "%%state_store_locations()%%（%%storage_manager.py:108%%）给状态缓存选级：只支持本地 CPU/磁盘，且必须与 %%LocalCPUBackend%% 共用同一个分配器。",
        "%%allocate_and_copy_objects%%（%%storage_manager.py:126%%）改用复数 %%get_shapes()%% / %%get_dtypes()%%（%%storage_manager.py:145%%），因为上游的 %%get_shape()%% 只覆盖第 0 组、会把多组对象分配小。"
      ]
    }
  ],
};

/* ================================================================
   Mooncake Transfer Engine  (L3 KV 传输)
   依据本地 call-path 走读笔记重写
   ================================================================ */
/* ================================================================
   Mooncake Store  (L4 KV 存储)
   依据本地 call-path 走读笔记重写
   ================================================================ */
window.WIKI_DETAILS['mooncake'] = {
  overview: `
## 一句话定位

Mooncake 解决的是一件事：**KVCache 的搬运速度决定了 PD 分离架构的效率**。GPU 显存放不下、CPU/SSD/远端节点的 KV 需要以接近硬件带宽的速度移动，还要在网卡故障、进程崩溃时不停机。

整个仓库其实就是**一个传输内核 + 建在内核上的三层服务**：

~~~text
┌─────────────────────────────────────────────────────────────────┐
│  应用层（不在本仓库）                                              │
│  vLLM MooncakeConnector / SGLang HiCache / LMCache / TensorRT-LLM │
└───────────────▲─────────────────▲──────────────────▲─────────────┘
                │ mooncake.store  │ mooncake.engine  │ mooncake.pg / ep
┌───────────────┴─────────────────┴──────────────────┴─────────────┐
│  服务层（本仓库）                                                  │
│  mooncake-store    分布式 KVCache 池（master 元数据 + 多副本 + SSD）│
│  mooncake-p2p-store checkpoint/大对象 P2P 分发（纯 Go 客户端）      │
│  mooncake-pg       PyTorch 分布式后端（NCCL/Gloo 的容错替代）       │
│  mooncake-ep       MoE dispatch/combine GPU 内核（DeepEP 适配版）  │
├──────────────────────────────────────────────────────────────────┤
│  内核层                                                           │
│  mooncake-transfer-engine (TE)：多协议、拓扑感知、零拷贝传输引擎    │
│    ├─ 13+ 种 Transport：RDMA/TCP/NVMe-oF/CXL/NVLink/EFA/UB/昇腾… │
│    └─ 元数据面：etcd/redis/http + TCP 握手（控制面与数据面分离）    │
├──────────────────────────────────────────────────────────────────┤
│  mooncake-common：配置加载、环境变量、Go cgo 封装的 etcd/K8s 客户端 │
└──────────────────────────────────────────────────────────────────┘
~~~

> 本页把两层一起讲：**上层对象模型（Store）**与**下层字节搬运（Transfer Engine）**。
> 其余三个服务（p2p-store / pg / ep）不在本页范围内。

## 两条贯穿全仓库的设计原则

**原则一：控制面与数据面分离。**这个模式在仓库里反复出现：

| 位置 | 控制面 | 数据面 |
|---|---|---|
| TE 内部 | 元数据（地址 / rkey / 拓扑）走 etcd/redis/http + TCP 握手 | 数据走**单边 RDMA**，对端 CPU 完全不参与收包 |
| Store 内部 | 对象元数据（key → 副本位置）集中在 master | client 与 client 之间用 TE 直传，master 不碰数据 |
| PG 内部 | 建连 / QP 信息经 c10d Store 交换 | 集合通信数据走 TE 的单边 WRITE |
| EP 内部 | QP / rkey 经 PG 的集合通信交换 | token 数据由 GPU 设备侧直接下发 RDMA WQE |

一句话概括：**小消息走控制通道协商出「句柄」，大数据凭句柄直连。**

**原则二：统一抽象 + 可插拔。**数据搬运被抽象成 %%Transport%% 接口（TE 内）、%%TransferSubmitter%%（store 内）、%%c10d::Backend%%（PG 内），具体介质（RDMA / TCP / 文件 / memcpy）都成为可替换实现。

## 模块速查

| 模块 | 定位 | 与 TE 的关系 |
|---|---|---|
| mooncake-transfer-engine | 传输内核：统一接口的多协议数据搬运 | 就是本体 |
| mooncake-store | TE 之上的分布式 KV 服务（master/client 分离） | 数据面完全复用 TE |
| mooncake-p2p-store | 无服务器的对象分发（checkpoint 场景，Go） | cgo 调 TE 的 C API |
| mooncake-pg | %%torch.distributed%% 后端 "mooncake"，容错集合通信 | 直接持有 TE 单例 |
| mooncake-ep | MoE token dispatch/combine 内核，IBGDA + NVLink IPC | 不调 TE 的批量传输接口，但用 TE 的设备侧传输层 |
| mooncake-common | 配置 / 环境变量 / etcd wrapper | 被所有模块复用 |

---

## 本轮补齐的子系统

深度分析页的模块数从 9 个扩到 **23 个**，把之前没覆盖的部分都补上了：

| 子系统 | 一句话 | 为什么值得看 |
|---|---|---|
| %%mooncake-integration%% | Python 绑定层（pybind11 + C ABI） | 上层框架唯一能碰到的面 |
| %%mooncake-common%% | 配置 / 环境变量 / etcd / k8s 封装 | **两条互不相通的配置通道**——「改了配置没生效」的答案就在这里 |
| %%mooncake-p2p-store%% | 无服务器 P2P 对象分发（Go） | 仓库里唯一的 Go 服务，「谁有」写在 etcd 里 |
| %%tent/%%（拆成两个模块） | **第二套、更新的传输引擎** | 与 legacy 并存，两边的 %%Transport%% 抽象**不互认** |
| %%src/transport/*/%% 各具体后端 | 20 个后端、3.9 万行 | 从 RDMA 到 Ascend / CXL / Sunrise 的完整选型面 |
| %%local_ssd%% / %%hf3fs%% / %%storage%% | 具体存储后端 | USRBIO 与内核 VFS 混用、延迟释放与水位驱逐 |
| %%src/device/%% | 加速器设备抽象 | CUDA / HIP / Ascend / Sunrise 的注册与 IPC 差异 |
| %%kv_event%% · %%engram%% · %%spdk%% · %%serialize%% · %%placement%% | 可选特性插件 | 多数是旁路；%%placement%% 在生产里只落地了一半 |
| %%mooncake-pg%% · %%mooncake-ep%% · %%mooncake-reshard%% | 训练与集合通信侧 | 同一份字节能力被搬到分布式训练与专家并行 |
| %%mooncake-rl%% + %%mooncake-conductor%% | RL 示例与公共层 | 示例脚本 + 一份无人 include 的契约层 |

> 逐模块的走读见 [Mooncake 模块代码分析](#/a/mooncake)。

---

## 上层：对象模型（Mooncake Store）

Mooncake Store 是构建在 [Transfer Engine](#/c/mooncake) 之上的**分布式 KVCache 池**：把集群里所有机器的 DRAM 与 SSD 聚合成一个可寻址的键值存储，让任意实例都能取到别处算过的 KV。

> **与 Transfer Engine 的分工**：Store 不自己搬数据，搬运全部交给 TE。Store 负责的是「**这段 KV 在哪、还有没有空间、该淘汰谁**」。
>
> 因此两者的失败模式完全不同：传输层的问题永远是「带宽没打满 / 拓扑选错」；存储层的问题则是「元数据成了瓶颈 / 淘汰把热数据赶走了」。

## 进程模型

~~~text
                 ┌──────────────────────────────┐
                 │ mooncake_master (master.cpp) │  控制面：对象元数据、地址分配器、
                 │  MasterService               │  副本 / 租约 / 淘汰 / 任务 / HA
                 └──────▲───────────▲───────────┘  （不碰数据）
             coro_rpc   │           │  coro_rpc（ylantinglibs，默认 :50051）
      PutStart/PutEnd/GetReplicaList │ MountSegment / FetchTasks / Ping
        ┌──────────────┴──┐     ┌───┴──────────────┐
        │ RealClient 进程  │     │ RealClient 进程   │  数据面：client ↔ client 用 TE 直传
        │ (real_client.cpp)│◄───►│ (每存储节点一个)   │  （本地命中则 memcpy 降级）
        │  持有内存 / SSD   │ TE  │                  │
        └────▲─────────────┘     └──────────────────┘
   unix socket + 共享内存（dummy ↔ real）
        ┌────┴─────────────┐
        │ DummyClient × N   │  推理进程内每个 TP rank 一个轻量代理
        │ (无资源，转发请求)  │  （mooncake.store 的 dummy 模式）
        └──────────────────┘
~~~

## 一个反直觉但关键的设计

**地址分配器跑在 master，内存物理上在 client。**

client 调 %%MountSegment%% 时（%%client_service.cpp:2142%%）先 %%transfer_engine_->registerLocalMemory%% 再上报 master；master 在自己的地址空间里用 CacheLib slab / offset allocator 对 %%(base, size)%% 区间做**纯地址运算的「镜像分配」**（%%segment.cpp:25%%）。

这样 master 就能**全局统筹配额与负载，又不必搬运数据**——控制面与数据面分离原则在这里的体现。

## 三种部署形态

| 形态 | 说明 |
|---|---|
| 嵌入式 | 推理进程内直接链库 |
| dummy-real | N 个 rank 共享同机一个 real client 的网卡与内存 |
| 独立守护进程 | %%mooncake_client%% 专职供内存 |

## 一致性模型：不可变对象 + 租约读

- 对象**不可变**：%%PutStart%%（分配副本）→ 数据直传 → %%PutEnd%%（mark_complete）；%%PutRevoke%% 回滚
- **读保护靠租约**：%%GetReplicaList%% 返回前给对象发 5s 租约，客户端传完校验租约是否过期，防止「读一半被淘汰」

> 这两条合起来回答了一个容易被忽略的问题：**分布式 KV 池需不需要强一致？** Mooncake 的答案是「不需要，但需要租约」——因为 KV 是只写一次、读多次、且可以容忍偶尔重算的数据。
`,
  modules: [
    {
      "id": "store-model",
      "name": "进程模型与三种部署形态",
      "files": [
        "mooncake-store/src/master.cpp",
        "mooncake-store/src/real_client.cpp",
        "mooncake-store/src/dummy_client.cpp",
        "mooncake-store/src/client_service.cpp"
      ],
      "summary": "master 管账，client 管内存",
      "flow": [
        "**master**（%%master.cpp%% / %%MasterService%%）是控制面：对象元数据、地址分配器、副本 / 租约 / 淘汰 / 任务 / HA——**不碰数据**",
        "master 与 client 之间走 **coro_rpc**（ylantinglibs，默认 :50051）",
        "**RealClient**（%%real_client.cpp%%）是数据面：持有真实内存与 SSD，每存储节点一个，client ↔ client 之间用 TE 直传",
        "**DummyClient**：推理进程内每个 TP rank 一个轻量代理，无资源，只转发请求给同机的 real client（unix socket + 共享内存）",
        "控制面 RPC：%%PutStart%% / %%PutEnd%% / %%GetReplicaList%% / %%MountSegment%% / %%FetchTasks%% / %%Ping%%"
      ],
      "points": [
        "**dummy-real 分离解决的是「多 rank 抢资源」问题**：一个节点上 8 个 TP rank 如果各自建 TE 与内存池，网卡与内存都会被重复占用",
        "**共享内存 + unix socket 做 dummy ↔ real 通道**，避免了同机通信走网络栈",
        "「master 不碰数据」这条纪律是整个 Store 能扩展的前提——否则 master 立刻成为带宽瓶颈"
      ]
    },
    {
      "id": "store-alloc",
      "name": "镜像分配：分配器在 master，内存在 client",
      "files": [
        "mooncake-store/src/allocator.cpp",
        "mooncake-store/src/allocation_strategy.cpp",
        "mooncake-store/include/segment.h"
      ],
      "summary": "反直觉设计的实现",
      "flow": [
        "client %%/%%%%MountSegment%%（%%client_service.cpp:2142%%）：先 %%transfer_engine_->registerLocalMemory%% 注册本地内存，再把 %%(base, size)%% 上报 master",
        "master 在自己的地址空间里对这段区间做**纯地址运算的镜像分配**（%%segment.cpp:25%%），底层是 CacheLib slab / offset allocator",
        "%%RandomAllocationStrategy%%（%%allocation_strategy.h:245%%）保证同一对象的副本落在**不同 segment**",
        "副本分配是 **best-effort**：分不到足够副本时降级而非失败"
      ],
      "points": [
        "**「镜像分配」是这套设计的精髓**：master 只维护地址账本，不需要真的持有内存。它因此能做全局统筹，又不会成为数据瓶颈",
        "**副本分到不同 segment 是有意为之**：同一台机器上的多个副本没有容错价值，反而浪费内存",
        "**best-effort 而非强保证**是分布式存储的常见取舍：宁可给一个副本，也不要因为凑不齐副本数而让整个 put 失败"
      ]
    },
    {
      "id": "store-consistency",
      "name": "不可变对象与租约读",
      "files": [
        "mooncake-store/src/master_service.cpp",
        "mooncake-store/include/master_service.h",
        "mooncake-store/src/client_service.cpp"
      ],
      "summary": "为什么不需要强一致，但需要租约",
      "flow": [
        "对象元数据 %%ObjectMetadata%%（%%master_service.h:582%%）：**1024 个哈希分片**，每片一把 %%shared_mutex%%",
        "结构：%%key → {client_id, size, lease_timeout, replicas[]}%%",
        "**当前版本一个对象 = 一段连续缓冲的 N 个副本**（旧版「多 slice 元数据」模型已简化，slice 现在只是传输 / 分配粒度，上限 ≈ 16MB − 16，%%types.h:335%%）",
        "**Put 语义**：%%PutStart%%（分配副本、返回描述符）→ 数据直传 → %%PutEnd%%（mark_complete）。对象不可变；%%PutRevoke%% 回滚",
        "**读保护靠租约**：%%GetReplicaList%% 返回前给对象发 **5s 租约**（%%master_service.cpp:790%%）",
        "客户端传完校验租约是否过期（%%client_service.cpp:815%%）——防止「读一半被淘汰」"
      ],
      "points": [
        "**「不可变 + 租约」是一对组合拳**：不可变让对象无需加锁读写，租约解决「读的过程中被删掉」——两者一起把一致性成本压到最低",
        "**1024 个哈希分片**说明元数据规模是设计时就在意的量级——单一全局锁在这个规模下必然成为瓶颈",
        "5s 这个租约时长是个平衡点：太短会在慢传输时误判过期，太长会拖慢淘汰回收",
        "**为什么 KV 不需要强一致**：KV 是只写一次、读多次、且**读错了可以重算**的数据。这个性质是整个轻量一致性模型成立的前提"
      ]
    },
    {
      "id": "store-put",
      "name": "Put 全链路",
      "files": [
        "mooncake-store/src/real_client.cpp",
        "mooncake-store/src/client_service.cpp",
        "mooncake-store/src/transfer_task.cpp",
        "mooncake-store/src/allocator.cpp"
      ],
      "summary": "控制面两次 RPC，中间夹一段 TE 直传",
      "flow": [
        "%%RealClient::put(key, value, config)%%（%%real_client.cpp:1339%%）",
        "├ %%ClientBufferAllocator::allocate%% + %%memcpy%% + %%split_into_slices%%（≈ 16MB 分段）",
        "└ %%Client::Put(key, slices, config)%%（%%client_service.cpp:1173%%）",
        "　　├ **【控制面 RPC】** %%MasterClient::PutStart(key, slice_lengths, cfg)%%",
        "　　│　　└ master: %%AllocateAndInsertMetadata%% → %%allocation_strategy_->Allocate()%% → %%vector<Replica>{buffer_address, protocol, transport_endpoint}%%",
        "　　├ **【数据面】**对每个 MEMORY 副本 %%TransferWrite(replica, slices)%%",
        "　　│　　└ %%TransferSubmitter::submit(replica, slices, WRITE)%%（%%transfer_task.cpp:488%%）",
        "　　│　　　　├ endpoint 是本机？→ **LOCAL_MEMCPY**（MemcpyWorkerPool 线程池）",
        "　　│　　　　└ 否则 → **TRANSFER_ENGINE**：%%openSegment%% → 每 slice 一个 TransferRequest → %%allocateBatchID%% + %%submitTransfer%%（进入 TE 调用链）",
        "　　│　　└ 失败 → %%PutRevoke%% 回滚该副本",
        "　　└ **【控制面 RPC】** %%MasterClient::PutEnd(key, MEMORY)%%（mark_complete + 续租约）"
      ],
      "points": [
        "**%%AllocatedBuffer::Descriptor{buffer_address, transport_endpoint}%%（%%allocator.cpp:32%%）就是「KV 值地址 → TE target」的桥梁**——store 层与 TE 层的**唯一接缝**",
        "**本地命中降级为 memcpy** 是个务实的优化：同机副本没必要走网络栈",
        "**两次控制面 RPC 夹一次数据面传输**是标准的三段式，TE 只在中间那段被用到",
        "「每 slice 一个 TransferRequest」说明 slice（≈16MB）是 store 与 TE 之间的粒度契约"
      ]
    },
    {
      "id": "store-get",
      "name": "Get 链路与客户端热点缓存",
      "files": [
        "mooncake-store/src/client_service.cpp",
        "mooncake-store/src/local_hot_cache.cpp",
        "mooncake-store/include/client_service.h"
      ],
      "summary": "查询 → 改写描述符 → 拉取 → 校验租约",
      "flow": [
        "%%Query(key)%% 拿副本列表 + 租约",
        "%%FindFirstCompleteReplica%% 挑一个完整副本——**命中本地热点缓存则改写描述符**（%%client_service.h:536%%）",
        "TE **READ** 拉到用户 buffer",
        "校验租约是否仍然有效",
        "**BatchGet** 则一次 %%BatchGetReplicaList%% RPC + 全部传输先提交再统一等待（%%client_service.cpp:994%%）"
      ],
      "points": [
        "**本地热点缓存用 CountMinSketch 做频率准入**——只缓存高频 key，避免冷数据挤占本地内存",
        "**「改写描述符」是热点缓存生效的关键**：命中本地时把远端地址换成 `localhost`，后续 TE 调用自然走了 memcpy 快路径，上层代码完全无感",
        "**BatchGet 先全部提交再统一等待**，把 N 次传输的延迟重叠起来——这是批量场景比单次快得多的原因",
        "读侧与写侧都做了本地优先：写入时同机副本走 memcpy，读取时热点 key 走本地缓存"
      ]
    },
    {
      "id": "store-evict",
      "name": "淘汰与分层存储",
      "files": [
        "mooncake-store/src/master_service.cpp",
        "mooncake-store/include/replica.h",
        "mooncake-store/src/local_ssd/",
        "mooncake-store/src/hf3fs/"
      ],
      "summary": "租约时间近似 LRU，以及 DRAM → SSD 的下沉",
      "flow": [
        "master 后台线程**每 10ms 轮询**",
        "**超高水位（95%）时**用「租约时间近似 LRU」批量淘汰（%%BatchEvict%%，%%master_service.cpp:3512%%）",
        "**hard-pin 永不淘汰**；**soft-pin（VIP 对象）30 分钟保护**",
        "%%offload_on_evict%% 模式下先把副本落 SSD 再删内存",
        "副本三态：%%MEMORY%% / %%DISK%% / %%LOCAL_DISK%%（%%replica.h:32%%）；master 心跳统一调度 offload",
        "SSD 侧三种 backend：file-per-key / bucket 聚合 / offset-log"
      ],
      "points": [
        "**「租约时间近似 LRU」是个聪明的近似**：真正的 LRU 需要维护访问链表，而租约续期本身就隐含了「最近被访问」——复用已有信息，零额外成本",
        "**pin 分两档（hard / soft）**给出了业务表达优先级的空间：系统内部的块用 hard-pin，VIP 前缀用 soft-pin",
        "**95% 才触发淘汰**说明系统倾向于「晚回收、大吞吐」而不是「频繁小回收」",
        "**%%offload_on_evict%% 是分层存储的关键开关**：淘汰不等于删除，可以先下沉到 SSD——这让 DRAM 池的容量问题变成延迟问题"
      ]
    },
    {
      "id": "store-ha",
      "name": "HA：可选，默认关闭",
      "files": [
        "mooncake-store/src/ha/",
        "mooncake-store/src/master_snapshot_manager.cpp",
        "mooncake-store/src/hot_standby_service.cpp",
        "mooncake-store/src/k8s_lease_helper.cpp"
      ],
      "summary": "唯一有状态组件的可用性",
      "flow": [
        "master 是唯一有状态组件，HA 包含三部分：",
        "**leader 选举**：etcd / redis lease（%%MasterServiceSupervisor%%）或 K8s Lease（%%k8s_lease_helper.cpp%%）",
        "**OpLog 回放**：%%REMOVE%% **强制持久化后才执行**（防 stale descriptor）；%%PUT_END%% 尽力而为",
        "**周期快照**：%%master_snapshot_manager.cpp%%",
        "client 崩溃由 **Ping TTL（默认 10s）**检测并卸段清副本；复活后 %%ReMountSegment%% 重挂"
      ],
      "points": [
        "**「REMOVE 强制持久化、PUT_END 尽力而为」这条非对称策略值得细想**：误删一个更早版本的描述符会导致读到脏数据，而漏记一次 PUT_END 最多是少一个副本——两者的后果严重程度不同",
        "**非 HA 模式元数据仅内存态**，说明默认部署假设是「KV 池挂了可以重建，不值得为它付 HA 成本」",
        "Ping TTL 10s 是故障检测的响应时间上界，直接决定节点宕机后多久能重新利用它的内存"
      ]
    },
    {
      "id": "te-core",
      "name": "TransferEngine：门面与四层结构",
      "files": [
        "mooncake-transfer-engine/include/transfer_engine.h",
        "mooncake-transfer-engine/src/transfer_engine.cpp",
        "mooncake-transfer-engine/src/multi_transport.cpp"
      ],
      "summary": "注册内存、提交批量传输、多链路择优",
      "flow": [
        "%%TransferEngine%% 门面（%%include/transfer_engine.h:42%%）对外暴露注册内存、提交传输、查询状态",
        "%%submitTransfer%%（%%src/transfer_engine.cpp:90%%）是用户线程入口",
        "转交 %%MultiTransport::submitTransfer%%（%%multi_transport.cpp:104%%）",
        "%%selectTransport%% 查目标段的 %%protocol%% → 从 %%transport_map_%% 取出对应实现（%%\"rdma\"%% 等）",
        "为每个 request 建 %%TransferTask%% 挂进 %%BatchDesc%%",
        "打包交给具体 Transport 的 %%submitTransferTask%%"
      ],
      "points": [
        "**%%registerLocalMemory%% 是理解整个传输层的第一个概念**：只有注册过的内存才能被网卡直接读写——这也是「KV 必须落在特定 buffer」的根源",
        "门面与实现分离（TransferEngine → MultiTransport → Transport）让新增链路不改上层",
        "批量提交（BatchTransfer）而非单次传输，是为了摊薄每次提交的固定开销——KV 搬运天然是「很多个小块」的形态"
      ]
    },
    {
      "id": "te-structs",
      "name": "三个核心数据结构：Batch → Task → Slice",
      "files": [
        "mooncake-transfer-engine/include/transport/transport.h"
      ],
      "summary": "层层切分，原子计数回填",
      "flow": [
        "**%%BatchDesc%%（:314）**——一个批次，%%allocateBatchID%% 的产物。含 %%task_list%%、%%context%%（给 Transport 挂私有数据）、原子完成标志 %%has_failure%% / %%is_finished%%",
        "**%%TransferTask%%（:281）**——一个 TransferRequest 的全部状态。含 %%request%% 回指、%%slices%%、以及 %%slice_count/success/failed/transferred_bytes%% 原子计数",
        "**%%Slice%%（:104）**——最小传输单元，默认 **64KB**（%%config.h:49%%）。含 %%source_addr%% / %%dest_addr%% / %%length%% / %%opcode%%",
        "Slice 还带 %%peer_nic_path%%（\"对端服务名@对端网卡名\"）——**路径的唯一标识**，以及匿名 union 存协议私有字段（rdma 的 lkey/rkey、ub、nvmeof…）",
        "%%markSuccess()%% / %%markFailed()%% 原子累计回填 task 与 batch 计数"
      ],
      "points": [
        "**一个精妙的细节：%%BatchID%% 就是 %%BatchDesc*%% 指针的整数重解释**（%%transport.h:87-100%% 注释明说这是绕过 map 查找的热路径优化）。代价是**调用方必须保证 batch 生命周期**",
        "三层结构对应三种粒度：batch 是「一次提交」，task 是「一个请求」，slice 是「一次实际 DMA」。性能问题定位到哪一层，决定了下一步查什么",
        "原子计数而非锁，说明完成状态会被用户线程与 worker 线程并发读取"
      ]
    },
    {
      "id": "te-metadata",
      "name": "元数据面：句柄如何发布与寻址",
      "files": [
        "mooncake-transfer-engine/src/transfer_metadata.cpp",
        "mooncake-transfer-engine/src/transfer_metadata_plugin.cpp",
        "mooncake-transfer-engine/include/transfer_metadata.h"
      ],
      "summary": "两个插件组合出「谁在哪、能怎么访问」",
      "flow": [
        "%%TransferMetadata%%（%%transfer_metadata.h:43%%）由两个插件组合而成",
        "**MetadataStoragePlugin**（%%transfer_metadata_plugin.cpp:542%% 工厂按 conn_string 前缀选择 etcd / redis / http）：key 布局 %%mooncake/[cluster_id/]ram/<segment_name>%%",
        "**SocketHandShakePlugin**：固定 TCP + JSON，负责 QP 握手、通知、存活探测",
        "发布的内容是 %%SegmentDesc%%（%%transfer_metadata.h:88%%）：%%protocol%%、%%devices[]%%（网卡 lid/gid）、**对端拓扑副本 priority_matrix**、%%buffers[]%%",
        "%%BufferDesc%%（:52）里的 %%lkey[]/rkey[]%% 是**按本端网卡数量排列的数组**——%%rkey[device_id]%% 的含义是「这块内存在第 device_id 号网卡视角下的远程访问 key」"
      ],
      "points": [
        "**%%rkey[device_id]%% 这个按网卡索引的数组是双向拓扑选路的基石**：只有精确到「用哪张网卡的 key」，才能真正做到 NIC-to-NIC 配对",
        "把**对端拓扑副本**发布到元数据里，是双向选路的另一半（见下一条）",
        "元数据服务是传输层的单点：它挂了不是数据丢，而是新连接建不起来——所以本地缓存兜底很重要",
        "HTTP 选项的存在说明小集群可以零依赖起步，不必先部署 etcd/redis"
      ]
    },
    {
      "id": "te-topology",
      "name": "拓扑感知：双向选网卡",
      "files": [
        "mooncake-transfer-engine/src/topology.cpp",
        "mooncake-transfer-engine/src/transport/rdma_transport/rdma_transport.cpp",
        "mooncake-transfer-engine/src/transport/rdma_transport/worker_pool.cpp"
      ],
      "summary": "TE 的独门设计：两侧各选一次网卡",
      "flow": [
        "**发现**（%%discover%%，%%topology.cpp:473%%）：解析 %%/sys/class/infiniband/*/device%%（realpath 得 PCI bus id、numa_node）、%%cudaDeviceGetPCIBusId%%、NVMe 设备",
        "构建%%存储位置(cpu:N / cuda:i) → {preferred_hca[], avail_hca[]}%% 矩阵",
        "其中 **PCIe 距离 = sysfs realpath 的公共祖先深度**（%%getPciDistance%%，%%topology.cpp:343%%）——不依赖 hwloc",
        "**选择**（%%selectDevice%%，%%topology.cpp:572%%）：%%retry_count==0%% 时在 preferred 集合内随机（或 %%MC_PATH_ROUNDROBIN%% 轮询）做负载均衡；%%retry_count>0%% 时按 preferred→avail 顺序遍历——**重试次数本身驱动降级**",
        "**覆盖**：%%MC_CUSTOM_TOPO_JSON%% / %%installTransport%% / 段描述里的 %%priority_matrix%% 都能覆盖自动发现",
        "**双向选路**：提交时先在**本地**拓扑上为 source 地址选网卡（%%rdma_transport.cpp:475%%）",
        "worker 下发时又在**对端发布的拓扑副本**上为 dest 地址选网卡（%%worker_pool.cpp:116%%）",
        "两侧共同决定 %%peer_nic_path = server@nic%%，再取 %%rkey[device_id]%% 精确配对 NIC-to-NIC"
      ],
      "points": [
        "**选错链路带宽会掉一个数量级**，所以这是性能调优第一个该看的地方",
        "**「重试次数驱动降级」是个很干净的设计**：把「这是第几次尝试」这个信息直接喂给选路函数，不需要额外的状态机",
        "PCIe 距离用 sysfs 公共祖先深度自己算而不引 hwloc，减少了部署依赖",
        "**双向选路的本质是双方各自掌握一半信息**：本端知道自己哪张网卡离显存近，对端知道自己哪张网卡离目标缓冲近，合起来才是最优路径"
      ]
    },
    {
      "id": "te-write",
      "name": "一次 WRITE 的完整调用链（最重要的图）",
      "files": [
        "mooncake-transfer-engine/src/transfer_engine.cpp",
        "mooncake-transfer-engine/src/transport/rdma_transport/rdma_transport.cpp",
        "mooncake-transfer-engine/src/transport/rdma_transport/worker_pool.cpp",
        "mooncake-transfer-engine/src/transport/rdma_transport/rdma_endpoint.cpp"
      ],
      "summary": "从用户线程到 ibv_post_send",
      "flow": [
        "**【用户线程】** %%submitTransfer(batch, requests)%%（%%transfer_engine.cpp:90%%）→ %%MultiTransport::submitTransfer%%（%%multi_transport.cpp:104%%）",
        "→ %%RdmaTransport::submitTransferTask%%（%%rdma_transport.cpp:456%%）",
        "　　├ 对 source 地址做一次 %%selectDevice%% 定位 %%(buffer_id, device_id)%% ← **本地拓扑**",
        "　　├ 按 64KB 切 Slice；首片定位失败则 %%while(retry_cnt<9)%% 换 NIC 重选 ← **拓扑降级**",
        "　　├ %%slice->rdma.source_lkey = buffers[buffer_id].lkey[device_id]%%",
        "　　└ 按 NIC 分组 %%context->submitPostSend(slices)%%",
        "**【worker 线程，每 NIC 若干个、NUMA 绑定】** %%WorkerPool::transferWorker%%（%%worker_pool.cpp:383%%）",
        "　　├ %%performPostSend%%(:173)",
        "　　│　　├ %%endpoint(peer_nic_path)%% ← EndpointStore(SIEVE) 懒建；未连接则 sendHandshake 交换 QP num，双方 doSetupConnection（QP: RESET→INIT→RTR→RTS，%%rdma_endpoint.cpp:545%%）",
        "　　│　　└ %%RdmaEndPoint::submitPostSend%%（%%rdma_endpoint.cpp:455%%）：按 QP 轮转分摊 slice → 构造 %%ibv_send_wr{WRITE, remote_addr, rkey}%% → **%%ibv_post_send%%**",
        "　　└ %%performPollCq%%(:269)：%%ibv_poll_cq%%，%%wc.wr_id%% 就是 %%Slice*%%；成功 → %%markSuccess()%%（整批完成时 CV 通知）；失败 → 删端点 + %%retry_cnt++%% → %%redispatch%%(:344)",
        "**【用户线程轮询】** %%getBatchTransferStatus%%（%%multi_transport.cpp:226%%）：快路径读原子 %%is_finished%%；慢路径逐 task 聚合 slice 计数",
        "**【兜底线程】**每 NIC 一个 %%monitorWorker%%（%%worker_pool.cpp:489%%）：epoll IBV 异步事件，QP_FATAL → 端点失活；DEVICE_FATAL/PORT_ERR → 整卡熔断；每秒尝试自愈"
      ],
      "points": [
        "**数据面的终点是 %%ibv_post_send%%**——单边 RDMA，对端 CPU 零参与。这是「KV 搬运不占对端算力」的物理保证",
        "**握手是懒建的**：第一次真正要用这条 %%peer_nic_path%% 时才建 QP，避免启动时打爆连接数",
        "QP 状态机 RESET→INIT→RTR→RTS 是 RoCE/IB 的标准流程，%%rkey%% 与 %%remote_addr%% 在这里被写入 WR",
        "**查询路径的快慢两分支**很实用：绝大多数时候整批还没完成，但一旦完成，原子读一次就返回，不必遍历所有 task",
        "%%wc.wr_id%% 直接放 %%Slice*%% 指针——又一处「用指针当 ID」的零查找优化，与 %%BatchID%% 同源"
      ]
    },
    {
      "id": "te-fault",
      "name": "容错：三级降级 + 上层整批重试",
      "files": [
        "mooncake-transfer-engine/src/transport/rdma_transport/worker_pool.cpp",
        "mooncake-transfer-engine/src/transfer_engine_py.cpp"
      ],
      "summary": "从换网卡到熔断整卡，四级递进",
      "flow": [
        "**slice 级**：%%poll_cq%% 失败 → %%redispatch%%：%%retry_cnt++%% 驱动 %%selectDevice%% 换网卡重发（上限 9 次）——%%worker_pool.cpp:344%%",
        "**连接级**：QP fatal → endpoint 失活，下次访问懒重建；inactive > 1s 回收——%%worker_pool.cpp:235%%",
        "**设备级**：连续 32 次失败 → 整块网卡 %%context.set_active(false)%% 熔断；%%monitorWorker%% 每秒探测自愈——%%worker_pool.cpp:249,489%%",
        "**batch 级（Python 层）**：整批失败后以 %%advise_retry_cnt=retry%% 重新提交，配合 %%selectDevice%% 语义实现「换本地网卡重来」——%%transfer_engine_py.cpp:395%%"
      ],
      "points": [
        "**四级降级对应四种故障尺度**：坏了一次传输、坏了一条连接、坏了一张网卡、整批失败。每级的恢复策略不同，混在一起处理会导致要么过度反应要么恢复太慢",
        "**%%advise_retry_cnt%% 字段是接口设计的干净之处**：上层把「这是第 N 次重试」的意图通过一个字段传进引擎，引擎据此改变选路策略——不需要新增 API",
        "熔断整卡这个粒度很关键：单次失败可能只是瞬时拥塞，连续 32 次才说明这张卡真有问题",
        "1 秒的自愈探测周期与 1 秒的端点回收形成节奏一致的收敛行为"
      ]
    },
    {
      "id": "te-parallel",
      "name": "并行度设计：四级摊薄单点队列",
      "files": [
        "mooncake-transfer-engine/src/transport/rdma_transport/worker_pool.cpp",
        "mooncake-transfer-engine/src/transport/rdma_transport/rdma_context.cpp"
      ],
      "summary": "为什么大集群下不会卡在一个队列上",
      "flow": [
        "一次批量提交被逐级分组，每一级都摊薄上一级的单点：",
        "**MultiTransport 按协议分组**",
        "**→ RdmaTransport 按 NIC（context）分组**",
        "**→ WorkerPool 按 8 个 shard 分组**（%%hash(target_id, device_id)%% 决定入哪个队列）",
        "**→ EndPoint 按多 QP 均分**（QP / CQ / comp channel 本身也是 round-robin 创建，%%rdma_context.cpp:421%%）",
        "大传输还有**流式水位** %%kSubmitWatermark%%（%%rdma_transport.cpp:558%%）：切块过程中先行下发一部分，控制内存占用",
        "锁粒度普遍是 RWSpinlock + 原子计数，**网络 IO 全部在锁外**"
      ],
      "points": [
        "**四级分组的设计意图是消除「单点队列」**：任何一级只按一个维度分组，都可能在那个维度上退化成串行",
        "8 这个 shard 数是个经验值——太少会有竞争，太多会增加调度开销",
        "**「网络 IO 全部在锁外」是高性能网络代码的铁律**：持锁调用 %%ibv_post_send%% 会把锁竞争直接放大成网络延迟",
        "流式水位解决的是「一次切几万个 slice 会吃掉多少内存」的问题，属于工程细节但影响很大"
      ]
    },
    {
      "id": "te-ascend",
      "name": "昇腾路径：AscendDirectTransport 与 GlobalTE",
      "files": [
        "vllm_ascend/distributed/kv_transfer/utils/mooncake_transfer_engine.py",
        "vllm_ascend/distributed/kv_transfer/utils/utils.py",
        "mooncake-transfer-engine/src/transport/ascend_transport/"
      ],
      "summary": "同一套内核，换一条传输实现",
      "flow": [
        "**%%GlobalTE%% 进程单例**（%%utils/mooncake_transfer_engine.py:26%%）：%%TransferEngine().initialize(hostname, \"P2PHANDSHAKE\", \"ascend\", device_name)%%",
        "**P2PHANDSHAKE**：无 etcd / master，段描述经 TCP 对等交换——PD 分离不需要中心服务",
        "**%%protocol=\"ascend\"%%**：装载 **AscendDirectTransport（ADXL）**，每卡一个引擎，引擎名 %%ip:port%% 即全局地址",
        "**device_name**：PP>1 时传 %%torch.npu.current_device()%%——对应「每卡一引擎」",
        "**P2P 与 Store 复用同一个 TE**：%%MooncakeBackend._setup_store%% 把 %%global_te.get_transfer_engine(...).get_engine()%% 直接传给 %%store.setup(engine=...)%%（%%mooncake_backend.py:122-132%%），避免两套引擎抢资源",
        "注册的内存是 **torch NPU tensor 的 %%data_ptr()%%（HBM 地址）**，没有任何连接器直接调 %%aclrtMemcpy%%",
        "注册前统一处理（%%utils/utils.py%%）：%%collect_storage_merged_register_regions%%(:363-425) 按 %%untyped_storage().data_ptr()%% 分组排序、间隔 ≤4096B 合并",
        "**HCCL 256 区域上限**（%%MAX_HCCL_REGISTER_REGIONS%%，:14）：超限直接报错",
        "**2MB 对齐**断言/向下对齐（%%mooncake_connector.py:2359%%、%%pool_worker.py:739-756%% 的 %%_align_kv_ptrs%%）——昇腾 RDMA 传输的地址对齐要求"
      ],
      "points": [
        "**%%protocol=\"ascend\"%% 是硬编码的**：昇腾栈上所有 mooncake 路径都走这条路，不会回落到 RDMA/RoCE 实现",
        "**HCCL 256 区域上限是最容易踩的坑**：把每层张量合并成大区域不只是性能优化，而是**必须做的**，否则注册直接失败",
        "2MB 对齐同理——是硬约束而非建议。这类「底座强加的约束」正是 infra 层最该被记录下来的知识",
        "**P2P 与 Store 复用同一个 TE** 避免了两个引擎各自抢 QP 与网卡资源，也解释了为什么配置里 TE 相关的参数是全局的",
        "对照 [HIXL](#/c/hixl)：ADXL 是 mooncake 侧的昇腾传输实现，而 HIXL 是 CANN 提供的单边通信库，两者是「框架侧封装」与「底座能力」的关系"
      ]
    },
    {
      "id": "te-ascend-paths",
      "name": "昇腾栈上的四条 KV 传输路径",
      "files": [
        "vllm_ascend/distributed/kv_transfer/kv_p2p/mooncake_connector.py",
        "vllm_ascend/distributed/kv_transfer/kv_p2p/mooncake_layerwise_connector.py",
        "vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/backend/mooncake_backend.py",
        "vllm_ascend/distributed/kv_transfer/kv_p2p/sfa_pd_rd2h/connector.py"
      ],
      "summary": "三条走 mooncake，一条不走",
      "flow": [
        "**① P2P 整体拉取** —— %%MooncakeConnectorV1%%：**D 侧拉**（%%batch_transfer_sync_read%%）；控制面走 ZMQ side channel（P 侧只服务元数据）；PD 分离、跨机，支持 CP/PP/GQA/MLA/Mamba/SWA",
        "**② P2P 逐层推送** —— %%MooncakeLayerwiseConnector%%：**P 侧推**（%%batch_transfer_sync_write%%，每层 forward 完即推）；控制面走 HTTP metaserver（layerwise proxy 的 %%/v1/metaserver%%）；传输与计算重叠",
        "**③ 共享 KV 池** —— %%AscendStoreConnector%%（旧名 MooncakeConnectorStoreV1）：put/get（%%batch_put/get_from/into_multi_buffers%%）；控制面走 mooncake master（coro_rpc）；前缀缓存跨请求跨实例复用、decode offload",
        "**④ SFA RD2H** —— %%SfaRemoteD2HConnector%%：D 侧拉，但走 **memfabric 而非 mooncake**（强制 %%memfabric_hybrid%% 包）；A3 超节点 SFA 模型 decode offload 到 CPU 池",
        "另有 %%MooncakeHybridConnector%%：路径①的混合布局变体（HMA / Mamba / compress 多 KV group），同为 D 侧拉，限制 pcp×dcp=1"
      ],
      "points": [
        "**与 GPU 栈最大的认知差异——先记住这一条**：昇腾版 P2P 是 **Decode 主动拉（READ）**，P 侧只被动服务元数据；GPU 主线版（含 mooncake 自带的 OOT connector）是 **Prefill 主动推（WRITE）**。逐层版则是 P 推，所以三条路径两种方向都有",
        "**「拉」与「推」的取舍**：拉由接收方掌握节奏，更容易做背压与流水线；推实现更简单，但压力在发送侧",
        "**方向语义必须记清楚**（%%transfer_engine_py.cpp%%）：%%batch_transfer_sync_read%% 第 1 组是**本地**地址、第 2 组是**远端**地址；%%write%% 同形参但方向相反",
        "**Store 模式在 A3 800 I/T 系列上还可开 %%ASCEND_ENABLE_USE_FABRIC_MEM=1%% 走统一编址直传**——这是与 HIXL 的 FabricMem 模式对应的能力",
        "第④条路径虽然不走 mooncake，但放在一起看才能理解昇腾栈的完整选型：**三条 mooncake + 一条 memfabric，按场景而非按统一抽象选**"
      ]
    }
  ]
};
/* ================================================================
   NVIDIA Dynamo
   ================================================================ */
window.WIKI_DETAILS.dynamo = {
  overview: `
## 一句话定位

Dynamo 是 NVIDIA 推出的**数据中心级分布式推理服务框架**。它关心的不是「单个实例怎么算得快」，而是「**几百上千张卡怎么协同着把吞吐做上去**」：请求该路由到哪个实例、prefill 与 decode 怎么分池、什么时候该扩容、KV 怎么在实例之间流转。

一句话概括它的分工：**引擎负责算，Dynamo 负责编排算**。

## 四个核心子系统

| 子系统 | 代码位置 | 回答的问题 |
|---|---|---|
| Frontend | %%components/src/dynamo/frontend/%% | 对外协议是什么（OpenAI 兼容 / 自定义） |
| Router | %%lib/kv-router/%% + %%components/src/dynamo/router/%% | 这个请求该发给谁 |
| Planner | %%components/src/dynamo/planner/%% | 现在该起几个 prefill / 几个 decode |
| KVBM | %%lib/kvbm-*/%% | KV 在显存 / 主机 / 盘之间怎么分层 |

## 为什么 Router 是核心

在 PD 分离架构下，路由决策的影响被急剧放大：把请求发给一个**KV 已经缓存了这段前缀**的实例，可以完全跳过 prefill；发给一个没缓存的实例，则要付全额 prefill 成本。因此 Dynamo 的路由是 **KV-aware** 的——路由器需要知道每个实例的 KV 库存。

> %%lib/kv-router/%% 下的 %%indexer%%、%%active_set.rs%%、%%tracking_hash.rs%% 就是这套「KV 感知路由」的实现：它维护近似的前缀索引，在常数时间内估算候选实例的命中长度。

## 技术栈特点

Dynamo 是 **Rust + Python 混合**的：控制面与路由这类对延迟和并发敏感的部分用 Rust（%%lib/%% 下大量 crate），与引擎的对接和业务流程用 Python。这种分层值得注意——**路由在请求关键路径上，用 Python 写会成为瓶颈**。

## 架构分层

~~~text
  客户端
     │  OpenAI / gRPC
  ┌──▼─────────────┐
  │  Frontend      │  协议适配、请求预处理
  └──┬─────────────┘
     │
  ┌──▼─────────────┐        ┌──────────────┐
  │  Router        │◄───────┤ KV Indexer   │  前缀索引 / 实例库存
  │  (Rust)        │        └──────────────┘
  └──┬─────────────┘
     │  选中的实例
  ┌──▼──────┐   KV   ┌──────────┐
  │ Prefill │───────►│  Decode  │
  └─────────┘        └──────────┘
     ▲                     ▲
     └────────┬────────────┘
        ┌─────▼──────┐
        │  Planner   │  依据 SLA 与负载扩缩容
        └────────────┘
~~~
`,
  modules: [
    {
      id: 'frontend', name: 'Frontend：协议入口与请求预处理',
      files: ['components/src/dynamo/frontend/', 'components/src/dynamo/common/', 'deploy/'],
      summary: '对外提供 OpenAI 兼容接口，向内产出统一请求对象',
      flow: [
        'Frontend 暴露 OpenAI 兼容 HTTP 接口与 gRPC 接口',
        '完成鉴权、限流、prompt 模板渲染与 tokenize 前的预处理',
        '产出统一内部请求，交给 Router 决策目标实例',
        '与后端引擎进程通过 %%dynamo-runtime%% 的通信原语交互'
      ],
      points: [
        '**Frontend 不做路由**：它只把请求标准化，路由是独立子系统——这个切分让路由可以独立演进与压测',
        '%%deploy/%% 下同时提供 K8s 与本地部署模板，说明它从设计上就假设运行在编排系统里'
      ]
    },
    {
      id: 'router', name: 'Router：KV-aware 路由决策',
      files: ['lib/kv-router/src/lib.rs', 'lib/kv-router/src/indexer/', 'lib/kv-router/src/active_set.rs', 'lib/kv-router/src/tracking_hash.rs', 'lib/kv-router/src/scheduling/', 'components/src/dynamo/router/'],
      summary: '在候选实例中挑出「KV 命中最多 + 负载最轻」的那个',
      flow: [
        'Indexer 维护每条前缀在各实例上的存在性（近似索引，非精确清单）',
        '%%tracking_hash.rs%% 提供请求前缀的滚动哈希，作为索引的键',
        '新请求到达时，Router 用前缀哈希查询各实例的**预估命中长度**',
        '%%active_set.rs%% 维护当前可用实例集合，过滤掉过载或故障实例',
        '%%scheduling/%% 综合命中长度、队列深度、显存水位等打分，选出目标实例'
      ],
      points: [
        '**近似索引是工程上的必然妥协**：精确维护全局 KV 清单的成本远高于收益，用哈希近似可以拿到大部分命中收益',
        '路由打分是**多目标权衡**：命中率高的实例可能正忙，必须在线权衡「省 prefill」与「排队等待」',
        '%%active_set.rs%% 体现了故障域处理：实例掉线要让路由立刻停止投放，而不是等请求超时'
      ]
    },
    {
      id: 'planner', name: 'Planner：扩缩容与拓扑编排',
      files: ['components/src/dynamo/planner/', 'components/src/dynamo/global_planner/', 'components/src/dynamo/global_router/', 'components/src/dynamo/profiler/'],
      summary: '依据 SLA 与负载决定 prefill / decode 池各起多少实例',
      flow: [
        '%%profiler/%% 先离线测量：给定模型与硬件，不同 batch 下的吞吐 / 延迟曲线',
        'Planner 采集线上指标（QPS、TTFT、TPOT、队列深度）',
        '按 SLA 目标反推所需算力，生成扩缩容决策',
        '%%global_planner%% 做跨集群/跨区域的全局编排，%%global_router%% 负责跨域流量分配'
      ],
      points: [
        '**profiler 是前提**：没有准确的性能模型，自动扩缩容就是瞎猜。这是 Dynamo 相对简单 HPA 方案的核心差异',
        'PD 分离下扩缩容是**二维问题**（prefill 实例数 × decode 实例数），且两者依赖不同的资源特征，必须分别决策',
        '%%squeeze_evolve/%% 说明这里用到了演化类搜索算法来求解配置空间'
      ]
    },
    {
      id: 'kvbm', name: 'KVBM：KV Block Manager 分层管理',
      files: ['lib/kvbm-engine/', 'lib/kvbm-logical/', 'lib/kvbm-physical/', 'lib/kvbm-kernels/', 'lib/kvbm-consolidator/', 'components/src/dynamo/gpu_memory_service/'],
      summary: '显存 / 主机 / 盘三级 KV 块的统一管理',
      flow: [
        '%%kvbm-logical%% 定义逻辑块与生命周期（谁在用、可否复用）',
        '%%kvbm-physical%% 管理各存储层级的物理块与迁移',
        '%%kvbm-kernels%% 提供 GPU 侧搬运与转换 kernel',
        '%%kvbm-consolidator%% 做块整理与合并，%%kvbm-engine%% 对外暴露统一接口',
        '%%gpu_memory_service%% 负责显存侧的分配与对外共享'
      ],
      points: [
        '**逻辑块与物理块分离**是分层缓存能成立的前提：逻辑块可以在层级间搬移而不改变上层引用',
        '%%consolidator%% 解决的是碎片问题——多层缓存反复换入换出必然产生碎片',
        '这套 KVBM 与 %%kv_dc_relay%% 配合，支撑跨数据中心的 KV 中继'
      ]
    },
    {
      id: 'relay', name: 'KV Relay 与跨域中继',
      files: ['components/src/dynamo/kv_dc_relay/', 'lib/kv-router/src/conditional_disagg.rs', 'lib/kv-router/src/recovery/'],
      summary: '跨数据中心 / 跨域的 KV 传递与故障恢复',
      flow: [
        '%%kv_dc_relay%% 在数据中心之间中转 KV，避免跨域直连打满带宽',
        '%%conditional_disagg.rs%% 决定「这次要不要走分离路径」——短 prompt 直接本地算更划算',
        '%%recovery/%% 处理传输中断后的重试与状态修复'
      ],
      points: [
        '**「要不要分离」本身就是个决策问题**：PD 分离不是永远更优，短序列场景下传输开销可能超过收益。%%conditional_disagg%% 就是这个判断点',
        '跨域 KV 传输的带宽成本极高，中继设计的目的通常是压缩与聚合，而不是简单转发'
      ]
    },
    {
      id: 'runtime', name: 'Runtime 与引擎后端绑定',
      files: ['lib/runtime/', 'lib/llm/', 'lib/bindings/python/', 'lib/bindings/c/', 'components/src/dynamo/vllm/', 'components/src/dynamo/sglang/', 'components/src/dynamo/trtllm/'],
      summary: 'Rust 控制面与各推理引擎的对接层',
      flow: [
        '%%lib/runtime%% 提供进程、服务发现与通信原语（含 ZMQ 通道 %%zmq_wire%%）',
        '%%lib/bindings/python%% 把 Rust 能力暴露给 Python 侧',
        '%%components/src/dynamo/vllm%%、%%sglang%%、%%trtllm%% 分别是三个引擎的适配层',
        '适配层负责把引擎的 KV Connector 接进 Dynamo 的 KVBM 与 Router'
      ],
      points: [
        '**多引擎适配层是 Dynamo 的定位体现**：它不绑定自家 TRT-LLM，而是同时支持 vLLM、SGLang',
        '%%lib/tokens/%% 与 %%lib/kv-hashing/%% 说明连 tokenize 与前缀哈希都被下沉到 Rust 侧以保证性能'
      ]
    },
    {
      id: 'tooling', name: '压测与回放工具',
      files: ['components/src/dynamo/mocker/', 'components/src/dynamo/replay/', 'components/src/dynamo/profiler/', 'benchmarks/'],
      summary: '在真实 GPU 之外模拟与回放负载',
      flow: [
        '%%mocker%% 用假引擎模拟实例行为，可在无 GPU 环境下压测控制面',
        '%%replay%% 把线上真实请求轨迹回放，复现问题或验证扩容策略',
        '%%profiler%% 采集性能基线供 Planner 使用'
      ],
      points: [
        '**mocker 的价值被低估**：调度与路由逻辑的正确性可以在无卡环境下高频验证，这是控制面能快速迭代的原因',
        '回放工具是把「线上问题」变成「可复现实验」的关键设施'
      ]
    }
  ],
};

/* ================================================================
   vLLM-Ascend
   ================================================================ */
window.WIKI_DETAILS['vllm-ascend'] = {
  overview: `
## 一句话定位

vLLM-Ascend 是 vLLM 在昇腾 NPU 上的官方插件。它保持 vLLM 的调度与显存管理骨架不变，把**算子、显存、通信、KV 通道**四类硬件相关实现替换成昇腾版本，并额外长出了一整套昇腾特色的 KV 能力：KV Pool、KV P2P、稀疏卸载。

## 它为什么值得单独看

因为它把「**KV 从哪来、往哪去**」这件事做到了罕见的完整度。%%vllm_ascend/distributed/kv_transfer/%% 下的目录结构几乎就是一份 KV 传输/存储的选型清单：

| 目录 | 形态 | 说明 |
|---|---|---|
| %%kv_pool/ascend_store/%% | 远端 KV 池 | 统一接入 MemCache / Mooncake / Yuanrong 后端 |
| %%kv_pool/ucm_connector.py%% | 远端 KV 池 | 接入 UCM 统一缓存管理 |
| %%kv_offload/%% + %%simple_kv_offload/%% | 本地卸载 | NPU ↔ CPU 原生卸载 |
| %%kv_pool/simple_cpu_offload/%% | 本地卸载 | 简化版 CPU 卸载 |
| %%kv_pool/recompute_cpu_offload/%% | 混合 | 卸载 + 重算的混合策略 |
| %%kv_p2p/mooncake_connector.py%% | P2P 传输 | PD 分离的 KV 直传（另有 hybrid / layerwise 两个变体） |
| %%kv_p2p/sfa_pd_rd2h/%% | P2P 传输 | 面向稀疏注意力的 PD 路径 |
| %%sparse_kv_offload/%% | 稀疏卸载 | 只搬被稀疏注意力选中的 KV |

> 一个观察：昇腾侧把 **%%kv_pool%%（池化/卸载）**与 **%%kv_p2p%%（点对点）**明确分成两条线。这个划分很有价值——前者解决「KV 存在哪」，后者解决「KV 从 A 到 B」，两者的失败模式与调优手段完全不同。

## 接口层：引擎与后端之间

%%AscendStoreConnector%% 是这里的枢纽：它实现 vLLM 的 %%KVConnectorBase_V1%% 接口，对内适配引擎，对外通过 %%backend/%% 适配不同 KV 存储产品。这意味着**换 KV 存储后端不需要改引擎**。

## 三条接缝：插件到底改了什么

vLLM-Ascend 不重写宿主的调度器与分页，它只在三个地方接管：

| 接缝 | 手法 | 落点 |
|---|---|---|
| **平台注册** | entry point（%%vllm.platform_plugins%%）被发现，覆写宿主 %%Platform%% 的虚方法 | %%platform.py%% |
| **算子替换** | 名字进 %%CustomOp.register_oot%% 表、或 %%direct_register_custom_op%% 进 %%torch.ops.vllm%% | %%vllm_ascend/ops/%% |
| **猴子补丁** | 宿主没留口子的地方直接换绑函数/类 | %%vllm_ascend/patch/%%（74 文件） |

底层还有一层 **AscendC 内核**（%%csrc/%%，1161 个源文件）：Python 侧的 %%torch.ops._C_ascend%% 最终落到这里的算子实现。
**判断一个插件是否"干净"，就看它改的是宿主的接口还是内部**——这一页两条都用了，比例决定了它的寿命。

## 传输引擎抽象

%%kv_transfer/utils/%% 下并列着 %%mooncake_transfer_engine.py%% 与 %%memfabric_transfer_engine.py%%——传输引擎也是可替换的。在昇腾超节点里，MemFabric 基于灵衢（UnifiedBus）提供内存语义，与 RDMA 路径的编程模型不同。
`,
  modules: [
    {
      id: 'arch', name: '昇腾适配总览：哪一层被替换',
      files: ['vllm_ascend/platform.py', 'vllm_ascend/worker/', 'vllm_ascend/attention/', 'vllm_ascend/ops/'],
      summary: '保持 vLLM 骨架，替换算子/设备/通信实现',
      flow: [
        '%%platform.py%% 向 vLLM 注册昇腾平台，声明设备能力与可用后端',
        '%%worker/%% 实现 NPU Worker，替换 %%GPUWorker%% 的显存与执行细节',
        '%%attention/%% 提供昇腾 attention 后端实现',
        '%%ops/%% 用 CANN / ATB 算子替换 CUDA 算子，必要时做自定义融合'
      ],
      points: [
        '**插件化的收益在这里最明显**：vLLM 的调度、分页、前缀缓存逻辑一行不改就复用了',
        '昇腾的显存管理与 CUDA 不同（HBM 分配、stream 语义），因此 %%worker%% 层的差异比想象中大',
        '%%torch_npu%% 是隐性依赖，很多行为差异最终会归因到它'
      ]
    },
    {
      id: 'kvpool', name: 'KV Pool：kvcache 池化与卸载',
      files: ['vllm_ascend/distributed/kv_transfer/kv_pool/', 'vllm_ascend/kv_offload/cpu_npu.py', 'vllm_ascend/simple_kv_offload/worker.py'],
      summary: '把 KV 从 NPU 显存卸载到 CPU / 远端池，并支持换回',
      flow: [
        '%%kv_pool/%% 下按后端分目录：原生卸载、简单卸载、UCM、AscendStore',
        '%%kv_offload/cpu_npu.py%% 实现 NPU ↔ CPU 的搬运',
        '%%offloading_connector.py%% 实现 KV Connector 接口，把卸载动作挂到调度/执行钩子上',
        '被卸载的 block 在下次命中时换回显存，避免重算'
      ],
      points: [
        '**「卸载」与「重算」是需要对冲的两种策略**：当 KV 搬运比重新 prefill 还慢时，丢弃才是最优解',
        '%%recompute_cpu_offload/%% 正是这个对冲的实现——部分卸载、部分重算',
        'native 与 simple 两条卸载路径并存，通常对应不同的兼容性与性能取舍'
      ]
    },
    {
      id: 'ascendstore', name: 'AscendStoreConnector：统一后端适配',
      files: ['vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/ascend_store_connector.py', 'vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/backend/', 'tests/ut/distributed/ascend_store/test_ascend_store_connector.py'],
      summary: '一个 Connector，多个 KV 存储后端',
      flow: [
        '%%ascend_store_connector.py%% 实现 vLLM %%KVConnectorBase_V1%% 的四个方法',
        '%%backend/%% 下每个后端实现统一的 put/get/lookup 协议',
        '调度阶段返回可命中 token 数；执行阶段发起异步加载与保存',
        '通过配置切换 MemCache / Mooncake / Yuanrong 等后端'
      ],
      points: [
        '**这是「KV 存储中间层」的典型形态**：把 N 个存储产品收敛到 1 个引擎接口，适配成本从 N×M 降到 N+M',
        'vLLM-Ascend 社区还在持续接入新的后端（Yuanrong 支持即以 PR 形式推进），说明这个中间层的边界仍在扩张',
        '配套单测放在 %%tests/ut/distributed/%% 下，读它可以最快理解 connector 的契约'
      ]
    },
    {
      id: 'kvp2p', name: 'KV P2P：PD 分离的直传通道',
      files: ['vllm_ascend/distributed/kv_transfer/kv_p2p/mooncake_connector.py', 'vllm_ascend/distributed/kv_transfer/kv_p2p/mooncake_hybrid_connector.py', 'vllm_ascend/distributed/kv_transfer/kv_p2p/mooncake_layerwise_connector.py'],
      summary: 'prefill 算完直接把 KV 送到 decode 实例',
      flow: [
        '%%base_scheduler.py%% / %%pull_scheduler.py%% 决定什么时候发起传输、拉还是推',
        '%%pull_worker.py%% 在 decode 侧执行实际接收',
        '%%connector.py%% 串起调度决策与传输执行',
        'layerwise 变体（%%mooncake_layerwise_connector.py%%）让传输与逐层计算重叠',
        '%%mooncake_hybrid_connector.py%% 混合多种策略'
      ],
      points: [
        '**pull 与 push 的取舍**：push 由 prefill 主动推，实现简单但可能把压力压到发送侧；pull 由 decode 按自己节奏拉，更容易做流水线',
        'layerwise 是隐藏传输延迟的核心手段——第 0 层算完就能开始传，不必等整个 forward 结束',
        '一个连接器衍生出 base / pull / layerwise / hybrid 四个变体，反映的是**同一问题在不同部署形态下的不同折中**'
      ]
    },
    {
      id: 'sparse', name: '稀疏 KV 卸载与 SFA PD 路径',
      files: ['vllm_ascend/distributed/kv_transfer/sparse_kv_offload/sparse_kv_offload_manager.py', 'vllm_ascend/distributed/kv_transfer/kv_p2p/sfa_pd_rd2h/connector.py', 'vllm_ascend/distributed/kv_transfer/kv_p2p/sfa_pd_rd2h/scheduler.py', 'vllm_ascend/distributed/kv_transfer/kv_p2p/sfa_pd_rd2h/send_thread.py'],
      summary: '只搬运稀疏注意力真正会读到的 KV',
      flow: [
        '稀疏注意力先选出每个 query 需要关注的 KV 位置（top-k / 索引）',
        '%%sparse_kv_offload_manager.py%% 只把被选中的 KV 卸载或传输',
        '%%sfa_pd_rd2h%% 是面向稀疏注意力的 PD 传输路径：由 decode 侧按需拉取所需 KV',
        '%%send_thread.py%% / %%read_thread.py%% 分离收发线程，做异步流水'
      ],
      points: [
        '**这是「KV 格式演进」对传输层的直接冲击**：一旦注意力变稀疏，「全量搬运」就不再必要，搬运量可以降到零头',
        '稀疏卸载让「KV 分层」的粒度从 block 变成 token 子集，元数据复杂度随之上升',
        '%%rd2h%%（read device to host）这个命名点出了数据流向：先下到主机再走网络'
      ]
    },
    {
      id: 'transferengines', name: '传输引擎与内存语义',
      files: ['vllm_ascend/distributed/kv_transfer/utils/mooncake_transfer_engine.py', 'vllm_ascend/distributed/kv_transfer/utils/memfabric_transfer_engine.py', 'vllm_ascend/distributed/kv_transfer/utils/utils.py'],
      summary: 'RDMA 路径与灵衢内存语义路径并列',
      flow: [
        '两个 transfer engine 封装提供一致的 Python 接口',
        '%%mooncake_transfer_engine.py%% 走 RDMA 语义：显式注册内存 + 提交传输',
        '%%memfabric_transfer_engine.py%% 走灵衢（UnifiedBus）内存语义：更接近全局内存访问',
        '上层 connector 不关心底层是哪条路径'
      ],
      points: [
        '**两套编程模型的差异是本质性的**：RDMA 需要显式注册与完成轮询，内存语义可以像访问本地内存一样访问远端——后者会显著简化上层代码',
        '统一接口让「换 fabric」不影响 KV 池与 P2P 逻辑，这是分层的价值',
        '超节点（SuperPod）场景下 UB 的带宽与延迟特征与 RDMA 组网完全不同，调优参数也完全不同'
      ]
    },
    {
      id: 'multi', name: '多连接器聚合',
      files: ['vllm_ascend/distributed/kv_transfer/ascend_multi_connector.py'],
      summary: '同时启用多个 KV 通路',
      flow: [
        '%%ascend_multi_connector.py%% 聚合多个子 connector',
        '按请求特征或层级选择走哪个通路',
        '统一向外暴露单一 KV Connector 接口'
      ],
      points: [
        '**现实部署里往往同时需要池化与 P2P**：热 KV 走直传、冷 KV 走池化，多连接器就是为了表达这种组合',
        '聚合层需要处理子连接器之间的优先级与去重，否则会出现同一份 KV 搬两次'
      ]
    },
    {
      id: 'ops',
      name: '算子替换：五族算子与 attention 后端',
      files: [
        'vllm_ascend/ops/',
        'vllm_ascend/attention/',
        'vllm_ascend/utils.py'
      ],
      summary: '把 CUDA/CANN 算子换成昇腾版本，必要时自定义融合',
      flow: [
        '%%utils.py%% 的 %%CustomOp.register_oot%% 按**类名**登记 27 个替换点',
        '%%direct_register_custom_op%% 把 18 个算子名注册进 %%torch.ops.vllm%%（都带 fake_impl）',
        '%%patch_fused_moe.py%% 换掉 %%FusedMoE%% 这个名字，装上昇腾的 MoERunner',
        'attention 不走注册表：%%platform.py%% 的 %%get_attn_backend_cls%% 直接返回类路径'
      ],
      points: [
        '**昇腾侧 KV cache 布局与 CUDA 不同**：MLA / 稀疏后端是 `(N, block, kv, head)`，CUDA 是 `(2, N, block, kv, head)`',
        '%%_C_ascend%%（本仓库 csrc 自研）、%%torch_npu%%（CANN 随包）、%%cann_ops_transformer%%（独立 CANN 包）三层边界要分清',
        '融合算子的收益按算子语义推导，**仓库内没有实测数字**'
      ]
    },
    {
      id: 'patch',
      name: '猴子补丁层：宿主没留口子的地方',
      files: [
        'vllm_ascend/patch/'
      ],
      summary: '按宿主内部名字直接换绑，附一张"什么时候能删"的登记册',
      flow: [
        '%%patch/__init__.py%% 是一份 1473 行的登记册：61 个文件级条目、88 个编号补丁项',
        '三个入口：platform 包、worker 包、以及按需 import 的三个补丁',
        '每个条目记录它等的上游 PR、以及"什么时候可以删"的条件（79 处 Remove）'
      ],
      points: [
        '**这是插件里最脆的一半**：补丁依赖宿主的函数名、签名与内部属性，宿主重构就会静默失效',
        '最脆弱的一个是 %%Scheduler%% 整体替换——%%schedule()%% 直接抄自 v0.26.0，会静默盖掉宿主后来的改动',
        '生效与否**不可观测**：没有断言、没有日志，出问题表现为"结果不对"而不是报错'
      ]
    },
    {
      id: 'csrc-kernels',
      name: 'AscendC 内核：从 torch.ops 到 kernel',
      files: [
        'csrc/torch_binding.cpp',
        'csrc/attention/',
        'csrc/moe/',
        'csrc/mc2/'
      ],
      summary: '11.6 万行算子源码，一个命名空间 _C_ascend',
      flow: [
        'Python 侧 %%torch.ops._C_ascend.xxx%% 进入 %%torch_binding.cpp%% 的注册表',
        '经 %%*_torch_adpt.h%% 与 %%EXEC_NPU_CMD%% 下发到 aclnn 或 AscendC kernel',
        'kernel 用 %%__global__ __aicore__%% 声明，按 SOC 版本编译，产物落 %%vllm_ascend/_cann_ops_custom/%%'
      ],
      points: [
        '**meta 注册表与真实实现是两份**：非 310P 注册 64 个算子，meta 档 60 个——**缺的 7 个会让 torch.compile 抓不到图**',
        '四族重点：attention（tiling 与片上分级）、moe（路由 + grouped GEMM）、mc2（通信计算融合）、gmm',
        '只细读了少数算子，其余按族归并——**这是一层"按需查"的代码**'
      ]
    }
  ],
};
