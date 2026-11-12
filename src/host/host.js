'use strict';
// 호스트 창: 상태 UI + 화면 캡처 + 뷰어별 WebRTC 연결 관리
const H = window.host;
const $ = s => document.querySelector(s);

const QUALITY = {
  auto: { maxBitrate: 12e6, maxFramerate: 60, scale: 1 },
  high: { maxBitrate: 30e6, maxFramerate: 60, scale: 1 },
  saver: { maxBitrate: 2.5e6, maxFramerate: 30, scale: 1.5 },
  low: { maxBitrate: 0.8e6, maxFramerate: 20, scale: 2 }
};

const peers = new Map(); // viewerId -> peer
const viewers = new Map(); // viewerId -> { name, ip, since }
const captures = new Map(); // sourceId -> { refs, promise }
let sources = [];
let iceServers = [];
let hostName = '';

// ───────────────────────── UI ─────────────────────────
function log(line) {
  const el = $('#log');
  el.textContent += (el.textContent ? '\n' : '') + line;
  const lines = el.textContent.split('\n');
  if (lines.length > 300) el.textContent = lines.slice(-300).join('\n');
  el.scrollTop = el.scrollHeight;
}
const localLog = msg => log(`[${new Date().toTimeString().slice(0, 8)}] ${msg}`);

function renderAddresses(list) {
  $('#lanHint').textContent = list.length ? `같은 와이파이의 PC 브라우저에서도 접속할 수 있어요: ${list[0].url}` : '';
}

function renderNet(n) {
  const dot = $('#netDot');
  dot.className = 'dot ' + (n.upnp === 'ok' ? 'ok' : n.upnp === 'checking' ? 'warn' : n.upnp === 'off' ? '' : 'warn');
  if (n.upnp === 'ok') $('#netDetail').textContent = '공유기 자동 열기 성공 — 엄격한 통신망에서도 접속 가능';
  else if (n.upnp === 'checking') $('#netDetail').textContent = '공유기 확인 중…';
  else if (n.upnp === 'off') $('#netDetail').textContent = '꺼짐';
  else $('#netDetail').textContent = '공유기 자동 열기 안 됨 — 대부분은 그래도 접속돼요';
}

function renderRelay(r) {
  const ok = r && r.connected > 0;
  $('#relayDot').className = 'dot ' + (ok ? 'ok' : 'warn');
  $('#relayText').textContent = ok ? `접속 대기 중 (중계망 ${r.connected}/${r.total} 연결)` : '인터넷 연결 확인 중… (자동으로 다시 연결해요)';
}

function formatId(id) { return String(id || '').replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3'); }

function connStateInfo(p) {
  if (!p) return ['warn', '준비 중'];
  const s = p.pc.connectionState;
  if (s === 'connected') return ['ok', `연결됨 · ${p.route || ''}`];
  if (s === 'connecting' || s === 'new') return ['warn', '연결 중'];
  if (s === 'disconnected') return ['warn', '복구 중'];
  return ['bad', s];
}

function renderViewers() {
  const box = $('#viewerList');
  box.innerHTML = '';
  if (!viewers.size) {
    box.innerHTML = '<div class="empty">아직 접속한 기기가 없어요</div>';
  }
  for (const [id, v] of viewers) {
    const p = peers.get(id);
    const [cls, text] = connStateInfo(p);
    const row = document.createElement('div');
    row.className = 'viewer';
    row.innerHTML = `<span class="dot ${cls}"></span><div class="grow"><div class="name"></div><div class="meta"></div></div><button class="danger">끊기</button>`;
    row.querySelector('.name').textContent = v.name;
    row.querySelector('.meta').textContent = `${v.ip} · ${text}${p && p.stats ? ' · ' + p.stats : ''}`;
    row.querySelector('button').onclick = () => H.kick(id);
    box.appendChild(row);
  }
  const anyConnected = [...peers.values()].some(p => p.pc.connectionState === 'connected');
  const badge = $('#statusBadge');
  badge.textContent = viewers.size ? `접속 ${viewers.size}명` : '대기 중';
  badge.className = 'badge' + (anyConnected ? ' on' : '');
}

async function initUi() {
  const st = await H.state();
  iceServers = st.iceServers;
  hostName = st.hostName;
  $('#hostName').textContent = `${st.hostName} · v${st.version}${st.inputOk ? '' : ' · ⚠ 입력 제어 불가'}`;
  $('#deviceId').textContent = formatId(st.deviceId);
  $('#copyId').onclick = () => { H.copyText(st.deviceId); $('#copyId').textContent = '복사됨'; setTimeout(() => { $('#copyId').textContent = '복사'; }, 1500); };
  $('#openViewer').onclick = () => H.openViewer();
  renderRelay(st.relay);
  $('#autoStart').checked = st.autoStart;
  $('#unattended').checked = st.unattended;
  $('#upnp').checked = st.upnp;
  if (!st.hasPassword) {
    $('#pwHint').innerHTML = '<b style="color:#fbbf24">먼저 비밀번호를 정해 주세요.</b> 비밀번호가 없으면 아무도 접속할 수 없어요.';
    $('#pwCard').style.borderColor = '#fbbf24';
  }
  renderAddresses(st.addresses);
  renderNet(st.net);
  $('#log').textContent = st.logs.join('\n');
  for (const v of st.viewers) viewers.set(v.id, v);
  renderViewers();

  $('#pwSave').onclick = async () => {
    const pw = $('#pwInput').value;
    const msg = $('#pwMsg');
    try {
      await H.setPassword(pw);
      msg.className = 'msg';
      msg.textContent = '저장했어요. 다른 기기에서 PC ID와 이 비밀번호로 접속하세요.';
      $('#pwInput').value = '';
      $('#pwCard').style.borderColor = '';
      $('#pwHint').textContent = '다른 기기에서 접속할 때 입력할 비밀번호예요. 8자 이상, 숫자·영문을 섞으면 안전해요.';
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = '비밀번호는 6자 이상이어야 해요';
    }
  };
  $('#pwInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#pwSave').click(); });
  $('#autoStart').onchange = e => H.setAutoStart(e.target.checked);
  $('#unattended').onchange = e => H.setUnattended(e.target.checked);
  $('#upnp').onchange = e => { renderNet({ upnp: 'checking' }); H.setUpnp(e.target.checked); };
  $('#netRecheck').onclick = () => { renderNet({ upnp: 'checking' }); H.recheckNet(); };
}

H.on('log', log);
H.on('net-status', renderNet);
H.on('relay-status', renderRelay);

// ─────────────────────── 화면 캡처 ───────────────────────
async function refreshSources() {
  try { sources = await H.sources(); } catch (e) { localLog('화면 목록 오류: ' + e.message); }
  return sources;
}
const primarySource = () => sources.find(s => s.primary) || sources[0];

async function openCapture(sourceId) {
  const video = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: sourceId,
      maxWidth: 3840,
      maxHeight: 2160,
      maxFrameRate: 60
    }
  };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } }, video });
  } catch (e) {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
    localLog('PC 소리는 빼고 화면만 보내요 (' + e.name + ')');
  }
  const vt = stream.getVideoTracks()[0];
  if (vt) {
    vt.contentHint = 'detail'; // 글자가 선명하게
    vt.addEventListener('ended', () => recoverCapture(sourceId));
  }
  return stream;
}

function acquire(sourceId) {
  let c = captures.get(sourceId);
  if (!c) {
    c = { refs: 0, promise: null };
    c.promise = openCapture(sourceId).catch(e => { captures.delete(sourceId); throw e; });
    captures.set(sourceId, c);
  }
  c.refs++;
  return c.promise;
}

function release(sourceId) {
  const c = captures.get(sourceId);
  if (!c) return;
  if (--c.refs <= 0) {
    captures.delete(sourceId);
    c.promise.then(s => s.getTracks().forEach(t => t.stop())).catch(() => {});
  }
}

const recovering = new Set();
async function recoverCapture(sourceId) {
  if (recovering.has(sourceId)) return;
  recovering.add(sourceId);
  localLog('화면 캡처가 끊겨서 다시 연결해요');
  captures.delete(sourceId);
  try {
    await new Promise(r => setTimeout(r, 500));
    await refreshSources();
    const users = [...peers.values()].filter(p => p.sourceId === sourceId);
    const target = sources.find(s => s.id === sourceId) ? sourceId : (primarySource() || {}).id;
    for (const p of users) {
      p.sourceId = null; // 이전 캡처는 이미 끝남
      await switchSource(p, target).catch(e => localLog('화면 복구 실패: ' + e.message));
    }
  } finally {
    recovering.delete(sourceId);
  }
}

// ─────────────────────── WebRTC ───────────────────────
function preferCodecs(tx) {
  if (!tx.setCodecPreferences) return;
  const rank = c => {
    const m = c.mimeType.toLowerCase();
    if (m === 'video/h264') return (c.sdpFmtpLine || '').includes('packetization-mode=1') ? 0 : 1;
    if (m === 'video/vp8') return 2;
    if (m === 'video/vp9') return 3;
    if (m === 'video/av1') return 4;
    return 5;
  };
  for (const getCaps of [() => RTCRtpSender.getCapabilities('video'), () => RTCRtpReceiver.getCapabilities('video')]) {
    try {
      const caps = getCaps();
      if (!caps) continue;
      tx.setCodecPreferences([...caps.codecs].sort((a, b) => rank(a) - rank(b)));
      return;
    } catch { /* 다음 방법 */ }
  }
}

function dcSend(p, obj) {
  if (p.dc && p.dc.readyState === 'open') {
    try { p.dc.send(JSON.stringify(obj)); } catch { /* ignore */ }
  }
}

function sendHello(p) {
  dcSend(p, {
    t: 'hello',
    host: hostName,
    screens: sources.map(s => ({ id: s.id, name: s.name, primary: s.primary, width: s.width, height: s.height })),
    current: p.sourceId,
    quality: p.quality
  });
}

async function applyQuality(p, mode) {
  const q = QUALITY[mode] || QUALITY.auto;
  p.quality = QUALITY[mode] ? mode : 'auto';
  if (!p.videoSender) return;
  try {
    const params = p.videoSender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    Object.assign(params.encodings[0], { maxBitrate: q.maxBitrate, maxFramerate: q.maxFramerate, scaleResolutionDownBy: q.scale });
    params.degradationPreference = 'balanced';
    await p.videoSender.setParameters(params);
  } catch (e) {
    localLog('화질 설정 실패: ' + e.message);
  }
}

async function switchSource(p, newId) {
  const src = sources.find(s => s.id === newId);
  if (!src) throw new Error('화면을 찾을 수 없어요');
  const stream = await acquire(newId);
  if (p.closed) { release(newId); return; }
  await p.videoSender.replaceTrack(stream.getVideoTracks()[0] || null);
  if (p.audioSender) await p.audioSender.replaceTrack(stream.getAudioTracks()[0] || null);
  const old = p.sourceId;
  p.sourceId = newId;
  p.displayId = src.displayId;
  if (old && old !== newId) release(old);
  dcSend(p, { t: 'screen', id: newId });
}

async function negotiate(p, iceRestart = false) {
  const offer = await p.pc.createOffer({ iceRestart });
  await p.pc.setLocalDescription(offer);
  H.toViewer(p.id, { type: 'offer', sid: p.sid, sdp: p.pc.localDescription.sdp });
}

function closePeer(id) {
  const p = peers.get(id);
  if (!p) return;
  p.closed = true;
  peers.delete(id);
  clearInterval(p.statsTimer);
  try { p.pc.close(); } catch { /* ignore */ }
  if (p.sourceId) release(p.sourceId);
  H.input({ t: 'release' });
}

async function createPeer(id) {
  closePeer(id);
  const sid = Math.random().toString(36).slice(2, 10);
  const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
  const p = { id, sid, pc, dc: null, sourceId: null, displayId: null, videoSender: null, audioSender: null, quality: 'auto', closed: false, pendingCands: [], route: '', stats: '' };
  peers.set(id, p);

  pc.onicecandidate = e => { if (e.candidate) H.toViewer(id, { type: 'cand', sid, c: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => {
    if (p.closed) return;
    const s = pc.connectionState;
    if (s === 'connected' || s === 'failed') localLog(`${(viewers.get(id) || {}).name || '뷰어'}: ${s === 'connected' ? '화면 연결됨' : '연결 끊김 — 복구 대기'}`);
    renderViewers();
  };

  const dc = pc.createDataChannel('ctl', { ordered: true });
  p.dc = dc;
  dc.onopen = () => sendHello(p);
  dc.onmessage = e => onDcMessage(p, e.data);

  await refreshSources();
  const src = primarySource();
  if (!src) throw new Error('캡처할 화면이 없어요');
  const stream = await acquire(src.id);
  if (p.closed) { release(src.id); return; }
  p.sourceId = src.id;
  p.displayId = src.displayId;

  const q = QUALITY.auto;
  const vtx = pc.addTransceiver(stream.getVideoTracks()[0], {
    direction: 'sendonly',
    streams: [stream],
    sendEncodings: [{ maxBitrate: q.maxBitrate, maxFramerate: q.maxFramerate, scaleResolutionDownBy: q.scale }]
  });
  p.videoSender = vtx.sender;
  preferCodecs(vtx);
  const at = stream.getAudioTracks()[0];
  const atx = pc.addTransceiver(at || 'audio', { direction: 'sendonly', streams: [stream] });
  p.audioSender = atx.sender;

  p.statsTimer = setInterval(() => updatePeerStats(p), 2000);
  await negotiate(p);
  renderViewers();
}

async function updatePeerStats(p) {
  if (p.closed || p.pc.connectionState !== 'connected') return;
  try {
    const st = await p.pc.getStats();
    let pair = null, out = null;
    st.forEach(r => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pair = st.get(r.selectedCandidatePairId);
      if (r.type === 'outbound-rtp' && r.kind === 'video') out = r;
    });
    if (pair) {
      const remote = st.get(pair.remoteCandidateId);
      const local = st.get(pair.localCandidateId);
      const relayed = (remote && remote.candidateType === 'relay') || (local && local.candidateType === 'relay');
      p.route = relayed ? '중계 연결' : '직접 연결';
    }
    if (out) {
      const prev = p.prevOut;
      if (prev) {
        const mbps = ((out.bytesSent - prev.bytesSent) * 8) / ((out.timestamp - prev.timestamp) / 1000) / 1e6;
        p.stats = `${out.frameWidth || '?'}×${out.frameHeight || '?'} ${Math.round(out.framesPerSecond || 0)}fps ${mbps.toFixed(1)}Mbps`;
      }
      p.prevOut = { bytesSent: out.bytesSent, timestamp: out.timestamp };
    }
    renderViewers();
  } catch { /* ignore */ }
}

function onDcMessage(p, raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'ping': dcSend(p, { t: 'pong', ts: m.ts }); break;
    case 'mm': case 'mb':
      m.d = p.displayId;
      H.input(m);
      break;
    case 'wh': case 'k': case 'kp': case 'combo': case 'txt': case 'release':
      H.input(m);
      break;
    case 'quality': applyQuality(p, m.v); break;
    case 'screen': switchSource(p, m.id).catch(e => localLog('화면 전환 실패: ' + e.message)); break;
    case 'screens': refreshSources().then(() => sendHello(p)); break;
    case 'clip-get': H.clipGet().then(text => dcSend(p, { t: 'clip', text: String(text || '').slice(0, 200000) })); break;
    case 'clip-set': H.clipSet(String(m.text || '').slice(0, 200000)); break;
  }
}

H.on('viewer-join', v => {
  viewers.set(v.id, v);
  renderViewers();
  createPeer(v.id).catch(e => localLog('연결 준비 실패: ' + e.message));
});
H.on('viewer-resume', () => renderViewers());
H.on('viewer-leave', ({ id }) => {
  closePeer(id);
  viewers.delete(id);
  renderViewers();
});
H.on('displays-changed', async () => {
  await refreshSources();
  for (const p of peers.values()) {
    if (p.sourceId && !sources.find(s => s.id === p.sourceId)) recoverCapture(p.sourceId);
    else sendHello(p);
  }
});

const sigChains = new Map();
H.on('signal', ({ id, data }) => {
  const prev = sigChains.get(id) || Promise.resolve();
  const next = prev.then(() => handleSignal(id, data)).catch(e => localLog('연결 처리 오류: ' + e.message));
  sigChains.set(id, next);
});

async function handleSignal(id, d) {
  if (d.type === 'renew') {
    localLog('뷰어 요청으로 연결을 새로 만들어요');
    return createPeer(id);
  }
  const p = peers.get(id);
  if (!p || (d.sid && d.sid !== p.sid)) return;
  if (d.type === 'answer') {
    if (p.pc.signalingState !== 'have-local-offer') return;
    await p.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
    for (const c of p.pendingCands.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
  } else if (d.type === 'cand') {
    if (p.pc.remoteDescription) await p.pc.addIceCandidate(d.c).catch(() => {});
    else p.pendingCands.push(d.c);
  } else if (d.type === 'restart') {
    if (p.pc.signalingState === 'stable') await negotiate(p, true);
    else if (p.pc.localDescription) H.toViewer(id, { type: 'offer', sid: p.sid, sdp: p.pc.localDescription.sdp });
  }
}

initUi().then(() => {
  // 앱이 다시 로드된 경우(오류 복구) 이미 접속 중인 뷰어에게 새 연결을 만든다
  for (const id of viewers.keys()) createPeer(id).catch(e => localLog('연결 준비 실패: ' + e.message));
});
