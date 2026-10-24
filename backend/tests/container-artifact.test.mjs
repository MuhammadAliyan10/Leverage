import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [dockerfile, dockerignore, packageJson, tsconfig] = await Promise.all([
  readFile(resolve(backend, 'Dockerfile'), 'utf8'),
  readFile(resolve(backend, '.dockerignore'), 'utf8'),
  readFile(resolve(backend, 'package.json'), 'utf8').then(JSON.parse),
  readFile(resolve(backend, 'tsconfig.json'), 'utf8').then(JSON.parse),
]);

test('backend container excludes secrets and runs the compiled API as a non-root user', () => {
  assert.match(dockerignore, /^\.env$/m);
  assert.match(dockerignore, /^\.env\.\*$/m);
  assert.match(dockerignore, /^node_modules$/m);
  assert.match(dockerfile, /FROM node:22-alpine AS build/);
  assert.match(dockerfile, /FROM node:22-alpine AS runtime/);
  assert.match(dockerfile, /npm run prisma:generate && npm run build && npm prune --omit=dev/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /dist\/src\/index\.js/);
  assert.match(dockerfile, /health\/ready/);
  assert.doesNotMatch(dockerfile, /COPY\s+\.env/);
  assert.equal(packageJson.scripts['start:production'], 'node dist/src/index.js');
  assert.equal(tsconfig.compilerOptions.rootDir, '.');
});
