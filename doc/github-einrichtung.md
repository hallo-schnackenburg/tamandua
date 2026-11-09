# GitHub einrichten

Pro Environment (local, staging, production) eine GitHub App und ein Daten-Repo.
Alles in der GitHub-Organisation bzw. dem Konto, dem das Daten-Repo gehört.

## 1. Daten-Repo

1. Repo anlegen (`archive-dev` für local, `archive-staging`, `archive-production`), öffentlich
   und **leer**: ohne README, ohne `.gitignore`, ohne Lizenz.
2. Die Vorlage `templates/archive/` als ersten Commit auf `main` hochladen. Sie enthält
   `.github/workflows/validate.yml`, das das Tool-Repo `hallo-schnackenburg/tamandua` holt;
   es muss öffentlich sein. Aus dem Root dieses Repos (hier für staging):

   ```
   cd templates/archive
   git init -b main
   git add .
   git commit -m "Initial archive"
   git remote add origin git@github.com:hallo-schnackenburg/archive-staging.git
   git push -u origin main
   rm -rf .git
   ```

   Das letzte Kommando entfernt das Hilfs-Repo wieder, damit `templates/archive` hier ein
   normaler Ordner bleibt. Ohne diesen ersten Commit gibt es keinen Branch `main`, und die App
   meldet "Git Repository is empty" (409), sobald sie Änderungen sichern will. Die App kann das
   nicht selbst nachholen: Der Workflow liegt unter `.github/workflows/`, und dort dürfen
   GitHub Apps nur mit der Berechtigung "Workflows" schreiben, die wir bewusst nicht vergeben.
3. Settings > General: "Automatically delete head branches" einschalten.
4. Settings > Branches: Regel für `main`: "Require a pull request before merging" und
   "Require status checks to pass" mit dem Check `validate`.

## 2. GitHub App

Settings > Developer settings > GitHub Apps > New GitHub App.

- Name: `Schnackenburg Archiv Tamandua (dev)`, `… (staging)` bzw. `Schnackenburg Archiv Tamandua`
- Homepage URL: die Adresse der App
- Callback URL: `http://localhost:5173/api/auth/callback` (local),
  `https://tamandua-staging.schnackenburg.de/api/auth/callback` (staging) bzw.
  `https://tamandua.schnackenburg.de/api/auth/callback` (production)
- "Expire user authorization tokens": an
- "Request user authorization (OAuth) during installation": aus
- Webhook: "Active" aus
- Repository permissions: Contents: Read and write, Pull requests: Read and
  write, Metadata: Read-only
- Account permissions: keine
- "Where can this app be installed": Only on this account

Danach auf der App-Seite "Generate a new client secret" und die Client ID
notieren. Dann "Install App", die Organisation wählen und nur das Daten-Repo auswählen. Ohne Installation
sieht die App das Repo nicht, und der Login endet mit "Not Found" (`?login=failed`).

## 3. Worker

`worker/wrangler.toml`: `GITHUB_CLIENT_ID`, `DATA_REPO` (`owner/repo`), `BASE_BRANCH` (`main`), `APP_URL`.

Geheimnisse, lokal in `worker/.secrets/dev`, deployed mit `npx wrangler secret put`:

- `GITHUB_CLIENT_SECRET`: das Client Secret der App
- `SESSION_SECRET`: ein langer Zufallswert, z. B. `openssl rand -base64 32`

## 4. Freiwillige freischalten

Wer mitmachen soll, wird im Daten-Repo als Collaborator mit Write-Rechten
eingeladen. Wer sich anmeldet und kein Schreibrecht hat, sieht den Hinweis,
dass er noch eingeladen werden muss. Wer Admin oder Maintainer ist, kann prüfen
und Pull Requests annehmen.

## 5. Ablauf der Erfassung

Die Arbeit ist in **Sitzungen** gegliedert, benannten Arbeitseinheiten wie "Dachbodenfund Postkarten". Eine Sitzung
ist ein Branch und ein Pull Request.

- Das erste gesicherte Objekt einer Sitzung legt den Branch `erfassung/<login>/<kurzname>` und einen Entwurf
  (Draft-Pull-Request) an. Der Titel ist `<Sitzungsname> (<Person>, TT.MM.JJJJ, HH:MM)`; der Sitzungsname steht
  zusätzlich als Marker im Text des Pull Requests, damit die App die Sitzung wiederfindet. Jede weitere Sicherung
  ist ein Commit auf diesem Branch; `validate` läuft bei jedem Commit.
- Es können mehrere Sitzungen gleichzeitig offen sein. Ein Objekt gehört zu genau einer Sitzung, eine Datei zu der
  Sitzung, deren Objekt sie verwendet.
- Die App sichert eine Sekunde nach jeder eigenen Änderung (Objekt angelegt, Agent hat Felder gesetzt, Dateien
  zugeordnet) und 30 Sekunden nach der letzten Eingabe im Editor. Lokal gelöschte Objekte werden beim nächsten
  Sichern auch aus dem Branch entfernt.
- "Einreichen" stellt den Entwurf auf "Ready for review". Entwürfe filterst du in der PR-Liste mit `-is:draft` aus.
- Eine eingereichte Sitzung ist eingefroren: Die App schreibt nie wieder auf ihren Branch (der Worker lehnt es ab),
  damit Prüfende keine Benachrichtigungen über neue Commits bekommen. Weitere Objekte kommen in eine andere Sitzung.
- Wird der Pull Request ohne Merge geschlossen, ist die Sitzung in der App wieder offen. Die nächste Sicherung legt
  einen neuen Entwurf auf demselben Branch an.
- Nach dem Merge löscht GitHub den Branch. Die Sitzung gilt als übernommen und lässt sich in der App aus der
  Ansicht entfernen; im Archiv bleibt sie.
