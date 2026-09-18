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

/** 房间号规范化：去空格 + 转大写；格式非法返回 null */
function normalizeRoomId(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toUpperCase();
  return isValidRoomId(v) ? v : null;
}

/** 带错误码的业务异常，便于接口层映射为不同的 HTTP 状态 */
function roomError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
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

/** base64url 盐值与校验密文 */
const SALT_RE = /^[A-Za-z0-9_-]{16,64}$/;
const CHECK_RE = /^[A-Za-z0-9_.-]{8,512}$/;

/**
 * 规整加密参数。
 * 服务器只保存「盐 + 迭代次数 + 一段校验密文」，密码与密钥永远不落服务端。
 * @returns {{enc: object|null, invalid: boolean}}
 */
function normalizeEnc(raw) {
  if (raw === null || raw === undefined) return { enc: null, invalid: false };
  if (typeof raw !== 'object') return { enc: null, invalid: true };

  const salt = typeof raw.salt === 'string' ? raw.salt.trim() : '';
  const check = typeof raw.check === 'string' ? raw.check.trim() : '';
  const iter = Number(raw.iter);

  if (!SALT_RE.test(salt)) return { enc: null, invalid: true };
  if (!CHECK_RE.test(check)) return { enc: null, invalid: true };
  if (!Number.isInteger(iter) || iter < 10000 || iter > 2000000) {
    return { enc: null, invalid: true };
  }
  return { enc: { v: 1, salt, iter, check }, invalid: false };
}

/**
 * 规整自定义字体族。
 * 返回值会经 CSSOM 赋给 element.style.fontFamily，本身无法注入额外声明，
 * 这里再剔掉分隔符与控制字符，并限制长度，避免存垃圾数据。
 * @returns {string|null} null 表示使用系统默认字体栈
 */
function normalizeFontFamily(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[<>{};\\]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, config.maxFontFamilyLength);
}

function defaultSettings() {
  return {
    fontSize: config.defaultFontSize,
    nightStart: config.defaultNightStart,
    nightEnd: config.defaultNightEnd,
    fontFamily: null,
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
  const enc = raw.enc === true;
  // 加密消息的 text 是密文信封，用更宽的上限
  const limit = enc ? config.maxEncryptedTextLength : config.maxTextLength;
  return {
    text: typeof raw.text === 'string' ? raw.text.slice(0, limit) : '',
    enc,
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
      fontFamily: normalizeFontFamily(s.fontFamily),
    },
    enc: normalizeEnc(r.enc).enc,
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
    enc: room.enc || null,
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
  const skipped = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const roomId = entry.name;
    if (!isValidRoomId(roomId)) {
      // 常见于房间号长度改版后残留的旧目录：只忽略，不删除
      skipped.push(roomId);
      continue;
    }
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
  if (skipped.length) {
    const head = skipped.slice(0, 10).join(', ');
    console.warn(
      `[store] 忽略 ${skipped.length} 个不符合房间号规则的目录（未删除）：${head}${skipped.length > 10 ? ' …' : ''}`
    );
  }
  return [...rooms.values()];
}

/**
 * 创建房间。
 * @param {string|null} [customRoomId] 自定义房间号；留空则随机生成。
 *   已被占用或格式非法时抛出带 code 的异常（ROOM_EXISTS / INVALID_ROOM_ID），
 *   两种情况返回的错误文案一致，避免被用来探测某个房间号是否存在。
 * @param {object|null} [enc] 客户端的加密参数 { salt, iter, check }；null 表示不加密。
 */
async function createRoom(customRoomId, enc) {
  const hasCustom =
    customRoomId !== undefined && customRoomId !== null && String(customRoomId).trim() !== '';

  let roomId;

  if (hasCustom) {
    roomId = normalizeRoomId(customRoomId);
    if (!roomId) {
      throw roomError('INVALID_ROOM_ID', `房间号应为 ${config.roomIdLength} 位字母或数字`);
    }
    if (rooms.has(roomId) || fs.existsSync(roomDir(roomId))) {
      throw roomError('ROOM_EXISTS', '房间号已被占用，请换一个');
    }
  } else {
    roomId = null;
    for (let i = 0; i < 32; i += 1) {
      const candidate = newRoomId();
      if (!rooms.has(candidate) && !fs.existsSync(roomDir(candidate))) {
        roomId = candidate;
        break;
      }
    }
    if (!roomId) throw new Error('无法生成唯一房间号');
  }

  const now = Date.now();
  const room = {
    roomId,
    createdAt: now,
    lastSeenA: now,
    lastPushAt: 0,
    settings: defaultSettings(),
    enc: enc || null,
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
    enc: false,
    bg: '#ffffff',
    fg: '#000000',
    expiresAt: null,
    createdAt: Date.now(),
    destroy: true,
  };
  await persist(room);
  return room;
}

/**
 * 房间回收：连续 roomRecycleMs 无 A 端轮询。
 * roomRecycleMs 为 0 / null 时表示已关闭回收，直接返回空数组。
 */
async function sweep() {
  if (!config.roomRecycleMs) return [];

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
  normalizeRoomId,
  normalizeEnc,
  normalizeFontFamily,
  roomError,
  normHex,
  normalizeTime,
  TIME_RE,
};
