import { mount } from 'svelte'
import App from './App.svelte'
import './css/cmu-serif.css'

const app = mount(App, {
  target: document.getElementById('app')!,
  props: { embedConfig: { collab: { capability: 'webrtc' } } },
})

export default app
