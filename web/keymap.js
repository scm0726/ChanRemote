'use strict';
// 브라우저 KeyboardEvent.code → Windows 가상키(VK) [vk, 확장키여부]
(function () {
  const M = {
    Backspace: [0x08], Tab: [0x09], Enter: [0x0D], NumpadEnter: [0x0D, 1],
    ShiftLeft: [0xA0], ShiftRight: [0xA1], ControlLeft: [0xA2], ControlRight: [0xA3, 1],
    AltLeft: [0xA4], AltRight: [0xA5, 1], Pause: [0x13], CapsLock: [0x14], Escape: [0x1B], Space: [0x20],
    PageUp: [0x21, 1], PageDown: [0x22, 1], End: [0x23, 1], Home: [0x24, 1],
    ArrowLeft: [0x25, 1], ArrowUp: [0x26, 1], ArrowRight: [0x27, 1], ArrowDown: [0x28, 1],
    PrintScreen: [0x2C, 1], Insert: [0x2D, 1], Delete: [0x2E, 1],
    MetaLeft: [0x5B, 1], MetaRight: [0x5C, 1], OSLeft: [0x5B, 1], OSRight: [0x5C, 1], ContextMenu: [0x5D, 1],
    NumpadMultiply: [0x6A], NumpadAdd: [0x6B], NumpadSubtract: [0x6D], NumpadDecimal: [0x6E], NumpadDivide: [0x6F, 1],
    NumLock: [0x90, 1], ScrollLock: [0x91],
    Semicolon: [0xBA], Equal: [0xBB], Comma: [0xBC], Minus: [0xBD], Period: [0xBE], Slash: [0xBF], Backquote: [0xC0],
    BracketLeft: [0xDB], Backslash: [0xDC], BracketRight: [0xDD], Quote: [0xDE], IntlBackslash: [0xE2],
    Lang1: [0x15], Lang2: [0x19], KanaMode: [0x15], HangulMode: [0x15], Hanja: [0x19],
    AudioVolumeMute: [0xAD, 1], AudioVolumeDown: [0xAE, 1], AudioVolumeUp: [0xAF, 1],
    MediaTrackNext: [0xB0, 1], MediaTrackPrevious: [0xB1, 1], MediaPlayPause: [0xB3, 1]
  };
  for (let i = 0; i < 26; i++) M['Key' + String.fromCharCode(65 + i)] = [0x41 + i];
  for (let i = 0; i < 10; i++) { M['Digit' + i] = [0x30 + i]; M['Numpad' + i] = [0x60 + i]; }
  for (let i = 1; i <= 24; i++) M['F' + i] = [0x6F + i];

  window.CRKeys = {
    fromCode: code => M[code] || null,
    VK: {
      BACK: 0x08, TAB: 0x09, ENTER: 0x0D, SHIFT: 0xA0, CTRL: 0xA2, ALT: 0xA4, WIN: 0x5B, ESC: 0x1B,
      SPACE: 0x20, PGUP: 0x21, PGDN: 0x22, END: 0x23, HOME: 0x24, LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28,
      INS: 0x2D, DEL: 0x2E, HANGUL: 0x15, HANJA: 0x19, F1: 0x70, PRTSC: 0x2C
    }
  };
})();
