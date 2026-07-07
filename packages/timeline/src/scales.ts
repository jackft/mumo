export class LinearScale {
  constructor(
    public domain: [number, number],
    public range: [number, number],
  ) {}

  map(x: number): number {
    const [d0, d1] = this.domain
    const [r0, r1] = this.range
    if (d1 === d0) return r0
    return r0 + ((x - d0) / (d1 - d0)) * (r1 - r0)
  }

  invert(y: number): number {
    const [d0, d1] = this.domain
    const [r0, r1] = this.range
    if (r1 === r0) return d0
    return d0 + ((y - r0) / (r1 - r0)) * (d1 - d0)
  }
}
