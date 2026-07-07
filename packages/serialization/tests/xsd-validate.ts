import { execSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const eafSchema = join(fixturesDir, 'EAFv3.0.xsd')

/** Validate against the EAFv3.0 XSD (schema conformance — what ELAN's validator runs),
 *  then parse with pympi if available (ref-chain resolution — what downstream tools do). */
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
  validatePympi(xml)
}

// pympi parse validation
//
// pympi is lenient about schema details (element order, required attributes), so it is
// NOT a substitute for the XSD check — but it resolves every ref annotation's time
// through its parent chain, catching dangling/cyclic references that are ID-valid.

let _pympiAvailable: boolean | null = null
function pympiAvailable(): boolean {
  if (_pympiAvailable === null) {
    try {
      execSync('python3 -c "import pympi"', { stdio: 'ignore' })
      _pympiAvailable = true
    } catch {
      _pympiAvailable = false
      console.warn('pympi not available (pip install pympi-ling) — skipping pympi EAF validation')
    }
  }
  return _pympiAvailable
}

const PYMPI_SCRIPT = `
import io, contextlib, sys
import pympi
buf = io.StringIO()
with contextlib.redirect_stderr(buf):
    eaf = pympi.Elan.Eaf(file_path=sys.argv[1])
    for tier in eaf.get_tier_names():
        eaf.get_annotation_data_for_tier(tier)
w = buf.getvalue().strip()
if w:
    print(w)
    sys.exit(1)
`

export function validatePympi(xml: string): void {
  if (!pympiAvailable()) return
  const dir = mkdtempSync(join(tmpdir(), 'mumo-eaf-'))
  try {
    const file = join(dir, 'validate.eaf')
    writeFileSync(file, xml)
    execFileSync('python3', ['-c', PYMPI_SCRIPT, file], { stdio: ['ignore', 'pipe', 'pipe'] })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    throw new Error(`pympi EAF parse failed:\n${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? e.message}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
