import {
    HALF_HOUR_MS,
    snapToStep,
    programRect,
    presentationBlocks,
    nowLinePct,
    timeTicks,
    clampWindowStart
} from '../../src/domain/layout.js';

const MIN = 60000;
const HOUR = 3600000;

// A window running 15:00 -> 18:00 on a fixed date keeps assertions readable.
const WINDOW_START = new Date(2026, 7, 22, 15, 0, 0).getTime();
const WINDOW_MS = 3 * HOUR;

const prog = (startMin, endMin) => ({
    startMs: WINDOW_START + startMin * MIN,
    endMs: WINDOW_START + endMin * MIN
});

describe('snapToStep', () => {
    it('floors to the previous half hour', () => {
        const t = new Date(2026, 7, 22, 15, 47, 30).getTime();
        expect(new Date(snapToStep(t, HALF_HOUR_MS)).getMinutes()).toBe(30);
        expect(new Date(snapToStep(t, HALF_HOUR_MS)).getSeconds()).toBe(0);
    });

    it('leaves an already-aligned time alone', () => {
        const aligned = new Date(2026, 7, 22, 15, 30, 0).getTime();
        expect(snapToStep(aligned, HALF_HOUR_MS)).toBe(aligned);
    });

    it('supports other step sizes', () => {
        const t = new Date(2026, 7, 22, 15, 47, 0).getTime();
        expect(new Date(snapToStep(t, HOUR)).getMinutes()).toBe(0);
    });
});

describe('programRect', () => {
    it('places a fully contained programme proportionally', () => {
        // 15:30 -> 16:30 inside a 3h window starting 15:00
        const r = programRect(prog(30, 90), WINDOW_START, WINDOW_MS);
        expect(r.leftPct).toBeCloseTo(100 / 6, 6);
        expect(r.widthPct).toBeCloseTo(100 / 3, 6);
        expect(r.clippedStart).toBe(false);
        expect(r.clippedEnd).toBe(false);
    });

    it('clips a programme that began before the window', () => {
        const r = programRect(prog(-60, 30), WINDOW_START, WINDOW_MS);
        expect(r.leftPct).toBe(0);
        expect(r.widthPct).toBeCloseTo(100 / 6, 6);
        expect(r.clippedStart).toBe(true);
        expect(r.clippedEnd).toBe(false);
    });

    it('clips a programme running past the window', () => {
        const r = programRect(prog(150, 300), WINDOW_START, WINDOW_MS);
        expect(r.leftPct).toBeCloseTo((150 / 180) * 100, 6);
        expect(r.leftPct + r.widthPct).toBeCloseTo(100, 6);
        expect(r.clippedEnd).toBe(true);
    });

    it('clips on both sides when the programme spans the whole window', () => {
        const r = programRect(prog(-60, 300), WINDOW_START, WINDOW_MS);
        expect(r.leftPct).toBe(0);
        expect(r.widthPct).toBe(100);
        expect(r.clippedStart).toBe(true);
        expect(r.clippedEnd).toBe(true);
    });

    it('gives zero width to a programme entirely outside the window', () => {
        expect(programRect(prog(-120, -60), WINDOW_START, WINDOW_MS).widthPct).toBe(0);
        expect(programRect(prog(240, 300), WINDOW_START, WINDOW_MS).widthPct).toBe(0);
    });

    it('never returns values outside 0..100', () => {
        for (let start = -240; start < 360; start += 17) {
            const r = programRect(prog(start, start + 40), WINDOW_START, WINDOW_MS);
            expect(r.leftPct).toBeGreaterThanOrEqual(0);
            expect(r.widthPct).toBeGreaterThanOrEqual(0);
            expect(r.leftPct + r.widthPct).toBeLessThanOrEqual(100.000001);
        }
    });
});

describe('presentationBlocks', () => {
    const block = (title, leftPct, widthPct, { isLive = false, isFocused = false } = {}) => ({
        program: { scene: { title }, startMs: leftPct, endMs: leftPct + widthPct },
        rect: { leftPct, widthPct, clippedStart: false, clippedEnd: false },
        isLive,
        isFocused
    });

    it('keeps an upcoming scene individual when its title has usable space', () => {
        const readable = block('Readable scene', 0, 20);

        expect(presentationBlocks([readable], 1)).toEqual([
            expect.objectContaining({ program: readable.program, programs: [readable.program], title: 'Readable scene' })
        ]);
    });

    it('groups a narrow upcoming scene with the next scene', () => {
        const first = block('First scene', 0, 5);
        const second = block('Second scene', 5, 15);

        expect(presentationBlocks([first, second], 1)).toEqual([
            expect.objectContaining({
                program: first.program,
                programs: [first.program, second.program],
                title: 'First scene, Second scene',
                rect: expect.objectContaining({ leftPct: 0, widthPct: 20 })
            })
        ]);
    });

    it('keeps extending a dense upcoming group until its label has usable space', () => {
        const first = block('First', 0, 4);
        const second = block('Second', 4, 4);
        const third = block('Third', 8, 12);

        expect(presentationBlocks([first, second, third], 1)).toEqual([
            expect.objectContaining({
                programs: [first.program, second.program, third.program],
                title: 'First, Second, and 1 more',
                rect: expect.objectContaining({ leftPct: 0, widthPct: 20 })
            })
        ]);
    });

    it('groups a live scene when its full duration is short', () => {
        const live = block('Live scene', 0, 4, { isLive: true });
        const future = block('Future scene', 4, 20);

        expect(presentationBlocks([live, future], 1)).toEqual([
            expect.objectContaining({ program: live.program, programs: [live.program, future.program], title: 'Live scene, Future scene', isLive: true })
        ]);
    });
});

describe('nowLinePct', () => {
    it('positions the line inside the window', () => {
        expect(nowLinePct(WINDOW_START + 90 * MIN, WINDOW_START, WINDOW_MS)).toBeCloseTo(50, 6);
    });

    it('sits at zero at the window start', () => {
        expect(nowLinePct(WINDOW_START, WINDOW_START, WINDOW_MS)).toBe(0);
    });

    it('returns null when now is outside the window', () => {
        expect(nowLinePct(WINDOW_START - MIN, WINDOW_START, WINDOW_MS)).toBeNull();
        expect(nowLinePct(WINDOW_START + WINDOW_MS + MIN, WINDOW_START, WINDOW_MS)).toBeNull();
    });

    it('returns null exactly at the far edge, where there is nothing left to mark', () => {
        expect(nowLinePct(WINDOW_START + WINDOW_MS, WINDOW_START, WINDOW_MS)).toBeNull();
    });
});

describe('timeTicks', () => {
    it('emits an aligned tick every step across the window', () => {
        const ticks = timeTicks(WINDOW_START, WINDOW_MS, HALF_HOUR_MS);
        expect(ticks.map((t) => t.label)).toEqual(['15:00', '15:30', '16:00', '16:30', '17:00', '17:30']);
        expect(ticks[0].leftPct).toBe(0);
        expect(ticks[1].leftPct).toBeCloseTo(100 / 6, 6);
    });

    it('starts from the first aligned time when the window is not aligned', () => {
        const unaligned = WINDOW_START + 10 * MIN; // 15:10
        const ticks = timeTicks(unaligned, HOUR, HALF_HOUR_MS);
        expect(ticks[0].label).toBe('15:30');
        expect(ticks[0].leftPct).toBeGreaterThan(0);
    });

    it('keeps every tick within the window', () => {
        for (const t of timeTicks(WINDOW_START, WINDOW_MS, HALF_HOUR_MS)) {
            expect(t.leftPct).toBeGreaterThanOrEqual(0);
            expect(t.leftPct).toBeLessThan(100);
        }
    });
});

describe('clampWindowStart', () => {
    const dayStart = new Date(2026, 7, 22, 0, 0, 0).getTime();

    it('allows panning within the permitted range', () => {
        const target = dayStart + 10 * HOUR;
        expect(clampWindowStart(target, dayStart, 12 * HOUR)).toBe(target);
    });

    it('refuses to pan before the earliest allowed time', () => {
        expect(clampWindowStart(dayStart - 5 * HOUR, dayStart, 12 * HOUR)).toBe(dayStart);
    });

    it('refuses to pan past the latest allowed time', () => {
        expect(clampWindowStart(dayStart + 20 * HOUR, dayStart, 12 * HOUR)).toBe(dayStart + 12 * HOUR);
    });
});
