# LLM Infra Wiki

大模型推理基础设施的**分层知识库**站点。按「集群调度 → 推理引擎 → KV 传输 → KV 存储」四层组织，
外加一条纵向穿透的底座带，每个组件页包含**整体介绍**与**代码流程子模块走读**。

> **v0.1 原型**：结构、视觉、交互已定型。当前覆盖 **27 个组件 / 137 个模块走读**，
> 其中 10 个是完整走读（LMCache-Ascend、LMCache、Mooncake、
> vLLM、SGLang、vLLM-Ascend、Dynamo、CANN、CUDA、HIXL），其余 17 个为「骨架」。
>
> **当前内容重点：LMCache-Ascend、LMCache 与 Mooncake**——这两个组件的页面依据本地 call-path 走读笔记重写，
> 包含整体调用链、模块之间的关系、以及每个模块的功能设计（LMCache-Ascend 12 模块 / LMCache 7 / Mooncake 16）。

---

## 这个站点是做什么的

一个按技术栈分层整理的**大模型推理基础设施知识库**。每个组件都讲清三件事：

1. **它解决什么问题**（特点速览）
2. **关键抽象落在哪几个文件里**（模块的文件路径）
3. **一次请求在它内部怎么流动**（调用链）

并标注**昇腾与 NVIDIA 两条栈各自由谁实现**。

首页的阅读顺序是：

1. **部署拓扑** —— 一张与下方分层**同宽**的图：应用/Agent → 网关 → 集群调度 →
   PD 集群（Prefill 池 / Decode 池，实例以芯片图标表示）→ KV 存储池（DRAM / 本地 SSD / 远端，宽度递增）。
   图里画出两条通信路径：**P → D 直传**与**实例 ⇄ 存储池**。先建立直观概念，再往下看分层。
2. **技术栈分层** —— 每层先列**组件**（主内容），再列该层要回答的问题；
   「本层在链路中承担什么」默认折叠。层与层之间画双向交互带。
3. **底座** —— CANN / CUDA，纵向穿透所有层。

首页另提供四个入口：按层浏览组件 · 搜到具体模块 · 切换栈视角做对比 · 展开折叠看某层在链路中承担什么。

## 改完静态资源后必须 bump 版本号

```bash
python3 bump.py        # index.html 里 10 个 ?v=N 统一 +1
```

**为什么单独做成脚本**：之前手工用 `sed 's/?v=41/?v=42/'` 递增，
一旦中间跳号（例如从 55 直接写 57），之后每次 sed 都**静默不匹配**，
版本号再也不动——而 sed 不报错，看起来一切正常。
**结果是浏览器一直用缓存的旧文件，改动看不到。**
本项目的版本号就这样卡在 `?v=48` 过好几轮。

`bump.py` 会校验：取值必须唯一、替换必须全部成功，否则报错退出。

## 成表的内容必须画框线

**凡是并列成表的内容，一律画出外框与单元格竖线。**

只画横线的表格会让多列的行难以横向对齐，**看起来像浮空的文字**——
尤其当单元格里是较长的中文时，读者无法判断某段文字属于哪一列。

涉及三处，样式必须一致：

| 位置 | 选择器 |
|---|---|
| 组件页正文 | `.prose table` |
| 深度分析页正文 | `.an-body table` |
| 联动分析的接缝表 | `.seam-table` |

另外 `.leg-steps`（联动分析的步骤列表）虽然语义上是列表，
**但结构是"编号 + 标题 + 内容"的固定三行，同样按表格处理**——
加外框与行分隔线。

新写页面时若出现新的表格容器，记得一并加上。

## 两项对比用「属性为行」

列的多少要与内容的分布相称。**只有两项要对比时，不要用「项为行」的三列表**——
那样每一项只占一行，而属性列会很空。

反例（改前）：

```
| 层 | 是什么 | 谁管 |
| L1 | ... | 服务端 |      ← 「谁管」列只有三个字，却占三分之一宽
| L2 | ... | adapter 族 |
```

正例（改后）：

```
|            | L1 | L2 |
| 是什么      | ... | ... |
| 谁持有      | ... | ... |
| 淘汰由谁决定 | ... | ... |
```

**转置还有一个附带好处：会逼你想清楚「该比哪几个维度」。**
上面那张表在转置时补出了「淘汰由谁决定」——
而 L1 实例自治、L2 集群统一，正是两者的实质差别。

**判据**：如果一张表只有两行数据、且某一列的内容普遍短于 10 个字，
就该考虑转置。

## 模块页的骨架：照搬业界 wiki

骨架来自 [inkeep/open-knowledge 的 `codebase-wiki`](https://github.com/inkeep/open-knowledge)
（"把 DeepWiki 放进仓库"）。它的分册与本站在结构上是对齐的：

| 业界 | 本站 |
|---|---|
| `OVERVIEW.md` | `#/` 全景 |
| `architecture/` | `#/a/<id>` 深度分析 |
| `modules/` | `#/a/<id>/<mid>` 模块页 |
| `flows/` | `#/flows` 联动分析 |

业界对模块页的规定是原文这六项，逐项对应成七节：

| # | 节 |
|---|---|
| 1 | 用途与职责（含**不负责什么**） |
| 2 | 内部结构（表 + 类图） |
| 3 | 公开 API 与入口 |
| 4 | 关键文件 |
| 5 | 依赖 |
| 6 | 参与的流程（调用路径） |
| 7 | 未覆盖 |

### 两处不要放在模块页

| 内容 | 该放哪 | 依据 |
|---|---|---|
| **设计决策** | 深度分析页 | 业界：architecture 页含 "the design decisions behind them"，模块页规定里没有 |
| **失效模式** | 联动分析页 | 业界：flows 页 "add a Failure modes section per flow" |

**顺序铁律**：用途 → 职责 → 结构 → 类图 → API → 依赖 → 流程，
走完这些读者应当**不必读源码就能说出这个模块由哪几块组成**；
**具体实现放在其后**。

## sticky 侧栏必须自己可滚## sticky 侧栏必须自己可滚

**sticky 元素被钉在 `top` 之后，自身不随页面滚动。**
如果它的内容高于视口，**超出部分永久不可达**——表现为"目录拖不动"。

本项目实测（`#/a/lmcache`，28 个条目）：

```
视口高      577
侧栏高     1043   ← 超出 570px
position   sticky, top:104
overflow   visible ← 关键
```

**修法是三件一起**：

```css
.an-side{
  position:sticky; top:88px;
  max-height:calc(100vh - 112px);   /* 留出 top 偏移与底部呼吸空间 */
  overflow-y:auto;
}
```

**两个断点都要处理**：

| 断点 | 要求 |
|---|---|
| 桌面 | `max-height` + `overflow-y:auto` —— 侧栏独立滚动 |
| **移动（≤860px）** | **`position:static` 的同时必须清掉 `max-height` 与 `overflow`** |

**移动端这条最容易漏**：只改 `position` 而留着 `max-height`，
会在页面里**套出一个固定的嵌套滚动区**，比不修还难用。

**自查方法**：在两种宽度下量 `sidebar.getBoundingClientRect().bottom` 与
`innerHeight` 的关系，并检查 `scrollHeight > clientHeight` 时
`overflowY` 是否为 `visible`。

## 模块页只写本模块的内容

**每句话的主语必须是本模块。** 三种失守形式：

| 形式 | 例子（本项目真实出现过） | 改法 |
|---|---|---|
| **视角错位** | 在宿主页写「这是**全插件**改动最重的类」 | 「这是**被插件改写最多的宿主类**」 |
| **术语错位** | 在宿主页用插件的术语「净增能力」 | 「**插件新增的** 18 个方法做两件事」 |
| **位置错位** | 内容写进了错误的模块（批量编辑锚点选错） | 定位时**同时匹配模块 id 与节 id**，替换后校验落点 |

**判据**：把每句话的主语读出来，不是本模块就改写。

写「与 X 的接合」时，要写成「**本模块的哪些部分在被 X 跟随**」，
而不是替 X 做分析——**哪怕那段分析写得再好，放错位置就是噪音。**

## 行内标记的三条约束

内容里写 `**粗体**`、`%%行内代码%%` 时注意：

1. **SVG 里不能写 markdown** —— SVG 不经过 markdown 渲染，`**` 会原样显示。
   用 `<tspan font-weight="600">` 代替 `**`。
2. **代码块（`~~~` 围栏）里不能写 markdown** —— 同样不会被渲染。
3. **列表项里的 `**` 不要跨行** —— 渲染器逐行处理列表项，
   跨行的 `**` 匹配不上。（段落与引用块会先合并再渲染，所以不受影响。）

`lint_svg.py` 会检查第 1 条。

## 手绘 SVG 要跑一次重叠检查

```bash
python3 lint_svg.py     # 检查数据文件里手绘 SVG 的文字是否压在一起
```

手写 SVG 用绝对坐标定位文字，**很容易让同一行的两段文字重叠**——
曾出现「层标签」与「标题」画在同一基线且 x 区间相交，视觉上糊成一团。

`lint_svg.py` 按估算宽度做机械检查（CJK 记 2 单位，其余 1，乘字号 × 0.55），
只用于发现**明显重叠**，不能替代肉眼确认。有重叠时退出码非 0。

## 快速预览

```bash
cd llm-infra-wiki
./serve.sh              # → http://127.0.0.1:8899
./serve.sh --lan        # → 局域网内其他设备也能访问
PORT=9000 ./serve.sh    # 换端口
```

等价于 `python3 -m http.server 8899`。前台运行，Ctrl-C 停止。

> **改了样式/数据后看不到变化？** 多半是浏览器缓存。`index.html` 里的资源引用带了 `?v=N`，
> 每次改动 `assets/` 或 `data/` 后把这个数字 +1 即可强制刷新。
> 只改数据文件时也可以先按 **Cmd+Shift+R**（Windows: Ctrl+F5）硬刷新试试。

无需构建、无需 npm install。也可以直接双击 `index.html`——所有数据都内联在 `<script>` 里，
不依赖 `fetch`，所以 `file://` 协议下同样可用。

---

## 目录结构

```
llm-infra-wiki/
├── index.html                     # 唯一页面（hash 路由）
├── serve.sh                       # 本地预览脚本
├── assets/
│   ├── css/style.css              # 设计系统：暖色纸感风格 + 层级配色
│   └── js/
│       ├── markdown.js            # 轻量 Markdown 渲染器（含 heading 锚点生成）
│       └── app.js                 # 路由 / 渲染 / 搜索 / TOC 滚动高亮
└── data/
    ├── catalog.js                 # 编目：4 层 + 底座 + 27 个组件的元信息与「特点速览」
    ├── details.js                 # 7 个旗舰组件的完整走读
    ├── details-ascend.js          # 昇腾线深度解读（CANN、HIXL）
    ├── details-nvidia.js          # NVIDIA 线底座（CUDA）
    └── details-outline.js         # 其余 17 个组件的骨架内容
```

**数据与视图完全分离**：`data/` 下全是纯数据，`assets/js/` 只负责渲染。

---

## 分层模型

### 四层 + 一条底座

| 层级 | 在本层回答的问题 | 组件数 | 代表组件 |
|---|---|---|---|
| **L1 集群调度** | 请求发给谁、什么时候扩容 | 6 | Dynamo / AIBrix / llm-d / PyMotor |
| **L2 推理引擎** | 单实例内怎么组批、怎么算、怎么放 KV | 8 | vLLM / SGLang / vLLM-Ascend / LMCache |
| **L3 KV 传输** | KV 怎么搬、搬哪些、怎么与计算重叠 | 5 | Mooncake Transfer Engine / NIXL / HIXL / MemFabric |
| **L4 KV 存储** | KV 存在哪、怎么索引与淘汰 | 6 | Mooncake Store / MemCache / FlexKV / UCM |
| **L0 底座** | 算子、内存、通信原语由谁定义 | 1 | CANN |

L0 不是第五层，而是**纵向穿透所有层的地基**。CANN 既不是推理引擎也不是传输库，
放进任何一层都会失真，所以单独建模，在全景图里画成一条带斜纹的地基带。

### 每个组件只属于一层

早期版本允许组件同时挂在多层上（`primary` + `also`），结果是 L3、L4 的**每张卡都被列了两遍**：

```
L3 KV 传输: 主 4 / 跨层 4   ← 每张卡出现两次
L4 KV 存储: 主 5 / 跨层 6   ← 11 张卡撑起 5 个组件
```

根因是**传输与存储不是两个平行的产品品类，而是同一条垂直栈的两半**。Mooncake、MemCache、
DataSystem 这类产品内部本来就同时包含传输子系统与存储子系统。

现在改为**一个组件恰好属于一层**，判据是**它的主要用途**：

- **Mooncake 整体归 L4**。它自带一个传输引擎，但解决的问题域是「分布式 KV 池」——
  **不按内部子系统拆卡**，否则同一个仓库会在两层各出现一次，读者得在两处拼起来才看得全
- **L3 只收「以搬字节本身为目的」的组件**（NIXL / HIXL / MemFabric）——
  判据是**它们能脱离任何存储系统单独使用**
- **AscendStoreConnector** 归 **L2**。三条判据：① 它的仓库就是 `vllm-ascend`，
  没有独立身份；② 它实现的是引擎自己的 `KVConnectorBase_V1` 接口；③ LMCache 同为
  「挂在引擎上的 KV 管理层 + Connector」也在 L2，放 L3 会自相矛盾

由此得到一条更一般的规则：

> **L2 收「引擎本身 + 挂在引擎上的 KV 管理层」；L3 收「独立部署的传输引擎」。**

按这条规则，L3 现在只剩 3 个组件，且**每一个都有独立仓库、都在真正搬字节**：
NIXL、MemFabric、HIXL。

### 三个容易搞混的边界

**一、H2D / D2H 不属于 KV 传输层，属于推理引擎。** 判据是一条：

> **L2 搬「KV 块」（懂布局），L3 搬「字节」（只认地址）。**

L3 传输引擎的接口里只有「注册内存段 + 偏移 + 长度」，**没有「层」「块」「slot」这些概念**——
它不知道什么是 attention，也不知道 MLA 与 GQA 的 KV 形状不同。而 D2H / H2D 要按 `slot_mapping`
把连续的一段 KV **散进分页显存的正确位置**，这需要引擎的内部知识，所以由引擎侧的 GPU / NPU
Connector 完成（LMCache 的 `gpu_connector`、vLLM 的 `v1/kv_offload/cpu`）。

**二、KV 传输与 KV 存储是同件事的两个面。** 传输是动词、存储是名词。之所以能分成两层，
是因为产品形态上确实存在纯传输引擎（Mooncake TE 不做存储）与纯存储系统（MemCache 不做传输）。
但边界不是绝对的：GDS（显存 ↔ SSD 直传）既像传输又像存储，按「它被谁装配」归入 L4。

**三、推理引擎与 KV 存储是「生产者/消费者 ↔ 托管方」。**

| | 推理引擎（L2） | KV 存储（L4） |
|---|---|---|
| 产生 KV | ✅ 计算产生 | ❌ 不产生 |
| 消费 KV | ✅ attention 读取 | ❌ 不知道 attention 是什么 |
| 定义 key 与块大小 | ✅ 前缀哈希 + 块大小由引擎定 | ❌ 只接受这个 key |
| 决定换入换出时机 | ✅ 调度器与前缀查询 | ❌ 只按容量与淘汰策略响应 |

两条推论：① **存储系统不知道哪些 KV 会被读到**（它只认 key），这正是 UCM 那类稀疏检索
**必须侵入引擎**的原因；② **但存储后端的能力会反向约束引擎**——layerwise 要求后端支持分层、
异步、部分完成的读写，所以目前只有 MemCache 支持，这直接限制了 vLLM-Ascend 能否做逐层流水。

### 归类用两个正交维度，不合并

早期版本只有一个 `eco` 标签，把两件事混成了一件：

| 维度 | 含义 | 例子 |
|---|---|---|
| **org** | 谁做的 / 为谁做的（厂商血统） | Dynamo 出自 NVIDIA、MindIE 出自华为 |
| **runs** | 当前实际能跑在哪些硬件栈 | CANN 只能昇腾、vLLM 两栈都能跑 |

混起来的后果是把 **Dynamo** 误判成「像 CANN 一样锁死 NVIDIA」。实际上它只是**引擎之上的编排层**，
今天跑不了昇腾的原因是厂商 SDK 与发行物，不是架构上不可能。所以每个组件标三个字段：

```js
{
  runs: ['nvidia'],       // 可运行的硬件栈
  port: 'sdk',            // bound | sdk | neutral
  portNote: '官方支持矩阵只列 NVIDIA Ampere→Blackwell，发行物全是 NGC CUDA 容器…',
}
```

**`bound` 与 `sdk` 的区别很重要**：

| port | 含义 | 换栈要付什么代价 | 例子 |
|---|---|---|---|
| `bound` | 硬件绑定：本身就是硬件抽象层，或编译到特定硬件 | **重写** | CANN、CUDA、TensorRT-LLM、HIXL、MemFabric |
| `sdk` | 厂商 SDK / 发行物绑定：架构中立但实现绑在某一栈 | **适配** | Dynamo、NIXL、FlexKV、LMDeploy |
| `neutral` | 硬件中立：两栈都有官方或主线落地 | 无 | vLLM、SGLang、LMCache、Mooncake、UCM |

当前分布：**昇腾专属 8 · NV 专属 6 · 双栈 13**。`portNote` 会显示在组件页顶部。

另有两个容易按厂商血统误判的例子：

- **UCM** 出自华为 ModelEngine，但构建配置的 runtime 覆盖 `simu / ascend / ascend-a3 / musa / cuda`，
  Ascend 优化还是默认关闭的编译选项——按功能归 L4，不是昇腾专属
- **openYuanrong DataSystem** 的构建同时支持 Ascend 与 CUDA 后端

### 层与层之间：KV 的两次流动

首页的**技术栈分层本身就画出了层间交互**——层与层之间有一条交互带，内含**两条真实画出的流向线**
（圆点标记起点、虚线加箭头标记流向、线色取自起点层）。

但在画交互带之前，先要把流程的顺序搞对。**KV 有两次流动，夹着一次计算**：

```
KV 入向（算之前搬进来） → 计算 → KV 出向（算完搬出去）
```

早先的版本把传输全排在计算之后，**那是错的**——它只描述了 prefill 侧「算完把 KV 送出去」，
漏掉了 decode 侧「KV 送进来才能算」。计算没有 KV 根本无法进行，所以入向必须排在计算之前。

因此全链路分四个阶段：

| 阶段 | 步骤 | 说明 |
|---|---|---|
| **决策** | 01–04 | 谁来做、能省多少。路由决策要查 L4 的索引与 L2 上报的状态 |
| **KV 入向** | 05–06 | 计算的前置条件。两个来源性质不同，见下表 |
| **计算** | 07–08 | **消费**已就位的 KV，同时**生产**新的 KV——它是 KV 的汇合点与产源地 |
| **KV 出向** | 09–14 | 把新产生的 KV 送给 decode 实例（L3）并写入池（L4） |

**「KV 入向」有两个来源，性质相同（都是缓存命中）**：

| 步骤 | 来源 | KV 物理上在哪 |
|---|---|---|
| **05** | KV Pool 命中取回（L4） | 共享池里（主机内存 / SSD / 远端） |
| **06** | 从邻实例取回（L3） | **别的实例的显存里**——P2P 直读，不经过池 |

两者复用的都是**之前请求**算过的结果，差别只在"KV 存在哪"以及随之而来的延迟。

标了 **「条件」** 的步骤只在命中时发生——**冷启动请求没有入向，直接算**。

### 层内的版式：组件优先

每一层的 rail 里，**内容顺序是按重要性排的**：

1. **本层组件**（主内容，放在最前）
2. **本层要回答的问题**
3. **本层在链路中承担** —— 默认**折叠**

早先版本把「本层在链路中承担」放在最前面并完整展开，导致辅助信息比主内容还显眼。
现在它默认折叠，需要时点开。

**PD 分离不在编号流程里**，这是刻意的：它是一种**部署形态**，把一个逻辑请求切成 prefill / decode
两段执行，两段各自走这条链路，中间用 KV 传输对接（P 段的**出向**接上 D 段的**入向**）。
把它列为通用步骤会让流程读不通——比如"计算"到底是 P 段的还是 D 段的？

三条交互带的内容：

| 层间 | ↓ 下行 | ↑ 上行 |
|---|---|---|
| L1 ⇄ L2 | 请求下发（已编排的请求 + 目标实例 + 采样参数） | 状态回流（队列深度 / KV 命中率 / 显存水位）→ 反哺路由打分 |
| L2 ⇄ L3 | 搬运指令（**算前搬进来 / 算完送出去**，双向共用一个通道） | 到位通知（KV 已落在本地显存）→ 这是「计算可以开始」的信号 |
| L3 ⇄ L4 | 检索与落存（算前查在不在池里 / 算完写入池） | 位置响应与取回（在不在、在哪台机器；命中时数据经 L3 搬回） |

## 已完成的深度分析

**三个分析页的关键模块全部完成**（48 个模块）。

| 组件 | 节数 | 模块 | 状态 |
|---|---|---|---|
| **lmcache**（宿主） | 6 | `platform` · `StorageManager/StorageBackend` · `GPUConnector` · `LMCacheEngine` | ✅ 4/4 |
| **lmcache-ascend**（插件） | 7 | `NPUConnector` · `MemoryManager/KvFormat` · `P2PBackend` · `TransferChannel` · `PDBackend` · `TokensHash` | ✅ 6/6 |
| **mooncake** | 6 | 对象层：`MasterService` · `Client/ClientService` · `StorageBackend` · `AllocationStrategy` · `HA`<br>字节层：`Transport` · `TransferMetadata` · `Topology/MultiTransport` · `Segment/Buffer` | ✅ 9/9 |

**跨侧互链**：宿主与插件的 10 个模块**每个都有一条指向对面一侧的链接**
（写在模块页的「风险」节末），保证读者从任一侧进入都能找到另一侧。

**插件式组件的分析纪律**：分析 lmcache-ascend 时**必须同时读 lmcache**。
每个模块页首节是「先看宿主」——把宿主的对应实现与插件实现**并列贴出**，
并标注相同的是布局知识、不同的是入口与调用约定。
**在宿主侧**（`lmcache/gpu-connector`、`lmcache/engine`）有「与插件的接合」一节，
给出双向派发图与影响推断。**两侧互链，缺一边就读不懂。**

## 联动分析（跨组件）

**三条，三种体裁**——它们互补而不重复：

| 链路 | 体裁 | 回答的问题 |
|---|---|---|
| **KV Save / Load 全链路** | 调用路径 | 一次操作**怎么走** |
| **KV 回落的三条通路** | 方案对比 | 一道题**有几种解法** |
| **一个 KV 对象要变形四次** | 数据变换 | 一份数据**经过哪些形状** |

**为什么独立成集**：一次操作横跨多个独立项目时，放在任何单个组件页都会让读者找不到，
且必然与其它参与方脱节。三条都与相关组件页**双向互链**。

### 深度分析与联动分析的分工

**深度分析**跟着一个仓库走（单组件，钉一个版本）。
**联动分析**跟着一次操作走（跨仓库，钉每个参与方的版本）。

一次操作横跨多个项目时，**不放组件页**——放在任何一边都会让读者找不到，
且必然与其它参与方脱节。两者双向互链。

## 分析文档的产出规范

本仓库的深度分析遵循 `code-arch-analysis` skill：

- **模块关系图必须手绘 SVG**（不从代码生成）
- **类图必须 PlantUML**，源在 `diagrams/*.puml`
- 结论带 `path:line` 锚点；**钉住分析版本**

**渲染类图时注意两个坑**（`diagrams/render.sh` 会检查）：

1. **`skinparam FontSize` 不支持小数**——写 `12.5` 会被 PlantUML 解析成 `125`，
   图宽膨胀 10 倍，在页面里被缩小到看不清。**必须用整数。**
2. **同级类太多会横向铺开**——超过约 1150px 的图会被 CSS 缩小。
   减少同级的类，或把「其余实现」合并成一个节点。

渲染类图：

```bash
brew install plantuml      # 一次性
diagrams/render.sh         # *.puml → *.svg
```

页面运行时按需注入 SVG，**不依赖任何在线 PlantUML 服务**。

## 数据模型

### 层级（`data/catalog.js` → `WIKI_LAYERS`）

```js
{
  id: 'transport',
  num: 'L3',
  name: 'KV 传输',
  en: 'KV Transport',
  color: '#8f5f7d',        // 该层主题色，驱动整站配色
  colorDim: '#e0cbd8',
  wash: 'rgba(143,95,125,.08)',   // 极浅底色，用于卡片与高亮
  tagline: '一句话描述这层在干什么',
  handoff: 'KV 已到位 → 继续解码',   // 交给下一层的产物
  questions: ['本层要回答的设计问题 1', '问题 2']
}
```

### 全链路（`data/catalog.js` → `WIKI_FLOW`）

**全站的主轴**：以「请求 + KV」的流程把四层串成一条，并显式画成环。

```js
window.WIKI_FLOW = {
  title: '一条请求与它的 KV',
  sub: '四层不是四个独立的盒子…',
  steps: [
    { k: 'step', n: 1, layer: 'scheduling', kind: 'req', title: '请求到达', desc: '…' },
    { k: 'handoff', label: '已编排的请求 → 引擎实例' },
    { k: 'step', n: 5, layer: 'engine', kind: 'kv', title: '执行计算', desc: '…' },
    // …
    { k: 'loop', label: '下一次请求进来时，L4 的索引回到 L1', desc: '…' }
  ]
};
```

有三种条目（`k` 字段）：`step` 是链路上的步骤，`handoff` 是层与层之间的交接，
`loop` 是闭环说明。`layer` 决定步骤归属哪一层，`kind` 区分 **请求流** 与 **KV 流**。

首页各层只渲染**自己承担的那几步**（`flowStepsOfLayer(layerId)`），引用的是同一份数据，
因此编号在「全链路」与「各层」两处始终一致。

底座单独放在 `WIKI_SUBSTRATES` 里，不混入 `WIKI_LAYERS`：

```js
window.WIKI_SUBSTRATES = [
  { id: 'substrate', label: '底座', en: 'Substrate',
    color: '#8fa3b8', note: '四层共同站立的地基…', components: ['cann'] }
];
```

### 组件（`data/catalog.js` → `WIKI_COMPONENTS`）

```js
{
  id: 'vllm',
  name: 'vLLM',
  primary: 'engine',       // 唯一的归属层；底座组件填 'substrate'
  org: 'vLLM Project',
  repo: 'https://github.com/vllm-project/vllm',
  lang: 'Python / CUDA',
  role: '一句话定位（显示在卡片上）',
  status: 'deep' | 'outline'
}
```

### 详情（`data/details*.js` → `WIKI_DETAILS`）

```js
WIKI_DETAILS['vllm'] = {
  draft: true,             // 可选，标为「骨架」
  overview: `...markdown...`,
  modules: [
    {
      id: 'scheduler',
      name: '调度器：continuous batching 的核心',
      files: ['vllm/v1/core/sched/scheduler.py'],   // 上游仓库内的相对路径
      refs:  [{ t: '官方文档', u: 'https://...' }],  // 可选：外部参考链接
      summary: '一句话（折叠状态显示在标题右侧）',
      flow: ['调用链步骤 1', '步骤 2'],               // 编号流程
      points: ['关键设计点 / 易踩的坑']                // 菱形要点
    }
  ],
}
```

> `files` 中一律使用**上游仓库内的相对路径**，不写本机路径，便于发布后对照上游代码核对。
> 像 CANN 这种没有单一仓库的组件，用 `refs` 挂官方文档链接。

#### Markdown 书写约定

正文用轻量 Markdown。**为了避免 JS 模板串里转义反引号**，本项目约定：

| 写法 | 效果 | 说明 |
|---|---|---|
| `%%path/to/file.py%%` | `行内代码` | 替代反引号（渲染器两种都支持） |
| `~~~` 围栏 | 代码块 | 替代三个反引号（标准 Markdown 同样支持） |
| `**粗体**` / `[链接](url)` / `- 列表` / `\| 表格 \|` / `> 引用` | 常规 | 均支持 |

---

## 特点速览

每个组件页顶部有一块 **「特点速览」**（`highlights` 字段），把该组件最容易踩坑、最能体现设计取舍的点
提炼成若干条。**它是读者判断「这个组件值不值得往下读」的依据**，所以写在正文之前。

数据源是两类：**组件源码的走读**（vLLM 请求生命周期、KVConnector 抽象、PD 分离模式、
各 KV 项目的架构解析），以及**横向对比**得出的判断。不是仓库 README 的复述。

当前 28 个组件共 **134 条**特点。几条代表性的：

| 组件 | 特点 |
|---|---|
| vLLM | v1 引擎**没有 prefill / decode 阶段之分**，用 `num_computed_tokens` 推进增量 |
| LMCache-Ascend | 用 **PAC 编解码替代 CUDA CacheGen**，KV 压缩在昇腾上走另一套算术编码 |
| AscendStoreConnector | **layerwise 只有 memcache 后端支持**，且只支持 Prefill 节点 |
| HIXL | **HCCS 119 GB/s vs RDMA 22 GB/s**，这个差距决定了 PD 分离的拓扑设计 |
| Mooncake TE | **`BatchID` 就是 `BatchDesc*` 指针的整数重解释**，绕过 map 查找的热路径优化 |

## 新增一个组件

1. 在 `data/catalog.js` 的 `WIKI_COMPONENTS` 里加一条（`primary` 选一个层）；
2. 在对应的 `data/details*.js` 里加 `WIKI_DETAILS['<id>']`；
3. 刷新页面。

侧栏、搜索索引、层级卡片、相邻组件都会自动更新——不需要改任何渲染代码。

### 数据完整性自检

```bash
node -e "
global.window=global;
['catalog','details','details-ascend','details-nvidia','details-outline'].forEach(f=>require('./data/'+f+'.js'));
const C=WIKI_COMPONENTS,D=WIKI_DETAILS;
const mods=C.reduce((n,c)=>n+((D[c.id]||{}).modules||[]).length,0);
const hl=C.reduce((n,c)=>n+((D[c.id]||{}).highlights||[]).length,0);
console.log('组件',C.length,'模块',mods,'特点',hl);
console.log('缺详情:',C.filter(c=>!D[c.id]).map(c=>c.name));
"
```

---

## 交互

| 操作 | 说明 |
|---|---|
| `/` | 聚焦搜索框 |
| `↑` `↓` + `Enter` | 在搜索结果中导航与跳转 |
| `Esc` | 清空搜索 |

搜索索引覆盖**组件名、简介、组织、语言、所属层**以及**所有模块名、摘要、文件路径、要点**，
因此可以直接搜 `radix`、`scheduler.py`、`RDMA`、`HIXL` 这类关键词定位到具体模块。

---

## 部署（让别人能访问）

纯静态站点，任意静态托管均可：

```bash
git init && git add -A && git commit -m "LLM Infra Wiki v0.1"

# GitHub Pages：推到仓库 Settings → Pages 选分支
# Vercel / Netlify：直接拖目录，或 netlify deploy --dir=.
# 对象存储 + CDN：oss/cos/s3 上传后开静态网站托管
```

部署前建议替换：

- `index.html` 中的 Google Fonts 链接建议换成本地字体或国内镜像，避免部分网络下字体加载慢

---

## 待办

- [ ] 把 17 个骨架组件补成完整走读（昇腾线剩余：MemFabric、MemCache 深化、MindIE、PyMotor）
- [ ] 补一层「横向对比」页面（各引擎的 KV 量化支持、各 KV 存储的索引粒度等）
- [ ] 加入 `log.md` 式的更新日志，记录每个组件是对着哪个上游 commit 整理的
- [ ] 支持从真实 `.md` 文件构建（现在是数据内联，改造成本很低）
- [ ] 增加中英切换
