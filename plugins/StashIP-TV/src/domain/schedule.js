/**
 * Deterministic broadcast scheduling.
 *
 * A channel's programming is a pure function of (channel id, scene pool, day).
 * Nothing is stored: reload the page and the same programme is still playing,
 * at an offset that has advanced by exactly the elapsed wall-clock time. Two
 * browsers looking at the same channel agree without talking to each other.
 *
 * The broadcast day runs from local midnight. Both halves of the calculation
 * pivot on it -- the shuffle is seeded with the day key, and the playback
 * cursor is measured from the day's start -- so the two roll over together and
 * the day restarts cleanly instead of jumping mid-programme.
 *
 * No DOM, no I/O.
 */

/** Guard against a pathological window (very short scenes, very wide view). */
import { ALL_SCENES_CHANNEL_ID, ALL_SCENES_EPOCH_MS } from './allScenes.js';

export const MAX_SCHEDULE_WALK = 500;

/** FNV-1a. Small, fast, and stable across engines -- which matters, because
 *  this seeds the schedule every client must agree on. */
export function hashString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        // 32-bit FNV prime multiply, kept in range via Math.imul
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/** Seeded PRNG. Deterministic, uniform enough for shuffling a playlist. */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Fisher-Yates driven by the seeded PRNG. Returns a new array. */
export function seededShuffle(items, seed) {
    const out = items.slice();
    const rng = mulberry32(seed);
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = out[i];
        out[i] = out[j];
        out[j] = tmp;
    }
    return out;
}

/** The broadcast day containing `nowMs`, in the viewer's local timezone. */
export function dayBucket(nowMs) {
    const d = new Date(nowMs);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    const pad = (n) => String(n).padStart(2, '0');
    return {
        key: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
        startMs: start.getTime()
    };
}

/** Playable runtime of a scene in ms, or 0 if it has none we can trust. */
function durationMsOf(scene) {
    const seconds = scene && scene.files && scene.files[0] && scene.files[0].duration;
    // Absolute programme times are stored as JavaScript millisecond timestamps.
    // Keep offsets on the same integer grid: fractional source seconds can
    // otherwise produce a sub-millisecond rounding gap at a programme boundary.
    return typeof seconds === 'number' && seconds > 0 ? Math.max(1, Math.round(seconds * 1000)) : 0;
}

/**
 * Lay a channel's scenes end to end for one broadcast day.
 *
 * Scenes without a usable duration are dropped rather than defaulted -- a
 * guessed runtime would desync every downstream offset.
 *
 * @returns {{entries: Array<{scene: object, offsetMs: number, durationMs: number}>, totalMs: number}}
 */
export function buildDaySchedule(channelId, scenes, dayKey) {
    const continuous = channelId === ALL_SCENES_CHANNEL_ID;
    const source = continuous ? [...new Map((scenes || []).map((scene) => [scene.id, scene])).values()] : scenes;
    const pool = (source || []).filter((s) => durationMsOf(s) > 0);
    if (pool.length === 0) return { entries: [], totalMs: 0 };

    const ordered = seededShuffle(pool, hashString(`${channelId}|${continuous ? 'continuous-v1' : dayKey}`));

    const entries = [];
    let offsetMs = 0;
    for (const scene of ordered) {
        const durationMs = durationMsOf(scene);
        entries.push({ scene, offsetMs, durationMs });
        offsetMs += durationMs;
    }
    return { entries, totalMs: offsetMs, ...(continuous ? { epochMs: ALL_SCENES_EPOCH_MS } : {}) };
}

/** Positive modulo -- `%` alone would go negative for times before day start. */
function mod(n, m) {
    return ((n % m) + m) % m;
}

/** Index of the entry whose span contains `cursor`, by binary search. */
function indexAtCursor(entries, cursor) {
    let lo = 0;
    let hi = entries.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (entries[mid].offsetMs <= cursor) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

/**
 * What is playing at `nowMs`, with absolute start/end times.
 *
 * The schedule loops when a channel holds less than a full day of programming,
 * so absolute times are rebuilt from the loop the cursor landed in -- callers
 * can position a grid block from `startMs` without knowing loops exist.
 *
 * @returns {{scene, index, startMs, endMs, elapsedMs, durationMs}|null}
 */
export function programAt(daySchedule, nowMs, dayStartMs) {
    const { entries, totalMs } = daySchedule;
    if (totalMs <= 0) return null;
    dayStartMs = daySchedule.epochMs ?? dayStartMs;

    const sinceDayStart = nowMs - dayStartMs;
    const cursor = mod(sinceDayStart, totalMs);
    // Which pass through the playlist we are in; floor, so it is correct for
    // times before the day start too.
    const loopBase = dayStartMs + Math.floor(sinceDayStart / totalMs) * totalMs;

    const index = indexAtCursor(entries, cursor);
    const entry = entries[index];
    const startMs = loopBase + entry.offsetMs;

    return {
        scene: entry.scene,
        index,
        startMs,
        endMs: startMs + entry.durationMs,
        elapsedMs: cursor - entry.offsetMs,
        durationMs: entry.durationMs
    };
}

/**
 * Every programme overlapping [fromMs, toMs), in order and contiguous.
 *
 * Walks forward from whatever is playing at `fromMs`, so the block already in
 * progress at the window's left edge is included rather than clipped away.
 */
export function scheduleBetween(daySchedule, dayStartMs, fromMs, toMs) {
    if (daySchedule.totalMs <= 0 || toMs <= fromMs) return [];

    const out = [];
    let cursor = fromMs;
    while (out.length < MAX_SCHEDULE_WALK) {
        const program = programAt(daySchedule, cursor, dayStartMs);
        out.push(program);
        if (program.endMs >= toMs) break;
        cursor = program.endMs;
    }
    return out;
}
