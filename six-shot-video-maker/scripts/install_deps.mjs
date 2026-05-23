#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import process from 'process';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const opts = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg.startsWith('--')) {
      opts[arg.slice(2)] = next || '';
      index += 1;
    }
  }
  return opts;
}

function defaultRuntimeDir() {
  return path.resolve(SCRIPT_DIR, '..', '..', '.six-shot-runtime');
}

function copyFile(name, targetDir) {
  fs.copyFileSync(path.join(SCRIPT_DIR, name), path.join(targetDir, name));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const runtimeDir = path.resolve(opts.runtime || process.env.SIX_SHOT_RUNTIME || defaultRuntimeDir());
  fs.mkdirSync(runtimeDir, { recursive: true });
  copyFile('package.json', runtimeDir);
  copyFile('package-lock.json', runtimeDir);

  const npmArgs = ['ci', '--prefix', runtimeDir, '--no-audit', '--no-fund', '--ignore-scripts'];
  const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd', ...npmArgs] : npmArgs;
  const result = spawnSync(command, args, {
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ci exited with ${result.status}`);
  console.log(`[deps] runtime: ${runtimeDir}`);
  console.log(`[deps] set SIX_SHOT_RUNTIME=${runtimeDir} only when using a non-default runtime path`);
}

try {
  main();
} catch (error) {
  console.error(`[deps] ERROR: ${error.message}`);
  process.exit(1);
}
