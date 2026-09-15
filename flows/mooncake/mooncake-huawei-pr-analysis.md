---
title: Mooncake 社区中华为系 PR 贡献分析
author: MadaoRui
direction: 社区与生态
date: 2026-09-09
tags: [Mooncake, PR分析, 华为, 社区]
summary: 全仓 2779 个 PR 的模块归属统计，按「已合入 PR 是否触达该目录」算占比，看华为系的贡献落在 Mooncake 的哪些模块上。
---
# Mooncake 社区中华为系 PR 贡献分析

> **代码仓库**：`kvcache-ai/Mooncake`（Moonshot AI / Kimi 主导的 KVCache 分离架构开源社区）
> **数据基线**：本地 HEAD = `b8f294d`（2026-08-29 同步）；PR 数据经 GitHub API 全量拉取，统计时点 2026-09-09
> **统计口径**：全仓 PR 共 2779 个（已合入 2055、在途 open、已关闭未合入其余）。模块占比按"已合入 PR 是否触达该目录"计算，一个 PR 可触达多模块，各行占比不可加总
> **姊妹篇**：`mooncake-module-analysis.md`（模块地图）、`mooncake-ascend-kunpeng-ub-transport-analysis.md`（昇腾传输后端）

---

## 1. 结论速览

| 口径 | PR 数 | 占比 |
|---|---:|---:|
| 全仓已合入 | 2055 | 100% |
| **华为系投递且已合入** | **113** | **5.5%** |
| 其中：硬证据（@huawei.com 邮箱 / 公司资料 / 团队账号） | 68~97 | 3.3%~3.5% |
| 华为系全部投递（含 open + closed 未合入） | 157 | 5.7%（/2779） |
| 在途 open | 8 | — |

- 共识别 **18 个华为相关账号**，最大单一贡献源是 `ascend-direct-dev`（Xiao You，youxiao@huawei.com，51 个 PR）
- 全仓 Ascend 主题 PR 共 92 个，其中 **67 个（73%）来自华为系**——昇腾专项功能基本由华为投递
- 投递仍在加速：2025 年全年 49 个，2026 年至今 94 个
- 尚未进入的模块：mooncake-wheel、mooncake-pg、mooncake-ep、mooncake-reshard、mooncake-rl、python SDK、tent（下一代传输引擎，仅 2 个 PR 触达）

## 2. 识别方法

GitHub 资料无法直接查到组织归属，采用三路交叉验证：

1. **提交邮箱后缀**：git 历史 + GitHub commits API 中 `@huawei.com` 后缀（youxiao@、tangjie66@、liangxu25@huawei.com）
2. **GitHub 个人资料**：company/bio 字段（如 "Huawei"、"Works on Ascend products at Huawei"、华为天才少年）
3. **工作内容指纹**：昇腾专属工作（CANN/HIXL/UBShmem/910B/昇腾 CI 机器）需要华为内部硬件与 SDK 才能完成，作为强信号

另用 vllm-ascend（华为主导仓库）贡献者名单与 Mooncake PR 作者取交集做召回，剔除其中工作内容无华为特征者（Chase-Rong、LiuYi-Up、Liziqi-77、Csrayz、zuochunwei=美团、staryxchen=Tencent 等）。

## 3. 人员清单

### 硬证据层（8 人）

| 账号 | 证据 | PR 总数（合入） | 主要方向 |
|---|---|---:|---|
| ascend-direct-dev | 提交邮箱关联 youxiao@huawei.com（Xiao You） | 51（42） | ascend_direct 传输、NPU store 池化 |
| swallowCXY | company: Huawei | 10（5） | store P2P 框架、DRAM tier 适配昇腾 |
| AscendTransport | 华为昇腾传输团队账号 | 10（6） | Ascend Transport 初始接入（HCCL 版） |
| JieTang66 | tangjie66@huawei.com | 9（7） | NPU wheel 发布 CI |
| liangxu2000 | liangxu25@huawei.com | 5（2） | store master HA、Grafana 监控 |
| yz53665 | company: Huawei | 4（2） | 3FS/盘符修复 |
| chenwenxiaolive | 华为天才少年 | 4（2） | Ascend NPU cache tier |
| Libotry | bio: 华为昇腾产品线 | 4（2） | master 服务 HA（etcd） |

### 强信号层（10 人，无直接组织证据但工作内容高度绑定华为生态）

| 账号 | 信号 | PR 总数（合入） | 方向 |
|---|---|---:|---|
| yejj710 | bio: "focused on Mooncake/Ascend NPU" | 12（9） | mooncake-conductor 索引器 |
| hjchen2 | 早期 Ascend TE 深度共建（合作教授） | 8（6） | Ascend TE 构建与恢复 |
| LCAIZJ | 910B kvpool、store 昇腾兼容 | 8（6） | RDMA/TCP 传输、store 兼容 |
| zchuango | 鲲鹏 SuperNode UB（华为灵衢生态） | 10（6） | UB Transport |
| VNightMare | Ascend CI 流水线、UBShmem/Ascend VMM | 9（9） | CI、UBShmem 传输 |
| Keithwwa | bio: @Ascend @vllm-ascend | 2（2） | 文档 |
| MingYang119 | HIXL（华为专用互联 SDK） | 2（2） | HIXL IPv6 |
| greatwhole | Ascend context | 2（2） | TE 修复 |
| A-Liuhao | HIXL | 2（2） | HIXL 报错 |
| jinsidong | HIXL CS mode | 1（1） | TE 修复 |

## 4. 按代码目录模块的覆盖（已合入口径）

| 模块 | 说明 | 合入 PR 总数 | 华为投递 | 占比 | 华为是否投递 |
|---|---|---:|---:|---:|---|
| mooncake-transfer-engine | C++ 传输引擎（RDMA/TCP/NVMe-oF/昇腾等） | 570 | 63 | **11.1%** | ✅ 重点 |
| mooncake-store | 分布式对象存储（master/agent/HA） | 666 | 36 | 5.4% | ✅ |
| mooncake-common | 公共基础库 | 125 | 15 | **12.0%** | ✅ 重点 |
| mooncake-conductor（历史目录） | 全局调度/索引器 | 19 | 4 | **21.1%** | ✅ |
| mooncake-integration | vLLM/SGLang/MindIE 集成适配 | 242 | 15 | 6.2% | ✅ |
| mooncake-wheel | Python wheel 打包 | 205 | 0 | 0% | ❌（NPU wheel PR 多数未合入） |
| tent（transfer-engine/tent） | 下一代传输引擎 | 189 | 2 | 1.1% | ✅ 刚起步 |
| mooncake-p2p-store | 早期 Go 版 P2P 存储 | 30 | 1 | 3.3% | ✅ |
| mooncake-pg | PostgreSQL 集成（新） | 63 | 0 | 0% | ❌ |
| mooncake-ep | EP 弹性并行（新） | 59 | 0 | 0% | ❌ |
| mooncake-reshard / rl / python | 重分片 / RL / SDK（新） | 3~1 | 0 | 0% | ❌ |
| CI/构建/基础设施 | .github、scripts、docker、image、cmake | 429 | 25 | 5.8% | ✅ |
| docs | 文档 | 486 | 25 | 5.1% | ✅ |

**要点解读**：

- 传输引擎是华为投入最重的模块（63/570 = 11.1%）。昇腾三条传输路径——`ascend_transport`（HCCL 版，约 7900 行）、`ascend_direct_transport`（HIXL 版，约 3700 行）、`ascend_transport_c`（C 接口，约 1200 行）——几乎全部由华为投递
- mooncake-store 是全仓 PR 数最多的模块，华为参与度约等于均值（5.4%），集中在 HA（Libotry、liangxu2000）、P2P DataManager（swallowCXY）、NPU 池化。当前 8 个在途 open PR 有 7 个在 store
- tent 仅 2 个 PR 触达（zchuango 的 UB 基础 + URMA adapter 1626 行），是最大的空白，也是最大的机会（见 §6）

## 5. 时间趋势

- 首个华为 PR：2025-06（AscendTransport 团队接入 Ascend Transport）
- 2025 全年 49 个 → 2026 年至今 94 个，强度约翻倍
- 演进路径：传输引擎接入 → store/NPU 池化 → NPU wheel CI → conductor/HA，覆盖面持续扩大

## 6. 附：tent（下一代传输引擎）机会判断

TENT（Transfer Engine NEXT）是官方文档明确的旧引擎继任者，2025-12-22 首个 PR，现状：

- 月度 PR：1 月 3 → 4 月 17 → 7 月 37 → 8 月（未满月）39，增速约 10 倍
- 代码量约 8.8 万行，已与旧 TE（约 9.1 万行）打平；runtime 集中调度、transport 插件化变薄
- 作者格局：腾讯（staryxchen，30 个 PR、16%）为最大贡献方，阿里（jfeng18）跟进；华为近乎空白（1.1%）
- 昇腾在 tent 的现状：`transport/ascend/` 仅 759 行，对比旧 TE 昇腾三件套约 1.3 万行——迁移缺口巨大

**判断**：值得投入。理由：① 旧 TE 终会进入维护期，华为在旧 TE 的 11.1% 优势资产需迁移保值；② tent 的 ascend 位空缺，现在进场可主导接口设计；③ tent 的动态路径选择/故障切换架构对 UB+HIXL+RoCE 并存的昇腾集群是天然卖点。建议节奏：先"功能对等"（迁移 1.3 万行昇腾传输能力 + 昇腾 CI 进 tent），保持旧 TE 维护并行，待 store 侧切换信号明确再加大投入。

## 7. 数据与复现

- PR 元数据：`/tmp/mooncake_prs.json`（2779 条，含作者/状态/时间）
- 已合入 PR 文件清单：`/tmp/all_pr_files.tsv`（2055 个 PR × 文件路径）
- 华为 PR 文件清单：`/tmp/hw_pr_files.tsv`；模块统计脚本：`/tmp/module_stats.py`
- 主要命令：`gh pr list --state all --limit 3000 --json ...` + `gh api repos/kvcache-ai/Mooncake/pulls/N/files`

## 8. 局限性说明

- GitHub 无法验证到"昇腾计算 BU"组织粒度，强信号层人员按工作内容推断，可能存在少量误纳/漏纳
- 已关闭未合入的 36 个 PR 计入"全部投递"但不在模块占比内（模块表按已合入口径）
- 模块占比按文件路径触达统计，跨模块重构类 PR 会在多行重复计数
