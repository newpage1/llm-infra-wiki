# 绑定自定义域名

站点目前跑在 `https://newpage1.github.io/llm-infra-wiki/`，由 GitHub Pages 托管。
本文记录换成一个自己的域名（目标形如 `https://<你的域名>/`）需要做什么。

**为什么值得做**：现在是「平台 + 账号 + 仓库名」三段拼出来的地址，
换仓库名、换托管商都会让它失效。绑了域名之后，**链接只跟域名走**，
底下的托管换几次都不用改。

**为什么要套 Cloudflare**：GitHub Pages 的服务器在境外，直连在大陆时快时慢。
Cloudflare 免费档就能缓存静态资源、管 SSL，明显更稳。

---

## 一、买域名

### 选后缀

| 后缀 | 适合 | 注意 |
|---|---|---|
| `.com` | 最通用 | 最不容易被公司/校园网拦；首选 |
| `.wiki` | 语义最贴本项目 | 新顶级域，个别网络会拦 |
| `.dev` | 现代、强制 HTTPS | 稍贵 |
| `.cn` | 国内最便宜 | **必须实名**；以后想上国内 CDN 还要 ICP 备案。绑 GitHub Pages 不需要备案，但多一层约束 |

### 选注册商

- **Cloudflare Registrar** —— 域名和 DNS 在一家，**不用改 NS**，成本价、免费 WHOIS 隐私。
  代价：主要支持**转入**已有域名（新注册支持的 TLD 有限，以其页面为准）。
- **国内：阿里云 / 腾讯云** —— 便宜、实名方便。**买完记得把 NS 改成 Cloudflare 给的两个地址**。
- **海外：Namecheap / Porkbun** —— 不需要实名。

> 国内注册商要求**域名实名认证**，这是硬性的；没实名解析会被暂停。
> 境外注册商没有这个要求。

---

## 二、接 Cloudflare（约 5 分钟）

1. Cloudflare 控制台 → **Add a site** → 输入域名 → 选 **Free** 档。
2. 它会给你两个 NS 地址（形如 `xxx.ns.cloudflare.com`）。
   去注册商后台**把域名的 NS 改成这两个**。生效通常几分钟到几小时。
3. NS 生效后，在 Cloudflare 的 **DNS** 页加一条记录：

   | Type | Name | Content | Proxy |
   |---|---|---|---|
   | `CNAME` | `@`（裸域名）或 `wiki`（子域名） | `newpage1.github.io` | 先设为 **DNS only**（灰云） |

   > Cloudflare 支持裸域名写 CNAME（自动 flatten），所以裸域名和子域名**都只要一条记录**。

4. **先别开代理。** 下面的证书签发要绕过 Cloudflare 直连 GitHub，
   灰云状态最省事；GitHub 侧签发成功后再回来点亮成橙云。

---

## 三、GitHub 侧（这一步交给我）

1. 仓库根目录加一个 `CNAME` 文件，内容**只有一行**：你的域名（不带 `https://`、不带路径）。
2. 推送到 `main`，等 Pages 重新构建。
3. 仓库 Settings → Pages → **Custom domain** 填域名 → 勾 **Enforce HTTPS**。
   GitHub 会自动签 Let's Encrypt 证书，通常几分钟到半小时。

---

## 四、回到 Cloudflare 开代理

1. 把那条 CNAME 的云朵点亮（**Proxied**）。
2. **SSL/TLS 模式必须选 Full（或 Full strict）。**

> ⚠️ **两个经典坑**
>
> **① 选 Flexible 会无限重定向。**
> Flexible 是「Cloudflare 用 HTTP 回源」，而 GitHub Pages 强制跳 HTTPS，
> 于是两者互相跳，浏览器报 `ERR_TOO_MANY_REDIRECTS`。**必须用 Full。**
>
> **② 代理开着时证书可能签不下来。**
> GitHub 用 HTTP-01 验证域名归属，橙云会挡住它。所以上面第 4 步要**先灰云**，
> 等 GitHub 那边显示证书已签发再点亮。

---

## 五、验证清单

改完之后我会跑一遍这些，确认没有半成品状态：

```bash
# 1. 新域名能打开，且是 200
curl -sI https://<你的域名>/ | head -1

# 2. 全部本地资源都 200（尤其字体和 5 个数据文件）
curl -s https://<你的域名>/ | grep -oE '(href|src)="[^"]+"' | sed 's/.*="//; s/"$//' |
  grep -v '^https\?://' | grep -v '^data:' | sort -u | while read -r p; do
    printf '%s  %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "https://<你的域名>/$p")" "$p"
  done

# 3. 旧地址会 301 跳到新域名
curl -sI https://newpage1.github.io/llm-infra-wiki/ | head -3

# 4. 逐路由渲染一遍，确认没有残留字面量、没有外部资源
#    （用 tools/check_publish.js 的同一套判据，见 CONTRIBUTING.md）
```

---

## 附：当前状态

- 托管：GitHub Pages（`main` 分支根目录，legacy 构建）
- 现网址：<https://newpage1.github.io/llm-infra-wiki/>
- 外部资源依赖：**无**（字体已自托管，见 `tools/fetch_fonts.py`）
- 仓库根**还没有** `CNAME` 文件
