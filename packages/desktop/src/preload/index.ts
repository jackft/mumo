import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  openTextFile: (extensions: string[], label?: string) =>
    ipcRenderer.invoke('open-text-file', extensions, label),
  openBinaryFile: (extensions: string[], label?: string) =>
    ipcRenderer.invoke('open-binary-file', extensions, label),
  readFileAsBytes: (path: string) =>
    ipcRenderer.invoke('read-file-bytes', path),
  fileExists: (path: string) =>
    ipcRenderer.invoke('file-exists', path),
  showSaveDialog: (defaultName: string) =>
    ipcRenderer.invoke('show-save-dialog', defaultName),
  saveFile: (filePath: string, data: Uint8Array) =>
    ipcRenderer.invoke('save-file', filePath, data),
  listSystemFonts: () =>
    ipcRenderer.invoke('list-system-fonts'),
  readPrefs: () =>
    ipcRenderer.invoke('read-prefs'),
  writePrefs: (prefs: unknown) =>
    ipcRenderer.invoke('write-prefs', prefs),
  newWindow: () =>
    ipcRenderer.invoke('new-window'),
  onMenuAction: (callback: (action: string) => void) => {
    ipcRenderer.on('menu-action', (_, action: string) => { callback(action); })
  },
  // Collection
  collectionGetFolders: () =>
    ipcRenderer.invoke('collection:get-folders'),
  collectionAddFolder: () =>
    ipcRenderer.invoke('collection:add-folder'),
  collectionRemoveFolder: (path: string) =>
    ipcRenderer.invoke('collection:remove-folder', path),
  collectionSync: (folders?: string[]) =>
    ipcRenderer.invoke('collection:sync', folders),
  collectionSearch: (q: unknown) =>
    ipcRenderer.invoke('collection:search', q),
  collectionSearchUtterances: (q: unknown) =>
    ipcRenderer.invoke('collection:search-utterances', q),
  collectionSearchPatterns: (q: unknown) =>
    ipcRenderer.invoke('collection:search-patterns', q),
  collectionSearchSequences: (q: unknown) =>
    ipcRenderer.invoke('collection:search-sequences', q),
  collectionSearchUtterancesComposite: (q: unknown) =>
    ipcRenderer.invoke('collection:search-utterances-composite', q),
  collectionSearchAnnotations: (q: unknown) =>
    ipcRenderer.invoke('collection:search-annotations', q),
  collectionSearchTierOverlaps: (q: unknown) =>
    ipcRenderer.invoke('collection:search-tier-overlaps', q),
  collectionGetTierNames: () =>
    ipcRenderer.invoke('collection:get-tier-names'),
  collectionSearchAnnotationsComposite: (q: unknown) =>
    ipcRenderer.invoke('collection:search-annotations-composite', q),
  collectionSetsList: () =>
    ipcRenderer.invoke('collection:sets-list'),
  collectionSetsCreate: (name: string) =>
    ipcRenderer.invoke('collection:sets-create', name),
  collectionSetsDelete: (id: number) =>
    ipcRenderer.invoke('collection:sets-delete', id),
  collectionSetsAddItem: (collectionId: number, item: unknown) =>
    ipcRenderer.invoke('collection:sets-add-item', collectionId, item),
  collectionSetsItems: (collectionId: number) =>
    ipcRenderer.invoke('collection:sets-items', collectionId),
  collectionSetsRemoveItem: (itemId: number) =>
    ipcRenderer.invoke('collection:sets-remove-item', itemId),
  collectionOpenPermalink: (link: string) =>
    ipcRenderer.invoke('collection:open-permalink', link),
  collectionGetMetricFacets: (schemaName: string) =>
    ipcRenderer.invoke('collection:get-metric-facets', schemaName),
  collectionGetSlotNames: (schemaName?: string) =>
    ipcRenderer.invoke('collection:get-slot-names', schemaName),
  collectionSavedQueriesList: () =>
    ipcRenderer.invoke('collection:saved-queries-list'),
  collectionSavedQueriesSave: (name: string, queryJson: string) =>
    ipcRenderer.invoke('collection:saved-queries-save', name, queryJson),
  collectionSavedQueriesDelete: (id: number) =>
    ipcRenderer.invoke('collection:saved-queries-delete', id),
  collectionGetFolderDocuments: () =>
    ipcRenderer.invoke('collection:get-folder-documents'),
  collectionGetParticipants: () =>
    ipcRenderer.invoke('collection:get-participants'),
  collectionGetSpeakers: () =>
    ipcRenderer.invoke('collection:get-speakers'),
  collectionGetSchemaNames: () =>
    ipcRenderer.invoke('collection:get-schema-names'),
  collectionGetCodes: () =>
    ipcRenderer.invoke('collection:get-codes'),
  collectionOpenBookmark: (filePath: string, bmId: string) =>
    ipcRenderer.invoke('collection:open-bookmark', filePath, bmId),
  collectionOpenAtTime: (filePath: string, timeS: number) =>
    ipcRenderer.invoke('collection:open-at-time', filePath, timeS),
})
