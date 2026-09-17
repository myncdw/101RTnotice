/* ============================================================
   app.js · 主控制器
   房间入口 / 身份切换 / A 端轮询渲染 / B 端编辑推送 / 房间设置
   ============================================================ */

(function (RTN) {
  'use strict';

  const { $, show, hide } = RTN.dom;

  const MAX_TEXT = 100;
  const MIN_FONT_SIZE = 24;
  const DEFAULT_FONT_SIZE = 42;

  const POLL_MS_A = 5000;         // A 端 5 秒轮询
  const POLL_MS_B = 30000;        // B 端 30 秒轮询（同步设置 / 感知房间回收）
  const PUSH_LOADING_MS = 5000;   // 点击后 loading 5 秒才正式提交
  const PUSH_COOLDOWN_MS = 10000; // 同一设备 10 秒内不能提交第二次
  const PUSH_RETRY_MAX = 3;       // 失败后最多重试 3 次
  const PUSH_RETRY_INTERVAL = 3000;

  const DEFAULT_SETTINGS = { fontSize: DEFAULT_FONT_SIZE, nightStart: '20:00', nightEnd: '06:00' };

  /** 房间号：与 src/config.js 的 roomIdLength / roomIdAlphabet 保持一致 */
  const ROOM_ID_LENGTH = 4;
  const ROOM_ID_RE = new RegExp(`^[A-Z0-9]{${ROOM_ID_LENGTH}}$`);
  const ROOM_ID_HINT = `房间号应为 ${ROOM_ID_LENGTH} 位字母或数字`;

  /** 密码长度下限（服务端不做强度校验，仅客户端约束） */
  const MIN_PASSWORD_LENGTH = 6;

  const state = {
    roomId: null,
    role: null,          // 'view' | 'edit' | null
    screen: null,        // 'identity' | 'edit' | 'settings' | 'view'
    settings: { ...DEFAULT_SETTINGS },
    message: null,
    /** 房间的加密参数 { v, salt, iter, check }，未加密为 null */
    enc: null,
    /** 当前房间的密码（存于 localStorage，A 端无人值守自动解密依赖它） */
    password: null,
    lastText: null,
    firstLoadDone: false,
    pollTimer: 0,
    pollInterval: POLL_MS_A,
    pushBusy: false,
    lastPushClickAt: 0,
    pendingRoomId: null,
    pendingPassword: null,
  };

  let wakeLock = null;

  // ================================================================
  // HTTP
  // ================================================================

  function httpError(code, message, data, status) {
    const err = new Error(message || code);
    err.code = code;
    err.data = data || null;
    err.status = status || 0;
    return err;
  }

  async function request(path, options) {
    let res;
    try {
      res = await fetch(path, options);
    } catch (err) {
      throw httpError('NETWORK_ERROR', '网络不可用');
    }

    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      data = null;
    }

    if (res.status === 404) throw httpError('ROOM_NOT_FOUND', '房间不存在', data, 404);
    if (!res.ok) {
      throw httpError((data && data.error) || 'HTTP_ERROR', (data && data.message) || `HTTP ${res.status}`, data, res.status);
    }
    return data;
  }

  const jsonInit = (method, body) => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

  const API = {
    createRoom: (roomId, enc) =>
      request('/api/rooms', jsonInit('POST', { roomId: roomId || null, enc: enc || null })),
    checkRoom: (roomId) => request(`/api/rooms/${encodeURIComponent(roomId)}`),
    getState: (roomId, role) => request(`/api/rooms/${encodeURIComponent(roomId)}/state?role=${role}`),
    push: (roomId, payload) => request(`/api/rooms/${encodeURIComponent(roomId)}/messages`, jsonInit('POST', payload)),
    saveSettings: (roomId, payload) => request(`/api/rooms/${encodeURIComponent(roomId)}/settings`, jsonInit('PUT', payload)),
  };

  // ================================================================
  // 轮询
  // ================================================================

  function stopPolling() {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = 0;
  }

  function startPolling(intervalMs, role, immediate) {
    stopPolling();
    state.pollInterval = intervalMs;

    const loop = async () => {
      const startedAt = Date.now();
      try {
        const payload = await API.getState(state.roomId, role);
        await onState(payload, role);
      } catch (err) {
        if (err.code === 'ROOM_NOT_FOUND') {
          handleRoomGone();
          return;
        }
        // 网络 / 服务异常：保留当前画面，静默持续重试（不出现空白或报错画面）
      }
      const elapsed = Date.now() - startedAt;
      state.pollTimer = setTimeout(loop, Math.max(1000, intervalMs - elapsed));
    };

    // immediate：切换身份 / 进入查看时先立刻拉一次，避免首帧空白
    state.pollTimer = setTimeout(loop, immediate ? 0 : intervalMs);
  }

  async function onState(payload, role) {
    const previousSettings = JSON.stringify(state.settings);
    if (payload.settings) state.settings = payload.settings;
    if (payload.enc !== undefined) state.enc = payload.enc || null;
    state.message = payload.message || null;

    if (role === 'A') {
      const night = RTN.theme.isNight(state.settings);

      // 解密失败（密码不对 / 密文被篡改）：保留当前画面，不清屏
      const text = await resolvePlainText(state.message);
      if (text === null) {
        RTN.theme.applyShellTheme(night);
        console.warn('[rtn] 通知解密失败，已保留当前画面');
        return;
      }

      const changed = text !== state.lastText;
      await applyMessageToView(text);

      // 提示音：仅当内容非空、与上次不同、非夜间、且不是首屏加载时播放
      if (state.firstLoadDone && changed && text.trim() !== '' && !night) {
        RTN.audio.ding();
      }
      state.lastText = text;
      state.firstLoadDone = true;
      return;
    }

    // B 端：同步界面主题
    RTN.theme.applyShellTheme(RTN.theme.isNight(state.settings));
    if (state.screen === 'settings') {
      fillSettingsForm();
      if (JSON.stringify(state.settings) !== previousSettings) {
        RTN.toast('房间设置已被其他设备更新');
      }
    }
  }

  // ================================================================
  // A 端渲染
  // ================================================================

  /**
   * 把当前消息解析为可显示的明文。
   * @returns {Promise<string|null>} null 表示加密消息解密失败
   */
  async function resolvePlainText(message) {
    if (!message) return '';
    if (!message.enc) return message.text; // 明文（含销毁用的空格消息）
    if (!state.enc || !state.password) return null;
    return RTN.crypto.decryptText(state.roomId, state.password, state.enc, message.text);
  }

  async function applyMessageToView(plainOverride) {
    const night = RTN.theme.isNight(state.settings);
    RTN.theme.applyShellTheme(night);

    const text =
      typeof plainOverride === 'string' ? plainOverride : await resolvePlainText(state.message);
    if (text === null) return; // 解密失败，保持画面不动

    const msg = state.message;
    let bg = msg ? msg.bg : '#ffffff';
    let fg = msg ? msg.fg : '#000000';

    // 夜间模式：通知强制黑底白字，覆盖用户选择的配色
    if (night) {
      bg = '#000000';
      fg = '#ffffff';
    }

    RTN.renderer.render({
      text,
      bg,
      fg,
      fontSize: state.settings.fontSize,
      night,
    });
  }

  // ================================================================
  // 页面切换
  // ================================================================

  function goTo(screen) {
    state.screen = screen;
    stopPolling();

    hide($('appShell'));
    hide($('viewStage'));
    hide($('unlockBtn'));
    hide($('identityPanel'));
    hide($('editPanel'));
    hide($('settingsPanel'));

    if (screen === 'view') {
      show($('viewStage'));
      RTN.renderer.setVisible(true);
      applyMessageToView();
      requestWakeLock();
      if (RTN.audio.isUnlocked()) hide($('unlockBtn'));
      else show($('unlockBtn'));
      startPolling(POLL_MS_A, 'A', true);
      return;
    }

    RTN.renderer.setVisible(false);
    releaseWakeLock();
    exitFullscreen();

    show($('appShell'));
    $('roomBadge').textContent = state.roomId || '----';
    $('roleBadge').textContent = state.role === 'view' ? '查看端' : state.role === 'edit' ? '编辑端' : '';

    if (screen === 'identity') {
      $('roleBadge').textContent = '';
      hide($('btnHome'));
      show($('identityPanel'));
      RTN.theme.applyShellTheme(RTN.theme.isNight(state.settings));
      return;
    }

    show($('btnHome'));
    if (screen === 'edit') {
      show($('editPanel'));
      $('textCounter').textContent = `${$('editText').value.length}/${MAX_TEXT}`;
    } else if (screen === 'settings') {
      fillSettingsForm();
      show($('settingsPanel'));
    }
    RTN.theme.applyShellTheme(RTN.theme.isNight(state.settings));
    startPolling(POLL_MS_B, 'B');
  }

  function setRole(role) {
    state.role = role;
    // 注意：这里必须带上 password，否则切换身份会把已记住的密码冲掉，
    // A 端重载后就再也解不开加密通知了
    RTN.session.set({ roomId: state.roomId, role, password: state.password });
    if (role === 'view') {
      // 首屏（含切回查看）只显示内容，不播放提示音
      state.lastText = null;
      state.firstLoadDone = false;
      goTo('view');
      return;
    }
    goTo('edit');
  }

  // ================================================================
  // 房间入口
  // ================================================================

  function switchTab(tab) {
    const isCreate = tab === 'create';
    $('tabCreate').classList.toggle('is-active', isCreate);
    $('tabJoin').classList.toggle('is-active', !isCreate);
    $('createPane').classList.toggle('is-hidden', !isCreate);
    $('joinPane').classList.toggle('is-hidden', isCreate);
  }

  function showEntry() {
    stopPolling();
    RTN.renderer.setVisible(false);
    RTN.renderer.hide();
    hide($('appShell'));
    hide($('viewStage'));
    hide($('unlockBtn'));
    releaseWakeLock();
    exitFullscreen();

    state.roomId = null;
    state.role = null;
    state.message = null;
    state.enc = null;
    state.password = null;
    state.lastText = null;
    state.firstLoadDone = false;
    state.pushBusy = false;
    state.pendingRoomId = null;
    state.pendingPassword = null;

    // 重置入口弹窗
    $('customRoomInput').value = '';
    $('createPassword').value = '';
    $('btnCopyRoom').disabled = true;
    $('btnCreateEnter').disabled = true;
    $('btnCreate').disabled = false;
    $('btnCreate').textContent = '创建房间';
    hide($('joinError'));
    hide($('createError'));
    hide($('dialogModal'));
    switchTab('create');

    // 用「加入过的房间」预填加入面板：退出房间后重新加入不用再输密码
    const last = RTN.knownRooms.latest();
    $('joinInput').value = last ? last.roomId : '';
    $('joinPassword').value = last && last.password ? last.password : '';
    if (last && last.password) {
      $('joinHint').textContent = `已记住房间 ${last.roomId} 的密码，切到「加入」点一下即可进入`;
      show($('joinHint'));
    } else {
      hide($('joinHint'));
    }

    show($('entryModal'));
  }

  async function enterRoom(role) {
    hide($('entryModal'));
    show($('appShell'));
    $('roomBadge').textContent = state.roomId;

    let loaded = false;
    try {
      const payload = await API.getState(state.roomId, role === 'view' ? 'A' : 'B');
      if (payload.settings) state.settings = payload.settings;
      state.enc = payload.enc || null;
      state.message = payload.message || null;
      loaded = true;
    } catch (err) {
      if (err.code === 'ROOM_NOT_FOUND') {
        handleRoomGone();
        return;
      }
      RTN.toast('暂时无法连接服务器，将持续重试');
    }

    // 房间需要密码但本地没有（例如换了设备、清了浏览器数据）
    if (loaded && state.enc && !state.password) {
      await RTN.alert('该房间已设置密码，需要输入密码才能查看通知', '提示');
      showEntry();
      return;
    }

    // 本地有密码时先验一次，避免密码不对却静默显示空白
    if (loaded && state.enc && state.password) {
      const ok = await RTN.crypto.verifyPassword(state.roomId, state.password, state.enc);
      if (!ok) {
        RTN.session.clear();
        await RTN.alert('房间密码不正确，请重新输入', '提示');
        showEntry();
        return;
      }
    }

    state.lastText = null;
    state.firstLoadDone = false;
    RTN.theme.applyShellTheme(RTN.theme.isNight(state.settings));

    if (role) setRole(role);
    else goTo('identity');
  }

  async function restoreSession() {
    const saved = RTN.session.get();
    if (!saved || !saved.roomId) {
      showEntry();
      return;
    }
    state.roomId = saved.roomId;
    state.password = saved.password || null;
    await enterRoom(saved.role || null);
  }

  // ================================================================
  // 房间消失（含被回收）
  // ================================================================

  async function handleRoomGone() {
    stopPolling();
    RTN.session.clear(); // 清除本地保留的设置

    // 先收起界面，避免提示框背后残留上一个房间的内容
    RTN.renderer.setVisible(false);
    RTN.renderer.hide();
    hide($('appShell'));
    hide($('viewStage'));
    hide($('unlockBtn'));
    releaseWakeLock();
    exitFullscreen();

    await RTN.alert('房间不存在', '提示');
    showEntry();
  }

  // ================================================================
  // 屏幕常亮 / 全屏 / 横屏（尽力能力）
  // ================================================================

  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (err) {
      /* 尽力能力，失败时依赖系统「充电时不锁定屏幕」设置 */
    }
  }

  function releaseWakeLock() {
    try {
      if (wakeLock) wakeLock.release();
    } catch (err) { /* 忽略 */ }
    wakeLock = null;
  }

  async function requestFullscreenLandscape() {
    const el = document.documentElement;
    try {
      if (!document.fullscreenElement && el.requestFullscreen) {
        await el.requestFullscreen({ navigationUI: 'hide' });
      }
    } catch (err) { /* 尽力能力 */ }
    try {
      if (screen.orientation && screen.orientation.lock) {
        await screen.orientation.lock('landscape');
      }
    } catch (err) { /* 尽力能力 */ }
  }

  function exitFullscreen() {
    try {
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen();
    } catch (err) { /* 忽略 */ }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.screen === 'view') requestWakeLock();
  });

  // ================================================================
  // 入口弹窗交互
  // ================================================================

  $('tabCreate').addEventListener('click', () => switchTab('create'));
  $('tabJoin').addEventListener('click', () => switchTab('join'));

  $('btnRandomRoom').addEventListener('click', () => {
    hide($('createError'));
    $('customRoomInput').value = RTN.crypto.randomRoomId(ROOM_ID_LENGTH);
    $('btnCopyRoom').disabled = true;
    $('btnCreateEnter').disabled = true;
    state.pendingRoomId = null;
  });

  $('btnCreate').addEventListener('click', async () => {
    const btn = $('btnCreate');
    const errEl = $('createError');
    hide(errEl);

    const roomId = ($('customRoomInput').value || '').trim().toUpperCase();
    if (!ROOM_ID_RE.test(roomId)) {
      errEl.textContent = roomId ? ROOM_ID_HINT : '请先填写房间号，或点「随机房间号」';
      show(errEl);
      return;
    }

    const password = $('createPassword').value || '';
    if (password && password.length < MIN_PASSWORD_LENGTH) {
      errEl.textContent = `密码至少 ${MIN_PASSWORD_LENGTH} 位`;
      show(errEl);
      return;
    }
    if (password && !RTN.crypto.isSupported()) {
      errEl.textContent = '当前浏览器不支持加密，请换用现代 Chromium 系浏览器';
      show(errEl);
      return;
    }

    btn.disabled = true;
    btn.textContent = '创建中…';
    try {
      // 密码不发给服务端；只上传盐、迭代次数与校验密文
      const enc = password ? await RTN.crypto.buildEncParams(roomId, password) : null;
      const payload = await API.createRoom(roomId, enc);
      state.pendingRoomId = payload.roomId;
      state.pendingPassword = password || null;
      RTN.knownRooms.remember(payload.roomId, password || null);
      $('btnCopyRoom').disabled = false;
      $('btnCreateEnter').disabled = false;
      RTN.toast(password ? '加密房间已创建' : '房间已创建');
    } catch (err) {
      if (err.code === 'ROOM_EXISTS' || err.code === 'INVALID_ROOM_ID' || err.code === 'INVALID_ENC') {
        errEl.textContent = err.message || ROOM_ID_HINT;
      } else {
        errEl.textContent = '创建失败，请稍后重试';
      }
      show(errEl);
    } finally {
      btn.disabled = false;
      btn.textContent = '创建房间';
    }
  });

  $('btnCopyRoom').addEventListener('click', async () => {
    const roomId = ($('customRoomInput').value || '').trim().toUpperCase();
    if (!ROOM_ID_RE.test(roomId)) return;
    try {
      await navigator.clipboard.writeText(roomId);
      RTN.toast('房间号已复制');
    } catch (err) {
      RTN.toast(`复制失败，请手动记录：${roomId}`);
    }
  });

  $('btnCreateEnter').addEventListener('click', () => {
    if (!state.pendingRoomId) return;
    state.roomId = state.pendingRoomId;
    state.password = state.pendingPassword || null;
    // 密码存入本地：A 端重载后才能继续自动解密
    RTN.session.set({ roomId: state.roomId, role: null, password: state.password });
    enterRoom(null);
  });

  $('btnJoin').addEventListener('click', async () => {
    const errEl = $('joinError');
    hide(errEl);
    const roomId = ($('joinInput').value || '').trim().toUpperCase();

    if (!ROOM_ID_RE.test(roomId)) {
      errEl.textContent = ROOM_ID_HINT;
      show(errEl);
      return;
    }

    const btn = $('btnJoin');
    btn.disabled = true;
    try {
      const info = await API.checkRoom(roomId);
      let password = $('joinPassword').value || '';

      if (info.enc) {
        if (!password) {
          errEl.textContent = '该房间已设置密码，请输入密码';
          show(errEl);
          return;
        }
        if (!RTN.crypto.isSupported()) {
          errEl.textContent = '当前浏览器不支持解密，请换用现代 Chromium 系浏览器';
          show(errEl);
          return;
        }
        // 完全在本地校验，密码不会发给服务端
        const ok = await RTN.crypto.verifyPassword(roomId, password, info.enc);
        if (!ok) {
          errEl.textContent = '密码错误';
          show(errEl);
          return;
        }
      } else {
        password = null; // 未加密的房间忽略密码输入
      }

      state.roomId = roomId;
      state.password = password;
      RTN.session.set({ roomId, role: null, password });
      RTN.knownRooms.remember(roomId, password);
      enterRoom(null);
    } catch (err) {
      errEl.textContent = err.code === 'ROOM_NOT_FOUND' ? '房间不存在' : '连接失败，请重试';
      show(errEl);
    } finally {
      btn.disabled = false;
    }
  });

  $('joinInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') $('btnJoin').click();
  });

  $('customRoomInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') $('btnCreate').click();
  });

  // 只保留字母与数字，自动转大写
  for (const id of ['customRoomInput', 'joinInput']) {
    $(id).addEventListener('input', () => {
      const el = $(id);
      const cleaned = (el.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_ID_LENGTH);
      if (cleaned !== el.value) el.value = cleaned;
      if (id === 'joinInput') syncKnownPassword();
    });
  }

  /** 加入面板：输入的房间号若之前加入过，自动把密码填上（不覆盖已输入的内容） */
  function syncKnownPassword() {
    const roomId = ($('joinInput').value || '').trim().toUpperCase();
    const hint = $('joinHint');
    const known = ROOM_ID_RE.test(roomId) ? RTN.knownRooms.get(roomId) : null;

    if (known && known.password) {
      if (!$('joinPassword').value) $('joinPassword').value = known.password;
      hint.textContent = `已记住房间 ${roomId} 的密码`;
      show(hint);
      return;
    }
    hide(hint);
  }

  // ================================================================
  // 身份 / 导航
  // ================================================================

  $('btnView').addEventListener('click', async () => {
    // 解锁音频必须发生在该次点击事件的同一处理流程内
    RTN.audio.unlock();
    hide($('unlockBtn'));
    setRole('view');
    await requestFullscreenLandscape();
  });

  $('btnEdit').addEventListener('click', () => setRole('edit'));

  // 退出房间：只清当前会话，已记住的房间密码保留，方便一键重新加入
  $('btnLeave').addEventListener('click', async () => {
    const ok = await RTN.dialog({
      title: '退出房间',
      text: `确定退出房间 ${state.roomId} 吗？\n\n房间号与密码会保留在本机，下次可以直接重新加入。`,
      okText: '退出',
      cancelText: '取消',
    });
    if (!ok) return;
    RTN.session.clear();
    showEntry();
    RTN.toast('已退出房间');
  });

  // 忘记密码：连同小账本一起清除，下次必须重新输入
  $('btnForgetPassword').addEventListener('click', async () => {
    const ok = await RTN.dialog({
      title: '忘记本机保存的密码',
      text: '清除后需要重新输入密码才能进入本房间。通知本身不会受影响。',
      okText: '清除',
      cancelText: '取消',
    });
    if (!ok) return;
    RTN.knownRooms.forget(state.roomId);
    RTN.session.clear();
    showEntry();
    RTN.toast('已清除本机保存的密码');
  });

  $('btnHome').addEventListener('click', () => goTo('identity'));

  $('btnSettings').addEventListener('click', () => goTo('settings'));

  // 查看模式下界面无任何操作控件（避免 A 端被误触）：
  // 连点两下画面任意位置即可切回「身份 / 设置」界面
  let lastStageTapAt = 0;
  $('viewStage').addEventListener('click', () => {
    if (state.screen !== 'view') return;
    const now = Date.now();
    if (now - lastStageTapAt < 400) {
      lastStageTapAt = 0;
      goTo('identity');
      return;
    }
    lastStageTapAt = now;
  });

  // 重载后自动进入查看模式时，仍需一次人工点击来解锁提示音
  $('unlockBtn').addEventListener('click', async () => {
    RTN.audio.unlock();
    hide($('unlockBtn'));
    await requestFullscreenLandscape();
    RTN.toast('提示音已解锁');
  });

  // ================================================================
  // B 端编辑
  // ================================================================

  const textEl = $('editText');
  const bgSelect = $('bgSelect');
  const bgHex = $('bgHex');
  const bgPicker = $('bgPicker');

  textEl.addEventListener('input', () => {
    if (textEl.value.length > MAX_TEXT) {
      textEl.value = textEl.value.slice(0, MAX_TEXT);
    }
    $('textCounter').textContent = `${textEl.value.length}/${MAX_TEXT}`;
  });

  function syncBgControls() {
    const isCustom = bgSelect.value === 'custom';
    bgHex.disabled = !isCustom;
    bgPicker.disabled = !isCustom;
    if (!isCustom) {
      bgHex.value = bgSelect.value;
      bgPicker.value = bgSelect.value;
    }
  }

  bgSelect.addEventListener('change', syncBgControls);

  bgHex.addEventListener('input', () => {
    const v = (bgHex.value || '').trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(v)) bgPicker.value = v;
  });

  bgPicker.addEventListener('input', () => {
    bgHex.value = bgPicker.value.toLowerCase();
  });

  $('btnClearExpire').addEventListener('click', () => {
    $('expireAt').value = '';
  });

  function resolveBg() {
    if (bgSelect.value !== 'custom') return bgSelect.value;
    const v = (bgHex.value || '').trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test(v) ? v : null;
  }

  function countdownLoading(btn, ms) {
    return new Promise((resolve) => {
      const endAt = Date.now() + ms;
      btn.disabled = true;
      const paint = () => {
        const left = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
        btn.textContent = left > 0 ? `准备中… ${left}s` : '推送中…';
      };
      paint();
      const timer = setInterval(() => {
        if (Date.now() >= endAt) {
          clearInterval(timer);
          resolve();
          return;
        }
        paint();
      }, 200);
    });
  }

  async function pushWithRetry(payload) {
    let lastError = null;
    for (let attempt = 0; attempt <= PUSH_RETRY_MAX; attempt += 1) {
      try {
        return await API.push(state.roomId, payload);
      } catch (err) {
        if (err.code === 'ROOM_NOT_FOUND') throw err;
        lastError = err;
        if (attempt < PUSH_RETRY_MAX) await RTN.sleep(PUSH_RETRY_INTERVAL);
      }
    }
    throw lastError || httpError('PUSH_FAILED', '推送失败');
  }

  $('btnPush').addEventListener('click', async () => {
    if (state.pushBusy) return;

    const now = Date.now();
    const sinceLast = now - state.lastPushClickAt;
    if (state.lastPushClickAt && sinceLast < PUSH_COOLDOWN_MS) {
      RTN.toast(`请稍候，${Math.ceil((PUSH_COOLDOWN_MS - sinceLast) / 1000)} 秒后可再次推送`);
      return;
    }

    const text = textEl.value;
    if (text.length > MAX_TEXT) {
      RTN.toast(`文本不得超过 ${MAX_TEXT} 字`);
      return;
    }

    const bg = resolveBg();
    if (!bg) {
      RTN.toast('自定义颜色格式应为 #RRGGBB');
      return;
    }
    const fg = $('fgSelect').value;

    const expireRaw = ($('expireAt').value || '').trim();
    if (expireRaw) {
      const minutes = RTN.theme.parseHHMM(expireRaw);
      const d = new Date();
      const nowMinutes = d.getHours() * 60 + d.getMinutes();
      if (minutes !== null && minutes <= nowMinutes) {
        const ok = await RTN.dialog({
          title: '确认存活期',
          text: '将会在次日销毁此消息，是否确认',
          okText: '确认',
          cancelText: '取消',
        });
        if (!ok) return; // 取消则不提交
      }
    }

    state.pushBusy = true;
    state.lastPushClickAt = Date.now();
    const btn = $('btnPush');
    const hint = $('pushHint');
    hint.textContent = '';

    // 先 loading 5 秒再正式提交，用于避开服务器的 3 秒丢弃窗口
    await countdownLoading(btn, PUSH_LOADING_MS);

    // 加密房间：在提交前把明文换成密文（密钥已缓存，耗时极短）
    let payloadText = text;
    let enc = false;
    if (state.enc) {
      if (!state.password || !RTN.crypto.isSupported()) {
        hint.textContent = '本地缺少密码，无法加密，请重新加入房间。';
        RTN.toast('缺少密码，无法加密');
        state.pushBusy = false;
        btn.disabled = false;
        btn.textContent = '确认推送';
        return;
      }
      try {
        payloadText = await RTN.crypto.encryptText(state.roomId, state.password, state.enc, text);
        enc = true;
      } catch (err) {
        hint.textContent = '加密失败，未提交。';
        RTN.toast('加密失败');
        state.pushBusy = false;
        btn.disabled = false;
        btn.textContent = '确认推送';
        return;
      }
    }

    try {
      const result = await pushWithRetry({
        text: payloadText,
        enc,
        bg,
        fg,
        expireAt: expireRaw || null,
      });
      if (result && result.discarded) {
        hint.textContent = '该消息距上一条不足 3 秒，已被服务器丢弃。';
        RTN.toast('消息已被服务器丢弃');
      } else {
        hint.textContent = enc ? '推送成功（已加密）。' : '推送成功。';
        RTN.toast('推送成功');
      }
    } catch (err) {
      if (err.code === 'ROOM_NOT_FOUND') {
        state.pushBusy = false;
        btn.disabled = false;
        btn.textContent = '确认推送';
        handleRoomGone();
        return;
      }
      hint.textContent = `推送失败：${err.message || '请稍后重试'}`;
      RTN.toast('推送失败');
    } finally {
      state.pushBusy = false;
      btn.disabled = false;
      btn.textContent = '确认推送';
    }
  });

  // ================================================================
  // 房间设置
  // ================================================================

  function fillSettingsForm() {
    $('setFontSize').value = String(state.settings.fontSize);
    $('setNightStart').value = state.settings.nightStart || '';
    $('setNightEnd').value = state.settings.nightEnd || '';
    $('encInfo').textContent = state.enc ? '已开启（通知以密文存储）' : '未开启';
    $('btnForgetPassword').classList.toggle('is-hidden', !state.enc);
    hide($('settingsError'));
    $('settingsError').textContent = '';
    hide($('settingsSaved'));
  }

  function showSettingsError(message) {
    $('settingsError').textContent = message;
    show($('settingsError'));
    hide($('settingsSaved'));
  }

  $('btnClearNight').addEventListener('click', () => {
    $('setNightStart').value = '';
    $('setNightEnd').value = '';
  });

  $('btnSaveSettings').addEventListener('click', async () => {
    const raw = ($('setFontSize').value || '').trim();
    const parsed = Number(raw);
    let invalid = false;
    let fontSize = parsed;

    // 非法输入（小于 24 或非数字）：报错，并把字号恢复为 42
    if (!/^\d+$/.test(raw) || !Number.isInteger(parsed) || parsed < MIN_FONT_SIZE) {
      invalid = true;
      fontSize = DEFAULT_FONT_SIZE;
      $('setFontSize').value = String(DEFAULT_FONT_SIZE);
    }

    const nightStart = ($('setNightStart').value || '').trim() || null;
    const nightEnd = ($('setNightEnd').value || '').trim() || null;

    const btn = $('btnSaveSettings');
    btn.disabled = true;
    try {
      const payload = await API.saveSettings(state.roomId, { fontSize, nightStart, nightEnd });
      state.settings = payload.settings;
      RTN.theme.applyShellTheme(RTN.theme.isNight(state.settings));

      if (invalid) {
        $('setFontSize').value = String(DEFAULT_FONT_SIZE);
        $('setNightStart').value = state.settings.nightStart || '';
        $('setNightEnd').value = state.settings.nightEnd || '';
        showSettingsError('字号输入非法（须为不小于 24 的整数），已恢复为 42。');
      } else {
        hide($('settingsError'));
        $('settingsSaved').textContent = '设置已保存，房间内所有设备将同步生效。';
        show($('settingsSaved'));
      }
    } catch (err) {
      if (err.code === 'ROOM_NOT_FOUND') {
        btn.disabled = false;
        handleRoomGone();
        return;
      }
      if (err.code === 'INVALID_FONT_SIZE') {
        if (err.data && err.data.settings) {
          state.settings = err.data.settings;
          $('setNightStart').value = state.settings.nightStart || '';
          $('setNightEnd').value = state.settings.nightEnd || '';
        }
        $('setFontSize').value = String(DEFAULT_FONT_SIZE);
        showSettingsError('字号输入非法（须为不小于 24 的整数），已恢复为 42。');
      } else if (err.code === 'INVALID_NIGHT_TIME') {
        showSettingsError('夜间时间格式应为 HH:MM，或留空以关闭夜间模式。');
      } else {
        showSettingsError(err.message || '保存失败，请重试。');
      }
    } finally {
      btn.disabled = false;
    }
  });

  // ================================================================
  // 启动
  // ================================================================

  function boot() {
    RTN.renderer.init();
    syncBgControls();

    // 夜间边界兜底：即使不在轮询也保证界面主题跟随本地时间
    setInterval(() => {
      if (state.screen === 'view') return; // 由 5 秒轮询负责
      RTN.theme.applyShellTheme(RTN.theme.isNight(state.settings));
    }, 30000);

    restoreSession();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window.RTN);
