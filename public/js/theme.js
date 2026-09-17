/* ============================================================
   theme.js · 夜间模式判定与界面主题
   判定依据：各设备自身的本地时间
   ============================================================ */

(function (RTN) {
  'use strict';

  /** "HH:MM" -> 一天中的分钟数；非法/留空返回 null */
  function parseHHMM(value) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value == null ? '' : value).trim());
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  /**
   * 是否处于夜间时段。
   * - 开始或结束任一留空 => 关闭夜间模式
   * - 支持跨午夜（如 20:00 – 06:00）
   */
  function isNight(settings, date) {
    if (!settings) return false;
    const start = parseHHMM(settings.nightStart);
    const end = parseHHMM(settings.nightEnd);
    if (start === null || end === null) return false;
    if (start === end) return false;

    const d = date || new Date();
    const cur = d.getHours() * 60 + d.getMinutes();

    if (start < end) return cur >= start && cur < end;
    return cur >= start || cur < end;
  }

  /** 应用界面深浅主题（仅影响界面，不影响消息配色） */
  function applyShellTheme(night) {
    document.documentElement.setAttribute('data-theme', night ? 'dark' : 'light');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', night ? '#000000' : '#ffffff');
  }

  RTN.theme = { parseHHMM, isNight, applyShellTheme };
})(window.RTN);
