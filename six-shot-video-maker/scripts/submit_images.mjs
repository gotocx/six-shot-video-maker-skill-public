#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import process from 'process';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.join(SCRIPT_DIR, 'image_workflow');
const ASSET_SCRIPT = path.join(SCRIPT_DIR, 'asset_state.mjs');

function parseArgs(argv) {
  const opts = { force: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
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

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeImageMode(value) {
  const mode = normalizeText(value).toLowerCase();
  return mode === 'browser' ? 'gpt' : mode || 'gpt';
}

function firstExisting(candidates) {
  return candidates.find(item => item && fs.existsSync(item)) || '';
}

function resolveBrowser(explicit) {
  const browser = firstExisting([
    explicit,
    process.env.SIX_SHOT_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ]);
  if (!browser) throw new Error('browser not found; pass --browser or set SIX_SHOT_BROWSER');
  return browser;
}

function resolveProfile(explicit) {
  const profile = firstExisting([
    explicit,
    process.env.SIX_SHOT_PROFILE,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/User Data') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft/Edge/User Data') : '',
    'C:/Users/81921/AppData/Local/Google/Chrome/User Data',
  ]);
  if (!profile) throw new Error('browser profile not found; pass --profile or set SIX_SHOT_PROFILE');
  return profile;
}

function runChecked(args, options = {}) {
  const result = spawnSync(args[0], args.slice(1), { stdio: options.stdio || 'inherit', encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${args[0]} exited with ${result.status}`);
  }
  return result;
}

function validateStage(runDir, stage) {
  runChecked([process.execPath, ASSET_SCRIPT, 'validate', '--run', runDir, '--stage', stage]);
}

function buildTask(storyboard, scene, index) {
  const id = normalizeText(scene.id) || `scene${String(index + 1).padStart(2, '0')}`;
  const style = normalizeText(storyboard.style);
  const title = normalizeText(scene.title);
  const prompt = normalizeText(scene.imagePrompt);
  return {
    id,
    prompt: `${prompt}。横版16:9，主体完整，画面无文字、无水印。`,
    styleHints: [style, title].filter(Boolean),
    backgroundHints: [],
    sizeRequirement: '横版16:9，主体完整，关键元素不要贴边，无文字、无水印，适合后续转视频。',
    outputWidth: 1536,
    outputHeight: 864,
  };
}

function listImages(root) {
  const found = [];
  if (!fs.existsSync(root)) return found;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...listImages(full));
    else if (/\.(png|jpg|jpeg|webp)$/i.test(entry.name)) found.push(full);
  }
  return found;
}

function canonicalImage(runDir, id) {
  for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
    const file = path.join(runDir, 'images', `${id}.${ext}`);
    if (fs.existsSync(file)) return file;
  }
  return '';
}

function normalizeOutputs(runDir, scenes, force) {
  const imagesDir = path.join(runDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });
  const files = listImages(imagesDir).sort();
  const copied = [];
  for (const scene of scenes) {
    const id = normalizeText(scene.id);
    if (!id) continue;
    if (!force && canonicalImage(runDir, id)) continue;
    const pattern = new RegExp(`^${id}(?:[-_].*)?\\.(png|jpg|jpeg|webp)$`, 'i');
    const match = files.find(file => pattern.test(path.basename(file)));
    if (!match) continue;
    const ext = path.extname(match).toLowerCase() || '.png';
    const target = path.join(imagesDir, `${id}${ext}`);
    if (path.resolve(match) !== path.resolve(target)) {
      fs.copyFileSync(match, target);
      copied.push({ id, from: match, to: target });
    }
  }
  return copied;
}

function powershellExe() {
  return process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
}

function runWorker(workerPath, args, dryRun, runDir) {
  const command = [
    powershellExe(),
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    workerPath,
    ...args,
  ];
  console.log(`[images] command: ${command.map(part => JSON.stringify(part)).join(' ')}`);
  if (!dryRun) {
    const result = spawnSync(command[0], command.slice(1), {
      stdio: 'inherit',
      encoding: 'utf8',
      env: { ...process.env, AUTO_IMAGE_PROJECT_ROOT: runDir },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command[0]} exited with ${result.status}`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.run) throw new Error('missing --run');
  const runDir = path.resolve(opts.run);
  const storyboardFile = path.join(runDir, 'storyboard.json');
  if (!fs.existsSync(storyboardFile)) throw new Error(`missing storyboard: ${storyboardFile}`);
  validateStage(runDir, 'storyboard');

  const storyboard = readJson(storyboardFile);
  const imageMode = normalizeImageMode(opts.mode || opts['image-mode'] || storyboard.imageMode);
  const tasks = (storyboard.scenes || []).map((scene, index) => buildTask(storyboard, scene, index));
  if (tasks.length === 0) throw new Error('storyboard has no scenes');

  const browser = resolveBrowser(opts.browser);
  const profile = resolveProfile(opts.profile);
  const checksDir = path.join(runDir, 'checks');
  const imagesDir = path.join(runDir, 'images');
  const logDir = path.join(runDir, 'logs', imageMode);
  fs.mkdirSync(checksDir, { recursive: true });
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  if (imageMode === 'gpt') {
    const queueFile = path.join(checksDir, 'gpt-image-queue.json');
    writeJson(queueFile, tasks);
    runWorker(path.join(WORKFLOW_DIR, 'run-browser-worker.ps1'), [
      '-ProfileDir', profile,
      '-Browser', browser,
      '-QueueFile', queueFile,
      '-OutDir', imagesDir,
      '-LogDir', logDir,
      ...(opts.force ? ['-Force'] : []),
      ...(opts['allow-network-fallback'] ? ['-AllowNetworkFallback'] : []),
    ], opts.dryRun, runDir);
  } else if (imageMode === 'jimeng') {
    const manifestFile = path.join(checksDir, 'jimeng-image-manifest.json');
    const poolFile = path.join(checksDir, 'jimeng-workspace-pool.json');
    writeJson(manifestFile, tasks);
    runWorker(path.join(WORKFLOW_DIR, 'run-jimeng-worker.ps1'), [
      '-ProfileDir', profile,
      '-Browser', browser,
      '-Manifest', manifestFile,
      '-WorkspacePoolFile', poolFile,
      '-OutDir', imagesDir,
      '-LogDir', logDir,
      '-Concurrency', '1',
      ...(opts.workspace ? ['-ConversationId', opts.workspace] : []),
      ...(opts['workspace-url'] ? ['-ConversationUrl', opts['workspace-url']] : []),
      ...(opts['no-stop-browser'] ? ['-NoStopBrowser'] : []),
    ], opts.dryRun, runDir);
  } else {
    throw new Error(`unsupported image mode: ${imageMode}`);
  }

  if (!opts.dryRun) {
    const copied = normalizeOutputs(runDir, storyboard.scenes || [], opts.force);
    if (copied.length) console.log(`[images] normalized ${copied.length} output file(s)`);
    validateStage(runDir, 'images');
  }
}

try {
  main();
} catch (error) {
  console.error(`[images] ERROR: ${error.message}`);
  process.exit(1);
}
