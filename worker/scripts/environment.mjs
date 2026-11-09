// Where one environment's bucket settings come from, so the scripts in this folder agree on it:
//   local                 S3_* from .secrets/dev; the app's address from the top-level [vars] of wrangler.toml
//   staging, production   S3_ENDPOINT, S3_BUCKET and APP_URL from [env.<name>.vars] of wrangler.toml;
//                         the keys (S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY) from .secrets/<name>
// The .secrets/ files are not in git. The deployed Worker gets the same keys as Cloudflare secrets.

import { readFileSync } from 'node:fs'
import { parse } from 'smol-toml'

export const ENVIRONMENTS = ['local', 'staging', 'production']

const root = new URL('../', import.meta.url)

function readVarsFile(name) {
  let text
  try {
    text = readFileSync(new URL(name, root), 'utf8')
  } catch {
    throw new Error(`worker/${name} is missing (it holds this environment's S3 keys and is not in git)`)
  }
  return Object.fromEntries(
    text
      .split('\n')
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]),
  )
}

export function loadEnvironment(name) {
  if (!ENVIRONMENTS.includes(name)) {
    throw new Error(`Give the environment as an argument: ${ENVIRONMENTS.join(', ')}`)
  }
  const toml = parse(readFileSync(new URL('wrangler.toml', root), 'utf8'))

  let vars
  if (name === 'local') {
    vars = { ...toml.vars, ...readVarsFile('.secrets/dev') }
  } else {
    const env = toml.env?.[name]
    if (!env?.vars) throw new Error(`wrangler.toml has no [env.${name}.vars]`)
    // The bucket and the address come from wrangler.toml only; the keys file cannot redirect them.
    vars = { ...readVarsFile(`.secrets/${name}`), ...env.vars }
  }

  const config = {
    endpoint: vars.S3_ENDPOINT,
    bucket: vars.S3_BUCKET,
    accessKeyId: vars.S3_ACCESS_KEY_ID,
    secretAccessKey: vars.S3_SECRET_ACCESS_KEY,
  }
  const missing = [
    ['S3_ENDPOINT', config.endpoint],
    ['S3_BUCKET', config.bucket],
    ['S3_ACCESS_KEY_ID', config.accessKeyId],
    ['S3_SECRET_ACCESS_KEY', config.secretAccessKey],
    ['APP_URL', vars.APP_URL],
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key)
  if (missing.length) throw new Error(`${missing.join(', ')} missing for ${name}`)

  return { name, config, origin: new URL(vars.APP_URL).origin }
}
