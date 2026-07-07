/**
 * Bidirectional map between mumo UUIDs and EAF sequential annotation IDs.
 * EAF uses "a1", "a2", ... — generated fresh on each export.
 * On import, we generate fresh mumo IDs and stash the original EAF ID
 * in features.eafAnnotationId for potential round-trip fidelity.
 */

export class IdMap {
  private mumoToEaf = new Map<string, string>()
  private eafToMumo = new Map<string, string>()
  private counter = 0

  /** Get or create an EAF annotation ID for a mumo ID.
   * If `preferredEafId` is supplied and not already taken, it is used instead of a generated one. */
  eafId(mumoId: string, preferredEafId?: string): string {
    let eaf = this.mumoToEaf.get(mumoId)
    if (!eaf) {
      if (preferredEafId && !this.eafToMumo.has(preferredEafId)) {
        eaf = preferredEafId
      } else {
        // Skip IDs already taken by pre-registered preferred EAF IDs
        do { eaf = `a${++this.counter}` } while (this.eafToMumo.has(eaf))
      }
      this.mumoToEaf.set(mumoId, eaf)
      this.eafToMumo.set(eaf, mumoId)
    }
    return eaf
  }

  /** Look up the mumo ID for a given EAF annotation ID. */
  mumoId(eafId: string): string | undefined {
    return this.eafToMumo.get(eafId)
  }

  /** Register an import mapping (eafId → fresh mumo ID). */
  register(eafId: string, mumoId: string): void {
    this.eafToMumo.set(eafId, mumoId)
    this.mumoToEaf.set(mumoId, eafId)
  }

  /** All (mumoId, eafId) pairs registered so far. */
  entries(): Array<[mumoId: string, eafId: string]> {
    return [...this.mumoToEaf.entries()]
  }
}
