# dsh-mobile-control · 移动控制

给 DSH 一个轻量的手机入口：本机反向代理 + 设备级配对 + 移动页模块裁剪。隧道（cloudflared / cpolar / frp）不由本插件管理，外部进程把公网域名指到 `127.0.0.1:<端口>` 即可。

## 能力

| 能力 | 说明 |
|---|---|
| 反向代理 | HTTP + WebSocket 全站转发到 DSH 本机 Web，改写 Host/Origin 通过 DSH 的信任栅栏 |
| 设备配对 | 一次性 6 位码（5 分钟有效，错 5 次锁 10 分钟）→ 每设备独立 token → 长期 cookie（400 天滑动续期） |
| 多设备 | 设备列表可单独撤销，撤销即失效；丢一台不影响其他 |
| 模块裁剪 | 只对手机 UA 改写 boot manifest，可按模块关闭，减首屏体积；电脑端不受影响 |
| 管理 | 设置页「移动控制」：开关、端口、公网地址、配对、设备、模块 |

---

# 部署指南：从零到手机能用

整个过程分六步，大约 30 分钟（不含域名解析生效等待）。已经买好域名并托管到 Cloudflare 的，直接从第三步开始。

## 前置条件

- 一台能跑 DSH 的电脑（Windows / macOS / Linux），DSH 已能正常打开。
- 一个自己的域名。Cloudflare Tunnel 要求域名托管在 Cloudflare 上，**免费二级域名（如 `xxx.trycloudflare.com`）每次重启都会变，只能临时用**。
- 不需要公网 IP，不需要在路由器上做端口映射。

---

## 第一步：买一个域名

推荐三个渠道，按省心程度排序：

| 渠道 | 价格参考 | 说明 |
|---|---|---|
| Cloudflare Registrar | 约 $10/年（.com） | 成本价、无续费涨价，但需要先把域名转进来 |
| Namesilo / Porkbun | 约 $10/年 | 支持支付宝/信用卡，注册简单 |
| 阿里云 / 腾讯云 | 约 ¥60–90/年 | 国内备案流程与境外托管无关，买完照样可以托管到 Cloudflare |

买域名时注意两点：

1. **不要买需要备案才能解析的国内主机**——我们只把域名托管到 Cloudflare，不涉及国内服务器。
2. 域名注册后先把 **注册商后台的「域名服务器 / NS」改掉**（下一步会给出 Cloudflare 的两个 NS 地址）。

---

## 第二步：注册 Cloudflare 并托管域名

### 2.1 注册账号

打开 <https://dash.cloudflare.com/sign-up>，用邮箱注册，验证邮件后登录。

### 2.2 添加站点

1. 首页点 **Add a site**（添加站点）。
2. 输入你的域名（例如 `example.com`，不要带 `https://`）。
3. 套餐页**必须选 Free（免费版）**。
   > 踩坑：如果通过 API 建 zone 且没选套餐，zone 会长期停在 `initializing`，Cloudflare 不对该域名应答 DNS 查询，表现为「域名完全解析不了」。在控制台手动选一次 Free 即可修复。
4. 选完后 Cloudflare 会给你两个 NS 地址，形如：
   ```
   ada.ns.cloudflare.com
   bob.ns.cloudflare.com
   ```

### 2.3 修改 NS

回到域名注册商后台，把域名的 NS 改成上面两个地址（删掉原有的 NS）。保存后等待生效。

### 2.4 等激活

回 Cloudflare 的站点概览，状态会从 `Pending` 逐步变成 `Active`。通常几分钟到几小时。

- 状态 `Active` 之前，**后面所有步骤都会失败**（隧道通了也访问不了）。
- 激活后还要等 **Universal SSL 证书签发**（约 15 分钟），期间浏览器可能报 `ERR_SSL_VERSION_OR_CIPHER_MISMATCH`，属于正常现象，等即可。

---

## 第三步：创建 Cloudflare Tunnel

### 3.1 建隧道

1. 进 <https://one.dash.cloudflare.com/>（Zero Trust 控制台）。
2. 左侧 **Networks → Tunnels → Create a tunnel**。
3. 选 **Cloudflared**，起一个名字（例如 `dsh`），保存。
4. 页面会给出**安装命令**，里面带一段很长的 `--token eyJhIjoi...`。**把这串 token 记下来**，后面本机运行要用。

### 3.2 配置公网入口（最容易漏）

在隧道详情页 → **Public Hostname → Add a public hostname**：

| 字段 | 填什么 |
|---|---|
| Subdomain | `dsh`（最终域名就是 `dsh.example.com`） |
| Domain | 选你在第二步添加的域名 |
| Type | `HTTP` |
| URL | `127.0.0.1:3444` |

保存。

> 踩坑：只建隧道、不配 Public Hostname，访问域名会返回 `503`，而隧道状态本身显示 `healthy`，很容易误判成插件问题。

---

## 第四步：在本机运行 cloudflared

### 4.1 下载

- Windows：<https://github.com/cloudflare/cloudflared/releases/latest> 下载 `cloudflared-windows-amd64.exe`，改名 `cloudflared.exe`。
- macOS：`brew install cloudflared`
- Linux：`curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared && chmod +x cloudflared`

### 4.2 前台测试

先用前台模式确认能通（`<TOKEN>` 换成 3.1 拿到的 token）：

```powershell
cloudflared.exe tunnel run --token <TOKEN>
```

看到 `Registered tunnel connection` 四行、且没有报错，说明隧道已连上。此时**先别关窗口**，去做第五步。

### 4.3 装成开机自启服务

前台窗口一关隧道就断，长期使用要装服务：

**Windows（管理员 PowerShell）**

```powershell
cloudflared.exe service install <TOKEN>
# 启动
sc start cloudflared
# 查看状态
sc query cloudflared
```

> 注意：`service install` 在部分 Windows 版本上会报权限不足或者服务起不来。实在装不上，就建一个「任务计划程序」任务，触发器选「登录时」，操作填：
> `cloudflared.exe tunnel run --token <TOKEN>`

**macOS**

```bash
sudo cloudflared service install <TOKEN>
```

**Linux**

```bash
sudo cloudflared service install <TOKEN>
sudo systemctl enable --now cloudflared
```

装好后关掉前台窗口，用 `https://dsh.example.com/mobile-control/health` 验证，返回 `{"ok":true}` 就说明隧道和插件都通了。

---

## 第五步：配置插件

1. DSH 打开 **设置 → 移动控制**。
2. **启用** 开关打开。
3. **监听端口** 填 `3444`（和第三步 Public Hostname 里的 URL 端口一致；改了这里也要改 Cloudflare 那边）。
4. **公网地址** 填 `https://dsh.example.com`（带 `https://`，不要带结尾斜杠）。
   - 从旧版 `dsh-mobile` 升级上来的，插件会自动读旧配置里的域名，通常不用手填。
5. 保存。

---

## 第六步：手机配对

1. 设置页点 **生成配对码**，得到一个 6 位数字（5 分钟内有效）。
2. 手机浏览器打开：
   ```
   https://dsh.example.com/mobile-control/pair?code=123456
   ```
   或者只打开 `https://dsh.example.com`，会提示未配对并给出配对入口。
3. 页面会预填设备名（从浏览器 UA 推断，如 `iPhone`、`Xiaomi 14`），可改。
4. 点 **配对**，成功后自动跳到 DSH 手机页面。

配对一次长期有效（400 天滑动续期）。换手机、卖手机时，回设置页在设备列表里 **撤销**，该设备立即失效。

---

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 域名完全解析不了（`dig` 无结果） | zone 停在 `initializing`，没选套餐 | 控制台 → 该域名 → 选 Free 套餐 |
| 访问返回 `530` / `1033` | 隧道进程没在跑 | 检查 `sc query cloudflared` 或进程列表 |
| 访问返回 `502` / `1033` | 隧道通了但 Public Hostname 没配或端口不对 | 检查隧道 ingress 是否指向 `127.0.0.1:3444` |
| 返回 `503` 且隧道状态 healthy | 同上，缺 ingress | 在 Zero Trust 里补 Public Hostname |
| `ERR_SSL_VERSION_OR_CIPHER_MISMATCH` | Universal SSL 还在签发 | 等 15–30 分钟 |
| 页面能开但一直转圈 | 插件端口和 DSH 实际端口不一致，或 DSH 没启动 | 设置页看「运行中 · 127.0.0.1:端口」是否正常 |
| 手机打开显示「未配对」 | 配对码过期（5 分钟） | 回电脑重新生成 |
| 手机上某个插件不见了 | 在「插件模块」里被取消勾选 | 重新勾选并保存 |
| 电脑上正常、手机白屏 | 模块裁剪把依赖项关掉了 | 「全选」保存，再逐个关 |

---

## 安全说明

- 设备 token 只存在电脑的 `~/.dsh/storages/mobile-control.json`，接口不会回传。
- Cookie 为 `HttpOnly; SameSite=Lax`，HTTPS 下自动加 `Secure`。
- 配对失败 5 次锁 10 分钟，防止暴力猜码。
- 建议长期开启 Cloudflare 的 **Access** 或至少给域名加 WAF 规则；本插件的配对是第二道门，不是唯一一道。
- **隧道一旦通，DNS 泄露类工具（如 `crt.sh` / Certificate Transparency 日志）可能扫到你的子域名。** 未加 Access 时，扫到即可看到登录页并尝试配对；配对锁只防猜码，不防「你已经把页面暴露在公网」这件事。长期不用时建议停掉 `cloudflared` 进程，而不是只关插件开关。
- **Host/Origin 校验只对本机回环请求生效**：来自隧道的请求 Host 是公网域名，插件按约定放行（否则手机端根本进不来）；真正的访问控制依赖配对 token + Cloudflare Access。

---

## 配置参考

```yaml
- id: mobile-control
  name: '@local/dsh-mobile-control'
  config:
    port: 3444      # 监听端口，默认 3444
```

状态文件：`~/.dsh/storages/mobile-control.json`（设备 token、端口、公网地址、模块排除项）。

## 与 dsh-mobile 的关系

本插件是它的精简替代：保留代理、配对、模块裁剪，去掉隧道管理、自建 CA、移动端 UI 重构、扩展系统。两者不要同时启用（都占端口、都改写上游认证）。

## 测试

```powershell
npm test        # 宿主侧 10 项 + 热重载 3 项
```

## License

MIT
