'use strict';
const {
  app, BrowserWindow, Tray, Menu, ipcMain, desktopCapturer, screen,
  powerSaveBlocker, clipboard, nativeImage, dialog, shell
} = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const crypto = require('crypto');
const QRCode = require('qrcode');
const config = require('./config');
const { createSignalServer } = require('./server');
const { createTurnServer, stunPublicIp } = require('./turn');
const upnp = require('./upnp');
const { createMqttRelay } = require('./mqtt-relay');
const input = require('./input');

// ── 끊김 방지: 창이 숨겨져 있어도 캡처/전송이 느려지지 않게 ──
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// 로컬 IP를 mDNS로 숨기지 않음 → 같은 와이파이/중계에서 직접 연결이 잘 됨
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns,CalculateNativeWinOcclusion');

const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const startHidden = process.argv.includes('--hidden');

let cfg;
let win = null;
let tray = null;
let server = null;
let turn = null;
let relay = null;
let relayStatus = { connected: 0, total: 3 };
let viewerWin = null;
let quitting = false;
let sessionBlocker = null;
let awakeBlocker = null;
const viewers = new Map();
const turnCreds = new Map(); // viewerId -> { username, credential }
const logs = [];
let net = { upnp: 'checking', reason: null, externalIp: null, publicIp: null, doubleNat: false, checkedAt: 0 };
let primaryIp = null;

function log(msg) {
  const line = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`;
  logs.push(line);
  if (logs.length > 200) logs.shift();
  console.log(line);
  send('log', line);
}

function send(ch, data) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data);
}

function stunServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  if (cfg.turn) list.push(...(Array.isArray(cfg.turn) ? cfg.turn : [cfg.turn]));
  return list;
}

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const [o1, o2] = a.address.split('.').map(Number);
      out.push({ name, ip: a.address, tailscale: o1 === 100 && o2 >= 64 && o2 <= 127 });
    }
  }
  // 기본 경로 IP를 맨 앞으로
  out.sort((a, b) => (b.ip === primaryIp) - (a.ip === primaryIp));
  return out;
}

function refreshPrimaryIp() {
  return new Promise(resolve => {
    const s = dgram.createSocket('udp4');
    s.on('error', () => { try { s.close(); } catch { /* ignore */ } resolve(primaryIp); });
    s.connect(53, '8.8.8.8', () => {
      try { primaryIp = s.address().address; } catch { /* ignore */ }
      try { s.close(); } catch { /* ignore */ }
      resolve(primaryIp);
    });
  });
}

function relayIp() {
  if (primaryIp) return primaryIp;
  const l = lanAddresses();
  return l.length ? l[0].ip : '127.0.0.1';
}

function addressesForViewer() {
  return {
    lan: lanAddresses().map(a => `${a.ip}:${cfg.port}`),
    wan: net.externalIp && !upnp.isPrivateIp(net.externalIp) && net.upnp === 'ok' ? `${net.externalIp}:${cfg.port}` : null
  };
}

// ── 공유기 자동 포트 열기 + 공인 IP 확인 ──
let netBusy = false;
async function checkNetwork(reason) {
  if (netBusy) return;
  netBusy = true;
  try {
    await refreshPrimaryIp();
    net.publicIp = await stunPublicIp();
    if (!cfg.upnp) {
      net = { ...net, upnp: 'off', reason: '자동 포트 열기 꺼짐', externalIp: null, doubleNat: false };
    } else {
      const r = await upnp.mapPorts([
        { port: cfg.port, protocol: 'TCP' },
        { port: cfg.turnPort, protocol: 'UDP' },
        { port: cfg.turnPort, protocol: 'TCP' }
      ]);
      const doubleNat = !!(r.externalIp && (upnp.isPrivateIp(r.externalIp) || (net.publicIp && net.publicIp !== r.externalIp)));
      net = {
        ...net,
        upnp: r.ok && !doubleNat ? 'ok' : 'fail',
        reason: doubleNat ? '공유기가 두 개 연결돼 있어요(이중 NAT). 바깥 공유기에도 포트포워딩이 필요해요' : r.reason,
        externalIp: r.externalIp || null,
        doubleNat
      };
    }
    net.checkedAt = Date.now();
    log(`네트워크 확인(${reason}): ${net.upnp === 'ok' ? `외부 접속 가능 ${net.externalIp}:${cfg.port}` : `외부 접속 준비 안 됨 — ${net.reason || '알 수 없음'}`}`);
  } catch (e) {
    net.upnp = 'fail';
    net.reason = e.message;
    log('네트워크 확인 실패: ' + e.message);
  } finally {
    netBusy = false;
    send('net-status', publicNetStatus());
  }
}

function publicNetStatus() {
  return { ...net, port: cfg.port, turnPort: cfg.turnPort, wan: addressesForViewer().wan };
}

let lastIfaces = '';
function watchInterfaces() {
  const now = JSON.stringify(lanAddresses().map(a => a.ip));
  if (lastIfaces && now !== lastIfaces) {
    upnp.resetCache();
    checkNetwork('네트워크 변경');
  }
  lastIfaces = now;
}

// ── 화면 좌표 변환 ──
// 한 모니터 안의 정규화 좌표(0~1)를, 전체 가상 화면 기준 절대좌표(0~65535)로 변환.
// 모두 DIP(배율 적용 전) 좌표로 비율만 계산하므로 화면 배율·다중 모니터에 영향받지 않음.
let displayCache = null;
function displays() {
  if (!displayCache) {
    const all = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const d of all) {
      minX = Math.min(minX, d.bounds.x);
      minY = Math.min(minY, d.bounds.y);
      maxX = Math.max(maxX, d.bounds.x + d.bounds.width);
      maxY = Math.max(maxY, d.bounds.y + d.bounds.height);
    }
    const virt = { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
    const list = all.map(d => ({
      id: String(d.id),
      primary: d.id === primary.id,
      bounds: d.bounds,
      w: Math.round(d.bounds.width * d.scaleFactor), // 캡처 해상도 표시용
      h: Math.round(d.bounds.height * d.scaleFactor)
    }));
    displayCache = { virt, list };
  }
  return displayCache;
}
function invalidateDisplays() {
  displayCache = null;
  send('displays-changed', true);
}
function toVirtual(displayId, nx, ny) {
  const { virt, list } = displays();
  const d = list.find(x => x.id === String(displayId)) || list.find(x => x.primary) || list[0];
  const b = d.bounds;
  const cx = Math.min(1, Math.max(0, Number(nx) || 0));
  const cy = Math.min(1, Math.max(0, Number(ny) || 0));
  return {
    ax: ((b.x - virt.x) + cx * b.width) / virt.width * 65535,
    ay: ((b.y - virt.y) + cy * b.height) / virt.height * 65535
  };
}

function handleInput(m) {
  if (!m || typeof m !== 'object') return;
  try {
    switch (m.t) {
      case 'mm': { const p = toVirtual(m.d, m.x, m.y); input.moveAbs(p.ax, p.ay); break; }
      case 'mb':
        if (m.x != null) { const p = toVirtual(m.d, m.x, m.y); input.moveAbs(p.ax, p.ay); }
        input.button(m.b | 0, !!m.down);
        break;
      case 'wh': input.wheel(m.dy | 0, m.dx | 0); break;
      case 'k': input.key(m.vk | 0, !!m.down, !!m.ext); break;
      case 'kp': input.press(m.vk | 0, !!m.ext); break;
      case 'combo': input.combo(m.keys); break;
      case 'txt': input.text(String(m.s || '').slice(0, 4000)); break;
      case 'release': input.releaseAll(); break;
    }
  } catch (e) {
    log('입력 처리 오류: ' + e.message);
  }
}

async function getSources() {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const list = displays();
  return sources.map((s, i) => {
    const d = list.list.find(x => x.id === String(s.display_id)) || list.list[i] || list.list[0];
    return {
      id: s.id,
      displayId: d ? d.id : String(s.display_id),
      primary: d ? d.primary : i === 0,
      width: d ? d.w : 0,
      height: d ? d.h : 0,
      name: `모니터 ${i + 1}${d && d.primary ? ' (주)' : ''}`
    };
  });
}

function updateBlockers() {
  if (viewers.size > 0 && sessionBlocker === null) sessionBlocker = powerSaveBlocker.start('prevent-display-sleep');
  if (viewers.size === 0 && sessionBlocker !== null) { powerSaveBlocker.stop(sessionBlocker); sessionBlocker = null; }
  if (cfg.unattended && awakeBlocker === null) awakeBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!cfg.unattended && awakeBlocker !== null) { powerSaveBlocker.stop(awakeBlocker); awakeBlocker = null; }
  updateTray();
}

function applyAutoStart() {
  const settings = { openAtLogin: !!cfg.autoStart, args: ['--hidden'] };
  // 무설치(포터블) 실행 파일 경로는 PORTABLE_EXECUTABLE_FILE 로 들어옴
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portable) {
    settings.path = portable;
  } else if (!app.isPackaged) {
    settings.path = process.execPath;
    settings.args = [app.getAppPath(), '--hidden'];
  }
  try { app.setLoginItemSettings(settings); } catch { /* ignore */ }
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(`ChanRemote — ID ${cfg.deviceId} — ${viewers.size ? `접속 ${viewers.size}명` : relayStatus.connected ? '대기 중' : '인터넷 연결 확인 중'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'ChanRemote 열기', click: showWindow },
    { label: '다른 PC 원격 접속', click: openViewerWindow },
    { label: viewers.size ? `접속 중: ${[...viewers.values()].map(v => v.name).join(', ')}` : '접속자 없음', enabled: false },
    { type: 'separator' },
    { label: '모든 접속 끊기', enabled: viewers.size > 0, click: () => server && server.kickAll() },
    { label: '종료', click: () => { quitting = true; app.quit(); } }
  ]));
}

// ── 무인 접속: 자리에 아무도 없어도 접속되도록 절전·자동 잠금 끄기 ──
function run(cmd, args) {
  return new Promise(resolve => execFile(cmd, args, { windowsHide: true }, err => resolve(!err)));
}
async function applyUnattended() {
  if (process.platform !== 'win32' || !cfg.unattended) return;
  const results = await Promise.all([
    run('powercfg', ['/change', 'standby-timeout-ac', '0']),
    run('powercfg', ['/change', 'hibernate-timeout-ac', '0']),
    run('powercfg', ['/SETACVALUEINDEX', 'SCHEME_CURRENT', 'SUB_NONE', 'CONSOLELOCK', '0']),
    run('reg', ['add', 'HKCU\\Control Panel\\Desktop', '/v', 'ScreenSaverIsSecure', '/t', 'REG_SZ', '/d', '0', '/f']),
    run('reg', ['add', 'HKCU\\Control Panel\\Desktop', '/v', 'ScreenSaveActive', '/t', 'REG_SZ', '/d', '0', '/f']),
    run('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon', '/v', 'EnableGoodbye', '/t', 'REG_DWORD', '/d', '0', '/f'])
  ]);
  await run('powercfg', ['/SETACTIVE', 'SCHEME_CURRENT']);
  const ok = results.filter(Boolean).length;
  log(`무인 접속 설정 적용: 절전·자동 잠금 해제 (${ok}/${results.length})`);
}

// ── 다른 PC에 원격 접속하는 창 ──
function openViewerWindow() {
  if (viewerWin && !viewerWin.isDestroyed()) { viewerWin.show(); viewerWin.focus(); return; }
  viewerWin = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'ChanRemote — 원격 접속',
    icon: ICON,
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  viewerWin.setMenuBarVisibility(false);
  viewerWin.loadFile(path.join(__dirname, '..', 'web', 'index.html'));
  viewerWin.on('closed', () => { viewerWin = null; });
}

function createWindow() {
  win = new BrowserWindow({
    width: 500,
    height: 860,
    minWidth: 420,
    minHeight: 560,
    title: 'ChanRemote',
    icon: ICON,
    show: !startHidden,
    backgroundColor: '#0e1117',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'host', 'index.html'));
  win.on('close', e => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    log('화면 전송 프로세스 오류(' + details.reason + ') — 자동 재시작');
    setTimeout(() => { if (win && !win.isDestroyed()) win.reload(); }, 1000);
  });
}

function setupIpc() {
  ipcMain.handle('state', () => ({
    port: cfg.port,
    turnPort: cfg.turnPort,
    hasPassword: !!cfg.key,
    deviceId: cfg.deviceId,
    relay: relayStatus,
    autoStart: !!cfg.autoStart,
    unattended: !!cfg.unattended,
    upnp: !!cfg.upnp,
    addresses: lanAddresses().map(a => ({ ...a, url: `http://${a.ip}:${cfg.port}` })),
    net: publicNetStatus(),
    viewers: [...viewers.entries()].map(([id, v]) => ({ id, ...v })),
    iceServers: stunServers(),
    hostName: os.hostname(),
    version: app.getVersion(),
    logs: logs.slice(-60),
    inputOk: input.init()
  }));
  ipcMain.handle('set-password', (_e, pw) => {
    pw = String(pw || '');
    if (pw.length < 6) throw new Error('비밀번호는 6자 이상');
    config.setPassword(cfg, pw);
    config.save(cfg);
    log('비밀번호가 변경되었어요 — 기존 접속은 모두 끊어요');
    if (server) server.kickAll();
    return true;
  });
  ipcMain.handle('set-autostart', (_e, on) => { cfg.autoStart = !!on; config.save(cfg); applyAutoStart(); return cfg.autoStart; });
  ipcMain.handle('set-unattended', (_e, on) => { cfg.unattended = !!on; config.save(cfg); updateBlockers(); applyUnattended(); return cfg.unattended; });
  ipcMain.on('open-viewer', () => openViewerWindow());
  ipcMain.on('copy-text', (_e, t) => clipboard.writeText(String(t || '')));
  ipcMain.handle('set-upnp', async (_e, on) => { cfg.upnp = !!on; config.save(cfg); upnp.resetCache(); checkNetwork('설정 변경'); return cfg.upnp; });
  ipcMain.handle('recheck-net', () => { upnp.resetCache(); checkNetwork('다시 확인'); return true; });
  ipcMain.handle('set-port', (_e, p) => {
    p = Number(p);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('포트는 1024~65535');
    cfg.port = p;
    config.save(cfg);
    quitting = true;
    app.relaunch();
    app.exit(0);
    return true;
  });
  ipcMain.handle('sources', () => getSources());
  ipcMain.handle('qr', (_e, text) => QRCode.toDataURL(String(text), { margin: 1, width: 240 }));
  ipcMain.handle('clip-get', () => clipboard.readText());
  ipcMain.on('clip-set', (_e, text) => clipboard.writeText(String(text || '')));
  ipcMain.on('to-viewer', (_e, { id, data }) => { if (server) server.signal(id, data); });
  ipcMain.on('input', (_e, m) => handleInput(m));
  ipcMain.on('kick', (_e, id) => { if (server) server.kick(id); });
  ipcMain.on('open-external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
}

async function startServers() {
  turn = createTurnServer({ port: cfg.turnPort, relayIp, log });
  try {
    await turn.start();
    log(`중계 서버 시작: 포트 ${cfg.turnPort} (UDP/TCP)`);
  } catch (e) {
    log('중계 서버 시작 실패: ' + e.message + ' — 밖에서 접속이 불안정할 수 있어요');
    turn = null;
  }

  server = createSignalServer({
    port: cfg.port,
    webDir: path.join(__dirname, '..', 'web'),
    log,
    auth: {
      info: () => ({ salt: cfg.salt, iter: cfg.iter, hostName: os.hostname() }),
      verify: (nonce, proof) => config.verifyProof(cfg, nonce, proof),
      sessionKey: nonce => config.sessionKey(cfg, nonce)
    },
    extraAuthOk: id => {
      const c = turnCreds.get(id);
      return {
        iceServers: stunServers(),
        turn: turn && c ? {
          host: net.upnp === 'ok' && net.externalIp ? net.externalIp : null,
          lan: relayIp(),
          port: cfg.turnPort,
          username: c.username,
          credential: c.credential
        } : null,
        addrs: addressesForViewer(),
        deviceId: cfg.deviceId,
        hostName: os.hostname()
      };
    },
    onJoin: (id, info) => {
      if (turn) {
        const c = { username: 'v' + crypto.randomBytes(6).toString('hex'), credential: crypto.randomBytes(16).toString('hex') };
        turn.addUser(c.username, c.credential);
        turnCreds.set(id, c);
      }
      viewers.set(id, info);
      send('viewer-join', { id, ...info });
      updateBlockers();
      input.wake(); // 꺼진 모니터 깨우기
    },
    onResume: id => send('viewer-resume', { id }),
    onSignal: (id, data) => send('signal', { id, data }),
    onLeave: id => {
      const c = turnCreds.get(id);
      if (c && turn) turn.removeUser(c.username);
      turnCreds.delete(id);
      viewers.delete(id);
      send('viewer-leave', { id });
      input.releaseAll();
      updateBlockers();
    }
  });
  try {
    await server.start();
    log(`집 안 접속 서버 시작: 포트 ${cfg.port}`);
  } catch (e) {
    log('집 안 접속 서버 시작 실패: ' + e.message + ' (ID 접속은 계속 돼요)');
  }

  relay = createMqttRelay({
    deviceId: cfg.deviceId,
    getKey: () => (cfg.key ? Buffer.from(cfg.key, 'hex') : null),
    onViewer: sock => server.attach(sock, 'remote'),
    log,
    onStatus: st => {
      const was = relayStatus.connected;
      relayStatus = st;
      if (!was && st.connected) log(`중계망 연결됨 (${st.connected}/${st.total}) — PC ID ${cfg.deviceId}로 접속할 수 있어요`);
      if (was && !st.connected) log('중계망 연결이 모두 끊겼어요 — 인터넷 연결을 확인하세요 (자동으로 다시 연결해요)');
      send('relay-status', st);
      updateTray();
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    cfg = config.load(app);
    config.save(cfg);
    if (!input.init()) log('⚠ 입력 주입 초기화 실패 — 화면 보기만 가능해요');
    setupIpc();
    createWindow();

    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
    updateTray();

    screen.on('display-added', invalidateDisplays);
    screen.on('display-removed', invalidateDisplays);
    screen.on('display-metrics-changed', invalidateDisplays);

    applyAutoStart();
    updateBlockers();
    applyUnattended();
    await refreshPrimaryIp();
    await startServers();
    checkNetwork('시작');
    setInterval(() => checkNetwork('주기 갱신'), 20 * 60 * 1000);
    setInterval(watchInterfaces, 30 * 1000);
  });

  app.on('before-quit', () => {
    quitting = true;
    input.releaseAll();
    if (relay) relay.stop();
    if (server) server.close();
    if (turn) turn.stop();
  });
  app.on('window-all-closed', () => { /* 트레이에 상주 */ });
}
