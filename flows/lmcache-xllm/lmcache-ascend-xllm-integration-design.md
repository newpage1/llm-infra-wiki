---
title: 方案 B 详细设计：为 xllm 新增 LMCache KV 传输后端
author: MadaoRui
date: 2026-08-02
tags: [xllm, LMCache, 方案设计, C-ABI]
summary: 在 xllm 的 KVCacheTransferFactory 里加第三个分支，经一个 C ABI 桥接库复用 LMCache 全栈（层级缓存、前缀命中、CacheBlend、PD 分离），对上层一行配置切换。
---
# 方案 B 详细设计：为 xllm 新增 `LMCache` KV 传输后端

> 目标：让 xllm 引擎原生把 KV cache 交给 LMCache（含 lmcache-ascend 的 Ascend 后端）管理，
> 享受其层级缓存（NPU 显存 → CPU → Disk → 远端 Mooncake Store）、prefix-cache 命中、
> CacheBlend、PD 分离等能力，对上层 xllm-service 完全透明（`kv_cache_transfer_type=LMCache` 一键切换）。

---

## 0. TL;DR — 一句话架构

在 xllm 的 `KVCacheTransferFactory` 里新增第三个分支 `"LMCache"`，它实例化一个
`LMCacheKVCacheTransfer`（C++，继承 `KVCacheTransfer`）。该类**不直接调 LMCache Python API**，
而是通过一个 **C ABI 的桥接库 `libxllm_lmcache_bridge.so`**（LMCache/lmcache-ascend 侧新建，
C++ 实现 + pybind 导出 C 符号）完成 KV 的 store/retrieve/lookup。
xllm 侧 `dlopen` 这个 .so，拿到一组纯 C 函数指针（`lmcache_put / lmcache_get / lmcache_lookup / …`）。

```text
xllm 引擎 (C++/libtorch+torch_npu)
  │
  │  KVCacheTransferFactory::create("LMCache", ...)
  ▼
LMCacheKVCacheTransfer  (xllm 侧, 新增, C++)
  │  pull_kv_blocks / push_kv_blocks / allocate / register
  │  实现 KVCacheTransfer 纯虚接口
  │
  │  dlopen("libxllm_lmcache_bridge.so") + dlsym
  ▼  ──────────────  C ABI 边界（void* + int + 简单结构体）  ──────────────
  │
libxllm_lmcache_bridge.so  (LMCache 侧, 新增, C++ + pybind11)
  │  内部持有: LMCacheEngine(单例) + 一个为 xllm 写的 NPU gpu_connector
  │  把 C 调用翻译成 LMCacheEngine.store()/retrieve()/lookup()
  ▼
LMCache v1 storage_manager 层级
  ├─ NPU 显存 (近端 L1, lmcache-ascend 提供)
  ├─ CPU pinned host mem (L2)
  ├─ Local Disk/SSD (L3)
  └─ Mooncake Store / Redis (远端, P↔D 搬运)
```

**为什么用 C ABI 桥接而不是 pybind11 直接嵌 Python？**
xllm 是 C++ 进程（libtorch），在推理热路径里嵌入 CPython 解释器（GIL、初始化、异常转换）
风险与开销都高。C ABI 把"语言边界"收敛到一个稳定、可独立编译、可单测的薄层：
- xllm 侧零 Python 依赖，编译/链接/部署干净；
- bridge 侧可单独编译（带 torch_npu + lmcache + lmcache_ascend），独立演进；
- ABI 用 `void*`（device 指针/offset）+ 基本类型，跨编译器/ABI 版本稳定。

---

## 1. 背景与约束（设计前提）

### 1.1 xllm 现有 KV 传输抽象

位置：`xllm/xllm/core/framework/kv_cache_transfer/`

```text
KVCacheTransfer (纯虚基类, kv_cache_transfer.h)
   ├─ allocate_kv_cache(kv_caches, num_layers, shape, dtype)
   ├─ register_kv_cache(kv_caches, shape, dtype)
   ├─ get_cache_info(cluster_id, addr)
   ├─ link_cluster / unlink_cluster
   ├─ pull_kv_blocks(src_cluster, src_addr, src_blocks, dst_blocks, ...)   ← 纯虚
   ├─ pull_kv_blocks_async(...)                                            ← 有默认实现(线程池)
   ├─ push_kv_blocks(merged_kv_infos, layer_synchronizer, ...)             ← 纯虚(NPU/MLU/DCU)
   └─ merge_kv_blocks(...)                                                 ← 有默认实现

KVCacheTransferFactory::create(transfer_type, ...)   ← kv_cache_transfer.cpp:335
   if transfer_type == "LlmDataDist"  → LlmDataDistTransfer (华为 HCCL)
   else if transfer_type == "Mooncake"→ MooncakeKVCacheTransferDefault/XTensor
   else                               → LOG(FATAL)
```

**调用点**：`worker_impl.cpp:375`，`WorkerImpl::allocate_kv_cache_with_transfer()` 在 worker 初始化时
唯一调用一次，传入 `DisaggPDConfig::kv_cache_transfer_type()`。

**关键约束**：
- 工厂只调用一次，**transfer 对象生命周期 = worker 生命周期**（长生命周期单例，可在构造时初始化桥接）。
- `push/pull` 携带的是 **block_id 列表**（PagedAttention 物理页号），不是 token。
- xllm 的 KV 是按 layer 组织的 `std::vector<KVCache>`，每个 KVCache 内含 k_cache/v_cache/index_cache 的 torch::Tensor。
- NPU 上 push 用 `KVPushSynchronizerImpl(=NPULayerSynchronizerImpl)` 做逐层流控。

### 1.2 LMCache 的语义模型（与 xllm 的根本差异）

| 维度 | xllm (Mooncake transfer) | LMCache v1 |
|------|--------------------------|------------|
| **寻址** | block_id（物理页号）| `CacheEngineKey(model_id, fmt, chunk_hash, …)`（token-hash 驱动）|
| **交换单元** | 整块 KV 页内存（裸字节）| chunk（带 metadata，可压缩）|
| **存储调用** | `Client::BatchPut(key=hash+tp_rank, slice=裸内存)` | `engine.store(tokens/hashes, mask, **kwargs)` |
| **取回调用** | `Client::BatchGet(key, slice)` → 直接 DMA 到页 | `engine.retrieve(tokens, mask) → bool mask`（命中标记）|
| **KV 搬运主体** | transfer 层自己做 RDMA/D2D | `gpu_connector` 抽象（vLLM connector 协议）负责把 chunk 拆/装进 paged buffer |
| **PD 角色** | P(push)/D(pull) 显式 | kv_role: kv_producer / kv_consumer / kv_both |
| **命中模型** | block 级全有全无 | token 级 prefix 命中（mask: FFFFFTTTTT）|

**核心结论**：不能把 xllm 的 `pull/push_kv_blocks` 直接 1:1 翻译成 LMCache 的 `store/retrieve`。
必须有一个**适配层**，负责：
1. block_id ↔ token-hash 的映射（用 request_id + block 内 token 序列算 hash）；
2. paged KV buffer 的"装/卸"——这正是 LMCache `gpu_connector` 的职责。

> 因此设计里 **xllm 侧的 `LMCacheKVCacheTransfer` 承担"block↔token 适配"和"触发存取"，
> bridge 侧提供一个专用的 `XllmNpuConnector`（实现 gpu_connector 协议）承担"chunk↔paged 页装卸"。**

### 1.3 硬件/编译约束

- xllm：C++17，libtorch + torch_npu，`_GLIBCXX_USE_CXX11_ABI` 跟随 PyTorch 自动探测。
- lmcache-ascend：PyTorch + torch_npu，C++17，`csrc/` 已有 NPU kernel 和 pybind。
- **ABI 一致性**：bridge.so 必须与 xllm 用**相同 CXX11_ABI**、**相同 torch_npu 版本**编译，
  否则跨 .so 传 `torch::Tensor` 会崩。设计上**不在 C ABI 跨边界传 torch::Tensor**，
  只传 `void*`（data_ptr）+ shape/dtype 元数据，规避此风险。

---

## 2. 总体架构（三层）

```text
┌──────────────────────────── xllm 仓 ────────────────────────────┐
│                                                                  │
│  worker_impl.cpp                                                 │
│       │  create("LMCache", ...)                                  │
│       ▼                                                          │
│  KVCacheTransferFactory  ──(新增分支)──►  LMCacheKVCacheTransfer │
│       │                                          │               │
│       │                                          │  allocate/register/pull/push
│       │                                          │               │
│       │                          LmcacheBridgeHandle (RAII, dlopen/dlclose)
│       │                                          │               │
│       └──────────────► dlopen libxllm_lmcache_bridge.so          │
│                                                                  │
└──────────────────────────┼───────────────────────────────────────┘
                           │  C ABI (lmcache_bridge.h)
                           ▼
┌──────────────────────── lmcache-ascend 仓 ───────────────────────┐
│                                                                   │
│  bridge/bridge.cpp  ──(导出 C 符号)──►  pybind11 module           │
│       │                                                           │
│       │  内部持有 LMCacheEngine 单例 (per instance_id)            │
│       │  内部持有 XllmNpuConnector (gpu_connector 实现)          │
│       │                                                           │
│       ├─ lmcache_engine_init(cfg_path, kv_layout)                 │
│       ├─ lmcache_put(instance_id, blocks, tokens, mask, kv_ptrs)  │
│       ├─ lmcache_get(instance_id, blocks, tokens, mask, kv_ptrs)  │
│       ├─ lmcache_lookup(instance_id, tokens) -> hit_mask          │
│       └─ lmcache_engine_finalize(instance_id)                     │
│                                                                   │
│  integration/xllm/xllm_npu_connector.py  (新增)                  │
│       └─ XllmNpuConnector: 把 chunk 拆装到 xllm paged buffer      │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

**三层职责**：
1. **xllm 层**：实现 `KVCacheTransfer` 接口，把 xllm 的 block/page 语义适配成 C ABI 调用；管理 RAII 句柄。
2. **bridge 层**（薄）：C ABI ↔ LMCacheEngine Python 对象的翻译；单例持有；线程安全。
3. **connector 层**：实现 LMCache 的 `gpu_connector` 协议，把 LMCache 的 chunk 语义适配到 xllm 的 paged KV 内存布局。

---

## 3. C ABI 设计（语言边界的契约）

文件：lmcache-ascend 新建 `bridge/include/lmcache_bridge.h`（纯 C 头，两侧共用）。

```c
// bridge/include/lmcache_bridge.h
#ifndef XLLM_LMCACHE_BRIDGE_H
#define XLLM_LMCACHE_BRIDGE_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---- 错误码 ---- */
typedef enum {
    LMC_OK = 0,
    LMC_ERR_NOT_INIT = -1,
    LMC_ERR_INVALID_ARG = -2,
    LMC_ERR_OOM = -3,
    LMC_ERR_BACKEND = -4,
    LMC_ERR_TIMEOUT = -5,
} LmcStatus;

/* ---- KV 内存布局描述（注册时一次性告知 bridge）---- */
typedef struct {
    int32_t  num_layers;        // model layer 数
    int32_t  block_size;        // tokens per block (xllm 页大小)
    int32_t  num_kv_heads;
    int32_t  head_dim;
    int32_t  dtype_code;        // 0=bf16 1=fp16 2=fp8 3=fp32
    bool     has_v_cache;       // MLA 等场景可能只有 k
    bool     has_index_cache;   // lighting indexer / MLA absorb 态
    /* index cache 额外维度，has_index_cache=true 时有效 */
    int32_t  index_num_entries;
    int32_t  index_entry_size;
} LmcKvLayout;

/* ---- 每层的 KV 指针（pull/push 时传入）----
 * 每层最多 3 个 buffer: k / v / index。data_ptr 是 device 指针(NPU)或 host 指针。
 * 桥接内部分发到 XllmNpuConnector 的 paged buffer。 */
typedef struct {
    void* k_data;      // 可为 NULL
    void* v_data;      // 可为 NULL
    void* index_data;  // 可为 NULL
} LmcLayerBuf;

/* ---- 生命周期 ---- */
// cfg_path: LMCache YAML 配置路径; kv_role: "producer"/"consumer"/"both"
// instance_id: 进程内唯一 id，多卡各不相同
// 返回 0 成功。线程安全，可重复 init（同 instance_id 幂等）。
LmcStatus lmcache_engine_init(const char* instance_id,
                              const char* cfg_path,
                              const char* kv_role,
                              const LmcKvLayout* layout);

LmcStatus lmcache_engine_finalize(const char* instance_id);

/* ---- 存（P 节点 push 后调用 / 主动缓存）----
 * blocks[]:     本次涉及的 xllm block_id 列表（长度 n_blocks）
 * tokens[]:     这些 block 展开后的连续 token id 序列（长度 n_tokens）
 * mask[]:       每 token 是否参与缓存（bool，长度 n_tokens；前缀 F + 后段 T）
 * layer_bufs[]: 每层 KV device 指针（长度 = layout.num_layers）
 * sync:         true=阻塞直到落盘/L2；false=异步返回
 */
LmcStatus lmcache_put(const char* instance_id,
                      const uint64_t* blocks, int32_t n_blocks,
                      const int32_t* tokens, int32_t n_tokens,
                      const bool* mask,
                      const LmcLayerBuf* layer_bufs,
                      bool sync);

/* ---- 取（D 节点 pull 时调用）----
 * 入参同 put（blocks/tokens/mask/layer_bufs 是目标 buffer）
 * out_hit[]: 输出，每 token 是否命中取回（长度 n_tokens）
 * 返回命中 token 数（>=0）或负错误码
 */
int32_t lmcache_get(const char* instance_id,
                    const uint64_t* blocks, int32_t n_blocks,
                    const int32_t* tokens, int32_t n_tokens,
                    const bool* mask,
                    const LmcLayerBuf* layer_bufs,
                    bool* out_hit);

/* ---- 仅查询命中（不搬运），用于 scheduler 决策 ---- */
// 返回前缀命中 token 数
int32_t lmcache_lookup(const char* instance_id,
                       const int32_t* tokens, int32_t n_tokens);

/* ---- 健康检查 ---- */
bool lmcache_is_healthy(const char* instance_id);

#ifdef __cplusplus
}
#endif
#endif
```

**设计要点**：
- **不跨边界传 `torch::Tensor`**：只传 `void*`（data_ptr）+ `LmcKvLayout`。规避 ABI/版本不匹配。
- **block 与 token 双轨**：同时传 `blocks[]`（xllm 原生寻址）和 `tokens[]`（LMCache 哈希寻址），让 bridge 内部用 token 算 `CacheEngineKey`，用 block 做页定位。
- **mask 语义对齐 LMCache**：`FFFFFTTTTT`（前缀 False=已有，后段 True=待处理），与 `engine.store/retrieve` 完全一致。
- **instance_id 多卡隔离**：xllm 每个 worker/rank 一个 id，对应 LMCache 一个 `LMCacheEngine` 单例。

---

## 4. xllm 侧改动（新增 `LMCacheKVCacheTransfer`）

### 4.1 新增文件清单

```text
xllm/xllm/core/framework/kv_cache_transfer/
├── lmcache_kv_cache_transfer.h        (新增)
├── lmcache_kv_cache_transfer.cpp      (新增)
├── lmcache_bridge_loader.h            (新增, RAII dlopen 句柄 + 函数指针类型)
├── lmcache_bridge_loader.cpp          (新增)
└── CMakeLists.txt                     (改: 加 cc_library)
```

### 4.2 `lmcache_bridge_loader.h` —— RAII dlopen

```cpp
// 函数指针类型定义，与 lmcache_bridge.h 的 C 声明一一对应
extern "C" {
using lmcache_engine_init_fn   = LmcStatus(*)(const char*, const char*, const char*, const LmcKvLayout*);
using lmcache_engine_finalize_fn = LmcStatus(*)(const char*);
using lmcache_put_fn   = LmcStatus(*)(const char*, const uint64_t*, int32_t, const int32_t*, int32_t, const bool*, const LmcLayerBuf*, bool);
using lmcache_get_fn   = int32_t(*)(const char*, const uint64_t*, int32_t, const int32_t*, int32_t, const bool*, const LmcLayerBuf*, bool*);
using lmcache_lookup_fn = int32_t(*)(const char*, const int32_t*, int32_t);
using lmcache_is_healthy_fn = bool(*)(const char*);
}

class LmcacheBridgeLoader {
 public:
  static LmcacheBridgeLoader& get_instance();   // 进程级单例，dlopen 一次
  bool load(const std::string& so_path);        // 显式加载，返回是否成功
  bool loaded() const { return handle_ != nullptr; }
  // 访问函数指针（loaded() 为 true 时有效）
  lmcache_engine_init_fn   engine_init;
  lmcache_engine_finalize_fn engine_finalize;
  lmcache_put_fn   put;
  lmcache_get_fn   get;
  lmcache_lookup_fn lookup;
  lmcache_is_healthy_fn is_healthy;
 private:
  void* handle_ = nullptr;
};
```

> 配置项 `LMCacheBridgeConfig::bridge_so_path`（新增 flag），指向 `libxllm_lmcache_bridge.so`。
> 若未配置或 dlopen 失败，工厂回退报错（不静默，因为 KV 传输是正确性关键路径）。

### 4.3 `lmcache_kv_cache_transfer.h`

```cpp
namespace xllm {

class LMCacheKVCacheTransfer final : public KVCacheTransfer {
 public:
  LMCacheKVCacheTransfer(int32_t device_id,
                         uint16_t listen_port,     // 兼容接口，LMCache 不用
                         const torch::Device& device,
                         const std::string& model_id,
                         InstanceRole instance_role);
  ~LMCacheKVCacheTransfer() override;

  void initialize(int32_t device_id) override;
  void allocate_kv_cache(std::vector<xllm::KVCache>& kv_caches,
                         int64_t num_layers,
                         const KVCacheShape& shape,
                         torch::ScalarType dtype) override;   // 记录布局，不真正分配(LMCache不管显存)
  void register_kv_cache(std::vector<xllm::KVCache>& kv_caches,
                         const KVCacheShape& shape,
                         torch::ScalarType dtype) override;   // engine_init
  void free_kv_cache() override;

  void get_cache_info(uint64_t& cluster_id, std::string& addr) override;
  bool link_cluster(uint64_t cid, const std::string& addr, uint16_t port) override;
  bool unlink_cluster(uint64_t cid, const std::string& addr, uint16_t port,
                      bool force_flag = true) override;

  bool pull_kv_blocks(uint64_t src_cluster, const std::string& src_addr,
                      const std::vector<uint64_t>& src_blocks,
                      const std::vector<uint64_t>& dst_blocks,
                      const std::vector<uint64_t>& src_linear_state_ids,
                      const std::vector<uint64_t>& dst_linear_state_ids) override;
  bool push_kv_blocks(std::unordered_map<std::string, KVCacheInfo>& merged,
                      std::shared_ptr<KVPushSynchronizerImpl>& sync,
                      bool is_spec_draft,
                      int32_t kv_split_rank, int32_t kv_split_size) override;

 private:
  // block_id → tokens 的映射（从 scheduler 的 request 上下文获取）
  std::vector<int32_t> collect_block_tokens(const std::vector<uint64_t>& block_ids);
  // 把每层 KVCache 的 data_ptr 打包成 LmcLayerBuf[]
  std::vector<LmcLayerBuf> marshal_layer_bufs();
  // mask 构造（前缀已缓存段置 false）
  std::vector<bool> build_store_mask(int32_t n_tokens, int32_t prefix_hit);

  std::string instance_id_;       // = model_id + ":" + rank
  std::string model_id_;
  InstanceRole instance_role_;
  torch::Device device_;
  LmcKvLayout layout_{};
  std::vector<xllm::KVCache>* kv_caches_ = nullptr;   // 非 own
  bool bridge_inited_ = false;
};

}  // namespace xllm
```

### 4.4 关键实现要点

**(a) `register_kv_cache` → `lmcache_engine_init`**：
- 从 `KVCacheShape` 提取 num_layers / block_size / num_kv_heads / head_dim / dtype；
- `model_id` 用 `DisaggPDConfig` 或 `options_.model_id()`；
- `kv_role`：P 节点=`producer`，D 节点=`consumer`，混合=`both`（由 `instance_role` 映射）；
- 读 `LMCACHE_CONFIG_FILE`（LMCache 标准 YAML）路径传给 bridge。

**(b) `push_kv_blocks` → `lmcache_put`**（P 节点存 KV）：
```cpp
auto tokens = collect_block_tokens(merged 中的 block_ids);
auto bufs   = marshal_layer_bufs();      // 遍历每层 KVCache, 取 k/v/index 的 data_ptr
auto mask   = build_store_mask(tokens.size(), 0);  // push 时全部为 true
sync->WaitForLayer(...) // 复用现有 layer 流控, 确保该层 KV 已就绪
LmcacheBridgeLoader::get_instance().put(
    instance_id_.c_str(), blocks.data(), blocks.size(),
    tokens.data(), tokens.size(), mask.data(), bufs.data(), /*sync=*/false);
```
> 关键：`collect_block_tokens` 需要 block→token 映射。xllm scheduler 在构造 `TransferKVInfo` 时
> 已知每个 block 对应的 token（`request_id` + block 内 token 序列）。需要在 `worker_impl` 或
> `scheduler` 处把这个映射透传给 transfer（见 §6 改动）。

**(c) `pull_kv_blocks` → `lmcache_get`**（D 节点取 KV）：
```cpp
auto tokens = collect_block_tokens(dst_blocks);
auto bufs   = marshal_layer_bufs();
std::vector<bool> hit(tokens.size());
int n = LmcacheBridgeLoader::get_instance().get(
    instance_id_.c_str(), dst_blocks.data(), dst_blocks.size(),
    tokens.data(), tokens.size(), /*mask=*/all_true, bufs.data(), hit.data());
// n < tokens.size() 时, 未命中部分由 D 节点本地 prefill 补齐(交还 xllm scheduler 决策)
return n > 0;
```

**(d) `link/unlink_cluster` / `get_cache_info`**：
- LMCache 的远端搬运由 storage backend（Mooncake Store）内部完成，**不需要 xllm 显式 link**。
- 实现为 no-op 或仅记录日志，保持接口完整。`get_cache_info` 返回 bridge 健康状态。

### 4.5 工厂分支（`kv_cache_transfer.cpp:370` 之后插入）

```cpp
} else if (transfer_type == "LMCache") {
  auto& bridge = LmcacheBridgeLoader::get_instance();
  std::string so_path = LMCacheBridgeConfig::get_instance().bridge_so_path();
  CHECK(bridge.load(so_path))
      << "Failed to load lmcache bridge: " << so_path
      << ". Check LMCacheBridgeConfig::bridge_so_path.";

  auto transfer = std::make_shared<LMCacheKVCacheTransfer>(
      device_id, transfer_listen_port, device, model_id, instance_role);
  transfer->initialize(device_id);
  transfer->allocate_kv_cache(kv_caches, num_layers, kv_cache_shape, dtype);
  transfer->register_kv_cache(kv_caches, kv_cache_shape, dtype);
  return transfer;  // 注意: 与 Mooncake 分支对称
}
```

### 4.6 CMake 改动（`kv_cache_transfer/CMakeLists.txt`）

```cmake
cc_library(
  NAME lmcache_bridge_loader
  HDRS lmcache_bridge_loader.h
  SRCS lmcache_bridge_loader.cpp
  DEPS glog::glog ${CMAKE_DL_LIBS}    # 关键: link dl, 不依赖 lmcache
)

# lmcache_kv_cache_transfer 只在 NPU 下编译(与 Mooncake 分支一致)
cc_library(
  NAME lmcache_kv_cache_transfer
  HDRS lmcache_kv_cache_transfer.h
  SRCS lmcache_kv_cache_transfer.cpp
  DEPS :common :kv_cache :kv_cache_transfer :lmcache_bridge_loader
         :common glog::glog torch torch_npu platform_npu proto::xllm_proto
)
```
> `kv_cache_transfer` 的 DEPS 增加 `$<$<BOOL:${USE_NPU}>:lmcache_kv_cache_transfer>`。

---

## 5. lmcache-ascend 侧改动（新增 bridge + xllm connector）

### 5.1 新增文件清单

```text
lmcache-ascend/
├── bridge/
│   ├── include/lmcache_bridge.h          (新增, C ABI 头, 与 xllm 侧共用)
│   ├── bridge.cpp                        (新增, C++ 实现 + pybind 导出 C 符号)
│   └── CMakeLists.txt                    (新增)
└── lmcache_ascend/integration/xllm/
    ├── __init__.py                       (新增)
    ├── xllm_npu_connector.py             (新增, gpu_connector 实现)
    └── kv_layout.py                      (新增, LmcKvLayout ↔ LMCache metadata 翻译)
```

### 5.2 `bridge.cpp` 核心实现

```cpp
// 持有 Python 端 LMCacheEngine 的 C++ wrapper
// 用 pybind11 的 scoped_interpreter_guard 管理 GIL（仅 bridge 内部）
// 实际 store/retrieve 在 hold GIL 的线程里调 Python 对象

static std::unordered_map<std::string, BridgeContext*> g_contexts;  // instance_id -> ctx
static std::mutex g_mtx;

extern "C" {

LmcStatus lmcache_engine_init(const char* instance_id, const char* cfg_path,
                              const char* kv_role, const LmcKvLayout* layout) {
  std::lock_guard<std::mutex> lk(g_mtx);
  if (g_contexts.count(instance_id)) return LMC_OK;  // 幂等
  auto* ctx = new BridgeContext();
  ctx->instance_id = instance_id;
  // 1. 加载 LMCacheEngineConfig.from_file(cfg_path)
  // 2. 构造 XllmNpuConnector(layout)
  // 3. LMCacheEngine.get_or_create(instance_id, cfg, connector)
  ctx->engine = /* py::object */;
  g_contexts[instance_id] = ctx;
  return LMC_OK;
}

LmcStatus lmcache_put(const char* instance_id, ...) {
  auto* ctx = g_contexts[instance_id];
  // 关键: 跨语言调用必须在 GIL 下
  py::gil_scoped_acquire gil;
  // 把 blocks/tokens/mask/layer_bufs 打包成 connector 能理解的 kwargs
  // 调 engine.store(tokens=..., mask=..., **paged_kv_kwargs)
  try {
    ctx->engine.attr("store")(tokens_py, mask_py, paged_kwargs);
  } catch (py::error_already_set& e) { return LMC_ERR_BACKEND; }
  return LMC_OK;
}

int32_t lmcache_get(const char* instance_id, ...) {
  py::gil_scoped_acquire gil;
  auto hit = ctx->engine.attr("retrieve")(tokens_py, mask_py, paged_kwargs);
  // hit 是 bool mask, 统计并拷贝到 out_hit
  ...
}

}  // extern "C"
```

### 5.3 `XllmNpuConnector`（gpu_connector 协议实现）

这是最难的一块，复用 lmcache-ascend 现有的 `VllmAscendConnector` 思路，
但目标 buffer 是 xllm 的 paged KV layout 而非 vLLM 的。

需实现 LMCache `RemoteKVConnector` / `GPUConnector` 接口的关键方法：
- `get_num_new_matched_tokens()`：本步要处理的 token 数
- `update_state_after_alloc()`：拿到 slot 映射后更新内部状态
- `build_connector_meta()`：构造传给 store/retrieve 的 kwargs（含 paged buffer 指针、block_table）
- `save_kv_layer()` / `wait_for_save()`：逐层保存（对应 xllm 的 layer_synchronizer 流控）
- `wait_for_get()`：取回完成同步

```python
# lmcache_ascend/integration/xllm/xllm_npu_connector.py
class XllmNpuConnector(GPUConnectorBase):
    def __init__(self, layout: LmcKvLayout):
        self.layout = layout
        # 每层 k/v/index 的 device 指针, 由 bridge.lmcache_put/get 时通过 kwargs 注入
        self.layer_bufs = None
        self.block_table = None

    def set_paged_buffer(self, layer_buf_ptrs, block_ids):
        """bridge 调 store/retrieve 前注入 xllm 侧的 paged 指针"""
        self.layer_bufs = layer_buf_ptrs  # {layer: {k: ptr, v: ptr}}
        self.block_table = block_ids

    def build_connector_meta(self, ptrs):
        # 构造 LMCache 期望的 kwargs, 描述 paged KV 如何分块到 chunk
        return {"kv_layout": "xllm_paged", "layer_bufs": ..., "block_table": ...}

    def save_kv_layer(self, layer_id):
        # 把该层 KV 从 NPU 页拷到 LMCache 的 chunk (host/NPU memory obj)
        ...

    def wait_for_get(self):
        # retrieve 后, 把命中 chunk scatter 回 xllm paged 页
        ...
```

> **chunk ↔ page scatter/gather** 是性能关键。lmcache-ascend 的 `csrc/mem_kernels.cpp` 已有
> NPU 上的 KV memcpy/gather kernel，可直接复用，避免重写。

---

## 6. 周边改动（让 block→token 映射可达）

xllm 当前的 `pull/push_kv_blocks` 只传 block_id，不带 token。LMCache 需要 token 算哈希。
有两种方案：

**方案 6-A（推荐，改动小）**：在 `WorkerImpl` 维护一个 `block_id → token_ids` 的小映射表
（仅对"正在参与传输的 request"），在构造 `TransferKVInfo` 时一并填充。
`TransferKVInfo` 增加可选字段 `std::vector<int32_t> tokens;`（默认空，仅 LMCache 后端读）。

**方案 6-B**：`LMCacheKVCacheTransfer` 自己从 scheduler 上下文查。耦合更深，不推荐。

### 6.1 配置项新增（`DisaggPDConfig` 或独立 `LMCacheConfig`）

```cpp
PROPERTY(std::string, lmcache_config_file) = "";   // LMCache YAML 路径
PROPERTY(std::string, lmcache_bridge_so)   = "";   // libxllm_lmcache_bridge.so 路径
PROPERTY(std::string, lmcache_kv_role)     = "both"; // producer/consumer/both
```
新增 `normalize_ascend()`：当 `kv_cache_transfer_type == "LMCache"` 时，校验 bridge_so 非空。

---

## 7. 编译、部署、运行

### 7.1 编译顺序（依赖链）

```text
1. lmcache-ascend/bridge/  →  libxllm_lmcache_bridge.so   (依赖 lmcache, lmcache_ascend, torch_npu)
2. xllm                    →  libxllm (dlopen 上面那个 .so, 编译期不依赖)
```

> xllm 编译期**完全不依赖** lmcache，只在运行时 dlopen。这是"可选插件"的关键。

### 7.2 LMCache YAML 配置示例（`lmcache.yaml`）

```yaml
chunk_size: 256                 # 与 xllm block_size 对齐或为其整数倍
local_cpu: True
max_local_cpu_size: 10
local_disk: /data/lmcache_disk
max_local_disk_size: 100
remote_store: mooncake          # 用 JD fork 的 Mooncake Store 做跨节点
remote_serde: mooncakestore
max_local_npu_size: 2           # lmcache-ascend 的 NPU 显存层
save_chunk_meta: False          # 与 xllm 的 KVCacheStore(裸字节)对齐
```

### 7.3 运行（PD 分离场景）

```bash
# 1. 启动 Mooncake Store master (JD fork)
# 2. P 节点 (prefill worker)
export LMCACHE_CONFIG_FILE=/path/lmcache.yaml
export XLLM_LMCACHE_BRIDGE_SO=/path/libxllm_lmcache_bridge.so
xllm serve ... \
  --enable-disagg-pd \
  --instance-role PREFILL \
  --kv-cache-transfer-type LMCache \
  --lmcache-kv-role producer

# 3. D 节点 (decode worker)
xllm serve ... \
  --instance-role DECODE \
  --kv-cache-transfer-type LMCache \
  --lmcache-kv-role consumer
```

---

## 8. 关键技术风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| **GIL 在热路径** | bridge 每次 put/get 都要 acquire GIL，NPU 异步流被 Python 拖慢 | (1) bridge 内部用独立后台线程 + 队列，worker 线程只入队；(2) 批量化（一次 put/get 多 layer/block）；(3) 长期：把 LMCache 的核心存储路径用 C++ 重写（lmcache-ascend 的 `csrc/` 已部分如此） |
| **block↔token 映射不全** | LMCache 哈希算不出正确 key，命中率为 0 | 方案 6-A，在 scheduler/worker 透传；首版可对齐为"每 block 整存整取"，token 序列从 request 重建 |
| **KV 布局不兼容**（MLA index_cache / DeepSeek-V4 / spec draft）| put 的字节在 get 端解释错 | `LmcKvLayout` 显式描述 has_v/has_index/dtype；首版只支持标准 MHA（k+v），MLA/DSv4 作为 P1 |
| **torch_npu ABI 不一致** | bridge.so 与 xllm 的 torch::Tensor 内存模型不匹配 | **C ABI 不传 Tensor，只传 void\***，规避；device 指针在 NPU 上是跨 .so 有效的 |
| **跨节点协议**（xllm 用 JD Mooncake fork `1adcb2fb`）| LMCache 的 `mooncake_store` pip 包（上游 kvcache-ai）wire protocol 可能与 JD fork 不一致 | 首版 PD 限定同 fork 部署；若要 xllm↔vllm-ascend 共享，需先跑 §9 互通测试 |
| **异步语义对齐** | xllm 用 `folly::SemiFuture`，LMCache 用 asyncio | bridge 内部桥接：C++ future ↔ Python asyncio.run_coroutine_threadsafe；首版先做同步版，异步作 P1 |

---

## 9. 验证计划（分阶段）

### 阶段 0：Mooncake 互通性（前置，决定远端是否可用）
C++ 用 JD fork `mooncake::Client::BatchPut` 写 key，Python `mooncake_store` 包读。
通过 → 远端 Mooncake backend 可用；不通过 → PD 首版用 host CPU 搬运，远端留 P1。

### 阶段 1：单进程 C ABI 自测
- bridge 单元测试：`lmcache_engine_init → put(随机 KV) → get → 校验字节一致`。
- 不接 xllm，直接用 C test harness 调 bridge 符号。

### 阶段 2：xllm 单卡 self-loop
- `kv_cache_transfer_type=LMCache`，kv_role=both。
- 同一进程：push 一段 KV → 清空本地页 → pull 回来 → 校验。
- 验证 `LMCacheKVCacheTransfer` 接口实现正确。

### 阶段 3：单机 prefix-cache 命中
- 同模型两请求共享前缀，验证第二次请求 retrieve 命中、TTFT 下降。

### 阶段 4：双节点 PD 分离
- P 节点 producer，D 节点 consumer，共享 Mooncake Store。
- 验证跨节点 KV 搬运正确 + 端到端生成质量无损。

### 阶段 5：性能 & 功能扩展
- MLA / DeepSeek-V4 / speculative draft 支持；
- CacheBlend 命中拼接；
- benchmark TTFT / throughput vs Mooncake baseline。

---

## 10. 工作量估算与里程碑

| 阶段 | 内容 | 产出 | 预估 |
|------|------|------|------|
| M1 | C ABI 头 + bridge 骨架 + 单测 | `libxllm_lmcache_bridge.so` 可 dlopen，put/get 自测通过 | 1.5 周 |
| M2 | `LMCacheKVCacheTransfer` + 工厂分支 + CMake | xllm 编译通过，阶段 2 self-loop | 1.5 周 |
| M3 | `XllmNpuConnector`（chunk↔page scatter/gather） | NPU 上正确存取 KV | 2 周 |
| M4 | block↔token 映射透传 + 配置项 + PD 模式 | 阶段 4 双节点端到端 | 1.5 周 |
| M5 | 异步化、GIL 优化、benchmark | 性能达标 | 2 周 |
| **合计** | | | **~8.5 周** |

P1（M5 之后）：MLA/DSv4 index_cache、speculative draft、CacheBlend、跨框架（xllm↔vllm-ascend）共享缓存。

---

## 11. 文件改动总览

### xllm 仓（新增为主，改动少）
| 文件 | 类型 | 说明 |
|------|------|------|
| `xllm/core/framework/kv_cache_transfer/lmcache_bridge_loader.{h,cpp}` | 新增 | dlopen RAII + 函数指针 |
| `xllm/core/framework/kv_cache_transfer/lmcache_kv_cache_transfer.{h,cpp}` | 新增 | KVCacheTransfer 实现 |
| `xllm/core/framework/kv_cache_transfer/kv_cache_transfer.cpp` | 改 | 工厂加 `"LMCache"` 分支 |
| `xllm/core/framework/kv_cache_transfer/CMakeLists.txt` | 改 | 加两个 cc_library |
| `xllm/core/framework/config/lmcache_config.{h,cpp}` | 新增 | 配置项 + normalize |
| `xllm/core/common/types.h` | 改 | `TransferKVInfo` 加可选 `tokens` 字段 |
| `xllm/core/runtime/worker_impl.cpp` | 改 | 透传 block→token 映射（方案 6-A）|
| `CMakeLists.txt` | 改 | 顶层 option `USE_LMCACHE`(默认 OFF) |

### lmcache-ascend 仓（新增为主）
| 文件 | 类型 | 说明 |
|------|------|------|
| `bridge/include/lmcache_bridge.h` | 新增 | C ABI 头（两侧共用）|
| `bridge/bridge.cpp` | 新增 | C++ 实现+C符号导出 |
| `bridge/CMakeLists.txt` | 新增 | 编 libxllm_lmcache_bridge.so |
| `lmcache_ascend/integration/xllm/xllm_npu_connector.py` | 新增 | gpu_connector 实现 |
| `lmcache_ascend/integration/xllm/kv_layout.py` | 新增 | 布局翻译 |
| `csrc/xllm_scatter_gather.{cpp,h}` | 新增（可复用现有 mem_kernels）| chunk↔page scatter/gather |

---

## 12. 决策记录（为什么这样选）

1. **C ABI 而非 pybind 直接嵌**：xllm 是 C++ 推理进程，热路径嵌 CPython 风险高；C ABI 把语言边界收敛到一处，xllm 编译期零 Python 依赖，可独立演进。
2. **新增 transfer 子类而非改 Mooncake 分支**：遵循 xllm 既有的插件约定（`transfer_type` 字符串分发），对现有 Mooncake/LlmDataDist 路径零侵入，可回退。
3. **bridge 放 lmcache-ascend 仓而非 xllm 仓**：bridge 依赖 lmcache+lmcache_ascend+torch_npu，与 xllm 解耦；版本对齐责任在 lmcache 侧。
4. **首版只支持标准 MHA**：MLA/DSv4/index_cache 的 KV 布局复杂（absorb 态、index cache），首版先打通主路径，复杂格式作 P1，降低风险。
5. **不传 torch::Tensor 跨边界**：规避 torch_npu/PyTorch ABI 版本耦合，device 指针 + 元数据足够且稳定。
