/* ============================================================
   core.js · 通用工具：DOM、Toast、确认框、localStorage 会话
   ============================================================ */

window.RTN = window.RTN || {};

(function (RTN) {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function show(el) { if (el) el.classList.remove('is-hidden'); }
  function hide(el) { if (el) el.classList.add('is-hidden'); }

  // ---------------------------------------------------------- Toast

  let toastTimer = 0;

  function toast(text, ms) {
    const el = $('toast');
    if (!el) return;
    el.textContent = text;
    show(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hide(el), ms || 2600);
  }

  // ---------------------------------------------------------- 确认对话框

  let dialogResolve = null;

  function dialog(options) {
    const opts = options || {};
    return new Promise((resolve) => {
      $('dialogTitle').textContent = opts.title || '提示';
      $('dialogText').textContent = opts.text || '';
      $('dialogOk').textContent = opts.okText || '确定';
      $('dialogCancel').textContent = opts.cancelText || '取消';
      $('dialogCancel').classList.toggle('is-hidden', opts.showCancel === false);
      show($('dialogModal'));
      dialogResolve = resolve;
    });
  }

  function closeDialog(value) {
    hide($('dialogModal'));
    const resolve = dialogResolve;
    dialogResolve = null;
    if (resolve) resolve(value);
  }

  $('dialogOk').addEventListener('click', () => closeDialog(true));
  $('dialogCancel').addEventListener('click', () => closeDialog(false));

  // ---------------------------------------------------------- 会话存储

  const SESSION_KEY = 'rtn.session.v1';

  const session = {
    get() {
      try {
        return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      } catch (err) {
        return null;
      }
    },
    set(value) {
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(value)); } catch (err) { /* 隐私模式忽略 */ }
    },
    clear() {
      try { localStorage.removeItem(SESSION_KEY); } catch (err) { /* 忽略 */ }
    },
  };

  /**
   * 「加入过的房间」小账本：房间号 -> 密码。
   *
   * 与 session（当前会话）分开存放，所以点「退出房间」不会把密码弄丢，
   * 下次在「加入」面板里可以直接一键重新进入，不用再输一遍密码。
   */
  const KNOWN_ROOMS_KEY = 'rtn.rooms.v1';
  const KNOWN_ROOMS_MAX = 20;

  const knownRooms = {
    all() {
      try {
        const map = JSON.parse(localStorage.getItem(KNOWN_ROOMS_KEY) || '{}');
        return map && typeof map === 'object' ? map : {};
      } catch (err) {
        return {};
      }
    },
    write(map) {
      try { localStorage.setItem(KNOWN_ROOMS_KEY, JSON.stringify(map)); } catch (err) { /* 忽略 */ }
    },
    get(roomId) {
      if (!roomId) return null;
      return this.all()[roomId] || null;
    },
    remember(roomId, password) {
      if (!roomId) return;
      const map = this.all();
      map[roomId] = { password: password || null, at: Date.now() };
      // 只保留最近使用的若干个，避免无限增长
      const keep = Object.keys(map)
        .sort((a, b) => map[b].at - map[a].at)
        .slice(0, KNOWN_ROOMS_MAX);
      const trimmed = {};
      for (const key of keep) trimmed[key] = map[key];
      this.write(trimmed);
    },
    forget(roomId) {
      const map = this.all();
      if (map[roomId]) {
        delete map[roomId];
        this.write(map);
      }
    },
    /** 最近使用过的房间 */
    latest() {
      const map = this.all();
      const keys = Object.keys(map).sort((a, b) => map[b].at - map[a].at);
      if (!keys.length) return null;
      return { roomId: keys[0], password: map[keys[0]].password || null, at: map[keys[0]].at };
    },
  };

  // ---------------------------------------------------------- 其他

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  RTN.dom = { $, show, hide };
  RTN.toast = toast;
  RTN.dialog = dialog;
  RTN.alert = (text, title) => dialog({ title: title || '提示', text, showCancel: false });
  RTN.session = session;
  RTN.knownRooms = knownRooms;
  RTN.sleep = sleep;
})(window.RTN);
