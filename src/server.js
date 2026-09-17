'use strict';

const path = require('path');
const express = require('express');
const config = require('./config');
const store = require('./store');
const expiry = require('./expiry');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// 接口一律不缓存
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const TIME_RE = store.TIME_RE;

/**
 * 把 HH:MM 解析为「服务器时间」下的绝对时刻。
 * 规则（PRD 4.2）：时刻早于（或等于）当前时刻时，按次日该时刻销毁。
 */
function resolveExpireAt(value, now) {
  if (value === null || value === undefined || value === '') {
    return { expiresAt: null, invalid: false };
  }
  if (typeof value !== 'string') return { expiresAt: null, invalid: true };
  const v = value.trim();
  if (!TIME_RE.test(v)) return { expiresAt: null, invalid: true };

  const m = TIME_RE.exec(v);
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  let t = d.getTime();
  if (t <= now) t += 24 * 60 * 60 * 1000;
  return { expiresAt: t, invalid: false };
}

function publicMessage(message) {
  if (!message) return null;
  return {
    text: message.text,
    bg: message.bg,
    fg: message.fg,
    expiresAt: message.expiresAt,
    destroy: message.destroy,
  };
}

function publicRoom(room) {
  return {
    ok: true,
    serverTime: Date.now(),
    roomId: room.roomId,
    settings: room.settings,
    message: publicMessage(room.message),
  };
}

// ---------------------------------------------------------------- 健康检查

app.get('/api/health', (req, res) => {
  res.json({ ok: true, serverTime: Date.now() });
});

// ---------------------------------------------------------------- 创建房间

app.post('/api/rooms', async (req, res, next) => {
  try {
    const room = await store.createRoom();
    console.log(`[room] 创建房间 ${room.roomId}`);
    res.status(201).json({ ok: true, roomId: room.roomId, serverTime: Date.now() });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- 房间中间件

// 房间号即访问凭据；格式非法或房间不存在（含被回收）统一返回 404
app.use('/api/rooms/:roomId', (req, res, next) => {
  const roomId = String(req.params.roomId || '').toUpperCase();
  if (!store.isValidRoomId(roomId)) {
    return res.status(404).json({ ok: false, error: 'ROOM_NOT_FOUND', message: '房间不存在' });
  }
  const room = store.getRoom(roomId);
  if (!room) {
    return res.status(404).json({ ok: false, error: 'ROOM_NOT_FOUND', message: '房间不存在' });
  }
  req.roomId = roomId;
  req.room = room;
  return next();
});

/** 加入房间前的存在性校验 */
app.get('/api/rooms/:roomId', (req, res) => {
  res.json({ ok: true, roomId: req.roomId, serverTime: Date.now() });
});

/**
 * 轮询接口。
 * role=A：记录 A 端轮询时间（房间存续唯一依据）；role=B 不计入活跃度。
 */
app.get('/api/rooms/:roomId/state', (req, res) => {
  const role = String(req.query.role || '').toUpperCase();
  if (role === 'A') store.markSeen(req.roomId);
  res.json(publicRoom(req.room));
});

// ---------------------------------------------------------------- 推送消息

app.post('/api/rooms/:roomId/messages', async (req, res, next) => {
  try {
    const room = req.room;
    const now = Date.now();

    // 服务器丢弃距上一条消息 3 秒内提交的新消息
    if (room.lastPushAt && now - room.lastPushAt < config.discardWindowMs) {
      console.log(`[push] 房间 ${room.roomId} 命中 3 秒丢弃窗口，已丢弃`);
      return res.json({ ok: true, discarded: true, serverTime: now, message: publicMessage(room.message) });
    }

    const body = req.body || {};
    const text = typeof body.text === 'string' ? body.text : '';
    if (text.length > config.maxTextLength) {
      return res.status(400).json({
        ok: false,
        error: 'TEXT_TOO_LONG',
        message: `文本不得超过 ${config.maxTextLength} 字`,
      });
    }

    const { expiresAt, invalid } = resolveExpireAt(body.expireAt, now);
    if (invalid) {
      return res.status(400).json({ ok: false, error: 'INVALID_EXPIRE_AT', message: '存活期格式应为 HH:MM' });
    }

    // 每次推送整条覆盖：文本、背景色、字体色、存活期全部以新消息为准
    room.message = {
      text,
      bg: store.normHex(body.bg, '#ffffff'),
      fg: store.normHex(body.fg, '#000000'),
      expiresAt,
      createdAt: now,
      destroy: false,
    };
    room.lastPushAt = now;

    await store.persist(room);
    expiry.schedule(room);

    console.log(`[push] 房间 ${room.roomId} 更新消息（${text.length} 字，存活期 ${expiresAt ? new Date(expiresAt).toISOString() : '永久'}）`);
    return res.json({ ok: true, serverTime: now, message: publicMessage(room.message) });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------- 设置

app.put('/api/rooms/:roomId/settings', async (req, res, next) => {
  try {
    const room = req.room;
    const body = req.body || {};

    const rawFont = body.fontSize;
    const fontSize = typeof rawFont === 'number' ? rawFont : Number(String(rawFont ?? '').trim());

    // 非法输入（小于 24 或非数字）：报错，并把房间字号恢复为 42
    if (!Number.isInteger(fontSize) || fontSize < config.minFontSize) {
      room.settings.fontSize = config.defaultFontSize;
      await store.persist(room);
      return res.status(400).json({
        ok: false,
        error: 'INVALID_FONT_SIZE',
        message: `字号必须是不小于 ${config.minFontSize} 的整数，已恢复为 ${config.defaultFontSize}`,
        settings: room.settings,
        serverTime: Date.now(),
      });
    }

    const hasNightStart = body.nightStart !== null && body.nightStart !== undefined && body.nightStart !== '';
    const hasNightEnd = body.nightEnd !== null && body.nightEnd !== undefined && body.nightEnd !== '';
    const nightStart = hasNightStart ? store.normalizeTime(body.nightStart) : null;
    const nightEnd = hasNightEnd ? store.normalizeTime(body.nightEnd) : null;

    if ((hasNightStart && nightStart === null) || (hasNightEnd && nightEnd === null)) {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_NIGHT_TIME',
        message: '夜间时间格式应为 HH:MM，或留空以关闭夜间模式',
      });
    }

    room.settings = { fontSize, nightStart, nightEnd };
    await store.persist(room);

    return res.json({ ok: true, serverTime: Date.now(), settings: room.settings });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------- 静态资源

app.use(express.static(config.publicDir, { etag: true, lastModified: true, maxAge: 0 }));

app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'NOT_FOUND' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(config.publicDir, 'index.html'));
});

// ---------------------------------------------------------------- 错误处理

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'BAD_JSON' });
  }
  console.error('[server] 未处理错误：', err);
  return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
});

// ---------------------------------------------------------------- 启动

let sweepTimer = null;

async function main() {
  const rooms = await store.init();

  // 重启后重建所有未到期的存活期定时器
  expiry.restoreAll(rooms);

  // 24 小时无 A 端轮询即回收房间；顺带回写心跳
  sweepTimer = setInterval(async () => {
    try {
      const removed = await store.sweep();
      for (const roomId of removed) expiry.cancel(roomId);
      if (removed.length) console.log(`[sweep] 已回收房间：${removed.join(', ')}`);
      await store.flushDirty();
    } catch (err) {
      console.error('[sweep] 巡检失败：', err.message);
    }
  }, config.sweepIntervalMs);
  sweepTimer.unref?.();

  const server = app.listen(config.port, config.host, () => {
    const offsetMin = -new Date().getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    console.log(`[server] 101实时通知 已启动：http://${config.host}:${config.port}`);
    console.log(`[server] 服务器时间：${new Date().toString()} (UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')})`);
    console.log('[server] 注意：存活期销毁、房间回收、3 秒丢弃窗口均以该时区的服务器时间为准');
  });

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`[server] 收到 ${signal}，正在保存数据并退出…`);
    if (sweepTimer) clearInterval(sweepTimer);
    await new Promise((resolve) => server.close(resolve));
    await store.shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[server] 启动失败：', err);
  process.exit(1);
});
