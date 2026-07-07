import { mount } from 'svelte'
import App from '../../../mumo/src/App.svelte'
import { ElectronPlatformIO } from './electron-platform.js'
import '../../../mumo/src/css/cmu-serif.css'

window.electronAPI.onMenuAction(action => {
  document.dispatchEvent(new CustomEvent('mumo:menu-action', { detail: action }))
})

mount(App, {
  target: document.getElementById('app')!,
  props: { platform: new ElectronPlatformIO() },
})
