# Funscript Ollama (Prototyp 0.2.1)

Eigenständiges Stash-Plugin, inspiriert vom Tag-Ablauf von
[FunscriptHaven](https://github.com/stashapp/CommunityScripts/tree/main/plugins/FunscriptHaven).
Es kombiniert **Ollama / `qwen3-vl:8b-instruct`**, die Bewegungsverarbeitung von
FunscriptHaven und den Kapitelimport von
[Funscript Markers](https://github.com/stashapp/CommunityScripts/tree/main/plugins/funscriptMarkers).
Es erstellt eine primäre `.funscript`-Datei und optional fünf zusätzliche Achsen
neben dem Video. Die lizenzierten Haven-Komponenten und Anpassungen sind in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) dokumentiert.

## Verarbeitungsmodi

Unter **Processing Engine** einen dieser Werte eintragen:

| Wert | Verhalten |
| --- | --- |
| `ollama` | Qwen wählt Bereich/Achse; OpenCV misst die gerichtete Bewegung. |
| `haven` | Haven-Radialbewegung ohne Ollama. Auch bei ausgeschaltetem Ollama-Server nutzbar. |
| `ollama_haven` | Standard: Qwen wählt den Bereich; darin wird Havens radiale Bewegung ausgewertet. |

**POV Mode** schaltet auch im `ollama`-Modus auf die radiale Messung mit einem
Ursprung unten in der Mitte des gewählten Bereichs um. **Balance Global Motion**
nutzt je nach Modus Hintergrundkompensation oder die ursprüngliche Haven-Gewichtung.
Driftfenster, lokale Normalisierung, Keyframe-Reduktion, Worker-Anzahl und maximale
Warteschlange sind konfigurierbar. Die wartenden Bildpaare bestimmen den
Speicherbedarf; das Video wird fortlaufend über OpenCV decodiert. Decord und die
ursprüngliche Intel-Arc-Decoder-Konfiguration werden nicht übernommen. Deshalb
sind Ergebnisse und Geschwindigkeit nicht bitgleich mit dem ursprünglichen Plugin.

### VR und zusätzliche Achsen

**Detect VR Tags** erkennt standardmäßig `VR`, `Virtual Reality`, `180°`, `360°`
ohne Beachtung der Großschreibung. **VR Tags** ist anpassbar. **VR Layout**:

- `haven`: unteres linkes Viertel, wie die ursprüngliche Haven-Vorverarbeitung.
- `sbs` (Standard): linkes Bild eines nebeneinander angeordneten Stereovideos.
- `tb`: oberes Bild eines übereinander angeordneten Stereovideos.
- `mono`: kein Zuschnitt, auch bei einem VR-Tag.

Dieser Zuschnitt gilt für Qwen und OpenCV. Es findet keine geometrische Entzerrung
von 180°-/360°-Projektionen statt.

**Generate Additional Axes** erzeugt `.surge.funscript`, `.sway.funscript`,
`.twist.funscript`, `.roll.funscript` und `.pitch.funscript`. Wie bei Haven sind
das **synthetische, an die Hauptbewegung gekoppelte Rauschkurven**, keine aus
dem Video rekonstruierten 3D-Bewegungen. Intensität, Variationstempo, Smart Limit,
Auto-Home-Verzögerung und Rückkehrdauer sind einstellbar. Null Sekunden Rückkehrdauer
bedeutet sofortige Zentrierung. Auch diese Dateien beachten Dateischutz, Backups
und Positions-/Geschwindigkeitsgrenzen. Bei vorhandener Hauptdatei können fehlende
zusätzliche Achsen ergänzt werden, ohne die Hauptdatei zu überschreiben.

## Was Qwen übernimmt

In den Ollama-Modi ist der voreingestellte Server **`http://192.168.178.16:11434`**. Qwen erhält zu
Beginn, nach erkannten Schnitten und etwa alle 30 Sekunden zwei verkleinerte
JPEG-Bilder. Das Modell wählt einen Bildbereich und eine horizontale oder
vertikale Bewegungsachse. OpenCV misst anschließend die tatsächliche Bewegung
zwischen den Bildern, standardmäßig mit ungefähr 15 Auswertungen pro Sekunde.
Die Bildbreite beträgt höchstens 512 Pixel; es wird kein vollständiges Video
an Ollama geschickt und es werden keine Vorschaubilder gespeichert.

Die gemessene Bewegung wird integriert, von langsamer Drift bereinigt, auf
0–100 normalisiert und auf Wendepunkte reduziert. Die Ausgabe begrenzt außerdem
die Positionsänderung pro Sekunde, einschließlich Übergängen zwischen Abschnitten.
Qwen erzeugt **keine Zeitstempel oder fertigen Bewegungsfolgen**. Bildanalyse
über die [Ollama Vision API](https://docs.ollama.com/capabilities/vision) und
[strukturierte JSON-Antworten](https://docs.ollama.com/capabilities/structured-outputs)
sind dafür Voraussetzung.

Das ist ein experimenteller Bewegungsdetektor. Ein falscher Bildbereich,
Kamerafahrten, Verdeckungen oder ungeeignete Perspektiven können unpassende
Kurven ergeben. Eine passende Gerätesynchronisation wird dadurch nicht garantiert.
Generierte Dateien zunächst in einem Editor prüfen. Es gibt keinen direkten
Gerätezugriff. Bei ungültigen Modellantworten, Decoderfehlern oder nicht messbarer
Bewegung wird keine neue Ausgabedatei veröffentlicht. Bereits erstellte Dateien
bleiben bei einem anschließenden Fehler beim Aktualisieren der Stash-Tags erhalten.

## Voraussetzungen

- Stash mit beschreibbarem Zugriff auf die Videodateien; getestet gegen den
  Plugin-/Abfragevertrag von Stash v0.31.1, noch nicht in einer echten Installation.
- Python **3.11 oder neuer**, OpenCV und NumPy im selben Container bzw. unter
  demselben Dienstkonto wie Stash; `stashapp-tools` für die Stash-Anbindung.
- Für die Ollama-Modi: Ollama mit installiertem `qwen3-vl:8b-instruct`. Die
  [Modellseite](https://ollama.com/library/qwen3-vl:8b-instruct) nennt mindestens
  Ollama 0.12.7. Auf dem Ollama-Server einmal ausführen:

  ```bash
  ollama pull qwen3-vl:8b-instruct
  ```

- Ein lokales Video pro Szene für die Bewegungsanalyse. Der Kapitelimport liest
  auch mehrere vorhandene primäre Sidecars einer Szene. Automatische
  GPU-Auswertung durch OpenCV ist nicht vorgesehen; Ollama kann seine eigene GPU verwenden.
- Decoder-Zeitstempel werden verwendet, wenn verfügbar; andernfalls greift
  die Bildrate. Bei variabler Bildrate ohne zuverlässige Decoder-Zeitstempel
  die Quelldatei vorher in eine konstante Bildrate umwandeln. Codec-Unterstützung
  hängt von der installierten OpenCV-Version ab.

## Installation über Stash

Unter **Einstellungen → Plugins → Quellen** dieselbe Quelle wie für StashIP-TV
verwenden. Der Index bietet **beide Plugins** an:

```text
https://raw.githubusercontent.com/Thietmar1/StashIP-TV/tvguide-iptv/index.yml
```

Quellen aktualisieren, **Funscript Ollama** installieren und die Python-Abhängigkeiten
wie unten beschrieben einrichten. Version 0.2.1 erscheint nach Merge und erfolgreicher
Veröffentlichung dieses Updates. Die bisherige separate Quelle
`https://raw.githubusercontent.com/Thietmar1/StashIP-TV/funscript-ollama/index.yml`
wird aus Kompatibilitätsgründen weiter aktualisiert. Bereits installierte Plugins
müssen beim Wechsel der Quelle nicht deinstalliert werden; die ID bleibt gleich.
Alternativ das ZIP nach `<Stash-Konfiguration>/plugins/FunscriptOllama/` entpacken
und die Plugins neu laden. Die Manifestdatei heißt **FunscriptOllama.yml** und
bestimmt auch die technische Einstellungs-ID `FunscriptOllama`.

## Dein Docker-/LXC-Aufbau (Alpine)

OpenCV, Python und NumPy müssen **im Container `stash`** installiert sein.
Die Installation im Debian-LXC allein reicht nicht. Ergänze im vorhandenen
Compose-Startblock die Alpine-Pakete; die anderen bereits benötigten Pakete
einschließlich Node.js bleiben bestehen:

```sh
apk add --no-cache python3 py3-pip py3-opencv py3-numpy

# Nutzt Alpine-Bibliotheken und installiert nur den Stash-API-Client per pip.
if [ ! -x /root/.stash/funscript-venv/bin/python ]; then
    python3 -m venv --system-site-packages /root/.stash/funscript-venv
fi
/root/.stash/funscript-venv/bin/python -m pip install 'stashapp-tools>=0.2.58,<1'
export PATH="/root/.stash/funscript-venv/bin:$PATH"

# Bereits vorhandenen Stash-Start erst danach ausführen:
exec /usr/bin/stash
```

Danach den Container mit der geänderten Compose-Konfiguration neu erstellen.
Falls in Stash bereits ein anderer Python-Interpreter unter **Python Path**
konfiguriert ist, dort `/root/.stash/funscript-venv/bin/python` eintragen:
Stash verwendet einen ausdrücklich konfigurierten Interpreter vorrangig vor PATH.
Kein `opencv-python` zusätzlich per pip in diese Alpine-Umgebung installieren;
es wird das bereits vorhandene `py3-opencv` verwendet. Ein hart codierter
`PYTHONPATH` für eine andere Python-Version ist für dieses Plugin nicht nötig.
Nach einem Alpine-/Python-Versionswechsel das virtuelle Environment passend neu
anlegen. Der Ordner unter `/root/.stash` bleibt durch dein vorhandenes Volume
erhalten.

Die exportierte PATH-Einstellung gilt für den gestarteten Stash-Prozess.
`docker exec` übernimmt diesen nachträglichen Shell-Export nicht automatisch.
Deshalb den Interpreter beim Test ausdrücklich angeben:

```bash
docker exec stash /root/.stash/funscript-venv/bin/python -c \
  'import cv2,numpy,stashapi; print("Python-Abhängigkeiten OK")'
docker exec stash /root/.stash/funscript-venv/bin/python -c \
  'import urllib.request; print(urllib.request.urlopen("http://192.168.178.16:11434/api/version", timeout=10).read().decode())'
```

Es wird kein zusätzlicher eingehender Stash-Port benötigt. Der Stash-Container
muss den Ollama-Server ausgehend erreichen können.

## Natives Linux

Ein virtuelles Environment außerhalb des Plugin-Ordners verhindert, dass ein
Plugin-Update die Python-Pakete ersetzt. Beispiel mit Debian 13:

```bash
sudo apt install python3 python3-venv
python3 -m venv /PFAD/ZUR/STASH-KONFIGURATION/funscript-venv
/PFAD/ZUR/STASH-KONFIGURATION/funscript-venv/bin/python -m pip install \
  -r /PFAD/ZUR/STASH-KONFIGURATION/plugins/FunscriptOllama/requirements.txt
```

Der Stash-Dienst braucht dieses `bin`-Verzeichnis an erster Stelle im `PATH`,
zum Beispiel durch `Environment="PATH=/PFAD/ZUR/STASH-KONFIGURATION/funscript-venv/bin:/usr/local/bin:/usr/bin:/bin"`
in einer systemd-Diensterweiterung. Danach `systemctl daemon-reload` und den
tatsächlichen Stash-Dienst neu starten. Der Dienstbenutzer benötigt Lesezugriff
auf Videos und Schreibzugriff auf deren Verzeichnisse.
Ein ausdrücklich in Stash gesetzter **Python Path** muss ebenfalls auf den
Interpreter dieses Environments zeigen.

## Natives Windows

Python 3.11+ installieren und beispielsweise in PowerShell ausführen:

```powershell
py -3 -m venv C:\Stash\funscript-venv
& C:\Stash\funscript-venv\Scripts\python.exe -m pip install -r C:\Stash\plugins\FunscriptOllama\requirements.txt
$env:Path = 'C:\Stash\funscript-venv\Scripts;' + $env:Path
& C:\Stash\stash.exe
```

Pfade anpassen. Bei einem Windows-Dienst muss dessen Umgebung denselben
Interpreter finden. Alternativ den ersten `exec`-Eintrag in **FunscriptOllama.yml**
durch den absoluten Interpreterpfad ersetzen oder Stashs **Python Path** auf
`C:\Stash\funscript-venv\Scripts\python.exe` setzen. Die Manifeständerung kann ein
Plugin-Update überschreiben. Videodateien müssen auch unter dem Dienstkonto
erreichbar sein; interaktiv verbundene Laufwerksbuchstaben gelten dort oft nicht.

## Benutzung

1. Unter **Einstellungen → Plugins → Funscript Ollama** bei **Ollama URL**
   `http://192.168.178.16:11434` und bei **Ollama Model** `qwen3-vl:8b-instruct`
   eintragen. Leere Felder verwenden die genannten Standardwerte.
2. Bei einer bestehenden Installation die Aufgabe **Apply Recommended Generation Settings**
   ausführen und die Einstellungsseite neu laden, um das unten beschriebene Profil
   einschließlich des dreistündigen Timeouts zu übernehmen.
3. Die Aufgabe **Test Ollama Connection** ausführen. Sie prüft das Modell und
   schickt ausschließlich zwei künstliche Testbilder. Eine erfolgreiche
   Verbindung ist noch kein Qualitätsnachweis für echte Videos.
4. Einer kurzen Testszene den Tag **FunscriptOllama_Process** geben.
5. **Process Tagged Scenes** ausführen; Fortschritt und Fehler stehen im
   Stash-Aufgabenprotokoll. Es gibt keinen Hintergrunddienst.
6. Die Ausgabe liegt neben dem Video, zum Beispiel `Beispiel.mp4` →
   `Beispiel.funscript`. Stashs Scan des betroffenen Medienordners erneut
   ausführen, falls die Datei dort noch nicht erkannt wird.

Erfolg entfernt den Queue-Tag und einen früheren Fehler-Tag und setzt
**FunscriptOllama_Complete**. Fehler lassen den Queue-Tag für einen erneuten
Versuch stehen und setzen **FunscriptOllama_Error**. Andere Tags bleiben erhalten.
Die Bewegung vorhandener Skripte wird übersprungen; ihr Queue-Tag bleibt stehen.
Kapitel können dabei importiert und fehlende Zusatzachsen ergänzt werden.
**Overwrite Existing Funscript** ist standardmäßig aus. Bei aktiviertem
Überschreiben wird die bisherige Datei vor dem Austausch als
`Datei.funscript.<Zeitstempel>.bak` gesichert.

Das Speichern verwendet einen temporären Dateipfad im Zielordner und einen
atomaren Austausch bzw. Hardlink. Ext4 und NTFS unterstützen das; Netzlaufwerke
ohne Hardlink-Unterstützung melden einen Fehler, anstatt eine bestehende Datei
unbemerkt zu überschreiben. Eine neue Ausgabe ersetzt nicht automatisch den
Stash-Datenbankstatus, falls dessen anschließende Tag-Aktualisierung fehlschlägt.
Dateien werden einzeln atomar gespeichert. Falls nach einer Hauptdatei eine
Zusatzachse oder die Marker-Aktualisierung fehlschlägt, bleibt die bereits
gespeicherte Ausgabe erhalten. Ein neuer Durchlauf kann fehlende Zusatzachsen
ergänzen; vorhandene Dateien werden ohne aktiviertes Überschreiben erhalten.

## Kapitel und Stash-Marker

Die Funktionen von Funscript Markers sind in folgenden Aufgaben enthalten:

- **Import Chapters From Tagged Scenes:** primäre Sidecars der mit dem Queue-Tag
  markierten Szenen lesen. Keine Videos auswerten und keine Skripte verändern.
- **Import Chapters From All Scenes:** die Dateipfade aller Szenen nach primären
  `.funscript`-Dateien durchsuchen. Funktioniert auch, bevor Stash die neue Datei
  als interaktiv markiert hat. Bei großen Bibliotheken entsprechend aufwendiger.

Diese Aufgaben benötigen **keinen Ollama-Server**. Sie lesen
`metadata.chapters` mit `name`, `startTime` und optional `endTime`. Unterstützt
werden Sekunden oder `HH:MM:SS.mmm`, einschließlich Kapitel bei Sekunde null.
Leere Kapitelnamen werden wie beim Vorbild zu `#`. Ungültige Kapitel stoppen den
Import dieser Datei, bevor Marker daraus angelegt werden. Bereits importierte
Dateien können gefahrlos erneut eingelesen werden: passende Titel/Tags innerhalb
der **Marker Duplicate Tolerance Seconds** werden übersprungen. Manuelle Marker
werden weder gelöscht noch verändert. Neue Kapitel können neue Stash-Tags anlegen.

**Automatically Import Chapter Markers** aktiviert denselben Ablauf nach der
Skripterzeugung und beim Erhalten einer vorhandenen Hauptdatei. Die ausdrücklichen
Import-Aufgaben funktionieren unabhängig von diesem Automatik-Schalter.
**Export Stash Markers As Chapters** übernimmt vorhandene Stash-Marker in neue
primäre Skripte und erhält beim Überschreiben vorhandene Sidecar-Kapitel.
**Add Completion Marker** ergänzt optional `Funscript Generated` bei Sekunde null
mit dem Tag `Funscript`, ohne diesen Marker doppelt anzulegen.

Das Plugin erfindet keine Kapitelbezeichnungen aus Modellantworten. Ohne bereits
vorhandene Kapitel oder Stash-Marker gibt es keine inhaltlichen Kapitel zu
importieren/exportieren; der optionale Abschlussmarker ist davon unabhängig.

## Empfohlenes Startprofil

Die neuen Standardwerte stehen auch in [recommended-settings.json](recommended-settings.json).
Die Aufgabe **Apply Recommended Generation Settings** speichert dieses Profil
in Stash. Sie ändert die dort aufgeführten Erzeugungseinstellungen einschließlich
Timeout und schaltet das Überschreiben vorhandener Dateien aus. Ollama-Adresse,
Modell, Tag-Namen, benutzerdefinierte VR-Tags und sämtliche Marker-Einstellungen
bleiben erhalten. Die Aufgabe analysiert keine Videos und stellt keine Ollama-Anfrage.
Bereits gespeicherte Werte bleiben bei einem normalen Plugin-Update erhalten;
das Profil wird erst durch die ausdrückliche Aufgabe übernommen.

Als Ausgangspunkt kombiniert `ollama_haven` Qwens Bereichsauswahl mit Havens
Bewegungsmessung. 15 Messungen pro Sekunde erfassen mehr Bewegungsdetails als
der bisherige Standard mit 10. Die Bereichsauswahl wird alle 30 Sekunden und
nach erkannten Schnitten erneuert. Driftbereinigung über 2 Sekunden, lokale
Normalisierung über 4 Sekunden und die Reduktion auf Wendepunkte bleiben aktiv.
Die Begrenzung auf 150 Positionspunkte pro Sekunde glättet abrupte Änderungen.
Diese Werte sind ein Startprofil; eine Qualitätsprüfung an echtem Videomaterial
steht noch aus. Perspektive, Kamerabewegung und Geschwindigkeit können andere
Werte oder den gerichteten Modus `ollama` erfordern.

Zusatzachsen bleiben aus, da ihre synthetischen Kurven keine zusätzliche
gemessene Bewegungsinformation liefern. POV nur bei passender Perspektive
aktivieren. Bei VR das tatsächliche Layout prüfen: `sbs` passt zu nebeneinander
angeordneten Bildern; bei übereinander angeordneten Bildern `tb` wählen.

## Einstellungen

| Einstellung | Standard | Bedeutung |
| --- | --- | --- |
| Analysis Frames Per Second | 15 | Zielrate der optischen Messung; 2–30 |
| Qwen Region Refresh Seconds | 30 | Neue Bildbereichsauswahl; 2–120 Sekunden |
| Ollama Request Timeout Seconds | 10800 | 3 Stunden je HTTP-Anfrage einschließlich Modellladezeit; 10–10800 |
| Maximum Position Change Per Second | 150 | Begrenzung für Werte von 0–100; 10–500 |
| Overwrite Existing Funscript | aus | Vor Überschreiben immer Sicherung erstellen |
| Processing Engine | `ollama_haven` | `ollama`, `haven` oder `ollama_haven` |
| Motion Worker Threads | 2 | Parallele optische Messungen; 1–32 |
| Maximum Queued Frame Pairs | 32 | Maximale wartende Bildpaare; 1–3000 |
| Detrend Window Seconds | 2 | Driftbereinigung; 1–10 |
| Normalization Window Seconds | 4 | Lokale Bereichskalibrierung; 1–10 |
| Reduce Keyframes | an | Aus schalten für alle gemessenen Punkte |
| POV Mode | aus | Radialmessung vom unteren Mittelpunkt |
| Balance Global Motion | an | Modusabhängige Kamerakompensation/Gewichtung |
| Detect VR Tags | an | Tag-basierte VR-Erkennung |
| VR Tags | `VR,Virtual Reality,180°,360°` | Kommagetrennte Tag-Namen |
| VR Layout | `sbs` | `haven`, `sbs`, `tb`, `mono` |
| Generate Additional Axes | aus | Surge, Sway, Twist, Roll, Pitch |
| Additional Axis Intensity | 5 | 0–10 |
| Additional Axis Variation Speed | 3 | 0–10 |
| Limit Additional Axes By Activity | an | Haven Smart Limit |
| Auto Home Delay Seconds | 1 | 0–10 |
| Auto Home Duration Seconds | 1 | 0–10; null bedeutet sofort |
| Automatically Import Chapter Markers | an | Kapitel in Stash übernehmen |
| Export Stash Markers As Chapters | an | Stash-Marker in neue Skripte übernehmen |
| Marker Duplicate Tolerance Seconds | 0.25 | Zeitabstand für passende Titel/Tags; 0–15 |
| Add Completion Marker | aus | Abschlussmarker bei Sekunde null |

Der **Timeout ist pro Installation in Stash einstellbar**, unter
**Einstellungen → Plugins → Funscript Ollama → Ollama Request Timeout Seconds**.
10800 Sekunden (3 Stunden) sind der Standard für ein leeres Feld. Ein bereits
gespeicherter eigener Wert wird durch das Update nicht ersetzt: bei Bedarf manuell
auf `10800` setzen oder das Startprofil anwenden. Der Verbindungstest und beide
Ollama-Verarbeitungsmodi verwenden diesen Wert für ihre HTTP-Anfragen.
Das Plugin wartet auf die vollständige Antwort (`stream: false`); im
Aufgabenprotokoll stehen Beginn und Ende jeder Anfrage. Der Timeout begrenzt die
Wartezeit auf die Antwort pro HTTP-Anfrage, nicht die gesamte Szene oder Aufgabe.
Netzwerkfehler, ein Abbruch durch Ollama oder vorgeschaltete Proxy-Timeouts können
die Anfrage früher beenden. Nach einem Fehler wird kein Ersatzskript erfunden.

Niedrige Bildraten erfassen schnelle Bewegung schlechter. Häufigere Qwen-Anfragen
erhöhen die Laufzeit und die übertragene Bildmenge. Es wird jeweils eine Szene
verarbeitet; die Geschwindigkeit hängt von Video-Decoding, CPU und Ollama ab.
Keine automatischen Modell-Downloads und keine stillen Ersatzkurven bei Fehlern.

Auf einem reinen CPU-Server können schon zwei kleine Bilder mehrere Minuten
benötigen. Bei Zeitüberschreitungen den Timeout erhöhen; für weniger Modellaufrufe
das Regionsintervall beispielsweise auf 120 Sekunden setzen. Erkannte Schnitte
lösen trotzdem eine neue Auswahl aus. Die automatische Analyse kann deutlich
länger als die Videolaufzeit dauern. GPU-Beschleunigung wird in Ollama eingerichtet,
nicht durch dieses Stash-Plugin. Den aktuellen Modellstatus zeigt Ollamas `/api/ps`.

## Entwicklung und Prüfung

```bash
python -m pip install -r plugins/FunscriptOllama/requirements.txt
python -m unittest discover -s plugins/FunscriptOllama/tests -v
python tools/package_funscript_ollama.py --output-dir dist/funscript-ollama --revision local --check
python tools/package_catalog.py --output-dir dist/catalog --revision local --check
```

Tests prüfen den echten lokalen HTTP-Transport mit einem Ollama-Testserver,
JSON-Validierung, optische Messung an einem synthetischen Video, Dateischutz,
Grenzwerte, VR-/POV-Verarbeitung, Zusatzachsen, Kapitelimport und den Stash-Tag-Ablauf
mit einem Test-Client. Sie führen keine
Inferenz mit einem echten Qwen-Modell aus. Zusätzlich wurde der Vision-/JSON-Aufruf
am 16.10.2026 mit zwei künstlichen Bildern gegen den angegebenen Ollama-Server
geprüft: Ollama 0.34.0, Modell vorhanden, gültige strukturierte Antwort nach etwa
165 Sekunden bei CPU-Ausführung. Das Modell meldete dabei keine sichere Bewegung;
der Verbindungstest ist daher kein Nachweis brauchbarer Bewegungsfolgen.
Die GitHub-Matrix verwendet Linux/Windows und Python 3.11/3.13. Ein End-to-End-Test
in deinem Stash-Container mit echtem Videomaterial und eine manuelle
Qualitätsprüfung stehen noch aus.

Lizenz: AGPL-3.0, siehe beiliegende LICENCE und THIRD-PARTY-NOTICES.md für die
adaptierten Haven-Komponenten. OpenCV, NumPy und stashapp-tools werden separat
installiert und behalten ihre jeweiligen Lizenzen.
