import { isIP, BlockList } from 'node:net';

export function parseTunerClients(value = '') {
    const clients = [...new Set(String(value ?? '').trim().split(/[\s,;]+/).filter(Boolean))];
    if (clients.length > 32 || clients.some((address) => !isIP(address))) {
        throw new Error('Plex tuner clients must be at most 32 literal IP addresses (no hostnames, wildcards or CIDR ranges)');
    }
    return clients;
}

export function tunerClientAllowed(address, clients = []) {
    if (!address || !isIP(address)) return false;
    const allowed = new BlockList();
    for (const client of clients) allowed.addAddress(client, isIP(client) === 6 ? 'ipv6' : 'ipv4');
    return allowed.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}
