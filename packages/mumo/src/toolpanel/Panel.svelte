<script lang="ts">
  import type { AnnotationStore, PatternSchema, Pattern, ControlledVocabulary, Annotation, TokenStore, ParticipantJSON, Bookmark } from '@mumo/core'
  import type { ID } from '@mumo/core'
  import type { SlotFillMode } from '../patternTypes.js'
  import type { PMNode } from '@mumo/core'
  import PatternsPanel from './PatternsPanel.svelte'
  import TextletsPanel from './TextletsPanel.svelte'
  import TablePanel from './TablePanel.svelte'
  import SuggestionsPanel from './SuggestionsPanel.svelte'
  import BookmarksPanel from './BookmarksPanel.svelte'

  const {
    store,
    tokenStore,
    patternSchemas,
    patterns,
    vocabs,
    participants = [],
    annotations,
    doc,
    slotFillMode,
    selectedPatternId = null,
    bookmarks = [],
    playhead = 0,
    tlSelection = null,
    myAuthorId = 'Anonymous',
    onSelectPattern,
    onRequestSlotFill,
    onCancelSlotFill,
    onFillWithPattern,
    onDeleteTextlet,
    onHoverTextletMark,
    onHoverSlot,
    onHoverPattern,
    onSeek,
    onCreateBookmark,
    onUpdateBookmark,
    onDeleteBookmark,
    onAddToCollection,
    activeCollectionName = null,
    editorMode = 'annotate',
    suggestMode = false,
  }: {
    store: AnnotationStore
    tokenStore: TokenStore
    patternSchemas: PatternSchema[]
    patterns: Pattern[]
    vocabs: ControlledVocabulary[]
    participants?: ParticipantJSON[]
    annotations: Annotation[]
    doc: PMNode
    slotFillMode: SlotFillMode | null
    selectedPatternId?: ID | null
    bookmarks?: Bookmark[]
    playhead?: number
    tlSelection?: { start: number; end: number } | null
    myAuthorId?: string
    onSelectPattern?: (id: ID | null) => void
    onRequestSlotFill: (patternId: ID, slotSchemaId: ID, anchorKind: 'span' | 'utterance' | 'pattern' | 'any') => void
    onCancelSlotFill: () => void
    onFillWithPattern?: (patternId: ID) => void
    onDeleteTextlet: (annId: string, markId: string) => void
    onHoverTextletMark: (markId: string | null) => void
    onHoverSlot?: (slotSchemaId: ID | null) => void
    onHoverPattern?: (patternId: ID | null) => void
    editorMode?: 'edit' | 'annotate'
    onSeek?: (time: number) => void
    onCreateBookmark?: (start: number, end: number, label: string, note?: string, code?: string) => void
    onUpdateBookmark?: (id: ID, patch: { label?: string; startSeconds?: number; endSeconds?: number; note?: string | undefined; code?: string | undefined }) => void
    onDeleteBookmark?: (id: ID) => void
    onAddToCollection?: (bm: Bookmark) => void
    activeCollectionName?: string | null
    suggestMode?: boolean
  } = $props()

  type Tab = 'patterns' | 'textlets' | 'table' | 'suggestions' | 'bookmarks'
  let activeTab = $state<Tab>('patterns')

  let suggestionCount = $state(0)
  $effect(() => {
    const update = () => {
      suggestionCount = store.allSuggestions().length
      if (suggestionCount === 0 && activeTab === 'suggestions') activeTab = 'patterns'
    }
    update()
    store.on('suggestions:changed', update)
    return () => store.off('suggestions:changed', update)
  })

  const tabs = $derived<Tab[]>(
    suggestionCount > 0
      ? ['patterns', 'textlets', 'table', 'bookmarks', 'suggestions']
      : ['patterns', 'textlets', 'table', 'bookmarks']
  )
</script>

<div class="panel">
  <div class="tab-bar">
    {#each tabs as tab (tab)}
      <button class="tab" class:active={activeTab === tab} onclick={() => activeTab = tab}>{tab}</button>
    {/each}
  </div>

  <div class="panel-content">
    {#if activeTab === 'patterns'}
      <PatternsPanel
        {store} {tokenStore} {patternSchemas} {patterns} {vocabs} {participants} {doc} {slotFillMode}
        {selectedPatternId} {editorMode} {suggestMode} {myAuthorId}
        onSelectPattern={onSelectPattern ?? (() => {})}
        {onRequestSlotFill} {onCancelSlotFill}
        {...(onFillWithPattern ? { onFillWithPattern } : {})}
        onHoverSlot={(id) => { onHoverSlot?.(id) }}
        onHoverPattern={(id) => { onHoverPattern?.(id) }}
      />
    {:else if activeTab === 'textlets'}
      <TextletsPanel {store} {annotations} {patterns} {vocabs} {doc} {tokenStore} {suggestMode} {myAuthorId} onDelete={onDeleteTextlet} onHoverMark={onHoverTextletMark} />
    {:else if activeTab === 'table'}
      <TablePanel {store} {tokenStore} {doc} {...(onSeek ? { onSeek } : {})} />
    {:else if activeTab === 'suggestions'}
      <SuggestionsPanel {store} {doc} {patternSchemas} {patterns} {tokenStore}
        onSelectPattern={(id) => { activeTab = 'patterns'; onSelectPattern?.(id) }}
      />
    {:else if activeTab === 'bookmarks'}
      <BookmarksPanel
        {bookmarks} {playhead} {tlSelection}
        onCreateBookmark={onCreateBookmark ?? (() => {})}
        onUpdateBookmark={onUpdateBookmark ?? (() => {})}
        onDeleteBookmark={onDeleteBookmark ?? (() => {})}
        {...(onSeek ? { onSeek } : {})}
        {...(onAddToCollection ? { onAddToCollection, activeCollectionName } : {})}
      />
    {/if}
  </div>
</div>

<style>
  .panel {
    width: 100%;
    flex-shrink: 0;
    border-left: none;
    background: #f0f0f0;
    display: flex;
    flex-direction: column;
    font-size: 0.83rem;
    overflow: hidden;
  }

  .panel-content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .tab-bar {
    display: flex;
    border-bottom: 1px solid #d8d8d8;
    background: #e8e8e8;
    flex-shrink: 0;
  }

  .tab {
    flex: 1;
    padding: 0.58rem 0.2rem;
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    background: transparent;
    font-size: 0.7rem;
    font-weight: 500;
    text-transform: capitalize;
    color: #999;
    cursor: pointer;
    letter-spacing: 0.03em;
  }
  .tab:hover { color: #555; background: #f5f5f5; }
  .tab.active { color: var(--color-primary); border-bottom-color: var(--color-primary); background: #fff; }


</style>
