FROM node:22-alpine

# TZ 决定「服务器时间」的时区，直接影响存活期销毁 / 房间回收 / 3 秒丢弃窗口。
# 中国大陆用户请保持 Asia/Shanghai，否则 21:00 的存活期会按 UTC 计算。
#
# 说明：Node 自带 ICU 时区库，直接读取 TZ 环境变量即可正确工作（启动日志会打印时区偏移）。
#      alpine 基础镜像不含 tzdata，因此 `docker exec 容器 date` 可能显示 UTC —— 这是
#      busybox date 解析不了时区名所致，不影响应用行为，请以启动日志为准。
ENV NODE_ENV=production \
    PORT=8686 \
    DATA_DIR=/data/101rtnotice \
    TZ=Asia/Shanghai

WORKDIR /app

# ---- 构建期代理 ----
# 仅用于 npm ci 联网；ARG 不会写进最终镜像的运行时环境。
# 注意：BuildKit 不会自动读取 docker compose 命令前的 HTTP_PROXY=...，必须像下面这样声明 ARG，
#      再由 docker-compose.yml 的 build.args 传入（详见 README 2.5）。
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY

# 先装依赖，利用构建缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --fetch-retries=5 && npm cache clean --force

# 再拷源码（LICENSE 一并带入镜像，满足 MIT 的版权声明保留要求）
COPY src ./src
COPY public ./public
COPY LICENSE ./

RUN mkdir -p /data/101rtnotice && chown -R node:node /data /app

USER node

EXPOSE 8686

# 数据目录：房间与消息通过卷映射持久化，容器重启不丢。
# 只占 /data 下的一个子目录，方便 /data 同时挂载给其它应用。
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8686)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
