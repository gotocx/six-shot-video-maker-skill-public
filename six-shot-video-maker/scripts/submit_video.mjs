#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import process from 'process';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSET_SCRIPT = path.join(SCRIPT_DIR, 'asset_state.mjs');
const VIDEO_WORKER = path.join(SCRIPT_DIR, 'video_submit.mjs');

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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function normalizeMode(value) {
  const mode = String(value || 'full').trim().toLowerCase();
  return mode === 'quick' ? 'quick' : 'full';
}

function runChecked(args, options = {}) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: options.cwd || process.cwd(),
    stdio: options.stdio || 'pipe',
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (options.logFile) {
    fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
    fs.writeFileSync(options.logFile, `${result.stdout || ''}${result.stderr || ''}`, 'utf8');
  } else {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.status !== 0) throw new Error(`${args[0]} exited with ${result.status}`);
  return result;
}

function validateStage(runDir, stage) {
  runChecked([process.execPath, ASSET_SCRIPT, 'validate', '--run', runDir, '--stage', stage], { stdio: 'inherit' });
}

function findImage(runDir, scene) {
  const candidates = [];
  if (scene.imagePath) candidates.push(path.resolve(runDir, scene.imagePath));
  const id = scene.id || 'scene';
  for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
    candidates.push(path.join(runDir, 'images', `${id}.${ext}`));
  }
  const hit = candidates.find(file => fs.existsSync(file));
  if (!hit) throw new Error(`missing image for ${id}`);
  return hit;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.run) throw new Error('missing --run');
  const runDir = path.resolve(opts.run);
  validateStage(runDir, 'ready');

  const storyboard = readJson(path.join(runDir, 'storyboard.json'));
  const workflowMode = normalizeMode(storyboard.workflowMode);
  const duration = opts.duration || (workflowMode === 'quick' ? '4' : '15');
  const model = opts.model || (workflowMode === 'quick' ? 'Seedance 2.0 Fast VIP' : 'Seedance 2.0 VIP');
  const promptFile = path.join(runDir, 'video_prompt.txt');
  if (!fs.existsSync(promptFile)) throw new Error(`missing video prompt: ${promptFile}`);
  const images = (storyboard.scenes || []).map(scene => findImage(runDir, scene));
  if (!images.length) throw new Error('no images to submit');

  const worker = opts.script ? path.resolve(opts.script) : VIDEO_WORKER;
  if (!fs.existsSync(worker)) throw new Error(`video worker not found: ${worker}`);
  const args = [process.execPath, worker];
  for (const image of images) args.push('--image', image);
  args.push('--prompt-file', promptFile, '--duration', duration, '--model', model);
  if (opts.browser) args.push('--browser', opts.browser);
  if (opts.profile) args.push('--profile', opts.profile);
  if (opts.workspace) args.push('--workspace', opts.workspace);
  if (opts['keep-open-ms']) args.push('--keep-open-ms', opts['keep-open-ms']);

  const logFile = path.join(runDir, 'logs', 'video_submit.log');
  console.log(`[video] submitting ${images.length} image(s), duration ${duration}s, model ${model}`);
  runChecked(args, { cwd: SCRIPT_DIR, logFile });
  runChecked([process.execPath, ASSET_SCRIPT, 'mark', '--run', runDir, '--stage', 'video_submit', '--status', 'submitted'], { stdio: 'inherit' });
  console.log(`[video] log: ${logFile}`);
}

try {
  main();
} catch (error) {
  console.error(`[video] ERROR: ${error.message}`);
  process.exit(1);
}
