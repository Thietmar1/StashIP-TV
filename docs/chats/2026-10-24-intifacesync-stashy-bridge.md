# Chat: IntifaceSync ohne Stash-Weboberfläche (Stashy-Bridge)


---

## Du

https://gitlab.com/allisless0/stash-plugins/-/tree/main/plugins/IntifaceSync
https://github.com/1letzgo/stashy


ich möchte das intiface sync auch dann akiv ist, wenn ich nicht auf der webpberfläche von stash angemeldet bin. im idealfall kann der code von stashy so angepasst werden, dass er mit intiface sync zusammenarbeitet. falls das nicht geehn sollte: lässt sich etwas programmieren, dass ich intiface sync auch dann verwenden kann, wenn ich eben nicht an der webpberfkäche angemeldet bin


---

## Claude

Der Pfad hier ist zu lang für die Kopie – ich arbeite im ursprünglichen Klon und lege am Ende einen Patch hier ab.

Jetzt schreibe ich die Bridge-Klasse (direkt hinter Stashys `ButtplugManager`, damit keine Änderungen an der Xcode-Projektdatei nötig sind).

Jetzt der Button in der „Interactive“-Karte:

Und die Player-Hooks in `SceneDetailView`:

Zuletzt die Einstellungen (Einstellungen › Intiface):

Ja, das geht. Ich habe Stashy so erweitert, dass es direkt mit IntifaceSync zusammenarbeitet. Eine Stash-Weboberfläche muss dabei nicht offen oder angemeldet sein. **Kompiliert und getestet ist das noch nicht**: Für iOS-Code braucht man einen Mac mit Xcode, und den gibt es hier unter Windows nicht.

Der Patch: [stashy-intifacesync.patch](stashy-intifacesync.patch)

## Warum das funktioniert

IntifaceSync besteht aus zwei Teilen:
- **Python-Backend**: läuft neben Stash als WebSocket-Server auf Port 7880 und verbindet sich selbst mit Intiface Central. Darin steckt die ganze Logik (Flow, Beat, Vibe-Tracks, Watchdog).
- **Browser-Teil**: meldet dem Backend nur, welche Szene läuft, und schickt Play/Pause/Seek sowie alle 2 Sekunden die Abspielzeit.

Das Backend prüft nicht, wer mit ihm spricht. Stashy schickt jetzt genau die Nachrichten, die sonst der Browser-Tab schickt. Für das Backend sieht Stashy damit aus wie ein weiterer Tab.

## Was der Patch in Stashy ändert (nur iOS)

- **Neue Klasse `IntifaceSyncBridge`** in `StashDBViewModel.swift`:
  - meldet sich beim Backend an und übernimmt die Steuerung des Toys;
  - schickt den Dateipfad der Szene, damit das Backend das passende Funscript sucht und lädt;
  - gibt Play, Pause, Seek und alle 2 s die Abspielzeit weiter;
  - versucht bei Verbindungsabbruch alle 3 s neu zu verbinden.
- **Einstellungen › Intiface**: neuer Bereich „IntifaceSync Plugin“ mit Schalter und Backend-Adresse. Leer gelassen wird `ws://<Stash-Server>:7880` verwendet.
- **Karte „Interactive“ in der Szene**: Ist der Schalter an, ersetzt der Button „IntifaceSync“ den bisherigen Intiface-Button. Grün „Ready“ heißt: Skript geladen, Stashy steuert.
- **Player-Hooks** in `SceneDetailView.swift`. Beim Verlassen der Szene stoppt das Toy.
- Stashys eigene Intiface-Verbindung wird dabei getrennt, weil Intiface Central nur einen Client gleichzeitig annimmt.

## Was du brauchst

1. In Stash einmal den Task **Start Backend** von IntifaceSync ausführen. Danach läuft das Backend auch ohne offene Weboberfläche.
2. Port **7880** muss vom iPhone aus erreichbar sein. Läuft Stash in Docker, musst du den Port freigeben.
3. Den Patch einspielen und die App selbst bauen. Die App-Store-Version lässt sich nicht verändern.
   ```bash
   git apply stashy-intifacesync.patch
   ```
   Danach in Xcode bauen und aufs Gerät laden. Ein kostenloser Apple-Account reicht, die App läuft dann aber nur 7 Tage.

## Einschränkungen

- **Nicht kompiliert**: Kleinere Swift-Fehler beim ersten Build sind möglich. Wenn du mir die Fehlermeldungen schickst, korrigiere ich sie.
- **Tuning pro Skript**: Was du im Browser für ein Skript eingestellt hast, sendet Stashy nicht mit. Das Backend nutzt seine Standardwerte (Modus Auto).
- **Nur in der normalen Szenenansicht**, also nicht in Reels/Feeds. Und nur bei Szenen, die Stash als interaktiv erkennt.
- **App im Hintergrund**: Geht Stashy in den Hintergrund oder sperrst du das iPhone, bricht die Verbindung ab. Der Watchdog des Backends stoppt das Toy dann nach spätestens 15 s.
- **Fallback ohne Stashy-Änderung**: Gibt es keinen richtigen. Ohne Anpassung an Stashy erfährt das Backend nicht, an welcher Stelle das Video gerade läuft. Stash selbst bekommt von Stashy nur gelegentlich die Resume-Zeit, das reicht für eine synchrone Steuerung nicht.

Ich habe den Patch hier in einem Ordner gespeichert, den die App für diese Sitzung angelegt hat. Wenn du diese Arbeit behalten möchtest, kann ich diese Sitzung in einen Ordner deiner Wahl verschieben.


---

## Du

geht es auch andersherum, dass man das intiface sync ändert, so dass es in stashy sinnvoll nutzbar is? wäre das auch ohne stashy nutzbar?


---

## Claude

Ja, das geht. Ich würde es sogar vorziehen, weil Stashy dann unverändert aus dem App Store bleiben kann. Allerdings mit Abstrichen gegenüber der Stashy-Änderung von vorhin.

## Die Idee: IntifaceSync gibt sich als Intiface aus

Stashy kann schon heute mit einem Intiface-Server sprechen, und die Adresse ist einstellbar. Das IntifaceSync-Backend bekäme einen zweiten Eingang, zum Beispiel auf Port 12346, der sich wie Intiface Central verhält:

1. In Stashy trägst du als Intiface-Server `ws://<Stash-Host>:12346` ein statt der Adresse von Intiface Central.
2. Das Backend meldet Stashy ein virtuelles Gerät, einen „Stroker“. Stashy schickt ihm dann zu jedem Funscript-Punkt einen Befehl: „fahre auf Position X in Y Millisekunden“.
3. Das Backend nimmt diese Befehle an, rechnet sie mit seiner eigenen Logik in Vibration um und gibt das Ergebnis über die echte Intiface-Verbindung an dein Toy.

Daraus ergeben sich zwei Stufen.

**Stufe 1: Live-Modus.** Er funktioniert sofort, mit jeder Szene. Das Backend wandelt die eingehenden Stroke-Befehle direkt in Vibration um. Die Stärke richtet sich nach Tempo und Hub, wie im „Speed“-Modus. Die Feinheiten von IntifaceSync gelten auch hier:
- Mindeststärke des Motors und Micro-Pulse
- Power-Limit
- Stop, wenn Stashy pausiert (Stashy schickt dann „alles stoppen“)

Was fehlt, ist der Blick nach vorn. Flow wertet das ganze Skript im Voraus aus, das geht hier nicht.

**Stufe 2: Voller Modus, wenn das Backend die Szene erkennt.** Stashy meldet Stash beim Abspielen regelmäßig die Wiedergabe-Aktivität. Das Backend könnte deshalb in Stash nachsehen, welche interaktiven Szenen gerade gespielt werden. Dann vergleicht es die eingehenden Befehle mit deren Funscripts: Position und Abstand der Punkte passen nur bei einem Skript an einer bestimmten Stelle zusammen. So kennt es die Szene und die genaue Abspielzeit. Danach läuft alles wie im Browser: Flow, Beat, Vibe-Track und dein Tuning pro Skript. Ob Stashys Aktivitätsmeldungen dafür schnell und zuverlässig genug sind, muss ich in Stash noch prüfen. Bis die Szene erkannt ist, würde Stufe 1 laufen.

## Was schlechter ist als mit dem Stashy-Patch

- **Timing**: Stashy berechnet die Abspielzeit selbst mit und gleicht sie nur bei Play und Seek mit dem Video ab. Ruckelt das iPhone, läuft Stashy hinterher, und das Backend erbt das. Mit dem Patch bekommt das Backend alle 2 s die echte Videozeit.
- **Erkennung (Stufe 2)**: Die Szenenerkennung ist indirekt. Bei sehr gleichförmigen Skripten kann sie ein paar Sekunden brauchen.
- **Nur Szenen mit Funscript**: Stashy schickt nur Befehle, wenn ein Funscript vorhanden ist. Das manuelle Muster für Szenen ohne Skript gibt es so nicht.

## Ginge das auch ohne Stashy?

Ja, das ist der eigentliche Vorteil.

- **Stufe 1 funktioniert mit jedem Programm**, das Funscripts per Intiface an einen Stroker schickt, zum Beispiel VR-Player wie HereSphere. Damit hättest du einen allgemeinen Übersetzer „Stroker-Skript → gute Vibration“.
- **Stufe 2 klappt nur mit Playern, die ihre Wiedergabe an Stash melden.** Sonst weiß das Backend nicht, welche Szene läuft.

Das wäre eine Erweiterung des Python-Backends von IntifaceSync: ein neuer Server-Teil auf eigenem Port. Am Browser-Teil ändert sich nichts. Testen kann ich hier nur mit einem simulierten Stashy-Client, nicht mit deinem echten Toy.

Soll ich das bauen, zuerst Stufe 1 und danach die Szenenerkennung für Stufe 2?


---

## Du

ja


---

## Claude

Jetzt baue ich es. Zuerst schaue ich, wie die Version zwischen Seite und Backend verglichen wird, damit nach dem Update keine Fehlermeldung „Old backend“ entsteht.

Die Testsuite läuft vollständig grün (75 Tests). Jetzt schreibe ich die Bridge ins Backend.

Zuerst zwei kleine Änderungen am Player (Durchreichen an echte Stroker im Live-Modus):

Jetzt der Kern: Skriptabgleich, Stash-Client und die Bridge selbst.

Ich räume zwei Stellen auf (Auflösung bei Mehrdeutigkeit, Suche per Bisektion statt linearem Durchlauf):

Jetzt die Einbindung in den Backend-Server:

Syntax-Check und die bestehenden Tests:

Die alten Tests laufen weiter grün. Jetzt schreibe ich eigene Tests für die Bridge, einschließlich eines simulierten Stashy, das wie die echte App Befehle pro Keyframe schickt.

Beide Testsuiten sind grün. Jetzt die Doku im README des Plugins:

Fertig: IntifaceSync gibt sich jetzt gegenüber Stashy als Intiface Central aus. Stashy bleibt dabei unverändert, also die App-Store-Version. In meinen Tests mit einem simulierten Stashy funktioniert alles. **Mit dem echten Stashy, deinem Toy und deinem Stash-Server ist es noch nicht getestet.**

## So richtest du es ein

1. Den Ordner [IntifaceSync](IntifaceSync) über deinen Plugin-Ordner in Stash kopieren. Alternativ [intifacesync-bridge.patch](intifacesync-bridge.patch) ins Repo einspielen.
2. In Stash den Task **Stop Backend** und danach **Start Backend** ausführen. Plugins neu laden reicht nicht.
3. In Stashy unter **Einstellungen › Intiface** als Server `ws://<Stash-Rechner>:12346` eintragen. Läuft Stash in Docker, musst du Port 12346 freigeben.
4. Intiface Central bleibt, wo es ist. Das Backend verbindet sich selbst damit, über die Intiface-Adresse aus den Plugin-Einstellungen.
5. In Stashy wie gewohnt eine Szene öffnen und auf den **Intiface**-Button tippen.

## Was dann passiert

- **Sofort (Stufe 1):** Stashy sieht ein Gerät „IntifaceSync“ und schickt ihm seine Stroke-Befehle. Das Backend macht daraus Vibration, mit Mindeststärke, Limits und so weiter. Den Modus wählst du in den Plugin-Einstellungen unter „Bridge live mode“: `speed`, `beat` oder `position`.
- **Nach etwa 3–6 Sekunden (Stufe 2):** Das Backend fragt Stash nach den zuletzt gespielten interaktiven Szenen und findet Stashys Strokes in einem der Funscripts wieder. Ab dann läuft das ganze Skript wie auf der Weboberfläche: Flow, Beat, Vibe-Track und dein gespeichertes Tuning für dieses Skript. Im Stash-Log steht dann zum Beispiel *Stashy plays 'Szene' at 3:12*.
- **Pause, Spulen, Szenenwechsel:** Pause stoppt das Toy. Nach dem Spulen findet das Backend die Stelle in etwa 2 Sekunden wieder und bleibt so lange still. Bei einer anderen Szene läuft erst Stufe 1, bis auch diese erkannt ist.
- **Timing:** Stashy berechnet seine Abspielzeit über Bildschirm-Frames und fällt bei ruckelndem Bild hinter das Video zurück. Die Bridge übernimmt diesen Rückstand nicht. Im Test lag die App nach 14 s 374 ms zurück, die Bridge blieb auf der Videozeit.
- **Weboberfläche gleichzeitig:** Stashy zählt wie ein weiterer Tab. Drückst du in einem Stash-Tab auf Play, übernimmt der Tab das Toy. Stop und Mute wirken von überall. Schließt du Stashy, stoppt das Toy.

## Auch ohne Stashy nutzbar

Ja. Jedes Programm, das einen Stroker über Intiface ansteuert, kann sich mit Port 12346 verbinden.
- **Stufe 1** funktioniert damit immer.
- **Stufe 2** klappt nur, wenn das Programm die Wiedergabe an Stash meldet.

## Getestet

- Die 75 bestehenden Tests des Plugins sind weiterhin grün.
- Neu ist `test_bridge.py` mit 12 Tests, ebenfalls alle grün. Ein simuliertes Stashy verbindet sich dort über einen echten WebSocket und sendet Befehle genau nach Stashys Logik. Geprüft werden:
  - Live-Start und Szenenerkennung (Abweichung 0–2 ms)
  - Pause und Fortsetzen, Spulen, Szenenwechsel
  - Übernahme durch einen Browser-Tab, Verbindungsabbruch
  - Zugriff auf Stash über einen nachgebauten GraphQL-Server
  - der Ausschalter in den Plugin-Einstellungen

## Einschränkungen

- **Erkennung braucht die Wiedergabe-Meldung an Stash:** Stashy meldet eine Szene erst nach der „als gespielt zählen“-Zeit aus seinen Einstellungen. Bis dahin läuft nur Stufe 1. Außerdem muss das Funscript neben dem Video liegen.
- **Stash mit Login:** Ist ein Login eingerichtet, aber kein API-Key erzeugt, endet die Erkennung, wenn die Sitzung des Tasks abläuft. Stufe 1 läuft weiter. Abhilfe: unter Settings › Security einen API-Key erzeugen.
- **Stärke:** Es gilt die Script-Stärke, die zuletzt auf der Weboberfläche eingestellt war. In Stashy lässt sie sich nicht ändern.
- **Sicherheit:** Port 12346 hat, wie der vorhandene Port 7880, keinen Zugriffsschutz. Er sollte nur im Heimnetz erreichbar sein.

Der Stashy-Patch aus meiner ersten Antwort ist damit nicht mehr nötig. Wenn du diese Arbeit behalten möchtest, kann ich diese Sitzung in einen Ordner deiner Wahl verschieben.


---

## Du

wie kann ich diesen chat zu einem github repo hinzufügen


---

## Claude

Es gibt zwei Wege. Beide laufen darauf hinaus, den Chat als Datei zu speichern und diese Datei ins Repo zu committen.

## 1. Chat als Datei exportieren und committen (empfohlen)

1. **Exportieren:** Ich kann den Verlauf dieser Sitzung als Markdown-Datei exportieren, zum Beispiel `chat-intifacesync.md`. Am besten zusammen mit den Ergebnissen: dem Plugin-Ordner `IntifaceSync/` und den beiden Patches.
2. **Ins Repo legen:** Die Dateien in dein lokales Repo kopieren. Hast du noch keins, legst du auf github.com ein neues Repository an und klonst es:
   ```bash
   git clone https://github.com/<dein-name>/<repo>.git
   ```
3. **Committen und pushen**, im Repo-Ordner:
   ```bash
   git add chat-intifacesync.md IntifaceSync intifacesync-bridge.patch
   ```
   ```bash
   git commit -m "IntifaceSync-Bridge für Stashy + Chatverlauf"
   ```
   ```bash
   git push
   ```

Ohne Kommandozeile geht es auch im Browser: Im Repo auf **Add file › Upload files** klicken und die Dateien hineinziehen.

## 2. Diese Sitzung direkt in dein Repo verschieben

Hast du das Repo schon lokal geklont, kann ich die Sitzung in diesen Ordner verschieben. Die erzeugten Dateien kommen dann mit. Den Commit und den Push kann ich danach für dich übernehmen. Pushen mache ich aber nur, wenn du es ausdrücklich bestätigst, weil das nach außen geht.

## Vor dem Hochladen beachten

- **Öffentlich oder privat:** Ein öffentliches Repo kann jeder lesen, auch den Chatverlauf. Wegen des Themas würde ich ein **privates** Repo nehmen.
- **Persönliche Daten:** Im Chat stehen lokale Pfade von deinem Rechner, zum Beispiel `~\...`. Die solltest du vorher entfernen oder mich bitten, sie im Export zu kürzen.
- **Fremder Code:** IntifaceSync gehört allisless0, Stashy gehört 1letzgo. Prüfe die Lizenzen, bevor du deren Code öffentlich weiterverbreitest. Bei einem privaten Repo ist das unkritisch.

Soll ich den Chat jetzt als Markdown exportieren, mit gekürzten Pfaden, und zusammen mit den Ergebnissen in einem Ordner ablegen?


---

## Du

das github plugin kann ich nicht verwenden? das ist schon verbunden


---

## Claude

In dieser Sitzung kann ich es nicht nutzen. Ich habe nachgesehen: Hier stehen nur die Verbindungen „Claude Docs“, „Scalable“ und „scheduled-tasks“ zur Verfügung, ein GitHub-Connector ist nicht dabei. Die GitHub-Kommandozeile `gh` ist auf deinem Rechner auch nicht installiert.

Wahrscheinlich ist GitHub bei dir an anderer Stelle verbunden, etwa im Chat auf claude.ai oder für Cloud-Sitzungen. Diese Verbindung gilt aber nicht für eine lokale Code-Sitzung wie diese.

Damit ich das Hochladen selbst übernehmen kann, gibt es zwei Wege.

**A) GitHub CLI installieren (am einfachsten)**
Diese zwei Befehle führst du selbst aus. Den Login mache ich nicht für dich:
```bash
winget install --id GitHub.cli
```
```bash
gh auth login
```
Danach kann ich hier alles erledigen: ein **privates** Repo anlegen, den Chat-Export (mit gekürzten Pfaden) und die Plugin-Dateien committen und pushen. Vor dem Anlegen und vor dem Push frage ich dich jeweils.

**B) Über den Browser im App-Fenster**
Ich öffne github.com im eingebauten Browser. Du meldest dich dort selbst an, und ich lade die Dateien über **Add file › Upload files** hoch. Das funktioniert, ist aber umständlicher als A.

Welchen Weg möchtest du nehmen? Den Chat-Export kann ich in beiden Fällen schon vorbereiten.


---

## Du

A. dürfte auch schon erledigt. prüfe die github cli


---

## Claude

Die GitHub CLI ist installiert und angemeldet (Konto **Thietmar1**, mit Recht auf Repositories). Ich bereite jetzt den Chat-Export vor.
