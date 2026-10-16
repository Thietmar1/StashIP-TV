import { logoBadge } from '../../src/ui/logoBadge.js';

describe('logoBadge', () => {
    it('renders real artwork as a decorative image', () => {
        const node = logoBadge({ name: 'Studio A', logo: { type: 'image', url: '/img?t=1' } });
        expect(node.tagName).toBe('IMG');
        expect(node.getAttribute('src')).toBe('/img?t=1');
        // Decorative: the channel name is already beside it in text.
        expect(node.getAttribute('alt')).toBe('');
        expect(node.getAttribute('loading')).toBe('lazy');
    });

    it('renders initials on a stable colour when there is no artwork', () => {
        const node = logoBadge({ name: 'Studio A', logo: { type: 'monogram', initials: 'SA', hue: 42 } });
        expect(node.tagName).toBe('SPAN');
        expect(node.textContent).toBe('SA');
        expect(node.style.getPropertyValue('--tvguide-logo-hue')).toBe('42');
        expect(node.getAttribute('aria-hidden')).toBe('true');
    });

    it('falls back when a channel has no logo at all', () => {
        const node = logoBadge({ name: 'Nameless' });
        expect(node.textContent).toBe('?');
    });
});
