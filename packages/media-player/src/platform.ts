export interface FontEntry {
  label: string
  value: string  // CSS font-family string
}

export interface SystemFonts {
  defaults: FontEntry[]
  system: string[]  // family names, applied as CSS font-family: "Name"
}

export interface PlatformIO {
  openTextFile(extensions: string[], label?: string): Promise<{ text: string; path: string | null; name: string } | null>
  openBinaryFile(extensions: string[], label?: string): Promise<{ file: File; path: string | null } | null>
  mediaUrlForFile(file: File, path: string | null): string
}

export interface DesktopPlatformIO extends PlatformIO {
  readFileAsBytes(path: string): Promise<Uint8Array>
  fileExists(path: string): Promise<boolean>
  listSystemFonts?(): Promise<SystemFonts>
}

export function isDesktop(platform: PlatformIO): platform is DesktopPlatformIO {
  return 'fileExists' in platform
}

export function guessMime(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4',
    webm: 'video/webm', mkv: 'video/x-matroska', ogv: 'video/ogg',
    wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4',
    aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac',
  }
  return map[ext] ?? 'application/octet-stream'
}
