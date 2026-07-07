<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import { TabulatorFull as Tabulator } from 'tabulator-tables'
  import type { CellComponent, ColumnDefinition, DownloadType, EmptyCallback, ValueBooleanCallback, ValueVoidCallback } from 'tabulator-tables'
  import 'tabulator-tables/dist/css/tabulator_simple.min.css'
  import type { Annotation, AnnotationStore, TierDef, TokenRecord, TokenStore } from '@mumo/core'
  import { isTokenLtId, baseTextContent } from '@mumo/core'
  import type { PMNode } from '@mumo/core'

  const PSEUDO_UTT_PFX = '__utt__'
  const PSEUDO_TOK_PFX = '__tok__'
  const isPseudo = (id: string) => id.startsWith(PSEUDO_UTT_PFX) || id.startsWith(PSEUDO_TOK_PFX)
  const uttId    = (p: string) => `${PSEUDO_UTT_PFX}${p}`
  const tokId    = (p: string) => `${PSEUDO_TOK_PFX}${p}`

  const { store, tokenStore, doc, onSeek }: {
    store: AnnotationStore
    tokenStore: TokenStore
    doc: PMNode
    onSeek?: (time: number) => void
  } = $props()

  // Mutable local copy — updated via doc:change store event so _buildData() always
  // reads the latest doc without requiring Svelte reactivity.
  let _doc: PMNode = untrack(() => doc)

  let tableEl: HTMLDivElement | null = $state(null)
  let ddEl:       HTMLDivElement | null = $state(null)
  let exportEl:   HTMLDivElement | null = $state(null)
  let tab: InstanceType<typeof Tabulator> | null = null

  let _tiers: TierDef[]     = $state([])
  let _selectedIds: Set<string> = $state(new Set())
  let _showDropdown    = $state(false)
  let _showExportMenu  = $state(false)
  let _currentColKey = ''

  let _resizeObserver: ResizeObserver | null = null
  let _resizeDirty = false
  let _navRowId: string | null = null
  let _tableReady = false  // true only after Tabulator fires tableBuilt (it defers _create via setTimeout)
  let _uttNodeIds: string[] = []       // ordered utterance node IDs currently in the table, for structural-change detection
  const _uttTokCounts = new SvelteMap<string, number>()  // nodeId → non-ws token count snapshot
  const _uttTexts = new SvelteMap<string, string>()      // nodeId → textContent snapshot, for detecting token text edits
  const _uttParticipants = new SvelteMap<string, string>() // nodeId → participant snapshot, for detecting speaker changes

  let _showTierCol   = $state(true)
  let _showStart     = $state(true)
  let _showEnd       = $state(true)
  let _showDuration  = $state(false)
  let _mergeLingTypes = $state(false)
  let _canMerge       = $state(false)

  function _fmtTime(secs: number | null): string {
    if (secs == null) return ''
    const h   = Math.floor(secs / 3600)
    const m   = Math.floor((secs % 3600) / 60)
    const s   = secs % 60
    const hh  = String(h).padStart(2, '0')
    const mm  = String(m).padStart(2, '0')
    const ss  = s.toFixed(3).padStart(6, '0')
    return `${hh}:${mm}:${ss}`
  }

  function _fmtDuration(secs: number | null): string {
    if (secs == null) return ''
    return secs.toFixed(3)
  }

  // Dropdown groups

  type GroupMember =
    | { kind: 'pseudo-utt'; participant: string; depth: number }
    | { kind: 'pseudo-tok'; participant: string; depth: number }
    | { kind: 'tier';       tier: TierDef; depth: number; constraintLabel: string | null }

  function _mixedGroups(): { label: string; members: GroupMember[] }[] {
    const cLabel = (tierId: string): string | null => {
      const c = store.resolveTierConstraint(tierId)
      return c === 'symbolic_association' ? 'SA'
        : (c === 'symbolic_subdivision' || c === 'time_subdivision' || c === 'included_in') ? 'sub'
        : null
    }

    function tierTree(parentId: string, depth: number): GroupMember[] {
      const out: GroupMember[] = []
      for (const t of store.tierChildrenOf(parentId)) {
        out.push({ kind: 'tier', tier: t, depth, constraintLabel: cLabel(t.id) })
        out.push(...tierTree(t.id, depth + 1))
      }
      return out
    }

    // Gather participants from doc utterances
    const docParts = new SvelteSet<string>()
    _doc.forEach((n: PMNode) => {
      if (n.type?.name === 'utterance') docParts.add((n.attrs?.participant as string) || '')
    })

    // Build speaker → lt-word tier ID lookup for fast child traversal
    const ltWordTierOf = new SvelteMap<string, string>()
    for (const t of _tiers) {
      if (isTokenLtId(t.linguisticTypeId) && t.participant) ltWordTierOf.set(t.participant, t.id)
    }

    // Gather participants from doc utterances, root tiers, and word SA tiers
    const allParts = new SvelteSet<string>(docParts)
    for (const t of _tiers) {
      if (!t.parentTierId) { allParts.add(t.participant ?? ''); continue }
      if (t.parentTierId.startsWith(PSEUDO_UTT_PFX)) {
        allParts.add(t.parentTierId.slice(PSEUDO_UTT_PFX.length)); continue
      }
      const parentTier = t.parentTierId ? store.getTier(t.parentTierId) : undefined
      if (parentTier && isTokenLtId(parentTier.linguisticTypeId) && parentTier.participant)
        allParts.add(parentTier.participant)
    }

    return [...allParts].sort().flatMap(p => {
      const tokenTierId = ltWordTierOf.get(p)
      const members: GroupMember[] = []
      if (docParts.has(p)) {
        members.push({ kind: 'pseudo-utt', participant: p, depth: 0 })
        members.push(...tierTree(uttId(p), 1))          // SA/sub tiers of utt pseudo-tier
        members.push({ kind: 'pseudo-tok', participant: p, depth: 1 })
        if (tokenTierId) members.push(...tierTree(tokenTierId, 2))  // SA/sub tiers of word tier
      } else {
        members.push(...tierTree(uttId(p), 0))          // orphan tiers whose parent was pseudo
        if (tokenTierId) members.push(...tierTree(tokenTierId, 1))
      }
      for (const t of store.tierChildrenOf(undefined).filter(t => (t.participant ?? '') === p && !isTokenLtId(t.linguisticTypeId))) {
        members.push({ kind: 'tier', tier: t, depth: 0, constraintLabel: cLabel(t.id) })
        members.push(...tierTree(t.id, 1))
      }
      return members.length ? [{ label: p, members }] : []
    })
  }

  // Selection analysis

  type SelectionInfo = {
    rootTierIds:  string[]                // tiers whose annotations become rows
    saChildrenOf: Map<string, string[]>   // parentTierId → SA child tier IDs (columns)
    allSaTierIds: string[]                // all SA tiers in selection
  }

  function _analyze(): SelectionInfo {
    const sel = new SvelteSet([..._selectedIds].filter(id => !isPseudo(id)))
    const saChildrenOf  = new SvelteMap<string, string[]>()
    const allSaTierIds: string[] = []

    // lt-word tier ID → participant (for remapping word SA parents to internal tokId pseudo-row)
    const ltWordParticipant = new SvelteMap<string, string>()
    for (const t of _tiers) {
      if (isTokenLtId(t.linguisticTypeId) && t.participant) ltWordParticipant.set(t.id, t.participant)
    }

    for (const id of sel) {
      const tier = store.getTier(id)
      if (!tier) continue

      let parentId = tier.parentTierId

      // Word SA tier: real parent is an lt-word tier → remap to internal tokId pseudo-row
      // so the table can group SA columns under the token pseudo-tier rows.
      if (parentId && ltWordParticipant.has(parentId)) {
        parentId = tokId(ltWordParticipant.get(parentId)!)
      }

      // SA tier with participant but no explicit parent → auto-link to utterance pseudo-tier.
      if (!parentId) {
        const c = store.resolveTierConstraint(id)
        if (c === 'symbolic_association' && tier.participant) {
          const pseudoId = uttId(tier.participant)
          if (_selectedIds.has(pseudoId)) parentId = pseudoId
        }
      }

      if (!parentId) continue
      if (!sel.has(parentId) && !_selectedIds.has(parentId)) continue

      if (store.resolveTierConstraint(id) === 'symbolic_association') {
        allSaTierIds.push(id)
        const list = saChildrenOf.get(parentId) ?? []
        list.push(id)
        saChildrenOf.set(parentId, list)
      }
      // subdivision tiers: treated as independent row tiers, included in rootTierIds below
    }

    const saTierSet = new SvelteSet(allSaTierIds)
    // Every selected non-SA tier produces rows — subdivision tiers included
    const rootTierIds = [...sel].filter(id => !saTierSet.has(id))

    return { rootTierIds, saChildrenOf, allSaTierIds }
  }

  function _colKey(info: SelectionInfo): string {
    const pseudo = [..._selectedIds].filter(isPseudo).sort().join(',')
    return [
      pseudo,
      info.rootTierIds.slice().sort().join(','),
      [...info.saChildrenOf.entries()].map(([k, v]) => `${k}:${v.join('+')}`).sort().join(';'),
    ].join('|')
  }

  function _checkMergeEligibility(info: SelectionInfo): boolean {
    // Collision: two SA tiers with same LT under the same parent bucket
    for (const [, children] of info.saChildrenOf) {
      const seenLt = new SvelteSet<string>()
      for (const saId of children) {
        const lt = store.getTier(saId)?.linguisticTypeId
        if (!lt) continue
        if (seenLt.has(lt)) return false
        seenLt.add(lt)
      }
    }
    // Only meaningful if at least one LT spans 2+ SA tiers (across different parents)
    const ltCount = new SvelteMap<string, number>()
    for (const saId of info.allSaTierIds) {
      const lt = store.getTier(saId)?.linguisticTypeId
      if (!lt) continue
      ltCount.set(lt, (ltCount.get(lt) ?? 0) + 1)
    }
    for (const n of ltCount.values()) if (n >= 2) return true
    return false
  }

  // Row building

  type Row = {
    _id: string
    _tierId: string
    annotation: string
    start: number | null
    end: number | null
    duration: number | null
    _readonly?: boolean
    _participant?: string
    [saField: string]: unknown
  }

  function _buildData(): Row[] {
    const uttParticipants = new SvelteSet<string>()
    const tokParticipants = new SvelteSet<string>()
    for (const id of _selectedIds) {
      if (id.startsWith(PSEUDO_UTT_PFX)) uttParticipants.add(id.slice(PSEUDO_UTT_PFX.length))
      else if (id.startsWith(PSEUDO_TOK_PFX)) tokParticipants.add(id.slice(PSEUDO_TOK_PFX.length))
    }

    const info        = _analyze()
    const hasTierRows = info.rootTierIds.length > 0
    const needAnns    = hasTierRows || info.saChildrenOf.size > 0

    if (!hasTierRows && uttParticipants.size === 0 && tokParticipants.size === 0) return []

    const allAnns = needAnns ? store.allAnnotations() : []

    // Index by tierId+parentId for SA lookups (blockNodeId, tokenNodeId, or parentAnnId)
    const byKey = new SvelteMap<string, typeof allAnns>()
    for (const ann of allAnns) {
      const tierId     = ann.features.tierId     as string
      const blockNodeId  = ann.features.blockNodeId  as string | undefined
      const tokenNodeId = ann.features.tokenNodeId as string | undefined
      const key = blockNodeId  ? `${tierId}\0${blockNodeId}`
        : tokenNodeId         ? `${tierId}\0${tokenNodeId}`
        : `${tierId}\0${(ann.features.parentAnnId as string | undefined) ?? ''}`
      let b = byKey.get(key); if (!b) { b = []; byKey.set(key, b) }
      b.push(ann)
    }
    const getAnns = (tierId: string, parentId: string | null) =>
      byKey.get(`${tierId}\0${parentId ?? ''}`) ?? []

    // Index by tier for bulk lookup (subdivision anns always have a parentAnnId, so
    // getAnns(tierId, null) would miss them; byTier covers all annotations for a tier)
    const byTier = new SvelteMap<string, typeof allAnns>()
    for (const ann of allAnns) {
      const tierId = ann.features.tierId as string
      let b = byTier.get(tierId); if (!b) { b = []; byTier.set(tierId, b) }
      b.push(ann)
    }

    // ID → annotation for parent time lookup
    const annById = new SvelteMap<string, typeof allAnns[0]>()
    for (const ann of allAnns) annById.set(ann.id, ann)

    const rows: Row[] = []

    // Tier annotation rows
    if (hasTierRows) {
      for (const rootId of info.rootTierIds) {
        const isSymbolicSubdiv = store.resolveTierConstraint(rootId) === 'symbolic_subdivision'
        for (const ann of byTier.get(rootId) ?? []) {
          const ta = ann.anchors.find(a => a.type === 'time') as { start: number; end: number } | undefined
          let start: number | null = ta?.start ?? null
          let end:   number | null = ta?.end   ?? null
          // Symbolic subdivision: inherit start/end from parent (no independent time stored).
          // All siblings under the same parent share the parent's time span in the table.
          if (isSymbolicSubdiv && start == null) {
            const parentId = ann.features.parentAnnId as string | undefined
            const wordId   = ann.features.tokenNodeId  as string | undefined
            if (parentId) {
              const pta = annById.get(parentId)?.anchors.find(a => a.type === 'time') as { start: number; end: number } | undefined
              start = pta?.start ?? null
              end   = pta?.end   ?? null
            } else if (wordId) {
              const tt = store.getTokenTime(wordId)
              start = tt?.start ?? null
              end   = tt?.end   ?? null
            }
          }
          const duration = start != null && end != null ? +(end - start).toFixed(3) : null
          const row: Row = { _id: ann.id, _tierId: rootId, annotation: ann.type ?? '', start, end, duration }
          for (const saId of info.saChildrenOf.get(rootId) ?? []) {
            const saAnn = getAnns(saId, ann.id)[0]
            row[`sa_${saId}`]    = saAnn?.type ?? null
            row[`sa_${saId}_id`] = saAnn?.id   ?? null
          }
          rows.push(row)
        }
      }
    }

    // Utterance / token rows
    if (uttParticipants.size > 0 || tokParticipants.size > 0) {
      _doc.forEach((node: PMNode) => {
        if (node.type?.name !== 'utterance') return
        const p        = (node.attrs?.participant as string) || ''
        const wantsUtt = uttParticipants.has(p)
        const wantsTok = tokParticipants.has(p)
        if (!wantsUtt && !wantsTok) return

        const nodeId = node.attrs.id as string

        if (wantsUtt) {
          const uttStart = (node.attrs.startTimeSeconds as number | null) ?? null
          const uttEnd   = (node.attrs.endTimeSeconds   as number | null) ?? null
          const uttRow: Row = {
            _id:          nodeId,
            _tierId:      uttId(p),
            annotation:   baseTextContent(node),
            _participant: p,
            start:        uttStart,
            end:          uttEnd,
            duration:     uttStart != null && uttEnd != null ? +(uttEnd - uttStart).toFixed(3) : null,
          }
          for (const saId of info.saChildrenOf.get(uttId(p)) ?? []) {
            const saAnn = getAnns(saId, nodeId)[0]
            uttRow[`sa_${saId}`]    = saAnn?.type ?? null
            uttRow[`sa_${saId}_id`] = saAnn?.id   ?? null
          }
          rows.push(uttRow)
        }

        if (wantsTok) {
          const uttStart = (node.attrs.startTimeSeconds as number | null) ?? null
          const uttEnd   = (node.attrs.endTimeSeconds   as number | null) ?? null
          for (const tok of tokenStore.getUttTokens(nodeId).filter((t: TokenRecord) => t.kind !== 'ws')) {
            const tt       = store.getTokenTime(tok.id)
            const tokStart = tt?.start ?? uttStart
            const tokEnd   = tt?.end   ?? uttEnd
            const tokRow: Row = {
              _id:          tok.id,
              _tierId:      tokId(p),
              annotation:   tok.text,
              _readonly:    true,
              _participant: p,
              start:        tokStart,
              end:          tokEnd,
              duration:     tokStart != null && tokEnd != null ? +(tokEnd - tokStart).toFixed(3) : null,
            }
            for (const saId of info.saChildrenOf.get(tokId(p)) ?? []) {
              const saAnn = getAnns(saId, tok.id)[0]
              tokRow[`sa_${saId}`]    = saAnn?.type ?? null
              tokRow[`sa_${saId}_id`] = saAnn?.id   ?? null
            }
            rows.push(tokRow)
          }
        }
      })
    }

    return rows.sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
  }

  // Table construction

  function _vocabValues(tierId: string): string[] | null {
    const tier  = store.getTier(tierId)
    const lt    = tier ? store.getLinguisticType(tier.linguisticTypeId) : undefined
    const vocab = lt?.vocabularyId ? store.getVocabulary(lt.vocabularyId) : undefined
    return vocab ? vocab.entries.map(e => e.value) : null
  }

  function _getTableHeight(): number {
    return tableEl?.parentElement?.clientHeight ?? 0
  }

  function _buildTable(): void {
    _tableReady = false
    _navRowId = null
    tab?.destroy()
    tab = null
    if (!tableEl) return

    const info = _analyze()
    _currentColKey = _colKey(info)
    const hasUtt = [..._selectedIds].some(id => id.startsWith(PSEUDO_UTT_PFX))
    const hasTok = [..._selectedIds].some(id => id.startsWith(PSEUDO_TOK_PFX))

    const newCanMerge = _checkMergeEligibility(info)
    _canMerge = newCanMerge
    if (_mergeLingTypes && !newCanMerge) _mergeLingTypes = false

    // Shared editor factory — reads vocab for the given tier
    const makeEditor = (tierId: string) =>
      (cell: CellComponent, onRendered: EmptyCallback, success: ValueBooleanCallback, cancel: ValueVoidCallback): HTMLElement => {
        const commitOrCancel = (newVal: string) => {
          const prev = String(cell.getValue() ?? '')
          if (newVal !== prev) {
            // Merged SA columns use a virtual field (_sa_lt_X) but their formatters
            // read row.data['sa_${tierId}'] directly. Pre-populate that field before
            // success() so layoutElement() runs the formatter against the new value.
            // For regular SA and annotation columns this is redundant but harmless.
            ;cell.getRow().getData()[`sa_${tierId}`] = newVal
            success(newVal)
          } else {
            cancel(undefined)
          }
        }
        const navigateNext = () => {
          const nextRow = cell.getRow().getNextRow()
          if (nextRow) {
            const col = cell.getColumn()
            const nextCell = nextRow.getCells().find(c => c.getColumn() === col)
            queueMicrotask(() => { if (nextCell?.getElement()) nextCell.edit() })
          }
        }

        const values = _vocabValues(tierId)
        if (values) {
          const sel = document.createElement('select')
          sel.className = 'tab-cell-select'
          for (const v of values) {
            const opt = document.createElement('option')
            opt.value = v; opt.textContent = v
            sel.appendChild(opt)
          }
          sel.value = cell.getValue() as string ?? ''
          onRendered(() => sel.focus())
          let done = false
          sel.addEventListener('blur',    () => { if (!done) { done = true; commitOrCancel(sel.value) } })
          sel.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); done = true; cancel(undefined) }
            if (e.key === 'Enter') {
              e.preventDefault(); done = true; commitOrCancel(sel.value); navigateNext()
            }
          })
          return sel
        } else {
          const inp = document.createElement('input')
          inp.type = 'text'; inp.className = 'tab-cell-input'
          inp.value = cell.getValue() as string ?? ''
          onRendered(() => { inp.focus(); inp.select() })
          let done = false
          inp.addEventListener('blur',    () => { if (!done) { done = true; commitOrCancel(inp.value) } })
          inp.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); done = true; cancel(undefined) }
            if (e.key === 'Enter') {
              e.preventDefault(); done = true; commitOrCancel(inp.value); navigateNext()
            }
          })
          return inp
        }
      }

    // For the Annotation column the tier varies per row, so read _tierId from row data
    const annotationEditor = (cell: CellComponent, onRendered: EmptyCallback, success: ValueBooleanCallback, cancel: ValueVoidCallback) =>
      makeEditor((cell.getRow().getData() as Row)._tierId)(cell, onRendered, success, cancel)

    const onAnnotationCellEdited = (cell: CellComponent) => {
      const id    = (cell.getRow().getData() as Row)._id
      const value = String(cell.getValue() ?? '')
      // Defer so Tabulator's navigateDown → editCell call stack unwinds before
      // tab.updateData() fires via onAnnotationUpdate. Calling tab.updateData()
      // synchronously during editCell sets cell.element = false, crashing at
      // Edit.js:751 (element.classList.add on the next cell).
      queueMicrotask(() => store.updateAnnotation(id, { type: value }))
    }

    // Reverse map: saId → parent tier/pseudo-tier ID
    const saParentOf = new SvelteMap<string, string>()
    for (const [parent, children] of info.saChildrenOf) {
      for (const child of children) saParentOf.set(child, parent)
    }

    const makeSaCol = (saId: string): ColumnDefinition => {
      const saParentId = saParentOf.get(saId) ?? null
      const isWordSa   = saParentId?.startsWith(PSEUDO_TOK_PFX) ?? false
      return {
        title:      store.getTier(saId)?.name ?? saId,
        field:      `sa_${saId}`,
        widthGrow:  1,
        headerSort: false,
        editable:   (cell: CellComponent) => (cell.getRow().getData() as Row)._tierId === saParentId,
        formatter:  (cell: CellComponent) => {
          const val = cell.getValue() as string | null
          if (val != null && val !== '') return val
          return (cell.getRow().getData() as Row)._tierId === saParentId ? '' : '<span class="cell-null">∅</span>'
        },
        accessorDownload: (value: unknown, data: unknown) => {
          const row = data as Row
          const tierLabel = row._tierId as string
          let parentLabel: string
          if (saParentId?.startsWith(PSEUDO_UTT_PFX)) {
            parentLabel = 'Utterances'
            // Distinguish multi-speaker rows: both Alice's and Bob's utterances convert
            // to 'Utterances', so also check the _participant field (not modified by any
            // accessor, unlike _tierId which is overwritten by the Tier column accessor).
            if (row._participant !== saParentId.slice(PSEUDO_UTT_PFX.length)) return 'NA'
          } else if (saParentId?.startsWith(PSEUDO_TOK_PFX)) {
            parentLabel = 'Tokens'
            if (row._participant !== saParentId.slice(PSEUDO_TOK_PFX.length)) return 'NA'
          } else {
            parentLabel = store.getTier(saParentId ?? '')?.name ?? (saParentId ?? '')
          }
          if (tierLabel !== parentLabel) return 'NA'
          const val = value as string | null
          return (val != null && val !== '') ? val : 'NULL'
        },
        editor: makeEditor(saId),
        cellEdited: (cell: CellComponent) => {
          const data    = cell.getRow().getData() as Row
          const value   = String(cell.getValue() ?? '')
          const existId = data[`sa_${saId}_id`] as string | null
          queueMicrotask(() => {
            if (existId) {
              store.updateAnnotation(existId, { type: value })
            } else if (isWordSa) {
              store.addAnnotation(value, [], { tierId: saId, tokenNodeId: data._id })
            } else {
              store.addAnnotation(value, [], { tierId: saId, parentAnnId: data._id })
            }
          })
        },
      }
    }

    let saColumns: ColumnDefinition[]
    if (_mergeLingTypes) {
      // Group SA tiers by linguistic type
      const ltGroups = new SvelteMap<string, string[]>()
      for (const saId of info.allSaTierIds) {
        const ltId = store.getTier(saId)?.linguisticTypeId
        if (!ltId) continue
        const list = ltGroups.get(ltId) ?? []
        list.push(saId)
        ltGroups.set(ltId, list)
      }
      // SA tiers whose LT appears only once still get a normal column
      saColumns = []
      for (const [ltId, ltSaIds] of ltGroups) {
        if (ltSaIds.length === 1) { saColumns.push(makeSaCol(ltSaIds[0]!)); continue }
        // Merged column — one column for all tiers sharing this LT
        const parentToSa = new Map(ltSaIds.map(id => [saParentOf.get(id) ?? null, id]))
        const ltName = store.getLinguisticType(ltId)?.name ?? ltId
        saColumns.push({
          title:      ltName,
          field:      `_sa_lt_${ltId}`,  // virtual field; formatters read directly from row data
          widthGrow:  1,
          headerSort: false,
          editable: (cell: CellComponent) => {
            const tierId = (cell.getRow().getData() as Row)._tierId
            return parentToSa.has(tierId)
          },
          formatter: (cell: CellComponent) => {
            const data  = cell.getRow().getData() as Row
            const saId  = parentToSa.get(data._tierId) ?? null
            if (!saId) return '<span class="cell-null">∅</span>'
            const val = data[`sa_${saId}`] as string | null
            return (val != null && val !== '') ? val : ''
          },
          accessorDownload: (_value: unknown, data: unknown) => {
            const row = data as Row
            const tierLabel = row._tierId as string
            let matchedSaId: string | null = null
            for (const saId of ltSaIds) {
              const parent = saParentOf.get(saId)
              let parentLabel: string
              if (parent?.startsWith(PSEUDO_UTT_PFX)) {
                parentLabel = 'Utterances'
                if (row._participant !== parent.slice(PSEUDO_UTT_PFX.length)) continue
              } else if (parent?.startsWith(PSEUDO_TOK_PFX)) {
                parentLabel = 'Tokens'
                if (row._participant !== parent.slice(PSEUDO_TOK_PFX.length)) continue
              } else {
                parentLabel = store.getTier(parent ?? '')?.name ?? (parent ?? '')
              }
              if (tierLabel === parentLabel) { matchedSaId = saId; break }
            }
            if (!matchedSaId) return 'NA'
            const val = row[`sa_${matchedSaId}`] as string | null
            return (val != null && val !== '') ? val : 'NULL'
          },
          editor: (cell: CellComponent, onRendered: EmptyCallback, success: ValueBooleanCallback, cancel: ValueVoidCallback) => {
            const data = cell.getRow().getData() as Row
            const saId = parentToSa.get(data._tierId) ?? null
            if (!saId) return document.createElement('span')
            return makeEditor(saId)(cell, onRendered, success, cancel)
          },
          cellEdited: (cell: CellComponent) => {
            const data    = cell.getRow().getData() as Row
            const saId    = parentToSa.get(data._tierId) ?? null
            if (!saId) return
            const value   = String(cell.getValue() ?? '')
            const existId = data[`sa_${saId}_id`] as string | null
            const isWordSa = saParentOf.get(saId)?.startsWith(PSEUDO_TOK_PFX) ?? false
            queueMicrotask(() => {
              if (existId) {
                store.updateAnnotation(existId, { type: value })
              } else if (isWordSa) {
                store.addAnnotation(value, [], { tierId: saId, tokenNodeId: data._id })
              } else {
                store.addAnnotation(value, [], { tierId: saId, parentAnnId: data._id })
              }
            })
          },
        } as ColumnDefinition)
      }
    } else {
      saColumns = info.allSaTierIds.map(makeSaCol)
    }

    const participantCol: ColumnDefinition = {
      title: 'Participant', field: '_participant', width: 70, headerSort: false,
      editable: false,
      cssClass: 'cell-readonly',
    }

    // Block keyup events from reaching Tabulator during its _initializeTable phase.
    // Tabulator defers _create() to a setTimeout; a pending ArrowUp/Down keyup can
    // fire inside _initializeTable() before rows exist.
    const _blockKeyup = (e: KeyboardEvent) => e.stopImmediatePropagation()
    document.addEventListener('keyup', _blockKeyup, { capture: true })

    tab = new Tabulator(tableEl, {
      index:      '_id',
      data:       _buildData(),
      layout:     'fitColumns',
      autoResize: false,
      headerSort: false,
      height:     _getTableHeight(),
      columns: [
        {
          title: 'Tier', field: '_tierId', width: 100, headerSort: false,
          cssClass: 'cell-readonly', editable: false,
          formatter: (c) => {
            const id = c.getValue() as string
            if (id.startsWith(PSEUDO_UTT_PFX)) return 'Utterances'
            if (id.startsWith(PSEUDO_TOK_PFX)) return 'Tokens'
            return store.getTier(id)?.name ?? id
          },
          accessorDownload: (v: unknown) => {
            const id = v as string
            if (id.startsWith(PSEUDO_UTT_PFX)) return 'Utterances'
            if (id.startsWith(PSEUDO_TOK_PFX)) return 'Tokens'
            return store.getTier(id)?.name ?? id
          },
        },
        ...(hasUtt || hasTok ? [participantCol] : []),
        {
          title: 'Annotation', field: 'annotation', widthGrow: 3, headerSort: false,
          editable: (cell: CellComponent) => {
            const tierId = (cell.getRow().getData() as Row)._tierId
            return !tierId.startsWith(PSEUDO_UTT_PFX) && !tierId.startsWith(PSEUDO_TOK_PFX)
          },
          accessorDownload: (v: unknown) => {
            const val = v as string | null
            return (val != null && val !== '') ? val : 'NULL'
          },
          editor:     annotationEditor,
          cellEdited: onAnnotationCellEdited,
        },
        ...saColumns,
        {
          title: 'Start', field: 'start', hozAlign: 'right', width: 90, headerSort: false,
          cssClass: 'time-cell time-cell-seek',
          formatter: (c) => _fmtTime(c.getValue() as number | null),
          accessorDownload: (v: unknown) => v == null ? 'NULL' : _fmtTime(v as number),
          cellClick: (_e, c) => { const v = c.getValue() as number | null; if (v != null) onSeek?.(v) },
        },
        {
          title: 'End', field: 'end', hozAlign: 'right', width: 90, headerSort: false,
          cssClass: 'time-cell time-cell-seek',
          formatter: (c) => _fmtTime(c.getValue() as number | null),
          accessorDownload: (v: unknown) => v == null ? 'NULL' : _fmtTime(v as number),
          cellClick: (_e, c) => { const v = c.getValue() as number | null; if (v != null) onSeek?.(v) },
        },
        {
          title: 'Dur', field: 'duration', hozAlign: 'right', width: 70, headerSort: false,
          cssClass: 'time-cell',
          formatter: (c) => _fmtDuration(c.getValue() as number | null),
          accessorDownload: (v: unknown) => v == null ? 'NULL' : _fmtDuration(v as number),
        },
      ],
    })

    tab.on('tableBuilt', () => {
      document.removeEventListener('keyup', _blockKeyup, { capture: true })
      _tableReady = true
      _applyColVisibility()
    })

    _resizeObserver?.disconnect()
    _resizeObserver = new ResizeObserver(() => { _resizeDirty = true })
    if (tableEl?.parentElement) _resizeObserver.observe(tableEl.parentElement)
    _snapshotUttIds()
  }

  function _snapshotUttIds(): void {
    _uttNodeIds = []
    _uttTokCounts.clear()
    _uttTexts.clear()
    _uttParticipants.clear()
    _doc.forEach((n: PMNode) => {
      if (n.type?.name !== 'utterance' && n.type?.name !== 'event') return
      const id = n.attrs.id as string
      _uttNodeIds.push(id)
      _uttTokCounts.set(id, tokenStore.getUttTokens(id).filter((t: TokenRecord) => t.kind !== 'ws').length)
      _uttTexts.set(id, baseTextContent(n))
      _uttParticipants.set(id, (n.attrs.participant as string) ?? '')
    })
  }

  function _refreshData(): void {
    if (!tab || !_tableReady) return
    const info   = _analyze()
    const newKey = _colKey(info)
    if (newKey !== _currentColKey) { _buildTable(); return }
    void tab.replaceData(_buildData())
    _snapshotUttIds()
  }

  function _applyColVisibility(): void {
    if (!tab || !_tableReady) return
    const tierCol  = tab.getColumn('_tierId')
    const startCol = tab.getColumn('start')
    const endCol   = tab.getColumn('end')
    const durCol   = tab.getColumn('duration')
    if (tierCol)  { if (_showTierCol)  { tierCol.show()  } else { tierCol.hide()  } }
    if (startCol) { if (_showStart)    { startCol.show() } else { startCol.hide() } }
    if (endCol)   { if (_showEnd)      { endCol.show()   } else { endCol.hide()   } }
    if (durCol)   { if (_showDuration) { durCol.show()   } else { durCol.hide()   } }
  }

  // Tier toggle

  function toggleTier(tierId: string): void {
    const next = new SvelteSet(_selectedIds)
    if (next.has(tierId)) next.delete(tierId)
    else                   next.add(tierId)
    _selectedIds = next
    _refreshData()
  }

  // Lifecycle

  onMount(() => {
    _tiers       = store.allTiersOrdered()
    _selectedIds = new Set()
    _buildTable()

    // annotations:changed fires twice per Yjs transaction — once from yAnnotations.observe
    // and once from yAnnotationLists.observeDeep. Use a count so targeted updates can
    // suppress both without letting the second one hit a mid-initializing Tabulator.
    let _skipBatchCount = 0

    const onAnnotationUpdate = (ann: Annotation) => {
      if (!tab || !_tableReady) return
      // Always suppress the annotations:changed that follows every annotation:update.
      // Previously this was set only after targeted updates succeeded, which meant early
      // returns (tier not selected, null parentAnnId) left _skipBatchCount = 0 and let
      // annotations:changed fall through to _refreshData → replaceData.
      _skipBatchCount = 1
      const tierId     = ann.features.tierId as string
      const constraint = store.resolveTierConstraint(tierId)

      if (constraint === 'symbolic_association') {
        if (!_selectedIds.has(tierId)) return
        const parentAnnId = ann.features.parentAnnId as string | null
        const tokenNodeId  = ann.features.tokenNodeId  as string | null
        const rowId = parentAnnId ?? tokenNodeId
        if (!rowId) return
        void tab.updateData([{ _id: rowId, [`sa_${tierId}`]: ann.type, [`sa_${tierId}_id`]: ann.id }])
      } else {
        if (!_selectedIds.has(tierId)) return
        const ta = ann.anchors.find(a => a.type === 'time') as { start: number; end: number } | undefined
        const as_ = ta?.start ?? null
        const ae  = ta?.end   ?? null
        void tab.updateData([{
          _id:        ann.id,
          annotation: ann.type,
          start:      as_,
          end:        ae,
          duration:   as_ != null && ae != null ? +(ae - as_).toFixed(3) : null,
        }])
      }
    }

    const onAnnotationAdd = (ann: Annotation) => {
      if (!tab || !_tableReady) return
      const tierId     = ann.features.tierId as string
      const constraint = store.resolveTierConstraint(tierId)
      // SA adds: update the parent row's column in-place, suppress the batch rebuild
      if (constraint === 'symbolic_association' && _selectedIds.has(tierId)) {
        const parentAnnId = ann.features.parentAnnId as string | null
        const blockNodeId   = ann.features.blockNodeId   as string | null
        const tokenNodeId  = ann.features.tokenNodeId  as string | null
        const rowId = parentAnnId ?? blockNodeId ?? tokenNodeId
        if (rowId) {
          void tab.updateData([{ _id: rowId, [`sa_${tierId}`]: ann.type, [`sa_${tierId}_id`]: ann.id }])
          _skipBatchCount = 2  // yAnnotations + yAnnotationLists both fire
          return
        }
      }
      // Other adds: let annotations:changed handle it (row needs inserting)
    }

    const onAnnotationsChanged = () => {
      if (_skipBatchCount > 0) { _skipBatchCount--; return }
      _refreshData()
    }

    const onTierChange = () => {
      _tiers = store.allTiersOrdered()
      const validTiers = new Set(_tiers.map(t => t.id))
      _selectedIds = new Set([..._selectedIds].filter(id => isPseudo(id) || validTiers.has(id)))
      _buildTable()
      // confirmAddTier adds annotations in a separate Yjs transaction right after
      // addTier(), so annotations:changed fires twice (yAnnotations + yAnnotationLists).
      // Suppress both to avoid replaceData on the freshly-created Tabulator.
      _skipBatchCount = 2
    }

    const onDocClick = (e: MouseEvent) => {
      if (_showDropdown && ddEl && !ddEl.contains(e.target as Node)) _showDropdown = false
      if (_showExportMenu && exportEl && !exportEl.contains(e.target as Node)) _showExportMenu = false
    }

    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (_showDropdown)   { _showDropdown   = false; e.stopPropagation() }
        if (_showExportMenu) { _showExportMenu = false; e.stopPropagation() }
      }
    }

    const onMouseUp = () => {
      if (_resizeDirty) {
        _resizeDirty = false
        tab?.setHeight(_getTableHeight())
        tab?.redraw(true)
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      setTimeout(() => {
        const activeEl = document.activeElement
        if (!activeEl || !tableEl?.contains(activeEl)) return
        const rowEl = activeEl.closest('.tabulator-row') as HTMLElement | null
        if (!rowEl) return
        const trow = (tab?.getRows() ?? []).find(r => r.getElement() === rowEl)
        if (!trow) return
        const data = trow.getData() as Row
        if (data._id === _navRowId) return
        _navRowId = data._id
        if (data.start != null) onSeek?.(data.start)
      }, 0)
    }

    const onTokenTimesChanged = (ids: Set<string>) => {
      if (!tab || !_tableReady) return
      if (![..._selectedIds].some(id => id.startsWith(PSEUDO_TOK_PFX))) {
        // No token rows visible — still suppress the annotations:changed that follows
        _skipBatchCount++
        return
      }
      const updates: object[] = []
      for (const id of ids) {
        const tt = store.getTokenTime(id)
        if (!tt) continue
        const s = tt.start ?? null
        const e = tt.end   ?? null
        updates.push({ _id: id, start: s, end: e, duration: s != null && e != null ? +(e - s).toFixed(3) : null })
      }
      if (updates.length > 0) void tab.updateData(updates)
      _skipBatchCount++
    }

    const onDocChange = (newDoc: PMNode) => {
      // _pushTimelineData fires for annotation changes too (same timelineDoc reference).
      // Only proceed when the PM doc itself actually changed.
      if (newDoc === _doc) return
      _doc = newDoc
      if (!tab || !_tableReady) return

      // Fast path: if no pseudo-tiers selected, doc changes don't affect visible rows
      const hasUttSel = [..._selectedIds].some(id => id.startsWith(PSEUDO_UTT_PFX))
      const hasTokSel = [..._selectedIds].some(id => id.startsWith(PSEUDO_TOK_PFX))
      if (!hasUttSel && !hasTokSel) return

      // Check for structural change: utterances added/removed/reordered, participant changed, or token count changed
      let idx = 0
      let structural = false
      _doc.forEach((n: PMNode) => {
        if (n.type?.name !== 'utterance' && n.type?.name !== 'event') return
        const nodeId = n.attrs.id as string
        if (_uttNodeIds[idx] !== nodeId) { structural = true; idx++; return }
        const newParticipant = (n.attrs.participant as string) ?? ''
        if (newParticipant !== (_uttParticipants.get(nodeId) ?? '')) structural = true
        if (hasTokSel) {
          const newCount = tokenStore.getUttTokens(nodeId).filter((t: TokenRecord) => t.kind !== 'ws').length
          if (newCount !== (_uttTokCounts.get(nodeId) ?? -1)) structural = true
        }
        idx++
      })
      if (structural || idx !== _uttNodeIds.length) { _refreshData(); return }

      // Targeted updates.
      // Token times: handled by onTokenTimesChanged (yTokenTimes observe) — iterating
      // all 10k token rows here would be too slow on every utterance drag.
      // Token text: detected by comparing per-utterance textContent against snapshot.
      const uttUpdates: object[] = []
      const tokUpdates: object[] = []
      _doc.forEach((node: PMNode) => {
        if (node.type?.name !== 'utterance' && node.type?.name !== 'event') return
        const nodeId = node.attrs.id as string
        const p      = (node.attrs.participant as string) ?? ''
        const wantsUtt = hasUttSel && _selectedIds.has(uttId(p))
        const wantsTok = hasTokSel && _selectedIds.has(tokId(p))
        if (wantsUtt) {
          const us = (node.attrs.startTimeSeconds as number | null) ?? null
          const ue = (node.attrs.endTimeSeconds   as number | null) ?? null
          uttUpdates.push({
            _id:        nodeId,
            annotation: baseTextContent(node),
            start:      us,
            end:        ue,
            duration:   us != null && ue != null ? +(ue - us).toFixed(3) : null,
          })
        }
        if (wantsTok) {
          const newText = baseTextContent(node)
          if (newText !== _uttTexts.get(nodeId)) {
            _uttTexts.set(nodeId, newText)
            for (const tok of tokenStore.getUttTokens(nodeId).filter((t: TokenRecord) => t.kind !== 'ws')) {
              tokUpdates.push({ _id: tok.id, annotation: tok.text })
            }
          }
        }
      })
      if (uttUpdates.length > 0) void tab.updateData(uttUpdates)
      if (tokUpdates.length > 0) void tab.updateData(tokUpdates)
    }

    store.on('annotation:update',    onAnnotationUpdate)
    store.on('annotation:add',       onAnnotationAdd)
    store.on('annotations:changed',  onAnnotationsChanged)
    store.on('token-times:changed',  onTokenTimesChanged)
    store.on('tier:add',    onTierChange)
    store.on('tier:update', onTierChange)
    store.on('tier:remove', onTierChange)
    store.on('doc:change',  onDocChange)
    document.addEventListener('click', onDocClick)
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('keydown', onDocKeyDown, true)
    tableEl?.addEventListener('keydown', onKeyDown)

    return () => {
      _resizeObserver?.disconnect(); _resizeObserver = null
      _tableReady = false
      tab?.destroy(); tab = null
      store.off('annotation:update',   onAnnotationUpdate)
      store.off('annotation:add',      onAnnotationAdd)
      store.off('annotations:changed', onAnnotationsChanged)
      store.off('token-times:changed', onTokenTimesChanged)
      store.off('tier:add',    onTierChange)
      store.off('tier:update', onTierChange)
      store.off('tier:remove', onTierChange)
      store.off('doc:change',  onDocChange)
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('keydown', onDocKeyDown, true)
      tableEl?.removeEventListener('keydown', onKeyDown)
    }
  })
</script>

<div class="table-panel">
  <div class="panel-header">
    <div class="tier-dd" bind:this={ddEl}>
      <button
        class="tier-dd-btn"
        class:open={_showDropdown}
        onclick={() => _showDropdown = !_showDropdown}
        aria-haspopup="listbox"
        aria-expanded={_showDropdown}
      >
        <span class="tier-dd-label">Columns</span>
        <svg class="tier-dd-caret" width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true">
          <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>

      {#if _showDropdown}
        <div class="tier-dd-menu" role="listbox" aria-label="Select columns">
          {#each _mixedGroups() as group (group.label)}
            <div class="tier-dd-lineage-label">{group.label || '(no participant)'}</div>
            {#each group.members as member (member.kind === 'tier' ? member.tier.id : member.kind + ':' + member.participant)}
              {#if member.kind === 'pseudo-utt'}
                <label class="tier-dd-item" style="padding-left: {10 + member.depth * 14}px">
                  <input type="checkbox" checked={_selectedIds.has(uttId(member.participant))} onchange={() => toggleTier(uttId(member.participant))} />
                  <span class="tier-dd-name">Utterances</span>
                </label>
              {:else if member.kind === 'pseudo-tok'}
                <label class="tier-dd-item" style="padding-left: {10 + member.depth * 14}px">
                  <input type="checkbox" checked={_selectedIds.has(tokId(member.participant))} onchange={() => toggleTier(tokId(member.participant))} />
                  <span class="tier-dd-name">Tokens</span>
                  <span class="tier-dd-constraint">sub</span>
                </label>
              {:else}
                <label class="tier-dd-item" style="padding-left: {10 + member.depth * 14}px">
                  <input type="checkbox" checked={_selectedIds.has(member.tier.id)} onchange={() => toggleTier(member.tier.id)} />
                  <span class="tier-dd-name">{member.tier.name}</span>
                  {#if member.constraintLabel}<span class="tier-dd-constraint">{member.constraintLabel}</span>{/if}
                  {#if member.tier.participant && member.depth === 0}<span class="tier-dd-participant">{member.tier.participant}</span>{/if}
                </label>
              {/if}
            {/each}
          {/each}
          <div class="tier-dd-lineage-label tier-dd-lineage-label--sep">Display</div>
          <label class="tier-dd-item">
            <input type="checkbox" checked={_showTierCol} onchange={() => { _showTierCol = !_showTierCol; _applyColVisibility() }} />
            <span class="tier-dd-name">Tier</span>
          </label>
          <label class="tier-dd-item">
            <input type="checkbox" checked={_showStart} onchange={() => { _showStart = !_showStart; _applyColVisibility() }} />
            <span class="tier-dd-name">Start</span>
          </label>
          <label class="tier-dd-item">
            <input type="checkbox" checked={_showEnd} onchange={() => { _showEnd = !_showEnd; _applyColVisibility() }} />
            <span class="tier-dd-name">End</span>
          </label>
          <label class="tier-dd-item">
            <input type="checkbox" checked={_showDuration} onchange={() => { _showDuration = !_showDuration; _applyColVisibility() }} />
            <span class="tier-dd-name">Duration</span>
          </label>
        </div>
      {/if}
    </div>
    <button
      class="merge-lt-btn"
      class:active={_mergeLingTypes}
      disabled={!_canMerge}
      title={_canMerge ? 'Merge columns that share a linguistic type' : 'No columns share a linguistic type'}
      onclick={() => { _mergeLingTypes = !_mergeLingTypes; _buildTable() }}
    >
      Merge linguistic types
    </button>

    <div class="export-wrap" bind:this={exportEl}>
      <div class="export-split">
        <button class="export-main" title="Download as CSV" onclick={() => tab?.download('csv', 'table.csv')}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M6 1v7M3 5l3 3 3-3M1 10h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          CSV
        </button>
        <button class="export-arrow" title="Export options" onclick={() => _showExportMenu = !_showExportMenu} aria-haspopup="true" aria-expanded={_showExportMenu}>
          <svg width="8" height="5" viewBox="0 0 8 5" fill="none" aria-hidden="true">
            <path d="M1 1l3 3 3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
      {#if _showExportMenu}
        <div class="export-menu">
          {#each [
            { fmt: 'csv',  label: 'CSV',  ext: 'csv'  },
            { fmt: 'json', label: 'JSON', ext: 'json' },
            { fmt: 'xlsx', label: 'XLSX', ext: 'xlsx' },
            { fmt: 'pdf',  label: 'PDF',  ext: 'pdf'  },
            { fmt: 'html', label: 'HTML', ext: 'html' },
          ] as opt (opt.fmt)}
            <button onclick={() => { tab?.download(opt.fmt as DownloadType, `table.${opt.ext}`); _showExportMenu = false }}>
              {opt.label}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <div class="table-area">
    <div class="table-border" bind:this={tableEl}></div>
  </div>
</div>

<style>
  .table-panel {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  /* ── Panel header ──────────────────────────────────────────────────────── */
  .panel-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    border-bottom: 1px solid var(--color-border, #ccc);
    background: var(--color-primary-light);
    flex-shrink: 0;
  }

  /* ── Tier dropdown ─────────────────────────────────────────────────────── */
  .tier-dd { position: relative; }

  .tier-dd-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0.2rem 0.55rem;
    border: 1px solid var(--color-border, #ccc);
    border-radius: var(--radius-sm, 4px);
    background: var(--color-bg-0, #fff);
    font-family: inherit;
    font-size: var(--font-xs, 0.72rem);
    font-weight: 600;
    color: var(--color-text-2, #444);
    cursor: pointer;
    white-space: nowrap;
  }
  .tier-dd-btn:hover { background: var(--color-bg-2, #f5f5f5); }
  .tier-dd-btn.open  { border-color: var(--color-primary, #4a9eff); }
  /* ── Merge LT toggle ──────────────────────────────────────────────────── */
  .merge-lt-btn {
    display: inline-flex;
    align-items: center;
    padding: 0.2rem 0.55rem;
    border: 1px solid var(--color-border, #ccc);
    border-radius: var(--radius-sm, 4px);
    background: var(--color-bg-0, #fff);
    font-family: inherit;
    font-size: var(--font-xs, 0.72rem);
    font-weight: 600;
    color: var(--color-text-2, #444);
    cursor: pointer;
    white-space: nowrap;
  }
  .merge-lt-btn:hover:not(:disabled) { background: var(--color-bg-2, #f5f5f5); }
  .merge-lt-btn.active {
    background: var(--color-active-light);
    border-color: var(--color-active);
    color: var(--color-active-dark);
  }
  .merge-lt-btn.active:hover:not(:disabled) {
    background: var(--color-active-light);
    border-color: var(--color-active);
    color: var(--color-active-dark);
  }
  .merge-lt-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  /* ── Export split button ───────────────────────────────────────────────── */
  .export-wrap { position: relative; margin-left: auto; }

  .export-split {
    display: inline-flex;
    align-items: stretch;
    border: 1px solid var(--color-border, #ccc);
    border-radius: var(--radius-sm, 4px);
    overflow: hidden;
  }

  .export-main {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0.2rem 0.5rem;
    border: none;
    border-radius: 0;
    background: var(--color-bg-0, #fff);
    font-family: inherit;
    font-size: var(--font-xs, 0.72rem);
    font-weight: 600;
    color: var(--color-text-2, #444);
    cursor: pointer;
  }
  .export-main:hover { background: var(--color-bg-2, #f5f5f5); }

  .export-arrow {
    display: inline-flex;
    align-items: center;
    padding: 0 5px;
    border: none;
    border-left: 1px solid var(--color-border, #ccc);
    border-radius: 0;
    background: var(--color-bg-1, #fafafa);
    color: var(--color-text-muted, #999);
    cursor: pointer;
  }
  .export-arrow:hover { background: var(--color-bg-3, #f0f0f0); color: var(--color-text-2, #444); }

  .export-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 50;
    background: var(--color-bg-0, #fff);
    border: 1px solid var(--color-border-strong, #ddd);
    border-radius: var(--radius-md, 6px);
    box-shadow: var(--shadow-menu, 0 4px 16px rgba(0,0,0,0.12));
    padding: 4px 0;
    min-width: 80px;
  }
  .export-menu button {
    display: block;
    width: 100%;
    padding: 0.3rem 0.8rem;
    border: none;
    border-radius: 0;
    background: transparent;
    text-align: left;
    font-size: var(--font-sm, 0.8rem);
    color: var(--color-text-1, #222);
    cursor: pointer;
  }
  .export-menu button:hover { background: var(--color-bg-menu-hover, #f5f5f5); }

.tier-dd-caret {
    color: var(--color-text-muted, #999);
    flex-shrink: 0;
    transition: transform 0.15s;
  }
  .tier-dd-btn.open .tier-dd-caret { transform: rotate(180deg); }

  .tier-dd-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 50;
    min-width: 200px;
    max-width: 300px;
    max-height: 300px;
    overflow-y: auto;
    background: var(--color-bg-0, #fff);
    border: 1px solid var(--color-border, #ccc);
    border-radius: var(--radius-md, 6px);
    box-shadow: var(--shadow-menu, 0 4px 16px rgba(0,0,0,0.12));
    padding: 4px 0;
  }

  .tier-dd-lineage-label {
    padding: 6px 10px 2px;
    font-size: var(--font-xs, 0.72rem);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted, #999);
  }
  .tier-dd-lineage-label:not(:first-child),
  .tier-dd-lineage-label--sep {
    border-top: 1px solid var(--color-border, #eee);
    margin-top: 4px;
    padding-top: 8px;
  }

  .tier-dd-item {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 4px 10px;
    font-size: var(--font-sm, 0.8rem);
    cursor: pointer;
    user-select: none;
  }
  .tier-dd-item:hover { background: var(--color-bg-menu-hover, #f5f5f5); }

  .tier-dd-name {
    font-weight: 600;
    color: var(--color-text-1, #222);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tier-dd-constraint {
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--color-bg-4, #e8e8e8);
    color: var(--color-text-3, #666);
    flex-shrink: 0;
  }

  .tier-dd-participant {
    color: var(--color-text-muted, #999);
    font-size: var(--font-xs, 0.72rem);
    flex-shrink: 0;
  }

  /* ── Table area ────────────────────────────────────────────────────────── */
  .table-area {
    flex: 1;
    min-height: 0;
  }

  .table-border { border: 1px solid #bbb; }

  /* ── Tabulator overrides ───────────────────────────────────────────────── */
  /* Tabulator adds .tabulator to the container element itself, so
     .table-border and .tabulator are on the same element. */
  :global(.table-border.tabulator) {
    border: none; border-radius: 0; font-family: system-ui, sans-serif; font-size: 0.8rem;
  }
  :global(.table-border .tabulator-header) {
    background: var(--color-primary-light);
    border-bottom: 1px solid var(--color-primary-border);
  }
  :global(.table-border .tabulator-headers) {
    background: var(--color-primary-light);
  }
  :global(.table-border .tabulator-header .tabulator-col) {
    background: transparent;
    border-right: 1px solid var(--color-primary-border);
    font-size: 0.71rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.04em; color: var(--color-primary-dark);
  }
  :global(.table-border .tabulator-col-title)  { padding: 0.4rem 0.6rem; }
  :global(.table-border .tabulator-col-sorter) { display: none !important; }
  :global(.table-border .tabulator-row)        { border-bottom: 1px solid #ddd; background: #fff; }
  :global(.table-border .tabulator-row:nth-child(even)) { background: #f4f5f6; }
  :global(.table-border .tabulator-row:hover)  { background: var(--color-primary-light); }
  :global(.table-border .tabulator-cell) {
    padding: 0.35rem 0.6rem; border-right: 1px solid #ddd; color: #222; cursor: text;
  }
  :global(.tab-cell-input), :global(.tab-cell-select) {
    width: 100%; height: 100%; padding: 0.28rem 0.45rem;
    border: none; outline: 2px solid var(--color-primary, #4a9eff);
    font-family: system-ui, sans-serif; font-size: 0.8rem; color: #111;
    background: #fff; box-sizing: border-box;
  }
  :global(.tab-cell-select) { cursor: pointer; }

  /* ── Read-only cells ──────────────────────────────────────────────────────── */
  :global(.table-border .tabulator-cell.cell-readonly) {
    cursor: default;
    color: var(--color-text-3, #555);
  }

  /* ── Null / N-A cells ────────────────────────────────────────────────────── */
  :global(.table-border .tabulator-cell .cell-null) {
    color: var(--color-text-muted, #bbb);
    cursor: default;
  }

  /* ── Time cell styling (matches .utt-time in transcript) ─────────────────── */
  :global(.table-border .tabulator-cell.time-cell) {
    font-size: 0.72em;
    color: var(--color-text-light, #888);
    font-variant-numeric: tabular-nums;
  }
  :global(.table-border .tabulator-cell.time-cell-seek) {
    cursor: pointer;
  }
  :global(.table-border .tabulator-cell.time-cell-seek:hover) {
    color: var(--color-primary, #4a9eff);
  }
</style>
