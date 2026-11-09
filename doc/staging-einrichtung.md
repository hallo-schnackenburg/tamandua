# Staging einrichten

Staging ist eine eigene, vollständig getrennte Umgebung: eigener Bucket, eigenes Daten-Repo, eigene
GitHub App, eigener Worker, eigenes Pages-Projekt. Production wird später genauso aufgebaut.

| | Staging |
|---|---|
| Adresse | `https://tamandua-staging.schnackenburg.de` |
| Hetzner-Bucket | `schnackenburg-archiv-staging` |
| Daten-Repo | `hallo-schnackenburg/archive-staging` |
| GitHub App | `Schnackenburg Archiv Tamandua (staging)` |
| Worker | `tamandua-worker-staging` (kein öffentlicher Zugang, nur über das Service Binding) |
| Pages-Projekt | `tamandua-staging` |

So hängt es zusammen: Der Browser spricht nur mit `tamandua-staging.schnackenburg.de`. Das Pages-Projekt liefert die
App aus. Alles unter `/api/*` nimmt eine Pages Function (`app/functions/api/[[path]].ts`) an und gibt es über das
Service Binding an den Worker weiter. Dadurch ist das Session-Cookie ein gewöhnliches Cookie derselben Adresse.

## 1. Hetzner-Bucket

In der Hetzner-Konsole (nur das geht nicht per Skript): das Projekt für Staging, darin ein Schlüsselpaar (S3
credentials). Die Schlüssel gehören zum Projekt, nicht zum Bucket. Gelten sie für mehrere Buckets, kann ein
Staging-Schlüssel auch Production erreichen; deshalb ein Hetzner-Projekt pro Umgebung.

Die Schlüssel kommen in `worker/.secrets/staging` (nicht in git):

    S3_ACCESS_KEY_ID=...
    S3_SECRET_ACCESS_KEY=...

Bucket und Adresse stehen schon in `worker/wrangler.toml` (`[env.staging.vars]`). Dann, aus `worker/`:

    node --experimental-strip-types scripts/provision-bucket.mjs staging
    node --experimental-strip-types scripts/probe-s3.mjs staging

`provision-bucket.mjs` legt den Bucket an, falls er fehlt, und setzt CORS für die Adresse der Umgebung. Es lässt sich
wiederholen. `probe-s3.mjs` prüft Upload, öffentliches Lesen, CORS und Checksummen. Beide funktionieren genauso für
`local` (Schlüssel aus `.secrets/dev`) und `production` (`.secrets/production`).

## 2. Daten-Repo und GitHub App

Siehe `github-einrichtung.md`, mit den Namen aus der Tabelle. Danach die Client ID der App in
`worker/wrangler.toml` bei `GITHUB_CLIENT_ID` (`[env.staging.vars]`) eintragen.

## 3. Worker ausrollen

    npx wrangler login
    cd worker
    npx wrangler secret put ANTHROPIC_API_KEY --env staging
    npx wrangler secret put S3_ACCESS_KEY_ID --env staging
    npx wrangler secret put S3_SECRET_ACCESS_KEY --env staging
    npx wrangler secret put GITHUB_CLIENT_SECRET --env staging
    npx wrangler secret put SESSION_SECRET --env staging     # z. B. openssl rand -base64 32
    npm run deploy:staging

## 4. Pages-Projekt ausrollen

    cd app
    npx wrangler pages project create tamandua-staging --production-branch main
    npm run deploy:staging

`deploy:staging` baut die App mit `.env.staging` (`VITE_WORKER_URL=/api`) und lädt `dist/` samt `functions/` hoch.

## 5. Adresse

Reihenfolge einhalten:

1. Cloudflare: Workers & Pages > `tamandua-staging` > Custom domains > `tamandua-staging.schnackenburg.de` hinzufügen.
2. DNSimple: CNAME `tamandua-staging` auf `tamandua-staging.pages.dev`.

Ein CNAME vor Schritt 1 führt zu einem 522-Fehler.

## 6. Prüfen

Anmelden, Datei ablegen, Objekt anlegen, sichern; auf `archive-staging` erscheinen Branch und Pull Request, im Bucket die
Datei unter `originale/…`.
