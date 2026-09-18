'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * 全局配置。所有可调参数集中在此，便于按 PRD 校准。
 */
module.exports = {
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 8686),

  /** 独立数据目录（卷映射到宿主机 / 命名卷） */
  dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
  publicDir: path.join(ROOT, 'public'),

  // ---------- 房间 ----------
  /** 房间号长度 */
  roomIdLength: 4,
  /** 房间号字符集：字母 + 数字 */
  roomIdAlphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  /**
   * 连续多久无 A 端轮询即回收房间。
   * 设为 0 / null 即**关闭回收**：房间与消息会一直保留。（留意磁盘占用）
   */
  roomRecycleMs: 24 * 60 * 60 * 1000,
  /** 巡检间隔（同时用于回写 lastSeenA） */
  sweepIntervalMs: 60 * 1000,

  // ---------- 消息 ----------
  /** 明文文本上限 100 字（客户端强制） */
  maxTextLength: 100,
  /** 密文上限：100 字明文经 AES-GCM + base64 后约 700 字符，留足余量 */
  maxEncryptedTextLength: 2000,
  /** 服务器丢弃距上一条消息 3 秒内提交的新消息 */
  discardWindowMs: 3000,

  // ---------- 设置 ----------
  defaultFontSize: 42,
  minFontSize: 24,
  defaultNightStart: '20:00',
  defaultNightEnd: '06:00',
  /** 自定义字体族名称的长度上限（留空即使用系统默认字体栈） */
  maxFontFamilyLength: 100,
};
