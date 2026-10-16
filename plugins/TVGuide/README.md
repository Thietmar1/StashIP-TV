# TV Guide

Manage live channels from your Stash library and watch them through Jellyfin
or Emby. An optional virtual HDHomeRun tuner prototype also targets Plex.
An optional read-only adapter prototype presents those channels as virtual
scenes in Stashy, with both channel and currently playing scene in the title.

The Stash browser button opens **channel management**. The old browser player
and programme grid are no longer shipped. Channel rules, preferences, saved
filters and shared scheduling remain available to the IPTV server.

## Channel management

Open **TVGuide** in Stash's navigation bar. Select studios, performers, tags,
groups, saved filters or special channels. Rules with a minimum scene count
include matching sources automatically; explicit selections keep particular
sources. Existing lineups are preserved.

The manager retains channel names, logos, hidden state, pins and pin order,
scene caps and source selections. State is stored in TVGuide's Stash plugin
configuration, so it follows the Stash instance across browsers.

Click **Rename** on an included channel, enter its name and **Save name** (or
press Enter). **Reset name** restores the original. Names apply to M3U, XMLTV,
Stashy and the Plex tuner; the original Stash entities are unchanged. See
[Plex/Emby setup and names](PLEX-EMBY.md) for refresh and mapping instructions.

Special channels include **New releases**, **Recently added**, **Movies**,
**Shorts** and optional **All Scenes**. All Scenes uses a lightweight index and
one continuous shuffled cycle across midnight, ignoring normal scene caps.
Saved-filter channels remain usable without recreating them.

## Live scheduling and Jellyfin

See [IPTV setup](IPTV.md) for installation, Docker requirements, plugin tasks,
M3U and XMLTV URLs and Jellyfin channel mapping.

Ordinary channels use a deterministic daily shuffle. The programme and playback
offset depend on channel ID, scene pool and wall clock; clients share the same
broadcast. The configured timezone determines the broadcast day. Short pools
loop, and All Scenes uses its continuous cycle instead.

Channel numbers start at **12** by default and can be changed in plugin settings.
Both M3U and XMLTV use stable channel IDs. In Jellyfin, assign XMLTV channels
under **Map Channels**, then refresh guide data if automatic mapping fails.

After updating, run **Stop IPTV Server**, then **Start IPTV Server** to load
new server code.

## Stashy prototype

See [Stashy setup and limitations](NATIVE-APPS.md). Enable **Stashy Adapter
(Prototype)**, stop/start IPTV and add a separate Stashy server at the IPTV
public URL followed by `/stashy`. Use the **IPTV Access Token** as its API key.

Each channel appears as a virtual scene, for example
`12 · My Channel — Current Scene`. IDs stay stable when programmes change;
refresh the scene list to fetch current names. The adapter uses the existing
live stream and does not provide a separate EPG in Stashy. Editing the real
library through this connection is disabled.

Automated tests cover original Stashy GraphQL queries and media routes.
Playback on an actual iOS/tvOS device still needs verification. Live seeking,
downloads and Stashy's MP4 fallback are not supported by this prototype.
Version 1.2.1 serves buffered HLS to Stashy, including its HLS fallback URL;
Jellyfin's MPEG-TS stream is unchanged.

## Development

Run `npm ci`, `npm run build`, `npm test -- --runInBand` and `npm run test:iptv`.
The published server bundle includes its dependencies; the Stash installation
only needs Node.js 20+ and FFmpeg, with no npm install.

Legacy player source and tests remain in the repository for reference, but the
browser entry point only bundles channel management. Shared scheduling,
providers and state are still used by IPTV and the manager.

See [third-party notices](THIRD-PARTY-NOTICES.txt) for bundled dependencies.
