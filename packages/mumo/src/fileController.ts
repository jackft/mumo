import type { PlatformIO } from './platform.js'
import { isDesktop } from '@mumo/media-player'
import type { FormatImporter, FormatExporter, ImportResult, ExportContext } from './formats.js'

export type FileControllerCallbacks = {
  // Successful text-format import — apply parsed data to app state
  onImported(result: ImportResult, filename: string, formatId: string): void
  // EAF/ETF detected — needs the tier-mapping dialog before it can be applied
  onEafText(text: string, filePath: string | null): void
  // .mumo binary detected — app handles unpack + image registry + media loading
  onMumoBytes(bytes: Uint8Array, filename: string, path?: string | null): Promise<void>
}

export class FileController {
  currentFilename: string | null = null
  currentFilePath: string | null = null
  currentFormat: string | null = null

  private importers: FormatImporter[] = []
  private exporters: FormatExporter[] = []

  constructor(
    private platform: PlatformIO,
    private cb: FileControllerCallbacks,
  ) {}

  registerImporter(imp: FormatImporter): this {
    this.importers.push(imp)
    return this
  }

  registerExporter(exp: FormatExporter): this {
    this.exporters.push(exp)
    return this
  }

  get allImporters(): FormatImporter[] { return this.importers }
  get allExporters(): FormatExporter[] { return this.exporters }

  importerForExt(ext: string): FormatImporter | undefined {
    return this.importers.find(i => i.extensions.includes(ext))
  }

  exporterById(id: string): FormatExporter | undefined {
    return this.exporters.find(e => e.id === id)
  }

  openableExtensions(): string[] {
    return [...new Set([
      'mumo',
      'eaf', 'etf',
      ...this.importers.flatMap(i => i.extensions),
    ])]
  }

  templateExtensions(): string[] {
    return [...new Set([
      'etf',
      ...this.importers.filter(i => i.isTemplate).flatMap(i => i.extensions),
    ])]
  }

  async openFile(extensions?: string[], label?: string): Promise<void> {
    const exts = extensions ?? this.openableExtensions()
    const result = await this.platform.openBinaryFile(exts, label)
    if (!result) return

    const filename = result.file.name
    const ext = filename.split('.').pop()?.toLowerCase() ?? ''

    if (ext === 'mumo') {
      const bytes = result.path && isDesktop(this.platform)
        ? await this.platform.readFileAsBytes(result.path)
        : new Uint8Array(await result.file.arrayBuffer())
      await this.cb.onMumoBytes(bytes, filename, result.path ?? null)
      this.currentFilename = filename
      this.currentFilePath = result.path ?? null
      this.currentFormat = 'mumo'
      return
    }

    const text = result.path && isDesktop(this.platform)
      ? new TextDecoder().decode(await this.platform.readFileAsBytes(result.path))
      : await result.file.text()

    if (ext === 'eaf' || ext === 'etf') {
      this.cb.onEafText(text, result.path)
      this.currentFormat = 'eaf'
      return
    }

    const importer = this.importerForExt(ext)
    if (!importer) {
      alert('Unsupported file format.')
      return
    }

    try {
      const parsed = importer.import(text)
      this.currentFormat = importer.id
      this.cb.onImported(parsed, filename, importer.id)
    } catch (err) {
      console.error(`Failed to load .${ext}:`, err)
      alert(`Could not load file — invalid ${importer.label} format.`)
    }
  }

  async openTemplate(): Promise<void> {
    await this.openFile(this.templateExtensions(), 'mumo templates')
  }

  downloadExport(id: string, ctx: ExportContext): void {
    const exp = this.exporterById(id)
    if (!exp) { console.error(`No exporter registered for id: ${id}`); return }
    const content = exp.export(ctx)
    const mime = exp.mimeType ?? 'application/xml'
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([content], { type: mime })),
      download: `transcript.${exp.extension}`,
    })
    a.click()
    URL.revokeObjectURL(a.href)
  }

  promptSaveAs(defaultName?: string): string | null {
    const raw = window.prompt('Save as:', defaultName ?? this.currentFilename ?? 'transcript.mumo')
    if (!raw) return null
    const name = raw.endsWith('.mumo') ? raw : `${raw}.mumo`
    this.currentFilename = name
    return name
  }

  setFilename(name: string): void {
    this.currentFilename = name
  }
}
