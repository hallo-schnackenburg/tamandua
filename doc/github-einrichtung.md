# GitHub einrichten

Pro Environment (local, staging, production) eine GitHub App und ein Daten-Repo.
Alles in der GitHub-Organisation bzw. dem Konto, dem das Daten-Repo gehört.

## 1. Daten-Repo

1. Repo anlegen (`archive-dev` für local, `archive-staging`, `archive` für production), öffentlich
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
klappt der Login bei einem öffentlichen Repo noch (er liest nur), aber das Sichern scheitert mit
403 "Resource not accessible by integration". Bei einem privaten Repo endet schon der Login
mit "Not Found" (`?login=failed`).

## 3. Worker

`worker/wrangler.toml`: `GITHUB_CLIENT_ID`, `DATA_REPO` (`owner/repo`), `BASE_BRANCH` (`main`), `APP_URL`.

Geheimnisse, lokal in `worker/.secrets/dev`, deployed mit `npx wrangler secret put`:

- `GITHUB_CLIENT_SECRET`: das Client Secret der App
- `SESSION_SECRET`: ein langer Zufallswert, z. B. `openssl rand -base64 32`
- `WEBHOOK_SECRET`: ein langer Zufallswert (siehe Abschnitt "Webhook"); derselbe Wert steht im Webhook des Daten-Repos

### Webhook: Änderungen sofort in allen Browsern

Damit alle, die die App offen haben, Änderungen am Archiv (also einen gemergten Pull Request) nach ein bis zwei
Sekunden sehen, ruft GitHub bei jedem Push den Worker auf. Der Worker gibt das über einen Durable Object ("Hub", ein
einzelner Verteiler im Worker-Projekt, kein eigener Server) an alle offenen Browser weiter, und die holen sich, was neu
ist. Ohne Webhook funktioniert alles weiter, die App fragt dann nur einmal pro Minute nach.

Im Daten-Repo unter Settings → Webhooks → Add webhook:

- Payload URL: `https://<Adresse der App>/api/hook/github` (Staging und Production), lokal die Adresse des Tunnels
  (siehe unten) plus `/hook/github`
- Content type: `application/json`
- Secret: der Wert von `WEBHOOK_SECRET`
- Events: "Just the push event"

GitHub schickt gleich einen Ping; unter "Recent Deliveries" muss dort ein grünes Häkchen stehen. Der Worker beachtet nur
Pushes auf `main` des eigenen Daten-Repos und prüft bei jedem Aufruf die Signatur.

Der Hub wird beim ersten Deploy angelegt (`[[migrations]]` in `wrangler.toml`; auf dem Free-Plan nur mit SQLite-Speicher,
den wir nutzen). Er schläft, solange nichts gesendet wird, und kostet dann nichts.

**Lokal** erreicht GitHub `localhost` nicht. Mit einem Tunnel geht es trotzdem:

```
cloudflared tunnel --url http://localhost:8787
```

Die ausgegebene Adresse (`https://….trycloudflare.com`) kommt mit `/hook/github` als Payload URL in den Webhook von
`archive-dev`; sie ändert sich bei jedem Start des Tunnels. Der Worker (`npm run dev:worker`) braucht `WEBHOOK_SECRET`
in `worker/.secrets/dev`. Im Tab "Datenbank" zeigt der kleine Punkt neben der Überschrift, ob die Live-Verbindung
steht (grün) oder nur nachgefragt wird (grau).

## 4. Freiwillige freischalten

Wer mitmachen soll, wird im Daten-Repo als Collaborator mit Write-Rechten
eingeladen. Wer sich anmeldet und kein Schreibrecht hat, sieht den Hinweis,
dass er noch eingeladen werden muss. Wer Admin oder Maintainer ist, kann prüfen
und Pull Requests annehmen.

## 5. Ablauf der Erfassung

Die Arbeit ist in **Erfassungen** gegliedert, benannten Arbeitseinheiten wie "Dachbodenfund Postkarten". Eine Erfassung
ist ein Branch und ein Pull Request.

- Das erste gesicherte Objekt einer Erfassung legt den Branch `erfassung/<login>/<kurzname>` und einen Entwurf
  (Draft-Pull-Request) an. Der Titel ist `<Erfassungsname> (<Person>, TT.MM.JJJJ, HH:MM)`; der Erfassungsname steht
  zusätzlich als Marker im Text des Pull Requests, damit die App die Erfassung wiederfindet. Jede weitere Sicherung
  ist ein Commit auf diesem Branch; `validate` läuft bei jedem Commit.
- Nach der Anmeldung legt die App selbst eine leere Erfassung an ("Erfassung vom TT.MM.JJJJ"), wenn keine offene da
  ist. Sie existiert nur im Browser; GitHub sieht sie erst mit dem ersten gesicherten Objekt. Wird sie nicht
  umbenannt und bleibt leer, löscht die App sie beim Abmelden und beim nächsten Anmelden wieder. Nach dem Einreichen
  wird, falls keine offene mehr da ist, gleich eine neue angelegt.
- Auf einem neuen Gerät (oder nach `/clear!`) lädt die App nach der Anmeldung die eigenen offenen und eingereichten
  Erfassungen aus GitHub: die Liste und die Objekte kommen über den Worker bzw. direkt von `raw.githubusercontent.com`
  (am Commit, daher nie veraltet), die Vorschaubilder aus dem Bucket. Was im Browser schon da ist, bleibt unangetastet.
  Erst danach legt die App bei Bedarf eine leere Erfassung an. Erfassungen anderer Personen und übernommene werden
  (noch) nicht geladen.
- Es können mehrere Erfassungen gleichzeitig offen sein. Ein Objekt gehört zu genau einer Erfassung, eine Datei zu der
  Erfassung, deren Objekt sie verwendet.
- Die App sichert eine Sekunde nach jeder eigenen Änderung (Objekt angelegt, Agent hat Felder gesetzt, Dateien
  zugeordnet) und 30 Sekunden nach der letzten Eingabe im Editor. Lokal gelöschte Objekte werden beim nächsten
  Sichern auch aus dem Branch entfernt.
- "Einreichen" stellt den Entwurf auf "Ready for review". Entwürfe filterst du in der PR-Liste mit `-is:draft` aus.
- Eine eingereichte Erfassung ist eingefroren: Die App schreibt nie wieder auf ihren Branch (der Worker lehnt es ab),
  damit Prüfende keine Benachrichtigungen über neue Commits bekommen. Weitere Objekte kommen in eine andere Erfassung.
- Wird der Pull Request ohne Merge geschlossen, ist die Erfassung in der App wieder offen. Die nächste Sicherung legt
  einen neuen Entwurf auf demselben Branch an.
- Nach dem Merge löscht GitHub den Branch. Die Erfassung gilt als übernommen und lässt sich in der App aus der
  Ansicht entfernen; im Archiv bleibt sie.
