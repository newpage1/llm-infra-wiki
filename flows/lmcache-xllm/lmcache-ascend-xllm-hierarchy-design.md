---
title: 方案 D：分层组合 —— Mooncake 管 PD 跨节点，LMCache 管节点内池化
author: MadaoRui
date: 2026-08-02
tags: [xllm, LMCache, Mooncake, 方案设计]
summary: 不替换 Mooncake，也不动任何已验证路径：把 LMCache 接到 xllm 已有的 HierarchyKVCacheTransfer 机制上做「节点内 KV 池化层」，与 Mooncake 的跨节点搬运正交并存，各司其职。
---
# 方案 D：分层组合 — Mooncake 负责 PD 跨节点，LMCache 负责节点内池化

> **核心思想**：不替换 Mooncake，不替换任何已验证路径。
> 把 LMCache 接入 xllm 已有的分层 KV 缓存机制（`HierarchyKVCacheTransfer`），
> 作为"节点内 KV 池化层"。Mooncake 继续做它擅长的 P↔D 跨节点搬运。
> 两者**正交并存**，各司其职。

---

## 0. 关键发现（这个方案成立的依据）

xllm 代码库里**已经存在**一个分层 KV 缓存设计：

```text
xllm/core/framework/kv_cache_transfer/hierarchy_kv_cache_transfer.h
```

它被 `worker_impl.cpp` 的注释代码临时挂起，注释原文：
> `// hierarchy temporarily disabled during the block-manager refactor`

这个类的设计**正是你想要的职责切分**：

| 能力 | 谁负责 | 对应 xllm 组件 |
|------|--------|----------------|
| NPU↔CPU 的 KV offload（D2H/H2D 批量拷贝）| 节点内分层 | `HierarchyKVCacheTransfer::d2h_batch_copy / h2d_batch_copy` |
| CPU 缓存不够时下沉到外部 store | 节点内分层 | `HierarchyKVCacheTransfer::offload_to_store / load_from_store` |
| P↔D 跨节点 KV 搬运 | Mooncake | `MooncakeKVCacheTransfer`（`kv_cache_transfer_`）|

两者是 worker 内**两个独立对象**，走**两套独立接口**：
- Mooncake：`pull_kv_blocks / push_kv_blocks`（被 `pull_kv_blocks_async` 调度）
- Hierarchy：`transfer_kv_blocks(BlockTransferInfo)`（独立的本地路径）

**所以 LMCache 的接入点是 `HierarchyKVCacheTransfer`，不是 `KVCacheTransferFactory`。**

---

## 1. 目标职责划分（你要的分层）

```text
┌─────────────────────────── 单个 Worker 节点（NPU）───────────────────────────┐
│                                                                              │
│   请求到达                                                                    │
│     │                                                                        │
│     ▼                                                                        │
│  ① 本地 prefix 命中查询（LMCache）  ◄── 节点内池化，本方案重点                │
│     │  命中 → 直接 H2D 装回 NPU 页，跳过这部分 prefill                        │
│     │  未命中 → 继续 prefill                                                 │
│     ▼                                                                        │
│  ② Prefill 计算（NPU）                                                       │
│     │                                                                        │
│     ▼                                                                        │
│  ③ KV offload 到 LMCache（D2H + 分层存储）  ◄── 节点内池化，本方案重点       │
│     │   NPU 显存(L1) → CPU pinned(L2) → Disk(L3)                            │
│     │   下次同前缀请求命中，省 prefill                                        │
│     ▼                                                                        │
│  ④ [PD 模式] P 节点把 KV push 给 D 节点（Mooncake）  ◄── 跨节点，保留现状    │
│         D 节点 pull（Mooncake）                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

**职责正交**：
- LMCache 只管"同一个节点、同一个请求、跨时间"的 KV 复用（prefix cache + 显存 offload）。它**不参与**跨节点。
- Mooncake 只管"同一时刻、跨节点"的 KV 搬运（P→D）。它**不关心**节点内是否缓存。
- 一个 P 节点可以同时：把 KV 存进 LMCache（供本节点后续复用）+ push 给 D 节点（供 decode）。

---

## 2. 总体架构

```text
                         WorkerImpl (单节点)
                            │
            ┌───────────────┴────────────────┐
            │                                │
   kv_cache_transfer_                 lmcache_local_pool_
   (Mooncake, 跨节点 PD)              (LMCache, 节点内池化) ◄── 新增
            │                                │
   pull/push_kv_blocks                store/retrieve/lookup
   (已存在, 不动)                       (本方案实现)
            │                                │
            ▼                                ▼
   ┌─────────────────┐              ┌──────────────────────┐
   │ Mooncake Store  │              │ LMCache 层级          │
   │ (跨节点 RDMA)   │              │ NPU显存→CPU→Disk→(远端)│
   └─────────────────┘              └──────────────────────┘
```

**与方案 B 的根本区别**：

| | 方案 B | 方案 D（本方案）|
|---|---|---|
| 接入点 | `KVCacheTransferFactory`（替换 Mooncake）| `HierarchyKVCacheTransfer`（与 Mooncake 并存）|
| Mooncake | 被替换，降级为 LMCache 的 remote backend | **保留**，独立负责 PD |
| LMCache 角色 | 全权接管 KV（本地+远端）| 只管节点内池化 |
| 已验证路径 | 丢弃 Mooncake PD 路径 | **全部保留** |
| 风险 | 高（重写传输链）| 低（新增独立对象，不动现有）|

---

## 3. 接入策略：两条路径

`HierarchyKVCacheTransfer` 当前是注释状态。有两条可选路径，按对 xllm 的侵入程度排序：

### 路径 D-1（推荐）：实现一个独立的 `LMCacheLocalPool` 类，挂在 WorkerImpl 上

**思路**：**不复活** `HierarchyKVCacheTransfer`（它和旧 block-manager 耦合），而是新建一个干净的 `LMCacheLocalPool` 类，作为 WorkerImpl 的第二个成员（和 `kv_cache_transfer_` 并列）。

```cpp
// worker_impl.h（新增一个成员）
class WorkerImpl {
  std::shared_ptr<KVCacheTransfer> kv_cache_transfer_;       // Mooncake PD（已存在）
  std::unique_ptr<LMCacheLocalPool> lmcache_local_pool_;     // 节点内池化（新增）
};
```

**优点**：
- 完全不碰 `kv_cache_transfer_` 和 `HierarchyKVCacheTransfer`，对现有 PD 路径零侵入；
- 接口可以按 LMCache 的语义（token-hash 驱动）重新设计，不受旧 `BlockTransferInfo` 约束；
- 可独立开关（`enable_lmcache_local_pool` flag）。

**缺点**：需要在 worker 的请求处理流程里插入"查询/存入"两个钩子（见 §4）。

### 路径 D-2：复活并改造 `HierarchyKVCacheTransfer`

**思路**：把 `HierarchyKVCacheTransfer` 的 `offload_to_store / load_from_store` 实现替换成调 LMCache，而不是调 Mooncake Store。

**优点**：复用现有的 D2H/H2D 批量拷贝逻辑、layer 同步、线程池。

**缺点**：
- 它和 block-manager 重构耦合（这正是它被注释的原因），复活它要先理清 block-manager 的现状；
- 它的接口是 `BlockTransferInfo`（block 级），而 LMCache 是 token-hash 级，仍需适配；
- 和旧代码绑死，演进不自由。

> **推荐路径 D-1。** 以下设计基于 D-1。

---

## 4. `LMCacheLocalPool` 设计

### 4.1 触发时机（在 worker 请求生命周期里插钩子）

xllm 的请求处理大致是：`prepare_inputs → prefill → (可选 KV 传输) → decode`。
LMCache 的两个钩子插在：

```text
prepare_inputs()
  │
  ├─► 【钩子 A：lookup + retrieve】prefill 前
  │     查 LMCache 是否有当前请求 token 的 prefix 命中
  │     命中 → retrieve 把 KV 装回 NPU 页，更新 num_kv_cache_tokens（减少 prefill 计算量）
  │     等价于 xllm 的 "prefix cache 命中跳过 prefill"
  │
  ▼
prefill / decode
  │
  └─► 【钩子 B：store】请求结束或 block 满时
        把本次新计算的 KV 存入 LMCache（D2H + 分层落盘）
        供本节点后续同前缀请求复用
```

> 注意：钩子 A/B 都在**节点内**，不涉及 PD。PD 的 push/pull 仍由 `kv_cache_transfer_`（Mooncake）独立处理，互不干扰。

### 4.2 类定义

```cpp
// xllm/core/framework/lmcache/lmcache_local_pool.h
namespace xllm {

class LMCacheLocalPool {
 public:
  struct Options {
    PROPERTY(std::string, lmcache_config_file) = "";   // LMCache YAML
    PROPERTY(std::string, bridge_so_path) = "";        // libxllm_lmcache_bridge.so
    PROPERTY(bool, enable) = false;
    PROPERTY(std::string, model_id) = "";
    PROPERTY(std::string, kv_role) = "both";            // 本地池化默认 both
  };

  LMCacheLocalPool(Options opts, const torch::Device& device);
  ~LMCacheLocalPool();

  // worker 初始化时调一次（register_kv_cache 之后）
  void initialize(const LmcKvLayout& layout);

  // 钩子 A: prefill 前查询并取回命中 KV
  // tokens: 当前请求的 token 序列
  // kv_caches: 本地 NPU 页（retrieve 命中部分会被填充）
  // block_ids: 这些 token 对应的物理页号
  // 返回: 前缀命中 token 数（caller 据此调整 prefill 范围）
  int32_t lookup_and_retrieve(const std::vector<int32_t>& tokens,
                              std::vector<xllm::KVCache>& kv_caches,
                              const std::vector<uint64_t>& block_ids);

  // 钩子 B: 存入本次新计算的 KV
  void store(const std::vector<int32_t>& tokens,
             const std::vector<xllm::KVCache>& kv_caches,
             const std::vector<uint64_t>& block_ids,
             const std::vector<bool>& mask);

  bool is_healthy() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;   // 持有 bridge handle + RAII
};

}  // namespace xllm
```

### 4.3 与 Mooncake 并存的调用流（worker_impl.cpp 改动）

```cpp
void WorkerImpl::initialize() {
  // ... 原有初始化 ...

  // ① Mooncake PD 传输（完全不动）
  kv_cache_transfer_ = KVCacheTransferFactory::create(
      DisaggPDConfig::get_instance().kv_cache_transfer_type(), ...);

  // ② LMCache 节点内池化（新增，独立开关）
  if (LMCacheLocalPoolConfig::get_instance().enable()) {
    LMCacheLocalPool::Options opts;
    opts.lmcache_config_file(...).bridge_so_path(...).model_id(...);
    lmcache_local_pool_ = std::make_unique<LMCacheLocalPool>(std::move(opts), device_);
    lmcache_local_pool_->initialize(build_layout_from_kv_caches());
  }
}

// 钩子 A：在 prepare_inputs 末尾、prefill 前
int32_t WorkerImpl::prepare_inputs(ModelInput& input) {
  // ... 原有逻辑 ...
  if (lmcache_local_pool_ && lmcache_local_pool_->is_healthy()) {
    auto tokens = input.token_ids;
    auto block_ids = input.block_table;          // 当前请求占用的物理页
    int hit = lmcache_local_pool_->lookup_and_retrieve(tokens, kv_caches_, block_ids);
    if (hit > 0) {
      // 调整 prefill 范围：前 hit 个 token 跳过计算
      input.skip_prefix_tokens(hit);
    }
  }
}

// 钩子 B：在 prefill 完成、block 写满或请求结束时
void WorkerImpl::on_kv_ready_for_store(const Request& req) {
  if (lmcache_local_pool_ && lmcache_local_pool_->is_healthy()) {
    lmcache_local_pool_->store(req.token_ids, kv_caches_, req.block_ids, req.store_mask);
  }
  // PD push 由原有逻辑独立触发（kv_cache_transfer_->push_kv_blocks），不在此处
}
```

> **关键：PD 的 push/pull 代码原封不动。** LMCache 的 store/retrieve 是额外的、并行的本地操作。

---

## 5. 与 Mooncake 的关系：什么时候两者都活跃？

| 场景 | Mooncake（PD）| LMCache（节点内）| 说明 |
|------|---------------|-------------------|------|
| 纯在线单节点 | 关 | 开 | 无 PD，只要本地池化省 prefill |
| PD 分离 - P 节点 | 开（push）| 开（store）| P 存 KV 供本机复用 + push 给 D |
| PD 分离 - D 节点 | 开（pull）| 开（store+retrieve）| D 从 P 拿 KV + 本地也池化 |
| 离线批量推理 | 关 | 开 | 同前缀跨 batch 命中 |

**不会冲突的原因**：两者操作的是**不同维度的复用**。
- Mooncake：解决"同一请求，KV 要从 P 搬到 D"（空间维度，跨节点）。
- LMCache：解决"不同请求（同前缀），KV 不用重算"（时间维度，同节点）。
- 即便都开，P 节点会：`store to LMCache`（异步、后台）`+ push to D via Mooncake`（按 PD 协议），互不阻塞。

---

## 6. C ABI 桥接（与方案 B 相同，可复用）

`LMCacheLocalPool` 同样通过 `libxllm_lmcache_bridge.so`（C ABI）调 LMCache，**不直接嵌 Python**。
设计、ABI 头（`lmcache_bridge.h`）、bridge 实现与方案 B §3-§5 **完全相同**，此处不重复。

唯一区别：bridge 导出的符号集更小（不需要 PD 相关的），核心就三个：

```c
LmcStatus lmcache_engine_init(instance_id, cfg, kv_role, layout);
int32_t    lmcache_lookup_and_retrieve(instance_id, tokens, n, layer_bufs, block_ids);  // 钩子 A
LmcStatus  lmcache_store(instance_id, tokens, n, mask, layer_bufs, block_ids);          // 钩子 B
bool       lmcache_is_healthy(instance_id);
```

> 这套 ABI 比 方案 B 更简单：因为 LMCache 只做本地池化，不碰远端 Mooncake（远端 Mooncake 由 xllm 原生路径负责），bridge 内部的 LMCache 配置里 `remote_store` 可以关掉或指向独立 store，避免和 PD 的 Mooncake Store 混用。

---

## 7. 关键风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| **两个钩子插入点找不准** | 命中 KV 装不回正确页，或存入时机不对（KV 还没算完）| 钩子 A 在 `prepare_inputs` 末尾、attention metadata 构建前；钩子 B 在 layer 同步完成后。需要读懂 `prepare_mla_prefixcache_inputs` 的模式来对齐 |
| **prefix 命中后 prefill 范围调整** | xllm scheduler 不支持"部分跳过" | xllm 已有 prefix-cache 机制（`prepare_mla_prefixcache_inputs`），复用其 `num_kv_cache_tokens` / `q_seq_lens` 调整逻辑，LMCache 只是替换 KV 来源 |
| **block→token 映射** | LMCache 算哈希需要 token | `Request` 对象里有 token 序列 + block_table，钩子处可拿到 |
| **显存占用叠加** | Mooncache 页 + LMCache 的 NPU L1 层 都占显存 | LMCache YAML 里 `max_local_npu_size` 设小，或首版 LMCache 只用 CPU/Disk（不用 NPU L1），避免和 xllm 页争显存 |
| **GIL 热路径** | 同方案 B | 后台线程 + 队列 + 批量化；store 异步化（不阻塞 prefill）|

---

## 8. 验证计划

| 阶段 | 内容 | 通过标准 |
|------|------|----------|
| 1 | C ABI 自测（bridge put/get 字节一致）| put→get 校验通过 |
| 2 | 单卡 self-loop（`LMCacheLocalPool` store 后清页再 retrieve）| 字节一致 |
| 3 | **单节点 prefix-cache 命中**（同模型两请求共享前缀）| 第二请求 TTFT 下降、生成正确 |
| 4 | **PD + LMCache 并存**（Mooncake PD 开 + LMCache 开）| 端到端正确，PD 不受影响 |
| 5 | benchmark（TTFT / throughput vs 纯 Mooncake baseline）| 命中场景 TTFT 显著下降，未命中场景开销可忽略 |

> 阶段 3 是核心价值验证：证明 LMCache 在 xllm 里能省 prefill。阶段 4 是正交性验证：证明两者不打架。

---

## 9. 文件改动总览

### xllm 仓
| 文件 | 类型 | 说明 |
|------|------|------|
| `xllm/core/framework/lmcache/lmcache_local_pool.{h,cpp}` | 新增 | 节点内池化类（持 bridge handle）|
| `xllm/core/framework/lmcache/lmcache_bridge_loader.{h,cpp}` | 新增 | dlopen RAII（与方案 B 同）|
| `xllm/core/runtime/worker_impl.{h,cpp}` | 改 | 加 `lmcache_local_pool_` 成员 + 两个钩子 |
| `xllm/core/framework/config/lmcache_local_pool_config.{h,cpp}` | 新增 | `enable/config_file/bridge_so` 配置 |
| `CMakeLists.txt` | 改 | option `USE_LMCACHE_LOCAL_POOL`（默认 OFF）|

> **不改动**：`kv_cache_transfer.cpp`（工厂）、`mooncake_kv_cache_transfer.*`、`hierarchy_kv_cache_transfer.*`。

### lmcache-ascend 仓
与方案 B §5 相同（bridge + `XllmNpuConnector`），但 `XllmNpuConnector` 只需实现 store/retrieve 的 chunk↔page scatter/gather，不需要 PD 语义。

---

## 10. 方案对比（B vs D）与推荐

| 维度 | 方案 B（替换 Mooncake）| 方案 D（分层组合，推荐）|
|------|----------------------|------------------------|
| 是否替换 Mooncake | ✅ 替换 | ❌ **不替换，并存** |
| PD 跨节点 | LMCache 的 remote backend 做 | **Mooncake 原生做（保留）** |
| 节点内池化 | LMCache 做 | LMCache 做 |
| 对现有路径侵入 | 大（重写传输链）| **小（新增独立对象+两钩子）** |
| 可回退性 | 差 | **好（flag 开关，关闭即退回原状）** |
| 符合你描述的分层意图 | ❌ | ✅ **完全符合** |
| 复用 xllm 已有设计 | 部分 | **强（契合 Hierarchy 设计意图）** |
| 工作量 | ~8.5 周 | **~6 周**（少了 PD 传输重写）|

### 推荐：方案 D

理由：
1. **完全符合**你说的"Mooncake 负责 PD，LMCache 负责节点内池化"；
2. **契合 xllm 自己的设计意图**（`HierarchyKVCacheTransfer` 就是为此而设，只是被临时挂起）；
3. 对 Mooncake PD 路径**零侵入**，风险最低；
4. 比方案 B 省约 2.5 周（不用重写 PD 传输链）；
5. 远端 Mooncake Store 和本地 LMCache **不混用**，各自独立，避免方案 A 里那个跨语言协议风险。

---

## 11. 工作量估算

| 里程碑 | 内容 | 预估 |
|--------|------|------|
| M1 | C ABI 头 + bridge 骨架 + 自测 | 1.5 周 |
| M2 | `LMCacheLocalPool` + worker 钩子 + 配置 | 1.5 周 |
| M3 | `XllmNpuConnector`（chunk↔page scatter/gather）| 1.5 周 |
| M4 | prefix-cache 命中 + prefill 跳过逻辑对齐 | 1 周 |
| M5 | PD+LMCache 并存验证 + benchmark | 0.5 周 |
| **合计** | | **~6 周** |
