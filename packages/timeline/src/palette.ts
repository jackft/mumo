/** PixiJS color palette (0xRRGGBB format). Single source of truth for all timeline colors. */
export const palette = {
  primary:         0x4a9eff,
  primaryLight:    0xeef6ff,
  selection:       0x2196f3,

  danger:          0xe74c3c,

  speakerColors:   [0x4a9eff, 0x2ecc71, 0xe74c3c, 0xf39c12, 0x9b59b6, 0x1abc9c] as number[],
  speakerBgColors: [0xeef6ff, 0xeefff6, 0xffeef6, 0xfffeee, 0xf3eeff, 0xeefffc] as number[],

  event:           0x9575cd,
  eventBg:         0xf5f0ff,

  annotation:      0x26a69a,
  annotationBg:    0xedfaf8,

  bg0:             0xffffff,
  bg2:             0xf5f5f5,
  bg3:             0xf0f0f0,
  bg4:             0xe8e8e8,
  bg5:             0xe0e0e0,
  border:          0xd0d0d0,
  borderStrong:    0xdedede,
  separator:       0x777777,

  textDark:        0x333333,
  textMid:         0x444444,
  textLight:       0x888888,
  textFaint:       0x999999,

  playhead:        0xff4444,
  loopRegion:      0xff8800,
  waveform:        0x888888,
  waveformZero:    0xcccccc,
  signalHandle:    0xd0d0d0,
} as const
