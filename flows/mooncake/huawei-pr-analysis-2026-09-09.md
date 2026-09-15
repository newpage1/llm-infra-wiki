---
title: Mooncake 按现有模块的华为相关 PR 梳理
author: MadaoRui
direction: 社区与生态
date: 2026-09-09
tags: [Mooncake, PR分析, 华为, 昇腾]
summary: 按技术栈关键词筛出 98 个候选 PR（高置信 53 + 弱置信 45），逐模块统计变更量与合入状态：已合并候选共 +35116 / -6996 行，占当前代码量 7.42%。
---
# Mooncake 按现有模块的华为相关 PR 梳理

- **统计时间**：2026-09-09（Asia/Shanghai）；仓库已同步至 `e389a85`（`origin/main`）。
- **仓库**：`kvcache-ai/Mooncake`；代码目录与分析笔记分离。
- **候选口径（允许弱置信）**：PR 标题明确出现 `Ascend`、`HIXL`、`ADXL`、`HCCL`、`UB/URMA`、`Kunpeng`、`NPU/CANN`、`fabric mem` 等华为技术栈，或明确是 Ascend CI/构建适配的 PR。
- **置信度**：高置信 53 个（华为专用账号或 `@huawei.com` 提交邮箱）；弱置信 45 个（标题/改动内容强指向华为技术栈，但公开身份未完全确认）。已排除 PR #1441/#1429：其 Ascend NPU cache tier 实现已不在当前主干。
- **状态**：98 个候选 PR 中，86 个已合并、3 个打开、9 个关闭未合并；仅统计当前主干仍可对应的 PR 代码。

## 结论概览

已合并候选 PR 变更为 **+35116 / -6996 行**，共 42,112 行变更；未合入候选 PR（打开中及关闭未合并）共 26,736 行变更。当前总代码量为 567,389 行，因此合入代码量占 **7.42%**，未合入代码量占 **4.71%**。这些是 PR 变更量，不等于逐行作者归属。

## 模块汇总

“主责 PR 数”按标题和功能归入一个模块，便于加总；“触及 PR 数”按 GitHub changed files 统计，一个 PR 可同时触及多个模块。

| 当前模块 | 主责 PR 数 | 触及 PR 数 | 已合并 | 打开 | 关闭未合并 | 合入 / 未合入代码量占总代码 | 主要内容 |
|---|---:|---:|---:|---:|---:|---:|---|
| `mooncake-transfer-engine` | 51 | 61 | 44 | 2 | 5 | 合入 29,241 行（**5.15%**）；未合入 8,317 行（**1.47%**） | Transfer Engine 主体：Ascend Direct/HIXL、HCCL、UB/URMA/Kunpeng、异构 NPU↔GPU、异步传输、端点/内存/恢复；TENT 相关也归入此模块。 |
| `mooncake-store` | 20 | 22 | 17 | 0 | 3 | 合入 10,284 行（**1.81%**）；未合入 4,995 行（**0.88%**） | Store：Ascend fabric memory、dummy-real、主机内存、SSD offload、DRAM 适配及 Store 会话 API。 |
| `CI/构建与发布` | 22 | 23 | 21 | 0 | 1 | 合入 2,390 行（**0.42%**）；未合入 13,391 行（**2.36%**） | Ascend CI 门禁、GitHub mirror、CANN/NPU wheel、release workflow、构建和打包链路。 |
| `docs` | 5 | 18 | 4 | 1 | 0 | 合入 197 行（**0.03%**）；未合入 33 行（**0.01%**） | Ascend/NPU/Kunpeng/UB 构建指南、README/API 与设计文档。 |
| `mooncake-common` | 0 | 18 | 0 | 0 | 0 | 合入 0 行（**0.00%**）；未合入 0 行（**0.00%**） | 公共头文件、内存/设备/URMA 辅助及跨模块依赖；多为被 TE/Store PR 顺带触及。 |
| `mooncake-integration` | 0 | 11 | 0 | 0 | 0 | 合入 0 行（**0.00%**）；未合入 0 行（**0.00%**） | Python/C++ 集成适配、Ascend allocator、异构传输接入。 |
| `mooncake-ep` | 0 | 1 | 0 | 0 | 0 | 合入 0 行（**0.00%**）；未合入 0 行（**0.00%**） | EP 对 fabric memory/NVLink IPC 的条件控制。 |
| `mooncake-pg` | 0 | 2 | 0 | 0 | 0 | 合入 0 行（**0.00%**）；未合入 0 行（**0.00%**） | PG 与 fabric memory/MNNVL 的兼容修复。 |
| `mooncake-p2p-store` | 0 | 1 | 0 | 0 | 0 | 合入 0 行（**0.00%**）；未合入 0 行（**0.00%**） | 本次候选仅有历史草稿/跨模块变更触及。 |
| `mooncake-wheel` | 0 | 1 | 0 | 0 | 0 | 合入 0 行（**0.00%**）；未合入 0 行（**0.00%**） | 本次候选仅有 NPU 发布草稿触及。 |
| `mooncake-reshard` | 0 | 0 | 0 | 0 | 0 | 合入 0 行（**0.00%**）；未合入 0 行（**0.00%**） | 未发现标题/内容直接涉及华为技术栈的候选 PR。 |
| `mooncake-rl` | 0 | 0 | 0 | 0 | 0 | 合入 0 行（**0.00%**）；未合入 0 行（**0.00%**） | 未发现标题/内容直接涉及华为技术栈的候选 PR。 |

> **列口径**：该列分子为该模块“主责 PR”的变更量（additions + deletions），分别按已合入和未合入统计；分母统一为当前主干总代码量 **567,389 行**。未合入包括打开中及关闭未合并的 PR；已从统计中剔除当前主干已不存在的 PR #1441/#1429。

## 模块解读

- **Transfer Engine 是核心承载模块**：主责 51 个、实际触及 61 个，覆盖 Ascend Direct/HIXL 的引入与演进、HCCL/UB/URMA/Kunpeng 通道、异构 NPU↔GPU、异步与多目的端、连接恢复、内存注册和 TENT 适配。
- **Mooncake Store 是第二大功能模块**：主责 20 个、实际触及 22 个，重点是 fabric memory、dummy-real、主机内存、SSD offload 以及会话读写。
- **CI/构建发布是重要配套模块**：22 个 PR 主责于此，集中解决 Ascend CI 门禁、镜像重试、CANN 版本、NPU wheel、release workflow 和打包。
- **公共层和集成层多为跨模块联动**：`mooncake-common` 实际触及 18 个，`mooncake-integration` 实际触及 11 个，主要是公共设备/内存辅助及 Python/C++ 接入。
- **低关联模块**：`mooncake-ep` 1 个、`mooncake-pg` 2 个、`mooncake-p2p-store` 1 个、`mooncake-wheel` 1 个；`mooncake-reshard` 与 `mooncake-rl` 未发现本口径下的候选 PR。

## PR 明细（按主责模块）

### `mooncake-transfer-engine`（51 个主责 PR）

- #3933｜打开｜高置信｜`ascend-direct-dev`｜[WIP][TENT] Align Ascend Direct with async AutoConnect-only transfer｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/3933)
- #3835｜已合并｜高置信｜`ascend-direct-dev`｜[Bugfix][TE] Use the only ADXL endpoint when dest has one engine｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/3835)
- #3453｜已合并｜弱置信｜`jinsidong`｜[TE] Skip same-host device offset when HIXL CS mode is available｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/3453)
- #3302｜已合并｜高置信｜`MooncakeHixl`｜feat(ascend_direct): auto-detect AutoConnect & Client-Server mode via GetCapability, inject LocalCommRes｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/3302)
- #3282｜已合并｜弱置信｜`zchuango`｜[TENT] Add native UB foundation and URMA resource management｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/3282)
- #3280｜已合并｜弱置信｜`Primary33`｜[TENT] Port GDS and Ascend transport reliability updates｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/3280)
- #3116｜已合并｜弱置信｜`jfeng18`｜[TENT] Fix req_map_ leak for single-task batches in ascend transport｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/3116)
- #2828｜关闭未合并｜弱置信｜`zchuango`｜[TE/TENT] Enable UB Transport in TENT on Kunpeng SuperNode (Phase 3)｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/2828)
- #2617｜已合并｜弱置信｜`he-yufeng`｜fix(transport): associate task.request in EFA/Kunpeng submitTransfer｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/2617)
- #2557｜已合并｜弱置信｜`greatwhole`｜[Bugfix] Set Ascend context in batch get worker｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/2557)
- #2505｜已合并｜弱置信｜`jfeng18`｜[TENT] Fix stale getTransferStatus in nvlink/mnnvl/ascend transports｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/2505)
- #2499｜已合并｜高置信｜`ascend-direct-dev`｜[TE] Support per-role Ascend protocol for co-located Transfer Engines｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/2499)
- #2374｜打开｜弱置信｜`jfeng18`｜[TE] Fix HCCL retry loop and stream leak in initiatorLoop｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/2374)
- #2323｜已合并｜高置信｜`ascend-direct-dev`｜[TE] Optimize ascend_direct async query and fix auto_connect teardown｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/2323)
- #1960｜已合并｜弱置信｜`swallowCXY`｜[Bugfix]: abort ascend unified pointer｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1960)
- #1855｜已合并｜弱置信｜`zchuango`｜[TE] Enabling UB Transport on the Kunpeng SuperNode Phase 2｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1855)
- #1805｜已合并｜弱置信｜`zchuango`｜[TE] Enabling UB Transport on the Kunpeng SuperNode Phase 1｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1805)
- #1663｜已合并｜弱置信｜`xleoken`｜fix compile error when use -DUSE_ASCEND_HETEROGENEOUS=ON｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1663)
- #1641｜已合并｜高置信｜`ascend-direct-dev`｜[TE] add retry logic for ascend direct｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1641)
- #1543｜已合并｜高置信｜`ascend-direct-dev`｜[TE] add ascend direct transport unit test｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1543)
- #1524｜已合并｜弱置信｜`A-Liuhao`｜[TE] feat: hixl support report errmsg when interface called failed｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1524)
- #1519｜已合并｜弱置信｜`VNightMare`｜[TE] Ubshmem transport support ipc memory and build allocator when set USE_UBSHMEM=ON｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1519)
- #1473｜已合并｜弱置信｜`alogfans`｜Add ascend-direct-dev as codeowner｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1473)
- #1464｜已合并｜高置信｜`ascend-direct-dev`｜[TE] add GlobalResourceConfig config for ascend direct transport｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1464)
- #1399｜已合并｜弱置信｜`VNightMare`｜[TE] Enable ubshmem transport via ascend vmm apis｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1399)
- #1377｜关闭未合并｜高置信｜`ascend-direct-dev`｜[TE]ascend direct transport add option｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1377)
- #1325｜已合并｜高置信｜`ascend-direct-dev`｜[TE]feat: ascend direct transport add async tranfer task limit｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1325)
- #1274｜已合并｜高置信｜`ascend-direct-dev`｜[TE] feat:ascend direct transport support async transfer｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1274)
- #1220｜已合并｜弱置信｜`MingYang119`｜[TransferEngine]: HIXL support ipv6 when searching for available port｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1220)
- #1194｜已合并｜弱置信｜`MingYang119`｜[TE] AscendDirectTransport: HIXL support IPV6｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1194)
- #1049｜已合并｜高置信｜`ascend-direct-dev`｜TE v1: change hixl transport to ascend direct transport ｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1049)
- #1039｜已合并｜高置信｜`ascend-direct-dev`｜change adxl log｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1039)
- #1037｜已合并｜高置信｜`ascend-direct-dev`｜add hixl transport for TE v1｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1037)
- #1013｜已合并｜高置信｜`AscendTransport`｜ASCEND MINDIE KVPOOL｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1013)
- #963｜已合并｜高置信｜`ascend-direct-dev`｜adxl: fix aclrtMemcpyBatch max 4096 limit bug｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/963)
- #941｜已合并｜高置信｜`ascend-direct-dev`｜TE: adxl config without buffer pool｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/941)
- #859｜已合并｜弱置信｜`zuochunwei`｜[TransferEngine] Performance Enhancement for Heterogeneous Ascend via Intelligent Aggregation & Pipeline Design｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/859)
- #857｜已合并｜高置信｜`ascend-direct-dev`｜ascend direct transport support transfer to multiple destinations in one batch｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/857)
- #856｜已合并｜高置信｜`ascend-direct-dev`｜fix adxl find tcp port bug｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/856)
- #847｜已合并｜弱置信｜`hjchen2`｜[TransferEngine] clear all transport mems for fast recovery for ascend transport｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/847)
- #786｜已合并｜高置信｜`ascend-direct-dev`｜Fix: ascend direct transport support host addr type｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/786)
- #764｜已合并｜高置信｜`ascend-direct-dev`｜[TE] Fix  adxl error code in ascend-direct-transport｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/764)
- #759｜已合并｜弱置信｜`zuochunwei`｜[TransferEngine] heterogeneous_ascend support kv-cache transfer between npu and gpu｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/759)
- #758｜已合并｜弱置信｜`hjchen2`｜[TransferEngine] Ascend supports asymmetric amount of registered memory｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/758)
- #753｜关闭未合并｜高置信｜`AscendTransport`｜heterogeneous_ascend｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/753)
- #740｜已合并｜高置信｜`ascend-direct-dev`｜add ascend direct transport｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/740)
- #728｜关闭未合并｜高置信｜`ascend-direct-dev`｜add ascend direct transport｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/728)
- #658｜已合并｜高置信｜`AscendTransport`｜[TransferEngine] Fix compile issue to make CentOS usable + Make ascend_transport timeout configurable｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/658)
- #619｜已合并｜高置信｜`AscendTransport`｜[TransferEngine] Ascend Transport: add batch_transfer_sync, Debian support & bug fixes｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/619)
- #614｜关闭未合并｜弱置信｜`hjchen2`｜refine build with ascend｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/614)
- #502｜已合并｜高置信｜`AscendTransport`｜[TransferEngine] Enable Huawei Ascend Transport for TransferEngine｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/502)
### `mooncake-store`（22 个主责 PR）

- #3955｜已合并｜高置信｜`ascend-direct-dev`｜[TE] Keep fabric mem Store-only; drop GRC fabric_memory enablement｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/3955)
- #3866｜关闭未合并｜高置信｜`ascend-direct-dev`｜[Bugfix][Store] Allocate via fabric/VMM only in fabric_mem mode｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/3866)
- #3568｜关闭未合并｜高置信｜`MooncakeHixl`｜fix(store): link transfer_engine for ascend builds of mooncake_store_master｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/3568)
- #3450｜已合并｜高置信｜`ascend-direct-dev`｜[Store][TE] Split Ascend agent-mode store pool across n engines｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/3450)
- #3214｜已合并｜高置信｜`ascend-direct-dev`｜[Store][TE] fabric_mem best-effort alloc via percentile ladder｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/3214)
- #2429｜已合并｜弱置信｜`swallowCXY`｜[BugFix]adapt dram tier to ascend｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/2429)
- #2158｜已合并｜高置信｜`ascend-direct-dev`｜[Store] Fix Ascend dummy reconnect shm replay｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/2158)
- #2005｜已合并｜高置信｜`ascend-direct-dev`｜[Store] add SSD offload support for ascend platform｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/2005)
- #1917｜已合并｜高置信｜`ascend-direct-dev`｜[Store] support host mem in ascend dummy-real mode｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1917)
- #1723｜已合并｜高置信｜`ascend-direct-dev`｜[Store] adapt to dummy real mode for ascend｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1723)
- #1720｜已合并｜高置信｜`ascend-direct-dev`｜[TE] refactor ascend direct transport & adapt to dummy real mode of store｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1720)
- #1644｜已合并｜弱置信｜`he-yufeng`｜Fix MNNVL warmup hang: skip warmup when fabric mem is available｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1644)
- #1637｜已合并｜弱置信｜`UNIDY2002`｜[EP] Enable Fabric Mem only if MC_USE_NVLINK_IPC is explicitly set to zero｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1637)
- #1623｜已合并｜高置信｜`ascend-direct-dev`｜[Store] [TE] Refactor mem allocation process in ascend platform｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1623)
- #1598｜已合并｜弱置信｜`VNightMare`｜[Store] Remove duplicate code in allocate/free ascend fabric memory function of mooncake store｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1598)
- #1591｜已合并｜弱置信｜`VNightMare`｜[TE] [STORE] Improve UBShmem Transport performance with stream pool && adapts to Mooncake Store｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1591)
- #1427｜已合并｜高置信｜`ascend-direct-dev`｜[Store] fix malloc physical for ascend fabric mem｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1427)
- #1170｜已合并｜高置信｜`ascend-direct-dev`｜[Store] feat:mooncake store enable ascend fabric mem mode｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1170)
- #838｜关闭未合并｜弱置信｜`LCAIZJ`｜[Store] Mooncake store compatibility huawei ascend｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/838)
- #835｜已合并｜高置信｜`ascend-direct-dev`｜add ascend protocol to mooncake store｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/835)
### `CI/构建与发布`（22 个主责 PR）

- #3802｜已合并｜弱置信｜`staryxchen`｜[CI] Keep Ascend mirror retry on actions/checkout｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/3802)
- #3565｜已合并｜弱置信｜`Aionw`｜[CI/Build] Fix Ascend master linkage｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/3565)
- #2577｜已合并｜高置信｜`MooncakeHixl`｜[build] Use dynamic CANN version detection for NPU release workflow｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/2577)
- #2483｜已合并｜高置信｜`MooncakeHixl`｜[build] Add Python 3.9 support to NPU wheel release｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/2483)
- #2439｜已合并｜高置信｜`VNightMare`｜[CI] Change options to speed up ci for ascend.｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/2439)
- #2386｜已合并｜高置信｜`MooncakeHixl`｜[build] Migrate NPU wheel CI to cloud runners with ARM/x86 matrix｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/2386)
- #2216｜已合并｜高置信｜`MooncakeHixl`｜[build] NPU wheel: RPATH patching, vendored lib consolidation, pip retry, cmake fixes｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/2216)
- #2202｜已合并｜高置信｜`MooncakeHixl`｜[build] Strip shared libraries to reduce NPU wheel size｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/2202)
- #2178｜已合并｜高置信｜`MooncakeHixl`｜Add release-npu workflow｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/2178)
- #2135｜关闭未合并｜高置信｜`MooncakeHixl`｜Draft: Test workflow release-npu build｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/2135)
- #1992｜已合并｜弱置信｜`staryxchen`｜fix: hardcode Ascend mirror URL and remove pull_request_target routing｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1992)
- #1989｜已合并｜弱置信｜`staryxchen`｜[CI] route fork PR to pull_request_target for ascend/integration tests｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1989)
- #1943｜已合并｜弱置信｜`LujhCoconut`｜[CI] Restore auto-triggered ascend-test and integration-test in ci.yml｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1943)
- #1924｜已合并｜弱置信｜`staryxchen`｜fix(ci): retry ascend submodule update via GitHub mirrors｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1924)
- #1896｜已合并｜弱置信｜`staryxchen`｜[CI] add configurable GitHub mirror fallback for Ascend checkout｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1896)
- #1806｜已合并｜弱置信｜`LujhCoconut`｜[CI] fix bugs with CI pr1782: fail-fast on format check and restore Ascend/Integration as PR gates｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1806)
- #1697｜已合并｜弱置信｜`VNightMare`｜[CI] Add hixl roce samples on ASCEND platforms.｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1697)
- #1640｜已合并｜弱置信｜`VNightMare`｜[CI] Add CI workflow on ASCEND platform｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1640)
- #1072｜已合并｜高置信｜`ascend-direct-dev`｜Adapt to adxl connection auto release feature｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1072)
- #827｜已合并｜弱置信｜`hjchen2`｜[TransferEngine] Make ascend TE to be released successfully and support fast recovery from failures through retry｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/827)
- #737｜已合并｜弱置信｜`hjchen2`｜[TransferEngine] exclude packaging ascend precompiled libraries｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/737)
- #714｜已合并｜高置信｜`AscendTransport`｜[TransferEngine] Update to support CANN 8.2.RC1｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/714)
### `docs`（5 个主责 PR）

- #3473｜打开｜弱置信｜`littlejimmywang`｜[Doc] Align Kunpeng UB dependencies with openEuler｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/3473)
- #2437｜已合并｜弱置信｜`ykwd`｜[Docs] Readme add pypi npu badge｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/2437)
- #2325｜已合并｜高置信｜`VNightMare`｜[Docs] Add build guidance for npu platform｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/2325)
- #1683｜已合并｜弱置信｜`VNightMare`｜[CI] update ascend ci workflow and docs｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1683)
- #1534｜已合并｜高置信｜`ascend-direct-dev`｜[TE] change ascend direct transport docs & fix async transfer disconnect bug｜[GitHub](https://github.com/kvcache-ai/Mooncake/pull/1534)

## 方法与限制

1. 使用 `git pull --ff-only origin main` 同步；未修改代码。
2. 使用 GitHub REST API 的 `state=all`、PR 标题/正文、changed files 和 additions/deletions。
3. “华为相关”采用宽松候选法，弱置信项可能是社区成员对华为技术栈的适配，不代表其雇主一定是华为。
4. 主责模块按标题/功能语义归类；触及模块按改动文件归类，因此两种计数不同是预期结果。
5. 关闭未合并 PR 不计入当前主干；打开 PR 只计入潜在影响。
