# Thietmar1 Stash plugins

Fork of [hippochapel/hippo-stash-plugins](https://github.com/hippochapel/hippo-stash-plugins),
with TVGuide M3U playlists, XMLTV listings and live streams for Jellyfin.

## Install TVGuide in Stash

In **Settings → Plugins → Available Plugins → Add Source**, add:

```text
https://raw.githubusercontent.com/Thietmar1/hippo-stash-plugins/tvguide-iptv/index.yml
```

Refresh the source and install **TV Guide**. The package includes the guide and
IPTV server. Install Node.js 20+ and FFmpeg in the Stash LXC (`apt install nodejs
ffmpeg`), configure the IPTV fields in TVGuide's plugin settings, then run
**Start IPTV Server** in Stash's Tasks page. No npm install or separate systemd
service is needed for plugin-managed operation.

See [IPTV setup](plugins/TVGuide/IPTV.md) for the settings and Jellyfin URLs.
Stop the IPTV server before a plugin update, then start it again afterwards.
The `tvguide-iptv` branch contains the compiled package and its SHA256-verified
index. The publish workflow updates that branch when changes land on `main`.
This install source works without GitHub Pages.

## Optional GitHub Pages source for the full plugin collection

1. Click **Use this template** > **Create a new repository**. 
1. Choose a repository name and click **Create repository**.
1. Open **Settings** and head to **Pages**.
1. Under Build and deployment select the Source as GitHub Actions.

Now add your plugins to [plugins](/plugins) directory and they will be automatically published to the source index.

After enabling Pages, the full collection's source URL is
[`https://thietmar1.github.io/hippo-stash-plugins/main/index.yml`](https://thietmar1.github.io/hippo-stash-plugins/main/index.yml).

## Share your plugins

- [Create a new topic](https://discourse.stashapp.cc/t/-/33) for your plugin on the community forum.
- [Add your source index to the list](https://discourse.stashapp.cc/t/-/122) on the Stash community forum.

## License

The default license is set to [AGPL-3.0](/LICENCE). Before publishing any plugins you can change it.
