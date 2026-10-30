/** PixiJS color palette (0xRRGGBB format). Single source of truth for all timeline colors. */
export interface TimelinePalette {
  primary: number
  primaryLight: number
  selection: number

  danger: number

  participantColors: number[]
  participantBgColors: number[]

  event: number
  eventBg: number

  annotation: number
  annotationBg: number

  bg0: number
  /** Timeline canvas/panel background — distinct from bg0 so it can run darker than the editor in dark mode. */
  tlBg: number
  bg2: number
  bg3: number
  bg4: number
  bg5: number
  border: number
  borderStrong: number
  separator: number

  textDark: number
  textMid: number
  textLight: number
  textFaint: number

  playhead: number
  loopRegion: number
  waveform: number
  waveformZero: number
  pitch: number
  signalHandle: number
}

const lightPalette: TimelinePalette = {
  primary:         0x4a9eff,
  primaryLight:    0xeef6ff,
  selection:       0x2196f3,

  danger:          0xe74c3c,

  participantColors:   [0x4a9eff, 0x2ecc71, 0xe74c3c, 0xf39c12, 0x9b59b6, 0x1abc9c],
  participantBgColors: [0xeef6ff, 0xeefff6, 0xffeef6, 0xfffeee, 0xf3eeff, 0xeefffc],

  event:           0x9575cd,
  eventBg:         0xf5f0ff,

  annotation:      0x26a69a,
  annotationBg:    0xedfaf8,

  bg0:             0xffffff,
  tlBg:            0xf5f5f5,
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
  pitch:           0x2979ff,  // blue
  signalHandle:    0xd0d0d0,
}

/** VS Code "Dark Modern" inspired — editor.background, descriptionForeground, syntax hues, etc. */
const darkPalette: TimelinePalette = {
  primary:         0x3794ff,  // focusBorder / textLink.foreground
  primaryLight:    0x04395e,  // list.inactiveSelectionBackground
  selection:       0x3794ff,

  danger:          0xf14c4c,  // editorError.foreground

  participantColors:   [0x3794ff, 0x4ec9b0, 0xf14c4c, 0xcca700, 0xc586c0, 0xb5cea8],
  participantBgColors: [0x0b2942, 0x0e3b34, 0x3a1d1d, 0x3a2e00, 0x3b2840, 0x2b3b22],

  event:           0x569cd6,  // keyword blue
  eventBg:         0x1b2a3a,

  annotation:      0x4ec9b0,  // type teal
  annotationBg:    0x0e3b34,

  bg0:             0x1e1e1e,  // editor.background
  tlBg:            0x181818,  // panel.background — darker than the editor so the timeline reads as its own panel
  bg2:             0x252526,  // sideBar.background
  bg3:             0x2d2d2d,  // tab.inactiveBackground
  bg4:             0x333333,  // activityBar.background
  bg5:             0x3c3c3c,  // input.background
  border:          0x454545,  // widget border
  borderStrong:    0x555555,
  separator:       0x6a6a6a,

  textDark:        0xcccccc,  // editor.foreground
  textMid:         0xbbbbbb,
  textLight:       0x9d9d9d,  // descriptionForeground
  textFaint:       0x797979,

  playhead:        0xff6666,
  loopRegion:      0xffa94d,
  waveform:        0x9d9d9d,
  waveformZero:    0x5a5a5a,
  pitch:           0x4fc3f7,
  signalHandle:    0x555555,
}

/** Live, mutable palette — mutated in place by `applyPaletteTheme` so existing `palette.x` reads everywhere pick up the new values without re-importing. */
export const palette: TimelinePalette = { ...lightPalette }

export function applyPaletteTheme(theme: 'light' | 'dark'): void {
  Object.assign(palette, theme === 'dark' ? darkPalette : lightPalette)
}
