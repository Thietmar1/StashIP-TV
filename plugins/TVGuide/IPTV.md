# TVGuide in Jellyfin (M3U + XMLTV)

The optional TVGuide IPTV companion exposes the Stash guide as live channels:

- `/playlist.m3u`: one permanent stream URL per channel, with matching `tvg-id`.
- `/epg.xml`: XMLTV programme listings for today and the following days.
- `/stream/<encoded-channel-id>.ts`: a continuous MPEG-TS stream that joins the
  programme currently on air at its live offset, then advances to the next one.
- `/health`: process health (also requires the TVGuide token).

This is an additional service, because the existing Stash plugin runs in the
browser. A downloaded list of scene URLs would start each video at its beginning
and stop at the end; it would not behave as a live channel in Jellyfin.

The companion shares TVGuide's actual JavaScript scheduler, providers, daily pool
rotation, saved filters and channel preferences. It reads the server's
`configuration.plugins.TVGuide.tvguide_state`. Open TVGuide and save your channel
selection in its channel manager first. Renames, logos, pins, hidden channels and
per-channel scene caps are respected. Search and collapsed groups do not remove
channels from the exports. Channels with no playable duration are omitted.

## Debian 13 / Proxmox LXC

Run the companion in the **Stash LXC**. Jellyfin can stay in a separate LXC; it only
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
  credentials. For diagnosis, check Stash's scene playback, API connectivity and
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
