import { isDefaultImage, resolveLogo } from '../../src/domain/logo.js';

describe('isDefaultImage', () => {
    it('treats a real image path as real', () => {
        expect(isDefaultImage('/studio/12/image?t=1699')).toBe(false);
    });

    it('detects Stash\'s placeholder marker', () => {
        expect(isDefaultImage('/studio/12/image?default=true')).toBe(true);
        expect(isDefaultImage('/studio/12/image?t=1&default=true')).toBe(true);
        expect(isDefaultImage('/studio/12/image?default=true&t=1')).toBe(true);
    });

    it('is not fooled by a similar-looking parameter', () => {
        expect(isDefaultImage('/studio/12/image?notdefault=true')).toBe(false);
        expect(isDefaultImage('/studio/12/image?default=false')).toBe(false);
    });

    it('treats missing values as no image', () => {
        expect(isDefaultImage(null)).toBe(true);
        expect(isDefaultImage(undefined)).toBe(true);
        expect(isDefaultImage('')).toBe(true);
    });
});

describe('resolveLogo', () => {
    it('uses real artwork when there is any', () => {
        expect(resolveLogo('/studio/1/image?t=2', 'Studio A')).toEqual({
            type: 'image',
            url: '/studio/1/image?t=2'
        });
    });

    it('falls back to a monogram for a placeholder image', () => {
        const logo = resolveLogo('/studio/1/image?default=true', 'Studio A');
        expect(logo.type).toBe('monogram');
        expect(logo.initials).toBe('SA');
        expect(typeof logo.hue).toBe('number');
    });

    it('falls back to a monogram when there is no image at all', () => {
        expect(resolveLogo(null, 'Favourites').initials).toBe('FA');
    });
});
