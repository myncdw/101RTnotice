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

  // ---------------------------------------------------------- 其他

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  RTN.dom = { $, show, hide };
  RTN.toast = toast;
  RTN.dialog = dialog;
  RTN.alert = (text, title) => dialog({ title: title || '提示', text, showCancel: false });
  RTN.session = session;
  RTN.sleep = sleep;
})(window.RTN);
