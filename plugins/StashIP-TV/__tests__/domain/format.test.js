import { formatClock, formatDuration, formatRemaining, monogram } from '../../src/domain/format.js';

describe('formatClock', () => {
    it.each([
        [0, 0, '12:00 AM'], [0, 5, '12:05 AM'], [9, 5, '9:05 AM'],
        [12, 0, '12:00 PM'], [15, 30, '3:30 PM'], [23, 59, '11:59 PM']
    ])('renders %i:%i on a 12-hour clock as %s', (hour, minute, expected) => {
        expect(formatClock(new Date(2026, 7, 22, hour, minute).getTime(), true)).toBe(expected);
    });

    it('renders 24-hour time zero-padded', () => {
        expect(formatClock(new Date(2026, 7, 22, 9, 5).getTime())).toBe('09:05');
        expect(formatClock(new Date(2026, 7, 22, 15, 30).getTime())).toBe('15:30');
        expect(formatClock(new Date(2026, 7, 22, 0, 0).getTime())).toBe('00:00');
    });
});

describe('formatDuration', () => {
    it('renders m:ss under an hour', () => {
        expect(formatDuration(0)).toBe('0:00');
        expect(formatDuration(9)).toBe('0:09');
        expect(formatDuration(605)).toBe('10:05');
    });

    it('renders h:mm:ss at or over an hour', () => {
        expect(formatDuration(3600)).toBe('1:00:00');
        expect(formatDuration(3753)).toBe('1:02:33');
    });

    it('floors fractional seconds', () => {
        expect(formatDuration(59.9)).toBe('0:59');
    });

    it('treats missing or negative input as zero', () => {
        expect(formatDuration(null)).toBe('0:00');
        expect(formatDuration(-5)).toBe('0:00');
        expect(formatDuration(undefined)).toBe('0:00');
    });
});

describe('formatRemaining', () => {
    it('counts down in whole minutes', () => {
        expect(formatRemaining(12 * 60000)).toBe('12 min left');
        expect(formatRemaining(90 * 60000)).toBe('90 min left');
    });

    it('rounds up so a part-minute never reads as finished', () => {
        expect(formatRemaining(30000)).toBe('1 min left');
    });

    it('says ending when there is under a second to go', () => {
        expect(formatRemaining(0)).toBe('ending');
        expect(formatRemaining(-1000)).toBe('ending');
    });
});

describe('monogram', () => {
    it('takes initials from the first two words', () => {
        expect(monogram('Studio Name').initials).toBe('SN');
        expect(monogram('Alpha Beta Gamma').initials).toBe('AB');
    });

    it('falls back to the first two letters of a single word', () => {
        expect(monogram('Vixen').initials).toBe('VI');
    });

    it('uppercases', () => {
        expect(monogram('lowercase words').initials).toBe('LW');
    });

    it('handles empty and whitespace-only names', () => {
        expect(monogram('').initials).toBe('?');
        expect(monogram('   ').initials).toBe('?');
        expect(monogram(null).initials).toBe('?');
    });

    it('handles a single-letter name', () => {
        expect(monogram('X').initials).toBe('X');
    });

    it('assigns a stable hue per name', () => {
        expect(monogram('Studio A').hue).toBe(monogram('Studio A').hue);
        expect(monogram('Studio A').hue).not.toBe(monogram('Studio B').hue);
    });

    it('keeps the hue in degrees', () => {
        for (const n of ['a', 'bb', 'Studio Long Name', 'Zed']) {
            expect(monogram(n).hue).toBeGreaterThanOrEqual(0);
            expect(monogram(n).hue).toBeLessThan(360);
        }
    });
});
