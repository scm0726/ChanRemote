'use strict';
(() => {
  const $ = s => document.querySelector(s);
  const C = window.CRCrypto;
  const VK = window.CRKeys.VK;
  const cap = window.Capacitor;
  const isApp = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  const Plugins = (cap && cap.Plugins) || {};
  const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  const DEFAULT_PORT = 8787;

  const store = {
    get(k, d) { try { const v = localStorage.getItem('cr.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('cr.' + k, JSON.stringify(v)); } catch { /* ignore */ } }
  };
  const clamp01 = v => Math.min(1, Math.max(0, v));
  const now = () => performance.now();

  // ═════════════════════════ PC 목록 ═════════════════════════
  const R = window.CRRelay;
  // 설정(config.js)과 동일해야 함
  const MASTER_SALT = 'chanremote-master-v1', MASTER_ITER = 100000;
  const FLEET_SALT = 'chanremote-fleet-v1', FLEET_ITER = 60000;
  let pcs = store.get('pcs', []);
  // 예전 형식(주소 목록) → 새 형식
  pcs.forEach(p => { if (!p.lan && Array.isArray(p.addrs) && p.addrs.length) p.lan = p.lastAddr || p.addrs[0]; delete p.addrs; delete p.wan; delete p.lastAddr; });
  const savePcs = () => store.set('pcs', pcs);
  const fmtId = id => String(id || '').replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
  const cleanId = v => String(v || '').replace(/\D/g, '');

  // 관리자(마스터) 로그인 상태 — 마스터 비밀번호로 "내 PC 묶음" 전체를 봄
  let admin = null; // { key(hex), fleetId, enc(Uint8Array) }
  const fleetPcs = new Map(); // id -> { id, name, admin:true }

  // PC가 직접 띄워준 페이지(같은 와이파이)로 들어온 경우: 이 PC를 목록에 자동 추가
  const servedByPc = !isApp && /^https?:$/.test(location.protocol) && !!location.host;
  if (servedByPc && !pcs.some(p => p.lan === location.host)) {
    pcs.unshift({ id: null, name: '이 PC', lan: location.host });
    savePcs();
  }

  function toast(text, ms = 2600) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, ms);
  }

  function presenceText(pc) {
    if (!pc.id) return { cls: '', text: '같은 와이파이' };
    const p = R.presence(pc.id);
    if (!p) return { cls: 'wait', text: '확인 중' };
    return p.on ? { cls: 'on', text: '켜짐' } : { cls: 'off', text: '꺼짐' };
  }

  function mkRow(pc, badge) {
    const st = presenceText(pc);
    const el = document.createElement('div');
    el.className = 'pc';
    el.innerHTML = '<div class="pcIcon">🖥</div><div class="info"><div class="name"></div><div class="addr"></div></div><span class="state"></span><button class="more" aria-label="메뉴">⋮</button>';
    el.querySelector('.name').textContent = pc.name || pc.hostName || 'PC';
    el.querySelector('.addr').textContent = badge || (pc.id ? `ID ${fmtId(pc.id)}` : pc.lan);
    const stEl = el.querySelector('.state');
    stEl.className = 'state ' + st.cls;
    stEl.textContent = st.text;
    el.onclick = e => { if (!e.target.closest('.more')) connectPc(pc); };
    const more = el.querySelector('.more');
    if (pc.admin) more.hidden = true; else more.onclick = () => pcMenu(pc);
    return el;
  }

  function renderHome() {
    const box = $('#pcList');
    box.innerHTML = '';
    // 관리자 모드: 묶음 PC 먼저
    if (admin) {
      const members = [...fleetPcs.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      const hdr = document.createElement('div');
      hdr.className = 'listHdr';
      hdr.innerHTML = `<span>관리자 — 내 PC ${members.length}대</span><button class="linkBtn" id="adminOut">로그아웃</button>`;
      box.appendChild(hdr);
      hdr.querySelector('#adminOut').onclick = adminLogout;
      if (!members.length) {
        const e = document.createElement('div');
        e.className = 'emptyCard';
        e.innerHTML = '이 마스터 비밀번호를 쓰는 PC를 찾는 중…<br>PC 설정에서 같은 <b>마스터 비밀번호</b>를 넣어 두세요.';
        box.appendChild(e);
      }
      for (const pc of members) { if (pc.id) R.watchPresence(pc.id); box.appendChild(mkRow(pc)); }
    }
    if (pcs.length) {
      if (admin) { const h = document.createElement('div'); h.className = 'listHdr'; h.innerHTML = '<span>직접 추가한 PC</span>'; box.appendChild(h); }
      for (const pc of pcs) { if (pc.id) R.watchPresence(pc.id); box.appendChild(mkRow(pc)); }
    } else if (!admin) {
      box.innerHTML = '<div class="emptyCard">아직 추가한 PC가 없어요.<br>PC에서 ChanRemote를 실행하면 나오는<br><b>PC ID</b>와 비밀번호로 추가하세요.<br>또는 <b>관리자 로그인</b>으로 한 번에 불러오세요.</div>';
    }
    $('#adminBtn').textContent = admin ? '관리자 로그아웃' : '관리자 로그인';
    const n = R.connectedCount();
    $('#homeHint').textContent = R.available() ? (n ? `중계망 연결됨 (${n}/${R.total()})` : '중계망에 연결하는 중…') : '';
  }

  // ── 관리자 로그인 ──
  function adminLogin(pw) {
    const keyHex = C.hex(C.pbkdf2(C.utf8(pw), C.utf8(MASTER_SALT), MASTER_ITER, 32));
    const fleetId = C.hex(C.pbkdf2(C.utf8(pw), C.utf8(FLEET_SALT), FLEET_ITER, 8));
    const enc = C.hmac(C.unhex(keyHex), C.utf8('fleet'));
    admin = { key: keyHex, fleetId, enc };
    store.set('admin', { key: keyHex, fleetId, enc: C.hex(enc) });
    fleetPcs.clear();
    R.watchFleet(fleetId, enc, (id, name) => {
      fleetPcs.set(id, { id, name, admin: true });
      if (!$('#home').hidden) renderHome();
    });
    renderHome();
  }
  function adminLogout() {
    admin = null;
    fleetPcs.clear();
    store.set('admin', null);
    R.stopFleet();
    renderHome();
  }
  // 저장된 관리자 세션 복원
  (() => {
    const a = store.get('admin', null);
    if (a && a.key && a.fleetId && a.enc) {
      admin = { key: a.key, fleetId: a.fleetId, enc: C.unhex(a.enc) };
      R.watchFleet(a.fleetId, admin.enc, (id, name) => {
        fleetPcs.set(id, { id, name, admin: true });
        if (!$('#home').hidden) renderHome();
      });
    }
  })();
  R.onPresence(() => { if (!$('#home').hidden) renderHome(); });
  R.onStatus(() => { if (!$('#home').hidden) renderHome(); });

  function pcMenu(pc) {
    const choice = prompt(`${pc.name || 'PC'}\n1: 이름 바꾸기\n2: 저장된 비밀번호 지우기\n3: 목록에서 삭제`, '');
    if (choice === '1') {
      const n = prompt('새 이름', pc.name || '');
      if (n != null) { pc.name = n.trim() || pc.name; savePcs(); renderHome(); }
    } else if (choice === '2') {
      delete pc.key; delete pc.salt; savePcs(); toast('저장된 비밀번호를 지웠어요');
    } else if (choice === '3') {
      if (confirm('이 PC를 목록에서 삭제할까요?')) { pcs = pcs.filter(p => p !== pc); savePcs(); renderHome(); }
    }
  }

  // ── PC 추가 / 비밀번호 시트 ──
  let sheetPc = null;
  function openSheet(pc, err) {
    sheetPc = pc;
    $('#sheetTitle').textContent = pc ? `${pc.name || 'PC'} 비밀번호` : 'PC 추가';
    $('#addrField').hidden = !!pc;
    $('#nameField').hidden = !!pc;
    $('#fAddr').value = '';
    $('#fName').value = '';
    $('#fPw').value = '';
    $('#fRemember').checked = true;
    $('#sheetErr').textContent = err || '';
    $('#sheet').hidden = false;
    setTimeout(() => (pc ? $('#fPw') : $('#fAddr')).focus(), 50);
  }
  function closeSheet() { $('#sheet').hidden = true; }

  $('#addPcBtn').onclick = () => openSheet(null);
  $('#sheetCancel').onclick = closeSheet;
  $('#fAddr').addEventListener('input', e => {
    const d = cleanId(e.target.value).slice(0, 9);
    const f = d.replace(/(\d{3})(?=\d)/g, '$1 ');
    if (e.target.value !== f) e.target.value = f;
  });
  $('#sheetForm').onsubmit = e => {
    e.preventDefault();
    const pw = $('#fPw').value;
    if (!pw) { $('#sheetErr').textContent = '비밀번호를 입력하세요'; return; }
    let pc = sheetPc;
    if (!pc) {
      const id = cleanId($('#fAddr').value);
      if (!/^\d{9}$/.test(id)) { $('#sheetErr').textContent = 'PC ID 9자리를 입력하세요'; return; }
      pc = pcs.find(p => p.id === id);
      if (!pc) {
        pc = { id, name: $('#fName').value.trim(), lan: null };
        pcs.push(pc);
        savePcs();
      }
    }
    closeSheet();
    startSession(pc, pw, $('#fRemember').checked);
  };

  function connectPc(pc) {
    if (pc.admin) { if (!admin) return; return startSession(pc, null, false); }
    if (!pc.key) return openSheet(pc);
    startSession(pc, null, true);
  }

  // 관리자 로그인 버튼/시트
  $('#adminBtn').onclick = () => {
    if (admin) { adminLogout(); return; }
    $('#adminSheet').hidden = false;
    $('#adminPw').value = '';
    $('#adminErr').textContent = '';
    setTimeout(() => $('#adminPw').focus(), 50);
  };
  $('#adminCancel').onclick = () => { $('#adminSheet').hidden = true; };
  $('#adminForm').onsubmit = e => {
    e.preventDefault();
    const pw = $('#adminPw').value;
    if (pw.length < 6) { $('#adminErr').textContent = '마스터 비밀번호 6자 이상'; return; }
    $('#adminSheet').hidden = true;
    adminLogin(pw);
    toast('관리자 로그인 — 내 PC를 불러오는 중…');
  };

  function deviceName() {
    const ua = navigator.userAgent;
    if (/SM-F9/i.test(ua)) return '갤럭시 폴드';
    if (/Android/i.test(ua)) return isApp ? '안드로이드 앱' : '안드로이드';
    if (/iPhone|iPad/i.test(ua)) return 'iPhone/iPad';
    if (/Electron/i.test(ua)) return 'PC (ChanRemote)';
    if (/Windows/i.test(ua)) return 'Windows PC';
    if (/Mac/i.test(ua)) return 'Mac';
    return '뷰어';
  }

  // ═════════════════════════ 연결 ═════════════════════════
  const S = {
    pc: null, password: null, remember: true, secret: null, ending: true,
    ch: null, sessKey: null, token: null, id: null, authed: false,
    turn: null, ice: [], wsTimer: null, backoff: 500, everConnected: false,
    rtc: null, sid: null, dc: null, pendingCands: [], sigChain: Promise.resolve(),
    restartTimer: null, renewTimer: null, lastPong: 0, lastChMsg: 0, rtt: 0,
    pingTimer: null, statsTimer: null, prevStats: null, wakeLock: null
  };

  const wsScheme = () => (!isApp && location.protocol === 'https:' ? 'wss' : 'ws');

  // 같은 와이파이용 직접 연결(웹소켓)을 채널 모양으로 감싸기
  function wsChannel(addr) {
    const ch = { kind: 'lan', closed: false, onmessage: null, onclose: null, kenc: null };
    let ws;
    try { ws = new WebSocket(`${wsScheme()}://${addr}/ws`); } catch { return null; }
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } if (ch.onmessage) ch.onmessage(m); };
    ws.onclose = () => { if (ch.closed) return; ch.closed = true; if (ch.onclose) ch.onclose(); };
    ws.onerror = () => {};
    ch.send = obj => { if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ } } };
    ch.close = () => { if (ch.closed) return; ch.closed = true; try { ws.close(); } catch { /* ignore */ } if (ch.onclose) ch.onclose(); };
    return ch;
  }

  function startSession(pc, password, remember) {
    teardown(true);
    Object.assign(S, { pc, password, remember, secret: null, ending: false, token: null, authed: false, everConnected: false, backoff: 500 });
    S.adminKey = pc.admin && admin ? admin.key : null;
    showStage();
    showOverlay(pc.id ? 'PC를 찾는 중…' : 'PC에 연결하는 중…');
    openChannel();
  }

  // 중계망(ID) + 같은 와이파이(직접) 동시에 시도 → 먼저 응답한 쪽 사용
  function openChannel() {
    clearTimeout(S.wsTimer);
    if (S.ending) return;
    const pc = S.pc;
    const tries = [];
    if (pc.lan) { const c = wsChannel(pc.lan); if (c) tries.push(c); }
    if (pc.id && R.available()) tries.push(R.openChannel(pc.id));
    let won = false, done = false;
    const fail = () => {
      if (won || done) return;
      done = true;
      tries.forEach(c => c.close());
      onChannelFail();
    };
    const timer = setTimeout(fail, 15000);
    for (const ch of tries) {
      ch.onmessage = m => {
        if (won || m.t !== 'hello') return;
        won = true;
        clearTimeout(timer);
        tries.forEach(c => { if (c !== ch) c.close(); });
        adoptChannel(ch, m);
      };
      ch.onclose = () => { if (!won && tries.every(c => c.closed)) { clearTimeout(timer); fail(); } };
    }
    if (!tries.length) { clearTimeout(timer); fail(); }
  }

  function onChannelFail() {
    if (S.ending) return;
    if (!S.everConnected && !S.authed) {
      const pc = S.pc;
      const p = pc && pc.id ? R.presence(pc.id) : null;
      endSession();
      if (p && !p.on) toast('PC가 꺼져 있거나 인터넷에 연결돼 있지 않아요', 4500);
      else if (pc && pc.id && !R.connectedCount()) toast('폰 인터넷 연결을 확인하세요', 4000);
      else toast('PC에 연결할 수 없어요. PC ID와 PC 프로그램이 켜져 있는지 확인하세요', 4500);
      return;
    }
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (S.ending) return;
    showOverlay('네트워크가 바뀌었거나 끊겼어요. 다시 연결하는 중…');
    clearTimeout(S.wsTimer);
    S.wsTimer = setTimeout(openChannel, S.backoff);
    S.backoff = Math.min(S.backoff * 2, 4000);
  }

  function adoptChannel(ch, hello) {
    S.ch = ch;
    S.backoff = 500;
    S.lastChMsg = Date.now();
    ch.onmessage = m => { S.lastChMsg = Date.now(); onWs(m); };
    ch.onclose = () => {
      if (S.ch !== ch) return;
      S.ch = null;
      if (!S.ending) scheduleReconnect();
    };
    // 관리자(마스터) 모드: 미리 만들어 둔 마스터 키를 그대로 사용
    if (S.pc.admin) {
      if (!hello.master) { endSession(); toast('이 PC에는 마스터 비밀번호가 설정돼 있지 않아요', 4000); return; }
      finishAuth(ch, hello, S.adminKey, null);
      return;
    }

    if (!hello.salt) { endSession(); toast('PC 프로그램에서 먼저 비밀번호를 정해 주세요', 4000); return; }

    const secret = S.secret && S.secret.salt === hello.salt ? S.secret : (S.pc.salt === hello.salt ? { key: S.pc.key, salt: S.pc.salt } : null);
    let keyHex = secret ? secret.key : null;
    if (S.password == null && !keyHex) {
      const pc = S.pc;
      endSession();
      openSheet(pc, 'PC 비밀번호가 바뀌었어요. 다시 입력하세요');
      return;
    }
    if (S.password != null) {
      showOverlay('비밀번호 확인 중…');
      setTimeout(() => {
        keyHex = C.hex(C.pbkdf2(C.utf8(S.password), C.unhex(hello.salt), hello.iter || 100000, 32));
        finishAuth(ch, hello, keyHex, hello.salt);
      }, 30);
    } else {
      finishAuth(ch, hello, keyHex, hello.salt);
    }
  }

  // 인증 메시지는 평문으로 보내고(증명값은 노출돼도 안전), 암호화 키는 auth-ok 이후에 적용
  function finishAuth(ch, hello, keyHex, salt) {
    if (S.ch !== ch) return;
    const key = C.unhex(keyHex);
    S.pendingKenc = C.hmac(key, C.utf8('enc:' + hello.nonce));
    S.sessKey = C.hmac(key, C.utf8('sess:' + hello.nonce));
    S.pendingSecret = salt ? { key: keyHex, salt } : null;
    wsSend({ t: 'auth', proof: C.hex(C.hmac(key, C.utf8('auth:' + hello.nonce))), name: deviceName(), resume: S.token });
  }

  function wsSend(obj) { if (S.ch && !S.ch.closed) S.ch.send(obj); }
  const sig = data => wsSend({ t: 'signal', data });

  function onWs(m) {
    switch (m.t) {
      case 'auth-ok': {
        S.authed = true;
        S.id = m.id;
        S.token = m.token;
        S.turn = m.turn;
        S.ice = m.iceServers || [];
        if (S.ch && S.pendingKenc) S.ch.kenc = S.pendingKenc; // 이제부터 신호 암호화
        const pc = S.pc;
        if (S.pendingSecret && !pc.admin) {
          S.secret = S.pendingSecret;
          if (S.remember) { pc.key = S.pendingSecret.key; pc.salt = S.pendingSecret.salt; }
          else { delete pc.key; delete pc.salt; }
        }
        S.password = null;
        if (m.hostName) { pc.hostName = m.hostName; if (!pc.name || pc.name === '이 PC') pc.name = m.hostName; }
        if (m.deviceId && !pc.id) pc.id = m.deviceId;
        if (m.addrs && m.addrs.lan && m.addrs.lan[0] && S.ch && S.ch.kind === 'lan') pc.lan = pc.lan || m.addrs.lan[0];
        if (!pcs.includes(pc)) pcs.push(pc);
        // 같은 PC가 목록에 두 번(와이파이/ID) 있으면 하나로 합치기
        const dup = pcs.find(p => p !== pc && pc.id && p.id === pc.id);
        if (dup) pcs = pcs.filter(p => p !== dup);
        savePcs();
        if (S.rtc) {
          try { S.rtc.setConfiguration({ ...S.rtc.getConfiguration(), iceServers: iceServers() }); } catch { /* ignore */ }
          if (rtcHealthy()) hideOverlay();
          else { requestRestart(); armRenew(6000); }
        } else {
          showOverlay('화면 받는 중…');
        }
        break;
      }
      case 'auth-fail': {
        const pc = S.pc;
        endSession();
        if (m.code === 'badpw') { delete pc.key; delete pc.salt; savePcs(); }
        if (m.code === 'badpw' || m.code === 'locked') openSheet(pc, m.reason);
        else toast(m.reason, 4000);
        break;
      }
      case 'signal':
        S.sigChain = S.sigChain.then(() => onSignal(m.data)).catch(e => console.warn('signal', e));
        break;
      case 'kicked':
        endSession();
        toast('PC에서 연결을 끊었어요');
        break;
    }
  }

  function iceServers() {
    const list = [...(S.ice || [])];
    const t = S.turn;
    if (t && t.username) {
      const hosts = [];
      if (S.ch && S.ch.kind === 'lan' && t.lan) hosts.push(t.lan);
      if (t.host) hosts.push(t.host);
      for (const h of hosts) {
        list.push({ urls: [`turn:${h}:${t.port}?transport=udp`, `turn:${h}:${t.port}?transport=tcp`], username: t.username, credential: t.credential });
      }
    }
    return list;
  }

  async function onSignal(d) {
    if (!d || S.ending) return;
    if (d.type === 'offer') {
      if (!S.sessKey || C.hex(C.hmac(S.sessKey, C.utf8(d.sdp))) !== d.sig) {
        console.warn('서명이 맞지 않는 연결 정보 무시');
        return;
      }
      if (!S.rtc || d.sid !== S.sid) newRtc(d.sid);
      const rtc = S.rtc;
      await rtc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
      for (const c of S.pendingCands.splice(0)) await rtc.addIceCandidate(c).catch(() => {});
      const ans = await rtc.createAnswer();
      await rtc.setLocalDescription(ans);
      const sdp = rtc.localDescription.sdp;
      sig({ type: 'answer', sid: d.sid, sdp, sig: C.hex(C.hmac(S.sessKey, C.utf8(sdp))) });
    } else if (d.type === 'cand') {
      if (d.sid !== S.sid) return;
      if (S.rtc && S.rtc.remoteDescription) await S.rtc.addIceCandidate(d.c).catch(() => {});
      else S.pendingCands.push(d.c);
    }
  }

  function newRtc(sid) {
    closeRtc();
    S.sid = sid;
    S.pendingCands = [];
    const rtc = new RTCPeerConnection({ iceServers: iceServers(), bundlePolicy: 'max-bundle' });
    S.rtc = rtc;
    rtc.onicecandidate = e => { if (e.candidate) sig({ type: 'cand', sid, c: e.candidate.toJSON() }); };
    rtc.ontrack = e => {
      const v = $('#video');
      const ms = e.streams[0] || new MediaStream([e.track]);
      if (v.srcObject !== ms) v.srcObject = ms;
      try { e.receiver.jitterBufferTarget = 0; } catch { /* ignore */ }
      try { e.receiver.playoutDelayHint = 0; } catch { /* ignore */ }
      v.play().catch(() => {});
    };
    rtc.ondatachannel = e => setupDc(e.channel);
    rtc.onconnectionstatechange = () => onRtcState(rtc);
  }

  function closeRtc() {
    if (S.rtc) { try { S.rtc.close(); } catch { /* ignore */ } }
    S.rtc = null;
    S.dc = null;
  }

  function rtcHealthy() {
    return !!(S.rtc && S.rtc.connectionState === 'connected' && S.dc && S.dc.readyState === 'open' && Date.now() - S.lastPong < 7000);
  }

  function onRtcState(rtc) {
    if (rtc !== S.rtc || S.ending) return;
    const st = rtc.connectionState;
    if (st === 'connected') {
      clearTimeout(S.restartTimer); clearTimeout(S.renewTimer);
      S.restartTimer = S.renewTimer = null;
      S.everConnected = true;
      hideOverlay();
    } else if (st === 'disconnected') {
      showOverlay('연결이 잠깐 불안정해요… 복구 중');
      if (!S.restartTimer) S.restartTimer = setTimeout(() => { S.restartTimer = null; requestRestart(); }, 1500);
      armRenew(10000);
    } else if (st === 'failed') {
      showOverlay('연결 복구 중…');
      requestRestart();
      armRenew(6000);
    }
  }

  function requestRestart() { if (S.sid) sig({ type: 'restart', sid: S.sid }); }
  function armRenew(ms) {
    if (S.renewTimer) return;
    S.renewTimer = setTimeout(() => {
      S.renewTimer = null;
      if (S.ending || rtcHealthy()) return;
      sig({ type: 'renew' }); // 연결을 처음부터 새로 만들기
      armRenew(12000);
    }, ms);
  }

  function setupDc(ch) {
    S.dc = ch;
    ch.onopen = () => {
      S.lastPong = Date.now();
      dcSend({ t: 'quality', v: settings.quality });
    };
    ch.onmessage = e => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      onDc(m);
    };
  }

  function dcSend(obj) {
    if (S.dc && S.dc.readyState === 'open') {
      try { S.dc.send(JSON.stringify(obj)); } catch { /* ignore */ }
    }
  }

  let screens = [];
  let currentScreen = null;
  function onDc(m) {
    switch (m.t) {
      case 'pong':
        S.lastPong = Date.now();
        S.rtt = now() - m.ts;
        break;
      case 'hello':
        screens = m.screens || [];
        currentScreen = m.current;
        renderScreens();
        if (m.quality !== settings.quality) dcSend({ t: 'quality', v: settings.quality });
        break;
      case 'screen':
        currentScreen = m.id;
        renderScreens();
        resetView();
        break;
      case 'clip':
        $('#clipText').value = m.text || '';
        writeLocalClipboard(m.text || '').then(ok => toast(ok ? 'PC 클립보드를 폰에 복사했어요' : 'PC 클립보드를 가져왔어요'));
        break;
    }
  }

  // 2초마다 생존 확인 → 응답이 없으면 즉시 복구 시작
  function pingLoop() {
    if (S.ending) return;
    // 연결 채널(중계망/직접) 생존 확인
    if (S.ch && S.authed) {
      if (!S.lastChPing || Date.now() - S.lastChPing > 10000) { S.lastChPing = Date.now(); wsSend({ t: 'ping', ts: Date.now() }); }
      if (Date.now() - S.lastChMsg > 35000) { S.lastChMsg = Date.now(); S.ch.close(); }
    }
    if (S.dc && S.dc.readyState === 'open') dcSend({ t: 'ping', ts: now() });
    if (S.rtc && S.rtc.connectionState === 'connected' && S.lastPong && Date.now() - S.lastPong > 7000) {
      showOverlay('응답이 없어요… 복구 중');
      requestRestart();
      armRenew(8000);
    }
  }

  async function statsLoop() {
    if (S.ending || !S.rtc) return;
    try {
      const st = await S.rtc.getStats();
      let inb = null, pair = null;
      st.forEach(r => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') inb = r;
        if (r.type === 'transport' && r.selectedCandidatePairId) pair = st.get(r.selectedCandidatePairId);
      });
      if (!inb) return;
      const prev = S.prevStats;
      let mbps = 0;
      if (prev && inb.timestamp > prev.timestamp) mbps = ((inb.bytesReceived - prev.bytes) * 8) / ((inb.timestamp - prev.timestamp) / 1000) / 1e6;
      S.prevStats = { bytes: inb.bytesReceived, timestamp: inb.timestamp };
      const rtt = pair && pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : S.rtt;
      const fps = Math.round(inb.framesPerSecond || 0);
      let route = '';
      if (pair) {
        const l = st.get(pair.localCandidateId), r = st.get(pair.remoteCandidateId);
        const relay = (l && l.candidateType === 'relay') || (r && r.candidateType === 'relay');
        route = relay ? '중계' : (r && r.candidateType === 'host') ? '직접(집 안)' : '직접(인터넷)';
      }
      const codec = inb.codecId && st.get(inb.codecId) ? st.get(inb.codecId).mimeType.split('/')[1] : '';
      const chip = $('#statChip');
      chip.textContent = `● ${Math.round(rtt)}ms · ${fps}fps · ${mbps.toFixed(1)}Mbps`;
      chip.className = 'chip' + (rtt > 150 || fps < 10 ? ' bad' : rtt > 70 || fps < 24 ? ' warn' : '');
      chip.hidden = !settings.stats;
      $('#statDetail').textContent = `해상도 ${inb.frameWidth || '?'}×${inb.frameHeight || '?'} · ${codec} · ${route}\n지연 ${Math.round(rtt)}ms · ${fps}fps · ${mbps.toFixed(1)}Mbps · 손실 ${inb.packetsLost || 0}`;
    } catch { /* ignore */ }
  }

  function teardown(silent) {
    S.ending = true;
    clearTimeout(S.wsTimer); clearTimeout(S.restartTimer); clearTimeout(S.renewTimer);
    S.restartTimer = S.renewTimer = null;
    if (S.ch) {
      if (!silent) wsSend({ t: 'bye' });
      const ch = S.ch;
      S.ch = null;
      setTimeout(() => ch.close(), 80);
    }
    closeRtc();
    S.sessKey = null;
    S.prevStats = null;
    const v = $('#video');
    v.srcObject = null;
  }

  function endSession() {
    if (S.dc) dcSend({ t: 'release' });
    teardown(false);
    releaseMods(true);
    showHome();
  }

  // ═════════════════════════ 화면 전환 ═════════════════════════
  function showStage() {
    $('#home').hidden = true;
    $('#stage').hidden = false;
    closePanels();
    applyMode();
    requestAnimationFrame(layout);
    requestWakeLock();
    if (isApp) document.documentElement.classList.add('app');
  }
  function showHome() {
    $('#stage').hidden = true;
    $('#home').hidden = false;
    hideOverlay();
    try { $('#kbd').blur(); } catch { /* ignore */ }
    renderHome();
    if (S.wakeLock) { S.wakeLock.release().catch(() => {}); S.wakeLock = null; }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  function showOverlay(text) {
    $('#overlayText').textContent = text;
    $('#overlay').hidden = false;
  }
  function hideOverlay() { $('#overlay').hidden = true; }
  $('#overlayCancel').onclick = () => endSession();

  async function requestWakeLock() {
    try { if ('wakeLock' in navigator) S.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* ignore */ }
  }

  // ═════════════════════════ 화면 배치/확대 ═════════════════════════
  const view = { z: 1, L: 0, T: 0, baseW: 0, baseH: 0, W: 0, H: 0 };
  const cursor = { x: 0.5, y: 0.5 };

  function layout() {
    const vp = $('#viewport');
    const v = $('#video');
    const W = vp.clientWidth, H = vp.clientHeight;
    const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
    const s = Math.min(W / vw, H / vh);
    view.W = W; view.H = H;
    view.baseW = vw * s; view.baseH = vh * s;
    v.style.width = view.baseW + 'px';
    v.style.height = view.baseH + 'px';
    clampView();
    applyView();
  }
  function resetView() { view.z = 1; layout(); }
  function clampView() {
    const w = view.baseW * view.z, h = view.baseH * view.z;
    view.L = w <= view.W ? (view.W - w) / 2 : Math.min(0, Math.max(view.W - w, view.L));
    view.T = h <= view.H ? (view.H - h) / 2 : Math.min(0, Math.max(view.H - h, view.T));
  }
  function applyView() {
    $('#video').style.transform = `translate(${view.L}px,${view.T}px) scale(${view.z})`;
    drawCursor();
  }
  function zoomAt(fx, fy, z) {
    z = Math.max(1, Math.min(6, z));
    view.L = fx - (fx - view.L) * (z / view.z);
    view.T = fy - (fy - view.T) * (z / view.z);
    view.z = z;
    clampView();
    applyView();
  }
  function vpRect() { return $('#viewport').getBoundingClientRect(); }
  function toNorm(cx, cy) {
    const r = vpRect();
    return {
      x: clamp01((cx - r.left - view.L) / (view.baseW * view.z)),
      y: clamp01((cy - r.top - view.T) / (view.baseH * view.z))
    };
  }
  function drawCursor() {
    const el = $('#cursor');
    if (settings.mode !== 'trackpad' || !isTouch) { el.hidden = true; return; }
    el.hidden = false;
    el.style.left = (view.L + cursor.x * view.baseW * view.z) + 'px';
    el.style.top = (view.T + cursor.y * view.baseH * view.z) + 'px';
  }
  function autoPan() {
    if (view.z <= 1) return;
    const m = 50;
    const cx = view.L + cursor.x * view.baseW * view.z;
    const cy = view.T + cursor.y * view.baseH * view.z;
    if (cx < m) view.L += m - cx;
    if (cx > view.W - m) view.L -= cx - (view.W - m);
    if (cy < m) view.T += m - cy;
    if (cy > view.H - m) view.T -= cy - (view.H - m);
    clampView();
    applyView();
  }

  new ResizeObserver(() => layout()).observe($('#viewport'));
  $('#video').addEventListener('resize', layout);
  $('#video').addEventListener('loadedmetadata', layout);

  // ═════════════════════════ 입력 전송 ═════════════════════════
  let pendingMove = null, moveRaf = 0;
  function sendMove() {
    pendingMove = { x: cursor.x, y: cursor.y };
    drawCursor();
    if (!moveRaf) moveRaf = requestAnimationFrame(flushMove);
  }
  function flushMove() {
    if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = 0; }
    if (pendingMove) {
      dcSend({ t: 'mm', x: +pendingMove.x.toFixed(5), y: +pendingMove.y.toFixed(5) });
      pendingMove = null;
    }
  }
  function mouseButton(b, down) {
    flushMove();
    dcSend({ t: 'mb', b, down });
    if (!down) releaseMods();
  }
  function click(b = 0) {
    flushMove();
    dcSend({ t: 'mb', b, down: true });
    dcSend({ t: 'mb', b, down: false });
    releaseMods();
  }
  let wheelAccX = 0, wheelAccY = 0;
  function wheel(dy, dx) {
    wheelAccY += dy; wheelAccX += dx;
    const iy = Math.trunc(wheelAccY), ix = Math.trunc(wheelAccX);
    if (iy || ix) {
      dcSend({ t: 'wh', dy: iy, dx: ix });
      wheelAccY -= iy; wheelAccX -= ix;
    }
  }
  function keyPress(vk, ext) {
    dcSend({ t: 'k', vk, ext: ext ? 1 : 0, down: true });
    dcSend({ t: 'k', vk, ext: ext ? 1 : 0, down: false });
    releaseMods();
  }

  // ── 조합키(Ctrl/Alt/Shift/Win): 한 번 누르면 다음 입력 한 번에 적용 ──
  const mods = new Map(); // vk -> ext
  function toggleMod(vk, ext) {
    if (mods.has(vk)) { dcSend({ t: 'k', vk, ext: ext ? 1 : 0, down: false }); mods.delete(vk); }
    else { dcSend({ t: 'k', vk, ext: ext ? 1 : 0, down: true }); mods.set(vk, ext); }
    updateModUi();
  }
  function releaseMods(silent) {
    if (!mods.size) return;
    if (!silent) for (const [vk, ext] of mods) dcSend({ t: 'k', vk, ext: ext ? 1 : 0, down: false });
    mods.clear();
    updateModUi();
  }
  function updateModUi() {
    document.querySelectorAll('.key.mod').forEach(b => b.classList.toggle('on', mods.has(+b.dataset.vk)));
  }

  function sendText(s) {
    if (!s) return;
    // 조합키가 켜져 있으면 글자 대신 키로 보냄 (Ctrl+C 등)
    if (mods.size && /^[a-z0-9]$/i.test(s)) {
      keyPress(s.toUpperCase().charCodeAt(0));
      return;
    }
    const parts = s.split('\n');
    parts.forEach((p, i) => {
      if (p) dcSend({ t: 'txt', s: p });
      if (i < parts.length - 1) keyPress(VK.ENTER);
    });
    if (mods.size) releaseMods();
  }

  // ═════════════════════════ 설정 ═════════════════════════
  const settings = {
    mode: store.get('mode', isTouch ? 'trackpad' : 'direct'),
    quality: store.get('quality', 'auto'),
    sens: store.get('sens', 1.3),
    stats: store.get('stats', true),
    bar: true
  };
  function saveSettings() {
    store.set('mode', settings.mode);
    store.set('quality', settings.quality);
    store.set('sens', settings.sens);
    store.set('stats', settings.stats);
  }
  function segSelect(id, value) {
    document.querySelectorAll(`#${id} button`).forEach(b => b.classList.toggle('on', b.dataset.v === value));
  }
  function applyMode() {
    $('#modeLabel').textContent = settings.mode === 'trackpad' ? '터치패드' : '직접 터치';
    $('#modeIc').textContent = settings.mode === 'trackpad' ? '☝' : '👆';
    segSelect('modeSeg', settings.mode);
    segSelect('qualitySeg', settings.quality);
    $('#sens').value = settings.sens;
    $('#statsBtn').textContent = settings.stats ? '끄기' : '켜기';
    $('#statChip').hidden = !settings.stats;
    drawCursor();
  }
  function flashHint(text) {
    const el = $('#modeHint');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(flashHint.t);
    flashHint.t = setTimeout(() => { el.hidden = true; }, 1600);
  }
  function setMode(m) {
    settings.mode = m;
    saveSettings();
    applyMode();
    flashHint(m === 'trackpad'
      ? '터치패드: 밀어서 커서 이동 · 탭 클릭\n두 손가락 탭 우클릭 · 두 손가락 밀기 스크롤'
      : '직접 터치: 누른 곳 클릭 · 길게 누르면 우클릭\n끌기 드래그 · 두 손가락 스크롤/확대');
  }

  $('#modeSeg').onclick = e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.v); };
  $('#qualitySeg').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    settings.quality = b.dataset.v;
    saveSettings();
    applyMode();
    dcSend({ t: 'quality', v: settings.quality });
  };
  $('#sens').oninput = e => { settings.sens = +e.target.value; saveSettings(); };
  $('#statsBtn').onclick = () => { settings.stats = !settings.stats; saveSettings(); applyMode(); };
  $('#soundBtn').onclick = () => {
    const v = $('#video');
    v.muted = !v.muted;
    v.play().catch(() => {});
    $('#soundBtn').textContent = v.muted ? '켜기' : '끄기';
  };
  $('#fsBtn').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => toast('이 환경에서는 전체화면을 쓸 수 없어요'));
  };
  $('#hideBarBtn').onclick = () => { closePanels(); $('#toolbar').hidden = true; $('#showBar').hidden = false; };
  $('#showBar').onclick = () => { $('#toolbar').hidden = false; $('#showBar').hidden = true; };
  $('#disconnectBtn').onclick = () => askConfirm('연결을 끊을까요?', endSession);

  // ── 클립보드 ──
  async function readLocalClipboard() {
    try { if (Plugins.Clipboard) { const r = await Plugins.Clipboard.read(); return r.value || ''; } } catch { /* ignore */ }
    try { if (navigator.clipboard && navigator.clipboard.readText) return await navigator.clipboard.readText(); } catch { /* ignore */ }
    return null;
  }
  async function writeLocalClipboard(text) {
    try { if (Plugins.Clipboard) { await Plugins.Clipboard.write({ string: text }); return true; } } catch { /* ignore */ }
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* ignore */ }
    try {
      const t = $('#clipText');
      t.value = text; t.select();
      return document.execCommand('copy');
    } catch { return false; }
  }
  $('#clipGet').onclick = () => dcSend({ t: 'clip-get' });
  $('#clipSet').onclick = async () => {
    let text = $('#clipText').value;
    if (!text) text = (await readLocalClipboard()) || '';
    if (!text) { toast('보낼 내용이 없어요. 칸에 붙여넣어 주세요'); return; }
    dcSend({ t: 'clip-set', text });
    toast('PC 클립보드로 보냈어요. PC에서 Ctrl+V 하세요');
  };
  $('#clipType').onclick = async () => {
    let text = $('#clipText').value;
    if (!text) text = (await readLocalClipboard()) || '';
    if (!text) { toast('입력할 내용이 없어요'); return; }
    sendText(text);
    toast('PC에 입력했어요');
  };

  // ── 확인 창 ──
  let confirmCb = null;
  function askConfirm(text, cb) {
    $('#confirmText').textContent = text;
    confirmCb = cb;
    $('#confirm').hidden = false;
  }
  $('#confirmNo').onclick = () => { $('#confirm').hidden = true; confirmCb = null; };
  $('#confirmYes').onclick = () => { $('#confirm').hidden = true; const cb = confirmCb; confirmCb = null; if (cb) cb(); };

  // ═════════════════════════ 툴바 / 패널 ═════════════════════════
  function closePanels() {
    ['#keysPanel', '#settingsPanel', '#screensPanel'].forEach(s => { $(s).hidden = true; });
    document.querySelectorAll('#toolbar button').forEach(b => b.classList.remove('on'));
  }
  function togglePanel(sel, act) {
    const open = $(sel).hidden;
    closePanels();
    if (open) {
      $(sel).hidden = false;
      document.querySelector(`#toolbar [data-act="${act}"]`).classList.add('on');
    }
  }
  $('#toolbar').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    switch (b.dataset.act) {
      case 'kbd': toggleKeyboard(); break;
      case 'keys': togglePanel('#keysPanel', 'keys'); break;
      case 'mode': setMode(settings.mode === 'trackpad' ? 'direct' : 'trackpad'); break;
      case 'screens': dcSend({ t: 'screens' }); renderScreens(); togglePanel('#screensPanel', 'screens'); break;
      case 'settings': togglePanel('#settingsPanel', 'settings'); break;
    }
  };

  function renderScreens() {
    const box = $('#screensPanel');
    box.innerHTML = '';
    if (!screens.length) { box.innerHTML = '<div class="hint">모니터 정보를 받는 중…</div>'; return; }
    for (const s of screens) {
      const b = document.createElement('button');
      b.className = 'screenBtn' + (s.id === currentScreen ? ' on' : '');
      b.textContent = `${s.name} · ${s.width}×${s.height}`;
      b.onclick = () => { dcSend({ t: 'screen', id: s.id }); closePanels(); };
      box.appendChild(b);
    }
  }

  // 특수키 패널
  const KEYS = [
    [
      ['Esc', { k: VK.ESC }], ['Tab', { k: VK.TAB }], ['한/영', { k: VK.HANGUL }], ['한자', { k: VK.HANJA }],
      ['Enter', { k: VK.ENTER }], ['⌫', { k: VK.BACK }], ['Del', { k: VK.DEL, ext: 1 }], ['Space', { k: VK.SPACE }]
    ],
    [
      ['Ctrl', { mod: VK.CTRL }], ['Alt', { mod: VK.ALT }], ['Shift', { mod: VK.SHIFT }], ['Win', { mod: VK.WIN, ext: 1 }],
      ['↑', { k: VK.UP, ext: 1 }], ['↓', { k: VK.DOWN, ext: 1 }], ['←', { k: VK.LEFT, ext: 1 }], ['→', { k: VK.RIGHT, ext: 1 }],
      ['Home', { k: VK.HOME, ext: 1 }], ['End', { k: VK.END, ext: 1 }], ['PgUp', { k: VK.PGUP, ext: 1 }], ['PgDn', { k: VK.PGDN, ext: 1 }]
    ],
    [
      ['복사', { combo: [VK.CTRL, 0x43] }], ['붙여넣기', { combo: [VK.CTRL, 0x56] }], ['잘라내기', { combo: [VK.CTRL, 0x58] }],
      ['실행취소', { combo: [VK.CTRL, 0x5A] }], ['전체선택', { combo: [VK.CTRL, 0x41] }], ['저장', { combo: [VK.CTRL, 0x53] }],
      ['창 전환', { combo: [VK.ALT, VK.TAB] }], ['창 닫기', { combo: [VK.ALT, 0x73] }], ['바탕화면', { combo: [VK.WIN, 0x44] }],
      ['시작', { k: VK.WIN, ext: 1 }], ['탐색기', { combo: [VK.WIN, 0x45] }], ['실행', { combo: [VK.WIN, 0x52] }],
      ['작업관리자', { combo: [VK.CTRL, VK.SHIFT, VK.ESC] }], ['캡처', { combo: [VK.WIN, VK.SHIFT, 0x53] }],
      ['새로고침', { k: 0x74 }], ['좌클릭', { click: 0 }], ['우클릭', { click: 2 }], ['더블클릭', { dbl: 1 }]
    ],
    Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, { k: VK.F1 + i }])
  ];
  (function buildKeys() {
    const panel = $('#keysPanel');
    for (const group of KEYS) {
      const grid = document.createElement('div');
      grid.className = 'keyGrid';
      for (const [label, a] of group) {
        const b = document.createElement('button');
        b.className = 'key' + (a.mod ? ' mod' : '');
        b.textContent = label;
        if (a.mod) b.dataset.vk = a.mod;
        b.onclick = () => {
          if (navigator.vibrate) navigator.vibrate(8);
          if (a.mod) toggleMod(a.mod, a.ext);
          else if (a.combo) { dcSend({ t: 'combo', keys: a.combo }); releaseMods(); }
          else if (a.click != null) click(a.click);
          else if (a.dbl) { click(0); click(0); }
          else keyPress(a.k, a.ext);
        };
        grid.appendChild(b);
      }
      panel.appendChild(grid);
    }
  })();

  // ═════════════════════════ 폰 키보드 (한글 포함) ═════════════════════════
  // 숨겨진 입력칸의 변화를 비교해서 지운 만큼 ⌫, 새로 생긴 글자는 그대로 PC에 입력
  const SENT = '        ';
  const kbd = $('#kbd');
  let kbLast = SENT;
  let composing = false;
  function resetKbd() {
    kbd.value = SENT;
    kbLast = SENT;
    try { kbd.setSelectionRange(SENT.length, SENT.length); } catch { /* ignore */ }
  }
  function toggleKeyboard() {
    if (document.activeElement === kbd) { kbd.blur(); return; }
    closePanels();
    resetKbd();
    kbd.focus();
  }
  function syncKbd() {
    const cur = kbd.value;
    if (cur === kbLast) return;
    const a = Array.from(kbLast), b = Array.from(cur);
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    const del = a.length - p;
    const add = b.slice(p).join('');
    for (let i = 0; i < del; i++) keyPress(VK.BACK);
    if (add) sendText(add);
    kbLast = cur;
    if (!composing && (cur.length < SENT.length || cur.length > 60 || !cur.startsWith(SENT) || add.includes('\n'))) resetKbd();
  }
  kbd.addEventListener('compositionstart', () => { composing = true; });
  kbd.addEventListener('compositionend', () => { composing = false; setTimeout(syncKbd, 0); });
  kbd.addEventListener('input', syncKbd);
  kbd.addEventListener('keydown', e => {
    // 글자를 만들지 않는 키(방향키 등)는 그대로 전달 (블루투스/PC 키보드)
    const passthru = /^(Arrow|Escape|Tab|Delete|Home|End|Page|F\d)/.test(e.code);
    if (passthru) {
      const k = window.CRKeys.fromCode(e.code);
      if (k) { e.preventDefault(); keyPress(k[0], k[1]); }
    } else if (e.key === 'Backspace' && kbd.value === kbLast && kbd.selectionStart === kbd.value.length && kbd.value.length <= SENT.length) {
      // 일부 키보드: 빈칸에서 ⌫ 이 input 이벤트를 안 만드는 경우
      if (kbd.value.length === 0) { e.preventDefault(); keyPress(VK.BACK); }
    }
  });
  resetKbd();

  // ═════════════════════════ 터치 조작 ═════════════════════════
  const vp = $('#viewport');
  const T = {
    g: null, touches: new Map(), start: 0, moved: false, dragging: false, longFired: false, longTimer: 0,
    tapDrag: false, lastTap: { t: 0, x: 0, y: 0 }, lastMoveT: 0, two: null
  };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  vp.addEventListener('touchstart', e => {
    e.preventDefault();
    if (!$('#keysPanel').hidden || !$('#settingsPanel').hidden || !$('#screensPanel').hidden) closePanels();
    for (const t of e.changedTouches) T.touches.set(t.identifier, { x: t.clientX, y: t.clientY, sx: t.clientX, sy: t.clientY });
    const n = T.touches.size;
    const tnow = now();
    if (n === 1 && T.g === null) {
      const t = [...T.touches.values()][0];
      T.g = 'one'; T.start = tnow; T.moved = false; T.dragging = false; T.longFired = false; T.lastMoveT = tnow;
      T.tapDrag = tnow - T.lastTap.t < 320 && Math.hypot(t.x - T.lastTap.x, t.y - T.lastTap.y) < 45;
      if (settings.mode === 'direct') {
        const p = toNorm(t.x, t.y);
        cursor.x = p.x; cursor.y = p.y;
        sendMove();
      }
      clearTimeout(T.longTimer);
      T.longTimer = setTimeout(() => {
        if (T.g === 'one' && !T.moved && !T.dragging) {
          T.longFired = true;
          if (navigator.vibrate) navigator.vibrate(25);
          click(2);
        }
      }, 550);
    } else if (n === 2) {
      clearTimeout(T.longTimer);
      if (T.g === 'one' && T.dragging) { mouseButton(0, false); T.dragging = false; }
      const [a, b] = [...T.touches.values()];
      const r = vpRect();
      const m = mid(a, b);
      T.g = 'two';
      T.two = { d0: dist(a, b), z0: view.z, lastMid: { x: m.x - r.left, y: m.y - r.top }, mode: null, start: tnow, moved: 0 };
    } else if (n >= 3) {
      clearTimeout(T.longTimer);
      if (T.g === 'one' && T.dragging) { mouseButton(0, false); T.dragging = false; }
      T.g = 'three';
      T.start = tnow;
    }
  }, { passive: false });

  vp.addEventListener('touchmove', e => {
    e.preventDefault();
    const prev = new Map();
    for (const t of e.changedTouches) {
      const o = T.touches.get(t.identifier);
      if (!o) continue;
      prev.set(t.identifier, { x: o.x, y: o.y });
      o.x = t.clientX; o.y = t.clientY;
    }
    const tnow = now();
    if (T.g === 'one') {
      const [id, t] = [...T.touches.entries()][0] || [];
      if (!t) return;
      const p = prev.get(id) || t;
      if (!T.moved && Math.hypot(t.x - t.sx, t.y - t.sy) > 9) { T.moved = true; clearTimeout(T.longTimer); }
      if (!T.moved || T.longFired) { T.lastMoveT = tnow; return; }
      if (settings.mode === 'trackpad') {
        if (T.tapDrag && !T.dragging) { mouseButton(0, true); T.dragging = true; }
        const dx = t.x - p.x, dy = t.y - p.y;
        const dt = Math.max(1, tnow - T.lastMoveT);
        const speed = Math.hypot(dx, dy) / dt;
        const accel = 1 + Math.min(2.5, Math.max(0, speed - 0.25) * 1.8);
        const g = settings.sens * accel;
        cursor.x = clamp01(cursor.x + (dx * g) / (view.baseW * view.z));
        cursor.y = clamp01(cursor.y + (dy * g) / (view.baseH * view.z));
        sendMove();
        autoPan();
      } else {
        if (!T.dragging) { flushMove(); mouseButton(0, true); T.dragging = true; }
        const n = toNorm(t.x, t.y);
        cursor.x = n.x; cursor.y = n.y;
        sendMove();
      }
      T.lastMoveT = tnow;
    } else if (T.g === 'two' && T.touches.size >= 2) {
      const [a, b] = [...T.touches.values()];
      const r = vpRect();
      const m = mid(a, b);
      const mm = { x: m.x - r.left, y: m.y - r.top };
      const tw = T.two;
      const ratio = dist(a, b) / tw.d0;
      const ddx = mm.x - tw.lastMid.x, ddy = mm.y - tw.lastMid.y;
      tw.moved += Math.hypot(ddx, ddy);
      if (!tw.mode) {
        if (Math.abs(ratio - 1) > 0.12) tw.mode = 'zoom';
        else if (tw.moved > 10) tw.mode = 'scroll';
      }
      if (tw.mode === 'zoom') {
        view.L += ddx; view.T += ddy;
        zoomAt(mm.x, mm.y, tw.z0 * ratio);
      } else if (tw.mode === 'scroll') {
        wheel(ddy * 2.2, -ddx * 2.2);
      }
      tw.lastMid = mm;
    }
  }, { passive: false });

  function touchEnd(e) {
    e.preventDefault();
    for (const t of e.changedTouches) T.touches.delete(t.identifier);
    if (T.touches.size > 0) return;
    const tnow = now();
    clearTimeout(T.longTimer);
    if (T.g === 'one') {
      if (T.dragging) {
        mouseButton(0, false);
        T.dragging = false;
        T.lastTap.t = 0;
      } else if (!T.moved && !T.longFired && tnow - T.start < 450) {
        click(0);
        const t = e.changedTouches[0];
        T.lastTap = { t: tnow, x: t.clientX, y: t.clientY };
      }
    } else if (T.g === 'two') {
      if (!T.two.mode && tnow - T.two.start < 350) click(2);
      if (view.z < 1.05) { view.z = 1; clampView(); applyView(); }
    } else if (T.g === 'three') {
      if (tnow - T.start < 450) toggleKeyboard();
    }
    T.g = null;
  }
  vp.addEventListener('touchend', touchEnd, { passive: false });
  vp.addEventListener('touchcancel', touchEnd, { passive: false });

  // ═════════════════════════ 마우스·키보드 (PC에서 접속할 때) ═════════════════════════
  vp.addEventListener('mousemove', e => {
    const p = toNorm(e.clientX, e.clientY);
    cursor.x = p.x; cursor.y = p.y;
    sendMove();
  });
  const mouseHeld = new Set();
  vp.addEventListener('mousedown', e => {
    e.preventDefault();
    mouseHeld.add(e.button);
    vp.focus();
    const p = toNorm(e.clientX, e.clientY);
    cursor.x = p.x; cursor.y = p.y;
    sendMove();
    mouseButton(e.button, true);
  });
  window.addEventListener('mouseup', e => {
    if ($('#stage').hidden || !mouseHeld.has(e.button)) return;
    mouseHeld.delete(e.button);
    mouseButton(e.button, false);
  });
  vp.addEventListener('contextmenu', e => e.preventDefault());
  vp.addEventListener('wheel', e => {
    e.preventDefault();
    let dy = e.deltaY, dx = e.deltaX;
    if (e.deltaMode === 1) { dy *= 40; dx *= 40; } else if (e.deltaMode === 2) { dy *= 800; dx *= 800; }
    wheel(-dy * 1.2, dx * 1.2);
  }, { passive: false });

  const isFormField = el => el && el !== kbd && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  function keyHandler(down) {
    return e => {
      if ($('#stage').hidden || isFormField(e.target) || e.target === kbd) return;
      const k = window.CRKeys.fromCode(e.code);
      if (!k) return;
      e.preventDefault();
      dcSend({ t: 'k', vk: k[0], ext: k[1] ? 1 : 0, down });
    };
  }
  window.addEventListener('keydown', keyHandler(true));
  window.addEventListener('keyup', keyHandler(false));
  window.addEventListener('blur', () => { if (!$('#stage').hidden) dcSend({ t: 'release' }); });

  // ═════════════════════════ 앱 생명주기 ═════════════════════════
  function wakeUp() {
    if (S.ending || $('#stage').hidden) return;
    requestWakeLock();
    if (!S.ch) { clearTimeout(S.wsTimer); S.backoff = 300; openChannel(); }
    else if (!rtcHealthy()) { requestRestart(); armRenew(5000); }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (!$('#stage').hidden) dcSend({ t: 'release' }); }
    else wakeUp();
  });
  window.addEventListener('online', wakeUp);
  window.addEventListener('focus', wakeUp);

  if (Plugins.App && Plugins.App.addListener) {
    Plugins.App.addListener('backButton', () => {
      if (!$('#confirm').hidden) { $('#confirm').hidden = true; return; }
      if (!$('#adminSheet').hidden) { $('#adminSheet').hidden = true; return; }
      if (!$('#sheet').hidden) { closeSheet(); return; }
      if (!$('#stage').hidden) {
        if (document.activeElement === kbd) { kbd.blur(); return; }
        if (!$('#keysPanel').hidden || !$('#settingsPanel').hidden || !$('#screensPanel').hidden) { closePanels(); return; }
        askConfirm('연결을 끊을까요?', endSession);
        return;
      }
      if (Plugins.App.exitApp) Plugins.App.exitApp();
    });
    Plugins.App.addListener('appStateChange', st => { if (st && st.isActive) wakeUp(); });
  }

  setInterval(pingLoop, 2000);
  setInterval(statsLoop, 1000);

  // 시작
  applyMode();
  renderHome();
  if (servedByPc && pcs.length === 1 && pcs[0].key && pcs[0].lan === location.host) {
    connectPc(pcs[0]); // 이 PC가 띄운 페이지 + 비밀번호 저장됨 → 바로 연결
  }
  R.ensure();

  window.__cr = { S, settings, view, cursor }; // 디버깅용
})();
