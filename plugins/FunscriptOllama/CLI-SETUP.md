# ChatGPT und Gemini mit Konto-Anmeldung (ab 0.3.0)

Unter **Einstellungen → Plugins → Funscript Ollama → AI Provider** wählen:

| Wert | Bildbereichsauswahl | Anmeldung |
| --- | --- | --- |
| `ollama` | Bisheriger lokaler Ollama-Server | Ollama URL / Ollama Model |
| `chatgpt_cli` | Offizielle Codex CLI | ChatGPT-Konto mit Codex-Zugang, z. B. Plus |
| `gemini_cli` | Offizielle Gemini CLI | Persönliches Google-Konto, z. B. Google AI Pro |

Die CLI-Anbieter nutzen **keinen separat abgerechneten API-Schlüssel**. Sie
arbeiten online, senden die jeweils ausgewählten zwei Bilder an OpenAI bzw.
Google und unterliegen den Modell-, Inhalts- und Nutzungslimits des Kontos.
Die Akzeptanz konkreter Bildinhalte, Ausgabequalität und Geschwindigkeit sind
nicht garantiert. Es wird keine Browseroberfläche automatisiert und keine
Anmeldung aus einem Browser oder einer anderen Anwendung ausgelesen.
Das Plugin ruft die unveränderte offizielle CLI auf; diese verwaltet ihre Tokens.

Die Namen **Processing Engine = ollama / ollama_haven** bleiben aus
Kompatibilitätsgründen erhalten. Sie bestimmen die gerichtete/radiale Messung,
während **AI Provider** die Bildbereichsauswahl bestimmt. Für ChatGPT oder Gemini
beispielsweise `ollama_haven` beibehalten und nur den Anbieter wechseln.
**Processing Engine = haven** bleibt vollständig lokal und ruft keinen Anbieter auf.
Der vorhandene Ollama-Server und seine Einstellungen bleiben erhalten.

## Zusätzliche Einstellungen

| Einstellung | Standard / Bedeutung |
| --- | --- |
| ChatGPT Codex CLI Path | `codex` aus dem PATH des Stash-Prozesses, alternativ absoluter ausführbarer Pfad |
| Gemini CLI Path | `gemini` aus dem PATH des Stash-Prozesses, alternativ absoluter ausführbarer Pfad |
| ChatGPT CLI Model | Leer: CLI-Standard; optional exakter bildfähiger Modellname, der dem Konto zur Verfügung steht |
| Gemini CLI Model | Leer: CLI-Standard; optional verfügbarer Modellname/Alias, z. B. `pro` oder `flash` |
| CLI Account Directory | Leer: jeweiliges normales CLI-Benutzerverzeichnis; empfohlen: eigener persistenter absoluter Ordner |
| AI Request Timeout Seconds | Weiterhin 10800 Sekunden; 10–10800 je Bildanfrage; CLI-Start-/Loginprüfung maximal 30 Sekunden |

**CLI Account Directory** ist kein Token. Bei `/root/.stash/funscript-accounts`
verwendet das Plugin für die Kindprozesse:

- `CODEX_HOME=/root/.stash/funscript-accounts/codex`
- `GEMINI_CLI_HOME=/root/.stash/funscript-accounts/gemini`
  (Gemini legt darin selbst `.gemini` an.)

Die Anmeldung muss exakt dieselben Verzeichnisse und dasselbe Dienstkonto wie
der Plugin-Aufruf verwenden. Das Plugin meldet niemanden automatisch an und
installiert keine Pakete während der Analyse. Der Task **Apply Recommended
Generation Settings** erhält Anbieter, CLI-Pfade, Kontoverzeichnis und Modelle.

## Docker im Stash-LXC

Node.js und die CLIs müssen **im Container `stash`** verfügbar sein, nicht nur
im LXC. Node.js 24 wird empfohlen; Gemini CLI 0.64.0 benötigt mindestens Node 20.
Die beim Einrichten verwendeten CLI-Versionen prüfen; bei älteren Codex-Versionen
können die benötigten Optionen `--ignore-user-config` und `--ephemeral` fehlen.
Die Anbindung wurde gegen Codex CLI 0.163.0-alpha.10.2 und Gemini CLI 0.64.0 geprüft.

Im vorhandenen Compose-Startblock die Alpine-Pakete `nodejs npm` mitführen.
Dadurch sind sie nach einer Container-Neuerstellung wieder vorhanden. Einmalig
in der LXC-Konsole die CLIs in das bestehende persistente Stash-Volume installieren:

```bash
docker exec stash sh -c 'node --version; npm --version'
docker exec stash sh -c 'npm install --prefix /root/.stash/funscript-cli @openai/codex @google/gemini-cli'
docker exec stash mkdir -p /root/.stash/funscript-accounts/codex /root/.stash/funscript-accounts/gemini
```

Danach in Stash einstellen:

```text
ChatGPT Codex CLI Path: /root/.stash/funscript-cli/node_modules/.bin/codex
Gemini CLI Path:        /root/.stash/funscript-cli/node_modules/.bin/gemini
CLI Account Directory: /root/.stash/funscript-accounts
```

Die absoluten Pfade vermeiden Abhängigkeiten vom npm-PATH des Dienstes.
CLI-Pakete nach Node-/Architekturwechsel passend neu installieren. Falls die
offizielle CLI auf dem verwendeten Alpine-/CPU-Build nicht startet, zuerst deren
Laufzeitkompatibilität klären; das Plugin ersetzt fehlende native Bestandteile nicht.
Das Stash-Plugin-Update selbst ersetzt diese außerhalb des Pluginordners
installierten Pakete oder Konto-Verzeichnisse nicht.

### ChatGPT anmelden

```bash
docker exec -it -e CODEX_HOME=/root/.stash/funscript-accounts/codex stash \
  /root/.stash/funscript-cli/node_modules/.bin/codex login --device-auth
```

Den angezeigten Link im eigenen Browser öffnen und den Einmal-Code eingeben.
Gegebenenfalls zuerst Gerätecode-Anmeldung in den ChatGPT-Sicherheitseinstellungen
freigeben. Danach prüfen:

```bash
docker exec -e CODEX_HOME=/root/.stash/funscript-accounts/codex stash \
  /root/.stash/funscript-cli/node_modules/.bin/codex login status
```

Erwartet wird **Logged in using ChatGPT**. Ein Login per API-Key wird von diesem
Modus abgelehnt. Authentifizierungsdateien niemals in Chat, Repository oder
öffentliche Fehlerberichte kopieren.

### Gemini anmelden

```bash
docker exec -it -e GEMINI_CLI_HOME=/root/.stash/funscript-accounts/gemini stash \
  /root/.stash/funscript-cli/node_modules/.bin/gemini
```

**Sign in with Google** wählen und mit dem zum Abo gehörenden Konto anmelden.
Die CLI zeigt den Browser-/Anmeldeablauf an. Im entfernten Container muss der
Browser-Callback erreichbar sein; gegebenenfalls eine SSH-Weiterleitung für
den von der CLI angezeigten lokalen Callback-Port einrichten. Die konkrete
Portnummer der laufenden CLI verwenden. Ein Callback auf `localhost` im Browser
des PCs erreicht ohne Weiterleitung nicht den Container.
Nach erfolgreicher Anmeldung die interaktive CLI beenden. Das Plugin startet
anschließend den dokumentierten Headless-Modus mit der gespeicherten Anmeldung.
Es verwendet keine kopierten OAuth-Tokens für eigene Backend-Anfragen.

## Natives Linux

Eine aktuelle Node.js-Laufzeit einschließlich npm für das Stash-Dienstkonto
bereitstellen. In einer Shell dieses Kontos beispielsweise:

```bash
npm install --prefix /PFAD/ZUR/STASH-KONFIGURATION/funscript-cli @openai/codex @google/gemini-cli
mkdir -p /PFAD/ZUR/STASH-KONFIGURATION/funscript-accounts/codex
mkdir -p /PFAD/ZUR/STASH-KONFIGURATION/funscript-accounts/gemini

CODEX_HOME=/PFAD/ZUR/STASH-KONFIGURATION/funscript-accounts/codex \
  /PFAD/ZUR/STASH-KONFIGURATION/funscript-cli/node_modules/.bin/codex login --device-auth
GEMINI_CLI_HOME=/PFAD/ZUR/STASH-KONFIGURATION/funscript-accounts/gemini \
  /PFAD/ZUR/STASH-KONFIGURATION/funscript-cli/node_modules/.bin/gemini
```

Absolute CLI-Pfade und den gemeinsamen `funscript-accounts`-Ordner im Plugin
setzen. Node muss auch im PATH des Stash-Dienstes erreichbar sein, da die npm-
Starter Node darüber finden. Der Dienst benötigt Schreibrechte auf den
Kontoverzeichnissen, damit die CLI ihre Anmeldung erneuern kann.

## Windows

Node.js einschließlich npm installieren. In PowerShell unter demselben Konto,
unter dem Stash ausgeführt wird, beispielsweise:

```powershell
npm.cmd install --prefix C:\Stash\funscript-cli @openai/codex @google/gemini-cli
$env:CODEX_HOME = 'C:\Stash\funscript-accounts\codex'
$env:GEMINI_CLI_HOME = 'C:\Stash\funscript-accounts\gemini'
New-Item -ItemType Directory -Force -Path $env:CODEX_HOME, $env:GEMINI_CLI_HOME | Out-Null
& C:\Stash\funscript-cli\node_modules\.bin\codex.cmd login
& C:\Stash\funscript-cli\node_modules\.bin\gemini.cmd
```

Im Plugin diese beiden `.cmd`-Pfade und `C:\Stash\funscript-accounts` setzen.
Das Plugin löst offizielle npm-Starter über den `bin`-Eintrag ihrer Paketdatei auf
und startet sie direkt mit Node, ohne `cmd /c` oder PowerShell. Node muss im
PATH des Stash-Dienstes liegen. Beliebige eigene `.bat`-/`.cmd`-Wrapper sind kein
unterstützter Ersatz. Eine Anmeldung unter einem anderen Windows-Benutzer gilt
nicht automatisch für das Dienstkonto.

## Test und Betrieb

1. **AI Provider** auf `chatgpt_cli` oder `gemini_cli` setzen und speichern.
2. **Test Selected AI Provider** ausführen. Er verwendet nur zwei künstliche
   Bilder. Ein erfolgreicher Test bestätigt auch Modellzugang und Bildantwort,
   aber noch keine Qualität für echte Videos.
3. Mit separatem **Queue Tag**, etwa `FunscriptOllama_Test`, zuerst eine kurze
   einzelne Szene verarbeiten. Danach erst größere Warteschlangen freigeben.

Die bisherige Aufgabe **Test Ollama Connection** testet weiterhin ausdrücklich
Ollama, unabhängig vom gewählten Anbieter. Kapitelimport-Aufgaben rufen keinen
KI-Anbieter auf. Bei CLI-Timeout, Kontingent-/Anmelde-/Startfehlern stoppt die
Verarbeitungsaufgabe nach der betroffenen Szene; restliche Szenen behalten ihren
Queue-Tag. Keine automatischen Anbieterwechsel, API-Key-Nutzung oder Kontokäufe.
Eine ungültige Bildbereichsantwort wird wie bisher genau einmal korrigiert.
Erneut ungültige Antworten lassen diese Szene fehlschlagen.

Die CLI läuft in einem temporären Arbeitsverzeichnis mit ausschließlich den
ausgewählten JPEG-Bildern. Diese Dateien werden nach der Anfrage entfernt.
Die CLI kann gemäß ihren eigenen Einstellungen/Standards Sitzungsdaten im
Kontoverzeichnis speichern; deren Aufbewahrung und die Cloud-Datenverwendung
bestimmt der jeweilige Anbieter. Codex wird mit `--ephemeral`, lesendem Sandbox-
Modus und ohne Shell, Hooks, Apps oder Subagents gestartet. Gemini erhält nur
Lesewerkzeuge; Hooks, Erweiterungen, Skills und MCP werden für den Aufruf
deaktiviert. Das ist keine Betriebssystem-Isolation des gesamten Stash-Kontos.

## Offizielle Grundlagen und Testumfang

- [Codex-Anmeldung und Gerätecode](https://learn.chatgpt.com/docs/auth)
- [Codex-Aufrufe mit Bildern und JSON Schema](https://learn.chatgpt.com/docs/cli/reference)
- [Gemini-Anmeldung, einschließlich Headless mit vorhandenem Login](https://geminicli.com/docs/get-started/authentication/)
- [Gemini Headless mit JSON-Ausgabe](https://geminicli.com/docs/cli/headless/)
- [Gemini-Datei-/Bildwerkzeuge](https://geminicli.com/docs/tools/file-system/)

Die automatischen Tests verwenden echte Kindprozesse mit einem Offline-CLI-
Testprogramm: Bildanhänge, Befehlsargumente, Antwortprüfung, Kontingentfehler,
Timeout inklusive Kindprozess-Abbruch, Ausgabelimit und Bilddatei-Cleanup.
CLI-Versionen/Hilfe wurden zusätzlich lokal geprüft. Eine echte Konto-Anmeldung
und Modellinferenz mit deinem ChatGPT-/Google-Konto sowie ein End-to-End-Test
im Stash-Container stehen noch aus. Die CLIs werden nicht im Plugin-ZIP mitgeliefert.
