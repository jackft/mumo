export type { PlatformIO } from '@mumo/media-player'
export { guessMime } from '@mumo/media-player'

function _pickFile(accept: string): Promise<File | null> {
  return new Promise(resolve => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept })
    input.onchange = () => { resolve(input.files?.[0] ?? null); }
    input.oncancel = () => { resolve(null); }
    input.click()
  })
}

export class WebPlatformIO {
  async openTextFile(extensions: string[], _label?: string): Promise<{ text: string; path: string | null; name: string } | null> {
    const file = await _pickFile(extensions.map(e => `.${e}`).join(','))
    if (!file) return null
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => { resolve({ text: reader.result as string, path: null, name: file.name }); }
      reader.onerror = reject
      reader.readAsText(file)
    })
  }

  async openBinaryFile(extensions: string[], _label?: string): Promise<{ file: File; path: string | null } | null> {
    const file = await _pickFile(extensions.map(e => `.${e}`).join(','))
    if (!file) return null
    return { file, path: null }
  }

  mediaUrlForFile(file: File, _path: string | null): string {
    return URL.createObjectURL(file)
  }
}
