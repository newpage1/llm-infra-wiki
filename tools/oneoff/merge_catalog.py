#!/usr/bin/env python3
# catalog.js：把 mooncake-te（L3）与 mooncake-store（L4）合成一个 mooncake（L4）。
# 用户要求：KV 传输只留真正做传输的组件；Mooncake 作为整体归 KV 存储。
P = 'data/catalog.js'
s = open(P).read()

def span(cid):
    m = s.index("  {\n    id: '" + cid + "'")
    i = s.index('{', m); depth = 0
    for n in range(i, len(s)):
        if s[n] == '{': depth += 1
        elif s[n] == '}':
            depth -= 1
            if depth == 0: break
    end = n + 1
    while end < len(s) and s[end] in ' \n': end += 1
    if end < len(s) and s[end] == ',': end += 1
    if end < len(s) and s[end] == '\n': end += 1
    return m, end

MERGED = """  {
    id: 'mooncake', name: 'Mooncake', primary: 'storage', runs: ['nvidia', 'ascend'], port: 'neutral',
    portNote: "已有 mooncake-transfer-engine-npu wheel 与 AscendDirectTransport，昇腾是主线支持的一等路径。",
    org: 'Moonshot AI / 清华', repo: 'https://github.com/kvcache-ai/Mooncake',
    lang: 'C++ / Python',
    role: '分布式 KV 池（对象层）+ 自带的零拷贝传输引擎（字节层）：上层认 key，下层只认地址',
    status: 'deep',
    highlights: [
      "**一个仓库两层，分界很干净**：上层 Store 认 %%key%% 与副本，下层 Transfer Engine 只认 %%(地址, 长度)%%——**字节全部由下层搬，Store 自己一行都不搬**",
      "**master 不碰数据**：只维护对象元数据与地址账本，数据由 client 与 client 之间用 TE 直传",
      "**镜像分配**：地址分配器跑在 master，内存物理上在 client——master 做纯地址运算，因此能全局统筹配额又不必搬数据",
      "**不可变对象 + 5s 租约读**：KV 是只写一次、读多次、且**读错了可以重算**的数据，所以不需要强一致，但需要租约防「读一半被淘汰」",
      "**%%protocol%% 参数是昇腾关键**：它**同时**选择内存分配器与传输实现；%%protocol=\\"ascend\\"%% 会经 %%ascend_allocate_memory%% 分配 NPU 内存并装上升腾 transport",
      "**1024 个哈希分片**元数据，每片一把 shared_mutex——单全局锁在这个规模下必然成为瓶颈",
      "**淘汰复用租约信息**：「租约时间近似 LRU」零额外成本拿到近似效果；hard-pin 永不淘汰、soft-pin 30 分钟保护",
      "**dummy-real 分离**解决多 rank 抢资源：推理进程内每个 TP rank 一个轻量代理，共享同机一个 real client 的网卡与内存",
      "**传输内核 + 建在内核上的三层服务**：Store 只是其中最厚的一层，另有 p2p-store / pg / ep",
      "**控制面与数据面分离**是贯穿全仓库的第一原则：小消息走控制通道协商出「句柄」，大数据凭句柄直连；数据面终点是 %%ibv_post_send%% 单边 RDMA，对端 CPU 零参与",
      "**13+ 种 Transport**：RDMA / TCP / NVMe-oF / CXL / NVLink / EFA / UB / 昇腾……链路可插拔是它能在两套生态都落地的前提",
      "**双向选网卡是独门设计**：提交时在本地拓扑为 source 选网卡，worker 下发时又在**对端发布的拓扑副本**上为 dest 选网卡，两侧共同决定 %%peer_nic_path%%",
      "**重试次数本身驱动降级**：%%retry_cnt%% 直接喂给 %%selectDevice%% 依序遍历 preferred→avail，不需要额外状态机",
      "**四级摊薄单点队列**：MultiTransport 按协议 → RdmaTransport 按 NIC → WorkerPool 按 8 shard → EndPoint 按多 QP",
      "**%%BatchID%% 就是 %%BatchDesc*%% 指针的整数重解释**——绕过 map 查找的热路径优化，代价是调用方必须保证 batch 生命周期"
    ]
  },
"""

# ① 先删 L3 的 mooncake-te（在文件中靠前）
a, b = span('mooncake-te')
assert 'mooncake-te' in s[a:a+60], s[a:a+60]
s = s[:a] + s[b:]

# ② 再把 L4 的 mooncake-store 整块换成合并条目
a, b = span('mooncake-store')
assert 'mooncake-store' in s[a:a+60], s[a:a+60]
s = s[:a] + MERGED + s[b:]

open(P, 'w').write(s)
print('已合并 catalog.js')
