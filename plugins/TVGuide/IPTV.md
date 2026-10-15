# TVGuide in Jellyfin (M3U + XMLTV)

TVGuide's included IPTV server exposes the Stash guide as live channels:

- `/playlist.m3u`: one permanent stream URL per channel, with matching `tvg-id`.
- `/epg.xml`: XMLTV programme listings for today and the following days.
- `/stream/<encoded-channel-id>.ts`: a continuous MPEG-TS stream that joins the
  programme currently on air at its live offset, then advances to the next one.
- `/health`: process health (also requires the TVGuide token).

Stash starts the included server through plugin tasks, using its raw external
plugin interface. It runs in the background so the task queue remains available.
A downloaded list of scene URLs alone would start each video at its beginning
and stop at the end; it would not behave as a live channel in Jellyfin.

The companion shares TVGuide's actual JavaScript scheduler, providers, daily pool
rotation, saved filters and channel preferences. It reads the server's
`configuration.plugins.TVGuide.tvguide_state`. Open TVGuide and save your channel
selection in its channel manager first. Renames, logos, pins, hidden channels and
per-channel scene caps are respected. Search and collapsed groups do not remove
channels from the exports. Channels with no playable duration are omitted.

## Install and control directly in Stash (Debian 13 / Proxmox LXC)

In the Stash LXC, install the two runtime requirements once:

```sh
apt update
apt install nodejs ffmpeg openssl
node --version
openssl rand -hex 24
```

Node.js must be version 20 or newer. Copy the generated random token for the
**IPTV Access Token** setting below. The package already contains the built server;
no npm dependencies, separate checkout or systemd service are needed.

Add this plugin source in **Settings → Plugins → Available Plugins → Add Source**:

```text
https://raw.githubusercontent.com/Thietmar1/hippo-stash-plugins/tvguide-iptv/index.yml
```

Refresh the source and install **TV Guide** (version 1.1 or newer). Existing
TVGuide installations keep the same plugin ID and saved channel lineup. Use this
fork's source for TVGuide updates, to avoid replacing it with the upstream version.

Open TVGuide's plugin settings and set:

| Setting | Value for your two-LXC setup |
| --- | --- |
| IPTV Public URL | `http://STASH_LXC_IP:9898` (reachable from Jellyfin) |
| IPTV Access Token | The random token generated above; separate from the Stash key |
| IPTV Stash API Key | Your Stash API key, recommended for uninterrupted service |
| IPTV Timezone | `Europe/Berlin`, matching the browser guide |
| IPTV Listen Address | Leave empty for `0.0.0.0` (LAN access) |
| IPTV Port | `9898`; match the Public URL (zero/empty also uses 9898 in 1.1.2+) |
| IPTV Guide Days | `3` (zero/empty also uses 3 in 1.1.2+) |
| IPTV Maximum Streams | `2` (zero/empty also uses 2 in 1.1.2+) |

Leave **IPTV Stash URL** empty to use Stash's local task connection. If Stash returns
media URLs using an external origin, set this field to that same reachable origin.
Leave **IPTV FFmpeg Path** empty to use Stash's configured FFmpeg binary or PATH.
Stash settings of type STRING display the API key/token as text; keep them private.

In Stash **Tasks → Plugin Tasks**, run **TV Guide: Start IPTV Server**. The task
finishes after the background server is ready. **IPTV Server Status** checks it;
**Restart IPTV Server** applies changed settings, and **Stop IPTV Server** stops
the server and its viewers. Check Status and run Start again after restarting
Stash or the LXC. Stop the server
before updating/uninstalling the plugin and start it after the update. Do not run
the plugin-managed server and the optional systemd service on the same port.

Tasks use Stash's task session to read configuration; a configured API key is used
for long-running playback. If no API key is set, the session cookie remains only
in server memory and playback stops working when that session expires. Restart
the task to renew the session, or configure the API key.

Private instance-control state is stored in `tvguide-iptv/server.json` underneath
Stash's configuration directory, outside the installed plugin package. It contains
no Stash API key or session cookie. A separate control token and instance ID allow
safe stop/status requests; the Jellyfin access token cannot stop the server.
The task's structured debug output includes the complete Jellyfin URLs.

Allow TCP 9898 from the Jellyfin LXC to the Stash LXC, then follow **Jellyfin
configuration** below. The M3U URL is
`http://STASH_LXC_IP:9898/playlist.m3u?token=YOUR_TVGUIDE_TOKEN`; XMLTV uses
`http://STASH_LXC_IP:9898/epg.xml?token=YOUR_TVGUIDE_TOKEN`.

## Stash in Docker inside the LXC

If Stash runs as a Docker container, install Node in that container/image, not
only in Debian on the LXC host. The official Stash image uses Alpine and already
includes FFmpeg. For a quick check/install on the container named `stash`:

```sh
docker exec -u 0 stash apk add --no-cache nodejs
docker exec stash /usr/bin/node --version
```

Make the installation part of your Dockerfile or existing startup script so it
survives container replacement. In Compose, publish `9898:9898` alongside Stash's
`9999:9999`. Set IPTV Listen Address to `0.0.0.0` and IPTV Public URL to the LXC's
LAN address on port 9898, for example `http://192.168.1.50:9898`. Do not use a
Docker-internal address or localhost for the public URL consumed by Jellyfin.
IPTV Stash URL can stay empty; it uses local port 9999 inside the Stash container.

For TVGuide versions before 1.1.2, enter explicit positive numbers for IPTV Port,
Guide Days and Maximum Streams. Stash can save blank NUMBER settings as zero,
which those versions reject. Version 1.1.2 treats zero/blank as the documented
defaults at the plugin-settings boundary. Restart IPTV Server after saving.

## Alternative: standalone systemd service

For automatic startup at LXC boot, you can alternatively manage the server with
systemd. The plugin tasks above are the default installation path.
Run the server in the **Stash LXC**. Jellyfin can stay in a separate LXC; it only
needs network access to TCP port 9898 on the Stash LXC. All transcoding happens in
the companion using software H.264/AAC, at 720p/25 fps. No device passthrough is
required. Each viewer consumes one FFmpeg process, so allocate CPU accordingly.

Requirements: Node.js 20 or newer and FFmpeg with `libx264` and AAC support.
Debian's `nodejs` and `ffmpeg` packages provide these. Inside the Stash LXC:

```sh
apt update
apt install nodejs ffmpeg openssl curl
node --version
ffmpeg -hide_banner -encoders | grep -E 'libx264| aac '
```

Obtain `tvguide-server.js` and `tvguide-iptv.service` from the built TVGuide plugin
ZIP, or build them from a checkout (development machine, not required in the LXC):

```sh
cd plugins/TVGuide
npm ci
npm run build
npm run test:iptv
```

`tvguide-server.js` is self-contained; no `npm install` or source tree is needed on
the server. From the directory containing those two files, install them as root:

```sh
install -d -m 0755 /opt/tvguide
install -m 0644 tvguide-server.js /opt/tvguide/tvguide-server.js
install -m 0644 tvguide-iptv.service /etc/systemd/system/tvguide-iptv.service
install -m 0600 /dev/null /etc/tvguide-iptv.env
openssl rand -hex 24
```

Edit `/etc/tvguide-iptv.env` with your addresses and the generated token:

```ini
STASH_URL=http://127.0.0.1:9999
STASH_API_KEY=YOUR_STASH_API_KEY
TVGUIDE_HOST=0.0.0.0
TVGUIDE_PORT=9898
TVGUIDE_PUBLIC_URL=http://192.168.1.50:9898
TVGUIDE_TOKEN=PASTE_THE_GENERATED_TOKEN_HERE
TVGUIDE_EPG_DAYS=3
TVGUIDE_MAX_STREAMS=2
TZ=Europe/Berlin
```

Replace `192.168.1.50` with the Stash LXC's LAN IP. `TVGUIDE_PUBLIC_URL` must be
reachable **from the Jellyfin LXC**, and cannot use `127.0.0.1` in this setup.
Use Stash's API key from **Settings → Security**; leave `STASH_API_KEY` empty only
if Stash does not require authentication. Never use the Stash key as the TVGuide
token. The playlist contains the TVGuide token, which grants access to the selected
channels; keep the playlist and both URLs private. Prefer a trusted LAN or HTTPS.

Stash's returned media URLs must use the same origin (scheme, host, port) as
`STASH_URL`. If Stash has an external host configured, use that reachable origin
for `STASH_URL` too. This check prevents sending the API key to another server.
The companion proxies Stash media and channel logos with redirects disabled;
the Stash key stays out of exports and FFmpeg command-line arguments.
Custom external HTTP(S) logos keep their configured URL.

Start and enable the service:

```sh
systemctl daemon-reload
systemctl enable --now tvguide-iptv
systemctl status tvguide-iptv
journalctl -u tvguide-iptv -n 50 --no-pager
```

Allow TCP 9898 between the two LXCs in any Proxmox/LXC firewall. You do not need to
expose port 9898 on the internet. Test **from the Jellyfin LXC**:

```sh
curl --fail 'http://192.168.1.50:9898/health?token=YOUR_TVGUIDE_TOKEN'
curl --fail 'http://192.168.1.50:9898/playlist.m3u?token=YOUR_TVGUIDE_TOKEN'
curl --fail 'http://192.168.1.50:9898/epg.xml?token=YOUR_TVGUIDE_TOKEN' -o /tmp/tvguide.xml
```

## Jellyfin configuration

In **Dashboard → Live TV**:

1. Add a tuner, select **M3U Tuner**, and enter:
   `http://192.168.1.50:9898/playlist.m3u?token=YOUR_TVGUIDE_TOKEN`
2. Set Jellyfin's simultaneous stream limit to the companion's limit (default 2).
3. Add a guide data provider, select **XMLTV**, and enter:
   `http://192.168.1.50:9898/epg.xml?token=YOUR_TVGUIDE_TOKEN`
4. Refresh guide data. If Jellyfin does not map a channel automatically, use
   **Map Channels** on the guide provider and select its corresponding channel.
5. Open Live TV and tune a channel. Confirm both the current show and a programme
   transition. The companion has no direct access to your Jellyfin installation;
   these installation-specific checks must run on your servers.

See the [official Jellyfin setup guide](https://jellyfin.org/docs/general/server/live-tv/setup-guide/)
for the M3U tuner and XMLTV provider screens.

## Scheduling and operation

- **Timezone:** use the same timezone as your Stash TVGuide browser, for example
  `Europe/Berlin`. TVGuide uses the viewer's local midnight; a browser in another
  timezone can have a different daily schedule. XMLTV timestamps are emitted as
  explicit UTC (`+0000`). Daylight saving days use actual local midnights.
- **Daily channels:** pool selection and shuffle change at local midnight. A show
  crossing midnight is cut there, matching TVGuide. Future EPG days load their own
  daily pools and date-dependent special-channel filters.
- **All Scenes:** retains TVGuide's continuous epoch-based rotation through midnight.
- **Refresh:** channel settings and library metadata are re-read after five minutes
  on the next request (and at midnight). EPG is generated on demand and cached with
  that snapshot. After changing lineup/settings/library, refresh Jellyfin's tuner
  and guide data. Restart the companion to force an immediate config reload.
- **Runtime:** keep system clocks synchronized. Startup, network and transcoding
  introduce a small playback delay. At each show change the stream recalculates
  the live offset. MPEG-TS timestamps advance across programmes; PAT/PMT versions
  and discontinuity flags announce source changes.
- **Failure:** missing streams, invalid durations, upstream errors or early EOF end
  that viewing connection. Jellyfin can reconnect; the next connection starts at
  the current live offset. Failed requests return 502; excess viewers return 503.
  Logs deliberately omit upstream URLs and FFmpeg stderr because those can contain
  credentials. API errors include the GraphQL operation and error in
  the server log, with configured keys, tokens, cookies and URLs redacted. Plugin
  tasks write the detached server's errors to `tvguide-iptv/server.log` inside
  Stash's configuration directory, resetting that file on each server start.
  These background errors are not included in `docker logs`. If
  health returns 200 but the playlist returns 502, request the playlist once and
  inspect `docker exec stash tail -n 30 /root/.stash/tvguide-iptv/server.log`
  for that operation's error (requires version 1.1.4 or newer).
  Version 1.1.5 also logs GraphQL HTTP 400/422 explanations and their field paths.
  It fixes saved Stash-ID criteria being sent with an unsupported `value` field,
  which made playlists fail with `variable.filter.stash_id_endpoint.value`.
  Version 1.1.6 fixes saved numeric/date range values being mistaken for entity
  lists (for example `cannot use slice as Int` at `filter.stash_id_count.value`).
  For diagnosis, check Stash's scene playback, API connectivity and
  the installed FFmpeg encoders.
- **Limits:** `TVGUIDE_EPG_DAYS` is 1–7 (default 3); `TVGUIDE_MAX_STREAMS` is 1–32
  (default 2). Each channel has a 100,000-programme limit per EPG export, reported
  as an error rather than silently dropping listings. Reduce days for very short
  scenes or large lineups. All Scenes listings use its summary title metadata.
- **Updates:** install a newly built `tvguide-server.js` in `/opt/tvguide` and run
  `systemctl restart tvguide-iptv`. Plugin UI updates do not restart this service.

For manual execution, export the environment variables and run
`node tvguide-server.js`. `FFMPEG_PATH` optionally selects a different FFmpeg binary.
The default listen address is loopback. Export URLs support a `?token=` parameter;
HTTP clients may alternatively send `Authorization: Bearer <TVGUIDE_TOKEN>`.

## Node.js not found by Stash

For Debian/LXC, the plugin task explicitly runs `/usr/bin/node`, the path provided
by Debian's `nodejs` package. Stash otherwise falls back to `<pluginDir>/node` if
its service PATH cannot resolve `node`. That fallback produces a misleading
`fork/exec .../TVGuide/node: no such file or directory` error.

Run `/usr/bin/node --version` inside the **Stash LXC**, rather than on the Proxmox
host. If the file is missing, install `nodejs` in that LXC. Update TVGuide to 1.1.1
or newer and reload plugins before running Start IPTV Server again. Installing
Node through a user's nvm shell does not make it available to Stash's service.
For another OS or a custom Node location, change the manifest's first `exec` entry
to the absolute path of that Node executable; standalone operation is unchanged.

