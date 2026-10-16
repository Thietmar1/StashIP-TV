import { readFileSync } from 'node:fs';

const styles = readFileSync('src/styles/index.css', 'utf8');

describe('fullscreen player styling', () => {
    it('does not retain theater height caps in fullscreen', () => {
        expect(styles).toMatch(
            /\.tvguide-player-stage:fullscreen[\s\S]*?max-height:\s*none/
        );
        expect(styles).toMatch(
            /\.tvguide-player-stage:fullscreen \.tvguide-viewer-video[\s\S]*?max-height:\s*none/
        );
    });
});
