const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function build() {
    const ctx = await esbuild.context({
        entryPoints: ['src/extension.ts'], // your desktop entry
        bundle: true,
        platform: 'node',                  // DESKTOP NODE
        target: 'node18',                  // matches VS Code runtime
        outfile: 'dist/extension.js',      // must match package.json "main"
        format: 'cjs',                     // CommonJS for VS Code
        minify: production,
        sourcemap: !production,
        external: ['vscode'],              // never bundle vscode module
        logLevel: 'info',
    });

    if (watch) {
        console.log('[watch] watching for changes...');
        await ctx.watch();
    } else {
        await ctx.rebuild();
        await ctx.dispose();
        console.log('✅ Build finished');
    }
}

build().catch((err) => {
    console.error(err);
    process.exit(1);
});
