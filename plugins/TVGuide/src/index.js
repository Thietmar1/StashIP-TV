// The browser plugin now contains channel management only. Playback and EPG
// are served by the shared Node backend for Jellyfin and the Stashy adapter.
import { startChannelManager } from './channelManager.js';

if (typeof window !== 'undefined' && !window.__tvguideStarted) {
    window.__tvguideStarted = true;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => startChannelManager(), { once: true });
    } else {
        startChannelManager();
    }
}
