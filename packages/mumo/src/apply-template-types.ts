export type ConflictEntry = {
  category: string
  name: string
  reason: string
}

export type PreviewItem = {
  action: 'add' | 'merge' | 'skip'
  name: string
  detail?: string
  additions?: string[]
}

export type PreviewSection = {
  category: string
  items: PreviewItem[]
}
