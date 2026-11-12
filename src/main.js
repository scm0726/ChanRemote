'use strict';
const {
  app, BrowserWindow, Tray, Menu, ipcMain, desktopCapturer, screen,
  powerSaveBlocker, clipboard, nativeImage, dialog, shell
} = require('electron');
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const crypto = require('crypto');
const QRCode = require('qrcode');
const config = require('./config');
const { createSignalServer } = require('./server');
const { createTurnServer, stunPublicIp } = require('./turn');
const upnp = require('./upnp');
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
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
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

// ── 화면 좌표 변환 (정규화 0~1 → 실제 물리 픽셀) ──
let displayCache = null;
function displays() {
  if (!displayCache) {
    const all = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    displayCache = all.map(d => ({
      id: String(d.id),
      primary: d.id === primary.id,
      rect: process.platform === 'win32'
        ? screen.dipToScreenRect(null, d.bounds)
        : { x: d.bounds.x * d.scaleFactor, y: d.bounds.y * d.scaleFactor, width: d.bounds.width * d.scaleFactor, height: d.bounds.height * d.scaleFactor }
    }));
  }
  return displayCache;
}
function invalidateDisplays() {
  displayCache = null;
  send('displays-changed', true);
}
function toPhys(displayId, nx, ny) {
  const list = displays();
  const d = list.find(x => x.id === String(displayId)) || list.find(x => x.primary) || list[0];
  const r = d.rect;
  const cx = Math.min(1, Math.max(0, Number(nx) || 0));
  const cy = Math.min(1, Math.max(0, Number(ny) || 0));
  return { x: r.x + cx * (r.width - 1), y: r.y + cy * (r.height - 1) };
}

function handleInput(m) {
  if (!m || typeof m !== 'object') return;
  try {
    switch (m.t) {
      case 'mm': { const p = toPhys(m.d, m.x, m.y); input.moveTo(p.x, p.y); break; }
      case 'mb':
        if (m.x != null) { const p = toPhys(m.d, m.x, m.y); input.moveTo(p.x, p.y); }
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
    const d = list.find(x => x.id === String(s.display_id)) || list[i] || list[0];
    return {
      id: s.id,
      displayId: d ? d.id : String(s.display_id),
      primary: d ? d.primary : i === 0,
      width: d ? d.rect.width : 0,
      height: d ? d.rect.height : 0,
      name: `모니터 ${i + 1}${d && d.primary ? ' (주)' : ''}`
    };
  });
}

function updateBlockers() {
  if (viewers.size > 0 && sessionBlocker === null) sessionBlocker = powerSaveBlocker.start('prevent-display-sleep');
  if (viewers.size === 0 && sessionBlocker !== null) { powerSaveBlocker.stop(sessionBlocker); sessionBlocker = null; }
  if (cfg.keepAwake && awakeBlocker === null) awakeBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!cfg.keepAwake && awakeBlocker !== null) { powerSaveBlocker.stop(awakeBlocker); awakeBlocker = null; }
  updateTray();
}

function applyAutoStart() {
  const settings = { openAtLogin: !!cfg.autoStart, args: ['--hidden'] };
  if (!app.isPackaged) {
    settings.path = process.execPath;
    settings.args = [app.getAppPath(), '--hidden'];
  }
  app.setLoginItemSettings(settings);
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(`ChanRemote — ${viewers.size ? `접속 ${viewers.size}명` : '대기 중'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'ChanRemote 열기', click: showWindow },
    { label: viewers.size ? `접속 중: ${[...viewers.values()].map(v => v.name).join(', ')}` : '접속자 없음', enabled: false },
    { type: 'separator' },
    { label: '모든 접속 끊기', enabled: viewers.size > 0, click: () => server && server.kickAll() },
    { label: '종료', click: () => { quitting = true; app.quit(); } }
  ]));
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
    autoStart: !!cfg.autoStart,
    keepAwake: !!cfg.keepAwake,
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
    if (pw.length < 4) throw new Error('비밀번호는 4자 이상');
    config.setPassword(cfg, pw);
    config.save(cfg);
    log('비밀번호가 변경되었어요 — 기존 접속은 모두 끊어요');
    if (server) server.kickAll();
    return true;
  });
  ipcMain.handle('set-autostart', (_e, on) => { cfg.autoStart = !!on; config.save(cfg); applyAutoStart(); return cfg.autoStart; });
  ipcMain.handle('set-keepawake', (_e, on) => { cfg.keepAwake = !!on; config.save(cfg); updateBlockers(); return cfg.keepAwake; });
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
        turn: turn && c ? { port: cfg.turnPort, username: c.username, credential: c.credential } : null,
        addrs: addressesForViewer(),
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
    log(`접속 서버 시작: 포트 ${cfg.port}`);
  } catch (e) {
    log('접속 서버 시작 실패: ' + e.message);
    dialog.showErrorBox('ChanRemote', `포트 ${cfg.port}을(를) 열 수 없어요.\n이미 실행 중이거나 다른 프로그램이 사용 중이에요.\n\n${e.message}`);
  }
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
    await refreshPrimaryIp();
    await startServers();
    checkNetwork('시작');
    setInterval(() => checkNetwork('주기 갱신'), 20 * 60 * 1000);
    setInterval(watchInterfaces, 30 * 1000);
  });

  app.on('before-quit', () => {
    quitting = true;
    input.releaseAll();
    if (server) server.close();
    if (turn) turn.stop();
  });
  app.on('window-all-closed', () => { /* 트레이에 상주 */ });
}
