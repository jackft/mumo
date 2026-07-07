declare module 'y-leveldb' {
  import * as Y from 'yjs'

  export class LeveldbPersistence {
    constructor(location: string)
    getYDoc(name: string): Promise<Y.Doc>
    storeUpdate(name: string, update: Uint8Array): Promise<void>
    writeState(name: string, ydoc: Y.Doc): Promise<void>
    destroy(): Promise<void>
  }
}
