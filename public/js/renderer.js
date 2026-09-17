/* ============================================================
   renderer.js · A 端排版与渲染
   排版流程（PRD 4.3）：
     ① 优先自动换行
     ② 仍超出屏幕则逐步缩小字号，下限 24px
     ③ 24px 仍放不下则自动往复滚动（20 px/s，两端各停 5 秒，无滚动条）
   更新方式：只改 DOM，不整页刷新；内容无变化时不重复渲染
   ============================================================ */

(function (RTN) {
  'use strict';

  const MIN_FONT_SIZE = 24;
  const SCROLL_SPEED = 20;        // px/s
  const SCROLL_PAUSE = 5000;      // 两端各停留 5 秒
  const MAX_FRAME_DT = 120;       // 防止切回前台时位置跳跃

  const R = {
    stage: null,
    inner: null,
    textEl: null,
    sig: null,
    mode: 'fit',
    fontSize: MIN_FONT_SIZE,
    overflow: 0,
    pos: 0,
    dir: -1,
    waitUntil: 0,
    lastTs: 0,
    rafId: 0,
    visible: false,
  };

  function init() {
    R.stage = document.getElementById('viewStage');
    R.inner = document.getElementById('viewInner');
    R.textEl = document.getElementById('viewText');

    window.addEventListener('resize', () => {
      if (R.visible) applyLayout();
    });
    window.addEventListener('orientationchange', () => {
      setTimeout(() => {
        if (R.visible) applyLayout();
      }, 300);
    });
  }

  // ---------------------------------------------------------- 排版

  function stopScroll() {
    if (R.rafId) cancelAnimationFrame(R.rafId);
    R.rafId = 0;
  }

  function startScroll() {
    R.pos = 0;
    R.dir = -1;
    R.lastTs = 0;
    R.waitUntil = performance.now() + SCROLL_PAUSE;
    stopScroll();
    R.rafId = requestAnimationFrame(tick);
  }

  function tick(ts) {
    if (R.mode !== 'scroll') {
      R.rafId = 0;
      return;
    }

    let dt = R.lastTs ? ts - R.lastTs : 0;
    R.lastTs = ts;
    if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;

    if (dt > 0 && ts >= R.waitUntil) {
      R.pos += (R.dir * SCROLL_SPEED * dt) / 1000;

      if (R.pos <= -R.overflow) {
        R.pos = -R.overflow;
        R.dir = 1;
        R.waitUntil = ts + SCROLL_PAUSE;
      } else if (R.pos >= 0) {
        R.pos = 0;
        R.dir = -1;
        R.waitUntil = ts + SCROLL_PAUSE;
      }
      R.textEl.style.transform = `translateY(${R.pos.toFixed(2)}px)`;
    }

    R.rafId = requestAnimationFrame(tick);
  }

  /** 依据当前内容与字号重新排版 */
  function applyLayout() {
    if (!R.stage || !R.textEl) return;

    const availH = Math.max(1, Math.round(R.inner.clientHeight * 0.96));
    const availW = Math.max(1, Math.round(R.inner.clientWidth * 0.94));

    R.textEl.style.width = `${availW}px`;

    const fits = () => {
      const rect = R.textEl.getBoundingClientRect();
      return rect.height <= availH && rect.width <= availW + 1;
    };

    // 只缩小、不放大：初始值取设置中的字号
    let size = R.fontSize;
    R.textEl.style.fontSize = `${size}px`;

    if (!fits()) {
      while (size > MIN_FONT_SIZE) {
        size -= 1;
        R.textEl.style.fontSize = `${size}px`;
        if (fits()) break;
      }
    }

    const textH = R.textEl.getBoundingClientRect().height;
    R.overflow = Math.max(0, Math.round(textH - availH));

    stopScroll();

    if (R.overflow > 1) {
      // 24px 仍放不下 -> 自动往复滚动
      R.mode = 'scroll';
      R.inner.style.justifyContent = 'flex-start';
      R.textEl.style.transform = 'translateY(0px)';
      startScroll();
    } else {
      R.mode = 'fit';
      R.inner.style.justifyContent = 'center';
      R.textEl.style.transform = 'none';
    }
  }

  // ---------------------------------------------------------- 渲染

  /**
   * @param {{text:string,bg:string,fg:string,fontSize:number,night:boolean}} state
   */
  function render(state) {
    if (!R.stage) return;

    const sig = [state.text, state.bg, state.fg, state.fontSize, state.night ? 1 : 0].join('\u0000');
    if (sig === R.sig) return; // 内容无变化 -> 不重复渲染 DOM
    R.sig = sig;

    R.stage.style.backgroundColor = state.bg;
    R.textEl.style.color = state.fg;
    R.fontSize = state.fontSize;

    if (R.textEl.textContent !== state.text) {
      R.textEl.textContent = state.text;
    }

    applyLayout();
  }

  function setVisible(visible) {
    R.visible = !!visible;
    if (!R.visible) {
      stopScroll();
      R.mode = 'fit';
    }
  }

  function show() {
    if (R.stage) R.stage.classList.remove('is-hidden');
  }

  function hide() {
    if (R.stage) R.stage.classList.add('is-hidden');
  }

  RTN.renderer = { init, render, applyLayout, setVisible, show, hide };
})(window.RTN);
