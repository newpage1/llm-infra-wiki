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
    { name: 'LMCache', rev: 'v0.4.4' }
  ],

  summary:
    '在普通的 dense 模型里，KV 就是 %%(K, V)%% 两块张量，搬运是直接的地址拷贝。' +
    '**在 DSA / 稀疏 KV 下这件事变了**：一个稀疏层的 KV 在 forward 时聚合成 **6 项**（A5 下 7 项），' +
    '而它从模型语义走到磁盘，**要经过四次形状变换**。' +
    '**每一次变换都是一处可能出错的接缝。**',

  reading: [
    '先看**形状变换链**：注意每一层的「块大小」含义都不同——**这是全部复杂度的来源**。',
    '再看 **Store / Retrieve 两条链**：它们不是对称的，Retrieve 要**逐 plane 选各自的 slot mapping**。',
    '最后看 **六处风险**——这一节的密度最高，且都标注了是「已确认」还是「推断」。'
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
        { t: '① 逻辑 token 空间', a: 'vLLM scheduler 的 block_size',
          note: '%%block_size = 16%%（原始 token 数）。**这一层的块大小是模型语义，不是存储语义**' },
        { t: '② 物理存储行', a: 'storage_block_size = block_size / compress_ratio',
          note: '★ **C4 每 4 个原始 token 一行，C128 每 128 个一行。** 逻辑 token 数与物理行数从此分离' },
        { t: '③ typed / as-strided 多 plane view', a: 'vLLM-Ascend 的 raw allocation',
          note: '★ 先申请一维 int8 backing，再构造 typed view。**不同 dtype（FP8/FP32）+ 不同块大小 + 不同压缩比**' },
        { t: '④ uint8 packed LMCache row', a: 'v1/npu_connector/npu_connectors.py',
          note: '★ 异质 plane 被压成**连续 byte chunk + metadata**，装进 multi-group MemoryObj' },
        { t: '⑤ SSD raw bytes', a: 'LocalDisk / P2P / 远端', note: '到这一层已经没有形状，只有字节' }
      ],
      html: `
### 一句话概括这次变化的本质

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
而 DSA 打破了这个假设。**
      `.trim()
    },
    {
      id: 'store',
      layer: 'engine',
      title: 'Store 链',
      direction: 'out',
      steps: [
        { t: '模型 forward', a: '—',
          note: 'SWA scatter → compressor 产出 C4/C128 row + compressed slot → main/indexer quant scatter' },
        { t: 'LMCache connector', a: 'integration/vllm/vllm_v1_adapter.py',
          note: '每 request 保留 %%block_ids_by_group%% → 生成 %%slot_mappings_by_group%% → **过滤 -1** → 按 layer layout 建 transfer groups' },
        { t: 'LMCacheEngine.store', a: 'v1/cache_engine.py:388',
          note: '按 token hash 切 logical chunk → CPU allocator 申请 **multi-group MemoryObj**' },
        { t: 'NPU connector D2H', a: 'v1/npu_connector/npu_connectors.py',
          note: '★ **对每个 transfer group、每个 plane**：paged slot gather → 写入 uint8 packed LMCache row' },
        { t: 'StorageManager.batched_put', a: 'v1/storage_backend/storage_manager.py',
          note: 'LocalCPU 热缓存 → 可异步复制到 SSD / P2P / 远端' }
      ],
      html: `
**注意第 4 步是两重循环**：transfer group × plane。

**为什么必须逐 plane 处理**：因为每个 plane 的压缩比不同，
**slot mapping 也就不同**——主 KV 可能按 C128 存，SWA 按 C4 存。
**用一条 slot mapping 覆盖全部 plane 会写错位置。**

**第 2 步的「过滤 -1」也值得注意**：与本站《LMCache-Ascend · NPUConnector》
里引用的那句注释（%%slot_mapping%% 中前缀部分是 -1）是同一件事——
**这里的 -1 代表"该位置不需要保存"**，过滤后生成 dense slots。
      `.trim()
    },
    {
      id: 'retrieve',
      layer: 'engine',
      title: 'Retrieve 链：与 Store 不对称',
      direction: 'in',
      steps: [
        { t: 'TokenDatabase 查找完整 chunk', a: 'v1/token_database.py' },
        { t: 'CPU 命中，或 SSD raw bytes 读回', a: 'v1/storage_backend/',
          note: '读回的仍是 **multi-group MemoryObj**' },
        { t: 'P2P 场景可能先得到 ProxyMemoryObj', a: 'v1/proxy_memory_obj.py',
          note: '★ **只带元数据，延迟到 %%batched_to_gpu%% 才真正取数**——与散射流水化' },
        { t: 'NPU connector H2D', a: 'v1/npu_connector/npu_connectors.py',
          note: '★ **每 plane 选择自己的 slot mapping** → uint8 packed row 解包 → scatter 回各自 paged cache' },
        { t: 'attention 读取', a: 'wait_for_kv_layer_from_connector',
          note: '从恢复后的 SWA / main / indexer page 读取' }
      ],
      html: `
### 不对称的地方

**Store 是「逐 plane 打包成一个 row」，Retrieve 是「逐 plane 解包回各自的 page」。**
看起来是对称的，但**Retrieve 多了一条路径**：

> %%P2P 时可能先获得 ProxyMemoryObj%%

**这正是本站《LMCache-Ascend · MemoryManager / KvFormat》里分析过的那个延迟求值对象。**
它在这里的作用是：把「取数」推迟到 %%batched_to_gpu%%，**让远端取数与 NPU 散射重叠**。

**所以 DSA 场景下这个对象的价值更大**——因为 plane 数量多了，
**逐 plane 的取数如果串行执行会非常慢**，而延迟求值让它们可以流水化。

**这是两处分析在同一个对象上会合的第二个例子**
（第一个是 %%NPUConnector._remote_batched_to_gpu%% 与 %%ProxyMemoryObj%% 的关系）。
      `.trim()
    },
    {
      id: 'risks',
      layer: 'engine',
      title: '六处风险',
      direction: 'both',
      steps: [
        { t: '主线 / 分支兼容断层', a: 'LMCache-Ascend e05a757',
          note: '★ **DSV4 完整功能在 %%origin/dsv4_support_045%%，尚未并入 main。** 部署必须用成套版本，不能任意拼接最新四个仓库' },
        { t: 'state cache 不能按普通 token KV 处理', a: '—',
          note: 'state 只是未完整压缩组的 accumulator；跨非整 chunk 边界恢复需额外定义 4 项协议' },
        { t: 'shared backing 与 overlapping view', a: '—',
          note: '★ **不能按 Python tuple 元素数算外存大小**——同 storage 同 data_ptr、同 storage 不同 data_ptr、不同 storage 是三种情况' },
        { t: 'page padding', a: '—',
          note: '★ NPU cache 可能是 %%as_strided%% view；逐 block 拷贝**必须用真实 %%block_stride%%**，否则下一 block 读错地址' },
        { t: 'Python/C++ enum 注释不一致', a: 'kernels/types.h',
          note: 'Python 定义 %%DSA_C8_KV=5%% / %%MULTI_PLANE_KV=6%%，但锁定的 C++ %%types.h%% 只到 %%DSA_KV=4%%' },
        { t: '未做 NPU runtime 验证', a: '—',
          note: '静态调用链与布局核对已完成，**但无 Ascend NPU/CANN 运行环境**，未跑 round-trip / 精度 / 带宽测试' }
      ],
      html: `
### 逐条说明它们的性质

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
而非实测——**引用时不应说成"验证过"。**
      `.trim()
    }
  ],

  seams: [
    { name: 'block_size → storage_block_size', from: '调度语义', to: '存储语义',
      at: 'vLLM-Ascend 的 cache spec',
      why: '★ **全部复杂度的源头**：逻辑 token 数与物理行数从此分离，slot mapping 不再唯一' },
    { name: 'slot_mappings_by_group', from: 'vLLM', to: 'LMCache connector',
      at: 'integration/vllm/vllm_v1_adapter.py',
      why: '每 group 一套 slot mapping；过滤 -1 后生成 dense slots' },
    { name: 'uint8 packed row', from: 'NPU cache', to: 'LMCache MemoryObj',
      at: 'v1/npu_connector/npu_connectors.py',
      why: '异质 plane 被压成连续字节 + metadata —— **LMCache 侧只看字节，不看 plane 语义**' },
    { name: 'ProxyMemoryObj', from: 'LMCache', to: 'P2P / 远端',
      at: 'v1/proxy_memory_obj.py',
      why: '延迟求值：plane 越多，流水化的收益越大' }
  ],

  related: ['vllm-ascend', 'lmcache-ascend', 'lmcache', 'cann', 'ascend-store-connector']
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
    { name: 'Mooncake', rev: '408b831' }
  ],

  summary:
    'KV 在昇腾栈上不止一条路。**路径 A** 用 LMCache-Ascend 做实例内的多级缓存与 P2P/PD；' +
    '**路径 B** 用 AscendStoreConnector 把 KV 送进 Mooncake 这个分布式对象存储；' +
    '**路径 C** 是把两者接起来——LMCache 管近端，Mooncake 管远端。' +
    '**三条路的强项在不同层次，所以"A 比 B 好"这个问法本身不成立。**',

  reading: [
    '先看**三通路对照图**：注意三条路在「vLLM 接入」这一层是同一个契约，分野在下面。',
    '再看**逐维度对照**——管理 / 传输 / 存储三段，每段给出「谁更强 + 为什么」。',
    '最后看**共同短板**：P/D 的 TP 数不同这件事，**三条路目前都不成立**。'
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
        { t: 'vLLM 调度接入', a: 'integration/vllm/vllm_v1_adapter.py',
          note: 'A：LMCache adapter 返回外部命中长度；B：AscendStore 直接用 vLLM block hash 与 cache group' },
        { t: 'KV 索引', a: '—',
          note: 'A：%%CacheEngineKey%% + 链式 chunk hash + tier location；B：%%PoolKey%% = model + parallel ranks + group/role/family + block hash' },
        { t: 'KV 内存布局', a: 'v1/npu_connector/npu_connectors.py',
          note: 'A：NPU connector 把 vLLM layout gather/scatter 成 MemoryObj；B：直接从 vLLM KV tensor 算 block/layer/head slice 地址' },
        { t: '传输', a: 'v1/transfer_channel/ · transfer_engine',
          note: 'A：HCCL/HIXL channel；B：Mooncake TransferEngine + Ascend transport' },
        { t: '存储控制面', a: '—',
          note: 'A：%%StorageManager%% + CacheController；B：Mooncake Master' }
      ],
      html: `
**这一节是整条分析的地基。** 原始对比文档里有一句话值得直接引用：

> 「因此，『LMCache 前缀匹配强』与『Mooncake 副本 HA 强』并不矛盾：
> **它们本来就位于不同层**。真正公平的比较对象必须是两套完整方案。」

**两层的关键差别在这里**：

| | A 的 %%CacheEngineKey%% | B 的 %%PoolKey%% |
|---|---|---|
| 组成 | 链式 chunk hash + tier location | model + parallel ranks + group/role/family + block hash |
| 谁定义 | LMCache 自己 | **直接复用 vLLM 的 block hash** |
| 后果 | 可跨 tier 接续查找 | **与 vLLM 的新 KV 类型天然一致** |

**所以两者其实是"自己造索引"与"复用引擎索引"的分歧**——
而这一分歧贯穿到后面每一节。
      `.trim()
    },
    {
      id: 'dimensions',
      layer: 'engine',
      title: '逐维度对照',
      direction: 'both',
      steps: [
        { t: 'KV 管理 · 前缀匹配', a: '—', note: 'LMCache 略强：链式 hash 可跨 CPU/Disk/Remote/P2P 接续；AscendStore 略强于模型语义一致性' },
        { t: 'KV 管理 · hybrid / SWA / Mamba', a: '—', note: 'AscendStore 更好：直接复用 vLLM 的 KVCacheSpec manager，原生维护 group mask、SWA clip' },
        { t: 'KV 管理 · MLA / DSA TP 冗余消除', a: '—', note: '两边都能去掉同组重复写；LMCache 语义更直接（save_only_first_rank）' },
        { t: 'KV 管理 · layerwise', a: '—', note: 'AscendStore 能力更宽（两条模式）但成熟度不足；LMCache 不支持 async store，与 P2P/PD 不兼容' },
        { t: 'KV 传输 · 专用 PD backend', a: 'v1/storage_backend/pd/',
          note: 'LMCache 更灵活：HCCL/HIXL、push/pull/delay-pull、CPU offload；AscendStore 没有独立 PD backend' },
        { t: 'KV 传输 · 注册内存与多段搬运', a: 'registerLocalMemory',
          note: 'Mooncake 的通用 registered-memory fabric 更完整；支持 multi-buffer batch put/get 与 Fabric 模式' },
        { t: 'KV 传输 · 失败传播', a: 'mooncake_backend.py',
          note: '★ LMCache 更好：P2P 返回明确 error，PD 有 backoff，pull 总发 Done 释放资源；AscendStore 的 put 失败只记日志' },
        { t: 'KV 存储 · 本地多级缓存', a: 'v1/storage_backend/',
          note: 'LMCache 更好：LocalCPU 是热缓存与 staging，可组合 Disk/Remote/P2P/PD，支持 LRU/LFU/FIFO/MRU' },
        { t: 'KV 存储 · 分布式对象与副本', a: 'src/master_service.cpp',
          note: '★ Mooncake 明显更好：Master 管 object / segment / replica / read lease / tenant quota / 水位淘汰' },
        { t: 'KV 存储 · 控制面 HA', a: 'src/ha/',
          note: '★ Mooncake 明显更好：leader coordinator + standby promotion + oplog + snapshot。**LMCache 的 mp_coordinator 有 fleet 级 registry 与持久化状态，但没有选主与 HA**（其 persistence 文档说明重启后靠各组件自恢复）' }
      ],
      html: `
### 三处「★」是差距最大的地方

我把原始对比里结论最明确的三条挑出来：

| 维度 | 谁更强 | 差距性质 |
|---|---|---|
| **失败传播** | LMCache | AscendStore 的 %%MooncakeBackend.put()%% **捕获异常后只记日志，不把失败返回给发送线程** |
| **分布式对象与副本** | Mooncake | 完整的 object / replica / quota / 水位淘汰体系 |
| **控制面 HA** | Mooncake | Mooncake 有 leader + oplog + snapshot；**LMCache 的 mp_coordinator 有持久化状态但无选主**，重启后由各组件自行恢复 |

**前一条是正确性问题，后两条是能力缺失。**
这解释了为什么原始文档的结论是「要 KV 管理平台能力选 LMCache，
要分布式 KV 对象存储能力选 Mooncake」——**它们缺的不是同一类东西。**
      `.trim()
    },
    {
      id: 'gap',
      layer: 'transport',
      title: '共同短板：P/D 的 TP 数不同',
      direction: 'in',
      steps: [
        { t: 'A：Ascend PD backend', a: 'v1/storage_backend/pd/sender_mixin.py',
          note: '按同 %%tp_rank%% 连接，按发送端 shape/dtype 搬 raw bytes —— **没有通用 reshard**' },
        { t: 'B：AscendStore', a: '—',
          note: 'dense GQA 的 strided head-slice 代码**已存在**，但主分支 transfer thread 没传 %%worker%%，**生产入口不可达**' },
        { t: '结论', a: '—',
          note: '**两边当前都不能视为可靠支持**' },
        { t: '而 MLA / hybrid / sparse / layerwise', a: '—',
          note: '**明确不支持** —— 这不是简单地址搬运，需要 canonical layout 与模型语义感知的重排' }
      ],
      html: `
**这是本节最需要读者记住的一条。**

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
| **P/D TP 不同且是 MLA/DSV4/sparse** | **都不推荐** |
      `.trim()
    }
  ],

  seams: [
    { name: 'KVConnectorBase_V1', from: '推理引擎', to: 'KV 通路',
      at: 'vllm/distributed/kv_transfer/kv_connector/v1/base.py',
      why: '**三条路共用同一个契约**——所以它们可以在同一个 vLLM 里替换，而不改引擎' },
    { name: 'CacheEngineKey', from: 'LMCache', to: '索引',
      at: 'lmcache/utils.py',
      why: 'A 路自造的键：链式 chunk hash + tier location，因此能跨 tier 接续查找' },
    { name: 'PoolKey', from: 'AscendStore', to: '索引',
      at: 'kv_pool/ascend_store/config_data.py',
      why: 'B 路复用 vLLM 的 block hash，因此与引擎的新 KV 类型天然一致' },
    { name: 'mooncakestore:// adapter', from: 'LMCache', to: 'Mooncake',
      at: 'lmcache/v1/storage_backend/connector/mooncakestore_adapter.py',
      why: '★ **路径 C 的接缝**——让 LMCache 的近端能力与 Mooncake 的远端能力组合起来' }
  ],

  related: ['lmcache-ascend', 'ascend-store-connector', 'mooncake', 'vllm-ascend', 'hixl']
},

{
  id: 'kv-save-load',
  title: 'KV Save / Load 全链路',
  subtitle: 'vLLM-Ascend ⇄ Mooncake（昇腾栈）',
  kind: 'call-path',

  participants: ['vllm-ascend', 'ascend-store-connector', 'mooncake', 'hixl', 'cann'],
  revisions: [
    { name: 'vllm-ascend', rev: 'be42704' },
    { name: 'Mooncake', rev: 'e389a85' },
    { name: 'CANN', rev: '9.1.0' }
  ],

  summary:
    '一次请求的 KV 如何在本机 NPU 显存与共享 KV 池之间往返。' +
    '关键结论只有一句：**控制面只搬元数据，数据面才搬字节**——' +
    'Master 的 RPC 从不携带 KV，它只回答「副本在哪」。',

  reading: [
    '先看**总图**：上下两条带分别是控制面与数据面，它们之间只有一条细箭头相连——那是全链路唯一的接缝。',
    '再看 **Save / Load 两条腿**：每条都是带 `file:line` 的编号调用链，跨模块的跳都标了出来。',
    '最后看**接缝表**：如果只记三个符号，记那张表。'
  ],

  /* 手绘 SVG：控制面 / 数据面 分离 */
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

  <!-- ═══ 控制面 ═══ -->
  <rect x="20" y="20" width="1160" height="140" rx="10"
        fill="var(--l1)" fill-opacity=".045" stroke="var(--line)"/>
  <rect x="20" y="20" width="1160" height="3" fill="var(--l1)" clip-path="url(#cpC)"/>
  <text x="44" y="48" class="t-band" fill="var(--l1)">CONTROL PLANE · 控制面</text>
  <text x="250" y="48" class="t-sub">只走元数据：谁在哪、命中多少、要不要加载</text>

  ${[
    ['vLLM Scheduler', 'BlockPool 查本地命中', 44],
    ['LookupClient', 'ZeroMQ 跨进程查询', 324],
    ['KVPoolWorker', '构造 Store key', 604],
    ['Mooncake Master', '查副本位置 · 返回 LoadSpec', 884]
  ].map(([t, s, x]) => `
    <rect x="${x}" y="76" width="256" height="62" rx="7"
          fill="var(--panel)" stroke="var(--line)"/>
    <text x="${x + 16}" y="102" class="t-title-sm">${t}</text>
    <text x="${x + 16}" y="123" class="t-mono">${s}</text>`).join('')}

  <line x1="304" y1="107" x2="320" y2="107" class="t-line" marker-end="url(#farr)"/>
  <line x1="584" y1="107" x2="600" y2="107" class="t-line" marker-end="url(#farr)"/>
  <line x1="864" y1="107" x2="880" y2="107" class="t-line" marker-end="url(#farr)"/>

  <!-- ═══ 唯一接缝 ═══ -->
  <line x1="1012" y1="164" x2="1012" y2="212" stroke="var(--l3)" stroke-width="1.5"
        stroke-dasharray="5 4" marker-end="url(#farrk)"/>
  <rect x="856" y="172" width="300" height="30" rx="4" fill="var(--bg)"/>
  <text x="1012" y="184" class="t-mono-c" text-anchor="middle">只返回副本位置</text>
  <text x="1012" y="198" class="t-mono" text-anchor="middle">RPC 不携带任何 KV 字节</text>

  <!-- ═══ 数据面 ═══ -->
  <rect x="20" y="216" width="1160" height="140" rx="10"
        fill="var(--l3)" fill-opacity=".05" stroke="var(--line)"/>
  <rect x="20" y="216" width="1160" height="3" fill="var(--l3)" clip-path="url(#cpD)"/>
  <text x="44" y="244" class="t-band" fill="var(--l3)">DATA PLANE · 数据面</text>
  <text x="250" y="244" class="t-sub">只走字节：KV 块本体的搬运</text>

  ${[
    ['NPU KV tensor', 'HBM 地址 + 长度', 44],
    ['TransferEngine', 'submitTransfer 批量提交', 324],
    ['ADXL / HCCL', '昇腾传输链路', 604],
    ['Store segment', 'DRAM / SSD / 远端', 884]
  ].map(([t, s, x]) => `
    <rect x="${x}" y="272" width="256" height="62" rx="7"
          fill="var(--panel)" stroke="var(--l3)" stroke-opacity=".4"/>
    <text x="${x + 16}" y="298" class="t-title-sm">${t}</text>
    <text x="${x + 16}" y="319" class="t-mono">${s}</text>`).join('')}

  <line x1="304" y1="303" x2="320" y2="303" class="t-line" marker-end="url(#farr)"/>
  <line x1="584" y1="303" x2="600" y2="303" class="t-line" marker-end="url(#farr)"/>
  <line x1="864" y1="303" x2="880" y2="303" class="t-line" marker-end="url(#farr)"/>
</svg>`,

  legs: [
    {
      id: 'save',
      layer: 'engine',
      title: 'Save：本机 NPU → 共享池',
      direction: 'out',
      steps: [
        { t: 'Worker 产生新 KV', a: 'vllm_ascend/worker/model_runner_v1.py', note: '前向结束，KV 已落在分页池' },
        { t: 'block hash → PoolKey', a: 'kv_pool/ascend_store/config_data.py', note: '前缀哈希即缓存键，跨实例可复现' },
        { t: 'store_mask 过滤', a: 'kv_pool/ascend_store/ascend_store_connector.py', note: '不完整 chunk 不保存' },
        { t: '跳过已由外部 load 的区间', a: '同上', note: '避免把刚取回来的又写回去' },
        { t: 'exists 查询', a: 'pool_worker.py', note: '已存在的 key 直接跳过' },
        { t: 'prepare_value → NPU 源地址', a: 'pool_worker.py:739-756', note: '_align_kv_ptrs：2MB 对齐是硬要求' },
        { t: '等待 NPU event', a: 'pool_worker.py', note: '确保写入完成再传输' },
        { t: 'MooncakeBackend.put', a: 'kv_pool/ascend_store/backend/mooncake_backend.py', note: '跨入存储系统边界' },
        { t: 'pybind：uintptr_t → Slice{ptr,size}', a: 'mooncake-integration/transfer_engine', note: 'Python 地址交给 C++' },
        { t: 'Client::BatchPut', a: 'mooncake-store/src/client_service.cpp:1173', note: '进入 Mooncake' },
        { t: 'Master::BatchPutStart', a: 'mooncake-store/src/master_service.cpp', note: '★ 控制面：分配副本位置' },
        { t: '需要 staging？', a: 'mooncake-store/src/transfer_task.cpp:488', note: '否则 NPU 源 slice 直接参与传输' },
        { t: 'TransferSubmitter WRITE', a: '同上', note: '★ 数据面：真正发起搬运' },
        { t: 'ADXL / HCCL 执行', a: 'mooncake-transfer-engine/src/transport/ascend_transport/', note: 'protocol="ascend" 分支' },
        { t: 'Master::BatchPutEnd', a: 'mooncake-store/src/master_service.cpp', note: 'replica 标记 COMPLETE，key 才可读' }
      ]
    },
    {
      id: 'load',
      layer: 'engine',
      title: 'Load：共享池 → 本机 NPU',
      direction: 'in',
      steps: [
        { t: '请求 token / block hash', a: 'vllm/v1/core/sched/scheduler.py' },
        { t: 'KVCacheManager 查本地 HBM 最长前缀', a: 'vllm/v1/core/kv_cache_manager.py', note: '得到 hbm_hit_tokens' },
        { t: 'get_num_new_matched_tokens', a: 'vllm/distributed/kv_transfer/kv_connector/v1/base.py:454', note: '★ 接缝：调度阶段就问「能省多少」' },
        { t: 'LookupClient 外部 lookup（ZMQ）', a: 'kv_pool/ascend_store/ascend_store_connector.py', note: '跨进程，不阻塞调度主循环' },
        { t: 'Mooncake batch_is_exist', a: 'mooncake-store/src/client_service.cpp', note: '得到 external_hit_tokens' },
        { t: '组装 LoadSpec', a: 'kv_pool/ascend_store/config_data.py', note: 'local + external + skip 三段' },
        { t: 'external > local ？', a: 'vllm/v1/core/sched/scheduler.py', note: '★ 只有超过才分配新 block 并取数' },
        { t: '为 external suffix 分配 HBM block', a: 'vllm/v1/core/kv_cache_manager.py' },
        { t: 'prepare_value → NPU 目标地址', a: 'pool_worker.py' },
        { t: 'batch_get_into_multi_buffers', a: 'backend/mooncake_backend.py', note: '跨入存储系统边界' },
        { t: 'Master BatchQuery → replica 描述符', a: 'mooncake-store/src/master_service.cpp', note: '★ 控制面：仍然不含字节' },
        { t: 'TransferSubmitter READ', a: 'mooncake-store/src/transfer_task.cpp:488', note: '★ 数据面：拉取' },
        { t: '写入本地 NPU HBM block', a: 'ascend_transport', note: 'ADXL 单边读' },
        { t: 'block table 指向已填充块', a: 'vllm/v1/core/kv_cache_manager.py', note: '调度器据此跳过对应 prefill' }
      ]
    }
  ],

  seams: [
    { name: 'KVConnectorBase_V1', from: '推理引擎', to: 'KV 传输',
      at: 'vllm/distributed/kv_transfer/kv_connector/v1/base.py',
      why: '调度阶段就能问出「外部能命中多少 token」，而不必等到执行时才发现' },
    { name: 'MooncakeBackend.put / get', from: 'KV 传输（引擎侧）', to: 'KV 存储',
      at: 'vllm_ascend/.../kv_pool/ascend_store/backend/mooncake_backend.py',
      why: '三个后端（mooncake / memcache / yuanrong）在此替换，上层不变' },
    { name: 'Master RPC', from: '控制面', to: '数据面',
      at: 'mooncake-store/src/client_service.cpp',
      why: '★ 接缝只传位置，不传字节——这是全链路最重要的一条边界' },
    { name: 'registerLocalMemory', from: '推理引擎', to: '传输引擎',
      at: 'mooncake-transfer-engine/src/transfer_engine.cpp',
      why: '未注册的显存无法被网卡访问；且 HCCL 有 256 区域上限' }
  ],

  related: ['vllm-ascend', 'ascend-store-connector', 'mooncake', 'hixl', 'cann', 'lmcache-ascend']
}

];
