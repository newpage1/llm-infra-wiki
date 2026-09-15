---
title: 方案 N：xllm 原生逐层 KV 传输（不移植 lmcache 算子）
author: MadaoRui
date: 2026-08-02
tags: [xllm, 逐层传输, 昇腾, 方案设计]
summary: 方案 B 与方案 D 的最小闭环前置：暂不移植 AscendC 的 scatter/gather kernel、不引入跨语言桥接，仅用 xllm 原生的 aclrtMemcpyBatch 加 device-side event overlap，先把逐层传输与 attention 重叠跑通。
---
# 方案 N：xllm 原生逐层 KV 传输（不移植 lmcache 算子）

> **定位**：这是 `integration-design.md`（方案 B，dlopen 桥接 + lmcache 全栈）和
> `hierarchy-design.md`（方案 D，Hierarchy + Mooncake 分层）的**最小闭环前置方案**。
>
> **核心取舍**：暂不移植 lmcache-ascend 的 paged scatter/gather AscendC kernel，
> 暂不引入跨语言桥接。仅用 xllm 原生的 `aclrtMemcpyBatch`（改 async）+ device-side
> event overlap，先把"逐层 H2D/D2H KV 传输 + 与 attention overlap"这条最小可行路径跑通。
>
> **为什么不移植算子**：见讨论结论——一旦放弃 lmcache-ascend 的 chunk/token-major
> 组织、改用 xllm 的 block/paged 组织做"端到端同布局 block→block 搬运"，传输就退化
> 成 block 级线性 memcpy，**不需要 scatter kernel，dims 转置问题也不存在**（两端同布局）。
> scatter kernel 的价值（contiguous chunk ↔ paged + dims 吸收）只有在源端是 token-major
> contiguous 时才体现；本方案刻意避开它，把风险降到最低。
>
> **与后两份文档的关系**：本方案是 P0。跑通后，若 profile 显示 memcpy 是瓶颈，再按
> 方案 B/D 把 lmcache-ascend 的 fused scatter kernel 作为"传输加速器"接入——届时 dims
> 映射问题才需要处理，且可作为独立优化迭代。

---

## 0. 决策前提（已与用户确认）

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 目标场景 | 单节点 GPU↔CPU pinned 分层 offload | 不涉及跨节点协议，脚手架现成 |
| KV 组织 | xllm 原生 block/paged（**不**用 lmcache chunk token-major） | 消除 scatter 需求与 dims 风险 |
| 搬运原语 | `aclrtMemcpyBatch`（改 async）+ host `aclrtHostRegister` pinned 池 | xllm 已有 API（`HierarchyKVCacheTransfer` 在用），零外部依赖 |
| overlap 语义 | **device-side** `aclrtStreamWaitEvent`（仿 `RollingLoadManager`） | 真流水线；不用 host-blocking `synchronize_layer` |
| 算子移植 | **暂不移植** lmcache-ascend kernel | 最小风险、最小依赖 |

---

## 1. 现状基线（代码事实，非二手）

### 1.1 H2D 逐层传输：当前**没有**可用实现

- 唯一实现过 H2D 逐层 + per-layer overlap 的是 `HierarchyKVCacheTransfer`，但被全面注释禁用：
  - `worker_impl.h:29,217,330`、`worker_impl.cpp:360,391,424`（`init_hierarchy_kv_cache_transfer()` 注释）
  - `worker_impl.cpp:1643,1652`（`LOG(FATAL) "hierarchy kv cache transfer is disabled"`）
  - `llm_worker_impl.cpp:188`、`rec_worker_impl.cpp:3173`（`set_layer_synchronizer` 注释）
- 其 H2D 逐层逻辑代码**完整保留**（`hierarchy_kv_cache_transfer.cpp:286-409` `h2d_batch_copy`）：
  - 按 `layers_per_bacth_copy` 分层块
  - 每块一次 `aclrtMemcpyBatch`（**同步**，是 TODO 要改的点，见 `d2h_batch_copy:254`）
  - 每块 record 一个 `aclrtEvent`，注入 `layer_wise_load_synchronizer_[batch_id]`
- **gate 点基础设施完整**：`ModelInputParams::synchronize_layer(i)`（`model_input_params.h:1014`）逐层调用，但运行时 `layer_wise_load_synchronizer` 永远是 `nullptr`（因为注入者被禁用），所以**空转**。

### 1.2 D2H：同步、无 overlap

- `d2h_batch_copy`（`hierarchy_kv_cache_transfer.cpp:205-284`）：一次性把所有层×所有 block 拼成一个 `aclrtMemcpyBatch`，然后 `stream->synchronize()` 阻塞。**无逐层、无 overlap**。
- 被 PUSH（跨节点发送）侧的 `MooncakeKVCacheTransfer::push_kv_blocks` 才有逐层 overlap（`mooncake_kv_cache_transfer.cpp:510`，配 `layer_synchronizer` event）——但那是 D2H→远端，不是 D2H→本机 CPU。

### 1.3 device-side overlap 的教科书范例：`RollingLoadManager`

`core/layers/npu/loader/rolling_load_manager.cpp:155-202` 是 xllm 里**正确**的逐层 device-side overlap 实现（权重 rolling load），本方案的 overlap 机制直接照搬它的模式：

```cpp
// load_stream 上发起 H2D，record event
kick_h2d(layer_index);
aclrtRecordEvent(h2d_events_[layer_index], load_stream);

// compute_stream 在读这层前 wait event（device-side，CPU 不挂起）
wait_layer_h2d_ready(layer_index):
  aclrtStreamWaitEvent(compute_stream, h2d_events_[layer_index]);  // ← 关键
  aclrtResetEvent(h2d_events_[layer_index], compute_stream);

// 这层 compute 完，record compute_event；load_stream 等它后才能覆盖同一槽位
schedule_next_layer_h2d(layer_index):
  aclrtRecordEvent(compute_events_[layer_index], compute_stream);
  aclrtStreamWaitEvent(load_stream, compute_events_[layer_index]);
  kick_h2d(next_layer);
```

**这是本方案 overlap 设计的蓝本。**

### 1.4 host pinned 池：现成机制

`hierarchy_kv_cache_transfer.cpp:510` 用 `aclrtHostRegister(..., ACL_HOST_REGISTER_MAPPED, &mapped_ptr_)` 把页对齐的 host KV 池注册为 device-mapped 内存——本方案的 CPU 侧存储直接复用这个手法。

---

## 2. 目标架构

### 2.1 单 Worker 内的职责切分

```text
┌─────────────────────── 单 Worker（NPU）──────────────────────────┐
│                                                                   │
│  请求到达（batch_id, block_transfer_infos）                        │
│    │                                                              │
│    ├─【H2D load】命中本地 CPU 池的 block                            │
│    │   逐层 async memcpy（CPU pinned → NPU paged 槽位）            │
│    │   per-layer event → model loop device-side wait              │
│    │                                                              │
│    ├─【forward】model loop（npu/llm_model_base.h:233）             │
│    │   for i in layers:                                           │
│    │     aclrtStreamWaitEvent(compute, h2d_event[i])  ← overlap    │
│    │     attention(i)  读写 kv_caches[i]                          │
│    │     [可选] record compute_event[i] 供 D2H overlap            │
│    │                                                              │
│    └─【D2H offload】evict/存档的 block                             │
│        逐层 async memcpy（NPU paged → CPU pinned）                 │
│        per-layer event → 与下一层 attention overlap                │
└───────────────────────────────────────────────────────────────────┘
```

### 2.2 与现有传输路径的关系

| 路径 | 方向 | 本方案是否覆盖 | 说明 |
|------|------|----------------|------|
| 本机 H2D（CPU→NPU） | host→device | ✅ **新建** | 逐层 async + device overlap |
| 本机 D2H（NPU→CPU） | device→host | ✅ **新建** | 逐层 async + device overlap |
| 跨节点 PD pull/push | 远端↔device | ❌ 不动 | 仍走 Mooncake（整体 SemiFuture） |
| KVCacheStore（落 SSD/etcd） | host↔外部存储 | ⏸ 暂不做 | Hierarchy 有 `offload_to_store/load_from_store`，本方案先只做 NPU↔CPU 这一级 |

**本方案只补"本机 NPU↔CPU pinned 的逐层 overlap"这一格，其它路径维持现状。**

---

## 3. 详细设计

### 3.1 新增类：`NativeLayerwiseKVTransfer`

**位置**：`xllm/core/framework/kv_cache_transfer/native_layerwise_kv_transfer.{h,cpp}`

为什么不直接"解禁 Hierarchy"：
1. Hierarchy 的 H2D 用**同步** `aclrtMemcpyBatch` + **host-blocking** `synchronize_layer`（性能差，且与 device overlap 语义冲突）；
2. Hierarchy 还耦合了 `KVCacheStore`（SSD/etcd）逻辑，本方案 P0 不需要；
3. Hierarchy 被 block-manager 重构阻塞，解禁要等重构完成；
4. 独立新建可不受重构进度影响，且能从一开始就用 device-side overlap。

**接口设计**（与 `HierarchyKVCacheTransfer` 同级，不继承 `KVCacheTransfer`——后者是跨节点抽象，本方案是节点内机制）：

```cpp
namespace xllm {

class NativeLayerwiseKVTransfer {
 public:
  struct Options {
    PROPERTY(uint32_t, tp_rank);
    PROPERTY(uint32_t, layers);                   // num decoder layers
    PROPERTY(double, host_blocks_factor) = 0.0;   // CPU 池相对 GPU 的容量比
    PROPERTY(uint32_t, layers_per_copy_batch) = 1;// 每次 memcpy 合并几层
    PROPERTY(int64_t, stream_timeout_ms) = 60000; // copy stream 借用超时
  };

  NativeLayerwiseKVTransfer(const Options& options,
                            const torch::Device& device,
                            std::vector<xllm::KVCache>* kv_caches_ptr,
                            Stream* compute_stream);   // ← 关键：拿到 compute_stream 做 device-side wait
  ~NativeLayerwiseKVTransfer();

  // ===== H2D：把命中的 block 从 CPU 池逐层搬回 NPU =====
  // 返回 batch_id，调用方用它从 layer_synchronizer_for(batch_id) 取 gate
  uint64_t load_kv_blocks_async(std::vector<BlockTransferInfo> infos);

  // ===== D2H：把要 evict 的 block 逐层搬到 CPU 池 =====
  // 在 offload stream 上跑，与 attention overlap
  void offload_kv_blocks_async(std::vector<BlockTransferInfo> infos);

  // ===== 把本 batch 的 per-layer gate 注入 ModelInputParams =====
  // 仿 HierarchyKVCacheTransfer::set_layer_synchronizer，但注入的是
  // DEVICE-SIDE wait 的 synchronizer（见 3.3）
  void install_layer_gate(uint64_t batch_id, ModelInputParams& params);

  // 查询某 block 是否在 CPU 池（prefix 命中判断）
  bool has_block(uint64_t block_id) const;

 private:
  void create_page_aligned_host_pool();   // aclrtHostRegister(ACL_HOST_REGISTER_MAPPED)
  Stream* borrow_copy_stream();
  void return_copy_stream(std::unique_ptr<Stream>);

  Options options_;
  Device device_;
  Stream* compute_stream_;                // 不拥有，用于 device-side wait
  std::vector<xllm::KVCache>* kv_caches_ptr_;
  std::vector<xllm::KVCache> host_kv_caches_;   // CPU 侧 paged 镜像（同布局）

  void* mapped_host_data_ = nullptr;
  std::vector<uint64_t> cache_size_per_layer_;

  // copy stream 池（仿 HierarchyKVCacheTransfer）
  moodycamel::BlockingConcurrentQueue<std::unique_ptr<Stream>> copy_streams_;

  // per-batch 的 device-side gate（见 3.3）
  std::mutex gate_mutex_;
  std::unordered_map<uint64_t, std::shared_ptr<DeviceSideLayerGate>>
      batch_gates_;
};

}  // namespace xllm
```

### 3.2 搬运逻辑（核心：改 async + block→block 线性拷）

**为什么是 block→block 线性 memcpy、不需要 scatter**：

两端都是 xllm paged 布局，同一个 `kv_caches[layer].get_k_cache()` 返回的是
`[num_blocks, ...]` 的 tensor，`get_k_cache()[block_id]` 就是该 block 的连续存储区。
源（CPU 池 `host_kv_caches_[src_block_id].get_k_cache()[layer_id]`）和
目的（`kv_caches_ptr_->at(layer_id).get_k_cache()[dst_block_id]`）都是**一个 block 的连续字节**，
`aclrtMemcpyBatch` 一次搞定，slot_mapping / dims 全无关。

```cpp
// H2D load —— 伪码，关键是 aclrtMemcpyBatch 之前的 ACL_MEMCPY_HOST_TO_DEVICE
uint64_t NativeLayerwiseKVTransfer::load_kv_blocks_async(
    std::vector<BlockTransferInfo> infos) {
  auto batch_id = next_batch_id++;
  auto gate = std::make_shared<DeviceSideLayerGate>(options_.layers());
  {
    std::lock_guard<std::mutex> l(gate_mutex_);
    batch_gates_[batch_id] = gate;
  }

  // 异步派发到 copy 线程
  h2d_threadpool_->enqueue([this, infos, gate]() {
    auto stream = borrow_copy_stream();
    auto guard = stream->set_stream_guard();
    aclrtStream ls = stream->get_stream()->stream();
    aclrtStream cs = compute_stream_->get_stream()->stream();

    const int64_t num_layers = options_.layers();
    uint32_t per_batch = options_.layers_per_copy_batch();

    for (int layer_start = 0; layer_start < num_layers; layer_start += per_batch) {
      int layer_end = std::min(layer_start + per_batch, (int)num_layers);

      // 拼装 srcs/dsts/copy_size（仿 h2d_batch_copy:330-370）
      std::vector<void*> srcs, dsts;
      std::vector<size_t> sizes;
      for (int L = layer_start; L < layer_end; ++L) {
        for (const auto& info : infos) {
          srcs.push_back(host_kv_caches_[info.src_block_id].get_k_cache()[L].data_ptr());
          dsts.push_back(kv_caches_ptr_->at(L).get_k_cache()[info.dst_block_id].data_ptr());
          sizes.push_back(cache_size_per_layer_[0]);
          // ... 同理 V（+ index_cache 若有）
        }
      }

      // 异步批量拷（注意：用 ACL_MEMCPY_HOST_TO_DEVICE 属性）
      aclrtMemcpyBatch(dsts.data(), sizes.data(), srcs.data(), sizes.data(),
                       srcs.size(), &h2d_attr, /*async*/ ...);

      // record event 在 copy stream —— compute 侧 device-side wait（见 3.3）
      aclrtRecordEvent(gate->event(layer_start), ls);
    }
    return_copy_stream(std::move(stream));
  });

  return batch_id;
}
```

> ⚠️ **async API 落地待确认**：`aclrtMemcpyBatch` 本身是同步语义。两条路：
> (a) 单次 batch 内拷的量不大时，仍用 `aclrtMemcpyBatch`，但放在专用 copy stream 上、
>     用 event 与 compute stream 解耦——overlap 来自"不同 stream 并行"，而非"调用非阻塞"；
> (b) 若需要更细的并发，降级为逐 block `aclrtMemcpyAsync`（H2D），自己攒批。
> 参考 `hierarchy_kv_cache_transfer.cpp:254` 的 TODO（"change to async API"）说明这是已知改进点。
> **P0 先走 (a)，profile 后再决定是否上 (b)。**

### 3.3 overlap 机制：device-side gate（蓝本：RollingLoadManager）

**关键设计**：不用 host-blocking 的 `NPULayerSynchronizerImpl::synchronize_layer`
（它内部 `aclrtSynchronizeEventWithTimeout` 会阻塞 CPU 线程，破坏流水线）。
新增一个 **device-side** gate：

```cpp
// 新增：device-side 逐层 gate
class DeviceSideLayerGate {
 public:
  explicit DeviceSideLayerGate(uint32_t num_layers) {
    events_.resize(num_layers);
    for (auto& e : events_) {
      aclrtCreateEventWithFlag(&e, ACL_EVENT_SYNC);
    }
  }
  ~DeviceSideLayerGate() { for (auto& e : events_) aclrtDestroyEvent(e); }

  aclrtEvent* event(uint32_t layer) { return &events_[layer]; }

  // 在 compute stream 上 device-side wait 某层 H2D 完成（CPU 不挂起）
  // 仿 RollingLoadManager::wait_layer_h2d_ready
  void wait_layer_on_compute(uint32_t layer, aclrtStream compute_stream) {
    aclrtStreamWaitEvent(compute_stream, events_[layer]);   // device-side
    aclrtResetEvent(events_[layer], compute_stream);
  }
 private:
  std::vector<aclrtEvent> events_;
};
```

### 3.4 与 model loop 的对接（关键改动点）

model loop 现有的 `synchronize_layer(i)`（`model_input_params.h:1014`）走的是 host-blocking
路径，不适合 device overlap。**两条可选接线方式**：

**方式 1（推荐，改动小）：扩展 `ModelInputParams` 增加 device-gate 字段**

在 `ModelInputParams::ParallelInput` 增加：
```cpp
std::shared_ptr<DeviceSideLayerGate> device_layer_gate = nullptr;
aclrtStream compute_stream_for_gate = nullptr;
```
然后在 `synchronize_layer(i)` 里**优先**走 device 路径：
```cpp
bool synchronize_layer(uint32_t i) const {
#if defined(USE_NPU)
  if (parallel.device_layer_gate != nullptr) {            // ← 新增优先分支
    parallel.device_layer_gate->wait_layer_on_compute(
        i, parallel.compute_stream_for_gate);
    return true;                                            // CPU 不阻塞
  }
  if (parallel.layer_wise_load_synchronizer != nullptr &&   // 旧 host-blocking 路径保留
      i % parallel.layers_per_bacth_copy == 0) { ... }
#endif
  return true;
}
```
所有 npu model（`llm_model_base.h:241` 等十几个）**无需改动**——它们调的都是 `synchronize_layer(i)`。

**方式 2（侵入大）：直接在 model loop 插 wait**
不推荐，因为 npu 下有十几个 model 文件都有 layer loop。

### 3.5 Worker 接线

参考 `HierarchyKVCacheTransfer` 原本在 worker 里的位置，但本方案是**新增成员、共存**，
不动 Mooncake：

```cpp
// worker_impl.h（新增成员，与 kv_cache_transfer_ 并列）
std::unique_ptr<NativeLayerwiseKVTransfer> native_layerwise_transfer_;

// worker_impl.cpp 初始化（仿原 init_hierarchy_kv_cache_transfer，但解开禁）
void WorkerImpl::init_native_layerwise_transfer() {
  if (!LoadConfig::enable_native_layerwise()) return;   // 新增 flag
  NativeLayerwiseKVTransfer::Options opts;
  opts.layers(context_.get_model_args().n_layers())
      .host_blocks_factor(LoadConfig::host_blocks_factor())
      .layers_per_copy_batch(LoadConfig::layers_per_copy_batch());
  native_layerwise_transfer_ = std::make_unique<NativeLayerwiseKVTransfer>(
      opts, device_, &kv_caches_, compute_stream_.get());
}

// step 里：命中本地池的 block → H2D；evict 的 block → D2H
// 在 worker_impl.cpp:1087 附近（原 hierarchy set_layer_synchronizer 处）
if (native_layerwise_transfer_ != nullptr) {
  auto need_load = collect_blocks_in_host_pool(input);     // 命中判断
  if (!need_load.empty()) {
    auto bid = native_layerwise_transfer_->load_kv_blocks_async(std::move(need_load));
    native_layerwise_transfer_->install_layer_gate(bid, input.input_params);
  }
  auto need_offload = collect_blocks_to_evict(input);
  if (!need_offload.empty()) {
    native_layerwise_transfer_->offload_kv_blocks_async(std::move(need_offload));
  }
}
```

---

## 4. 数据流与时序

### 4.1 H2D load + forward overlap

```text
时间轴 →

copy_stream:   ┌─scatter L0─┐─scatter L1─┐─scatter L2─┐ ...
               └─record e0   └─record e1   └─record e2
                              (aclrtMemcpyBatch on copy_stream)
compute_stream:                 wait e0 ┌─attn L0─┐ wait e1 ┌─attn L1─┐ ...
                                         (device-side aclrtStreamWaitEvent)
CPU 主线程:     load_kv_blocks_async() 立即返回 batch_id（非阻塞）
                install_layer_gate() 把 gate 塞进 params
                forward() 内部逐层 synchronize_layer(i) → device wait
```

关键点：`load_kv_blocks_async` 在 forward **之前**调用，但拷贝在 copy_stream 异步进行；
forward 跑到第 i 层时，`synchronize_layer(i)` 触发 `compute_stream.wait(e_i)`，
设备侧保证 L_i 的 H2D 已完成。**CPU 主线程全程不阻塞**（这是相对 Hierarchy 原实现的核心改进）。

### 4.2 D2H offload + forward overlap

```text
copy_stream(offload):   wait compute_event[i] ┌─gather L_i─┐ record d2h_event[i]
compute_stream:         ... ┌─attn L_i─┐ record compute_event[i] ...
```
D2H 必须等该层 attention 写完 KV 才能搬，所以 offload 线程在拷 L_i 前
`aclrtStreamWaitEvent(offload_stream, compute_event[i])`。compute_event 由 model loop
在每层后 record（需要方式 1 的扩展，或复用现有 `layer_synchronizer` 的 record 机制）。

---

## 5. 配置项

新增 gflag（`xllm.cpp` 的 flag 区块 + `LoadConfig`）：

| flag | 默认 | 含义 |
|------|------|------|
| `enable_native_layerwise` | false | 总开关 |
| `host_blocks_factor` | 0.0 | CPU 池容量 / GPU 池容量 |
| `layers_per_copy_batch` | 1 | 每次 memcpy 合并几层（>1 减少 launch，增大单次等待粒度） |

---

## 6. P0 验收清单（最小闭环）

**P0 目标：证明 device-side 逐层 overlap 在本机 NPU↔CPU 上成立，且正确性无误。**

1. **block→block memcpy 正确性**
   - 构造已知 KV（每层每 block 填特定 pattern）
   - D2H 搬到 CPU 池 → 改 NPU 原值 → H2D 搬回 → 逐字节比对
   - 覆盖 MHA（K+V）与 MLA（若有）
2. **event overlap 正确性**
   - 在 copy_stream 和 compute_stream 各跑负载
   - 用 `aclrtStreamWaitEvent` 做依赖，验证不出现"compute 读到未完成的 H2D"
3. **端到端：prefill 后 offload、重排后 load 命中**
   - 同一请求二次到达（prefix 命中），load 命中的 block，forward 结果与不 offload 一致
4. **性能**：对比"不开 layerwise（全显存）"vs "开 layerwise offload+load"，量 overlap 收益

**P0 不包含**：跨节点、KVCacheStore（SSD/etcd）、prefix hash 匹配算法、AclGraph 兼容。

---

## 7. 风险与开放问题

| 风险 | 说明 | 处置 |
|------|------|------|
| `aclrtMemcpyBatch` 同步语义 | 即使放 copy stream，单次 batch 内是阻塞的 | P0 用方式 (a)（stream 隔离换 overlap）；profile 后视情况降级为逐 block `aclrtMemcpyAsync` |
| device-side gate 与 AclGraph 互斥 | AclGraph capture 区禁 host-sync；但本路径只在 eager/decode 跑（graph 路径不设 gate），与现有 layerwise 一致 | 文档注明"开启本特性时 decode 走 eager"；prefill 本就走 eager，不受影响 |
| CPU pinned 池容量管理 | `host_blocks_factor` 决定池大小，evict 策略未定 | P0 用简单 LRU 或定长环形；prefix 匹配算法留 P1 |
| `compute_event` record 改动 | D2H overlap 需 model loop 每层后 record compute_event；现有 `layer_synchronizer` 的 record 是给 PUSH 用的，需确认能否复用 | P0 可先让 D2H 不 overlap（forward 完再整体 offload），只把 H2D overlap 做透 |
| block-manager 重构依赖 | 本方案新建独立类，不解禁 Hierarchy，理论上不受影响 | 需确认 `BlockTransferInfo` / `KVCache` API 在重构中稳定 |

### 开放问题（需用户/后续确认）

1. **CPU 池的 block 匹配用什么 key？** token 序列 hash（prefix cache 式）还是直接 block_id？
   前者支持跨请求复用，后者只支持同请求 evict/load。P0 可只做 block_id（同请求），P1 上 hash。
2. **`layers_per_copy_batch` 默认值？** 1 = 最细粒度 overlap（event 最多）；num_layers = 退化为一次性拷。
   需实测最佳值。
3. **D2H overlap 是否 P0 必需？** 若 evict 发生在请求结束后（非热路径），可不做 overlap，简化 P0。

---

## 8. 后续演进路径（明确不在此方案内）

- **P1**：若 memcpy 成瓶颈 → 引入 lmcache-ascend 的 `batched_fused_single_layer_kv_transfer`，
  把"N 段 H2D memcpy + scatter"融合为单 OpCommand。届时需要处理 chunk token-major ↔ paged 的
  layout 映射（见 `integration-design.md` 方案 B 的 dims 章节）。
- **P2**：CPU 池下沉到 `KVCacheStore`（SSD/etcd），复用 Hierarchy 的 `offload_to_store/load_from_store`。
- **P3**：跨节点 PD 场景，本方案与 Mooncake pull/push 协同（Hierarchy 方案 D 的分层思路）。

**本方案的价值在于：用最小风险、零外部依赖先把"逐层 overlap"这条基础设施打通，为后续所有
KV 传输优化（含 lmcache 算子接入）提供可验证、可 profile 的基线。**
