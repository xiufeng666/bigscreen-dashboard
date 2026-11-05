# 银河麒麟 / 统信 UOS 部署与测试指南

> 适用于：银河麒麟桌面/服务器 V10（SP1/SP2/SP3）、统信 UOS 20 等国产 Linux。
> 支持 CPU：**x86_64（Intel/AMD）** 与 **aarch64/arm64（飞腾、鲲鹏、麒麟 ARM）**。
> 产品版本：**v1.1.0**；单二进制、纯静态、无需联网、无需安装 Go/Node/数据库。

---

## 一、准备清单

- 麒麟电脑一台（用来跑服务，同时也可以作为大屏显示机）
- 发行文件：`bigscreen-v1.1.0-kylin-uos-linux.tar.gz`（约 13MB，含 x86_64 与 arm64 两个二进制）
  - 如果拿的是全平台包 `bigscreen-v1.1.0-all-platforms.zip`，只用里面的两个 `bigscreen-server_linux_*` 文件即可
- U 盘（或内网文件共享）用于把文件拷到麒麟电脑
- 大屏显示器接在这台麒麟电脑上（或同一局域网内的其它电脑用浏览器访问）

> **重要原则**：不要直接在 U 盘里运行程序（U 盘分区常被挂载为 `noexec`，会报“权限不够/无法执行”）。先把文件拷贝到用户主目录（如 `~/bigscreen`）或 `/opt/bigscreen`。

---

## 二、5 步启动（推荐流程）

### 第 1 步：确认 CPU 架构

在麒麟电脑打开终端（桌面右键 →「在终端中打开」，或快捷键 `Ctrl+Alt+T`）：

```bash
uname -m
```

| 输出 | 应该用的二进制 |
|---|---|
| `x86_64` | `bigscreen-server_linux_amd64` |
| `aarch64` 或 `arm64`（飞腾/鲲鹏） | `bigscreen-server_linux_arm64` |
| `i686` / `armv7l` | 本包暂不包含 32 位版本，请联系交付方补充 |

> 不用记：`start.sh` 会自动检测架构并选择正确的二进制，推荐直接用 `start.sh` 启动。

### 第 2 步：拷贝并解压到主目录

把压缩包拷到麒麟电脑的 `/home/你的用户名/` 下，然后：

```bash
cd ~
tar -xzf bigscreen-v1.1.0-kylin-uos-linux.tar.gz
cd bigscreen-v1.1.0-kylin-uos
ls -l
```

应能看到：
```
bigscreen-server_linux_amd64
bigscreen-server_linux_arm64
start.sh
快速开始-麒麟UOS.txt
docs/
README.md
```

> 如果发行包是 `.zip`：`unzip bigscreen-v1.1.0-all-platforms.zip`（没有 unzip 可用文件管理器右键“提取”）。

### 第 3 步：赋予执行权限

```bash
chmod +x start.sh bigscreen-server_linux_amd64 bigscreen-server_linux_arm64
```

### 第 4 步：启动服务

```bash
./start.sh -port 8080 -data ./data
```

启动成功后会看到类似输出（局域网 IP 每台机器不同）：

```
================================================================
  BigScreen 大屏看板  v1.1.0  (go1.22 linux/arm64)
================================================================
  数据目录 : /home/user/bigscreen-.../data
  编辑密码 : 未启用（局域网内可直接编辑，建议加 -password 设置密码）
  展示大屏 :
    http://192.168.1.50:8080/
  远程编辑 :
    http://192.168.1.50:8080/editor
  本机访问 : http://127.0.0.1:8080/editor
================================================================
  停止服务 : 按 Ctrl+C
```

常用参数：

```bash
# 设置编辑密码（推荐，局域网内其他人需登录才能改看板）
./start.sh -port 8080 -data ./data -password '你的密码'

# 启动后自动打开浏览器显示大屏（需要桌面环境与 xdg-open）
./start.sh -port 8080 -data ./data -open

# 换端口（8080 被占用时）
./start.sh -port 9090 -data ./data
```

**保持这个终端窗口不要关闭**（关闭终端服务就停了；长期使用见第六节开机自启）。

### 第 5 步：浏览器验证

在麒麟电脑本机打开浏览器，访问：

| 地址 | 用途 |
|---|---|
| `http://127.0.0.1:8080/` | 大屏展示页（按 `F11` 全屏上墙；地址加 `?kiosk=1` 隐藏鼠标与控制条） |
| `http://127.0.0.1:8080/editor` | 远程编辑器（拖拽排版、改标题、切主题、远程控制） |

局域网内其它电脑（办公电脑）用启动横幅里的**局域网 IP**访问：

```
http://192.168.x.x:8080/editor
```

如果本机能打开、其它电脑打不开，99% 是防火墙没放行，见第三节。

---

## 三、放行防火墙端口（关键）

麒麟桌面默认可能启用防火墙。先检查：

```bash
sudo firewall-cmd --state        # 输出 running 说明 firewalld 在运行
```

### 情况 A：firewalld（麒麟常见）

```bash
sudo firewall-cmd --zone=public --add-port=8080/tcp --permanent
sudo firewall-cmd --reload
sudo firewall-cmd --list-ports    # 确认看到 8080/tcp
```

### 情况 B：ufw（部分 UOS/Ubuntu 系）

```bash
sudo ufw status
sudo ufw allow 8080/tcp
```

### 情况 C：图形界面（麒麟安全中心）

打开「安全中心 / 麒麟安全中心」→「网络保护」或「防火墙」→ 自定义规则/端口放行 → 添加 TCP `8080` → 允许。

### 情况 D：iptables 兜底（重启后失效）

```bash
sudo iptables -I INPUT -p tcp --dport 8080 -j ACCEPT
```

放行后可在本机确认端口监听：

```bash
ss -lntp | grep 8080
curl http://127.0.0.1:8080/api/health
# 正常返回：{"status":"ok","uptimeSeconds":...,"version":"1.1.0"}
```

> 另外检查两台电脑是否在同一网段；部分企业 WiFi 开了「AP 隔离」也会导致互访失败，可改用有线或请网管放行。

---

## 四、按你的大屏比例设置画布（非 16:9）

服务默认画布是 1920×1080（16:9）。如果你的屏幕是 4:3、3:2、16:10、21:9、竖屏等：

1. 打开 `/editor`（本机或局域网任意电脑）；
2. 点击画布空白处取消选中 → 右侧「看板设置 → 画布尺寸」；
3. 按实际屏幕比例选择预设，或自定义填写，例如：

| 实际屏幕比例 | 建议画布 |
|---|---|
| 4:3 | 1920×1440 或 1600×1200 |
| 3:2 | 1920×1280 |
| 16:10 | 1920×1200 |
| 21:9 | 2560×1080 |
| 竖屏 | 1080×1920 |

4. 保持「按比例缩放现有组件布局」勾选 → 点击「保存发布」；
5. 大屏页面会通过实时连接自动适配，无需刷新。

> 画布比例与屏幕比例一致时画面会完整铺满；不一致时会自动居中留边，留边使用主题背景，不会拉伸或裁切。

---

## 五、验收检查清单（建议照做一遍）

- [ ] `./bigscreen-server_linux_arm64 -version`（或 amd64）输出 `1.1.0`
- [ ] 启动横幅显示本机局域网 URL
- [ ] 本机浏览器打开 `http://127.0.0.1:8080/` 正常显示科技风大屏，时钟在走
- [ ] `/editor` 可打开，修改标题后「保存发布」，大屏标题实时变化
- [ ] 三套主题切换（科技风 / 红色风格 / 节日喜庆）正常
- [ ] 上传一张图片 → 图片组件显示正常（`data/uploads/` 有文件）
- [ ] 在编辑器点「下一屏」/「通知」，大屏实时响应
- [ ] 局域网另一台电脑可打开 `http://麒麟IP:8080/editor`
- [ ] 按实际屏幕比例设置画布后，「铺满 / 无溢出 / 无滚动条」

---

## 六、开机自启（可选，长期使用建议）

若安装在 `/opt/bigscreen`，创建 systemd 服务（把用户名和架构改一下）：

```bash
sudo mkdir -p /opt/bigscreen/data
sudo cp bigscreen-server_linux_amd64 /opt/bigscreen/
sudo cp start.sh /opt/bigscreen/
sudo chown -R $USER:$USER /opt/bigscreen
```

创建 `/etc/systemd/system/bigscreen.service`：

```ini
[Unit]
Description=BigScreen 大屏看板
After=network.target

[Service]
Type=simple
User=你的用户名
WorkingDirectory=/opt/bigscreen
ExecStart=/opt/bigscreen/bigscreen-server_linux_amd64 -port 8080 -data /opt/bigscreen/data -password 你的密码
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bigscreen
sudo systemctl status bigscreen
journalctl -u bigscreen -f     # 实时日志
```

---

## 七、常见问题

| 现象 | 处理 |
|---|---|
| `bash: ./bigscreen-server_linux_am64: 权限不够` | `chmod +x 文件`；并确认不是在 U 盘上运行 |
| `无法执行二进制文件` / `Exec format error` | 架构不匹配：`uname -m` 对照下载正确二进制；ARM 电脑不要用 amd64 |
| 启动后本机打不开 | 看终端是否报端口占用；`ss -lntp \| grep 8080`；换 `-port 9090` |
| 本机能开，局域网其它电脑打不开 | 放行防火墙（第三节）；确认访问的是局域网 IP 不是 127.0.0.1；检查 AP 隔离 |
| `-open` 没有自动弹出浏览器 | 麒麟缺少桌面会话或 `xdg-open`；手动用浏览器打开 `http://127.0.0.1:8080/` |
| 安全中心拦截/应用控制阻止运行 | 麒麟安全中心 → 应用保护/执行控制 → 信任该程序；或终端执行 `sudo setstatus softmode` 临时放宽（测试完可 `sudo setstatus enable` 恢复） |
| 页面还是旧版本/改了不生效 | 前端资源编译在二进制里，换二进制后重启服务；浏览器强制刷新 `Ctrl+F5` |
| 端口被占用 | `ss -lntp \| grep 8080` 找进程；或直接换端口 `-port 9090` |
| 想停止服务 | 前台运行按 `Ctrl+C`；systemd 用 `sudo systemctl stop bigscreen` |
| 数据在哪/怎么备份 | `-data` 目录：`dashboard.json`、`.bak`、`uploads/`；停服务后整目录拷贝即可迁移 |

---

## 八、版本与文件

| 项目 | 说明 |
|---|---|
| 版本 | v1.1.0（`-version` 可查） |
| 二进制 | `bigscreen-server_linux_amd64` / `bigscreen-server_linux_arm64`（静态链接，不依赖 glibc 版本） |
| 启动脚本 | `start.sh`（自动识别架构、自动找二进制） |
| 完整文档 | 全平台发行包或项目仓库中的 `README.md`（含 API、systemd、防火墙、数据备份等） |
| 验收报告 | 全平台发行包或项目仓库中的 `docs/ACCEPTANCE.md` |
| 默认端口 | 8080 |
| 默认无密码 | 建议加 `-password '密码'`；大屏展示页始终免登录 |

如遇到本指南未覆盖的问题，把终端输出、`uname -m`、`uname -r` 和浏览器访问的地址发回来即可排查。
