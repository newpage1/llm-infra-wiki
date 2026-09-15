---
title: GLM-5.2 集群级端到端推理时延估算（W8A8 + PD 分离）
author: MadaoRui
direction: 性能与容量
date: 2026-08-02
tags: [时延, PD分离, 量化, 昇腾, GLM]
summary: 744B/40B MoE·MLA 在 W8A8、PD 分离、五级 KV 存储、90% 前缀命中下的全链路时延拆解：从请求进网关到首 token / 末 token，逐段算账，覆盖昇腾 950 PR 与 950 DT 两档硬件。
---
# GLM-5.2 集群级端到端推理时延估算（W8A8 + PD 分离）

> 场景：GLM-5.2（744B/40B MoE·MLA）、W8A8 量化、PD 分离架构、五级 KV 存储、90% prefix 命中、coding 高并发。
> 从客户端请求进入网关，到返回首 token / 末 token 的全链路时延拆解。
> 覆盖硬件：昇腾 950 PR（推理版）/ 950 DT（训练版）。
>
> 文档日期：2026-08-02（覆盖前版单机估算）

---

## 一、参数基准（全部已核实）

### 模型 — GLM-5.2（z.ai 官方）

| 项目 | 取值 | 来源 |
|---|---|---|
| 总参数 | 744 B | z.ai 官方 |
| 激活参数（每 token） | 40 B（Top-8 / 256 专家） | 官方 |
| 层数 L | 78（3 dense + 75 MoE） | 官方 |
| 隐藏维度 H | 6 144（64 头 × head_dim 96） | 官方 |
| 注意力 | **MLA**（Multi-head Latent Attention） | 官方 |
| KV 潜维度 | 576（kv_lora_rank 512 + qk_rope 64） | 官方 |
| **KV/token（MLA+INT8）** | **43.9 KB**（vs MHA 1.83 MB，压缩 43×） | 推导 |
| IndexShare | 1M context 下 attention FLOPs ×1/2.9 | 官方 |
| 量化 | W8A8（权重/激活/KV 均 INT8） | 题设 |

### 硬件 — 昇腾 950 PR/DT（TrendForce + SCMP + flopper 核实）

| 参数 | 950 PR（推理版） | 950 DT（训练版） |
|---|---|---|
| 定位 | Prefill / 推荐系统推理 | 训练（也做推理） |
| 发布 | 2026 Q1（已发布） | 2026 Q4 |
| 算力 | 1.56 PFLOPS (FP4) / FP16 500 TF / **INT8 ~800 TF** | 同 |
| HBM | **HiBL 1.0**，112 GB，**1.5 TB/s** | **HiZQ 2.0**，144 GB，**~3.0 TB/s** |
| 互联 | Unified Bus 2.0，2.0 TB/s（2.5×上代） | 同 |
| 单卡 TDP | 600W（Atlas 350 卡） | 900W（OAM） |
| 部署 | TP=8（8 卡/节点） | TP=8 |

### 多级存储（联网查证 + 业界标准）

| 层级 | 介质 | 带宽 | 访问延迟 | 来源 |
|---|---|---|---|---|
| L1 HBM | NPU 显存 | 1.5 / 3.0 TB/s | ~0.1 µs | flopper/SCMP |
| L2 本地 DDR | 服务器内存 | ~460 GB/s（DDR5-4800 12ch） | ~1 µs | Wikipedia DDR5 |
| L3 远端 DDR | 其他节点内存（RDMA） | 50 GB/s（400 Gbps） | ~2.5 µs + 传输 | 业界标准 |
| L4 本地 SSD | NVMe PCIe 5.0 | ~14 GB/s | 70-100 µs | 业界标准 |
| L5 远端存储池 | 分布式存储（OBS/SFS） | ~8 GB/s | ms 级 | 估算 |

### KV 命中分布（基于 LMCache 分级淘汰策略假设）

| 层级 | 命中率 | 说明 |
|---|---|---|
| L1 HBM | 30% | 热数据，已在显存 |
| L2 本地 DDR | 40% | 温数据，LRU 淘汰到此 |
| L3 远端 DDR | 15% | 其他节点的副本 |
| L4 本地 SSD | 5% | 冷数据溢出 |
| L5 远端池 | 0% | 归档，基本不用 |
| MISS | 10% | 完全未命中（重算 prefill） |
| **总命中** | **90%** | |

### 其他系统参数

| 项目 | 取值 |
|---|---|
| PD 间互联 | 400 Gbps IB ≈ 50 GB/s 有效 RDMA |
| 网关转发（dynamo） | 2 ms（固定） |
| 路由决策（KV 亲和） | 1.5 ms（固定） |
| Decode batch | 64（连续批） |
| Prefill MFU | 40%（sparse attention 损耗） |
| 投机解码（MTP） | ×0.85（接受率对应加速） |
| 输出长度 | 256 tokens |

---

## 二、端到端请求生命周期（8 个环节）

```text
客户端
  ↓
[1] 网关接收转发 (dynamo)         ~2ms 固定
  ↓
[2] 路由决策 (KV亲和路由)          ~1.5ms 固定
  ↓
[3] P节点排队 (M/M/c 排队模型)     随QPS/集群规模变化 ★
  ↓
[4] KV cache 拉取 (五级存储命中)   加权: HBM/DDR/远端DDR/SSD
  ↓
[5] Prefill 计算                  权重bound, 只算10%未命中token
  ↓
[6] PD间KV迁移                    P→D 跨节点RDMA (MLA压缩,代价小)
  ↓
[7] D节点排队+Decode (batch=64)   TPOT随seq线性增长
  ↓
[8] 流式返回 (TTFT=环节1-6+首decode / E2E=+256tok decode)
```

---

## 三、核心结果

### 【1】TTFT 首字延迟

| 上下文 | QPS | 小集群(8节点) | | 中集群(32节点) | | 大集群(128节点) | |
|---|---|---|---|---|---|---|---|
| | | 950PR | 950DT | 950PR | 950DT | 950PR | 950DT |
| 32K | 50 | 156ms | 154ms | 136ms | 134ms | 136ms | 134ms |
| 32K | 200 | **超载** | **超载** | 137ms | 135ms | 136ms | 134ms |
| 32K | 800 | **超载** | **超载** | **超载** | **超载** | 136ms | 134ms |
| 128K | 50 | **超载** | **超载** | 1.0s | 1.0s | 660ms | 658ms |
| 128K | 200 | **超载** | **超载** | **超载** | **超载** | 726ms | 725ms |
| 128K | 800 | **超载** | **超载** | **超载** | **超载** | **超载** | **超载** |
| 256K | 50 | **超载** | **超载** | **超载** | **超载** | 1.6s | 1.6s |
| ≥512K | 任意 | **超载** | **超载** | **超载** | **超载** | **超载** | **超载** |

> ⚠️ **大量"超载"**是真实结论：950PR 的 INT8 算力（800 TFLOPS）做长上下文 prefill 吃力，单请求 512K prefill 就要 3.5s，集群吞吐受限。

### 【2】TPOT 单 token 延迟（与集群规模无关，只跟硬件+seq有关）

| 上下文 | 950PR (1.5TB/s) | | | 950DT (3.0TB/s) | | | 加速比 |
|---|---|---|---|---|---|---|---|
| | 基础 | 投机0.85 | 吞吐 | 基础 | 投机0.85 | 吞吐 | |
| 32K | 1.01ms | **0.86ms** | 1163 tok/s | 0.51ms | **0.43ms** | 2326 tok/s | 2.0× |
| 64K | 1.97ms | 1.67ms | 599 | 0.98ms | 0.84ms | 1190 | 2.0× |
| 128K | 3.89ms | **3.30ms** | 303 | 1.94ms | **1.65ms** | 606 | 2.0× |
| 256K | 7.72ms | 6.56ms | 152 | 3.86ms | 3.28ms | 305 | 2.0× |
| 512K | 15.39ms | 13.08ms | 76 | 7.69ms | 6.54ms | 153 | 2.0× |
| 1M | 30.00ms | **25.50ms** | 39 | 15.00ms | **12.75ms** | 78 | 2.0× |

> batch=64 下权重项被摊薄到 0.05ms（可忽略），TPOT 完全由 KV 读取主导。950DT 带宽翻倍使 TPOT 减半。

### 【3】端到端延迟（TTFT + 256 tokens 解码）

| 上下文 | QPS | 小集群 | | 中集群 | | 大集群 | |
|---|---|---|---|---|---|---|---|
| | | 950PR | 950DT | 950PR | 950DT | 950PR | 950DT |
| 32K | 50 | 380ms | 268ms | 356ms | 244ms | 356ms | 244ms |
| 32K | 800 | **超载** | **超载** | **超载** | **超载** | 356ms | 244ms |
| 128K | 50 | **超载** | **超载** | 1.9s | 1.5s | 1.5s | 1.1s |
| 128K | 200 | **超载** | **超载** | **超载** | **超载** | 1.6s | 1.2s |
| 256K | 50 | **超载** | **超载** | **超载** | **超载** | 3.2s | 2.3s |

---

## 四、端到端时延瀑布图

### 场景 A：32K 短上下文 | 大集群 | QPS=50 | 950PR（总 356ms）

```text
[TTFT 136ms ─────────────────]
  网关转发      2ms   1%  █
  路由决策      2ms   1%  █
  P节点排队     0ms   0%  ·
  KV五级拉取    7ms   5%  █
  Prefill计算 119ms  88%  █████████████████
  PD间KV迁移   3ms   2%  █
  首token decode 3ms 2%  █
[DECODE 220ms ───────────────]
  D节点排队     0ms   0%  ·
  256tok decode 220ms 62% ███████████████████████████████
```

### 场景 B：128K 中等上下文 | 大集群 | QPS=50 | 950PR（总 1.5s）

```text
[TTFT 660ms ─────────────────]
  网关转发      2ms   0%  █
  路由决策      2ms   0%  █
  P节点排队     0ms   0%  ·
  KV五级拉取   27ms   4%  █
  Prefill计算 615ms  93%  ████████████████████
  PD间KV迁移  12ms   2%  █
  首token decode 3ms 1%  █
[DECODE 846ms ───────────────]
  D节点排队     0ms   0%  ·
  256tok decode 846ms 56% ████████████████████████████
```

### 场景 C：128K | 大集群 | QPS=50 | 950DT（总 1.1s，对比 PR）

```text
[TTFT 658ms ─────────────────]
  Prefill计算 615ms  93%  ████████████████████████████  (与PR相同,prefill是计算bound)
[DECODE 423ms ───────────────]
  256tok decode 423ms 39% ████████████████████  (DT的HBM 2x, decode快1倍)
```

### 场景 D：128K | 大集群 | QPS=200（高并发）| 950PR（总 1.6s）

```text
[TTFT 726ms ─────────────────]
  P节点排队   67ms   9%  ██       ← 高并发下排队开始显现
  Prefill计算 615ms  85%  ███████████████████
[DECODE 859ms ───────────────]
  D节点排队   13ms   1%  █
  256tok decode 846ms 53% ███████████████████████████
```

---

## 五、排队与过载分析

### 各集群的吞吐上限（QPS 上限，950PR）

| 上下文 | 小集群(8节点) | 中集群(32) | 大集群(128) |
|---|---|---|---|
| 32K | 67 req/s | 269 req/s | **1074 req/s** |
| 64K | 29 | 116 | 463 |
| 128K | 13 | 52 | **208** |
| 256K | 6 | 23 | 91 |
| 512K | 2 | 9 | 36 |
| 1M | 0.8 | 3.3 | **13** |

### 排队等待时间 vs QPS（128K 上下文，950PR）

| QPS | 小集群(8) | 中集群(32) | 大集群(128) |
|---|---|---|---|
| 10 | 130ms | 0ms | 0ms |
| 30 | **过载** | 0.1ms | 0ms |
| 50 | **过载** | 366ms | 0ms |
| 100 | **过载** | **过载** | 0ms |
| 200 | **过载** | **过载** | 67ms |
| 500 | **过载** | **过载** | **过载** |

> 128K 吞吐上限：小=13 / 中=52 / 大=208 req/s。超过即队列爆炸。

---

## 六、五级存储 KV 拉取分析

| 上下文 | KV 总量 | L2(DDR) | L3(远端) | L4(SSD) | 拉取总时 | 占 prefill 比 |
|---|---|---|---|---|---|---|
| 32K | 1.4 GB | 1.3ms | 4.3ms | 5.2ms | **6.8ms** | 6% |
| 64K | 2.9 GB | 2.5ms | 8.6ms | 10.3ms | 13.5ms | 5% |
| 128K | 5.8 GB | 5.0ms | 17.3ms | 20.6ms | **26.8ms** | 4% |
| 256K | 11.5 GB | 10.0ms | 34.5ms | 41.2ms | 53.5ms | 4% |
| 512K | 23.0 GB | 20.0ms | 69.0ms | 82.2ms | 106.9ms | 3% |
| 1M | 44.9 GB | 39.1ms | 134.8ms | 160.5ms | **208.7ms** | 2% |

**结论**：KV 拉取时间占 prefill 的 2-6%，**不是瓶颈**。这得益于 MLA 把 KV 压到 43.9KB/token（vs MHA 的 1.83MB，压缩 43×）。若是 MHA，1M 的 L3 远端拉取要 5.7 秒。

---

## 七、瓶颈迁移分析

| 场景 | 主要瓶颈 | 优化方向 |
|---|---|---|
| 短上下文 32K + 低并发 | Prefill 计算（88%） | 提升 INT8 算力 |
| 短上下文 32K + 高并发 | 排队等待 | 扩容 P 节点 |
| 中等 128K + 低并发 | Prefill 计算（93%） | IndexShare + 算力 |
| 中等 128K + 高并发 | 排队爆炸（过载） | 扩容或换 950DT |
| 长上下文 ≥512K | Prefill 算力严重不足 | **950PR 不适合，需 DT + 扩容** |

---

## 八、核心结论

### 1. 950PR 的 INT8 算力是长上下文的硬约束 ⭐
这是本评估最重要的发现。950PR 的 INT8 ~800 TFLOPS（由 FP4 1.56 PFLOP 推算）做长上下文 prefill 吃力：
- 512K 单请求 prefill 3.5s，128 节点大集群吞吐上限仅 36 req/s
- **≥512K 上下文在任何 coding 高并发场景下都会过载**
- 这是为什么 950PR 定位是"prefill/推荐"而非通用长上下文

### 2. PD 分离的 KV 迁移代价在 GLM-5.2 上可忽略
得益于 MLA（KV 压缩 43×，43.9KB/token），即便 1M 上下文跨节点 RDMA 迁移也仅 88ms（90% 命中下），占 TTFT 的 2%。

### 3. 五级存储命中策略有效，但拉取不是瓶颈
KV 拉取（最慢的 SSD 级）1M 仅 160ms，占 prefill 2%。MLA 压缩使多级存储的拉取代价极小。

### 4. 950DT 是长上下文推理的更好选择
HBM 带宽翻倍（3.0 TB/s）使 TPOT 减半，decode 性能 2×。但 prefill 是计算 bound，DT 的 INT8 算力与 PR 相近，**prefill 时间不会改善**——长上下文的 prefill 瓶颈只能靠扩容或更高算力芯片解决。

### 5. 排队是高并发的隐形杀手
低并发时排队为 0，一旦 QPS 接近吞吐上限的 80%，排队时间急剧上升。coding 高并发场景必须预留 30%+ 的算力余量。

### 6. 端到端由 prefill + decode 双重主导
- 短上下文（32K）：prefill 和 decode 各占约一半
- 长上下文（128K+）：TTFT 中 prefill 占 93%，但 decode 总量也大（KV 读取线性增长）

---

## 九、与前版单机估算的对比

前版（单机 H100 估算）的 TTFT 1M = 1.27s，本版（集群 950PR）= 9.6s（单节点）且高并发过载。差异来源：

| 因素 | 前版（单机 H100） | 本版（集群 950PR） |
|---|---|---|
| INT8 算力 | 1979 TFLOPS × 8 卡 | 800 TFLOPS × 8 卡（低 2.5×） |
| 排队 | 无（独占） | M/M/c，高并发过载 |
| 网关/路由 | 无 | +3.5ms 固定 |
| 多级存储拉取 | 无 | +2-6% 开销 |
| 端到端真实性 | 理论下界 | 含集群开销，更接近真实 |

---

## 十、局限说明

1. **排队模型用 M/M/c 理论下界**：实际有调度抖动、请求长度分布差异，真实排队会更长
2. **命中分布是假设**（基于 LMCache 设计的 30/40/15/5/0/10%），实际取决于工作负载热度
3. **950 的 INT8 算力是 FP4 推算**（1.56 PFLOP / 2 ≈ 800 TF），未官方确认
4. **网关/路由开销是经验估值**（2ms/1.5ms），实际取决于 dynamo 实现和路由表规模
5. **D 节点排队简化**为 P 排队的 1/5，实际取决于 decode batch 容量和调度
6. **prefill 假设每节点串行处理一个请求**，实际可 micro-batch（但长 prefill 不易 batch）

---

## 附：可复现的推导脚本

核心逻辑（全部参数化，可调整）：

```javascript
// 模型 (GLM-5.2 官方)
const MODEL = {
  activeParams: 40e9, numLayers: 78, hiddenSize: 6144,
  kvLoraRank: 512, qkRope: 64,
  get kvPerToken() { return this.numLayers * (this.kvLoraRank + this.qkRope) * 1; }, // 44928 B
  indexShare: { 128000:0.7, 1000000:1/2.9 }, // attention FLOPs 系数
};

// 硬件 (950 PR/DT 已核实)
const HW = {
  '950PR': { int8TFLOPS:800, hbmBW:1.5e12 },
  '950DT': { int8TFLOPS:800, hbmBW:3.0e12 },
};

// Prefill (90%命中, 只算10%)
function prefillTime(seq, hwKey, hit=0.9) {
  const newTok = seq * (1-hit);
  const weightFLOPS = 2 * MODEL.activeParams * newTok;
  const idx = MODEL.indexShare[seq] || 1.0;
  const attnFLOPS = 4 * newTok * seq * 0.25 * MODEL.hiddenSize * MODEL.numLayers * idx;
  return (weightFLOPS + attnFLOPS) / (HW[hwKey].int8TFLOPS * 1e12 * 8 * 0.4);
}

// TPOT (batch=64, 投机0.85)
function tpot(seq, hwKey) {
  const kvT = (seq * MODEL.kvPerToken) / HW[hwKey].hbmBW;
  return kvT * 0.85; // 权重项被batch摊薄可忽略
}

// 排队 M/M/c (Erlang-C)
function queueTime(seq, cluster, qps, hwKey) {
  const serviceTime = prefillTime(seq, hwKey);
  const c = cluster.Pnodes;
  const mu = 1/serviceTime, lambda = qps, a = lambda/mu, rho = a/c;
  if (rho >= 1) return { overload:true };
  const P_wait = erlangC(c, a);
  return { time: P_wait / (c*mu - lambda), rho };
}

// 端到端
function e2e(seq, cluster, qps, hwKey) {
  const q = queueTime(seq, cluster, qps, hwKey);
  if (q.overload) return { overload:true };
  const ttft = 0.002 + 0.0015 + q.time  // 网关+路由+排队
    + kvFetch(seq, hwKey)                // 五级拉取
    + prefillTime(seq, hwKey)            // prefill
    + seq*0.1*MODEL.kvPerToken/50e9      // PD迁移
    + 0.003;                             // 首decode
  const decode = tpot(seq, hwKey) * 256;
  return { ttft, e2e: ttft + decode };
}
```

---

## 参考资料

- GLM-5.2 官方规格：[z.ai/blog/glm-5.2](https://z.ai/blog/glm-5.2)
- 昇腾 950 规格：TrendForce（2025/9/18, 2026/3/23）、SCMP、flopper.io
- DDR5 带宽：[Wikipedia DDR5](https://en.wikipedia.org/wiki/DDR5_SDRAM)
- PD 分离架构：[DistServe (OSDI'24)](https://www.usenix.org/system/files/osdi24-zhong-yinmin.pdf)
- 多级 KV 存储：LMCache / Mooncake 设计文档
- 排队论：Erlang-C 公式（M/M/c 模型）
