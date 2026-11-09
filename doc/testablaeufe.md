# Testabläufe gegen GitHub

Manuelle Durchläufe mit der Dev-Umgebung (`archive-dev`, Dev-Bucket, echte Anmeldung).
Die automatischen Tests laufen gegen einen Nachbau von GitHub; hier wird geprüft, ob das
echte GitHub sich genauso verhält. Pro Ablauf: Schritte, danach was auf GitHub zu sehen
sein muss.

Vorbereitung: eine frische Sitzung, drei bis vier Testdateien, GitHub in einem zweiten
Tab auf `archive-dev` (Branches, Pull Requests, Commits).

## A. Sichern

**A1. Kein leerer Commit.** Objekt anlegen, warten bis es gesichert ist. Dann das Objekt
auf- und zuklappen, in den Editor klicken und wieder heraus, Seite neu laden.
Erwartet: Auf dem Branch kommt kein neuer Commit dazu.

**A2. Änderung rückgängig.** Titel ändern, sichern lassen, Titel auf den alten Wert
zurücksetzen, sichern lassen. Erwartet: zwei Commits, der zweite macht die Änderung
rückgängig. Dann denselben Text noch einmal sichern lassen (zum Beispiel durch Wechsel
zu einer anderen Sitzung und zurück): kein weiterer Commit.

**A3. Commit-Nachricht.** Zwei Objekte anlegen, eines davon ändern, eines löschen.
Erwartet: Die Nachricht nennt den Namen der Sitzung und die Titel der neuen, geänderten
und gelöschten Objekte.

**A4. Löschen.** Ein bereits gesichertes Objekt löschen. Erwartet: Die YAML-Datei ist
auf dem Branch weg. Die Dateien (Scans) bleiben im Bucket.

**A5. Viele Dateien.** 60 bis 100 kleine Dateien auf einmal ablegen und beschreiben.
Erwartet: Alles kommt an (die App sichert in Stücken zu 50), keine Datei fehlt, keine
doppelte Meldung im Chat.

## B. Sitzungen

**B1. Umbenennen mit gesicherten Objekten.** Sitzung mit gesicherten Objekten per
Doppelklick umbenennen. Erwartet: Derselbe PR (gleiche Nummer) mit neuem Titel; der
Branch behält seinen Namen (er ist die feste Kennung der Sitzung, ein PR kann seinen Branch nicht wechseln).

**B2. Umbenennen ohne Objekte.** Leere Sitzung umbenennen. Erwartet: Nichts passiert auf
GitHub, es gibt noch keinen Branch.

**B3. Namen mit Sonderzeichen.** Sitzungen heißen lassen: „Dachbodenfund: Postkarten /
Briefe“, „Über Äcker & Wiesen“, ein Name mit 100 Zeichen. Erwartet: Der Branch-Name ist
gültig und lesbar, der PR-Titel trägt den vollen Namen.

**B4. Zwei Sitzungen parallel.** Zwei offene Sitzungen mit je zwei Objekten. Dateien der
anderen Sitzung sind ausgeblendet. Eine einreichen. Erwartet: Die andere bleibt offen
und änderbar, ihr Branch und PR bleiben unberührt.

## C. Einreichen und danach

**C1. Normaler Weg.** Sitzung einreichen. Erwartet: Der Draft-PR wird „Ready for review“,
die Sitzung zeigt „Eingereicht“, der Editor ist schreibgeschützt.

**C2. Einreichen blockiert.** Ein Objekt mit leerem Titel (gelb) und eines mit
unbekanntem Feld (rot) in einer Sitzung. Einreichen klicken. Erwartet: Chat nennt die
Objekte, es passiert nichts auf GitHub.

**C3. Sperre von außen.** Dieselbe Sitzung in zwei Browsern oder Tabs öffnen (Tab B vor
dem Einreichen laden). In Tab A einreichen. In Tab B ein Objekt ändern und warten.
Erwartet: Tab B bekommt die Meldung „war schon eingereicht“, die Sitzung wird dort als
eingereicht gezeigt, auf dem Branch erscheint kein Commit.

**C4. PR abgelehnt.** Den PR auf GitHub schließen, ohne zu mergen. In der App neu laden
oder zur App zurückkehren. Erwartet: Die Sitzung ist wieder offen. Ändern und erneut
einreichen funktioniert.

**C5. PR übernommen.** PR mergen. Erwartet: „Übernommen“; der Papierkorb entfernt die
Sitzung aus der Ansicht (mit Rückfrage), im Archiv bleibt sie. Nach Neuladen bleibt sie
entfernt.

**C6. Nach dem Merge weiterarbeiten.** Eine neue Sitzung beginnen, eine Datei der
übernommenen Sitzung erneut ablegen. Erwartet: Meldung, dass die Datei schon vorhanden
ist, kein doppeltes Objekt.

## D. Anmeldung und Netz

**D1. Abmelden und anmelden.** Mit offener Arbeit abmelden, wieder anmelden. Erwartet:
Die Arbeit ist noch da, GitHub zeigt keine Freigabeseite mehr, gesichert wird ohne
Doppelungen.

**D2. Token abgelaufen.** Das Ablaufen nachstellen (Cookie des Workers löschen oder den
Browser-Speicher der Anmeldung leeren), dann etwas ändern. Erwartet: Hinweis zur
Anmeldung, lokale Arbeit bleibt, nach dem Anmelden wird nachgesichert.

**D3. Offline.** Im Browser das Netz abschalten, Objekte ändern und anlegen, Netz
wieder einschalten. Erwartet: „nicht gesichert“ am Objekt und „!“ an der Sitzung,
nach spätestens einer Minute gesichert, Markierung verschwindet.

**D4. Seite während des Sicherns schließen.** Etwas tippen, sofort den Tab schließen,
wieder öffnen. Erwartet: Der Text ist da (lokal gespeichert), wird nachgesichert.

## E. Mehrere Personen

**E1. Zwei Konten.** Mit einem zweiten GitHub-Konto (Mitglied der Organisation)
anmelden und dieselbe Datei ablegen. Erwartet: Eigener Branch und eigener PR, kein
Eingriff in die Sitzung der ersten Person. Beobachten, ob die App doppelte Arbeit
bemerkt (heute: nein, das wäre Thema für „Ansprüche“).

**E2. Konto ohne Rechte.** Mit einem Konto anmelden, das nicht zur Organisation gehört.
Erwartet: Verständliche Meldung, kein Absturz.

## F. Prüfung im Daten-Repo

**F1. validate-Workflow.** Draft-PR mit einem gelben und einem roten Objekt. Erwartet:
Der Check meldet für rot einen Fehler und für gelb (je nach Regel) Fehler oder Warnung.
Klären, ob unvollständige Objekte im Draft erlaubt sein sollen.

**F2. Fremde Felder.** Das Feld `original_name` im Objekt. Erwartet: Check grün, sobald
das Tool-Repo auf `main` den aktuellen Stand hat.

## Auffälligkeiten festhalten

Pro Ablauf: bestanden, nicht bestanden, oder „anders als erwartet“ mit kurzer
Beschreibung. Bei Abweichungen am besten Screenshot der GitHub-Seite und der
Browser-Konsole.

## Ergebnisse 2026-11-09

- A1 Kein leerer Commit: bestanden
- A1 Kein leerer Commit: bestanden (PR #15: 3 Commits, alle mit Änderung)
- A2 Änderung rückgängig, erster Teil: bestanden (Titel ändern und zurücksetzen ergibt zwei Commits)
- A3 Commit-Nachricht, teilweise gesehen: Format "Sitzung: + Titel" (neu) und "Sitzung: ~ Titel" (geändert) stimmt; Löschen noch nicht geprüft
- A3 Commit-Nachricht, Löschen: bestanden, Format "Sitzung: - Titel" (gesehen: + Rückseite, dann - Rückseite)
- Beobachtung: zwei Commits "~ Prospekt Universal-Ofen, Vorderseite" mit roter Prüfung (0/1), Ursache geklärt: "Operation was cancelled", die Läufe wurden von neueren Commits abgebrochen (kein Fehler)
- A4 Löschen: bestanden (die YAML-Datei ist auf dem Branch entfernt; Bucket-Dateien noch nicht geprüft)
- A5 Viele Dateien: bestanden (60 Dateien, ein Objekt mit 50 Dateien; kurzer Hänger beim Anlegen, siehe Notiz Spinner)
- B1 Umbenennen mit gesicherten Objekten: bestanden nach korrigierter Erwartung (PR-Titel wird umbenannt, Branch bleibt bewusst unverändert; die Testbeschreibung war falsch)
- B2 Umbenennen ohne Objekte: bestanden (wie erwartet)
- B3 Namen mit Sonderzeichen: bestanden (wie erwartet)
- B4 Zwei Sitzungen parallel: bestanden (bereits mehrfach getestet)
- C-Vorbefund Chat/Datum: "heute" wurde nicht erkannt (Modell kannte das Datum nicht, schrieb den Platzhalter <UNKNOWN> ins Datum); die Korrektur lehnte das Modell dann als Nutzeränderung ab. Behoben im Worker (Datum im Kontext, Platzhalter werden verworfen), noch nicht gegen das echte Modell getestet
- C1 Einreichen, normaler Weg: bestanden
- C2 Vorbefund: Objekt mit leerem unbekannten Feld ("titlez:") wurde gelb statt rot angezeigt; behoben in validity.ts (unbekanntes Feld ist immer fehlerhaft)
- C2 Einreichen blockiert: bestanden (Chat nennt die offenen Objekte, PR bleibt Draft; Meldung auf "Wir können erst einreichen, wenn alle Objekte vollständig sind. Noch offen: …" umformuliert)
- C3 Sperre von außen: bestanden (Meldung umformuliert: "war leider schon eingereicht (vielleicht in einem anderen Browser oder Tab). Deine Änderungen konnten nicht mehr gesichert werden.")
- C4 PR abgelehnt: bestanden
- Änderung: Einreichen-Button ist deaktiviert, solange nicht alle Objekte grün sind (Tooltip erklärt es); C2 damit nur noch als Sicherheitsnetz im Code
- C5 PR übernommen: bestanden
- Änderung: Badges in der Sitzungsliste heißen "Eingereicht"/"Übernommen" und sehen aus wie die Labels im Kopf (schmaler)
- C6 Datei nach dem Merge erneut ablegen: NICHT bestanden/nicht gebaut: nach Merge (testbild-01.png in archive-dev main) und erneutem Ablegen in einer neuen Sitzung kommt keine Meldung; die App kennt nur lokale/Branch-Dateien, einen Abgleich mit dem Archiv gibt es noch nicht (Thema Duplikate/Claims)
- Änderung: keine Preview-Variante, wenn das Bild nicht größer als 400 px ist (sonst Kopie des Originals)
- A2 Änderung rückgängig, zweiter Teil: bestanden
- A4 Bucket-Prüfung: zurückgestellt (später)
- Änderung: Fortschritt "N von M" in der Dateien-Überschrift bei mehreren abgelegten Dateien, Spinner im Chat statt "…"; kleiner Papierkorb am Objekt (Rückfrage Ja/Nein, Dateien bleiben in der Liste)
- Chat "heute" gegen das echte Modell: bestanden (Datum im Kontext funktioniert)
