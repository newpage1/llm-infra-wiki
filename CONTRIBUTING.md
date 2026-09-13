# 参与贡献

这是一个**纯静态**的知识库站点：没有构建步骤、没有 npm install、没有依赖。
改完 `data/` 或 `assets/` 里的文件，刷新浏览器就能看到效果。

## 三种参与方式

| 你想做的 | 怎么做 |
|---|---|
| **指出错误**（行号过期、说法不对、链接失效） | 开一个 [纠错 Issue](../../issues/new?template=correction.yml)，不必改代码 |
| **改内容 / 加模块** | 改文件 → 本地跑校验 → 提 PR（见下） |
| **建议新增一个组件或一条链路** | 开 [新组件建议 Issue](../../issues/new?template=new-component.yml) |

**不熟悉 git 也能改**：GitHub 网页版可以直接编辑 `data/analyses.js` 并提交 PR，
手机浏览器也能操作。适合改错别字、换行号这一类小改动。

---

## 本地跑起来

```bash
./serve.sh              # → http://127.0.0.1:8899
./serve.sh --lan        # 局域网可访问（手机上真机调试用这个）
```

也可以直接双击 `index.html`——所有数据都内联在 `<script>` 里，不依赖 `fetch`，
`file://` 协议下同样可用。

> 改完 `assets/` 下的静态资源记得 `python3 bump.py` 递增版本号，
> 否则浏览器会用缓存里的旧文件（见 README 里那段踩坑记录）。

---

## 提 PR 之前：跑校验

```bash
bash tools/verify.sh
```

它做四件事，**目标一律是「0 个错误，0 个提示」**：

1. `tools/check_publish.js` —— 用**真实渲染器**把内容跑一遍，抓「写对了但页面会漏字」的问题
2. 每个分析页的**结构校验**（8 小节顺序、`%%` 配对、图数、跨节重复）
3. 每个分析页的**总体设计图 ↔ 模块认领关系**
4. `lint_svg.py` —— 手绘 SVG 里同一水平线的文字不能重叠

CI 上跑的就是这一条，红了的 PR 合不进去。

### 行号与逐字围栏要单独校验

上面那一步**不查行号**（查行号得先把被分析的代码 clone 下来）。
改动了 `路径:行号` 或代码围栏时，跑完整版：

```bash
bash tools/verify-anchors.sh              # 自动 clone 到 .anchor-cache/
bash tools/verify-anchors.sh mooncake     # 只查一个
```

它会按 `tools/anchors.json` 里钉住的**提交 SHA** 拉取代码，逐条核对：
行号真实存在、代码围栏与仓库原文逐字一致。

> 注意：`lmcache-ascend` 的基线是**本地合成提交**，上游没有这个 SHA，
> 完整校验会自动跳过并说明原因。

---

## 写作规范

**加/改关键模块之前，请先读 [`authoring/MODULE-SPEC.md`](authoring/MODULE-SPEC.md)。**
它讲清了这个站点的数据格式、八小节铁律、SVG 的硬约束，以及几个**已经踩过的坑**
（比如 `%%` 中间不能带 `%`、`files` 与 `subtitle` 这类字段是纯文本不能写 markdown）。

整套源码分析的方法论（怎么划边界、找主干、提抽象、追数据流）在
[`data/SKILL-code-arch-analysis.md`](data/SKILL-code-arch-analysis.md)。

---

## 目录结构

```
llm-infra-wiki/
├── index.html                 # 唯一页面（hash 路由）
├── serve.sh                   # 本地预览
├── bump.py                    # 统一递增 ?v=N
├── lint_svg.py                # SVG 文字重叠检查
├── fix_fences.py              # 裸 ~~~ 围栏 → 带语言标记
├── assets/
│   ├── css/style.css
│   └── js/{markdown.js,app.js}
├── data/
│   ├── catalog.js             # 编目：分层 + 组件元信息
│   ├── details.js             # 组件详情页（介绍 + 模块走读）
│   ├── details-{ascend,nvidia,outline}.js
│   ├── analyses.js            # 深度分析页（本站最重的内容）
│   ├── flows.js               # 跨组件链路
│   └── SKILL-code-arch-analysis.md
├── diagrams/                  # PlantUML 源与渲染出的 SVG
├── authoring/                 # 写作规范 + 单模块自检包装
├── tools/
│   ├── verify.sh              # 离线自检（CI 跑这个）
│   ├── verify-anchors.sh      # 完整校验（含行号）
│   ├── check_publish.js       # 真渲染器体检
│   ├── anchors.json           # 各分析页钉住的仓库与提交
│   ├── checker/               # 从 skill 里 vendor 进来的校验器
│   └── oneoff/                # 一次性迁移脚本（留档，不再维护）
└── .github/                   # CI 与 Issue/PR 模板
```

---

## 发布

推到 `main` 后由 **Cloudflare Pages** 自动构建发布（没有构建步骤，就是把仓库当静态站托管）。

需要一个**不经过 git** 的直发通道时（例如打一个预览快照给别人看）：

```bash
bash deploy.sh              # 用 wrangler 直传当前工作区
bash deploy.sh --dry-run    # 只看会传哪些文件
```

---

## 内容口径

写内容时请守住这几条，它们是这个站点区别于「又一份翻译稿」的地方：

1. **每句话要指得到某一行**——论断后面给 `路径:行号`，行号必须真实。
2. **图画在上面，说明写在下面。**
3. **诚实标注**：没读到的写「未覆盖」，靠推理的写「推断」，找不到调用方的写「未发现调用方」。
   把没锚上的东西写清楚，比编一个行号有价值得多。
4. **钉版本**：所有引用都相对分析页 `revision` 字段里那个提交。上游代码会漂，
   漂了就是「详情页路径过期」这类问题——发现请开 Issue 或直接改。
