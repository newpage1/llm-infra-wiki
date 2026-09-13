# LLM Infra Wiki

大模型推理基础设施的**分层知识库**站点。纯静态：没有构建步骤、没有依赖、没有后端。

**在线看** → <https://newpage1.github.io/llm-infra-wiki/>

---

## 这是什么

按「**集群调度 → 推理引擎 → KV 传输 → KV 存储**」四层组织的知识库，外加一条纵向穿透的
底座带（CANN / CUDA）。首页是全景与分层，每个组件页讲清它解决什么问题、关键抽象落在
哪几个文件里、一次请求在它内部怎么流动。

本站的立身之本只有一条：**每句话都指得到上游源码的某一行。**

- 所有引用锚在**钉住的提交**上（见 `tools/anchors.json`），不是"某个版本"
- 行号真实存在、代码围栏与仓库原文**一字不差**，由 `tools/verify-anchors.sh` 逐条核对
- 没读到的地方明确标「未覆盖」，靠推理的标「推断」——**不编行号**

**深度分析页共 5 个、92 个关键模块**（这是仓库里最重的内容）：

| 分析页 | 钉住的版本 | 模块 |
|---|---|---|
| vllm | v0.26.0 `568afb3a` | 9 |
| vllm-ascend | v0.26.0rc1 `f2f74a16` | 10 |
| lmcache | `b5d109ea` | 33 |
| lmcache-ascend | 本地合成 `452bcf4` | 17 |
| mooncake | `e389a86` | 23 |

---

## 本地跑起来

```bash
git clone https://github.com/newpage1/llm-infra-wiki.git
cd llm-infra-wiki
./serve.sh                 # → http://127.0.0.1:8899
./serve.sh --lan           # 局域网可访问（手机上真机调试用这个）
```

没有构建、不用 `npm install`。也可以**直接双击 `index.html`**——数据全部内联在
`<script>` 里，不走 `fetch`，所以 `file://` 协议下同样能用。

---

## 怎么提意见

**发现错误不需要改代码。** 开一个 Issue 就行，两个模板：

| 模板 | 什么时候用 |
|---|---|
| [纠错 / 内容不对](https://github.com/newpage1/llm-infra-wiki/issues/new?template=correction.yml) | 行号过期、说法不对、链接失效、事实有误 |
| [建议新增内容](https://github.com/newpage1/llm-infra-wiki/issues/new?template=new-component.yml) | 想加一个组件、补一个模块、加一条跨组件链路 |

带证据的纠错处理得最快——`路径:行号`、官方文档链接、上游 issue 链接都行。

---

## 怎么改内容

### 1. 找到要改的文件

| 想改什么 | 改哪 |
|---|---|
| 深度分析页（关键模块、总体设计） | `data/analyses.js` |
| 组件的整体介绍与模块走读 | `data/details.js`（及其 `details-{ascend,nvidia,outline}.js`） |
| 分层、组件编目、「特点速览」 | `data/catalog.js` |
| 跨组件链路 | `data/flows.js` |
| 版式与交互 | `assets/css/style.css`、`assets/js/app.js` |

`data/` 下全是纯数据，`assets/js/` 只负责渲染——**改内容不需要碰渲染代码**。

### 2. 改完必须跑校验

```bash
bash tools/verify.sh
```

**目标一律是「0 个错误，0 个提示」。** CI 跑的就是这一条，红了合不进去。

它检查四件事：内容用**真实渲染器**跑一遍（抓"写对了但页面会漏字"）、每个分析页的结构
（8 小节顺序、`%%` 配对、图数）、总体设计图与模块的认领关系、手绘 SVG 的文字重叠。

### 3. 改了行号或代码围栏，还要跑完整校验

```bash
bash tools/verify-anchors.sh            # 自动 clone 被分析的仓库到 .anchor-cache/
bash tools/verify-anchors.sh mooncake   # 只查一页
```

它会按 `tools/anchors.json` 里钉住的**提交 SHA** 拉代码，逐条核对「这个行号真实存在吗」
「这段围栏与原文一字不差吗」。离线校验查不了这个。

> `lmcache-ascend` 的基线是**本地合成提交**，上游没有这个 SHA，完整校验会自动跳过并说明原因。

### 4. 提 PR

按 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md) 填。**不熟悉 git 也能改**——GitHub 网页版
可以直接编辑文件并提交 PR，手机上也能操作，适合改错别字、换行号这一类小改动。

---

## 怎么贡献新内容

**加一个组件**（不需要改任何渲染代码）：

1. 在 `data/catalog.js` 的 `WIKI_COMPONENTS` 里加一条，`primary` 选一个层；
2. 在对应的 `data/details*.js` 里加 `WIKI_DETAILS['<id>']`；
3. 刷新页面——侧栏、搜索索引、层级卡片、相邻组件都会自动更新。

**加/改一个关键模块**（深度分析页里的一节）：先读
[`authoring/MODULE-SPEC.md`](authoring/MODULE-SPEC.md)，它规定了 8 小节的固定顺序、
`%%` 的用法、哪些字段不能写 markdown。写得对不对由校验器判定，不是靠人眼。

**改版式（表格、对比排版、章节顺序）**：见
[`authoring/EDITORIAL.md`](authoring/EDITORIAL.md)。

---

## 注意事项

### 硬约束（改坏了校验会拦住）

| 注意 | 说明 |
|---|---|
| **改完静态资源必须 bump** | `python3 bump.py`。不 bump 浏览器会一直用缓存里的旧文件，改动看不见 |
| **`**读图**：` 四个字不能删** | 校验器要求带图小节的 html 里必须有「读图」 |
| **`~~~` 围栏里是逐字原文** | 一个字都不能改，否则完整校验会报 |
| **所有 `路径:行号` 要有意义** | 那是本站的立身之本，不能随手删 |
| **`%%` 必须成对，且中间不能有 `%`** | 渲染器的正则是 `%%([^%]+)%%`，写 `%%a % b%%` 会整段漏出字面量 |
| **粗体不能跨行** | 渲染器逐行做行内解析，跨行的 `**` 配不上 |

### 哪些字段是纯文本（不能写 markdown）

**踩过好几次坑**：渲染器对一部分字段走转义，写了 `%%x%%` 会直接漏成字面量。

| 走纯文本 | 走 markdown |
|---|---|
| 分析页的 `title` `subtitle` `repo` `revision` | 分析页的 `summary` `scope` `notCovered` `modulesLead` |
| 模块的 `title` `subtitle` `files` | 模块的 `lead`、小节 `html` |
| `details.js` 模块的 `name` `summary` `files` | `details.js` 的 `overview` |

### 两条方法论

- **不要用脚本批量改措辞。** 替换不是重写——本项目实测过，批量替换会造出
  「所以"为什么两条线都存在"」这种自相矛盾的句子。细节见 [`authoring/STYLE.md`](authoring/STYLE.md)。
- **文风有量化守门。** `node tools/style_audit.js` 会数「AI 腔」指标（破折号密度、粗体密度、
  套话），并有一条硬指标：**锚点总数只许增不许减**——文风可以改，但不能以丢掉
  「每句话指得到某一行」为代价。基线在 `tools/style-baseline.json`，CI 会拦回退。

### 不要提交的东西

`.gitignore` 已经排除了：`.backup/`（脚本改写前的整文件快照）、`.work/`（逐模块施工的
中间产物）、`.anchor-cache/`（完整校验 clone 下来的代码）。这三个都是本地临时目录。

---

## 目录结构

```
llm-infra-wiki/
├── index.html                  # 唯一页面（hash 路由）
├── serve.sh                    # 本地预览
├── bump.py                     # 统一递增 index.html 的 ?v=N
├── lint_svg.py                 # 手绘 SVG 文字重叠检查
├── deploy.sh                   # 用 wrangler 直传 Cloudflare Pages
├── CONTRIBUTING.md             # 内容口径（动手之前必须接受的四条）
├── assets/
│   ├── css/{style.css,fonts.css}
│   ├── fonts/*.woff2           # 自托管字体（无外部依赖）
│   └── js/{markdown.js,app.js}
├── data/
│   ├── catalog.js              # 分层 + 组件编目
│   ├── analyses.js             # 深度分析页（最重的内容）
│   ├── details*.js             # 组件详情页
│   ├── flows.js                # 跨组件链路
│   └── SKILL-code-arch-analysis.md   # 源码分析方法论
├── diagrams/                   # PlantUML 源与渲染出的 SVG
├── authoring/                  # 写内容的人看这三份
├── docs/                       # 设计笔记与部署说明
├── tools/                      # 校验器与脚手架
└── .github/                    # CI 与 Issue / PR 模板
```

---

## 文档在哪

| 文档 | 讲什么 |
|---|---|
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 参与的完整流程（本文的精简版之外的细节） |
| [`authoring/MODULE-SPEC.md`](authoring/MODULE-SPEC.md) | **数据格式与校验器**：8 小节铁律、SVG 约束、哪些字段是纯文本 |
| [`authoring/EDITORIAL.md`](authoring/EDITORIAL.md) | **内容编例**：表格怎么画、两项对比怎么摆、模块页按什么顺序写 |
| [`authoring/STYLE.md`](authoring/STYLE.md) | **文风**：去 AI 腔、术语表、句式规则 |
| [`data/SKILL-code-arch-analysis.md`](data/SKILL-code-arch-analysis.md) | **方法论**：怎么划边界、找主干、提抽象、追数据流 |
| [`docs/DESIGN.md`](docs/DESIGN.md) | **站点设计笔记**：分层模型、数据模型、版式决策、实现踩过的坑 |
| [`docs/custom-domain.md`](docs/custom-domain.md) | 绑自己的域名（含 Cloudflare 的两个经典坑） |

---

## 部署

推到 `main` 后由 **GitHub Pages** 自动发布（没有构建步骤，就是把仓库当静态站托管）。
发布体积约 6MB，**没有任何外部资源依赖**（字体已自托管），断网、内网都能正常显示。

需要不走 git 的直发通道时：

```bash
bash deploy.sh --dry-run     # 先看会传哪些文件
bash deploy.sh --preview     # 发一个预览，拿到临时 URL
```

想换成自己的域名见 [`docs/custom-domain.md`](docs/custom-domain.md)。
