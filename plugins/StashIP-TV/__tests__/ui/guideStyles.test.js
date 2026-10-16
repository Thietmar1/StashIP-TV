import { readFileSync } from 'node:fs';

const styles = readFileSync('src/styles/index.css', 'utf8');

it('gives theater mode a definite guide height so grid and list scrolling stay bounded', () => {
    expect(styles).toMatch(/\.tvguide-overlay\.is-theater \.tvguide-stage\s*\{[^}]*height:\s*70dvh;[^}]*min-height:\s*0;/s);
});

describe('short-scene dividers', () => {
    it('stay inside the rounded programme card', () => {
        expect(styles).toMatch(/\.tvguide-block-divider\s*\{[^}]*top:\s*4px;[^}]*bottom:\s*4px;/s);
    });
});

describe('Recent panel', () => {
    it('keeps long channel histories inside a scrollable viewport', () => {
        expect(styles).toMatch(
            /\.tvguide-recent-panel\s*\{[^}]*max-height:\s*50dvh;[^}]*overflow-y:\s*auto;/s
        );
    });
});
