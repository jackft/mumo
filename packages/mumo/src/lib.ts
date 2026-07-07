import { mount as svelteMount, unmount } from 'svelte'
import App from './App.svelte'
import 'computer-modern/cmu-serif.css'

export type { EmbedConfig, mumoHandle, mumoPlugin, EmbedFeatures, CollabConfig, CollabCapability } from './embed.js'
export type { DocumentJSON } from '@mumo/core'
export type { SnapPlugin, SnapCtx } from '@mumo/timeline'
export type { SignalPlugin } from '@mumo/media-player'

import type { EmbedConfig, mumoHandle } from './embed.js'
import type { DocumentJSON } from '@mumo/core'
import { parseEAF } from '@mumo/serialization'

/** Parse an EAF XML string into a DocumentJSON suitable for loadDoc / onLoad. */
export function parseEAFToDoc(xml: string): DocumentJSON {
  const r = parseEAF(xml)
  return {
    version: 1,
    doc:             r.doc,
    annotations:     r.annotations,
    tiers:           r.tiers,
    vocabularies:    r.vocabularies,
    linguisticTypes: r.linguisticTypes,
    patternSchemas:    [],
    patterns:          [],
    participants:    r.participants,
    trackSets:       [],
    coordinateFrames: [],
  }
}

/**
 * Mount a mumo annotation tool into the given element.
 *
 * ```html
 * <script type="module">
 *   import { mount } from './mumo.esm.js'
 *   const app = mount({ target: document.getElementById('app'), doc: myDoc })
 * </script>
 * ```
 */
export function mount(config: EmbedConfig & { target: HTMLElement }): mumoHandle {
  const { target, ...embedConfig } = config

  const instance = svelteMount(App, {
    target,
    props: { embedConfig },
  }) as unknown as {
    loadDoc:      mumoHandle['loadDoc']
    loadMediaUrl: mumoHandle['loadMediaUrl']
    getDoc:       mumoHandle['getDoc']
    setUser:      mumoHandle['setUser']
    openEAF:      mumoHandle['openEAF']
  }

  return {
    loadDoc:      (doc)  => { instance.loadDoc(doc); },
    loadMediaUrl: (url)  => instance.loadMediaUrl(url),
    getDoc:       ()     => instance.getDoc(),
    setUser:      (user) => { instance.setUser(user); },
    openEAF:      (xml)  => { instance.openEAF(xml); },
    destroy:      ()     => { void unmount(instance as Parameters<typeof unmount>[0]) },
  }
}
