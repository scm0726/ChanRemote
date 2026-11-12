'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ITER = 100000;
// 마스터(관리자) 비밀번호는 여러 PC에서 같은 키가 나와야 하므로 고정 솔트를 사용
const MASTER_SALT = 'chanremote-master-v1';
const MASTER_ITER = 100000;
const FLEET_SALT = 'chanremote-fleet-v1';
const FLEET_ITER = 60000;

const DEFAULTS = {
  port: 8787, // 같은 와이파이 접속용 TCP 포트
  turnPort: 3478, // 내장 중계 UDP+TCP 포트
  deviceId: null, // 9자리 PC ID (첫 실행 때 생성)
  unattended: true, // 무인 접속 (기본 켜짐)
  upnp: true, // 공유기 포트 자동 열기 (직접 연결이 막힐 때 대비용)
  startHidden: false, // 실행하면 창 없이 트레이로 바로 숨기기
  trayHidden: false, // 트레이 아이콘까지 숨기기
  salt: null,
  iter: ITER,
  key: null, // 개인 비밀번호 키 (PBKDF2)
  masterKey: null, // 마스터(관리자) 비밀번호 키
  fleetId: null, // 마스터 비밀번호로 만든 "내 PC 묶음" 식별자
  autoStart: true,
  turn: null
};

let file = null;

function load(app) {
  file = path.join(app.getPath('userData'), 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 첫 실행 */ }
  const merged = { ...DEFAULTS, ...cfg };
  delete merged.passwordHash;
  delete merged.keepAwake;
  if (!/^\d{9}$/.test(String(merged.deviceId || ''))) merged.deviceId = newDeviceId();
  return merged;
}

function newDeviceId() {
  return String(crypto.randomInt(1, 10)) + String(crypto.randomInt(0, 1e8)).padStart(8, '0');
}

function save(cfg) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    console.error('config save failed', e);
  }
}

function setPassword(cfg, pw) {
  if (!pw) { cfg.salt = null; cfg.key = null; return; }
  const salt = crypto.randomBytes(16);
  cfg.salt = salt.toString('hex');
  cfg.iter = ITER;
  cfg.key = crypto.pbkdf2Sync(String(pw), salt, ITER, 32, 'sha256').toString('hex');
}

function setMasterPassword(cfg, pw) {
  if (!pw) { cfg.masterKey = null; cfg.fleetId = null; return; }
  cfg.masterKey = crypto.pbkdf2Sync(String(pw), MASTER_SALT, MASTER_ITER, 32, 'sha256').toString('hex');
  cfg.fleetId = crypto.pbkdf2Sync(String(pw), FLEET_SALT, FLEET_ITER, 8, 'sha256').toString('hex');
}

const hmac = (keyHex, text) => crypto.createHmac('sha256', Buffer.from(keyHex, 'hex')).update(text, 'utf8').digest();

function timingEqHmac(keyHex, text, gotHex) {
  try {
    const expect = hmac(keyHex, text);
    const got = Buffer.from(String(gotHex || ''), 'hex');
    return got.length === expect.length && crypto.timingSafeEqual(expect, got);
  } catch {
    return false;
  }
}

// 개인 비밀번호 또는 마스터 비밀번호 중 하나라도 맞으면 그 키(hex)를 돌려줌 (아니면 null)
function verifyProof(cfg, nonce, proofHex) {
  if (cfg.key && timingEqHmac(cfg.key, 'auth:' + nonce, proofHex)) return cfg.key;
  if (cfg.masterKey && timingEqHmac(cfg.masterKey, 'auth:' + nonce, proofHex)) return cfg.masterKey;
  return null;
}

function sessionKey(keyHex, nonce) {
  return hmac(keyHex, 'sess:' + nonce);
}

// 마스터 비밀번호로 "내 PC 묶음" 알림을 암호화할 키
function fleetEncKey(cfg) {
  return cfg.masterKey ? hmac(cfg.masterKey, 'fleet') : null;
}

module.exports = {
  load, save, setPassword, setMasterPassword, verifyProof, sessionKey, fleetEncKey,
  getFile: () => file,
  constants: { MASTER_SALT, MASTER_ITER, FLEET_SALT, FLEET_ITER }
};
