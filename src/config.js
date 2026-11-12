'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ITER = 100000;

const DEFAULTS = {
  port: 8787, // 접속(웹/시그널링) TCP 포트
  turnPort: 3478, // 내장 중계 UDP+TCP 포트
  deviceId: null, // 9자리 PC ID (첫 실행 때 생성)
  unattended: true, // 무인 접속 (기본 켜짐): 절전·화면잠금 해제, 수락 없이 바로 접속
  upnp: true, // 공유기 포트 자동 열기 (직접 연결이 막힐 때 대비용)
  salt: null,
  iter: ITER,
  key: null, // PBKDF2-SHA256(비밀번호) — 비밀번호 원문은 저장하지 않음
  autoStart: true,
  turn: null // 외부 TURN을 따로 쓸 때만: { urls, username, credential }
};

let file = null;

function load(app) {
  file = path.join(app.getPath('userData'), 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 첫 실행 */ }
  const merged = { ...DEFAULTS, ...cfg };
  delete merged.passwordHash; // 구버전 형식 제거
  delete merged.keepAwake;
  if (!/^\d{9}$/.test(String(merged.deviceId || ''))) merged.deviceId = newDeviceId();
  return merged;
}

function newDeviceId() {
  // 첫 자리는 0이 아니게, 9자리 숫자
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
  const salt = crypto.randomBytes(16);
  cfg.salt = salt.toString('hex');
  cfg.iter = ITER;
  cfg.key = crypto.pbkdf2Sync(String(pw), salt, ITER, 32, 'sha256').toString('hex');
}

const hmac = (keyHex, text) => crypto.createHmac('sha256', Buffer.from(keyHex, 'hex')).update(text, 'utf8').digest();

// 비밀번호 대신 증명값으로 확인 (비밀번호가 네트워크에 오가지 않음)
function verifyProof(cfg, nonce, proofHex) {
  if (!cfg.key) return false;
  try {
    const expect = hmac(cfg.key, 'auth:' + nonce);
    const got = Buffer.from(String(proofHex || ''), 'hex');
    return got.length === expect.length && crypto.timingSafeEqual(expect, got);
  } catch {
    return false;
  }
}

function sessionKey(cfg, nonce) {
  return hmac(cfg.key, 'sess:' + nonce);
}

module.exports = { load, save, setPassword, verifyProof, sessionKey, getFile: () => file };
