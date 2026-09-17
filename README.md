# 101实时通知

> 单房间、单向推送、被动展示的**厨房通知屏**。
> 在外的人用手机编辑并推送，厨房里横放的 Android 设备零操作地醒目显示。

本项目按一份内部产品需求文档（PRD v1.0）实现。文中出现的「PRD 4.1」「PRD 4.2」等
是该文档的条目编号，用于说明每条规则的出处。

---

## 1. 技术栈与结构

| 层 | 选型 |
|---|---|
| 服务端 | Node.js 20+ / Express 4（单进程，无数据库） |
| 前端 | 原生 HTML / CSS / JS（无构建步骤，无框架） |
| 持久化 | 每个房间一个目录，JSON 文件 + 原子写入（临时文件 → fsync → rename） |
| 交付 | 单一 Docker 镜像，数据目录 `/data` 通过卷映射持久化 |

```
.
├── Dockerfile
├── docker-compose.yml
├── package.json
├── src
│   ├── config.js      全局参数（房间长度/字符集、6h 回收、3s 丢弃窗口、字号上下限…）
│   ├── store.js       房间与消息的读写、原子落盘、房间回收
│   ├── expiry.js      存活期定时器（内存定时器 + 启动时重建）
│   └── server.js      Express 应用与接口
└── public
    ├── index.html
    ├── css/style.css  浅色 / 深色双主题，全部响应式
    └── js
        ├── core.js      DOM 工具、Toast、确认框、localStorage 会话
        ├── crypto.js    通知加密（PBKDF2 + AES-GCM，密码不离开浏览器）
        ├── audio.js     合成「叮」声与音频解锁
        ├── theme.js     夜间模式判定与界面主题
        ├── renderer.js  A 端排版（换行 → 缩字号 → 往复滚动）与局部 DOM 更新
        └── app.js       主控制器（房间入口 / 身份 / 轮询 / 编辑推送 / 设置）
```

---

## 2. 快速开始

### 2.1 Docker Compose（推荐）

```bash
docker compose up -d --build
```

服务监听 `8686`，用浏览器访问 `http://<服务器IP>:8686`。

### 2.2 docker run

```bash
docker build -t 101rtnotice:1.0.0 .

docker run -d \
  --name 101rtnotice \
  --restart unless-stopped \
  -p 8686:8686 \
  -e TZ=Asia/Shanghai \
  -v rtn-data:/data \
  101rtnotice:1.0.0
```

### 2.3 改用宿主目录存数据（便于备份）

```bash
mkdir -p ./data && sudo chown -R 1000:1000 ./data
```

然后在 `docker-compose.yml` 中改用 `- ./data:/data`（容器内以 uid 1000 的 `node` 用户运行）。

### 2.4 用 localhost 先跑一遍（开发）

```bash
npm install
DATA_DIR=./data PORT=8686 npm start
```

### 2.5 网络受限的机器：代理与镜像源

#### 2.5.1 为什么 `HTTP_PROXY=... docker compose up --build` 传不进去

这是最常见的坑。**Docker 23+ 默认用 BuildKit，它不会读取命令行前的环境变量**，
所以下面这种写法里，代理只给了 `docker compose` 这个客户端进程，**构建容器里根本看不到**：

```bash
# ❌ 在 BuildKit 下无效
HTTP_PROXY=http://192.168.1.100:7890 HTTPS_PROXY=http://192.168.1.100:7890 \
  docker compose up -d --build
```

（老的 legacy builder 会自动读取这些变量并注入，所以网上的老帖子会让你这么做。）

BuildKit 下代理必须**显式**传递。本仓库已经配好了 **方式 A**，直接用就行。

#### 2.5.2 方式 A：走 `build.args`（本仓库已内置，推荐）

`Dockerfile` 里声明了 `ARG HTTP_PROXY / HTTPS_PROXY / NO_PROXY`，
`docker-compose.yml` 里把它们接到宿主机环境变量上，所以下面这条命令**现在可以直接用了**：

```bash
HTTP_PROXY=http://192.168.1.100:7890 \
HTTPS_PROXY=http://192.168.1.100:7890 \
docker compose up -d --build
```

不需要代理的机器什么都不用设，留空即直连。
验证代理是否真的进去了（把代理换成一个必然连不上的地址，npm 会立刻失败）：

```bash
HTTP_PROXY=http://127.0.0.1:1 docker compose build --no-cache
```

> `ARG` 只在构建期生效，**不会写进最终镜像的运行时环境**；
> 但它的值会出现在 `docker history` 里，所以代理地址**别带用户名密码**。

#### 2.5.3 方式 B：`~/.docker/config.json` 的 `proxies`（一劳永逸）

不想每次敲环境变量，或者机器上有多个项目要构建，就配这个。**它连 `ARG` 都不用声明**，
Docker 会自动注入到所有构建中：

```bash
mkdir -p ~/.docker
cat > ~/.docker/config.json <<'EOF'
{
  "proxies": {
    "default": {
      "httpProxy": "http://192.168.1.100:7890",
      "httpsProxy": "http://192.168.1.100:7890",
      "noProxy": "localhost,127.0.0.1"
    }
  }
}
EOF
```

配好后 `docker compose up -d --build` 即可，无需任何前缀。

> 注意：它同时会给**运行中的容器**注入这些代理环境变量。对本项目无影响
> （应用运行时不访问外网），但如果宿主机的代理哪天挂了，容器里仍留着这些变量。

#### 2.5.4 拉基础镜像失败（与上面是两件事）

`docker pull` / 构建时拉 `node:22-alpine` 是由 **dockerd 守护进程**发起的，
上面两种方式**都管不到它**。若报：

```
failed to resolve source metadata for docker.io/library/node:22-alpine
```

二选一：

```bash
# ① 用国内加速源手动拉下来再打本地标签（不需要 root）
docker pull docker.m.daocloud.io/library/node:22-alpine
docker tag  docker.m.daocloud.io/library/node:22-alpine node:22-alpine
docker compose up -d --build
```

```bash
# ② 给守护进程配镜像加速器（需要 root 并重启 dockerd）
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{ "registry-mirrors": ["https://docker.m.daocloud.io"] }
EOF
sudo systemctl restart docker
```

> 守护进程走代理则需要在 systemd drop-in 里配 `HTTP_PROXY`（`/etc/systemd/system/docker.service.d/`），
> 同样需要 root，属于宿主机运维范畴。

### 2.6 ⚠️ 换端口时注意浏览器的「不安全端口」

Chromium 系浏览器（Chrome / Edge，也就是 A 端与 B 端使用的内核）内置了一份端口黑名单，
**用浏览器直接访问这些端口会得到 `ERR_UNSAFE_PORT`，页面根本打不开**（服务本身与 `curl` 是正常的）。

已被拦截的常见端口：`6000`、`6566`、`6665`–`6669`、`6697`、`10080`、`5060`、`21`、`25`、`110` 等。

> 若通过 HTTPS 域名（443）由反向代理转发到容器，浏览器看不到容器端口，则不受此限制。
> 但局域网直连调试时会被拦，因此默认端口选了不在列表里的 `8686`。

可安全使用：`8686`、`6688`、`8888`、`6060`、`7000`、`8080`、`9000`、`3333`。

### 2.7 自动启动（已经配好了）

`docker-compose.yml` 里已经写了 `restart: unless-stopped`，**不需要额外配置**。
生效需要两个条件，缺一不可：

| 条件 | 作用 | 怎么查 |
|---|---|---|
| 容器重启策略 = `unless-stopped` | 容器退了就自己拉起来 | `docker inspect 101rtnotice --format '{{.HostConfig.RestartPolicy.Name}}'` |
| **dockerd 自身开机自启** | 宿主机重启后把容器带回来 | `systemctl is-enabled docker` → 应为 `enabled` |

> 很多人只配了第一条就以为万事大吉。如果 `dockerd` 没设开机自启，主机一重启容器就永远不会回来。

#### 什么情况会自动拉起

| 场景 | 是否自启 | 说明 |
|---|---|---|
| 容器内进程崩溃退出 | ✅ | 立即重启 |
| 宿主机重启 / 断电恢复 | ✅ | dockerd 启动后拉起 |
| 手动 `docker stop` / `docker kill` / `docker compose stop` | ❌ | **属「显式停止」，策略会被挂起**，直到你重新 `docker compose up -d` |
| `docker compose down` | ❌ | 容器被删除，策略随之消失，需重新 `up -d` |
| 容器内进程反复崩溃 | ✅ 但会退避 | 启动间隔翻倍（100ms → 200ms → …），避免刷屏 |

⚠️ **最容易踩的坑**：为了「重启一下服务」而执行 `docker stop` / `docker kill`，
以为它会自己回来 —— 实际上不会，`restart` 策略已经被挂起了。**统一用 `docker compose restart`**，
它不会挂起策略：

```bash
docker compose restart   # 重启应用（保留策略）
docker compose up -d     # 修改配置后重新应用
```

> 若提示 `permission denied while trying to connect to the Docker daemon socket`，
> 说明当前用户不在 `docker` 组，执行下面这条后**重新登录**（或 `newgrp docker`）即可：
>
> ```bash
> sudo usermod -aG docker $USER
> ```

#### 验证自动恢复

```bash
# 模拟真实崩溃（容器内部杀掉进程，而不是 docker kill）
docker exec 101rtnotice sh -c "kill -9 \$(pgrep -f 'node src/server.js')"
sleep 8
docker inspect 101rtnotice --format '状态: {{.State.Status}}  重启次数: {{.RestartCount}}'
# 预期输出：状态: running  重启次数: 1
curl -s http://127.0.0.1:8686/api/health
```

#### 对 A 端的影响

服务器重启期间，A 端会保留当前画面并持续静默重试，恢复后 **≤15 秒**内自动同步到最新内容，
不会出现空白或报错画面。

同时 A 端心跳（`lastSeenA`）是**落盘**的，所以重启不会重置 6 小时回收倒计时 ——
只要停机时间累计不超过 6 小时，房间与消息都不会丢。

---

## 3. ⚠️ 时区：部署前必读

**存活期销毁、房间回收、3 秒丢弃窗口全部以「服务器时间」为准**（PRD 4.7）。
容器默认 `TZ=UTC`，中国大陆用户如果不设置时区，把存活期填 `21:00` 实际会在本地次日 05:00 才销毁。

本镜像的 `TZ` 默认值为 `Asia/Shanghai`，可用环境变量覆盖：

```bash
docker run -e TZ=Asia/Shanghai ...
```

服务启动日志会打印当前服务器时间与时区偏移，请确认一次：

```
[server] 服务器时间：Thu Sep 17 2026 13:54:00 GMT+0800 (中国标准时间) (UTC+08:00)
```

> 排查提示：alpine 基础镜像不含 `tzdata`，`docker exec 容器 date` 可能显示 UTC。
> 这是 busybox `date` 解析不了时区名所致；应用使用 Node（自带 ICU 时区库）读取 `TZ`，
> 行为正确，**请以启动日志打印的服务器时间为准**。

---

## 4. A 端（展示端）使用前置条件

| # | 条件 | 说明 |
|---|---|---|
| 1 | 充电 + 屏幕常亮 | 系统设置中开启「充电时不锁定屏幕」，并把浏览器加入后台白名单 |
| 2 | 每次打开 / 重载页面后**手动点击一次「查看」** | 浏览器自动播放策略所限，音频解锁必须由用户手势触发；页面会显示一个半透明「查看」按钮提醒 |
| 3 | 保持联网 | 建议通过 HTTPS 域名访问 |
| 4 | 建议物理横放 | 全屏与横屏锁定为尽力能力，不支持时靠响应式布局兜底 |
| 5 | 房间存续依赖 A 端 | 连续 **6 小时**无 A 端轮询，房间、消息与设置会被服务器删除 |

**页面级兜底能力**（尽力而为，失败不影响使用）：
`navigator.wakeLock` 屏幕常亮、`requestFullscreen()` 全屏、`screen.orientation.lock('landscape')` 横屏锁定。

### 查看模式下如何切回「身份 / 设置」

查看模式刻意不显示任何操作控件（避免厨房设备被误触）。
**连点两下画面任意位置**即可回到「选择身份」界面，再点「设置」进入房间设置。

---

## 5. 行为说明（易被误解的几点）

| 行为 | 说明 |
|---|---|
| 推送后为什么不立刻发出请求 | `确认推送` 先 loading 5 秒再提交，用于避开服务器的 3 秒丢弃窗口（PRD 4.2） |
| 10 秒内又点了一次推送 | 会被前端拦下并提示剩余秒数；同一设备 10 秒内不能提交第二次 |
| 服务器返回 `discarded` | 表示距上一条消息不足 3 秒，该消息被服务器丢弃，A 端内容不变 |
| 存活期填了已经过去的时刻 | 前端弹「将会在次日销毁此消息，是否确认」，确认后按**次日**该时刻销毁；取消则不提交 |
| 页面不显示剩余时长 | 按 PRD 要求，编辑页与查看页都不做任何时长换算与倒计时 |
| 销毁的表现 | 服务器写入一条「白底 + 单个空格」的消息，A 端表现为白底空白，**不响铃** |
| 夜间模式下 A 端的配色 | 强制黑底白字，覆盖用户在编辑页选的背景色 / 字体色；界面同时转深色 |
| 夜间模式下 B 端 | 只有它自己的界面转深色，**不影响它编辑的消息样式** |
| 夜间模式留空 | 开始或结束任一留空即视为关闭夜间模式 |
| 多台 A 端 / 多台 B 端 | 可以同时在同一个房间，身份不固定，设置房间级共享 |
| 自定义房间号 | 创建面板可自填 4 位房间号，或点「随机房间号」生成；已被占用会拒绝创建。房间号不区分大小写，输入时自动转大写并过滤掉字母数字以外的字符 |
| 通知加密 | 创建房间时填了密码就开启；密码只存在浏览器，服务端只存密文。加入加密房间必须输对密码，否则提示「密码错误」 |
| 退出房间 | 首页的「退出房间」只需确认一下；它**只清当前会话**，房间号与密码会记住，下次一键重新加入。想彻底清除就用设置里的「忘记本机保存的密码」 |
| 密码记忆 | 加入过的房间号与密码存在浏览器本地（各保留最近 20 个），下次在「加入」面板会自动预填，不用再输一遍 |
| 断网 | A 端保留当前画面并静默持续重试，不出现空白或报错画面 |

### 5.1 通知加密（可选密码）

创建房间时填一个 ≥ 6 位的密码，通知内容就会以密文形式存储在服务器上。

| 项 | 说明 |
|---|---|
| 算法 | PBKDF2-HMAC-SHA256（150,000 次迭代）派生密钥 + AES-GCM-256 认证加密 |
| 密码去向 | **永远不发给服务端**。加密与解密都在浏览器用 Web Crypto 完成 |
| 服务端存什么 | 盐、迭代次数、一段校验密文（用来本地判断密码对不对），以及通知的密文 |
| 密文绑定 | 以房间号作为 AES-GCM 的附加认证数据，密文被人搬到别的房间会解密失败 |
| 加密范围 | **仅通知文本**。背景色 / 字体色 / 存活期仍是明文（服务端需要用它们完成到期销毁） |
| 验证方式 | 加入时浏览器本地解密校验密文，因此密码错会**立即**提示，无需等第一条通知 |
| 密码记忆 | 存在浏览器 `localStorage`。A 端是无人值守设备，不记住就无法自动解密、重载后会变成白屏 |

**明文 / 密文不能混推**：加密房间只能收密文，未加密房间只能收明文。
否则任何人猜到房间号后都能向加密房间注入一段明文，直接在 A 端显示出来（服务端会拒绝，返回 `400`）。

#### ⚠️ 已知限制

1. **忘记密码 = 消息永久读不出来**。服务端只有密文，没有任何恢复途径，只能重新建房间。
2. **100 字上限只在浏览器端强制**。服务端看不到明文，无法校验字数，只能限制密文长度（2000 字符）。
3. **校验密文可被离线爆破**。拿到房间号的人可以拿到校验密文，在本地暴力尝试密码，
   因此密码**至少 6 位、建议再长一些**，不要用 `123456` 这类弱密码。
4. **设置（字号、夜间时间）不加密**。不需要密码就能看到这些无关痛痒的值。
5. **密码不能在创建后修改或取消**。改密码需要重新派生密钥并重加密全部历史，本项目未实现。
6. 因为明文不上传，**服务端日志、数据备份里也不会出现通知内容** —— 这是这套方案最大的好处。

---

## 6. 接口

房间号本身即访问凭据，无需账号密码。房间不存在（含被回收）统一返回：

```json
404 { "ok": false, "error": "ROOM_NOT_FOUND", "message": "房间不存在" }
```

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 健康检查（含 `serverTime`） |
| `POST` | `/api/rooms` | 创建房间。`roomId` 留空 => 随机生成 4 位；填了则作为**自定义房间号**（已被占用返回 `409 ROOM_EXISTS`，格式非法返回 `400 INVALID_ROOM_ID`）。`enc` 传入客户端生成的加密参数则创建加密房间 |
| `GET` | `/api/rooms/:roomId` | 加入前的存在性校验，返回 `enc`（有值则客户端需先本地验密码） |
| `GET` | `/api/rooms/:roomId/state?role=A\|B` | 轮询。`role=A` 会记录 A 端心跳（房间存续唯一依据），`role=B` 不计入活跃度 |
| `POST` | `/api/rooms/:roomId/messages` | 推送消息，整条覆盖上一条 |
| `PUT` | `/api/rooms/:roomId/settings` | 更新房间设置（字号、夜间时间） |

### 创建房间请求体

```json
{}
```

留空则随机生成房间号。也可以指定自定义房间号：

```json
{ "roomId": "HOME" }
```

- 房间号为 **4 位**，字符集 `A-Z0-9`（输入不区分大小写，服务端自动转大写）；
- 已被占用 => `409 { "ok": false, "error": "ROOM_EXISTS", "message": "房间号已被占用，请换一个" }`；
- 格式非法（长度不对、含其它字符）=> `400 INVALID_ROOM_ID`。

  > 两种失败返回的文案刻意保持一致，避免被用来枚举哪些房间号存在。

  **加密房间需额外带上 `enc`**（由浏览器生成，不含密码）：

  ```json
  {
    "roomId": "HOME",
    "enc": {
      "v": 1,
      "salt": "<base64url 16 字节盐>",
      "iter": 150000,
      "check": "1.<base64url iv>.<base64url 密文>"
    }
  }
  ```

  格式不合法 => `400 INVALID_ENC`。

### 推送请求体

```json
{
  "text": "饭好了，下来吃饭",
  "enc": false,
  "bg": "#fdd835",
  "fg": "#000000",
  "expireAt": "21:00"
}
```

- `text` ≤ 100 字；`bg` / `fg` 为 `#RRGGBB`（非法值回退为白底黑字）；
- `expireAt` 为 `HH:MM`，`null` / 省略表示永久存活；
- 距上一条消息不足 3 秒 → 返回 `{ "ok": true, "discarded": true }`。

**加密房间的推送**：`enc` 必须为 `true`，`text` 换成密文信封 `1.<iv>.<密文>`；
此时服务端按密文上限（2000 字符）校验，无法校验明文长度。
`enc` 与房间的加密状态不匹配时返回 `400 ROOM_ENCRYPTED` / `ROOM_NOT_ENCRYPTED`。

**销毁消息例外**：存活期到点时服务器写入的「白底 + 单空格」消息始终是**明文**
（`enc: false`），不包含任何用户信息。

### 设置请求体

```json
{ "fontSize": 42, "nightStart": "20:00", "nightEnd": "06:00" }
```

- `fontSize` 必须是不小于 `24` 的整数；非法时返回 `400 INVALID_FONT_SIZE`，并把房间字号**恢复为 42**；
- `nightStart` / `nightEnd` 为 `HH:MM`，留空（`null` / `""`）即关闭夜间模式。

---

## 7. 数据与持久化

```
/data/rooms/<ROOMID>/room.json      房间元信息 + 房间级设置 + 最近一次 A 端轮询时间
/data/rooms/<ROOMID>/message.json   当前消息（消息单独存放于独立文件夹）
```

- 每次变更使用「临时文件 → `fsync` → `rename`」原子写入，断电不会产生半截 JSON；
- A 端心跳（每 5 秒一次）在内存中累积，**每 60 秒**批量回写一次，退出前强制落盘；
- **容器重启后**：房间与当前消息不丢失；所有未到期的存活期按原定时刻继续生效，重启期间已到期的会立即补一次销毁。

---

## 8. 主要参数（`src/config.js`）

| 参数 | 值 | 对应 PRD |
|---|---|---|
| `roomIdLength` / `roomIdAlphabet` | 4 位 / `A-Z0-9` | 见第 10 节（原 PRD 为 8 位） |
| `roomRecycleMs` | **6 小时** | 见第 10 节（原 PRD 为 24 小时） |
| `sweepIntervalMs` | 60 秒 | 巡检 + 心跳回写 |
| `maxTextLength` | 100 | 4.2 |
| `maxEncryptedTextLength` | 2000（密文上限） | 5.1 |
| `discardWindowMs` | 3000 ms | 4.2 |
| `defaultFontSize` / `minFontSize` | 42 / 24 | 4.3 / 4.6 |

前端常量集中在 `public/js/app.js` 顶部：轮询 5 秒（A）/ 30 秒（B）、loading 5 秒、冷却 10 秒、重试 3 次、字号下限 24；
滚动参数在 `public/js/renderer.js`：`SCROLL_SPEED = 20` px/s、`SCROLL_PAUSE = 5000` ms。

---

## 9. 验收对照

| # | 验收项 | 实现位置 |
|---|---|---|
| 1–2 | 创建 / 加入、房间不存在提示 | `public/js/app.js` 入口弹窗 + `GET /api/rooms/:roomId` |
| 3–4 | localStorage 记忆、房间消失回弹窗 | `RTN.session` + `handleRoomGone()` |
| 5 | 多台 A / 多台 B 同时在线 | 身份不固定，无连接数限制 |
| 6 | 6 小时无 A 端轮询回收房间 | `store.sweep()` + `lastSeenA` |
| 7–8 | 100 字上限与实时计数、背景「无」= 白底 | `maxlength` + `input` 计数；`#ffffff` 选项 |
| 9–10 | 存活期次日确认、不显示剩余时长 | `btnPush` 处理流程 + `RTN.dialog` |
| 11 | loading 5 秒、10 秒冷却、3 秒丢弃窗口 | `countdownLoading()` / `PUSH_COOLDOWN_MS` / `server.js` 丢弃判断 |
| 12 | 失败重试 3 次后提示 | `pushWithRetry()` |
| 13–14 | 永久存活、到点写空白消息 | `resolveExpireAt()` / `expiry.js` / `store.destroyMessage()` |
| 15–18 | 居中、换行、缩字号（≥24）、往复滚动、空消息 | `public/js/renderer.js` |
| 19–22 | 夜间模式配色 / 静音 / 恢复 / 不补响 | `theme.js` + `applyMessageToView()` |
| 23 | B 端仅自身界面转深色 | `applyShellTheme()` |
| 24–26 | 提示音触发与不触发条件 | `audio.js` + `onState()` |
| 27–29 | 字号校验与恢复 42、房间级同步 | `btnSaveSettings` + `PUT /settings` + B 端 30 秒轮询 |
| 30 | 容器重启不丢数据、TTL 继续生效 | `store.init()` + `expiry.restoreAll()` |
| 31–32 | 长时运行、断网自恢复 | 轮询用 `setTimeout` 链（不会堆积）、失败静默重试 |
| — | 加密房间：密码错立即提示、重载后自动解密、明文/密文不可混推 | `public/js/crypto.js` + `server.js` 的 `ROOM_ENCRYPTED` 校验 |

---

## 10. 本实现中自行决定的点（可调整）

PRD 未明确、实现时做了取舍，列在这里便于复核：

1. **查看模式下不常驻操作按钮**：厨房设备无人操作，避免误触；用「连点两下画面」切回身份界面。
2. **重载后自动进入查看模式**（满足 PRD 4.1「不再弹窗」），但仍保留一个半透明「查看」按钮用于解锁音频（满足 PRD 0.2）。
3. **`TZ` 默认 `Asia/Shanghai`**：PRD 只说「以服务器时间为准」，未指定时区；默认按中国大陆用户预期。
4. **房间号改为 4 位、字符集为全部 `A-Z0-9`、并支持自定义**：PRD 4.1 原本为「8 位、由系统随机生成」，
   现改为 **4 位**（未剔除易混淆字符，输入不区分大小写），并在创建面板提供自定义输入框（留空则随机）。
   自定义号已被占用时拒绝创建（`409`）。

   > ⚠️ 这是**安全上的降级**：PRD 明确「房间号本身即唯一访问凭据」，减少长度后组合数从 36⁸
   > 降到 36⁴（约 168 万），而「房间不存在」的提示可被用来确认某个号是否已被占用。
   > 家庭自用完全够用，但**不要把它当成对外服务**。若日后要收紧，只需把
   > `src/config.js` 的 `roomIdLength` 调回 8，并把 `public/js/app.js` 顶部的
   > `ROOM_ID_LENGTH` 改成一致即可（接口与页面会自动适配）。
5. **推送重试语义**：`最多重试 3 次` 实现为「首次 + 最多 3 次重试」，间隔 3 秒。
6. **同一设备 10 秒冷却**从点击时刻起算（含那 5 秒 loading）。
7. **夜间模式跨午夜且 `开始 == 结束` 时视为关闭**（否则会全天静音，属于明显不合理的配置）。
8. **通知加密方案自行设计**（PRD 未涉及）：服务端只存盐 / 迭代次数 / 校验密文 / 密文，
   密码与密钥不离开浏览器。加密仅覆盖通知文本，配色与存活期仍为明文（服务端需要用它们做到期销毁）；
   加密房间只能推密文，防止猜到房间号的人注入明文内容。
9. **密码存在浏览器 `localStorage`**：这是 A 端能无人值守的前提（否则页面一重载就无法解密）。
   拿到该设备的人可以读到密码 —— 这是为可用性做的权衡，详见 5.1。
10. **创建房间时必须先产生房间号**：去掉了「留空则随机」的隐式行为，改为显式的
    「随机房间号」按钮 + 自填输入框，避免用户不知道房间号到底是多少。
11. **房间回收由 24 小时缩短为 6 小时**：PRD 4.1 为 24 小时。缩短后房间与消息
    在 A 端离线 6 小时后即被清空，意在更快释放短房间号的号段。

    > ⚠️ A 端断网 / 没电超过 6 小时，房间、消息与设置都会丢。要改回去只需调整
    > `src/config.js` 的 `roomRecycleMs`。
12. **「加入过的房间」小账本存在浏览器本地**：用于退出后快速重新加入（见 5 节），
    与当前会话 `rtn.session` 分开存放，上限 20 条。它同样是**明文密码**，
    与 5.1 的密码记忆是同一个权衡。

---

## 11. 不在本需求范围

- 部署方式、隧道 / 穿透与网络加速方案；
- HTTPS 证书与反向代理（容器只暴露 `8686`，由你自己的域名 / 隧道方案转发到该端口）；
- 埋点、统计与监控。

---

## 12. 许可证

[MIT License](./LICENSE) © 2026 myncdw

可自由使用、修改、商用与再发布，只需保留版权声明与许可证文本。
