/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import type { Node } from 'prosemirror-model'
import type { Lane, BarItem } from '@mumo/timeline'
import type { TierDef, Annotation, TokenStore, LinguisticType, TierConstraint, AnnotationStore, AnchorJSON } from '@mumo/core'
import { isTokenLtId, TOKEN_LT_II_ID, baseTextContent, orderTiersDepthFirst, buildTierDepths } from '@mumo/core'

// Dark grey — provides contrast for the dx/dy/velocity motion curve overlays.
const TRACK_PRESENCE_COLOR = 0x444444

// Okabe-Ito categorical palette (colorblind-friendly)

const PALETTE = [
  0xE69F00,  // orange
  0x56B4E9,  // sky blue
  0x009E73,  // bluish green
  0x0072B2,  // blue
  0xD55E00,  // vermillion
  0xCC79A7,  // reddish purple
  0xF0E442,  // yellow
]

/** Base tier attr for lane computations: the reserved 'utterance' default is treated as none. */
export function uttTierBase(tierAttr: string | null | undefined): string {
  const t = tierAttr ?? ''
  return t === 'utterance' ? '' : t
}

/** Lane ID for an utterance: <base>:<participant> for custom tiers, utterance:<participant>
 *  by default, utterance:unknown when there is neither. Labels mirror IDs (always unique).
 *  A suffix equal to the base is redundant and skipped (ELAN tier FA1 for participant FA1
 *  stays FA1, not FA1:FA1). */
export function uttLaneId(tierAttr: string | null | undefined, participant: string): string {
  const base = uttTierBase(tierAttr)
  return base
    ? (participant && participant !== base ? `${base}:${participant}` : base)
    : (participant ? `utterance:${participant}` : 'utterance:unknown')
}

// Main transform

export function docToTimeline(
  doc: Node,
  tiers: TierDef[] = [],
  annotations: Annotation[] = [],
  tokenStore?: TokenStore,
  linguisticTypes: LinguisticType[] = [],
  trackPresence: Map<string, { startSeconds: number; endSeconds: number }> = new Map(),
  store?: AnnotationStore,
): { lanes: Lane[]; bars: BarItem[] } {
  const ltById = new Map(linguisticTypes.map(lt => [lt.id, lt]))
  const resolveConstraint = (tier: TierDef): TierConstraint | undefined =>
    tier.linguisticTypeId ? ltById.get(tier.linguisticTypeId)?.constraint : undefined
  const laneMap = new Map<string, Lane>()
  const bars: BarItem[] = []

  // participant → palette color (stable: hash-derived so order-independent)
  const groupColor = new Map<string, number>()
  function colorFor(key: string): number {
    if (!groupColor.has(key)) {
      let h = 5381
      for (let i = 0; i < key.length; i++) h = (h * 33 ^ key.charCodeAt(i)) >>> 0
      groupColor.set(key, PALETTE[h % PALETTE.length]!)
    }
    return groupColor.get(key)!
  }

  // tokenNodeId / blockNodeId → computed {start, end} — populated alongside bar creation
  const tokenNodeLookup = new Map<string, { start: number; end: number }>()
  const blockNodeLookup  = new Map<string, { start: number; end: number }>()

  // lt-token TierDefs (token tiers imported from EAF) become the token lane for their participant
  const participantTokenTier = new Map<string, TierDef>()
  for (const tier of tiers) {
    if (isTokenLtId(tier.linguisticTypeId) && tier.participant)
      participantTokenTier.set(tier.participant, tier)
  }
  const namedTokenLaneIds = new Set<string>()

  // Utterance time suggestion map
  const uttSugMap = new Map<string, { suggestionId: string; newStart: number; newEnd: number }>()
  if (store) {
    for (const sug of store.allSuggestions()) {
      if (sug.change.type === 'utt:set-time') {
        uttSugMap.set(sug.change.uttId, { suggestionId: sug.id, newStart: sug.change.startTime, newEnd: sug.change.endTime })
      }
    }
  }

  let prevEnd = 0

  doc.forEach((node) => {
    if (node.type.name === 'utterance') {
      // Skip blank placeholder blocks: empty content, no timing, no participant.
      if (
        node.content.size === 0 &&
        node.attrs.startTimeSeconds === null &&
        !node.attrs.participant
      ) return

      const participant: string = (node.attrs.participant as string | null) ?? ''
      const tierAttr = uttTierBase(node.attrs.tier as string | undefined)
      const laneId = uttLaneId(tierAttr, participant)
      // Token lane: tokens:<participant> or tokens:unknown (flat, no nested prefix)
      const tokenTierDef = participantTokenTier.get(participant)
      const tokenLaneId = tokenTierDef
        ? `ann:${tokenTierDef.id}`
        : (participant ? `tokens:${participant}` : 'tokens:unknown')

      const c = colorFor(tierAttr || participant)
      if (!laneMap.has(laneId)) {
        laneMap.set(laneId, { id: laneId, label: laneId, type: 'participant', participant, color: c })
      }
      if (!laneMap.has(tokenLaneId)) {
        if (tokenTierDef) namedTokenLaneIds.add(tokenLaneId)
        laneMap.set(tokenLaneId, { id: tokenLaneId, label: tokenTierDef?.name ?? tokenLaneId, type: 'token', participant, color: c })
      }

      const rawStart: number | null = node.attrs.startTimeSeconds
      const rawEnd:   number | null = node.attrs.endTimeSeconds

      let uttStart: number
      let uttEnd: number
      let placeholder = false

      if (rawStart !== null) {
        uttStart = rawStart
        uttEnd = rawEnd ?? rawStart + 1
      } else {
        uttStart = prevEnd
        uttEnd = prevEnd + 1
        placeholder = true
      }

      prevEnd = Math.max(prevEnd, uttEnd)

      const uttColor = laneMap.get(laneId)!.color
      const uttSugEntry = uttSugMap.get(node.attrs.id as string)
      blockNodeLookup.set(node.attrs.id as string, { start: uttStart, end: uttEnd })
      bars.push({
        id: node.attrs.id,
        nodeId: node.attrs.id,
        start: uttStart,
        end: uttEnd,
        label: baseTextContent(node),
        laneId,
        type: 'utterance',
        placeholder,
        ...(uttColor !== undefined ? { color: uttColor } : {}),
        ...(uttSugEntry !== undefined ? { suggestionKind: 'move-old' as const, suggestionId: uttSugEntry.suggestionId } : {}),
      })

      if (uttSugEntry) {
        bars.push({
          id:             `suggestion-utt-move:${uttSugEntry.suggestionId}`,
          nodeId:         `suggestion-utt-move:${uttSugEntry.suggestionId}`,
          start:          uttSugEntry.newStart,
          end:            uttSugEntry.newEnd,
          label:          baseTextContent(node),
          laneId,
          type:           'utterance',
          summaryHidden:  true,
          suggestionKind: 'move-new',
          suggestionId:   uttSugEntry.suggestionId,
          ...(uttColor !== undefined ? { color: uttColor } : {}),
        })
      }

      const tokenNodes = (tokenStore?.getUttTokens(node.attrs.id as string) ?? [])
        .filter(t => t.kind !== 'ws')
        .map(t => { const time = store?.getTokenTime(t.id); return { id: t.id, text: t.text, ws: time?.start ?? null, we: time?.end ?? null } })

      const n = tokenNodes.length
      if (n > 0) {
        const uttDur = uttEnd - uttStart
        // A "sentinel" stored time (ws === we) marks only the outer edge — it doesn't pin an
        // interior boundary. Lane is considered time_subdivision if any token has a stored time.
        const hasAnyStoredTime = tokenNodes.some(w => w.ws !== null)
        const tokenTierIsIncludedIn = tokenTierDef?.linguisticTypeId === TOKEN_LT_II_ID
        tokenNodes.forEach((w, i) => {
          const isSentinel = w.ws !== null && w.ws === w.we
          const ws = (!isSentinel && w.ws !== null) ? w.ws : (uttStart + (i / n) * uttDur)
          const we = (!isSentinel && w.we !== null) ? w.we : (uttStart + ((i + 1) / n) * uttDur)
          tokenNodeLookup.set(w.id, { start: ws, end: we })
          bars.push({
            id: w.id,
            nodeId: w.id,
            start: ws,
            end: we,
            label: w.text,
            laneId: tokenLaneId,
            type: 'token',
            placeholder: w.ws === null,
            constraint: tokenTierIsIncludedIn ? 'included_in' : (hasAnyStoredTime ? 'time_subdivision' : 'symbolic_subdivision'),
            ...(uttColor !== undefined ? { color: uttColor } : {}),
            parentNodeId: node.attrs.id as string,
            listIndex: i,
            // Timed edge = real stored time (not sentinel) OR parent utterance endpoint
            startTimed: (!isSentinel && w.ws !== null) || (i === 0 && !placeholder && hasAnyStoredTime),
            endTimed:   (!isSentinel && w.we !== null) || (i === n - 1 && !placeholder && hasAnyStoredTime),
          })
        })
      }
    } else if (node.type.name === 'visualization') {
      const vizType: string = (node.attrs.type as string) || 'visualization'
      const participant: string = (node.attrs.participant as string) || ''

      // Each tied viz gets its own child lane under the parent speaker group.
      // Independent vizs get a shared lane per type, placed at the bottom.
      let laneId: string
      if (participant) {
        laneId = `viz:spk:${participant}:${vizType}`
        if (!laneMap.has(laneId)) {
          const c = colorFor(participant)
          laneMap.set(laneId, { id: laneId, label: vizType, type: 'visualization', participant: participant, color: c, depth: 1 })
        }
      } else {
        laneId = `viz:${vizType}`
        if (!laneMap.has(laneId)) {
          laneMap.set(laneId, { id: laneId, label: vizType, type: 'visualization', participant: '_viz', depth: 1 })
        }
      }

      const vizStart: number | null = node.attrs.startTimeSeconds
      const vizEnd: number | null = node.attrs.endTimeSeconds
      const dependent: boolean = !!node.attrs.dependent
      const parentNodeId: string | null = (node.attrs.parentNodeId as string | null) ?? null
      if (vizStart !== null) {
        bars.push({
          id: node.attrs.id,
          nodeId: node.attrs.id,
          start: vizStart,
          end: vizEnd ?? vizStart + 0.5,
          label: (node.attrs.label as string) || vizType,
          laneId,
          type: 'annotation',
          summaryHidden: true,
          ...(dependent ? { constraint: 'symbolic_association', ...(parentNodeId ? { parentNodeId } : {}) } : {}),
        })
      }
    }
  })

  // Annotation suggestion kind map
  // Pre-compute per-annotation visual treatment so the tier loop can include it inline.
  type AnnSugEntry =
    | { kind: 'move-old';     suggestionId: string; newAnchors: AnchorJSON[] }
    | { kind: 'delete';       suggestionId: string }
    | { kind: 'update-label'; suggestionId: string }

  const annSugMap = new Map<string, AnnSugEntry>()
  if (store) {
    for (const sug of store.allSuggestions()) {
      const c = sug.change
      if (c.type === 'annotation:delete') {
        annSugMap.set(c.annotationId, { kind: 'delete', suggestionId: sug.id })
      } else if (c.type === 'annotation:update') {
        if (c.patch.anchors) {
          annSugMap.set(c.annotationId, { kind: 'move-old', suggestionId: sug.id, newAnchors: c.patch.anchors })
        } else if (c.patch.type !== undefined) {
          annSugMap.set(c.annotationId, { kind: 'update-label', suggestionId: sug.id })
        }
      }
    }
  }

  // Annotation tiers (depth-first, parent before children)
  const orderedTiers = orderTiersDepthFirst(tiers)
  const tierDepths   = buildTierDepths(tiers)

  const annsByTier = new Map<string, Annotation[]>()
  for (const ann of annotations) {
    const tierId = ann.features.tierId
    if (!tierId) continue
    if (!annsByTier.has(tierId)) annsByTier.set(tierId, [])
    annsByTier.get(tierId)!.push(ann)
  }

  // Precompute list indices and sibling counts: for each (tierId, parentAnnId) group.
  // Word-child tiers (parentTier.linguisticTypeId === 'lt-token') store all anns under
  // parentAnnId=undefined but need per-tokenNodeId indices for symbolic_subdivision rendering.
  const annListIndex   = new Map<string, number>()
  const annSiblingCount = new Map<string, number>()
  if (store) {
    for (const tier of orderedTiers) {
      const parentTierDef = tier.parentTierId ? tiers.find(t => t.id === tier.parentTierId) : undefined
      const parentIsWord  = parentTierDef ? isTokenLtId(parentTierDef.linguisticTypeId) : false
      if (parentIsWord) {
        // All anns in this tier are keyed under parentAnnId=undefined; group by tokenNodeId instead.
        const allOrdered = store.getOrderedAnnotations(tier.id, undefined)
        const byWord = new Map<string, typeof allOrdered>()
        for (const ann of allOrdered) {
          const wid = (ann.features.tokenNodeId) ?? ''
          if (!byWord.has(wid)) byWord.set(wid, [])
          byWord.get(wid)!.push(ann)
        }
        for (const wordAnns of byWord.values()) {
          wordAnns.forEach((ann, i) => { annListIndex.set(ann.id, i); annSiblingCount.set(ann.id, wordAnns.length) })
        }
      } else {
        const tierAnns = annsByTier.get(tier.id) ?? []
        const parentIds = new Set<string | undefined>()
        for (const ann of tierAnns) parentIds.add(ann.features.parentAnnId)
        for (const parentId of parentIds) {
          const ordered = store.getOrderedAnnotations(tier.id, parentId)
          ordered.forEach((ann, i) => { annListIndex.set(ann.id, i); annSiblingCount.set(ann.id, ordered.length) })
        }
      }
    }
  }

  const annTimeLookup = new Map<string, { start: number; end: number }>()
  for (const ann of annotations) {
    const ta = ann.anchors.find(a => a.type === 'time')
    if (ta) annTimeLookup.set(ann.id, { start: ta.start, end: ta.end })
  }

  // Propagate participant down the tier tree so child tiers share their parent's colour.
  // orderTiersDepthFirst guarantees parents come before children, so one forward pass suffices.
  const tierParticipant = new Map<string, string>()
  for (const tier of orderedTiers) {
    const p = tier.participant
      ?? (tier.parentTierId ? tierParticipant.get(tier.parentTierId) : undefined)
    if (p) tierParticipant.set(tier.id, p)
  }

  for (const tier of orderedTiers) {
    // lt-token and isUttTier tiers are structural — not separate annotation lanes
    if (isTokenLtId(tier.linguisticTypeId)) continue
    if (tier.isUttTier) continue

    const effectiveParticipant = tierParticipant.get(tier.id) ?? ''
    const laneColor = effectiveParticipant ? colorFor(effectiveParticipant) : undefined

    const laneId = `ann:${tier.id}`
    const depth = tierDepths.get(tier.id) ?? 0
    laneMap.set(laneId, {
      id: laneId,
      label: tier.name,
      type: tier.trackRef ? 'track' : 'annotation',
      participant: effectiveParticipant,
      depth,
      ...(laneColor !== undefined ? { color: laneColor } : {}),
    })

    // Track presence bar — spans the full extent of loaded detection data.
    if (tier.trackRef) {
      const range = trackPresence.get(tier.id)
      if (range) {
        bars.push({
          id: `track-presence:${tier.id}`,
          nodeId: `track-presence:${tier.id}`,
          start: range.startSeconds,
          end: range.endSeconds,
          label: '',
          laneId,
          type: 'track',
          color: TRACK_PRESENCE_COLOR,
          locked: true,
        })
      }
    }

    for (const ann of annsByTier.get(tier.id) ?? []) {
      let start: number | undefined
      let end:   number | undefined

      if (resolveConstraint(tier) === 'symbolic_association') {
        const parentAnnId = ann.features.parentAnnId
        if (parentAnnId) {
          const pt = annTimeLookup.get(parentAnnId)
          if (pt) { start = pt.start; end = pt.end }
        }
        const tokenNodeId = ann.features.tokenNodeId
        if (tokenNodeId && start === undefined) {
          const pt = tokenNodeLookup.get(tokenNodeId)
          if (pt) { start = pt.start; end = pt.end }
        }
        const blockNodeId = ann.features.blockNodeId
        if (blockNodeId && start === undefined) {
          const pt = blockNodeLookup.get(blockNodeId)
          if (pt) { start = pt.start; end = pt.end }
        }
      }

      if (resolveConstraint(tier) === 'symbolic_subdivision') {
        const parentAnnId = ann.features.parentAnnId
        if (parentAnnId) {
          const pt = annTimeLookup.get(parentAnnId)
          if (pt) {
            const i     = annListIndex.get(ann.id) ?? 0
            const count = annSiblingCount.get(ann.id) ?? 1
            const span  = pt.end - pt.start
            start = pt.start + span * i / count
            end   = pt.start + span * (i + 1) / count
          }
        }
        const tokenNodeId = ann.features.tokenNodeId
        if (tokenNodeId && start === undefined) {
          const pt = tokenNodeLookup.get(tokenNodeId)
          if (pt) {
            const i     = annListIndex.get(ann.id) ?? 0
            const count = annSiblingCount.get(ann.id) ?? 1
            const span  = pt.end - pt.start
            start = pt.start + span * i / count
            end   = pt.start + span * (i + 1) / count
          }
        }
      }

      if (start === undefined) {
        const ta = ann.anchors.find(a => a.type === 'time')
        if (ta) { start = ta.start; end = ta.end }
      }

      if (start === undefined) continue

      // Record the resolved position so deeper children (symbolic_subdivision of symbolic_subdivision)
      // can find their parent's time even when it has no stored anchor.
      annTimeLookup.set(ann.id, { start, end: end ?? start })

      const isSymbolic = resolveConstraint(tier) === 'symbolic_subdivision' || resolveConstraint(tier) === 'symbolic_association'
      const parentAnnId  = ann.features.parentAnnId
      const tokenNodeId   = ann.features.tokenNodeId
      const blockNodeId   = ann.features.blockNodeId
      // tokenNodeId takes priority over parentAnnId: EAF import sets parentAnnId to a ghost
      // ID (word-tier EAF ref not in the annotation store), while tokenNodeId is the real token.
      const annParentNodeId = tokenNodeId ?? parentAnnId ?? blockNodeId
      const annLI = annListIndex.get(ann.id)
      const annConstraint = resolveConstraint(tier)
      const annSugEntry = annSugMap.get(ann.id)
      bars.push({
        id: ann.id,
        nodeId: ann.id,
        start,
        end: end ?? start + 0.1,
        label: ann.type || '',
        laneId,
        type: 'annotation',
        ...(laneColor !== undefined ? { color: laneColor } : {}),
        ...(isSymbolic ? { summaryHidden: true } : {}),
        ...(annParentNodeId !== undefined ? { parentNodeId: annParentNodeId } : {}),
        ...(annConstraint !== undefined ? { constraint: annConstraint } : {}),
        ...(annLI !== undefined ? { listIndex: annLI } : {}),
        ...(annSugEntry !== undefined ? { suggestionKind: annSugEntry.kind, suggestionId: annSugEntry.suggestionId } : {}),
      })

      // For moved annotations: also push a ghost bar at the proposed new position.
      if (annSugEntry?.kind === 'move-old') {
        const newTa = annSugEntry.newAnchors.find(a => a.type === 'time')
        if (newTa) {
          bars.push({
            id:             `suggestion-move:${annSugEntry.suggestionId}`,
            nodeId:         `suggestion-move:${annSugEntry.suggestionId}`,
            start:          newTa.start,
            end:            newTa.end,
            label:          ann.type || '',
            laneId,
            type:           'annotation',
            summaryHidden:  true,
            suggestionKind: 'move-new',
            suggestionId:   annSugEntry.suggestionId,
          })
        }
      }
    }

  }

  // Lane ordering
  // Insert viz child lanes tied to a specific participant (viz:spk:participant:type)
  function insertParticipantVizLanes(speaker: string) {
    const prefix = `viz:spk:${speaker}:`
    for (const [vid, vlane] of laneMap) {
      if (vid.startsWith(prefix)) reordered.set(vid, vlane)
    }
  }

  const reordered = new Map<string, Lane>()

  for (const [id, lane] of laneMap) {
    reordered.set(id, lane)
    if (lane.type === 'token') {
      const laneParticipant = lane.participant
      // Walk depth-first through orderedTiers, seeding from:
      //   (a) root annotation tiers whose participant === laneParticipant
      //   (b) lt-word tiers for this participant (which aren't annotation lanes themselves but whose
      //       children — e.g. EAF-imported POS tiers — should appear here)
      // Then transitively include all children, regardless of their own participant field,
      // so that child tiers added via addChildDlg (which inherit no participant) still land
      // directly under their parent.
      const placed = new Set<string>()

      // Seed: lt-word tiers and isUttTier tiers for this participant.
      // isUttTier entries are invisible (skipped in the loop above) but act as transparent
      // parents — their children (e.g. gloss tiers) should still land inside this participant block.
      for (const tier of orderedTiers) {
        if (isTokenLtId(tier.linguisticTypeId) && tier.participant === laneParticipant) placed.add(tier.id)
        if (tier.isUttTier && tier.participant === laneParticipant) placed.add(tier.id)
      }

      // Pass 1: token-child tiers (children of this participant's token tier, recursively).
      // These appear indented under the token lane.
      for (const tier of orderedTiers) {
        if (isTokenLtId(tier.linguisticTypeId)) continue
        if (tier.isUttTier) continue
        if (tier.parentTierId && placed.has(tier.parentTierId)) {
          placed.add(tier.id)
          const annId = `ann:${tier.id}`
          const annLane = laneMap.get(annId)
          if (annLane) reordered.set(annId, annLane)
        }
      }

      // Pass 2: children of already-placed tiers (recursively).
      // Only tiers with an explicit parentTierId that chains back to this participant block are nested here.
      // Tiers with a participant but no parentTierId are top-level and will appear outside participant blocks.
      for (const tier of orderedTiers) {
        if (isTokenLtId(tier.linguisticTypeId)) continue
        if (tier.isUttTier) continue
        if (placed.has(tier.id)) continue
        const parentPlaced = tier.parentTierId ? placed.has(tier.parentTierId) : false
        if (parentPlaced) {
          placed.add(tier.id)
          const annId = `ann:${tier.id}`
          const annLane = laneMap.get(annId)
          if (annLane) reordered.set(annId, annLane)
        }
      }
      insertParticipantVizLanes(laneParticipant)
    }
  }

  // Anything not yet placed
  for (const [id, lane] of laneMap) {
    if (reordered.has(id)) continue
    if (id.startsWith('viz:')) continue  // independent viz placed last
    reordered.set(id, lane)
  }

  // Independent visualization lanes (viz:type) at the bottom
  for (const [id, lane] of laneMap) {
    if (!reordered.has(id)) reordered.set(id, lane)
  }

  // Pending annotation:add suggestions — ghost bars
  // These annotations don't exist in the store yet; synthesize a bar so the user
  // can see and accept/reject them directly in the timeline.
  if (store) {
    for (const sug of store.allSuggestions()) {
      if (sug.change.type !== 'annotation:add') continue
      const ann = sug.change.annotation
      const tierId = ann.features.tierId
      if (!tierId) continue
      const laneId = `ann:${tierId}`
      if (!reordered.has(laneId)) continue
      const ta = ann.anchors.find(a => a.type === 'time')
      if (!ta) continue
      bars.push({
        id:             `suggestion:${sug.id}`,
        nodeId:         `suggestion:${sug.id}`,
        start:          ta.start,
        end:            ta.end,
        label:          ann.type || '',
        laneId,
        type:           'annotation',
        summaryHidden:  true,
        suggestionKind: 'add',
        suggestionId:   sug.id,
      })
    }
  }

  const builtLanes = Array.from(reordered.values())
  return { lanes: builtLanes, bars }
}
