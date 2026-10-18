import { build } from 'esbuild';
await build({ entryPoints: ['server/admin/app.ts'], outfile: 'server/internal/syncstore/admin/app.js', bundle: true, minify: true, target: 'es2022', platform: 'browser' });
