# Native app adapter (StashIP-TV 1.5.0)

The optional adapter exposes the existing StashIP-TV live channels as a separate,
read-only Stash library. Stashy can browse one virtual scene per channel using
its existing Scenes screen and player. No Stashy fork or EPG screen is required.

Each title contains the channel number, channel name and current scene name:

```text
12 · My Channel — Current Scene
```

IDs identify channels, not the underlying real scenes, and remain stable across
programme changes. Metadata is evaluated when Stashy requests it. Refresh the
list or reopen a scene to update a title already displayed in the app; the
unmodified app does not receive live title notifications from this adapter.

## Setup: iOS / iPadOS / tvOS

1. Keep your existing Stash connection. Install StashIP-TV 1.2.1 or newer on Stash.
2. In StashIP-TV settings, enable **Enable Stashy Adapter (Prototype)**.
3. Run **Stop IPTV Server**, then **Start IPTV Server**. The same Node process,
   Docker port 9898 and FFmpeg stream service are used by Jellyfin and Stashy.
4. In Stashy add an **additional server**, for example named `StashIP-TV Live`:

   | Field | Value |
   | --- | --- |
   | Protocol | HTTP (or your configured HTTPS proxy) |
   | Server address | `192.168.178.20:9898/stashy` |
   | Authentication | API Key |
   | API Key | **IPTV Access Token** from StashIP-TV settings |

   The adapter uses its separate IPTV token as Stashy's API key. Do not enter
   your real Stash API key in this additional connection. For a custom Public URL
   with a path prefix, append `/stashy` to that entire URL.
5. Test the connection, switch to `StashIP-TV Live`, and open **Scenes** with no
   restrictive filters. Select a channel. It joins the currently scheduled scene
   at its live position and continues to the next one through the existing
   buffered live HLS stream. The first start takes several seconds to produce
   three complete segments. Refresh or reopen the scene after updating from
   1.2.0 so Stashy fetches the new HLS media URL.

The regular Stash connection and Jellyfin M3U/XMLTV URLs remain unchanged. There
is no additional Docker port to publish. Stash must allow GraphQL introspection:
the adapter loads the actual server schema once and uses it to validate client
queries. It does not forward the client's GraphQL operations to Stash.

## Prototype scope and validation

### Native dashboards and saved channel filters (1.5.0)

The adapter now returns a virtual **StashIP-TV Live** saved SCENES filter plus
one saved filter per currently playable channel. `findSavedFilters` and
`findSavedFilter` expose both modern `object_filter` / `find_filter` fields and
the legacy JSON criteria. A channel filter matches its stable `code`, so a
rename, renumbering or programme transition cannot select a different channel.
Empty/hidden/unselected channels do not become per-channel dashboard filters.
Nothing is written into the actual Stash database.

For an existing installation: update the plugin, stop/start IPTV, then reload
saved filters or reconnect the app to the existing `/stashy` connection.

In the inspected current **Stashy iOS** source:

1. Switch to the additional **StashIP-TV Live** server connection.
2. Open **Settings → Dashboard** and enable the **Channels** dashboard row.
3. In the **Channels** settings section, enable the desired saved channel filters
   and arrange them. Stashy synchronizes these from `findSavedFilters`.
4. Open the dashboard channel. Stashy opens its filtered scene feed; the one
   virtual scene represents the live channel and plays its HLS stream.

The Channels row is a **Stashy+** feature in that source revision. Availability
depends on the installed app version and entitlement. Without that row, the
adapter's normal Scenes catalogue and scene-based dashboard rows remain usable.
This does not install a new dashboard widget or bypass app feature restrictions.
tvOS/Android dashboard layouts are app-specific and are not assumed identical.

The adapter also provides `configuration.ui.frontPageContent` referencing the
all-live saved filter for clients that import Stash homepage filters. These are
API responses from the additional connection, not JavaScript or a modification
of the original server's homepage. App caches still need refreshing for new
names and programmes. No live title push or new browser player is introduced.

Source contract:
[Stashy HomeChannelsRowView.swift](https://github.com/1letzgo/stashy/blob/7a26a580e4b8aacf465e8097f67c72f8eb6bf98b/stashy/Home/HomeChannelsRowView.swift),
[DashboardSettingsView.swift](https://github.com/1letzgo/stashy/blob/7a26a580e4b8aacf465e8097f67c72f8eb6bf98b/stashy/Settings/DashboardSettingsView.swift).

The adapter supports the version probe, scene list/detail, scene pagination and
text search, common scene filters, virtual studio, statistics, saved dashboard
filters and empty other catalogue results. Unsupported filters return an explicit error.
Only the Live Scenes catalogue is intended for use; this is not a complete Stash
server replacement. Scenes are live streams with duration/resume position 0;
seeking and downloads are not supported. Both the primary media URL and Stashy's
constructed `stream.m3u8` fallback serve the same live HLS playlist. Its MP4
fallback remains unsupported.

Version 1.2.0 supplied an endless MPEG-TS URL. Stashy opens its primary source
with normal file playback options, which can force a forward-only stream onto
the engine's software playback path. Version 1.2.1 supplies HLS for the player's
remote-HLS route instead. This avoids relying on the app to declare raw TS live.
See [Stashy's source loading](https://github.com/1letzgo/stashy/blob/main/stashy/Playback/AetherSceneEngine.swift)
and [AetherEngine routing](https://github.com/superuser404notfound/AetherEngine/blob/b89240afcaebb958632b4b2c69284138c96e275f/Sources/AetherEngine/AetherEngine.swift).

HLS uses one encoder per actively watched channel, shared by Stashy viewers of
that channel. A second FFmpeg process only remuxes the existing H.264/AAC output;
it does not encode it again. Six rolling two-second segments are kept in a private
temporary directory, with a small deletion grace window. Each active HLS channel
uses one configured stream slot, shared with Jellyfin's existing stream limit.
After 45 seconds without playlist/segment requests, its processes and buffer are
removed. Stopping IPTV also closes every HLS producer. Brief extra playback delay
is expected because the player now has a buffer.

Library mutations (including rating, deletion, and playback-progress writes) are
rejected. Stashy may still show these controls because its interface is unchanged.
They cannot modify the real library through this connection. The real Stash
credentials stay in the backend; artwork is proxied through authenticated URLs.

Automated HTTP tests use the original Stashy GraphQL query documents for list,
detail and configuration, pinned under `iptv/test/fixtures/stashy/SOURCE.md` with
their MIT license. They test live title changes, stable IDs, token authentication,
read-only behavior, request limits, media routes and credential isolation.
Real FFmpeg tests decode HLS segments containing video/audio across a programme
change and verify producer sharing, idle cleanup and stream-slot release.

**Still required:** an actual playback check in the installed Stashy release on
iOS/iPadOS and Apple TV, including one programme transition. These device checks
cannot be replaced by HTTP contract tests and have not been performed here.

## Troubleshooting

- A failed connection test: enable the adapter, stop/start the server, and check
  the `/stashy` address, HTTP/HTTPS selection and separate IPTV token.
- An empty Scenes list: clear Stashy filters and check the saved StashIP-TV lineup.
- Correct names but playback fails: check Stash's private
  `tvguide-iptv/server.log` and verify the same channel in Jellyfin. Report the
  Stashy app version and device; omit access tokens from logs/screenshots.
- A rating/progress error: this connection is read-only by design. Use the
  original Stash server connection for on-demand library management.

The browser plugin now provides channel management only. Its player/grid is no
longer included in the browser bundle; the shared channel providers, saved
filters, preferences and server scheduler are retained for both integrations.

## Mirage

Mirage documents saved filters and importing Stash homepage filters into its
**For You** screen. The adapter supplies both kinds of metadata. Its website
also describes fetching an API key through username/password authentication;
this adapter currently uses its separate IPTV key and does not implement that
login flow. Complete Mirage connection/playback compatibility is therefore
**unverified**. Do not replace the normal Mirage/Stash connection on that basis.
If the installed app can connect using an API key, test a separate adapter
connection, then import/select **StashIP-TV Live** in For You settings. Otherwise
further app support or its exact request/error contract is required.

Sources:
- https://github.com/1letzgo/stashy
- https://github.com/1letzgo/stashy/blob/main/stashy/ServerConfig.swift
- https://github.com/1letzgo/stashy/blob/main/stashy/Playback/Scene%2BAetherPlayback.swift
- https://mirageplayer.app/
