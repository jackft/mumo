import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const eafSchema = join(fixturesDir, 'EAFv3.0.xsd')

export function validateEAF(xml: string): void {
  try {
    execSync(`xmllint --nonet --schema "${eafSchema}" --noout -`, {
      input: xml,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    throw new Error(`EAF XSD validation failed:\n${e.stderr?.toString() ?? e.message}`)
  }
}
