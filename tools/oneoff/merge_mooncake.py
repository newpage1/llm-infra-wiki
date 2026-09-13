#!/usr/bin/env python3
# 把 mooncake-store 与 mooncake-te 两个分析页合并成一个 mooncake 分析页。
# 只做结构性合并 + 新总体设计；模块对象原样保留（用户要求「具体的关键模块可以保留」）。
import json, sys

P = 'data/analyses.js'
src = open(P).read()
i = src.index('window.WIKI_ANALYSES'); j = src.index('[', i); k = src.rindex(']')
d = json.loads(src[j:k+1])

A = {a['id']: a for a in d}
store, te = A['mooncake-store'], A['mooncake-te']
print('原：store 模块', len(store['modules']), ' te 模块', len(te['modules']))

def sec(an, sid):
    return next(s for s in an['sections'] if s['id'] == sid)

DESIGN_SVG = open('/tmp/design_mooncake.svg').read().strip()

# ── 合并后的各小节 ──────────────────────────────────────────────
POSITION = {
    'id': 'position', 'title': '定位与职责',
    'lead': '同一个仓库里装着两件东西：**一个分布式 KV 池（Store）**，'
            '和**它自己用的零拷贝传输引擎（Transfer Engine）**。'
            '前者认 `key`，后者只认「地址 + 长度」。',
    'html': """| | |
|---|---|
| **定位** | 分布式 KV 池：把集群里所有机器的 DRAM 与 SSD 聚合成一个可寻址的对象存储 |
| **底层** | 自带一个通用的跨设备、跨机内存搬运库（Transfer Engine），不感知 KV 与 attention 语义 |
| **对外语义** | 对象级操作：`Get` / `Put` / `List` / `Del` / `Replicate` |
| **两层分界** | 传输引擎只认 %%(地址, 长度)%%；Store 只认 %%key%%——**中间那层翻译就是 Store 存在的理由** |
| **搬运由谁做** | 全部交给 Transfer Engine。Store 只算「副本在哪、要搬多少字节」 |
| **被谁用** | vLLM / SGLang / TensorRT-LLM / vLLM-Ascend 的 KV Connector、LMCache 远端后端；也可**只用下层引擎**，不用对象层 |
| **一致性承诺** | %%Get%% **必定读到某个一致的版本，但不保证是最新版本**（官方明确声明） |

### 为什么本页把两者放在一起讲

它们**同属一个开源仓库**，而且下层的传输引擎是上层的**必需底座**——
Store 自己一行字节都不搬，全部交给它。

但两者的**职责、失败模式与调优手段完全不同**：
对象层关心副本放置与一致性，字节层关心链路选择与带宽。
所以本页用两个层次讲清楚，**关键模块里也按层分开列**。

最后一行的取舍值得单独看：Store **不承诺线性一致**，只承诺读到的版本是完整一致的。
对一个 KV 缓存来说这是合理取舍——缓存的价值在命中率，不在强一致。
"""
}

DESIGN = {
    'id': 'design', 'title': '总体设计',
    'lead': '一句话：**上面是对象层，下面是字节层，中间只隔着一次结构体转换。**',
    'svg': DESIGN_SVG,
    'html': """**读图要点**：从下往上读——每一条带回答一个不同的问题，**越往下越接近硬件**。

| 带 | 回答什么 | 谁在做 |
|---|---|---|
| **CALLERS · 调用方** | 谁来用、用哪几个操作 | 引擎侧 KV Connector、LMCache 远端后端 |
| **CONTROL · 控制面** | 这个 key 的副本在哪、放哪块内存 | `MasterService` + `AllocationStrategy` |
| **DATA · 数据面** | 字节怎么过去 | `Client` / `ClientService` → Transfer Engine |
| **STORAGE · 存储资源** | KV 最终落在哪种介质上 | 同一套后端契约下的 DRAM / L1 / SSD / 3FS |
| **TRANSFER ENGINE** | 把字节从 A 搬到 B | 选路、寻址、拓扑、内存注册 |
| **TRANSPORT · 后端族** | 走哪条物理链路 | 同一抽象下的 20+ 个实现 |

### 一次请求里，"控制面 / 数据面"要穿过两回

这是这张图最该记住的一点：**Put 和 Get 都不是一次 RPC 就能完成的**——
它们各自**两次**跨过 CONTROL 与 DATA 之间那条线：

```
Put:  控制面（要位置）→ 数据面（搬字节）→ 控制面（标记完成）
Get:  控制面（问位置）→ 数据面（拉字节）
```

**为什么必须分开**：控制面只走元数据，能扛高 QPS；数据面走 RDMA 直达，
**不经过 Master**。代价是 Master 在关键路径上出现了两次，
所以它必须是**无状态可重放的**——这也正是上面那条 HA 带的由来。

### 那条接缝：★ 处只传"地址 + 长度"

图中间那条竖箭头标的就是**对象层与字节层的唯一接口**。

Store 交给 Transfer Engine 的东西，剥掉类型外壳之后就是
`(本地地址, 远端地址, 长度)`——**没有一个字段带 KV 语义**。
反过来 Transfer Engine 也从不回问"这个 key 是什么"。

**这条边界的价值在故障隔离**：传输引擎的失败（网卡掉、超时）
不会污染对象层的元数据；对象层的元数据故障也不影响已经在传的数据。

### 一处容易被忽略的重合

Store 的对象模型里有 %%Slice{ptr, size}%%，
而 Transfer Engine 的 %%TransferRequest%% 描述的也是"一段地址"。

**两者之间隔的是一次结构体转换，而不是一次语义转换。**
这带来轻微的冗余，但也换来了**下层能被完全独立地复用**——
vLLM、SGLang 这些不关心对象模型的调用方可以直接用下层。
"""
}

# flow：把对象层两条路径（store 的 html）与字节层的切片机制（te 的 html）合并，
# chain 保留 TE 那份逐步骤清单（它讲的是底层一次提交）。
store_flow, te_flow = sec(store, 'flow'), sec(te, 'flow')
FLOW = {
    'id': 'flow', 'title': '关键流程：从对象操作到一次搬运',
    'lead': '对象层的两条路径都**两次穿过控制面与数据面的分界**；'
            '到了字节层，一次传输又会被切成**可以各走一条网卡的多个 slice**。',
    'chain': te_flow.get('chain'),
    'html': store_flow.get('html', '') + """
### 再往下：一次 submitTransfer 会被切片

到了字节层，上面那条 `submitTransfer(...)` 并不是一次不可分的搬运。
官方文档的原话：

> "if a single request's transfer is internally divided into multiple slices
> if its length exceeds 64KB. Each slice **might use a different path**,
> enabling collaborative work among all RDMA NICs."

**「一次传输」在实现上是「一批可以走不同网卡的切片」。**
故障换路也是建立在这个粒度上的——某个 NIC 挂了，
只需要把该 NIC 上的 slice 重新提交到另一条路径。

**所以对象层的"重试"与字节层的"换路"是两个粒度**：
前者重发整个对象，后者只挪动几个 slice。这也是为什么
%%，%%Store 的重试成本远高于引擎内部的换路。
"""
}

# quality：两张表并成一张，去掉重复的规模行，补一行说明合并后的量级。
q_store = sec(store, 'quality').get('table', {})
q_te = sec(te, 'quality').get('table', {})
rows = list(q_store.get('rows', []))
for r in q_te.get('rows', []):
    if r and str(r[0]).startswith('**规模**'):
        continue      # 规模行合并成下面单独一条
    rows.append(r)
rows.append(['**规模**', '约 45 万行。上半（Store）约 23 万，下半（Transfer Engine）约 21 万',
             '代码统计'])
rows.append(['**可测试性**', '%%tests/%% 164 文件 86808 行——**测试代码超过源码的 1/3**',
             '代码统计'])
QUALITY = {
    'id': 'quality', 'title': '质量属性与硬约束',
    'table': {'head': q_store.get('head', ['维度', '结论', '依据']), 'rows': rows},
}

# issues：两边的观察按层归拢
ISSUES = {
    'id': 'issues', 'title': '问题与发现',
    'html': """### 对象层（Store）

""" + (sec(store, 'issues').get('html') or '') + """

### 字节层（Transfer Engine）

""" + (sec(te, 'issues').get('html') or '')
}

MODULES = list(store['modules']) + list(te['modules'])

MERGED = {
    'id': 'mooncake',
    'component': 'mooncake',
    'title': 'Mooncake 模块代码分析',
    'subtitle': '分布式 KV 池 + 它自带的零拷贝传输引擎',
    'repo': store['repo'],
    'revision': store['revision'],
    'date': store['date'],
    'summary': '一个仓库里装着一整套 KV 数据面：**上层是对象层（Store）**——'
               '把集群的 DRAM 与 SSD 聚合成可寻址的 KV 池，只承诺「读到某个一致版本」；'
               '**下层是字节层（Transfer Engine）**——通用的零拷贝搬运库，'
               '不认 key、不认对象，只认「地址 + 长度」。'
               '两层的分界很干净：**Store 只算"副本在哪、多少字节"，字节全部交给下层的引擎搬。**',
    'scope': sorted(set(list(store.get('scope', [])) + list(te.get('scope', []))), key=str),
    'notCovered': list(store.get('notCovered', [])) + list(te.get('notCovered', [])),
    'sections': [POSITION, DESIGN, sec(te, 'segment'), FLOW, QUALITY, ISSUES],
    'modules': MODULES,
}
# segment 的标题在合并后要说明它在整页里的位置
for s in MERGED['sections']:
    if s['id'] == 'segment':
        s['title'] = '核心模型：Segment 的两级可见性'

out = []
placed = False
for a in d:
    if a['id'] in ('mooncake-store', 'mooncake-te'):
        if not placed:
            out.append(MERGED); placed = True
        continue
    out.append(a)
print('合并后分析页:', [a['id'] for a in out], '模块数', len(MERGED['modules']))
print('  模块:', [m['id'] for m in MERGED['modules']])
print('  小节:', [s['id'] for s in MERGED['sections']])

open(P, 'w').write(src[:j] + json.dumps(out, ensure_ascii=False, indent=2) + src[k+1:])
print('已写入', P)
