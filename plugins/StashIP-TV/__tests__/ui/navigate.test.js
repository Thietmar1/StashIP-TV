import { navigateToScene } from '../../src/ui/navigate.js';

describe('navigateToScene', () => {
    const location = () => ({ assign: jest.fn() });

    it('opens the scene at its live offset', () => {
        const loc = location();
        navigateToScene('42', 725, loc);
        expect(loc.assign).toHaveBeenCalledWith('/scenes/42?t=725');
    });

    it('floors fractional seconds', () => {
        const loc = location();
        navigateToScene('42', 12.9, loc);
        expect(loc.assign).toHaveBeenCalledWith('/scenes/42?t=12');
    });

    it('never sends a negative offset', () => {
        const loc = location();
        navigateToScene('42', -5, loc);
        expect(loc.assign).toHaveBeenCalledWith('/scenes/42?t=0');
    });
});
