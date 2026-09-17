'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

/**
 * 数据落盘结构（卷映射到 /data）：
 *
 *   /data/rooms/<ROOMID>/room.json      房间元信息 + 房间级设置 + 心跳
 *   /data/rooms/<ROOMID>/message.json   当前消息（消息单独存放于独立文件夹）
 *
 * 内存中的 Map 为唯一事实来源，任何变更都同步原子写盘，保证重启不丢。
 */

const roomsRoot = path.join(config.dataDir, 'rooms');

/** @type {Map<string, object>} */
const rooms = new Map();

/** lastSeenA 变更频繁（A 端每 5 秒轮询），攒批回写以降低磁盘写入 */
const dirtySeen = new Set();

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const ROOM_ID_RE = new RegExp(`^[${config.roomIdAlphabet}]{${config.roomIdLength}}$`);

// ---------------------------------------------------------------- 路径

function roomDir(roomId) {
  return path.join(roomsRoot, roomId);
}
function metaFile(roomId) {
  return path.join(roomDir(roomId), 'room.json');
}
function messageFile(roomId) {
  return path.join(roomDir(roomId), 'message.json');
}

// ---------------------------------------------------------------- 工具

function isValidRoomId(roomId) {
  return typeof roomId === 'string' && ROOM_ID_RE.test(roomId);
}

function normalizeTime(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return TIME_RE.test(v) ? v : null;
}

function normHex(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const v = value.trim();
  if (!HEX_RE.test(v)) return fallback;
  if (v.length === 4) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
  }
  return v.toLowerCase();
}

function defaultSettings() {
  return {
    fontSize: config.defaultFontSize,
    nightStart: config.defaultNightStart,
    nightEnd: config.defaultNightEnd,
  };
}

function newRoomId() {
  const alphabet = config.roomIdAlphabet;
  const bytes = crypto.randomBytes(config.roomIdLength);
  let out = '';
  for (let i = 0; i < config.roomIdLength; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

/** 原子写：写临时文件 -> fsync -> rename，避免断电/重启产生半截 JSON */
async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const payload = JSON.stringify(data, null, 2);
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(payload, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// ---------------------------------------------------------------- 规整

function normalizeMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const expiresAt = Number(raw.expiresAt);
  return {
    text: typeof raw.text === 'string' ? raw.text.slice(0, config.maxTextLength) : '',
    bg: normHex(raw.bg, '#ffffff'),
    fg: normHex(raw.fg, '#000000'),
    expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null,
    createdAt: Number(raw.createdAt) || Date.now(),
    destroy: raw.destroy === true,
  };
}

function normalizeRoom(raw, roomId) {
  const now = Date.now();
  const r = raw && typeof raw === 'object' ? raw : {};
  const s = r.settings && typeof r.settings === 'object' ? r.settings : {};

  let fontSize = Number(s.fontSize);
  if (!Number.isInteger(fontSize) || fontSize < config.minFontSize) {
    fontSize = config.defaultFontSize;
  }

  const createdAt = Number(r.createdAt) || now;
  const lastSeenA = Number(r.lastSeenA) || createdAt;

  return {
    roomId,
    createdAt,
    lastSeenA,
    lastPushAt: Number(r.lastPushAt) || 0,
    settings: {
      fontSize,
      nightStart: normalizeTime(s.nightStart),
      nightEnd: normalizeTime(s.nightEnd),
    },
    message: normalizeMessage(r.message),
  };
}

function toMetaPayload(room) {
  return {
    roomId: room.roomId,
    createdAt: room.createdAt,
    lastSeenA: room.lastSeenA,
    lastPushAt: room.lastPushAt,
    settings: room.settings,
  };
}

// ---------------------------------------------------------------- 落盘

/** 完整持久化（元信息 + 消息） */
async function persist(room) {
  if (room.message) {
    await writeJsonAtomic(messageFile(room.roomId), room.message);
  } else {
    await fsp.rm(messageFile(room.roomId), { force: true });
  }
  await writeJsonAtomic(metaFile(room.roomId), toMetaPayload(room));
}

/** 仅持久化元信息 */
async function persistMeta(room) {
  await writeJsonAtomic(metaFile(room.roomId), toMetaPayload(room));
}

/** 把攒批的 lastSeenA 回写磁盘 */
async function flushDirty() {
  if (dirtySeen.size === 0) return;
  const ids = [...dirtySeen];
  dirtySeen.clear();
  for (const id of ids) {
    const room = rooms.get(id);
    if (!room) continue;
    try {
      await persistMeta(room);
    } catch (err) {
      console.error(`[store] 回写房间 ${id} 元信息失败：`, err.message);
      dirtySeen.add(id);
    }
  }
}

// ---------------------------------------------------------------- 对外

/** 启动时从数据目录恢复全部房间 */
async function init() {
  await fsp.mkdir(roomsRoot, { recursive: true });
  const entries = await fsp.readdir(roomsRoot, { withFileTypes: true });
  let loaded = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const roomId = entry.name;
    if (!isValidRoomId(roomId)) continue;
    try {
      const meta = await readJson(metaFile(roomId));
      const message = await readJson(messageFile(roomId));
      if (!meta && !message) continue;
      const merged = meta ? { ...meta, message } : { message };
      rooms.set(roomId, normalizeRoom(merged, roomId));
      loaded += 1;
    } catch (err) {
      console.error(`[store] 房间 ${roomId} 数据损坏，已跳过：`, err.message);
    }
  }

  console.log(`[store] 数据目录 ${roomsRoot}，已恢复 ${loaded} 个房间`);
  return [...rooms.values()];
}

async function createRoom() {
  let roomId = null;
  for (let i = 0; i < 16; i += 1) {
    const candidate = newRoomId();
    if (!rooms.has(candidate) && !fs.existsSync(roomDir(candidate))) {
      roomId = candidate;
      break;
    }
  }
  if (!roomId) throw new Error('无法生成唯一房间号');

  const now = Date.now();
  const room = {
    roomId,
    createdAt: now,
    lastSeenA: now,
    lastPushAt: 0,
    settings: defaultSettings(),
    message: null,
  };
  rooms.set(roomId, room);
  await persist(room);
  return room;
}

function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

async function removeRoom(roomId) {
  rooms.delete(roomId);
  dirtySeen.delete(roomId);
  await fsp.rm(roomDir(roomId), { recursive: true, force: true });
}

/** 记录 A 端轮询（房间存续的唯一依据，B 端轮询不计入） */
function markSeen(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.lastSeenA = Date.now();
  dirtySeen.add(roomId);
}

/**
 * 存活期到点：由服务器写入一条「背景白色 + 内容为单个空格」的新消息。
 * 该消息不触发 A 端提示音（A 端按「内容去空格后为空」判定）。
 */
async function destroyMessage(roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  // 已无存活期说明期间被新消息覆盖，忽略这次到点
  if (!room.message || !room.message.expiresAt) return null;

  room.message = {
    text: ' ',
    bg: '#ffffff',
    fg: '#000000',
    expiresAt: null,
    createdAt: Date.now(),
    destroy: true,
  };
  await persist(room);
  return room;
}

/** 房间回收：连续 24 小时无 A 端轮询 */
async function sweep() {
  const now = Date.now();
  const expired = [];
  for (const [roomId, room] of rooms) {
    if (now - room.lastSeenA >= config.roomRecycleMs) expired.push(roomId);
  }
  for (const roomId of expired) {
    await removeRoom(roomId);
  }
  return expired;
}

async function shutdown() {
  try {
    await flushDirty();
    for (const room of rooms.values()) {
      await persistMeta(room);
    }
  } catch (err) {
    console.error('[store] 退出前落盘失败：', err.message);
  }
}

module.exports = {
  init,
  createRoom,
  getRoom,
  removeRoom,
  markSeen,
  destroyMessage,
  sweep,
  flushDirty,
  persist,
  shutdown,
  isValidRoomId,
  normHex,
  normalizeTime,
  TIME_RE,
};
