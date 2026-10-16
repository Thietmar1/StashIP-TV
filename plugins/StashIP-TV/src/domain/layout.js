/**
 * Geometry for the guide grid.
 *
 * Everything here converts times into percentages of the visible window, so the
 * grid can be laid out with plain CSS percentages and stays correct at any
 * width -- no pixel measurement, nothing to recompute on resize.
 *
 * No DOM, no I/O.
 */

import { formatClock } from './format.js';

export const HALF_HOUR_MS = 1800000;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// This deliberately allows ordinary ellipsis; it only prevents guide entries
// whose visible label would be an unrecognizable fragment such as "The…".

/** Floor a timestamp to the previous `stepMs` boundary of the local day. */
export function snapToStep(ms, stepMs) {
    const d = new Date(ms);
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
    return dayStart + Math.floor((ms - dayStart) / stepMs) * stepMs;
}

/**
 * Where a programme sits in the window, as percentages.
 *
 * Blocks routinely overhang both edges, so the rect is clipped to the window
 * and reports which sides were cut -- the grid draws a continuation arrow on
 * a clipped edge rather than implying the programme starts or ends there.
 */
export function programRect(program, windowStartMs, windowMs) {
    const rawLeft = ((program.startMs - windowStartMs) / windowMs) * 100;
    const rawRight = ((program.endMs - windowStartMs) / windowMs) * 100;

    const leftPct = clamp(rawLeft, 0, 100);
    const rightPct = clamp(rawRight, 0, 100);

    return {
        leftPct,
        widthPct: Math.max(0, rightPct - leftPct),
        clippedStart: rawLeft < 0,
        clippedEnd: rawRight > 100
    };
}

/**
 * Turn time-accurate row blocks into readable presentation blocks.
 *
 * The schedule is never modified. A live block always remains individual;
 * narrow future blocks borrow consecutive future scenes only until their
 * combined span can hold a recognizable title snippet.
 */
export function presentationBlocks(blocks, shortSceneMinutes) {
    const thresholdMs = shortSceneMinutes * 60000;
    const maxGroupMs = 60 * 60000;
    const durationMs = (block) => block.program.durationMs ?? (block.program.endMs - block.program.startMs);
    const titleFor = (program) => program.scene?.title || 'Untitled scene';
    const individual = (block) => ({
        ...block,
        programs: [block.program],
        title: titleFor(block.program),
        dividerPct: []
    });
    const result = [];

    for (let index = 0; index < blocks.length;) {
        const first = blocks[index];
        if (durationMs(first) >= thresholdMs) {
            result.push(individual(first));
            index += 1;
            continue;
        }

        const group = [first];
        while (
            index + group.length < blocks.length &&
            durationMs(blocks[index + group.length]) < thresholdMs &&
            blocks[index + group.length].program.endMs - first.program.startMs <= maxGroupMs
        ) {
            const next = blocks[index + group.length];
            group.push(next);
        }

        const last = group[group.length - 1];
        const programs = group.map((block) => block.program);
        const names = programs.map(titleFor);
        result.push({
            ...first,
            programs,
            title:
                names.length <= 2
                    ? names.join(', ')
                    : `${names[0]}, ${names[1]}, and ${names.length - 2} more`,
            rect: {
                leftPct: first.rect.leftPct,
                widthPct: last.rect.leftPct + last.rect.widthPct - first.rect.leftPct,
                clippedStart: first.rect.clippedStart,
                clippedEnd: last.rect.clippedEnd
            },
            isLive: group.some((block) => block.isLive),
            isFocused: group.some((block) => block.isFocused),
            dividerPct: group.slice(1).map((block) =>
                ((block.rect.leftPct - first.rect.leftPct) /
                    (last.rect.leftPct + last.rect.widthPct - first.rect.leftPct)) * 100
            )
        });
        index += group.length;
    }

    return result;
}

/** Position of the now-line, or null when now is not on screen. */
export function nowLinePct(nowMs, windowStartMs, windowMs) {
    const pct = ((nowMs - windowStartMs) / windowMs) * 100;
    if (pct < 0 || pct >= 100) return null;
    return pct;
}

/** Clock labels along the top of the grid, aligned to `stepMs` boundaries. */
export function timeTicks(windowStartMs, windowMs, stepMs, use12Hour = false) {
    const ticks = [];
    const first = Math.ceil(windowStartMs / stepMs) * stepMs;
    for (let t = first; t < windowStartMs + windowMs; t += stepMs) {
        ticks.push({
            ms: t,
            leftPct: ((t - windowStartMs) / windowMs) * 100,
            label: formatClock(t, use12Hour)
        });
    }
    return ticks;
}


/**
 * Keep panning inside a sane range.
 *
 * Scrolling far into the past is pointless (it is all reruns of the same day)
 * and far into the future stops being a forecast anyone acts on.
 */
export function clampWindowStart(targetMs, dayStartMs, maxAheadMs) {
    return clamp(targetMs, dayStartMs, dayStartMs + maxAheadMs);
}
