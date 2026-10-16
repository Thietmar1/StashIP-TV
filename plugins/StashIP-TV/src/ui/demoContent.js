// Deterministic, local sample content. Never send library metadata to a text or
// image service. The source only seeds a choice among these fictional words.
function seed(text) {
    let hash = 2166136261;
    for (const char of text.trim().replace(/\s+/g, ' ')) hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
    return hash >>> 0;
}

const WORDS = {
    Channel: [
        ['Juniper', 'Horizon', 'Lantern', 'Summit', 'Orchard', 'Harbor', 'Cedar', 'Daybreak'],
        ['TV', 'Network', 'Channel', 'Broadcast']
    ],
    Program: [
        ['The Hidden', 'Beyond the', 'Return to', 'A Tale of', 'Along the', 'Under the', 'Echoes of', 'The Last'],
        ['Coast', 'Garden', 'Valley', 'River', 'Horizon', 'Orchard', 'Mountains', 'Lighthouse', 'Summer', 'Skyline', 'Meadow', 'Island']
    ],
    Person: [
        ['Alex', 'Morgan', 'Jamie', 'Taylor', 'Casey', 'Riley', 'Jordan', 'Sam'],
        ['Reed', 'Ellis', 'Brooks', 'Hayes', 'Parker', 'Lane', 'Quinn', 'Rowan']
    ],
    Studio: [
        ['Maple', 'Northstar', 'Paper Moon', 'Bluebird', 'Silver Birch', 'Wildflower',
            'Copper Finch', 'Clearwater', 'Golden Hour', 'Moonstone', 'Redwood', 'Sunfield',
            'Cloud Nine', 'Evergreen', 'Lantern House', 'Driftwood'],
        ['Pictures', 'Studios', 'Productions', 'Films']
    ],
    Tag: [['Adventure', 'Drama', 'Travel', 'Discovery', 'Classics', 'Documentary', 'Family', 'Mystery']]
};

export function demoName(kind, text) {
    if (!text.trim()) return text;
    let index = seed(text);
    return WORDS[kind].map((words) => {
        const word = words[index % words.length];
        index = Math.floor(index / words.length);
        return word;
    }).join(' ');
}

export function demoDescription(text) {
    if (!text.trim()) return text;
    const openings = [
        'An unexpected discovery brings a quiet town together for an unforgettable season.',
        'A familiar journey takes a surprising turn, revealing stories hidden in plain sight.',
        'Old friends reunite to follow a trail of clues through a changing landscape.',
        'A curious newcomer finds friendship and a fresh perspective far from home.'
    ];
    const middles = [
        'Along the way, small moments become the beginning of something extraordinary.',
        'Each new encounter offers another piece of a much larger story.',
        'Beautiful scenery and unexpected detours make every stop worth remembering.'
    ];
    const endings = [
        'A warm story about finding connection in unexpected places.',
        'The adventure continues with new possibilities just around the corner.',
        'An inviting escape filled with memorable characters and a sense of discovery.'
    ];
    let index = seed(text);
    return [openings, middles, endings].slice(0, Math.max(1, Math.min(3, Math.ceil(text.length / 110))))
        .map((sentences) => {
            const sentence = sentences[index % sentences.length];
            index = Math.floor(index / sentences.length);
            return sentence;
        }).join(' ');
}

export function demoArtwork(source, poster = false) {
    const hue = seed(source) % 360;
    const width = poster ? 640 : 160;
    const height = poster ? 360 : 160;
    const svg = `<svg data-tvguide-demo="true" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="100%" height="100%" fill="hsl(${hue},35%,18%)"/>
      <circle cx="${width * .78}" cy="${height * .26}" r="${height * .5}" fill="hsl(${hue},45%,35%)"/>
      <path d="M0 ${height} L${width * .45} ${height * .3} L${width} ${height}Z" fill="hsl(${(hue + 40) % 360},45%,55%)"/>
      <text x="${width / 2}" y="${height * .76}" text-anchor="middle" fill="white" font-family="sans-serif" font-size="${poster ? 32 : 28}" font-weight="bold">${poster ? 'DEMO' : 'TV'}</text>
    </svg>`;
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

/** A studio identity uses its name, not its image URL, so every view agrees. */
export function demoStudioWordmark(studioName) {
    const name = demoName('Studio', studioName);
    const split = name.lastIndexOf(' ');
    const brand = name.slice(0, split);
    const descriptor = name.slice(split + 1).toUpperCase();
    const index = seed(studioName);
    const palettes = [
        ['#142b38', '#faf1dc', '#78c9c0'],
        ['#302332', '#ffe9de', '#e7ad88'],
        ['#202c24', '#f2f0d5', '#b8cc87'],
        ['#292640', '#f4efff', '#b9abe9']
    ];
    const [background, ink, accent] = palettes[index % palettes.length];
    const serif = (index >>> 3) % 2 === 0;
    const font = serif ? 'Georgia,serif' : 'Arial,sans-serif';
    const brandSize = Math.min(68, Math.floor(520 / (brand.length * .64)));
    // All strings embedded here come from the fixed fictional vocabulary.
    const svg = `<svg data-tvguide-demo="true" xmlns="http://www.w3.org/2000/svg" width="640" height="200" viewBox="0 0 640 200">
      <title>${name}</title>
      <rect width="640" height="200" rx="12" fill="${background}"/>
      <path d="M32 64V32H80 M560 168H608V136" fill="none" stroke="${accent}" stroke-width="4"/>
      <text x="320" y="104" text-anchor="middle" fill="${ink}" font-family="${font}" font-size="${brandSize}" font-weight="${serif ? 400 : 700}" letter-spacing="${serif ? 1 : -1}">${brand}</text>
      <path d="M250 125H390" stroke="${accent}" stroke-width="2"/>
      <text x="320" y="157" text-anchor="middle" fill="${accent}" font-family="Arial,sans-serif" font-size="22" letter-spacing="6">${descriptor}</text>
    </svg>`;
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

/** Force mute before tune/play, not just after an asynchronous volume event. */
export function withDemoPlayback(viewer, getState) {
    const mutedFor = (muted) => Boolean(getState().settings.guide_sfw_text || muted);
    return {
        ...viewer,
        tune(scene, offsetMs, muted) { return viewer.tune(scene, offsetMs, mutedFor(muted)); },
        setMuted(muted) { return viewer.setMuted(mutedFor(muted)); }
    };
}
