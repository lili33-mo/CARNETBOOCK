// Compile l'interface (React + moteur d'écriture) vers public/app.js et public/app.css
import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const options = {
  entryPoints: ['client/src/main.jsx'],
  bundle: true,
  outfile: 'public/app.js',
  format: 'esm',
  target: ['es2020', 'safari15'],
  minify: !watch,
  sourcemap: watch,
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  logLevel: 'info',
};
if (watch) { const ctx = await esbuild.context(options); await ctx.watch(); }
else await esbuild.build(options);
