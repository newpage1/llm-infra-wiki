/* ============================================================
   联动分析（Cross-component flows）
   ------------------------------------------------------------
   一次操作横跨多个独立项目时，不放在任何单个组件页里 —— 否则
   ① 读者不知道去哪找；② 必然会与它描述的各组件脱节。
   独立成集：/flows 列表，/f/<id> 详情。组件页与流程页双向互链。
   ============================================================ */

window.WIKI_FLOWS = [

  {
    id: 'dsa-shapes',
    title: '一个 KV 对象要变形四次',
    subtitle: 'DSA / 稀疏 KV 下，KV 不再是 (K, V)',
    kind: 'data-shape',
    participants: ['vllm-ascend', 'lmcache-ascend', 'lmcache', 'cann'],
    revisions: [
      { name: 'vllm-ascend', rev: 'af337df' },
      { name: 'LMCache-Ascend', rev: 'e05a757' },
      { name: 'LMCache', rev: 'v0.4.4' },
    ],
    summary: '在普通的 dense 模型里，KV 就是 %%(K, V)%% 两块张量，搬运是直接的地址拷贝。**在 DSA / 稀疏 KV 下这件事变了**：一个稀疏层的 KV 在 forward 时聚合成 **6 项**（A5 下 7 项），而它从模型语义走到磁盘，**要经过四次形状变换**。**每一次变换都是一处可能出错的地方。**',
    reading: [
      '先看**形状变换链**：注意每一层的「块大小」含义都不同——**这是全部复杂度的来源**。',
      '再看 **Store / Retrieve 两条链**：它们不是对称的，Retrieve 要**逐 plane 选各自的 slot mapping**。',
      '最后看 **六处风险**——这一节的密度最高，且都标注了是「已确认」还是「推断」。',
    ],
    diagram: `<svg viewBox="0 0 1200 620" class="diagram flow-svg" role="img"
     aria-label="DSA 场景下一个 KV 对象经过的四次形状变换">
  <defs>
    <marker id="d1" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,1 L9,5 L0,9 z" fill="#d5c7b0"/>
    </marker>
    <clipPath id="c1"><rect x="20" y="20" width="1160" height="70" rx="10"/></clipPath>
    <clipPath id="c2"><rect x="20" y="150" width="1160" height="80" rx="10"/></clipPath>
    <clipPath id="c3"><rect x="20" y="290" width="1160" height="96" rx="10"/></clipPath>
    <clipPath id="c4"><rect x="20" y="446" width="1160" height="80" rx="10"/></clipPath>
    <clipPath id="c5"><rect x="20" y="586" width="1160" height="1" rx="0"/></clipPath>
  </defs>

  <!-- ① 逻辑 token 空间 -->
  <rect x="20" y="20" width="1160" height="70" rx="10" fill="var(--l2)" fill-opacity=".05" stroke="var(--line)"/>
  <rect x="20" y="20" width="1160" height="3" fill="var(--l2)" clip-path="url(#c1)"/>
  <text x="44" y="46" class="t-band" fill="var(--l2)">① 逻辑 token 空间 · scheduler 视角</text>
  <text x="44" y="72" class="t-mono" style="font-size:11.5px">block_size = 16（原始 token 数）　——　这一层的块大小是<tspan font-weight="600">模型语义</tspan>，不是存储语义</text>

  <line x1="600" y1="90" x2="600" y2="126" class="t-line" marker-end="url(#d1)"/>
  <rect x="470" y="98" width="260" height="20" rx="4" fill="var(--bg)"/>
  <text x="600" y="112" class="t-mono-c" text-anchor="middle">压缩：compress_ratio</text>

  <!-- ② 物理存储行 -->
  <rect x="20" y="150" width="1160" height="80" rx="10" fill="var(--l4)" fill-opacity=".05" stroke="var(--line)"/>
  <rect x="20" y="150" width="1160" height="3" fill="var(--l4)" clip-path="url(#c2)"/>
  <text x="44" y="176" class="t-band" fill="var(--l4)">② 物理存储行 · NPU cache tensor 视角</text>
  <text x="44" y="202" class="t-mono" style="font-size:11.5px">storage_block_size = block_size / compress_ratio</text>
  <text x="44" y="220" class="t-mono" style="font-size:11.5px;fill:var(--l4)">C4：每 4 个原始 token 一行　　C128：每 128 个原始 token 一行</text>

  <line x1="600" y1="230" x2="600" y2="266" class="t-line" marker-end="url(#d1)"/>
  <rect x="452" y="238" width="296" height="20" rx="4" fill="var(--bg)"/>
  <text x="600" y="252" class="t-mono-c" text-anchor="middle">分配：一维 int8 backing</text>

  <!-- ③ 多 plane view -->
  <rect x="20" y="290" width="1160" height="96" rx="10" fill="var(--l1)" fill-opacity=".04" stroke="var(--line)"/>
  <rect x="20" y="290" width="1160" height="3" fill="var(--l1)" clip-path="url(#c3)"/>
  <text x="44" y="316" class="t-band" fill="var(--l1)">③ typed / as-strided 多 plane view · 同一块 backing</text>
  <text x="44" y="342" class="t-mono" style="font-size:11.5px">主压缩 KV(FP8) · SWA KV · indexer K(FP8) · indexer scale(FP32) · compressor state</text>
  <text x="44" y="362" class="t-mono" style="font-size:11.5px;fill:var(--l1)">不同 dtype · 不同 block size · 不同压缩比 · 不同 slot stream　——　<tspan font-weight="600">不能共用一条 slot mapping</tspan></text>
  <text x="44" y="380" class="t-mono" style="font-size:11px;fill:var(--muted)">A5 下每稀疏层 7 项（含 full packed view）；block 间有 padding，须用真实 block_stride</text>

  <line x1="600" y1="386" x2="600" y2="422" class="t-line" marker-end="url(#d1)"/>
  <rect x="440" y="394" width="320" height="20" rx="4" fill="var(--bg)"/>
  <text x="600" y="408" class="t-mono-c" text-anchor="middle">D2H：逐 transfer group、逐 plane 循环</text>

  <!-- ④ uint8 packed row -->
  <rect x="20" y="446" width="1160" height="80" rx="10" fill="var(--l3)" fill-opacity=".05" stroke="var(--line)"/>
  <rect x="20" y="446" width="1160" height="3" fill="var(--l3)" clip-path="url(#c4)"/>
  <text x="44" y="472" class="t-band" fill="var(--l3)">④ uint8 packed LMCache row · LMCache 视角</text>
  <text x="44" y="498" class="t-mono" style="font-size:11.5px">异质 plane 被压成<tspan font-weight="600">连续 byte chunk + metadata</tspan>，装进 multi-group MemoryObj</text>
  <text x="44" y="516" class="t-mono" style="font-size:11.5px;fill:var(--l3)">P2P 场景下这里可能是 <tspan font-weight="600">ProxyMemoryObj</tspan>（只带元数据，延迟到 batched_to_gpu 才取数）</text>

  <line x1="600" y1="526" x2="600" y2="562" class="t-line" marker-end="url(#d1)"/>
  <rect x="500" y="534" width="200" height="20" rx="4" fill="var(--bg)"/>
  <text x="600" y="548" class="t-mono-c" text-anchor="middle">落存</text>

  <!-- ⑤ 磁盘 -->
  <rect x="20" y="586" width="1160" height="46" rx="10" fill="var(--line)" fill-opacity=".2" stroke="var(--line)"/>
  <text x="600" y="614" class="t-title-sm" text-anchor="middle">SSD raw bytes（LocalDisk / P2P / 远端）</text>
</svg>`,
    legs: [
      {
        id: 'shapes',
        layer: 'engine',
        title: '四次形状变换',
        direction: 'out',
        steps: [
          { t: '① 逻辑 token 空间', a: 'vllm/v1/kv_cache_interface.py:106', note: '%%block_size = 16%%（原始 token 数）。**这一层的块大小是模型语义，不是存储语义**' },
          { t: '② 物理存储行', a: 'vllm/v1/kv_cache_interface.py:395', note: '★ **C4 每 4 个原始 token 一行，C128 每 128 个一行。** 逻辑 token 数与物理行数从此分离' },
          { t: '③ typed / as-strided 多 plane view', a: 'vllm_ascend/worker/model_runner_v1.py:4199', note: '★ 先申请一维 int8 backing，再构造 typed view。**不同 dtype（FP8/FP32）+ 不同块大小 + 不同压缩比**' },
          { t: '④ uint8 packed LMCache row', a: 'lmcache_ascend/v1/npu_connector/npu_connectors.py:768', note: '★ 异质 plane 被压成**连续 byte chunk + metadata**，装进 multi-group MemoryObj' },
          { t: '⑤ SSD raw bytes', a: 'lmcache/v1/storage_backend/local_disk_backend.py:333', note: '到这一层已经没有形状，只有字节' },
        ],
        html: `### 这次变化的本质

原始分析的最终判断值得直接引用：

> 「DSV4/GLM DSA KV 的本质变化不是『多一个 indexer tensor』这么简单，
> 而是从**单一同构 KV page** 变成：
> ~~~
> 多个独立 paging plane
> + 不同 dtype
> + 不同 block size
> + 不同压缩比
> + 不同 slot stream
> + 运行中 compressor state
> + 可能重叠的 backing view
> ~~~」

**关键在第 ② 步**：%storage_block_size = block_size / compress_ratio%。
scheduler 说「这段有 16 个 token」，但 NPU cache 里**只占 1 行**（若是 C16）。
于是——

> **不同 plane 不能共用一条按 token 展开的 slot mapping。**

这句话是后面所有复杂度的根。**LMCache 的传统 connector 假设"一段 token 对应一段连续存储"，
而 DSA 打破了这个假设。**`,
      },
      {
        id: 'store',
        layer: 'engine',
        title: 'Store 链',
        direction: 'out',
        steps: [
          { t: '模型 forward', a: 'vllm/models/deepseek_v4/compressor.py:415', note: 'SWA scatter → compressor 产出 C4/C128 row + compressed slot → main/indexer quant scatter' },
          { t: 'LMCache connector', a: 'lmcache_ascend/integration/vllm/multi_group_vllm_adapter.py:523', note: '每 request 保留 %%block_ids_by_group%% → 生成 %%slot_mappings_by_group%% → **过滤 -1** → 按 layer layout 建 transfer groups' },
          { t: 'LMCacheEngine.store', a: 'lmcache_ascend/v1/cache_engine.py:916', note: '按 token hash 切 logical chunk → CPU allocator 申请 **multi-group MemoryObj**' },
          { t: 'NPU connector D2H', a: 'lmcache_ascend/v1/npu_connector/npu_connectors.py:1827', note: '★ **对每个 transfer group、每个 plane**：paged slot gather → 写入 uint8 packed LMCache row' },
          { t: 'StorageManager.batched_put', a: 'lmcache/v1/storage_backend/storage_manager.py:386', note: 'LocalCPU 热缓存 → 可异步复制到 SSD / P2P / 远端' },
        ],
        html: `**注意第 4 步是两重循环**：transfer group × plane。

**为什么必须逐 plane 处理**：因为每个 plane 的压缩比不同，
**slot mapping 也就不同**——主 KV 可能按 C128 存，SWA 按 C4 存。
**用一条 slot mapping 覆盖全部 plane 会写错位置。**

**第 2 步的「过滤 -1」**：与本站《LMCache-Ascend · NPUConnector》
里引用的那句注释（%%slot_mapping%% 中前缀部分是 -1）是同一件事——
**这里的 -1 代表"该位置不需要保存"**，过滤后生成 dense slots。`,
      },
      {
        id: 'retrieve',
        layer: 'engine',
        title: 'Retrieve 链：与 Store 不对称',
        direction: 'in',
        steps: [
          { t: 'TokenDatabase 查找完整 chunk', a: 'lmcache/v1/token_database.py:368' },
          { t: 'CPU 命中，或 SSD raw bytes 读回', a: 'lmcache/v1/storage_backend/storage_manager.py:482', note: '读回的仍是 **multi-group MemoryObj**' },
          { t: 'P2P 场景可能先得到 ProxyMemoryObj', a: 'lmcache_ascend/v1/proxy_memory_obj.py:37', note: '★ **只带元数据，延迟到 %%batched_to_gpu%% 才真正取数**——与散射流水化' },
          { t: 'NPU connector H2D', a: 'lmcache_ascend/v1/npu_connector/npu_connectors.py:1514', note: '★ **每 plane 选择自己的 slot mapping** → uint8 packed row 解包 → scatter 回各自 paged cache' },
          { t: 'attention 读取', a: 'vllm_ascend/attention/utils.py:451', note: '从恢复后的 SWA / main / indexer page 读取' },
        ],
        html: `### 不对称的地方

**Store 是「逐 plane 打包成一个 row」，Retrieve 是「逐 plane 解包回各自的 page」。**
看起来是对称的，但**Retrieve 多了一条路径**：

> %%P2P 时可能先获得 ProxyMemoryObj%%

**本站《LMCache-Ascend · MemoryManager / KvFormat》里分析过这个延迟求值对象。**
它在这里的作用是：把「取数」推迟到 %%batched_to_gpu%%，**让远端取数与 NPU 散射重叠**。

**所以 DSA 场景下这个对象的价值更大**——因为 plane 数量多了，
**逐 plane 的取数如果串行执行会很慢**，而延迟求值让它们可以流水化。

**这是两处分析在同一个对象上会合的第二个例子**
（第一个是 %%NPUConnector._remote_batched_to_gpu%% 与 %%ProxyMemoryObj%% 的关系）。`,
      },
      {
        id: 'risks',
        layer: 'engine',
        title: '六处风险',
        direction: 'both',
        steps: [
          { t: '主线 / 分支兼容断层', a: 'MERGE-PROVENANCE.md:13', note: '★ **DSV4 完整功能在 %%origin/dsv4_support_045%%，尚未并入 main。** 部署必须用成套版本，不能任意拼接最新四个仓库' },
          { t: 'state cache 不能按普通 token KV 处理', a: 'lmcache_ascend/integration/vllm/multi_group_vllm_adapter.py:491', note: 'state 只是未完整压缩组的 accumulator；跨非整 chunk 边界恢复需额外定义 4 项协议' },
          { t: 'shared backing 与 overlapping view', a: 'vllm_ascend/worker/model_runner_v1.py:4239', note: '★ **不能按 Python tuple 元素数算外存大小**——同 storage 同 data_ptr、同 storage 不同 data_ptr、不同 storage 是三种情况' },
          { t: 'page padding', a: 'vllm_ascend/worker/model_runner_v1.py:4453', note: '★ NPU cache 可能是 %%as_strided%% view；逐 block 拷贝**必须用真实 %%block_stride%%**，否则下一 block 读错地址' },
          { t: 'Python/C++ enum 注释不一致', a: 'third_party/kvcache-ops/kernels/types.h:34', note: 'Python 定义 %%DSA_C8_KV=5%% / %%MULTI_PLANE_KV=6%%，但锁定的 C++ %%types.h%% 只到 %%DSA_KV=4%%' },
          { t: '未做 NPU runtime 验证', a: '—', note: '静态调用链与布局核对已完成，**但无 Ascend NPU/CANN 运行环境**，未跑 round-trip / 精度 / 带宽测试。**这条是作者的验证声明，没有对应的代码路径，因此不给代码锚点。**' },
        ],
        html: `### 逐条说明它们的性质

原始分析对每条都标了**是"已确认事实"还是"推断"**，这一点很规范。我按其口径复述：

| # | 性质 | 说明 |
|---|---|---|
| ① 分支断层 | **已确认事实** | DSV4 完整实现不在 main 上。**这是部署前最需要确认的版本事实** |
| ② state cache | **设计缺口** | 当前选择 %%discard_partial_chunks=True%% 来回避——**是"绕开"而不是"解决"** |
| ③ overlapping view | **已确认陷阱** | 三种情况（同 storage 同/不同 data_ptr、不同 storage）要分别处理 |
| ④ page padding | **已确认陷阱** | 把逻辑 %%numel()%% 当连续跨度会**静默读错地址** |
| ⑤ enum 不一致 | **一致性问题，非运行时故障** | 新路径不走 legacy %%switch%%，所以当前无害；**但回落到 legacy 就有风险** |
| ⑥ 无 runtime 验证 | **明确的验证缺口** | 作者诚实声明了 |

### 最值得记的两条

**第四条（page padding）** 是典型的**静默错误**：
%%as_strided%% view 的逻辑 %%numel()%% 小于 backing 的实际跨度，
**把前者当后者用不会报错，只会读到下一个 block 的数据。**
这与本站反复出现的主题（**错误不报错，只是结果不对**）是同一类。

**第五条（enum 不一致）** 展示了另一件事：
**代码注释说"必须与 C++ 一致"，但实际上没一致，而当前恰好因为不走那条路而无害。**
这种"靠调用路径绕开的不一致"是**最脆弱的**——一次重构就会暴露。

### 作者自己的验证声明

> "本次完成了代码更新、静态调用链与布局核对，但当前机器没有对应 Ascend NPU/CANN
> 运行环境，因此没有执行 DSV4 round-trip、精度或带宽测试。"

**这句话应当被读者当真。** 本文的结论全部是**静态分析**得出的，
而非实测——**引用时不应说成"验证过"。**`,
      },
    ],
    seams: [
      {
        name: 'block_size → storage_block_size',
        from: '调度语义',
        to: '存储语义',
        at: 'vLLM-Ascend 的 cache spec',
        why: '★ **全部复杂度的源头**：逻辑 token 数与物理行数从此分离，slot mapping 不再唯一',
      },
      {
        name: 'slot_mappings_by_group',
        from: 'vLLM',
        to: 'LMCache connector',
        at: 'integration/vllm/vllm_v1_adapter.py',
        why: '每 group 一套 slot mapping；过滤 -1 后生成 dense slots',
      },
      {
        name: 'uint8 packed row',
        from: 'NPU cache',
        to: 'LMCache MemoryObj',
        at: 'v1/npu_connector/npu_connectors.py',
        why: '异质 plane 被压成连续字节 + metadata —— **LMCache 侧只看字节，不看 plane 语义**',
      },
      {
        name: 'ProxyMemoryObj',
        from: 'LMCache',
        to: 'P2P / 远端',
        at: 'v1/proxy_memory_obj.py',
        why: '延迟求值：plane 越多，流水化的收益越大',
      },
    ],
    related: ['vllm-ascend', 'lmcache-ascend', 'lmcache', 'cann', 'ascend-store-connector'],
  },

  {
    id: 'kv-paths',
    title: 'KV 回落的三条通路',
    subtitle: '同一个昇腾栈上，KV 可以走三条不同的路',
    kind: 'comparison',
    participants: ['lmcache-ascend', 'ascend-store-connector', 'mooncake', 'hixl', 'vllm-ascend'],
    revisions: [
      { name: 'vllm-ascend', rev: 'af337df' },
      { name: 'LMCache-Ascend', rev: '1b6e3a4' },
      { name: 'Mooncake', rev: '408b831' },
    ],
    summary: 'KV 在昇腾栈上不止一条路。**路径 A** 用 LMCache-Ascend 做实例内的多级缓存与 P2P/PD；**路径 B** 用 AscendStoreConnector 把 KV 送进 Mooncake 这个分布式对象存储；**路径 C** 是把两者接起来——LMCache 管近端，Mooncake 管远端。**三条路的强项在不同层次，所以"A 比 B 好"这个问法本身不成立。**',
    reading: [
      '先看**三通路对照图**：注意三条路在「vLLM 接入」这一层是同一个契约，分野在下面。',
      '再看**逐维度对照**——管理 / 传输 / 存储三段，每段给出「谁更强 + 为什么」。',
      '最后看**共同短板**：P/D 的 TP 数不同这件事，**三条路目前都不成立**。',
    ],
    diagram: `<svg viewBox="0 0 1200 600" class="diagram flow-svg" role="img"
     aria-label="昇腾栈上 KV 回落的三条通路">
  <defs>
    <marker id="fa" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto">
      <path d="M0,1 L9,5 L0,9 z" fill="#d5c7b0"/>
    </marker>
    <clipPath id="f1"><rect x="20" y="20" width="376" height="90" rx="10"/></clipPath>
    <clipPath id="f2"><rect x="412" y="20" width="376" height="90" rx="10"/></clipPath>
    <clipPath id="f3"><rect x="804" y="20" width="376" height="90" rx="10"/></clipPath>
  </defs>

  <!-- 三条通路标题 -->
  <rect x="20" y="20" width="376" height="90" rx="10" fill="var(--l2)" fill-opacity=".05" stroke="var(--line)"/>
  <rect x="20" y="20" width="376" height="3" fill="var(--l2)" clip-path="url(#f1)"/>
  <text x="208" y="48" class="t-band" fill="var(--l2)" text-anchor="middle">PATH A</text>
  <text x="208" y="74" class="t-title-sm" text-anchor="middle">LMCache-Ascend 独立</text>
  <text x="208" y="96" class="t-mono" text-anchor="middle">推理实例内的多级缓存 + P2P + PD</text>

  <rect x="412" y="20" width="376" height="90" rx="10" fill="var(--l4)" fill-opacity=".05" stroke="var(--line)"/>
  <rect x="412" y="20" width="376" height="3" fill="var(--l4)" clip-path="url(#f2)"/>
  <text x="600" y="48" class="t-band" fill="var(--l4)" text-anchor="middle">PATH B</text>
  <text x="600" y="74" class="t-title-sm" text-anchor="middle">AscendStore + Mooncake</text>
  <text x="600" y="96" class="t-mono" text-anchor="middle">外部分布式对象存储</text>

  <rect x="804" y="20" width="376" height="90" rx="10" fill="var(--l3)" fill-opacity=".06" stroke="var(--line)"/>
  <rect x="804" y="20" width="376" height="3" fill="var(--l3)" clip-path="url(#f3)"/>
  <text x="992" y="48" class="t-band" fill="var(--l3)" text-anchor="middle">PATH C</text>
  <text x="992" y="74" class="t-title-sm" text-anchor="middle">组合：A 管近端，B 管远端</text>
  <text x="992" y="96" class="t-mono" text-anchor="middle">mooncakestore:// adapter</text>

  <!-- 共同的入口 -->
  <rect x="20" y="146" width="1160" height="56" rx="8" fill="var(--panel)" stroke="var(--line)"/>
  <text x="600" y="180" class="t-title-sm" text-anchor="middle">vLLM-Ascend · 同一个请求，同一个 KVConnectorBase_V1 契约</text>
  <path d="M208,202 V232" class="t-line" marker-end="url(#fa)"/>
  <path d="M600,202 V232" class="t-line" marker-end="url(#fa)"/>
  <path d="M992,202 V232" class="t-line" marker-end="url(#fa)"/>

  <!-- A 列 -->
  <rect x="20" y="240" width="376" height="48" rx="6" fill="var(--panel)" stroke="var(--l2)" stroke-opacity=".4"/>
  <text x="208" y="262" class="t-mono" text-anchor="middle" style="fill:var(--l2)">LMCacheConnectorV1</text>
  <text x="208" y="280" class="t-mono" text-anchor="middle">→ AscendLMCacheEngine</text>
  <rect x="20" y="298" width="376" height="48" rx="6" fill="var(--panel)" stroke="var(--line)"/>
  <text x="208" y="320" class="t-mono" text-anchor="middle">StorageManager</text>
  <text x="208" y="338" class="t-mono" text-anchor="middle">LocalCPU / Disk / Remote</text>
  <rect x="20" y="356" width="182" height="48" rx="6" fill="var(--panel)" stroke="var(--line)"/>
  <text x="111" y="378" class="t-mono" text-anchor="middle">P2PBackend</text>
  <text x="111" y="396" class="t-mono" text-anchor="middle">邻实例直读</text>
  <rect x="214" y="356" width="182" height="48" rx="6" fill="var(--panel)" stroke="var(--line)"/>
  <text x="305" y="378" class="t-mono" text-anchor="middle">PDBackend</text>
  <text x="305" y="396" class="t-mono" text-anchor="middle">HCCL / HIXL</text>
  <text x="208" y="432" class="t-mono" text-anchor="middle" style="fill:var(--muted)">控制面：嵌入模式无独立控制面；MP 模式有 mp_coordinator</text>
  <text x="208" y="456" class="t-mono" text-anchor="middle" style="fill:var(--l2)">强项：跨 tier 前缀 · pin/prefetch · serde</text>

  <!-- B 列 -->
  <rect x="412" y="240" width="376" height="48" rx="6" fill="var(--panel)" stroke="var(--l4)" stroke-opacity=".4"/>
  <text x="600" y="262" class="t-mono" text-anchor="middle" style="fill:var(--l4)">AscendStoreConnector</text>
  <text x="600" y="280" class="t-mono" text-anchor="middle">→ PoolWorker → Mooncake Client</text>
  <rect x="412" y="298" width="376" height="48" rx="6" fill="var(--panel)" stroke="var(--line)"/>
  <text x="600" y="320" class="t-mono" text-anchor="middle">Mooncake Master</text>
  <text x="600" y="338" class="t-mono" text-anchor="middle">key → Replica · 配额 · 淘汰</text>
  <rect x="412" y="356" width="376" height="48" rx="6" fill="var(--panel)" stroke="var(--line)"/>
  <text x="600" y="378" class="t-mono" text-anchor="middle">TransferEngine · Ascend transport</text>
  <text x="600" y="396" class="t-mono" text-anchor="middle">multi-buffer / GVA copy</text>
  <text x="600" y="432" class="t-mono" text-anchor="middle" style="fill:var(--muted)">控制面：Master + leader/oplog/snapshot</text>
  <text x="600" y="456" class="t-mono" text-anchor="middle" style="fill:var(--l4)">强项：对象 · 副本 · HA · 多存储节点</text>

  <!-- C 列 -->
  <rect x="804" y="240" width="376" height="48" rx="6" fill="var(--panel)" stroke="var(--l3)" stroke-opacity=".45"/>
  <text x="992" y="262" class="t-mono" text-anchor="middle" style="fill:var(--l3)">LMCache 全套（= 路径 A）</text>
  <text x="992" y="280" class="t-mono" text-anchor="middle">负责 prefix / tier / P2P / PD</text>
  <rect x="804" y="298" width="376" height="48" rx="6" fill="var(--panel)" stroke="var(--line)"/>
  <text x="992" y="320" class="t-mono" text-anchor="middle">mooncakestore:// 远端 connector</text>
  <text x="992" y="338" class="t-mono" text-anchor="middle">LMCache 的一个 RemoteBackend</text>
  <rect x="804" y="356" width="376" height="48" rx="6" fill="var(--panel)" stroke="var(--line)"/>
  <text x="992" y="378" class="t-mono" text-anchor="middle">Mooncake（= 路径 B 的存储侧）</text>
  <text x="992" y="396" class="t-mono" text-anchor="middle">负责远端 object / replica / HA</text>
  <text x="992" y="432" class="t-mono" text-anchor="middle" style="fill:var(--muted)">两层各自的 eviction 会叠加</text>
  <text x="992" y="456" class="t-mono" text-anchor="middle" style="fill:var(--l3)">尚未验证：Ascend 直连 · serde · 错误传播</text>

  <!-- 共同短板 -->
  <rect x="20" y="494" width="1160" height="86" rx="10"
        fill="var(--l1)" fill-opacity=".05" stroke="var(--l1)" stroke-opacity=".35"/>
  <text x="44" y="522" class="t-band" fill="var(--l1)">三条通路共同的短板</text>
  <text x="44" y="550" class="t-mono" style="font-size:11.5px">P/D 的 TP 数不同时：A 按同 tp_rank 连接、搬 raw bytes；B 有 dense GQA reshard 代码但接线未合入；</text>
  <text x="44" y="570" class="t-mono" style="font-size:11.5px">MLA / hybrid / sparse / layerwise 的 mismatch 两边都不支持 —— 不是简单地址搬运，需要 canonical layout 重排</text>
</svg>`,
    legs: [
      {
        id: 'boundary',
        layer: 'engine',
        title: '先划边界：它们本就在不同层',
        direction: 'both',
        steps: [
          { t: 'vLLM 调度接入', a: 'vllm/v1/core/sched/scheduler.py:767', note: 'A：LMCache adapter 返回外部命中长度；B：AscendStore 直接用 vLLM block hash 与 cache group' },
          { t: 'KV 索引', a: 'lmcache/utils.py:389', note: 'A：%%CacheEngineKey%% + 链式 chunk hash + tier location；B：%%PoolKey%% = model + parallel ranks + group/role/family + block hash' },
          { t: 'KV 内存布局', a: 'lmcache_ascend/v1/npu_connector/npu_connectors.py:745', note: 'A：NPU connector 把 vLLM layout gather/scatter 成 MemoryObj；B：直接从 vLLM KV tensor 算 block/layer/head slice 地址' },
          { t: '传输', a: 'lmcache_ascend/v1/transfer_channel/hccl_channel.py:95', note: 'A：HCCL/HIXL channel；B：Mooncake TransferEngine + Ascend transport' },
          { t: '存储控制面', a: 'lmcache/v1/storage_backend/storage_manager.py:221', note: 'A：%%StorageManager%% + CacheController；B：Mooncake Master' },
        ],
        html: `**这一节是整条分析的地基。** 原始对比文档里有一句话值得直接引用：

> 「因此，『LMCache 前缀匹配强』与『Mooncake 副本 HA 强』并不矛盾：
> **它们本来就位于不同层**。真正公平的比较对象必须是两套完整方案。」

**两层的关键差别在这里**：

| | A 的 %%CacheEngineKey%% | B 的 %%PoolKey%% |
|---|---|---|
| 组成 | 链式 chunk hash + tier location | model + parallel ranks + group/role/family + block hash |
| 谁定义 | LMCache 自己 | **直接复用 vLLM 的 block hash** |
| 后果 | 可跨 tier 接续查找 | **与 vLLM 的新 KV 类型天然一致** |

**所以两者的分歧是「自己造索引」与「复用引擎索引」。**
而这一分歧贯穿到后面每一节。`,
      },
      {
        id: 'dimensions',
        layer: 'engine',
        title: '逐维度对照',
        direction: 'both',
        steps: [
          { t: 'KV 管理 · 前缀匹配', a: 'lmcache/v1/token_database.py:363', note: 'LMCache 略强：链式 hash 可跨 CPU/Disk/Remote/P2P 接续；AscendStore 略强于模型语义一致性' },
          { t: 'KV 管理 · hybrid / SWA / Mamba', a: 'vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/config_data.py:334', note: 'AscendStore 更好：直接复用 vLLM 的 KVCacheSpec manager，原生维护 group mask、SWA clip' },
          { t: 'KV 管理 · MLA / DSA TP 冗余消除', a: 'lmcache/v1/token_database.py:243', note: '两边都能去掉同组重复写；LMCache 语义更直接（save_only_first_rank）' },
          { t: 'KV 管理 · layerwise', a: 'vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/layerwise_cache_layout.py:39', note: 'AscendStore 能力更宽（两条模式）但成熟度不足；LMCache 不支持 async store，与 P2P/PD 不兼容' },
          { t: 'KV 传输 · 专用 PD backend', a: 'lmcache_ascend/v1/storage_backend/pd/backend.py:54', note: 'LMCache 更灵活：HCCL/HIXL、push/pull/delay-pull、CPU offload；AscendStore 没有独立 PD backend' },
          { t: 'KV 传输 · 注册内存与多段搬运', a: 'mooncake-transfer-engine/include/transfer_engine_impl.h:121', note: 'Mooncake 的通用 registered-memory fabric 更完整；支持 multi-buffer batch put/get 与 Fabric 模式' },
          { t: 'KV 传输 · 失败传播', a: 'vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/backend/mooncake_backend.py:211', note: '★ LMCache 更好：P2P 返回明确 error，PD 有 backoff，pull 总发 Done 释放资源；AscendStore 的 put 失败只记日志' },
          { t: 'KV 存储 · 本地多级缓存', a: 'lmcache/v1/storage_backend/local_cpu_backend.py:42', note: 'LMCache 更好：LocalCPU 是热缓存与 staging，可组合 Disk/Remote/P2P/PD，支持 LRU/LFU/FIFO/MRU' },
          { t: 'KV 存储 · 分布式对象与副本', a: 'mooncake-store/src/master_service.cpp:130', note: '★ Mooncake 明显更好：Master 管 object / segment / replica / read lease / tenant quota / 水位淘汰' },
          { t: 'KV 存储 · 控制面 HA', a: 'mooncake-store/src/ha/standby_controller.cpp:205', note: '★ Mooncake 明显更好：leader coordinator + standby promotion + oplog + snapshot。**LMCache 的 mp_coordinator 有 fleet 级 registry 与持久化状态，但没有选主与 HA**（其 persistence 文档说明重启后靠各组件自恢复）' },
        ],
        html: `### 三处「★」是差距最大的地方

我把原始对比里结论最明确的三条挑出来：

| 维度 | 谁更强 | 差距性质 |
|---|---|---|
| **失败传播** | LMCache | AscendStore 的 %%MooncakeBackend.put()%% **捕获异常后只记日志，不把失败返回给发送线程** |
| **分布式对象与副本** | Mooncake | 完整的 object / replica / quota / 水位淘汰体系 |
| **控制面 HA** | Mooncake | Mooncake 有 leader + oplog + snapshot；**LMCache 的 mp_coordinator 有持久化状态但无选主**，重启后由各组件自行恢复 |

**前一条是正确性问题，后两条是能力缺失。**
原始文档的结论是「要 KV 管理平台能力选 LMCache，要分布式 KV 对象存储能力选
Mooncake」，原因就在这里：**两者缺的不是同一类东西。**`,
      },
      {
        id: 'gap',
        layer: 'transport',
        title: '共同短板：P/D 的 TP 数不同',
        direction: 'in',
        steps: [
          { t: 'A：Ascend PD backend', a: 'lmcache_ascend/v1/storage_backend/pd/sender_mixin.py:414', note: '按同 %%tp_rank%% 连接，按发送端 shape/dtype 搬 raw bytes —— **没有通用 reshard**' },
          { t: 'B：AscendStore', a: 'vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/pool_worker.py:556', note: 'dense GQA 的 strided head-slice 代码**已存在**，但主分支 transfer thread 没传 %%worker%%，**生产入口不可达**' },
          { t: '结论', a: 'lmcache_ascend/v1/storage_backend/pd/sender_mixin.py:290', note: '**两边当前都不能视为可靠支持**（A 侧只按发送端 %%shape%%/%%dtype%% 搬 raw bytes，见下方锚点；B 侧的 head-slice 路径未接线，见上一步）。' },
          { t: '而 MLA / hybrid / sparse / layerwise', a: 'vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/pool_worker.py:1940', note: '**明确不支持** —— %%tp_mismatch%% 的地址构造注释写明只覆盖「单一 dense KV group」，MLA / hybrid / sparse / layerwise 需要 canonical layout 与模型语义感知的重排，当前没有这条路。' },
        ],
        html: `**这是本节最需要读者记住的一条。**

P/D 分离时如果两侧的 TP 数不同，KV 需要**重排**才能落地——
发送端的第 i 个 head 分片，在接收端可能属于另一个 rank。

| | 现状 |
|---|---|
| **LMCache-Ascend PD** | 按**同 %%tp_rank%%** 连接，搬 raw bytes。**语义上是"复制"而不是"重排"。** |
| **AscendStore** | 有 dense GQA 的 strided head-slice 代码，**但接线未合入**——生产入口不可达 |
| **MLA / hybrid / sparse / layerwise** | **两边都不支持** |

**特别注意第二条**：代码已经存在但"生产入口不可达"——
这与本站《LMCache-Ascend · 承接机制》里讲的
「属性替换的失败模式是静默错误」是**同一类风险**：
**代码在仓库里 ≠ 能力已交付。**

原始文档的措辞很明确：**不能把开放 PR 当成已交付。**

### 场景化结论

| 场景 | 更推荐 |
|---|---|
| 单集群 P/D、TP 相同、要最短数据路径 | **LMCache-Ascend PD** |
| 多实例借 KV、按需 peer fetch | **LMCache-Ascend P2P** |
| CPU/Disk/Remote 多级缓存与通用前缀复用 | **LMCache** |
| 大规模共享池、replica、配额、Master HA | **AscendStore + Mooncake** |
| 跟随 vLLM 新 KV spec（hybrid/SWA/Mamba/DSV4） | **AscendStore + Mooncake**（需核对开放 PR） |
| 存储成本受限，要 FP8 / CacheGen 量化 | **LMCache** |
| **P/D TP 不同的 dense GQA** | **两边都不应直接承诺** |
| **P/D TP 不同且是 MLA/DSV4/sparse** | **都不推荐** |`,
      },
    ],
    seams: [
      {
        name: 'KVConnectorBase_V1',
        from: '推理引擎',
        to: 'KV 通路',
        at: 'vllm/distributed/kv_transfer/kv_connector/v1/base.py',
        why: '**三条路共用同一个契约**——所以它们可以在同一个 vLLM 里替换，而不改引擎',
      },
      {
        name: 'CacheEngineKey',
        from: 'LMCache',
        to: '索引',
        at: 'lmcache/utils.py',
        why: 'A 路自造的键：链式 chunk hash + tier location，因此能跨 tier 接续查找',
      },
      {
        name: 'PoolKey',
        from: 'AscendStore',
        to: '索引',
        at: 'kv_pool/ascend_store/config_data.py',
        why: 'B 路复用 vLLM 的 block hash，因此与引擎的新 KV 类型天然一致',
      },
      {
        name: 'mooncakestore:// adapter',
        from: 'LMCache',
        to: 'Mooncake',
        at: 'lmcache/v1/storage_backend/connector/mooncakestore_adapter.py',
        why: '★ **路径 C 的接口**——让 LMCache 的近端能力与 Mooncake 的远端能力组合起来',
      },
    ],
    related: ['lmcache-ascend', 'ascend-store-connector', 'mooncake', 'vllm-ascend', 'hixl'],
  },

  {
    id: 'kv-save-load',
    title: 'KV Save / Load 全链路',
    subtitle: 'vLLM-Ascend 与 Mooncake（昇腾栈）',
    kind: 'call-path',
    participants: ['vllm-ascend', 'ascend-store-connector', 'mooncake', 'hixl', 'cann'],
    revisions: [
      { name: 'vllm-ascend', rev: 'f2f74a16' },
      { name: 'vLLM', rev: '568afb3a' },
      { name: 'Mooncake', rev: 'e389a85' },
      { name: 'LMCache', rev: 'b5d109ea' },
      { name: 'LMCache-Ascend（本地合成）', rev: 'local' },
      { name: 'CANN', rev: '9.1.0' },
    ],
    summary: '一次请求的 KV 如何在本机 NPU 显存与共享 KV 池之间往返。**控制面只搬元数据，数据面才搬字节**：Master 的 RPC 从不携带 KV，它只回答「副本在哪」。本文每一步都给出 %%仓库相对路径:行号%%，可直接回源码核对。',
    reading: [
      '先看**总图**：上下两条带分别是控制面与数据面，中间那条竖虚线是两者唯一的交界处，只传位置。',
      '再看 **Save 与 Load 两条腿**：每条腿先给导语与泳道序列图，再给带 %%仓库相对路径:行号%% 的编号调用链。',
      '最后看两节专题：**KV 块在内存在哪**与**字节怎么过去**，以及接口表。如果只记三样东西，记那张表。',
    ],
    diagram: `
<svg viewBox="0 0 1200 380" class="diagram flow-svg" role="img"
     aria-label="KV Save/Load 全链路的控制面与数据面分离图">
  <defs>
    <marker id="farr" viewBox="0 0 10 10" refX="8" refY="5"
            markerWidth="5.5" markerHeight="5.5" orient="auto">
      <path d="M0,1 L9,5 L0,9 z" fill="#d5c7b0"/>
    </marker>
    <marker id="farrk" viewBox="0 0 10 10" refX="8" refY="5"
            markerWidth="5.5" markerHeight="5.5" orient="auto">
      <path d="M0,1 L9,5 L0,9 z" fill="var(--l3)"/>
    </marker>
    <clipPath id="cpC"><rect x="20" y="20" width="1160" height="140" rx="10"/></clipPath>
    <clipPath id="cpD"><rect x="20" y="216" width="1160" height="140" rx="10"/></clipPath>
  </defs>

  <!-- 控制面 -->
  <rect x="20" y="20" width="1160" height="140" rx="10"
        fill="var(--l1)" fill-opacity=".045" stroke="var(--line)"/>
  <rect x="20" y="20" width="1160" height="3" fill="var(--l1)" clip-path="url(#cpC)"/>
  <text x="44" y="48" class="t-band" fill="var(--l1)">CONTROL PLANE · 控制面</text>
  <text x="250" y="48" class="t-sub">只走元数据：谁在哪、命中多少、要不要加载</text>

  <rect x="44" y="76" width="256" height="62" rx="7"
        fill="var(--panel)" stroke="var(--line)"/>
  <text x="60" y="102" class="t-title-sm">vLLM Scheduler</text>
  <text x="60" y="123" class="t-mono">BlockPool 查本地命中</text>
  <rect x="324" y="76" width="256" height="62" rx="7"
        fill="var(--panel)" stroke="var(--line)"/>
  <text x="340" y="102" class="t-title-sm">LookupClient</text>
  <text x="340" y="123" class="t-mono">ZeroMQ 跨进程查询</text>
  <rect x="604" y="76" width="256" height="62" rx="7"
        fill="var(--panel)" stroke="var(--line)"/>
  <text x="620" y="102" class="t-title-sm">KVPoolWorker</text>
  <text x="620" y="123" class="t-mono">构造 Store key</text>
  <rect x="884" y="76" width="256" height="62" rx="7"
        fill="var(--panel)" stroke="var(--line)"/>
  <text x="900" y="102" class="t-title-sm">Mooncake Master</text>
  <text x="900" y="123" class="t-mono">查副本位置 · 返回 LoadSpec</text>

  <line x1="304" y1="107" x2="320" y2="107" class="t-line" marker-end="url(#farr)"/>
  <line x1="584" y1="107" x2="600" y2="107" class="t-line" marker-end="url(#farr)"/>
  <line x1="864" y1="107" x2="880" y2="107" class="t-line" marker-end="url(#farr)"/>

  <!-- 唯一的交界处 -->
  <line x1="1012" y1="164" x2="1012" y2="212" stroke="var(--l3)" stroke-width="1.5"
        stroke-dasharray="5 4" marker-end="url(#farrk)"/>
  <rect x="856" y="172" width="300" height="30" rx="4" fill="var(--bg)"/>
  <text x="1012" y="184" class="t-mono-c" text-anchor="middle">只返回副本位置</text>
  <text x="1012" y="198" class="t-mono" text-anchor="middle">RPC 不携带任何 KV 字节</text>

  <!-- 数据面 -->
  <rect x="20" y="216" width="1160" height="140" rx="10"
        fill="var(--l3)" fill-opacity=".05" stroke="var(--line)"/>
  <rect x="20" y="216" width="1160" height="3" fill="var(--l3)" clip-path="url(#cpD)"/>
  <text x="44" y="244" class="t-band" fill="var(--l3)">DATA PLANE · 数据面</text>
  <text x="250" y="244" class="t-sub">只走字节：KV 块本体的搬运</text>

  <rect x="44" y="272" width="256" height="62" rx="7"
        fill="var(--panel)" stroke="var(--l3)" stroke-opacity=".4"/>
  <text x="60" y="298" class="t-title-sm">NPU KV tensor</text>
  <text x="60" y="319" class="t-mono">HBM 地址 + 长度</text>
  <rect x="324" y="272" width="256" height="62" rx="7"
        fill="var(--panel)" stroke="var(--l3)" stroke-opacity=".4"/>
  <text x="340" y="298" class="t-title-sm">TransferEngine</text>
  <text x="340" y="319" class="t-mono">submitTransfer 批量提交</text>
  <rect x="604" y="272" width="256" height="62" rx="7"
        fill="var(--panel)" stroke="var(--l3)" stroke-opacity=".4"/>
  <text x="620" y="298" class="t-title-sm">ADXL / HCCL</text>
  <text x="620" y="319" class="t-mono">昇腾传输链路</text>
  <rect x="884" y="272" width="256" height="62" rx="7"
        fill="var(--panel)" stroke="var(--l3)" stroke-opacity=".4"/>
  <text x="900" y="298" class="t-title-sm">Store segment</text>
  <text x="900" y="319" class="t-mono">DRAM / SSD / 远端</text>

  <line x1="304" y1="303" x2="320" y2="303" class="t-line" marker-end="url(#farr)"/>
  <line x1="584" y1="303" x2="600" y2="303" class="t-line" marker-end="url(#farr)"/>
  <line x1="864" y1="303" x2="880" y2="303" class="t-line" marker-end="url(#farr)"/>
</svg>
`,
    legs: [
      {
        id: 'save',
        layer: 'engine',
        title: 'Save：本机 NPU 到共享池',
        direction: 'out',
        lead: '本机引擎把刚落进分页池的 KV 推给共享池。控制面在 %%Mooncake Master%% 上登记「哪个 key 有哪些副本」，数据面由传输后端直接从 NPU 显存读走字节，两条线在这条腿里交替出现。下面按 %%KVCacheStoreSendingThread._handle_stored_request%% 的实际顺序展开，每步的第一步见 %%vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/kv_transfer.py:718%%。',
        diagram: `
<svg viewBox="0 0 1200 460" class="diagram flow-svg" role="img"
     aria-label="Save 腿泳道序列图：引擎读 NPU、控制面登记、数据面搬运">
  <defs>
    <marker id="sfr" viewBox="0 0 10 10" refX="8" refY="5"
            markerWidth="5.5" markerHeight="5.5" orient="auto">
      <path d="M0,1 L9,5 L0,9 z" fill="#d5c7b0"/>
    </marker>
    <marker id="sfk" viewBox="0 0 10 10" refX="8" refY="5"
            markerWidth="5.5" markerHeight="5.5" orient="auto">
      <path d="M0,1 L9,5 L0,9 z" fill="var(--l3)"/>
    </marker>
  </defs>

  <rect x="20" y="26" width="222" height="418" rx="8" fill="var(--panel)" fill-opacity=".5" stroke="var(--line)"/>
  <line x1="24" y1="27" x2="238" y2="27" stroke="var(--l2)" stroke-width="3"/>
  <text x="131" y="50" class="t-title-sm" text-anchor="middle">NPU HBM</text>
  <text x="131" y="68" class="t-sub" text-anchor="middle">vLLM 分页池</text>

  <rect x="252" y="26" width="222" height="418" rx="8" fill="var(--panel)" fill-opacity=".5" stroke="var(--line)"/>
  <line x1="256" y1="27" x2="470" y2="27" stroke="var(--l2)" stroke-width="3"/>
  <text x="363" y="50" class="t-title-sm" text-anchor="middle">KVTransferThread</text>
  <text x="363" y="68" class="t-sub" text-anchor="middle">store 发送线程</text>

  <rect x="484" y="26" width="222" height="418" rx="8" fill="var(--panel)" fill-opacity=".5" stroke="var(--line)"/>
  <line x1="488" y1="27" x2="702" y2="27" stroke="var(--l2)" stroke-width="3"/>
  <text x="595" y="50" class="t-title-sm" text-anchor="middle">MooncakeBackend</text>
  <text x="595" y="68" class="t-sub" text-anchor="middle">pybind 到 Client</text>

  <rect x="716" y="26" width="222" height="418" rx="8" fill="var(--l1)" fill-opacity=".07" stroke="var(--line)"/>
  <line x1="720" y1="27" x2="934" y2="27" stroke="var(--l1)" stroke-width="3"/>
  <text x="827" y="50" class="t-title-sm" text-anchor="middle">Mooncake Master</text>
  <text x="827" y="68" class="t-sub" text-anchor="middle">控制面 RPC</text>

  <rect x="948" y="26" width="222" height="418" rx="8" fill="var(--l3)" fill-opacity=".07" stroke="var(--line)"/>
  <line x1="952" y1="27" x2="1166" y2="27" stroke="var(--l3)" stroke-width="3"/>
  <text x="1059" y="50" class="t-title-sm" text-anchor="middle">传输后端</text>
  <text x="1059" y="68" class="t-sub" text-anchor="middle">ADXL / HCCL</text>

  <line x1="131" y1="84" x2="131" y2="436" class="t-line" stroke-dasharray="4 5"/>
  <line x1="363" y1="84" x2="363" y2="436" class="t-line" stroke-dasharray="4 5"/>
  <line x1="595" y1="84" x2="595" y2="436" class="t-line" stroke-dasharray="4 5"/>
  <line x1="827" y1="84" x2="827" y2="436" class="t-line" stroke-dasharray="4 5"/>
  <line x1="1059" y1="84" x2="1059" y2="436" class="t-line" stroke-dasharray="4 5"/>

  <line x1="131" y1="110" x2="355" y2="110" class="t-line" marker-end="url(#sfr)"/>
  <text x="243" y="104" class="t-mono" text-anchor="middle">① 前向写满 slot</text>

  <rect x="233" y="130" width="260" height="30" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="363" y="149" class="t-mono" text-anchor="middle">② token hash 到 PoolKey</text>

  <line x1="363" y1="178" x2="587" y2="178" class="t-line" marker-end="url(#sfr)"/>
  <text x="475" y="172" class="t-mono" text-anchor="middle">③ exists(keys)：已存在则跳过</text>

  <line x1="595" y1="212" x2="819" y2="212" class="t-line" marker-end="url(#sfr)"/>
  <text x="707" y="206" class="t-mono" text-anchor="middle">④ BatchExistKey（控制面）</text>

  <rect x="233" y="232" width="260" height="30" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="363" y="251" class="t-mono" text-anchor="middle">⑤ prepare_value 到 NPU 地址</text>

  <rect x="233" y="266" width="260" height="30" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="363" y="285" class="t-mono" text-anchor="middle">⑥ NPU event 同步</text>

  <line x1="363" y1="314" x2="587" y2="314" class="t-line" marker-end="url(#sfr)"/>
  <text x="475" y="308" class="t-mono" text-anchor="middle">⑦ put(keys, addrs, sizes)</text>

  <line x1="595" y1="348" x2="819" y2="348" class="t-line" marker-end="url(#sfr)"/>
  <text x="707" y="342" class="t-mono" text-anchor="middle">⑧ BatchPutStart 只回副本位置</text>

  <line x1="595" y1="382" x2="1051" y2="382" stroke="var(--l3)" stroke-width="1.5" marker-end="url(#sfk)"/>
  <text x="823" y="376" class="t-mono-c" text-anchor="middle">⑨ 数据面 WRITE：ADXL 直读 NPU</text>

  <line x1="595" y1="416" x2="819" y2="416" class="t-line" marker-end="url(#sfr)"/>
  <text x="707" y="410" class="t-mono" text-anchor="middle">⑩ BatchPutEnd 副本标记完成</text>
</svg>
`,
        steps: [
          { t: 'Worker 产生新 KV', a: 'vllm_ascend/worker/model_runner_v1.py:2145', note: '前向写满分页池的 slot，KV 已按逻辑块号落位' },
          { t: 'block hash 到 PoolKey', a: 'vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/pool_scheduler.py:238', note: '前缀哈希即缓存键，跨实例可复现' },
          { t: 'store_mask 过滤', a: 'vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/kv_transfer.py:723', note: '不完整 chunk 不保存' },
          { t: '跳过已由外部 load 的区间', a: '同上:734', note: '避免把刚取回来的又写回去' },
          { t: 'exists 查询', a: '同上:537', note: '已存在的 key 直接跳过' },
          { t: 'prepare_value 到 NPU 源地址', a: 'vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/config_data.py:405', note: '%%addr = base_addr + block_id * block_stride%%；2MB 对齐由 %%_align_kv_ptrs%% 兜底（%%vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/pool_worker.py:747%%）' },
          { t: '等待 NPU event', a: 'vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/kv_transfer.py:890', note: '确保写入完成再传输' },
          { t: 'MooncakeBackend.put', a: 'vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/backend/mooncake_backend.py:189', note: '跨入存储系统的接口' },
          { t: 'pybind：uintptr_t 到 void*', a: 'mooncake-integration/store/store_py.cpp:470', note: 'Python 地址交给 C++，类型换成 %%Slice{ptr,size}%%（%%mooncake-store/include/types.h:421%%）' },
          { t: 'Client::BatchPut', a: 'mooncake-store/src/client_service.cpp:2519', note: '进入 Mooncake，发起 %%BatchPutStart%%' },
          { t: 'Master::BatchPutStart', a: 'mooncake-store/src/rpc_service.cpp:444', note: '★ 控制面：只分配副本位置，不收字节' },
          { t: '拷贝还是直读', a: 'mooncake-store/src/transfer_task.cpp:1467', note: '%%selectStrategy%% 判 endpoint：同进程才用 memcpy' },
          { t: 'TransferSubmitter WRITE', a: '同上:1261', note: '★ 数据面：真正发起搬运，远端地址取 %%handle.buffer_address_%%' },
          { t: 'ADXL / HCCL 执行', a: 'mooncake-transfer-engine/src/transport/ascend_transport/hccl_transport/hccl_transport.cpp:568', note: '%%protocol="ascend"%% 分支；注册走 %%regLocalRmaMem%%' },
          { t: 'Master::BatchPutEnd', a: 'mooncake-store/src/master_service.cpp:5221', note: 'replica 标记 COMPLETE，key 才可读' },
        ],
      },
      {
        id: 'load',
        layer: 'engine',
        title: 'Load：共享池到本机 NPU',
        direction: 'in',
        lead: 'Load 不是 Save 的镜像：调度阶段就要问出「外部能命中多少 token」，决定了这一步要不要分配 HBM block。命中量由 %%KVPoolScheduler%% 通过 ZeroMQ 问 %%KVPoolWorker%% 得到，真正搬字节发生在执行阶段。入口见 %%vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/pool_scheduler.py:521%%。',
        diagram: `
<svg viewBox="0 0 1200 460" class="diagram flow-svg" role="img"
     aria-label="Load 腿泳道序列图：调度侧问命中、控制面回位置、数据面单边读">
  <defs>
    <marker id="lfr" viewBox="0 0 10 10" refX="8" refY="5"
            markerWidth="5.5" markerHeight="5.5" orient="auto">
      <path d="M0,1 L9,5 L0,9 z" fill="#d5c7b0"/>
    </marker>
    <marker id="lfk" viewBox="0 0 10 10" refX="8" refY="5"
            markerWidth="5.5" markerHeight="5.5" orient="auto">
      <path d="M0,1 L9,5 L0,9 z" fill="var(--l3)"/>
    </marker>
  </defs>

  <rect x="20" y="26" width="222" height="418" rx="8" fill="var(--panel)" fill-opacity=".5" stroke="var(--line)"/>
  <line x1="24" y1="27" x2="238" y2="27" stroke="var(--l2)" stroke-width="3"/>
  <text x="131" y="50" class="t-title-sm" text-anchor="middle">vLLM Scheduler</text>
  <text x="131" y="68" class="t-sub" text-anchor="middle">KVCacheManager</text>

  <rect x="252" y="26" width="222" height="418" rx="8" fill="var(--panel)" fill-opacity=".5" stroke="var(--line)"/>
  <line x1="256" y1="27" x2="470" y2="27" stroke="var(--l2)" stroke-width="3"/>
  <text x="363" y="50" class="t-title-sm" text-anchor="middle">KVPoolScheduler</text>
  <text x="363" y="68" class="t-sub" text-anchor="middle">调度侧 Lookup 客户端</text>

  <rect x="484" y="26" width="222" height="418" rx="8" fill="var(--panel)" fill-opacity=".5" stroke="var(--line)"/>
  <line x1="488" y1="27" x2="702" y2="27" stroke="var(--l2)" stroke-width="3"/>
  <text x="595" y="50" class="t-title-sm" text-anchor="middle">KVPoolWorker</text>
  <text x="595" y="68" class="t-sub" text-anchor="middle">lookup 服务端与收发线程</text>

  <rect x="716" y="26" width="222" height="418" rx="8" fill="var(--l1)" fill-opacity=".07" stroke="var(--line)"/>
  <line x1="720" y1="27" x2="934" y2="27" stroke="var(--l1)" stroke-width="3"/>
  <text x="827" y="50" class="t-title-sm" text-anchor="middle">Mooncake Master</text>
  <text x="827" y="68" class="t-sub" text-anchor="middle">控制面 RPC</text>

  <rect x="948" y="26" width="222" height="418" rx="8" fill="var(--l3)" fill-opacity=".07" stroke="var(--line)"/>
  <line x1="952" y1="27" x2="1166" y2="27" stroke="var(--l3)" stroke-width="3"/>
  <text x="1059" y="50" class="t-title-sm" text-anchor="middle">传输后端</text>
  <text x="1059" y="68" class="t-sub" text-anchor="middle">ADXL / HCCL</text>

  <line x1="131" y1="84" x2="131" y2="436" class="t-line" stroke-dasharray="4 5"/>
  <line x1="363" y1="84" x2="363" y2="436" class="t-line" stroke-dasharray="4 5"/>
  <line x1="595" y1="84" x2="595" y2="436" class="t-line" stroke-dasharray="4 5"/>
  <line x1="827" y1="84" x2="827" y2="436" class="t-line" stroke-dasharray="4 5"/>
  <line x1="1059" y1="84" x2="1059" y2="436" class="t-line" stroke-dasharray="4 5"/>

  <rect x="40" y="96" width="180" height="28" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="131" y="114" class="t-mono" text-anchor="middle">① 算 block hashes</text>

  <line x1="131" y1="144" x2="355" y2="144" class="t-line" marker-end="url(#lfr)"/>
  <text x="243" y="138" class="t-mono" text-anchor="middle">② get_num_new_matched_tokens</text>

  <line x1="363" y1="178" x2="587" y2="178" class="t-line" marker-end="url(#lfr)"/>
  <text x="475" y="172" class="t-mono" text-anchor="middle">③ ZMQ lookup 只发 hash</text>

  <line x1="595" y1="212" x2="819" y2="212" class="t-line" marker-end="url(#lfr)"/>
  <text x="707" y="206" class="t-mono" text-anchor="middle">④ batch_is_exist（控制面）</text>

  <line x1="819" y1="246" x2="371" y2="246" class="t-line" marker-end="url(#lfr)"/>
  <text x="595" y="240" class="t-mono" text-anchor="middle">⑤ 回到 external_hit_tokens</text>

  <rect x="233" y="266" width="260" height="30" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="363" y="285" class="t-mono" text-anchor="middle">⑥ 组装 LoadSpec</text>

  <line x1="355" y1="314" x2="139" y2="314" class="t-line" marker-end="url(#lfr)"/>
  <text x="247" y="308" class="t-mono" text-anchor="middle">⑦ external 更大才分配 HBM</text>

  <rect x="465" y="332" width="260" height="30" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="595" y="351" class="t-mono" text-anchor="middle">⑧ prepare_value 到 NPU 地址</text>

  <line x1="595" y1="382" x2="819" y2="382" class="t-line" marker-end="url(#lfr)"/>
  <text x="707" y="376" class="t-mono" text-anchor="middle">⑨ BatchGetReplicaList 回位置</text>

  <line x1="595" y1="416" x2="1051" y2="416" stroke="var(--l3)" stroke-width="1.5" marker-end="url(#lfk)"/>
  <text x="823" y="410" class="t-mono-c" text-anchor="middle">⑩ get() 单边读写入 HBM</text>
</svg>
`,
        steps: [
          { t: '请求 token 与 block hash', a: 'vllm/v1/core/block_pool.py:263', note: '按前缀逐块算哈希，作为去重的键' },
          { t: 'KVCacheManager 查本地 HBM 最长前缀', a: 'vllm/v1/core/kv_cache_manager.py:207', note: '得到 %%hbm_hit_tokens%%' },
          { t: 'get_num_new_matched_tokens', a: 'vllm/distributed/kv_transfer/kv_connector/v1/base.py:454', note: '★ 接口：调度阶段就问「能省多少」' },
          { t: 'LookupClient 外部 lookup（ZMQ）', a: 'vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/pool_scheduler.py:1185', note: '跨进程 socket，只发 hash 与 group id，不阻塞调度主循环' },
          { t: 'Mooncake batch_is_exist', a: 'mooncake-store/src/master_service.cpp:3001', note: '得到 %%external_hit_tokens%%；引擎侧调用见 %%vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/backend/mooncake_backend.py:187%%' },
          { t: '组装 LoadSpec', a: 'vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/pool_scheduler.py:610', note: 'local、external、skip 三段分开记' },
          { t: 'external 大于 local 才取数', a: '同上:590', note: '★ 只有外部命中更多时才分配新 block' },
          { t: '为 external suffix 分配 HBM block', a: 'vllm/v1/core/kv_cache_manager.py:283', note: '写入 block table 的是物理块号' },
          { t: 'prepare_value 到 NPU 目标地址', a: 'vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/kv_transfer.py:970', note: '目标地址同样按 %%block_id * block_stride%% 算' },
          { t: 'batch_get_into_multi_buffers', a: 'vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/backend/mooncake_backend.py:240', note: '跨入存储系统的接口' },
          { t: 'Master BatchGetReplicaList 回描述符', a: 'mooncake-store/src/master_service.cpp:4110', note: '★ 控制面：回的仍是 %%AllocatedBuffer::Descriptor%%（见 %%mooncake-store/include/replica.h:237%%），不含字节' },
          { t: 'TransferSubmitter READ', a: 'mooncake-store/src/transfer_task.cpp:1303', note: '★ 数据面：拉取，地址来自描述符' },
          { t: '写入本地 NPU HBM block', a: 'mooncake-transfer-engine/tent/src/transport/ascend/ascend_direct_transport.cpp:349', note: 'HIXL 单边读；RDMA 回退路径见 %%mooncake-transfer-engine/src/transport/rdma_transport/worker_pool.cpp:358%%' },
          { t: 'block table 指向已填充块', a: 'vllm/v1/worker/block_table.py:114', note: '调度器据此跳过对应 prefill' },
        ],
      },
    ],
    sections: [
      {
        id: 'memory',
        title: 'KV 块在内存在哪：三段地址',
        lead: '一个 KV 块的地址在链路上会变形四次：逻辑块号、物理块号、设备指针、注册地址。承载这四次表示的是三段内存，分别由引擎、LMCache 和 Mooncake 分配，生命周期也各不相同。图里横排是四次表示，下面三行是这三段内存各自的结构与归属。',
        diagram: `
<svg viewBox="0 0 1200 660" class="diagram flow-svg" role="img"
     aria-label="一个 KV 块的四次地址表示与三段内存：设备显存、主机钉住缓冲、注册内存">
  <defs>
    <marker id="mfr" viewBox="0 0 10 10" refX="8" refY="5"
            markerWidth="5.5" markerHeight="5.5" orient="auto">
      <path d="M0,1 L9,5 L0,9 z" fill="#d5c7b0"/>
    </marker>
  </defs>

  <rect x="20" y="20" width="250" height="60" rx="7" fill="var(--panel)" stroke="var(--line)"/>
  <text x="32" y="44" class="t-title-sm">逻辑块号</text>
  <text x="32" y="64" class="t-sub">block table 的行内下标</text>
  <rect x="310" y="20" width="250" height="60" rx="7" fill="var(--panel)" stroke="var(--line)"/>
  <text x="322" y="44" class="t-title-sm">物理块号</text>
  <text x="322" y="64" class="t-sub">KVCacheBlock.block_id</text>
  <rect x="600" y="20" width="250" height="60" rx="7" fill="var(--panel)" stroke="var(--line)"/>
  <text x="612" y="44" class="t-title-sm">设备指针</text>
  <text x="612" y="64" class="t-sub">data_ptr 加 block_id 乘 stride</text>
  <rect x="890" y="20" width="270" height="60" rx="7" fill="var(--panel)" stroke="var(--l3)" stroke-opacity=".5"/>
  <text x="902" y="44" class="t-title-sm">注册地址</text>
  <text x="902" y="64" class="t-sub">buffer_address 加 rkey 或 MemHandle</text>

  <line x1="270" y1="50" x2="306" y2="50" class="t-line" marker-end="url(#mfr)"/>
  <line x1="560" y1="50" x2="596" y2="50" class="t-line" marker-end="url(#mfr)"/>
  <line x1="850" y1="50" x2="886" y2="50" class="t-line" marker-end="url(#mfr)"/>
  <text x="44" y="104" class="t-mono">同一块 KV 的四次表示：调度语义到传输语义</text>

  <rect x="20" y="130" width="1160" height="150" rx="10" fill="var(--l2)" fill-opacity=".05" stroke="var(--line)"/>
  <line x1="24" y1="131" x2="1176" y2="131" stroke="var(--l2)" stroke-width="3"/>
  <text x="44" y="160" class="t-title-sm">段 A · 设备显存（NPU HBM）</text>
  <rect x="200" y="174" width="230" height="64" rx="7" fill="var(--panel)" stroke="var(--line)"/>
  <text x="212" y="196" class="t-title-sm">分页池 tensor</text>
  <text x="212" y="215" class="t-mono">torch.zeros 一次预分配</text>
  <text x="212" y="231" class="t-mono">dtype 是 int8</text>
  <rect x="450" y="174" width="230" height="64" rx="7" fill="var(--panel)" stroke="var(--line)"/>
  <text x="462" y="196" class="t-title-sm">块形状</text>
  <text x="462" y="215" class="t-mono">num_blocks 乘 block_size</text>
  <text x="462" y="231" class="t-mono">乘 num_heads 乘 head_dim</text>
  <rect x="700" y="174" width="230" height="64" rx="7" fill="var(--panel)" stroke="var(--line)"/>
  <text x="712" y="196" class="t-title-sm">block table</text>
  <text x="712" y="215" class="t-mono">int32 二维数组</text>
  <text x="712" y="231" class="t-mono">请求行到物理块号</text>
  <rect x="950" y="174" width="230" height="64" rx="7" fill="var(--panel)" stroke="var(--line)"/>
  <text x="962" y="196" class="t-title-sm">基地址表</text>
  <text x="962" y="215" class="t-mono">group_kv_caches_base_addr</text>
  <text x="962" y="231" class="t-mono">按 group 存 data_ptr</text>
  <text x="44" y="266" class="t-mono">谁分配：引擎按 kv_cache_config 在 worker 启动时一次性算好块数；生命周期：worker 进程全程，不随请求释放</text>

  <rect x="20" y="300" width="1160" height="150" rx="10" fill="var(--l4)" fill-opacity=".05" stroke="var(--line)"/>
  <line x1="24" y1="301" x2="1176" y2="301" stroke="var(--l4)" stroke-width="3"/>
  <text x="44" y="330" class="t-title-sm">段 B · 主机钉住缓冲（pinned host buffer）</text>
  <rect x="200" y="344" width="230" height="64" rx="7" fill="var(--panel)" stroke="var(--line)"/>
  <text x="212" y="366" class="t-title-sm">MixedMemoryAllocator</text>
  <text x="212" y="385" class="t-mono">LMCache 的 L1 CPU 池</text>
  <text x="212" y="401" class="t-mono">allocate_cpu_memory</text>
  <rect x="450" y="344" width="230" height="64" rx="7" fill="var(--panel)" stroke="var(--line)"/>
  <text x="462" y="366" class="t-title-sm">PinMemoryAllocator</text>
  <text x="462" y="385" class="t-mono">整块 pinned arena</text>
  <text x="462" y="401" class="t-mono">再切片成小对象</text>
  <rect x="700" y="344" width="230" height="64" rx="7" fill="var(--panel)" stroke="var(--line)"/>
  <text x="712" y="366" class="t-title-sm">cudaHostAlloc</text>
  <text x="712" y="385" class="t-mono">真正钉住页的一步</text>
  <text x="712" y="401" class="t-mono">物理页不再被换出</text>
  <rect x="950" y="344" width="230" height="64" rx="7" fill="var(--panel)" stroke="var(--line)"/>
  <text x="962" y="366" class="t-title-sm">MemoryObj</text>
  <text x="962" y="385" class="t-mono">metadata.address</text>
  <text x="962" y="401" class="t-mono">引用计数控制回收</text>
  <text x="44" y="436" class="t-mono">谁分配：LMCache 在引擎进程里建池；生命周期：进程级，MemoryObj 引用计数归零才回池</text>

  <rect x="20" y="470" width="1160" height="150" rx="10" fill="var(--l3)" fill-opacity=".06" stroke="var(--line)"/>
  <line x1="24" y1="471" x2="1176" y2="471" stroke="var(--l3)" stroke-width="3"/>
  <text x="44" y="500" class="t-title-sm">段 C · 注册内存（网卡与 ADXL 可直接访问）</text>
  <rect x="200" y="514" width="230" height="64" rx="7" fill="var(--panel)" stroke="var(--l3)" stroke-opacity=".4"/>
  <text x="212" y="536" class="t-title-sm">AllocatedBuffer</text>
  <text x="212" y="555" class="t-mono">Mooncake 的存储块句柄</text>
  <text x="212" y="571" class="t-mono">get_descriptor 出地址</text>
  <rect x="450" y="514" width="230" height="64" rx="7" fill="var(--panel)" stroke="var(--l3)" stroke-opacity=".4"/>
  <text x="462" y="536" class="t-title-sm">Descriptor</text>
  <text x="462" y="555" class="t-mono">buffer_address 加端点</text>
  <text x="462" y="571" class="t-mono">还有 protocol</text>
  <rect x="700" y="514" width="230" height="64" rx="7" fill="var(--panel)" stroke="var(--l3)" stroke-opacity=".4"/>
  <text x="712" y="536" class="t-title-sm">registerLocalMemory</text>
  <text x="712" y="555" class="t-mono">每个 transport 各注册一次</text>
  <text x="712" y="571" class="t-mono">失败要回滚</text>
  <rect x="950" y="514" width="230" height="64" rx="7" fill="var(--panel)" stroke="var(--l3)" stroke-opacity=".4"/>
  <text x="962" y="536" class="t-title-sm">远端可用的句柄</text>
  <text x="962" y="555" class="t-mono">RDMA 是 addr 加 rkey</text>
  <text x="962" y="571" class="t-mono">HIXL 是 MemHandle</text>
  <text x="44" y="606" class="t-mono">谁分配：Mooncake 的 client segment；生命周期：mount 时建立，unregisterLocalMemory 之前一直有效</text>

  <text x="44" y="646" class="t-mono-c">数据面只认段 C 的地址：段 A 的 data_ptr 必须先注册成段 C，才会出现在 Master 返回的描述符里</text>
</svg>
`,
        html: `
**读图**：上排从左到右是同一块 KV 的四次表示，下面三行是它依次落到的三段内存。段 A 由引擎分配，段 B 是主机上的钉住缓冲，段 C 是注册给网卡的内存。箭头只画「表示怎么变」，内存归属看每行底部的说明。

### 三段内存各是什么

| 段 | 谁分配 | 承载结构 | 生命周期 |
|---|---|---|---|
| A 设备显存 | 引擎按 %%kv_cache_config%% 一次性预分配 | %%torch.zeros%% 出的 int8 backing，%%KVCacheBlock%% | worker 进程全程，不随请求释放 |
| B 主机钉住缓冲 | LMCache 在引擎进程里建池 | %%MemoryObj%% 与 %%MemoryObjMetadata.address%% | 进程级；%%MemoryObj%% 引用计数归零才回收 |
| C 注册内存 | Mooncake 的 client segment | %%AllocatedBuffer::Descriptor%% | mount 时建立，%%unregisterLocalMemory%% 之前有效 |

### 段 A：设备显存里的分页池

分页（paging）指把显存切成固定大小的块，让不同请求的 KV 交错复用同一片池子，块与块之间不必相邻。vLLM 的 KV cache 不是按请求分配，而是启动时申请一大块 int8 backing，再切出 typed view。%%vllm/v1/worker/gpu_model_runner.py:7238%% 的 %%_allocate_kv_cache_tensors%% 里，每个 %%kv_cache_tensor%% 走一次 %%torch.zeros%%（%%vllm/v1/worker/gpu_model_runner.py:7257%%）。物理布局是 %%num_blocks, block_size, num_heads, 2 乘 head_size%%（%%vllm/v1/attention/backend.py:129%%），%%num_blocks%% 由 %%KVCacheConfig%% 在前向之前算好，%%block_size%% 是每块装多少 token。

逻辑块号到物理块号的对应关系放在 block table 里。%%BlockTable.block_table%% 是一个 int32 的二维数组，形状 %%max_num_reqs, max_num_blocks_per_req%%（%%vllm/v1/worker/block_table.py:81%%）。请求的第 i 个逻辑块就是这一行的第 i 列，写进去的值是 %%KVCacheBlock.block_id%%（%%vllm/v1/core/kv_cache_utils.py:118%%），追加由 %%append_row%% 完成（%%vllm/v1/worker/block_table.py:114%%）。

昇腾侧同一件事由 %%KVPoolWorker%% 做，而且它算的是字节地址：遍历 %%kv_caches%%，对每个 cache 取 %%cache.data_ptr()%%（%%vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/pool_worker.py:735%%），把「基地址、块字节长度、块步长」按 group 记进 %%group_kv_caches_base_addr%%（同文件 \`:741\`）。设备指针到具体块地址的换算在 %%prepare_value%%：

\`\`\`python
addr = base_addr + block_id * block_stride
\`\`\`

这一行在 %%vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/config_data.py:429%%，定义在 \`:405\`。注意 %%block_stride%% 取的是 %%cache.stride(0)%% 而不是 %%numel()%%：共享 backing 或多个 view 叠在同一片池子上时，两者不相等，用错会静默读写到相邻块。混合场景下 %%KVPoolWorker%% 还会把起始地址向下对齐到 2MB（%%vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/pool_worker.py:747%%）。

### 段 B：主机上的钉住缓冲

钉住（pin）指让操作系统承诺这段内存的物理页不被换出、地址不漂移，网卡才能拿它做 DMA。LMCache 的 L1 CPU 池默认是 %%MixedMemoryAllocator%%（%%lmcache/v1/memory_allocators/mixed_memory_allocator.py:29%%），构造函数里 %%self.buffer = memory_management._allocate_cpu_memory(...)%%（同文件 \`:60\`）。%%_allocate_cpu_memory%%（%%lmcache/v1/memory_management.py:547%%）解析出分配函数后调用 %%resolved.alloc()%%（\`:564\`）；CUDA 构建下最终落到 %%alloc_pinned_ptr%%，里面是 %%cudaHostAlloc%%（%%csrc/cuda/mem_alloc.cpp:35%%）。

%%PinMemoryAllocator%% 是同一机制的独立实现（%%lmcache/v1/memory_allocators/pin_memory_allocator.py:25%%），持有一整块 pinned arena，默认切成 %%TensorMemoryAllocator%%（%%lmcache/v1/memory_allocators/pin_memory_allocator.py:52%%）。它自己只负责钉住，不负责把地址告诉网卡。每个分配出来的 %%MemoryObj%% 带一份元数据，%%address%% 字段存「物理地址」（%%lmcache/v1/memory_management.py:155%%），%%data_ptr()%% 从底层 tensor 取（\`:885\`）。对齐粒度是 %%AddressManager.ALIGN_BYTES%%，值为 \`4096\`（\`:1304\`）。

### 段 C：注册内存

Mooncake 的 KV 池是自己管的一片 segment。%%Client::setup%% 先映射出这片内存，再 %%MountSegment%%（%%mooncake-store/src/real_client.cpp:1069%%）；注册前会尝试 %%TryPinStoreSegment%%（\`:1066\`），内部走 %%RegisteredPinnedMemoryManager::try_pin%%（%%mooncake-store/src/registered_pinned_memory.cpp:90%%）。

每块分配出去的存储用一个 %%AllocatedBuffer%% 表示（%%mooncake-store/include/allocator.h:48%%）。它的可序列化形态是嵌套的 %%Descriptor%%（%%mooncake-store/include/allocator.h:96%%）：

\`\`\`cpp
struct Descriptor {
    uint64_t size_;
    uintptr_t buffer_address_;
    std::string protocol_;
    std::string transport_endpoint_;
    YLT_REFL(Descriptor, size_, buffer_address_, protocol_,
             transport_endpoint_);
};
\`\`\`

%%buffer_address_%% 是这段内存的地址，%%transport_endpoint_%% 标明它属于哪个进程或哪张网卡，填充逻辑在 %%AllocatedBuffer::get_descriptor%%（%%mooncake-store/src/allocator.cpp:95%%）。

地址要被网卡访问，得先过 %%registerLocalMemory%%（%%mooncake-transfer-engine/src/transfer_engine_impl.cpp:657%%），它把这段内存交给每一个已安装的 transport 各注册一次（\`:678\`），任一失败就回滚已注册的部分（\`:687\`）。传输引擎侧记下的结果是 %%TransferMetadata::BufferDesc%%（%%mooncake-transfer-engine/include/transfer_metadata.h:56%%），字段有 %%addr%%（\`:58\`）、%%lkey%%（\`:72\`）、%%rkey%%（\`:73\`）。

昇腾侧多一层类型区分。HIXL 注册时按 %%desc.location%% 决定 %%hixl::MEM_HOST%% 还是 %%hixl::MEM_DEVICE%%（%%mooncake-transfer-engine/tent/src/transport/ascend/ascend_direct_transport.cpp:494%%），%%RegisterMem%% 返回的句柄按地址存进 %%addr_to_mem_handle_%%（同文件 \`:526\` 与 \`:538\`；映射声明在 %%mooncake-transfer-engine/tent/include/tent/transport/ascend/ascend_direct_transport.h:130%%）。device 与 Host 注册路径相同，差别在于谁能直接寻址。

LMCache-Ascend 在设备侧另有一块 staging：%%NPUConnector%% 用 %%ref_tensor.device%% 确定设备（%%lmcache_ascend/v1/npu_connector/npu_connectors.py:402%%），再交给 %%GPUMemoryAllocator%% 建缓冲（同文件 \`:448\`）。这块内存属于段 A 的同一类，生命周期短于分页池，按层或按批建立。

### 三段之间谁把地址交给谁

段 A 到段 C 的交接点是 %%KVPoolWorker%% 的注册调用：它把设备指针整理成 %%ptrs%% 与 %%lengths%%（%%vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/pool_worker.py:821%% 与 \`:822\`），然后调 %%self.m_store.register_buffer(ptrs, lengths)%%（\`:876\`）。这一跳之后，段 A 的地址才以「注册过的地址」的身份出现在传输引擎里。

段 C 的地址走向控制面时，被包进 %%Replica::MemoryDescriptor%%（%%mooncake-store/include/replica.h:237%%），字段就是上文的 %%AllocatedBuffer::Descriptor%%，赋值处见同文件 \`:758\`。于是对端从 RPC 里拿到的是段 C 的地址，不是段 A 的。

段 B 是可选的中间落点：需要跨进程、跨机搬运，或 LMCache 自己缓存时才会出现。它同时也是 LMCache 那条链路的段 C，因为 LMCache 的传输后端注册的就是这块 pinned 内存（%%lmcache/v1/memory_management.py:593%% 把裸指针包成 tensor）。
`,
      },
      {
        id: 'transport',
        title: '字节怎么过去：传输方式',
        lead: '这条链路把「协商」和「搬字节」分得很干净。控制面用 RPC 交换 key、长度和副本位置，数据面才动 KV 本体；数据面自己又分两条路：同进程直接 memcpy，跨进程走注册内存做零拷贝。图的上半是控制面与注册，下半是数据面的判定。',
        diagram: `
<svg viewBox="0 0 1200 660" class="diagram flow-svg" role="img"
     aria-label="传输方式：控制面 RPC、注册与后端选择、数据面零拷贝与拷贝两条路">
  <defs>
    <marker id="tfr" viewBox="0 0 10 10" refX="8" refY="5"
            markerWidth="5.5" markerHeight="5.5" orient="auto">
      <path d="M0,1 L9,5 L0,9 z" fill="#d5c7b0"/>
    </marker>
    <marker id="tfk" viewBox="0 0 10 10" refX="8" refY="5"
            markerWidth="5.5" markerHeight="5.5" orient="auto">
      <path d="M0,1 L9,5 L0,9 z" fill="var(--l3)"/>
    </marker>
  </defs>

  <rect x="20" y="20" width="1160" height="130" rx="10" fill="var(--l1)" fill-opacity=".05" stroke="var(--line)"/>
  <line x1="24" y1="21" x2="1176" y2="21" stroke="var(--l1)" stroke-width="3"/>
  <text x="44" y="46" class="t-title-sm">控制面：只传元数据</text>
  <rect x="40" y="76" width="250" height="52" rx="7" fill="var(--panel)" stroke="var(--line)"/>
  <text x="54" y="98" class="t-title-sm">KVPoolScheduler</text>
  <text x="54" y="117" class="t-mono">ZMQ REQ 发 hash</text>
  <rect x="330" y="76" width="250" height="52" rx="7" fill="var(--panel)" stroke="var(--line)"/>
  <text x="344" y="98" class="t-title-sm">KVPoolWorker</text>
  <text x="344" y="117" class="t-mono">coro_rpc 客户端</text>
  <rect x="620" y="76" width="250" height="52" rx="7" fill="var(--panel)" stroke="var(--line)"/>
  <text x="634" y="98" class="t-title-sm">Mooncake Master</text>
  <text x="634" y="117" class="t-mono">只回副本位置</text>
  <rect x="910" y="76" width="270" height="52" rx="7" fill="var(--panel)" stroke="var(--l3)" stroke-opacity=".5"/>
  <text x="924" y="98" class="t-title-sm">Descriptor</text>
  <text x="924" y="117" class="t-mono">地址加端点，没有字节</text>
  <line x1="290" y1="102" x2="326" y2="102" class="t-line" marker-end="url(#tfr)"/>
  <line x1="580" y1="102" x2="616" y2="102" class="t-line" marker-end="url(#tfr)"/>
  <line x1="870" y1="102" x2="906" y2="102" class="t-line" marker-end="url(#tfr)"/>

  <rect x="20" y="170" width="1160" height="160" rx="10" fill="var(--l4)" fill-opacity=".05" stroke="var(--line)"/>
  <line x1="24" y1="171" x2="1176" y2="171" stroke="var(--l4)" stroke-width="3"/>
  <text x="44" y="196" class="t-title-sm">注册与后端选择：registerLocalMemory 之后才有数据面</text>
  <rect x="40" y="214" width="280" height="64" rx="7" fill="var(--panel)" stroke="var(--line)"/>
  <text x="54" y="238" class="t-title-sm">TransferEngineImpl</text>
  <text x="54" y="258" class="t-mono">registerLocalMemory</text>
  <text x="54" y="273" class="t-mono">遍历所有已装 transport</text>
  <rect x="360" y="214" width="280" height="64" rx="7" fill="var(--panel)" stroke="var(--line)"/>
  <text x="374" y="238" class="t-title-sm">MultiTransport</text>
  <text x="374" y="258" class="t-mono">installTransport(proto)</text>
  <text x="374" y="273" class="t-mono">协议名决定实现类</text>
  <rect x="680" y="196" width="480" height="32" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="694" y="217" class="t-mono">proto 等于 rdma 到 RdmaTransport</text>
  <rect x="680" y="236" width="480" height="32" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="694" y="257" class="t-mono">proto 等于 ascend 且 USE_ASCEND 到 HcclTransport</text>
  <rect x="680" y="276" width="480" height="32" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="694" y="297" class="t-mono">proto 等于 ascend 且 USE_ASCEND_DIRECT 到 HIXL 直连</text>
  <line x1="320" y1="246" x2="356" y2="246" class="t-line" marker-end="url(#tfr)"/>
  <line x1="640" y1="230" x2="676" y2="212" class="t-line" marker-end="url(#tfr)"/>
  <line x1="640" y1="246" x2="676" y2="252" class="t-line" marker-end="url(#tfr)"/>
  <line x1="640" y1="262" x2="676" y2="292" class="t-line" marker-end="url(#tfr)"/>

  <rect x="20" y="350" width="1160" height="290" rx="10" fill="var(--l3)" fill-opacity=".05" stroke="var(--line)"/>
  <line x1="24" y1="351" x2="1176" y2="351" stroke="var(--l3)" stroke-width="3"/>
  <text x="44" y="378" class="t-title-sm">数据面：先判能不能同进程 memcpy，其余走注册内存直读</text>
  <rect x="40" y="404" width="280" height="60" rx="7" fill="var(--panel)" stroke="var(--line)"/>
  <text x="54" y="428" class="t-title-sm">selectStrategy(handle)</text>
  <text x="54" y="448" class="t-mono">canUseLocalMemcpy</text>
  <rect x="400" y="404" width="300" height="60" rx="7" fill="var(--panel)" stroke="var(--line)"/>
  <text x="414" y="428" class="t-title-sm">LOCAL_MEMCPY</text>
  <text x="414" y="448" class="t-mono">appendMemcpyOperations</text>
  <rect x="760" y="404" width="400" height="60" rx="7" fill="var(--panel)" stroke="var(--line)"/>
  <text x="774" y="428" class="t-title-sm">std::memcpy 或加速器 memcpy</text>
  <text x="774" y="448" class="t-mono">要求 endpoint 完全相等</text>
  <rect x="400" y="504" width="300" height="60" rx="7" fill="var(--panel)" stroke="var(--l3)" stroke-opacity=".5"/>
  <text x="414" y="528" class="t-title-sm">TRANSFER_ENGINE</text>
  <text x="414" y="548" class="t-mono">target_offset 加 buffer_address</text>
  <rect x="760" y="504" width="400" height="60" rx="7" fill="var(--panel)" stroke="var(--l3)" stroke-opacity=".5"/>
  <text x="774" y="528" class="t-title-sm">网卡或 ADXL 直读，无 CPU 拷贝</text>
  <text x="774" y="548" class="t-mono">RDMA rkey 或 HIXL MemHandle</text>
  <line x1="320" y1="434" x2="396" y2="434" class="t-line" marker-end="url(#tfr)"/>
  <text x="356" y="428" class="t-mono" text-anchor="middle">是</text>
  <line x1="320" y1="440" x2="396" y2="530" class="t-line" marker-end="url(#tfr)"/>
  <text x="356" y="490" class="t-mono" text-anchor="middle">否</text>
  <line x1="700" y1="434" x2="756" y2="434" class="t-line" marker-end="url(#tfr)"/>
  <line x1="700" y1="534" x2="756" y2="534" stroke="var(--l3)" stroke-width="1.5" marker-end="url(#tfk)"/>
  <text x="44" y="628" class="t-mono-c">注册是前提：没注册过的地址不会出现在 BufferDesc 里，也就到不了对端</text>
</svg>
`,
        html: `
**读图**：三段从上到下依次是控制面 RPC、注册与后端选择、数据面分支。上半所有箭头都只带元数据；下半的判定问的是「能不能把对端地址当本地指针用」，答是则 memcpy，答否则交给传输后端做直接内存访问（DMA）。

### 控制面 RPC：谁用什么协议协商

Mooncake 的 client 与 Master 之间是 %%ylt::coro_rpc%%（%%mooncake-store/include/master_client.h:11%%），默认地址 %%localhost:50051%%（\`:27\`）。把 %%MC_RPC_PROTOCOL%% 设成 %%rdma%% 时，RPC 连接本身改用 %%coro_io::ib_socket_t%%（\`:67\` 与 \`:43\`）。请求体里只有 key、长度、副本配置这类元数据，例如 %%BatchPutStart%% 的签名是 %%client_id, keys, slice_lengths, config, tenant_id%%（%%mooncake-store/src/rpc_service.cpp:444%%），没有任何一个参数是 KV 字节。客户端发起处见 %%mooncake-store/src/client_service.cpp:2519%%。

引擎侧的 lookup 更轻。%%LookupKeyClient%% 用 ZeroMQ 的 %%REQ%% 套接字（%%vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/pool_scheduler.py:1168%%），发出去的是 token 数与 block hash 字符串（\`:1186\`）。这条查询走的是进程间 socket，不带任何 KV。

控制面回来的东西也只是一段描述符：%%Replica::MemoryDescriptor%% 里装着 %%AllocatedBuffer::Descriptor%%（%%mooncake-store/include/replica.h:237%%）。所以「查命中」和「拿地址」都不产生字节搬运。

### 数据面：零拷贝与拷贝两条路

Python 侧进到 C++ 时先做一次 %%uintptr_t%% 到 %%void*%% 的转换，函数是 %%CastAddrs2Ptrs%%（%%mooncake-integration/store/store_py.cpp:470%%），对应的 C++ 类型是：

\`\`\`cpp
struct Slice {
    void* ptr{nullptr};
    size_t size{0};
};
\`\`\`

定义在 %%mooncake-store/include/types.h:421%%。选路在 %%TransferSubmitter::selectStrategy%%（%%mooncake-store/src/transfer_task.cpp:1467%%），判据是 %%canUseLocalMemcpy%%（\`:1475\`）。

判据不是「同主机」，而是「同一进程的虚拟地址空间」：%%isSameProcessEndpoint%% 要求 handle 的 endpoint 与本地 endpoint 完全相等（%%mooncake-store/src/transfer_task.cpp:1481%%）。%%BufferDesc%% 的注释写得很直白：同主机不同进程共享 IP，但各自有独立的虚拟地址空间，拿对端地址做 memcpy 会段错误。

- 走拷贝：%%appendMemcpyOperations%% 把 %%handle.buffer_address_%% 当本地指针用（%%mooncake-store/src/transfer_task.cpp:1180%%），worker 线程执行 %%std::memcpy%%（\`:676\`）。注册前提是两端在同一进程。
- 走零拷贝：%%submitTransferEngineOperation%%（%%mooncake-store/src/transfer_task.cpp:1261%%）把远端地址写成 %%request.target_offset = base_address + offset%%（\`:1291\`），其中 %%base_address%% 就是 %%handle.buffer_address_%%。后端的 DMA 引擎直接读写这块注册内存，CPU 不参与。

中转缓冲只在协议或硬件不支持直接访问时才出现。store 侧备有主机侧的 pinned 缓冲池（%%mooncake-store/include/pinned_buffer_pool.h%%），用于不能直接寻址设备内存的后端；%%protocol%% 为 %%ascend%% 时走设备内存直达；%%MooncakeBackend%% 在构造时就检查这一点，%%config.protocol%% 不是 %%ascend%% 会直接抛 %%NotImplementedError%%（%%vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/backend/mooncake_backend.py:66%%）。

### 后端怎么被选中

协议字符串到实现类的映射在 %%MultiTransport::installTransport%%（%%mooncake-transfer-engine/src/multi_transport.cpp:418%%）。%%proto%% 等于 %%ascend%% 时有三个候选，取决于编译宏：%%USE_ASCEND_DIRECT%% 建 %%AscendDirectTransport%%（\`:469\`），%%USE_ASCEND%% 建 %%HcclTransport%%（\`:474\`），%%USE_ASCEND_HETEROGENEOUS%% 建 %%HeterogeneousRdmaTransport%%；%%rdma%% 则建 %%RdmaTransport%%。装哪个由 %%TransferEngineImpl%% 启动时决定（%%mooncake-transfer-engine/src/transfer_engine_impl.cpp:229%% 一带的 %%installTransport("ascend", ...)%%）。

注册与后端强绑定。%%registerLocalMemory%% 会遍历 %%listTransports()%%，每个 transport 都要注册一遍（%%mooncake-transfer-engine/src/transfer_engine_impl.cpp:678%%），任一失败就回滚已经注册过的（\`:687\`），避免出现「一半 transport 认得、一半不认得」的状态。%%HcclTransport%% 的注册先调 %%regLocalRmaMem%%（%%mooncake-transfer-engine/src/transport/ascend_transport/hccl_transport/hccl_transport.cpp:568%%），再把地址写进元数据服务（\`:574\`）。注册区域数有上限，由 %%ASCEND_TRANSPORT_MAX_REG_MEMORY_NUM%% 控制（%%mooncake-transfer-engine/src/transport/ascend_transport/hccl_transport/ascend_transport_c/hccl_transport_mem_c.cpp:64%%）。

HCCL 的远端内存要经过两次握手才可用：先 %%ExchangeMemDesc%% 交换描述符（%%mooncake-transfer-engine/src/transport/ascend_transport/hccl_transport/ascend_transport_c/hccl_transport_mem_c.cpp:1138%%），再 %%EnableMemAccess%% 拿到可访问的远端内存。

### handle 怎么传

控制面传的是「地址加端点」，数据面传的是「本地地址加远端地址」，两种后端各有自己的句柄形态。

RDMA 的句柄是 %%addr%% 加 %%rkey%%。注册结果随 %%BufferDesc%% 序列化进元数据服务：%%bufferJSON["addr"]%% 与 %%bufferJSON["rkey"]%%（%%mooncake-transfer-engine/src/transfer_metadata.cpp:455%% 与 \`:457\`）。本端要发数据时，从对端 segment 描述里取出 %%rkey%% 填进 slice：

\`\`\`cpp
slice->rdma.dest_rkey =
    peer_segment_desc->buffers[buffer_id].rkey[device_id];
\`\`\`

见 %%mooncake-transfer-engine/src/transport/rdma_transport/worker_pool.cpp:358%%。

HIXL 没有 rkey 这种密钥。注册返回的是 %%hixl::MemHandle%%，本地按地址存表（%%mooncake-transfer-engine/tent/include/tent/transport/ascend/ascend_direct_transport.h:130%%）。发起传输时只填两个地址，%%op_desc.local_addr = task->request.source%% 与 %%op_desc.remote_addr = task->request.target_offset%%（%%mooncake-transfer-engine/tent/src/transport/ascend/ascend_direct_transport.cpp:349%% 与 \`:350\`），路由靠 %%remote_hixl%% 这个名字。

元数据服务本身是可选的：%%conn_string%% 为 %%P2PHANDSHAKE%% 时不建存储插件（%%mooncake-transfer-engine/src/transfer_metadata.cpp:287%%），否则交给 %%MetadataStoragePlugin::Create%%（\`:292\`）。传输引擎初始化时用的正是 %%P2PHANDSHAKE%%（%%vllm_ascend/distributed/kv_transfer/utils/mooncake_transfer_engine.py:26%%），注册调用在 \`:37\`。
`,
      },
    ],
    seams: [
      {
        name: 'KVConnectorBase_V1',
        from: '推理引擎',
        to: 'KV 传输',
        at: 'vllm/distributed/kv_transfer/kv_connector/v1/base.py:454',
        why: '调度阶段就能问出「外部能命中多少 token」，不必等到执行时才发现',
      },
      {
        name: 'MooncakeBackend.put 或 get',
        from: 'KV 传输（引擎侧）',
        to: 'KV 存储',
        at: 'vllm_ascend/distributed/kv_transfer/kv_pool/ascend_store/backend/mooncake_backend.py:189',
        why: '三个后端（mooncake、memcache、yuanrong）在此替换，上层不变',
      },
      {
        name: 'Master RPC',
        from: '控制面',
        to: '数据面',
        at: 'mooncake-store/src/client_service.cpp:2519',
        why: '★ 这里只传位置，不传字节，是全链路最重要的一条分界',
      },
      {
        name: 'registerLocalMemory',
        from: '推理引擎',
        to: '传输引擎',
        at: 'mooncake-transfer-engine/src/transfer_engine_impl.cpp:657',
        why: '未注册的显存无法被网卡访问；HCCL 注册区域数还有上限（%%ASCEND_TRANSPORT_MAX_REG_MEMORY_NUM%%，mooncake-transfer-engine/src/transport/ascend_transport/hccl_transport/ascend_transport_c/hccl_transport_mem_c.cpp:64）',
      },
    ],
    related: ['vllm-ascend', 'ascend-store-connector', 'mooncake', 'hixl', 'cann', 'lmcache-ascend'],
  },

    {
    id: 'kv-formats',
    title: '新模型把 KV block 拆成了什么',
    subtitle: 'MLA、DSA 到 GDN state：形状如何被探测、抽象，并一路传导到缓存与传输层',
    kind: 'data-shape',
    participants: ['lmcache', 'lmcache-ascend', 'vllm', 'vllm-ascend'],
    revisions: [
      { name: 'LMCache', rev: 'b5d109ea' },
      { name: 'LMCache-Ascend（dsv4_support_045）', rev: '1452551' },
      { name: 'vLLM', rev: '568afb3a' },
      { name: 'vLLM-Ascend', rev: 'f2f74a16' },
      { name: 'kvcache-ops', rev: 'c3db0eb' },
      { name: 'lmcache-ascend-combined（本地合成，跳过行号校验）', rev: '452bcf4' },
    ],
    summary: 'DeepSeek V3 的 MLA 把 K 与 V 融成一个潜在向量，V3.2 的 DSA 再加一条 int8 indexer 缓存和它的 fp16 scale，多规格压缩让同一层里出现 block 大小不同的几块缓存；GDN 这类线性注意力不走这条路，只维护每层定长的 conv 与 ssm state。%%lmcache%% 用两个枚举把这件事钉成契约，用 %%detect_format%% 从张量结构反推格式，用 17 个 %%KVFormatSpec%% 子类摊开几何，缓存与传输层再跟着改 stride、指针表顺序、buffer 形状与 scale 的搬法。',
    reading: [
      '**先看总图**。左边一列是 KV 通道，从模型形状经注册、探测、spec 一路走到下游四件事；右边一列是 GDN state 的旁路。两条路的缓存语义不同，混着看会乱。',
      '**四条腿按「形状是什么、怎么认出来、怎么抽象、下游改什么」排列**，每条腿自带一张图，可以单独看懂。想看代码结构直接跳到「关键类型定义」一节。',
      '**锚点基线**：主路径用本 wiki 钉住的 %%LMCache%%、%%vLLM%%、%%vLLM-Ascend%% 与 %%kvcache-ops%% 提交；DSA-C8 与多平面部分对 %%LMCache-Ascend%% 的 %%dsv4_support_045%% 分支（%%1452551%%）校验。GDN state 的六个 %%state_*.py%% 只存在于本地合成快照，相关行号无法复现，正文里已逐处标注。',
    ],
    diagram: `<svg viewBox="0 0 1200 686" class="diagram flow-svg" role="img"
     aria-label="新模型的 KV 形状从模型侧经探测与 spec 传导到缓存与传输层，GDN state 走旁路">
  <defs>
    <marker id="ar0" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,1 L9,5 L0,9 z" fill="#d5c7b0"/>
    </marker>
  </defs>

  <!-- ① 模型侧 -->
  <rect x="20" y="18" width="1160" height="88" rx="10" fill="var(--l2)" fill-opacity=".05" stroke="var(--line)"/>
  <text x="40" y="38" class="t-band" fill="var(--l2)">① 模型侧要的形状</text>
  <rect x="38" y="46" width="360" height="50" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="52" y="66" class="t-title-sm">MLA（DeepSeek V2 / V3）</text>
  <text x="52" y="84" class="t-mono">K 与 V 合成一个潜在向量，维度不对称</text>
  <rect x="420" y="46" width="360" height="50" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="434" y="66" class="t-title-sm">DSA / DSA-C8（V3.2 稀疏）</text>
  <text x="434" y="84" class="t-mono">再加 int8 indexer 与它的 scale</text>
  <rect x="802" y="46" width="360" height="50" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="816" y="66" class="t-title-sm">GDN / KDA 线性注意力</text>
  <text x="816" y="84" class="t-mono">不存 KV，只存每层定长的 conv + ssm state</text>

  <line x1="218" y1="106" x2="218" y2="140" class="t-line" marker-end="url(#ar0)"/>
  <line x1="600" y1="106" x2="600" y2="140" class="t-line" marker-end="url(#ar0)"/>
  <line x1="982" y1="106" x2="982" y2="140" class="t-line" marker-end="url(#ar0)"/>

  <!-- KV 通道 -->
  <rect x="20" y="146" width="870" height="516" rx="10" fill="var(--l3)" fill-opacity=".035" stroke="var(--line)"/>
  <text x="40" y="170" class="t-band" fill="var(--l3)">KV 通道</text>

  <!-- ② engine 注册的 raw 结构 -->
  <text x="42" y="200" class="t-title-sm">② engine 注册出来的 raw 结构</text>
  <rect x="38" y="212" width="262" height="94" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="50" y="232" class="t-mono-c">NL_X_NB_BS_HS</text>
  <text x="50" y="250" class="t-mono">每层一个 3 维张量</text>
  <text x="50" y="266" class="t-mono">vLLM MLA / SGLang MLA</text>
  <text x="50" y="282" class="t-mono">kv_size = 1，单潜在平面</text>
  <text x="50" y="298" class="t-mono">kv_caches[L] = [NB, BS, HS]</text>
  <rect x="318" y="212" width="262" height="94" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="330" y="232" class="t-mono-c">NL_X_NB_BSV_BSS</text>
  <text x="330" y="250" class="t-mono">每层一个 3 维 uint8 张量</text>
  <text x="330" y="266" class="t-mono">DSA indexer k-cache</text>
  <text x="330" y="282" class="t-mono">末维 132 = 128 值 + 4 字节</text>
  <text x="330" y="298" class="t-mono">blocked scales 与值同块</text>
  <rect x="598" y="212" width="272" height="94" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="610" y="232" class="t-mono-c">NL_X_NB_NH_BS_CS</text>
  <text x="610" y="250" class="t-mono">每层一个 4 维张量</text>
  <text x="610" y="266" class="t-mono">K/V 融合进末维 content_size</text>
  <text x="610" y="282" class="t-mono">HND 时是 NL_X_NB_BS_NH_CS</text>
  <text x="610" y="298" class="t-mono">kv_size = 1</text>

  <line x1="455" y1="306" x2="455" y2="338" class="t-line" marker-end="url(#ar0)"/>

  <!-- ③ 探测 + 枚举 + spec -->
  <text x="42" y="334" class="t-title-sm">③ 探测与两个枚举</text>
  <rect x="38" y="346" width="262" height="110" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="50" y="366" class="t-mono-c">detect_format()</text>
  <text x="50" y="384" class="t-mono">attempt_permute 恢复物理布局</text>
  <text x="50" y="400" class="t-mono">get_detector(engine)</text>
  <text x="50" y="416" class="t-mono">→ EngineDetector.discover()</text>
  <text x="50" y="432" class="t-mono">只看张量与列表结构</text>
  <text x="50" y="448" class="t-mono">认不出就抛 ValueError</text>
  <rect x="318" y="346" width="262" height="110" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="330" y="366" class="t-mono-c">EngineKVFormat</text>
  <text x="330" y="384" class="t-mono">C++ enum class，17 个值</text>
  <text x="330" y="400" class="t-mono">名字就是形状</text>
  <text x="330" y="416" class="t-mono">A_X_B_X_C_D_E 记法</text>
  <text x="330" y="432" class="t-mono">pyi 与纯 Python 各一份</text>
  <text x="330" y="448" class="t-mono">整数下标即内核取值</text>
  <rect x="598" y="346" width="272" height="110" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="610" y="366" class="t-mono-c">KVFormatSpec</text>
  <text x="610" y="384" class="t-mono">17 个 spec 类，一个格式一个</text>
  <text x="610" y="400" class="t-mono">3 个结构位 + 6 个修饰位</text>
  <text x="610" y="416" class="t-mono">registry 扫目录自动索引</text>
  <text x="610" y="432" class="t-mono">borrow 而不 own kv_caches</text>
  <text x="610" y="448" class="t-mono">FormatFacts 是 C++ 的镜像</text>

  <line x1="455" y1="456" x2="455" y2="488" class="t-line" marker-end="url(#ar0)"/>

  <!-- ④ 下游四件事 -->
  <text x="42" y="484" class="t-title-sm">④ 缓存与传输跟着改的四件事</text>
  <rect x="38" y="496" width="196" height="146" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="50" y="516" class="t-mono-c">block stride</text>
  <text x="50" y="536" class="t-mono">stride(0) 是每 block 步长</text>
  <text x="50" y="552" class="t-mono">只有 block 轴在 dim-0</text>
  <text x="50" y="568" class="t-mono">的格式允许 padding</text>
  <text x="50" y="588" class="t-mono">DeepSeek V4 的</text>
  <text x="50" y="604" class="t-mono">compressor / indexer</text>
  <text x="50" y="620" class="t-mono">与更大的 attn group</text>
  <text x="50" y="636" class="t-mono">共用一个 pool</text>
  <rect x="246" y="496" width="196" height="146" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="258" y="516" class="t-mono-c">指针表</text>
  <text x="258" y="536" class="t-mono">data_ptrs() 按格式出</text>
  <text x="258" y="552" class="t-mono">MLA 每层 1 个</text>
  <text x="258" y="568" class="t-mono">DSA 每层 3 个</text>
  <text x="258" y="584" class="t-mono">DSA-C8 每层 4 个</text>
  <text x="258" y="600" class="t-mono">每层元组按 K,V 交错</text>
  <text x="258" y="616" class="t-mono">MULTI_PLANE 变长</text>
  <text x="258" y="632" class="t-mono">每个 plane 各一套调度组</text>
  <rect x="454" y="496" width="196" height="146" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="466" y="516" class="t-mono-c">MemoryObj 形状</text>
  <text x="466" y="536" class="t-mono">MLA: 每 token</text>
  <text x="466" y="552" class="t-mono">kv_lora_rank + qk_rope</text>
  <text x="466" y="568" class="t-mono">DSA: 再加 dsa_head_dim</text>
  <text x="466" y="584" class="t-mono">DSA-C8: 每 token</text>
  <text x="466" y="600" class="t-mono">一个字节行</text>
  <text x="466" y="616" class="t-mono">字节行按 32 字节对齐后</text>
  <text x="466" y="632" class="t-mono">摊回每 token</text>
  <rect x="662" y="496" width="208" height="146" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="674" y="516" class="t-mono-c">量化 scale</text>
  <text x="674" y="536" class="t-mono">每 plane 一个字节宽</text>
  <text x="674" y="552" class="t-mono">DSA-C8 必须给 4 个</text>
  <text x="674" y="568" class="t-mono">scale 与所属 plane</text>
  <text x="674" y="584" class="t-mono">一起搬</text>
  <text x="674" y="600" class="t-mono">落盘时 V 的 scale 有</text>
  <text x="674" y="616" class="t-mono">per-tensor / per-layer-head</text>
  <text x="674" y="632" class="t-mono">/ per-page-head 三档</text>

  <!-- GDN 旁路 -->
  <rect x="910" y="146" width="270" height="516" rx="10" fill="var(--l1)" fill-opacity=".04" stroke="var(--line)"/>
  <text x="930" y="170" class="t-band" fill="var(--l1)">GDN 旁路</text>
  <rect x="928" y="184" width="234" height="82" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="940" y="204" class="t-title-sm">state 的形状</text>
  <text x="940" y="224" class="t-mono">conv_state: conv_dim 与 K-1</text>
  <text x="940" y="240" class="t-mono">ssm_state: NH x HV x HK</text>
  <text x="940" y="256" class="t-mono">三个维都与 token 数无关</text>
  <rect x="928" y="278" width="234" height="82" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="940" y="298" class="t-title-sm">写入方式</text>
  <text x="940" y="318" class="t-mono">ssm_state[slot] =</text>
  <text x="940" y="334" class="t-mono">last_recurrent_state</text>
  <text x="940" y="350" class="t-mono">原地覆盖，不追加</text>
  <rect x="928" y="372" width="234" height="98" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="940" y="392" class="t-title-sm">checkpoint 粒度</text>
  <text x="940" y="412" class="t-mono">边界对齐 mamba_block_size</text>
  <text x="940" y="428" class="t-mono">chunk_stride =</text>
  <text x="940" y="444" class="t-mono">mamba_block_size / chunk</text>
  <text x="940" y="460" class="t-mono">只在 complete chunk 上建</text>
  <rect x="928" y="482" width="234" height="82" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="940" y="502" class="t-title-sm">传输</text>
  <text x="940" y="522" class="t-mono">参数只有 blockId 与</text>
  <text x="940" y="538" class="t-mono">sliceNumel，没有 token 轴</text>
  <text x="940" y="554" class="t-mono">每层一个指针，层内连续</text>
  <rect x="928" y="576" width="234" height="70" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="940" y="596" class="t-title-sm">dtype</text>
  <text x="940" y="616" class="t-mono">kernel 只声明 FP32 与 BF16</text>
  <text x="940" y="632" class="t-mono">没有 FP8 / int8 路径</text>
</svg>`,
    legs: [
      {
        id: 'shapes',
        layer: 'engine',
        title: '一个 KV block 的六种形状',
        direction: 'out',
        lead: 'MLA 之后，一个 layer 的 KV 不再是一对同形状的张量。下面把 %%KVCacheFormat%% 的六种可用取值逐层画出来，每一格给出成员数、每个成员的形状与它带来的指针数；后两格是 DSA 之后才出现的 plane。',
        diagram: `<svg viewBox="0 0 1200 430" class="diagram flow-svg" role="img"
     aria-label="六种 KVCacheFormat 的每层条目形状并列对照">
  <text x="20" y="22" class="t-band" fill="var(--l2)">六种格式 · 一个 layer 的条目</text>

  <rect x="20" y="34" width="178" height="366" rx="8" fill="var(--l4)" fill-opacity=".05" stroke="var(--line)"/>
  <text x="32" y="56" class="t-title-sm" style="font-size:11.5px">MERGED_KV</text>
  <rect x="32" y="68" width="154" height="34" rx="5" fill="var(--bg)" stroke="var(--line)"/>
  <text x="42" y="82" class="t-mono">单个张量</text>
  <text x="42" y="96" class="t-mono">[2, NB, BS, NH, HS]</text>
  <line x1="32" y1="118" x2="186" y2="118" stroke="var(--line)"/>
  <text x="32" y="138" class="t-mono">K 与 V 共用 block 轴</text>
  <text x="32" y="156" class="t-mono">flash attention 时轴 0 = 2</text>
  <text x="32" y="174" class="t-mono">flash infer 时轴 1 = 2</text>
  <text x="32" y="192" class="t-mono">vLLM 0.9.2 的注册形态</text>
  <text x="32" y="356" class="t-mono-c">kv_size = 1</text>
  <text x="32" y="378" class="t-mono">一个指针就够</text>

  <rect x="217" y="34" width="178" height="366" rx="8" fill="var(--l4)" fill-opacity=".05" stroke="var(--line)"/>
  <text x="229" y="56" class="t-title-sm" style="font-size:11.5px">SEPARATE_KV</text>
  <rect x="229" y="68" width="154" height="34" rx="5" fill="var(--bg)" stroke="var(--line)"/>
  <text x="239" y="82" class="t-mono">K_tensor</text>
  <text x="239" y="96" class="t-mono">[NB, BS, NH, HS]</text>
  <rect x="229" y="108" width="154" height="34" rx="5" fill="var(--bg)" stroke="var(--line)"/>
  <text x="239" y="122" class="t-mono">V_tensor</text>
  <text x="239" y="136" class="t-mono">[NB, BS, NH, HS]</text>
  <line x1="229" y1="158" x2="383" y2="158" stroke="var(--line)"/>
  <text x="229" y="178" class="t-mono">两个形状完全相同的张量</text>
  <text x="229" y="196" class="t-mono">vLLM 0.11.0+ 默认注册</text>
  <text x="229" y="214" class="t-mono">SGLang NPU 走</text>
  <text x="229" y="232" class="t-mono">layer-concatenated 形态</text>
  <text x="229" y="356" class="t-mono-c">kv_size = 2</text>
  <text x="229" y="378" class="t-mono">K 表在前、V 表在后</text>

  <rect x="414" y="34" width="178" height="366" rx="8" fill="var(--l3)" fill-opacity=".05" stroke="var(--line)"/>
  <text x="426" y="56" class="t-title-sm" style="font-size:11.5px">MLA_KV</text>
  <rect x="426" y="68" width="154" height="34" rx="5" fill="var(--bg)" stroke="var(--line)"/>
  <text x="436" y="82" class="t-mono">k_cache</text>
  <text x="436" y="96" class="t-mono">[NB, BS, NH, lora_rank]</text>
  <rect x="426" y="108" width="154" height="34" rx="5" fill="var(--bg)" stroke="var(--line)"/>
  <text x="436" y="122" class="t-mono">v_cache</text>
  <text x="436" y="136" class="t-mono">[NB, BS, NH, rope_dim]</text>
  <line x1="426" y1="158" x2="580" y2="158" stroke="var(--line)"/>
  <text x="426" y="178" class="t-mono">K 与 V 维度不等</text>
  <text x="426" y="196" class="t-mono">这是唯一的判定依据</text>
  <text x="426" y="214" class="t-mono">kv_lora_rank 约 512</text>
  <text x="426" y="232" class="t-mono">qk_rope_head_dim 约 64</text>
  <text x="426" y="356" class="t-mono-c">kv_size = 2</text>
  <text x="426" y="378" class="t-mono">两个指针，形状不同</text>

  <rect x="611" y="34" width="178" height="366" rx="8" fill="var(--l1)" fill-opacity=".05" stroke="var(--line)"/>
  <text x="623" y="56" class="t-title-sm" style="font-size:11.5px">DSA_KV</text>
  <rect x="623" y="68" width="154" height="34" rx="5" fill="var(--bg)" stroke="var(--line)"/>
  <text x="633" y="82" class="t-mono">k_cache</text>
  <text x="633" y="96" class="t-mono">[NB, BS, NH, lora_rank]</text>
  <rect x="623" y="108" width="154" height="34" rx="5" fill="var(--bg)" stroke="var(--line)"/>
  <text x="633" y="122" class="t-mono">v_cache</text>
  <text x="633" y="136" class="t-mono">[NB, BS, NH, rope_dim]</text>
  <rect x="623" y="148" width="154" height="34" rx="5" fill="var(--bg)" stroke="var(--line)"/>
  <text x="633" y="162" class="t-mono">dsa_k_cache</text>
  <text x="633" y="176" class="t-mono">[NB, BS, 1, 128]</text>
  <line x1="623" y1="198" x2="777" y2="198" stroke="var(--line)"/>
  <text x="623" y="218" class="t-mono">多一条 lightning indexer 的 k</text>
  <text x="623" y="236" class="t-mono">head 数固定为 1</text>
  <text x="623" y="254" class="t-mono">128 = 每 token 128 字节</text>
  <text x="623" y="356" class="t-mono-c">kv_size = 3</text>
  <text x="623" y="378" class="t-mono">三个指针</text>

  <rect x="808" y="34" width="178" height="366" rx="8" fill="var(--l1)" fill-opacity=".05" stroke="var(--line)"/>
  <text x="820" y="56" class="t-title-sm" style="font-size:11.5px">DSA_C8_KV</text>
  <rect x="820" y="68" width="154" height="34" rx="5" fill="var(--bg)" stroke="var(--line)"/>
  <text x="830" y="82" class="t-mono">k_cache / v_cache</text>
  <text x="830" y="96" class="t-mono">bf16，形状同 MLA</text>
  <rect x="820" y="108" width="154" height="34" rx="5" fill="var(--bg)" stroke="var(--line)"/>
  <text x="830" y="122" class="t-mono">dsa_k_cache</text>
  <text x="830" y="136" class="t-mono">int8，[NB, BS, 1, 128]</text>
  <rect x="820" y="148" width="154" height="34" rx="5" fill="var(--bg)" stroke="var(--line)"/>
  <text x="830" y="162" class="t-mono">dsa_k_scale_cache</text>
  <text x="830" y="176" class="t-mono">fp16，[NB, BS, 1, 1]</text>
  <line x1="820" y1="198" x2="974" y2="198" stroke="var(--line)"/>
  <text x="820" y="218" class="t-mono">四个成员的 dtype 各不相同</text>
  <text x="820" y="236" class="t-mono">slot 索引在成员间对齐</text>
  <text x="820" y="254" class="t-mono">num_blocks 与 block_size 一致</text>
  <text x="820" y="356" class="t-mono-c">kv_size = 4</text>
  <text x="820" y="378" class="t-mono">四个指针，缺一不可</text>

  <rect x="1005" y="34" width="178" height="366" rx="8" fill="var(--l2)" fill-opacity=".05" stroke="var(--line)"/>
  <text x="1017" y="56" class="t-title-sm" style="font-size:11.5px">MULTI_PLANE_KV</text>
  <rect x="1017" y="68" width="154" height="34" rx="5" fill="var(--bg)" stroke="var(--line)"/>
  <text x="1027" y="82" class="t-mono">plane 0 · bs = 16</text>
  <text x="1027" y="96" class="t-mono">压缩主 KV</text>
  <rect x="1017" y="108" width="154" height="34" rx="5" fill="var(--bg)" stroke="var(--line)"/>
  <text x="1027" y="122" class="t-mono">plane 1 · bs = 128</text>
  <text x="1027" y="136" class="t-mono">SWA 或 indexer 缓存</text>
  <rect x="1017" y="148" width="154" height="34" rx="5" fill="var(--bg)" stroke="var(--line)"/>
  <text x="1027" y="162" class="t-mono">plane 2 · bs = 128</text>
  <text x="1027" y="176" class="t-mono">独立 slot mapping</text>
  <line x1="1017" y1="198" x2="1171" y2="198" stroke="var(--line)"/>
  <text x="1017" y="218" class="t-mono">planes 数量与 block 大小可变</text>
  <text x="1017" y="236" class="t-mono">相等 block size 时只能靠</text>
  <text x="1017" y="254" class="t-mono">MultiPlaneBundle 构造期标记</text>
  <text x="1017" y="356" class="t-mono-c">kv_size = 0</text>
  <text x="1017" y="378" class="t-mono">没有固定 stride</text>
</svg>`,
        steps: [
          { t: '读一个 layer 的条目，按元素类型分流', a: 'lmcache_ascend/v1/kv_format.py:231', note: '%%detect()%% 只看 %%kvcaches[0]%% 是张量还是元组、元组有几个元素，不看任何「我是 MLA」的标志位' },
          { t: 'MERGED_KV：K/V 轴与 block 轴叠在一个张量里', a: 'lmcache_ascend/v1/kv_format.py:138', note: '形状是 %%[2, num_blocks, block_size, num_heads, head_dim]%%，K 与 V 共用一条 block 轴，所以只需要一个指针' },
          { t: 'SEPARATE_KV：两个形状相同的张量', a: 'lmcache_ascend/v1/kv_format.py:143', note: '这个值还兼任 SGLang NPU 的 layer-concatenated 注册形态，那里 K 与 V 各自是一个 5 维张量' },
          { t: 'MLA_KV：靠 K 与 V 的维度不等识别', a: 'lmcache_ascend/v1/kv_format.py:160', note: 'k 的末维是 %%kv_lora_rank%%，v 的末维是 %%qk_rope_head_dim%%，两者不相等这一点是全篇唯一的形状判据' },
          { t: 'DSA_KV：多一条 lightning indexer 的 k', a: 'lmcache_ascend/v1/kv_format.py:171', note: '%%dsa_k_cache%% 形状是 %%[num_blocks, block_size, 1, 128]%%，head 数固定为 1，末维 128 是每 token 的字节数' },
          { t: 'DSA_C8_KV：再挂一个 fp16 scale 平面', a: 'lmcache_ascend/v1/kv_format.py:184', note: '四元组 %%k_cache, v_cache, dsa_k_cache, dsa_k_scale_cache%% 的 dtype 各不相同，%%dsa_k_scale%% 是 %%[num_blocks, block_size, 1, 1]%%' },
          { t: '确认四个成员的 slot 索引对齐', a: 'lmcache_ascend/v1/kv_format.py:179', note: '%%num_blocks%% 与 %%block_size%% 在四个成员上一致，这是同一个 block 号能索引到四份数据的前提' },
          { t: 'MULTI_PLANE_KV：平面数与 block 大小都可变', a: 'lmcache_ascend/v1/kv_format.py:188', note: '多规格压缩把 block_size 不同的几块缓存捆在一层，比如压缩主 KV 每 16 token 一行、indexer 每 128 token 一行' },
          { t: '同 block size 时靠构造期标记兜底', a: 'lmcache_ascend/v1/kv_format.py:19', note: 'block size 相等的 bundle 与普通 %%SEPARATE_KV%% 形状完全一致，只能靠 %%MultiPlaneBundle%% 这个 tuple 子类标记' },
          { t: '把共享 storage 的视图排除在多平面之外', a: 'lmcache_ascend/v1/kv_format.py:89', note: '同一块内存上的 bf16 与 int8 重解释视图 storage 相同、起始地址也相同，它们是同一个物理分配，不是多个平面' },
          { t: '对到 C++ 侧的整数值', a: 'third_party/kvcache-ops/kernels/types.h:29', note: 'C++ 侧在钉住的 %%c3db0eb%% 上只声明了 %%UNDEFINED%% 到 %%DSA_KV%% 四个值，%%DSA_C8_KV%% 与 %%MULTI_PLANE_KV%% 的数值在头文件里没有对应成员；%%lmcache_ascend/v1/kv_format.py:180%% 与 %%lmcache_ascend/v1/kv_format.py:191%% 的 docstring 却要求两边一致' },
        ],
      },
      {
        id: 'detect',
        layer: 'engine',
        title: '形状怎么被探测出来',
        direction: 'in',
        lead: '%%detect_format%% 读的是张量与列表的结构，不是引擎自报的格式。判定有固定顺序，位置越靠前的条件越优先；命中即返回，不匹配任何分支就抛错。',
        diagram: `<svg viewBox="0 0 1200 520" class="diagram flow-svg" role="img"
     aria-label="vLLM 分支的 KV 格式判定顺序与六个返回结果">
  <defs>
    <marker id="ar2" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,1 L9,5 L0,9 z" fill="#d5c7b0"/>
    </marker>
  </defs>
  <text x="20" y="22" class="t-band" fill="var(--l3)">判定顺序 · 位置即优先级</text>

  <rect x="360" y="34" width="480" height="44" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="600" y="52" class="t-title-sm" text-anchor="middle">detect_format(kv_caches, serving_engine, hints)</text>
  <text x="600" y="68" class="t-mono" text-anchor="middle">先做一次零拷贝的连续视图恢复</text>
  <line x1="600" y1="78" x2="600" y2="96" class="t-line" marker-end="url(#ar2)"/>

  <rect x="360" y="98" width="480" height="44" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="600" y="116" class="t-title-sm" text-anchor="middle">get_detector(serving_engine).discover()</text>
  <text x="600" y="132" class="t-mono" text-anchor="middle">engine 决定读哪套分支，形状决定返回值</text>
  <line x1="600" y1="142" x2="600" y2="160" class="t-line" marker-end="url(#ar2)"/>

  <rect x="360" y="162" width="480" height="52" rx="7" fill="var(--l3)" fill-opacity=".07" stroke="var(--line)"/>
  <text x="600" y="180" class="t-title-sm" text-anchor="middle">先判融合 K/V：kv_caches[0].dim() == 4</text>
  <text x="600" y="198" class="t-mono" text-anchor="middle">命中则直接返回 NL_X_NB_NH_BS_CS（HND）或 NL_X_NB_BS_NH_CS（NHD）</text>

  <line x1="600" y1="214" x2="600" y2="238" class="t-line"/>
  <line x1="111" y1="238" x2="1089" y2="238" stroke="#d5c7b0" stroke-width="1.5"/>
  <line x1="111" y1="238" x2="111" y2="252" class="t-line" marker-end="url(#ar2)"/>
  <line x1="306" y1="238" x2="306" y2="252" class="t-line" marker-end="url(#ar2)"/>
  <line x1="501" y1="238" x2="501" y2="252" class="t-line" marker-end="url(#ar2)"/>
  <line x1="696" y1="238" x2="696" y2="252" class="t-line" marker-end="url(#ar2)"/>
  <line x1="891" y1="238" x2="891" y2="252" class="t-line" marker-end="url(#ar2)"/>
  <line x1="1086" y1="238" x2="1086" y2="252" class="t-line" marker-end="url(#ar2)"/>

  <rect x="22" y="254" width="178" height="52" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="111" y="274" class="t-mono-c" text-anchor="middle">list_depth == 0</text>
  <text x="111" y="292" class="t-mono" text-anchor="middle">整块就是一个张量</text>
  <rect x="217" y="254" width="178" height="52" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="306" y="274" class="t-mono-c" text-anchor="middle">depth 1 · ndim 5</text>
  <text x="306" y="292" class="t-mono" text-anchor="middle">shape[0] == 2</text>
  <rect x="412" y="254" width="178" height="52" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="501" y="274" class="t-mono-c" text-anchor="middle">depth 1 · ndim 5</text>
  <text x="501" y="292" class="t-mono" text-anchor="middle">shape[1] == 2</text>
  <rect x="607" y="254" width="178" height="52" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="696" y="274" class="t-mono-c" text-anchor="middle">depth 1 · ndim 3</text>
  <text x="696" y="292" class="t-mono" text-anchor="middle">末维是否 132 且 uint8</text>
  <rect x="802" y="254" width="178" height="52" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="891" y="274" class="t-mono-c" text-anchor="middle">depth 1 · ndim 6</text>
  <text x="891" y="292" class="t-mono" text-anchor="middle">shape[3] == 1</text>
  <rect x="997" y="254" width="181" height="52" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="1088" y="274" class="t-mono-c" text-anchor="middle">depth 2</text>
  <text x="1088" y="292" class="t-mono" text-anchor="middle">kv_caches[0] 长度 2</text>

  <rect x="22" y="314" width="178" height="104" rx="6" fill="var(--l4)" fill-opacity=".06" stroke="var(--line)"/>
  <text x="111" y="334" class="t-mono-c" text-anchor="middle" style="font-size:9.5px">NB_NL_TWO_BS_NH_HS</text>
  <text x="111" y="352" class="t-mono" text-anchor="middle">cross-layer</text>
  <text x="111" y="370" class="t-mono" text-anchor="middle">layer 轴在第 1 维</text>
  <text x="111" y="388" class="t-mono" text-anchor="middle">vLLM CROSS_LAYER</text>
  <text x="111" y="406" class="t-mono" text-anchor="middle">TRT-LLM 也走这里</text>

  <rect x="217" y="314" width="178" height="104" rx="6" fill="var(--l3)" fill-opacity=".06" stroke="var(--line)"/>
  <text x="306" y="334" class="t-mono-c" text-anchor="middle" style="font-size:9.5px">NL_X_TWO_NB_NH_BS_HS</text>
  <text x="306" y="352" class="t-mono" text-anchor="middle">HND 时取这个</text>
  <text x="306" y="374" class="t-mono-c" text-anchor="middle" style="font-size:9.5px">NL_X_TWO_NB_BS_NH_HS</text>
  <text x="306" y="392" class="t-mono" text-anchor="middle">NHD 时取这个</text>
  <text x="306" y="410" class="t-mono" text-anchor="middle">两者形状相同</text>

  <rect x="412" y="314" width="178" height="104" rx="6" fill="var(--l3)" fill-opacity=".06" stroke="var(--line)"/>
  <text x="501" y="334" class="t-mono-c" text-anchor="middle" style="font-size:9.5px">NL_X_NB_TWO_NH_BS_HS</text>
  <text x="501" y="352" class="t-mono" text-anchor="middle">HND 时取这个</text>
  <text x="501" y="374" class="t-mono-c" text-anchor="middle" style="font-size:9.5px">NL_X_NB_TWO_BS_NH_HS</text>
  <text x="501" y="392" class="t-mono" text-anchor="middle">NHD 时取这个</text>
  <text x="501" y="410" class="t-mono" text-anchor="middle">K/V 轴在第 1 维</text>

  <rect x="607" y="314" width="178" height="104" rx="6" fill="var(--l1)" fill-opacity=".06" stroke="var(--line)"/>
  <text x="696" y="334" class="t-mono-c" text-anchor="middle" style="font-size:9.5px">NL_X_NB_BSV_BSS</text>
  <text x="696" y="352" class="t-mono" text-anchor="middle">uint8 且末维 132</text>
  <text x="696" y="370" class="t-mono" text-anchor="middle">DSA indexer 缓存</text>
  <text x="696" y="392" class="t-mono-c" text-anchor="middle" style="font-size:9.5px">NL_X_NB_BS_HS</text>
  <text x="696" y="410" class="t-mono" text-anchor="middle">否则按 MLA 处理</text>

  <rect x="802" y="314" width="178" height="104" rx="6" fill="var(--l2)" fill-opacity=".06" stroke="var(--line)"/>
  <text x="891" y="334" class="t-mono-c" text-anchor="middle" style="font-size:9.5px">NL_X_TWO_NB_NH_</text>
  <text x="891" y="348" class="t-mono-c" text-anchor="middle" style="font-size:9.5px">ONE_BS_HS</text>
  <text x="891" y="366" class="t-mono" text-anchor="middle">vLLM-RBLN</text>
  <text x="891" y="384" class="t-mono" text-anchor="middle">heads 与 block tokens</text>
  <text x="891" y="402" class="t-mono" text-anchor="middle">之间夹一个单例维</text>

  <rect x="997" y="314" width="181" height="104" rx="6" fill="var(--l2)" fill-opacity=".06" stroke="var(--line)"/>
  <text x="1088" y="334" class="t-mono-c" text-anchor="middle" style="font-size:9.5px">NL_X_TWO_X_NB_BS_NH_HS</text>
  <text x="1088" y="352" class="t-mono" text-anchor="middle">每层一个 (K, V) 元组</text>
  <text x="1088" y="370" class="t-mono" text-anchor="middle">vLLM-Ascend 的</text>
  <text x="1088" y="388" class="t-mono" text-anchor="middle">per-layer 注册</text>
  <text x="1088" y="406" class="t-mono" text-anchor="middle">指针按 K,V 交错</text>

  <line x1="20" y1="438" x2="1180" y2="438" stroke="var(--line)"/>
  <text x="20" y="458" class="t-mono">HND 与 NHD 的每层 shape 完全相同，只有 stride 不同。is_hnd 来自 layout_hints，不来自形状。</text>
  <text x="20" y="476" class="t-mono">SGLang 分支另有一套：有无 tokens_per_block 决定 PBS 轴是否已融合，NL_X_NBBS_ONE_HS 只在没有该 hint 时出现。</text>
  <text x="20" y="494" class="t-mono">所有分支都不匹配时 discover 返回 None，detect_format 抛 ValueError。没有兜底猜测，也没有默认格式。</text>
</svg>`,
        steps: [
          { t: '从入口进入，先做一次零拷贝的布局恢复', a: 'lmcache/v1/gpu_connector/kv_format/detection.py:62', note: '%%attempt_permute_to_contiguous_view%% 按 stride 大小重排维度，把 vLLM 那种「物理是 HND、逻辑报 NHD」的视图还原成形状即物理的样子' },
          { t: '只接受 block 轴在 dim-0 的 padding', a: 'lmcache/v1/gpu_connector/kv_format/contiguity.py:97', note: '重排后仍不连续的张量会走这里；注释写明它服务的是 DeepSeek V4 的 compressor 与 indexer 缓存，其余非连续形态一律报错' },
          { t: '按 engine 选 detector', a: 'lmcache/v1/gpu_connector/kv_format/detectors/registry.py:20', note: '四个 detector 由目录扫描得到，%%engine_type%% 是索引键；没有对应 detector 时 %%detect_format%% 直接抛错' },
          { t: '解析 kv_layout 提示，定出 HND 还是 NHD', a: 'lmcache/v1/gpu_connector/kv_format/detectors/vllm.py:26', note: 'hint 缺失时回退到「CPU 后端用 HND、其余用 NHD」（%%lmcache/v1/gpu_connector/kv_format/detectors/vllm.py:34%%），这个回退是为了兼容不传 hint 的旧注册' },
          { t: '先判融合 K/V 的 rank-4 形态', a: 'lmcache/v1/gpu_connector/kv_format/detectors/vllm.py:64', note: '%%kv_caches[0].dim() == 4%% 是唯一的 rank-4 vLLM 布局，不会与 5 维拆分混淆；HND 与 NHD 两种 blocks-first 视图只差 %%stride(0)%%' },
          { t: '量出列表深度与内部张量维数', a: 'lmcache/v1/gpu_connector/kv_format/detectors/base.py:20', note: '%%measure_list_depth_until_tensor%% 只沿第一个元素下潜，回传 %%list_depth%% 与 %%tensor_ndim%% 两个数，后续分支全部由这两个数加几个 shape 分量决定' },
          { t: '5 维时用 K/V 轴的位置区分两组格式', a: 'lmcache/v1/gpu_connector/kv_format/detectors/vllm.py:89', note: '%%shape[0] == 2%% 走 %%NL_X_TWO_NB_*%%，%%shape[1] == 2%% 走 %%NL_X_NB_TWO_*%%；再乘上 is_hnd，一个条件分出四个格式' },
          { t: '3 维时用 uint8 加末维 132 认出 DSA indexer', a: 'lmcache/v1/gpu_connector/kv_format/detectors/vllm.py:99', note: '否则按 MLA 处理；这两个格式的几何读法完全相同，差别只在物理页内值与 scale 的排布' },
          { t: '2 层嵌套且每层是二元组时走 per-layer 元组格式', a: 'lmcache/v1/gpu_connector/kv_format/detectors/vllm.py:103', note: '这是 vLLM-Ascend 的注册形态，指针顺序也随格式变成 K 与 V 交错' },
          { t: 'SGLang 分支看 tokens_per_block 提示决定 PBS 是否融合', a: 'lmcache/v1/gpu_connector/kv_format/detectors/sglang.py:90', note: '没有该 hint 走 %%NL_X_NBBS_ONE_HS%%（PBS 已融合），有则先 reshape 回 %%NL_X_NB_BS_HS%%' },
          { t: '认不出就抛错，不做兜底猜测', a: 'lmcache/v1/gpu_connector/kv_format/detection.py:67', note: '%%discover%% 返回 %%None%% 时 %%detect_format%% 抛 %%ValueError%%；没有默认格式，因为几何读错会把数据搬到错误的地址' },
        ],
      },
      {
        id: 'spec',
        layer: 'engine',
        title: '形状怎么被抽象成 spec',
        direction: 'in',
        lead: '格式认出来之后，几何问题全部转给一个 spec 对象。%%KVFormatSpec%% 把「有哪些轴、各是几」做成方法，把「这个格式是什么样」做成类属性；下面这张矩阵就是类属性在 17 个格式上的完整取值。',
        diagram: `<svg viewBox="0 0 1200 500" class="diagram flow-svg" role="img"
     aria-label="EngineKVFormat 到结构位与修饰位的完整事实矩阵">
  <text x="20" y="22" class="t-band" fill="var(--l2)">FormatFacts · 17 个格式 × 9 个布尔位</text>

  <text x="366" y="42" class="t-title-sm" fill="var(--l2)">结构位（恰好一个为真）</text>
  <text x="636" y="42" class="t-title-sm" fill="var(--l3)">修饰位（可叠加）</text>
  <text x="368" y="62" class="t-mono" text-anchor="middle">全层融合</text>
  <text x="458" y="62" class="t-mono" text-anchor="middle">K/V 两表</text>
  <text x="548" y="62" class="t-mono" text-anchor="middle">逐层列表</text>
  <text x="638" y="62" class="t-mono" text-anchor="middle">mla</text>
  <text x="728" y="62" class="t-mono" text-anchor="middle">hnd</text>
  <text x="818" y="62" class="t-mono" text-anchor="middle">融合尾维</text>
  <text x="908" y="62" class="t-mono" text-anchor="middle">TWO 在前</text>
  <text x="998" y="62" class="t-mono" text-anchor="middle">PBS 合并</text>
  <text x="1088" y="62" class="t-mono" text-anchor="middle">元组每层</text>
  <line x1="20" y1="70" x2="1180" y2="70" stroke="var(--line)"/>
  <line x1="592" y1="34" x2="592" y2="452" stroke="var(--l3-dim)"/>
  <line x1="636" y1="34" x2="636" y2="452" stroke="var(--line)"/>

  <text x="20" y="90" class="t-mono" style="font-size:9.5px">NB_NL_TWO_BS_NH_HS</text>
  <circle cx="368" cy="86" r="4.5" fill="var(--l2)"/>
  <text x="20" y="112" class="t-mono" style="font-size:9.5px">NL_X_TWO_NB_BS_NH_HS</text>
  <circle cx="548" cy="108" r="4.5" fill="var(--l2)"/>
  <circle cx="908" cy="108" r="4.5" fill="var(--l3)"/>
  <text x="20" y="134" class="t-mono" style="font-size:9.5px">NL_X_NB_TWO_BS_NH_HS</text>
  <circle cx="548" cy="130" r="4.5" fill="var(--l2)"/>
  <text x="20" y="156" class="t-mono" style="font-size:9.5px">NL_X_NB_BS_HS</text>
  <circle cx="548" cy="152" r="4.5" fill="var(--l2)"/>
  <circle cx="638" cy="152" r="4.5" fill="var(--l3)"/>
  <text x="20" y="178" class="t-mono" style="font-size:9.5px">TWO_X_NL_X_NBBS_NH_HS</text>
  <circle cx="458" cy="174" r="4.5" fill="var(--l2)"/>
  <text x="20" y="200" class="t-mono" style="font-size:9.5px">NL_X_NBBS_ONE_HS</text>
  <circle cx="548" cy="196" r="4.5" fill="var(--l2)"/>
  <circle cx="638" cy="196" r="4.5" fill="var(--l3)"/>
  <circle cx="998" cy="196" r="4.5" fill="var(--l3)"/>
  <text x="20" y="222" class="t-mono" style="font-size:9.5px">NL_X_TWO_NB_NH_BS_HS</text>
  <circle cx="548" cy="218" r="4.5" fill="var(--l2)"/>
  <circle cx="728" cy="218" r="4.5" fill="var(--l3)"/>
  <circle cx="908" cy="218" r="4.5" fill="var(--l3)"/>
  <text x="20" y="244" class="t-mono" style="font-size:9.5px">NL_X_NB_TWO_NH_BS_HS</text>
  <circle cx="548" cy="240" r="4.5" fill="var(--l2)"/>
  <circle cx="728" cy="240" r="4.5" fill="var(--l3)"/>
  <text x="20" y="266" class="t-mono" style="font-size:9.5px">NB_NL_TWO_NH_BS_HS</text>
  <circle cx="368" cy="262" r="4.5" fill="var(--l2)"/>
  <circle cx="728" cy="262" r="4.5" fill="var(--l3)"/>
  <text x="20" y="288" class="t-mono" style="font-size:9.5px">TWO_X_NL_X_NB_BS_NH_HS</text>
  <circle cx="458" cy="284" r="4.5" fill="var(--l2)"/>
  <text x="20" y="310" class="t-mono" style="font-size:9.5px">NL_X_NB_NH_BS_TWO_HS</text>
  <circle cx="548" cy="306" r="4.5" fill="var(--l2)"/>
  <circle cx="728" cy="306" r="4.5" fill="var(--l3)"/>
  <circle cx="818" cy="306" r="4.5" fill="var(--l3)"/>
  <text x="20" y="332" class="t-mono" style="font-size:9.5px">NL_X_NB_BS_NH_TWO_HS</text>
  <circle cx="548" cy="328" r="4.5" fill="var(--l2)"/>
  <circle cx="818" cy="328" r="4.5" fill="var(--l3)"/>
  <text x="20" y="354" class="t-mono" style="font-size:9.5px">NL_X_NB_NH_BS_CS</text>
  <circle cx="548" cy="350" r="4.5" fill="var(--l2)"/>
  <circle cx="728" cy="350" r="4.5" fill="var(--l3)"/>
  <circle cx="818" cy="350" r="4.5" fill="var(--l3)"/>
  <text x="20" y="376" class="t-mono" style="font-size:9.5px">NL_X_NB_BS_NH_CS</text>
  <circle cx="548" cy="372" r="4.5" fill="var(--l2)"/>
  <circle cx="818" cy="372" r="4.5" fill="var(--l3)"/>
  <text x="20" y="398" class="t-mono" style="font-size:9.5px">NL_X_NB_BSV_BSS</text>
  <circle cx="548" cy="394" r="4.5" fill="var(--l2)"/>
  <circle cx="638" cy="394" r="4.5" fill="var(--l3)"/>
  <text x="20" y="420" class="t-mono" style="font-size:9.5px">NL_X_TWO_NB_NH_ONE_BS_HS</text>
  <circle cx="548" cy="416" r="4.5" fill="var(--l2)"/>
  <circle cx="728" cy="416" r="4.5" fill="var(--l3)"/>
  <circle cx="908" cy="416" r="4.5" fill="var(--l3)"/>
  <text x="20" y="442" class="t-mono" style="font-size:9.5px">NL_X_TWO_X_NB_BS_NH_HS</text>
  <circle cx="548" cy="438" r="4.5" fill="var(--l2)"/>
  <circle cx="1088" cy="438" r="4.5" fill="var(--l3)"/>

  <line x1="20" y1="458" x2="1180" y2="458" stroke="var(--line)"/>
  <text x="20" y="478" class="t-mono">C++ 侧的 format_facts() 逐 case 写入同一张表；is_kv_second_tuple 只由 NL_X_TWO_X_NB_BS_NH_HS 置真。</text>
  <text x="20" y="496" class="t-mono">类与 C++ 侧都已有第六位 is_kv_second_tuple，lmcache-review/lmcache/v1/gpu_connector/kv_format/specs/base.py 的类 docstring 只列了五个。</text>
</svg>`,
        steps: [
          { t: '把几何读法收进一个纯几何接口', a: 'lmcache/v1/gpu_connector/kv_format/specs/base.py:92', note: '%%KVFormatSpec%% 只管布局，不带引擎身份：一个格式可能来自多个引擎与后端组合' },
          { t: '三个结构位互斥地描述 kv_caches 的形状', a: 'lmcache/v1/gpu_connector/kv_format/specs/base.py:134', note: '%%is_cross_layer%% 是所有层融成一个张量，%%is_kv_list%% 是 K 与 V 分成两个顶层列表，%%is_layer_list%% 是每层一个条目' },
          { t: '修饰位叠加在结构位之上', a: 'lmcache/v1/gpu_connector/kv_format/specs/base.py:142', note: '类里实际声明了六个：%%is_mla%%、%%is_hnd%%、%%is_fused_packed%%、%%is_two_major%%、%%is_pbs_fused%%、%%is_kv_second_tuple%%；类 docstring 仍只列五个' },
          { t: 'spec 借用张量而不持有它', a: 'lmcache/v1/gpu_connector/kv_format/specs/base.py:121', note: '%%get_spec%% 每次新建实例、调用点即用即弃；把 spec 缓存在长生命周期对象上会让引擎的 KV 张量在 disconnect 之后仍然活着' },
          { t: '一个格式一个文件，MLA 的 spec 只声明差异', a: 'lmcache/v1/gpu_connector/kv_format/specs/nl_x_nb_bs_hs.py:22', note: '%%is_layer_list%% 与 %%is_mla%% 置真，%%num_heads%% 固定返回 1，%%kv_size%% 固定返回 1' },
          { t: 'DSA indexer 的 spec 整个继承 MLA spec', a: 'lmcache/v1/gpu_connector/kv_format/specs/nl_x_nb_bsv_bss.py:21', note: '只换 %%engine_kv_format%% 与 %%attention_backends%%；逻辑形状与 MLA 相同，物理页内排布不同这一点归传输内核处理' },
          { t: 'registry 扫目录自动索引，按枚举整数值查表', a: 'lmcache/v1/gpu_connector/kv_format/specs/registry.py:43', note: '键是 %%int(fmt)%% 而不是枚举对象本身，因为 pybind 的原生枚举与纯 Python 回退枚举是两种类型' },
          { t: 'C++ 侧把同一张事实表写进 constexpr 函数', a: 'csrc/engine_kv_format.h:201', note: '%%format_facts()%% 逐 case 赋值，默认全 false，只把成立的位置真；设备代码不查全局表，避免依赖 hipcc 对全局 HD 数据的处理' },
          { t: '两边的漂移由测试钉住', a: 'lmcache/v1/gpu_connector/kv_format/specs/base.py:8', note: '%%lmcache-review/lmcache/v1/gpu_connector/kv_format/specs/base.py%% 的模块 docstring 写明 %%lmcache-review/tests/v1/gpu_connector/test_kv_format_classification.py%% 把 Python 与 C++ 两侧钉在一起' },
        ],
      },
      {
        id: 'downstream',
        layer: 'store',
        title: '格式变了，缓存与传输要改什么',
        direction: 'out',
        lead: '格式不只是一个分类。它决定了每 block 的物理步长、内核要几个指针、LMCache 侧的那块 buffer 最后一维是多少、以及量化 scale 跟谁一起搬。下面四行把上游事实与下游字段对上。',
        diagram: `<svg viewBox="0 0 1200 512" class="diagram flow-svg" role="img"
     aria-label="格式事实如何流入 block stride、指针表、MemoryObj 形状与量化 scale">
  <defs>
    <marker id="ar4" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,1 L9,5 L0,9 z" fill="#d5c7b0"/>
    </marker>
  </defs>
  <text x="20" y="22" class="t-band" fill="var(--l4)">上游事实 → 下游字段 → 改错的后果</text>

  <rect x="20" y="34" width="290" height="98" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="32" y="54" class="t-mono-c">block_stride_elems</text>
  <text x="32" y="74" class="t-mono">resolve_block_stride_</text>
  <text x="32" y="90" class="t-mono">and_log_layout()</text>
  <text x="32" y="110" class="t-mono">只有 block 轴在 dim-0 的</text>
  <text x="32" y="126" class="t-mono">四个格式允许 padding</text>
  <line x1="310" y1="83" x2="336" y2="83" class="t-line" marker-end="url(#ar4)"/>
  <rect x="340" y="34" width="380" height="98" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="352" y="54" class="t-mono-c">PageBufferShapeDesc.block_stride_elems</text>
  <text x="352" y="74" class="t-mono">= 代表层张量的 stride(0)</text>
  <text x="352" y="94" class="t-mono">为 0 时内核按 kv_size 与</text>
  <text x="352" y="110" class="t-mono">scalars_per_block 自己重算紧凑</text>
  <text x="352" y="126" class="t-mono">stride，Python 侧不重复这段算术</text>
  <line x1="720" y1="83" x2="746" y2="83" class="t-line" marker-end="url(#ar4)"/>
  <rect x="750" y="34" width="430" height="98" rx="7" fill="var(--l4)" fill-opacity=".05" stroke="var(--line)"/>
  <text x="762" y="54" class="t-title-sm">跳过 padding 就会读写错字节</text>
  <text x="762" y="76" class="t-mono">DeepSeek V4 的 compressor 与 indexer 缓存</text>
  <text x="762" y="92" class="t-mono">和更大的 attn group 共用一个 KV pool 时，</text>
  <text x="762" y="108" class="t-mono">每个 block 的 dim-0 会带 padding。这个字段</text>
  <text x="762" y="124" class="t-mono">就是唯一被内核承认的非连续形态。</text>

  <rect x="20" y="148" width="290" height="98" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="32" y="168" class="t-mono-c">KVFormatSpec.data_ptrs()</text>
  <text x="32" y="188" class="t-mono">每层出几个指针由格式决定</text>
  <text x="32" y="208" class="t-mono">MLA 出 1 个，DSA 出 3 个，</text>
  <text x="32" y="224" class="t-mono">DSA-C8 出 4 个</text>
  <line x1="310" y1="197" x2="336" y2="197" class="t-line" marker-end="url(#ar4)"/>
  <rect x="340" y="148" width="380" height="98" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="352" y="168" class="t-mono-c">kernel 的 int64 指针数组</text>
  <text x="352" y="188" class="t-mono">顺序：k, v, dsa_k, dsa_k_scale</text>
  <text x="352" y="208" class="t-mono">每层元组形态按 K,V 交错</text>
  <text x="352" y="224" class="t-mono">MULTI_PLANE 的每层长度可变</text>
  <line x1="720" y1="197" x2="746" y2="197" class="t-line" marker-end="url(#ar4)"/>
  <rect x="750" y="148" width="430" height="98" rx="7" fill="var(--l4)" fill-opacity=".05" stroke="var(--line)"/>
  <text x="762" y="168" class="t-title-sm">少一个指针，scale 就落错 plane</text>
  <text x="762" y="190" class="t-mono">DSA-C8 的四个成员各有自己的 dtype 与宽度，</text>
  <text x="762" y="206" class="t-mono">数量不对时在构造参数阶段直接抛错，</text>
  <text x="762" y="222" class="t-mono">不会等到搬运时才错位。</text>

  <rect x="20" y="262" width="290" height="98" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="32" y="282" class="t-mono-c">每 plane 的每 slot 字节宽</text>
  <text x="32" y="302" class="t-mono">numel 乘 element_size</text>
  <text x="32" y="318" class="t-mono">再除以 num_blocks 乘 block_size</text>
  <text x="32" y="338" class="t-mono">dtype 不同，宽度就不同</text>
  <line x1="310" y1="311" x2="336" y2="311" class="t-line" marker-end="url(#ar4)"/>
  <rect x="340" y="262" width="380" height="98" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="352" y="282" class="t-mono-c">MemoryObj 的最后一维</text>
  <text x="352" y="302" class="t-mono">MLA: kv_lora_rank + rope_dim</text>
  <text x="352" y="318" class="t-mono">DSA: 再加 dsa_head_dim</text>
  <text x="352" y="338" class="t-mono">DSA-C8: 每 token 的字节行</text>
  <line x1="720" y1="311" x2="746" y2="311" class="t-line" marker-end="url(#ar4)"/>
  <rect x="750" y="262" width="430" height="98" rx="7" fill="var(--l4)" fill-opacity=".05" stroke="var(--line)"/>
  <text x="762" y="282" class="t-title-sm">分配字节数与实际搬运量不等</text>
  <text x="762" y="304" class="t-mono">uint8 行按 32 字节对齐后再摊回每 token，</text>
  <text x="762" y="320" class="t-mono">取整后每 token 宽度会略大于原始宽度；</text>
  <text x="762" y="336" class="t-mono">照着 plane 宽度直接分配会装不下。</text>

  <rect x="20" y="376" width="290" height="98" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="32" y="396" class="t-mono-c">ScaleScope</text>
  <text x="32" y="416" class="t-mono">per_tensor / per_layer_head</text>
  <text x="32" y="432" class="t-mono">/ per_page_head</text>
  <text x="32" y="452" class="t-mono">落盘时 V 的 scale 怎么组织</text>
  <line x1="310" y1="425" x2="336" y2="425" class="t-line" marker-end="url(#ar4)"/>
  <rect x="340" y="376" width="380" height="98" rx="7" fill="var(--bg)" stroke="var(--line)"/>
  <text x="352" y="396" class="t-mono-c">EncodedKV 的头</text>
  <text x="352" y="416" class="t-mono">k_dtype / v_dtype / scale_dtype</text>
  <text x="352" y="432" class="t-mono">scale_shape 与三个长度字段</text>
  <text x="352" y="452" class="t-mono">K、V、scales 顺序拼在 payload</text>
  <line x1="720" y1="425" x2="746" y2="425" class="t-line" marker-end="url(#ar4)"/>
  <rect x="750" y="376" width="430" height="98" rx="7" fill="var(--l4)" fill-opacity=".05" stroke="var(--line)"/>
  <text x="762" y="396" class="t-title-sm">分页 KV 天然不满足整层假设</text>
  <text x="762" y="418" class="t-mono">按整层张量算一个 scale 会把不同页的极值混在</text>
  <text x="762" y="434" class="t-mono">一起，量化误差集中在大值页；per_page_head 是</text>
  <text x="762" y="450" class="t-mono">默认，额外开销相对 V 的字节量很小。</text>
</svg>`,
        steps: [
          { t: '调用点只转调 spec，不再内联格式清单', a: 'lmcache/v1/gpu_connector/utils.py:288', note: '%%get_num_layers%%、%%get_num_blocks%%、%%get_block_size%%、%%get_kv_size%% 等 facade 全是单行转发，格式分支只存在于 spec 类里' },
          { t: '混合模型逐层探测格式', a: 'lmcache/v1/gpu_connector/utils.py:215', note: '同一模型里可以有 %%kv_size=2%% 的 K+V 主缓存和 %%kv_size=1%% 的 key-only indexer 缓存，所以格式是按层而不是按模型记录' },
          { t: '解析每 block 的物理步长', a: 'lmcache/v1/gpu_connector/utils.py:507', note: 'block 轴在 dim-0 的四个格式直接返回 %%stride(0)%%；其余格式若带 dim-0 padding 会被拒绝，因为内核无法遵守' },
          { t: '只对 block 轴在 dim-0 的格式放行 padding', a: 'lmcache/v1/gpu_connector/utils.py:494', note: '集合里是 %%NL_X_NB_BS_HS%%、%%NL_X_NB_BSV_BSS%% 与两个 blocks-first 的 vLLM 布局；注释写了为何暂不纳入 %%NL_X_NB_TWO_BS_NH_HS%%' },
          { t: '把事实填进内核参数结构', a: 'lmcache/v1/gpu_connector/utils.py:629', note: '%%PageBufferShapeDesc%% 的字段名是 %%kv_size%%、%%nl%%、%%nb%%、%%bs%%、%%nh%%、%%hs%%、%%element_size%%、%%block_stride_elems%%、%%dtype%%' },
          { t: 'kv_size 与 heads 直接取自 spec', a: 'lmcache/v1/gpu_connector/utils.py:663', note: '%%desc.kv_size%% 来自 %%get_kv_size%%；MLA 时 %%nh%% 被强制为 1（%%lmcache/v1/gpu_connector/utils.py:667%%），即使底层张量还有一个 head 轴' },
          { t: '按格式抽取指针表', a: 'lmcache_ascend/v1/npu_connector/npu_connectors.py:208', note: 'v2 内核读的是一个扁平 int64 数组，每种格式每层贡献的指针数不同，所以抽取必须逐格式写' },
          { t: 'DSA-C8 必须凑够四个指针', a: 'lmcache_ascend/v1/npu_connector/npu_connectors.py:224', note: '顺序是 k、v、dsa_k、dsa_k_scale；%%lmcache_ascend/v1/npu_connector/npu_connectors.py:135%% 在构造参数阶段就检查数量，不足四个直接抛错' },
          { t: '给每个平面算每 slot 的字节宽度', a: 'lmcache_ascend/v1/kv_layer_groups.py:38', note: '%%numel * element_size // (num_blocks * block_size)%%；dtype 不同宽度就不同，%%MULTI_PLANE_KV%% 连 block_size 都可能不同' },
          { t: '把 uint8 行的最后一维摊回每 token', a: 'lmcache_ascend/v1/kv_layer_groups.py:65', note: '每个平面的字节数先按 32 字节向上取整再求和，最后除以 token 数向上取整；%%lmcache_ascend/v1/kv_layer_groups.py:83%% 那行就是 %%AlignUp32Bytes%%' },
          { t: '由格式决定 LMCache 侧 MemoryObj 的最后一维', a: 'lmcache_ascend/v1/npu_connector/npu_connectors.py:2144', note: 'MLA 是 %%kv_lora_rank + qk_rope_head_dim%%，DSA 再加 %%dsa_head_dim%%，DSA-C8 则是每 token 的字节行宽' },
          { t: '落盘时把 scale 的粒度写进头', a: 'lmcache/v1/kv_codec/encoded_kv.py:43', note: '%%ScaleScope%% 有 %%per_tensor%%、%%per_layer_head%%、%%per_page_head%%、%%external%% 四个取值，默认 %%per_page_head%%' },
          { t: '三个 payload 长度分开记，一起校验', a: 'lmcache/v1/kv_codec/encoded_kv.py:157', note: '%%EncodedKV%% 分别记 %%k_payload_len%%、%%v_payload_len%%、%%scale_payload_len%%，序列化前先核对他们之和是否等于实际 payload' },
          { t: '非对称量化把 K 留在原生精度、只压 V', a: 'lmcache/v1/kv_codec/asym_k16_v8.py:2', note: 'K 用 FP16 或 BF16，V 量化到 FP8 e4m3fn；全零张量的 scale 取 1.0 作为哨兵，保证反量化回 0 且不产生 NaN' },
        ],
      },
    ],
    sections: [
      {
        id: 'gdn-state',
        title: 'GDN 的 state 不是 KV',
        lead: 'state 与 token KV 的差别不止在名字。前者每层定长、被每个 token 原地改写、只有 chunk 边界值得外存；后者随序列无界增长、只追加、任意完整前缀都能共享。图把这两套语义并排画出来，底部是同一段序列上的两种写模式。',
        diagram: `<svg viewBox="0 0 1200 520" class="diagram flow-svg" role="img"
     aria-label="token KV 与 GDN state 在容量、写入、复用与传输上的对照">
  <text x="20" y="22" class="t-band" fill="var(--l3)">token KV 与 GDN state 的对照</text>

  <rect x="20" y="34" width="560" height="292" rx="9" fill="var(--l3)" fill-opacity=".05" stroke="var(--line)"/>
  <text x="38" y="56" class="t-title-sm">token KV</text>
  <text x="38" y="80" class="t-mono">容量　随序列无界增长，按 token 分页的 block 池</text>
  <text x="38" y="102" class="t-mono">写入　追加。新 token 落新 slot，已写完的 block 不变</text>
  <text x="38" y="124" class="t-mono">寻址　block table 第 i 列 = 第 i 个 token block</text>
  <text x="38" y="146" class="t-mono">复用　任意完整前缀都能共享，按 token hash 定位</text>
  <text x="38" y="168" class="t-mono">内容　MLA 后是单个潜在平面，kv_size = 1</text>
  <text x="38" y="190" class="t-mono">　　　DSA 后多一条 indexer 缓存，DSA-C8 再多 scale</text>
  <text x="38" y="212" class="t-mono">dtype bf16 / fp8 / int8 混用</text>
  <text x="38" y="238" class="t-mono">块大小　block_size 由调度器决定</text>
  <text x="38" y="260" class="t-mono">　　　一层里可以有互不相同的 block_size</text>
  <text x="38" y="282" class="t-mono">落盘　KV codec 可以把 V 降到 fp8，</text>
  <text x="38" y="304" class="t-mono">　　　scale 随 blob 一起走</text>

  <rect x="620" y="34" width="560" height="292" rx="9" fill="var(--l1)" fill-opacity=".05" stroke="var(--line)"/>
  <text x="638" y="56" class="t-title-sm">GDN state</text>
  <text x="638" y="80" class="t-mono">容量　每层定长。conv 与 ssm 两平面，</text>
  <text x="638" y="102" class="t-mono">　　　三个维只由 head 数与 head 维度决定</text>
  <text x="638" y="124" class="t-mono">写入　覆盖。ssm_state[slot] = 最新 state</text>
  <text x="638" y="146" class="t-mono">寻址　每请求一个 slot，取 block table 第 0 列</text>
  <text x="638" y="168" class="t-mono">复用　只有 chunk 边界上的快照可用</text>
  <text x="638" y="190" class="t-mono">内容　按 (conv, ssm) 逐平面打包，层内连续</text>
  <text x="638" y="212" class="t-mono">dtype kernel 只声明 FP32 与 BF16</text>
  <text x="638" y="238" class="t-mono">块大小　边界对齐 mamba_block_size，</text>
  <text x="638" y="260" class="t-mono">　　　chunk_stride = 每块有几个 chunk</text>
  <text x="638" y="282" class="t-mono">落盘　快照按 blockId 寻址，</text>
  <text x="638" y="304" class="t-mono">　　　一个 block 一个整 state</text>

  <rect x="20" y="346" width="1160" height="150" rx="9" fill="var(--bg)" stroke="var(--line)"/>
  <text x="38" y="368" class="t-title-sm">同一段序列上的两种写模式</text>
  <text x="38" y="392" class="t-mono">token 位置</text>
  <text x="150" y="392" class="t-mono">0</text>
  <text x="270" y="392" class="t-mono">256</text>
  <text x="390" y="392" class="t-mono">512</text>
  <text x="510" y="392" class="t-mono">768</text>
  <text x="630" y="392" class="t-mono">1024</text>
  <text x="750" y="392" class="t-mono">1280</text>
  <text x="870" y="392" class="t-mono">1536</text>
  <text x="990" y="392" class="t-mono">1792</text>
  <text x="38" y="416" class="t-mono">KV block</text>
  <rect x="150" y="404" width="116" height="14" rx="3" fill="var(--l3)" fill-opacity=".22" stroke="var(--l3)"/>
  <rect x="270" y="404" width="116" height="14" rx="3" fill="var(--l3)" fill-opacity=".22" stroke="var(--l3)"/>
  <rect x="390" y="404" width="116" height="14" rx="3" fill="var(--l3)" fill-opacity=".22" stroke="var(--l3)"/>
  <rect x="510" y="404" width="116" height="14" rx="3" fill="var(--l3)" fill-opacity=".22" stroke="var(--l3)"/>
  <rect x="630" y="404" width="116" height="14" rx="3" fill="var(--l3)" fill-opacity=".22" stroke="var(--l3)"/>
  <rect x="750" y="404" width="116" height="14" rx="3" fill="var(--l3)" fill-opacity=".08" stroke="var(--l3)"/>
  <rect x="870" y="404" width="116" height="14" rx="3" fill="var(--l3)" fill-opacity=".08" stroke="var(--l3)"/>
  <text x="208" y="415" class="t-mono" text-anchor="middle" style="font-size:9px">block 0</text>
  <text x="328" y="415" class="t-mono" text-anchor="middle" style="font-size:9px">block 1</text>
  <text x="448" y="415" class="t-mono" text-anchor="middle" style="font-size:9px">block 2</text>
  <text x="568" y="415" class="t-mono" text-anchor="middle" style="font-size:9px">block 3</text>
  <text x="688" y="415" class="t-mono" text-anchor="middle" style="font-size:9px">block 4</text>
  <text x="808" y="415" class="t-mono" text-anchor="middle" style="font-size:9px">block 5</text>
  <text x="928" y="415" class="t-mono" text-anchor="middle" style="font-size:9px">block 6</text>
  <text x="38" y="446" class="t-mono">state slot</text>
  <rect x="150" y="434" width="836" height="14" rx="3" fill="var(--l1)" fill-opacity=".14" stroke="var(--l1)"/>
  <text x="568" y="445" class="t-mono" text-anchor="middle" style="font-size:9px">同一个 slot 被每个 token 覆盖改写</text>
  <line x1="266" y1="430" x2="266" y2="452" stroke="var(--l1)" stroke-width="1.5"/>
  <line x1="386" y1="430" x2="386" y2="452" stroke="var(--l1)" stroke-width="1.5"/>
  <line x1="506" y1="430" x2="506" y2="452" stroke="var(--l1)" stroke-width="1.5"/>
  <line x1="626" y1="430" x2="626" y2="452" stroke="var(--l1)" stroke-width="1.5"/>
  <line x1="746" y1="430" x2="746" y2="452" stroke="var(--l1)" stroke-width="1.5"/>
  <line x1="866" y1="430" x2="866" y2="452" stroke="var(--l1)" stroke-width="1.5"/>
  <text x="38" y="478" class="t-mono">竖线是块边界，也是唯一能被外部保存的 state 快照点；token 之间没有可复用的中间版本。</text>
  <text x="38" y="494" class="t-mono">KV 的浅色两格表示 block 已分配、token 未写满：KV 可以只搬写满的部分，state 不能。</text>
</svg>`,
        html: `
### 两条递推式，两种存储

GDN 的 state 是递推量。KDA/GDN 每接受一个 token 就更新一次 state，下一个 token 的输出依赖刚写回的那一份。这一点在代码里表现为 prefill 结束时的一次整体回写：

~~~python
                beta=beta_non_spec,
                initial_state=initial_state,
                output_final_state=True,
                cu_seqlens=attn_metadata.prefill_query_start_loc,
                chunk_indices=attn_metadata.chunk_indices,
                chunk_offsets=attn_metadata.chunk_offsets,
                use_qk_l2norm_in_kernel=False,
            )
            # Init cache
            ssm_state[prefill_state_indices] = last_recurrent_state.to(ssm_state.dtype)
~~~

图里两条泳道的差别就来自这里。KV 的 block table 第 i 列是第 i 个 token block，列号随序列推进；GDN 只取第 0 列：

~~~python
            spec_state_indices_tensor = None
            non_spec_state_indices_tensor = block_table_tensor[:, 0]
~~~

%%vllm/v1/attention/backends/gdn_attn.py:219%% 这一行是解码路径的 state slot 来源。decode 侧走 %%inplace_final_state=True%%（%%vllm/model_executor/layers/mamba/gdn/qwen_gdn_linear_attn.py:1386%%），算完直接把结果写回同一块内存，没有第二次分配，也没有追加。

### 形状与序列长度解耦

%%gated_delta_net_state_shape%% 返回的两个形状里没有序列长度：

~~~python
        temporal_state_shape = (
            divide(num_v_heads, tp_world_size),
            head_v_dim,
            head_k_dim,
        )
        return conv_state_shape, temporal_state_shape
~~~

conv 平面的大小由 %%conv_dim%% 与 %%conv_kernel_size - 1 + num_spec%% 决定，ssm 平面是 %%num_v_heads / tp_world_size, head_v_dim, head_k_dim%% 三维。换一个更长的上下文，这两个形状不变。KV 的 block 池相反：上下文越长，占用的 block 越多，池子被撑大。

两者的保存粒度不能共用一个周期：KV 的 block 一旦写完就不再变，所以它天然是一个可共享的不可变对象；state 的 slot 每个 token 都被改写一次，只有落在 chunk 边界上的那一份才值得外部保留。

### checkpoint 边界在代码里怎么写

%%mamba_block_size%% 是三档 %%mamba_cache_mode%% 的粒度来源，%%chunk_stride%% 由它除以 chunk 大小得出：

~~~python
                # The chunk_stride is the number of chunks per mamba block
                # e.g., if mamba_block_size = 512 and chunk_size = 256,
                # then chunk_stride = 2
                chunk_stride = mamba_block_size // chunk_size
~~~

%%vllm/model_executor/layers/mamba/mamba_mixer2.py:883%% 紧接着把写入位置对齐到 %%first_aligned_chunk%%（%%vllm/model_executor/layers/mamba/mamba_mixer2.py:919%%），于是 block 之间那些 chunk 上的 state 永远不外存，图里那排竖线标的就是这些边界。

%%state_*.py%% 的 checkpoint 身份也建立在同一套边界上。%%CheckpointRef.from_chunk%% 拒绝非整 chunk 的边界：

~~~python
        if chunk_size <= 0 or boundary <= 0 or boundary != chunk_end:
            raise ValueError("Checkpoint boundary must equal the positive chunk end")
        if boundary % chunk_size:
            raise ValueError("Checkpoint boundary must end at a complete chunk")
~~~

### 与调研材料的一处分歧

一份关于 KDA/GDN state 保存粒度的论证材料（%%kda-gdn-kvc-update-and-memory-analysis.md%%）把「只在 block 边界保留 checkpoint」写成 GDN 与 KDA 的现状。在钉住的 %%vllm%% @ %%568afb3a%% 上，这个机制只出现在 %%vllm/model_executor/layers/mamba/mamba_mixer.py:267%% 与 %%vllm/model_executor/layers/mamba/mamba_mixer2.py:689%% 两处，%%is_mamba_cache_all%% 是它们的开关。GDN 的 %%vllm-review/vllm/model_executor/layers/mamba/gdn/qwen_gdn_linear_attn.py%% 里没有 %%mamba_cache_mode%%、%%block_idx%%、%%mamba_block_size%% 的任何引用；prefill 路径只做一次最终 state 回写。

所以在这套版本上，GDN 的外部可用恢复点只有一个，就是请求结束时的最终 state。block 对齐的中间快照是 Mamba2 的能力，把它当成 GDN 的既成事实会让 checkpoint 间隔的设计落空。

### 搬到外部时搬什么

昇腾侧的 state 通道按平面打包。%%build_state_group_layout%% 只接受两个平面，并逐一校验层的形状与 dtype 一致：

~~~python
    if any(len(entry) != 2 for entry in tensors):
        raise ValueError("State layout requires conv and SSM planes")
~~~

打包时按各平面 dtype 的最小公倍数对齐（%%lmcache_ascend/v1/state_layout.py:65%%、%%lmcache_ascend/v1/state_layout.py:84%%），因为没有 Python 侧拷贝，对齐只影响偏移量的计算。

底层 kernel 的参数表印证了「定长、按块寻址」这回事：

~~~c
void multi_layer_gdn_state_transfer_kernel(
    kvcache_ops::AscendType type, uint32_t blockDim, void *stream,
    uint8_t *memoryTensor, uint8_t *statePtrs, const int64_t blockId,
    const int32_t numLayers, const int64_t sliceNumel,
    const bool stateToMemory);
~~~

参数里有 %%blockId%% 与 %%sliceNumel%%，没有 token 维度，也没有 block_size。state 的地址就是 %%blockId * sliceNumel%%（%%third_party/kvcache-ops/kernels/multi_layer/multi_layer_gdn_state_kernels.cpp:60%%），每层的指针来自一张 int64 表（%%third_party/kvcache-ops/kernels/multi_layer/multi_layer_gdn_state_kernels.cpp:57%%）。dtype 只声明了 FP32 与 BF16（%%third_party/kvcache-ops/kernels/multi_layer/multi_layer_gdn_state_kernels.cpp:151%%），没有 KV 那边常见的 FP8 与 int8。

> **这一段的锚点情况**：%%lmcache-ascend-combined/lmcache_ascend/v1/state_transfer.py%%、%%lmcache-ascend-combined/lmcache_ascend/v1/state_layout.py%%、%%lmcache-ascend-combined/lmcache_ascend/v1/state_checkpoint.py%%、%%lmcache-ascend-combined/lmcache_ascend/v1/state_lookup.py%%、%%lmcache-ascend-combined/lmcache_ascend/v1/state_cache.py%%、%%lmcache-ascend-combined/lmcache_ascend/v1/state_memory.py%% 六个文件只存在于本地合成快照 %%lmcache-ascend-combined%%，无法从公开仓库复现，因此这几处行号没有经过校验。GDN state kernel 与 vLLM 的两处都在公开仓库里，行号已核对。
`,
      },
      {
        id: 'code-structs',
        title: '关键类型定义',
        lead: '两个枚举定义「有哪些格式」，%%FormatFacts%% 与 %%KVFormatSpec%% 定义「每个格式是什么」，%%EncodedKV%% 定义「存到字节里长什么样」。图先把四个类型群和它们之间的两份镜像画出来，下面逐块抄代码。',
        diagram: `<svg viewBox="0 0 1200 480" class="diagram flow-svg" role="img"
     aria-label="两个枚举、spec 基类、registry 与落盘 codec 的类型关系">
  <defs>
    <marker id="ar6" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,1 L9,5 L0,9 z" fill="#d5c7b0"/>
    </marker>
  </defs>
  <text x="20" y="22" class="t-band" fill="var(--l2)">类型与所有权</text>

  <rect x="20" y="36" width="360" height="196" rx="9" fill="var(--l3)" fill-opacity=".04" stroke="var(--line)"/>
  <text x="38" y="58" class="t-title-sm">Python 侧 · lmcache-review</text>
  <rect x="38" y="72" width="324" height="60" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="50" y="92" class="t-mono-c">EngineKVFormat</text>
  <text x="50" y="110" class="t-mono">17 个值，名字即形状</text>
  <text x="50" y="126" class="t-mono">pyi 存根与纯 Python 回退各一份</text>
  <rect x="38" y="144" width="324" height="76" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="50" y="164" class="t-mono-c">KVFormatSpec（ABC）</text>
  <text x="50" y="182" class="t-mono">17 个 spec 子类，一个格式一个</text>
  <text x="50" y="198" class="t-mono">借 kv_caches 而不持有它</text>
  <text x="50" y="214" class="t-mono">get_spec(fmt) 每次新建，用完即弃</text>

  <rect x="420" y="36" width="360" height="196" rx="9" fill="var(--l4)" fill-opacity=".04" stroke="var(--line)"/>
  <text x="438" y="58" class="t-title-sm">C++ 内核侧 · lmcache-review</text>
  <rect x="438" y="72" width="324" height="60" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="450" y="92" class="t-mono-c">enum class EngineKVFormat</text>
  <text x="450" y="110" class="t-mono">整数值就是内核侧的格式下标</text>
  <text x="450" y="126" class="t-mono">设备代码里是 constexpr 查表</text>
  <rect x="438" y="144" width="324" height="76" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="450" y="164" class="t-mono-c">struct FormatFacts</text>
  <text x="450" y="182" class="t-mono">3 个结构位 + 6 个修饰位</text>
  <text x="450" y="198" class="t-mono">format_facts() 逐 case 赋值</text>
  <text x="450" y="214" class="t-mono">与 Python spec 的类属性一一对应</text>

  <rect x="820" y="36" width="360" height="196" rx="9" fill="var(--l1)" fill-opacity=".04" stroke="var(--line)"/>
  <text x="838" y="58" class="t-title-sm">Ascend 侧 · lmcache-ascend-dsv4-review</text>
  <rect x="838" y="72" width="324" height="60" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="850" y="92" class="t-mono-c">KVCacheFormat（Enum）</text>
  <text x="850" y="110" class="t-mono">7 个值，从 UNDEFINED 到</text>
  <text x="850" y="126" class="t-mono">MULTI_PLANE_KV</text>
  <rect x="838" y="144" width="324" height="76" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="850" y="164" class="t-mono-c">KVCacheFormat（C++）</text>
  <text x="850" y="182" class="t-mono">kvcache-ops 仓库的枚举头文件</text>
  <text x="850" y="198" class="t-mono">在钉住的 c3db0eb 上只到 DSA_KV</text>
  <text x="850" y="214" class="t-mono">整数值必须与 Python 枚举一致</text>

  <line x1="362" y1="102" x2="438" y2="102" class="t-line" stroke-dasharray="4 3"/>
  <text x="400" y="96" class="t-mono" text-anchor="middle" style="font-size:9px">镜像</text>
  <line x1="762" y1="102" x2="838" y2="102" class="t-line" stroke-dasharray="4 3"/>
  <text x="800" y="96" class="t-mono" text-anchor="middle" style="font-size:9px">整数契约</text>

  <rect x="20" y="262" width="360" height="196" rx="9" fill="var(--l2)" fill-opacity=".04" stroke="var(--line)"/>
  <text x="38" y="284" class="t-title-sm">探测 · kv_format 包</text>
  <rect x="38" y="298" width="324" height="60" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="50" y="318" class="t-mono-c">EngineDetector（ABC）</text>
  <text x="50" y="336" class="t-mono">4 个 detector：vllm / sglang /</text>
  <text x="50" y="352" class="t-mono">trtllm / atom</text>
  <rect x="38" y="370" width="324" height="70" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="50" y="390" class="t-mono-c">detect_format()</text>
  <text x="50" y="408" class="t-mono">连续视图恢复 → 选 detector</text>
  <text x="50" y="424" class="t-mono">→ discover() 返回格式与规范化结构</text>
  <text x="50" y="440" class="t-mono">识别失败抛 ValueError</text>

  <rect x="420" y="262" width="360" height="196" rx="9" fill="var(--l2)" fill-opacity=".04" stroke="var(--line)"/>
  <text x="438" y="284" class="t-title-sm">装配 · registry</text>
  <rect x="438" y="298" width="324" height="60" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="450" y="318" class="t-mono-c">_discover_specs()</text>
  <text x="450" y="336" class="t-mono">pkgutil 遍历 specs 目录</text>
  <text x="450" y="352" class="t-mono">加一个格式只需丢一个新文件</text>
  <rect x="438" y="370" width="324" height="70" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="450" y="390" class="t-mono-c">get_spec_class(fmt)</text>
  <text x="450" y="408" class="t-mono">按枚举整数值查表</text>
  <text x="450" y="424" class="t-mono">查不到抛 ValueError</text>
  <text x="450" y="440" class="t-mono">调用点不再内联格式清单</text>

  <rect x="820" y="262" width="360" height="196" rx="9" fill="var(--l4)" fill-opacity=".04" stroke="var(--line)"/>
  <text x="838" y="284" class="t-title-sm">落盘 · kv_codec</text>
  <rect x="838" y="298" width="324" height="66" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="850" y="318" class="t-mono-c">EncodedKV</text>
  <text x="850" y="336" class="t-mono">k_dtype / v_dtype / scale_dtype</text>
  <text x="850" y="352" class="t-mono">payload = K 字节 接 V 字节 接 scale</text>
  <rect x="838" y="376" width="324" height="66" rx="6" fill="var(--bg)" stroke="var(--line)"/>
  <text x="850" y="396" class="t-mono-c">ScaleScope / CodecHashes</text>
  <text x="850" y="414" class="t-mono">scale 的三档粒度，加 external</text>
  <text x="850" y="430" class="t-mono">跨模型与跨 backend 的六个哈希</text>

  <line x1="362" y1="330" x2="438" y2="330" class="t-line" marker-end="url(#ar6)"/>
  <line x1="600" y1="232" x2="600" y2="298" class="t-line" marker-end="url(#ar6)"/>
  <line x1="1000" y1="232" x2="1000" y2="298" class="t-line" marker-end="url(#ar6)"/>
</svg>`,
        html: `
### 两个枚举：一个管引擎，一个管存储

%%EngineKVFormat%% 描述引擎交给上游的物理布局，名字本身就是一个形状公式。文件开头的记法说明了一切：

~~~c
/*
Symbol Reference:
NL: number of layers
NB: number of blocks/pages
BS: block/page size
NBBS: block/page buffer size = NB * BS
NH: number of heads
HS: head size
CS: content size (per-head content width; 2 * head size when K/V are fused)
TWO: 2
ONE: 1

_ means a dimension within the same tensor
_X_ means a dimension across a list

A_X_B_X_C_D_E means:
kv_cache: List[List[torch.Tensor]]
len(kv_cache) = A
len(kv_cache[0]) = B
kv_cache[0][0].shape = (C, D, E)
*/
~~~

%%A_X_B_X_C_D_E%% 表示外层嵌套几层、每层张量有几维；%%_X_%% 是跨列表的一层，%%_%% 是同一张量内的一个维。读一个格式名就等于读它的形状，不需要另查表。

枚举的前四个值是 vLLM 与 SGLang 的主力布局：

~~~c
enum class EngineKVFormat : int {
  NB_NL_TWO_BS_NH_HS = 0,
  /*
  used by:
  - vLLM CROSS_LAYER mode
  */

  NL_X_TWO_NB_BS_NH_HS = 1,
  /*
  used by:
  - vLLM non-MLA flash attention
  */

  NL_X_NB_TWO_BS_NH_HS = 2,
  /*
  used by:
  - vLLM non-MLA flash infer
  */

  NL_X_NB_BS_HS = 3,
  /*
  used by:
  - vLLM MLA
  - SGLang MLA via MP daemon
  */
~~~

同一个枚举在 C++、pybind 存根、纯 Python 回退三处各有一份，三者的整数值必须一致，%%lmcache-review/lmcache/lmcache_native.pyi:11%% 与 %%lmcache-review/lmcache/lmcache_native.pyi:28%% 是其中一份。

### FormatFacts：把「每个格式是什么」写成布尔位

C++ 侧把布局事实收进一个结构体，注释明确写了三个结构位互斥：

~~~c
struct FormatFacts {
  bool is_cross_layer = false;   // all layers in one fused tensor
  bool is_kv_list = false;       // keys and values in two top-level lists
  bool is_layer_list = false;    // one list entry per layer
  bool is_mla = false;           // MLA: single latent KV head (no separate K/V)
  bool is_hnd = false;           // heads before block tokens (HND layout)
  bool is_fused_packed = false;  // K/V packed in trailing dim (kv_size == 1)
  bool is_two_major = false;     // size-2 K/V axis precedes the block axis
  bool is_pbs_fused = false;     // paged buffer size fused into one axis
  bool is_kv_second_tuple = false;  // each per-layer entry is a (K, V) pair
};
~~~

结构位是 %%is_cross_layer%% / %%is_kv_list%% / %%is_layer_list%%，修饰位是 %%is_mla%% / %%is_hnd%% / %%is_fused_packed%% / %%is_two_major%% / %%is_pbs_fused%% / %%is_kv_second_tuple%%。%%is_kv_second_tuple%% 是后加的，%%lmcache/v1/gpu_connector/kv_format/specs/base.py:103%% 的类 docstring 仍只列了五个修饰位。

### 存储侧的枚举多出一层

%%lmcache-ascend%% 的 %%KVCacheFormat%% 是给缓存与搬运用的，它比 %%EngineKVFormat%% 更关心「一层里有几个平面、dtype 是否一致」：

~~~python
class KVCacheFormat(Enum):
    """
    The storage format enumeration of KV cache is used to distinguish
    the KV cache data structures of different versions of vLLM.

    The order of enum values MUST match the KVCacheFormat
    definition in kernels/types.h to ensure correct interoperability
    between Python and C++ code.
    """

    UNDEFINED = 0

    MERGED_KV = auto()
    """Merge format (eg: vLLM 0.9.2 ...)
    layer: [num_kv, num_blocks, block_size, num_heads, head_dim]
    """

    SEPARATE_KV = auto()
    """Separation format (eg: vLLM 0.11.0+ ...)
    layer: tuple: (K_tensor, V_tensor)
    - K_tensor.shape = [num_blocks, block_size, num_heads, head_dim]
    - V_tensor.shape = [num_blocks, block_size, num_heads, head_dim]

    eg: kvcaches[0] = (K, V)

    SGLang NPU Layer-Concatenated
    kvcaches = [K_all_layers, V_all_layers]
    - K_tensor.shape = [layer_nums, num_blocks, block_size, num_heads, head_dim]
    - V_tensor.shape = [layer_nums, num_blocks, block_size, num_heads, head_dim]
    """

    MLA_KV = auto()
    """MLA format for DeepSeek V2/V3 models
    layer: tuple: (k_cache, v_cache) where K and V have different dimensions
    - k_cache.shape = [num_blocks, block_size, num_kv_heads, kv_lora_rank]
    - v_cache.shape = [num_blocks, block_size, num_kv_heads, qk_rope_head_dim]

    This format is used when K/V shapes differ (detected automatically).
    """
~~~

docstring 里那张形状表就是 DSA 的完整形态：%%k_cache%% 与 %%v_cache%% 维度不同，%%dsa_k_cache%% 形状是 %%[NB, BS, 1, 128]%%，%%DSA_C8_KV%% 再多一个 %%[NB, BS, 1, 1]%% 的 fp16 scale。%%slot%% 索引在四个成员之间对齐，这是四个平面能被同一套 block 号寻址的前提。

平面数直接决定内核要几个指针：

~~~python
    def is_tuple_format(self) -> bool:
        return self in (
            KVCacheFormat.SEPARATE_KV,
            KVCacheFormat.MLA_KV,
            KVCacheFormat.DSA_KV,
            KVCacheFormat.DSA_C8_KV,
            KVCacheFormat.MULTI_PLANE_KV,
        )

    def get_kv_size(self) -> int:
        # MULTI_PLANE_KV has a variable number of planes per layer, so there
        # is no fixed stride for a flat pointer table; 0 signals per-group pointers.
        if self == KVCacheFormat.MULTI_PLANE_KV:
            return 0
        if self == KVCacheFormat.DSA_C8_KV:
            return 4
        elif self == KVCacheFormat.DSA_KV:
            return 3
        elif self in (KVCacheFormat.SEPARATE_KV, KVCacheFormat.MLA_KV):
            return 2
        elif self == KVCacheFormat.MERGED_KV:
            return 1
        return 0
~~~

%%MULTI_PLANE_KV%% 返回 0，因为 planes 数量不固定，没有一套统一的扁平 stride；%%DSA_C8_KV%% 返回 4，其余依次是 3、2、1。

### spec 基类与它的扩展点

%%KVFormatSpec%% 把几何读法做成抽象方法，把布局事实做成类属性：

~~~python
    # ── Static layout facts (see the class docstring) ──────────────────
    # Structural shape of the normalized \`\`kv_caches\`\`: exactly one is true.
    # All layers in one fused tensor.
    is_cross_layer: ClassVar[bool] = False
    # Keys and values in two top-level lists: \`\`[key_layers, value_layers]\`\`.
    is_kv_list: ClassVar[bool] = False
    # One list entry per layer: \`\`kv_caches[layer_idx]\`\` is that layer.
    is_layer_list: ClassVar[bool] = False

    # Modifiers, orthogonal to the structural shape.
    # Multi-head Latent Attention: one latent plane, no K/V split.
    is_mla: ClassVar[bool] = False
    # Heads stored before block tokens within a layer (HND, not NHD).
    is_hnd: ClassVar[bool] = False
    # K and V packed into the trailing content dim, so \`\`kv_size == 1\`\`.
    is_fused_packed: ClassVar[bool] = False
    # The size-2 K/V axis comes before the block axis (\`\`TWO_NB\`\`, not
    # \`\`NB_TWO\`\`), so K and V are two contiguous planes per layer.
    is_two_major: ClassVar[bool] = False
    # \`\`num_blocks\`\` and \`\`block_size\`\` are folded into one PBS axis, which
    # leaves both of them undefined for this format.
    is_pbs_fused: ClassVar[bool] = False
    # Each per-layer list entry is a \`\`(K, V)\`\` tuple of paged tensors, rather
    # than a single stacked per-layer tensor.
    is_kv_second_tuple: ClassVar[bool] = False
~~~

一个格式一个文件，%%lmcache-review/lmcache/v1/gpu_connector/kv_format/specs/registry.py%% 用 %%pkgutil%% 扫目录自动索引，新增格式不需要改 registry：

~~~python
def _discover_specs() -> dict["lmcache_native.EngineKVFormat", type[KVFormatSpec]]:
    """Import every spec module in this folder and index it by its format."""
    specs: dict["lmcache_native.EngineKVFormat", type[KVFormatSpec]] = {}
    for module in pkgutil.iter_modules([str(Path(__file__).parent)]):
        if module.name in ("base", "registry"):
            continue
        imported = importlib.import_module(f"{__package__}.{module.name}")
        for value in vars(imported).values():
            if (
                isinstance(value, type)
                and issubclass(value, KVFormatSpec)
                and value is not KVFormatSpec
            ):
                specs[value.engine_kv_format] = value
    return specs
~~~

MLA 的 spec 只有十几行，因为它的大部分方法与普通 per-layer 格式相同，差异集中在 %%kv_size == 1%%：

~~~python
class NL_X_NB_BS_HS_Spec(KVFormatSpec):
    engine_kv_format = lmcache_native.EngineKVFormat.NL_X_NB_BS_HS
    attention_backends = ("vLLM MLA / SGLang MLA (MP)",)
    is_layer_list = True
    is_mla = True
...
    def kv_size(self) -> int:
        return 1
~~~

DSA indexer 的 spec（%%lmcache/v1/gpu_connector/kv_format/specs/nl_x_nb_bsv_bss.py:21%%）整个类只声明了自己的枚举值与 %%attention_backends%%，其余全部继承 MLA spec。它多出来的信息是物理页内的排布：每块先放全部 token 的 128 字节 fp8 值，再放全部 token 的 4 字节 scale（%%lmcache/v1/gpu_connector/kv_format/specs/nl_x_nb_bsv_bss.py:7%%），只有传输内核需要知道这件事。

### 传输侧怎么把平面数取出来

%%lmcache-ascend%% 的 NPU 连接器按格式逐 case 抽指针，%%DSA_C8_KV%% 分支把四个平面依次展开：

~~~python
    if entry_format == KVCacheFormat.DSA_C8_KV:
        k_cache, v_cache, dsa_k_cache, dsa_k_scale = entry
        return [
            k_cache.data_ptr(),
            v_cache.data_ptr(),
            dsa_k_cache.data_ptr(),
            dsa_k_scale.data_ptr(),
        ]
~~~

### 落盘时格式变成字节

%%EncodedKV%% 是格式在磁盘上的对应物：头部记 K、V、scale 三个 dtype 与三个长度，%%payload%% 按 K 字节接 V 字节接 scale 的顺序拼。scale 的组织由 %%ScaleScope%% 描述，默认是 %%per_page_head%%（%%lmcache/v1/kv_codec/encoded_kv.py:171%%），因为分页 KV 天然不满足整层张量的极值假设。跨模型、跨 tokenizer、跨 rope 配置、跨 backend 的命中由头部里的六个哈希把关（%%lmcache/v1/kv_codec/encoded_kv.py:130%%）。
`,
      },
    ],
    seams: [
      {
        name: 'KVCacheFormat 的整数值',
        from: 'LMCache-Ascend 的 Python 枚举',
        to: 'kvcache-ops 的 C++ 枚举',
        at: 'lmcache_ascend/v1/kv_format.py:131',
        why: 'docstring 要求两边顺序一致以「ensure correct interoperability」；在钉住的 kvcache-ops @ c3db0eb 上，third_party/kvcache-ops/kernels/types.h:29 只声明到 DSA_KV=4，Python 侧多出的 DSA_C8_KV 与 MULTI_PLANE_KV 没有对应成员',
      },
      {
        name: 'EngineDetector.discover()',
        from: '引擎注册适配层',
        to: 'kv_format 探测层',
        at: 'lmcache/v1/gpu_connector/kv_format/detectors/base.py:44',
        why: '一个方法同时完成 reshape 与格式识别，返回 (格式, 规范化后的 kv_caches)；返回 None 表示这个注册结构不被认识，调用方据此抛错',
      },
      {
        name: 'KVFormatSpec.data_ptrs()',
        from: 'spec',
        to: '传输内核的参数表',
        at: 'lmcache/v1/gpu_connector/utils.py:392',
        why: '指针顺序是格式相关的：MLA 每层一个、DSA 三个、DSA-C8 四个、每层元组形态按 K 与 V 交错、跨层格式只给一个基址由内核自己走层',
      },
      {
        name: 'PageBufferShapeDesc.block_stride_elems',
        from: 'spec 层的 stride 解析',
        to: '设备搬运内核',
        at: 'lmcache/v1/gpu_connector/utils.py:629',
        why: '它是 Dim-0 padding 唯一的传递通道；DeepSeek V4 的 compressor 与 indexer 缓存与更大的 attn group 共用一个 KV pool 时，这个字段不填内核就会跳过 padding 读错字节',
      },
      {
        name: 'multi_layer_gdn_state_transfer',
        from: 'state cache 与 storage backend',
        to: '昇腾 GDN state 内核',
        at: 'third_party/kvcache-ops/kernels/multi_layer/multi_layer_gdn_state_kernels.h:28',
        why: '参数里只有 blockId 与 sliceNumel，没有 token 维度与 block_size；state 按块寻址、每块大小固定，这是它与 KV 搬运接口最直接的区别',
      },
    ],
    related: ['lmcache', 'lmcache-ascend', 'vllm', 'vllm-ascend', 'cann'],
  }

];
