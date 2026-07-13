import { app, BrowserWindow, ipcMain, dialog, protocol, Menu } from 'electron'
import { execFile as _execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { MenuItemConstructorOptions } from 'electron'
import { NATIVE_MENU_TEMPLATE } from '../../../mumo/src/nativeMenu.js'
import type { NativeMenuItem } from '../../../mumo/src/nativeMenu.js'
import { promises as fsPromises, constants as fsConstants, createWriteStream, createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { join, extname, basename, resolve } from 'node:path'

// Crash logging
// Write to a log file before app is fully ready (userData not available yet),
// then re-open at the proper path once app is ready.
let logPath = join(process.env['HOME'] ?? '.', 'mumo-crash.log')
let logStream = createWriteStream(logPath, { flags: 'a' })

function log(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args.map(a => (a instanceof Error ? a.stack ?? a.message : String(a))).join(' ')}\n`
  process.stderr.write(line)
  logStream.write(line)
}

process.on('uncaughtException', (err) => { log('uncaughtException', err); app.exit(1) })
process.on('unhandledRejection', (reason) => { log('unhandledRejection', reason instanceof Error ? reason : String(reason)) })
import { initDb, getDb, addFolder, removeFolder, getFolders, getFolderDocuments, search, searchUtterances, searchUtterancesComposite, searchUtteranceSequences, searchPatterns, searchAnnotations, searchAnnotationsComposite, searchTierOverlaps, createCollection, listCollections, deleteCollection, addCollectionItem, listCollectionItems, removeCollectionItem, getAllParticipantLabels, getAllSpeakers, getAllSchemaNames, getAllTierNames, getAllCodeValues, getMetricFacets, getSlotNames, upsertSavedQuery, listSavedQueries, deleteSavedQuery } from './collection-db.js'
import type { CollectionQuery, CompositeUttQuery, CompositeAnnQuery, SequenceQuery, TierOverlapQuery } from './collection-db.js'
import { resolvePermalinkDoc, resolvePermalinkTime } from './collection-db.js'
import { parsePermalink } from '@mumo/core'
import { syncFolders } from './collection-sync.js'

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true } },
])

function getIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(__dirname, '../../resources/icon.png')
}


function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: getIconPath(),
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? {} : { titleBarOverlay: { color: '#ffffff', symbolColor: '#333333', height: 38 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  if (!isMac) win.setMenuBarVisibility(false)

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    win.webContents.openDevTools()
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

function buildMenuItems(items: NativeMenuItem[]): MenuItemConstructorOptions[] {
  return items.map(item => {
    if (item.type === 'separator') return { type: 'separator' }
    const opts: MenuItemConstructorOptions = {}
    if (item.label)       opts.label       = item.label
    if (item.accelerator) opts.accelerator = item.accelerator
    if (item.enabled === false) opts.enabled = false
    if (item.role)  opts.role = item.role as Exclude<MenuItemConstructorOptions['role'], undefined>
    if (item.action === 'file:new') {
      opts.click = () => createWindow()
    } else if (item.action) {
      const action = item.action
      opts.click = () => BrowserWindow.getFocusedWindow()?.webContents.send('menu-action', action)
    }
    if (item.submenu) opts.submenu = buildMenuItems(item.submenu)
    return opts
  })
}

function setupApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = []

  if (process.platform === 'darwin') {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  }

  template.push(...buildMenuItems(NATIVE_MENU_TEMPLATE))

  if (process.platform === 'darwin') {
    template.push({
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
    })
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(() => {
  // Move log to proper userData path now that app is ready
  const properLogPath = join(app.getPath('userData'), 'mumo.log')
  if (properLogPath !== logPath) {
    logStream.end()
    logPath = properLogPath
    logStream = createWriteStream(logPath, { flags: 'a' })
  }

  protocol.handle('media', handleMediaRequest)
  setupApplicationMenu()

  try {
    initDb()
  } catch (err) {
    log('initDb failed', err)
    dialog.showErrorBox('mumo startup error', `Database init failed:\n${err instanceof Error ? err.message : String(err)}\n\nLog: ${logPath}`)
    app.exit(1)
    return
  }

  createWindow()

  // permalink passed on first launch (Linux/Windows put it in argv)
  const link = process.argv.find(a => a.startsWith('mumo://'))
  if (link) handlePermalink(link)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((err: unknown) => {
  log('app.whenReady failed', err)
  app.exit(1)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

async function handleMediaRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const filePath = decodeURIComponent(url.pathname)

  let fileSize: number
  try {
    const stat = await fsPromises.stat(filePath)
    fileSize = stat.size
  } catch {
    return new Response('Not found', { status: 404 })
  }

  const mime = mimeFor(filePath)
  const rangeHeader = request.headers.get('range')

  // Stream the file rather than buffering it: media players send open-ended range
  // requests (bytes=N-) and read lazily, so buffering materializes entire multi-GB
  // files in main-process memory — several concurrent readers per file OOM-kills the app.
  const streamBody = (start: number, end: number): BodyInit | null => {
    if (end < start) return null
    return Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream
  }

  if (rangeHeader) {
    const range = parseRange(rangeHeader, fileSize)
    if (!range) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${fileSize}` },
      })
    }
    const [start, end] = range
    return new Response(streamBody(start, end), {
      status: 206,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
      },
    })
  }

  return new Response(streamBody(0, fileSize - 1), {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Length': String(fileSize),
      'Accept-Ranges': 'bytes',
    },
  })
}

ipcMain.handle('new-window', () => { createWindow() })

ipcMain.handle('open-text-file', async (_, extensions: string[], label?: string) => {
  const { filePaths } = await dialog.showOpenDialog({
    filters: [
      { name: label ?? 'Files', extensions },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  })
  if (!filePaths[0]) return null
  const text = await fsPromises.readFile(filePaths[0], 'utf-8')
  return { text, path: filePaths[0], name: basename(filePaths[0]) }
})

ipcMain.handle('open-binary-file', async (_, extensions: string[], label?: string) => {
  const { filePaths } = await dialog.showOpenDialog({
    filters: [
      { name: label ?? 'Files', extensions },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  })
  if (!filePaths[0]) return null
  return { path: filePaths[0], name: basename(filePaths[0]) }
})

ipcMain.handle('read-file-bytes', async (_, filePath: string) => {
  return fsPromises.readFile(filePath)
})

ipcMain.handle('file-exists', async (_, filePath: string) => {
  try {
    await fsPromises.access(filePath, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
})

ipcMain.handle('show-save-dialog', async (_, defaultName: string) => {
  const { filePath } = await dialog.showSaveDialog({
    defaultPath: defaultName,
    filters: [{ name: 'mumo files', extensions: ['mumo'] }],
  })
  return (filePath as string | undefined) ?? null
})

ipcMain.handle('save-file', async (_, filePath: string, data: Uint8Array) => {
  await fsPromises.writeFile(filePath, Buffer.from(data))
})

function mimeFor(filePath: string): string {
  const ext = extname(filePath).toLowerCase().slice(1)
  const map: Record<string, string> = {
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm',
    mov: 'video/quicktime', mkv: 'video/x-matroska', ogv: 'video/ogg',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
    aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac',
  }
  return map[ext] ?? 'application/octet-stream'
}

function parseRange(header: string, fileSize: number): [number, number] | null {
  const m = header.match(/^bytes=(\d*)-(\d*)$/)
  if (!m) return null
  const start = m[1] ? parseInt(m[1]) : 0
  const end = m[2] ? Math.min(parseInt(m[2]), fileSize - 1) : fileSize - 1
  if (start > end || start >= fileSize) return null
  return [start, end]
}

// --- System font listing ---

interface FontEntry { label: string; value: string }
interface SystemFonts { defaults: FontEntry[]; system: string[] }

const execFile = promisify(_execFile)

const FALLBACK_DEFAULTS: FontEntry[] = [
  { label: 'CMU Serif',       value: '"CMU Serif", "Computer Modern", Georgia, serif' },
  { label: 'Times New Roman', value: '"Times New Roman", Times, serif' },
  { label: 'Arial',           value: 'Arial, Helvetica, sans-serif' },
  { label: 'Courier New',     value: '"Courier New", Courier, monospace' },
]

async function readDefaultFonts(): Promise<FontEntry[]> {
  const configPath = resolve(app.getPath('userData'), 'font-defaults.json')
  try {
    const text = await fsPromises.readFile(configPath, 'utf-8')
    const parsed: unknown = JSON.parse(text)
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as FontEntry[]
  } catch {
    // write the default file so the user can find and edit it
    await fsPromises.writeFile(configPath, JSON.stringify(FALLBACK_DEFAULTS, null, 2), 'utf-8').catch(() => {})
  }
  return FALLBACK_DEFAULTS
}

async function listFontFamiliesUnix(): Promise<string[]> {
  const { stdout } = await execFile('fc-list', ['--format=%{family[0]}\n'])
  const families = new Set<string>()
  for (const line of stdout.split('\n')) {
    const name = line.trim()
    if (name) families.add(name)
  }
  return [...families].sort((a, b) => a.localeCompare(b))
}

async function listFontFamiliesWindows(): Promise<string[]> {
  const fontsDir = resolve(process.env['WINDIR'] ?? 'C:\\Windows', 'Fonts')
  const entries = await fsPromises.readdir(fontsDir)
  const families = new Set<string>()
  for (const entry of entries) {
    const ext = extname(entry).toLowerCase()
    if (ext === '.ttf' || ext === '.otf') {
      families.add(basename(entry, ext).replace(/[-_]/g, ' '))
    }
  }
  return [...families].sort((a, b) => a.localeCompare(b))
}

async function listSystemFonts(): Promise<SystemFonts> {
  const [defaults, system] = await Promise.all([
    readDefaultFonts(),
    process.platform === 'win32' ? listFontFamiliesWindows() : listFontFamiliesUnix(),
  ])
  return { defaults, system }
}

ipcMain.handle('list-system-fonts', () => listSystemFonts())

// --- User preferences (persistent across sessions) ---

ipcMain.handle('read-prefs', async () => {
  try {
    const text = await fsPromises.readFile(join(app.getPath('userData'), 'prefs.json'), 'utf-8')
    return JSON.parse(text) as unknown
  } catch { return {} }
})

ipcMain.handle('write-prefs', async (_, prefs: unknown) => {
  await fsPromises.writeFile(join(app.getPath('userData'), 'prefs.json'), JSON.stringify(prefs, null, 2), 'utf-8')
})

// --- Collection ---

ipcMain.handle('collection:get-folders', () => getFolders(getDb()))

ipcMain.handle('collection:add-folder', async () => {
  const { filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (!filePaths[0]) return null
  addFolder(getDb(), filePaths[0])
  return filePaths[0]
})

ipcMain.handle('collection:remove-folder', (_, path: string) => {
  removeFolder(getDb(), path)
})

ipcMain.handle('collection:sync', async (_, folders?: string[]) => {
  return syncFolders(getDb(), folders)
})

ipcMain.handle('collection:search', (_, q: CollectionQuery) => {
  return search(getDb(), q)
})

ipcMain.handle('collection:search-utterances', (_, q: CollectionQuery) => {
  return searchUtterances(getDb(), q)
})

ipcMain.handle('collection:search-patterns', (_, q: CollectionQuery) => {
  return searchPatterns(getDb(), q)
})

ipcMain.handle('collection:search-sequences', (_, q: SequenceQuery) => {
  return searchUtteranceSequences(getDb(), q)
})

ipcMain.handle('collection:search-utterances-composite', (_, q: CompositeUttQuery) => {
  return searchUtterancesComposite(getDb(), q)
})

ipcMain.handle('collection:search-annotations', (_, q: CollectionQuery) => {
  return searchAnnotations(getDb(), q)
})

ipcMain.handle('collection:search-tier-overlaps', (_, q: TierOverlapQuery) => {
  return searchTierOverlaps(getDb(), q)
})

ipcMain.handle('collection:get-tier-names', () => getAllTierNames(getDb()))

ipcMain.handle('collection:get-metric-facets', (_, schemaName: string) => getMetricFacets(getDb(), schemaName))
ipcMain.handle('collection:get-slot-names', (_, schemaName?: string) => getSlotNames(getDb(), schemaName))

ipcMain.handle('collection:saved-queries-list', () => listSavedQueries(getDb()))
ipcMain.handle('collection:saved-queries-save', (_, name: string, queryJson: string) => { upsertSavedQuery(getDb(), name, queryJson) })
ipcMain.handle('collection:saved-queries-delete', (_, id: number) => { deleteSavedQuery(getDb(), id) })

ipcMain.handle('collection:get-folder-documents', () => getFolderDocuments(getDb()))
ipcMain.handle('collection:get-participants', () => getAllParticipantLabels(getDb()))
ipcMain.handle('collection:get-speakers', () => getAllSpeakers(getDb()))
ipcMain.handle('collection:get-schema-names', () => getAllSchemaNames(getDb()))
ipcMain.handle('collection:get-codes', () => getAllCodeValues(getDb()))

ipcMain.handle('collection:open-bookmark', (_, filePath: string, bmId: string) => {
  // Focus existing window with this file, or open a new one
  const allWindows = BrowserWindow.getAllWindows()
  for (const win of allWindows) {
    if ((win as BrowserWindow & { _mumoFilePath?: string })._mumoFilePath === filePath) {
      win.focus()
      win.webContents.send('menu-action', `seek-to-bookmark:${bmId}`)
      return
    }
  }
  const win = createWindow()
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('menu-action', `open-file-at-bookmark:${filePath}:${bmId}`)
  })
})

function openDocAtTime(filePath: string, timeS: number): void {
  const t = Number.isFinite(timeS) ? timeS : 0
  const allWindows = BrowserWindow.getAllWindows()
  for (const win of allWindows) {
    if ((win as BrowserWindow & { _mumoFilePath?: string })._mumoFilePath === filePath) {
      win.focus()
      win.webContents.send('menu-action', `seek-to-time:${t}`)
      return
    }
  }
  const win = createWindow()
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('menu-action', `open-file-at-time:${filePath}:${t}`)
  })
}

ipcMain.handle('collection:open-at-time', (_, filePath: string, timeS: number) => {
  openDocAtTime(filePath, timeS)
})

ipcMain.handle('collection:search-annotations-composite', (_, q: CompositeAnnQuery) => {
  return searchAnnotationsComposite(getDb(), q)
})

// Curated collections
ipcMain.handle('collection:sets-list', () => listCollections(getDb()))
ipcMain.handle('collection:sets-create', (_, name: string) => createCollection(getDb(), name))
ipcMain.handle('collection:sets-delete', (_, id: number) => { deleteCollection(getDb(), id) })
ipcMain.handle('collection:sets-add-item', (_, collectionId: number, item: { kind: string; docPath: string; refId?: string | null; startS?: number | null; endS?: number | null; label?: string | null; note?: string | null }) => {
  addCollectionItem(getDb(), collectionId, item)
})
ipcMain.handle('collection:sets-items', (_, collectionId: number) => listCollectionItems(getDb(), collectionId))
ipcMain.handle('collection:sets-remove-item', (_, itemId: number) => { removeCollectionItem(getDb(), itemId) })

ipcMain.handle('collection:open-permalink', (_, link: string) => handlePermalink(link))

// Permalinks
// Scheme-agnostic main part (see @mumo/core permalink.ts):
//   doc/<docKey>[/utt|ann|pat|bm/<id>][?t=<seconds>]   → open/focus doc at time
//   collection[/<id>]                                   → open the collection view
// Accepted as mumo://…, https://host/prefix/…, or bare.

function handlePermalink(url: string): boolean {
  const target = parsePermalink(url)
  if (!target) return false
  if (target.kind === 'collection') {
    const win = BrowserWindow.getAllWindows()[0] ?? createWindow()
    win.focus()
    win.webContents.send('menu-action', target.id != null ? `open-collection:${target.id}` : 'view:collection')
    return true
  }
  const db = getDb()
  const docPath = resolvePermalinkDoc(db, target.docKey)
  if (!docPath) return false
  const refT = target.ref ? resolvePermalinkTime(db, docPath, target.ref) : null
  openDocAtTime(docPath, refT ?? target.t ?? 0)
  return true
}

if (process.defaultApp) {
  // dev: registration needs the explicit electron binary + entry args
  if (process.argv[1]) app.setAsDefaultProtocolClient('mumo', process.execPath, [resolve(process.argv[1])])
} else {
  app.setAsDefaultProtocolClient('mumo')
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const link = argv.find(a => a.startsWith('mumo://'))
    if (link) handlePermalink(link)
    else BrowserWindow.getAllWindows()[0]?.focus()
  })
  app.on('open-url', (e, url) => { e.preventDefault(); handlePermalink(url) })
}
