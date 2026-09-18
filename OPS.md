# 101实时通知 · 运维指南

面向把这个服务跑在自己机器上的人。所有命令都在这台机器上实测过。

> 下文的命令直接用 `docker` / `docker compose`。若提示
> `permission denied while trying to connect to the Docker daemon socket`，
> 说明当前用户不在 `docker` 组，执行 `sudo usermod -aG docker $USER` 后**重新登录**即可。

---

## 1. 一屏体检

```bash
cd /path/to/101RTnotice
docker compose ps                                  # 容器状态（应显示 healthy）
curl -s http://127.0.0.1:8686/api/health           # 服务与服务器时间
docker inspect 101rtnotice --format '{{range .Mounts}}{{.Source}} → {{.Destination}}{{println}}{{end}}'
ls -la /data/101rtnotice/rooms/                    # 数据目录
```

正常的输出长这样：

```
NAME          STATUS                   PORTS
101rtnotice   Up 2 minutes (healthy)   0.0.0.0:8686->8686/tcp

{"ok":true,"serverTime":1789707148143}

/data/101rtnotice → /data/101rtnotice

drwxr-xr-x  2 myncdw-vm  rooms/         ← 每个房间一个子目录
```

---

## 2. 数据在哪、备份什么

```
/data/101rtnotice/rooms/<房间号>/room.json      房间元信息 + 设置 + 最后心跳 + 加密参数
/data/101rtnotice/rooms/<房间号>/message.json   当前消息
```

容器内与宿主机是同一个路径（绑定挂载），所以**宿主机直接 `ls` 就能看**。

**要备份的就是 `/data/101rtnotice/` 整个目录。**

```bash
# 备份（服务运行中也可以，但停机更稳妥）
sudo rsync -a /data/101rtnotice/ /backup/101rtnotice-$(date +%F)/

# 或者打包
sudo tar czf ~/101rtnotice-$(date +%F).tar.gz -C /data 101rtnotice

# 恢复
docker compose down
sudo rsync -a /backup/101rtnotice-2026-09-18/ /data/101rtnotice/
docker compose up -d
```

> 恢复前注意属主：目录必须归 **uid 1000**，否则容器内的 `node` 用户写不进去。
> `sudo chown -R 1000:1000 /data/101rtnotice`

---

## 3. 重启与升级

### 3.1 重启服务

```bash
docker compose restart        # ✅ 推荐：只重启进程，保留重启策略
```

**不要用 `docker stop` + `docker start`**：

- `docker stop` / `docker kill` / `docker compose stop` 属于「显式停止」，
  会**挂起 `restart: unless-stopped` 策略**，宿主机重启后容器不会自己回来。
- 详见 README 2.7。

### 3.2 升级到新版本

```bash
cd /path/to/101RTnotice
git pull
docker compose up -d --build     # 会重建镜像与容器，数据不受影响
docker compose ps                # 确认 healthy
docker compose logs --tail 20    # 看启动日志
```

### 3.3 ⚠️ `down -v` 对数据的实际影响

| 存储方式 | `docker compose down` | `docker compose down -v` |
|---|---|---|
| **绑定宿主目录**（当前默认） | 数据保留 ✅ | 数据保留 ✅（宿主目录不受影响） |
| 命名卷 | 数据保留 ✅ | **数据被删除** ❌ |

好消息：换成宿主目录后，`down -v` **误操作也不会丢数据**了 —— 实测验证过。

不过 `-v` 仍会尝试删除 compose 里声明的 `rtn-data` 卷（当前配置下它没被使用）。

---

## 4. 日常操作

### 4.1 看日志

```bash
docker compose logs -f --tail 100        # 实时跟随
docker compose logs --since 1h           # 最近一小时
docker compose logs | grep '\[push\]'    # 只看推送记录
docker compose logs | grep '\[sweep\]'   # 只看房间回收
```

日志里的关键标记：

| 标记 | 含义 |
|---|---|
| `[server]` | 启动、时区、回收策略 |
| `[room]` | 创建房间（含是否自定义/加密） |
| `[push]` | 推送消息（加密的只记「加密」，不记内容） |
| `[expiry]` | 存活期到点销毁 |
| `[sweep]` | 巡检与房间回收 |
| `[store]` | 数据加载、跳过异常目录 |

### 4.2 看某个房间的数据

```bash
ROOM=HOME
cat /data/101rtnotice/rooms/$ROOM/room.json
cat /data/101rtnotice/rooms/$ROOM/message.json

# 看还有多少时间被回收
python3 -c "
import json,time
d=json.load(open('/data/101rtnotice/rooms/$ROOM/room.json'))
idle=(time.time()*1000-d['lastSeenA'])/3600000
print(f'已 {idle:.1f} 小时无 A 端轮询')"
```

### 4.3 手动删除一个房间

⚠️ **必须先停容器**。服务端把房间缓存在内存里，运行中删目录会在下次落盘
（每 60 秒一次心跳回写、以及退出时）**被重新创建出来**：

```bash
docker compose down                    # ① 先停
rm -rf /data/101rtnotice/rooms/BADROOM # ② 再删
docker compose up -d                   # ③ 起回来
```

---

## 5. 配置速查

### 5.1 服务端参数 `src/config.js`

| 参数 | 默认 | 说明 |
|---|---|---|
| `port` | `8686` | 监听端口（也读环境变量 `PORT`） |
| `dataDir` | `/data/101rtnotice` | 数据目录（也读环境变量 `DATA_DIR`） |
| `roomIdLength` | 4 | 房间号长度 |
| `roomRecycleMs` | 24 小时 | 无 A 端轮询多久回收；**设 0/null 即关闭回收** |
| `sweepIntervalMs` | 60 秒 | 巡检 + 心跳回写间隔 |
| `maxTextLength` | 100 | 明文长度上限（客户端强制） |
| `maxEncryptedTextLength` | 2000 | 密文长度上限 |
| `discardWindowMs` | 3000 | 丢弃窗口 |
| `defaultFontSize` / `minFontSize` | 42 / 24 | 字号 |
| `maxFontFamilyLength` | 100 | 自定义字体族长度上限 |

改完需要 `docker compose up -d --build` 才生效。

### 5.2 前端参数 `public/js/app.js` 顶部

| 常量 | 默认 | 说明 |
|---|---|---|
| `POLL_MS_A` | 5000 | A 端轮询间隔 |
| `POLL_MS_B` | 30000 | B 端轮询间隔 |
| `PUSH_LOADING_MS` | 5000 | 点击推送后的 loading |
| `PUSH_COOLDOWN_MS` | 10000 | 同设备推送冷却 |
| `PUSH_RETRY_MAX` | 3 | 失败重试次数 |
| `IDLE_WARN_MS` | 30 分钟 | 离线多久后显示回收倒计时横幅 |

### 5.3 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `TZ` | `Asia/Shanghai` | **服务器时间时区**，影响存活期销毁与房间回收 |
| `PORT` | `8686` | 监听端口 |
| `DATA_DIR` | `/data/101rtnotice` | 数据目录 |

在 `docker-compose.yml` 的 `environment:` 里改，然后 `docker compose up -d` 即可
（**不需要 `--build`**）。上表的 `src/config.js` 参数则会打进镜像，必须 `--build`。

---

## 6. 故障排查

### 6.1 A 端不响铃 / 白屏

| 现象 | 原因 | 处理 |
|---|---|---|
| 有新消息但没声音 | 浏览器自动播放策略，音频未解锁 | **在 A 端页面上点一次「查看」按钮**（页面右下角有半透明按钮） |
| 重载后白屏、不响应 | 同上，解锁状态随重载失效 | 同上。这是浏览器的硬限制，无法远程绕过 |
| 加密房间重载后空白 | 本地没存密码 | 重新加入房间并输入密码 |
| 页面被系统回收 | 后台限制 / 省电策略 | 关闭省电与后台清理，把浏览器加入白名单 |

### 6.2 房间突然不见了

| 原因 | 判断依据 | 处理 |
|---|---|---|
| **A 端离线超过 24 小时**被回收 | 之前页面顶部出现过回收倒计时横幅 | 重新创建房间。想彻底避免就把 `roomRecycleMs` 设为 `0` |
| 数据目录变更后没迁移 | `ls /data/101rtnotice/rooms` 是空的，但旧卷里有数据 | 按 README 第 7 节迁移 |
| 绑定的宿主目录被清空 | 目录里没有 `rooms/` | 从备份恢复 |

### 6.3 容器起不来

```bash
docker compose logs --tail 50
```

| 报错 | 原因 | 处理 |
|---|---|---|
| `EADDRINUSE` | 端口被占用 | `ss -ltnp \| grep 8686` 找到占用者，或改 `PORT` |
| `EACCES` / 写不进去 | 宿主目录属主不对 | `sudo chown -R 1000:1000 /data/101rtnotice` |
| 启动后立刻退出 | 配置写错 | 看日志里的堆栈 |

### 6.4 浏览器打不开页面（`ERR_UNSAFE_PORT`）

Chromium 系浏览器有端口黑名单，服务本身和 `curl` 正常，但浏览器拒绝访问。

- 被拦截：`6000`、`6566`、`6665`–`6669`、`6697`、`10080`、`5060`、`21`、`25`、`110`
- 可安全使用：`8686`、`6688`、`8888`、`6060`、`7000`、`8080`、`9000`、`3333`

### 6.5 存活期销毁时间不对

**以服务器时间为准**，先确认时区：

```bash
docker compose logs | grep '服务器时间'
# [server] 服务器时间：Fri Sep 18 2026 12:52:21 GMT+0800 (中国标准时间) (UTC+08:00)
```

若是 `UTC+00:00`，说明 `TZ` 没生效 —— 检查 `docker-compose.yml` 的 `TZ` 环境变量。

> `docker exec 容器 date` 可能显示 UTC，那是 busybox 解析不了时区名所致，
> **以启动日志为准**。

### 6.6 构建卡住 / 拉不到基础镜像

| 现象 | 原因 | 处理 |
|---|---|---|
| `npm ci` 一直卡着 | BuildKit 不读命令行的 `HTTP_PROXY=` | 用 README 2.5 的方式传代理 |
| `failed to resolve source metadata` | Docker Hub 不可达 | 配镜像加速器，或先 `docker pull` 加速源再 `tag` |

### 6.7 磁盘越来越大

```bash
du -sh /data/101rtnotice
ls /data/101rtnotice/rooms | wc -l     # 房间数量
```

- 关闭了房间回收（`roomRecycleMs: 0`）时，房间**不会自动清理**，会一直堆积。
- 单个房间的数据很小（两个 JSON 文件），正常自用不会成为问题。
- 清理方式见 4.3。

### 6.8 容器没有自动启动

```bash
docker inspect 101rtnotice --format '{{.HostConfig.RestartPolicy.Name}}'   # 应为 unless-stopped
systemctl is-enabled docker                                               # 应为 enabled
```

两个都要满足。如果之前用过 `docker stop` / `docker kill`，策略会被挂起，
需要 `docker compose up -d` 重新应用。详见 README 2.7。

---

## 7. 安全

### 7.1 数据目录权限

`/data` 在根目录下，默认 755、文件 644，**同机器上的任何用户都能读到房间数据**：

```bash
sudo chmod 700 /data/101rtnotice
```

> 属主必须是 uid 1000（容器内的 `node` 用户），只改权限位、别改属主。

### 7.2 房间号即凭据

4 位房间号只有 36⁴ ≈ 168 万种组合，且没有账号密码。**不要把它当作对外服务**。
需要更强保护就给房间设密码（通知会以密文存储）。

### 7.3 加密的边界

密码不会离开浏览器，服务端只存密文。但要清楚：

- **忘记密码 = 消息永久读不出来**，没有恢复途径
- 服务端存的校验密文可被**离线爆破**，密码请用 6 位以上
- 密码存在浏览器 `localStorage`（A 端无人值守的前提）
- 设置（字号、夜间时间）与配色**不加密**

### 7.4 暴露面

容器只监听 `8686`。建议：

- 不要直接把端口暴露到公网，走反向代理 + HTTPS
- 如果必须暴露，至少加一层访问控制

---

## 8. 建议的日常巡检

| 频率 | 检查项 |
|---|---|
| 每天 | A 端画面是否正常显示（设备是否还在充电、亮屏、联网） |
| 每周 | `docker compose ps` 看是否 healthy；`docker compose logs --tail 50` 有无异常 |
| 每月 | 备份一次 `/data/101rtnotice/`；`ls /data/101rtnotice/rooms \| wc -l` 看房间数是否合理 |
| 升级后 | README 2.7 的自动恢复验证 + A 端页面重载后点一次「查看」解锁音频 |

---

## 9. 常用命令速查

```bash
# 状态
docker compose ps
curl -s http://127.0.0.1:8686/api/health
docker compose logs -f --tail 100

# 重启 / 升级
docker compose restart
git pull && docker compose up -d --build

# 数据
ls -la /data/101rtnotice/rooms/
sudo tar czf ~/101rtnotice-$(date +%F).tar.gz -C /data 101rtnotice
sudo chown -R 1000:1000 /data/101rtnotice

# 停止 / 启动（注意：stop 会挂起重启策略）
docker compose down && docker compose up -d

# 彻底重建（数据在宿主目录，不受影响）
docker compose down && docker compose up -d --build
```
