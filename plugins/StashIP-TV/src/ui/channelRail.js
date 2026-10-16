/**
 * The A-Z rail beside the channel column.
 *
 * Scoped to one group at a time -- whichever group the scroll position is
 * currently inside. The guide is always grouped, so a single global rail would
 * offer letters that throw you out of the section you are reading; a rail that
 * belongs to the group under it jumps within that section.
 */

import { el, replaceChildren } from './dom.js';
import { PINNED_GROUP } from '../domain/channelPrefs.js';
import * as sel from '../state/selectors.js';

export function createChannelRail({ store, onJump }) {
    const root = el('div', {
        class: 'tvguide-rail',
        role: 'toolbar',
        'aria-label': 'Jump to channels by letter',
        'aria-orientation': 'vertical'
    });

    let rendered = '';

    return {
        element: root,

        render(state, groupKey) {
            const letters = groupKey && groupKey !== PINNED_GROUP ? sel.groupLetters(state, groupKey) : [];
            const signature = `${groupKey || ''}|${letters.join('')}`;
            if (signature === rendered) return;
            rendered = signature;

            replaceChildren(
                root,
                letters.map((letter) =>
                    el(
                        'button',
                        {
                            class: 'tvguide-rail-letter',
                            type: 'button',
                            'aria-label': `Jump to ${letter === '#' ? 'other' : letter}`,
                            onclick: () => jump(groupKey, letter)
                        },
                        letter
                    )
                )
            );
        }
    };

    function jump(groupKey, letter) {
        const channelId = sel.firstChannelForLetterInGroup(store.getState(), groupKey, letter);
        if (channelId && onJump) onJump(channelId);
    }
}
