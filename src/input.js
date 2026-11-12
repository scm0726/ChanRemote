'use strict';
// Windows 입력 주입 (SendInput / SetCursorPos) — koffi FFI 사용, 별도 컴파일 불필요
// INPUT 구조체(x64, 40바이트)를 Buffer로 직접 구성해 전달한다.

const INPUT_SIZE = 40;
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;

const MOUSEEVENTF = {
  LEFTDOWN: 0x0002, LEFTUP: 0x0004,
  RIGHTDOWN: 0x0008, RIGHTUP: 0x0010,
  MIDDLEDOWN: 0x0020, MIDDLEUP: 0x0040,
  XDOWN: 0x0080, XUP: 0x0100,
  WHEEL: 0x0800, HWHEEL: 0x1000
};
const KEYEVENTF = { EXTENDED: 0x0001, KEYUP: 0x0002, UNICODE: 0x0004 };

// 확장 키(E0 접두) — 이 플래그가 없으면 방향키가 숫자패드로 인식되는 등 문제가 생김
const EXTENDED_VK = new Set([
  0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, // PgUp PgDn End Home ←↑→↓
  0x2D, 0x2E, // Insert Delete
  0x5B, 0x5C, 0x5D, // LWin RWin Apps
  0xA3, 0xA5, // RCtrl RAlt
  0x6F, 0x90, 0x2C // Numpad / , NumLock, PrintScreen
]);

let api = null;
const heldKeys = new Map(); // vk -> ext
const heldButtons = new Set();

function init() {
  if (api) return true;
  if (process.platform !== 'win32') {
    console.warn('[input] Windows 전용입니다. 입력 주입 비활성화');
    return false;
  }
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    api = {
      SendInput: user32.func('uint32 __stdcall SendInput(uint32 cInputs, void *pInputs, int cbSize)'),
      SetCursorPos: user32.func('int __stdcall SetCursorPos(int X, int Y)'),
      MapVirtualKeyW: user32.func('uint32 __stdcall MapVirtualKeyW(uint32 uCode, uint32 uMapType)')
    };
    return true;
  } catch (e) {
    console.error('[input] 초기화 실패', e);
    api = null;
    return false;
  }
}

function sendBuffer(buf, count) {
  if (!api || count <= 0) return 0;
  return api.SendInput(count, buf, INPUT_SIZE);
}

function writeMouse(buf, i, flags, data = 0) {
  const o = i * INPUT_SIZE;
  buf.writeUInt32LE(INPUT_MOUSE, o);
  buf.writeInt32LE(0, o + 8); // dx
  buf.writeInt32LE(0, o + 12); // dy
  buf.writeInt32LE(data | 0, o + 16); // mouseData (휠은 음수 가능)
  buf.writeUInt32LE(flags >>> 0, o + 20);
}

function writeKey(buf, i, vk, scan, flags) {
  const o = i * INPUT_SIZE;
  buf.writeUInt32LE(INPUT_KEYBOARD, o);
  buf.writeUInt16LE(vk & 0xffff, o + 8);
  buf.writeUInt16LE(scan & 0xffff, o + 10);
  buf.writeUInt32LE(flags >>> 0, o + 12);
}

function moveTo(x, y) {
  if (!api) return;
  api.SetCursorPos(Math.round(x), Math.round(y));
}

function buttonFlags(b, down) {
  switch (b) {
    case 1: return [down ? MOUSEEVENTF.MIDDLEDOWN : MOUSEEVENTF.MIDDLEUP, 0];
    case 2: return [down ? MOUSEEVENTF.RIGHTDOWN : MOUSEEVENTF.RIGHTUP, 0];
    case 3: return [down ? MOUSEEVENTF.XDOWN : MOUSEEVENTF.XUP, 1];
    case 4: return [down ? MOUSEEVENTF.XDOWN : MOUSEEVENTF.XUP, 2];
    default: return [down ? MOUSEEVENTF.LEFTDOWN : MOUSEEVENTF.LEFTUP, 0];
  }
}

function button(b, down) {
  if (!api) return;
  const [flags, data] = buttonFlags(b | 0, down);
  const buf = Buffer.alloc(INPUT_SIZE);
  writeMouse(buf, 0, flags, data);
  sendBuffer(buf, 1);
  if (down) heldButtons.add(b | 0); else heldButtons.delete(b | 0);
}

function wheel(dy, dx) {
  if (!api) return;
  const list = [];
  if (dy) list.push([MOUSEEVENTF.WHEEL, Math.max(-12000, Math.min(12000, dy | 0))]);
  if (dx) list.push([MOUSEEVENTF.HWHEEL, Math.max(-12000, Math.min(12000, dx | 0))]);
  if (!list.length) return;
  const buf = Buffer.alloc(INPUT_SIZE * list.length);
  list.forEach(([f, d], i) => writeMouse(buf, i, f, d));
  sendBuffer(buf, list.length);
}

function keyFlags(vk, down, ext) {
  return (down ? 0 : KEYEVENTF.KEYUP) | ((ext || EXTENDED_VK.has(vk)) ? KEYEVENTF.EXTENDED : 0);
}

function key(vk, down, ext) {
  if (!api || !vk) return;
  vk &= 0xff;
  const scan = api.MapVirtualKeyW(vk, 0);
  const buf = Buffer.alloc(INPUT_SIZE);
  writeKey(buf, 0, vk, scan, keyFlags(vk, down, ext));
  sendBuffer(buf, 1);
  if (down) heldKeys.set(vk, !!ext); else heldKeys.delete(vk);
}

function press(vk, ext) {
  key(vk, true, ext);
  key(vk, false, ext);
}

function combo(keys) {
  if (!Array.isArray(keys)) return;
  const list = keys.slice(0, 6).map(k => (typeof k === 'number' ? { vk: k, ext: false } : { vk: k.vk | 0, ext: !!k.ext }));
  list.forEach(k => key(k.vk, true, k.ext));
  list.slice().reverse().forEach(k => key(k.vk, false, k.ext));
}

// 유니코드 문자 직접 입력 (한글 포함) — 호스트 IME 상태와 무관하게 그대로 입력됨
function text(s) {
  if (!api || !s) return;
  s = String(s).replace(/\r\n?/g, '\n');
  let chunk = [];
  const flush = () => {
    if (!chunk.length) return;
    const buf = Buffer.alloc(INPUT_SIZE * chunk.length * 2);
    let n = 0;
    for (const cu of chunk) {
      writeKey(buf, n++, 0, cu, KEYEVENTF.UNICODE);
      writeKey(buf, n++, 0, cu, KEYEVENTF.UNICODE | KEYEVENTF.KEYUP);
    }
    sendBuffer(buf, n);
    chunk = [];
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\n') { flush(); press(0x0D); continue; }
    if (ch === '\t') { flush(); press(0x09); continue; }
    chunk.push(s.charCodeAt(i));
    if (chunk.length >= 200) flush();
  }
  flush();
}

// 꺼진 모니터 깨우기 (마우스를 1픽셀 움직였다 되돌림)
function wake() {
  if (!api) return;
  const buf = Buffer.alloc(INPUT_SIZE * 2);
  [[1, 0], [-1, 0]].forEach(([dx, dy], i) => {
    const o = i * INPUT_SIZE;
    buf.writeUInt32LE(INPUT_MOUSE, o);
    buf.writeInt32LE(dx, o + 8);
    buf.writeInt32LE(dy, o + 12);
    buf.writeUInt32LE(0x0001, o + 20); // MOUSEEVENTF_MOVE
  });
  sendBuffer(buf, 2);
}

function releaseAll() {
  for (const [vk, ext] of [...heldKeys]) key(vk, false, ext);
  for (const b of [...heldButtons]) button(b, false);
}

module.exports = { init, moveTo, button, wheel, key, press, combo, text, releaseAll, wake };
