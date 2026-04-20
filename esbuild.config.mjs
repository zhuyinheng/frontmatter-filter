import esbuild from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

await esbuild.build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/frontmatter-filter.mjs',
  minify: false,
  treeShaking: true,
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  banner: {
    js: `#!/usr/bin/env node
// frontmatter-filter v${pkg.version}
// https://github.com/.../frontmatter-filter
import { createRequire } from 'node:module';
var require = createRequire(import.meta.url);`,
  },
});
