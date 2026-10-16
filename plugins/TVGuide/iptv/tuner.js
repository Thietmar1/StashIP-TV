import { createHash } from 'node:crypto';
import { xml } from './guide.js';

// Stable identity independent of channel names and access tokens. The last
// nibble is the HDHomeRun device-ID checksum (not an actual hardware device).
export function tunerIdentity(baseUrl) {
    const hash = createHash('sha256').update(`TVGuide tuner:${baseUrl}`).digest('hex');
    const prefix = `10${hash.slice(0, 5)}`;
    const table = [0xa, 0x5, 0xf, 0x6, 0x7, 0xc, 0x1, 0xb, 0x9, 0x2, 0x8, 0xd, 0x4, 0x3, 0xe, 0x0];
    const checksum = [...prefix].reduce((sum, digit, i) => sum ^ (i % 2 ? parseInt(digit, 16) : table[parseInt(digit, 16)]), 0);
    return { deviceId: `${prefix}${checksum.toString(16)}`.toUpperCase(),
        uuid: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}` };
}

export function tunerDiscovery(config) {
    return { FriendlyName: 'TVGuide Live TV', Manufacturer: 'TVGuide',
        ModelNumber: 'HDTC-2US', FirmwareName: 'hdhomeruntc_atsc', FirmwareVersion: '20170930',
        DeviceID: tunerIdentity(config.publicUrl).deviceId, DeviceAuth: '',
        TunerCount: config.maxStreams, BaseURL: config.publicUrl, LineupURL: `${config.publicUrl}/lineup.json` };
}

export function tunerDeviceXml(config) {
    const { deviceId, uuid } = tunerIdentity(config.publicUrl);
    return `<?xml version="1.0" encoding="UTF-8"?>\n<root xmlns="urn:schemas-upnp-org:device-1-0"><URLBase>${xml(config.publicUrl)}</URLBase><specVersion><major>1</major><minor>0</minor></specVersion><device><deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType><friendlyName>TVGuide Live TV</friendlyName><manufacturer>TVGuide</manufacturer><modelName>HDTC-2US</modelName><modelNumber>HDTC-2US</modelNumber><serialNumber>${deviceId}</serialNumber><UDN>uuid:${uuid}</UDN></device></root>\n`;
}

export function tunerLineup(channels, config) {
    return channels.map((channel) => ({ GuideNumber: String(channel.number), GuideName: channel.name,
        // Plex may append its own query parameters. Tuner streams use the IP
        // allowlist and a plain URL rather than putting credentials in its query.
        URL: `${config.publicUrl}/auto/v${channel.number}` }));
}

export function tunerLineupXml(channels, config) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n<Lineup>' + tunerLineup(channels, config).map((item) =>
        `<Program><GuideNumber>${xml(item.GuideNumber)}</GuideNumber><GuideName>${xml(item.GuideName)}</GuideName><URL>${xml(item.URL)}</URL></Program>`
    ).join('') + '</Lineup>\n';
}
