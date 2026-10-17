# ChatGPT und Antigravity mit Konto-Anmeldung (ab 0.5.0)

| AI Provider | Bildbereichsauswahl | Anmeldung |
| --- | --- | --- |
| `ollama` | Lokaler Ollama-Server | Ollama URL / Modell |
| `chatgpt_cli` | Offizielle Codex CLI | ChatGPT-Konto mit Codex-Zugang |
| `antigravity_cli` | Offizielle Antigravity CLI, Programm `agy` | Google-/Antigravity-Konto |

Die alte Auswahl `gemini_cli` wird als `antigravity_cli` behandelt; auch `antigravity` wird akzeptiert. Künftig `antigravity_cli` speichern. **Gemini CLI Path/Model werden nicht übernommen:** Das alte Programm und Aliase wie `pro`/`flash` sind kein gültiger Ersatz. Die neuen Felder **Antigravity CLI Path/Model** verwenden.

Die CLI verarbeitet ausgewählte Bilder online und unterliegt den Inhalts-, Modell- und Nutzungslimits des Kontos. Das Plugin nutzt keine API-Schlüssel, privaten HTTP-Endpunkte oder Browser-Automatisierung. Die offizielle CLI verwaltet ihre Anmeldung. Ein IDE-Login allein bestätigt noch keinen erfolgreichen Plugin-Bildaufruf.

**Processing Engine** `ollama`/`ollama_haven` beibehalten: Diese wählen die lokale Bewegungsauswertung; **AI Provider** wählt die Bildregion. `haven` bleibt vollständig lokal.

## Einstellungen und separates Profil

| Feld | Bedeutung |
| --- | --- |
| Antigravity CLI Path | `agy` aus dem Stash-PATH oder absoluter nativer `agy`/`agy.exe`-Pfad; kein IDE-Starter oder Shell-Wrapper |
| Antigravity CLI Model | Leer: CLI-Standard. Optional exakter bildfähiger Modell-Slug aus `agy models`; alte Aliase werden nicht geraten |
| ChatGPT Codex CLI Path / Model | Bestehende Codex-Anbindung unverändert |
| CLI Account Directory | Optionaler absoluter persistenter Ordner: Codex verwendet darin `codex`, Antigravity darin `antigravity` als eigenes Benutzerprofil |
| AI Request Timeout Seconds | 10–10800 Sekunden pro Anfrage, Standard 10800; derselbe Wert wird als `--print-timeout` an Antigravity übergeben |

Ohne **CLI Account Directory** bleibt Codex bei seinem normalen Profil. Antigravity verwendet `<Stash-Benutzerverzeichnis>/.funscript-ollama/antigravity`. Nur beim Antigravity-Kindprozess werden `HOME` und `USERPROFILE` auf dieses Profil gesetzt. Es werden keine Token-Dateien aus anderen Profilen kopiert oder gelesen. Die CLI kann den Betriebssystem-Schlüsselspeicher desselben Benutzers nutzen; ein Dienstkonto muss gegebenenfalls separat angemeldet werden.

**Test Selected AI Provider** einmal starten: Das Plugin legt das reservierte Profil und seine Berechtigungsdatei an, bevor es die CLI testet. Scheitert die Anmeldung, anschließend mit genau diesem Profil interaktiv anmelden und erneut testen. Das Profil ausschließlich für das Plugin verwenden; keine Erweiterungen dort installieren.

Das Profil verwendet `strict` und sperrt Shell-/Schreib-/Web-/MCP-Aktionen. API-Modus, eigene MCP-Server, Hooks, Plugins oder geänderte Sicherheitsregeln führen zum Abbruch. Persönliche IDE-Einstellungen werden nicht überschrieben. Zur Reparatur in `<Profil>/.gemini/antigravity-cli/settings.json` folgende Regeln setzen und eigene Erweiterungen aus diesem reservierten Profil entfernen:

```json
{"toolPermission":"strict","allowNonWorkspaceAccess":false,"permissions":{"deny":["command(*)","unsandboxed(*)","write_file(*)","read_url(*)","execute_url(*)","mcp(*)"],"allow":[],"ask":[]}}
```

## Windows, Beispiel für diesen PC

Die offizielle **Antigravity CLI 1.4+** installieren; sie ist ein eigenes Programm, kein IDE-Starter. [Offizielle Installation](https://antigravity.google/docs/install?tab=cli):

```powershell
irm https://antigravity.google/cli/install.ps1 | iex
```

In einer neuen PowerShell unter dem Stash-Benutzer prüfen:

```powershell
& "$env:LOCALAPPDATA\agy\bin\agy.exe" --version
& "$env:LOCALAPPDATA\agy\bin\agy.exe" --help
```

Für `proMB` ist der übliche Programmpfad `C:\Users\proMB\AppData\Local\agy\bin\agy.exe`. In Stash beispielsweise:

```text
AI Provider:           antigravity_cli
Antigravity CLI Path:  C:\Users\proMB\AppData\Local\agy\bin\agy.exe
CLI Account Directory: C:\Users\proMB\StashAIAccounts
Antigravity CLI Model: [zunächst leer]
```

Nach dem ersten Plugin-Test in einer **separaten** PowerShell mit diesem Profil anmelden und danach das Fenster schließen:

```powershell
$env:HOME = 'C:\Users\proMB\StashAIAccounts\antigravity'
$env:USERPROFILE = $env:HOME
& 'C:\Users\proMB\AppData\Local\agy\bin\agy.exe'
```

Den von `agy` angebotenen Google-Login abschließen; keine API-Key-Anmeldung wählen. Danach **Test Selected AI Provider** erneut ausführen. Läuft Stash als anderer Dienstbenutzer, gelten dessen Pfade und Schlüsselspeicher; eine Anmeldung als `proMB` ersetzt das nicht.

ChatGPT bleibt separat verfügbar:

```powershell
npm.cmd install --prefix C:\Stash\funscript-cli @openai/codex
$env:CODEX_HOME = 'C:\Users\proMB\StashAIAccounts\codex'
& C:\Stash\funscript-cli\node_modules\.bin\codex.cmd login
```

Den Codex-Pfad im Plugin setzen. Node muss im Stash-PATH liegen. Offizielle Codex-npm-Starter werden direkt über Node gestartet, ohne `cmd /c`.

## Natives Linux

CLI und Anmeldung müssen demselben Benutzer wie Stash gehören:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
command -v agy
agy --version
agy --help
```

Den absoluten Pfad aus `command -v agy` im Plugin eintragen. **CLI Account Directory** beispielsweise `/PFAD/ZUR/STASH-KONFIGURATION/funscript-accounts`. Nach dem ersten Plugin-Test unter dem Stash-Benutzer anmelden:

```bash
HOME=/PFAD/ZUR/STASH-KONFIGURATION/funscript-accounts/antigravity \
USERPROFILE=/PFAD/ZUR/STASH-KONFIGURATION/funscript-accounts/antigravity \
/ABSOLUTER/PFAD/ZU/agy
```

Bei SSH den von der CLI angebotenen Browser-/Code-Ablauf nutzen. Ein Windows-Login ersetzt keinen Linux-Login. Bei Diensten ohne zugänglichen Schlüsselspeicher muss zuerst die offizielle CLI allein erfolgreich laufen; keine Tokens aus anderen Anwendungen kopieren.

Für Codex weiterhin Node/npm bereitstellen:

```bash
npm install --prefix /PFAD/ZUR/STASH-KONFIGURATION/funscript-cli @openai/codex
CODEX_HOME=/PFAD/ZUR/STASH-KONFIGURATION/funscript-accounts/codex \
/PFAD/ZUR/STASH-KONFIGURATION/funscript-cli/node_modules/.bin/codex login --device-auth
```

## Docker im LXC

Entscheidend ist der Container `stash`, nicht der LXC-Host. Eine Installation auf Debian außerhalb des Containers reicht nicht. Antigravity benötigt kein npm-Paket `@google/gemini-cli`.

Die passende offizielle Linux-CLI muss **innerhalb des Containers** starten:

```bash
docker exec stash /ABSOLUTER/PFAD/ZU/agy --version
docker exec stash /ABSOLUTER/PFAD/ZU/agy --help
```

Das Stash-Alpine-Image und die offizielle CLI können unterschiedliche Laufzeitbibliotheken voraussetzen. Allgemeine Alpine-/musl-Unterstützung ist hier nicht bestätigt. Falls der native Starter dort nicht läuft, zuerst einen CLI-kompatiblen Container verwenden. Die Windows-Prüfung bestätigt keine Container-Inferenz.

CLI passend zur Architektur installieren und im eigenen Image dauerhaft bereitstellen. Das Profil im persistenten Volume behalten. Im Plugin **CLI Account Directory** `/root/.stash/funscript-accounts` und den absoluten CLI-Pfad setzen. Nach dem ersten Plugin-Test anmelden:

```bash
docker exec -it \
  -e HOME=/root/.stash/funscript-accounts/antigravity \
  -e USERPROFILE=/root/.stash/funscript-accounts/antigravity \
  stash /ABSOLUTER/PFAD/ZU/agy
```

Codex kann weiterhin im persistenten Stash-Volume installiert werden:

```bash
docker exec stash sh -c 'npm install --prefix /root/.stash/funscript-cli @openai/codex'
docker exec -it -e CODEX_HOME=/root/.stash/funscript-accounts/codex stash \
  /root/.stash/funscript-cli/node_modules/.bin/codex login --device-auth
```

## Test und Betrieb

1. Einstellungen speichern, **Test Selected AI Provider** ausführen. Es verwendet ausschließlich zwei künstliche Bilder.
2. Nach erfolgreichem Bildtest zuerst eine kurze Szene über einen getrennten Queue-Tag testen.
3. **Apply Recommended Generation Settings** erhält Anbieter, Pfade und Modelle. **Test Ollama Connection** prüft weiterhin Ollama.

Antigravity läuft mit JSON Schema, eigenem Zeitlimit und deaktivierter Slash-/Skill-Erweiterung in einem temporären Verzeichnis mit zwei JPEG-Bildern. Der Bildbetrachter darf sie lesen; Befehle, Schreiben, Web und MCP sind gesperrt. Dies ist keine Betriebssystem-Isolation des gesamten Stash-Kontos.

Nur `status=SUCCESS` mit vollständigem `structured_output` wird angenommen. Auch Exitcode 0 mit Teilantwort, Zeitlimitmeldung oder fehlendem Ergebnis gilt als Fehler. Ungültige Regionen erhalten höchstens einen Korrekturversuch. Bei Konto-/Kontingent-/Start-/Zeitlimitfehlern stoppt die restliche Warteschlange; keine Anbieterwechsel oder API-Key-Fallbacks.

Temporäre Bilder und Diagnosedateien werden entfernt; rohe CLI-Ausgaben erscheinen nicht im Stash-Protokoll. Antigravity kann eigene Sitzungsdaten im reservierten Profil ablegen. Deren Aufbewahrung und die Cloud-Verarbeitung bestimmt Google.

## Grundlagen und Prüfgrenzen

- [Installation und Anmeldung](https://antigravity.google/docs/install?tab=cli)
- [Headless, JSON Schema und Ergebnisstatus](https://antigravity.google/docs/cli/headless/)
- [Berechtigungen](https://antigravity.google/docs/permissions/)
- [CLI-Einstellungen](https://antigravity.google/docs/cli/using)
- [Codex-Anmeldung](https://learn.chatgpt.com/docs/auth)

Automatische Tests prüfen reale Offline-Kindprozesse, JPEG-Dateien, Argumente, Ergebnisvalidierung, Migration, Profilschutz, Kontingentfehler, Ausgabelimit, Zeitlimit und Kindprozessabbruch sowie die vorhandenen Bewegungs-/Kapitelabläufe. Der Aufrufvertrag der nativen Antigravity-CLI 1.4.0 wurde zusätzlich unter Windows geprüft. Der native Bildversuch lieferte hier kein strukturiertes Ergebnis und wurde korrekt abgelehnt. Eine erfolgreiche Konto-Inferenz im Stash-Dienst und die Qualität für deine Videos sind noch nicht bestätigt. CLI-Programme und Anmeldedaten werden nicht im Plugin-ZIP mitgeliefert.
