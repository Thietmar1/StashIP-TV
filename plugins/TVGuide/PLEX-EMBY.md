# Plex and Emby live TV (TVGuide 1.3.0)

Both integrations use the same saved channel lineup, custom channel names,
numbers (starting at 12 by default), live schedule and XMLTV programmes as
Jellyfin. Stash remains the place to manage channels. Node.js and FFmpeg run in
the existing IPTV service; no extra service or Docker port is needed.

## Custom channel names

1. Open **TVGuide** in Stash's navigation bar.
2. Choose the channel's source, find an included channel and click **Rename**.
3. Enter a **Channel name**, then click **Save name** (or press Enter).
4. **Reset name** restores its source name. An empty saved name also restores it.

This changes the channel's presentation, not the studio/tag/saved filter in
Stash. Existing overrides are preserved. Channel IDs and the seeded schedule
remain the same. Names are used in M3U, XMLTV, Stashy and the Plex tuner lineup.
As before, alphabetical ordering can change after a rename, so numbers following
that order can change too; XMLTV IDs remain stable for mapping.

The server refreshes its saved lineup within five minutes. Stop/start IPTV to
apply a rename immediately. Refresh channel lists and guide data in the client
afterwards; clients may retain previously imported names or manual overrides.

## Emby: M3U and XMLTV

No additional adapter switch is needed for Emby.

1. Start the IPTV server in Stash.
2. In the **Emby Server dashboard → Live TV**, choose **Add TV Source → M3U**.
3. Enter this playlist URL, replacing the placeholder with the IPTV Access Token:

   ```text
   http://192.168.178.20:9898/playlist.m3u?token=YOUR_IPTV_TOKEN
   ```

4. In Live TV add a guide provider of type **Xml TV**, using:

   ```text
   http://192.168.178.20:9898/epg.xml?token=YOUR_IPTV_TOKEN
   ```

5. Assign this guide provider to the TVGuide tuner. Check **channel mapping**
   and map any unmatched channels, then refresh guide data.
6. Keep Emby's simultaneous-stream setting within the IPTV Maximum Streams
   budget shared by all clients.

Emby's documented `tvg-id`, `tvg-name`, `tvg-chno` and `tvg-group` properties are
included in the playlist. Existing `group-title` is retained for other players.
The native Emby M3U route is preferred; Emby can optionally use the virtual
HDHomeRun tuner below instead, with its server IP explicitly allowed.

## Plex: virtual HDHomeRun tuner and XMLTV

Plex's tuner interface needs a virtual device rather than importing the M3U
directly. TVGuide provides the HTTP discovery, lineup/status, device XML and
numbered MPEG-TS stream endpoints. It is an optional software compatibility
adapter, not a physical or officially certified HDHomeRun device.

1. In Stash's TVGuide plugin settings, set **Plex Tuner Allowed IPs** to the
   actual Plex Media Server LAN IP, for example `192.168.178.30`. Multiple trusted
   servers can be separated by commas. Enter the server's IP, not the phone/TV
   running a Plex client.
2. Enable **Enable Plex HDHomeRun Tuner (Prototype)**.
3. Run **Stop IPTV Server**, then **Start IPTV Server**.
4. Open **Plex Web → Settings → Live TV & DVR** and add a tuner. Use the manual
   network-address option with `192.168.178.20:9898` (or
   `http://192.168.178.20:9898` if the field expects a URL).
5. Check that **TVGuide Live TV** and the custom channel names/numbers appear.
6. In DVR setup choose the **XMLTV guide** option and enter:

   ```text
   http://192.168.178.20:9898/guide.xml
   ```

   This URL is restricted to the allowed server IPs. The existing tokenized
   `epg.xml` URL can also be used. Map the channels to their XMLTV entries and
   finish setup. The adapter's channel number and name help with mapping.

There is no multicast/UDP auto-discovery, which avoids relying on multicast
across Docker and LXC boundaries. Add the address manually. Use the direct LAN
address with no Public URL path prefix for Plex setup; HTTP prefix handling is
tested, but Plex's manual-address UI handling of prefixes has not been checked.

Plex's XMLTV documentation describes selecting the guide while creating a DVR.
It also notes setup restrictions for an already configured DVR. Check your
existing setup before replacing a DVR or changing guide providers; this plugin
does not modify the Plex configuration itself. Recording entitlement depends on
Plex's current plan requirements.

### Access and troubleshooting

Plex's HDHomeRun requests do not supply the IPTV token. Therefore the tuner is
off by default and requires explicit server IPs before it can be enabled. Those
peers can read the tuner lineup/guide and play `/auto/v<number>` without a token.
Other peers get HTTP 403 before Stash is queried. Other IPTV routes still require
the token. Device IDs remain stable when names or the token change.

Use direct connections from Plex to the Stash LXC. Forwarded IP headers are
ignored. If Docker/NAT rewrites the connecting peer, determine the actual source
IP and prefer a direct route that preserves the Plex host's identity; allowing a
shared gateway/proxy would grant the same access to its other clients. The tuner
is intended for a trusted LAN, not public reverse-proxy access.

From the Plex server, these URLs should return the device, channels and guide:

```text
http://192.168.178.20:9898/discover.json
http://192.168.178.20:9898/lineup.json
http://192.168.178.20:9898/guide.xml
```

HTTP 404 means the tuner is disabled or the route is wrong. HTTP 403 means the
connecting peer is not allowed. HTTP 503 on playback means the shared stream
budget is full. Plex, Emby and Jellyfin TS viewers each occupy one encoder slot;
an active Stashy HLS channel occupies one shared slot until its idle timeout.
The reported tuner count equals the configured total budget, not its currently
free slots. Hardware tuning, CableCARD/DRM, UDP discovery and vendor services
are outside this adapter's scope.

Automated tests cover discovery/lineups, names/numbers/EPG consistency, stream
routes, shared limits, disabled mode, peer IP enforcement and spoofed proxy
headers. Actual playback and setup in the installed Plex/Emby versions still
need verification after installing 1.3.0.

## References

- [Emby M3U tuners](https://emby.media/support/articles/M3U-Tuners.html)
- [Emby XMLTV guide setup](https://emby.media/support/articles/Xml-Tv.html)
- [Plex XMLTV guide setup](https://support.plex.tv/articles/using-an-xmltv-guide/)
- [Plex Live TV/DVR FAQ](https://support.plex.tv/articles/226463767-frequently-asked-questions-dvr-live-tv/)
- [SiliconDust HTTP API specification](https://www.silicondust.com/hdhomerun/hdhomerun_http_development.pdf)
