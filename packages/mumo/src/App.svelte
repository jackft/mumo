<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import * as Y from 'yjs'
  import { TranscriptEditor, TranscriptOverlay, OverlapOverlayPlugin, BlockHighlightOverlayPlugin, PatternOverlayPlugin, initYXmlFragment, ySyncPluginKey, setAllGlosses, setGlossesVisible, resolveTokenRanges, setUttTiersVisible } from '@mumo/editor'
  import type { TokenRef, GlossEntry, FormattingState, PatternOverlayEntry } from '@mumo/editor'
  import { Timeline } from '@mumo/timeline'
  import type { SnapPlugin, SnapMode, CommitEntry } from '@mumo/timeline'
  import { AnnotationStore, TokenStore, TrackSetStore, importCoco, importMot, createEmptyDoc, schema, newId, TimeKeeper, USER_ORIGIN, parseGapDuration, DEFAULT_LT_ID, TOKEN_LT_ID, TOKEN_LT_II_ID, isTokenLtId, controllerKey } from '@mumo/core'
  import type { DocumentJSON, ImageProvenance, PMNode, TrackSet, ControllerMeta, SymbolDef } from '@mumo/core'
  import { CollabManager } from './collab.js'
  import type { CollabMode, CollabStatus, CollabIdentity, AwarenessLike, PeerPatternSel } from './collab.js'
  import { parseXML, eafTomumo, emitEAF, emitETF, parseMMEAF, parseMMETF, emitMMEAF, emitMMETF, emitVTT, emitTXT, emitCSV, packMumo, unpackMumo } from '@mumo/serialization'
  import { MediaResolver } from './media-resolver.js'
  import type { MediaResolveResult } from './media-resolver.js'
  import appIconUrl from './assets/mumo.svg'
  import magnetIconUrl from './assets/magnet.svg'
  import type { EAFDocument, MumoImageInput, MumoSpectrogramInput, MumoTrackBufferInput } from '@mumo/serialization'
  import { FileController } from './fileController.js'
  import type { ImportResult } from './formats.js'
  import { WebPlatformIO, guessMime } from './platform.js'
  import type { PlatformIO } from './platform.js'
  import { isDesktop } from '@mumo/media-player'
  import type { FontEntry } from '@mumo/media-player'
  import type { TierDef, Annotation, TierConstraint, ControlledVocabulary, LinguisticType, PatternSchema, Pattern, SlotInstance, TokenRecord, ParticipantJSON, Bookmark } from '@mumo/core'
  import type { ID } from '@mumo/core'
  import type { Node, Mark } from 'prosemirror-model'
  import type { EditorState } from 'prosemirror-state'
  import { docToTimeline, uttLaneId } from './docToTimeline.js'
  import { TrackOverlayPlugin } from '@mumo/media-player'
  import type { VizOptions } from '@mumo/media-player'
  
  import { applyInsertionHeuristic, healPromotedBlock, updateChildAnnotations, timeAnchor, formatGapDuration } from './docOps.js'

  import type { EmbedConfig } from './embed.js'
  import { defaultBindings, mergeBindings, normalizeKeyEvent } from './keybindings.js'
  import type { ActionId, KeyBindings } from './keybindings.js'
  import CollectionView from './CollectionView.svelte'
  import Panel from './toolpanel/Panel.svelte'
  import GutterOverlay from './GutterOverlay.svelte'
  import SuggestionOverlay from './SuggestionOverlay.svelte'
  import DebugTray from './debug/DebugTray.svelte'
  import ImageCropDlg from './dialogs/ImageCropDlg.svelte'
  import CollabDlg from './dialogs/CollabDlg.svelte'
  import InviteDlg from './dialogs/InviteDlg.svelte'
  import JoinIdentityDlg from './dialogs/JoinIdentityDlg.svelte'
  import PatternSchemaDlg from './dialogs/PatternSchemaDlg.svelte'
  import TranscriptToolbar from './TranscriptToolbar.svelte'
  import AddTierDlg from './dialogs/AddTierDlg.svelte'
  import SegmentTierDlg from './dialogs/SegmentTierDlg.svelte'
  import AddParticipantDlg from './dialogs/AddParticipantDlg.svelte'
  import ParticipantsDlg from './dialogs/ParticipantsDlg.svelte'
  import TrackMappingDlg from './dialogs/TrackMappingDlg.svelte'
  import TrackVizDlg from './dialogs/TrackVizDlg.svelte'
  import AssignLingTypeDlg from './dialogs/AssignLingTypeDlg.svelte'
  import AssignVocabDlg from './dialogs/AssignVocabDlg.svelte'
  import LinkParticipantDlg from './dialogs/LinkParticipantDlg.svelte'
  import LingTypeManagerDlg from './dialogs/LingTypeManagerDlg.svelte'
  import VocabManagerDlg from './dialogs/VocabManagerDlg.svelte'
  import SymbolManagerDlg from './dialogs/SymbolManagerDlg.svelte'
  import PreferencesDlg from './dialogs/PreferencesDlg.svelte'
  import EditAnnPopover from './dialogs/EditAnnPopover.svelte'
  import EafImportDlg from './dialogs/EafImportDlg.svelte'
  import EditUttTierDlg from './dialogs/EditUttTierDlg.svelte'
  import EditTierDlg from './dialogs/EditTierDlg.svelte'
  import UttTiersDlg from './dialogs/UttTiersDlg.svelte'
  import type { SlotFillMode } from './patternTypes.js'
  import type { MediaState, SpectrogramSettings, SpectrogramTile, VadSegment, WaveformBins } from '@mumo/media-player'
  import { SPEC_PRESETS, DEFAULT_SPEC_SETTINGS, MultiMediaPlayer, VideoTileLayout, LinkedMediaDlg, computeEnergyVad } from '@mumo/media-player'
  import type { MediaPlayer } from '@mumo/media-player'
  import type { SignalChannel, TickMark, TierIntervalOverlay, ArcItem, MotionCurve } from '@mumo/timeline'
  import './css/base.css'
  import './css/dialogs.css'

  // Embed config (library API)
  const { embedConfig = undefined, platform = new WebPlatformIO() }: { embedConfig?: EmbedConfig; platform?: PlatformIO } = $props()

  const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)

  const _showMenuBar    = $derived(embedConfig?.features?.menuBar    !== false)
  const _showMediaPane  = $derived(embedConfig?.features?.mediaPlayer !== false)
  const _showTimeline   = $derived(embedConfig?.features?.timeline   !== false)
  const _showInspector  = $derived(embedConfig?.features?.inspector  !== false)
  const _showFileOpen   = $derived(embedConfig?.features?.fileOpen   !== false)
  const _appIconUrl     = $derived(embedConfig?.appIconUrl ?? appIconUrl)
  const _snapPlugins    = $derived(embedConfig?.plugins?.filter(p => p.kind === 'snap') as SnapPlugin[] | undefined)
  let _appLoaded = false

  // Initial document
  const _initEmbedDoc = untrack(() => embedConfig?.doc)
  const initialDoc = _initEmbedDoc ? schema.nodeFromJSON(_initEmbedDoc.doc) : createEmptyDoc()

  // Yjs shared document — all store collections and the PM fragment live here
  const ydoc = new Y.Doc()

  // Collaborative editing — read once at mount (intentional snapshot of initial props)
  const _collabCap       = untrack(() => embedConfig?.collab?.capability ?? 'both')
  const _collabAllowEmail = untrack(() => embedConfig?.collab?.allowEmail !== false)
  const COLLAB_SERVER = untrack(() => embedConfig?.collab?.serverUrl    ?? (import.meta as unknown as { env: Record<string, string> }).env['VITE_COLLAB_SERVER'] ?? 'ws://localhost:1234')
  const SIGNAL_SERVER = untrack(() => embedConfig?.collab?.signalingUrl ?? (import.meta as unknown as { env: Record<string, string> }).env['VITE_SIGNAL_SERVER'] ?? 'wss://signaling.yjs.dev')
  const _urlParams    = new URLSearchParams(location.search)
  const _hasRoomUrl   = _collabCap !== 'none' && !!_urlParams.get('room')

  let collabStatus   = $state<CollabStatus>('off')
  let collabMode     = $state<CollabMode | null>(null)
  let collabRoomId   = $state<string | null>(null)
  let collabDlgOpen  = $state(false)
  let inviteDlgOpen  = $state(false)
  let _awareness     = $state<AwarenessLike | null>(null)
  let _peerPatternSels = $state<PeerPatternSel[]>([])

  const store = new AnnotationStore(ydoc)
  const trackStore = new TrackSetStore(ydoc)
  store.trackPresenceProvider = (trackSetId, trackId) => trackStore.presenceRange(trackSetId, trackId)
  const tokenStore = new TokenStore()
  const trackOverlay = new TrackOverlayPlugin(trackStore)
  let _focusedTrackRef   = $state<{ trackSetId: ID; trackId: ID } | null>(null)
  let _trackVizDlgOpen  = $state(false)
  let _trackHiddenIds   = $state(new Set<ID>())
  const yXmlFragment = ydoc.getXmlFragment('prosemirror')
  if (!_hasRoomUrl) {
    initYXmlFragment(ydoc, initialDoc)
    if (_initEmbedDoc) {
      store.loadJSON(_initEmbedDoc)
    }
  }
  const undoManager = new Y.UndoManager(
    [yXmlFragment, ...store.getYTypes()],
    { trackedOrigins: new Set<unknown>([ySyncPluginKey, USER_ORIGIN]) },
  )

  // undoManager.undoing / undoManager.redoing remain true for the entire popStackItem call,
  // including all sub-transaction observer cleanups. This is more reliable than a per-transaction
  // flag that gets cleared in afterTransaction before sub-transaction cleanups run.
  const _isUndoRedo = () => undoManager.undoing || undoManager.redoing

  // svelte-ignore non_reactive_update
  let currentDoc: Node = initialDoc
  // svelte-ignore non_reactive_update
  let editorRef: ReturnType<typeof TranscriptEditor> | undefined
  let underlineActive = $state(false)
  let boldActive = $state(false)
  let italicActive = $state(false)
  let strikeActive = $state(false)
  let currentFont = $state('')
  let transcriptFont = $state(store.getTranscriptFont())
  let _defaultFonts = $state<FontEntry[]>([])
  let _systemFonts  = $state<string[]>([])

  function getMyAuthorId(): string {
    let name = localStorage.getItem('mumolia:userName') ?? ''
    if (!name) { name = 'Anonymous'; localStorage.setItem('mumolia:userName', name) }
    return name
  }
  let myAuthorId = $state(getMyAuthorId())

  function setTranscriptFont(family: string) {
    store.setTranscriptFont(family)
    transcriptFont = family
  }
  const imageRegistry = new SvelteMap<string, string>()
  // svelte-ignore non_reactive_update
  let gutterRef: { refresh(liveDoc?: Node): void } | undefined
  const overlapOverlayPlugin    = new OverlapOverlayPlugin()
  const blockHighlightPlugin    = new BlockHighlightOverlayPlugin()
  const patternOverlayPlugin    = new PatternOverlayPlugin()
  let _currentTokenRefs: TokenRef[] = []
  blockHighlightPlugin.setRangeGetter(view => resolveTokenRanges(view, _currentTokenRefs, tokenStore))
  const overlayPlugins = [overlapOverlayPlugin, blockHighlightPlugin, patternOverlayPlugin]
  let editorPaneEl    = $state<HTMLElement | null>(null)
  let editorScrollEl  = $state<HTMLElement | null>(null)
  let _isPlaying      = $state(false)
  let gutterWidth     = $state(80)
  let timelinePaneH       = $state(220)
  let timelineContentH    = $state(80)
  let currentView              = $state<'editor' | 'collection'>('editor')
  let collectionFocusReq       = $state<{ id: number | null; n: number }>({ id: null, n: 0 })
  let activeCollectionId       = $state<number | null>(null)
  let activeCollectionName     = $state<string | null>(null)
  let timelinePinned      = $state(true)
  let inspectorW          = $state(420)
  let showInspector       = $state(true)
  let showTranscript      = $state(true)
  let mediaPaneW          = $state(240)
  let tlSettingsOpen      = $state(false)
  let tlGearMenuPos       = $state<{ x: number; y: number } | null>(null)
  let _tlGearMenuEl = $state<HTMLDivElement | null>(null)
  let mediaSpeed          = $state(1)
  let mediaPreservePitch  = $state(localStorage.getItem('mumolia:preservePitch') !== 'false')
  let keyBindings = $state<KeyBindings>(defaultBindings())

  function _hasElectronPrefs(): boolean {
    return typeof window !== 'undefined' && 'electronAPI' in window &&
      typeof (window as Record<string, unknown> & { electronAPI?: Record<string, unknown> }).electronAPI?.['readPrefs'] === 'function'
  }
  const isElectron = _hasElectronPrefs()
  async function _loadAppPrefs(): Promise<void> {
    try {
      let stored: Record<string, unknown> = {}
      if (_hasElectronPrefs()) {
        stored = await (window as unknown as { electronAPI: { readPrefs(): Promise<Record<string, unknown>> } }).electronAPI.readPrefs()
      } else {
        const s = localStorage.getItem('mumolia:prefs')
        if (s) stored = JSON.parse(s)
      }
      if (stored.keyBindings && typeof stored.keyBindings === 'object') {
        keyBindings = mergeBindings(defaultBindings(), stored.keyBindings as Partial<Record<string, string>>)
      }
      if (_hasElectronPrefs()) {
        // Persist userName / preservePitch to/from prefs.json in Electron
        if (typeof stored.userName === 'string') {
          localStorage.setItem('mumolia:userName', stored.userName)
          myAuthorId = stored.userName
        } else if (myAuthorId !== 'Anonymous') {
          void _saveAppPrefs({ userName: myAuthorId })
        }
        if (typeof stored.preservePitch === 'boolean') {
          mediaPreservePitch = stored.preservePitch
        }
      }
    } catch {}
  }
  async function _saveAppPrefs(patch: { keyBindings?: Partial<KeyBindings>; userName?: string; preservePitch?: boolean }): Promise<void> {
    try {
      if (_hasElectronPrefs()) {
        const api = (window as unknown as { electronAPI: { readPrefs(): Promise<Record<string, unknown>>; writePrefs(p: unknown): Promise<void> } }).electronAPI
        const current = await api.readPrefs().catch(() => ({}))
        await api.writePrefs({ ...current, ...patch })
      } else {
        const s = localStorage.getItem('mumolia:prefs')
        const current: Record<string, unknown> = s ? JSON.parse(s) : {}
        localStorage.setItem('mumolia:prefs', JSON.stringify({ ...current, ...patch }))
      }
    } catch {}
  }

  function matchKey(e: KeyboardEvent, id: ActionId): boolean {
    const combo = normalizeKeyEvent(e)
    return !!combo && combo === keyBindings[id]
  }

  function startMediaPaneResize(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const startX = e.clientX; const startW = mediaPaneW
    function onMove(ev: PointerEvent) { mediaPaneW = Math.max(120, startW + (ev.clientX - startX)) }
    function onUp() { el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp) }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
  }

  function _onTimelineContentHeight(h: number) {
    timelineContentH = h
    if (h > 0 && (timelinePinned || timelinePaneH > h)) {
      timelinePaneH = h
    }
  }

  function startTimelineResize(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const startY = e.clientY; const startH = timelinePaneH
    function onMove(ev: PointerEvent) {
      const max = timelineContentH > 0 ? timelineContentH : 700
      timelinePaneH = Math.max(60, Math.min(max, startH - (ev.clientY - startY)))
      timelinePinned = timelinePaneH >= max
    }
    function onUp() { el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp) }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
  }

  function startInspectorResize(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const startX = e.clientX; const startW = inspectorW
    function onMove(ev: PointerEvent) { inspectorW = Math.max(160, startW - (ev.clientX - startX)) }
    function onUp() { el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp) }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
  }
  let timelineRef = $state<ReturnType<typeof Timeline> | undefined>(undefined)

  // collab is created here — after editorRef (line ~129) and timelineRef — so the callbacks
  // that close over these refs are never in the temporal dead zone when they fire.
  const collab = new CollabManager(ydoc, {
    onStatus(status, mode) { collabStatus = status; collabMode = mode; collabRoomId = collab.roomId },
    onAwareness(aw)        { _awareness = aw },
    onPeerSelections(bars, patterns) {
      _peerPatternSels = patterns
      timelineRef?.setPeerBarSelections(bars)
    },
  }, { collabServer: COLLAB_SERVER, signalServer: SIGNAL_SERVER })
  const _embedUser = untrack(() => embedConfig?.user)
  // Params to pass to initFromUrl — held until identity is known when joining via link.
  const _initParams = _collabCap !== 'none' ? (() => {
    const p = new URLSearchParams(_urlParams)
    if (_collabCap === 'webrtc') p.set('collab', 'webrtc')
    else if (_collabCap === 'server') p.delete('collab')
    return p
  })() : null

  let _joinIdentityDlgOpen = $state(false)

  if (_embedUser) {
    collab.setUser(_embedUser)
    if (_initParams) collab.initFromUrl(_initParams)
  } else if (_hasRoomUrl) {
    // Restore identity saved by joinCollaboration before the page navigation.
    let restored = false
    try {
      const saved = sessionStorage.getItem('mumo:collab-identity')
      if (saved) {
        collab.setUser(JSON.parse(saved))
        sessionStorage.removeItem('mumo:collab-identity')
        restored = true
      }
    } catch {}
    if (restored) {
      if (_initParams) collab.initFromUrl(_initParams)
    } else {
      // No identity known — prompt before connecting.
      _joinIdentityDlgOpen = true
    }
  } else {
    if (_initParams) collab.initFromUrl(_initParams)
  }

  function _onJoinIdentity(identity: CollabIdentity) {
    _joinIdentityDlgOpen = false
    collab.setUser(identity)
    if (_initParams) collab.initFromUrl(_initParams)
    // Editor mounted before identity was known, so the yCursorPlugin wasn't
    // included at creation time. Patch it in now that awareness exists.
    if (collab.awareness) editorRef?.setAwareness(collab.awareness)
  }

  let playhead = $state(0)
  let timecodeTimeEl     = $state<HTMLSpanElement | undefined>(undefined)
  let timecodeFrameNumEl = $state<HTMLSpanElement | undefined>(undefined)

  function _formatTimecodeFull(t: number): string {
    const s = Math.max(0, t)
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = Math.floor(s % 60)
    const ms = Math.floor((s % 1) * 1000)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
  }

  function _setTimecode(t: number) {
    playhead = t
    // deliberate imperative writes: updates at media frame rate, bypassing reactivity
    // eslint-disable-next-line svelte/no-dom-manipulating
    if (timecodeTimeEl) timecodeTimeEl.textContent = _formatTimecodeFull(t)
    // eslint-disable-next-line svelte/no-dom-manipulating
    if (timecodeFrameNumEl) timecodeFrameNumEl.textContent = `f${Math.floor(t * primaryFrameRate)}`
  }

  function _showCopied(anchor: HTMLElement): void {
    window.getSelection()?.removeAllRanges()
    const r = anchor.getBoundingClientRect()
    const el = document.createElement('span')
    el.textContent = 'Copied!'
    el.className = 'tl-copied-toast'
    el.style.cssText = `left:${r.left + r.width / 2}px;top:${r.top}px`
    document.body.appendChild(el)
    el.addEventListener('animationend', () => el.remove())
  }
  let loopRegion    = $state<{ start: number; end: number } | null>(null)
  $effect(() => {
    const ids = loopRegion ? _blockIdsForTimeRange(loopRegion.start, loopRegion.end) : []
    editorRef?.setLoopIds(ids)
  })
  let tlSelection   = $state<{ start: number; end: number } | null>(null)
  let editorMode: 'edit' | 'annotate' = $state('edit')
  let _modeJiggle = $state(false)
  let _modeFlash  = $state(false)
  let _annotateTypeCount = 0
  function _jiggleModeSwitch() {
    _annotateTypeCount++
    if (_annotateTypeCount >= 5) {
      if (_modeJiggle) { _modeJiggle = false; requestAnimationFrame(() => { _modeJiggle = true }) }
      else _modeJiggle = true
      if (_modeFlash) { _modeFlash = false; requestAnimationFrame(() => { _modeFlash = true }) }
      else _modeFlash = true
      _annotateTypeCount = 0
    }
  }
  let showFps       = $state(false)
  let timelineFps   = $state(0)
  let tlPxPerSec    = $state(0)
  let tlHz          = $state<number | null>(null)
  let selectedId: string | null = $state(null)
  let timelineSelectionActive = $state(false)

  // Timeline suggestion hover card
  type TlSugCard = { suggestionId: string; x: number; y: number } | null
  let _tlSugCard: TlSugCard = $state(null)
  let _tlSugHideTimer: ReturnType<typeof setTimeout> | null = null

  function _tlSugScheduleHide(): void {
    if (_tlSugHideTimer) clearTimeout(_tlSugHideTimer)
    _tlSugHideTimer = setTimeout(() => { _tlSugCard = null }, 400)
  }
  function _tlSugCancelHide(): void {
    if (_tlSugHideTimer) { clearTimeout(_tlSugHideTimer); _tlSugHideTimer = null }
  }

  function handleBarSuggestionHover(suggestionId: string | null, clientX: number, clientY: number): void {
    if (suggestionId === null) { _tlSugScheduleHide(); return }
    _tlSugCancelHide()
    if (_tlSugCard?.suggestionId !== suggestionId) {
      _tlSugCard = { suggestionId, x: clientX, y: clientY }
    }
  }
  let showStartTime = $state(true)
  let showEndTime   = $state(false)
  let showGlosses      = $state(false)
  let showUttTierNames = $state(false)
  let suggestMode      = $state(false)
  let showGuides      = $state(false)
  let showLeftGuide   = $state(false)
  let showSepGuide    = $state(false)
  let showRightGuide  = $state(false)
  let timeDecimals  = $state(1)
  let transcriptFontSizePx = $state(16)
  let showVideoInfo   = $state(false)
  let showDecodeDebug = $state(false)
  let showDebugTray    = $state(false)
  let documentLanguage = $state<string>(typeof navigator !== 'undefined' ? navigator.language : 'und')
  let slotFillMode   = $state<SlotFillMode | null>(null)
  let selectedPatternId = $state<ID | null>(null)

  // Reactive mirror of the annotation store
  let tiers        = $state<TierDef[]>([])
  let annotations    = $state<Annotation[]>([])
  let vocabs       = $state<ControlledVocabulary[]>([])
  let lingTypes    = $state<LinguisticType[]>([])
  let patternSchemas = $state<PatternSchema[]>([])
  let patterns       = $state<Pattern[]>([])
  let bookmarks        = $state<Bookmark[]>([])
  let participants      = $state<ParticipantJSON[]>([])
  let participantInUse = $state<Set<string>>(new Set())
  let symbolDefs        = $state<SymbolDef[]>([])
  let showWarnings = $state(false)

  interface FileWarning { kind: 'pattern' | 'utterance' | 'group' | 'gap'; message: string; id?: string }

  let fileWarnings = $state<FileWarning[]>([])
  let invalidGapIds = new Set<string>()

  function _recomputeWarnings(doc?: Node) {
    const d = doc ?? editorRef?.liveDoc() ?? currentDoc
    const warnings: FileWarning[] = []

    for (const pattern of store.allPatterns()) {
      const fSchema = store.allPatternSchemas().find(s => s.id === pattern.schemaId)
      if (!fSchema) continue
      const unfilled = fSchema.slots.filter(sl => sl.required && !pattern.slots.find(si => si.schemaSlotId === sl.id))
      if (unfilled.length > 0) {
        const slotNames = unfilled.map(sl => sl.label ?? sl.name).join(', ')
        warnings.push({ kind: 'pattern', message: `Pattern "${fSchema.name}" — required slot(s) unfilled: ${slotNames}`, id: pattern.id })
      }
      for (const si of pattern.slots) {
        if (!store.getAnnotation(si.annotationId)) {
          const slotSchema = fSchema.slots.find(s => s.id === si.schemaSlotId)
          warnings.push({ kind: 'pattern', message: `Pattern "${fSchema.name}" — slot "${slotSchema?.label ?? slotSchema?.name ?? '?'}" references a deleted annotation`, id: pattern.id })
        }
      }
    }

    d.forEach((block: Node) => {
      if (block.type.name !== 'utterance') return
      const label = `Utterance (${block.attrs.participant ?? '?'}): "${block.textContent?.slice(0, 30) ?? ''}…"`
      if (block.attrs.startTimeSeconds == null || block.attrs.endTimeSeconds == null) {
        warnings.push({ kind: 'utterance', message: `${label} — missing time alignment`, id: block.attrs.id })
      }
    })

    fileWarnings = warnings
  }


  function _checkGapWarnings(doc: Node) {
    const newInvalidIds = new SvelteSet<string>()
    const gapWarns: FileWarning[] = []
    doc.forEach((block: Node) => {
      if (block.type.name !== 'utterance') return
      const uttStart: number | null = block.attrs.startTimeSeconds
      const uttEnd: number | null = block.attrs.endTimeSeconds
      if (uttStart === null || uttEnd === null) return
      const uttDur = uttEnd - uttStart
      const tokens = tokenStore.getUttTokens(block.attrs.id as string)
      const isPromoted = tokens.some(t => (t.kind === 'word' || t.kind === 'gap') && store.getTokenTime(t.id) !== undefined)
      for (const tok of tokens) {
        if (tok.kind !== 'gap') continue
        // For both promoted and symbolic: warn when text duration exceeds available space
        const dur = parseGapDuration(tok.text)
        if (dur === null) continue
        const tokTime = store.getTokenTime(tok.id)
        const available = isPromoted && tokTime !== undefined && tokTime.start !== null
          ? uttEnd - tokTime.start
          : uttDur
        if (dur > available + 0.001) {
          newInvalidIds.add(tok.id)
          const preview = block.textContent.slice(0, 25)
          gapWarns.push({ kind: 'gap', message: `Gap ${tok.text} (${dur.toFixed(1)}s) longer than available space (${available.toFixed(1)}s) in "${preview}…"`, id: tok.id })
        }
      }
    })
    invalidGapIds = newInvalidIds
    fileWarnings = [...fileWarnings.filter((w: FileWarning) => w.kind !== 'gap'), ...gapWarns]
    editorRef?.refreshDecorations()
  }

  let timelineDoc = $state(initialDoc)
  let _timelineTimer: ReturnType<typeof setTimeout> | null = null
  let _isDragging = false
  let timelineData = $state(docToTimeline(initialDoc, [], [], tokenStore, [], new Map(), store))

  function _extractScreenshotTicks(doc: Node): TickMark[] {
    const ticks: TickMark[] = []
    doc.forEach(block => {
      if (block.type !== schema.nodes['visualization']) return
      const p       = (block.attrs.participant as string) || ''
      const vizType = (block.attrs.type as string) || 'visualization'
      const laneId = p ? `viz:spk:${p}:${vizType}` : `viz:${vizType}`

      // One tick per screenshot image, anchored to the video capture time (not the block time)
      block.descendants(n => {
        if (n.type !== schema.nodes['image']) return
        const prov = n.attrs.provenance as ImageProvenance | null
        if (!prov || prov.kind !== 'screenshot') return
        ticks.push({
          id: n.attrs.id as string,
          timeSeconds: prov.mediaTimeMs / 1000,
          laneId,
        })
      })
    })
    return ticks
  }

  function _pushTimelineData() {
    const trackPresence = new SvelteMap<string, { startSeconds: number; endSeconds: number }>()
    for (const tier of tiers) {
      if (!tier.trackRef) continue
      const range = trackStore.presenceRange(tier.trackRef.trackSetId, tier.trackRef.trackId)
      if (range) trackPresence.set(tier.id, range)
    }
    const data = docToTimeline(timelineDoc, tiers, annotations, tokenStore, lingTypes, trackPresence, store)
    timelineData = data
    const arcs: ArcItem[] = store.allRelations().map(r => ({ id: r.id, sourceBarId: r.source, targetBarId: r.target, ...(r.type ? { label: r.type } : {}) }))
    timelineRef?.setData({
      lanes: data.lanes.filter(l => !isLaneHidden(l.id)),
      bars:  data.bars,
      ticks: _extractScreenshotTicks(timelineDoc),
      arcs,
    })
    timelineRef?.setMotionCurves(_buildMotionCurves())
    store.emit('doc:change', timelineDoc as PMNode)
  }

  function _buildMotionCurves(): MotionCurve[] {
    const curves: MotionCurve[] = []
    for (const tier of tiers) {
      if (!tier.trackRef) continue
      const ts = trackStore.getTrackSet(tier.trackRef.trackSetId)
      if (!ts) continue
      const pts = trackStore.trajectory(tier.trackRef.trackSetId, tier.trackRef.trackId)
      if (pts.length < 2) continue
      const n = pts.length
      const dt = 1 / ts.frameRate
      const times    = new Float32Array(n)
      const dx       = new Float32Array(n)
      const dy       = new Float32Array(n)
      const velocity = new Float32Array(n)
      times[0] = pts[0]!.frame / ts.frameRate
      for (let i = 1; i < n; i++) {
        times[i]    = pts[i]!.frame / ts.frameRate
        const ddx   = pts[i]!.x - pts[i - 1]!.x
        const ddy   = pts[i]!.y - pts[i - 1]!.y
        dx[i]       = ddx / dt
        dy[i]       = ddy / dt
        velocity[i] = Math.hypot(ddx, ddy) / dt
      }
      curves.push({ laneId: `ann:${tier.id}`, times, dx, dy, velocity })
    }
    return curves
  }

  // Shared utilities

  function getOrCreateStyle(id: string): HTMLStyleElement {
    const existing = document.getElementById(id) as HTMLStyleElement | null
    if (existing) return existing
    const el = document.createElement('style')
    el.id = id
    document.head.appendChild(el)
    return el
  }

  function toggleMenu(name: string) { openMenu = openMenu === name ? null : name }
  function menuHover(name: string) { if (openMenu !== null) openMenu = name }

  function _promoteImpliedParticipants() {
    const stored = new SvelteSet(store.allParticipants().map(p => p.label))
    const inUse  = new SvelteSet<string>()
    const toAdd: Array<[string, Partial<Omit<ParticipantJSON, 'id' | 'label'>>]> = []

    const _doc = editorRef?.liveDoc() ?? currentDoc
    _doc.forEach((node: Node) => {
      const label = node.attrs.participant as string | undefined
      if (!label) return
      inUse.add(label)
      if (!stored.has(label)) {
        stored.add(label)
        toAdd.push([label, {}])
      }
    })

    for (const tier of tiers) {
      if (tier.participant) {
        inUse.add(tier.participant)
        if (!stored.has(tier.participant)) {
          stored.add(tier.participant)
          toAdd.push([tier.participant, {}])
        }
      }
    }

    participantInUse = inUse
    for (const [label, meta] of toAdd) store.addParticipant(label, meta)
  }

  let _timelinePushPending = false

  function _afterStoreChange() {
    _recomputeWarnings()
    if (!_timelinePushPending) {
      _timelinePushPending = true
      queueMicrotask(() => {
        _timelinePushPending = false
        _pushTimelineData()
        _resolveOverlayTiers()
        _promoteImpliedParticipants()
      })
    }
    updateSlotStyles()
    gutterRef?.refresh(editorRef?.liveDoc() ?? currentDoc)
    _pushGlosses()
    if (_appLoaded && embedConfig?.onChange) embedConfig.onChange(getDoc())
  }

  function syncStore() {
    tiers        = store.allTiersOrdered()
    annotations  = store.allAnnotations()
    vocabs       = store.allVocabularies()
    lingTypes    = store.allLinguisticTypes()
    patternSchemas = store.allPatternSchemas()
    patterns       = store.allPatterns()
    bookmarks        = store.allBookmarks()
    participants = store.allParticipants()
    symbolDefs   = store.getSymbolDefs()
    _afterStoreChange()
    _updatePatternOverlay()
  }

  function _pushGlosses(): void {
    const glossTierIds = new SvelteSet<string>()
    for (const tier of store.allTiers()) {
      if (tier.inlineGloss && store.resolveTierConstraint(tier.id) === 'symbolic_association') glossTierIds.add(tier.id)
    }
    if (glossTierIds.size === 0) { setAllGlosses(new Map()); return }
    const map = new SvelteMap<string, GlossEntry>()
    for (const ann of store.allAnnotations()) {
      if (!glossTierIds.has(ann.features.tierId as string)) continue
      let uttId = ann.features.blockNodeId as string | undefined
      if (!uttId) {
        // New path: parentAnnId pointing directly to an isUttTier annotation (id = PM node id)
        const pid = ann.features.parentAnnId as string | undefined
        if (pid) {
          const parent = store.getAnnotation(pid)
          const parentTier = parent ? store.getTier(parent.features.tierId as string) : undefined
          if (parentTier?.isUttTier) uttId = pid
        }
      }
      if (!uttId) continue
      const annId = ann.id
      map.set(uttId, { text: ann.type ?? '', onSave: (t) => store.updateAnnotation(annId, { type: t }) })
    }
    setAllGlosses(map)
  }

  function _resolveOverlayTiers(): void {
    const needsUpdate = mediaSignals.some(s => s.overlayTierIds && s.overlayTierIds.length > 0)
    if (!needsUpdate) return
    mediaSignals = mediaSignals.map(s => {
      if (!s.overlayTierIds || s.overlayTierIds.length === 0) return s
      const overlayTiers: TierIntervalOverlay[] = s.overlayTierIds.flatMap(tierId => {
        const tierDef = store.getTier(tierId)
        if (!tierDef) return []
        const intervals = store.allAnnotations()
          .filter(ann => ann.features.tierId === tierId)
          .flatMap(ann => {
            const ta = ann.anchors.find(a => a.type === 'time')
            if (!ta || ta.type !== 'time') return []
            return [{ start: ta.start, end: ta.end, label: ann.type }]
          })
          .sort((a, b) => a.start - b.start)
        return [{ tierId, label: tierDef.name, intervals }]
      })
      return { ...s, overlayTiers }
    })
    _flushSignals()
  }
  /** Resolve an annotation's effective time span, walking up the parent chain.
   *  Mirrors the resolution order in docToTimeline so App.svelte handlers stay in sync. */
  function resolveAnnTime(annId: string, depth = 0): { start: number; end: number } | null {
    if (depth > 10) return null  // guard against cycles
    const ann = store.getAnnotation(annId)
    if (!ann) return null
    // Stored time anchor — authoritative for time_subdivision / included_in
    const ta = ann.anchors.find(a => a.type === 'time')
    if (ta && ta.type === 'time') return { start: ta.start, end: ta.end }
    // Walk parentAnnId chain (symbolic_association / symbolic_subdivision)
    const parentAnnId = ann.features.parentAnnId as string | undefined
    if (parentAnnId) return resolveAnnTime(parentAnnId, depth + 1)
    // Utterance node
    const blockNodeId = ann.features.blockNodeId as string | undefined
    if (blockNodeId) {
      let found: { start: number; end: number } | null = null
      currentDoc.forEach((node: Node) => {
        if (node.attrs.id === blockNodeId && node.attrs.startTimeSeconds != null)
          found = { start: node.attrs.startTimeSeconds as number, end: node.attrs.endTimeSeconds as number }
      })
      if (found) return found
    }
    // Word/token node
    const tokenNodeId = ann.features.tokenNodeId as string | undefined
    if (tokenNodeId) {
      const tt = store.getTokenTime(tokenNodeId)
      if (tt && tt.start != null && tt.end != null) return { start: tt.start, end: tt.end }
    }
    return null
  }

  store.on('tier:add', (tier) => {
    _symbolicCoverage = null
    const tierConstraint = store.resolveTierConstraint(tier.id)
    if (tier.parentTierId && (tierConstraint === 'time_subdivision' || tierConstraint === 'symbolic_subdivision' || tierConstraint === 'symbolic_association')) {
      // Get ALL annotations in the parent tier regardless of their own parentAnnId level.
      // getOrderedAnnotations(tierId, undefined) only returns root-level anns and misses
      // annotations that are themselves children (parentAnnId set).
      const parentAnns = store.allAnnotations().filter(a => a.features.tierId === tier.parentTierId)
      if (parentAnns.length > 0) {
        store.transact(() => {
          for (const parentAnn of parentAnns) {
            if (store.getOrderedAnnotations(tier.id, parentAnn.id).length > 0) continue
            if (tierConstraint === 'symbolic_subdivision' || tierConstraint === 'symbolic_association') {
              store.addAnnotation('', [], { tierId: tier.id, parentAnnId: parentAnn.id })
            } else {
              const pt = resolveAnnTime(parentAnn.id)
              if (!pt) continue
              store.addAnnotation('', [timeAnchor(pt.start, pt.end)], { tierId: tier.id, parentAnnId: parentAnn.id })
            }
          }
        })
      }
    }
    // syncStore runs via tiers:changed below
  })
  store.on('tier:update',         () => { _symbolicCoverage = null; _pushGlosses() })
  store.on('tier:remove',         () => { _symbolicCoverage = null })
  store.on('tiers:changed',       () => { tiers = store.allTiersOrdered(); _afterStoreChange() })
  store.on('annotations:changed', () => { annotations = store.allAnnotations(); _afterStoreChange() })
  store.on('suggestions:changed', _afterStoreChange)

  // Incremental coverage cache: tierId → Set of tokenIds that already have an annotation.
  // null = dirty, will be rebuilt on next access.
  let _symbolicCoverage: Map<string, Set<string>> | null = null

  function _getSymbolicCoverage(): Map<string, Set<string>> {
    if (_symbolicCoverage !== null) return _symbolicCoverage
    _symbolicCoverage = new SvelteMap()
    for (const ann of store.allAnnotations()) {
      const tierId  = ann.features.tierId as string | undefined
      const tokenId = (ann.features.tokenNodeId ?? ann.features.blockNodeId) as string | undefined
      if (!tierId || !tokenId) continue
      if (!_symbolicCoverage.has(tierId)) _symbolicCoverage.set(tierId, new Set())
      _symbolicCoverage.get(tierId)!.add(tokenId)
    }
    return _symbolicCoverage
  }

  store.on('annotation:add', (ann) => {
    if (_symbolicCoverage !== null) {
      const tierId  = ann.features.tierId as string | undefined
      const tokenId = (ann.features.tokenNodeId ?? ann.features.blockNodeId) as string | undefined
      if (tierId && tokenId) {
        if (!_symbolicCoverage.has(tierId)) _symbolicCoverage.set(tierId, new Set())
        _symbolicCoverage.get(tierId)!.add(tokenId)
      }
    }
    _pushGlosses()
    _autoPopulateChildTiers(ann)
  })

  // Any remove invalidates the cache (removes are rare — undo, tier delete).
  store.on('annotation:remove', () => { _symbolicCoverage = null })
  store.on('vocabulary:add',         () => { vocabs = store.allVocabularies(); _afterStoreChange() })
  store.on('vocabulary:update',      () => { vocabs = store.allVocabularies(); _afterStoreChange() })
  store.on('vocabulary:remove',      () => { vocabs = store.allVocabularies(); _afterStoreChange() })
  store.on('linguistic-type:add',    () => { lingTypes = store.allLinguisticTypes(); _afterStoreChange() })
  store.on('linguistic-type:update', () => { lingTypes = store.allLinguisticTypes(); _afterStoreChange() })
  store.on('linguistic-type:remove', () => { lingTypes = store.allLinguisticTypes(); _afterStoreChange() })
  store.on('pattern-schema:add',       () => { patternSchemas = store.allPatternSchemas(); _afterStoreChange(); _updatePatternOverlay() })
  store.on('pattern-schema:update',    () => { patternSchemas = store.allPatternSchemas(); _afterStoreChange(); _updatePatternOverlay() })
  store.on('pattern-schema:remove',    () => { patternSchemas = store.allPatternSchemas(); _afterStoreChange(); _updatePatternOverlay() })
  store.on('pattern:add',              () => { patterns = store.allPatterns(); _afterStoreChange(); _updatePatternOverlay() })
  store.on('pattern:update',           () => { patterns = store.allPatterns(); _afterStoreChange(); _updatePatternOverlay() })
  store.on('pattern:update',           () => { if (selectedPatternId) updateSlotRefStyles(selectedPatternId) })
  store.on('pattern:remove',           () => { patterns = store.allPatterns(); _afterStoreChange(); _updatePatternOverlay() })
  store.on('participant:changed',    () => { participants = store.allParticipants(); _afterStoreChange() })
  store.on('bookmarks:changed',          () => { bookmarks = store.allBookmarks() })
  store.on('reset',                  syncStore)

  function _updatePatternOverlay() {
    const entries: PatternOverlayEntry[] = []
    for (const p of patterns) {
      const schema = patternSchemas.find(s => s.id === p.schemaId)
      if (!schema) continue
      const color = `#${(schema.color ?? 0).toString(16).padStart(6, '0')}`
      const uttIds: string[] = []
      for (const slot of p.slots) {
        const ann = store.getAnnotation(slot.annotationId)
        const uttId = (ann?.features['utteranceId'] ?? ann?.features['blockNodeId']) as string | undefined
        if (uttId) uttIds.push(uttId)
      }
      if (uttIds.length) entries.push({ patternId: p.id, color, label: schema.name, uttIds })
    }
    patternOverlayPlugin.setEntries(entries)
  }

  // After Yjs undo/redo, suggestion marks or utterances may be gone — clean up the store to match.
  function _syncSuggestionsFromDoc(): void {
    const docSugIds = new SvelteSet<string>()
    const docUttIds = new SvelteSet<string>()
    const doc = editorRef?.liveDoc()
    if (doc) {
      doc.descendants(node => {
        if (node.isText) {
          for (const m of node.marks) {
            if (m.type.name === 'suggestion_insert' || m.type.name === 'suggestion_delete')
              docSugIds.add(m.attrs.suggestionId as string)
          }
        }
        if (node.type?.name === 'utterance') docUttIds.add(node.attrs.id as string)
        return true
      })
    }
    for (const sug of store.allSuggestions()) {
      if (sug.change.type === 'pm:replace' && !docSugIds.has(sug.id))
        store.rejectSuggestion(sug.id)
      if ((sug.change.type === 'utt:set-time' || sug.change.type === 'utt:set-participant') && !docUttIds.has(sug.change.uttId))
        store.rejectSuggestion(sug.id)
    }
  }

  // When an external pm:replace suggestion arrives, apply its marks to the PM doc.
  // Skip during undo/redo: the yXmlFragment undo/redo already restores the marks via
  // the ySyncPlugin, so calling applyReplaceSuggestion here would double-apply them.
  store.on('suggestion:add', (sug) => {
    if (_isUndoRedo()) return
    if (sug.change.type === 'pm:replace') {
      const c = sug.change as { type: 'pm:replace'; uttId: string; fromOffset: number; toOffset: number; replacement: string }
      editorRef?.applyReplaceSuggestion(sug.id, sug.authorId, c.uttId, c.fromOffset, c.toOffset, c.replacement)
    }
  })

  function _handleSuggestEdit(id: string, uttId: string, fromOffset: number, toOffset: number, replacement: string): void {
    const change = { type: 'pm:replace' as const, uttId, fromOffset, toOffset, replacement }
    if (!store.updateSuggestionChange(id, change))
      store.addSuggestion(change, 'user:local', undefined, id)
  }

  function _handleSuggestRemove(id: string): void {
    store.rejectSuggestion(id)
  }

  store.on('suggestion:pre-reject', (s) => {
    if (s.change.type === 'pm:replace') editorRef?.rejectReplaceSuggestion(s.id)
  })

  store.on('suggestion:pre-accept', (s) => {
    if (s.change.type === 'textlet:delete') {
      const ann = store.getAnnotation(s.change.textletId)
      const markAnchor = ann?.anchors.find(a => a.type === 'mark')
      if (markAnchor?.type === 'mark') editorRef?.removeAnnotationMark(markAnchor.markId)
    }
    if (s.change.type === 'textlet:add') {
      const ann = s.change.annotation
      const idx = ann.anchors.findIndex(a => a.type === 'word-range')
      if (idx >= 0) {
        const anchor = ann.anchors[idx]!
        if (anchor.type === 'word-range') {
          const markId = editorRef?.addAnnotationMarkForWordIds(anchor.fromWordId, anchor.toWordId)
          if (markId) {
            const updatedAnchors = [...ann.anchors]
            updatedAnchors[idx] = { type: 'mark', markId }
            store.updateSuggestionChange(s.id, {
              type: 'textlet:add',
              annotation: { ...ann, anchors: updatedAnchors },
            })
          }
        }
      }
    }
    if (s.change.type === 'pm:replace') {
      editorRef?.acceptReplaceSuggestion(s.id)
    }
    if (s.change.type === 'utt:set-participant') {
      editorRef?.applyParticipantChange(s.change.uttId, s.change.participant)
    }
    if (s.change.type === 'utt:set-time') {
      const { uttId, startTime, endTime } = s.change
      ydoc.transact(() => {
        for (const child of yXmlFragment.toArray()) {
          if (child instanceof Y.XmlElement && child.getAttribute('id') === uttId) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            child.setAttribute('startTimeSeconds', startTime as any)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            child.setAttribute('endTimeSeconds', endTime as any)
          }
        }
      }, USER_ORIGIN)
      editorRef?.reorderByTime(true)
      const doc = editorRef?.liveDoc()
      if (doc) {
        _syncTimeKeeperFromDoc(doc)
        _recomputeWarnings(doc)
        timelineDoc = doc
      }
    }
  })

  // Promote any new participant labels that appear in the PM doc via editing
  yXmlFragment.observe(() => queueMicrotask(_promoteImpliedParticipants))

  // Track data loaded from sidecar → re-render presence bars without full store sync.
  trackStore.on('track-set:add',         syncStore)
  trackStore.on('track-set:update',      syncStore)
  trackStore.on('track-set:remove',      () => { syncStore(); _syncTrackOverlay() })
  trackStore.on('track-set:data-loaded', () => { queueMicrotask(() => _pushTimelineData()) })
  trackStore.on('reset',                 () => { syncStore(); _syncTrackOverlay() })

  // Sync initial state (seed runs before subscriptions)
  syncStore()
  // Migrate any tiers that were saved with legacy pseudo-tier parents (__tok__Speaker).
  // Safe to run on every load — exits immediately if nothing needs migrating.
  for (const tier of store.allTiers()) {
    if (!tier.parentTierId?.startsWith('__tok__')) continue
    const participant = tier.parentTierId.slice('__tok__'.length)
    store.updateTier(tier.id, { parentTierId: ensureWordTier(participant).id })
  }

  // After Timeline mounts, push initial data imperatively.
  // Must re-run docToTimeline here (not use cached timelineData) because
  // timelineData is computed before syncStore() populates the token store.
  // Track overlay: focus/unfocus a track tier by clicking its lane

  function handleLaneClick(laneId: string): void {
    if (!laneId.startsWith('ann:')) { _setFocusedTrack(null); return }
    const tierId = laneId.slice(4)
    const tier = tiers.find(t => t.id === tierId)
    _setFocusedTrack(tier?.trackRef ?? null)
  }

  function _setFocusedTrack(ref: { trackSetId: ID; trackId: ID } | null): void {
    _focusedTrackRef = ref
    trackOverlay.setFocusedTrack(ref?.trackSetId ?? null, ref?.trackId ?? null)
  }

  function _syncTrackOverlay(): void {
    const defaults = _trackImportDefaults()
    trackOverlay.setVideoRef(defaults.videoRef)
    const participantMap = new SvelteMap<string, string>()
    for (const t of tiers) {
      if (t.trackRef && t.participant) participantMap.set(t.trackRef.trackId, t.participant)
    }
    trackOverlay.setParticipantMap(participantMap)
    _hasVizTracks = trackOverlay.getTrackEntries().length > 0
  }

  function _setTrackVisible(trackId: ID, visible: boolean): void {
    trackOverlay.setTrackVisible(trackId, visible)
    _trackHiddenIds = new Set(trackOverlay.hiddenTrackIds)
  }

  let _trackVizOptions = $state({ ...trackOverlay.vizOptions })
  let _trackVizEnabled = $state(true)
  let _hasVizTracks    = $state(false)

  function _setVizOptions(opts: Partial<VizOptions>): void {
    trackOverlay.setVizOptions(opts)
    _trackVizOptions = { ...trackOverlay.vizOptions }
  }

  function _toggleTrackViz(): void {
    _trackVizEnabled = !_trackVizEnabled
    trackOverlay.setEnabled(_trackVizEnabled)
  }

  onMount(async () => {
    await _loadAppPrefs()
    if ('listSystemFonts' in platform && typeof (platform as { listSystemFonts?: unknown }).listSystemFonts === 'function') {
      const fonts = await (platform as { listSystemFonts(): Promise<{ defaults: FontEntry[]; system: string[] }> }).listSystemFonts()
      _defaultFonts = fonts.defaults
      _systemFonts  = fonts.system
    }

    // Must run here (after children mount) not at module-init time. The module-init call at
    // line ~2296 pre-populates activeIds before TranscriptEditor registers its onActiveChange
    // listener, so subsequent seeks see changed=false and never highlight. Calling it again
    // here — after the listener is registered — clears activeIds and fires a fresh diff.
    // See time-keeper.test.ts "clearRegistrations resets active set" for the invariant.
    _syncTimeKeeperFromDoc(currentDoc)
    _pushTimelineData()
    timelineRef?.initialRenderBars()
    timelineRef?.setSnapEnabled(snapMode !== 'off')
    if (snapMode !== 'off') timelineRef?.setSnapMode(snapMode)
    timelineRef?.setSnapChannel(snapChannelId)
    timelineRef?.setAnnotationSnapMode(annotationSnapMode)
    _recomputeWarnings(initialDoc)
    const _peerBars = collab.peerBarSelections()
    if (_peerBars.length) timelineRef?.setPeerBarSelections(_peerBars)

    // Register track overlay — addPrimaryPlugin queues it until the primary player and its canvas exist.
    multiPlayer.addPrimaryPlugin(trackOverlay)
    trackOverlay.onSeekToFrame = (frame) => {
      const tsId = _focusedTrackRef?.trackSetId
      const ts   = tsId ? trackStore.getTrackSet(tsId) : null
      if (ts) multiPlayer.seek(frame / ts.frameRate)
    }
    trackOverlay.onScrubToFrame = (frame) => {
      const tsId = _focusedTrackRef?.trackSetId
      const ts   = tsId ? trackStore.getTrackSet(tsId) : null
      if (ts) multiPlayer.scrub(frame / ts.frameRate)
    }
    trackOverlay.onEndScrub = () => multiPlayer.endScrub()
    trackOverlay.onSelectRange = (lo, hi) => {
      const tsId = _focusedTrackRef?.trackSetId
      const ts   = tsId ? trackStore.getTrackSet(tsId) : null
      if (ts) timelineRef?.setSelection(lo / ts.frameRate, hi / ts.frameRate)
    }
    
    if (embedConfig?.mediaUrl) {
      await loadMediaUrl(embedConfig.mediaUrl)
    } else if (embedConfig?.onLoad) {
      const result = await embedConfig.onLoad()
      loadDoc(result.doc)
      if (result.mediaUrl) await loadMediaUrl(result.mediaUrl)
    }

    _appLoaded = true
    embedConfig?.onReady?.(store, tokenStore, (from, to) => editorRef?.addAnnotationMarkForWordIds(from, to) ?? null)
    _syncSuggestionsFromDoc()
  })

  onMount(() => {
    function handleMenuAction(e: Event) {
      const action = (e as CustomEvent<string>).detail
      switch (action) {
        case 'file:new':               newDoc(); break
        case 'file:open':              void openAny(); break
        case 'file:save':              void (filecontroller.currentFilename ? saveMumo() : saveMumoAs()); break
        case 'file:openTemplate':      void openTemplate(); break
        case 'file:saveTemplate':      saveTemplate(); break
        case 'file:setLanguage':       setLanguage(); break
        case 'tracks:importCOCO':      void importTracksCoco(); break
        case 'tracks:importMOT':       void importTracksMot(); break
        case 'media:loadMedia':        linkedMediaOpen = true; break
        case 'media:linkMedia':        linkedMediaOpen = true; break
        case 'edit:insertVisualization': insertVisualizationBlock(); break
        case 'selection:createTextlet': createTextletFromSelection(); break
        case 'view:toggleInspector':   showInspector = !showInspector; break
        case 'view:collection':        if (isElectron) currentView = currentView === 'collection' ? 'editor' : 'collection'; break
        case 'tier:newTier':           addTier(); break
        case 'type:lingTypes':         lingTypeDlgOpen = true; break
        case 'type:vocabs':            vocabDlgOpen = true; break
        case 'type:patternSchemas':      patternSchemaDlgOpen = true; break
        case 'collaborate:start':      openCollabDlg(); break
        case 'help:shortcuts':         openMenu = 'help'; break
        case 'debug:showFps':          if (import.meta.env.DEV) { showFps = !showFps } break
        case 'debug:decodeTiming':     if (import.meta.env.DEV) { showDecodeDebug = !showDecodeDebug } break
        case 'debug:debugTray':        if (import.meta.env.DEV) { showDebugTray = !showDebugTray } break
        default: {
          if (action.startsWith('seek-to-bookmark:')) {
            const bmId = action.slice('seek-to-bookmark:'.length)
            const bm = store.getBookmark(bmId)
            if (bm) { currentView = 'editor'; void multiPlayer.seek(bm.startSeconds) }
          } else if (action.startsWith('seek-to-time:')) {
            const t = Number(action.slice('seek-to-time:'.length))
            if (Number.isFinite(t)) { currentView = 'editor'; void multiPlayer.seek(t) }
          } else if (action.startsWith('open-file-at-bookmark:')) {
            const [, filePath, bmId] = action.split(':')
            if (filePath) void _openMumoPath(filePath, bmId)
          } else if (action.startsWith('open-collection:')) {
            const id = Number(action.slice('open-collection:'.length))
            currentView = 'collection'
            if (Number.isFinite(id)) collectionFocusReq = { id, n: collectionFocusReq.n + 1 }
          } else if (action.startsWith('open-file-at-time:')) {
            // split on the LAST colon — the file path may itself contain colons
            const rest = action.slice('open-file-at-time:'.length)
            const sep = rest.lastIndexOf(':')
            const filePath = sep > 0 ? rest.slice(0, sep) : rest
            const t = sep > 0 ? Number(rest.slice(sep + 1)) : 0
            if (filePath) void _openMumoPath(filePath, undefined, Number.isFinite(t) ? t : 0)
          }
        }
      }
    }
    document.addEventListener('mumo:menu-action', handleMenuAction)
    return () => document.removeEventListener('mumo:menu-action', handleMenuAction)
  })

  // Library imperative API

  /** Replace the current document (library API). */
  export function openEAF(xml: string): void {
    const eaf = parseXML(xml)
    eafImportDlg = { open: true, eaf, eafFilePath: null }
  }

  export function loadDoc(data: DocumentJSON): void {
    const newDoc = schema.nodeFromJSON(data.doc)
    store.loadJSON(data)
    _applyNewDoc(newDoc)
  }

  /**
   * Configure which annotation tiers to overlay on the given spectrogram channel.
   * signalId: e.g. "${playerId}:spectrogram:ch0"
   * tierIds: array of tier IDs from the annotation store (empty to clear)
   */
  export function setSignalOverlayTiers(signalId: string, tierIds: string[]): void {
    mediaSignals = mediaSignals.map(s =>
      s.id === signalId ? { ...s, overlayTierIds: tierIds } : s
    )
    _resolveOverlayTiers()
  }

  /** Load media from a URL for playback (library API — no audio analysis). */
  export function loadMediaUrl(url: string): Promise<void> {
    return multiPlayer.loadPrimaryUrl(url)
  }

  /** Update the local user identity shown in collab awareness (library API). */
  export function setUser(user: { name?: string; email?: string }): void {
    collab.setUser(user)
  }

  /** Return the current document as a plain object (library API). */
  export function getDoc(): DocumentJSON {
    return {
      version: 1,
      doc: (editorRef?.liveDoc() ?? currentDoc).toJSON(),
      ...store.toJSON(),
    } as DocumentJSON
  }

  /** Resolve a tier's effective constraint, preferring its linguistic type if set. */
  function resolveTierConstraint(tier: TierDef): TierConstraint | undefined {
    return store.resolveTierConstraint(tier.id)
  }

  /** Find an existing LT with the given constraint, or create one. */
  function ensureLinguisticType(constraint: TierConstraint): string {
    const existing = lingTypes.find(lt => lt.constraint === constraint && !lt.vocabularyId)
    if (existing) return existing.id
    return store.addLinguisticType(constraint, { constraint }).id
  }

  function ensureWordTier(participant: string): TierDef {
    return store.allTiers().find(t => isTokenLtId(t.linguisticTypeId) && t.participant === participant)
      ?? store.addTier(`tokens:${participant}`, { linguisticTypeId: TOKEN_LT_ID, participant })
  }

  /** Resolve a tier's effective vocabularyId via its linguistic type. */
  function resolveTierVocabulary(tier: TierDef): string | undefined {
    return store.getLinguisticType(tier.linguisticTypeId)?.vocabularyId
  }

  // Media

  let mediaState           = $state<MediaState | null>(null)
  let primaryFrameRate     = $state(30)
  let mediaSignals         = $state<SignalChannel[]>([])
  let hiddenSignalIds      = $state<Set<string>>(new Set())
  let spectrogramSettings = $state<SpectrogramSettings>({ ...DEFAULT_SPEC_SETTINGS })
  let spectrogramProgress = $state<{ done: number; total: number } | null>(null)
  let specModalOpen = $state(false)
  let hiddenLaneIds    = $state<Set<string>>(new Set())
  let linkedMediaOpen  = $state(false)
  let linkedPlayers    = $state<readonly MediaPlayer[]>([])

  type EafPassthrough = {
    media: import('@mumo/serialization').EAFMediaDescriptor[]
    properties: Array<{ name: string; value: string }>
  }
  let eafPassthrough     = $state<EafPassthrough | null>(null)
  // Maps desc.mediaUrl → player.id for files loaded via the Load button (works without path matching)
  let eafSlotAssignments = $state(new Map<string, string>())

  const mediaEntries = $derived((() => {
    type E = import('@mumo/media-player').MediaEntry
    const loaded: E[] = linkedPlayers.map(p => ({
      kind: 'loaded' as const,
      id: p.id,
      name: p.state?.filename ?? '(loading…)',
      offsetSec: p.track?.offsetSec ?? 0,
    }))

    if (!eafPassthrough) return loaded

    const loadedPaths  = new Set(linkedPlayers.map(p => p.track?.path).filter(Boolean) as string[])
    const loadedHashes = new Set(linkedPlayers.map(p => p.track?.mediaHash).filter(Boolean) as string[])
    const storedHashByIndex = new Map<number, string>()
    for (const prop of eafPassthrough.properties) {
      const m = prop.name.match(/^mumo:mediaHash:(\d+)$/)
      if (m) storedHashByIndex.set(parseInt(m[1]!), prop.value)
    }
    const loadedPlayerIds = new Set(linkedPlayers.map(p => p.id))
    const unloaded: E[] = eafPassthrough.media
      .filter((desc, i) => {
        const assignedId = eafSlotAssignments.get(desc.mediaUrl)
        if (assignedId && loadedPlayerIds.has(assignedId)) return false
        if (loadedPaths.has(desc.mediaUrl)) return false
        const h = storedHashByIndex.get(i)
        if (h && loadedHashes.has(h)) return false
        return true
      })
      .map(desc => ({
        kind: 'unloaded' as const,
        id: desc.mediaUrl,
        name: desc.mediaUrl.split(/[/\\]/).pop() ?? desc.mediaUrl,
        offsetSec: (desc.timeOrigin ?? 0) / 1000,
      }))

    return [...loaded, ...unloaded]
  })())
  let _knownPlayerIds  = new Set<string>()

  function sortSignals(a: SignalChannel, b: SignalChannel): number {
    const pidA = a.id.split(':')[0]!
    const pidB = b.id.split(':')[0]!
    // Primary player first
    const primaryId = multiPlayer.primary?.id ?? ''
    const aP = pidA === primaryId ? 0 : 1
    const bP = pidB === primaryId ? 0 : 1
    if (aP !== bP) return aP - bP
    if (pidA !== pidB) return pidA < pidB ? -1 : 1
    if (a.kind !== b.kind) return a.kind === 'waveform' ? -1 : 1
    const chA = parseInt(a.id.match(/ch(\d+)/)?.[1] ?? '0')
    const chB = parseInt(b.id.match(/ch(\d+)/)?.[1] ?? '0')
    return chA - chB
  }

  function _flushSignals() {
    timelineRef?.setSignals(mediaSignals.filter(s => !hiddenSignalIds.has(s.id)))
  }

  const customSignalHandlers = new Map<string, (data: unknown) => void>()

  const multiPlayer = new MultiMediaPlayer(
    {
      onPrimaryStateChange(state) {
        // Clear only the primary player's signals; secondary signals survive primary reload
        const pid = multiPlayer.primary?.id
        if (pid) mediaSignals = mediaSignals.filter(s => !s.id.startsWith(pid + ':'))
        mediaState = state
        if (state) {
          timelineRef?.setMediaDuration(state.duration)
          const info = multiPlayer.primary?.getVideoInfo()
          if (info) primaryFrameRate = info.framerate
        }
        multiPlayer.setLoop(loopRegion)
        // Sync overlay so tracks for the newly loaded video become visible
        _syncTrackOverlay()
      },
      onPlayersChange(players) {
        linkedPlayers = players
        // Only remove signals for players that were present before and are now gone.
        // Don't prune signals for players whose analysis completed before they were
        // added to the list (possible during concurrent session restore loads).
        const currIds = new Set(players.map(p => p.id))
        const removedIds = new Set([..._knownPlayerIds].filter(id => !currIds.has(id)))
        _knownPlayerIds = currIds
        if (removedIds.size > 0) {
          mediaSignals = mediaSignals.filter(s => !removedIds.has(s.id.split(':')[0]!))
          _flushSignals()
        }
      },
      onPrimaryPlayheadChange(t) { _setTimecode(t); timeKeeper.seek(t) },
      onPrimaryPlayingChange(playing) { _isPlaying = playing },
      onWaveform(playerId, ch, bins) {
        const player = multiPlayer.players.find(p => p.id === playerId)
        const isPrimary = playerId === multiPlayer.primary?.id
        const n = player?.state?.channelCount ?? 1
        const chLabel = spectrogramSettings.monoMix || n === 1 ? 'wav mono' : ch === 0 ? 'wav L' : ch === 1 ? 'wav R' : `wav ch${ch}`
        const label = isPrimary ? chLabel : `${player?.state?.filename ?? ''} ${chLabel}`
        const id = `${playerId}:waveform:ch${ch}`
        const timeOffset = player?.track?.offsetSec ?? 0
        mediaSignals = [
          ...mediaSignals.filter(s => s.id !== id),
          { id, label, kind: 'waveform' as const, waveformBins: bins, height: 20, timeOffset },
        ].sort(sortSignals)
        _flushSignals()
      },
      onSpectrogramOverview(playerId, ch, tile) {
        const player = multiPlayer.players.find(p => p.id === playerId)
        const isPrimary = playerId === multiPlayer.primary?.id
        const n = player?.state?.channelCount ?? 1
        const chLabel = spectrogramSettings.monoMix || n === 1 ? 'mono' : ch === 0 ? 'L' : ch === 1 ? 'R' : `ch${ch}`
        const label = isPrimary ? `spec ${chLabel}` : `${player?.state?.filename ?? ''} spec ${chLabel}`
        const id = `${playerId}:spectrogram:ch${ch}`
        const timeOffset = player?.track?.offsetSec ?? 0
        if (!mediaSignals.find(s => s.id === id)) {
          mediaSignals = [
            ...mediaSignals,
            { id, label, kind: 'spectrogram' as const, imageTimeStart: tile.timeStart, imageTimeEnd: tile.timeEnd, height: 40, maxFreqHz: spectrogramSettings.maxFreqHz, spectrogramDynamicRangeDb: spectrogramSettings.dynamicRangeDb, spectrogramGamma: spectrogramSettings.gamma, timeOffset },
          ].sort(sortSignals)
        } else {
          mediaSignals = mediaSignals.map(s => s.id === id ? { ...s, label, maxFreqHz: spectrogramSettings.maxFreqHz, spectrogramDynamicRangeDb: spectrogramSettings.dynamicRangeDb, spectrogramGamma: spectrogramSettings.gamma } : s)
        }
        _flushSignals()
        timelineRef?.setSpectrogramOverview(id, tile)
      },
      onSpectrogramTile(playerId, ch, tile) {
        timelineRef?.addSpectrogramTile(`${playerId}:spectrogram:ch${ch}`, tile)
      },
      onOnsets(playerId, ch, timestamps, strengths, bandTimestamps, bandStrengths) {
        const waveId = `${playerId}:waveform:ch${ch}`
        const specId = `${playerId}:spectrogram:ch${ch}`
        mediaSignals = mediaSignals.map(s =>
          (s.id === waveId || s.id === specId)
            ? { ...s, onsets: timestamps, onsetStrengths: strengths, bandOnsets: bandTimestamps, bandOnsetStrengths: bandStrengths }
            : s
        )
        _flushSignals()
      },
      onVad(segments) { timelineRef?.setVadSegments(segments); mergedVadSegments = segments },
      onProgress(done, total) {
        spectrogramProgress = (done >= total && total > 0) ? null : { done, total }
      },
      onError(message) { console.error('Media worker error:', message) },
      onCustom(pluginId, data) {
        const handler = customSignalHandlers.get(pluginId)
        if (handler) handler(data)
        else console.debug('[custom signal]', pluginId, data)
      },
    },
    untrack(() => platform),
    untrack(() => embedConfig?.workerUrl),
  )
  // initial value only, by design: later changes call setPreservePitch via prefs handlers
  if (!untrack(() => mediaPreservePitch)) multiPlayer.setPreservePitch(false)

  function applySpectrogramSettings(newSettings: SpectrogramSettings): void {
    const monoChanged = newSettings.monoMix !== spectrogramSettings.monoMix
    spectrogramSettings = newSettings
    mediaSignals = mediaSignals
      .filter(s => !monoChanged || !newSettings.monoMix || !s.id.match(/:(waveform|spectrogram):ch[1-9]/))
      .map(s => s.kind === 'spectrogram' ? { ...s, spectrogramDynamicRangeDb: newSettings.dynamicRangeDb, spectrogramGamma: newSettings.gamma } : s)
    if (!mediaState) return
    for (const sig of mediaSignals) {
      if (sig.kind === 'spectrogram') timelineRef?.clearSpectrogramDetailTiles(sig.id)
    }
    spectrogramProgress = { done: 0, total: 0 }
    multiPlayer.setSpectrogramSettings(newSettings)
  }

  async function loadMediaFile(file: File, path: string | null = null) {
    await multiPlayer.loadPrimary(file, path)
  }

  async function _loadResolvedMedia(result: MediaResolveResult, timeOriginSec: number) {
    if (result.kind === 'url') {
      if (timeOriginSec !== 0) {
        await multiPlayer.addTrackUrl(result.url, timeOriginSec)
      } else {
        await multiPlayer.loadPrimaryUrl(result.url)
      }
    } else {
      if (timeOriginSec !== 0) {
        await multiPlayer.addTrack(result.file, result.path, timeOriginSec)
      } else {
        await loadMediaFile(result.file, result.path)
      }
    }
  }

  async function _openMediaPicker() {
    const result = await platform.openBinaryFile(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'], 'Media files')
    if (result) await loadMediaFile(result.file, result.path)
  }

  async function linkMediaFile(offsetSec = 0) {
    const result = await platform.openBinaryFile(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'], 'Media files')
    if (result) await multiPlayer.addTrack(result.file, result.path, offsetSec)
  }

  const SPEED_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 5]

  function togglePlay() { multiPlayer.togglePlay() }
  function skip(sec: number) { multiPlayer.skip(sec) }

  function _timedUtts() {
    return timelineData.bars
      .filter(b => b.type === 'utterance' && b.start != null && b.end != null && !b.placeholder)
      .sort((a, b) => a.start - b.start)
  }

  function _uttIdxAtPlayhead(utts: typeof timelineData.bars) {
    let idx = utts.findIndex(b => playhead >= b.start && playhead < b.end)
    if (idx < 0) idx = utts.findLastIndex(b => b.start <= playhead)
    return idx
  }

  function _armAndPlay(bar: (typeof timelineData.bars)[number]) {
    loopRegion = { start: bar.start, end: bar.end }
    timelineRef?.setLoopRegion(loopRegion)
    multiPlayer.setLoop(loopRegion)
    multiPlayer.seek(bar.start)
    multiPlayer.play()
    editorRef?.focusBlock(bar.nodeId)
  }

  function toggleLoopPlay(): boolean {
    if (loopRegion) {
      multiPlayer.pause()
      loopRegion = null
      timelineRef?.setLoopRegion(null)
      multiPlayer.setLoop(null)
      return true
    }
    // prefer cursor-based utt (works in edit mode), fall back to playhead
    const cursorUtt = editorRef?.getUttAtCursor()
    if (cursorUtt) {
      loopRegion = { start: cursorUtt.start, end: cursorUtt.end }
      timelineRef?.setLoopRegion(loopRegion)
      multiPlayer.setLoop(loopRegion)
      multiPlayer.seek(cursorUtt.start)
      multiPlayer.play()
      return true
    }
    const utts = _timedUtts()
    const idx = _uttIdxAtPlayhead(utts)
    if (idx < 0) return false
    _armAndPlay(utts[idx]!)
    return true
  }

  function playNextUtt(): boolean {
    const utts = _timedUtts()
    if (utts.length === 0) return false
    const idx = _uttIdxAtPlayhead(utts)
    const target = utts[idx + 1] ?? utts[utts.length - 1]!
    _armAndPlay(target)
    return true
  }

  // Single press: restart current utterance. If already near the start (<0.5s in), go to previous.
  function playCurrentOrPrevUtt(): boolean {
    const utts = _timedUtts()
    if (utts.length === 0) return false
    const idx = _uttIdxAtPlayhead(utts)
    if (idx < 0) { _armAndPlay(utts[0]!); return true }
    const cur = utts[idx]!
    const target = (playhead - cur.start < 0.5 && idx > 0) ? utts[idx - 1]! : cur
    _armAndPlay(target)
    return true
  }
  function setSpeed(s: number) { mediaSpeed = s; multiPlayer.setSpeed(s) }
  function stepSpeedUp()   { const i = SPEED_STEPS.findIndex(s => s > mediaSpeed); if (i >= 0) setSpeed(SPEED_STEPS[i]!) }
  function stepSpeedDown() { const arr = [...SPEED_STEPS].reverse(); const s = arr.find(s => s < mediaSpeed); if (s) setSpeed(s) }

  function laneMenuDepth(laneId: string, depth?: number): number {
    if (timelineData.lanes.find(l => l.id === laneId)?.type === 'participant') return 0
    if (laneId.startsWith('tokens:')) return 1
    if (laneId.startsWith('ann:')) {
      const tier = tiers.find(t => t.id === laneId.slice(4))
      return 1 + (tier?.parentTierId ? laneMenuDepth(`ann:${tier.parentTierId}`) : 0)
    }
    return depth ?? 0
  }

  function isLaneHidden(laneId: string): boolean {
    if (hiddenLaneIds.has(laneId)) return true
    if (laneId.startsWith('tokens:')) {
      // Hidden if the corresponding utterance lane for the same participant is hidden
      const tokenLane = timelineData.lanes.find(l => l.id === laneId)
      if (tokenLane && timelineData.lanes.some(l => l.type === 'participant' && l.participant === tokenLane.participant && hiddenLaneIds.has(l.id))) return true
      return false
    }
    if (laneId.startsWith('ann:')) {
      const tier = tiers.find(t => t.id === laneId.slice(4))
      if (tier?.parentTierId && isLaneHidden(`ann:${tier.parentTierId}`)) return true
      if (tier?.participant) {
        // Hidden if any utterance lane for this participant is hidden
        if (timelineData.lanes.some(l => l.type === 'participant' && l.participant === tier.participant && hiddenLaneIds.has(l.id))) return true
      }
    }
    return false
  }
  let mergedVadSegments = $state<VadSegment[]>([])

  let snapMode = $state<'off' | SnapMode>('all')
  let snapChannelId = $state<string | null>(null)
  let annotationSnapMode = $state<'all' | 'same-lane' | 'none'>('all')
  let snapMenuPos = $state<{ x: number; y: number } | null>(null)
  let _snapMenuEl = $state<HTMLDivElement | null>(null)
  let _snapMenuCloseTimer: ReturnType<typeof setTimeout> | null = null
  const SNAP_MODES: SnapMode[] = ['all', 'vad', 'waveform', 'spectrogram']

  function _openSnapMenu(el: HTMLElement) {
    if (_snapMenuCloseTimer) { clearTimeout(_snapMenuCloseTimer); _snapMenuCloseTimer = null }
    const r = el.getBoundingClientRect()
    snapMenuPos = { x: r.right + 4, y: r.top }
    requestAnimationFrame(() => {
      if (!_snapMenuEl || !snapMenuPos) return
      const over = snapMenuPos.y + _snapMenuEl.offsetHeight - (window.innerHeight - 8)
      if (over > 0) snapMenuPos = { ...snapMenuPos, y: snapMenuPos.y - over }
    })
  }
  function _scheduleSnapMenuClose() {
    _snapMenuCloseTimer = setTimeout(() => { snapMenuPos = null; _snapMenuCloseTimer = null }, 150)
  }
  function _cancelSnapMenuClose() {
    if (_snapMenuCloseTimer) { clearTimeout(_snapMenuCloseTimer); _snapMenuCloseTimer = null }
  }
  let openMenu    = $state<string | null>(null)

  // Editor pane context menu
  interface EditorCtxMenu {
    open: boolean; x: number; y: number
    blockPos?: number
    blockType?: 'utterance'
  }
  let editorCtxMenu = $state<EditorCtxMenu>({ open: false, x: 0, y: 0 })

  function handleEditorContextMenu(e: MouseEvent) {
    e.preventDefault()
    const hit = editorRef?.blockTypeAtCoords(e.clientX, e.clientY)
    const estW = 200, estH = 80
    const x = Math.max(8, Math.min(e.clientX, window.innerWidth  - estW - 8))
    const y = Math.max(8, Math.min(e.clientY, window.innerHeight - estH - 8))
    editorCtxMenu = { open: true, x, y, ...(hit?.pos !== undefined ? { blockPos: hit.pos } : {}), ...(hit?.type !== undefined ? { blockType: hit.type } : {}) }
  }

  function closeEditorCtxMenu() { editorCtxMenu = { ...editorCtxMenu, open: false } }

  function setEditorMode(mode: 'edit' | 'annotate') {
    editorMode = mode
    if (mode === 'edit') editorRef?.focus()
  }

  function toggleLoop() {
    if (loopRegion) {
      loopRegion = null
      timelineRef?.setLoopRegion(null)
      multiPlayer.setLoop(null)
      return
    }
    // Prefer active timeline drag selection, then selected bar
    if (tlSelection) {
      loopRegion = { ...tlSelection }
    } else if (selectedId) {
      const bar = timelineData.bars.find(b => b.nodeId === selectedId)
      if (bar && bar.start != null && bar.end != null) {
        loopRegion = { start: bar.start, end: bar.end }
      }
    }
    timelineRef?.setLoopRegion(loopRegion)
    multiPlayer.setLoop(loopRegion)
    if (loopRegion) {
      multiPlayer.seek(loopRegion.start)
      multiPlayer.play()
    }
  }

  // Context menu state
  interface ContextMenu {
    open: boolean
    x: number
    y: number
    laneId: string    // full lane id, e.g. 'ann:xyz' or 'speaker:A'
    tierId: string    // only set when laneId starts with 'ann:'
    laneType: string  // lane.type from timelineData, e.g. 'participant', 'annotation'
  }
  let ctxMenu = $state<ContextMenu>({ open: false, x: 0, y: 0, laneId: '', tierId: '', laneType: '' })

  interface EditUttTierDialog {
    open: boolean
    tierName: string
    participant: string
  }
  let editUttTierDlg = $state<EditUttTierDialog>({ open: false, tierName: '', participant: '' })
  // lt-word tier lanes are ann:-prefixed but are word lanes, not annotation tiers.
  const ctxIsAnnotationTier = $derived(
    ctxMenu.laneId.startsWith('ann:') &&
    !tiers.some(t => t.id === ctxMenu.tierId && isTokenLtId(t.linguisticTypeId))
  )

  interface AddTierDialog {
    open: boolean
    participant: string
    parentLaneId: string
  }
  let addTierDlg = $state<AddTierDialog>({ open: false, participant: '', parentLaneId: '' })
  let addParticipantDlgOpen = $state(false)
  let participantsDlgOpen   = $state(false)
  let uttTiersDlgOpen       = $state(false)

let patternSchemaDlgOpen = $state(false)
  let vocabDlgOpen = $state(false)
  let lingTypeDlgOpen = $state(false)
  let symbolDlgOpen = $state(false)
  let preferencesDlgOpen = $state(false)

  let trackMappingDlgTrackSet = $state<TrackSet | null>(null)

  interface AssignVocabDialog {
    open: boolean
    tierId: string
  }
  let assignVocabDlg = $state<AssignVocabDialog>({ open: false, tierId: '' })

  interface AssignLingTypeDialog {
    open: boolean
    tierId: string
  }
  let assignLingTypeDlg = $state<AssignLingTypeDialog>({ open: false, tierId: '' })

  let linkParticipantDlg = $state<{ open: boolean; tierId: string }>({ open: false, tierId: '' })

  let editTierDlg = $state<{ open: boolean; tierId: string }>({ open: false, tierId: '' })

  interface SegmentTierDialog {
    open: boolean
    tiers: Array<{ id: string; name: string }>
    channels: Array<{ id: string; label: string; bins: WaveformBins }>
    mergedSegments: VadSegment[]
  }
  let segmentTierDlg = $state<SegmentTierDialog>({ open: false, tiers: [], channels: [], mergedSegments: [] })

  interface EditAnnPopoverState {
    open: boolean
    annId: string
    x: number
    y: number
    value: string
    vocabId: string
  }
  let editAnnPopover = $state<EditAnnPopoverState>({ open: false, annId: '', x: 0, y: 0, value: '', vocabId: '' })

  interface EafImportState {
    open: boolean
    eaf: EAFDocument | null
    eafFilePath: string | null
  }
  let eafImportDlg = $state<EafImportState>({ open: false, eaf: null, eafFilePath: null })

  function closeCtxMenu() { ctxMenu = { ...ctxMenu, open: false } }

  function closeAnyOpenDlg() {
    if (addTierDlg.open)      addTierDlg      = { ...addTierDlg,      open: false }
    if (editTierDlg.open)     editTierDlg     = { ...editTierDlg,     open: false }
    if (assignVocabDlg.open)  assignVocabDlg  = { ...assignVocabDlg,  open: false }
    if (assignLingTypeDlg.open) assignLingTypeDlg = { ...assignLingTypeDlg, open: false }
    if (linkParticipantDlg.open)   linkParticipantDlg   = { ...linkParticipantDlg,   open: false }
    if (eafImportDlg.open)     eafImportDlg     = { ...eafImportDlg,     open: false }
    if (segmentTierDlg.open)   segmentTierDlg   = { ...segmentTierDlg,   open: false }
    patternSchemaDlgOpen     = false
    vocabDlgOpen           = false
    lingTypeDlgOpen        = false
    symbolDlgOpen          = false
    preferencesDlgOpen     = false
    trackMappingDlgTrackSet = null
    _trackVizDlgOpen       = false
    tlSettingsOpen         = false
    tlGearMenuPos          = null
  }

  const _anyDlgOpen = () =>
    addTierDlg.open || assignVocabDlg.open || editTierDlg.open ||
    assignLingTypeDlg.open || linkParticipantDlg.open || eafImportDlg.open || segmentTierDlg.open ||
    patternSchemaDlgOpen || vocabDlgOpen || lingTypeDlgOpen || symbolDlgOpen || preferencesDlgOpen ||
    trackMappingDlgTrackSet !== null || _trackVizDlgOpen || tlSettingsOpen

  // Auto-populate direct time_subdivision/symbolic_subdivision child tiers when a parent annotation is added.
  // Called from the annotation:add observer; safe to call recursively (each level
  // checks for existing children before adding).
  function _autoPopulateChildTiers(ann: Annotation): void {
    const tierId = ann.features.tierId as string | undefined
    if (!tierId) return
    const childTiers = store.allTiers().filter(t => {
      if (t.parentTierId !== tierId) return false
      const c = store.resolveTierConstraint(t.id)
      return c === 'time_subdivision' || c === 'symbolic_subdivision' || c === 'symbolic_association'
    })
    if (childTiers.length === 0) return
    store.transact(() => {
      for (const ct of childTiers) {
        if (store.getOrderedAnnotations(ct.id, ann.id).length > 0) continue
        const c = store.resolveTierConstraint(ct.id)
        if (c === 'symbolic_subdivision' || c === 'symbolic_association') {
          store.addAnnotation('', [], { tierId: ct.id, parentAnnId: ann.id })
        } else {
          const pt = resolveAnnTime(ann.id)
          if (!pt) continue
          store.addAnnotation('', [timeAnchor(pt.start, pt.end)], { tierId: ct.id, parentAnnId: ann.id })
        }
      }
    })
  }

  // Split a store annotation, creating a new sibling after it.
  // For timed annotations: resize original to [start, splitTime], new sibling gets [splitTime, end].
  // For symbolic_subdivision (no stored time): just insert a new empty-anchor sibling; display
  // times redistribute automatically via docToTimeline.
  function splitAnnotation(barId: string, splitTime: number): void {
    const ann = store.getAnnotation(barId)
    if (!ann) return
    const annTierDef = tiers.find(t => t.id === (ann.features.tierId as string | undefined))
    if (!annTierDef?.parentTierId && !(ann.features.tokenNodeId as string | undefined)) return
    const ta = ann.anchors.find(a => a.type === 'time')
    if (!ta || ta.type !== 'time') {
      // symbolic_subdivision: insert a new empty-anchor sibling after this one
      store.addAnnotation(ann.type ?? '', [], { ...ann.features as Record<string, unknown> }, undefined, barId)
      _pushTimelineData()
      return
    }
    const { start, end } = ta
    if (splitTime <= start + 0.001 || splitTime >= end - 0.001) return
    store.transact(() => {
      store.updateAnnotation(barId, {
        anchors: ann.anchors.map(a => a.type === 'time' ? timeAnchor(start, splitTime) : a),
      }, USER_ORIGIN, true)
      updateChildAnnotations(barId, start, splitTime, start, end, store)
      store.addAnnotation(ann.type ?? '', [timeAnchor(splitTime, end)], {
        ...ann.features as Record<string, unknown>,
      }, undefined, barId)
    })
    _pushTimelineData()
  }

  interface BarContextMenu {
    open: boolean
    x: number
    y: number
    barId: string
    timeAtClick: number
    constraint: string | null
    isEdgeBar: boolean  // true if this bar is first or last in its time_subdivision group
    splitTime: number | null  // playhead time if within bar range, else null
    uttParticipant: string | null  // non-null when this is an utterance bar
  }
  let barCtxMenu = $state<BarContextMenu>({ open: false, x: 0, y: 0, barId: '', timeAtClick: 0, constraint: null, isEdgeBar: false, splitTime: null, uttParticipant: null })
  function closeBarCtxMenu() { barCtxMenu = { ...barCtxMenu, open: false } }

  function handleBarContextMenu(barId: string, timeAtClick: number, clientX: number, clientY: number) {
    const bar = timelineData.bars.find(b => b.nodeId === barId)
    if (!bar) return
    const constraint = bar.constraint ?? null

    // For time_subdivision word tokens: determine if this bar is first/last in its subdivision group
    let isEdgeBar = false
    if (constraint === 'time_subdivision' && bar.parentNodeId) {
      const siblings = timelineData.bars
        .filter(b => b.parentNodeId === bar.parentNodeId && b.constraint === 'time_subdivision')
        .sort((a, b) => a.start - b.start)
      const idx = siblings.findIndex(b => b.nodeId === barId)
      isEdgeBar = idx === 0 || idx === siblings.length - 1
    }

    // Show "Split at playhead" for child-tier store annotations only (not top-level).
    // Use bar display times so symbolic_subdivision (no stored time anchor) also works.
    const ann = store.getAnnotation(barId)
    const tierDef = ann ? tiers.find(t => t.id === ann.features.tierId) : undefined
    const isTopLevel = !tierDef?.parentTierId
    const splitTime = (!isTopLevel && ann && playhead > bar.start + 0.001 && playhead < bar.end - 0.001)
      ? playhead : null

    const uttParticipant = bar.type === 'utterance' ? (timelineData.lanes.find(l => l.id === bar.laneId)?.participant ?? null) : null

    barCtxMenu = { open: true, x: clientX, y: clientY, barId, timeAtClick, constraint, isEdgeBar, splitTime, uttParticipant }
  }

  function barCtxMoveToParticipant(target: string) {
    const { barId } = barCtxMenu
    closeBarCtxMenu()
    editorRef?.applyParticipantChange(barId, target)
  }

  function barCtxDivideHere() {
    const { barId } = barCtxMenu
    closeBarCtxMenu()
    const ann = store.getAnnotation(barId)
    if (!ann) return
    const features = { ...ann.features }
    store.addAnnotation('', [], features as Record<string, unknown>, undefined, barId)
    _pushTimelineData()
  }

  function barCtxUnsetTime() {
    const { barId } = barCtxMenu
    closeBarCtxMenu()
    const tok = tokenStore.getToken(barId)
    if (tok) {
      store.removeTokenTime(barId)
      _pushTimelineData()
    }
  }

  function barCtxSplitAtPlayhead() {
    const { barId, splitTime } = barCtxMenu
    closeBarCtxMenu()
    if (splitTime !== null) splitAnnotation(barId, splitTime)
  }

  function participantFromTierName(tierName: string): string {
    if (tierName.startsWith('utterance:')) return tierName.slice('utterance:'.length)
    return tierName
  }

  /** Base tier attr for an utterance lane ID ('' = default utterance:<participant> lane). */
  function laneBase(laneId: string, participant: string): string {
    if (laneId === `utterance:${participant}` || laneId === 'utterance:unknown') return ''
    return participant && laneId.endsWith(`:${participant}`)
      ? laneId.slice(0, -(participant.length + 1))
      : laneId
  }

  /** Normalize a user-typed lane label to a base tier attr. Accepts both 'turn' and
   *  'turn:<participant>' forms; 'utterance' / 'utterance:<participant>' resets to the
   *  default lane (''). Returns null when the label is reserved or collides. */
  function normalizeLaneLabel(label: string, participant: string): string | null {
    let base = label.trim()
    if (participant && base.endsWith(`:${participant}`)) base = base.slice(0, -(participant.length + 1))
    if (base === '' || base === 'utterance') return ''
    if (tierNameError(base, participant)) return null
    return base
  }

  function handleRenameLane(laneId: string, newLabel: string) {
    if (laneId.startsWith('ann:')) {
      if (tierNameError(newLabel, '')) return
      store.updateTier(laneId.slice('ann:'.length), { name: newLabel })
      return
    }

    // Utterance lanes: renaming only changes the tier display name, not the participant.
    const lane = timelineData.lanes.find(l => l.id === laneId)
    if (lane?.type === 'participant') {
      const p = lane.participant ?? ''
      const newBase = normalizeLaneLabel(newLabel, p)
      if (newBase === null) return
      editorRef?.updateUttTier(p, laneBase(laneId, p), newBase)
      _pushTimelineData()
      return
    }
  }

  function handleLaneContextMenu(laneId: string, clientX: number, clientY: number) {
    const tierId = laneId.startsWith('ann:') ? laneId.slice('ann:'.length) : ''
    const laneType = timelineData.lanes.find(l => l.id === laneId)?.type ?? ''
    ctxMenu = { open: true, x: clientX, y: clientY, laneId, tierId, laneType }
  }

  function clampToViewport(node: HTMLElement) {
    const rect = node.getBoundingClientRect()
    const x = Math.max(8, Math.min(parseFloat(node.style.left), window.innerWidth  - rect.width  - 8))
    const y = Math.max(8, Math.min(parseFloat(node.style.top),  window.innerHeight - rect.height - 8))
    node.style.left = `${x}px`
    node.style.top  = `${y}px`
  }

  function ctxAddChildTier() {
    const parentLane = timelineData.lanes.find(l => l.id === `ann:${ctxMenu.tierId}`)
    addTierDlg = { open: true, participant: parentLane?.participant ?? '', parentLaneId: `ann:${ctxMenu.tierId}` }
    closeCtxMenu()
  }

  function ctxAddParticipantSubTier() {
    const lane = timelineData.lanes.find(l => l.id === ctxMenu.laneId)
    const participant = lane?.participant ?? participantFromTierName(ctxMenu.laneId)
    addTierDlg = { open: true, participant, parentLaneId: '' }
    closeCtxMenu()
  }

  function ctxEditUttTier() {
    const lane = timelineData.lanes.find(l => l.id === ctxMenu.laneId)
    const currentParticipant = lane?.participant ?? participantFromTierName(ctxMenu.laneId)
    editUttTierDlg = { open: true, tierName: ctxMenu.laneId, participant: currentParticipant }
    closeCtxMenu()
  }

  function confirmEditUttTier(tierName: string, participant: string) {
    const { tierName: oldLaneId, participant: oldParticipant } = editUttTierDlg
    editUttTierDlg = { ...editUttTierDlg, open: false }
    // The typed name may carry either the old or the new participant suffix — strip old first.
    const stripped = oldParticipant && tierName.endsWith(`:${oldParticipant}`)
      ? tierName.slice(0, -(oldParticipant.length + 1))
      : tierName
    const newBase = normalizeLaneLabel(stripped, participant)
    if (newBase === null) return
    editorRef?.updateUttTier(oldParticipant, laneBase(oldLaneId, oldParticipant), newBase,
      participant !== oldParticipant ? participant : undefined)
    if (oldParticipant !== participant) {
      for (const tier of store.allTiersOrdered()) {
        if (tier.participant === oldParticipant) store.updateTier(tier.id, { participant })
      }
    }
    _pushTimelineData()
  }

  function getUttTiersForDialog() {
    const map = new SvelteMap<string, number>()
    ;(editorRef?.liveDoc() ?? currentDoc).forEach((node: Node) => {
      if (node.type.name !== 'utterance') return
      const lane = uttLaneId(node.attrs.tier as string | undefined, (node.attrs.participant as string | undefined) ?? '')
      map.set(lane, (map.get(lane) ?? 0) + 1)
    })
    return [...map.entries()].map(([tierName, count]) => ({ tierName, count }))
  }

  function handleUttTierUpdate(oldTierName: string, newTierName: string) {
    const lane = timelineData.lanes.find(l => l.id === oldTierName)
    const p = lane?.participant ?? participantFromTierName(oldTierName)
    const newBase = normalizeLaneLabel(newTierName, p)
    if (newBase === null) return
    editorRef?.updateUttTier(p, laneBase(oldTierName, p), newBase)
    _pushTimelineData()
  }

  function ctxAddWordSubTier() {
    const lane = timelineData.lanes.find(l => l.id === ctxMenu.laneId)
    const participant = lane?.participant
      ?? tiers.find(t => t.id === ctxMenu.tierId && isTokenLtId(t.linguisticTypeId))?.participant
      ?? ''
    addTierDlg = { open: true, participant, parentLaneId: ctxMenu.laneId }
    closeCtxMenu()
  }

  function ctxSetTokenTierIncludedIn(includedIn: boolean) {
    // Named token tier from EAF: tierId is already in ctxMenu.tierId (lane is ann:${id})
    // Unnamed token lane (tokens:…): resolve participant from the lane, then find/create tier
    let tierId = ctxMenu.tierId
    if (!tierId) {
      const lane = timelineData.lanes.find(l => l.id === ctxMenu.laneId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const participant: string = (lane as any)?.participant ?? ''
      if (!participant) { closeCtxMenu(); return }
      tierId = ensureWordTier(participant).id
    }
    store.updateTier(tierId, { linguisticTypeId: includedIn ? TOKEN_LT_II_ID : TOKEN_LT_ID })
    _pushTimelineData()
    closeCtxMenu()
  }

  function ctxPromoteTokenTimes() {
    const laneId = ctxMenu.laneId

    // Collect utterance IDs from bars (for membership only — order comes from the token store)
    const uttIds = new SvelteSet<string>()
    for (const bar of timelineData.bars) {
      if (bar.laneId === laneId && bar.type === 'token' && bar.parentNodeId)
        uttIds.add(bar.parentNodeId)
    }

    store.transact(() => {
      for (const uttId of uttIds) {
        // Tokens in utterance (textual) order — closer to the truth than sorting by bar time
        // Use the same filter as docToTimeline (kind !== 'ws') so sentinels align with
        // the actual first/last displayed bars. Filtering to word/gap only would misplace
        // the anchor when the utterance ends (or starts) with a punct token.
        const tokens = tokenStore.getUttTokens(uttId).filter(t => t.kind !== 'ws')
        const parentBar = timelineData.bars.find(b => b.nodeId === uttId)
        if (!tokens.length || !parentBar) continue
        const parentStart = +parentBar.start.toFixed(3)
        const parentEnd   = +parentBar.end.toFixed(3)
        const first = tokens[0]!
        const last = tokens[tokens.length - 1]!
        if (tokens.length == 1) {
          store.setTokenTime(first.id, parentStart, parentEnd)
        } else {
          // Sentinel pattern: null on one side means "inherits the utterance boundary".
          // first gets { start: parentStart, end: null } — its right edge is open,
          // docToTimeline uses the next timed token's start as this token's end.
          // last gets { start: null, end: parentEnd } — symmetrically open on the left.
          store.setTokenTime(first.id, parentStart, null)
          store.setTokenTime(last.id, null, parentEnd)
        }
      }
    })

    _pushTimelineData()
    closeCtxMenu()
  }

  function ctxDemoteTokenTimes() {
    const laneId = ctxMenu.laneId
    for (const bar of timelineData.bars) {
      if (bar.laneId === laneId && bar.type === 'token')
        store.removeTokenTime(bar.nodeId)
    }
    _pushTimelineData()
    _checkGapWarnings(timelineDoc)
    closeCtxMenu()
  }

  function ctxAssignLingType() {
    assignLingTypeDlg = { open: true, tierId: ctxMenu.tierId }
    closeCtxMenu()
  }

  function ctxAssignVocab() {
    assignVocabDlg = { open: true, tierId: ctxMenu.tierId }
    closeCtxMenu()
  }

  function ctxLinkToParticipant() {
    linkParticipantDlg = { open: true, tierId: ctxMenu.tierId }
    closeCtxMenu()
  }

  function ctxToggleInlineGloss() {
    const tier = store.getTier(ctxMenu.tierId)
    if (!tier) { closeCtxMenu(); return }
    store.updateTier(tier.id, { inlineGloss: !tier.inlineGloss })
    closeCtxMenu()
  }

  function ctxEditTier() {
    editTierDlg = { open: true, tierId: ctxMenu.tierId }
    closeCtxMenu()
  }

  function confirmEditTier(vals: { name: string; participant: string }) {
    const tier = store.getTier(editTierDlg.tierId)
    editTierDlg = { ...editTierDlg, open: false }
    if (!tier) return
    const base = vals.name.trim()
    if (!base || tierNameError(base, vals.participant, tier.id)) return
    store.updateTier(tier.id, {
      name: composeTierName(base, vals.participant),
      participant: vals.participant || undefined,
    })
  }

  /** Base name of a tier (its name with the :participant suffix stripped). */
  function tierBaseName(tier: TierDef): string {
    return tier.participant && tier.name.endsWith(`:${tier.participant}`)
      ? tier.name.slice(0, -(tier.participant.length + 1))
      : tier.name
  }

  function ctxDeleteTier() {
    const tierId = ctxMenu.tierId
    const tier = store.getTier(tierId)
    if (!tier) { closeCtxMenu(); return }
    if (window.confirm(`Delete tier "${tier.name}"?`)) {
      store.removeTierCascade(tierId)
    }
    closeCtxMenu()
  }

  function ctxSegmentTier() {
    const tierId = ctxMenu.tierId
    const tier = store.getTier(tierId)
    if (!tier) { closeCtxMenu(); return }
    closeCtxMenu()
    const channels = mediaSignals.filter(s => s.kind === 'waveform' && s.waveformBins).map(s => ({ id: s.id, label: s.label, bins: s.waveformBins! }))
    segmentTierDlg = { open: true, tiers: [{ id: tierId, name: tier.name }], channels, mergedSegments: mergedVadSegments }
  }

  function _openSegmentTierDlg() {
    const annTiers = tiers.filter(t => !t.parentTierId && !isTokenLtId(t.linguisticTypeId)).map(t => ({ id: t.id, name: t.name }))
    const channels = mediaSignals.filter(s => s.kind === 'waveform' && s.waveformBins).map(s => ({ id: s.id, label: s.label, bins: s.waveformBins! }))
    segmentTierDlg = { open: true, tiers: annTiers, channels, mergedSegments: mergedVadSegments }
  }

  function confirmSegmentTier(params: { tierId: string; channelId: string | null; minDuration: number; maxGap: number; replaceExisting: boolean }) {
    const { tierId, channelId, minDuration, maxGap, replaceExisting } = params
    const channels = segmentTierDlg.channels
    segmentTierDlg = { ...segmentTierDlg, open: false }

    let rawSegs: VadSegment[]
    if (channelId === null) {
      rawSegs = mergedVadSegments
    } else {
      const ch = channels.find(c => c.id === channelId)
      rawSegs = ch ? computeEnergyVad(ch.bins.rms, 1, ch.bins.binDuration) : []
    }

    // merge gaps and filter min duration
    const merged: VadSegment[] = []
    for (const s of rawSegs) {
      const last = merged[merged.length - 1]
      if (last && s.start - last.end <= maxGap) {
        last.end = Math.max(last.end, s.end)
      } else {
        merged.push({ start: s.start, end: s.end })
      }
    }
    const segs = merged.filter(s => s.end - s.start >= minDuration)
    if (segs.length === 0) return

    store.transact(() => {
      if (replaceExisting) {
        for (const ann of store.getOrderedAnnotations(tierId)) {
          store.removeAnnotation(ann.id)
        }
      } else {
        // remove only overlapping annotations
        const removed = new SvelteSet<string>()
        for (const seg of segs) {
          for (const ann of store.annotationsInRange(seg.start, seg.end)) {
            if (!removed.has(ann.id) && ann.features.tierId === tierId) {
              store.removeAnnotation(ann.id)
              removed.add(ann.id)
            }
          }
        }
      }
      for (const seg of segs) {
        store.addAnnotation('', [timeAnchor(seg.start, seg.end)], { tierId })
      }
    })
  }

  // Handlers

  function _syncTimeKeeperFromDoc(doc: Node) {
    timeKeeper.clearRegistrations()
    doc.forEach((node: Node) => {
      const s: number | null = node.attrs?.startTimeSeconds
      const e: number | null = node.attrs?.endTimeSeconds
      const id: string | null = node.attrs?.id
      if (s != null && e != null && id) timeKeeper.register(id, s, e)
    })
    timeKeeper.seek(timeKeeper.getTime())
  }

  function newDoc() {
    for (const p of multiPlayer.players.slice()) multiPlayer.removeTrack(p.id)
    for (const url of imageRegistry.values()) URL.revokeObjectURL(url)
    imageRegistry.clear()
    store.loadJSON({ annotations: [] })
    transcriptFont = store.getTranscriptFont()
    filecontroller.currentFilename = null
    filecontroller.currentFormat = null
    eafPassthrough = null
    eafSlotAssignments = new Map()
    _applyNewDoc(createEmptyDoc())
  }

  function _applyNewDoc(doc: Node, tokens?: TokenRecord[]) {
    currentDoc = doc
    _lastDocNodeCount = doc.childCount
    _syncTimeKeeperFromDoc(doc)
    _recomputeWarnings(doc)
    editorRef?.resetDoc(doc, tokens)
    undoManager.clear()
  }

  let _lastDocNodeCount = initialDoc.childCount
  const mediaResolver = new MediaResolver()

  const filecontroller = new FileController(untrack(() => platform), {
    onImported(result: ImportResult, _filename: string, _formatId: string) {
      const newDoc = schema.nodeFromJSON(result.docJSON)
      store.loadJSON(result.storeData)
      if (result.tokenTimes) store.loadTokenTimes(result.tokenTimes)
      _applyNewDoc(newDoc, result.tokens)
      for (const sug of result.suggestions ?? []) store.addSuggestion(sug.change, sug.authorId, sug.note, sug.id)
      if (result.transcriptFont) transcriptFont = store.getTranscriptFont()
      if (result.language) documentLanguage = result.language
    },
    onEafText(text: string, filePath: string | null) {
      try {
        const eaf = parseXML(text)
        eafImportDlg = { open: true, eaf, eafFilePath: filePath }
      } catch (err) {
        console.error('Failed to load EAF:', err)
        alert('Could not load file — invalid EAF format.')
      }
    },
    async onMumoBytes(bytes: Uint8Array, _filename: string, path?: string | null) {
      try {
        await _loadMumoBytes(bytes, path ?? null)
      } catch (err) {
        console.error('Failed to load .mumo:', err)
        alert('Could not load file — invalid .mumo format.')
      }
    },
  })

  /** Shared .mumo load: images, doc + store, tracks, linked media, spectrogram overviews. */
  async function _loadMumoBytes(bytes: Uint8Array, filePath: string | null = null): Promise<void> {
    for (const p of multiPlayer.players.slice(1)) multiPlayer.removeTrack(p.id)
    const unpacked = unpackMumo(bytes)
    for (const url of imageRegistry.values()) URL.revokeObjectURL(url)
    imageRegistry.clear()
    for (const [path, data] of unpacked.images) {
      const imgFilename = path.split('/').pop() ?? path
      const id = imgFilename.replace(/\.[^.]+$/, '')
      const fileExt = (imgFilename.split('.').pop() ?? 'png').toLowerCase()
      const mime = fileExt === 'jpg' || fileExt === 'jpeg' ? 'image/jpeg' : fileExt === 'webp' ? 'image/webp' : fileExt === 'gif' ? 'image/gif' : 'image/png'
      imageRegistry.set(id, URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: mime })))
    }
    const parsed = parseMMEAF(unpacked.mmeaf)
    const newDoc = schema.nodeFromJSON(parsed.doc)
    store.loadJSON({ annotations: parsed.annotations, tiers: parsed.tiers, vocabularies: parsed.vocabularies, linguisticTypes: parsed.linguisticTypes, patternSchemas: parsed.patternSchemas, patterns: parsed.patterns, participants: parsed.participants, symbolDefs: parsed.symbolDefs, transcriptFont: parsed.transcriptFont, bookmarks: parsed.bookmarks ?? [] })
    store.loadTokenTimes(parsed.tokenTimes ?? {})
    _applyNewDoc(newDoc, parsed.tokens)
    for (const sug of parsed.suggestions ?? []) store.addSuggestion(sug.change, sug.authorId, sug.note, sug.id)
    transcriptFont = store.getTranscriptFont()
    if (unpacked.trackSetsJSON) {
      trackStore.loadJSON(JSON.parse(unpacked.trackSetsJSON))
      for (const [key, buf] of unpacked.trackBuffers) {
        const slash = key.indexOf('/')
        const aligned = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
        trackStore.loadBuffer(key.slice(0, slash), key.slice(slash + 1), new Float32Array(aligned))
      }
      _syncTrackOverlay()
    }
    if (parsed.media.length > 0) {
      const [primaryDesc, ...secondaryDescs] = parsed.media
      const tryLoadDesc = async (desc: typeof parsed.media[number], primary: boolean) => {
        try {
          const result = await mediaResolver.resolve(desc, filePath, platform)
          if (!result) return
          if (primary) {
            if (result.kind === 'url') await multiPlayer.loadPrimaryUrl(result.url)
            else await loadMediaFile(result.file, result.path)
          } else {
            const offsetSec = (desc.timeOrigin ?? 0) / 1000
            if (result.kind === 'url') await multiPlayer.addTrackUrl(result.url, offsetSec)
            else await multiPlayer.addTrack(result.file, result.path, offsetSec)
          }
        } catch { /* media file may have moved */ }
      }
      const loads: Promise<void>[] = []
      if (primaryDesc) loads.push(tryLoadDesc(primaryDesc, true))
      for (const d of secondaryDescs) loads.push(tryLoadDesc(d, false))
      await Promise.all(loads)
    } else if (unpacked.manifest.mediaPaths?.length) {
      // Backward compat: old .mumo files without MEDIA_DESCRIPTOR in MMEAF
      const [primaryPath, ...extraPaths] = unpacked.manifest.mediaPaths
      const tryLoad = async (mediaPath: string, primary: boolean) => {
        try {
          const f = new File([], mediaPath.split(/[/\\]/).pop() ?? 'media', { type: guessMime(mediaPath) })
          if (primary) await loadMediaFile(f, mediaPath)
          else await multiPlayer.addTrack(f, mediaPath)
        } catch { /* media file may have moved */ }
      }
      const loads: Promise<void>[] = []
      if (primaryPath) loads.push(tryLoad(primaryPath, true))
      for (const p of extraPaths) loads.push(tryLoad(p, false))
      await Promise.all(loads)
    }
    for (const entry of unpacked.manifest.spectrograms) {
      const data = unpacked.spectrograms.get(entry.path)
      if (!data) continue
      const channelIndex = (entry.params['channelIndex'] as number | undefined) ?? 0
      const player = multiPlayer.players.find(p =>
        (entry.mediaHash && p.track?.mediaHash === entry.mediaHash) ||
        (entry.mediaPath && (p.track?.path === entry.mediaPath || p.state?.filename === entry.mediaPath))
      )
      if (!player) continue
      const channelId = `${player.id}:spectrogram:ch${channelIndex}`
      const timeStart = (entry.params['timeStart'] as number | undefined) ?? 0
      const timeEnd   = (entry.params['timeEnd']   as number | undefined) ?? 0
      void _pngBytesToTile(data as Uint8Array<ArrayBuffer>, timeStart, timeEnd).then(tile => {
        if (tile) timelineRef?.setSpectrogramOverview(channelId, tile)
      })
    }
  }

  filecontroller
    .registerImporter({
      id: 'mmeaf', label: 'MMEAF', extensions: ['mmeaf'],
      import(text) {
        const p = parseMMEAF(text)
        return { docJSON: p.doc as object, storeData: { annotations: p.annotations, tiers: p.tiers, vocabularies: p.vocabularies, linguisticTypes: p.linguisticTypes, patternSchemas: p.patternSchemas, patterns: p.patterns, participants: p.participants, symbolDefs: p.symbolDefs }, tokens: p.tokens, tokenTimes: p.tokenTimes, transcriptFont: p.transcriptFont, suggestions: p.suggestions }
      },
    })
    .registerImporter({
      id: 'mmetf', label: 'MMEAF template', extensions: ['mmetf'], isTemplate: true,
      import(text) {
        const p = parseMMETF(text)
        return { docJSON: p.doc as object, storeData: { annotations: p.annotations, tiers: p.tiers, vocabularies: p.vocabularies, linguisticTypes: p.linguisticTypes, patternSchemas: p.patternSchemas, patterns: p.patterns, participants: p.participants, symbolDefs: p.symbolDefs }, tokens: p.tokens, tokenTimes: p.tokenTimes, transcriptFont: p.transcriptFont }
      },
    })
    .registerImporter({
      id: 'json', label: 'JSON', extensions: ['json'],
      import(text) {
        const data = JSON.parse(text) as { doc: object; [k: string]: unknown }
        const tokens = data.tokens as import('@mumo/core').TokenRecord[] | undefined
        return { docJSON: data.doc, storeData: data as never, ...(tokens !== undefined ? { tokens } : {}) }
      },
    })
    .registerExporter({
      id: 'mmeaf', label: 'MMEAF', extension: 'mmeaf',
      export({ docJSON, store: s, tokenStore: ts, opts }) {
        return emitMMEAF(docJSON as never, s, {
          ...(opts?.language !== undefined ? { language: opts.language } : {}),
          ...(opts?.mediaUrl !== undefined ? { mediaUrl: opts.mediaUrl } : {}),
          ...(opts?.mimeType ? { mimeType: opts.mimeType } : {}),
          ...(opts?.mediaHash ? { mediaHash: opts.mediaHash } : {}),
          ...(opts?.timeOriginMs !== undefined ? { timeOrigin: opts.timeOriginMs } : {}),
          ...(ts ? { tokenStore: ts } : {}),
          ...(opts?.includeTokenTiers && ts ? { includeWords: true } : {}),
          ...(opts?.additionalMedia?.length ? { additionalMedia: opts.additionalMedia.map(m => ({
            mediaUrl: m.mediaUrl,
            ...(m.mimeType ? { mimeType: m.mimeType } : {}),
            ...(m.mediaHash ? { mediaHash: m.mediaHash } : {}),
            ...(m.timeOriginMs !== undefined ? { timeOrigin: m.timeOriginMs } : {}),
          })) } : {}),
        }, ts)
      },
    })
    .registerExporter({
      id: 'mmetf', label: 'MMEAF template', extension: 'mmetf', isTemplate: true,
      export({ store: s }) { return emitMMETF(s) },
    })
    .registerExporter({
      id: 'eaf', label: 'EAF', extension: 'eaf',
      export({ docJSON, store: s, tokenStore: ts, opts }) {
        return emitEAF(docJSON as never, s, {
          ...(opts?.language !== undefined ? { language: opts.language } : {}),
          ...(opts?.mediaUrl !== undefined ? { mediaUrl: opts.mediaUrl } : {}),
          ...(opts?.mimeType ? { mimeType: opts.mimeType } : {}),
          ...(opts?.mediaHash ? { mediaHash: opts.mediaHash } : {}),
          ...(opts?.timeOriginMs !== undefined ? { timeOrigin: opts.timeOriginMs } : {}),
          ...(ts ? { tokenStore: ts } : {}),
          ...(opts?.includeTokenTiers && ts ? { includeWords: true } : {}),
          ...(opts?.additionalMedia?.length ? { additionalMedia: opts.additionalMedia.map(m => ({
            mediaUrl: m.mediaUrl,
            ...(m.mimeType ? { mimeType: m.mimeType } : {}),
            ...(m.mediaHash ? { mediaHash: m.mediaHash } : {}),
            ...(m.timeOriginMs !== undefined ? { timeOrigin: m.timeOriginMs } : {}),
          })) } : {}),
          ...(opts?.headerProperties?.length ? { headerProperties: opts.headerProperties } : {}),
        })
      },
    })
    .registerExporter({
      id: 'etf', label: 'EAF template', extension: 'etf', isTemplate: true,
      export({ store: s }) { return emitETF(s) },
    })
    .registerExporter({
      id: 'json', label: 'JSON', extension: 'json', mimeType: 'application/json',
      export({ docJSON, store: s }) {
        return JSON.stringify({ version: 1, doc: docJSON, ...s.toJSON() }, null, 2)
      },
    })
    .registerExporter({
      id: 'vtt', label: 'WebVTT', extension: 'vtt', mimeType: 'text/vtt',
      export({ docJSON }) { return emitVTT(docJSON as never) },
    })
    .registerExporter({
      id: 'txt', label: 'Plain text', extension: 'txt', mimeType: 'text/plain',
      export({ docJSON }) { return emitTXT(docJSON as never) },
    })
    .registerExporter({
      id: 'csv', label: 'CSV', extension: 'csv', mimeType: 'text/csv',
      export({ docJSON, store: s }) { return emitCSV(docJSON as never, s) },
    })

  function _syncSymbolicAnnotations(doc: Node): void {
    if (_isUndoRedo()) return
    const symbolicTiers = store.allTiers().filter(tier =>
      !tier.parentTierId && store.resolveTierConstraint(tier.id) === 'symbolic_association' &&
      !!tier.participant
    )
    if (symbolicTiers.length === 0) return

    const coverage = _getSymbolicCoverage()

    store.transact(() => {
      for (const tier of symbolicTiers) {
        let covered = coverage.get(tier.id)
        if (!covered) { covered = new SvelteSet(); coverage.set(tier.id, covered) }

        const tierParticipant = tier.participant  // undefined for no-participant gloss tiers
        doc.forEach((block: Node) => {
          if (block.type.name !== 'utterance') return
          if (tierParticipant && block.attrs.participant !== tierParticipant) return
          const uttId = block.attrs.id as string
          if (!covered!.has(uttId)) {
            store.addAnnotation('', [], { tierId: tier.id, blockNodeId: uttId })
            covered!.add(uttId)
          }
        })
      }
    })
  }

  function _applyInsertionHeuristics(doc: Node, meta: ControllerMeta) {
    const { newIds, shrunkBlocks, removedIds } = meta
    if (newIds.size === 0 && shrunkBlocks.size === 0 && removedIds.size === 0) return
    const getTime = (id: string) => {
      const t = store.getTokenTime(id)
      if (t?.start == null || t?.end == null) return undefined
      return { start: t.start, end: t.end }
    }
    const setTime = (id: string, s: number, e: number) => store.setTokenTime(id, s, e)
    store.transact(() => {
      doc.forEach((block: Node) => {
        if (block.type.name !== 'utterance') return
        const blockId = block.attrs.id as string
        const tokens = tokenStore.getUttTokens(blockId)
        if (tokens.some(t => newIds.has(t.id)))
          applyInsertionHeuristic(tokens, store, newIds, block.attrs.startTimeSeconds, block.attrs.endTimeSeconds)
        if (shrunkBlocks.has(blockId)) {
          const parentStart: number | null = block.attrs.startTimeSeconds
          const parentEnd:   number | null = block.attrs.endTimeSeconds
          if (parentStart !== null && parentEnd !== null) {
            healPromotedBlock(tokens, parentStart, parentEnd, getTime, setTime)
            // After healing, ensure edge tokens are sentinels if the block retains any timing.
            // Handles the fragment where a sentinel edge token was deleted and its neighbor
            // has no stored time — promote it to a new sentinel so the block stays anchored.
            const nonWs = tokens.filter(t => t.kind !== 'ws')
            if (nonWs.length > 0 && nonWs.some(t => store.getTokenTime(t.id) !== undefined)) {
              const first = nonWs[0]!
              const last  = nonWs[nonWs.length - 1]!
              if (!store.getTokenTime(first.id)) setTime(first.id, parentStart, parentStart)
              if (!store.getTokenTime(last.id))  setTime(last.id, parentEnd, parentEnd)
            }
          }
        }
      })
      // Remove annotations whose parent token was deleted
      for (const tokenId of removedIds) {
        for (const ann of store.childrenOf(tokenId)) {
          store.removeAnnotation(ann.id)
        }
      }
    })
  }

  function handleDocChange(doc: Node, editorState: EditorState) {
    currentDoc = doc  // plain assignment — no Svelte reactivity
    // Update synchronously so syncStore()'s queueMicrotask(_pushTimelineData) sees
    // the correct doc when it fires after all Yjs observers complete (e.g. after undo).
    timelineDoc = doc
    gutterRef?.refresh(doc)
    // Symbolic annotation sync must be synchronous: runs in the same JS task as the
    // PM→Yjs transaction so the UndoManager groups them into one undo entry.
    _syncSymbolicAnnotations(doc)
    if (_isDragging) {
      if (_timelineTimer !== null) { clearTimeout(_timelineTimer); _timelineTimer = null }
      return
    }
    // Run time heuristics synchronously so they group with the PM change in the same undo step.
    // Skip during undo/redo: the restored state is already correct; healing would overwrite it.
    if (!_isUndoRedo()) {
      const meta = controllerKey.getState(editorState) ?? { newIds: new Set(), shrunkBlocks: new Set(), removedIds: new Set() }
      _applyInsertionHeuristics(doc, meta)
    }
    // Debounce the heavier visual ops.
    const structuralChange = doc.childCount !== _lastDocNodeCount
    if (_timelineTimer !== null) clearTimeout(_timelineTimer)
    _timelineTimer = setTimeout(() => {
      _lastDocNodeCount = doc.childCount
      if (structuralChange) _syncTimeKeeperFromDoc(doc)
      _checkGapWarnings(doc)
      _pushTimelineData()
    }, 150)
  }
  function handleSeek(t: number) {
    _setTimecode(t)
    timeKeeper.seek(t)
    multiPlayer.seek(t)
    timelineRef?.scrollToTime(t)
  }

  function handleBarDblClick(barId: string, clientX: number, clientY: number) {
    const popW = 220, popH = 46
    const x = Math.max(8, Math.min(clientX - popW / 2, window.innerWidth - popW - 8))
    const y = Math.max(8, clientY - popH - 14)

    // Ghost bar for annotation:add suggestion
    if (barId.startsWith('suggestion:')) {
      const sugId = barId.slice('suggestion:'.length)
      const sug = store.getSuggestion(sugId)
      if (sug?.change.type !== 'annotation:add') return
      const a = sug.change.annotation
      const tierId = a.features.tierId as string | undefined
      const tier = tierId ? store.getTier(tierId) : undefined
      const vocabId = tier ? (resolveTierVocabulary(tier) ?? '') : ''
      editAnnPopover = { open: true, annId: barId, x, y, value: a.type, vocabId }
      return
    }

    const ann = store.getAnnotation(barId)
    if (!ann) return
    const tier = store.getTier(ann.features.tierId as string)
    if (tier?.isUttTier) return
    const vocabId = tier ? (resolveTierVocabulary(tier) ?? '') : ''
    editAnnPopover = { open: true, annId: barId, x, y, value: ann.type, vocabId }
  }

  function commitEditAnn(value: string) {
    if (!editAnnPopover.annId) return
    const annId = editAnnPopover.annId

    if (annId.startsWith('suggestion:')) {
      // Editing label of an annotation:add ghost bar
      const sugId = annId.slice('suggestion:'.length)
      const sug = store.getSuggestion(sugId)
      if (sug?.change.type === 'annotation:add') {
        store.updateSuggestionChange(sugId, {
          ...sug.change,
          annotation: { ...sug.change.annotation, type: value },
        })
      }
    } else if (suggestMode) {
      store.addSuggestion({
        type: 'annotation:update',
        annotationId: annId,
        patch: { type: value },
      }, 'user:local')
    } else {
      store.updateAnnotation(annId, { type: value })
    }
    editAnnPopover = { ...editAnnPopover, open: false }
  }

  function closeEditAnn() {
    editAnnPopover = { ...editAnnPopover, open: false }
  }

  function docNodeKind(id: string): 'utterance' | 'token' | null {
    let kind: 'utterance' | 'token' | null = null
    const doc = editorRef?.liveDoc() ?? currentDoc
    doc.forEach((block: Node) => {
      if (block.attrs?.id === id) { kind = 'utterance'; return }
      block.forEach((inline: Node) => { if (inline.attrs?.id === id) kind = 'token' })
    })
    return kind
  }

  function handleSelectBar(nodeId: string | null) {
    if (slotFillMode && nodeId) {
      const { patternId, slotSchemaId, anchorKind } = slotFillMode
      if (store.getAnnotation(nodeId)) {
        if (!_slotAccepts(anchorKind, 'span')) { _rejectSlotFill(`This slot expects a ${anchorKind}`); return }
        fillSlot(patternId, slotSchemaId, nodeId)
        return
      }
      const kind = docNodeKind(nodeId)
      if (kind === 'utterance') {
        if (!_slotAccepts(anchorKind, 'utterance')) { _rejectSlotFill(`This slot expects a ${anchorKind}`); return }
        fillSlotWithNewAnnotation(patternId, slotSchemaId, '', [], { utteranceId: nodeId })
        return
      }
      if (kind === 'token') {
        if (!_slotAccepts(anchorKind, 'token')) { _rejectSlotFill(`This slot expects a ${anchorKind}`); return }
        fillSlotWithNewAnnotation(patternId, slotSchemaId, '', [], { tokenId: nodeId })
        return
      }
    }
    selectedId = nodeId
    timelineRef?.setSelectedId(nodeId)
    collab.setLocalState('selectedBarId', nodeId)
    // Focus the corresponding track when a bar in a tracking tier is selected
    if (nodeId) {
      const bar = timelineData.bars.find(b => b.nodeId === nodeId)
      if (bar?.laneId.startsWith('ann:')) {
        const barTier = tiers.find(t => t.id === bar.laneId.slice(4))
        if (barTier?.trackRef) _setFocusedTrack(barTier.trackRef)
      }
    }
    if (!nodeId) return
    if (store.getAnnotation(nodeId)) return
    editorRef?.focusBlock(nodeId)
  }


  function handleCommitBars(updates: CommitEntry[]) {
    _isDragging = true
    const pmIds = editorRef?.getBlockIds() ?? new Set<string>()

    const pmUpdates    = updates.filter(u => u.nodeId != null && pmIds.has(u.nodeId) && !u.nodeId.startsWith('track-presence:'))
    const storeUpdates = updates.filter(u => u.nodeId != null && !pmIds.has(u.nodeId) && !u.nodeId.startsWith('track-presence:'))

    const gapTextUpdates: Array<{ tok: TokenRecord; newText: string }> = []
    const annSuggestUpdates: Array<{ ann: Annotation; start: number; end: number }> = []
    const uttSuggestUpdates: Array<{ nodeId: string; start: number; end: number }> = []

    ydoc.transact(() => {
      for (const { nodeId, start, end } of pmUpdates) {
        if (suggestMode) {
          uttSuggestUpdates.push({ nodeId, start, end })
          continue
        }
        for (const child of yXmlFragment.toArray()) {
          if (child instanceof Y.XmlElement && child.getAttribute('id') === nodeId) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            child.setAttribute('startTimeSeconds', +start.toFixed(3) as any)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            child.setAttribute('endTimeSeconds',   +end.toFixed(3) as any)
          }
        }
      }
      for (const { nodeId, start, end, origStart, origEnd } of storeUpdates) {
        const tok = tokenStore.getToken(nodeId)
        if (tok) {
          if (tok.kind === 'gap') {
            const newText = formatGapDuration(end - start)
            if (newText !== tok.text) {
              tok.text = newText
              gapTextUpdates.push({ tok, newText })
            }
          }
          store.setTokenTime(nodeId, +start.toFixed(3), +end.toFixed(3))
          updateChildAnnotations(nodeId, start, end, origStart, origEnd, store)
          continue
        }
        // Ghost bars for annotation:add suggestions
        if (nodeId.startsWith('suggestion:')) {
          const sugId = nodeId.slice('suggestion:'.length)
          const sug = store.getSuggestion(sugId)
          if (sug?.change.type === 'annotation:add') {
            const a = sug.change.annotation
            store.updateSuggestionChange(sugId, {
              ...sug.change,
              annotation: {
                ...a,
                anchors: a.anchors.map(x => x.type === 'time' ? timeAnchor(+start.toFixed(3), +end.toFixed(3)) : x),
              },
            })
          }
          continue
        }
        // Ghost bars for annotation:update (move) suggestions
        if (nodeId.startsWith('suggestion-move:')) {
          const sugId = nodeId.slice('suggestion-move:'.length)
          const sug = store.getSuggestion(sugId)
          if (sug?.change.type === 'annotation:update') {
            const existingAnchors = sug.change.patch.anchors ?? store.getAnnotation(sug.change.annotationId)?.anchors ?? []
            store.updateSuggestionChange(sugId, {
              ...sug.change,
              patch: {
                ...sug.change.patch,
                anchors: existingAnchors.map(x => x.type === 'time' ? timeAnchor(+start.toFixed(3), +end.toFixed(3)) : x),
              },
            })
          }
          continue
        }
        // Ghost bars for utt:set-time (move) suggestions
        if (nodeId.startsWith('suggestion-utt-move:')) {
          const sugId = nodeId.slice('suggestion-utt-move:'.length)
          const sug = store.getSuggestion(sugId)
          if (sug?.change.type === 'utt:set-time') {
            store.updateSuggestionChange(sugId, { ...sug.change, startTime: +start.toFixed(3), endTime: +end.toFixed(3) })
          }
          continue
        }
        const ann = store.getAnnotation(nodeId)
        if (!ann) continue
        const prevAnchor = ann.anchors.find(a => a.type === 'time')
        const prevStart  = prevAnchor?.type === 'time' ? prevAnchor.start : origStart
        const prevEnd    = prevAnchor?.type === 'time' ? prevAnchor.end   : origEnd
        if (Math.abs(prevStart - start) < 0.0005 && Math.abs(prevEnd - end) < 0.0005) continue
        if (suggestMode) {
          annSuggestUpdates.push({ ann, start, end })
        } else {
          store.updateAnnotation(nodeId, {
            anchors: ann.anchors.map(a => a.type === 'time' ? timeAnchor(start, end) : a),
          }, USER_ORIGIN, true)
          updateChildAnnotations(nodeId, start, end, prevStart, prevEnd, store)
        }
      }
    }, USER_ORIGIN)

    for (const { ann, start, end } of annSuggestUpdates) {
      store.addSuggestion({
        type: 'annotation:update',
        annotationId: ann.id,
        patch: { anchors: ann.anchors.map(a => a.type === 'time' ? timeAnchor(+start.toFixed(3), +end.toFixed(3)) : a) },
      }, 'user:local')
    }

    for (const { nodeId, start, end } of uttSuggestUpdates) {
      // Check if there's already a pending utt:set-time suggestion for this utterance
      const existing = store.allSuggestions().find(s => s.change.type === 'utt:set-time' && s.change.uttId === nodeId)
      if (existing) {
        store.updateSuggestionChange(existing.id, { type: 'utt:set-time', uttId: nodeId, startTime: +start.toFixed(3), endTime: +end.toFixed(3) })
      } else {
        store.addSuggestion({ type: 'utt:set-time', uttId: nodeId, startTime: +start.toFixed(3), endTime: +end.toFixed(3) }, 'user:local')
      }
    }

    for (const { tok, newText } of gapTextUpdates) {
      editorRef?.updateGapText(tok, newText)
    }

    if (pmUpdates.length > 0 && !suggestMode) {
      editorRef?.reorderByTime(true)
      const doc = editorRef?.liveDoc()
      if (doc) {
        _syncTimeKeeperFromDoc(doc)
        _recomputeWarnings(doc)
        timelineDoc = doc
      }
    }

    _isDragging = false
    _pushTimelineData()
  }

  function handleNudgeEdge(barId: string, side: 'left' | 'right', direction: 1 | -1) {
    const fps = (_focusedTrackRef ? trackStore.getTrackSet(_focusedTrackRef.trackSetId)?.frameRate : null) ?? 30
    const delta = direction / fps

    const ann = store.getAnnotation(barId)
    if (!ann) return
    const ta = ann.anchors.find(a => a.type === 'time')
    if (!ta || ta.type !== 'time') return
    const newStart = side === 'left'  ? +(ta.start + delta).toFixed(3) : ta.start
    const newEnd   = side === 'right' ? +(ta.end   + delta).toFixed(3) : ta.end
    if (newStart >= newEnd) return
    const tierId     = ann.features.tierId     as string | undefined
    const parentAnnId = ann.features.parentAnnId as string | undefined
    const constraint = store.resolveTierConstraint(tierId)
    if (suggestMode) {
      store.addSuggestion({
        type: 'annotation:update',
        annotationId: barId,
        patch: { anchors: ann.anchors.map(a => a.type === 'time' ? timeAnchor(newStart, newEnd) : a) },
      }, 'user:local')
      _pushTimelineData()
      return
    }
    store.transact(() => {
      store.updateAnnotation(barId, {
        anchors: ann.anchors.map(a => a.type === 'time' ? timeAnchor(newStart, newEnd) : a),
      }, USER_ORIGIN, true)
      updateChildAnnotations(barId, newStart, newEnd, ta.start, ta.end, store)
      if (constraint === 'time_subdivision' && tierId) {
        const tokenNodeId = ann.features.tokenNodeId as string | undefined
        let siblings = store.getOrderedAnnotations(tierId, parentAnnId)
        if (tokenNodeId) {
          siblings = siblings.filter(s => (s.features.tokenNodeId as string | undefined) === tokenNodeId)
        }
        const myIdx = siblings.findIndex(a => a.id === barId)
        const sibAnn = side === 'right'
          ? (myIdx !== -1 && myIdx < siblings.length - 1 ? siblings[myIdx + 1] : undefined)
          : (myIdx > 0 ? siblings[myIdx - 1] : undefined)
        if (sibAnn) {
          const sibTa = sibAnn.anchors.find(a => a.type === 'time')
          if (sibTa && sibTa.type === 'time') {
            const sibNewStart = side === 'right' ? newEnd       : sibTa.start
            const sibNewEnd   = side === 'left'  ? newStart     : sibTa.end
            store.updateAnnotation(sibAnn.id, {
              anchors: sibAnn.anchors.map(a => a.type === 'time' ? timeAnchor(sibNewStart, sibNewEnd) : a),
            }, USER_ORIGIN, true)
            updateChildAnnotations(sibAnn.id, sibNewStart, sibNewEnd, sibTa.start, sibTa.end, store)
          }
        }
      }
    })
    _pushTimelineData()
  }

  function handleSelection(start: number, end: number, laneId: string | null) {
    if (!laneId) return

    {
      const uttLane = timelineData.lanes.find(l => l.id === laneId && l.type === 'participant')
      if (uttLane) {
        const nextBar = timelineData.bars
          .filter(b => b.laneId === laneId && b.type === 'utterance' && b.start > start)
          .sort((a, b) => a.start - b.start)[0]
        const clippedEnd = nextBar ? Math.min(end, nextBar.start) : end
        if (clippedEnd - start < 0.05) return
        editorRef?.insertBlockAtTime('utterance', {
          participant: uttLane.participant,
          tier: laneId.startsWith('utterance:') ? '' : laneId,
          startTimeSeconds: +start.toFixed(3),
          endTimeSeconds: +clippedEnd.toFixed(3),
        }, start)
        return
      }
    }

    if (laneId.startsWith('ann:')) {
      const tierId  = laneId.slice('ann:'.length)
      const tierDef = tiers.find(t => t.id === tierId)
      if (!tierDef) return
      // lt-word lanes are word-token lanes — not annotation tiers; skip drag-create
      if (isTokenLtId(tierDef.linguisticTypeId)) return
      if (end - start < 0.02) return

      const features: Record<string, unknown> = { tierId }
      let insertAfterAnn: string | null | undefined = undefined

      // For child tiers, find the parent annotation (or token) that spans this range
      if (tierDef.parentTierId) {
        const parentTierDef = tiers.find(t => t.id === tierDef.parentTierId)
        const parentIsWord  = parentTierDef ? isTokenLtId(parentTierDef.linguisticTypeId) : false

        if (parentIsWord) {
          // Parent is a token lane — find the word bar at the drag midpoint
          const tokenLaneId = `ann:${parentTierDef!.id}`
          const mid = (start + end) / 2
          const tokenBar = timelineData.bars.find(b =>
            b.type === 'token' && b.laneId === tokenLaneId && b.start <= mid && b.end > mid)
          if (!tokenBar) return // not inside a token
          features.tokenNodeId = tokenBar.id
          start = Math.max(start, tokenBar.start)
          end   = Math.min(end,   tokenBar.end)
        } else {
          const parentAnns = annotations.filter(a => {
            const ta = a.anchors.find(x => x.type === 'time')
            if (!ta || ta.type !== 'time') return false
            if (a.features.tierId !== tierDef.parentTierId) return false
            return ta.start <= start && ta.end >= end
          })
          const parentAnn = parentAnns[0]
          if (!parentAnn) return // must be inside a parent annotation

          features.parentAnnId = parentAnn.id

          const effectiveConstraint = resolveTierConstraint(tierDef)
          if (effectiveConstraint === 'time_subdivision' || effectiveConstraint === 'included_in') {
            // Clamp to parent span
            const ta = parentAnn.anchors.find(x => x.type === 'time')!
            if (ta.type === 'time') {
              start = Math.max(start, ta.start)
              end   = Math.min(end,   ta.end)
            }
          }
          // symbolic_association: inherit parent time (no independent time stored)
          if (effectiveConstraint === 'symbolic_association') {
            const ta = parentAnn.anchors.find(x => x.type === 'time')!
            if (ta.type === 'time') {
              start = ta.start
              end   = ta.end
            }
          }
          // symbolic_subdivision: position is list-order; insert after leftmost sibling
          if (effectiveConstraint === 'symbolic_subdivision') {
            const siblingBars = timelineData.bars
              .filter(b => b.laneId === laneId && b.parentNodeId === parentAnn.id)
              .sort((a, b) => (a.listIndex ?? 0) - (b.listIndex ?? 0))
            const leftSibling = [...siblingBars].reverse().find(b => b.start <= start)
            insertAfterAnn = leftSibling ? leftSibling.id : null
          }
        }
      }

      const effectiveConstraint = resolveTierConstraint(tierDef)
      const annAnchors = (effectiveConstraint === 'symbolic_association' || effectiveConstraint === 'symbolic_subdivision')
        ? []
        : [timeAnchor(start, end)]

      if (suggestMode) {
        const annId = newId()
        store.addSuggestion({
          type: 'annotation:add',
          annotation: { id: annId, type: '', anchors: annAnchors, features },
        }, 'user:local')
      } else {
        const newAnn = store.addAnnotation('', annAnchors, features, undefined, insertAfterAnn)
        // Auto-create 1:1 children for symbolic_association child tiers.
        // symbolic_subdivision is handled by _autoPopulateChildTiers via annotation:add.
        if (!tierDef.parentTierId) {
          for (const childTier of tiers.filter(t => t.parentTierId === tierId && resolveTierConstraint(t) === 'symbolic_association')) {
            store.addAnnotation('', [], {
              tierId: childTier.id,
              parentAnnId: newAnn.id,
            })
          }
        }
      }
    }
  }

  // Slot fill

  interface HoverMenuItem {
    label: string
    kind: 'annotation' | 'token' | 'utterance'
    id: string
    el?: HTMLElement  // undefined for token items (no DOM span)
  }

  // Written synchronously by ontokenhover before the outer div's mousemove fires
  let _lastTokenHover: { id: string; text: string; x: number; y: number } | null = null

  function handleTokenHover(token: TokenRecord | null, x: number, y: number) {
    _lastTokenHover = token ? { id: token.id, text: token.text, x, y } : null
  }

  interface HoverMenuState {
    x: number; y: number
    anchorKey: string
    items: HoverMenuItem[]
  }

  let hoverMenu     = $state<HoverMenuState | null>(null)
  let hoverCloseTimer: ReturnType<typeof setTimeout> | null = null

  function hoverCssForAnnotation(annId: string): string {
    const ann = store.getAnnotation(annId)
    if (!ann) return ''
    const uttId = ann.features.utteranceId as string | undefined
    if (uttId) return `[data-id="${CSS.escape(uttId)}"] .utt-content { ${HOVER_UNDERLINE_CSS} }`
    const markAnchor = ann.anchors.find(a => a.type === 'mark')
    if (markAnchor?.type === 'mark') return `.ann-span[data-ann-id="${CSS.escape(markAnchor.markId)}"] { ${HOVER_UNDERLINE_CSS} }`
    const tokenId = ann.features.tokenId as string | undefined
    if (tokenId) return `[data-id="${CSS.escape(tokenId)}"] { ${HOVER_UNDERLINE_CSS} }`
    return ''
  }

  function injectInspectorHover(css: string) {
    getOrCreateStyle('mumo-inspector-hover').textContent = css
  }

  function clearInspectorHover() {
    getOrCreateStyle('mumo-inspector-hover').textContent = ''
  }

  function handleHoverSlot(slotSchemaId: string | null) {
    clearInspectorHover()
    editorRef?.setSlotHighlightToken(null)
    if (!slotSchemaId || !selectedPatternId) return
    const pattern = patterns.find(f => f.id === selectedPatternId)
    const slot = pattern?.slots.find(s => s.schemaSlotId === slotSchemaId)
    if (!slot) return
    const ann = store.getAnnotation(slot.annotationId)
    if (!ann) return
    const tokenId = ann.features.tokenId as string | undefined
    if (tokenId) {
      editorRef?.setSlotHighlightToken({ id: tokenId })
      return
    }
    const css = hoverCssForAnnotation(slot.annotationId)
    if (css) injectInspectorHover(css)
  }

  function _timelineHighlightIds(): string[] {
    return tlSelection ? _blockIdsForTimeRange(tlSelection.start, tlSelection.end) : []
  }

  const HOVER_UNDERLINE_CSS = 'text-decoration: underline wavy 2px #555 !important; text-underline-offset: 3px !important; text-decoration-skip-ink: none !important;'

  function _frameSlotContent(patternId: string): { sels: string[]; tokenRefs: TokenRef[] } {
    const pattern = patterns.find(f => f.id === patternId)
    if (!pattern) return { sels: [], tokenRefs: [] }
    const sels: string[] = []
    const tokenRefs: TokenRef[] = []
    for (const slot of pattern.slots) {
      const ann = store.getAnnotation(slot.annotationId)
      if (!ann) continue
      const uttId = ann.features.utteranceId as string | undefined
      if (uttId) { sels.push(`[data-id="${CSS.escape(uttId)}"] .utt-content`); continue }
      const markAnchor = ann.anchors.find(a => a.type === 'mark')
      if (markAnchor?.type === 'mark') { sels.push(`.ann-span[data-ann-id="${CSS.escape(markAnchor.markId)}"]`); continue }
      const tokenId = ann.features.tokenId as string | undefined
      if (tokenId) tokenRefs.push({ id: tokenId })
    }
    return { sels, tokenRefs }
  }

  function handleHoverFrame(patternId: string | null) {
    if (!patternId) {
      blockHighlightPlugin.setHighlightIds(_timelineHighlightIds())
      getOrCreateStyle('mumo-pattern-hover').textContent = ''
      editorRef?.setHoverTokenRefs([])
      return
    }
    blockHighlightPlugin.setHighlightIds(tlSelection ? _blockIdsForFrame(patternId) : [])
    const { sels, tokenRefs } = _frameSlotContent(patternId)
    getOrCreateStyle('mumo-pattern-hover').textContent = sels.length
      ? `${sels.join(', ')} { ${HOVER_UNDERLINE_CSS} }`
      : ''
    editorRef?.setHoverTokenRefs(tokenRefs)
  }

  function handleHoverNoteItem(type: 'pattern' | 'textlet', sourceId: string | null) {
    if (!sourceId) {
      getOrCreateStyle('mumo-pattern-hover').textContent = ''
      getOrCreateStyle('mumo-hover-mark').textContent = ''
      editorRef?.setHoverTokenRefs([])
      return
    }
    if (type === 'pattern') {
      handleHoverFrame(sourceId)
    } else {
      setHoveredMarkId(sourceId)
    }
  }

  // Slot text styling

  function updateSlotStyles() {
    const rules: string[] = []
    const styledTokens: import('@mumo/editor').StyledTokenRef[] = []
    for (const pattern of patterns) {
      const schema = patternSchemas.find(s => s.id === pattern.schemaId)
      if (!schema) continue
      for (const inst of pattern.slots) {
        const slotSchema = schema.slots.find(s => s.id === inst.schemaSlotId)
        if (!slotSchema?.style) continue
        const ann = store.getAnnotation(inst.annotationId)
        if (!ann) continue
        const markAnchor = ann.anchors.find(a => a.type === 'mark')
        if (markAnchor?.type === 'mark') {
          const css = _slotStyleToCSS(slotSchema.style)
          if (css) rules.push(`.ann-span[data-ann-id="${CSS.escape(markAnchor.markId)}"] { ${css} }`)
          continue
        }
        const uttId = ann.features.utteranceId as string | undefined
        if (uttId) {
          const css = _slotStyleToCSS(slotSchema.style)
          if (css) rules.push(`[data-id="${CSS.escape(uttId)}"] .utt-content { ${css} }`)
          continue
        }
        const tokenId = ann.features.tokenId as string | undefined
        if (tokenId) styledTokens.push({ ref: { id: tokenId }, style: slotSchema.style })
      }
    }
    getOrCreateStyle('mumo-slot-styles').textContent = rules.join('\n')
    editorRef?.setStyledSlotTokens(styledTokens)
  }

  function _slotStyleToCSS(s: import('@mumo/core').SlotTextStyle): string {
    const parts: string[] = []
    if (s.textColor)       parts.push(`color:${s.textColor}`)
    if (s.backgroundColor) parts.push(`background-color:${s.backgroundColor}`)
    if (s.bold)            parts.push(`font-weight:bold`)
    if (s.italic)          parts.push(`font-style:italic`)
    const td: string[] = []
    if (s.underline)       td.push('underline')
    if (s.strikethrough)   td.push('line-through')
    if (td.length)         parts.push(`text-decoration:${td.join(' ')}`)
    if (s.borderColor)     parts.push(`outline:1px solid ${s.borderColor};border-radius:2px`)
    return parts.join(';')
  }

  // Slot reference boxes

  function updateSlotRefStyles(currentSelectedPatternId: ID | null) {
    if (!currentSelectedPatternId) {
      _currentTokenRefs = []
      blockHighlightPlugin.setSelectionBoxes([])
      editorRef?.setSelectionMarkSpacers([])
      return
    }
    const selectedPattern = patterns.find(f => f.id === currentSelectedPatternId)
    if (!selectedPattern) {
      _currentTokenRefs = []
      blockHighlightPlugin.setSelectionBoxes([])
      editorRef?.setSelectionMarkSpacers([])
      return
    }
    const selectors: string[] = []
    const tokenRefs: TokenRef[] = []
    const markIds: string[] = []
    for (const slot of selectedPattern.slots) {
      const ann = store.getAnnotation(slot.annotationId)
      if (!ann) continue
      const uttId = ann.features.utteranceId as string | undefined
      if (uttId) {
        selectors.push(`[data-id="${CSS.escape(uttId)}"] .utt-content`)
        continue
      }
      const markAnchor = ann.anchors.find(a => a.type === 'mark')
      if (markAnchor?.type === 'mark') {
        selectors.push(`.ann-span[data-ann-id="${CSS.escape(markAnchor.markId)}"]`)
        markIds.push(markAnchor.markId)
        continue
      }
      const tokenId = ann.features.tokenId as string | undefined
      if (tokenId) tokenRefs.push({ id: tokenId })
    }
    _currentTokenRefs = tokenRefs
    blockHighlightPlugin.setSelectionBoxes(selectors)
    editorRef?.setSelectionMarkSpacers(markIds)
  }

  function injectHighlight(css: string) {
    getOrCreateStyle('mumo-slot-highlight').textContent = css
  }

  function clearHighlight() {
    getOrCreateStyle('mumo-slot-highlight').textContent = ''
  }

  function setRowHighlight(row: HTMLElement | null) {
    if (!row?.dataset.id) { clearHighlight(); return }
    const id = CSS.escape(row.dataset.id)
    injectHighlight(`[data-id="${id}"] .utt-content { ${HOVER_UNDERLINE_CSS} }`)
  }

  function cancelHoverClose() {
    if (hoverCloseTimer !== null) { clearTimeout(hoverCloseTimer); hoverCloseTimer = null }
  }

  function scheduleHoverClose() {
    cancelHoverClose()
    hoverCloseTimer = setTimeout(() => { hoverMenu = null }, 250)
  }

  /** Extract text covered by an annotation mark from the PM doc. */
  function getMarkTextFromDoc(markId: string): string {
    const parts: string[] = []
    ;(editorRef?.liveDoc() ?? currentDoc).descendants((node: Node) => {
      if (!node.isText) return true
      if (node.marks?.some((m: Mark) => m.type.name === 'annotation' && m.attrs.id === markId)) {
        parts.push(node.text ?? '')
      }
      return true
    })
    return parts.join('').trim()
  }

  function _broadcastFrameId(id: ID | null) {
    collab.setLocalState('selectedPatternId', id)
  }

  function handleRequestSlotFill(patternId: ID, slotSchemaId: ID, anchorKind: 'span' | 'utterance' | 'pattern' | 'any') {
    slotFillMode = { patternId, slotSchemaId, anchorKind }
    // Ensure the pattern that owns this slot is selected
    if (selectedPatternId !== patternId) {
      selectedPatternId = patternId
      updateSlotRefStyles(patternId)
    }
    _broadcastFrameId(patternId)
    hoverMenu = null
    if (anchorKind !== 'pattern') editorRef?.focus()
  }

  function handleCancelSlotFill() {
    slotFillMode = null
    hoverMenu = null
    cancelHoverClose()
    setRowHighlight(null)
    clearHighlight()
  }

  function _blockIdForMark(markId: string): string | null {
    return document.querySelector(`.ann-span[data-ann-id="${CSS.escape(markId)}"]`)
      ?.closest('[data-id]')?.getAttribute('data-id') ?? null
  }

  function _blockIdsForFrame(patternId: string): string[] {
    const pattern = patterns.find(f => f.id === patternId)
    if (!pattern) return []
    const ids = new SvelteSet<string>()
    for (const slot of pattern.slots) {
      const ann = store.getAnnotation(slot.annotationId)
      if (!ann) continue
      const uttId = ann.features.utteranceId as string | undefined
      if (uttId) { ids.add(uttId); continue }
      const markAnchor = ann.anchors.find(a => a.type === 'mark')
      if (markAnchor?.type === 'mark') {
        const blockId = _blockIdForMark(markAnchor.markId)
        if (blockId) ids.add(blockId)
        continue
      }
      const tokenUttId = ann.features.uttId as string | undefined
      if (tokenUttId) ids.add(tokenUttId)
    }
    return [...ids]
  }

  function _blockIdsForTimeRange(start: number, end: number): string[] {
    const ids: string[] = []
    currentDoc.forEach((node) => {
      const s = node.attrs.startTimeSeconds as number | null
      const e = node.attrs.endTimeSeconds as number | null
      if (s == null || e == null) return
      if (s < end && e > start) ids.push(node.attrs.id as string)
    })
    return ids
  }

  function setHoveredMarkId(markId: string | null) {
    getOrCreateStyle('mumo-hover-mark').textContent = markId
      ? `.ann-span[data-ann-id="${CSS.escape(markId)}"] { ${HOVER_UNDERLINE_CSS} }`
      : ''
    const blockId = markId ? _blockIdForMark(markId) : null
    blockHighlightPlugin.setHighlightIds(blockId && tlSelection ? [blockId] : _timelineHighlightIds())
  }

  const timeKeeper = new TimeKeeper()

  // Populate timeKeeper from the initial doc.
  _syncTimeKeeperFromDoc(initialDoc)

  timeKeeper.onActiveChange((added) => {
    if (!_isPlaying || added.length === 0) return
    const scrollEl = editorScrollEl
    if (!scrollEl) return
    const id = added[0]!
    const el = scrollEl.querySelector<HTMLElement>(`[data-id="${id}"]`)
    if (!el) return
    const elRect = el.getBoundingClientRect()
    const containerRect = scrollEl.getBoundingClientRect()
    const elTopInView = elRect.top - containerRect.top
    const elBottomInView = elRect.bottom - containerRect.top
    if (elBottomInView > scrollEl.clientHeight || elTopInView < 0) {
      scrollEl.scrollTo({ top: scrollEl.scrollTop + elTopInView - 40, behavior: 'smooth' })
    }
  })

  function handleDeleteTextlet(annId: string, markId: string) {
    store.ydoc.transact(() => {
      editorRef?.removeAnnotationMark(markId)
      store.removeAnnotation(annId)
    }, USER_ORIGIN)
  }

  function handleFillWithPattern(refPatternId: ID) {
    if (!slotFillMode) return
    const { patternId, slotSchemaId } = slotFillMode
    fillSlotWithNewAnnotation(patternId, slotSchemaId, '', [], { patternId: refPatternId })
  }

  let _slotFillError = $state<string | null>(null)
  let _slotFillErrorTimer = 0

  function _rejectSlotFill(msg: string) {
    clearTimeout(_slotFillErrorTimer)
    _slotFillError = msg
    _slotFillErrorTimer = window.setTimeout(() => { _slotFillError = null }, 2200)
  }

  function _slotAccepts(anchorKind: 'span' | 'utterance' | 'pattern' | 'any', itemKind: 'span' | 'utterance' | 'pattern' | 'token'): boolean {
    if (anchorKind === 'any') return true
    if (anchorKind === 'span') return itemKind === 'span' || itemKind === 'token'
    return anchorKind === itemKind
  }

  function fillSlotWithNewAnnotation(patternId: ID, slotSchemaId: ID, type: string, anchors: Parameters<typeof store.addAnnotation>[1], features: Record<string, unknown>) {
    if (suggestMode) {
      const ann: Annotation = { id: newId(), type, anchors, features }
      // Build the slot the same way fillSlot does in suggest mode, but embed the annotation.
      const pattern = store.getPattern(patternId)
      const schemaId = pattern?.schemaId
        ?? (store.allSuggestions().find(s => s.change.type === 'pattern:add' && s.change.patternId === patternId)?.change as { schemaId: ID } | undefined)?.schemaId
      const patternSchema = schemaId ? store.getPatternSchema(schemaId) : undefined
      const isVariadic = patternSchema?.slots.find(s => s.id === slotSchemaId)?.variadic ?? false
      const existing = pattern?.slots.find(s => s.schemaSlotId === slotSchemaId)
      const slot: SlotInstance = isVariadic
        ? { id: newId(), schemaSlotId: slotSchemaId, annotationId: ann.id, metrics: [] }
        : { id: existing?.id ?? newId(), schemaSlotId: slotSchemaId, annotationId: ann.id, metrics: existing?.metrics ?? [] }
      store.addSuggestion({ type: 'pattern:fill-slot', patternId, slot, pendingAnnotation: ann }, 'user:local')
      slotFillMode = null; hoverMenu = null; setRowHighlight(null); clearHighlight()
      return
    }
    store.ydoc.transact(() => {
      const ann = store.addAnnotation(type, anchors, features)
      fillSlot(patternId, slotSchemaId, ann.id)
    }, USER_ORIGIN)
  }

  function fillSlot(patternId: ID, slotSchemaId: ID, annotationId: ID) {
    const pattern = store.getPattern(patternId)

    if (suggestMode) {
      // Pattern may not exist yet (ghost pattern created via pattern:add suggestion).
      // Look up schema via the real pattern or from the pending pattern:add suggestion.
      const schemaId = pattern?.schemaId
        ?? (store.allSuggestions().find(s => s.change.type === 'pattern:add' && (s.change as { patternId: ID }).patternId === patternId)?.change as { schemaId: ID } | undefined)?.schemaId
      const schema = schemaId ? store.getPatternSchema(schemaId) : undefined
      const isVariadic = schema?.slots.find(s => s.id === slotSchemaId)?.variadic ?? false
      const existing = pattern?.slots.find(s => s.schemaSlotId === slotSchemaId)
      const slot: SlotInstance = isVariadic
        ? { id: newId(), schemaSlotId: slotSchemaId, annotationId, metrics: [] }
        : { id: existing?.id ?? newId(), schemaSlotId: slotSchemaId, annotationId, metrics: existing?.metrics ?? [] }
      store.addSuggestion({ type: 'pattern:fill-slot', patternId, slot }, 'user:local')
      slotFillMode = null
      hoverMenu = null
      setRowHighlight(null)
      clearHighlight()
      return
    }

    if (!pattern) return
    const schema = store.getPatternSchema(pattern.schemaId)
    const isVariadic = schema?.slots.find(s => s.id === slotSchemaId)?.variadic ?? false

    {
      let newSlots: SlotInstance[]
      if (isVariadic) {
        newSlots = [...pattern.slots, { id: newId(), schemaSlotId: slotSchemaId, annotationId, metrics: [] }]
      } else {
        const existing = pattern.slots.find(s => s.schemaSlotId === slotSchemaId)
        newSlots = [
          ...pattern.slots.filter(s => s.schemaSlotId !== slotSchemaId),
          { id: existing?.id ?? newId(), schemaSlotId: slotSchemaId, annotationId, metrics: existing?.metrics ?? [] },
        ]
      }
      store.updatePattern(patternId, { slots: newSlots })
    }
    slotFillMode = null
    hoverMenu = null
    setRowHighlight(null)
    clearHighlight()
  }

  function fillSlotFromHoverItem(item: HoverMenuItem) {
    if (!slotFillMode) return
    const { patternId, slotSchemaId, anchorKind } = slotFillMode
    if (item.kind === 'annotation') {
      if (!_slotAccepts(anchorKind, 'span')) { _rejectSlotFill(`This slot expects a ${anchorKind}`); return }
      fillSlot(patternId, slotSchemaId, item.id)
    } else if (item.kind === 'token') {
      if (!_slotAccepts(anchorKind, 'token')) { _rejectSlotFill(`This slot expects a ${anchorKind}`); return }
      const tok = tokenStore.getToken(item.id)
      fillSlotWithNewAnnotation(patternId, slotSchemaId, tok?.text ?? '', [], { tokenId: item.id })
    } else if (item.kind === 'utterance') {
      if (!_slotAccepts(anchorKind, 'utterance')) { _rejectSlotFill(`This slot expects a ${anchorKind}`); return }
      fillSlotWithNewAnnotation(patternId, slotSchemaId, '', [], { utteranceId: item.id })
    }
    cancelHoverClose()
  }

  function handleEditorMouseMove(e: MouseEvent) {
    if (!slotFillMode) { if (hoverMenu) hoverMenu = null; setRowHighlight(null); return }
    const target = e.target as Element

    // Bold the whole utterance/event when hovering its line number
    const linenumEl = target.closest('.utt-linenum') as HTMLElement | null
    setRowHighlight(linenumEl ? linenumEl.closest('.utt-row') as HTMLElement | null : null)

    const items: HoverMenuItem[] = []

    // Annotation mark spans (textlets) — data-ann-id holds the mark ID, not the annotation ID.
    // Overlapping textlets render as nested spans; walk up to collect all of them.
    const annEls: HTMLElement[] = []
    let _el: Element | null = target
    while (_el) {
      if (_el.classList.contains('ann-span') && (_el as HTMLElement).dataset.annId) {
        annEls.push(_el as HTMLElement)
      }
      _el = _el.parentElement
    }
    const firstAnnEl = annEls[0] ?? null
    for (const annEl of annEls) {
      const markId = annEl.dataset.annId!
      const anns = store.byMarkId(markId)
      if (anns.length > 0) {
        const text = getMarkTextFromDoc(markId)
        items.push({ label: `textlet: "${text.slice(0, 28) || markId.slice(0, 8)}"`, kind: 'annotation', id: anns[0]!.id, el: annEl })
      }
    }

    // Word tokens — detected via the token-hover plugin (posAtCoords + TokenStore offset scan)
    if (_lastTokenHover) {
      const label = _lastTokenHover.text ? `"${_lastTokenHover.text}"` : 'token'
      items.push({ label: `token: ${label}`, kind: 'token', id: _lastTokenHover.id })
    }

    if (items.length > 0) {
      cancelHoverClose()
      // Anchor to the textlet span element if present; otherwise use cursor position
      const anchorKey = firstAnnEl?.dataset.annId ?? _lastTokenHover?.id ?? ''
      if (hoverMenu?.anchorKey !== anchorKey) {
        let x: number, y: number
        if (firstAnnEl) {
          const rect = firstAnnEl.getBoundingClientRect()
          x = rect.left + rect.width / 2
          y = rect.top - 2
        } else {
          x = _lastTokenHover!.x
          y = _lastTokenHover!.y - 2  // y is already token top from coordsAtPos
        }
        hoverMenu = { x, y, anchorKey, items }
      }
    } else {
      scheduleHoverClose()
    }
  }

  function handleTokenClick(token: TokenRecord) {
    if (!slotFillMode) return
    if (!_slotAccepts(slotFillMode.anchorKind, 'token')) {
      _rejectSlotFill(`This slot expects a ${slotFillMode.anchorKind}`)
      return
    }
    const { patternId, slotSchemaId } = slotFillMode
    fillSlotWithNewAnnotation(patternId, slotSchemaId, token.text, [], { tokenId: token.id })
  }

  function handleEditorPaneMouseUp(e: MouseEvent) {
    if (!slotFillMode) return
    const { patternId, slotSchemaId } = slotFillMode
    const target = e.target as Element
    if (target.closest('.bracket')) return  // gutter bracket click handled by its own onclick

    // Token click is handled by ontokenclick (plugin fires after mouseup)
    if (_lastTokenHover) return

    // Clicking the line number or the content area (not an annotation span) fills with the block ID
    if (target.closest('.utt-linenum') || (target.closest('.utt-content') && !target.closest('.ann-span'))) {
      const row = target.closest('.utt-row') as HTMLElement | null
      if (row?.dataset.id) {
        if (!_slotAccepts(slotFillMode.anchorKind, 'utterance')) {
          _rejectSlotFill(`This slot expects a ${slotFillMode.anchorKind}`)
          return
        }
        fillSlotWithNewAnnotation(patternId, slotSchemaId, '', [], { utteranceId: row.dataset.id })
      }
      return
    }

    // Span fill: drag selection across text
    const range = editorRef?.getSelectionRange()
    if (range) {
      const markId = newId()
      editorRef?.addAnnotationMarkToRange(markId, range.from, range.to)
      const liveDoc = editorRef?.liveDoc() ?? currentDoc
      const rpos = liveDoc.resolve(range.from)
      const uttId = rpos.depth >= 1 ? (rpos.node(1).attrs['id'] as string | undefined) : undefined
      fillSlotWithNewAnnotation(patternId, slotSchemaId, '', [{ type: 'mark', markId }], uttId ? { utteranceId: uttId } : {})
    }
  }

  // Toolbar actions


  // Image insertion

  function computeInitialWidth(url: string): Promise<number> {
    return new Promise(resolve => {
      const img = new Image()
      img.onload = () => {
        const scale = Math.min(1, 150 / img.naturalWidth, 150 / img.naturalHeight)
        resolve(Math.max(1, Math.round(img.naturalWidth * scale)))
      }
      img.onerror = () => resolve(150)
      img.src = url
    })
  }

  function fillImageNode(id: string, url: string, width: number, provenance: ImageProvenance) {
    imageRegistry.set(id, url)
    editorRef?.updateImageNode(id, width, provenance)
  }

  let imageMenu = $state<{ id: string; x: number; y: number } | null>(null)
  let imageCropBlob = $state<Blob | null>(null)
  let _pendingCropId = ''

  function insertVisualizationBlock(type = 'screenshot') {
    editorRef?.insertVisualizationBlock(type)
  }

  function insertCommentBlock() {
    editorRef?.insertCommentBlock()
  }

  // Viz context menu
  let vizMenu = $state<{
    vizId: string; vizType: string
    startSeconds: number | null; endSeconds: number | null
    editStart: number | null; editEnd: number | null
    channelId: string
    x: number; y: number
  } | null>(null)

  function onVizContextMenu(
    vizId: string, vizType: string,
    startSeconds: number | null, endSeconds: number | null,
    x: number, y: number,
  ) {
    const defaultCh = mediaSignals.find(s => s.kind === 'spectrogram')
    const initStart = tlSelection?.start ?? startSeconds
    const initEnd   = tlSelection?.end   ?? endSeconds
    vizMenu = { vizId, vizType, startSeconds, endSeconds, editStart: initStart, editEnd: initEnd, channelId: defaultCh?.id ?? '', x, y }
  }

  function _insertImageIntoViz(vizId: string): string | null {
    return editorRef?.insertImageIntoViz(vizId) ?? null
  }

  async function generateSpectForViz(vizId: string, channelId: string, startSeconds: number, endSeconds: number) {
    const ch = mediaSignals.find(s => s.id === channelId)
    if (!ch) return
    const dataUrl = timelineRef?.cropSpectrogram(ch.id, startSeconds, endSeconds)
    if (!dataUrl) return
    const imageId = _insertImageIntoViz(vizId)
    if (!imageId) return
    const w = await computeInitialWidth(dataUrl)
    fillImageNode(imageId, dataUrl, w, { kind: 'spectrogram-clip', startSeconds, endSeconds })
  }

  function onImageActivate(id: string, x: number, y: number) {
    imageMenu = { id, x, y }
  }

  function focusFirstMenuItem(node: HTMLElement) {
    const btn = node.querySelector<HTMLButtonElement>('button:not(:disabled)')
    btn?.focus()
  }

  function onImageMenuKeydown(e: KeyboardEvent) {
    const menu = e.currentTarget as HTMLElement
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const idx = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx - 1 + items.length) % items.length]?.focus() }
    else if (e.key === 'Escape') { imageMenu = null }
  }

  async function imageMenuScreenshotFull() {
    const id = imageMenu!.id
    imageMenu = null
    const player = multiPlayer.primary
    if (!player) return
    const blob = await player.captureFrame()
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const width = await computeInitialWidth(url)
    const mediaTimeMs = Math.round((multiPlayer.getPlaybackTime() - (player.track?.offsetSec ?? 0)) * 1000)
    const mediaPath = player.track?.path ?? player.state?.filename ?? ''
    fillImageNode(id, url, width, { kind: 'screenshot', mediaPath, mediaTimeMs })
  }

  async function imageMenuScreenshotCrop() {
    const id = imageMenu!.id
    imageMenu = null
    const player = multiPlayer.primary
    if (!player) return
    const blob = await player.captureFrame()
    if (!blob) return
    _pendingCropId = id
    imageCropBlob = blob
  }

  async function onCropConfirm(croppedBlob: Blob) {
    const id = _pendingCropId
    imageCropBlob = null
    _pendingCropId = ''
    const url = URL.createObjectURL(croppedBlob)
    const width = await computeInitialWidth(url)
    const player = multiPlayer.primary
    const mediaTimeMs = player
      ? Math.round((multiPlayer.getPlaybackTime() - (player.track?.offsetSec ?? 0)) * 1000)
      : 0
    const mediaPath = player?.track?.path ?? player?.state?.filename ?? ''
    fillImageNode(id, url, width, { kind: 'screenshot', mediaPath, mediaTimeMs })
  }

  async function imageMenuUpload() {
    const id = imageMenu!.id
    imageMenu = null
    const result = await platform.openBinaryFile(['png', 'jpg', 'jpeg', 'gif', 'webp'])
    if (!result) return
    const url = URL.createObjectURL(result.file)
    const width = await computeInitialWidth(url)
    fillImageNode(id, url, width, { kind: 'upload', filename: result.file.name })
  }

  function addTier() {
    addTierDlg = { open: true, participant: '', parentLaneId: '' }
  }

  function confirmAddParticipant(vals: { id: string; participant: string; annotator: string; defaultLocale: string }) {
    addParticipantDlgOpen = false
    const tierName = `utterance:${vals.id}`
    store.addTier(tierName, {
      participant: vals.participant || vals.id,
      ...(vals.annotator    ? { annotator:     vals.annotator }    : {}),
      ...(vals.defaultLocale ? { defaultLocale: vals.defaultLocale } : {}),
    })
  }

  function handleParticipantAdd(vals: Omit<ParticipantJSON, 'id'>): ParticipantJSON {
    const { label, ...rest } = vals
    return store.addParticipant(label, rest)
  }

  function handleCopyStructure(newLabel: string, source: { type: 'participant' | 'tier'; id: string }) {
    const allTiers = store.allTiersOrdered()
    const tiersToCopy = source.type === 'participant'
      ? allTiers.filter(t => t.participant === source.id)
      : allTiers.filter(t => t.id === source.id)
    for (const tier of tiersToCopy) {
      // Swap the participant suffix: gesture:Ann → gesture:Bob (names must stay unique)
      const base = tier.participant && tier.name.endsWith(`:${tier.participant}`)
        ? tier.name.slice(0, -(tier.participant.length + 1))
        : tier.name
      const newName = composeTierName(base, newLabel)
      if (store.allTiers().some(t => t.name === newName)) continue
      store.addTier(newName, {
        linguisticTypeId: tier.linguisticTypeId,
        participant: newLabel,
      })
    }
  }

  function handleParticipantUpdate(id: string, patch: Partial<Omit<ParticipantJSON, 'id'>>) {
    const old = store.getParticipant(id)
    const isRename = !!(old?.label && patch.label && old.label !== patch.label)
    if (isRename) {
      const oldLabel = old!.label
      const newLabel = patch.label!
      // Update the participant attr on all utterance nodes; tier attrs stay untouched,
      // so lane IDs re-derive as <base>:<newLabel> / utterance:<newLabel> automatically.
      editorRef?.renameParticipant(oldLabel, newLabel)
      // Store tiers scoped to this participant: swap the participant and the :suffix
      // in their names (gesture:Ann → gesture:Bob) so names stay unique and consistent.
      for (const tier of store.allTiers()) {
        if (tier.participant !== oldLabel) continue
        const name = tier.name.endsWith(`:${oldLabel}`)
          ? `${tier.name.slice(0, -(oldLabel.length + 1))}:${newLabel}`
          : tier.name
        store.updateTier(tier.id, { name, participant: newLabel })
      }
    }
    store.updateParticipant(id, patch)
    if (isRename) {
      // The PM doc and tiers update synchronously, but _pushTimelineData only fires via
      // syncStore microtask. Call it immediately so the timeline updates.
      _pushTimelineData()
    }
  }

  function handleParticipantRemove(id: string) {
    store.removeParticipant(id)
  }

  /** Tier naming convention: participant-scoped tiers are named base:participant so
   *  names stay unique (ELAN TIER_IDs must be unique) and tiers sharing a base name
   *  across participants share a linguistic type — which is what the table merges on.
   *  A suffix equal to the base is redundant and skipped (FA1, not FA1:FA1). */
  function composeTierName(base: string, participant: string): string {
    const b = base.trim()
    return participant && participant !== b ? `${b}:${participant}` : b
  }

  /** Error message if the tier name can't be used, else null.
   *  Pass excludeTierId when editing an existing tier so its own name doesn't collide. */
  function tierNameError(base: string, participant: string, excludeTierId?: string): string | null {
    const b = base.trim()
    if (!b) return null
    if (/^(utterance|tokens)(:|$)/i.test(b)) return '"utterance" and "tokens" are reserved names'
    const full = composeTierName(b, participant)
    if (store.allTiers().some(t => t.name === full && t.id !== excludeTierId)) return `A tier named "${full}" already exists`
    return null
  }

  /** Find or create the LT named by the tier's base name with the given constraint.
   *  Same-base tiers across participants share this LT so table merge groups them. */
  function ensureNamedLt(base: string, constraint: TierConstraint): string {
    const existing = lingTypes.find(lt => lt.name === base && lt.constraint === constraint)
    if (existing) return existing.id
    return store.addLinguisticType(base, { constraint }).id
  }

  function confirmAddTier(vals: { name: string; participant: string; linguisticTypeId: string; constraint: TierConstraint | ''; inlineGloss: boolean }) {
    const base = vals.name.trim()
    if (!base || tierNameError(base, vals.participant)) return
    const fullName = composeTierName(base, vals.participant)
    const ltId = vals.linguisticTypeId
      || (vals.constraint ? ensureNamedLt(base, vals.constraint as TierConstraint) : undefined)
    const parentLaneId = addTierDlg.parentLaneId

    // Resolve the lt-word parent tier (if any) so we can set parentTierId correctly.
    // Named word lanes are ann:${ltWordTier.id}; generic word lanes are tokens:${participant}.
    // Generic lanes always have a real lt-word tier created on demand via ensureWordTier.
    let ltTokenParentTier: TierDef | undefined
    let annParentId: string | undefined
    if (parentLaneId.startsWith('ann:')) {
      const id = parentLaneId.slice('ann:'.length)
      ltTokenParentTier = tiers.find(t => t.id === id && isTokenLtId(t.linguisticTypeId))
      if (!ltTokenParentTier) annParentId = id
    } else if (parentLaneId.startsWith('tokens:')) {
      const participant = timelineData.lanes.find(l => l.id === parentLaneId)?.participant ?? ''
      if (participant) ltTokenParentTier = ensureWordTier(participant)
    }
    const tokenParticipant = ltTokenParentTier?.participant ?? null

    const newTier = store.addTier(fullName, {
      ...(vals.participant  ? { participant:      vals.participant } : {}),
      ...(ltId              ? { linguisticTypeId: ltId }            : {}),
      ...(ltTokenParentTier ? { parentTierId: ltTokenParentTier.id } : {}),
      ...(annParentId       ? { parentTierId: annParentId }         : {}),
      ...(vals.inlineGloss  ? { inlineGloss: true }                 : {}),
    })
    const resolvedConstraint = resolveTierConstraint(newTier)
    const isSymbolic = resolvedConstraint === 'symbolic_association' || resolvedConstraint === 'symbolic_subdivision'
    const _addDoc = editorRef?.liveDoc() ?? currentDoc
    store.transact(() => {
      const isWordLane = !!(ltTokenParentTier || parentLaneId.startsWith('tokens:'))
      if (isSymbolic && !annParentId && !isWordLane && (vals.participant || vals.inlineGloss)) {
        const filterParticipant = vals.participant || null
        _addDoc.forEach((node: Node) => {
          if (node.type.name === 'utterance' && (!filterParticipant || node.attrs.participant === filterParticipant))
            store.addAnnotation('', [], { tierId: newTier.id, blockNodeId: node.attrs.id as ID })
        })
      }
      // Word-child annotations: named lt-word lanes (ann:ltWordId) or generic token lanes (tokens:${participant})
      if (tokenParticipant !== null && isSymbolic) {
        _addDoc.forEach((block: Node) => {
          if (block.type.name !== 'utterance' || block.attrs.participant !== tokenParticipant) return
          for (const tok of tokenStore.getUttTokens(block.attrs.id as ID)) {
            if (tok.kind !== 'ws')
              store.addAnnotation('', [], { tierId: newTier.id, tokenNodeId: tok.id })
          }
        })
      }
    })
    // Back-fill children for already-existing annotations in the parent tier
    if (annParentId && (resolvedConstraint === 'time_subdivision' || resolvedConstraint === 'symbolic_subdivision')) {
      for (const parentAnn of store.allAnnotations().filter(a => a.features.tierId === annParentId)) {
        _autoPopulateChildTiers(parentAnn)
      }
    }
    if (tokenParticipant !== null && isSymbolic && !showGlosses) {
      showGlosses = true
      setGlossesVisible(true)
    }
    addTierDlg = { ...addTierDlg, open: false }
  }

  // Assign-dialog callbacks

  function confirmAssignVocab(vals: { tierId: string; vocabularyId: string }) {
    const tier = store.getTier(vals.tierId)
    if (tier) {
      const ltId = tier.linguisticTypeId
      const vocabPatch = vals.vocabularyId ? { vocabularyId: vals.vocabularyId } : {}
      if (ltId === DEFAULT_LT_ID) {
        const lt = store.addLinguisticType(tier.name, vocabPatch)
        store.updateTier(vals.tierId, { linguisticTypeId: lt.id })
      } else {
        store.updateLinguisticType(ltId, vocabPatch)
      }
    }
    assignVocabDlg = { ...assignVocabDlg, open: false }
  }

  function confirmAssignLingType(vals: { tierId: string; linguisticTypeId: string }) {
    store.updateTier(vals.tierId, { linguisticTypeId: vals.linguisticTypeId || DEFAULT_LT_ID })
    assignLingTypeDlg = { ...assignLingTypeDlg, open: false }
  }

  function confirmLinkParticipant(participant: string) {
    const tierId = linkParticipantDlg.tierId
    linkParticipantDlg = { ...linkParticipantDlg, open: false }
    const tier = store.getTier(tierId)
    if (!tier) return

    const ltId = ensureLinguisticType('symbolic_association')
    store.updateTier(tierId, { participant, linguisticTypeId: ltId })

    // Build utterance time index for this participant
    const doc = editorRef?.liveDoc() ?? currentDoc
    const uttByTime: Array<{ id: string; start: number; end: number }> = []
    doc.forEach((node: Node) => {
      if (node.type.name !== 'utterance' || node.attrs.participant !== participant) return
      const s: number | null = node.attrs.startTimeSeconds
      const e: number | null = node.attrs.endTimeSeconds
      if (s !== null && e !== null) uttByTime.push({ id: node.attrs.id as string, start: s, end: e })
    })

    // Match existing time-anchored annotations to utterances by containment, then overlap
    store.transact(() => {
      for (const ann of store.allAnnotations().filter(a => a.features.tierId === tierId)) {
        const ta = ann.anchors.find(a => a.type === 'time')
        if (!ta || ta.type !== 'time') continue
        const utt = uttByTime.find(u => u.start <= ta.start + 0.05 && u.end >= ta.end - 0.05)
          ?? uttByTime.find(u => Math.max(u.start, ta.start) < Math.min(u.end, ta.end))
        if (!utt) continue
        store.updateAnnotation(ann.id, {
          anchors: ann.anchors.filter(a => a.type !== 'time'),
          features: { blockNodeId: utt.id },
        }, USER_ORIGIN, true)
      }
    })
  }

  function createTextletFromSelection() {
    const range = editorRef?.getSelectionRange()
    if (!range) return
    if (suggestMode) {
      const v = editorRef?.getView()
      if (!v) return
      let fromWordId: string | null = null
      let toWordId: string | null = null
      v.state.doc.forEach((utt, uttPos) => {
        const uttId = utt.attrs?.id as string | undefined
        if (!uttId) return
        const base = uttPos + 1
        const uttEnd = base + utt.content.size
        if (range.from > uttEnd || range.to < base) return
        for (const tok of tokenStore.getUttTokens(uttId)) {
          if (tok.kind !== 'word') continue
          const tokFrom = base + tok.startOffset
          const tokTo   = base + tok.endOffset
          if (tokFrom < range.to && tokTo > range.from) {
            if (!fromWordId) fromWordId = tok.id
            toWordId = tok.id
          }
        }
      })
      if (!fromWordId || !toWordId) return
      const ann: Annotation = { id: newId(), type: '', anchors: [{ type: 'word-range', fromWordId, toWordId }], features: {} }
      store.addSuggestion({ type: 'textlet:add', annotation: ann }, 'user:local')
      return
    }
    const markId = newId()
    // Wrap both in one Yjs transaction so undo is a single step.
    // The inner ydoc.transact inside dispatchTransaction collapses into the outer USER_ORIGIN one.
    store.transact(() => {
      editorRef?.addAnnotationMarkToRange(markId, range.from, range.to, true)
      store.addAnnotation('', [{ type: 'mark', markId }])
    })
  }

  async function saveJSON() {
    const data = getDoc()
    if (embedConfig?.onSave) {
      await embedConfig.onSave(data)
    } else {
      filecontroller.downloadExport('json', { docJSON: data.doc as object, store })
    }
  }

  function exportVTT() {
    filecontroller.downloadExport('vtt', { docJSON: (editorRef?.liveDoc() ?? currentDoc).toJSON(), store })
  }
  function exportTXT() {
    filecontroller.downloadExport('txt', { docJSON: (editorRef?.liveDoc() ?? currentDoc).toJSON(), store })
  }
  function exportCSV() {
    filecontroller.downloadExport('csv', { docJSON: (editorRef?.liveDoc() ?? currentDoc).toJSON(), store })
  }

  function setLanguage() {
    const next = prompt('Document language (BCP47 tag, e.g. en, en-US, fr):', documentLanguage)
    if (next !== null && next.trim()) documentLanguage = next.trim()
  }

  function trackToMediaUrl(track: import('@mumo/media-player').MediaTrack): string {
    return track.path ?? track.mediaUrl
  }

  function normalizeMimeType(raw: string): string {
    if (raw === 'audio/wav' || raw === 'audio/vnd.wave' || raw === 'audio/wave') return 'audio/x-wav'
    return raw
  }

  function _trackDescriptor(t: import('@mumo/media-player').MediaTrack, fallbackDesc?: import('@mumo/serialization').EAFMediaDescriptor) {
    const computedUrl = trackToMediaUrl(t)
    // In the browser track.path is null, so trackToMediaUrl returns the blob URL.
    // Prefer the stored descriptor URL (a real file:// path) over an ephemeral blob.
    const mediaUrl = computedUrl.startsWith('blob:') && fallbackDesc?.mediaUrl && !fallbackDesc.mediaUrl.startsWith('blob:')
      ? fallbackDesc.mediaUrl
      : computedUrl
    return {
      mediaUrl,
      ...(t.file.type ? { mimeType: normalizeMimeType(t.file.type) } : fallbackDesc?.mimeType ? { mimeType: fallbackDesc.mimeType } : {}),
      ...(t.mediaHash ? { mediaHash: t.mediaHash } : {}),
      ...(t.offsetSec ? { timeOriginMs: Math.round(t.offsetSec * 1000) } : fallbackDesc?.timeOrigin !== undefined ? { timeOriginMs: fallbackDesc.timeOrigin } : {}),
    }
  }

  function buildTrackOpts(players: readonly import('@mumo/media-player').MediaPlayer[]) {
    const passthrough = eafPassthrough
    const storedDescs = passthrough?.media ?? []

    // Build lookup maps for matching loaded players to stored descriptors
    const playerByPath = new Map<string, import('@mumo/media-player').MediaPlayer>()
    const playerByHash = new Map<string, import('@mumo/media-player').MediaPlayer>()
    for (const p of players) {
      if (p.track?.path) playerByPath.set(p.track.path, p)
      if (p.track?.mediaHash) playerByHash.set(p.track.mediaHash, p)
    }
    // Parse stored hashes from passthrough properties for hash-based matching
    const storedHashByIndex = new Map<number, string>()
    for (const prop of passthrough?.properties ?? []) {
      const m = prop.name.match(/^mumo:mediaHash:(\d+)$/)
      if (m) storedHashByIndex.set(parseInt(m[1]!), prop.value)
    }

    const coveredPlayers = new Set<import('@mumo/media-player').MediaPlayer>()
    type Desc = { mediaUrl: string; mimeType?: string; mediaHash?: string; timeOriginMs?: number }
    const descriptors: Desc[] = []

    for (let i = 0; i < storedDescs.length; i++) {
      const desc = storedDescs[i]!
      // Match by explicit slot assignment, then path, then hash
      const assignedId = eafSlotAssignments.get(desc.mediaUrl)
      let player = (assignedId ? players.find(p => p.id === assignedId) : undefined)
        ?? playerByPath.get(desc.mediaUrl)
      if (!player) {
        const h = storedHashByIndex.get(i)
        if (h) player = playerByHash.get(h)
      }
      if (player) {
        coveredPlayers.add(player)
        descriptors.push(_trackDescriptor(player.track!, desc))
      } else {
        // File not loaded this session — preserve stored descriptor as-is
        descriptors.push({
          mediaUrl: desc.mediaUrl,
          ...(desc.mimeType ? { mimeType: desc.mimeType } : {}),
          ...(desc.timeOrigin !== undefined ? { timeOriginMs: desc.timeOrigin } : {}),
        })
      }
    }

    // Append any players not covered by stored descriptors (includes all players when no passthrough)
    for (const p of players) {
      if (coveredPlayers.has(p)) continue
      const t = p.track
      if (!t) continue
      const url = trackToMediaUrl(t)
      if (!url) continue
      descriptors.push(_trackDescriptor(t))
    }

    const [primary, ...additional] = descriptors
    const passthroughProps = (passthrough?.properties ?? []).filter(p => !p.name.startsWith('mumo:mediaHash:'))
    return {
      ...(primary?.mediaUrl ? { mediaUrl: primary.mediaUrl } : {}),
      ...(primary?.mimeType ? { mimeType: primary.mimeType } : {}),
      ...(primary?.mediaHash ? { mediaHash: primary.mediaHash } : {}),
      ...(primary?.timeOriginMs !== undefined ? { timeOriginMs: primary.timeOriginMs } : {}),
      ...(additional.length ? { additionalMedia: additional } : {}),
      ...(passthroughProps.length ? { headerProperties: passthroughProps } : {}),
    } satisfies import('./formats.js').ExportOpts
  }

  function saveEAF(includeTokenTiers: boolean) {
    const opts: import('./formats.js').ExportOpts = {
      language: documentLanguage,
      ...buildTrackOpts(multiPlayer.players),
      includeTokenTiers,
    }
    filecontroller.downloadExport('eaf', { docJSON: (editorRef?.liveDoc() ?? currentDoc).toJSON(), store, tokenStore, opts })
  }

  function loadEAF() { void filecontroller.openFile(['eaf', 'etf']) }

  async function commitEafImport(opts: {
    transcriptTierIds: Set<string>
    glossTierIds: Set<string>
    tokenTiers: import('@mumo/serialization').TokenTierEntry[]
    updatedProjectConfig?: import('@mumo/serialization').TokenizationOpts
  }) {
    const { eaf } = eafImportDlg
    if (!eaf) return
    if (opts.updatedProjectConfig) store.setTokenizerConfig({ punctuationChars: opts.updatedProjectConfig.punctuationChars })
    try {
      const result = eafTomumo(eaf, {
        transcriptTierIds: [...opts.transcriptTierIds],
        glossTierIds: [...opts.glossTierIds],
        ...(opts.tokenTiers.length > 0 ? { tokenTiers: opts.tokenTiers } : {}),
      })
      const newDoc = schema.nodeFromJSON(result.doc)
      store.loadJSON({ annotations: result.annotations, tiers: result.tiers, vocabularies: result.vocabularies, linguisticTypes: result.linguisticTypes, participants: result.participants })
      store.loadTokenTimes(result.tokenTimes ?? {})
      _applyNewDoc(newDoc, result.tokens)
      filecontroller.currentFormat = 'eaf'
      eafPassthrough = { media: eaf.media, properties: eaf.properties }
    } catch (err) {
      console.error('Failed to import EAF:', err)
      alert('Could not import EAF.')
    }
    eafImportDlg = { ...eafImportDlg, open: false }

    if (eaf.languages.length > 0) documentLanguage = eaf.languages[0]!.langId

    if (eaf.media.length > 0) linkedMediaOpen = true
  }

  function loadMMEAF() { void filecontroller.openFile(['mmeaf', 'mmetf']) }

  function openCollabDlg() { openMenu = null; collabDlgOpen = true }

  async function hostCollaboration(mode: CollabMode, opts: { serverUrl: string; signalingUrl: string }, identity: CollabIdentity) {
    collabDlgOpen = false
    collab.setUser(identity)
    try {
      await collab.start(mode, opts)
      // Editor is mounted by now; add yCursorPlugin now that awareness is live.
      if (collab.awareness) editorRef?.setAwareness(collab.awareness)
    } catch (err) {
      alert(String(err))
    }
  }

  function joinCollaboration(roomId: string, mode: CollabMode, opts: { serverUrl: string; signalingUrl: string }, identity: CollabIdentity) {
    // Persist identity across the navigation so initFromUrl can restore it.
    sessionStorage.setItem('mumo:collab-identity', JSON.stringify(identity))
    // Navigate to the room URL instead of mutating in-place — this matches the URL-join
    // path where initYXmlFragment is never called and the provider exists at page load,
    // which is the only reliable way to get a clean sync and working awareness.
    const url = new URL(location.href)
    url.searchParams.set('room', roomId)
    if (mode === 'webrtc') {
      url.searchParams.set('collab', 'webrtc')
      url.searchParams.set('signal', opts.signalingUrl)
      url.searchParams.delete('server')
    } else {
      url.searchParams.delete('collab')
      url.searchParams.delete('signal')
      if (opts.serverUrl !== collab.defaultCollabServer)
        url.searchParams.set('server', opts.serverUrl)
      else
        url.searchParams.delete('server')
    }
    location.replace(url.toString())
  }

  function saveMMEAF() {
    const opts = buildTrackOpts(multiPlayer.players)
    filecontroller.downloadExport('mmeaf', { docJSON: (editorRef?.liveDoc() ?? currentDoc).toJSON(), store, tokenStore, opts })
  }

  function _tileToUint8Array(tile: SpectrogramTile): Promise<Uint8Array> {
    const canvas = Object.assign(document.createElement('canvas'), { width: tile.width, height: tile.height })
    let rgba: Uint8ClampedArray
    if (tile.rawDb) {
      // Render rawDb with a reasonable fixed LUT for archiving
      const { SPEC_DB_FLOOR: F, SPEC_DB_RANGE: R } = { SPEC_DB_FLOOR: -160, SPEC_DB_RANGE: 160 }
      const dynRange = spectrogramSettings.dynamicRangeDb
      // Use simple linear greyscale for archival PNG (avoid inferno dependency here)
      rgba = new Uint8ClampedArray(tile.rawDb.length * 4)
      for (let i = 0; i < tile.rawDb.length; i++) {
        const dB = tile.rawDb[i]! / 255 * R + F
        const v  = Math.max(0, Math.min(255, Math.round((dB + 80) / dynRange * 255)))
        rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255
      }
    } else {
      rgba = new Uint8ClampedArray(tile.pixels!)
    }
    canvas.getContext('2d')!.putImageData(new ImageData(rgba as unknown as Uint8ClampedArray<ArrayBuffer>, tile.width, tile.height), 0, 0)
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (!blob) return reject(new Error('canvas.toBlob failed'))
        blob.arrayBuffer().then(buf => resolve(new Uint8Array(buf)))
      }, 'image/png')
    })
  }

  async function _pngBytesToTile(data: Uint8Array<ArrayBuffer>, timeStart: number, timeEnd: number): Promise<SpectrogramTile | null> {
    const bitmap = await createImageBitmap(new Blob([data], { type: 'image/png' }))
    const { width, height } = bitmap
    if (!width || !height) { bitmap.close(); return null }
    const canvas = Object.assign(document.createElement('canvas'), { width, height })
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
    const imageData = canvas.getContext('2d')!.getImageData(0, 0, width, height)
    bitmap.close()
    return { tileIndex: -1, pixels: imageData.data, width, height, timeStart, timeEnd }
  }

  function loadMumo() { void filecontroller.openFile(['mumo']) }

  async function _openMumoPath(filePath: string, seekFragId?: string, seekTime?: number) {
    try {
      if (!isDesktop(platform)) return
      const raw = await platform.readFileAsBytes(filePath)
      if (!raw) return
      const filename = filePath.split(/[/\\]/).pop() ?? filePath
      await _loadMumoBytes(new Uint8Array(raw), filePath)
      filecontroller.currentFilename = filename
      filecontroller.currentFilePath = filePath
      filecontroller.currentFormat   = 'mumo'
      currentView = 'editor'
      if (seekFragId) {
        const bm = store.getBookmark(seekFragId)
        if (bm) void multiPlayer.seek(bm.startSeconds)
      } else if (seekTime != null) {
        void multiPlayer.seek(seekTime)
      }
    } catch (err) {
      console.error('Failed to open mumo file:', err)
    }
  }

  async function saveMumoAs() {
    if (isElectron) {
      type EApi = { showSaveDialog(defaultName: string): Promise<string | null> }
      const eApi = (window as unknown as { electronAPI: EApi }).electronAPI
      const filePath = await eApi.showSaveDialog(filecontroller.currentFilename ?? 'transcript.mumo')
      if (!filePath) return
      filecontroller.currentFilePath = filePath
      filecontroller.currentFilename = filePath.split(/[/\\]/).pop() ?? filePath
    } else {
      const name = filecontroller.promptSaveAs()
      if (!name) return
    }
    await saveMumo()
  }

  async function saveMumo() {
    const doc = editorRef?.liveDoc() ?? currentDoc

    const docJSON = doc.toJSON() as ReturnType<typeof doc.toJSON>
    let untimedCount = 0
    doc.forEach(node => { if (node.type.name === 'utterance' && node.attrs['startTimeSeconds'] == null) untimedCount++ })
    if (untimedCount > 0) {
      const ok = confirm(
        `${untimedCount} utterance${untimedCount === 1 ? '' : 's'} ha${untimedCount === 1 ? 's' : 've'} no timing and will be lost when the file is reloaded.\n\nSave anyway?`
      )
      if (!ok) return
    }

    const [primaryPlayer, ...secondaryPlayers] = multiPlayer.players
    const primaryTrack = primaryPlayer?.track
    const additionalMedia = secondaryPlayers.flatMap(p => {
      const t = p.track
      if (!t?.path) return []
      return [{ mediaUrl: t.path, ...(t.offsetSec ? { timeOrigin: Math.round(t.offsetSec * 1000) } : {}) }]
    })
    const mmeaf = emitMMEAF(docJSON, store, {
      ...(primaryTrack?.path ? { mediaUrl: primaryTrack.path } : {}),
      ...(primaryTrack?.offsetSec ? { timeOrigin: Math.round(primaryTrack.offsetSec * 1000) } : {}),
      ...(additionalMedia.length ? { additionalMedia } : {}),
    }, tokenStore)

    const imageInputs: MumoImageInput[] = []
    const seen = new SvelteSet<string>()
    const pending: Promise<void>[] = []

    doc.descendants(node => {
      if (node.type !== schema.nodes['image']) return
      const id = node.attrs.id as string
      if (seen.has(id)) return
      seen.add(id)
      const url = imageRegistry.get(id)
      if (!url) return
      const prov = node.attrs.provenance as ImageProvenance | null
      pending.push(
        fetch(url).then(async r => {
          const buf = await r.arrayBuffer()
          const ct = r.headers.get('content-type') ?? 'image/png'
          const ext = ct.includes('jpeg') ? 'jpg' : ct.includes('webp') ? 'webp' : ct.includes('gif') ? 'gif' : 'png'
          imageInputs.push({
            filename: `${id}.${ext}`,
            data: new Uint8Array(buf) as Uint8Array<ArrayBuffer>,
            ...((node.attrs.label as string) ? { label: node.attrs.label as string } : {}),
            ...(prov?.kind === 'screenshot' ? { mediaTimeMs: prov.mediaTimeMs } : {}),
          })
        })
      )
    })

    await Promise.all(pending)

    // Collect spectrogram overviews
    const spectrogramInputs: MumoSpectrogramInput[] = []
    const overviews = timelineRef?.getSpectrogramOverviews() ?? new Map()
    await Promise.all([...overviews.entries()].map(async ([channelId, tile]) => {
      const chMatch = channelId.match(/:spectrogram:ch(\d+)$/)
      const channelIndex = chMatch ? parseInt(chMatch[1]!) : 0
      const playerId = channelId.replace(/:spectrogram:ch\d+$/, '')
      const player = multiPlayer.players.find(p => p.id === playerId)
      const data = await _tileToUint8Array(tile)
      spectrogramInputs.push({
        filename: `ch${channelIndex}_${playerId.replace(/[^a-z0-9]/gi, '_')}.png`,
        data,
        mediaPath: player?.track?.path ?? player?.state?.filename ?? '',
        mediaHash: player?.track?.mediaHash ?? '',
        params: {
          channelIndex,
          timeStart: tile.timeStart,
          timeEnd: tile.timeEnd,
          ...spectrogramSettings,
        },
      })
    }))

    const mediaPaths = multiPlayer.players.map(p => p.track?.path ?? '').filter(Boolean)

    // Collect track metadata + detection buffers
    const trackData = trackStore.toJSON()
    const trackSetsJSON = trackData.trackSets.length || trackData.coordinateFrames.length
      ? JSON.stringify(trackData)
      : undefined
    const trackBufferInputs: MumoTrackBufferInput[] = []
    for (const ts of trackStore.allTrackSets()) {
      for (const track of ts.tracks) {
        const f32 = trackStore.getBuffer(ts.id, track.id)
        if (!f32) continue
        trackBufferInputs.push({
          trackSetId: ts.id,
          trackId: track.id,
          data: new Uint8Array(f32.buffer.slice(f32.byteOffset, f32.byteOffset + f32.byteLength)),
        })
      }
    }

    const packed = packMumo({
      mmeaf, images: imageInputs, spectrograms: spectrogramInputs, mediaPaths,
      ...(trackSetsJSON !== undefined ? { trackSetsJSON } : {}),
      ...(trackBufferInputs.length ? { trackBuffers: trackBufferInputs } : {}),
    })
    if (isElectron && filecontroller.currentFilePath) {
      type EApi = { saveFile(path: string, data: Uint8Array): Promise<void> }
      const eApi = (window as unknown as { electronAPI: EApi }).electronAPI
      await eApi.saveFile(filecontroller.currentFilePath, packed)
    } else {
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([(packed.buffer as ArrayBuffer).slice(packed.byteOffset, packed.byteOffset + packed.byteLength)], { type: 'application/zip' })),
        download: filecontroller.currentFilename ?? 'transcript.mumo',
      })
      a.click()
      URL.revokeObjectURL(a.href)
    }
  }

  function saveETF() {
    filecontroller.downloadExport('etf', { docJSON: {}, store })
  }

  function saveMMETF() {
    filecontroller.downloadExport('mmetf', { docJSON: {}, store })
  }

  // --- Track importers ---

  function _trackImportDefaults(): { videoRef: string; frameRate: number; videoWidth: number; videoHeight: number } {
    const info  = multiPlayer.primary?.getVideoInfo()
    const state = multiPlayer.primary?.state
    const filename = state?.filename ?? (state as { path?: string } | null)?.path ?? 'video.mp4'
    const videoRef = filename.split(/[/\\]/).pop() ?? filename
    return {
      videoRef,
      frameRate:   info?.framerate   ?? 30,
      videoWidth:  info?.videoWidth  ?? 640,
      videoHeight: info?.videoHeight ?? 360,
    }
  }

  async function importTracksCoco() {
    const result = await platform.openTextFile(['json'], 'COCO JSON')
    if (!result) return
    try {
      const defaults = _trackImportDefaults()
      const name = result.name?.replace(/\.[^.]+$/, '') ?? 'tracks'
      const ts = importCoco(trackStore, { data: result.text, name, ...defaults })
      trackMappingDlgTrackSet = ts
    } catch (err) {
      console.error('COCO import failed:', err)
      alert('Could not import COCO JSON — see console for details.')
    }
  }

  async function importTracksMot() {
    const result = await platform.openTextFile(['csv', 'txt'], 'MOT CSV')
    if (!result) return
    try {
      const defaults = _trackImportDefaults()
      const name = result.name?.replace(/\.[^.]+$/, '') ?? 'tracks'
      const ts = importMot(trackStore, { csv: result.text, name, ...defaults })
      trackMappingDlgTrackSet = ts
    } catch (err) {
      console.error('MOT import failed:', err)
      alert('Could not import MOT CSV — see console for details.')
    }
  }

  function _confirmTrackMapping(rows: { trackId: string; tierName: string; participant: string }[]) {
    const ts = trackMappingDlgTrackSet
    trackMappingDlgTrackSet = null
    if (!ts) return
    for (const row of rows) {
      store.addTier(row.tierName, {
        trackRef: { trackSetId: ts.id, trackId: row.trackId },
      })
    }
    _syncTrackOverlay()
  }

  function _participantsFromDoc(): string[] {
    const seen = new SvelteSet<string>()
    for (const tier of store.allTiers()) {
      if (tier.participant) seen.add(tier.participant)
    }
    return [...seen].sort()
  }

  function loadJSON() { void filecontroller.openFile(['json']) }

  function openAny() { void filecontroller.openFile(undefined, 'mumo files') }
  function openTemplate() { void filecontroller.openTemplate() }

  function saveTemplate() {
    if (filecontroller.currentFormat === 'eaf') saveETF()
    else saveMMETF()
  }
</script>

<!-- Editor pane context menu -->
{#if editorCtxMenu.open}
  <button class="ctx-backdrop" onclick={closeEditorCtxMenu} aria-label="Close menu"></button>
  <div class="ctx-menu" style="left:{editorCtxMenu.x}px; top:{editorCtxMenu.y}px">
    <button onclick={closeEditorCtxMenu}>Close</button>
  </div>
{/if}

<!-- Context menu -->
{#if ctxMenu.open}
  <button class="ctx-backdrop" onclick={closeCtxMenu} aria-label="Close menu"></button>
  <div class="ctx-menu" use:clampToViewport style="left:{ctxMenu.x}px; top:{ctxMenu.y}px">
    {#if ctxIsAnnotationTier}
      <button onclick={ctxAddChildTier}>Add child tier…</button>
      <button onclick={ctxEditTier}>Edit tier…</button>
      <button onclick={ctxAssignLingType}>Assign linguistic type…</button>
      <button onclick={ctxAssignVocab}>Assign vocabulary…</button>
      {#if !store.getTier(ctxMenu.tierId)?.participant}
        <button onclick={ctxLinkToParticipant}>Link to participant…</button>
      {/if}
      {#if store.resolveTierConstraint(ctxMenu.tierId) === 'symbolic_association'}
        <button onclick={ctxToggleInlineGloss}>
          {store.getTier(ctxMenu.tierId)?.inlineGloss ? '✓' : ''} Show inline in transcript
        </button>
      {/if}
      <button onclick={ctxSegmentTier} disabled={mergedVadSegments.length === 0 && !mediaSignals.some(s => s.kind === 'waveform' && s.waveformBins)}>Segment tier…</button>
      <hr />
      <button class="danger" onclick={ctxDeleteTier}>Delete tier</button>
    {:else if ctxMenu.laneType === 'participant'}
      {@const _uttLane = timelineData.lanes.find(l => l.id === ctxMenu.laneId)}
      <span class="ctx-label">Tier: {_uttLane?.label ?? ctxMenu.laneId}</span>
      <button onclick={ctxEditUttTier}>Edit tier…</button>
      <button onclick={ctxAddParticipantSubTier}>Add child tier…</button>
      <button onclick={addTier}>New annotation tier…</button>
    {:else if ctxMenu.laneId.startsWith('tokens:') || tiers.some(t => t.id === ctxMenu.tierId && isTokenLtId(t.linguisticTypeId))}
      {@const _tokenTier = tiers.find(t => t.id === ctxMenu.tierId && isTokenLtId(t.linguisticTypeId))}
      {@const laneIsIncludedIn = _tokenTier?.linguisticTypeId === TOKEN_LT_II_ID}
      {@const laneIsTimeSub = !laneIsIncludedIn && timelineData.bars.some(b => b.laneId === ctxMenu.laneId && b.constraint === 'time_subdivision')}
      <span class="ctx-label">Token lane</span>
      {#if !laneIsTimeSub && !laneIsIncludedIn}
        <button onclick={ctxPromoteTokenTimes}>Promote to time subdivision</button>
      {/if}
      {#if laneIsTimeSub || laneIsIncludedIn}
        <button onclick={ctxDemoteTokenTimes}>Demote to symbolic subdivision</button>
      {/if}
      {#if !laneIsIncludedIn}
        <button onclick={() => ctxSetTokenTierIncludedIn(true)}>Promote to included in</button>
      {:else}
        <button onclick={() => ctxSetTokenTierIncludedIn(false)}>Demote to time subdivision</button>
      {/if}
      <button onclick={ctxAddWordSubTier}>Add child tier…</button>
    {:else}
      <span class="ctx-label">{ctxMenu.laneId.replace('tier:', 'Tier: ')}</span>
      <button onclick={addTier}>New annotation tier…</button>
    {/if}
  </div>
{/if}

{#if barCtxMenu.open}
  <button class="ctx-backdrop" onclick={closeBarCtxMenu} oncontextmenu={(e) => e.preventDefault()} aria-label="Close menu"></button>
  <div class="ctx-menu" use:clampToViewport style="left:{barCtxMenu.x}px; top:{barCtxMenu.y}px">
    {#if barCtxMenu.uttParticipant !== null}
      {@const others = participants.filter(p => p.label !== barCtxMenu.uttParticipant)}
      {#if others.length > 0}
        {#each others as p (p.label)}
          <button onclick={() => barCtxMoveToParticipant(p.label)}>Move to {p.label}</button>
        {/each}
        <hr />
      {/if}
    {/if}
    {#if barCtxMenu.constraint === 'symbolic_subdivision'}
      <button onclick={barCtxDivideHere}>Divide here</button>
    {/if}
    {#if barCtxMenu.splitTime !== null}
      <button onclick={barCtxSplitAtPlayhead}>Split at playhead</button>
    {/if}
    {#if barCtxMenu.constraint === 'time_subdivision' && !barCtxMenu.isEdgeBar}
      <button onclick={barCtxUnsetTime}>Unset time</button>
    {/if}
  </div>
{/if}

{#if editTierDlg.open}
  {@const _editTier = store.getTier(editTierDlg.tierId)}
  {#if _editTier}
    <EditTierDlg
      name={tierBaseName(_editTier)}
      participant={_editTier.participant ?? ''}
      {participants}
      validateName={(n, p) => tierNameError(n, p, editTierDlg.tierId)}
      onconfirm={confirmEditTier}
      onclose={() => editTierDlg = { ...editTierDlg, open: false }}
    />
  {/if}
{/if}

{#if addTierDlg.open}
  <AddTierDlg
    participant={addTierDlg.participant}
    parentLaneId={addTierDlg.parentLaneId}
    {lingTypes}
    {participants}
    validateName={tierNameError}
    onconfirm={confirmAddTier}
    onclose={() => addTierDlg = { ...addTierDlg, open: false }}
  />
{/if}

{#if addParticipantDlgOpen}
  <AddParticipantDlg
    onconfirm={confirmAddParticipant}
    onclose={() => addParticipantDlgOpen = false}
  />
{/if}

{#if editUttTierDlg.open}
  <EditUttTierDlg
    tierName={editUttTierDlg.tierName}
    participant={editUttTierDlg.participant}
    onconfirm={({ tierName, participant }) => confirmEditUttTier(tierName, participant)}
    onclose={() => editUttTierDlg = { ...editUttTierDlg, open: false }}
  />
{/if}

{#if participantsDlgOpen}
  <ParticipantsDlg
    {participants}
    {tiers}
    inUseLabels={participantInUse}
    onadd={handleParticipantAdd}
    onupdate={handleParticipantUpdate}
    onremove={handleParticipantRemove}
    oncopystructure={handleCopyStructure}
    onclose={() => participantsDlgOpen = false}
  />
{/if}

{#if uttTiersDlgOpen}
  <UttTiersDlg
    uttTiers={getUttTiersForDialog()}
    onupdate={handleUttTierUpdate}
    onclose={() => uttTiersDlgOpen = false}
  />
{/if}


{#if assignLingTypeDlg.open}
  <AssignLingTypeDlg
    tierId={assignLingTypeDlg.tierId}
    tierName={store.getTier(assignLingTypeDlg.tierId)?.name ?? ''}
    {lingTypes}
    onconfirm={confirmAssignLingType}
    onclose={() => assignLingTypeDlg = { ...assignLingTypeDlg, open: false }}
  />
{/if}

{#if linkParticipantDlg.open}
  {@const _linkTier = store.getTier(linkParticipantDlg.tierId)}
  {@const _linkParticipants = (() => {
    const seen = new SvelteSet<string>()
    ;(editorRef?.liveDoc() ?? currentDoc).forEach((n: Node) => {
      if (n.type.name === 'utterance' && n.attrs.participant) seen.add(n.attrs.participant as string)
    })
    return [...seen].sort()
  })()}
  <LinkParticipantDlg
    tierName={_linkTier?.name ?? ''}
    participants={_linkParticipants}
    onconfirm={confirmLinkParticipant}
    onclose={() => linkParticipantDlg = { ...linkParticipantDlg, open: false }}
  />
{/if}

{#if assignVocabDlg.open}
  <AssignVocabDlg
    tierId={assignVocabDlg.tierId}
    tierName={store.getTier(assignVocabDlg.tierId)?.name ?? ''}
    {vocabs}
    onconfirm={confirmAssignVocab}
    onclose={() => assignVocabDlg = { ...assignVocabDlg, open: false }}
  />
{/if}

{#if lingTypeDlgOpen}
  <LingTypeManagerDlg
    {store}
    {lingTypes}
    {vocabs}
    onclose={() => lingTypeDlgOpen = false}
  />
{/if}

{#if trackMappingDlgTrackSet}
  <TrackMappingDlg
    trackSet={trackMappingDlgTrackSet}
    participants={_participantsFromDoc()}
    onconfirm={_confirmTrackMapping}
    onclose={() => trackMappingDlgTrackSet = null}
  />
{/if}

{#if _trackVizDlgOpen}
  <TrackVizDlg
    trackSets={trackStore.allTrackSets()}
    hiddenTrackIds={_trackHiddenIds}
    vizOptions={_trackVizOptions}
    trackParticipants={(() => {
      const m = new SvelteMap<string, string>()
      for (const t of tiers) {
        if (t.trackRef && t.participant) m.set(t.trackRef.trackId, t.participant)
      }
      return m
    })()}
    onsetvisible={_setTrackVisible}
    onsetviz={_setVizOptions}
    onclose={() => _trackVizDlgOpen = false}
  />
{/if}

{#if patternSchemaDlgOpen}
  <PatternSchemaDlg
    {store}
    {patternSchemas}
    {vocabs}
    onClose={() => patternSchemaDlgOpen = false}
  />
{/if}

{#if vocabDlgOpen}
  <VocabManagerDlg
    {store}
    {vocabs}
    onclose={() => vocabDlgOpen = false}
  />
{/if}

{#if symbolDlgOpen}
  <SymbolManagerDlg
    defs={store.getSymbolDefs()}
    onconfirm={(defs) => { store.setSymbolDefs(defs); symbolDefs = defs; symbolDlgOpen = false }}
    onclose={() => symbolDlgOpen = false}
  />
{/if}

{#if collabDlgOpen}
  <CollabDlg
    serverUrl={COLLAB_SERVER}
    signalingUrl={SIGNAL_SERVER}
    capability={_collabCap}
    allowEmail={_collabAllowEmail}
    prefillName={_embedUser?.name ?? ''}
    prefillEmail={_embedUser?.email ?? ''}
    onhost={hostCollaboration}
    onjoin={joinCollaboration}
    onclose={() => collabDlgOpen = false}
  />
{/if}

{#if inviteDlgOpen && collabRoomId}
  <InviteDlg
    roomId={collabRoomId}
    inviteUrl={location.href}
    onclose={() => inviteDlgOpen = false}
  />
{/if}

{#if _joinIdentityDlgOpen}
  <JoinIdentityDlg
    allowEmail={_collabAllowEmail}
    onjoin={_onJoinIdentity}
  />
{/if}

{#if preferencesDlgOpen}
  <PreferencesDlg
    {transcriptFont}
    userName={myAuthorId}
    preservePitch={mediaPreservePitch}
    {keyBindings}
    onconfirm={(prefs: { transcriptFont: string; userName: string; preservePitch: boolean; keyBindings: KeyBindings }) => {
      setTranscriptFont(prefs.transcriptFont)
      const patch: Parameters<typeof _saveAppPrefs>[0] = {}
      if (prefs.userName !== undefined) {
        const name = prefs.userName.trim() || 'Anonymous'
        localStorage.setItem('mumolia:userName', name)
        myAuthorId = name
        patch.userName = name
      }
      if (prefs.preservePitch !== mediaPreservePitch) {
        mediaPreservePitch = prefs.preservePitch
        localStorage.setItem('mumolia:preservePitch', String(prefs.preservePitch))
        multiPlayer.setPreservePitch(prefs.preservePitch)
        patch.preservePitch = prefs.preservePitch
      }
      if (prefs.keyBindings) {
        keyBindings = prefs.keyBindings
        patch.keyBindings = prefs.keyBindings
      }
      if (Object.keys(patch).length) void _saveAppPrefs(patch)
      preferencesDlgOpen = false
    }}
    onclose={() => preferencesDlgOpen = false}
  />
{/if}

{#if editAnnPopover.open}
  <EditAnnPopover
    x={editAnnPopover.x}
    y={editAnnPopover.y}
    currentValue={editAnnPopover.value}
    vocabId={editAnnPopover.vocabId}
    {vocabs}
    oncommit={commitEditAnn}
    onclose={closeEditAnn}
  />
{/if}

{#if eafImportDlg.open && eafImportDlg.eaf}
  <EafImportDlg
    eaf={eafImportDlg.eaf}
    projectConfig={store.getTokenizerConfig()}
    onconfirm={commitEafImport}
    onclose={() => eafImportDlg = { ...eafImportDlg, open: false }}
  />
{/if}

{#if segmentTierDlg.open}
  <SegmentTierDlg
    tiers={segmentTierDlg.tiers}
    waveformChannels={segmentTierDlg.channels}
    mergedSegments={segmentTierDlg.mergedSegments}
    onconfirm={confirmSegmentTier}
    onclose={() => segmentTierDlg = { ...segmentTierDlg, open: false }}
  />
{/if}


<svelte:window onkeydown={(e) => {
  const _target      = e.target as HTMLElement
  const inPMEditor   = !!_target.closest?.('.ProseMirror')
  const inNativeInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(_target.tagName)

  // Undo/redo — not rebindable; always route to PM unless already inside PM or native input
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'y') && !e.altKey) {
    if (!inNativeInput && !inPMEditor) {
      e.preventDefault()
      if (e.key === 'z' && !e.shiftKey) undoManager.undo()
      else undoManager.redo()
    }
  }
  if (matchKey(e, 'save'))              { e.preventDefault(); void (filecontroller.currentFilename ? saveMumo() : saveMumoAs()) }
  if (matchKey(e, 'speed_up'))          { e.preventDefault(); stepSpeedUp() }
  if (matchKey(e, 'speed_down'))        { e.preventDefault(); stepSpeedDown() }
  if (matchKey(e, 'play_pause_global')) { e.preventDefault(); togglePlay(); return }
  if (matchKey(e, 'loop_play'))         { e.preventDefault(); toggleLoopPlay(); return }
  if (matchKey(e, 'stop_loop_play'))    { e.preventDefault(); multiPlayer.pause(); loopRegion = null; timelineRef?.setLoopRegion(null); multiPlayer.setLoop(null); return }
  if (matchKey(e, 'next_utterance'))    { e.preventDefault(); playNextUtt(); return }
  if (matchKey(e, 'prev_utterance'))    { e.preventDefault(); playCurrentOrPrevUtt(); return }
  if (matchKey(e, 'toggle_inspector'))  { e.preventDefault(); showInspector = !showInspector }
  if (matchKey(e, 'toggle_transcript')) { e.preventDefault(); showTranscript = !showTranscript }
  if (matchKey(e, 'toggle_glosses'))    { e.preventDefault(); showGlosses = !showGlosses; setGlossesVisible(showGlosses) }
  if (matchKey(e, 'toggle_utt_tiers')) { e.preventDefault(); showUttTierNames = !showUttTierNames; setUttTiersVisible(showUttTierNames) }
  if (e.key === 'Escape') {
    if (openMenu) { openMenu = null; return }
    if (slotFillMode) handleCancelSlotFill()
    if (editorCtxMenu.open || ctxMenu.open || barCtxMenu.open || _anyDlgOpen()) {
      const focused = document.activeElement as HTMLElement | null
      if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA')) {
        focused.blur()
        return
      }
      closeEditorCtxMenu()
      closeCtxMenu()
      closeBarCtxMenu()
      closeAnyOpenDlg()
      return
    }
    if (editorMode === 'edit' && (e.target as HTMLElement).isContentEditable) {
      setEditorMode('annotate')
    }
  }
  if (matchKey(e, 'create_textlet')) { e.preventDefault(); createTextletFromSelection() }
  const inText = _target.isContentEditable || inNativeInput
  if (matchKey(e, 'mode_edit') && editorMode === 'annotate' && (!inText || inPMEditor)) {
    e.preventDefault(); setEditorMode('edit')
  }
  if (matchKey(e, 'mode_annotate') && editorMode === 'edit' && (!inText || inPMEditor)) {
    e.preventDefault(); setEditorMode('annotate')
  }
  if (editorMode === 'annotate' && inPMEditor && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    _jiggleModeSwitch()
  }
  if (!inText) {
    if (editorMode === 'annotate' && selectedPatternId && !e.ctrlKey && !e.altKey && !e.metaKey
             && e.key >= '1' && e.key <= '9') {
      const slotIdx = parseInt(e.key) - 1
      const pattern = patterns.find(f => f.id === selectedPatternId)
      const schema = pattern ? patternSchemas.find(s => s.id === pattern.schemaId) : null
      const slotSchema = schema?.slots[slotIdx]
      if (slotSchema) {
        e.preventDefault()
        handleRequestSlotFill(selectedPatternId, slotSchema.id, slotSchema.anchorKind)
      }
    }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
      if (store.getAnnotation(selectedId)) {
        e.preventDefault()
        store.removeAnnotation(selectedId)
        selectedId = null
        timelineRef?.setSelectedId(null)
      }
    }
    else if (matchKey(e, 'play_pause'))   { e.preventDefault(); togglePlay() }
    else if (matchKey(e, 'toggle_loop'))  { e.preventDefault(); toggleLoop() }
    else if (matchKey(e, 'cycle_snap')) {
      e.preventDefault()
      const cycle: Array<'off' | SnapMode> = ['off', ...SNAP_MODES]
      const next = cycle[(cycle.indexOf(snapMode) + 1) % cycle.length]!
      snapMode = next
      snapChannelId = null
      timelineRef?.setSnapEnabled(next !== 'off')
      if (next !== 'off') timelineRef?.setSnapMode(next)
      timelineRef?.setSnapChannel(null)
    }
    else if (matchKey(e, 'play'))              { e.preventDefault(); multiPlayer.play() }
    else if (matchKey(e, 'pause'))             { e.preventDefault(); multiPlayer.pause() }
    else if (matchKey(e, 'skip_back'))         { e.preventDefault(); multiPlayer.pause(); skip(-2) }
    else if (matchKey(e, 'step_forward_1s'))   { e.preventDefault(); skip(1) }
    else if (matchKey(e, 'step_back_1s'))      { e.preventDefault(); skip(-1) }
    else if (matchKey(e, 'frame_forward'))     { e.preventDefault(); skip(1/30) }
    else if (matchKey(e, 'frame_back'))        { e.preventDefault(); skip(-1/30) }
    else if (matchKey(e, 'go_to_start'))       { e.preventDefault(); multiPlayer.seek(0) }
    else if (matchKey(e, 'go_to_end'))         { e.preventDefault(); multiPlayer.seek(mediaState?.duration ?? 0) }
    else {
      const combo = normalizeKeyEvent(e)
      if (combo) {
        const match = store.allPatternSchemas().find(s => s.hotkey === combo)
        if (match) { e.preventDefault(); selectedPatternId = store.addPattern(match.id).id; updateSlotRefStyles(selectedPatternId); _broadcastFrameId(selectedPatternId) }
      }
    }
  }
}} />

{#if hoverMenu && slotFillMode}
  <div
    class="hover-menu"
    role="group"
    style="left:{hoverMenu.x}px; top:{hoverMenu.y}px; transform:translateX(-50%) translateY(-100%)"
    onmouseenter={cancelHoverClose}
    onmouseleave={scheduleHoverClose}
  >
    {#each hoverMenu.items as item (item.id)}
      {@const elAnnId = item.el?.dataset.annId}
      <button
        onmouseenter={() => {
          if (elAnnId) injectHighlight(`.ann-span[data-ann-id="${CSS.escape(elAnnId)}"] { ${HOVER_UNDERLINE_CSS} }`)
          // token items: decoration already highlights; no extra CSS needed
        }}
        onmouseleave={() => clearHighlight()}
        onclick={() => { clearHighlight(); fillSlotFromHoverItem(item) }}
      >{item.label}</button>
    {/each}
  </div>
{/if}

{#if openMenu}
  <button class="mb-backdrop" onclick={() => openMenu = null} aria-label="Close menu"></button>
{/if}

{#if isElectron}
<CollectionView
  focusRequest={collectionFocusReq}
  bind:activeCollectionId
  onActiveCollectionChange={(name) => { activeCollectionName = name }}
  onOpenAtTime={(filePath, timeS) => {
    const eApi = (window as unknown as { electronAPI?: { collectionOpenAtTime?: (f: string, t: number) => Promise<void> } }).electronAPI
    if (eApi?.collectionOpenAtTime) void eApi.collectionOpenAtTime(filePath, timeS)
    else void _openMumoPath(filePath, undefined, timeS)
  }}
  onOpenBookmark={(filePath, bmId) => {
    const eApi = (window as unknown as { electronAPI?: { collectionOpenBookmark?: (f: string, id: string) => Promise<void> } }).electronAPI
    if (eApi?.collectionOpenBookmark) void eApi.collectionOpenBookmark(filePath, bmId)
    else void _openMumoPath(filePath, bmId)
  }}
  onClose={() => { currentView = 'editor' }}
  visible={currentView === 'collection'}
  appIconUrl={_appIconUrl}
/>
{/if}

<div class="app" style="display: {currentView === 'editor' ? '' : 'none'}">
  {#if true}<!-- editor always mounted -->
  {#if _showMenuBar}
  <header class="menubar" style="--inspector-w:{showInspector ? inspectorW : 0}px">
    <img src={_appIconUrl} class="mb-app-icon" alt="mumo" aria-hidden="true" />
    <div class="mb-wrap">
      <button class="mb-btn" class:mb-open={openMenu === 'file'}
        onclick={() => toggleMenu('file')} onmouseenter={() => menuHover('file')}
      >File</button>
      {#if openMenu === 'file'}
        <div class="mb-drop">
          <button onclick={() => {
            openMenu = null
            if (isElectron) { type EApi = { newWindow(): void }; (window as unknown as { electronAPI: EApi }).electronAPI.newWindow() }
            else window.open(location.href, '_blank')
          }}>New</button>
          {#if _showFileOpen}
          <div class="mb-sub-wrap">
            <button onclick={() => { openMenu = null; void openAny() }}>Open… <span class="mb-arrow">▶</span></button>
            <div class="mb-sub-drop">
              <button onclick={() => { openMenu = null; void loadMumo() }}>Open .mumo…</button>
              <button onclick={() => { openMenu = null; void loadMMEAF() }}>Open MMEAF…</button>
              <button onclick={() => { openMenu = null; void loadEAF() }}>Open EAF…</button>
              <button onclick={() => { openMenu = null; void loadJSON() }}>Open JSON…</button>
            </div>
          </div>
          {/if}
          <button onclick={() => { openMenu = null; void (filecontroller.currentFilePath ? saveMumo() : saveMumoAs()) }}>Save{filecontroller.currentFilename ? ` (${filecontroller.currentFilename})` : ''}</button>
          <div class="mb-sub-wrap">
            <button onclick={() => { openMenu = null; void saveMumoAs() }}>Save As… <span class="mb-arrow">▶</span></button>
            <div class="mb-sub-drop">
              <button onclick={() => { openMenu = null; void saveMumoAs() }}>Save .mumo As…</button>
              <button onclick={() => { openMenu = null; saveMMEAF() }}>Save MMEAF</button>
              <div class="mb-sub-wrap">
                <button onclick={() => { openMenu = null; saveEAF(false) }}>Save EAF <span class="mb-arrow">▶</span></button>
                <div class="mb-sub-drop">
                  <button onclick={() => { openMenu = null; saveEAF(true) }}>With token tiers</button>
                  <button onclick={() => { openMenu = null; saveEAF(false) }}>Without token tiers</button>
                </div>
              </div>
              <button onclick={() => { openMenu = null; saveJSON() }}>Save JSON</button>
            </div>
          </div>
          <div class="mb-sub-wrap">
            <button onclick={() => { openMenu = null }}>Export <span class="mb-arrow">▶</span></button>
            <div class="mb-sub-drop">
              <button onclick={() => { openMenu = null; exportVTT() }}>Export .vtt (subtitles)</button>
              <button onclick={() => { openMenu = null; exportTXT() }}>Export .txt (transcript)</button>
              <button onclick={() => { openMenu = null; exportCSV() }}>Export .csv (transcript + annotations)</button>
            </div>
          </div>
          {#if _showFileOpen}
          <hr class="mb-sep" />
          <button onclick={() => { openMenu = null; void openTemplate() }}>Open template…</button>
          {/if}
          <div class="mb-sub-wrap">
            <button onclick={() => { openMenu = null; saveTemplate() }}>Save template <span class="mb-arrow">▶</span></button>
            <div class="mb-sub-drop">
              <button onclick={() => { openMenu = null; saveETF() }}>Save ETF</button>
              <button onclick={() => { openMenu = null; saveMMETF() }}>Save MMETF</button>
            </div>
          </div>
          <hr class="mb-sep" />
          <button onclick={() => { openMenu = null; setLanguage() }}>Language: {documentLanguage}</button>
          <hr class="mb-sep" />
          <button onclick={() => { openMenu = null; linkedMediaOpen = true }}>Manage media…</button>
          <hr class="mb-sep" />
          {#if _showFileOpen}
          <div class="mb-sub-wrap">
            <button>Import video detections <span class="mb-arrow">▶</span></button>
            <div class="mb-sub-drop">
              <button onclick={() => { openMenu = null; void importTracksCoco() }}>COCO JSON…</button>
              <button onclick={() => { openMenu = null; void importTracksMot() }}>MOT CSV…</button>
            </div>
          </div>
          {/if}
          {#if _collabCap !== 'none'}
            <hr class="mb-sep" />
            <button onclick={openCollabDlg} disabled={collabStatus !== 'off'}>Collaborate…</button>
          {/if}
        </div>
      {/if}
    </div>


    <div class="mb-wrap">
      <button class="mb-btn" class:mb-open={openMenu === 'edit'}
        onclick={() => toggleMenu('edit')} onmouseenter={() => menuHover('edit')}
      >Edit</button>
      {#if openMenu === 'edit'}
        <div class="mb-drop">
          <button onclick={() => { openMenu = null; undoManager.undo() }}>Undo<span class="mb-kbd">{isMac ? '⌘Z' : 'Ctrl+Z'}</span></button>
          <button onclick={() => { openMenu = null; undoManager.redo() }}>Redo<span class="mb-kbd">{isMac ? '⌘⇧Z' : 'Ctrl+Y'}</span></button>
          <hr class="mb-sep" />
          <button onclick={() => { openMenu = null; insertVisualizationBlock() }}>Insert visualization<span class="mb-kbd">Alt+Shift+↵</span></button>
          <button onclick={() => { openMenu = null; insertCommentBlock() }}>Insert comment<span class="mb-kbd">Alt+/</span></button>
          <hr class="mb-sep" />
          <button onclick={() => { openMenu = null; participantsDlgOpen = true }}>Participants…</button>
          <button onclick={() => { openMenu = null; uttTiersDlgOpen = true }}>Tiers…</button>
          <hr class="mb-sep" />
          <button onclick={() => { openMenu = null; preferencesDlgOpen = true }}>Preferences…</button>
          <hr class="mb-sep" />
          <button onclick={() => { suggestMode = !suggestMode }}>
            <span class="mb-check" class:mb-checked={suggestMode}></span>Track changes
          </button>
        </div>
      {/if}
    </div>

    <div class="mb-wrap">
      <button class="mb-btn" class:mb-open={openMenu === 'selection'}
        onclick={() => toggleMenu('selection')} onmouseenter={() => menuHover('selection')}
      >Selection</button>
      {#if openMenu === 'selection'}
        <div class="mb-drop">
          <button onclick={() => { openMenu = null; createTextletFromSelection() }}>Create Textlet <span class="mb-kbd">Alt+A</span></button>
        </div>
      {/if}
    </div>

    <div class="mb-wrap">
      <button class="mb-btn" class:mb-open={openMenu === 'view'}
        onclick={() => toggleMenu('view')} onmouseenter={() => menuHover('view')}
      >View</button>
      {#if openMenu === 'view'}
        <div class="mb-drop">
          <button onclick={() => { showTranscript = !showTranscript }}>
            <span class="mb-check" class:mb-checked={showTranscript}></span>Transcript
          </button>
          <button onclick={() => { showInspector = !showInspector }}>
            <span class="mb-check" class:mb-checked={showInspector}></span>Tool panel
          </button>
          <button onclick={() => { showGlosses = !showGlosses; setGlossesVisible(showGlosses) }}>
            <span class="mb-check" class:mb-checked={showGlosses}></span>Show glosses
          </button>
          <button onclick={() => { showUttTierNames = !showUttTierNames; setUttTiersVisible(showUttTierNames) }}>
            <span class="mb-check" class:mb-checked={showUttTierNames}></span>Show utterance tier names
          </button>
          <div class="mb-sub-wrap">
            <button>
              <span class="mb-check" class:mb-checked={showLeftGuide && showSepGuide && showRightGuide}></span>Guides <span class="mb-arrow">▶</span>
            </button>
            <div class="mb-sub-drop">
              <button onclick={() => {
                const allOn = showLeftGuide && showSepGuide && showRightGuide
                showLeftGuide = !allOn; showSepGuide = !allOn; showRightGuide = !allOn
                showGuides = !allOn
              }}>
                <span class="mb-check" class:mb-checked={showLeftGuide && showSepGuide && showRightGuide}></span>Show all
              </button>
              <hr class="mb-sep" />
              <button onclick={() => { showLeftGuide = !showLeftGuide; showGuides = showLeftGuide || showSepGuide || showRightGuide }}>
                <span class="mb-check" class:mb-checked={showLeftGuide}></span>Left margin
              </button>
              <button onclick={() => { showSepGuide = !showSepGuide; showGuides = showLeftGuide || showSepGuide || showRightGuide }}>
                <span class="mb-check" class:mb-checked={showSepGuide}></span>Column separator
              </button>
              <button onclick={() => { showRightGuide = !showRightGuide; showGuides = showLeftGuide || showSepGuide || showRightGuide }}>
                <span class="mb-check" class:mb-checked={showRightGuide}></span>Right margin
              </button>
            </div>
          </div>
          <div class="mb-sub-wrap">
            <button>Timestamps <span class="mb-arrow">▶</span></button>
            <div class="mb-sub-drop">
              <button onclick={() => { showStartTime = !showStartTime }}>
                <span class="mb-check" class:mb-checked={showStartTime}></span>Start time
              </button>
              <button onclick={() => { showEndTime = !showEndTime }}>
                <span class="mb-check" class:mb-checked={showEndTime}></span>End time
              </button>
              <hr class="mb-sep" />
              <span class="mb-label">Decimals</span>
              {#each [0, 1, 2, 3] as n (n)}
                <button onclick={() => { timeDecimals = n; editorRef?.setTimeDecimals(n) }}>
                  <span class="mb-check" class:mb-checked={timeDecimals === n}></span>{n}
                </button>
              {/each}
            </div>
          </div>
          <hr class="mb-sep" />
          <div class="mb-sub-wrap">
            <button>Video <span class="mb-arrow">▶</span></button>
            <div class="mb-sub-drop">
              <button onclick={() => { showVideoInfo = !showVideoInfo; openMenu = null }}>
                <span class="mb-check" class:mb-checked={showVideoInfo}></span>Info
              </button>
            </div>
          </div>
          <hr class="mb-sep" />
          <button onclick={() => { openMenu = null; _trackVizDlgOpen = true }}>Track visualization…</button>
        </div>
      {/if}
    </div>

    <div class="mb-wrap">
      <button class="mb-btn" class:mb-open={openMenu === 'tier'}
        onclick={() => toggleMenu('tier')} onmouseenter={() => menuHover('tier')}
      >Tier</button>
      {#if openMenu === 'tier'}
        <div class="mb-drop">
          <button onclick={() => { openMenu = null; addTier() }}>New annotation tier…</button>
          <hr class="mb-sep" />
          <button
            disabled={tiers.filter(t => !t.parentTierId && !isTokenLtId(t.linguisticTypeId)).length === 0}
            onclick={() => { openMenu = null; _openSegmentTierDlg() }}
          >Segment tiers…</button>
        </div>
      {/if}
    </div>

    <div class="mb-wrap">
      <button class="mb-btn" class:mb-open={openMenu === 'type'}
        onclick={() => toggleMenu('type')} onmouseenter={() => menuHover('type')}
      >Type</button>
      {#if openMenu === 'type'}
        <div class="mb-drop">
          <button onclick={() => { openMenu = null; lingTypeDlgOpen = true }}>Linguistic types…</button>
          <button onclick={() => { openMenu = null; vocabDlgOpen = true }}>Vocabularies…</button>
          <hr class="mb-sep" />
          <button onclick={() => { openMenu = null; patternSchemaDlgOpen = true }}>Pattern schemas…</button>
          <hr class="mb-sep" />
          <button onclick={() => { openMenu = null; symbolDlgOpen = true }}>Transcription symbols…</button>
        </div>
      {/if}
    </div>

    {#if import.meta.env.DEV}
    <div class="mb-wrap">
      <button class="mb-btn" class:mb-open={openMenu === 'debug'}
        onclick={() => toggleMenu('debug')} onmouseenter={() => menuHover('debug')}
      >Debug</button>
      {#if openMenu === 'debug'}
        <div class="mb-drop">
          <button onclick={() => { showFps = !showFps; openMenu = null }}>
            <span class="mb-check" class:mb-checked={showFps}></span>Show Timeline FPS
          </button>
          <button onclick={() => { showDecodeDebug = !showDecodeDebug; openMenu = null }}>
            <span class="mb-check" class:mb-checked={showDecodeDebug}></span>Decode timing overlay
          </button>
          <button onclick={() => { showDebugTray = !showDebugTray; openMenu = null }}>
            <span class="mb-check" class:mb-checked={showDebugTray}></span>Debug tray
          </button>
        </div>
      {/if}
    </div>
    {/if}

    <div class="mb-wrap">
      <button class="mb-btn" class:mb-open={openMenu === 'help'}
        onclick={() => toggleMenu('help')} onmouseenter={() => menuHover('help')}
      >Help</button>
      {#if openMenu === 'help'}
        <div class="mb-drop mb-drop-right mb-drop-help">
          <span class="mb-help-section">Playback</span>
          <div class="mb-help-row"><kbd>Space</kbd><span>Play / pause</span></div>
          <div class="mb-help-row"><kbd>Ctrl+Space</kbd><span>Play / pause (works while editing)</span></div>
          <div class="mb-help-row"><kbd>Ctrl+Shift+Space</kbd><span>Loop current utterance / stop loop play</span></div>
          <div class="mb-help-row"><kbd>Alt+→</kbd><span>Next utterance</span></div>
          <div class="mb-help-row"><kbd>Alt+←</kbd><span>Restart current utterance (tap twice for previous)</span></div>
          <div class="mb-help-row"><kbd>L</kbd><span>Play</span></div>
          <div class="mb-help-row"><kbd>K</kbd><span>Pause</span></div>
          <div class="mb-help-row"><kbd>J</kbd><span>Pause &amp; skip back 2s</span></div>
          <div class="mb-help-row"><kbd>←</kbd> <kbd>→</kbd><span>±1 pattern (1/30s)</span></div>
          <div class="mb-help-row"><kbd>Shift+←</kbd> <kbd>Shift+→</kbd><span>±1 second</span></div>
          <div class="mb-help-row"><kbd>Home</kbd><span>Go to start</span></div>
          <div class="mb-help-row"><kbd>End</kbd><span>Go to end</span></div>
          <div class="mb-help-row"><kbd>\</kbd><span>Arm / disarm loop on selection or bar</span></div>
          <div class="mb-help-row"><kbd>Ctrl+\</kbd><span>Stop looping play (pause + disarm)</span></div>
          <div class="mb-help-row"><kbd>S</kbd><span>Cycle snap mode (all / vad / waveform / spectrogram / off)</span></div>
          <hr class="mb-sep" />
          <span class="mb-help-section">Editing</span>
          <div class="mb-help-row"><kbd>Esc</kbd><span>Enter ANNOTATE mode (pattern hotkeys active)</span></div>
          <div class="mb-help-row"><kbd>e</kbd><span>Return to EDIT mode</span></div>
          <hr class="mb-sep" />
          <span class="mb-help-section">Patterns</span>
          <div class="mb-help-row"><span class="mb-help-note">Assign per-schema hotkeys in Type → Pattern schemas</span></div>
          <hr class="mb-sep" />
          <span class="mb-help-section">Note</span>
          <div class="mb-help-row"><span class="mb-help-note">Playback hotkeys inactive when transcript editor is focused</span></div>
        </div>
      {/if}
    </div>

    <div class="mb-spacer"></div>
    {#if isElectron}
    <button class="mb-collection-btn" onclick={() => { openMenu = null; currentView = 'collection' }}>
      Collections →
    </button>
    {/if}

    {#if collabStatus !== 'off'}
      <div class="mb-wrap mb-collab" class:mb-collab-live={collabStatus === 'connected'}>
        <span class="mb-collab-dot" class:mb-collab-dot-on={collabStatus === 'connected'}></span>
        <span class="mb-collab-label">
          {collabMode === 'webrtc' ? 'P2P' : 'Server'} · {collabStatus === 'connected' ? 'Live' : collabStatus}
        </span>
        {#if collabRoomId}
          <button class="mb-collab-invite" onclick={() => inviteDlgOpen = true}>
            Invite
          </button>
        {/if}
        <button class="mb-collab-stop icon-btn" onclick={() => collab.stop()} title="Stop collaboration">✕</button>
      </div>
    {/if}
  </header>
  {/if}

  <div class="main-area">
    {#if _showMediaPane && mediaState}
      <div class="media-pane" style="width:{mediaPaneW}px">
        <div class="media-pane-inner">
          <VideoTileLayout {multiPlayer} {showVideoInfo} {showDecodeDebug} bind:speed={mediaSpeed} />
        </div>
        {#if _hasVizTracks}
          <label class="viz-toggle-overlay" title="Toggle track visualizations">
            <input type="checkbox" checked={_trackVizEnabled} onchange={_toggleTrackViz} />
            viz
          </label>
        {/if}
        <div class="media-pane-resize" role="separator" aria-orientation="vertical" onpointerdown={startMediaPaneResize}></div>
      </div>
    {/if}

    <LinkedMediaDlg
      open={linkedMediaOpen}
      entries={mediaEntries}
      onClose={() => linkedMediaOpen = false}
      onLink={() => void linkMediaFile()}
      onLoad={async (url) => {
        const stored = eafPassthrough?.media.find(d => d.mediaUrl === url)
        const offsetSec = (stored?.timeOrigin ?? 0) / 1000
        const result = await platform.openBinaryFile(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'], 'Media files')
        if (!result) return
        const player = await multiPlayer.addTrack(result.file, result.path, offsetSec)
        eafSlotAssignments = new Map(eafSlotAssignments).set(url, player.id)
      }}
      onRemove={(id) => {
        if (multiPlayer.players.some(p => p.id === id)) {
          multiPlayer.removeTrack(id)
          const updated = new Map(eafSlotAssignments)
          for (const [url, pid] of updated) if (pid === id) updated.delete(url)
          eafSlotAssignments = updated
        } else if (eafPassthrough) {
          eafPassthrough = { ...eafPassthrough, media: eafPassthrough.media.filter(d => d.mediaUrl !== id) }
        }
      }}
      onOffsetChange={(id, offsetSec) => {
        if (multiPlayer.players.some(p => p.id === id)) {
          multiPlayer.updateTrackOffset(id, offsetSec)
          mediaSignals = mediaSignals.map(s =>
            s.id.startsWith(id + ':') ? { ...s, timeOffset: offsetSec } : s
          )
          _flushSignals()
        } else if (eafPassthrough) {
          eafPassthrough = {
            ...eafPassthrough,
            media: eafPassthrough.media.map(d =>
              d.mediaUrl === id ? { ...d, timeOrigin: Math.round(offsetSec * 1000) } : d
            ),
          }
        }
      }}
    />
    {#if showTranscript}
    <div
      class="editor-pane"
      class:slot-fill-active={slotFillMode !== null}
      role="region"
      aria-label="Editor"
      bind:this={editorPaneEl}
      onmousemove={handleEditorMouseMove}
      onmouseleave={() => setRowHighlight(null)}
      oncontextmenu={handleEditorContextMenu}
    >
      <div class="editor-col-headers" class:hide-times={!showStartTime && !showEndTime} class:hide-start={!showStartTime} class:hide-end={!showEndTime}>
        <span class="ech ech-linenum" aria-hidden="true">#</span>
        <span class="ech ech-time ech-time-start" aria-hidden="true">start</span>
        <span class="ech ech-time ech-time-end" aria-hidden="true">end</span>
        <span class="ech ech-participant" aria-hidden="true">participant</span>
        <div class="ech ech-content">
          <TranscriptToolbar
            getView={() => editorRef?.getView()}
            onInsertVisualization={insertVisualizationBlock}
            editable={editorMode === 'edit'}
            fontSizePx={transcriptFontSizePx}
            onFontSizeChange={(px) => { transcriptFontSizePx = px }}
            {boldActive}
            {italicActive}
            {strikeActive}
            {underlineActive}
            {currentFont}
            defaultFont={transcriptFont}
            onDefaultFontChange={setTranscriptFont}
            {...(_defaultFonts.length > 0 ? { defaultFonts: _defaultFonts } : {})}
            {...(_systemFonts.length  > 0 ? { systemFonts:  _systemFonts  } : {})}
            {...(symbolDefs.length > 0 ? { symbolDefs } : {})}
          />
        </div>
        <div class="ech-mode-group">
          {#if loopRegion && _isPlaying}
            <span class="ech-loop-tip">⇧Space to stop loop</span>
          {/if}
          <div class="ech-mode-switch" class:ech-mode-jiggle={_modeJiggle} onanimationend={() => { _modeJiggle = false }} title="Esc → CODE  •  e → EDIT">
            <span class="ech-mode-label">text mode:</span>
            <div class="ech-mode-buttons" class:ech-mode-flash={_modeFlash} onanimationend={() => { _modeFlash = false }}>
              <button
                class="ech-mode-opt" class:ech-mode-active={editorMode === 'annotate'}
                onclick={() => setEditorMode('annotate')}
              >code</button>
              <button
                class="ech-mode-opt" class:ech-mode-active={editorMode === 'edit'}
                onclick={() => setEditorMode('edit')}
              ><u>e</u>dit</button>
            </div>
          </div>
        </div>
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="editor-scroll" bind:this={editorScrollEl} onmouseup={handleEditorPaneMouseUp} style="font-size:{transcriptFontSizePx}px; padding-right:{gutterWidth}px">
        <TranscriptEditor
          bind:this={editorRef}
          {yXmlFragment}
          {undoManager}
          {store}
          {tokenStore}
          {timeKeeper}
          onDocChange={handleDocChange}
          onSeek={handleSeek}
          showTimes={showStartTime || showEndTime}
          showStart={showStartTime}
          showEnd={showEndTime}
          editable={editorMode === 'edit'}
          getTokenTime={(id) => { const t = store.getTokenTime(id); return (t?.start != null && t?.end != null) ? { start: t.start, end: t.end } : undefined }}
          onEscapeKey={() => setEditorMode('annotate')}
          tokenClickMode={!!slotFillMode}
          ontokenhover={handleTokenHover}
          ontokenclick={handleTokenClick}
          awareness={_awareness ?? undefined}
          onOverlapChange={() => { overlapOverlayPlugin.redraw(); patternOverlayPlugin.redraw() }}
          invalidGapIds={() => invalidGapIds}
          {imageRegistry}
          {onImageActivate}
          onImageLoad={() => { overlapOverlayPlugin.redraw(); patternOverlayPlugin.redraw() }}
          {onVizContextMenu}
          {transcriptFont}
          onUpdate={(fmt: FormattingState) => {
            blockHighlightPlugin.redraw()
            boldActive      = fmt.bold
            italicActive    = fmt.italic
            strikeActive    = fmt.strike
            underlineActive = fmt.underline
            currentFont     = fmt.fontFamily
          }}
          getSymbolDefs={() => store.getSymbolDefs()}
          onActiveUtteranceChange={(id) => { timelineRef?.setSelectedId(id) }}
          onUndoRedo={_syncSuggestionsFromDoc}
          {suggestMode}
          onSuggestEdit={_handleSuggestEdit}
          onSuggestRemove={_handleSuggestRemove}
          onSuggestParticipant={(uttId, participant) =>
            store.addSuggestion({ type: 'utt:set-participant', uttId, participant }, 'user:local')}
          {showGuides}
          {showLeftGuide}
          {showSepGuide}
          {showRightGuide}
        />
        <GutterOverlay
          bind:this={gutterRef}
          {store}
          {patterns}
          {patternSchemas}
          doc={currentDoc}
          editorPane={editorScrollEl}
          {tokenStore}
          {selectedPatternId}
          {slotFillMode}
          peerPatternSelections={_peerPatternSels}
          onSelectPattern={(id) => {
            selectedPatternId = id
            _broadcastFrameId(id)
            updateSlotRefStyles(id)
          }}
          {annotations}
          onWidthChange={(w) => { gutterWidth = w }}
          onFillWithPattern={handleFillWithPattern}
          onHoverPattern={handleHoverFrame}
          onHoverNoteItem={handleHoverNoteItem}
        />
        <TranscriptOverlay
          getView={() => editorRef?.getView()}
          editorPane={editorScrollEl}
          plugins={overlayPlugins}
        />
      </div>
      <SuggestionOverlay {store} editorContainer={editorScrollEl ?? undefined} />
    </div>
    {/if}

    {#if _tlSugCard !== null}
      {@const card = _tlSugCard}
      {@const tlSugNote = store.getSuggestion(_tlSugCard.suggestionId)?.note}
      <div
        class="tl-sug-card"
        style="left:{card.x - 16}px; top:{card.y}px; transform: translateY(calc(-100% - 8px))"
        role="menu"
        tabindex="-1"
        onmouseenter={_tlSugCancelHide}
        onmouseleave={_tlSugScheduleHide}
        onfocus={() => {}}
      >
        <div class="tl-sug-row">
          <button class="sug-btn sug-x" title="Reject"
            onclick={() => { store.rejectSuggestion(card.suggestionId); _tlSugCard = null }}>✗</button>
          <button class="sug-btn sug-check" title="Accept"
            onclick={() => { store.acceptSuggestion(card.suggestionId); _tlSugCard = null }}>✓</button>
          {#if tlSugNote}<span class="sug-comment">{tlSugNote}</span>{/if}
        </div>
      </div>
    {/if}

    {#if _showInspector}
    {#if showTranscript}
    <div class="inspector-resize-handle"
      class:inspector-collapsed={!showInspector}
      role="separator"
      aria-orientation="vertical"
      onpointerdown={showInspector ? startInspectorResize : null}
      ondblclick={() => showInspector = !showInspector}
    ></div>
    {/if}
    {#if showInspector}
    <div class="inspector-outer" style="{showTranscript ? `width:${inspectorW}px` : 'flex:1'}">
      <Panel
        {store}
        {tokenStore}
        {patternSchemas}
        {patterns}
        {vocabs}
        {participants}
        annotations={annotations}
        doc={timelineDoc}
        {slotFillMode}
        {selectedPatternId}
        {editorMode}
        {suggestMode}
        {bookmarks}
        playhead={playhead}
        {tlSelection}
        {myAuthorId}
        onSelectPattern={(id) => { selectedPatternId = id; _broadcastFrameId(id); updateSlotRefStyles(id) }}
        onRequestSlotFill={handleRequestSlotFill}
        onCancelSlotFill={handleCancelSlotFill}
        onFillWithPattern={handleFillWithPattern}
        onDeleteTextlet={handleDeleteTextlet}
        onHoverTextletMark={(id) => setHoveredMarkId(id)}
        onHoverSlot={handleHoverSlot}
        onHoverPattern={handleHoverFrame}
        onSeek={handleSeek}
        onCreateBookmark={(start, end, label, note, code) => store.addBookmark(label, start, end, { note, code })}
        onUpdateBookmark={(id, patch) => store.updateBookmark(id, patch)}
        onDeleteBookmark={(id) => store.removeBookmark(id)}
        {...(isElectron && activeCollectionId !== null ? {
          activeCollectionName,
          onAddToCollection: (bm: import('@mumo/core').Bookmark) => {
            const eApi = (window as unknown as { electronAPI?: { collectionSetsAddItem?: (id: number, item: unknown) => Promise<void> } }).electronAPI
            if (eApi?.collectionSetsAddItem && activeCollectionId !== null) {
              void eApi.collectionSetsAddItem(activeCollectionId, {
                kind: 'bookmark',
                docPath: filecontroller.currentFilename ?? '',
                refId: bm.id,
                startS: bm.startSeconds,
                endS: bm.endSeconds,
                label: bm.label,
              })
            }
          },
        } : {})}
      />
    </div>
    {/if}
    {/if}
  </div>

  {#if _showTimeline}
  <div class="timeline-resize-handle" role="separator" aria-orientation="horizontal" onpointerdown={startTimelineResize}></div>
  <div class="timeline-pane" style="height:{timelinePaneH}px">
    <Timeline
      bind:this={timelineRef}
      {timeKeeper}
      isPlaying={_isPlaying}
      onSeek={handleSeek}
      onSelectBar={handleSelectBar}
      onSelection={handleSelection}
      onSelectionChange={(sel) => {
        tlSelection = sel
        if (sel) {
          blockHighlightPlugin.setHighlightIds(_blockIdsForTimeRange(sel.start, sel.end))
          if (_focusedTrackRef) {
            const ts = trackStore.getTrackSet(_focusedTrackRef.trackSetId)
            if (ts) {
              trackOverlay.setTimeRange(
                Math.floor(sel.start * ts.frameRate),
                Math.ceil(sel.end   * ts.frameRate),
              )
            }
          }
        } else {
          blockHighlightPlugin.setHighlightIds([])
          trackOverlay.clearTimeRange()
        }
      }}
      onLaneClick={handleLaneClick}
      onLaneContextMenu={handleLaneContextMenu}
      onRenameLane={handleRenameLane}
      onBarDblClick={handleBarDblClick}
      onBarSuggestionHover={handleBarSuggestionHover}
      onCommitBars={handleCommitBars}
      onNudgeEdge={handleNudgeEdge}
      onBarContextMenu={handleBarContextMenu}
      onBarCtrlClick={(barId, t) => splitAnnotation(barId, t)}
      onSelectionActive={(v) => timelineSelectionActive = v}
      onContentHeight={_onTimelineContentHeight}
      {...(showFps ? { onFps: (fps: number) => { timelineFps = fps } } : {})}
      onViewChange={(pps) => { tlPxPerSec = pps }}
      onHzChange={(hz) => { tlHz = hz }}
      {...(_snapPlugins !== undefined ? { snapPlugins: _snapPlugins } : {})}
    >
      {#snippet mediaContent()}
        <div class="tl-panel-tools">
          <div class="tl-timecode-full">
            <span bind:this={timecodeTimeEl} class="tl-timecode-frame tl-timecode-copyable"
              role="button" tabindex="0"
              title="Double-click to copy"
              ondblclick={() => { if (timecodeTimeEl?.textContent) { void navigator.clipboard.writeText(timecodeTimeEl.textContent); _showCopied(timecodeTimeEl) } }}
            >{_formatTimecodeFull(0)}</span
            ><span class="tl-timecode-sep">&ensp;</span
            ><span bind:this={timecodeFrameNumEl} class="tl-timecode-frame tl-timecode-copyable"
              role="button" tabindex="0"
              title="Double-click to copy"
              ondblclick={() => { if (timecodeFrameNumEl?.textContent) { void navigator.clipboard.writeText(timecodeFrameNumEl.textContent); _showCopied(timecodeFrameNumEl) } }}
            >f0</span>
          </div>
          <div class="tl-tool-row">
            <div class="tl-snap-wrap"
              role="presentation"
              onmouseenter={(e) => { if (snapMode !== 'off') _openSnapMenu(e.currentTarget as HTMLElement) }}
              onmouseleave={_scheduleSnapMenuClose}>
              <button class="tl-tool-btn" class:active={snapMode !== 'off'}
                onclick={(e) => {
                  snapMenuPos = null
                  const next = snapMode === 'off' ? 'all' : 'off'
                  snapMode = next
                  snapChannelId = null
                  timelineRef?.setSnapEnabled(next !== 'off')
                  timelineRef?.setSnapChannel(null)
                  if (next !== 'off') _openSnapMenu(e.currentTarget as HTMLElement)
                }}
                title="Snap to audio onsets (S) — hover for mode"><img src={magnetIconUrl} width="16" height="16" alt="Snap" aria-hidden="true" draggable="false"></button>
            </div>
            <button class="tl-tool-btn" class:active={!!loopRegion} onclick={toggleLoop} title="Loop selection or bar (\)">⟳</button>
            <button class="tl-tool-btn" title="Display settings"
              onclick={(e) => {
                if (tlSettingsOpen) { tlSettingsOpen = false; tlGearMenuPos = null; return }
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                tlGearMenuPos = { x: r.right + 4, y: r.top }
                tlSettingsOpen = true
                requestAnimationFrame(() => {
                  if (!_tlGearMenuEl || !tlGearMenuPos) return
                  const over = tlGearMenuPos.y + _tlGearMenuEl.offsetHeight - (window.innerHeight - 8)
                  if (over > 0) tlGearMenuPos = { ...tlGearMenuPos, y: tlGearMenuPos.y - over }
                })
              }}>⚙</button>
            <button class="tl-tool-btn" onclick={addTier} title="New annotation tier">+</button>
          </div>
        </div>
      {/snippet}
    </Timeline>
  </div>
  {/if}

  <footer class="status-bar">
    <span class="status-logo"><span class="sl-bracket">[</span><span class="sl-m">m</span><span class="sl-u sl-oblique">u</span><span class="sl-m sl-oblique">m</span><span class="sl-o sl-oblique">o</span><span class="sl-bracket">]</span></span>
    {#if snapChannelId !== null}
      {@const snapCh = mediaSignals.find(s => s.id === snapChannelId)}
      <span class="status-snap" class:status-snap-ann={annotationSnapMode !== 'all'}>{snapCh?.label ?? snapChannelId}{annotationSnapMode === 'same-lane' ? '·same' : annotationSnapMode === 'none' ? '·∅' : ''}</span>
    {:else}
      <span class="status-snap" class:status-snap-off={snapMode === 'off'} class:status-snap-ann={annotationSnapMode !== 'all'}>snap:{snapMode}{annotationSnapMode === 'same-lane' ? '·same' : annotationSnapMode === 'none' ? '·∅' : ''}</span>
    {/if}
    {#if slotFillMode}
      {@const schema_ = patternSchemas.find(s => patterns.find(f => f.id === slotFillMode?.patternId)?.schemaId === s.id)}
      {@const slot_ = schema_?.slots.find(s => s.id === slotFillMode?.slotSchemaId)}
      <span class="status-item status-fill" class:status-fill-error={!!_slotFillError}>
        {#if _slotFillError}
          {_slotFillError}
        {:else}
          Filling <strong>{slot_?.label ?? slot_?.name ?? '…'}</strong>
          ({slotFillMode.anchorKind})
          — hover token/textlet · click line number for utterance · click timeline bar · Esc to cancel
        {/if}
      </span>
    {:else if timelineSelectionActive}
      <span class="status-item status-selection">
        {#if tlSelection}<span
            class="tl-timecode-copyable status-ms-copy"
            role="button" tabindex="0"
            title="Double-click to copy"
            ondblclick={(e) => { const v = (e.currentTarget as HTMLElement).textContent ?? ''; void navigator.clipboard.writeText(v); _showCopied(e.currentTarget as HTMLElement) }}
          >{((tlSelection.end - tlSelection.start) * 1000).toFixed(0)} ms</span> · {/if}Enter to create · Esc to cancel
      </span>
    {/if}
    {#if spectrogramProgress !== null}
      {@const pct = spectrogramProgress.total > 0 ? Math.round(spectrogramProgress.done / spectrogramProgress.total * 100) : null}
      <span class="status-spec">
        <span class="status-spec-label">Computing spectrogram…</span>
        <span class="status-spec-track">
          {#if pct !== null}
            <span class="status-spec-fill" style="width:{pct}%"></span>
          {:else}
            <span class="status-spec-indeterminate"></span>
          {/if}
        </span>
        {#if pct !== null}<span class="status-spec-pct">{pct}%</span>{/if}
      </span>
    {/if}
    {#if showFps}
      <span class="status-fps">{timelineFps} fps</span>
    {/if}
    {#if loopRegion && _isPlaying}
      <span class="status-loop-tip">Ctrl+⇧Space to stop loop</span>
    {/if}
    <span class="status-right">
      {#if tlHz !== null}
        <span class="status-hz">{Math.round(tlHz)} Hz</span>
      {/if}
      <span class="status-zoom">{tlPxPerSec.toFixed(1)} px/s</span>
      <button
        class="status-warn-btn"
        class:status-warn-active={fileWarnings.length > 0}
        onclick={() => showWarnings = !showWarnings}
        title="{fileWarnings.length} issue{fileWarnings.length !== 1 ? 's' : ''}"
      >⚠ {fileWarnings.length}</button>
    </span>
  </footer>

  {#if specModalOpen}
    <button class="spec-modal-backdrop" onclick={() => specModalOpen = false} aria-label="Close"></button>
    <div class="spec-modal" role="dialog" aria-modal="true">
      <div class="spec-modal-header">
        <span>Spectrogram settings</span>
        <button class="spec-modal-close" aria-label="Close" onclick={() => specModalOpen = false}>✕</button>
      </div>
      <div class="spec-modal-body">
        <div class="spec-modal-section-label">Presets</div>
        {#each SPEC_PRESETS as p (p.label)}
          {@const active = p.windowLengthSec === spectrogramSettings.windowLengthSec && p.hopSec === spectrogramSettings.hopSec && p.maxFreqHz === spectrogramSettings.maxFreqHz}
          <button class="spec-modal-preset" class:spec-modal-preset-active={active}
            onclick={() => applySpectrogramSettings({ ...p })}>
            {p.label}
          </button>
        {/each}
        <div class="spec-modal-divider"></div>
        <div class="spec-modal-section-label">Custom</div>

        {#snippet numCombo(id: string, label: string, unit: string, displayVal: string, opts: string[], onval: (v: string) => void)}
          <div class="spec-modal-row">
            <label class="spec-modal-label" for={id}>{label}{unit ? ` (${unit})` : ''}</label>
            <div class="spec-combo-wrap">
              <input id={id} class="spec-combo-input" type="text" value={displayVal}
                onchange={(e) => onval(e.currentTarget.value)}
                onfocus={(e) => (e.currentTarget as HTMLInputElement).select()} />
              <div class="spec-combo-arrow">
                <select class="spec-combo-select" aria-label={label}
                  onchange={(e) => { onval(e.currentTarget.value); e.currentTarget.value = '' }}>
                  <option value="" disabled selected></option>
                  {#each opts as o (o)}<option value={o}>{o}</option>{/each}
                </select>
                <span class="spec-combo-chevron" aria-hidden="true">▾</span>
              </div>
            </div>
          </div>
        {/snippet}

        {@render numCombo('spec-window-length', 'Window', 'ms',
          String(spectrogramSettings.windowLengthSec * 1000),
          ['5', '10', '15', '20', '25', '50'],
          v => { const n = parseFloat(v); if (n > 0) applySpectrogramSettings({ ...spectrogramSettings, windowLengthSec: n / 1000 }) }
        )}
        {@render numCombo('spec-time-step', 'Hop', 'ms',
          String(spectrogramSettings.hopSec * 1000),
          ['1', '2', '2.5', '5', '10', '20'],
          v => { const n = parseFloat(v); if (n > 0) applySpectrogramSettings({ ...spectrogramSettings, hopSec: n / 1000 }) }
        )}
        {@render numCombo('spec-max-freq', 'Max freq', 'Hz',
          String(spectrogramSettings.maxFreqHz),
          ['4000', '5000', '5500', '8000', '12000', '22050'],
          v => { const n = parseInt(v); if (n > 0) applySpectrogramSettings({ ...spectrogramSettings, maxFreqHz: n }) }
        )}
        {@render numCombo('spec-dynamic-range', 'Dyn. range', 'dB',
          String(spectrogramSettings.dynamicRangeDb),
          ['40', '50', '60', '70', '80', '90', '100'],
          v => { const n = parseInt(v); if (n > 0) applySpectrogramSettings({ ...spectrogramSettings, dynamicRangeDb: n }) }
        )}
        {@render numCombo('spec-gamma', 'Gamma', '',
          String(spectrogramSettings.gamma),
          ['1.0', '1.2', '1.5', '1.7', '2.0', '2.5'],
          v => { const n = parseFloat(v); if (n > 0) applySpectrogramSettings({ ...spectrogramSettings, gamma: n }) }
        )}

        <div class="spec-modal-row">
          <label class="spec-modal-label" for="spec-scale">Scale</label>
          <select id="spec-scale" class="spec-modal-sel" value={spectrogramSettings.scale}
            onchange={(e) => applySpectrogramSettings({ ...spectrogramSettings, scale: e.currentTarget.value as 'mel' | 'linear' })}>
            <option value="mel">Mel</option>
            <option value="linear">Linear</option>
          </select>
        </div>
        <div class="spec-modal-row">
          <label class="spec-modal-label" for="spec-mono-mix">Mono mix</label>
          <input id="spec-mono-mix" type="checkbox" checked={spectrogramSettings.monoMix}
            onchange={(e) => applySpectrogramSettings({ ...spectrogramSettings, monoMix: e.currentTarget.checked })} />
        </div>
        {#if spectrogramSettings.scale === 'mel'}
          {@render numCombo('spec-mel-bands', 'Mel bands', '',
            String(spectrogramSettings.melBands),
            ['40', '60', '80', '128'],
            v => { const n = parseInt(v); if (n > 0) applySpectrogramSettings({ ...spectrogramSettings, melBands: n }) }
          )}
        {/if}
      </div>
    </div>
  {/if}

  {#if showWarnings}
    <button class="warn-backdrop" onclick={() => showWarnings = false} aria-label="Close"></button>
    <div class="warn-panel">
      <div class="warn-panel-header">
        <span>File issues</span>
        <button class="warn-close" aria-label="Close" onclick={() => showWarnings = false}>✕</button>
      </div>
      {#if fileWarnings.length === 0}
        <div class="warn-empty">No issues found.</div>
      {:else}
        <ul class="warn-list">
          {#each fileWarnings as w (w.id ?? (w.kind + ':' + w.message))}
            <li class="warn-item warn-kind-{w.kind}">
              <span class="warn-kind-badge">{w.kind}</span>
              <span class="warn-msg">{w.message}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  {#if import.meta.env.DEV && showDebugTray}
    <DebugTray {multiPlayer} onClose={() => showDebugTray = false} />
  {/if}
  {/if}<!-- end editor always-mounted block -->
</div>

{#if snapMenuPos}
  <div class="snap-menu"
    bind:this={_snapMenuEl}
    style="left:{snapMenuPos.x}px; top:{snapMenuPos.y}px"
    role="menu"
    tabindex="-1"
    onmouseenter={_cancelSnapMenuClose}
    onmouseleave={_scheduleSnapMenuClose}>
    <div class="snap-menu-header">Snap mode</div>
    {#each SNAP_MODES as mode (mode)}
      <button class="snap-menu-item" class:snap-menu-item-active={snapMode === mode && snapChannelId === null}
        role="menuitem"
        onclick={() => {
          snapMode = mode
          snapChannelId = null
          timelineRef?.setSnapEnabled(true)
          timelineRef?.setSnapMode(mode)
          timelineRef?.setSnapChannel(null)
          snapMenuPos = null
        }}>
        {mode}
      </button>
    {/each}
    {#if mediaSignals.some(s => s.kind === 'waveform' || s.kind === 'spectrogram')}
      <div class="snap-menu-divider"></div>
      <div class="snap-menu-header">By channel</div>
      {#each mediaSignals.filter(s => s.kind === 'waveform' || s.kind === 'spectrogram') as sig (sig.id)}
        <button class="snap-menu-item" class:snap-menu-item-active={snapChannelId === sig.id}
          role="menuitem"
          onclick={() => {
            snapChannelId = sig.id
            snapMode = sig.kind as SnapMode
            timelineRef?.setSnapEnabled(true)
            timelineRef?.setSnapMode(sig.kind as SnapMode)
            timelineRef?.setSnapChannel(sig.id)
            snapMenuPos = null
          }}>
          {sig.label}
        </button>
      {/each}
    {/if}
    <div class="snap-menu-divider"></div>
    <div class="snap-menu-header">Annotations</div>
    {#each (['all', 'same-lane', 'none'] as const) as annMode (annMode)}
      <button class="snap-menu-item" class:snap-menu-item-active={annotationSnapMode === annMode}
        role="menuitem"
        onclick={() => {
          annotationSnapMode = annMode
          timelineRef?.setAnnotationSnapMode(annMode)
          snapMenuPos = null
        }}>
        {annMode}
      </button>
    {/each}
  </div>
{/if}

{#if tlSettingsOpen && tlGearMenuPos}
  <button class="tl-gear-backdrop" onclick={() => { tlSettingsOpen = false; tlGearMenuPos = null }} aria-label="Close"></button>
  <div class="tl-gear-menu"
    bind:this={_tlGearMenuEl}
    style="left:{tlGearMenuPos.x}px; top:{tlGearMenuPos.y}px"
    role="menu"
    tabindex="0"
    onmouseleave={() => { tlSettingsOpen = false; tlGearMenuPos = null }}>

    {#if mediaSignals.length > 0}
      {@const primaryId = multiPlayer.primary?.id ?? ''}
      {@const sigGroups = (() => {
        const map = new SvelteMap<string, typeof mediaSignals>()
        for (const s of mediaSignals) {
          const pid = s.id.split(':')[0]!
          if (!map.has(pid)) map.set(pid, [])
          map.get(pid)!.push(s)
        }
        return [...map.entries()]
          .sort(([a], [b]) => a === primaryId ? -1 : b === primaryId ? 1 : 0)
          .map(([pid, sigs]) => {
            const player = multiPlayer.players.find(p => p.id === pid)
            const filename = player?.state?.filename
            const header = pid === primaryId ? (filename ?? 'Primary') : (filename ?? 'Linked')
            return { pid, header, sigs }
          })
      })()}
      <div class="tl-gear-section-header">Audio</div>
      {#each sigGroups as grp (grp.pid)}
        {#if sigGroups.length > 1}
          <div class="tl-gear-player-header">{grp.header}</div>
        {/if}
        {#each grp.sigs as sig (sig.id)}
          {@const parts = sig.id.split(':')}
          {@const shortLabel = parts.length >= 3
            ? `${parts[1]} ${parseInt(parts[2]!.replace('ch','')) === 0 ? 'L' : parseInt(parts[2]!.replace('ch','')) === 1 ? 'R' : parts[2]}`
            : sig.label}
          <label class="tl-gear-item" class:tl-gear-item-indent={sigGroups.length > 1}>
            <input type="checkbox" checked={!hiddenSignalIds.has(sig.id)}
              onchange={() => {
                const next = new SvelteSet(hiddenSignalIds)
                if (next.has(sig.id)) next.delete(sig.id)
                else next.add(sig.id)
                hiddenSignalIds = next
                _flushSignals()
              }} />
            {shortLabel}
          </label>
        {/each}
      {/each}
    {/if}

    {#if mediaSignals.some(s => s.kind === 'spectrogram')}
      <div class="tl-gear-divider"></div>
      <button class="tl-gear-item tl-gear-preset-btn"
        onclick={() => { specModalOpen = true; tlSettingsOpen = false; tlGearMenuPos = null }}>
        Spectrogram settings…
      </button>
    {/if}

    {#if timelineData.lanes.length > 0}
      {#if mediaSignals.length > 0}<div class="tl-gear-divider"></div>{/if}
      <div class="tl-gear-section-header">Tiers</div>
      {#each timelineData.lanes as lane (lane.id)}
        {@const depth = laneMenuDepth(lane.id)}
        {@const selfHidden = hiddenLaneIds.has(lane.id)}
        {@const parentHidden = isLaneHidden(lane.id) && !selfHidden}
        <label class="tl-gear-item" class:tl-gear-item-dim={parentHidden} style="padding-left:{10 + depth * 12}px">
          <input type="checkbox" checked={!selfHidden && !parentHidden} disabled={parentHidden}
            onchange={() => {
              const next = new SvelteSet(hiddenLaneIds)
              if (next.has(lane.id)) next.delete(lane.id)
              else next.add(lane.id)
              hiddenLaneIds = next
              timelineRef?.setLanes(timelineData.lanes.filter(l => !isLaneHidden(l.id)))
            }} />
          {lane.label}
        </label>
      {/each}
    {/if}

    {#if mediaSignals.length === 0 && timelineData.lanes.length === 0}
      <div class="tl-gear-empty">No audio or tiers to show</div>
    {/if}
  </div>
{/if}

{#if vizMenu}
  <button class="img-menu-backdrop" onclick={() => vizMenu = null} aria-label="Close menu"></button>
  <div
    class="img-menu"
    style="left:{vizMenu.x}px; top:{vizMenu.y}px"
    role="menu"
    use:clampToViewport
  >
    {#if vizMenu.vizType === 'spectrogram-clip'}
      {@const spectChannels = mediaSignals.filter(s => s.kind === 'spectrogram')}
      <div class="viz-menu-time-row">
        <input type="number" class="viz-menu-time-input" step="0.001" min="0" placeholder="start"
          value={vizMenu.editStart ?? ''}
          oninput={(e) => { if (vizMenu) vizMenu = { ...vizMenu, editStart: parseFloat((e.target as HTMLInputElement).value) || null } }}
        />
        <span class="viz-menu-time-sep">–</span>
        <input type="number" class="viz-menu-time-input" step="0.001" min="0" placeholder="end"
          value={vizMenu.editEnd ?? ''}
          oninput={(e) => { if (vizMenu) vizMenu = { ...vizMenu, editEnd: parseFloat((e.target as HTMLInputElement).value) || null } }}
        />
        <span class="viz-menu-time-unit">s</span>
      </div>
      {#if spectChannels.length > 1}
        <div class="viz-menu-channel-row">
          <label class="viz-menu-channel-label" for="viz-menu-channel">Channel</label>
          <select
            id="viz-menu-channel"
            class="viz-menu-channel-select"
            value={vizMenu.channelId}
            onchange={(e) => { if (vizMenu) vizMenu = { ...vizMenu, channelId: (e.target as HTMLSelectElement).value } }}
          >
            {#each spectChannels as ch (ch.id)}
              <option value={ch.id}>{ch.label}</option>
            {/each}
          </select>
        </div>
      {/if}
      <button class="img-menu-item" role="menuitem"
        disabled={vizMenu.editStart == null || vizMenu.editEnd == null}
        onclick={() => { const m = vizMenu!; vizMenu = null; if (m.editStart != null && m.editEnd != null) void generateSpectForViz(m.vizId, m.channelId, m.editStart, m.editEnd) }}
      >Generate spectrogram clip</button>
    {:else}
      <button class="img-menu-item" role="menuitem" onclick={() => vizMenu = null}>No actions for type "{vizMenu.vizType}"</button>
    {/if}
  </div>
{/if}

{#if imageMenu}
  <button class="img-menu-backdrop" onclick={() => imageMenu = null} aria-label="Close menu"></button>
  <div
    class="img-menu"
    style="left:{imageMenu.x}px; top:{imageMenu.y}px"
    role="menu"
    tabindex="0"
    use:clampToViewport
    use:focusFirstMenuItem
    onkeydown={onImageMenuKeydown}
  >
    <button class="img-menu-item" role="menuitem" onclick={() => void imageMenuScreenshotFull()}>Full pattern screenshot</button>
    <button class="img-menu-item" role="menuitem" onclick={() => void imageMenuScreenshotCrop()}>Select region…</button>
    <hr class="img-menu-sep" />
    <button class="img-menu-item" role="menuitem" onclick={() => void imageMenuUpload()}>Upload image…</button>
  </div>
{/if}

{#if imageCropBlob}
  <ImageCropDlg
    frameBlob={imageCropBlob}
    onConfirm={blob => void onCropConfirm(blob)}
    onCancel={() => { imageCropBlob = null; _pendingCropId = '' }}
  />
{/if}

<style>
  :global(*, *::before, *::after) { box-sizing: border-box; margin: 0; padding: 0; }
  :global(body) { font-family: system-ui, sans-serif; background: #fafafa; color: #222; }
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  .menubar {
    display: flex;
    align-items: center;
    gap: 0;
    padding: 0 max(0.5rem, calc(100vw - env(titlebar-area-width, 100vw))) 0 0.5rem;
    background: #fff;
    border-bottom: 1px solid #e0e0e0;
    flex-shrink: 0;
    height: 40px;
    -webkit-app-region: drag;
  }

  .mb-app-icon {
    height: 20px;
    width: 20px;
    margin-right: 4px;
    flex-shrink: 0;
    image-rendering: auto;
    -webkit-app-region: no-drag;
  }

  .logo {
    font-weight: 700;
    font-size: 1.0rem;
    letter-spacing: -0.02em;
    margin-right: 0.25rem;
    padding: 0 6px;
  }

  .mb-spacer {
    flex: 1;
    -webkit-app-region: drag;
  }

  .mb-collection-btn {
    -webkit-app-region: no-drag;
    background: none;
    border: 1px solid var(--color-border, #ddd);
    border-radius: 3px;
    padding: 2px 10px;
    font-size: var(--font-sm, 0.8rem);
    cursor: pointer;
    color: var(--color-text-1, #333);
    white-space: nowrap;
    margin-right: 6px;
  }
  .mb-collection-btn:hover {
    background: var(--color-bg-1, #f5f5f5);
    border-color: var(--color-text-muted, #999);
  }

  .mb-wrap {
    position: relative;
    z-index: 300;
  }

  .mb-btn {
    padding: 2px 8px;
    border: none;
    border-radius: 3px;
    background: none;
    cursor: pointer;
    font-size: 0.82rem;
    color: #333;
    height: 22px;
    -webkit-app-region: no-drag;
  }
  .mb-btn:hover, .mb-btn.mb-open { background: var(--color-bg-4); }
  .mb-btn:disabled { color: var(--color-text-placeholder); cursor: default; }
  .mb-btn:disabled:hover { background: none; }

  .mb-collab {
    margin-left: 0.5rem;
    display: flex; align-items: center; gap: 0.35rem;
    padding: 0 0.3rem 0 0.6rem;
    height: 22px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--color-border);
    background: var(--color-bg-2);
    -webkit-app-region: no-drag;
  }
  .mb-collab.mb-collab-live {
    background: var(--color-active-light);
    border-color: var(--color-active-border);
  }
  .mb-collab-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--color-text-faint);
    flex-shrink: 0;
    transition: background 0.3s;
  }
  .mb-collab-dot.mb-collab-dot-on {
    background: var(--color-active);
    box-shadow: 0 0 0 2px var(--color-active-light);
  }
  .mb-collab-label {
    font-size: var(--font-xs);
    color: var(--color-text-3);
    white-space: nowrap;
  }
  .mb-collab-live .mb-collab-label { color: var(--color-active-dark); }
  .mb-collab-invite {
    font-size: var(--font-xs);
    padding: 0.15rem 0.55rem;
    border: none;
    border-radius: var(--radius-sm);
    background: var(--color-primary);
    color: #fff;
    cursor: pointer;
    font-weight: 600;
    line-height: 1.4;
    white-space: nowrap;
  }
  .mb-collab-invite:hover { background: var(--color-primary-hover); }
  .mb-collab-stop {
    width: 18px; height: 18px;
    padding: 0;
    font-size: 10px;
    border-radius: 50%;
    border: none;
    background: none;
    color: var(--color-text-muted);
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .mb-collab-stop:hover { background: var(--color-danger-light); color: var(--color-danger); }

  .mb-backdrop {
    position: fixed; inset: 0; z-index: 299;
    background: transparent; border: none; padding: 0; cursor: default;
  }

  .mb-drop {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 300;
    background: var(--color-bg-0);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-menu);
    min-width: 190px;
    padding: 4px 0;
    display: flex;
    flex-direction: column;
  }

  .mb-drop button {
    border: none;
    border-radius: 0;
    background: none;
    padding: 5px 12px 5px 26px;
    text-align: left;
    font-size: 0.82rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    color: var(--color-text-1);
  }
  .mb-drop button:hover { background: var(--color-bg-menu-hover); }
  .mb-drop button:disabled { color: var(--color-text-placeholder); cursor: default; }
  .mb-drop button:disabled:hover { background: none; }

  .mb-sep { border: none; border-top: 1px solid #eee; margin: 3px 0; }
  .mb-kbd { font-size: 0.7rem; color: #999; font-family: monospace; }
  .mb-check {
    width: 18px;
    flex-shrink: 0;
    margin-left: -18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    position: relative;
  }
  .mb-check::before {
    content: '';
    display: block;
    width: 12px;
    height: 12px;
    border: 1.5px solid #aaa;
    border-radius: 3px;
    box-sizing: border-box;
    flex-shrink: 0;
  }
  .mb-check.mb-checked::before {
    background: var(--color-primary);
    border-color: var(--color-primary);
  }
  .mb-check.mb-checked::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    width: 6px;
    height: 3.5px;
    border-left: 1.5px solid white;
    border-bottom: 1.5px solid white;
    transform: translate(-55%, -65%) rotate(-45deg);
  }
  .mb-empty { padding: 5px 12px; font-size: 0.82rem; color: #aaa; display: block; }

  .mb-sub-wrap { position: relative; }
  .mb-sub-drop {
    display: none;
    position: absolute; left: 100%; top: -5px;
    background: var(--color-bg-0);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-menu);
    min-width: 160px;
    padding: 4px 0;
    flex-direction: column;
    z-index: 301;
  }
  .mb-sub-wrap:hover > .mb-sub-drop { display: flex; }
  .mb-arrow { font-size: 9px; color: #999; }

  .mb-drop-right { left: auto; right: 0; }
  .mb-drop-help { min-width: 280px; padding: 6px 0; }
  .mb-help-section {
    display: block;
    padding: 4px 12px 2px;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #888;
  }
  .mb-help-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 2px 12px;
    font-size: 0.8rem;
    color: #333;
  }
  .mb-help-row kbd {
    display: inline-block;
    font-family: monospace;
    font-size: 0.72rem;
    background: #f0f0f0;
    border: 1px solid #ccc;
    border-radius: 3px;
    padding: 0 4px;
    line-height: 1.5;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .mb-help-row span { color: #444; }
  .mb-help-note { font-size: 0.75rem; color: #999; font-style: italic; }

  /* base button rules come from base.css */

  /* ── Media pane ────────────────────────────────────────────────────────── */
  .media-pane {
    flex-shrink: 0;
    display: flex;
    flex-direction: row;
    background: #111;
    overflow: hidden;
    position: relative;
  }

  .media-pane-inner {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }

  .viz-toggle-overlay {
    position: absolute;
    bottom: 6px;
    right: 8px;
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: rgba(255,255,255,0.75);
    background: rgba(0,0,0,0.45);
    padding: 2px 6px 2px 4px;
    border-radius: 3px;
    cursor: pointer;
    user-select: none;
    z-index: 10;
  }
  .viz-toggle-overlay:hover { color: #fff; background: rgba(0,0,0,0.65); }

  .media-filename-bar {
    flex-shrink: 0;
    font-size: 0.65rem;
    color: #666;
    font-family: monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 2px 6px;
    background: #0a0a0a;
    border-bottom: 1px solid #222;
  }

  .media-video {
    flex: 1;
    width: 100%;
    min-height: 0;
    object-fit: contain;
    background: #000;
    display: block;
  }

  .media-audio {
    flex: none;
    height: 36px;
  }

  .media-pane-resize {
    flex-shrink: 0;
    width: 5px;
    cursor: col-resize;
    background: #d8d8d8;
    border-right: 1px solid #c8c8c8;
    box-shadow: 2px 0 4px rgba(0,0,0,0.10);
    transition: background 0.15s;
  }
  .media-pane-resize:hover { background: var(--color-primary); }

  /* ── Main area ─────────────────────────────────────────────────────────── */
  .main-area {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .editor-pane {
    flex: 1;
    overflow: hidden;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .editor-col-headers {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 80px 0.25rem 0.25rem;
    border-bottom: 1px solid #bbb;
    background: #fafafa;
  }

  .editor-col-headers.hide-times  .ech-time       { display: none; }
  .editor-col-headers.hide-start  .ech-time-start { display: none; }
  .editor-col-headers.hide-end    .ech-time-end   { display: none; }
  .mb-label { font-size: 0.72rem; color: var(--color-text-muted); padding: 0.15rem 0.6rem 0; display: block; }

  .ech {
    font-size: 0.65em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #888;
    user-select: none;
    white-space: nowrap;
  }
  .ech-linenum { flex-shrink: 0; width: 2rem; text-align: right; }
  .ech-time    { flex-shrink: 0; width: 6.5rem; }
  .ech-participant { flex-shrink: 0; width: 4rem; text-align: right; }
  .ech-content { flex: 1; display: flex; align-items: center; overflow: visible; padding-left: 5rem; }

  .ech-mode-group {
    margin-left: auto;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .ech-loop-tip {
    font-size: 0.7rem;
    font-weight: bold;
    color: #e8c97a;
    white-space: nowrap;
  }
  .ech-mode-switch {
    flex-shrink: 0;
    display: flex;
    align-items: center;
  }
  .ech-mode-buttons {
    display: flex;
    border: 1px solid #ccc;
    border-radius: 3px;
    overflow: hidden;
  }

  .ech-mode-opt {
    padding: 0 0.45rem;
    border: none;
    border-radius: 0;
    background: transparent;
    font-size: 0.62em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #aaa;
    cursor: pointer;
    font-family: inherit;
    user-select: none;
    line-height: 1.7;
  }
  .ech-mode-label {
    padding: 0 0.3rem 0 0.45rem;
    font-size: 0.62em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted, #999);
    user-select: none;
    display: flex;
    align-items: center;
  }
  .ech-mode-opt + .ech-mode-opt { border-left: 1px solid #ccc; }
  .ech-mode-opt:hover:not(.ech-mode-active) { color: #666; background: #f0f0f0; }
  .ech-mode-opt.ech-mode-active { background: #e8e8e8; color: #333; cursor: default; box-shadow: inset 0 1px 3px rgba(0,0,0,0.18); }
  @keyframes ech-jiggle {
    0%   { transform: translateX(0); }
    20%  { transform: translateX(-5px); }
    40%  { transform: translateX(5px); }
    60%  { transform: translateX(-3px); }
    80%  { transform: translateX(3px); }
    100% { transform: translateX(0); }
  }
  .ech-mode-jiggle { animation: ech-jiggle 0.35s ease; }
  @keyframes ech-flash-red {
    0%   { border-color: #ccc; background: transparent; }
    20%  { border-color: #c0392b; background: rgba(192,57,43,0.12); }
    65%  { border-color: #c0392b; background: rgba(192,57,43,0.12); }
    100% { border-color: #ccc; background: transparent; }
  }
  .ech-mode-flash { animation: ech-flash-red 0.5s ease; }

  .editor-scroll {
    flex: 1;
    overflow-y: auto;
    scrollbar-gutter: stable;
    position: relative;
    padding: 0.25rem 0 1.5rem 0.25rem;
  }

  .status-bar {
    flex-shrink: 0;
    height: 22px;
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0 0.25rem;
    background: #1e1e1e;
    color: #ccc;
    font-size: 0.72rem;
    overflow: hidden;
    white-space: nowrap;
  }

  .status-logo { font-family: 'LMMonoLt10', monospace; font-weight: bold; font-size: 1rem; letter-spacing: 0.03em; }
  .sl-m { color: #ff0000; }
  .sl-u { color: #f2ad00; }
  .sl-o { color: #00a08a; }
  .sl-bracket { color: #888; }
  .sl-oblique { font-style: oblique; }
  .status-item { display: flex; align-items: center; gap: 0.3rem; }

  .status-fill { color: #e8c97a; }
  .status-fill strong { color: #ffd97d; font-weight: 600; }
  .status-fill-error { color: #ff8a8a; }

  .status-selection { color: #7ab8e8; }
  .status-loop-tip  { color: #e8c97a; font-size: 0.68rem; font-weight: bold; }
  .status-fps  { font-variant-numeric: tabular-nums; color: #888; font-size: 0.68rem; }
  .status-right { display: flex; align-items: center; gap: 0.5rem; margin-left: auto; }
  .status-hz    { font-variant-numeric: tabular-nums; color: #aaa; font-size: 0.68rem; }
  .status-zoom  { font-variant-numeric: tabular-nums; color: #888; font-size: 0.68rem; }

  .status-spec {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 0.72rem;
    color: #aaa;
  }
  .status-spec-label { white-space: nowrap; }
  .status-spec-pct { font-variant-numeric: tabular-nums; min-width: 2.5ch; text-align: right; }
  .status-spec-track {
    width: 100px;
    height: 5px;
    background: rgba(255,255,255,0.1);
    border-radius: 3px;
    overflow: hidden;
    position: relative;
  }
  .status-spec-fill {
    display: block;
    height: 100%;
    background: var(--color-primary, #0077cc);
    border-radius: 3px;
    transition: width 0.15s ease;
  }
  .status-spec-indeterminate {
    display: block;
    position: absolute;
    top: 0; bottom: 0;
    width: 40%;
    background: var(--color-primary, #0077cc);
    border-radius: 3px;
    animation: spec-indeterminate 1.2s ease-in-out infinite;
  }
  @keyframes spec-indeterminate {
    0%   { left: -40% }
    100% { left: 100% }
  }

  .status-warn-btn {
    padding: 0 0.5rem;
    height: 100%;
    border: none;
    border-radius: 0;
    background: transparent;
    color: #666;
    font-size: 0.68rem;
    font-family: inherit;
    cursor: pointer;
    letter-spacing: 0.03em;
  }
  .status-warn-btn:hover { background: #333; }
  .status-warn-btn.status-warn-active { color: var(--color-status-warn); }

  .warn-backdrop {
    position: fixed; inset: 0; z-index: 399;
    background: transparent; border: none; padding: 0; cursor: default;
  }

  .warn-panel {
    position: fixed;
    bottom: 22px;
    right: 0;
    z-index: 400;
    width: 420px;
    max-height: 320px;
    background: #fff;
    border: 1px solid #ccc;
    border-bottom: none;
    border-radius: 6px 6px 0 0;
    box-shadow: 0 -4px 16px rgba(0,0,0,0.12);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .warn-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.35rem 0.75rem;
    background: #f5f5f5;
    border-bottom: 1px solid #ddd;
    font-size: 0.75rem;
    font-weight: 600;
    color: #444;
    flex-shrink: 0;
  }

  .warn-close {
    padding: 0 0.3rem;
    border: none;
    background: transparent;
    color: #aaa;
    cursor: pointer;
    font-size: 0.8rem;
    line-height: 1;
  }
  .warn-close:hover { color: #444; }

  .warn-empty {
    padding: 1.25rem 1rem;
    font-size: 0.8rem;
    color: #aaa;
    text-align: center;
  }

  .warn-list {
    list-style: none;
    margin: 0;
    padding: 0.3rem 0;
    overflow-y: auto;
  }

  .warn-item {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.3rem 0.75rem;
    font-size: 0.78rem;
    border-bottom: 1px solid #f0f0f0;
    color: #333;
  }
  .warn-item:last-child { border-bottom: none; }

  .warn-kind-badge {
    flex-shrink: 0;
    font-size: 0.64rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0.1rem 0.35rem;
    border-radius: 3px;
    background: #f0e8d0;
    color: #a06000;
  }
  .warn-kind-pattern .warn-kind-badge { background: #e8eeff; color: #3060c0; }
  .warn-kind-utterance .warn-kind-badge { background: #eef8e8; color: #3a7020; }
  .warn-kind-group .warn-kind-badge { background: #f8e8f0; color: #902060; }
  .warn-kind-gap .warn-kind-badge { background: #fee2e2; color: #991b1b; }

  .warn-msg { flex: 1; line-height: 1.4; }

  .timeline-resize-handle {
    flex-shrink: 0;
    height: 5px;
    cursor: row-resize;
    background: #d8d8d8;
    border-top: 1px solid #c8c8c8;
    box-shadow: 0 2px 4px rgba(0,0,0,0.10);
    transition: background 0.15s;
  }

  .timeline-resize-handle:hover {
    background: var(--color-primary);
  }

  .timeline-pane {
    flex-shrink: 0;
    overflow-y: auto;
    overflow-x: hidden;
    background: #efefef;
    box-shadow: inset 0 4px 8px -4px rgba(0,0,0,0.12);
  }

  .tl-timecode-full {
    padding: 1px 2px 2px;
  }

  .tl-timecode-frame {
    font-family: monospace;
    font-size: 11px;
    font-weight: 600;
    color: #222;
    letter-spacing: 0.03em;
    user-select: text;
    cursor: text;
    white-space: nowrap;
  }

  .tl-timecode-copyable {
    cursor: copy;
    border-radius: 2px;
  }

  .tl-timecode-copyable:hover {
    background: rgba(0, 0, 0, 0.06);
  }

  .status-ms-copy:hover {
    background: rgba(255, 255, 255, 0.12);
  }

  /* ── Timeline panel tools ──────────────────────────────────────────────── */
  .tl-panel-tools {
    display: flex;
    flex-direction: column;
    justify-content: center;
    height: 100%;
    padding: 2px 4px;
  }

  .tl-snap-wrap { display: inline-flex; align-items: center; }

  .snap-menu {
    position: fixed;
    z-index: 300;
    background: var(--color-bg-0);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-menu);
    padding: 4px 0;
    min-width: 120px;
  }
  .snap-menu-header {
    padding: 3px 10px 2px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: #999;
    user-select: none;
  }
  .snap-menu-item {
    display: block;
    width: 100%;
    background: none;
    border: none;
    text-align: left;
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
    color: inherit;
  }
  .snap-menu-item:hover { background: var(--color-bg-menu-hover); }
  .snap-menu-item-active { color: var(--color-active-dark); font-weight: 600; }
  .snap-menu-divider { border-top: 1px solid var(--color-border, #eee); margin: 3px 0; }

  .status-snap {
    font-variant-numeric: tabular-nums;
    font-size: 0.68rem;
    color: var(--color-active, #0077cc);
  }
  .status-snap-off { color: #666; }
  .status-snap-ann { color: #e8c97a; }

  .tl-tool-row {
    display: flex;
    align-items: center;
    gap: 1px;
  }

  .tl-tool-btn {
    background: none;
    border: 1px solid transparent;
    border-radius: 3px;
    padding: 2px 5px;
    cursor: pointer;
    font-size: 13px;
    color: #555;
    line-height: 1;
  }
  .tl-tool-btn:hover:not(:disabled) { background: var(--color-bg-4); border-color: var(--color-border); }
  .tl-tool-btn.active { background: var(--color-active-light); border-color: var(--color-active); color: var(--color-active-dark); }
  .tl-tool-btn.active:hover:not(:disabled) { background: var(--color-active-light); border-color: var(--color-active); color: var(--color-active-dark); }
  .tl-tool-btn:disabled { opacity: 0.35; cursor: default; }

  .tl-gear-backdrop {
    position: fixed; inset: 0; z-index: 299;
    background: transparent; border: none; padding: 0; cursor: default;
  }

  .tl-gear-menu {
    position: fixed;
    z-index: 300;
    background: var(--color-bg-0);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-menu);
    padding: 6px 0;
    min-width: 140px;
  }

  .tl-gear-item {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .tl-gear-item:hover { background: var(--color-bg-menu-hover); }
  .tl-gear-item-dim { opacity: 0.45; cursor: default; }
  .tl-gear-item-dim:hover { background: transparent; }
  .tl-gear-item-indent { padding-left: 18px; }
  .tl-gear-player-header {
    padding: 4px 10px 1px;
    font-size: 10px; font-weight: 600;
    color: var(--color-text-2, #666);
    user-select: none;
  }

  .tl-gear-section-header {
    padding: 4px 10px 2px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: #999;
    user-select: none;
  }

  .tl-gear-divider {
    border-top: 1px solid #eee;
    margin: 4px 0;
  }

  .tl-gear-empty {
    padding: 6px 10px;
    font-size: 12px;
    color: #aaa;
  }

  .tl-gear-preset-btn {
    background: none;
    border: none;
    text-align: left;
    width: 100%;
    color: inherit;
    font: inherit;
  }
  .tl-gear-preset-active { font-weight: 600; color: var(--color-primary, #0077cc); }


/* Spectrogram settings modal */
  .spec-modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 200;
    background: transparent; border: none; padding: 0; cursor: default;
  }
  .spec-modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 201;
    background: var(--color-bg-0, #fff);
    border: 1px solid var(--color-border, #d0d0d0);
    border-radius: 6px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.18);
    min-width: 280px;
    font-size: 13px;
  }
  .spec-modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--color-border, #e0e0e0);
    font-weight: 600;
  }
  .spec-modal-close {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 13px;
    color: #888;
    padding: 2px 4px;
  }
  .spec-modal-close:hover { color: #333; }
  .spec-modal-body {
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .spec-modal-section-label {
    font-size: 11px;
    font-weight: 600;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 2px;
  }
  .spec-modal-preset {
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    text-align: left;
    padding: 5px 8px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    color: inherit;
    width: 100%;
  }
  .spec-modal-preset:hover { background: var(--color-bg-2, #f5f5f5); }
  .spec-modal-preset-active {
    font-weight: 600;
    color: var(--color-primary, #0077cc);
    border-color: var(--color-primary, #0077cc);
  }
  .spec-modal-divider {
    border-top: 1px solid var(--color-border, #e8e8e8);
    margin: 4px 0;
  }
  .spec-modal-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .spec-modal-label {
    width: 110px;
    color: #666;
    flex-shrink: 0;
    font-size: 12px;
  }
  .spec-modal-sel {
    flex: 1;
    font-size: 12px;
    padding: 3px 5px;
    border: 1px solid var(--color-border, #ccc);
    border-radius: 4px;
    background: var(--color-bg-0, #fff);
    color: inherit;
  }
  .spec-combo-wrap {
    flex: 1;
    display: inline-flex;
    align-items: stretch;
    border: 1px solid var(--color-border, #ccc);
    border-radius: 4px;
    background: var(--color-bg-0, #fff);
    font-size: 12px;
    overflow: hidden;
    height: 24px;
  }
  .spec-combo-wrap:focus-within { border-color: var(--color-primary, #4a9eff); outline: 1px solid var(--color-primary, #4a9eff); }
  .spec-combo-input {
    flex: 1;
    min-width: 0;
    padding: 2px 5px;
    border: none;
    background: transparent;
    font-size: inherit;
    font-family: inherit;
    font-variant-numeric: tabular-nums;
    color: inherit;
    outline: none;
  }
  .spec-combo-arrow {
    position: relative;
    display: flex;
    align-items: center;
    border-left: 1px solid var(--color-border, #ccc);
    background: var(--color-bg-2, #f5f5f5);
    padding: 0 4px;
  }
  .spec-combo-select {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
    width: 100%;
  }
  .spec-combo-chevron {
    font-size: 0.6rem;
    color: #666;
    pointer-events: none;
    line-height: 1;
  }

.inspector-resize-handle {
    flex-shrink: 0;
    width: 5px;
    cursor: col-resize;
    background: #d8d8d8;
    border-left: 1px solid #c8c8c8;
    box-shadow: -2px 0 4px rgba(0,0,0,0.10);
    transition: background 0.15s;
    position: relative;
  }

  .inspector-resize-handle:hover {
    background: var(--color-primary);
  }

  .inspector-collapsed {
    width: 10px;
    cursor: e-resize;
    border-left: 2px solid var(--color-border);
    background: var(--color-bg-3);
  }

  .inspector-collapsed:hover {
    background: var(--color-border-strong);
    border-left-color: var(--color-primary);
  }

  .inspector-outer {
    flex-shrink: 0;
    overflow: hidden;
    display: flex;
    background: #f0f0f0;
    box-shadow: inset 4px 0 8px -4px rgba(0,0,0,0.10);
  }

  /* ── Context menu ──────────────────────────────────────────────────────── */
  .ctx-backdrop {
    position: fixed; inset: 0; z-index: 100;
    background: transparent; border: none; padding: 0; cursor: default;
  }

  .ctx-menu {
    position: fixed;
    z-index: 101;
    background: var(--color-bg-0);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-menu);
    min-width: 160px;
    padding: 4px 0;
    display: flex;
    flex-direction: column;
  }

  .ctx-label {
    padding: 0.3rem 0.9rem 0.1rem;
    font-size: 0.75rem;
    color: #aaa;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    user-select: none;
  }

  .ctx-menu button {
    border: none;
    border-radius: 0;
    background: none;
    padding: 0.4rem 0.9rem;
    text-align: left;
    font-size: 0.85rem;
    width: 100%;
  }

  .ctx-menu button:hover { background: var(--color-bg-menu-hover); }
  .ctx-menu hr { border: none; border-top: 1px solid #eee; margin: 4px 0; }

  /* ── Slot-fill mode visual feedback ───────────────────────────────────── */

  /* Pointer cursor on line numbers and content area when a slot is waiting to be filled */
  .slot-fill-active :global(.utt-linenum) {
    cursor: pointer;
    color: #888;
  }

  .slot-fill-active :global(.utt-content) {
    cursor: pointer;
  }


  /* ── Slot-fill hover menu ──────────────────────────────────────────────── */
  .hover-menu {
    position: fixed;
    z-index: 500;
    background: var(--color-bg-0);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-menu-sm);
    padding: 3px 0;
    min-width: 160px;
    display: flex;
    flex-direction: column;
    pointer-events: all;
  }
  /* Transparent bridge below popup fills the gap between popup bottom and the textlet/token */
  .hover-menu::after {
    content: '';
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    height: 12px;
  }

  .hover-menu button {
    border: none;
    border-radius: 0;
    background: none;
    padding: 0.35rem 0.25rem;
    text-align: left;
    font-size: 0.82rem;
    width: 100%;
    white-space: nowrap;
  }

  .hover-menu button:hover { background: var(--color-primary-light); }

  .img-menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 199;
    background: transparent; border: none; padding: 0; cursor: default;
  }
  .img-menu {
    position: fixed;
    z-index: 200;
    background: var(--color-bg-0);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    padding: 4px 0;
    min-width: 180px;
    box-shadow: var(--shadow-menu);
  }
  .img-menu-item {
    display: block;
    width: 100%;
    padding: 0.4rem 0.9rem;
    background: none;
    border: none;
    font-size: 0.85rem;
    text-align: left;
    cursor: pointer;
  }
  .img-menu-item:hover,
  .img-menu-item:focus { background: var(--color-bg-menu-hover); outline: none; }
  .img-menu-sep { border: none; border-top: 1px solid var(--color-border); margin: 4px 0; }
  .img-menu-info {
    padding: 0.35rem 0.9rem;
    font-size: 0.75rem;
    color: var(--color-text-light);
    border-bottom: 1px solid var(--color-border);
    margin-bottom: 2px;
  }
  .img-menu-item:disabled { opacity: 0.4; cursor: default; }
  .viz-menu-time-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0.4rem 0.7rem;
    border-bottom: 1px solid var(--color-border);
  }
  .viz-menu-time-input {
    width: 70px;
    font-size: 0.78rem;
    padding: 2px 4px;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    background: var(--color-bg);
    color: var(--color-text);
    min-width: 0;
  }
  .viz-menu-time-sep { font-size: 0.78rem; color: var(--color-text-mid); }
  .viz-menu-time-unit { font-size: 0.78rem; color: var(--color-text-mid); }
  .viz-menu-channel-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.9rem;
    border-bottom: 1px solid var(--color-border);
  }
  .viz-menu-channel-label { font-size: 0.78rem; color: var(--color-text-mid); white-space: nowrap; }
  .viz-menu-channel-select { font-size: 0.78rem; flex: 1; min-width: 0; }

  /* Timeline suggestion hover card */
  .tl-sug-card {
    position: fixed;
    z-index: 500;
    background: var(--color-bg-0, #fff);
    border: 1px solid var(--color-border, #ddd);
    border-radius: var(--radius-md, 4px);
    box-shadow: var(--shadow-menu-sm, 0 2px 8px rgba(0,0,0,0.15));
    padding: 3px 0;
    pointer-events: all;
    white-space: nowrap;
  }
  .tl-sug-row {
    display: flex;
    align-items: center;
    padding: 0.2rem 0.25rem;
    gap: 0.18rem;
  }
  .sug-btn {
    padding: 0 0.28rem;
    border-radius: var(--radius-xs, 3px);
    border: 1px solid;
    background: none;
    cursor: pointer;
    font-size: 0.78rem;
    line-height: 1.5;
    flex-shrink: 0;
  }
  .sug-check { color: var(--color-active-dark, #15803d); border-color: var(--color-active, #16a34a); }
  .sug-check:hover { background: var(--color-active-light, #dcfce7); }
  .sug-x { color: var(--color-danger, #b91c1c); border-color: var(--color-danger, #b91c1c); }
  .sug-x:hover { background: var(--color-danger-light, #fee2e2); }
  .sug-comment {
    font-size: 0.82rem;
    color: var(--color-text-1, #555);
    padding: 0 0.25rem;
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
  }


</style>
