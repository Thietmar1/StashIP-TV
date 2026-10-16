# StashIP-TV

Auch in diesem Repository: **[Funscript Ollama](https://github.com/Thietmar1/StashIP-TV/tree/main/plugins/FunscriptOllama)**,
ein eigenständiger Prototyp zur Qwen-gestützten Bewegungsanalyse über Ollama.
Die bestehende Quelle `tvguide-iptv/index.yml` bietet beide unabhängigen Plugins an.
Funscript Ollama kombiniert Qwen/Haven-Bewegungsanalyse, VR/POV, Zusatzachsen und
Funscript-Kapitelmarker; die TV-Funktionen bleiben erhalten.

StashIP-TV macht aus deiner Stash-Bibliothek gemeinsame Live-TV-Kanäle mit
benutzerdefinierten Namen und XMLTV-Programmführer. Die Kanalverwaltung bleibt
in Stash; wiedergegeben wird über Jellyfin, Emby, Plex oder den Stashy-Adapter.
GalleryMode, SpriteTab und TheaterMode sind aus diesem Repository entfernt.

## Funktionen

- Kanäle aus Studios, Darstellern, Tags, Gruppen und gespeicherten Filtern.
- Eigene Kanalnamen (**Edit → Save name**), Logos, ausgeblendete Kanäle und Pins.
- Gemeinsamer deterministischer Sendeplan, tägliche Rotation und optional All Scenes.
- M3U, XMLTV und fortlaufendes MPEG-TS für Jellyfin und Emby.
- Gepuffertes HLS und Kanal-/Szenennamen für Stashy, ohne zusätzlichen EPG-Bildschirm.
- Optionaler virtueller HDHomeRun-Tuner mit EPG für Plex.
- Kanalnummern ab **12**, in den Einstellungen anpassbar.
- Kanalverwaltung mit **Active channels**, **Selected (including hidden)** und
  **All available channels**; die Auswahl wird gespeichert.
- Virtuelle gespeicherte Kanalfilter für native App-Startseiten über den Adapter.

Plex und Stashy bleiben als Prototypen gekennzeichnet. Ihre tatsächliche
Client-Wiedergabe hängt auch von der jeweiligen App-Version ab. Die automatischen
Tests prüfen Protokolle und echte FFmpeg-Streams, ersetzen aber keinen Test jeder
App auf jedem Gerät. Der frühere Browser-Player wird nicht mitgeliefert.

## Bestehendes TVGuide aktualisieren

Der sichtbare Pluginname und das Repository heißen jetzt **StashIP-TV**. Die
interne Stash-ID **TVGuide**, die Manifestdatei `TVGuide.yml`, Einstellungs- und
State-Schlüssel, Kanal-IDs und Tuner-Geräteidentität bleiben absichtlich erhalten.
Dadurch ist dies ein normales Update und keine zweite, leere Plugininstallation.
Du musst weder Kanäle noch Tokens noch Jellyfin-/Stashy-Verbindungen neu anlegen.
Auch der bisherige Zustand unter `tvguide-iptv/server.json` wird weiterverwendet,
damit ein bereits laufender Server erkannt und ordentlich beendet werden kann.

1. In Stash **Stop IPTV Server** ausführen.
2. Die Pluginquelle auf die folgende URL umstellen und die Quellen aktualisieren:

   ```text
   https://raw.githubusercontent.com/Thietmar1/StashIP-TV/tvguide-iptv/index.yml
   ```

3. Das vorhandene Plugin aktualisieren. Es erscheint anschließend als **StashIP-TV**.
4. Stash bei geänderten PATH-Einstellungen neu starten, ansonsten die Oberfläche neu laden.
5. **Start IPTV Server** ausführen.

Die Quellen-Branch `tvguide-iptv` bleibt ebenfalls bestehen. Verwende die neue
Repository-Adresse ausdrücklich; verlasse dich für rohe Download-URLs nicht auf
Weiterleitungen des alten Repositorynamens. Die Bereinigung des Git-Repositories
entfernt bereits auf deinem Stash installierte andere Plugins nicht automatisch.

## Voraussetzungen und Installationsquelle

- Stash mit externen Plugin-Tasks; API-Kompatibilität wird gegen v0.31.1 geprüft.
- Node.js 20 oder neuer; für neue Installationen eine unterstützte LTS-Version
  verwenden, beispielsweise Node.js 22 oder 24. Siehe [Node.js Releases](https://nodejs.org/en/about/previous-releases).
- FFmpeg mit `libx264` und AAC. Der Server normalisiert auf 720p/25 fps.
- Node und FFmpeg müssen **in derselben Ausführungsumgebung und für dasselbe
  Konto wie Stash** erreichbar sein. Eine Installation nur auf dem Docker-Host
  reicht für Stash im Container nicht aus.

In **Stash → Einstellungen → Plugins → Verfügbare Plugins → Quelle hinzufügen**
die obige URL eintragen, aktualisieren und **StashIP-TV** installieren. Das fertige
Paket enthält sämtliche JavaScript-Abhängigkeiten. Auf dem Stash-Rechner ist
**kein npm install, kein Python und kein Compiler** erforderlich.

Der Plugin-Task startet mit `node` aus dem PATH. Stash sucht laut seiner
[Plugin-Dokumentation](https://docs.stashapp.cc/in-app-manual/plugins/externalplugins/)
zuerst im PATH und danach im Pluginverzeichnis. Ein Fehler wie
`.../plugins/TVGuide/node: no such file or directory` bedeutet deshalb meistens,
dass der Stash-Prozess Node in seiner Umgebung nicht findet. Die Datei muss
nicht ins Pluginverzeichnis kopiert werden. `TVGuide` im Fehlerpfad ist die
beibehaltene interne ID.

## Docker / LXC / Proxmox

Bei Docker gelten die folgenden Schritte **im Stash-Container**, auch wenn Docker
selbst in einem Debian-LXC läuft. Für Stash direkt im LXC gilt der Linux-Abschnitt.

Für das Alpine-basierte offizielle Stash-Image kann ein eigenes Image gebaut
werden. Die folgenden Dateien sind ein vollständiges kleines Beispiel. Falls
du bereits Python/OpenCV oder andere Pakete installierst, behalte diese zusätzlich.

`Dockerfile` neben deiner Compose-Datei:

```dockerfile
FROM stashapp/stash:latest
RUN apk add --no-cache nodejs ffmpeg
```

Minimale `compose.yml`:

```yaml
services:
  stash:
    build: .
    image: stashiptv-local
    container_name: stash
    restart: unless-stopped
    ports:
      - "9999:9999"
      - "9898:9898"
    environment:
      STASH_PORT: "9999"
      STASH_STASH: /data/
      STASH_GENERATED: /generated/
      STASH_METADATA: /metadata/
      STASH_CACHE: /cache/
      TZ: Europe/Berlin
    volumes:
      - ./config:/root/.stash
      - ./data:/data
      - ./generated:/generated
      - ./metadata:/metadata
      - ./cache:/cache
```

**Bei einer vorhandenen Installation deren Volumes, Medien-Mounts, Umgebungsvariablen
und Startlogik beibehalten.** Ersetze sie nicht durch die Beispielpfade. Ergänze
Node/FFmpeg und Port 9898. Bei einem vorhandenen `apk add` im Entrypoint einfach
`nodejs` in dessen Paketliste aufnehmen; für dauerhafte reproduzierbare Images
ist der Dockerfile-Weg zweckmäßig.

```bash
docker compose up -d --build
docker exec stash node --version
docker exec stash ffmpeg -version
```

In den Plugin-Einstellungen: **Listen Address** `0.0.0.0`, **Public URL** die vom
Jellyfin-/Emby-/Plex-Server erreichbare Adresse des Docker-Hosts bzw. LXC,
beispielsweise `http://192.168.178.20:9898`. `localhost` bezeichnet aus einem
anderen LXC nicht den Stash-Container.

## Stash nativ unter Linux

Beispiel Debian/Ubuntu, einschließlich Debian 13 ohne Docker:

```bash
sudo apt update
sudo apt install nodejs ffmpeg
node --version
ffmpeg -version
ffmpeg -hide_banner -encoders | grep -E 'libx264| aac '
```

Prüfe die installierte Node-Version. Falls die Distribution eine ältere Version
liefert, installiere eine unterstützte LTS-Version gemäß [Node.js Download](https://nodejs.org/en/download).
Für andere Distributionen deren Paketmanager bzw. die auf den offiziellen
Downloadseiten verlinkten Pakete verwenden.

Bei einem Stash-systemd-Dienst muss dessen Benutzer Node und FFmpeg ebenfalls
finden. `stash.service` und `stash` in den Beispielen durch deinen tatsächlichen
Dienst- und Benutzernamen ersetzen:

```bash
systemctl cat stash.service
sudo -u stash /usr/bin/env node --version
sudo -u stash /usr/bin/env ffmpeg -version
```

Wenn Node nur über einen interaktiven Versionsmanager wie nvm installiert ist,
fehlt er häufig im Dienst-PATH. Installiere ihn systemweit oder ergänze den PATH
im Stash-Dienst über `sudo systemctl edit stash.service`, zum Beispiel:

```ini
[Service]
Environment="PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
```

`/opt/node/bin` durch das tatsächlich vorhandene Node-Verzeichnis ersetzen.
Danach `sudo systemctl daemon-reload` und `sudo systemctl restart stash.service`.
Stash braucht Schreibrechte in seinem Konfigurationsverzeichnis und im temporären
Verzeichnis. Dort liegen Laufzustand, Protokoll und der kurzlebige HLS-Puffer.

Das Plugin über die Installationsquelle installieren, Einstellungen wie unten
setzen und **Start IPTV Server** ausführen. Ein zusätzlicher systemd-Dienst für
das Plugin ist im normalen Betrieb nicht nötig. Für einen bereits separat
betriebenen Server gibt es weiterhin die optionale Linux-Vorlage
[`stashiptv.service`](plugins/StashIP-TV/stashiptv.service); deren Pfade müssen zur
Installation passen. Plugin-Tasks und einen separat gestarteten Server nicht
gleichzeitig auf denselben Port legen.

## Stash nativ unter Windows

1. Eine unterstützte Node.js-LTS-Version über den [offiziellen Windows-Installer](https://nodejs.org/en/download)
   installieren und **Add to PATH** aktivieren.
2. Einen Windows-Build von der [FFmpeg-Downloadseite](https://ffmpeg.org/download.html)
   wählen, entpacken und dessen `bin`-Verzeichnis zum PATH des Stash-Kontos hinzufügen.
   Alternativ in den Plugin-Einstellungen **IPTV FFmpeg Path** auf die vollständige
   `ffmpeg.exe` setzen, beispielsweise `C:\Tools\ffmpeg\bin\ffmpeg.exe`.
   Das Pfadfeld enthält den reinen Pfad ohne zusätzliche Anführungszeichen.
3. Stash vollständig beenden und neu starten. Ein schon laufender Prozess übernimmt
   nachträgliche Änderungen an PATH nicht.
4. In einer neuen PowerShell prüfen:

   ```powershell
   where.exe node
   node --version
   where.exe ffmpeg
   ffmpeg -version
   ffmpeg -hide_banner -encoders | Select-String 'libx264| aac '
   ```

5. Falls Stash als Windows-Dienst läuft, zählt dessen Dienstkonto und dessen PATH,
   nicht der PATH des angemeldeten Benutzers. Node systemweit installieren bzw.
   den PATH dieses Kontos konfigurieren und den Stash-Dienst neu starten.
6. StashIP-TV aus der Quelle installieren. **IPTV Listen Address** auf `0.0.0.0`
   und **IPTV Public URL** auf die LAN-Adresse dieses Windows-Rechners mit Port 9898
   setzen. Den Zugriff der gewünschten Medienserver auf TCP 9898 in der vorhandenen
   Firewall-Konfiguration zulassen.
7. **Start IPTV Server** ausführen. Bei Fehlern das Protokoll im tatsächlichen
   Stash-Konfigurationsverzeichnis unter `tvguide-iptv\server.log` ansehen.

Pfadnamen mit Leerzeichen und Unicode werden als einzelne Prozessargumente
übergeben, ohne Shell-Aufruf. Die Windows-Tests starten und beenden den echten
Node-Server aus solchen Pfaden. Auf Windows verschiebt Node die Unix-Dateimodi
nicht in ein eigenes Berechtigungsmodell: nutze das private Konfigurations- und
Temp-Verzeichnis des Stash-Kontos mit passenden Windows-Zugriffsrechten.

## Gemeinsame Einstellungen und Start

Unter **Einstellungen → Plugins → StashIP-TV → Konfigurieren**:

| Einstellung | Beispiel / Bedeutung |
| --- | --- |
| IPTV Stash URL | Leer für die lokale Stash-Task-Verbindung; bei externen Medien-URLs deren erreichbaren Ursprung angeben |
| IPTV Stash API Key | Stash-API-Schlüssel für länger laufenden Zugriff; sonst wird die Task-Sitzung verwendet |
| IPTV Public URL | `http://192.168.178.20:9898`, durch deine Stash-Adresse ersetzen |
| IPTV Access Token | Eigener zufälliger Token mit mindestens 24 Buchstaben/Ziffern/Bindestrichen/Unterstrichen |
| IPTV Listen Address | `0.0.0.0` für LAN, `127.0.0.1` nur für denselben Rechner |
| IPTV Port | `9898` |
| IPTV Guide Days | `3` |
| IPTV Maximum Streams | `2`, gemeinsames Budget für alle Integrationen |
| IPTV Timezone | `Europe/Berlin` oder deine Zeitzone |
| IPTV First Channel Number | `12` |
| IPTV FFmpeg Path | Leer für Stash-Konfiguration/PATH, sonst vollständiger Pfad |

**StashIP-TV** in der Navigation öffnen, Kanäle auswählen und ggf. umbenennen.
Dann auf der Aufgaben-Seite **Start IPTV Server** starten. Der Task endet,
während der Server im Hintergrund weiterläuft. Die weiteren Tasks heißen
**Stop IPTV Server**, **Restart IPTV Server** und **IPTV Server Status**.
Nach einem Plugin-Update **Stop**, dann **Start** ausführen; ein laufender alter
Node-Prozess lädt die neuen Dateien nicht automatisch nach.

Der Stash-API-Schlüssel und der IPTV-Token haben unterschiedliche Aufgaben.
Benutze für Jellyfin/Emby/Stashy nur den IPTV-Token. Die bisherigen Einstellungen
und `TVGUIDE_*`-Umgebungsvariablen für manuellen Betrieb bleiben kompatibel.

## Jellyfin, Emby, Plex und Stashy

In den Beispielen `YOUR_IPTV_TOKEN` und die IP-Adresse ersetzen:

```text
M3U:   http://192.168.178.20:9898/playlist.m3u?token=YOUR_IPTV_TOKEN
XMLTV: http://192.168.178.20:9898/epg.xml?token=YOUR_IPTV_TOKEN
```

- **Jellyfin:** M3U-Tuner und XMLTV-Anbieter unter Live TV hinzufügen. Unzugeordnete
  Kanäle manuell zuordnen und die Programmdaten aktualisieren.
- **Emby:** M3U als TV-Quelle und XMLTV als Programmführer hinzufügen; Zuordnung
  prüfen. [Detaillierte Anleitung](plugins/StashIP-TV/PLEX-EMBY.md).
- **Plex:** **Enable Plex HDHomeRun Tuner (Prototype)** aktivieren und unter
  **Plex Tuner Allowed IPs** die Plex-Server-IP eintragen. Manuell den Tuner
  `192.168.178.20:9898` und XMLTV `http://192.168.178.20:9898/guide.xml` hinzufügen.
  [Detaillierte Anleitung](plugins/StashIP-TV/PLEX-EMBY.md).
- **Stashy:** **Enable Stashy Adapter (Prototype)** aktivieren. Zusätzlichen
  HTTP-Server `192.168.178.20:9898/stashy` mit dem **IPTV Access Token** als API-Key
  hinzufügen, Szenenliste neu laden. [Einrichtung und Grenzen](plugins/StashIP-TV/NATIVE-APPS.md).

Kanalnamen gelten in allen Integrationen. Exporte werden spätestens nach fünf
Minuten aktualisiert; Stop/Start übernimmt Änderungen sofort. Die Medienanwendung
muss gegebenenfalls ihre Kanal- und EPG-Daten neu einlesen. Kanal-IDs bleiben
stabil; die alphabetische Reihenfolge und damit Kanalnummern können sich nach
einer Umbenennung ändern.

### Aktive Kanäle verwalten

Die Kanalverwaltung startet mit **Active channels**: ausgewählte Kanäle, die
nicht ausgeblendet sind. Das ist die konfigurierte TV-Auswahl, kein Zähler gerade
verbundener Zuschauer. Der Filter arbeitet auf der vollständigen Auswahl, auch
wenn ein Kanal erst auf einer späteren Katalogseite liegt. Die Suche findet dort
sowohl eigene Kanalnamen als auch ursprüngliche Namen.

- **Selected (including hidden)** zeigt zusätzlich ausgeblendete ausgewählte
  Kanäle, damit du sie wieder einblenden kannst.
- **All available channels** öffnet den bisherigen paginierten Katalog zum
  Hinzufügen weiterer Tags, Darsteller, Studios oder anderer Quellen.
- Der Kanaltyp bleibt über die Typauswahl wählbar. Ansicht und Kanaländerungen
  werden getrennt gespeichert; ein Ansichtswechsel ändert keine TV-Auswahl.

### Unterstudios pro Studio-Kanal

Bei ausgewählten Studio-Kanälen steht direkt in der Kanalzeile die Checkbox
**Include sub-studios**:

- **Aktiviert:** Der Kanal enthält auch Szenen aller untergeordneten Studios,
  einschließlich tieferer Ebenen.
- **Deaktiviert:** Der Kanal enthält nur Szenen, die diesem Studio direkt
  zugeordnet sind.

Die Auswahl wird pro Kanal gespeichert und gilt für denselben gemeinsamen
Sendeplan in Jellyfin, Emby, Plex und im App-Adapter. Für bestehende Kanäle ist
sie standardmäßig aktiviert, entsprechend dem bisherigen Verhalten. Der
Kanalname und die Kanal-ID bleiben erhalten.

Ein Oberstudio kann über **All available channels → Add** manuell aufgenommen
werden, auch wenn es keine eigenen Szenen besitzt. Ohne Unterstudio-Szenen kann
ein solcher Kanal leer sein und wird dann nicht als spielbarer Kanal exportiert.
Die Szenen laufen im gewählten Studio-Kanal; weitere Studio-Kanäle lassen sich
unabhängig davon auswählen.

Änderungen übernimmt der Server beim nächsten Snapshot-Refresh (spätestens nach
fünf Minuten). Für die sofortige Übernahme **Stop IPTV Server → Start IPTV Server**
ausführen und die Kanäle bzw. Programmdaten im Client aktualisieren.

### Kanäle auf nativen App-Startseiten

Stashy und Mirage verwenden eigene Oberflächen. JavaScript-Kacheln auf der
Stash-Webstartseite werden nicht in diese Apps übertragen. Die Integration
erfolgt deshalb über die zusätzliche Adapter-Verbindung `/stashy`.

Ab 1.5.0 liefert diese Verbindung den virtuellen gespeicherten Filter
**StashIP-TV Live** und einen Filter pro aktuell spielbarem Kanal. Die Filter
selektieren die stabilen Kanal-IDs; Namen, Nummern und laufende Szenen dürfen
sich ändern. Im echten Stash werden dafür keine Szenen oder Filter angelegt.

In aktuellen Stashy-Versionen kann die native **Channels**-Zeile diese Filter
verwenden. Sie ist im untersuchten iOS-Quellcode eine **Stashy+**-Funktion.
Die üblichen Szenen-Zeilen der Adapter-Verbindung funktionieren weiterhin.
Ein Klick führt über die App zur virtuellen Live-Szene und deren HLS-Wiedergabe.
Details und Einrichtung stehen in [NATIVE-APPS.md](plugins/StashIP-TV/NATIVE-APPS.md).

Für Clients, die Stash-Startseitenfilter lesen, liefert der Adapter zusätzlich
eine native `frontPageContent`-Definition für **StashIP-TV Live**. Mirage beschreibt
solche Filter für **For You**. Eine vollständige Mirage-Verbindung und Wiedergabe
sind hier nicht mit einem echten Gerät geprüft; diese Daten allein garantieren
keine Kompatibilität mit dessen Anmeldung oder Player.

## Betrieb und Fehlerdiagnose

- **Node nicht gefunden:** Im Container bzw. unter dem Stash-Dienstkonto prüfen,
  nicht nur in deiner interaktiven Konsole. Nach PATH-Änderungen Stash neu starten.
- **FFmpeg nicht gefunden:** Stash-/Plugin-Pfad oder PATH korrigieren. Der Build
  muss `libx264` und AAC unterstützen.
- **401:** IPTV-Token fehlt oder ist falsch. **403 an Plex-Tuner-URLs:** Die echte
  TCP-Quell-IP steht nicht in der Tuner-Freigabe; Proxy-Header werden ignoriert.
- **502:** `tvguide-iptv/server.log` im Stash-Konfigurationsverzeichnis prüfen.
  Zugangsdaten, Stash-Erreichbarkeit, Szenenfilter und FFmpeg kontrollieren.
- **503:** Das gemeinsame Streambudget ist belegt. Stashy-Zuschauer desselben
  Kanals teilen sich einen HLS-Produzenten; der wird nach 45 Sekunden ohne
  Wiedergabeanfragen freigegeben.
- **HLS:** Der erste Start braucht einige Sekunden für drei komplette Segmente.
  Der Puffer ist kurzlebig, wird im Betrieb begrenzt und bei Inaktivität entfernt.
- **Nach Neustart von Stash/Container:** Den Start-Task erneut ausführen; ein
  separater bereits eingerichteter Dienst kann den Start alternativ übernehmen.

Es werden keine echten Bibliothekseinträge für virtuelle Stashy-Kanäle erzeugt.
Schreibzugriffe über diesen Adapter sind gesperrt. Das Plex-Tuner-Protokoll ist
auf ausdrücklich erlaubte Server-IPs begrenzt; M3U/XMLTV behalten ihre Tokenprüfung.

## Entwicklung und Tests

Quellcode liegt ausschließlich unter `plugins/StashIP-TV`. Die gebauten Dateien
`tvguide.js`, `tvguide.css` und `tvguide-server.js` behalten ihre technischen
Dateinamen und werden nicht eingecheckt. Nutzer installieren das fertige Paket.

```text
cd plugins/StashIP-TV
npm ci
npm run build
npm test -- --runInBand --silent
npm run test:iptv
```

Vom Repository-Verzeichnis, auch unter Windows:

```text
python tools/package_stashiptv.py --output-dir dist --revision local --check
```

Für die optionalen echten Medienprüfungen `FFMPEG_TEST_PATH` auf eine FFmpeg-Datei
setzen. Die CI-Matrix prüft Node.js 20, 22 und 24 unter Ubuntu und Windows und
führt Tests mit echtem FFmpeg, Programmwechseln, HLS, Task-Start/Stop, Unicode-
Pfaden und den bestehenden Kanal-/API-Einstellungen aus. Der Publish-Job läuft
erst nach den erfolgreichen Tests auf `main` und aktualisiert die stabile Quelle.
Tests verwenden einen lokalen Stash-API-Testserver; eine komplette echte Stash-
Installation auf jeder Betriebssystem-/Distributionsvariante wird damit nicht
behauptet. Auf ARM/anderen Distributionen müssen passende Node-/FFmpeg-Binaries
verfügbar sein; dortige Hardwarevarianten sind nicht Bestandteil der CI-Matrix.

## Lizenz und Herkunft

Abgeleitet von [hippochapel/hippo-stash-plugins](https://github.com/hippochapel/hippo-stash-plugins).
Die ursprüngliche Lizenz [AGPL-3.0](LICENCE) bleibt erhalten. Hinweise zu gebündelten
Abhängigkeiten stehen in [THIRD-PARTY-NOTICES.txt](plugins/StashIP-TV/THIRD-PARTY-NOTICES.txt).
