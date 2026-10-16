import { readFileSync } from 'node:fs';

const styles = readFileSync('src/styles/index.css', 'utf8');

describe('manager availability styling', () => {
    it('keeps Add controls fully visible for channels outside the guide', () => {
        expect(styles).toContain(
            '.tvguide-manager-row:not(.is-included) .tvguide-manager-row-text { opacity: 0.5; }'
        );
        expect(styles).not.toContain(
            '.tvguide-manager-row:not(.is-included) .tvguide-manager-row-main { opacity: 0.5; }'
        );
    });
});
