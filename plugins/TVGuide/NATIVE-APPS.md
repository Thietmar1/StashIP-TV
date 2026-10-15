# TVGuide in native Stash apps

## Stashy: iOS and tvOS

Stashy is MIT-licensed and has SwiftUI applications for iOS and tvOS. Its existing
channels are saved-filter or entity-based continuous playlists: they load scene
pages and start playback at the beginning. They do not consume TVGuide's daily
schedule or XMLTV listings. See the source:

- https://github.com/1letzgo/stashy/blob/main/stashy/Home/HomeChannelsRowView.swift
- https://github.com/1letzgo/stashy/blob/main/stashyTV/TVChannelPlayerView.swift
- https://github.com/1letzgo/stashy/blob/main/README.md

A native TVGuide screen is feasible, but needs changes to Stashy. It can use the
existing server rather than duplicating the scheduler on the device:

1. Add an optional TVGuide server URL and its separate access token to each Stash
   connection. Store the token with the app's credentials (Keychain), never in
   diagnostics. The Stash API key and TVGuide token serve different endpoints.
2. Load `/playlist.m3u` for stable channel IDs, names, numbers and stream URLs.
3. Load `/epg.xml` and join XMLTV channel IDs to M3U `tvg-id` exactly. Convert
   timestamps to the device timezone; never reconstruct the daily schedule.
4. Add a Live TV tab on iOS and tvOS, with channels and current/next programme
   information. Reuse the native playback engine after verifying continuous
   MPEG-TS playback, reconnects and programme transitions on real devices.
5. Open the exported `/stream/<encoded-id>.ts` URL to join the current show.
   Do not seek a scene URL manually or write live-stream progress back as if
   the viewer had watched an on-demand scene from its beginning.

This repository provides the server side. It does not yet contain a Stashy fork
or a native iOS/tvOS implementation. A Windows environment cannot validate an
Apple platform build or sign an App Store release; that work requires Xcode
and testing on the intended devices. An upstream contribution needs the Stashy
maintainer's acceptance; a self-built fork can be tested independently.

## Mirage

Mirage's public website documents Stash browsing/playback, saved filters, DLNA
and SMB, but does not document TVGuide, M3U/XMLTV input, or a plugin SDK:
https://mirageplayer.app/

No usable public extension mechanism was established in this review. Native
TVGuide support would therefore require a supported integration point or a
change by Mirage's developer. No Mirage source modification or integration is
included here.

