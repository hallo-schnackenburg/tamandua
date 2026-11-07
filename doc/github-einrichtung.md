# GitHub einrichten

Pro Environment (lokal, dev, production) eine GitHub App und ein Daten-Repo.
Alles in der GitHub-Organisation bzw. dem Konto, dem das Daten-Repo gehört.

## 1. Daten-Repo

1. Repo anlegen (`archive-dev`, später `archive`), öffentlich.
2. Den Inhalt von `templates/archive/` aus diesem Repo hineinkopieren
   (`.github/workflows/validate.yml`) und in der Datei `OWNER/tamandua` durch
   den echten Namen des Tool-Repos ersetzen.
3. Settings > General: "Automatically delete head branches" einschalten.
4. Settings > Branches: Regel für `main`: "Require a pull request before merging" und
   "Require status checks to pass" mit dem Check `validate`.

## 2. GitHub App

Settings > Developer settings > GitHub Apps > New GitHub App.

- Name: `Tamandua (dev)` bzw. `Tamandua`
- Homepage URL: die Adresse der App
- Callback URL: `http://localhost:5173/api/auth/callback` (lokal) bzw.
  `https://tamandua-dev.schnackenburg.de/api/auth/callback`
- "Expire user authorization tokens": an
- "Request user authorization (OAuth) during installation": aus
- Webhook: "Active" aus
- Repository permissions: Contents: Read and write, Pull requests: Read and
  write, Metadata: Read-only
- Account permissions: keine
- "Where can this app be installed": Only on this account

Danach auf der App-Seite "Generate a new client secret" und die Client ID
notieren. Dann "Install App" und nur das Daten-Repo auswählen.

## 3. Worker

`worker/wrangler.toml`: `GITHUB_CLIENT_ID`, `DATA_REPO` (`owner/repo`), `BASE_BRANCH` (`main`), `APP_URL`.

Geheimnisse, lokal in `worker/.dev.vars`, deployed mit `npx wrangler secret put`:

- `GITHUB_CLIENT_SECRET`: das Client Secret der App
- `SESSION_SECRET`: ein langer Zufallswert, z. B. `openssl rand -base64 32`

## 4. Freiwillige freischalten

Wer mitmachen soll, wird im Daten-Repo als Collaborator mit Write-Rechten
eingeladen. Wer sich anmeldet und kein Schreibrecht hat, sieht den Hinweis,
dass er noch eingeladen werden muss. Wer Admin oder Maintainer ist, kann prüfen
und Pull Requests annehmen.
