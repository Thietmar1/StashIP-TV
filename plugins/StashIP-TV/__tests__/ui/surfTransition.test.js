import { createSurfTransition } from '../../src/ui/surfTransition.js';

function setup({ reduced = false } = {}) {
    const stage = document.createElement('div');
    const video = document.createElement('video');
    stage.append(video);
    const transition = createSurfTransition(stage, video);
    const frame = stage.querySelector('canvas');
    const animations = [];
    const animate = jest.fn(() => {
        let finish;
        const animation = { cancel: jest.fn(), finished: new Promise((resolve) => { finish = resolve; }), finish: () => finish() };
        animations.push(animation);
        return animation;
    });
    frame.animate = video.animate = animate;
    window.matchMedia = jest.fn(() => ({ matches: reduced }));
    return { stage, video, frame, transition, animations, animate };
}

afterEach(() => { delete window.matchMedia; });

it.each([1, -1])('slides the old and new pictures in direction %s, then releases the frame', async (direction) => {
    const { frame, transition, animations, animate } = setup();
    transition.play(direction);
    expect(frame.hidden).toBe(false);
    expect(animate.mock.calls[0][0][1].transform).toBe(`translateY(${-direction * 100}%)`);
    expect(animate.mock.calls[1][0][0].transform).toBe(`translateY(${direction * 100}%)`);
    animations.forEach((animation) => animation.finish());
    await Promise.all(animations.map((animation) => animation.finished));
    expect(frame.hidden).toBe(true);
    expect(frame.width).toBe(0);
});

it('captures the outgoing decoded frame before tuning, at a bounded size', () => {
    const { frame, video, transition } = setup();
    Object.defineProperties(video, { readyState: { value: 2 }, videoWidth: { value: 2560 }, videoHeight: { value: 1440 } });
    const drawImage = jest.fn();
    frame.getContext = () => ({ drawImage });
    transition.play(1);
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1280, 720);
    transition.cancel();
});

it('does not let the previous animation completion cancel a newer swipe', async () => {
    const { transition, animations, frame } = setup();
    transition.play(1);
    const old = animations.slice();
    transition.play(-1);
    expect(old.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true);
    old.forEach((animation) => animation.finish());
    await Promise.all(old.map((animation) => animation.finished));
    expect(frame.hidden).toBe(false);
    transition.cancel();
    expect(frame.hidden).toBe(true);
    expect(animations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true);
});

it('skips motion when requested or when animation is unavailable', () => {
    const { transition, animate, frame } = setup({ reduced: true });
    transition.play(1);
    expect(animate).not.toHaveBeenCalled();
    expect(frame.hidden).toBe(true);
    const unavailable = setup();
    unavailable.video.animate = undefined;
    unavailable.transition.play(1);
    expect(unavailable.animate).not.toHaveBeenCalled();
});

it('recovers if the browser rejects an animation', () => {
    const { transition, animate, frame } = setup();
    animate.mockImplementation(() => { throw new Error('unavailable'); });
    expect(() => transition.play(1)).not.toThrow();
    expect(frame.hidden).toBe(true);
});
