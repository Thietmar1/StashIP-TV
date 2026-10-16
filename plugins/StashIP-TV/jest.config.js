module.exports = {
    testEnvironment: 'jsdom',
    testMatch: ['<rootDir>/__tests__/**/*.test.js'],
    collectCoverageFrom: [
        'src/**/*.js',
        // Composition root: pure wiring, exercised end-to-end by the ui tests
        // rather than asserted directly.
        '!src/index.js'
    ],
    // CSS reaches the browser bundle through esbuild, never through jest.
    moduleNameMapper: { '\\.css$': '<rootDir>/__mocks__/styleMock.js' },
    coverageThreshold: {
        // The real logic lives here, and it is all pure -- hold it above the
        // repo-wide bar.
        './src/domain/': { statements: 100, lines: 100, functions: 100, branches: 90 },
        './src/state/': { statements: 100, lines: 100, functions: 100, branches: 90 },
        // I/O and DOM shells. Driving these to 100% in jsdom buys assertions
        // about DOM trivia rather than behaviour.
        './src/api/': { statements: 80, lines: 80, functions: 80, branches: 70 },
        './src/ui/': { statements: 80, lines: 80, functions: 80, branches: 70 }
    }
};
