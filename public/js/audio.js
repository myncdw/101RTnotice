/* ============================================================
   audio.js · 提示音
   - 由代码合成的「叮」一声，音量 100%，仅播放 1 次
   - 必须在用户点击事件的同一处理流程内调用 unlock()
   ============================================================ */

(function (RTN) {
  'use strict';

  let ctx = null;
  let unlocked = false;

  function getContext() {
    if (ctx) return ctx;
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    try {
      ctx = new AudioCtor();
    } catch (err) {
      ctx = null;
    }
    return ctx;
  }

  /**
   * 解锁音频。必须在点击事件的同步处理流程内调用。
   * 做法：resume() + 播放一个 1 帧的静音 buffer，彻底解除自动播放限制。
   */
  function unlock() {
    const c = getContext();
    if (!c) return false;
    try {
      if (c.state === 'suspended') c.resume();
      const buffer = c.createBuffer(1, 1, 22050);
      const source = c.createBufferSource();
      source.buffer = buffer;
      source.connect(c.destination);
      source.start(0);
      unlocked = true;
      return true;
    } catch (err) {
      return false;
    }
  }

  function isUnlocked() {
    return unlocked && !!ctx && ctx.state === 'running';
  }

  /** 播放一声合成的「叮」 */
  function ding() {
    const c = getContext();
    if (!c || c.state !== 'running' || !unlocked) return false;

    const t0 = c.currentTime;

    // 主增益：音量 100%
    const master = c.createGain();
    master.gain.value = 1;
    master.connect(c.destination);

    // 基音
    const osc1 = c.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(1244.5, t0); // D6
    const gain1 = c.createGain();
    gain1.gain.setValueAtTime(0.0001, t0);
    gain1.gain.exponentialRampToValueAtTime(1.0, t0 + 0.008);
    gain1.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55);
    osc1.connect(gain1);
    gain1.connect(master);
    osc1.start(t0);
    osc1.stop(t0 + 0.6);

    // 泛音：让「叮」更清脆
    const osc2 = c.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(2489.0, t0); // D#7
    const gain2 = c.createGain();
    gain2.gain.setValueAtTime(0.0001, t0);
    gain2.gain.exponentialRampToValueAtTime(0.35, t0 + 0.005);
    gain2.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
    osc2.connect(gain2);
    gain2.connect(master);
    osc2.start(t0);
    osc2.stop(t0 + 0.3);

    return true;
  }

  RTN.audio = { unlock, ding, isUnlocked, getContext };
})(window.RTN);
