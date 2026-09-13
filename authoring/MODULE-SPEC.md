# 深度分析页写作规范

这份文档写给**要往站点里加/改「关键模块」的人**。它把本项目对内容的硬约束讲清楚——
这些约束不是风格偏好，而是 `tools/checker/check_module.js` 会**逐条检查**的东西，
也是多人协作后内容不散架的唯一保证。

> 从没写过的话，建议先看一个现成模块当样板：`data/analyses.js` 里
> `lmcache-ascend` 的 `npu-connector`、或 `mooncake` 的 `link-backends`。
>
> **分工**：本文讲的是**这个站点的数据格式与校验器**；
> 整套源码分析的方法论（怎么划边界、找主干、提抽象、追数据流）在
> [`data/SKILL-code-arch-analysis.md`](../data/SKILL-code-arch-analysis.md)，
> 那 1600 行才是「怎么写出好内容」，本文只负责「怎么写得让校验器放行、让渲染器认」。

---

## 一、站点数据的形状

`data/analyses.js` 是**一个数组，每个元素是一个「深度分析页」**：

```js
window.WIKI_ANALYSES = [
  {
    id: 'vllm',                 // 路由用： #/a/vllm
    component: 'vllm',          // 必须与 data/catalog.js 里的组件 id 一致，否则入口按钮不出现
    title: 'vLLM 模块代码分析',
    subtitle: '…',              // 纯文本（见第六节）
    repo: 'vllm-project/vllm',
    revision: '568afb3a',       // 钉住的提交；行号全部以它为准
    date: '2026-09',

    summary: '…',               // markdown
    scope: ['…'],               // markdown，逐条
    notCovered: ['…'],          // markdown，逐条
    modulesLead: '…',           // markdown

    sections: [ …页面级小节… ],  // position / design / … 见第三节
    modules:  [ …关键模块…   ],  // 每个都是 8 小节，见第二节
  },
];
```

**页面级小节**常见的 id：`position`（定位与职责）、`design`（总体设计，含一张 SVG）、
然后是若干机制/模型小节、`quality`（质量属性）、`issues`（问题与发现），最后可选 `notcovered`。

---

## 二、关键模块：8 个小节，顺序固定

```
position → structure → interface → flow → impl → data → files → deps
```

| 小节 | id | 写什么 | 必须有图？ |
|---|---|---|---|
| 定位与职责 | `position` | 负责什么 / **不负责什么** | 否 |
| 内部结构 | `structure` | 类图 / 组件图：谁继承谁、谁持有谁 | **是** |
| 公开 API 与入口 | `interface` | **只讲这个模块暴露出去的接口** | 否 |
| 关键流程 | `flow` | 一次调用依次经过谁 | **是** |
| 关键实现 | `impl` | 机制：怎么做到的。**一条关键路径一张图** | **是** |
| 关键数据结构 | `data` | 真实的类/结构体定义 | 否（但要有逐字围栏） |
| 关键文件 | `files` | 分档阅读顺序：先读什么、为什么 | 否 |
| 依赖关系 | `deps` | 依赖谁 / 被谁依赖 | 否 |

模块对象的字段：

```json
{
  "id": "worker",
  "title": "模型执行 —— Worker 与 ModelRunner",
  "subtitle": "一句话副标题（纯文本，不能带 markdown）",
  "files": "vllm/v1/worker/worker_base.py 与同目录 97 个 py（共 32251 行）",
  "lead": "这一节的导语，1~3 句",
  "designSymbols": ["worker"],
  "sections": [ …8 个… ]
}
```

**`designSymbols` 是硬要求**：页面级「总体设计」图里必须有一个 `t-title-sm` 方框，
其标题**原样包含这个符号**（按词边界匹配），否则 `--design` 会报错。
约定写法是**方框标题 = `<模块 id> · 说明`**。

---

## 三、七条铁律

1. **每个小节里，图放上面，说明放下面。**
2. **公开 API 只讲这个模块暴露出去的接口**，内部件不讲（校验器会抓 `%%_私有名%%`）。
3. **总—分结构**：每节先用一段总述，再展开细节。
4. **关键实现里必须有关键流程图**——`flow` 小节里出现几个 ①②③，`impl` 就要有几张图。
5. **每句话要指得到某一行**：论断后面给 `路径:行号`，行号必须是真实存在的行。
6. **代码围栏里必须是仓库原文逐字复制**（缩进、类型标注、docstring 一字不改）。
   示意图用 `~~~text`，并在正文说明它不是源码。
7. **诚实标注推断**：没读到的写「未覆盖」，靠推理的写「推断」，找不到调用方的写「未发现调用方」。
   把没锚上的东西写清楚，比编一个行号有价值得多。

---

## 四、带图小节怎么写

图和它的解读要放进**同一个 block**：

```json
{"id": "flow", "title": "关键流程",
 "blocks": [
   {"lead": "……图上面的总述……",
    "svg": "<svg viewBox=\"0 0 1200 640\" class=\"diagram\" role=\"img\" aria-label=\"…\">…</svg>",
    "html": "**读图**：……图下面的解读（含 路径:行号）……"}
 ]}
```

- 不带图的小节直接写 `{"id":"position","title":"定位与职责","lead":"…","html":"…"}`。
- **`impl` 的每个带图 block，`html` 里必须出现「读图」二字**，否则会被判「图后缺少解读段」。

### SVG 的硬约束

- **不能出现** `**`、`%%`、`~~~`、markdown 链接——这些会被当成正文语法解析。
  要加粗用 `<tspan font-weight="600">`。
- 方框标题用 `class="t-title-sm"`，层带标题用 `class="t-band"`，
  正文用 `class="t-mono"` / `class="t-sub"`，连线用 `class="t-line"`。
- **同一水平线（`|y1-y2| <= 6`）的文字不能重叠**——`lint_svg.py` 会按估算宽度机械检查。
- `viewBox` 建议 `0 0 1200 <高>`，左边距 20/44。宽度 1200 是有意的：窄屏靠横滑 + 点图放大
  （见 `assets/js/app.js` 的 `installZoom`），不是靠缩到看不见。

---

## 五、行内代码与围栏

- **行内代码用 `%%x%%`**（不是反引号）。渲染器也接受反引号，但全站统一用 `%%`。
- **`%%` 必须成对**，且**中间不能出现 `%` 字符**——渲染器的正则是 `%%([^%]+)%%`，
  写 `%%a % b%%` 会整段漏出字面量。要表达取模就拆开：`%%a%% 对 %%b%% 取模`。
- 围栏**必须带语言标记**（`cpp` / `python` / `text`）。
  **裸 `~~~` 会被跳过逐字校验**——等于自己放行了引用错误，校验器会提示。

---

## 六、哪些字段是纯文本（不能带 markdown）

这一条**踩过三次坑**：渲染器对一部分字段走 `esc()`，markdown 不会被解析，直接漏成字面量。

| 走 `esc()`（纯文本） | 走 markdown |
|---|---|
| 分析页的 `title` `subtitle` `repo` `revision` | 分析页的 `summary` `scope` `notCovered` `modulesLead` |
| 模块的 `title` `subtitle` `files` | 模块的 `lead`、小节 `html`、block 的 `lead` / `html` |
| `WIKI_DETAILS`（`data/details.js`）模块的 `name` `summary` `files` | `WIKI_DETAILS` 的 `overview` |

写 `files`、`subtitle` 这种字段时**一律用普通文本**，别写 `%%路径%%`。

---

## 七、改完必须跑的命令

```bash
# ① 结构 + 行号 + 逐字围栏（要先把被分析的仓库 clone 到本地，见 CONTRIBUTING.md）
node tools/checker/check_module.js data/analyses.js <分析页 id> --all --repo <仓库路径>

# ② 总体设计图 ↔ 模块的认领关系
node tools/checker/check_module.js data/analyses.js <分析页 id> --design

# ③ 宿主页不得提到它的插件
node tools/checker/check_module.js data/analyses.js <分析页 id> --cross

# ④ 手绘 SVG 的文字重叠
python3 lint_svg.py

# ⑤ 改了静态资源就 bump 版本号
python3 bump.py
```

**目标一律是「0 个错误，0 个提示」。** 提示虽然不是错误，但每一条都对应一个真实隐患，
`main` 分支应当保持在 0。

CI 上跑的是 ① 的**离线版**（不带 `--repo`，只校验结构与 `%%` 配对）加上 ④——
行号校验需要 clone 被分析的仓库，放在本地或手动触发的工作流里做。
