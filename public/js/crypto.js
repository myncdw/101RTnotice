/* ============================================================
   crypto.js · 通知内容加密
   PBKDF2-HMAC-SHA256 派生密钥 + AES-GCM 认证加密，全部在浏览器完成。

   服务端只保存：
     - 盐值与迭代次数（用于重新派生密钥）
     - 一段校验密文（用于本地判断密码是否正确）
     - 通知的密文
   密码本身永远不离开浏览器，服务端无法解密任何内容。

   密文信封格式：  <版本>.<base64url(iv)>.<base64url(密文+认证标签)>
   以 roomId 作为 AES-GCM 的附加认证数据（AAD），防止密文被搬到别的房间。
   ============================================================ */

(function (RTN) {
  'use strict';

  const VERSION = 1;
  const SALT_BYTES = 16;
  const IV_BYTES = 12;
  const DEFAULT_ITERATIONS = 150000;
  const MIN_ITERATIONS = 10000;
  const MAX_ITERATIONS = 2000000;
  /** 校验密文加密的固定明文，解出来等于它就说明密码正确 */
  const CHECK_PLAINTEXT = 'rtn-ok';
  const ROOM_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function isSupported() {
    return !!(window.crypto && window.crypto.subtle && window.TextEncoder && window.TextDecoder);
  }

  // ---------------------------------------------------------- 编码

  function bytesToB64u(bytes) {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64uToBytes(text) {
    const s = String(text).replace(/-/g, '+').replace(/_/g, '/');
    const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
    const bin = atob(s + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  function randomBytes(n) {
    const b = new Uint8Array(n);
    window.crypto.getRandomValues(b);
    return b;
  }

  /** 客户端生成随机房间号（不占用服务端资源，真正占用发生在创建时） */
  function randomRoomId(length) {
    const bytes = randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i += 1) out += ROOM_ID_ALPHABET[bytes[i] % ROOM_ID_ALPHABET.length];
    return out;
  }

  // ---------------------------------------------------------- 密钥

  /** 同一个房间反复派生很浪费（每秒轮询会撞上），按 房间+密码+盐 缓存 */
  const keyCache = new Map();

  async function deriveKey(password, saltB64, iterations) {
    const base = await window.crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return window.crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: b64uToBytes(saltB64), iterations, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  function getKey(roomId, password, enc) {
    const cacheKey = `${roomId}\u0000${password}\u0000${enc.salt}\u0000${enc.iter}`;
    if (!keyCache.has(cacheKey)) {
      keyCache.set(cacheKey, deriveKey(password, enc.salt, enc.iter));
    }
    return keyCache.get(cacheKey);
  }

  function aadOf(roomId) {
    return encoder.encode(`rtn:${roomId}`);
  }

  async function encryptWithKey(key, roomId, plain) {
    const iv = randomBytes(IV_BYTES);
    const ct = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aadOf(roomId) },
      key,
      encoder.encode(plain)
    );
    return `${VERSION}.${bytesToB64u(iv)}.${bytesToB64u(new Uint8Array(ct))}`;
  }

  /** @returns {Promise<string|null>} null 表示认证失败（密码不对或数据被篡改） */
  async function decryptWithKey(key, roomId, envelope) {
    const parts = String(envelope).split('.');
    if (parts.length !== 3 || Number(parts[0]) !== VERSION) return null;
    try {
      const iv = b64uToBytes(parts[1]);
      const ct = b64uToBytes(parts[2]);
      const plain = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: aadOf(roomId) },
        key,
        ct
      );
      return decoder.decode(plain);
    } catch (err) {
      return null;
    }
  }

  // ---------------------------------------------------------- 对外

  /**
   * 创建加密房间时调用：生成盐、迭代次数与校验密文。
   * 返回值交给服务端保存，密码本身不发送。
   */
  async function buildEncParams(roomId, password) {
    const enc = {
      v: VERSION,
      salt: bytesToB64u(randomBytes(SALT_BYTES)),
      iter: DEFAULT_ITERATIONS,
      check: '',
    };
    const key = await deriveKey(password, enc.salt, enc.iter);
    enc.check = await encryptWithKey(key, roomId, CHECK_PLAINTEXT);
    return enc;
  }

  /** 加入房间时调用：完全在本地判断密码是否正确 */
  async function verifyPassword(roomId, password, enc) {
    if (!enc || !enc.salt || !enc.check) return false;
    try {
      const key = await getKey(roomId, password, enc);
      return (await decryptWithKey(key, roomId, enc.check)) === CHECK_PLAINTEXT;
    } catch (err) {
      return false;
    }
  }

  async function encryptText(roomId, password, enc, text) {
    const key = await getKey(roomId, password, enc);
    return encryptWithKey(key, roomId, text);
  }

  async function decryptText(roomId, password, enc, envelope) {
    try {
      const key = await getKey(roomId, password, enc);
      return decryptWithKey(key, roomId, envelope);
    } catch (err) {
      return null;
    }
  }

  RTN.crypto = {
    isSupported,
    randomRoomId,
    buildEncParams,
    verifyPassword,
    encryptText,
    decryptText,
    VERSION,
    DEFAULT_ITERATIONS,
    MIN_ITERATIONS,
    MAX_ITERATIONS,
  };
})(window.RTN);
