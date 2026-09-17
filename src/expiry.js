'use strict';

const store = require('./store');

/**
 * 存活期调度。
 *
 * - 推送成功 / 设置变更后调用 schedule(room) 重建定时器；
 * - 容器重启时调用 restoreAll(rooms)：
 *     未到期 -> 按原定时刻继续生效
 *     已过期 -> 立即补一次销毁
 */

/** setTimeout 的最大延迟（约 24.8 天） */
const MAX_DELAY = 2147483647;

/** @type {Map<string, NodeJS.Timeout>} */
const timers = new Map();

function cancel(roomId) {
  const timer = timers.get(roomId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(roomId);
  }
}

async function fire(roomId) {
  timers.delete(roomId);
  try {
    const room = await store.destroyMessage(roomId);
    if (room) {
      console.log(`[expiry] 房间 ${roomId} 的存活期到点，已写入空白消息`);
    }
  } catch (err) {
    console.error(`[expiry] 房间 ${roomId} 销毁失败：`, err.message);
  }
}

function schedule(room) {
  if (!room) return;
  cancel(room.roomId);

  const expiresAt = room.message && room.message.expiresAt;
  if (!expiresAt) return;

  const delay = Math.max(0, Math.min(MAX_DELAY, expiresAt - Date.now()));
  const timer = setTimeout(() => {
    fire(room.roomId);
  }, delay);
  timers.set(room.roomId, timer);
}

function restoreAll(rooms) {
  let pending = 0;
  let overdue = 0;
  for (const room of rooms) {
    const expiresAt = room.message && room.message.expiresAt;
    if (!expiresAt) continue;
    if (expiresAt <= Date.now()) {
      overdue += 1;
      fire(room.roomId);
    } else {
      pending += 1;
      schedule(room);
    }
  }
  if (pending || overdue) {
    console.log(`[expiry] 重建存活期定时器：${pending} 个待到期，${overdue} 个已过期立即销毁`);
  }
}

module.exports = { schedule, cancel, restoreAll };
