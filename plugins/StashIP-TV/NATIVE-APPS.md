# Stashy adapter prototype (StashIP-TV 1.2.1)

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

The adapter supports the version probe, scene list/detail, scene pagination and
text search, common scene filters, virtual studio, statistics and empty saved
filter/other catalogue results. Unsupported filters return an explicit error.
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

Mirage's public website does not establish a compatible virtual-server/plugin
integration contract. This prototype targets the inspected Stashy iOS/tvOS
queries; compatibility with Mirage has not been verified.

Sources:
- https://github.com/1letzgo/stashy
- https://github.com/1letzgo/stashy/blob/main/stashy/ServerConfig.swift
- https://github.com/1letzgo/stashy/blob/main/stashy/Playback/Scene%2BAetherPlayback.swift
- https://mirageplayer.app/
