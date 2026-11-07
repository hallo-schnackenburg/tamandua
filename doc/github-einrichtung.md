# GitHub einrichten

Pro Environment (lokal, dev, production) eine GitHub App und ein Daten-Repo.
Alles in der GitHub-Organisation bzw. dem Konto, dem das Daten-Repo gehört.

## 1. Daten-Repo

1. Repo anlegen (`archive-dev`, später `archive`), öffentlich.
2. Den Inhalt von `templates/archive/` aus diesem Repo
   (`.github/workflows/validate.yml`) hineinkopieren. Die Vorlage holt das Tool-Repo
   `hallo-schnackenburg/tamandua`; es muss öffentlich sein.
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

## 5. Ablauf der Erfassung

- Das erste gesicherte Objekt legt den Branch `erfassung/<login>` und einen Entwurf (Draft-Pull-Request) an. Jede
  weitere Sicherung ist ein Commit auf diesem Branch; der Entwurf zeigt immer den aktuellen Stand und `validate`
  läuft bei jedem Commit.
- Die App sichert eine Sekunde nach jeder eigenen Änderung (Objekt angelegt, Agent hat Felder gesetzt, Dateien
  zugeordnet) und 30 Sekunden nach der letzten Eingabe im Editor.
- "Einreichen" stellt den Entwurf auf "Ready for review". Entwürfe filterst du in der PR-Liste mit `-is:draft` aus.
- Nach dem Merge löscht GitHub den Branch; die nächste Sicherung beginnt mit einem neuen Entwurf.
