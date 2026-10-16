# Funscript Ollama (Prototyp 0.1.0)

Eigenständiges Stash-Plugin, inspiriert vom Tag-Ablauf von
[FunscriptHaven](https://github.com/stashapp/CommunityScripts/tree/main/plugins/FunscriptHaven).
Es kombiniert **Ollama / `qwen3-vl:8b-instruct`** mit OpenCV und erstellt eine
einachsige `.funscript`-Datei neben dem Video. Es verändert StashIP-TV nicht.
Die Implementierung ist neu; der FunscriptHaven-Algorithmus, dessen VR-Verarbeitung
und dessen zusätzliche Achsen wurden nicht übernommen.

## Was Qwen übernimmt

Der voreingestellte Server ist **`http://192.168.178.16:11434`**. Qwen erhält zu
Beginn, nach erkannten Schnitten und etwa alle 20 Sekunden zwei verkleinerte
JPEG-Bilder. Das Modell wählt einen Bildbereich und eine horizontale oder
vertikale Bewegungsachse. OpenCV misst anschließend die tatsächliche Bewegung
zwischen den Bildern, standardmäßig mit ungefähr zehn Auswertungen pro Sekunde.
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
- Ollama mit installiertem `qwen3-vl:8b-instruct`. Die
  [Modellseite](https://ollama.com/library/qwen3-vl:8b-instruct) nennt mindestens
  Ollama 0.12.7. Auf dem Ollama-Server einmal ausführen:

  ```bash
  ollama pull qwen3-vl:8b-instruct
  ```

- Ein lokales Video pro Szene. Mehrere Dateien pro Szene, VR-/Stereobilder,
  Multi-Axis-Ausgabe und automatische GPU-Auswertung durch OpenCV sind in dieser
  Version nicht vorgesehen. Ollama kann seine eigene GPU verwenden.
- Decoder-Zeitstempel werden verwendet, wenn verfügbar; andernfalls greift
  die Bildrate. Bei variabler Bildrate ohne zuverlässige Decoder-Zeitstempel
  die Quelldatei vorher in eine konstante Bildrate umwandeln. Codec-Unterstützung
  hängt von der installierten OpenCV-Version ab.

## Installation über Stash

Nach dem Merge und erfolgreicher Veröffentlichung diese **zusätzliche**
Plugin-Quelle unter **Einstellungen → Plugins → Quellen** hinzufügen:

```text
https://raw.githubusercontent.com/Thietmar1/StashIP-TV/funscript-ollama/index.yml
```

Quellen aktualisieren, **Funscript Ollama** installieren und die Python-Abhängigkeiten
wie unten beschrieben einrichten. Die bestehende TV-Quelle bleibt erhalten.
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
2. Die Aufgabe **Test Ollama Connection** ausführen. Sie prüft das Modell und
   schickt ausschließlich zwei künstliche Testbilder. Eine erfolgreiche
   Verbindung ist noch kein Qualitätsnachweis für echte Videos.
3. Einer kurzen Testszene den Tag **FunscriptOllama_Process** geben.
4. **Process Tagged Scenes** ausführen; Fortschritt und Fehler stehen im
   Stash-Aufgabenprotokoll. Es gibt keinen Hintergrunddienst.
5. Die Ausgabe liegt neben dem Video, zum Beispiel `Beispiel.mp4` →
   `Beispiel.funscript`. Stashs Scan des betroffenen Medienordners erneut
   ausführen, falls die Datei dort noch nicht erkannt wird.

Erfolg entfernt den Queue-Tag und einen früheren Fehler-Tag und setzt
**FunscriptOllama_Complete**. Fehler lassen den Queue-Tag für einen erneuten
Versuch stehen und setzen **FunscriptOllama_Error**. Andere Tags bleiben erhalten.
Bereits vorhandene Skripte werden übersprungen; ihr Queue-Tag bleibt stehen.
**Overwrite Existing Funscript** ist standardmäßig aus. Bei aktiviertem
Überschreiben wird die bisherige Datei vor dem Austausch als
`Datei.funscript.<Zeitstempel>.bak` gesichert.

Das Speichern verwendet einen temporären Dateipfad im Zielordner und einen
atomaren Austausch bzw. Hardlink. Ext4 und NTFS unterstützen das; Netzlaufwerke
ohne Hardlink-Unterstützung melden einen Fehler, anstatt eine bestehende Datei
unbemerkt zu überschreiben. Eine neue Ausgabe ersetzt nicht automatisch den
Stash-Datenbankstatus, falls dessen anschließende Tag-Aktualisierung fehlschlägt.

## Einstellungen

| Einstellung | Standard | Bedeutung |
| --- | --- | --- |
| Analysis Frames Per Second | 10 | Zielrate der optischen Messung; 2–30 |
| Qwen Region Refresh Seconds | 20 | Neue Bildbereichsauswahl; 2–120 Sekunden |
| Ollama Request Timeout Seconds | 600 | Einschließlich Modellladezeit; 10–1800 |
| Maximum Position Change Per Second | 150 | Begrenzung für Werte von 0–100; 10–500 |
| Overwrite Existing Funscript | aus | Vor Überschreiben immer Sicherung erstellen |

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
```

Tests prüfen den echten lokalen HTTP-Transport mit einem Ollama-Testserver,
JSON-Validierung, optische Messung an einem synthetischen Video, Dateischutz,
Grenzwerte und den Stash-Tag-Ablauf mit einem Test-Client. Sie führen keine
Inferenz mit einem echten Qwen-Modell aus. Zusätzlich wurde der Vision-/JSON-Aufruf
am 16.10.2026 mit zwei künstlichen Bildern gegen den angegebenen Ollama-Server
geprüft: Ollama 0.34.0, Modell vorhanden, gültige strukturierte Antwort nach etwa
165 Sekunden bei CPU-Ausführung. Das Modell meldete dabei keine sichere Bewegung;
der Verbindungstest ist daher kein Nachweis brauchbarer Bewegungsfolgen.
Die GitHub-Matrix verwendet Linux/Windows und Python 3.11/3.13. Ein End-to-End-Test
in deinem Stash-Container mit echtem Videomaterial und eine manuelle
Qualitätsprüfung stehen noch aus.

Lizenz: AGPL-3.0, siehe beiliegende LICENCE. FunscriptHaven ist die Referenz für
den Bedienablauf; OpenCV, NumPy und stashapp-tools werden separat installiert
und behalten ihre jeweiligen Lizenzen.
