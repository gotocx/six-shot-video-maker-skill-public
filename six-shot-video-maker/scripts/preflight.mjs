#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.join(SCRIPT_DIR, 'image_workflow');

function parseArgs(argv) {
  const opts = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--json') {
      opts.json = true;
    } else if (arg.startsWith('--')) {
      opts[arg.slice(2)] = next || '';
      index += 1;
    }
  }
  return opts;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function exists(file) {
  return Boolean(file && fs.existsSync(file));
}

function firstExisting(candidates) {
  return candidates.find(item => item && fs.existsSync(item)) || '';
}

function defaultBrowser() {
  return firstExisting([
    process.env.SIX_SHOT_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ]);
}

function defaultProfile() {
  return firstExisting([
    process.env.SIX_SHOT_PROFILE,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/User Data') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft/Edge/User Data') : '',
    'C:/Users/81921/AppData/Local/Google/Chrome/User Data',
  ]);
}

function normalizeImageMode(value) {
  const mode = String(value || 'gpt').trim().toLowerCase();
  return mode === 'browser' ? 'gpt' : mode || 'gpt';
}

function loadRunMode(runDir, explicitMode) {
  if (explicitMode) return normalizeImageMode(explicitMode);
  if (!runDir) return 'gpt';
  const storyboardFile = path.join(path.resolve(runDir), 'storyboard.json');
  if (!fs.existsSync(storyboardFile)) return 'gpt';
  return normalizeImageMode(readJson(storyboardFile).imageMode);
}

function item(name, file, required = true) {
  return { name, path: file || '', ok: exists(file), required };
}

function buildReport(opts) {
  const runDir = opts.run ? path.resolve(opts.run) : '';
  const imageMode = loadRunMode(runDir, opts.mode || opts['image-mode']);
  const browser = opts.browser || defaultBrowser();
  const profile = opts.profile || defaultProfile();
  const dependencies = path.join(SCRIPT_DIR, 'node_modules', 'puppeteer-core', 'package.json');
  const checks = [
    item('runtime package', path.join(SCRIPT_DIR, 'package.json')),
    item('runtime dependency', dependencies),
    item('browser', browser),
    item('browser profile', profile),
    item('state script', path.join(SCRIPT_DIR, 'asset_state.mjs')),
    item('image submit script', path.join(SCRIPT_DIR, 'submit_images.mjs')),
    item('video submit script', path.join(SCRIPT_DIR, 'submit_video.mjs')),
    item('bundled video worker', path.join(SCRIPT_DIR, 'video_submit.mjs')),
    item('browser image worker', path.join(WORKFLOW_DIR, 'run-browser-worker.ps1'), imageMode === 'gpt'),
    item('browser provider script', path.join(WORKFLOW_DIR, 'providers', 'browser', 'scripts', 'browserConversationGenerate.mjs'), imageMode === 'gpt'),
    item('jimeng image worker', path.join(WORKFLOW_DIR, 'run-jimeng-worker.ps1'), imageMode === 'jimeng'),
    item('jimeng provider script', path.join(WORKFLOW_DIR, 'providers', 'jimeng', 'scripts', 'jimengBatchGenerate.mjs'), imageMode === 'jimeng'),
  ];
  if (runDir) {
    checks.unshift(item('run directory', runDir));
  }
  const missing = checks.filter(check => check.required && !check.ok);
  return {
    ok: missing.length === 0,
    imageMode,
    runDir,
    installHint: exists(dependencies) ? '' : `npm install --prefix "${SCRIPT_DIR}"`,
    checks,
    missing: missing.map(check => check.name),
  };
}

const opts = parseArgs(process.argv.slice(2));
const report = buildReport(opts);
if (opts.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`[preflight] image mode: ${report.imageMode}`);
  for (const check of report.checks) {
    const status = check.ok ? 'OK' : (check.required ? 'MISSING' : 'optional');
    console.log(`[preflight] ${status}: ${check.name}${check.path ? ` -> ${check.path}` : ''}`);
  }
  if (report.installHint) console.log(`[preflight] install dependencies: ${report.installHint}`);
}
process.exit(report.ok ? 0 : 1);
