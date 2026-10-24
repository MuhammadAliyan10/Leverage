import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const backend = join(root, 'backend');
const temporaryOutput = mkdtempSync(join(tmpdir(), 'mizan-source-check-'));
const localValidationUrl = 'postgresql://localhost:5432/schema_validation';

const steps = [
  { name: 'App TypeScript', cwd: root, command: 'npm', args: ['run', 'typecheck'] },
  { name: 'App lint', cwd: root, command: 'npm', args: ['run', 'lint'] },
  { name: 'App tests', cwd: root, command: 'npm', args: ['test'] },
  { name: 'Backend TypeScript', cwd: backend, command: 'npm', args: ['run', 'typecheck'] },
  { name: 'Backend production runtime compile', cwd: backend, command: 'npm', args: ['run', 'build'] },
  { name: 'Backend production entrypoint syntax', cwd: backend, command: 'node', args: ['--check', 'dist/src/index.js'] },
  {
    name: 'Backend Prisma schema validation (localhost URL; no connection made)',
    cwd: backend,
    command: 'npm',
    args: ['run', 'prisma:validate'],
    env: { DATABASE_URL: localValidationUrl, DATABASE_URL_UNPOOLED: localValidationUrl },
  },
  { name: 'Backend integration tests (disposable local PGlite)', cwd: backend, command: 'npm', args: ['test'] },
  {
    name: 'Android JavaScript bundle (disposable app identity; no native build)',
    cwd: root,
    command: 'npm',
    args: ['exec', '--', 'expo', 'export', '--platform', 'android', '--output-dir', temporaryOutput],
    env: { HOUSELOG_ANDROID_VARIANT: 'disposable', EAS_BUILD_PROFILE: 'preview' },
  },
];

let failed = false;
try {
  for (const step of steps) {
    process.stdout.write(`\n=== ${step.name} ===\n`);
    const result = spawnSync(step.command, step.args, {
      cwd: step.cwd,
      env: { ...process.env, ...step.env },
      stdio: 'inherit',
    });
    if (result.error) {
      process.stderr.write(`${step.name} could not start: ${result.error.message}\n`);
      failed = true;
      break;
    }
    if (result.status !== 0) {
      process.stderr.write(`${step.name} failed with exit status ${result.status ?? 'unknown'}.\n`);
      failed = true;
      break;
    }
    process.stdout.write(`PASS: ${step.name}\n`);
  }
} finally {
  rmSync(temporaryOutput, { recursive: true, force: true });
}

if (failed) process.exitCode = 1;
else process.stdout.write('\nSource checks passed. This does not verify native Android behavior, cloud deployment, or production release readiness.\n');
