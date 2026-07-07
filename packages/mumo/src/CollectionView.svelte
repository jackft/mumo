<script lang="ts">
  import { buildPermalink, docKeyForPath } from '@mumo/core'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import type { PermalinkRefType } from '@mumo/core'
  import type {
    CollectionQuery, CollectionBookmark, CollectionSearchResult, FolderDocument,
    CollectionUtterance, UtteranceSearchResult, CollectionPattern, PatternSearchResult,
    SequenceQuery, SequenceHit, SequenceSearchResult,
    UttCondition, CompositeUttQuery, MetricFacet, SavedQuery,
    CollectionAnnotation, AnnotationSearchResult, TierRelation, TierOverlapQuery, TierOverlapHit, TierOverlapSearchResult,
    AnnCondition, CompositeAnnQuery, CollectionDef, CollectionItem,
  } from './collectionTypes.js'

  let {
    onOpenBookmark,
    onOpenAtTime,
    onClose,
    visible = true,
    focusRequest = { id: null, n: 0 },
    activeCollectionId = $bindable(null as number | null),
    onActiveCollectionChange,
    appIconUrl = '/mumo.svg',
  }: {
    onOpenBookmark: (filePath: string, bmId: string) => void
    onOpenAtTime: (filePath: string, timeS: number) => void
    onClose: () => void
    visible?: boolean
    focusRequest?: { id: number | null; n: number }
    activeCollectionId?: number | null
    onActiveCollectionChange?: (name: string | null) => void
    appIconUrl?: string
  } = $props()

  type ElectronAPI = {
    collectionGetFolders(): Promise<unknown>
    collectionGetFolderDocuments(): Promise<unknown>
    collectionSync(): Promise<unknown>
    collectionSearch(q: unknown): Promise<unknown>
    collectionSearchUtterances(q: unknown): Promise<unknown>
    collectionSearchPatterns(q: unknown): Promise<unknown>
    collectionSearchSequences(q: unknown): Promise<unknown>
    collectionSearchUtterancesComposite(q: unknown): Promise<unknown>
    collectionGetMetricFacets(schemaName: string): Promise<unknown>
    collectionGetSlotNames(schemaName?: string): Promise<unknown>
    collectionSavedQueriesList(): Promise<unknown>
    collectionSavedQueriesSave(name: string, queryJson: string): Promise<unknown>
    collectionSavedQueriesDelete(id: number): Promise<unknown>
    collectionSearchAnnotations(q: unknown): Promise<unknown>
    collectionSearchTierOverlaps(q: unknown): Promise<unknown>
    collectionGetTierNames(): Promise<unknown>
    collectionSearchAnnotationsComposite(q: unknown): Promise<unknown>
    collectionSetsList(): Promise<unknown>
    collectionSetsCreate(name: string): Promise<unknown>
    collectionSetsDelete(id: number): Promise<unknown>
    collectionSetsAddItem(collectionId: number, item: unknown): Promise<unknown>
    collectionSetsItems(collectionId: number): Promise<unknown>
    collectionSetsRemoveItem(itemId: number): Promise<unknown>
    collectionOpenPermalink(link: string): Promise<unknown>
    collectionGetSpeakers(): Promise<unknown>
    collectionGetSchemaNames(): Promise<unknown>
    collectionAddFolder(): Promise<unknown>
    collectionRemoveFolder(path: string): Promise<unknown>
  }
  const isElectron = typeof window !== 'undefined' && !!(window as unknown as Record<string, unknown>)['electronAPI']
  const api: ElectronAPI | null = isElectron
    ? (window as unknown as { electronAPI: ElectronAPI }).electronAPI
    : null

  // Tree state
  let folders         = $state<string[]>([])
  let folderDocs      = $state<FolderDocument[]>([])
  let expandedFolders = $state<Set<string>>(new Set())
  let selectedFolder  = $state<string | null>(null)
  let selectedDoc     = $state<string | null>(null)   // docPath

  // Search state
  type ResultKind = 'bookmarks' | 'utterances' | 'annotations' | 'patterns'
  const PAGE_SIZE = 50
  let resultKind  = $state<ResultKind>('utterances')
  let searchText  = $state('')
  let page        = $state(0)
  let results     = $state<CollectionSearchResult>({ total: 0, items: [] })
  let uttResults  = $state<UtteranceSearchResult>({ total: 0, items: [] })
  let patResults  = $state<PatternSearchResult>({ total: 0, items: [] })
  let seqResults  = $state<SequenceSearchResult>({ total: 0, items: [] })
  let annResults  = $state<AnnotationSearchResult>({ total: 0, items: [] })
  let ovlResults  = $state<TierOverlapSearchResult>({ total: 0, items: [] })
  let syncing     = $state(false)
  let syncMsg     = $state('')

  // Advanced (sequence) search: utterance matching A followed by one matching B
  let advancedOpen     = $state(false)
  let searchTextB      = $state('')
  let withinUtts       = $state(3)
  let selectedSpeakerB = $state<string>('')   // '' = all

  // Composite filters (utterances tab): OR-groups of AND-conditions
  interface FilterRow {
    kind:       'contains' | 'speaker' | 'pattern' | 'tier'
    text:       string
    speaker:    string
    schemaName: string
    slotName:   string
    tierName:   string
    tierText:   string
  }
  const blankRow = (): FilterRow => ({ kind: 'contains', text: '', speaker: '', schemaName: '', slotName: '', tierName: '', tierText: '' })
  let filtersOpen  = $state(false)
  let filterGroups = $state<FilterRow[][]>([[blankRow()]])
  let slotNameCache = $state<Record<string, string[]>>({})

  async function ensureSlotNames(schemaName: string) {
    if (!api || schemaName in slotNameCache) return
    const names = await api.collectionGetSlotNames(schemaName || undefined) as string[]
    slotNameCache = { ...slotNameCache, [schemaName]: names }
  }

  function rowToCondition(r: FilterRow): UttCondition | null {
    if (r.kind === 'contains') return r.text.trim() ? { text: r.text.trim() } : null
    if (r.kind === 'speaker')  return r.speaker ? { speaker: r.speaker } : null
    if (r.kind === 'tier') return {
      tier: {
        ...(r.tierName ? { tierName: r.tierName } : {}),
        ...(r.tierText.trim() ? { text: r.tierText.trim() } : {}),
      },
    }
    return {
      pattern: {
        ...(r.schemaName ? { schemaName: r.schemaName } : {}),
        ...(r.slotName ? { slotName: r.slotName } : {}),
      },
    }
  }

  // Metric filters (patterns tab, per selected schema)
  let metricFacets = $state<MetricFacet[]>([])
  let metricSel    = $state<Record<string, string>>({})   // metric name → value ('' = any)

  async function loadMetricFacets(schemaName: string) {
    if (!api || !schemaName) { metricFacets = []; metricSel = {}; return }
    metricFacets = await api.collectionGetMetricFacets(schemaName) as MetricFacet[]
    metricSel = {}
  }

  // Saved queries (per-library)
  let savedQueries = $state<SavedQuery[]>([])
  let savingName   = $state<string | null>(null)   // non-null = save input open

  async function loadSavedQueries() {
    if (!api) return
    savedQueries = await api.collectionSavedQueriesList() as SavedQuery[]
  }

  interface SavedState {
    resultKind: ResultKind
    searchText: string
    advancedOpen: boolean
    searchTextB: string
    withinUtts: number
    selectedSpeaker: string
    selectedSpeakerB: string
    selectedSchema: string
    metricSel: Record<string, string>
    filtersOpen: boolean
    filterGroups: FilterRow[][]
    selectedFolder: string | null
    selectedDoc: string | null
    selectedTier?: string
    useRegex?: boolean
    annFiltersOpen?: boolean
    annFilterGroups?: AnnRow[][]
    overlapOpen?: boolean
    overlapRelation?: TierRelation
    overlapTierB?: string
    overlapTextB?: string
    overlapWindowSec?: number
  }

  function currentState(): SavedState {
    return {
      resultKind, searchText, advancedOpen, searchTextB, withinUtts,
      selectedSpeaker, selectedSpeakerB, selectedSchema,
      metricSel: { ...metricSel },
      filtersOpen,
      filterGroups: filterGroups.map(g => g.map(r => ({ ...r }))),
      selectedFolder, selectedDoc,
      selectedTier, overlapOpen, overlapRelation, overlapTierB, overlapTextB, overlapWindowSec,
      useRegex, annFiltersOpen,
      annFilterGroups: annFilterGroups.map(g => g.map(r => ({ ...r }))),
    }
  }

  async function commitSaveQuery() {
    const name = savingName?.trim()
    if (!api || !name) { savingName = null; return }
    await api.collectionSavedQueriesSave(name, JSON.stringify(currentState()))
    savingName = null
    await loadSavedQueries()
  }

  async function applySavedQuery(sq: SavedQuery) {
    let st: SavedState
    try { st = JSON.parse(sq.queryJson) as SavedState } catch { return }
    resultKind       = st.resultKind
    searchText       = st.searchText
    advancedOpen     = st.advancedOpen
    searchTextB      = st.searchTextB
    withinUtts       = st.withinUtts
    selectedSpeaker  = st.selectedSpeaker
    selectedSpeakerB = st.selectedSpeakerB
    selectedSchema   = st.selectedSchema
    filtersOpen      = st.filtersOpen
    filterGroups     = st.filterGroups.length > 0 ? st.filterGroups : [[blankRow()]]
    selectedFolder   = st.selectedFolder
    selectedDoc      = st.selectedDoc
    selectedTier     = st.selectedTier ?? ''
    overlapOpen      = st.overlapOpen ?? false
    overlapRelation  = st.overlapRelation ?? 'overlaps'
    overlapTierB     = st.overlapTierB ?? ''
    overlapTextB     = st.overlapTextB ?? ''
    overlapWindowSec = st.overlapWindowSec ?? 1
    useRegex         = st.useRegex ?? false
    annFiltersOpen   = st.annFiltersOpen ?? false
    annFilterGroups  = st.annFilterGroups?.length ? st.annFilterGroups : [[blankAnnRow()]]
    for (const g of filterGroups) for (const r of g) {
      if (r.kind === 'pattern') void ensureSlotNames(r.schemaName)
    }
    if (st.resultKind === 'patterns' && st.selectedSchema) {
      await loadMetricFacets(st.selectedSchema)
      metricSel = { ...st.metricSel }
    }
    newSearch()
  }

  async function removeSavedQuery(id: number) {
    if (!api) return
    await api.collectionSavedQueriesDelete(id)
    await loadSavedQueries()
  }

  // Facets
  let speakerOptions = $state<string[]>([])
  let schemaOptions  = $state<string[]>([])
  let tierOptions    = $state<string[]>([])
  let selectedSpeaker = $state<string>('')   // '' = all
  let selectedSchema  = $state<string>('')   // '' = all
  let selectedTier    = $state<string>('')   // '' = all

  // Cross-tier overlap search (annotations tab, ELAN multiple-layer style)
  let overlapOpen      = $state(false)
  let overlapRelation  = $state<TierRelation>('overlaps')
  let overlapTierB     = $state<string>('')
  let overlapTextB     = $state('')
  let overlapWindowSec = $state(1)

  // Regex mode: text inputs are JS regexes instead of FTS expressions
  let useRegex = $state(false)

  // Composite filters (annotations tab)
  interface AnnRow {
    kind:        'value' | 'tier' | 'participant' | 'near'
    value:       string
    tierName:    string
    participant: string
    nearTier:    string
    nearRelation: TierRelation
    nearWindow:  number
    nearText:    string
  }
  const blankAnnRow = (): AnnRow => ({ kind: 'value', value: '', tierName: '', participant: '', nearTier: '', nearRelation: 'overlaps', nearWindow: 1, nearText: '' })
  let annFiltersOpen  = $state(false)
  let annFilterGroups = $state<AnnRow[][]>([[blankAnnRow()]])

  function annRowToCondition(r: AnnRow): AnnCondition | null {
    if (r.kind === 'value')       return r.value.trim() ? { value: r.value.trim() } : null
    if (r.kind === 'tier')        return r.tierName ? { tierName: r.tierName } : null
    if (r.kind === 'participant') return r.participant ? { participant: r.participant } : null
    if (r.nearRelation !== 'neighbors' && !r.nearTier) return null
    return {
      near: {
        tierName: r.nearTier,
        relation: r.nearRelation,
        ...(r.nearRelation === 'within' || r.nearRelation === 'neighbors' ? { windowSec: r.nearWindow } : {}),
        ...(r.nearText.trim() ? { text: r.nearText.trim() } : {}),
      },
    }
  }

  // Curated collections
  let collections = $state<CollectionDef[]>([])
  let viewingCollection = $state<CollectionDef | null>(null)
  let collectionItems = $state<CollectionItem[]>([])
  // item pending "add to collection" (chooser strip shows while non-null)
  type AddItem = { kind: string; docPath: string; refId?: string | null; startS?: number | null; endS?: number | null; label?: string | null }
  let addingItem = $state<AddItem | null>(null)
  let newCollectionName = $state('')

  // Active collection: the "playlist" — + buttons add directly to it without the strip
  const _activeCollection = $derived(collections.find(c => c.id === activeCollectionId) ?? null)
  $effect(() => { onActiveCollectionChange?.(_activeCollection?.name ?? null) })

  // Persist the active playlist across sessions. The saved value is captured
  // synchronously at init (before the persist effect can clear it) and applied
  // in load() once the collections list is known.
  const ACTIVE_COLL_KEY = 'mumo.activeCollectionId'
  let _pendingActiveRestore: number | null = (() => {
    try {
      const s = localStorage.getItem(ACTIVE_COLL_KEY)
      return s != null ? Number(s) : null
    } catch { return null }
  })()
  $effect(() => {
    try {
      if (activeCollectionId == null) localStorage.removeItem(ACTIVE_COLL_KEY)
      else localStorage.setItem(ACTIVE_COLL_KEY, String(activeCollectionId))
    } catch { /* storage unavailable */ }
  })

  // Transient "added to X" feedback in the status bar
  let addedMsg = $state<string | null>(null)
  let _addedTimer: ReturnType<typeof setTimeout> | null = null
  function flashAdded(name: string) {
    addedMsg = `added to ${name}`
    if (_addedTimer) clearTimeout(_addedTimer)
    _addedTimer = setTimeout(() => addedMsg = null, 1500)
  }

  const addTitle = $derived(_activeCollection ? `Add to "${_activeCollection.name}"` : 'Add to collection…')

  // Inline collection creation in the sidebar
  let creatingCollection = $state(false)
  let creatingCollectionName = $state('')
  let createCollInputEl = $state<HTMLInputElement | null>(null)

  $effect(() => {
    if (creatingCollection && createCollInputEl) createCollInputEl.focus()
  })

  async function loadCollections() {
    if (!api) return
    collections = await api.collectionSetsList() as CollectionDef[]
  }

  async function addToCollection(collectionId: number) {
    if (!api || !addingItem) return
    await api.collectionSetsAddItem(collectionId, addingItem)
    addingItem = null
    await loadCollections()
    if (viewingCollection?.id === collectionId) await openCollection(viewingCollection)
    const name = collections.find(c => c.id === collectionId)?.name
    if (name) flashAdded(name)
  }

  async function addToNewCollection() {
    if (!api || !addingItem || !newCollectionName.trim()) return
    const id = await api.collectionSetsCreate(newCollectionName.trim()) as number
    newCollectionName = ''
    await addToCollection(id)
    activeCollectionId = id
  }

  async function openCollection(c: CollectionDef) {
    if (!api) return
    viewingCollection = c
    collectionItems = await api.collectionSetsItems(c.id) as CollectionItem[]
  }

  async function removeCollection(id: number) {
    if (!api) return
    await api.collectionSetsDelete(id)
    if (viewingCollection?.id === id) viewingCollection = null
    if (activeCollectionId === id) activeCollectionId = null
    await loadCollections()
  }

  async function removeItem(itemId: number) {
    if (!api || !viewingCollection) return
    await api.collectionSetsRemoveItem(itemId)
    await openCollection(viewingCollection)
    await loadCollections()
  }

  let deletingCollection = $state<CollectionDef | null>(null)

  function confirmRemoveCollection(c: CollectionDef) {
    if (c.itemCount > 0) { deletingCollection = c }
    else void removeCollection(c.id)
  }

  function setActiveCollection(id: number) {
    activeCollectionId = activeCollectionId === id ? null : id
  }

  function startCreateCollection() {
    creatingCollection = true
    creatingCollectionName = ''
  }

  async function commitCreateCollection() {
    const name = creatingCollectionName.trim()
    if (!api || !name) { creatingCollection = false; return }
    const id = await api.collectionSetsCreate(name) as number
    creatingCollection = false
    creatingCollectionName = ''
    await loadCollections()
    activeCollectionId = id
  }

  // Add item directly to active collection, or fall back to the "Add to:" strip
  async function addItemToCollection(item: AddItem) {
    if (activeCollectionId != null) {
      if (!api) return
      const name = _activeCollection?.name
      await api.collectionSetsAddItem(activeCollectionId, item)
      await loadCollections()
      if (viewingCollection?.id === activeCollectionId) await openCollection(viewingCollection!)
      if (name) flashAdded(name)
    } else {
      addingItem = item
    }
  }

  const groupedItems = $derived(() => groupByDoc(collectionItems.map(i => ({ ...i, docTitle: i.docTitle }))))

  // Permalinks
  let linkCopied = $state(false)
  function _copy(mainPart: string) {
    void navigator.clipboard.writeText(`mumo://${mainPart}`).then(() => {
      linkCopied = true
      setTimeout(() => linkCopied = false, 1500)
    })
  }
  /** Copy a doc link, optionally anchored to a stable ref, with a ?t= fallback. */
  function copyLink(docPath: string, t: number | null | undefined, ref?: { type: PermalinkRefType; id: string }) {
    _copy(buildPermalink({
      kind: 'doc',
      docKey: docKeyForPath(docPath),
      ...(ref ? { ref } : {}),
      ...(t != null ? { t } : {}),
    }))
  }
  function copyCollectionLink(id: number) {
    _copy(buildPermalink({ kind: 'collection', id }))
  }

  // Paste-to-jump: accepts mumo://…, https://…, or the bare main part
  let pasteLink = $state('')
  let pasteFailed = $state(false)
  async function goToLink() {
    if (!api || !pasteLink.trim()) return
    const ok = await api.collectionOpenPermalink(pasteLink.trim()) as boolean
    pasteFailed = !ok
    if (ok) pasteLink = ''
    else setTimeout(() => pasteFailed = false, 2000)
  }

  // focus a collection when a collection permalink arrives
  $effect(() => {
    const req = focusRequest
    if (req.n === 0 || req.id == null) return
    void (async () => {
      await loadCollections()
      const c = collections.find(x => x.id === req.id)
      if (c) await openCollection(c)
    })()
  })

  let searchDebounce: ReturnType<typeof setTimeout> | null = null

  async function load() {
    if (!api) return
    folders    = await api.collectionGetFolders() as string[]
    folderDocs = await api.collectionGetFolderDocuments() as FolderDocument[]
    expandedFolders = new Set(folders)
    await loadFacets()
    await loadSavedQueries()
    await loadCollections()
    // Restore the persisted active playlist (once, if it still exists)
    if (activeCollectionId == null && _pendingActiveRestore != null) {
      if (collections.some(c => c.id === _pendingActiveRestore)) activeCollectionId = _pendingActiveRestore
    }
    _pendingActiveRestore = null
    // Items may have been added from the editor while this view was hidden
    if (viewingCollection) {
      const c = collections.find(x => x.id === viewingCollection!.id)
      if (c) await openCollection(c)
      else viewingCollection = null
    }
    void ensureSlotNames('')
    await runSearch()
    syncInBackground()
  }

  async function loadFacets() {
    if (!api) return
    speakerOptions = await api.collectionGetSpeakers() as string[]
    schemaOptions  = await api.collectionGetSchemaNames() as string[]
    tierOptions    = await api.collectionGetTierNames() as string[]
  }

  async function syncInBackground() {
    if (!api) return
    syncing = true; syncMsg = 'Syncing…'
    try {
      const res = await api.collectionSync() as { scanned: number; updated: number; removed: number }
      syncMsg = res.updated > 0 || res.removed > 0
        ? `Updated ${res.updated} file${res.updated !== 1 ? 's' : ''}`
        : ''
      if (res.updated > 0 || res.removed > 0) {
        folders    = await api.collectionGetFolders() as string[]
        folderDocs = await api.collectionGetFolderDocuments() as FolderDocument[]
        await loadFacets()
        await runSearch()
      }
    } finally { syncing = false }
  }

  const sequenceMode = $derived(
    resultKind === 'utterances' && advancedOpen && !!searchText.trim() && !!searchTextB.trim()
  )

  const compositeGroups = $derived.by(() => {
    if (resultKind !== 'utterances' || !filtersOpen) return []
    const groups: UttCondition[][] = []
    for (const g of filterGroups) {
      const conds = g.map(rowToCondition).filter((c): c is UttCondition => c !== null)
      // the main search box ANDs into every group
      if (searchText.trim()) conds.unshift({ text: searchText.trim() })
      if (conds.length > 0) groups.push(conds)
    }
    return groups
  })
  const compositeMode = $derived(!sequenceMode && compositeGroups.length > 0)

  const overlapMode = $derived(
    resultKind === 'annotations' && overlapOpen && !!selectedTier && (!!overlapTierB || overlapRelation === 'neighbors')
  )

  const compositeAnnGroups = $derived.by(() => {
    if (resultKind !== 'annotations' || !annFiltersOpen) return []
    const groups: AnnCondition[][] = []
    for (const g of annFilterGroups) {
      const conds = g.map(annRowToCondition).filter((c): c is AnnCondition => c !== null)
      if (searchText.trim()) conds.unshift({ value: searchText.trim() })
      if (conds.length > 0) groups.push(conds)
    }
    return groups
  })
  const compositeAnnMode = $derived(!overlapMode && compositeAnnGroups.length > 0)

  // Monotonic request id: a stale (slower) response must never overwrite a newer one
  let _searchReq = 0

  async function runSearch() {
    if (!api) return
    const req = ++_searchReq
    if (overlapMode) {
      const oq: TierOverlapQuery = {
        tierA: selectedTier,
        ...(searchText.trim() ? { textA: searchText.trim() } : {}),
        tierB: overlapTierB,
        ...(overlapTextB.trim() ? { textB: overlapTextB.trim() } : {}),
        relation: overlapRelation,
        ...(overlapRelation === 'within' || overlapRelation === 'neighbors' ? { windowSec: overlapWindowSec } : {}),
        ...(useRegex ? { useRegex: true } : {}),
        ...(selectedFolder != null ? { folder: selectedFolder } : {}),
        ...(selectedDoc != null ? { docPath: selectedDoc } : {}),
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }
      const r = await api.collectionSearchTierOverlaps(oq) as TierOverlapSearchResult
      if (req === _searchReq) ovlResults = r
      return
    }
    if (compositeAnnMode) {
      const caq: CompositeAnnQuery = {
        groups: compositeAnnGroups,
        ...(useRegex ? { useRegex: true } : {}),
        ...(selectedFolder != null ? { folder: selectedFolder } : {}),
        ...(selectedDoc != null ? { docPath: selectedDoc } : {}),
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }
      const r = await api.collectionSearchAnnotationsComposite(caq) as AnnotationSearchResult
      if (req === _searchReq) annResults = r
      return
    }
    if (resultKind === 'annotations') {
      const aq: CollectionQuery = {
        ...(searchText.trim() ? { text: searchText.trim() } : {}),
        ...(useRegex ? { useRegex: true } : {}),
        ...(selectedFolder != null ? { folder: selectedFolder } : {}),
        ...(selectedDoc != null ? { docPath: selectedDoc } : {}),
        ...(selectedTier ? { tierNames: [selectedTier] } : {}),
        ...(selectedSpeaker ? { speakers: [selectedSpeaker] } : {}),
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }
      const r = await api.collectionSearchAnnotations(aq) as AnnotationSearchResult
      if (req === _searchReq) annResults = r
      return
    }
    if (compositeMode) {
      const cq: CompositeUttQuery = {
        groups: compositeGroups,
        ...(selectedFolder != null ? { folder: selectedFolder } : {}),
        ...(selectedDoc != null ? { docPath: selectedDoc } : {}),
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }
      const r = await api.collectionSearchUtterancesComposite(cq) as UtteranceSearchResult
      if (req === _searchReq) uttResults = r
      return
    }
    if (sequenceMode) {
      const sq: SequenceQuery = {
        textA: searchText.trim(),
        textB: searchTextB.trim(),
        withinUtts,
        ...(useRegex ? { useRegex: true } : {}),
        ...(selectedSpeaker  ? { speakersA: [selectedSpeaker] }  : {}),
        ...(selectedSpeakerB ? { speakersB: [selectedSpeakerB] } : {}),
        ...(selectedFolder != null ? { folder: selectedFolder } : {}),
        ...(selectedDoc != null ? { docPath: selectedDoc } : {}),
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }
      const r = await api.collectionSearchSequences(sq) as SequenceSearchResult
      if (req === _searchReq) seqResults = r
      return
    }
    const q: CollectionQuery = {
      ...(searchText.trim() ? { text: searchText.trim() } : {}),
      ...(useRegex && resultKind === 'utterances' ? { useRegex: true } : {}),
      ...(selectedFolder != null ? { folder: selectedFolder } : {}),
      ...(selectedDoc != null ? { docPath: selectedDoc } : {}),
      ...(selectedSpeaker ? { speakers: [selectedSpeaker] } : {}),
      ...(selectedSchema ? { schemaNames: [selectedSchema] } : {}),
      ...(resultKind === 'patterns'
        ? { metrics: Object.entries(metricSel).filter(([, v]) => v !== '').map(([name, v]) => ({ name, values: [v] })) }
        : {}),
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }
    if (resultKind === 'bookmarks') {
      const r = await api.collectionSearch(q) as CollectionSearchResult
      if (req === _searchReq) results = r
    } else if (resultKind === 'utterances') {
      const r = await api.collectionSearchUtterances(q) as UtteranceSearchResult
      if (req === _searchReq) uttResults = r
    } else {
      const r = await api.collectionSearchPatterns(q) as PatternSearchResult
      if (req === _searchReq) patResults = r
    }
  }

  /** Any change to the query resets to page 0. */
  function newSearch() {
    page = 0
    void runSearch()
  }

  function setKind(k: ResultKind) {
    resultKind = k
    viewingCollection = null
    newSearch()
  }

  function setPage(p: number) {
    page = Math.max(0, Math.min(p, pageCount - 1))
    void runSearch()
  }

  const totalCount = $derived(
    overlapMode ? ovlResults.total
    : resultKind === 'annotations' ? annResults.total
    : sequenceMode ? seqResults.total
    : resultKind === 'bookmarks' ? results.total
    : resultKind === 'utterances' ? uttResults.total
    : patResults.total
  )
  const pageCount = $derived(Math.max(1, Math.ceil(totalCount / PAGE_SIZE)))
  const searchError = $derived(
    overlapMode ? ovlResults.error
    : resultKind === 'annotations' ? annResults.error
    : sequenceMode ? seqResults.error
    : resultKind === 'bookmarks' ? results.error
    : resultKind === 'utterances' ? uttResults.error
    : patResults.error
  )

  function onSearchInput() {
    if (searchDebounce) clearTimeout(searchDebounce)
    searchDebounce = setTimeout(() => { newSearch() }, 200)
  }

  async function addFolder() {
    if (!api) return
    const added = await api.collectionAddFolder() as string | null
    if (added) {
      folders    = await api.collectionGetFolders() as string[]
      folderDocs = await api.collectionGetFolderDocuments() as FolderDocument[]
      expandedFolders = new Set([...expandedFolders, added])
      await syncInBackground()
    }
  }

  async function removeFolder(path: string) {
    if (!api) return
    await api.collectionRemoveFolder(path)
    folders    = await api.collectionGetFolders() as string[]
    folderDocs = await api.collectionGetFolderDocuments() as FolderDocument[]
    if (selectedFolder === path) { selectedFolder = null; selectedDoc = null }
    await runSearch()
  }

  function toggleFolder(path: string) {
    const next = new SvelteSet(expandedFolders)
    if (next.has(path)) next.delete(path); else next.add(path)
    expandedFolders = next
  }

  function selectFolder(path: string) {
    if (selectedFolder === path && selectedDoc === null) {
      selectedFolder = null
    } else {
      selectedFolder = path
      selectedDoc    = null
    }
    newSearch()
  }

  function selectDoc(docPath: string, folderPath: string) {
    if (selectedDoc === docPath) {
      selectedDoc    = null
      selectedFolder = null
    } else {
      selectedDoc    = docPath
      selectedFolder = folderPath
    }
    newSearch()
  }

  // Group folderDocs by folder path
  const tree = $derived(() => {
    const map = new SvelteMap<string, FolderDocument[]>()
    for (const fd of folderDocs) {
      let arr = map.get(fd.folderPath)
      if (!arr) { arr = []; map.set(fd.folderPath, arr) }
      arr.push(fd)
    }
    return map
  })

  // Group results by document
  function groupByDoc<T extends { docPath: string; docTitle: string | null }>(items: T[]) {
    const map = new SvelteMap<string, { docPath: string; docTitle: string | null; items: T[] }>()
    for (const item of items) {
      if (!map.has(item.docPath)) map.set(item.docPath, { docPath: item.docPath, docTitle: item.docTitle, items: [] })
      map.get(item.docPath)!.items.push(item)
    }
    return [...map.values()]
  }
  const grouped    = $derived(() => groupByDoc<CollectionBookmark>(results.items))
  const groupedSeq = $derived(() => groupByDoc<SequenceHit>(seqResults.items))
  const groupedAnn = $derived(() => groupByDoc<CollectionAnnotation>(annResults.items))
  const groupedOvl = $derived(() => groupByDoc<TierOverlapHit>(ovlResults.items))
  const groupedUtt = $derived(() => groupByDoc<CollectionUtterance>(uttResults.items))
  const groupedPat = $derived(() => groupByDoc<CollectionPattern>(patResults.items))

  function formatTime(s: number): string {
    const m = Math.floor(s / 60)
    const sec = (s % 60).toFixed(1).padStart(4, '0')
    return `${m}:${sec}`
  }

  function basename(p: string): string {
    return p.split(/[/\\]/).pop() ?? p
  }

  $effect(() => { if (visible) void load() })
</script>

<svelte:window onkeydown={(e) => {
  const dc = deletingCollection
  if (!dc) return
  if (e.key === 'Escape') { e.preventDefault(); deletingCollection = null }
  if (e.key === 'Enter')  { e.preventDefault(); void removeCollection(dc.id); deletingCollection = null }
}} />

<div class="cv-titlebar" style="display: {visible ? '' : 'none'}">
  <img src={appIconUrl} class="cv-titlebar-icon" alt="mumo" aria-hidden="true" />
  <span class="cv-titlebar-title">Collections</span>
  <div class="cv-titlebar-spacer"></div>
  <button class="cv-editor-btn" onclick={onClose}>← Editor</button>
</div>

<div class="collection-view" style="display: {visible ? 'flex' : 'none'}">

  <!-- Sidebar: folder/file tree + collections -->
  <aside class="cv-sidebar">

    <div class="cv-sidebar-header">
      <span class="cv-sidebar-label">Corpora</span>
      <button class="cv-add-btn" onclick={addFolder} title="Add folder">+</button>
    </div>
    <div class="cv-tree">
      {#if folders.length === 0}
        <div class="cv-tree-empty">No folders added</div>
      {:else}
        <button
          class="cv-tree-all"
          class:cv-selected={selectedFolder === null && selectedDoc === null}
          onclick={() => { selectedFolder = null; selectedDoc = null; newSearch() }}
        >All</button>

        {#each folders as folder (folder)}
          {@const docs = tree().get(folder) ?? []}
          {@const expanded = expandedFolders.has(folder)}
          {@const folderActive = selectedFolder === folder && selectedDoc === null}

          <div class="cv-folder-row">
            <button class="cv-expand-btn" onclick={() => toggleFolder(folder)} title={expanded ? 'Collapse' : 'Expand'}>
              {expanded ? '▾' : '▸'}
            </button>
            <button
              class="cv-folder-label"
              class:cv-selected={folderActive}
              onclick={() => selectFolder(folder)}
              title={folder}
            >{basename(folder)}</button>
            <button class="cv-remove-btn" onclick={() => removeFolder(folder)} title="Remove">×</button>
          </div>

          {#if expanded}
            {#if docs.length === 0}
              <div class="cv-no-files">no files indexed</div>
            {:else}
              {#each docs as doc (doc.docPath)}
                <button
                  class="cv-file-row"
                  class:cv-selected={selectedDoc === doc.docPath}
                  onclick={() => selectDoc(doc.docPath, folder)}
                  title={doc.docPath}
                >{doc.docTitle ?? basename(doc.docPath)}</button>
              {/each}
            {/if}
          {/if}
        {/each}
      {/if}
    </div>

    <div class="cv-sidebar-header cv-section-divider">
      <span class="cv-sidebar-label">Collections</span>
      <button class="cv-add-btn" onclick={startCreateCollection} title="New collection">+</button>
    </div>
    {#if creatingCollection}
      <div class="cv-create-coll-row">
        <input
          class="cv-create-coll-input"
          type="text"
          placeholder="Collection name…"
          bind:this={createCollInputEl}
          bind:value={creatingCollectionName}
          onkeydown={(e) => { if (e.key === 'Enter') void commitCreateCollection(); if (e.key === 'Escape') creatingCollection = false }}
        />
        <button class="cv-add-btn" onclick={() => void commitCreateCollection()} title="Create">✓</button>
        <button class="cv-row-del" onclick={() => creatingCollection = false}>×</button>
      </div>
    {/if}
    <div class="cv-coll-list">
      {#if collections.length === 0 && !creatingCollection}
        <div class="cv-tree-empty">No collections yet</div>
      {/if}
      {#each collections as c (c.id)}
        <div class="cv-saved-row">
          <button
            class="cv-coll-radio"
            class:cv-coll-radio-on={activeCollectionId === c.id}
            onclick={(e) => { e.stopPropagation(); setActiveCollection(c.id) }}
            title={activeCollectionId === c.id ? 'Deactivate playlist' : 'Set as active playlist — + adds here'}
          ></button>
          <button class="cv-saved-name" class:cv-selected={viewingCollection?.id === c.id} title={c.name}
            onclick={() => { if (viewingCollection?.id === c.id) { viewingCollection = null } else { void openCollection(c) } }}
          >{c.name} <span class="cv-count">({c.itemCount})</span></button>
          <button class="cv-remove-btn" title="Delete collection" onclick={() => confirmRemoveCollection(c)}>×</button>
        </div>
      {/each}
    </div>

    {#if savedQueries.length > 0}
      <div class="cv-sidebar-header cv-section-divider">
        <span class="cv-sidebar-label">Saved queries</span>
      </div>
      <div class="cv-saved-list">
        {#each savedQueries as sq (sq.id)}
          <div class="cv-saved-row">
            <button class="cv-saved-name" title={sq.name} onclick={() => void applySavedQuery(sq)}>{sq.name}</button>
            <button class="cv-remove-btn" title="Delete saved query" onclick={() => void removeSavedQuery(sq.id)}>×</button>
          </div>
        {/each}
      </div>
    {/if}

  </aside>

  <!-- Main panel -->
  <div class="cv-main">
    <div class="cv-toolbar">
      <div class="cv-kind-tabs">
        <button class="cv-kind-tab" class:cv-kind-active={resultKind === 'utterances'}  onclick={() => setKind('utterances')}>Utterances</button>
        <button class="cv-kind-tab" class:cv-kind-active={resultKind === 'annotations'} onclick={() => setKind('annotations')}>Annotations</button>
        <button class="cv-kind-tab" class:cv-kind-active={resultKind === 'patterns'}    onclick={() => setKind('patterns')}>Patterns</button>
        <button class="cv-kind-tab" class:cv-kind-active={resultKind === 'bookmarks'}   onclick={() => setKind('bookmarks')}>Bookmarks</button>
      </div>
      <input
        class="cv-search"
        type="search"
        placeholder={resultKind === 'utterances' ? 'Search words…'
          : resultKind === 'annotations' ? 'Search annotation values…'
          : resultKind === 'patterns' ? 'Search pattern content…'
          : 'Search labels, notes, transcript…'}
        title="Supports AND, OR, NOT and “quoted phrases”"
        bind:value={searchText}
        oninput={onSearchInput}
      />
      {#if resultKind === 'utterances' || resultKind === 'annotations'}
        <button class="cv-advanced-btn cv-regex-btn" class:cv-advanced-active={useRegex}
          onclick={() => { useRegex = !useRegex; newSearch() }}
          title="Regex mode: text fields are regular expressions">.*</button>
      {/if}
      {#if resultKind !== 'bookmarks'}
        <select class="cv-facet" bind:value={selectedSpeaker} onchange={newSearch} title="Filter by participant">
          <option value="">All participants</option>
          {#each speakerOptions as sp (sp)}<option value={sp}>{sp}</option>{/each}
        </select>
      {/if}
      {#if resultKind === 'annotations'}
        <select class="cv-facet" bind:value={selectedTier} onchange={newSearch} title="Filter by tier">
          <option value="">All tiers</option>
          {#each tierOptions as t (t)}<option value={t}>{t}</option>{/each}
        </select>
        <button class="cv-advanced-btn" class:cv-advanced-active={overlapOpen}
          onclick={() => { overlapOpen = !overlapOpen; if (overlapOpen) annFiltersOpen = false; newSearch() }}
          title="Cross-tier search: annotation related in time to an annotation on another tier">
          {overlapOpen ? '▾' : '▸'} Overlap
        </button>
        <button class="cv-advanced-btn" class:cv-advanced-active={annFiltersOpen}
          onclick={() => { annFiltersOpen = !annFiltersOpen; if (annFiltersOpen) overlapOpen = false; newSearch() }}
          title="Composite filters: combine annotation conditions with AND / OR">
          {annFiltersOpen ? '▾' : '▸'} Filters
        </button>
      {/if}
      {#if resultKind === 'utterances'}
        <button class="cv-advanced-btn" class:cv-advanced-active={advancedOpen}
          onclick={() => { advancedOpen = !advancedOpen; if (advancedOpen) filtersOpen = false; newSearch() }}
          title="Sequence search: utterance followed by utterance">
          {advancedOpen ? '▾' : '▸'} Sequence
        </button>
        <button class="cv-advanced-btn" class:cv-advanced-active={filtersOpen}
          onclick={() => { filtersOpen = !filtersOpen; if (filtersOpen) advancedOpen = false; newSearch() }}
          title="Composite filters: combine conditions with AND / OR">
          {filtersOpen ? '▾' : '▸'} Filters
        </button>
      {/if}
      {#if savingName === null}
        <button class="cv-advanced-btn" onclick={() => savingName = ''} title="Save the current query">Save</button>
      {:else}
        <input
          class="cv-save-name"
          type="text"
          placeholder="Query name…"
          bind:value={savingName}
          onkeydown={(e) => { if (e.key === 'Enter') void commitSaveQuery(); if (e.key === 'Escape') savingName = null }}
        />
        <button class="cv-advanced-btn" onclick={() => void commitSaveQuery()}>✓</button>
      {/if}
      {#if resultKind === 'patterns'}
        <select class="cv-facet" bind:value={selectedSchema}
          onchange={() => { void loadMetricFacets(selectedSchema); newSearch() }} title="Filter by pattern type">
          <option value="">All patterns</option>
          {#each schemaOptions as sc (sc)}<option value={sc}>{sc}</option>{/each}
        </select>
      {/if}
      <input
        class="cv-link-input"
        class:cv-link-failed={pasteFailed}
        type="text"
        placeholder="go to link…"
        title="Paste a permalink (mumo://…, https://…, or doc/…) and press Enter"
        bind:value={pasteLink}
        onkeydown={(e) => { if (e.key === 'Enter') void goToLink(); if (e.key === 'Escape') pasteLink = '' }}
      />
      <button class="cv-sync-btn" onclick={syncInBackground} disabled={syncing} title="Re-sync folders">
        {syncing ? '⟳' : '↺'}
      </button>
    </div>

    {#if resultKind === 'annotations' && overlapOpen}
      <div class="cv-advanced-row">
        <span class="cv-adv-label">{selectedTier || '(pick a tier above)'}</span>
        <select class="cv-facet" bind:value={overlapRelation} onchange={newSearch} title="Temporal / structural relation">
          <option value="overlaps">overlaps</option>
          <option value="inside">is inside</option>
          <option value="within">is within ±N s of</option>
          <option value="neighbors">is within ±N annotations of</option>
        </select>
        {#if overlapRelation === 'within' || overlapRelation === 'neighbors'}
          <input class="cv-adv-num" type="number" min={overlapRelation === 'neighbors' ? 1 : 0} step={overlapRelation === 'neighbors' ? 1 : 0.5} bind:value={overlapWindowSec} onchange={newSearch} title={overlapRelation === 'neighbors' ? 'Max annotation distance' : 'Window in seconds'} />
          <span class="cv-adv-label">{overlapRelation === 'neighbors' ? 'anns of' : 's of'}</span>
        {/if}
        {#if overlapRelation === 'neighbors'}
          <span class="cv-adv-label">(same tier)</span>
        {:else}
          <select class="cv-facet" bind:value={overlapTierB} onchange={newSearch} title="Other tier">
            <option value="">— pick tier —</option>
            {#each tierOptions as t (t)}<option value={t}>{t}</option>{/each}
          </select>
        {/if}
        <input
          class="cv-search cv-adv-input"
          type="search"
          placeholder="matching… (optional)"
          bind:value={overlapTextB}
          oninput={onSearchInput}
        />
      </div>
    {/if}

    {#if resultKind === 'annotations' && annFiltersOpen}
      <div class="cv-filters-panel">
        {#each annFilterGroups as group, gi (gi)}
          {#if gi > 0}<div class="cv-or-divider">— or —</div>{/if}
          <div class="cv-filter-group">
            {#each group as row, ri (ri)}
              <div class="cv-filter-row">
                {#if ri > 0}<span class="cv-adv-label">and</span>{/if}
                <select class="cv-facet" bind:value={row.kind} onchange={newSearch}>
                  <option value="value">value matches</option>
                  <option value="tier">on tier</option>
                  <option value="participant">participant is</option>
                  <option value="near">related to tier</option>
                </select>
                {#if row.kind === 'value'}
                  <input class="cv-search cv-adv-input" type="search" placeholder={useRegex ? 'regex…' : 'words, "phrase", OR, NOT…'}
                    bind:value={row.value} oninput={onSearchInput} />
                {:else if row.kind === 'tier'}
                  <select class="cv-facet" bind:value={row.tierName} onchange={newSearch}>
                    <option value="">— pick tier —</option>
                    {#each tierOptions as t (t)}<option value={t}>{t}</option>{/each}
                  </select>
                {:else if row.kind === 'participant'}
                  <select class="cv-facet" bind:value={row.participant} onchange={newSearch}>
                    <option value="">— pick participant —</option>
                    {#each speakerOptions as sp (sp)}<option value={sp}>{sp}</option>{/each}
                  </select>
                {:else}
                  <select class="cv-facet" bind:value={row.nearRelation} onchange={newSearch}>
                    <option value="overlaps">overlaps</option>
                    <option value="inside">is inside</option>
                    <option value="within">within ±N s of</option>
                    <option value="neighbors">within ±N anns of</option>
                  </select>
                  {#if row.nearRelation === 'within' || row.nearRelation === 'neighbors'}
                    <input class="cv-adv-num" type="number" min="0" bind:value={row.nearWindow} onchange={newSearch} />
                  {/if}
                  {#if row.nearRelation !== 'neighbors'}
                    <select class="cv-facet" bind:value={row.nearTier} onchange={newSearch}>
                      <option value="">— pick tier —</option>
                      {#each tierOptions as t (t)}<option value={t}>{t}</option>{/each}
                    </select>
                  {:else}
                    <span class="cv-adv-label">(same tier)</span>
                  {/if}
                  <input class="cv-search cv-adv-input" type="search" placeholder="matching… (optional)"
                    bind:value={row.nearText} oninput={onSearchInput} />
                {/if}
                <button class="cv-row-del" title="Remove condition"
                  onclick={() => {
                    group.splice(ri, 1)
                    if (group.length === 0) annFilterGroups.splice(gi, 1)
                    if (annFilterGroups.length === 0) annFilterGroups.push([blankAnnRow()])
                    newSearch()
                  }}>×</button>
              </div>
            {/each}
            <div class="cv-filter-actions">
              <button class="cv-mini-btn" onclick={() => { group.push(blankAnnRow()) }}>+ and</button>
              {#if gi === annFilterGroups.length - 1}
                <button class="cv-mini-btn" onclick={() => { annFilterGroups.push([blankAnnRow()]) }}>+ or group</button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}

    {#if resultKind === 'utterances' && filtersOpen}
      <div class="cv-filters-panel">
        {#each filterGroups as group, gi (gi)}
          {#if gi > 0}<div class="cv-or-divider">— or —</div>{/if}
          <div class="cv-filter-group">
            {#each group as row, ri (ri)}
              <div class="cv-filter-row">
                {#if ri > 0}<span class="cv-adv-label">and</span>{/if}
                <select class="cv-facet" bind:value={row.kind} onchange={newSearch}>
                  <option value="contains">contains</option>
                  <option value="speaker">participant is</option>
                  <option value="pattern">in pattern</option>
                  <option value="tier">has annotation</option>
                </select>
                {#if row.kind === 'contains'}
                  <input class="cv-search cv-adv-input" type="search" placeholder="words, &quot;phrase&quot;, OR, NOT…"
                    bind:value={row.text} oninput={onSearchInput} />
                {:else if row.kind === 'speaker'}
                  <select class="cv-facet" bind:value={row.speaker} onchange={newSearch}>
                    <option value="">— pick participant —</option>
                    {#each speakerOptions as sp (sp)}<option value={sp}>{sp}</option>{/each}
                  </select>
                {:else if row.kind === 'tier'}
                  <select class="cv-facet" bind:value={row.tierName} onchange={newSearch}>
                    <option value="">on any tier</option>
                    {#each tierOptions as t (t)}<option value={t}>{t}</option>{/each}
                  </select>
                  <input class="cv-search cv-adv-input" type="search" placeholder="value matches… (optional)"
                    bind:value={row.tierText} oninput={onSearchInput} />
                {:else}
                  <select class="cv-facet" bind:value={row.schemaName}
                    onchange={() => { row.slotName = ''; void ensureSlotNames(row.schemaName); newSearch() }}>
                    <option value="">any pattern type</option>
                    {#each schemaOptions as sc (sc)}<option value={sc}>{sc}</option>{/each}
                  </select>
                  <select class="cv-facet" bind:value={row.slotName} onchange={newSearch}>
                    <option value="">any slot</option>
                    {#each slotNameCache[row.schemaName] ?? [] as sn (sn)}<option value={sn}>{sn}</option>{/each}
                  </select>
                {/if}
                <button class="cv-row-del" title="Remove condition"
                  onclick={() => {
                    group.splice(ri, 1)
                    if (group.length === 0) filterGroups.splice(gi, 1)
                    if (filterGroups.length === 0) filterGroups.push([blankRow()])
                    newSearch()
                  }}>×</button>
              </div>
            {/each}
            <div class="cv-filter-actions">
              <button class="cv-mini-btn" onclick={() => { group.push(blankRow()); }}>+ and</button>
              {#if gi === filterGroups.length - 1}
                <button class="cv-mini-btn" onclick={() => { filterGroups.push([blankRow()]) }}>+ or group</button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}

    {#if resultKind === 'patterns' && selectedSchema && metricFacets.length > 0}
      <div class="cv-advanced-row cv-metric-row">
        {#each metricFacets as mf (mf.name)}
          <label class="cv-metric-filter">
            <span class="cv-adv-label">{mf.name}</span>
            <select class="cv-facet"
              value={metricSel[mf.name] ?? ''}
              onchange={(e) => { metricSel = { ...metricSel, [mf.name]: (e.currentTarget as HTMLSelectElement).value }; newSearch() }}>
              <option value="">any</option>
              {#each mf.values as v (v)}<option value={v}>{v}</option>{/each}
            </select>
          </label>
        {/each}
      </div>
    {/if}

    {#if resultKind === 'utterances' && advancedOpen}
      <div class="cv-advanced-row">
        <span class="cv-adv-label">followed by</span>
        <input
          class="cv-search cv-adv-input"
          type="search"
          placeholder="Search words…"
          bind:value={searchTextB}
          oninput={onSearchInput}
        />
        <select class="cv-facet" bind:value={selectedSpeakerB} onchange={newSearch} title="Participant of the following utterance">
          <option value="">any participant</option>
          {#each speakerOptions as sp (sp)}<option value={sp}>{sp}</option>{/each}
        </select>
        <span class="cv-adv-label">within</span>
        <input class="cv-adv-num" type="number" min="1" max="50" bind:value={withinUtts} onchange={newSearch} />
        <span class="cv-adv-label">utterance{withinUtts !== 1 ? 's' : ''}</span>
      </div>
    {/if}

    <div class="cv-status">
      {#if linkCopied}<span class="cv-sync-msg">link copied</span>{/if}
      {#if addedMsg}<span class="cv-sync-msg">{addedMsg}</span>{/if}
      {#if searchError}<span class="cv-search-error" title={searchError}>invalid query</span>{/if}
      {#if syncMsg}<span class="cv-sync-msg">{syncMsg}</span>{/if}
      {#if !viewingCollection}
        <span class="cv-pager">
          {#if pageCount > 1}
            <button class="cv-page-btn" disabled={page === 0} onclick={() => setPage(page - 1)}>‹</button>
            <span>page {page + 1} / {pageCount}</span>
            <button class="cv-page-btn" disabled={page >= pageCount - 1} onclick={() => setPage(page + 1)}>›</button>
          {/if}
          <span class="cv-total">{totalCount} result{totalCount !== 1 ? 's' : ''}</span>
        </span>
      {/if}
    </div>

    <div class="cv-results">
      {#if viewingCollection}
        <div class="cv-collection-head">
          <span class="cv-collection-title">{viewingCollection.name}</span>
          <span class="cv-total">{collectionItems.length} item{collectionItems.length !== 1 ? 's' : ''}</span>
          <button class="cv-icon-btn" title="Copy collection permalink" onclick={() => copyCollectionLink(viewingCollection!.id)}>🔗</button>
          <button class="cv-mini-btn" onclick={() => viewingCollection = null}>← back to search</button>
        </div>
        {#if collectionItems.length === 0}
          <div class="cv-empty">Empty collection — add items from search results with ＋.</div>
        {:else}
          {#each groupedItems() as group (group.docPath)}
            <div class="cv-doc-group">
              <div class="cv-doc-title">{group.docTitle ?? basename(group.docPath)}</div>
              {#each group.items as item (item.id)}
                <div class="cv-frag-row">
                  <div class="cv-frag-info">
                    <span class="cv-schema-chip">{item.kind}</span>
                    <span class="cv-utt-text" title={item.label ?? ''}>{item.label ?? item.refId ?? ''}</span>
                    {#if item.startS != null && item.endS != null}
                      <span class="cv-frag-time">{formatTime(item.startS)} – {formatTime(item.endS)}</span>
                    {/if}
                  </div>
                  <div class="cv-row-actions">
                    {#if item.startS != null}
                      <button class="cv-frag-open" onclick={() => onOpenAtTime(item.docPath, item.startS ?? 0)}>Open ▶</button>
                      <button class="cv-icon-btn" title="Copy permalink"
                        onclick={() => {
                          const refType = ({ utterance: 'utt', annotation: 'ann', pattern: 'pat', bookmark: 'bm' } as Record<string, PermalinkRefType>)[item.kind]
                          copyLink(item.docPath, item.startS, refType && item.refId ? { type: refType, id: item.refId } : undefined)
                        }}>🔗</button>
                    {/if}
                    <button class="cv-row-del" title="Remove from collection" onclick={() => void removeItem(item.id)}>×</button>
                  </div>
                </div>
              {/each}
            </div>
          {/each}
        {/if}
      {:else if resultKind === 'bookmarks'}
        {#if grouped().length === 0}
          <div class="cv-empty">
            {folders.length === 0
              ? 'Add a folder to start indexing your collection.'
              : 'No bookmarks found.'}
          </div>
        {:else}
          {#each grouped() as group (group.docPath)}
            <div class="cv-doc-group">
              <div class="cv-doc-title">{group.docTitle ?? basename(group.docPath)}</div>
              {#each group.items as item (item.bookmarkId)}
                <div class="cv-frag-row cv-bookmark-row">
                  <div class="cv-frag-info cv-bookmark-info">
                    <div class="cv-bookmark-head">
                      <span class="cv-frag-label">{item.label}</span>
                      <span class="cv-frag-time">{formatTime(item.startS)} – {formatTime(item.endS)}</span>
                      {#if item.code}<span class="cv-frag-code">{item.code}</span>{/if}
                    </div>
                    {#if item.snippet ?? item.excerpt}
                      <div class="cv-bookmark-excerpt cv-utt-text" title={item.excerpt ?? undefined}>{item.snippet ?? item.excerpt}</div>
                    {/if}
                    {#if item.note}<div class="cv-bookmark-note">{item.note}</div>{/if}
                  </div>
                  <div class="cv-row-actions">
                    <button class="cv-frag-open" onclick={() => onOpenBookmark(item.docPath, item.bookmarkId)}>Open ▶</button>
                    <button class="cv-icon-btn" title="Copy permalink" onclick={() => copyLink(item.docPath, item.startS, { type: 'bm', id: item.bookmarkId })}>🔗</button>
                    <button class="cv-icon-btn" title={addTitle} onclick={() => addItemToCollection({ kind: 'bookmark', docPath: item.docPath, refId: item.bookmarkId, startS: item.startS, endS: item.endS, label: item.label })}>＋</button>
                  </div>
                </div>
              {/each}
            </div>
          {/each}
        {/if}
      {:else if resultKind === 'utterances'}
        {#if sequenceMode}
          {#if groupedSeq().length === 0}
            <div class="cv-empty">No matching sequences found.</div>
          {:else}
            {#each groupedSeq() as group (group.docPath)}
              <div class="cv-doc-group">
                <div class="cv-doc-title">{group.docTitle ?? basename(group.docPath)}</div>
                {#each group.items as hit (`${hit.a.utteranceId}:${hit.b.utteranceId}`)}
                  <div class="cv-frag-row cv-seq-hit">
                    <div class="cv-seq-lines">
                      <div class="cv-seq-line">
                        {#if hit.a.speaker}<span class="cv-participant-chip">{hit.a.speaker}</span>{/if}
                        <span class="cv-utt-text">{hit.a.text}</span>
                        {#if hit.a.startS != null}<span class="cv-frag-time">{formatTime(hit.a.startS)}</span>{/if}
                      </div>
                      <div class="cv-seq-line">
                        <span class="cv-seq-arrow" title={hit.gap === 1 ? 'next utterance' : `${hit.gap} utterances later`}>↳{hit.gap > 1 ? ` +${hit.gap}` : ''}</span>
                        {#if hit.b.speaker}<span class="cv-participant-chip">{hit.b.speaker}</span>{/if}
                        <span class="cv-utt-text">{hit.b.text}</span>
                        {#if hit.b.startS != null}<span class="cv-frag-time">{formatTime(hit.b.startS)}</span>{/if}
                      </div>
                    </div>
                    <div class="cv-row-actions">
                      {#if hit.a.startS != null}
                        <button class="cv-frag-open" onclick={() => onOpenAtTime(hit.docPath, hit.a.startS ?? 0)}>Open ▶</button>
                        <button class="cv-icon-btn" title="Copy permalink" onclick={() => copyLink(hit.docPath, hit.a.startS, { type: 'utt', id: hit.a.utteranceId })}>🔗</button>
                      {/if}
                      <button class="cv-icon-btn" title={addTitle} onclick={() => addItemToCollection({ kind: 'span', docPath: hit.docPath, startS: hit.a.startS, endS: hit.b.endS ?? hit.b.startS, label: `${hit.a.text} ↳ ${hit.b.text}`.slice(0, 160) })}>＋</button>
                    </div>
                  </div>
                {/each}
              </div>
            {/each}
          {/if}
        {:else if groupedUtt().length === 0}
          <div class="cv-empty">
            {folders.length === 0
              ? 'Add a folder to start indexing your collection.'
              : 'No utterances found.'}
          </div>
        {:else}
          {#each groupedUtt() as group (group.docPath)}
            <div class="cv-doc-group">
              <div class="cv-doc-title">{group.docTitle ?? basename(group.docPath)}</div>
              {#each group.items as item (item.utteranceId)}
                <div class="cv-frag-row">
                  <div class="cv-frag-info">
                    {#if item.speaker}<span class="cv-participant-chip">{item.speaker}</span>{/if}
                    <span class="cv-utt-text" title={item.text}>{item.snippet ?? item.text}</span>
                    {#if item.startS != null && item.endS != null}
                      <span class="cv-frag-time">{formatTime(item.startS)} – {formatTime(item.endS)}</span>
                    {/if}
                  </div>
                  <div class="cv-row-actions">
                    {#if item.startS != null}
                      <button class="cv-frag-open" onclick={() => onOpenAtTime(item.docPath, item.startS ?? 0)}>Open ▶</button>
                      <button class="cv-icon-btn" title="Copy permalink" onclick={() => copyLink(item.docPath, item.startS, { type: 'utt', id: item.utteranceId })}>🔗</button>
                    {/if}
                    <button class="cv-icon-btn" title={addTitle} onclick={() => addItemToCollection({ kind: 'utterance', docPath: item.docPath, refId: item.utteranceId, startS: item.startS, endS: item.endS, label: item.text.slice(0, 140) })}>＋</button>
                  </div>
                </div>
              {/each}
            </div>
          {/each}
        {/if}
      {:else if resultKind === 'annotations'}
        {#if overlapMode}
          {#if groupedOvl().length === 0}
            <div class="cv-empty">No matching annotation pairs found.</div>
          {:else}
            {#each groupedOvl() as group (group.docPath)}
              <div class="cv-doc-group">
                <div class="cv-doc-title">{group.docTitle ?? basename(group.docPath)}</div>
                {#each group.items as hit (`${hit.a.annId}:${hit.b.annId}`)}
                  <div class="cv-frag-row cv-seq-hit">
                    <div class="cv-seq-lines">
                      <div class="cv-seq-line">
                        <span class="cv-schema-chip">{hit.a.tierName}</span>
                        <span class="cv-utt-text">{hit.a.value}</span>
                        {#if hit.a.startS != null && hit.a.endS != null}
                          <span class="cv-frag-time">{formatTime(hit.a.startS)} – {formatTime(hit.a.endS)}</span>
                        {/if}
                      </div>
                      <div class="cv-seq-line">
                        <span class="cv-seq-arrow">∩</span>
                        <span class="cv-schema-chip">{hit.b.tierName}</span>
                        <span class="cv-utt-text">{hit.b.value}</span>
                        {#if hit.b.startS != null && hit.b.endS != null}
                          <span class="cv-frag-time">{formatTime(hit.b.startS)} – {formatTime(hit.b.endS)}</span>
                        {/if}
                      </div>
                    </div>
                    <div class="cv-row-actions">
                      {#if hit.a.startS != null}
                        <button class="cv-frag-open" onclick={() => onOpenAtTime(hit.docPath, hit.a.startS ?? 0)}>Open ▶</button>
                        <button class="cv-icon-btn" title="Copy permalink" onclick={() => copyLink(hit.docPath, hit.a.startS, { type: 'ann', id: hit.a.annId })}>🔗</button>
                      {/if}
                      <button class="cv-icon-btn" title={addTitle} onclick={() => addItemToCollection({ kind: 'span', docPath: hit.docPath, startS: hit.a.startS, endS: hit.b.endS ?? hit.b.startS, label: `${hit.a.tierName}: ${hit.a.value} ∩ ${hit.b.tierName}: ${hit.b.value}`.slice(0, 160) })}>＋</button>
                    </div>
                  </div>
                {/each}
              </div>
            {/each}
          {/if}
        {:else if groupedAnn().length === 0}
          <div class="cv-empty">
            {folders.length === 0
              ? 'Add a folder to start indexing your collection.'
              : 'No annotations found.'}
          </div>
        {:else}
          {#each groupedAnn() as group (group.docPath)}
            <div class="cv-doc-group">
              <div class="cv-doc-title">{group.docTitle ?? basename(group.docPath)}</div>
              {#each group.items as item (item.annId)}
                <div class="cv-frag-row cv-bookmark-row">
                  <div class="cv-frag-info cv-bookmark-info">
                    <div class="cv-bookmark-head">
                      <span class="cv-schema-chip">{item.tierName}</span>
                      {#if item.participant}<span class="cv-participant-chip">{item.participant}</span>{/if}
                      <span class="cv-frag-label" title={item.value}>{item.snippet ?? item.value}</span>
                      {#if item.startS != null && item.endS != null}
                        <span class="cv-frag-time">{formatTime(item.startS)} – {formatTime(item.endS)}</span>
                      {/if}
                    </div>
                    {#if item.uttText}
                      <div class="cv-bookmark-excerpt cv-utt-text" title={item.uttText}>{item.uttText}</div>
                    {/if}
                  </div>
                  <div class="cv-row-actions">
                    {#if item.startS != null}
                      <button class="cv-frag-open" onclick={() => onOpenAtTime(item.docPath, item.startS ?? 0)}>Open ▶</button>
                      <button class="cv-icon-btn" title="Copy permalink" onclick={() => copyLink(item.docPath, item.startS, { type: 'ann', id: item.annId })}>🔗</button>
                    {/if}
                    <button class="cv-icon-btn" title={addTitle} onclick={() => addItemToCollection({ kind: 'annotation', docPath: item.docPath, refId: item.annId, startS: item.startS, endS: item.endS, label: `${item.tierName}: ${item.value}`.slice(0, 140) })}>＋</button>
                  </div>
                </div>
              {/each}
            </div>
          {/each}
        {/if}
      {:else}
        {#if groupedPat().length === 0}
          <div class="cv-empty">
            {folders.length === 0
              ? 'Add a folder to start indexing your collection.'
              : 'No patterns found.'}
          </div>
        {:else}
          {#each groupedPat() as group (group.docPath)}
            <div class="cv-doc-group">
              <div class="cv-doc-title">{group.docTitle ?? basename(group.docPath)}</div>
              {#each group.items as item (item.patternId)}
                <div class="cv-frag-row cv-pattern-row">
                  <div class="cv-frag-info cv-pattern-info">
                    <div class="cv-pattern-head">
                      <span class="cv-schema-chip">{item.schemaName}</span>
                      {#if item.speakers}<span class="cv-participant-chip">{item.speakers}</span>{/if}
                      {#if item.startS != null && item.endS != null}
                        <span class="cv-frag-time">{formatTime(item.startS)} – {formatTime(item.endS)}</span>
                      {/if}
                    </div>
                    {#each item.slots as slot, i (i)}
                      {#if slot.valueText}
                        <div class="cv-pattern-slot">
                          <span class="cv-slot-name">{slot.slotName}</span>
                          <span class="cv-slot-value">{slot.valueText}</span>
                        </div>
                      {/if}
                    {/each}
                    {#if item.metrics.some(m => m.value)}
                      <div class="cv-pattern-metrics">
                        {#each item.metrics as m, i (i)}
                          {#if m.value}<span class="cv-metric-chip">{m.metricName}: {m.value}</span>{/if}
                        {/each}
                      </div>
                    {/if}
                  </div>
                  <div class="cv-row-actions">
                    {#if item.startS != null}
                      <button class="cv-frag-open" onclick={() => onOpenAtTime(item.docPath, item.startS ?? 0)}>Open ▶</button>
                      <button class="cv-icon-btn" title="Copy permalink" onclick={() => copyLink(item.docPath, item.startS, { type: 'pat', id: item.patternId })}>🔗</button>
                    {/if}
                    <button class="cv-icon-btn" title={addTitle} onclick={() => addItemToCollection({ kind: 'pattern', docPath: item.docPath, refId: item.patternId, startS: item.startS, endS: item.endS, label: `${item.schemaName}: ${item.summary ?? ''}`.slice(0, 140) })}>＋</button>
                  </div>
                </div>
              {/each}
            </div>
          {/each}
        {/if}
      {/if}
    </div>

    {#if addingItem !== null}
      <div class="cv-advanced-row cv-addto-row">
        <span class="cv-adv-label">Add to:</span>
        {#each collections as c (c.id)}
          <button class="cv-mini-btn" onclick={() => void addToCollection(c.id)}>{c.name}</button>
        {/each}
        <input class="cv-save-name" type="text" placeholder="new collection…"
          bind:value={newCollectionName}
          onkeydown={(e) => { if (e.key === 'Enter') void addToNewCollection(); if (e.key === 'Escape') addingItem = null }} />
        <button class="cv-mini-btn" onclick={() => void addToNewCollection()}>✓</button>
        <button class="cv-row-del" onclick={() => addingItem = null}>×</button>
      </div>
    {/if}
  </div>
</div>

{#if deletingCollection}
  <div class="cv-modal-overlay" role="presentation" onclick={() => deletingCollection = null}>
    <div class="cv-modal" role="presentation" onclick={(e) => e.stopPropagation()}>
      <p class="cv-modal-title">Delete "<strong>{deletingCollection.name}</strong>"?</p>
      <p class="cv-modal-sub">This collection contains {deletingCollection.itemCount} item{deletingCollection.itemCount !== 1 ? 's' : ''} that will be removed.</p>
      <div class="cv-modal-actions">
        <button class="cv-modal-cancel" onclick={() => deletingCollection = null}>Cancel</button>
        <button class="cv-modal-delete" onclick={() => { void removeCollection(deletingCollection!.id); deletingCollection = null }}>Delete</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .cv-titlebar {
    height: 40px;
    flex-shrink: 0;
    background: var(--color-bg-0, #fff);
    border-bottom: 1px solid var(--color-border, #e0e0e0);
    -webkit-app-region: drag;
    padding: 0 max(0.5rem, calc(100vw - env(titlebar-area-width, 100vw))) 0 0.5rem;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .cv-titlebar-icon {
    height: 20px;
    width: 20px;
    flex-shrink: 0;
    image-rendering: auto;
  }

  .cv-titlebar-title {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--color-text-2, #555);
    letter-spacing: 0.01em;
  }

  .cv-titlebar-spacer {
    flex: 1;
  }

  .cv-editor-btn {
    -webkit-app-region: no-drag;
    background: none;
    border: 1px solid var(--color-border, #ddd);
    border-radius: 3px;
    padding: 2px 10px;
    font-size: var(--font-sm, 0.8rem);
    cursor: pointer;
    color: var(--color-text-1, #333);
  }
  .cv-editor-btn:hover {
    background: var(--color-bg-1, #f5f5f5);
    border-color: var(--color-text-muted, #999);
  }

  .collection-view {
    display: flex;
    height: calc(100% - 41px);
    overflow: hidden;
    font-size: var(--font-sm);
    background: var(--color-bg-0);
    color: var(--color-text-1);
  }

  /* ── Sidebar ── */
  .cv-sidebar {
    width: 200px;
    flex-shrink: 0;
    border-right: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    align-self: flex-start;
    max-height: 100%;
    overflow-y: auto;
  }

  .cv-section-divider {
    border-top: 1px solid var(--color-border);
  }

  .cv-sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px 4px;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .cv-sidebar-label {
    font-size: 0.68rem;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .cv-add-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-muted);
    font-size: 1rem;
    line-height: 1;
    padding: 0 2px;
  }
  .cv-add-btn:hover { color: var(--color-text-1); }

  .cv-tree {
    padding: 4px 0;
  }

  .cv-tree-empty {
    padding: 8px;
    font-size: 0.72rem;
    color: var(--color-text-muted);
    font-style: italic;
  }

  .cv-tree-all {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    padding: 3px 10px;
    cursor: pointer;
    font-size: var(--font-sm);
    color: var(--color-text-1);
    border-radius: 3px;
  }
  .cv-tree-all:hover { background: var(--color-bg-2); }

  .cv-folder-row {
    display: flex;
    align-items: center;
    padding: 1px 4px 1px 2px;
    gap: 1px;
  }

  .cv-expand-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-muted);
    font-size: 0.7rem;
    padding: 2px 3px;
    flex-shrink: 0;
    line-height: 1;
  }

  .cv-folder-label {
    flex: 1;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    font-size: var(--font-sm);
    color: var(--color-text-1);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 2px 4px;
    border-radius: 3px;
    min-width: 0;
  }
  .cv-folder-label:hover { background: var(--color-bg-2); }

  .cv-remove-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-muted);
    font-size: 0.85rem;
    padding: 1px 3px;
    flex-shrink: 0;
    opacity: 0;
    line-height: 1;
  }
  .cv-folder-row:hover .cv-remove-btn { opacity: 1; }
  .cv-remove-btn:hover { color: var(--color-danger, #e74c3c); }

  .cv-no-files {
    padding: 2px 10px 2px 26px;
    font-size: 0.68rem;
    color: var(--color-text-muted);
    font-style: italic;
  }

  .cv-file-row {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    padding: 2px 8px 2px 26px;
    cursor: pointer;
    font-size: var(--font-sm);
    color: var(--color-text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border-radius: 3px;
  }
  .cv-file-row:hover { background: var(--color-bg-2); }

  .cv-selected {
    background: var(--color-primary-dim, color-mix(in srgb, var(--color-primary) 12%, transparent)) !important;
    color: var(--color-primary) !important;
  }

  .cv-coll-list {
    padding: 2px 0;
  }

  /* Radio-button activation dot */
  .cv-coll-radio {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    border: 1.5px solid var(--color-border);
    background: none;
    cursor: pointer;
    flex-shrink: 0;
    padding: 0;
    margin: 0 3px 0 4px;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: border-color 0.1s;
  }
  .cv-coll-radio::after {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: transparent;
    transition: background 0.1s;
  }
  .cv-coll-radio:hover { border-color: var(--color-primary); }
  .cv-coll-radio:hover::after { background: color-mix(in srgb, var(--color-primary) 35%, transparent); }
  .cv-coll-radio-on { border-color: var(--color-primary) !important; }
  .cv-coll-radio-on::after { background: var(--color-primary) !important; }

  /* Collection inline-create row in sidebar */
  .cv-create-coll-row {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 4px 6px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-primary-dim, color-mix(in srgb, var(--color-primary) 8%, transparent));
  }
  .cv-create-coll-input {
    flex: 1;
    min-width: 0;
    padding: 2px 5px;
    border: 1px solid var(--color-primary);
    border-radius: 3px;
    font-size: 0.75rem;
    background: var(--color-bg-0);
    color: var(--color-text-1);
    font-family: inherit;
  }
  .cv-create-coll-input:focus { outline: none; }

  /* Delete confirmation modal */
  .cv-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
  }
  .cv-modal {
    background: var(--color-bg-0);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 1.25rem 1.5rem;
    max-width: 320px;
    width: 90vw;
    box-shadow: 0 8px 32px rgba(0,0,0,0.2);
  }
  .cv-modal-title {
    margin: 0 0 0.5rem;
    font-size: 0.9rem;
    color: var(--color-text-1);
  }
  .cv-modal-sub {
    margin: 0 0 1rem;
    font-size: 0.78rem;
    color: var(--color-text-muted);
  }
  .cv-modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .cv-modal-cancel {
    background: none;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    padding: 4px 14px;
    font-size: 0.8rem;
    cursor: pointer;
    color: var(--color-text-muted);
  }
  .cv-modal-cancel:hover { color: var(--color-text-1); border-color: var(--color-text-muted); }
  .cv-modal-delete {
    background: var(--color-danger, #e74c3c);
    border: none;
    border-radius: 3px;
    padding: 4px 14px;
    font-size: 0.8rem;
    cursor: pointer;
    color: #fff;
  }
  .cv-modal-delete:hover { filter: brightness(1.1); }

  /* ── Main ── */
  .cv-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .cv-toolbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

.cv-search {
    flex: 1;
    padding: 4px 8px;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    font-size: var(--font-sm);
    background: var(--color-bg-1);
    color: var(--color-text-1);
    font-family: inherit;
  }
  .cv-search:focus { outline: 2px solid var(--color-primary); outline-offset: -1px; border-color: transparent; }

  .cv-sync-btn {
    background: none;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    padding: 3px 8px;
    cursor: pointer;
    font-size: 1rem;
    color: var(--color-text-muted);
  }
  .cv-sync-btn:hover { color: var(--color-text-1); }
  .cv-sync-btn:disabled { opacity: 0.5; cursor: default; }

  .cv-status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 3px 0.75rem;
    font-size: 0.72rem;
    color: var(--color-text-muted);
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
    min-height: 22px;
  }

  .cv-results {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .cv-empty {
    color: var(--color-text-muted);
    padding: 2rem;
    text-align: center;
    font-style: italic;
  }

  .cv-doc-group { display: flex; flex-direction: column; gap: 1px; }

  .cv-doc-title {
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--color-text-muted);
    padding: 4px 0 3px;
    border-bottom: 1px solid var(--color-border);
    margin-bottom: 2px;
  }

  .cv-frag-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 4px 2px;
    border-radius: 3px;
  }
  .cv-frag-row:hover { background: var(--color-bg-1); }

  .cv-frag-info { flex: 1; display: flex; align-items: baseline; gap: 0.5rem; min-width: 0; }

  .cv-frag-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cv-frag-time {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .cv-frag-code {
    font-size: 0.68rem;
    background: var(--color-primary-dim, color-mix(in srgb, var(--color-primary) 12%, transparent));
    color: var(--color-primary);
    border-radius: 2px;
    padding: 0 4px;
    white-space: nowrap;
  }

  /* ── Kind tabs + facets ── */
  .cv-kind-tabs {
    display: flex;
    gap: 2px;
    flex-shrink: 0;
  }

  .cv-kind-tab {
    background: none;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    padding: 3px 9px;
    font-size: 0.72rem;
    cursor: pointer;
    color: var(--color-text-muted);
    white-space: nowrap;
  }
  .cv-kind-tab:hover { color: var(--color-text-1); }
  .cv-kind-active {
    background: var(--color-primary-dim, color-mix(in srgb, var(--color-primary) 12%, transparent));
    color: var(--color-primary) !important;
    border-color: var(--color-primary);
  }

  .cv-facet {
    flex-shrink: 0;
    max-width: 140px;
    padding: 3px 4px;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    font-size: 0.72rem;
    background: var(--color-bg-1);
    color: var(--color-text-1);
    font-family: inherit;
  }

  /* ── Utterance / pattern rows ── */
  .cv-participant-chip {
    font-size: 0.68rem;
    font-weight: 600;
    background: var(--color-bg-2);
    color: var(--color-text-muted);
    border-radius: 2px;
    padding: 0 4px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .cv-schema-chip {
    font-size: 0.68rem;
    font-weight: 600;
    background: var(--color-primary-dim, color-mix(in srgb, var(--color-primary) 12%, transparent));
    color: var(--color-primary);
    border-radius: 2px;
    padding: 0 4px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .cv-pattern-row { align-items: flex-start; }
  .cv-pattern-info { flex-direction: column; align-items: stretch; gap: 2px; }
  .cv-pattern-head { display: flex; align-items: baseline; gap: 0.5rem; }

  .cv-pattern-slot {
    display: flex;
    gap: 0.4rem;
    font-size: 0.78rem;
    padding-left: 4px;
    min-width: 0;
  }
  .cv-slot-name {
    color: var(--color-text-muted);
    flex-shrink: 0;
    font-size: 0.72rem;
  }
  .cv-slot-value {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cv-pattern-metrics {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    padding-left: 4px;
  }
  .cv-metric-chip {
    font-size: 0.66rem;
    border: 1px solid var(--color-border);
    color: var(--color-text-muted);
    border-radius: 2px;
    padding: 0 3px;
    white-space: nowrap;
  }

  /* ── Advanced (sequence) search ── */
  .cv-advanced-btn {
    flex-shrink: 0;
    background: none;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    padding: 3px 8px;
    font-size: 0.72rem;
    cursor: pointer;
    color: var(--color-text-muted);
    white-space: nowrap;
  }
  .cv-advanced-btn:hover { color: var(--color-text-1); }
  .cv-advanced-active {
    color: var(--color-primary) !important;
    border-color: var(--color-primary);
  }

  .cv-advanced-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.75rem;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
    background: var(--color-bg-1);
  }

  .cv-adv-label {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .cv-adv-input { flex: 1; }

  .cv-adv-num {
    width: 52px;
    padding: 3px 5px;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    font-size: 0.75rem;
    background: var(--color-bg-0);
    color: var(--color-text-1);
  }

  .cv-filters-panel {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 0.4rem 0.75rem;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
    background: var(--color-bg-1);
  }

  .cv-filter-group { display: flex; flex-direction: column; gap: 3px; }
  .cv-filter-row { display: flex; align-items: center; gap: 0.4rem; }
  .cv-filter-actions { display: flex; gap: 0.4rem; padding-left: 2px; }

  .cv-or-divider {
    font-size: 0.68rem;
    color: var(--color-text-muted);
    text-align: center;
    letter-spacing: 0.05em;
  }

  .cv-mini-btn {
    background: none;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    padding: 1px 7px;
    font-size: 0.7rem;
    color: var(--color-text-muted);
    cursor: pointer;
  }
  .cv-mini-btn:hover { color: var(--color-text-1); border-color: var(--color-text-muted); }

  .cv-row-del {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-muted);
    font-size: 0.85rem;
    padding: 0 3px;
    flex-shrink: 0;
    line-height: 1;
  }
  .cv-row-del:hover { color: var(--color-danger, #e74c3c); }

  .cv-metric-row { flex-wrap: wrap; }
  .cv-metric-filter { display: flex; align-items: center; gap: 0.3rem; }

  .cv-save-name {
    flex-shrink: 0;
    width: 140px;
    padding: 3px 6px;
    border: 1px solid var(--color-primary);
    border-radius: 3px;
    font-size: 0.75rem;
    background: var(--color-bg-0);
    color: var(--color-text-1);
  }

  .cv-saved-list {
    max-height: 30%;
    overflow-y: auto;
    padding: 2px 0;
    flex-shrink: 0;
  }

  .cv-saved-row {
    display: flex;
    align-items: center;
    padding: 0 4px 0 2px;
  }
  .cv-saved-row:hover .cv-remove-btn { opacity: 1; }

  .cv-saved-name {
    flex: 1;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    font-size: var(--font-sm);
    color: var(--color-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 2px 6px;
    border-radius: 3px;
    min-width: 0;
  }
  .cv-saved-name:hover { background: var(--color-bg-2); }

  .cv-row-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
  }

  .cv-icon-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-muted);
    font-size: 0.75rem;
    padding: 1px 3px;
    line-height: 1;
  }
  .cv-icon-btn:hover { color: var(--color-primary); }

  .cv-regex-btn { font-family: monospace; }

  .cv-addto-row {
    background: var(--color-primary-dim, color-mix(in srgb, var(--color-primary) 8%, transparent));
    flex-wrap: wrap;
    border-top: 1px solid var(--color-border);
    border-bottom: none;
    flex-shrink: 0;
  }

  .cv-link-input {
    flex-shrink: 0;
    width: 110px;
    padding: 3px 6px;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    font-size: 0.72rem;
    background: var(--color-bg-1);
    color: var(--color-text-1);
    transition: width 0.15s;
  }
  .cv-link-input:focus { width: 220px; outline: 2px solid var(--color-primary); outline-offset: -1px; }
  .cv-link-failed { outline: 2px solid var(--color-danger, #e74c3c) !important; outline-offset: -1px; }

  .cv-collection-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--color-border);
  }
  .cv-collection-title { font-weight: 600; }
  .cv-count { color: var(--color-text-muted); font-size: 0.7rem; }

  .cv-search-error {
    color: var(--color-danger, #e74c3c);
    font-weight: 600;
  }

  .cv-pager {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .cv-page-btn {
    background: none;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    padding: 0 7px;
    font-size: 0.8rem;
    cursor: pointer;
    color: var(--color-text-muted);
    line-height: 1.3;
  }
  .cv-page-btn:hover:not(:disabled) { color: var(--color-text-1); }
  .cv-page-btn:disabled { opacity: 0.4; cursor: default; }

  /* utterance text: wrap up to two lines instead of single-line ellipsis */
  .cv-utt-text {
    min-width: 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .cv-bookmark-row { align-items: flex-start; }
  .cv-bookmark-info { flex-direction: column; align-items: stretch; gap: 1px; }
  .cv-bookmark-head { display: flex; align-items: baseline; gap: 0.5rem; min-width: 0; }

  .cv-bookmark-excerpt {
    font-size: 0.76rem;
    color: var(--color-text-muted);
    padding-left: 4px;
  }

  .cv-bookmark-note {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    font-style: italic;
    padding-left: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cv-seq-hit { align-items: flex-start; }
  .cv-seq-lines { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .cv-seq-line { display: flex; align-items: baseline; gap: 0.5rem; min-width: 0; }
  .cv-seq-arrow {
    color: var(--color-primary);
    font-size: 0.75rem;
    flex-shrink: 0;
    white-space: nowrap;
  }

  .cv-frag-open {
    background: none;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    padding: 2px 7px;
    font-size: 0.72rem;
    cursor: pointer;
    color: var(--color-text-muted);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .cv-frag-open:hover { color: var(--color-primary); border-color: var(--color-primary); }
</style>
