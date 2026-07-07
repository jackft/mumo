// The app version comes from the ROOT package.json (single source of truth
// for releases — the release workflow checks git tags against it). This file
// is a .cjs config instead of electron-builder.yml so it can inject that
// version via extraMetadata.
const { version } = require('../../package.json')

module.exports = {
  appId: 'com.mumo.app',
  productName: 'mumo',
  copyright: 'Copyright © 2026 Jack Terwilliger',
  artifactName: 'mumo-${version}-${arch}.${ext}',
  extraMetadata: { version },
  directories: {
    buildResources: 'resources',
    output: 'dist',
  },
  files: [
    'out/**/*',
    '!out/renderer/*.mp4',
    '!out/renderer/*.eaf',
  ],
  extraResources: [
    { from: 'resources/icons/256x256.png', to: 'icon.png' },
  ],
  // Native module rebuild happens explicitly in the pack/dist scripts
  // (electron-rebuild). electron-builder must not touch node_modules.
  npmRebuild: false,
  asarUnpack: ['**/*.node'],
  pacman: {
    depends: [],
  },
  linux: {
    target: ['AppImage', 'deb'],
    executableName: 'mumo',
    icon: 'resources/icons',
    category: 'AudioVideo',
    maintainer: 'Jack Terwilliger <jack.f.terwilliger@gmail.com>',
    description: 'Multimodal interaction analysis tool',
    syncDesktopName: true,
  },
  mac: {
    target: ['dmg'],
    identity: '-',
  },
  win: {
    target: ['nsis'],
  },
  protocols: [
    { name: 'mumo permalink', schemes: ['mumo'] },
  ],
}
