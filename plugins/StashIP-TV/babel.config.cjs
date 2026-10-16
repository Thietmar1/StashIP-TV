// Used only by babel-jest. The browser bundle is built by esbuild and never
// passes through babel.
module.exports = {
    presets: [['@babel/preset-env', { targets: { node: 'current' } }]]
};
