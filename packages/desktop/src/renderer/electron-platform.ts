import { guessMime } from '@mumo/media-player'
import type { DesktopPlatformIO, SystemFonts } from '@mumo/media-player'

interface ElectronAPI {
  openTextFile(extensions: string[], label?: string): Promise<{ text: string; path: string; name: string } | null>
  openBinaryFile(extensions: string[], label?: string): Promise<{ path: string; name: string } | null>
  readFileAsBytes(path: string): Promise<Uint8Array>
  fileExists(path: string): Promise<boolean>
  showSaveDialog(defaultName: string): Promise<string | null>
  saveFile(filePath: string, data: Uint8Array): Promise<void>
  listSystemFonts(): Promise<SystemFonts>
  onMenuAction(callback: (action: string) => void): void
}

declare global {
  interface Window { electronAPI: ElectronAPI }
}

export class ElectronPlatformIO implements DesktopPlatformIO {
  async openTextFile(extensions: string[], label?: string): Promise<{ text: string; path: string | null; name: string } | null> {
    return window.electronAPI.openTextFile(extensions, label)
  }

  async openBinaryFile(extensions: string[], label?: string): Promise<{ file: File; path: string | null } | null> {
    const result = await window.electronAPI.openBinaryFile(extensions, label)
    if (!result) return null
    return {
      file: new File([], result.name, { type: guessMime(result.name) }),
      path: result.path,
    }
  }

  async readFileAsBytes(path: string): Promise<Uint8Array> {
    return window.electronAPI.readFileAsBytes(path)
  }

  async fileExists(path: string): Promise<boolean> {
    return window.electronAPI.fileExists(path)
  }

  async listSystemFonts(): Promise<SystemFonts> {
    return window.electronAPI.listSystemFonts()
  }

  mediaUrlForFile(file: File, path: string | null): string {
    if (path) {
      const segments = path.replace(/\\/g, '/').split('/')
      const encoded = segments.map(encodeURIComponent).join('/')
      return `media://localhost${encoded.startsWith('/') ? encoded : '/' + encoded}`
    }
    return URL.createObjectURL(file)
  }
}
