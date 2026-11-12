'use strict';
// C# 호스트에서 오는 H.264 프레임을 WebCodecs 로 디코딩해 캔버스에 그림 + 입력 전송.
(() => {
  const cv = document.getElementById('cv');
  const ctx = cv.getContext('2d', { alpha: false, desynchronized: true });
  const chip = document.getElementById('chip');
  const msgEl = document.getElementById('msg');
  const view = document.getElementById('view');

  function msg(t) { msgEl.textContent = t; msgEl.hidden = !t; }

  if (!('VideoDecoder' in window)) {
    msg('이 브라우저는 WebCodecs를 지원하지 않아요. 크롬 최신 버전을 쓰세요.');
    return;
  }

  // ───── 디코더 ─────
  let decoder = null, configured = false, baseTs = 0, frameNo = 0;
  let vw = 0, vh = 0, needKey = true;
  let fps = 0, bytes = 0, lastStat = performance.now(), frames = 0;

  function nalType(b, i) { return b[i] & 0x1f; }
  // AU 안을 훑어 키프레임 여부와 SPS 위치 찾기
  function scan(data) {
    let key = false, spsPos = -1;
    for (let i = 0; i + 4 < data.length; i++) {
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
        const t = nalType(data, i + 3);
        if (t === 5 || t === 7) key = true;
        if (t === 7 && spsPos < 0) spsPos = i + 3;
      }
    }
    return { key, spsPos };
  }
  // SPS 에서 codec 문자열(avc1.PPCCLL) 만들기
  function codecFromSps(data, pos) {
    const profile = data[pos + 1], constraints = data[pos + 2], level = data[pos + 3];
    const hex = n => n.toString(16).padStart(2, '0');
    return 'avc1.' + hex(profile) + hex(constraints) + hex(level);
  }

  function setupDecoder(codec) {
    decoder = new VideoDecoder({
      output: frame => {
        if (frame.displayWidth !== vw || frame.displayHeight !== vh) {
          vw = frame.displayWidth; vh = frame.displayHeight;
          cv.width = vw; cv.height = vh;
          layout();
        }
        ctx.drawImage(frame, 0, 0);
        frame.close();
        frames++;
        msg('');
      },
      error: e => { console.warn('decoder error', e); resetDecoder(); }
    });
    decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
    configured = true;
  }
  function resetDecoder() {
    try { decoder && decoder.close(); } catch {}
    decoder = null; configured = false; needKey = true;
  }

  function onFrame(buf) {
    const data = new Uint8Array(buf);
    bytes += data.length;
    const { key, spsPos } = scan(data);
    if (!configured) {
      if (!key || spsPos < 0) return;         // 키프레임(SPS 포함)부터 시작
      try { setupDecoder(codecFromSps(data, spsPos)); }
      catch (e) { try { setupDecoder('avc1.42E01E'); } catch { return; } }
    }
    if (needKey) { if (!key) return; needKey = false; }
    try {
      const chunk = new EncodedVideoChunk({
        type: key ? 'key' : 'delta',
        timestamp: (frameNo++) * (1000000 / 60),
        data
      });
      decoder.decode(chunk);
    } catch (e) { console.warn('decode fail', e); resetDecoder(); }
  }

  // ───── 화면 배치 (레터박스) ─────
  let box = { x: 0, y: 0, w: 1, h: 1 };
  function layout() {
    const W = view.clientWidth, H = view.clientHeight;
    if (!vw || !vh) return;
    const s = Math.min(W / vw, H / vh);
    box.w = vw * s; box.h = vh * s;
    box.x = (W - box.w) / 2; box.y = (H - box.h) / 2;
    cv.style.width = box.w + 'px';
    cv.style.height = box.h + 'px';
    cv.style.left = box.x + 'px';
    cv.style.top = box.y + 'px';
  }
  addEventListener('resize', layout);

  // ───── 통신 ─────
  let ws = null;
  function connect() {
    ws = new WebSocket(`ws://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => msg('화면 받는 중…');
    ws.onmessage = e => { if (e.data instanceof ArrayBuffer) onFrame(e.data); };
    ws.onclose = () => { msg('연결이 끊겼어요. 다시 연결하는 중…'); resetDecoder(); setTimeout(connect, 1000); };
    ws.onerror = () => {};
  }
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  connect();

  // 통계 표시
  setInterval(() => {
    const now = performance.now(), dt = (now - lastStat) / 1000;
    fps = Math.round(frames / dt);
    const mbps = (bytes * 8 / dt / 1e6).toFixed(1);
    frames = 0; bytes = 0; lastStat = now;
    chip.hidden = false;
    chip.textContent = `${fps}fps · ${mbps}Mbps`;
  }, 1000);

  // ───── 좌표 변환 ─────
  function norm(cx, cy) {
    return {
      x: Math.min(1, Math.max(0, (cx - box.x) / box.w)),
      y: Math.min(1, Math.max(0, (cy - box.y) / box.h))
    };
  }

  // ───── 마우스(PC 접속 시) ─────
  view.addEventListener('mousemove', e => { const p = norm(e.clientX, e.clientY); send({ t: 'mm', x: p.x, y: p.y }); });
  view.addEventListener('mousedown', e => { e.preventDefault(); const p = norm(e.clientX, e.clientY); send({ t: 'mb', b: e.button === 2 ? 2 : e.button === 1 ? 1 : 0, down: true, x: p.x, y: p.y }); });
  addEventListener('mouseup', e => { send({ t: 'mb', b: e.button === 2 ? 2 : e.button === 1 ? 1 : 0, down: false }); });
  view.addEventListener('contextmenu', e => e.preventDefault());
  view.addEventListener('wheel', e => { e.preventDefault(); send({ t: 'wh', dy: -Math.sign(e.deltaY) * 120, dx: 0 }); }, { passive: false });

  // ───── 터치(폰) — 직접 터치 방식: 누른 곳 클릭, 끌면 드래그, 두 손가락 스크롤 ─────
  let touchStart = 0, moved = false, down = false, longTimer = 0;
  view.addEventListener('touchstart', e => {
    e.preventDefault();
    if (e.touches.length === 1) {
      const t = e.touches[0], p = norm(t.clientX, t.clientY);
      touchStart = performance.now(); moved = false;
      send({ t: 'mm', x: p.x, y: p.y });
      clearTimeout(longTimer);
      longTimer = setTimeout(() => { if (!moved) { send({ t: 'mb', b: 2, down: true }); send({ t: 'mb', b: 2, down: false }); } }, 550);
    }
  }, { passive: false });
  view.addEventListener('touchmove', e => {
    e.preventDefault();
    if (e.touches.length === 1) {
      const t = e.touches[0], p = norm(t.clientX, t.clientY);
      moved = true; clearTimeout(longTimer);
      if (!down) { send({ t: 'mb', b: 0, down: true, x: p.x, y: p.y }); down = true; }
      else send({ t: 'mm', x: p.x, y: p.y });
    } else if (e.touches.length === 2) {
      send({ t: 'wh', dy: -Math.sign(e.touches[0].clientY - (view._py || e.touches[0].clientY)) * 120, dx: 0 });
      view._py = e.touches[0].clientY;
    }
  }, { passive: false });
  view.addEventListener('touchend', e => {
    e.preventDefault();
    clearTimeout(longTimer);
    if (down) { send({ t: 'mb', b: 0, down: false }); down = false; }
    else if (!moved && performance.now() - touchStart < 400) { send({ t: 'mb', b: 0, down: true }); send({ t: 'mb', b: 0, down: false }); }
    view._py = null;
  }, { passive: false });

  // ───── 키보드(물리 키) ─────
  const VK = {
    Backspace: 8, Tab: 9, Enter: 13, Escape: 27, Space: 32, Delete: 46,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34,
    ShiftLeft: 160, ShiftRight: 161, ControlLeft: 162, ControlRight: 163, AltLeft: 164, AltRight: 165,
    MetaLeft: 91
  };
  function vkFromCode(code) {
    if (VK[code] != null) return VK[code];
    if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
    if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
    if (/^F([1-9]|1[0-2])$/.test(code)) return 111 + parseInt(code.slice(1));
    return 0;
  }
  addEventListener('keydown', e => { const vk = vkFromCode(e.code); if (vk) { e.preventDefault(); send({ t: 'k', vk, down: true }); } });
  addEventListener('keyup', e => { const vk = vkFromCode(e.code); if (vk) { e.preventDefault(); send({ t: 'k', vk, down: false }); } });

  layout();
})();
