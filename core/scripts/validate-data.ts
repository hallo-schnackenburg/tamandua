// Checks every object file of the data repository: the YAML is valid against the schema, the id in the
// file matches the file name and place, and nothing but object files is under objects/.
// Run in the data repository's CI (see templates/archive/.github/workflows/validate.yml):
//   npx tsx core/scripts/validate-data.ts <path to the data repository>

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { objectPath, validateObjectYaml } from '../src/index.js'

const root = process.argv[2]
if (!root) {
  console.error('Usage: validate-data <path to the data repository>')
  process.exit(2)
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* walk(path)
    else yield path
  }
}

let problems = 0
let checked = 0
const fail = (file: string, message: string) => {
  problems++
  // The "::error" form shows up as an annotation on the pull request.
  console.log(`::error file=${file}::${message}`)
}

const objects = join(root, 'objects')
let found = true
try {
  statSync(objects)
} catch {
  found = false
}

if (found) {
  for (const path of walk(objects)) {
    const file = relative(root, path).split('\\').join('/')
    if (!file.endsWith('.yaml')) {
      fail(file, 'Only .yaml object files belong into objects/.')
      continue
    }
    checked++
    const text = readFileSync(path, 'utf8')
    const id = /^id:\s*([0-9A-Z]{26})\s*$/m.exec(text)?.[1]
    if (!id) {
      fail(file, 'The file has no valid "id".')
    } else if (objectPath(id) !== file) {
      fail(file, `The id ${id} belongs in ${objectPath(id)}.`)
    }
    for (const issue of validateObjectYaml(text)) fail(file, `${issue.path || '/'}: ${issue.message}`)
  }
}

console.log(`${checked} object file(s) checked, ${problems} problem(s).`)
process.exit(problems === 0 ? 0 : 1)
