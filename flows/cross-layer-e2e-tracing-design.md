---
title: 跨层端到端追踪设计：把观测契约钉在 vLLM 的两个稳定边界上
author: MadaoRui
date: 2026-08-02
tags: [可观测性, tracing, vLLM, LMCache, Mooncake]
summary: vLLM / LMCache / Mooncake / 调度框架四层各自都有观测，却串不成一条链。这里给出一个不碰上游源码的接法：契约锚在不可变的 vLLM 边界上，上层靠 traceparent 透明接入，下层用 KV connector 包装任意后端。
---
# 跨层端到端追踪设计：vLLM / LMCache / Mooncake / 调度框架

> **核心思想**：把观测契约锚定在**唯一不可变的 vLLM** 的两个稳定边界上,
> 而不是任何可替换组件(lmcache/mooncake/调度器)的内部。上层靠"W3C traceparent
> 注入"契约透明接入,下层靠一个"tracing KV connector wrapper"包装任意后端。
> **vLLM 完全无感,后端随时替换,观测不断**。交付物是一个独立包 + 一组配置,
> 不进任何上游源码树。

---

## 0. 背景：四层各自的观测现状

| 层 | 观测能力 | 关键文件 |
|----|---------|---------|
| **Dynamo**(调度框架,Rust) | Prometheus + 完整 OTel tracing,W3C 跨 NATS/TCP 传播 | `lib/runtime/src/logging.rs`,`lib/llm/src/http/service.rs`(`make_inference_request_span`) |
| **vLLM**(不可变) | Prometheus(`vllm:`)+ OTel tracing,**但 tracer 只在设了 `--otlp-traces-endpoint` 时初始化** | `vllm/tracing/otel.py:60-91`,`vllm/v1/engine/async_llm.py:114-116` |
| **LMCache** | 双栈:v0 in-process Prometheus(`lmcache:`);v1 MP server 完整 OTel + event_bus(`lmcache_mp.` / `lmcache_blend.`) | `lmcache/observability.py`,`lmcache/v1/mp_observability/` |
| **Mooncake**(C++) | yalantinglibs → Prometheus text(port 9003/9100)。**零 tracing** | `mooncake-store/src/master_metric_manager.cpp`,`tent/src/metrics/` |

四层都有各自的指标,但**端到端 trace 在每一跳都断开**,且原因各不相同。

---

## 1. 关键证据：trace 在每一跳为什么断

基于对四个代码库的逐行核查,断点定位如下:

```text
Dynamo (Rust OTel provider,W3C 传播已实现)
   │  context.trace_headers() 把 traceparent 作为 kwarg 传给 vllm ✓
   │  ✗ Gap1: generate() 调用处没有 active span(handler 从不调 context.start_span)
   ▼
vLLM (独立的 Python OTel provider)
   │  收到 trace_headers,本应把 llm_request span 挂为 dynamo 的子 span...
   │  ✗ Gap2: 只有设了 --otlp-traces-endpoint 才初始化 tracer,
   │          而 dynamo 从不设这个 → vllm 的 span 实际是静默 no-op
   ▼
LMCache (MP server 有 OTel tracer;in-process 路径完全没有)
   │  in-process: 零 span,req_id 只是个字符串
   │  MP server: 发 span,但挂在自造的 "request" 根 span 下,
   │            只靠 session_id=request_id 字符串属性关联
   │  ✗ Gap3: ZMQ 协议帧里没有 traceparent
   ▼
Mooncake (C++,coro_rpc,完全没有任何 tracing)
   │  黑盒 — InstrumentedRemoteConnector 只记时延 metric
   │  ✗ Gap4: C++ API 没有 trace context 的注入/提取通道
```

**唯一已经天然贯通三层的关联键是 `request_id`**:
- dynamo 的 `make_inference_request_span` 已盖 `request_id` span 属性
- 它作为参数传进 vllm `engine_client.generate(..., request_id)`,成为 `Request.request_id`
- 流进 lmcache 成为 `req_id` → `IPCCacheServerKey.request_id` → MP server 的 `session_id`

mooncake 是唯一看不到它的层,但可以在 lmcache→mooncake 调用边界处盖上。

---

## 2. 核心设计原则：观测契约锚定在 vLLM

用户约束:**vLLM 是唯一不可变层,其他层都可替换**(调度器可换、缓存可换 lmcache→FlexKV、传输可换 mooncake→NIXL)。

这个约束直接否定了"patch lmcache/mooncake 内部"的做法——一旦换后端,所有 patch 作废,观测全丢。正确原则:

> **观测契约锚定在 vLLM 的两个稳定对外边界上。**

vLLM 只有两个稳定边界,恰好覆盖请求的进和出:

```text
        ┌──────────────────────────────────────────────┐
        │  vLLM (唯一不可变)                            │
        │                                                │
  入口边界│  trace_headers (W3C traceparent)              │出口边界
  ────────│  ← 谁在上面调我,inject 进来我就被追到了      │────────
        │                                                │  KV Connector 协议
        │                                                │  (retrieve / save_kv_layer / wait_for_save)
        └──────────────────────────────────────────────┘
            ▲                                        ▲
            │ 契约:inject traceparent                │ 包装:tracing wrapper
    (dynamo / 任何替换的调度器)               (lmcache / mooncake / 任何替换)
```

- **入口边**:vLLM 已会从 `trace_headers` 提取 W3C traceparent 开子 span。对上层,契约只有一条:调 vLLM 时 inject traceparent。dynamo 已遵守。换任何调度器,只要做这一步,就被透明追到。
- **出口边**:vLLM 通过 KV connector 协议访问缓存层,这是 vLLM 自定义的稳定接口。

"无感"的真正含义:**vLLM 经历的接口完全不变;观测层以 vLLM 预期的形态(plugin + connector)注入;后端替换对 vLLM 和观测层都透明。**

---

## 3. 关键工件:TracingKVConnector wrapper

与其 patch lmcache 内部,不如写**一个** KV connector 包装器:

```python
class TracingKVConnector(KVConnectorBase):
    """实现 vLLM 的 KV connector 协议,内部包装任意真实后端。"""

    def __init__(self, real_connector: KVConnectorBase, tracer):
        self._real = real_connector      # lmcache / mooncake-direct / NIXL / FlexKV...
        self._tracer = tracer

    def get_num_new_matched_tokens(self, request, ...):
        return self._real.get_num_new_matched_tokens(request, ...)

    def save_kv_layer(self, ...):
        with self._tracer.start_as_current_span("kv.save",
                attributes={"request_id": request.req_id}):
            return self._real.save_kv_layer(...)

    # retrieve / wait_for_save / start_load_kv 同理
```

- vLLM 看到的只是一个正常的 KV connector —— **它完全无感**。
- 真正的后端藏在 wrapper 里,随时换。
- **wrapper 是唯一稳定的观测工件**,后端换了它不换,观测不断。
- span 自动挂在 vLLM 当前请求 span 下(同进程、同 contextvar 链),不需要 request_id 后端 join。
- 顺带补上 lmcache 当前返回 None 的 `build_kv_connector_stats` / `build_prom_metrics`(因为 wrapper 本身就是 connector)。

---

## 4. 每层如何做到无感

| 层 | 机制 | 类型 | "无感"的含义 |
|----|------|------|--------------|
| **vLLM**(不可变) | 一次性:`VLLM_PLUGINS=llmtrace` + 一个 entry-point | vLLM 真实扩展点 | vLLM 只看到一个标准 plugin 和标准 connector,不知道它们在做 tracing |
| **上方调度器**(可替换) | 契约:调 vLLM 时 inject traceparent 到 trace_headers | 接口契约 | 任何遵守契约的调度器都被追到;dynamo 已遵守;换调度器不破坏观测 |
| **下方缓存**(可替换) | tracing wrapper 包装真实 connector | 包装器 | 换 lmcache→FlexKV 只换被包装对象,wrapper 不动,观测不断 |
| **传输层**(可替换) | wrapper 在调用传输层处打 span | 包装器 | mooncake 黑盒→wrapper 外面包一层;换自带 OTel 的 NIXL→wrapper 退化为透传 |

### 入口边:自配置 vLLM 的 OTel(Gap2 的优雅修复)

Gap2 说 vLLM 只有设了 `--otlp-traces-endpoint` 才初始化 tracer。但 entry-point plugin 在 **import 时**(早于 engine 初始化)可以设 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 环境变量,vLLM worker tracer init(`otel.py:115`)会读这个变量。

> **待验证**:plugin 加载与 tracer init 的先后顺序。若时序对得上,连 `--otlp-traces-endpoint` 都不用配——plugin 自配置 vLLM 的 OTel。即使时序不对,设一个 flag 也是"用 vLLM 的设计接口",不是修改 vLLM。

### 出口边:后端替换矩阵

| 后端 | wrapper 行为 | 观测粒度 |
|------|-------------|---------|
| LMCache(in-process) | 包装 `LMCacheConnectorV1Impl` | retrieve/store/save 各一个 span |
| LMCache MP server | 包装 `LMCacheMPConnector` | wrapper span + MP server 自己的 `lmcache_mp.*` span(靠 session_id join) |
| Mooncake direct | 包装 mooncake connector | mooncake 内部黑盒,只有包裹 span |
| NIXL(若替换) | 包装 NIXL connector;NIXL 自带 OTel 则透传 | NIXL 内部 span 直接挂上 |
| FlexKV(若替换) | 包装 FlexKV connector | 同上 |

---

## 5. 交付物结构

独立包 `llmtrace`,pip 安装,不进任何上游源码树:

```text
llmtrace/
├── connector/
│   └── tracing_wrapper.py     # TracingKVConnector:包装任意 KV connector
├── vllm_plugin.py             # entry-point "vllm.stat_logger_plugins":
│                              #   ① import 时自配置 OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
│                              #   ② 注册 tracing wrapper(包装真实 connector)
├── ingress.py                 # (可选)给不自带 inject 的调度器用的 traceparent 注入器
└── config.py                  # LLMTRACE_ENABLED,默认关,no-op 优先
```

### 加载方式

- **进程:vllm worker**。`VLLM_PLUGINS=llmtrace` 触发 entry-point。该进程里同时住着 vllm + in-process lmcache + mooncake connector,一个插件覆盖三层。
- **进程:lmcache MP server(若用 MP 拓扑)**。MP server 已有 `MPServerTracingSubscriber` 在 session_id 上发 span,确认 OTLP 开着即可。MP 拓扑下 mooncake 走 L2 adapter,由 storage controller 事件覆盖,已带 session 上下文。

---

## 6. 配置层(零代码,白送的 80/20)

仅靠配置(不改任何代码),就能修复**请求生命周期主干上最大的一处断点**:

| 系统 | 设置 | 修复了什么 |
|------|------|-----------|
| dynamo | `OTEL_EXPORT_ENABLED=1` + `OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4317` | dynamo 已有 OTel,确保导出 |
| **vLLM** | `--otlp-traces-endpoint http://collector:4317`(dynamo 默认不设!) | **关键**:开启 vLLm 自己的 Python OTel provider,trace_headers 往返才真正生效,`llm_request` span 正确挂为 dynamo 子 span(Gap1+Gap2 修复) |
| lmcache MP server | `--enable-tracing --otlp-endpoint http://collector:4317` | MP server 已有 tracer,确保开启;span 已带 `session_id=request_id` |

光这一步:dynamo → vLLM 的请求生命周期(接收/路由/prefill/decode/TTFT/ITL/e2e)就变成一条连贯 trace。

> **注意**:dynamo 同进程里设的是 Rust 全局 OTel provider,vLLM 设的是 Python 自己的 provider。两者独立、各有 BatchSpanProcessor,导到同一 Collector 不冲突;靠 W3C traceparent(经 trace_headers 往返)保持父子关系。设计里明确这一点,避免误以为它们共享 provider。

---

## 7. 关联与后端查询模型

三种部署粒度下的 trace 形态:

**纯 in-process(wrapper 模式,推荐)**:dynamo 根 trace → vllm span(真父子)→ kv.* span(wrapper,真父子)。**单条瀑布**,无需 join。最理想形态。

**MP server 拓扑**:多根,靠 `request_id` 属性 join:
- dynamo 根 trace(`request_id`)+ vllm span(挂在其下)+ kv.* wrapper span(挂在其下)
- lmcache MP 独立根(`session_id`)+ mooncake 包裹 span(`request_id`)

**Collector 侧 OTTL(可选增强)**:用 span-transformer processor,匹配 `attributes["request_id"]`,把 lmcache/mooncake 根 span 的 parent 重写成对应 vllm retrieve/store span → 标准 UI 里变成单条瀑布。关掉也能靠属性查询。

**查询示例**(Jaeger/Tempo):按 `request_id=<id>` 过滤,得到该请求穿越全部 span;或按 `service=lmcache_mp` + `session_id=<id>` 下钻某请求缓存行为。

---

## 8. 失败模式、开销、关闭方式

- **默认关闭**:`LLMTRACE_ENABLED=0` 时,entry-point 注册的 logger 立即 return,wrapper 不包装。零开销。
- **后端降级**:wrapper 包装真实 connector 时,若接口不匹配(后端版本变化),降级为透传不 tracing,不影响请求。
- **mooncake 降级**:若 mooncake store 句柄类型不匹配(不同 fork),wrapper 对该调用只丢 span,不影响请求。
- **OTLP 不可达**:各系统已有 BatchSpanProcessor,导出失败不影响推理路径。
- **采样**:生产建议 dynamo 端 `OTEL_TRACES_SAMPLE_RATIO=0.1` 头采样;request_id 贯通后,同 trace_id 整条采或整条不采,采样不破坏单条 trace 完整性。

---

## 9. 路径对比与选择

| 路径 | 做什么 | 收益 | 代价 |
|------|--------|------|------|
| **A 开灯** | 纯配置:三 OTel 层指向同一 Collector + 补 `--otlp-traces-endpoint` | 零代码,几小时,修复 dynamo↔vllm 主干断点 | 只通 1.5 层,lmcache/mooncake 没缝合 |
| **B 相关键桥(本设计)** | A + 一个独立 bridge 包(本设计特化为 tracing wrapper) | 覆盖全部四层,非侵入,后端可替换,观测不断 | trace 多根靠属性 join(纯 in-process 模式则是单条瀑布) |
| **C 真 W3C 传播** | B + 在有扩展点的边界真正传播 traceparent(ZMQ 帧加 traceparent) | dynamo→vllm→lmcache(MP) 单条统一瀑布 | ZMQ 协议帧改动是最重一处,需版本协商 |

**推荐**:先做路径 A(白送),交付物做成路径 B(本设计),vllm↔lmcache in-process 传播作为高 ROI 增量顺带实现。路径 C 的 ZMQ 帧改动按需再说。

---

## 10. 待确认 / 待验证事项

1. **vLLM plugin 加载时序**:entry-point import 时设 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 是否早于 vLLM worker tracer init(`otel.py:115`)。决定是否能免去 `--otlp-traces-endpoint` 配置。
2. **KV connector wrapper 的注册点**:vLLM 的 connector factory(`vllm/distributed/kv_transfer/kv_connector/factory.py`)如何被 wrapper 拦截——是在 factory 层包装,还是在 connector 实例化后包装。需确认 vLLM 是否允许 plugin 注入自定义 connector 包装逻辑。
3. **部署拓扑**:实际主要用 in-process lmcache 还是 MP server 拓扑。决定第 4/5 节工作量侧重(纯 in-process 是单条瀑布最理想)。
4. **mooncake span 粒度**:黑盒调用只能打包裹 span,内部 RDMA/TCP 细节无法观测——是否可接受,还是需要路径 C 级别的深度。
