import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { buildUnifiedPrompt, normalizeUnifiedTask } from '../../shared/unifiedTask.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const requireFromHere = createRequire(import.meta.url);
const puppeteer = await loadPuppeteerCore();
const DEFAULT_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_RESULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_STABLE_WAIT_MS = 12000;
const DEFAULT_POLL_MS = 4000;
const DEFAULT_MIN_IMAGE_BYTES = 20 * 1024;
const TARGET_SITE_HOST = String(process.env.IMAGE_SITE_HOST || ['chat', 'g', 'pt.com'].join(''))
  .trim()
  .replace(/^https?:\/\//i, '')
  .replace(/\/.*$/g, '');
const TARGET_SITE_ORIGIN = `https://${TARGET_SITE_HOST}`;
const DEFAULT_WORK_ROOT = resolveProjectRoot(SCRIPT_DIR, '.auto-image-workflow-data');
const DEFAULT_OUT_DIR = path.join(DEFAULT_WORK_ROOT, 'output', 'browser');
const DEFAULT_LOG_DIR = path.join(DEFAULT_WORK_ROOT, 'logs', 'browser');

function runtimeRoots() {
  const roots = [];
  if (process.env.SIX_SHOT_RUNTIME) roots.push(path.resolve(process.env.SIX_SHOT_RUNTIME));
  if (process.env.SIX_SHOT_NODE_MODULES) roots.push(path.dirname(path.resolve(process.env.SIX_SHOT_NODE_MODULES)));
  roots.push(path.resolve(SCRIPT_DIR, '..', '..', '..', '..', '..', '..', '.six-shot-runtime'));
  roots.push(path.resolve(SCRIPT_DIR, '..', '..', '..', '..', 'node_modules', '..'));
  return [...new Set(roots)];
}

async function loadPuppeteerCore() {
  try {
    return (await import('puppeteer-core')).default;
  } catch {}
  for (const root of runtimeRoots()) {
    try {
      const entry = requireFromHere.resolve('puppeteer-core', { paths: [root] });
      return (await import(pathToFileURL(entry).href)).default;
    } catch {}
  }
  throw new Error('Missing puppeteer-core. Run node scripts/install_deps.mjs from the skill folder.');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resolveProjectRoot(startPath, suffix = '') {
  const explicitRoot = String(process.env.AUTO_IMAGE_PROJECT_ROOT || process.env.WORKSPACE_ROOT || '').trim();
  if (explicitRoot) {
    const resolved = path.resolve(explicitRoot);
    return suffix ? path.join(resolved, suffix) : resolved;
  }

  let cursor = path.resolve(startPath);
  while (true) {
    const marker = path.join(cursor, '.trae');
    if (fs.existsSync(marker)) {
      return suffix ? path.join(cursor, suffix) : cursor;
    }
    const parent = path.dirname(cursor);
    if (!parent || parent === cursor) {
      const cwd = path.resolve(process.cwd());
      return suffix ? path.join(cwd, suffix) : cwd;
    }
    cursor = parent;
  }
}

function getPowerShellExecutable() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function getTaskListExecutable() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe');
}

function runPowerShell(command) {
  return spawnSync(
    getPowerShellExecutable(),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8' }
  );
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTextList(...values) {
  const normalized = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      normalized.push(...normalizeTextList(...value));
      continue;
    }
    const text = normalizeText(value);
    if (text) {
      normalized.push(text);
    }
  }
  return [...new Set(normalized)];
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  const normalized = normalizeText(value).toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(normalized);
}

function sanitizePathForLog(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const normalized = raw.replace(/\\/g, '/');
  const fileName = normalized.split('/').filter(Boolean).pop() || 'path';
  return `<path:${fileName}>`;
}

function sanitizeTextForLog(value) {
  let output = String(value ?? '');
  output = output.replace(/https:\/\/[^/\s]+\/c\/[A-Za-z0-9_-]+/gi, '<conversation-url>');
  output = output.replace(/[A-Za-z]:\\(?:[^\\\r\n:*?"<>|]+\\)*[^\\\r\n:*?"<>|]*/g, match => sanitizePathForLog(match));
  return output;
}

function sanitizeSummaryForLog(summary) {
  return {
    ...summary,
    referenceImagePaths: Array.isArray(summary?.referenceImagePaths)
      ? summary.referenceImagePaths.map(item => sanitizePathForLog(item))
      : [],
    images: Array.isArray(summary?.images)
      ? summary.images.map(item => ({
          ...item,
          src: sanitizeTextForLog(item?.src || ''),
          href: sanitizeTextForLog(item?.href || ''),
        }))
      : undefined,
    saved: Array.isArray(summary?.saved)
      ? summary.saved.map(item => ({
          ...item,
          path: sanitizePathForLog(item?.path || ''),
          url: sanitizeTextForLog(item?.url || ''),
        }))
      : undefined,
    skipped: Array.isArray(summary?.skipped)
      ? summary.skipped.map(item => ({
          ...item,
          url: sanitizeTextForLog(item?.url || ''),
          reason: sanitizeTextForLog(item?.reason || ''),
        }))
      : undefined,
    outputDir: summary?.outputDir ? sanitizePathForLog(summary.outputDir) : summary?.outputDir,
    error: summary?.error ? sanitizeTextForLog(summary.error) : summary?.error,
  };
}

function slugify(value) {
  const normalized = normalizeText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || `task-${Date.now()}`;
}

function makeTimestamp() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(
    now.getMinutes()
  )}${pad(now.getSeconds())}`;
}

function buildTaskOutputDir(baseOutDir, taskId) {
  const folderName = `${slugify(taskId)}-${makeTimestamp()}`;
  const taskOutDir = path.join(baseOutDir, folderName);
  ensureDir(taskOutDir);
  return taskOutDir;
}

function listFilesRecursive(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const results = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
      } else if (entry.isFile()) {
        results.push(absolutePath);
      }
    }
  }
  return results;
}

function writeTextToSystemClipboard(text) {
  const tempPath = path.join(os.tmpdir(), `browser-prompt-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  fs.writeFileSync(tempPath, String(text ?? ''), 'utf8');

  try {
    const command = `$content = Get-Content -LiteralPath '${tempPath.replace(/'/g, "''")}' -Raw -Encoding UTF8; Set-Clipboard -Value $content`;
    const result = runPowerShell(command);

    if (result.status !== 0) {
      throw new Error(result.error?.message || result.stderr || result.stdout || `Set-Clipboard exited with ${result.status}`);
    }
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function printHelp() {
  console.log(`
Usage:
  node .\\providers\\browser\\scripts\\browserConversationGenerate.mjs [options]

Options:
  --conversation-id <id>      Optional. Reuse a specific target image site conversation ID (the part after /c/)
  --conversation-url <url>    Optional alternative to --conversation-id; omitted means auto-create a fresh chat
  --prompt <text>             Single prompt string
  --provider-prompt <text>    Optional provider-specific prompt override
  --prompt-file <file>        Text file containing a single prompt
  --queue-file <file>         JSON array with unified task objects
  --reference-image <file>    Optional reference image file to attach; repeat to add multiple refs
  --style-hints <text>        Optional style hint to inject into the final prompt; repeatable
  --background-hints <text>   Optional scene/background hint to inject into the final prompt; repeatable
  --effect-hints <text>       Optional effect hint to inject into the final prompt; repeatable
  --size <text>               Optional composition size hint, e.g. square_1_1
  --size-requirement <text>   Optional size/aspect requirement to inject into the final prompt
  --cutout-policy <name>      Optional cutout prompt policy
  --output-width <n>          Optional target output width
  --output-height <n>         Optional target output height
  --subject-width-ratio <n>   Optional subject width ratio
  --subject-height-ratio <n>  Optional subject height ratio
  --out-dir <dir>             Output directory for final images
  --log-dir <dir>             Per-task JSON log directory
  --profile-dir <dir>         Required. User's real browser profile directory that is already logged into target image site
  --browser <path>            Required. User-controlled browser executable path
  --headless                  Unsupported in this workflow; use the user's visible browser instead
  --login-only                Only open browser, wait for login, then exit
  --force                     Regenerate even if output already exists
  --limit <n>                 Only process the first N queue items
  --login-timeout-ms <ms>     Wait time for manual login
  --result-timeout-ms <ms>    Max wait time per prompt for new images
  --stable-wait-ms <ms>       Require DOM image set to stay stable for this duration
  --poll-ms <ms>              DOM polling interval
  --min-image-bytes <n>       Skip downloaded images smaller than this
  --allow-network-fallback    Accept network image responses when no anchored DOM image is found
  --probe-only                Only inspect login/session state for the target conversation
  --json-out <file>           Write probe or task result JSON to a file
  --session-out <file>        Write resolved session metadata such as the final conversation URL
  --help                      Show this help
`);
}

function parseArgs(argv) {
  const options = {
    conversationId: '',
    conversationUrl: '',
    prompt: null,
    providerPrompt: '',
    promptFile: null,
    queueFile: null,
    referenceImagePaths: [],
    styleHints: [],
    backgroundHints: [],
    effectHints: [],
    size: '',
    sizeRequirement: '',
    cutoutPolicy: '',
    outputWidth: 0,
    outputHeight: 0,
    subjectWidthRatio: 0,
    subjectHeightRatio: 0,
    outDir: DEFAULT_OUT_DIR,
    logDir: DEFAULT_LOG_DIR,
    profileDir: '',
    browser: '',
    headless: false,
    loginOnly: false,
    force: false,
    limit: null,
    loginTimeoutMs: DEFAULT_LOGIN_TIMEOUT_MS,
    resultTimeoutMs: DEFAULT_RESULT_TIMEOUT_MS,
    stableWaitMs: DEFAULT_STABLE_WAIT_MS,
    pollMs: DEFAULT_POLL_MS,
    minImageBytes: DEFAULT_MIN_IMAGE_BYTES,
    allowNetworkFallback: false,
    probeOnly: false,
    jsonOut: null,
    sessionOut: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--conversation-id':
        options.conversationId = next;
        index += 1;
        break;
      case '--conversation-url':
        options.conversationUrl = next;
        index += 1;
        break;
      case '--prompt':
        options.prompt = next;
        index += 1;
        break;
      case '--provider-prompt':
        options.providerPrompt = next;
        index += 1;
        break;
      case '--prompt-file':
        options.promptFile = path.resolve(next);
        index += 1;
        break;
      case '--queue-file':
        options.queueFile = path.resolve(next);
        index += 1;
        break;
      case '--reference-image':
        options.referenceImagePaths.push(path.resolve(next));
        index += 1;
        break;
      case '--style-hints':
        options.styleHints.push(next);
        index += 1;
        break;
      case '--background-hints':
        options.backgroundHints.push(next);
        index += 1;
        break;
      case '--effect-hints':
        options.effectHints.push(next);
        index += 1;
        break;
      case '--size':
        options.size = next;
        index += 1;
        break;
      case '--size-requirement':
        options.sizeRequirement = next;
        index += 1;
        break;
      case '--cutout-policy':
        options.cutoutPolicy = next;
        index += 1;
        break;
      case '--output-width':
        options.outputWidth = Number(next);
        index += 1;
        break;
      case '--output-height':
        options.outputHeight = Number(next);
        index += 1;
        break;
      case '--subject-width-ratio':
        options.subjectWidthRatio = Number(next);
        index += 1;
        break;
      case '--subject-height-ratio':
        options.subjectHeightRatio = Number(next);
        index += 1;
        break;
      case '--out-dir':
        options.outDir = path.resolve(next);
        index += 1;
        break;
      case '--log-dir':
        options.logDir = path.resolve(next);
        index += 1;
        break;
      case '--profile-dir':
        options.profileDir = path.resolve(next);
        index += 1;
        break;
      case '--browser':
        options.browser = path.resolve(next);
        index += 1;
        break;
      case '--headless':
        options.headless = true;
        break;
      case '--login-only':
        options.loginOnly = true;
        break;
      case '--force':
        options.force = true;
        break;
      case '--limit':
        options.limit = Number(next);
        index += 1;
        break;
      case '--login-timeout-ms':
        options.loginTimeoutMs = Number(next);
        index += 1;
        break;
      case '--result-timeout-ms':
        options.resultTimeoutMs = Number(next);
        index += 1;
        break;
      case '--stable-wait-ms':
        options.stableWaitMs = Number(next);
        index += 1;
        break;
      case '--poll-ms':
        options.pollMs = Number(next);
        index += 1;
        break;
      case '--min-image-bytes':
        options.minImageBytes = Number(next);
        index += 1;
        break;
      case '--allow-network-fallback':
        options.allowNetworkFallback = true;
        break;
      case '--probe-only':
        options.probeOnly = true;
        break;
      case '--json-out':
        options.jsonOut = path.resolve(next);
        index += 1;
        break;
      case '--session-out':
        options.sessionOut = path.resolve(next);
        index += 1;
        break;
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function buildConversationUrlFromId(conversationId) {
  const normalizedId = normalizeText(conversationId);
  if (!normalizedId) {
    return '';
  }
  if (/^https?:\/\//i.test(normalizedId)) {
    throw new Error('Use --conversation-url for full URLs, or pass only the ID to --conversation-id.');
  }
  if (!/^[A-Za-z0-9_-]+(?:-[A-Za-z0-9_-]+)*$/.test(normalizedId)) {
    throw new Error(`Invalid target image site conversation ID: ${normalizedId}`);
  }
  return `${TARGET_SITE_ORIGIN}/c/${normalizedId}`;
}

function isTargetConversationUrl(value) {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname.toLowerCase() === TARGET_SITE_HOST.toLowerCase() &&
      /^\/c\/[^/\s]+$/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function resolveConversationUrl(options) {
  const conversationId = normalizeText(options.conversationId);
  const conversationUrl = normalizeText(options.conversationUrl);
  if (conversationId && conversationUrl) {
    throw new Error('Provide either --conversation-id or --conversation-url, not both.');
  }
  if (conversationId) {
    return buildConversationUrlFromId(conversationId);
  }
  return conversationUrl;
}

function assertRequiredOptions(options) {
  const conversationUrl = resolveConversationUrl(options);
  const profileDir = normalizeText(options.profileDir);
  const browser = normalizeText(options.browser);
  options.conversationUrl = conversationUrl;
  if (conversationUrl && !isTargetConversationUrl(conversationUrl)) {
    throw new Error(`Invalid target image site conversation URL: ${conversationUrl}`);
  }
  if (!browser) {
    throw new Error('Missing required argument: --browser');
  }
  if (!profileDir) {
    throw new Error('Missing required argument: --profile-dir');
  }
  if (options.probeOnly && !conversationUrl) {
    throw new Error('Missing required argument for --probe-only: --conversation-id or --conversation-url');
  }
}

function assertSupportedWorkflow(options) {
  if (options.headless) {
    throw new Error(
      'Do not use --headless. Close the user-controlled browser first, then let this tool reopen the same browser executable with the real logged-in profile.'
    );
  }
}

function assertBrowserClosed(options) {
  const browserPath = path.resolve(options.browser);
  const browserName = path.basename(browserPath, path.extname(browserPath));
  const imageName = `${browserName}.exe`;
  const result = spawnSync(
    getTaskListExecutable(),
    ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${imageName}`],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(`Failed to check whether browser is closed: ${result.error?.message || result.stderr || result.stdout}`);
  }
  const output = String(result.stdout || '').trim();
  const hasMatch =
    output &&
    !/INFO:\s+No tasks are running/i.test(output) &&
    new RegExp(`^"${escapeRegExp(imageName)}"`, 'im').test(output);
  if (hasMatch) {
    throw new Error(
      `Detected running browser process for "${browserName}". Please close the user's browser completely before running this tool.`
    );
  }
}

function printWorkflowReminder(options) {
  console.log('[browser] workflow: require the user to provide their logged-in browser and their real browser profile first');
  console.log('[browser] workflow: make sure that browser is fully closed before launching automation');
  console.log('[browser] workflow: do not use a temp profile, a generated browser environment, or a separate automation-only browser setup');
  console.log(`[browser] browser: ${options.browser}`);
  console.log(`[browser] profile: ${options.profileDir}`);
  console.log(`[browser] conversation: ${options.conversationUrl || '<auto-create-new-chat>'}`);
}

function loadQueue(options) {
  if (options.loginOnly || options.probeOnly) {
    return [];
  }

  if (options.queueFile) {
    if (!fs.existsSync(options.queueFile)) {
      throw new Error(`Queue file not found: ${options.queueFile}`);
    }
    const raw = fs.readFileSync(options.queueFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('Queue file must be a JSON array.');
    }
    const queueDir = path.dirname(options.queueFile);
    return parsed.map((item, index) => {
      const basePrompt = normalizeText(item?.prompt);
      if (!basePrompt) {
        throw new Error(`Queue item ${index} does not contain a valid prompt.`);
      }
      const structuredReferenceImages = resolveReferenceImages(item?.referenceImages, queueDir);
      const referenceImages = structuredReferenceImages;
      const task = normalizeTaskConfig({
        id: normalizeText(item?.id) || slugify(basePrompt).slice(0, 48),
        prompt: basePrompt,
        referenceImages,
        styleHints: item?.styleHints,
        effectHints: item?.effectHints,
        backgroundHints: item?.backgroundHints,
        providerPrompt: item?.providerPrompt,
        size: item?.size,
        outputWidth: item?.outputWidth,
        outputHeight: item?.outputHeight,
        subjectWidthRatio: item?.subjectWidthRatio,
        subjectHeightRatio: item?.subjectHeightRatio,
        cutoutPolicy: item?.cutoutPolicy,
        sourceKind: item?.sourceKind,
        cluster: item?.cluster,
        sizeRequirement: item?.sizeRequirement,
      });
      if (!task.prompt) {
        throw new Error(`Queue item ${index} produced an empty prompt after reference analysis.`);
      }
      return task;
    });
  }

  if (options.promptFile) {
    if (!fs.existsSync(options.promptFile)) {
      throw new Error(`Prompt file not found: ${options.promptFile}`);
    }
    const prompt = normalizeText(fs.readFileSync(options.promptFile, 'utf8'));
    if (!prompt) {
      throw new Error('Prompt file is empty.');
    }
    const referenceImages = options.referenceImagePaths.map(imagePath => normalizeReferenceImageItem({ path: imagePath }));
    return [
      normalizeTaskConfig({
        id: slugify(path.basename(options.promptFile, path.extname(options.promptFile))),
        prompt,
        providerPrompt: options.providerPrompt,
        referenceImages,
        styleHints: options.styleHints,
        backgroundHints: options.backgroundHints,
        effectHints: options.effectHints,
        size: options.size,
        sizeRequirement: options.sizeRequirement,
        cutoutPolicy: options.cutoutPolicy,
        outputWidth: options.outputWidth,
        outputHeight: options.outputHeight,
        subjectWidthRatio: options.subjectWidthRatio,
        subjectHeightRatio: options.subjectHeightRatio,
      }),
    ];
  }

  if (options.prompt) {
    const prompt = normalizeText(options.prompt);
    if (!prompt) {
      throw new Error('Prompt is empty.');
    }
    const referenceImages = options.referenceImagePaths.map(imagePath => normalizeReferenceImageItem({ path: imagePath }));
    return [
      normalizeTaskConfig({
        id: slugify(prompt).slice(0, 64),
        prompt,
        providerPrompt: options.providerPrompt,
        referenceImages,
        styleHints: options.styleHints,
        backgroundHints: options.backgroundHints,
        effectHints: options.effectHints,
        size: options.size,
        sizeRequirement: options.sizeRequirement,
        cutoutPolicy: options.cutoutPolicy,
        outputWidth: options.outputWidth,
        outputHeight: options.outputHeight,
        subjectWidthRatio: options.subjectWidthRatio,
        subjectHeightRatio: options.subjectHeightRatio,
      }),
    ];
  }

  throw new Error('Provide --prompt, --prompt-file, or --queue-file.');
}

function resolveOptionalFilePath(value, baseDir = process.cwd()) {
  const raw = normalizeText(value);
  if (!raw) return '';
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Input image not found: ${resolved}`);
  }
  return resolved;
}

function gcd(a, b) {
  let left = Math.abs(Number(a) || 0);
  let right = Math.abs(Number(b) || 0);
  while (right !== 0) {
    const next = left % right;
    left = right;
    right = next;
  }
  return left || 1;
}

function nearlyEqual(left, right, tolerance = 0.03) {
  if (!Number.isFinite(left) || !Number.isFinite(right) || right === 0) {
    return false;
  }
  return Math.abs(left - right) / Math.abs(right) <= tolerance;
}

function classifyOrientation(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return '未知方向';
  }
  const ratio = width / height;
  if (ratio >= 0.97 && ratio <= 1.03) {
    return '方图';
  }
  if (ratio > 1.03) {
    return '横版';
  }
  return '竖版';
}

function formatAspectRatio(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return '';
  }
  const divisor = gcd(width, height);
  const ratioWidth = Math.max(1, Math.round(width / divisor));
  const ratioHeight = Math.max(1, Math.round(height / divisor));
  return `${ratioWidth}:${ratioHeight}`;
}

function readPngDimensions(buffer) {
  if (buffer.length < 24) {
    throw new Error('PNG header is too short.');
  }
  const signature = '89504e470d0a1a0a';
  if (buffer.subarray(0, 8).toString('hex') !== signature) {
    throw new Error('Invalid PNG signature.');
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function readGifDimensions(buffer) {
  if (buffer.length < 10) {
    throw new Error('GIF header is too short.');
  }
  const signature = buffer.subarray(0, 6).toString('ascii');
  if (signature !== 'GIF87a' && signature !== 'GIF89a') {
    throw new Error('Invalid GIF signature.');
  }
  return {
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
  };
}

function readJpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error('Invalid JPEG signature.');
  }
  let offset = 2;
  while (offset + 9 < buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) {
      offset += 1;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= buffer.length) {
      break;
    }
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9) {
      continue;
    }
    if (offset + 1 >= buffer.length) {
      break;
    }
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      break;
    }
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  throw new Error('Could not find JPEG dimensions.');
}

function readWebpDimensions(buffer) {
  if (buffer.length < 30) {
    throw new Error('WEBP header is too short.');
  }
  if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF' || buffer.subarray(8, 12).toString('ascii') !== 'WEBP') {
    throw new Error('Invalid WEBP signature.');
  }
  const chunkType = buffer.subarray(12, 16).toString('ascii');
  if (chunkType === 'VP8 ') {
    if (buffer.length < 30) {
      throw new Error('VP8 header is too short.');
    }
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunkType === 'VP8L') {
    if (buffer.length < 25 || buffer[20] !== 0x2f) {
      throw new Error('Invalid VP8L payload.');
    }
    const bits =
      buffer[21] |
      (buffer[22] << 8) |
      (buffer[23] << 16) |
      (buffer[24] << 24);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunkType === 'VP8X') {
    if (buffer.length < 30) {
      throw new Error('VP8X header is too short.');
    }
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  throw new Error(`Unsupported WEBP chunk type: ${chunkType}`);
}

function readImageDimensions(filePath) {
  const buffer = fs.readFileSync(filePath);
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.png':
      return readPngDimensions(buffer);
    case '.jpg':
    case '.jpeg':
      return readJpegDimensions(buffer);
    case '.gif':
      return readGifDimensions(buffer);
    case '.webp':
      return readWebpDimensions(buffer);
    default:
      throw new Error(`Unsupported image format for reference analysis: ${extension || '<none>'}`);
  }
}

function normalizeReferenceImageItem(item, baseDir = process.cwd()) {
  const source = typeof item === 'string' ? { path: item } : item;
  if (!source || typeof source !== 'object') {
    throw new Error('Reference image items must be a file path string or an object with a path field.');
  }
  const imagePath = resolveOptionalFilePath(source.path, baseDir);
  if (!imagePath) {
    throw new Error('Reference image item is missing path.');
  }
  const { width, height } = readImageDimensions(imagePath);
  const styleHints = normalizeTextList(source.styleHints);
  const role = normalizeText(source.role);
  return {
    path: imagePath,
    width,
    height,
    orientation: classifyOrientation(width, height),
    aspectRatio: formatAspectRatio(width, height),
    styleHints,
    role,
  };
}

function resolveReferenceImages(value, baseDir = process.cwd()) {
  if (!Array.isArray(value)) return [];
  return value.map(item => normalizeReferenceImageItem(item, baseDir));
}

function normalizeTaskConfig(rawTask) {
  const normalizedTask = normalizeUnifiedTask(rawTask);
  return {
    ...normalizedTask,
    referenceImagePaths: normalizedTask.referenceImages.map(item => item.path).filter(Boolean),
    prompt: buildUnifiedPrompt(normalizedTask, { provider: 'browser', joinWith: '\n' }),
  };
}

function findExistingOutputFiles(baseOutDir, taskId, minImageBytes) {
  if (!fs.existsSync(baseOutDir)) {
    return [];
  }

  const finalPattern = new RegExp(`^${escapeRegExp(taskId)}(?:-v\\d+)?\\.(png|jpg|jpeg|webp)$`, 'i');
  return listFilesRecursive(baseOutDir).filter(filePath => {
    if (!finalPattern.test(path.basename(filePath))) {
      return false;
    }
    try {
      return fs.statSync(filePath).size >= minImageBytes;
    } catch {
      return false;
    }
  });
}

function buildQueue(tasks, options) {
  const filtered = tasks.filter(task => {
    if (options.force) {
      return true;
    }
    const existing = findExistingOutputFiles(options.outDir, task.id, options.minImageBytes);
    return existing.length === 0;
  });

  if (options.limit && Number.isFinite(options.limit)) {
    return filtered.slice(0, options.limit);
  }

  return filtered;
}

function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fetchAuthStatus(page) {
  return page.evaluate(() => {
    const href = window.location.href;
    const pathname = window.location.pathname;
    const hasComposer = Boolean(
      document.querySelector('#prompt-textarea') ||
        document.querySelector('[data-testid="composer-root"] [contenteditable="true"]') ||
        document.querySelector('form textarea') ||
        document.querySelector('main [contenteditable="true"]')
    );
    const hasLoginButton = Array.from(document.querySelectorAll('a,button')).some(element =>
      /(log in|sign in|登录|登入)/i.test((element.textContent || '').trim())
    );
    return {
      href,
      pathname,
      hasComposer,
      hasLoginButton,
    };
  });
}

function expectedConversationPath(conversationUrl) {
  return new URL(conversationUrl).pathname;
}

function normalizeConversationUrl(value) {
  const raw = normalizeText(value);
  if (!raw) {
    return '';
  }

  try {
    const parsed = new URL(raw);
    if (!isTargetConversationUrl(`${parsed.origin}${parsed.pathname}`)) {
      return '';
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '';
  }
}

async function readCurrentConversationUrl(page) {
  return normalizeConversationUrl(page.url());
}

async function clickNewChatControl(page) {
  return page.evaluate(() => {
    const isVisible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };

    const candidates = Array.from(document.querySelectorAll('a,button,[role="button"]')).filter(isVisible);
    const hit = candidates.find(element => {
      const href = element.getAttribute('href') || '';
      const text = [
        element.getAttribute('aria-label') || '',
        element.getAttribute('title') || '',
        element.getAttribute('data-testid') || '',
        element.textContent || '',
        href,
      ].join(' ');
      return /(new chat|new conversation|temporary chat|新聊天|新建聊天|发起新聊天|开启新聊天)/i.test(text) || href === '/';
    });

    if (!hit) {
      return false;
    }

    hit.click();
    return true;
  });
}

async function ensureComposerAvailableAnywhere(page, options) {
  const entryUrl = `${TARGET_SITE_ORIGIN}/`;
  await page.goto(entryUrl, { waitUntil: 'networkidle2' });
  await sleep(2500);

  let authState = await fetchAuthStatus(page);
  if (authState.hasComposer) {
    return;
  }

  if (options.headless) {
    throw new Error('target image site login is required. Re-run without --headless for manual login.');
  }

  console.log('[browser] login required before creating a fresh conversation');
  const deadline = Date.now() + options.loginTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    try {
      await page.goto(entryUrl, { waitUntil: 'networkidle2' });
    } catch {
      // Ignore transient navigation failures during manual login.
    }
    authState = await fetchAuthStatus(page);
    if (authState.hasComposer) {
      console.log('[browser] login detected and composer is available');
      return;
    }
  }

  throw new Error(`Timed out while waiting for target image site login. current=${authState.pathname} href=${authState.href}`);
}

async function ensureFreshConversation(page, options) {
  await ensureComposerAvailableAnywhere(page, options);

  const currentConversationUrl = await readCurrentConversationUrl(page);
  if (!currentConversationUrl) {
    console.log('[browser] fresh conversation page is ready');
    return;
  }

  const clickedNewChat = await clickNewChatControl(page);
  if (clickedNewChat) {
    await sleep(2000);
    const afterClickConversationUrl = await readCurrentConversationUrl(page);
    if (!afterClickConversationUrl && (await hasComposer(page))) {
      console.log('[browser] opened a fresh conversation via new chat control');
      return;
    }
  }

  await page.goto(`${TARGET_SITE_ORIGIN}/`, { waitUntil: 'networkidle2' });
  await sleep(2500);
  if (await hasComposer(page)) {
    console.log('[browser] using target image site home as the fresh conversation entry');
    return;
  }

  throw new Error('Could not prepare a fresh target image site conversation.');
}

async function ensureLoggedIn(page, options) {
  if (!options.conversationUrl) {
    await ensureFreshConversation(page, options);
    return;
  }

  const expectedPath = expectedConversationPath(options.conversationUrl);
  await page.goto(options.conversationUrl, { waitUntil: 'networkidle2' });
  await sleep(2500);

  let authState = await fetchAuthStatus(page);
  if (authState.hasComposer && authState.pathname === expectedPath) {
    console.log('[browser] composer is available and target conversation is open');
    return;
  }

  if (options.headless) {
    throw new Error('target image site login is required. Re-run without --headless for manual login.');
  }

  console.log(
    `[browser] login or conversation access required; expected ${expectedPath}, current ${authState.pathname}`
  );
  const deadline = Date.now() + options.loginTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    try {
      await page.goto(options.conversationUrl, { waitUntil: 'networkidle2' });
    } catch {
      // Ignore transient navigation failures during manual login.
    }
    authState = await fetchAuthStatus(page);
    if (authState.hasComposer && authState.pathname === expectedPath) {
      console.log('[browser] login detected and target conversation is accessible');
      return;
    }
  }

  throw new Error(
    `Timed out while waiting for target image site login or conversation access. expected=${expectedPath} current=${authState.pathname} href=${authState.href}`
  );
}

async function ensureConversationReady(page, options) {
  if (!options.conversationUrl) {
    if (!(await hasComposer(page))) {
      await ensureFreshConversation(page, options);
    }
    return;
  }

  const expectedPath = expectedConversationPath(options.conversationUrl);
  const authState = await fetchAuthStatus(page);
  if (authState.hasComposer && authState.pathname === expectedPath) {
    return;
  }

  await page.goto(options.conversationUrl, { waitUntil: 'networkidle2' });
  await sleep(2500);
}

async function hasComposer(page) {
  return page.evaluate(() => {
    const isVisible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };

    const direct = [
      document.querySelector('#prompt-textarea'),
      document.querySelector('[data-testid="composer-root"] [contenteditable="true"]'),
      document.querySelector('form textarea'),
    ].find(isVisible);
    if (direct) {
      return true;
    }

    return Array.from(document.querySelectorAll('main [contenteditable="true"], main textarea')).some(isVisible);
  });
}

async function focusComposer(page) {
  const focused = await page.evaluate(() => {
    const isVisible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };

    const composer =
      [
        document.querySelector('#prompt-textarea'),
        document.querySelector('[data-testid="composer-root"] [contenteditable="true"]'),
        document.querySelector('form textarea'),
      ].find(isVisible) ??
      Array.from(document.querySelectorAll('main [contenteditable="true"], main textarea'))
        .filter(isVisible)
        .sort((left, right) => {
          const a = left.getBoundingClientRect();
          const b = right.getBoundingClientRect();
          return b.width * b.height - a.width * a.height;
        })[0];

    if (!composer) {
      return false;
    }

    composer.scrollIntoView({ block: 'center', inline: 'nearest' });
    composer.focus();
    composer.click();
    return true;
  });

  if (!focused) {
    throw new Error('Prompt composer not found.');
  }
}

async function clearComposer(page) {
  await focusComposer(page);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await sleep(400);
  const cleared = await page.evaluate(() => {
    const isVisible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };

    const composer =
      [
        document.querySelector('#prompt-textarea'),
        document.querySelector('[data-testid="composer-root"] [contenteditable="true"]'),
        document.querySelector('form textarea'),
      ].find(isVisible) ??
      Array.from(document.querySelectorAll('main [contenteditable="true"], main textarea')).find(isVisible);

    if (!composer) {
      return false;
    }

    if ('value' in composer) {
      composer.value = '';
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    composer.innerHTML = '';
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
    return true;
  });

  if (!cleared) {
    throw new Error('Prompt composer disappeared during clear.');
  }
  await sleep(400);
}

async function readComposerValue(page) {
  return page.evaluate(() => {
    const isVisible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };

    const composer =
      [
        document.querySelector('#prompt-textarea'),
        document.querySelector('[data-testid="composer-root"] [contenteditable="true"]'),
        document.querySelector('form textarea'),
      ].find(isVisible) ??
      Array.from(document.querySelectorAll('main [contenteditable="true"], main textarea')).find(isVisible);

    if (!composer) {
      return '';
    }
    if ('value' in composer) {
      return composer.value || '';
    }
    return composer.innerText || composer.textContent || '';
  });
}

async function fillPrompt(page, prompt) {
  if (!(await hasComposer(page))) {
    throw new Error('Prompt composer not found before fill.');
  }

  await clearComposer(page);
  await focusComposer(page);

  const applyPromptViaDom = async value =>
    page.evaluate(input => {
      const safeValue = String(input ?? '');
      const isVisible = element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const composer =
        [
          document.querySelector('#prompt-textarea'),
          document.querySelector('[data-testid="composer-root"] [contenteditable="true"]'),
          document.querySelector('form textarea'),
        ].find(isVisible) ??
        Array.from(document.querySelectorAll('main [contenteditable="true"], main textarea')).find(isVisible);

      if (!composer) {
        return false;
      }

      composer.focus();
      if ('value' in composer) {
        composer.value = safeValue;
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        composer.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }

      composer.innerHTML = '';
      const lines = safeValue.split(/\r?\n/).filter(Boolean);
      if (lines.length === 0) {
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: '' }));
        return true;
      }

      for (const line of lines) {
        const paragraph = document.createElement('p');
        paragraph.textContent = line;
        composer.appendChild(paragraph);
      }

      composer.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: safeValue }));
      return true;
    }, value);

  let patched = await applyPromptViaDom(prompt);
  await sleep(1200);
  let actual = normalizeText(await readComposerValue(page));
  if (patched && actual === normalizeText(prompt)) {
    console.log(`[browser] prompt filled via DOM (${prompt.length} chars)`);
    return;
  }

  let pasted = false;
  try {
    writeTextToSystemClipboard(prompt);
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyV');
    await page.keyboard.up('Control');
    pasted = true;
  } catch {
    pasted = false;
  }

  if (!pasted) {
    await page.keyboard.type(prompt, { delay: 10 });
  }

  await sleep(1200);
  actual = normalizeText(await readComposerValue(page));
  if (actual === normalizeText(prompt)) {
    console.log(`[browser] prompt filled via ${pasted ? 'clipboard' : 'keyboard'} (${prompt.length} chars)`);
    return;
  }

  patched = await page.evaluate(value => {
    const safeValue = String(value ?? '');
    const isVisible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const composer =
      [
        document.querySelector('#prompt-textarea'),
        document.querySelector('[data-testid="composer-root"] [contenteditable="true"]'),
        document.querySelector('form textarea'),
      ].find(isVisible) ??
      Array.from(document.querySelectorAll('main [contenteditable="true"], main textarea')).find(isVisible);

    if (!composer) {
      return false;
    }

    composer.focus();
    if ('value' in composer) {
      composer.value = safeValue;
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    composer.innerHTML = '';
    const paragraph = document.createElement('p');
    paragraph.textContent = safeValue;
    composer.appendChild(paragraph);
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: safeValue }));
    return true;
  }, prompt);

  if (!patched) {
    throw new Error('Prompt composer disappeared during patch fill.');
  }

  await sleep(1200);
  actual = normalizeText(await readComposerValue(page));
  if (actual !== normalizeText(prompt)) {
    throw new Error(`Prompt write verification failed. expected="${normalizeText(prompt)}" actual="${actual}"`);
  }
  console.log(`[browser] prompt filled (${prompt.length} chars)`);
}

async function snapshotThreadImages(page) {
  const images = await page.evaluate(() => {
    const isVisible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };

    const absolutize = value => {
      const raw = String(value || '').trim();
      if (!raw) return '';
      if (/^(https?:|blob:|data:)/i.test(raw)) return raw;
      if (raw.startsWith('//')) return `${location.protocol}${raw}`;
      if (raw.startsWith('/')) return `${location.origin}${raw}`;
      try {
        return new URL(raw, location.href).href;
      } catch {
        return raw;
      }
    };

    const parseBackgroundUrl = value => {
      const raw = String(value || '').trim();
      const match = raw.match(/url\((['"]?)(.*?)\1\)/i);
      if (!match?.[2]) return '';
      return absolutize(match[2]);
    };

    const turnSelectors = [
      '[data-testid^="conversation-turn"]',
      '[data-message-author-role]',
      'article',
    ].join(',');
    const turns = Array.from(document.querySelectorAll(turnSelectors))
      .filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .filter((element, index, list) => list.findIndex(item => item === element) === index);

    const getTurnInfo = element => {
      const turn = element.closest(turnSelectors);
      if (!turn) {
        return {
          turnIndex: -1,
          turnTop: 0,
          turnBottom: 0,
          turnRole: '',
        };
      }
      const rect = turn.getBoundingClientRect();
      const role =
        turn.getAttribute('data-message-author-role') ||
        turn.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role') ||
        '';
      return {
        turnIndex: turns.indexOf(turn),
        turnTop: rect.top + window.scrollY,
        turnBottom: rect.bottom + window.scrollY,
        turnRole: role,
      };
    };

    const imageNodes = Array.from(document.querySelectorAll('img'))
      .filter(isVisible)
      .map((image, nodeIndex) => {
        const rect = image.getBoundingClientRect();
        const anchor = image.closest('a[href]');
        const turnInfo = getTurnInfo(image);
        return {
          src: absolutize(image.currentSrc || image.src || ''),
          href: absolutize(anchor?.href || ''),
          alt: image.alt || '',
          width: image.naturalWidth || rect.width || 0,
          height: image.naturalHeight || rect.height || 0,
          top: rect.top,
          left: rect.left,
          documentTop: rect.top + window.scrollY,
          documentBottom: rect.bottom + window.scrollY,
          nodeIndex,
          ...turnInfo,
          source: 'img',
        };
      });

    const backgroundNodes = Array.from(document.querySelectorAll('div,button,a,figure,span'))
      .filter(isVisible)
      .map((element, nodeIndex) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const bg = parseBackgroundUrl(style.backgroundImage || '');
        const anchor = element.closest('a[href]');
        const turnInfo = getTurnInfo(element);
        return {
          src: bg,
          href: absolutize(anchor?.href || ''),
          alt: element.getAttribute('aria-label') || element.textContent || '',
          width: rect.width || 0,
          height: rect.height || 0,
          top: rect.top,
          left: rect.left,
          documentTop: rect.top + window.scrollY,
          documentBottom: rect.bottom + window.scrollY,
          nodeIndex,
          ...turnInfo,
          source: 'background',
        };
      })
      .filter(item => item.src);

    return [...imageNodes, ...backgroundNodes];
  });

  return dedupeImages(
    images.filter(item => Math.max(item.width, item.height) >= 200)
  );
}

async function snapshotConversationState(page) {
  return page.evaluate(() => {
    const turnSelectors = [
      '[data-testid^="conversation-turn"]',
      '[data-message-author-role]',
      'article',
    ].join(',');
    const turns = Array.from(document.querySelectorAll(turnSelectors))
      .filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .filter((element, index, list) => list.findIndex(item => item === element) === index);

    const bounds = turns.map(element => {
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top + window.scrollY,
        bottom: rect.bottom + window.scrollY,
      };
    });

    return {
      turnCount: turns.length,
      maxTurnBottom: bounds.length ? Math.max(...bounds.map(item => item.bottom)) : 0,
      maxTurnTop: bounds.length ? Math.max(...bounds.map(item => item.top)) : 0,
      scrollY: window.scrollY,
    };
  });
}

function normalizeImageKey(item) {
  const target = item.href || item.src || '';
  if (!target) return '';
  try {
    const parsed = new URL(target);
    if (/\/backend-api\/estuary\/content/i.test(parsed.pathname)) {
      const fileId = parsed.searchParams.get('id');
      if (fileId) {
        return `estuary:${fileId}`;
      }
    }
    return parsed.href;
  } catch {
    return target;
  }
}

function dedupeImages(images) {
  const bestByKey = new Map();
  for (const image of images) {
    const key = normalizeImageKey(image);
    if (!key) continue;
    const current = bestByKey.get(key);
    const currentScore = current ? current.width * current.height : -1;
    const nextScore = image.width * image.height + (image.top >= 0 ? 10 : 0);
    if (!current || nextScore > currentScore) {
      bestByKey.set(key, {
        ...image,
        key,
      });
    }
  }

  return [...bestByKey.values()].sort((left, right) => {
    if (left.top !== right.top) return left.top - right.top;
    return left.left - right.left;
  });
}

function sortImagesNewest(images) {
  return [...images].sort((left, right) => {
    const rightTop = Number.isFinite(right.documentTop) ? right.documentTop : right.top || 0;
    const leftTop = Number.isFinite(left.documentTop) ? left.documentTop : left.top || 0;
    if (rightTop !== leftTop) return rightTop - leftTop;
    const rightIndex = Number.isFinite(right.turnIndex) ? right.turnIndex : -1;
    const leftIndex = Number.isFinite(left.turnIndex) ? left.turnIndex : -1;
    if (rightIndex !== leftIndex) return rightIndex - leftIndex;
    return (right.left || 0) - (left.left || 0);
  });
}

async function snapshotPolicyNotices(page) {
  return page.evaluate(() => {
    const bodyText = String(document.body?.innerText || '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!bodyText) {
      return [];
    }

    const patterns = [
      /image we created may violate our content policies/i,
      /if you think we got it wrong/i,
      /retry or edit your prompt/i,
      /may violate our policies/i,
      /可能违反我们的内容政策/i,
      /如果你认为我们弄错了/i,
      /请重试或修改你的提示词/i,
      /编辑你的提示词/i,
      /编辑提示词/i,
    ];

    const notices = [];
    for (const pattern of patterns) {
      const match = bodyText.match(pattern);
      if (!match) continue;
      const index = match.index ?? 0;
      const start = Math.max(0, index - 80);
      const end = Math.min(bodyText.length, index + match[0].length + 180);
      const snippet = bodyText.slice(start, end).trim();
      if (snippet) notices.push(snippet);
    }

    return [...new Set(notices)].map(text => ({
      key: text.toLowerCase(),
      message: text,
    }));
  });
}

function isLikelyGeneratedImageResponse(url, contentType = '') {
  const target = String(url || '');
  const type = String(contentType || '').toLowerCase();
  return (
    type.startsWith('image/') ||
    /backend-api\/files\/download/i.test(target) ||
    /backend-api\/estuary\/content/i.test(target) ||
    /oaiusercontent/i.test(target) ||
    /oaistatic/i.test(target) ||
    /dalle/i.test(target)
  );
}

async function isGenerationInProgress(page) {
  return page.evaluate(() => {
    const activeButton = Array.from(document.querySelectorAll('button')).find(button => {
      const text = (button.textContent || '').trim();
      const label = button.getAttribute('aria-label') || '';
      const testId = button.getAttribute('data-testid') || '';
      if (button.disabled) return false;
      return (
        /stop/i.test(text) ||
        /停止/i.test(text) ||
        /stop/i.test(label) ||
        /停止/i.test(label) ||
        testId === 'stop-button'
      );
    });
    return Boolean(activeButton);
  });
}

async function clickSubmit(page) {
  const beforeImages = await snapshotThreadImages(page);
  const beforeConversation = await snapshotConversationState(page);
  const beforePolicyNotices = await snapshotPolicyNotices(page);
  const started = Date.now();
  console.log(`[browser] visible image candidates before submit: ${beforeImages.length}`);
  console.log(
    `[browser] conversation anchor before submit: turns=${beforeConversation.turnCount} bottom=${Math.round(
      beforeConversation.maxTurnBottom || 0
    )}`
  );
  const clicked = await page.evaluate(() => {
    const isVisible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };

    const buttons = Array.from(document.querySelectorAll('button')).filter(isVisible);
    const sendButton = buttons.find(button => {
      if (button.disabled) return false;
      const label = button.getAttribute('aria-label') || '';
      const testId = button.getAttribute('data-testid') || '';
      const title = button.getAttribute('title') || '';
      const text = (button.textContent || '').trim();
      return (
        testId === 'send-button' ||
        /send/i.test(testId) ||
        /send/i.test(label) ||
        /发送/i.test(label) ||
        /send/i.test(title) ||
        /发送/i.test(title) ||
        /^Send$/i.test(text) ||
        text === '发送'
      );
    });
    if (!sendButton) {
      return false;
    }
    sendButton.click();
    return true;
  });

  if (!clicked) {
    await page.keyboard.press('Enter');
    await sleep(1500);
    console.log('[browser] submit sent via Enter fallback');
    return {
      startedAt: started,
      beforeImages,
      beforeConversation,
      beforePolicyNotices,
    };
  }

  await sleep(1500);
  console.log('[browser] submit clicked');
  return {
    startedAt: started,
    beforeImages,
    beforeConversation,
    beforePolicyNotices,
  };
}

function isImageAfterSubmitAnchor(item, submitInfo) {
  const beforeConversation = submitInfo.beforeConversation || {};
  const beforeTurnCount = Number.isFinite(beforeConversation.turnCount) ? beforeConversation.turnCount : -1;
  const beforeMaxTurnBottom = Number.isFinite(beforeConversation.maxTurnBottom)
    ? beforeConversation.maxTurnBottom
    : 0;

  if (Number.isFinite(item.turnIndex) && item.turnIndex >= 0 && beforeTurnCount >= 0) {
    return item.turnIndex >= beforeTurnCount;
  }

  const documentTop = Number.isFinite(item.documentTop) ? item.documentTop : item.top || 0;
  if (beforeMaxTurnBottom > 0) {
    return documentTop >= beforeMaxTurnBottom - 80;
  }

  return true;
}

async function waitForGeneratedImages(page, options, submitInfo) {
  const beforeKeys = new Set(submitInfo.beforeImages.map(item => item.key));
  const beforePolicyKeys = new Set((submitInfo.beforePolicyNotices || []).map(item => item.key));
  let newestImages = [];
  let lastChangeAt = 0;
  let lastSnapshot = [];
  let pollCount = 0;
  let lastNetworkAt = 0;
  const networkImages = new Map();
  const deadline = Date.now() + options.resultTimeoutMs;

  const onResponse = response => {
    try {
      const url = response.url();
      const headers = response.headers();
      const contentType = headers['content-type'] || headers['Content-Type'] || '';
      if (!isLikelyGeneratedImageResponse(url, contentType)) {
        return;
      }
      let key = url;
      try {
        const parsed = new URL(url);
        if (/\/backend-api\/estuary\/content/i.test(parsed.pathname)) {
          const fileId = parsed.searchParams.get('id');
          key = fileId ? `estuary:${fileId}` : parsed.href;
        } else {
          key = parsed.href;
        }
      } catch {
        key = url;
      }
      if (!networkImages.has(key)) {
        networkImages.set(key, {
          key,
          src: url,
          href: url,
          width: 0,
          height: 0,
          source: 'network',
        });
        lastNetworkAt = Date.now();
        console.log(`[browser] network image candidate: ${url}`);
      }
    } catch {
      // Ignore response inspection failures.
    }
  };

  if (options.allowNetworkFallback) {
    page.on('response', onResponse);
  }

  try {
    while (Date.now() < deadline) {
      pollCount += 1;
      const currentImages = await snapshotThreadImages(page);
      lastSnapshot = currentImages;
      const allFreshImages = currentImages.filter(item => !beforeKeys.has(item.key));
      const freshImages = sortImagesNewest(allFreshImages.filter(item => isImageAfterSubmitAnchor(item, submitInfo)));
      const currentPolicyNotices = await snapshotPolicyNotices(page);
      const freshPolicyNotices = currentPolicyNotices.filter(item => !beforePolicyKeys.has(item.key));

      const changed =
        freshImages.length !== newestImages.length ||
        freshImages.some((item, index) => item.key !== newestImages[index]?.key);

      if (changed) {
        newestImages = freshImages;
        lastChangeAt = Date.now();
        console.log(
          `[browser] detected ${freshImages.length} anchored fresh visible image(s), discarded ${
            allFreshImages.length - freshImages.length
          }: ${freshImages
            .map(item => `${item.key}@turn${item.turnIndex ?? '?'}:${Math.round(item.documentTop || item.top || 0)}`)
            .join(' | ')}`
        );
      }

      if (freshPolicyNotices.length > 0) {
        throw new Error(`Generation blocked by target image site content policy: ${freshPolicyNotices[0].message}`);
      }

      const generating = await isGenerationInProgress(page);
      if (pollCount % 5 === 0) {
        console.log(
          `[browser] wait poll=${pollCount} generating=${generating} visible=${currentImages.length} fresh=${freshImages.length}/${allFreshImages.length} network=${networkImages.size}`
        );
      }
      const freshVisibleStable = newestImages.length > 0 && lastChangeAt > 0 && Date.now() - lastChangeAt >= options.stableWaitMs;
      const networkStable =
        options.allowNetworkFallback &&
        networkImages.size > 0 &&
        lastNetworkAt > 0 &&
        Date.now() - lastNetworkAt >= options.stableWaitMs;
      const acceptWhileGeneratingVisible =
        freshVisibleStable && generating && Date.now() - lastChangeAt >= options.stableWaitMs * 2;
      const acceptWhileGeneratingNetwork =
        networkStable && generating && Date.now() - lastNetworkAt >= options.stableWaitMs * 2;

      if (freshVisibleStable && (!generating || acceptWhileGeneratingVisible)) {
        if (generating) {
          console.log("[browser] accepting fresh visible images even though generation flag is still true");
        }
        return newestImages;
      }
      if (networkStable && (!generating || acceptWhileGeneratingNetwork)) {
        if (generating) {
          console.log("[browser] accepting network image candidates even though generation flag is still true");
        }
        return [...networkImages.values()];
      }

      await sleep(options.pollMs);
    }
  } finally {
    if (options.allowNetworkFallback) {
      page.off('response', onResponse);
    }
  }

  throw new Error(
    `Timed out while waiting for new target image site images. lastSnapshot=${JSON.stringify(
      lastSnapshot.map(item => ({
        key: item.key,
        src: item.src,
        href: item.href,
        width: item.width,
        height: item.height,
        documentTop: item.documentTop,
        turnIndex: item.turnIndex,
        turnRole: item.turnRole,
        source: item.source,
      }))
    )} network=${JSON.stringify([...networkImages.values()].map(item => item.key))}`
  );
}

async function downloadImageThroughPage(page, url, destination, minBytes) {
  const result = await page.evaluate(async targetUrl => {
    const response = await fetch(targetUrl, { credentials: 'include' });
    const blob = await response.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('FileReader failed.'));
      reader.readAsDataURL(blob);
    });
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      dataUrl,
    };
  }, url);

  if (!result.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${result.status}`);
  }

  const match = String(result.dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error(`Unexpected data URL for ${url}`);
  }

  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length < minBytes) {
    throw new Error(`Downloaded file is too small (${buffer.length} bytes)`);
  }

  fs.writeFileSync(destination, buffer);
  return {
    bytes: buffer.length,
    contentType: result.contentType,
  };
}

function guessExtension(image) {
  const candidate = image.href || image.src || '';
  const match = candidate.match(/\.(png|jpe?g|webp|gif)(\?|$)/i);
  if (match) {
    const ext = match[1].toLowerCase();
    return ext === 'jpeg' ? '.jpg' : `.${ext}`;
  }
  return '.png';
}

function cleanupStaleOutputs(baseId, outDir, keepPaths) {
  const keepSet = new Set(keepPaths.map(item => path.resolve(item)));
  const entries = fs.readdirSync(outDir, { withFileTypes: true });
  const matcher = new RegExp(`^${escapeRegExp(baseId)}(?:-v\\d+)?\\.(png|jpg|jpeg|webp|gif)$`, 'i');
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!matcher.test(entry.name)) continue;
    const absolutePath = path.resolve(path.join(outDir, entry.name));
    if (keepSet.has(absolutePath)) continue;
    fs.rmSync(absolutePath, { force: true });
  }
}

async function saveImages(page, task, images, options) {
  ensureDir(options.outDir);
  const taskOutDir = buildTaskOutputDir(options.outDir, task.id);
  const saved = [];
  const skipped = [];
  const inputImageHashes = new Set();
  const taskReferenceImagePaths = Array.isArray(task.referenceImagePaths) ? task.referenceImagePaths : [];
  for (const referenceImagePath of taskReferenceImagePaths) {
    if (fs.existsSync(referenceImagePath)) {
      inputImageHashes.add(sha256File(referenceImagePath));
    }
  }

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const url = image.href || image.src;
    const extension = guessExtension(image);
    const outputPath = path.join(taskOutDir, `${task.id}-v${index + 1}${extension}`);
    try {
      const meta = await downloadImageThroughPage(page, url, outputPath, options.minImageBytes);
      if (inputImageHashes.has(sha256File(outputPath))) {
        fs.rmSync(outputPath, { force: true });
        skipped.push({
          url,
          reason: 'Downloaded candidate is one of the uploaded input images, not a generated result.',
        });
        continue;
      }
      saved.push({
        path: outputPath,
        url,
        bytes: meta.bytes,
        contentType: meta.contentType,
      });
    } catch (error) {
      skipped.push({
        url,
        reason: String(error),
      });
    }
  }

  if (saved.length === 0) {
    throw new Error(`No valid images downloaded. Skipped: ${JSON.stringify(skipped)}`);
  }

  cleanupStaleOutputs(task.id, taskOutDir, saved.map(item => item.path));
  return {
    outputDir: taskOutDir,
    saved,
    skipped,
  };
}

async function clickAttachButton(page) {
  return page.evaluate(() => {
    const isVisible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };

    const candidates = Array.from(document.querySelectorAll('button, [role="button"], label, a'))
      .filter(isVisible)
      .map(element => {
        const text = [
          element.getAttribute('aria-label') || '',
          element.getAttribute('title') || '',
          element.getAttribute('data-testid') || '',
          element.textContent || '',
        ].join(' ');
        return { element, text };
      });

    const hit = candidates.find(({ text }) =>
      /(attach|upload|file|image|photo|add files|添加|上传|附件|图片|照片|\+)/i.test(text)
    );

    if (!hit) return false;
    hit.element.click();
    return true;
  });
}

async function waitForInputImageUpload(page, inputImagePath) {
  const started = Date.now();
  const minWaitMs = 18000;
  const stableWaitMs = 6000;
  const timeoutMs = 180000;
  let stableSince = 0;
  let lastState = null;

  while (Date.now() - started < timeoutMs) {
    const state = await page.evaluate(() => {
      const isVisible = element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };

      const buttons = Array.from(document.querySelectorAll('button')).filter(isVisible);
      const sendButton = buttons.find(button => {
        const label = button.getAttribute('aria-label') || '';
        const testId = button.getAttribute('data-testid') || '';
        const text = (button.textContent || '').trim();
        return (
          testId === 'send-button' ||
          /send/i.test(label) ||
          /发送/i.test(label) ||
          /^Send$/i.test(text) ||
          text === '发送'
        );
      });

      const visibleElements = Array.from(document.querySelectorAll('main [role="progressbar"], main progress, main [aria-valuenow], main [aria-label], main [data-testid], main span, main div'))
        .filter(isVisible)
        .slice(-300);
      const textSample = visibleElements
        .map(element => [
          element.getAttribute('aria-label') || '',
          element.getAttribute('data-testid') || '',
          element.textContent || '',
        ].join(' ').trim())
        .filter(Boolean)
        .join(' ')
        .slice(-1200);

      const hasProgressElement = visibleElements.some(element => {
        const role = element.getAttribute('role') || '';
        return role === 'progressbar' || element.tagName.toLowerCase() === 'progress' || element.hasAttribute('aria-valuenow');
      });
      const hasUploadText = /(\b\d{1,3}\s*%|uploading|attaching|processing file|正在上传|上传中|读取中)/i.test(textSample);

      return {
        disabledSend: sendButton ? Boolean(sendButton.disabled || sendButton.getAttribute('aria-disabled') === 'true') : true,
        hasProgressElement,
        hasUploadText,
        textSample,
      };
    });

    lastState = state;
    const minimumElapsed = Date.now() - started >= minWaitMs;
    const ready = minimumElapsed && !state.disabledSend && !state.hasProgressElement;

    if (ready) {
      stableSince ||= Date.now();
      if (Date.now() - stableSince >= stableWaitMs) {
        console.log(`[browser] input image upload appears ready after ${Math.round((Date.now() - started) / 1000)}s: ${inputImagePath}`);
        return;
      }
    } else {
      stableSince = 0;
    }

    await sleep(2000);
  }

  throw new Error(
    `Input image upload did not finish before timeout. input=${inputImagePath} state=${JSON.stringify(lastState)}`
  );
}

async function attachInputImage(page, inputImagePath) {
  if (!inputImagePath) return;
  const absolutePath = path.resolve(inputImagePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Input image not found: ${absolutePath}`);
  }

  const directInput = await page.$('input[type="file"]');
  if (directInput) {
    await directInput.uploadFile(absolutePath);
    await waitForInputImageUpload(page, absolutePath);
    console.log(`[browser] input image attached via file input: ${absolutePath}`);
    return;
  }

  const chooserPromise = page.waitForFileChooser({ timeout: 6000 }).catch(() => null);
  const clicked = await clickAttachButton(page);
  const chooser = await chooserPromise;

  if (chooser) {
    await chooser.accept([absolutePath]);
    await waitForInputImageUpload(page, absolutePath);
    console.log(`[browser] input image attached via file chooser: ${absolutePath}`);
    return;
  }

  if (!clicked) {
    throw new Error('Could not find target image site attach/upload control for input image.');
  }

  const lateInput = await page.$('input[type="file"]');
  if (lateInput) {
    await lateInput.uploadFile(absolutePath);
    await waitForInputImageUpload(page, absolutePath);
    console.log(`[browser] input image attached after opening attach control: ${absolutePath}`);
    return;
  }

  throw new Error('Attach control was clicked, but no file chooser or file input became available.');
}

async function attachInputImages(page, inputImagePaths) {
  if (!Array.isArray(inputImagePaths) || inputImagePaths.length === 0) return;
  if (inputImagePaths.length === 1) {
    await attachInputImage(page, inputImagePaths[0]);
    return;
  }

  const absolutePaths = inputImagePaths.map(inputImagePath => {
    const absolutePath = path.resolve(inputImagePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Input image not found: ${absolutePath}`);
    }
    return absolutePath;
  });

  try {
    const directInput = await page.$('input[type="file"]');
    if (directInput) {
      await directInput.uploadFile(...absolutePaths);
      await waitForInputImageUpload(page, absolutePaths[absolutePaths.length - 1]);
      console.log(`[browser] input images attached via file input: ${absolutePaths.length}`);
      return;
    }

    const chooserPromise = page.waitForFileChooser({ timeout: 6000 }).catch(() => null);
    const clicked = await clickAttachButton(page);
    const chooser = await chooserPromise;

    if (chooser) {
      await chooser.accept(absolutePaths);
      await waitForInputImageUpload(page, absolutePaths[absolutePaths.length - 1]);
      console.log(`[browser] input images attached via file chooser: ${absolutePaths.length}`);
      return;
    }

    if (!clicked) {
      throw new Error('Could not find target image site attach/upload control for input images.');
    }

    const lateInput = await page.$('input[type="file"]');
    if (lateInput) {
      await lateInput.uploadFile(...absolutePaths);
      await waitForInputImageUpload(page, absolutePaths[absolutePaths.length - 1]);
      console.log(`[browser] input images attached after opening attach control: ${absolutePaths.length}`);
      return;
    }

    throw new Error('Attach control was clicked, but no file chooser or file input became available.');
  } catch (error) {
    console.warn(`[browser] batch input image attach failed; falling back to sequential uploads: ${error?.message || error}`);
    for (const absolutePath of absolutePaths) {
      await attachInputImage(page, absolutePath);
      await sleep(1200);
    }
  }
}

async function processTask(page, task, options) {
  await ensureConversationReady(page, options);

  await fillPrompt(page, task.prompt);
  await attachInputImages(page, task.referenceImagePaths);
  const submitInfo = await clickSubmit(page);
  const resolvedConversationUrl = await waitForResolvedConversationUrl(page, options, submitInfo.startedAt);
  if (resolvedConversationUrl) {
    options.conversationUrl = resolvedConversationUrl;
  }
  let images = [];
  let output = null;
  const hasInputImages = Array.isArray(task.referenceImagePaths) && task.referenceImagePaths.length > 0;
  const maxWaitPasses = hasInputImages ? 4 : 1;

  for (let waitPass = 1; waitPass <= maxWaitPasses; waitPass += 1) {
    images = await waitForGeneratedImages(page, options, submitInfo);
    try {
      output = await saveImages(page, task, images, options);
      break;
    } catch (error) {
      const message = String(error);
      const canIgnoreAttachment =
        hasInputImages &&
        waitPass < maxWaitPasses &&
        /No valid images downloaded|Downloaded file is too small/i.test(message);
      if (!canIgnoreAttachment) {
        throw error;
      }

      console.log(
        `[browser] ignoring ${images.length} fresh image candidate(s) that look like uploaded attachments; waiting for restored output`
      );
      submitInfo.beforeImages.push(...images);
      await sleep(options.pollMs);
    }
  }

  if (!output) {
    throw new Error('No valid generated image was recovered after retrying fresh attachment candidates.');
  }

  return {
    id: task.id,
    conversationUrl: options.conversationUrl,
    prompt: task.prompt,
    referenceImagePaths: hasInputImages ? task.referenceImagePaths : [],
    outputDir: output.outputDir,
    imageCount: images.length,
    images: images.map(item => ({
      key: item.key,
      src: item.src,
      href: item.href,
      width: item.width,
      height: item.height,
      documentTop: item.documentTop,
      turnIndex: item.turnIndex,
      turnRole: item.turnRole,
      source: item.source,
    })),
    saved: output.saved,
    skipped: output.skipped,
    startedAt: new Date(submitInfo.startedAt).toISOString(),
    completedAt: new Date().toISOString(),
  };
}

async function probeConversation(page, options) {
  const expectedPath = expectedConversationPath(options.conversationUrl);

  try {
    await page.goto(options.conversationUrl, { waitUntil: 'networkidle2' });
  } catch {
    // Ignore transient navigation failures and inspect the resulting page state anyway.
  }

  await sleep(2500);
  const authState = await fetchAuthStatus(page);
  const title = await page.title().catch(() => '');
  const accessible = authState.hasComposer && authState.pathname === expectedPath;

  let status = 'blocked';
  if (accessible) {
    status = 'ready';
  } else if (authState.hasLoginButton) {
    status = 'login_required';
  } else if (authState.pathname !== expectedPath) {
    status = 'wrong_conversation';
  }

  return {
    checkedAt: new Date().toISOString(),
    expectedPath,
    title,
    ...authState,
    accessible,
    status,
  };
}

async function waitForResolvedConversationUrl(page, options, startedAtMs) {
  const existingConversationUrl = normalizeConversationUrl(options.conversationUrl);
  if (existingConversationUrl) {
    return existingConversationUrl;
  }

  const deadline = Math.max(Date.now() + 10000, startedAtMs + options.resultTimeoutMs);
  while (Date.now() < deadline) {
    const currentConversationUrl = await readCurrentConversationUrl(page);
    if (currentConversationUrl) {
      console.log(`[browser] resolved new conversation URL: ${currentConversationUrl}`);
      return currentConversationUrl;
    }
    await sleep(1500);
  }

  throw new Error('Timed out while waiting for target image site to assign a conversation URL to the fresh chat.');
}

function writeSessionMetadata(options, payload) {
  if (!options.sessionOut) {
    return;
  }

  ensureDir(path.dirname(options.sessionOut));
  fs.writeFileSync(options.sessionOut, JSON.stringify(payload, null, 2), 'utf8');
}

async function createWorkerPage(browser) {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  return page;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertRequiredOptions(options);
  assertSupportedWorkflow(options);
  assertBrowserClosed(options);
  printWorkflowReminder(options);
  ensureDir(options.logDir);
  ensureDir(options.outDir);

  if (!fs.existsSync(options.browser)) {
    throw new Error(`Browser executable not found: ${options.browser}`);
  }
  if (!fs.statSync(options.browser).isFile()) {
    throw new Error(`Browser executable path must point to a file: ${options.browser}`);
  }
  if (!fs.existsSync(options.profileDir)) {
    throw new Error(`Browser profile directory not found: ${options.profileDir}`);
  }
  if (!fs.statSync(options.profileDir).isDirectory()) {
    throw new Error(`Browser profile directory path must point to a directory: ${options.profileDir}`);
  }

  const queue = buildQueue(loadQueue(options), options);
  console.log(`[browser] queue size: ${queue.length}`);

  if (!options.loginOnly && !options.probeOnly && queue.length === 0) {
    console.log('[browser] Nothing to do.');
    return;
  }

  const browser = await puppeteer.launch({
    headless: options.headless ? 'new' : false,
    executablePath: options.browser,
    userDataDir: options.profileDir,
    defaultViewport: null,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    if (options.probeOnly) {
      const page = await createWorkerPage(browser);
      const probe = await probeConversation(page, options);
      await page.close();
      writeSessionMetadata(options, {
        checkedAt: new Date().toISOString(),
        conversationUrl: options.conversationUrl || '',
        mode: 'probe',
      });
      if (options.jsonOut) {
        ensureDir(path.dirname(options.jsonOut));
        fs.writeFileSync(options.jsonOut, JSON.stringify(probe, null, 2), 'utf8');
      }
      console.log(JSON.stringify(probe));
      return;
    }

    const workerPage = await createWorkerPage(browser);
    await ensureLoggedIn(workerPage, options);

    if (options.loginOnly) {
      console.log('[browser] login-only completed, profile is ready for reuse');
      writeSessionMetadata(options, {
        checkedAt: new Date().toISOString(),
        conversationUrl: await readCurrentConversationUrl(workerPage),
        mode: 'login_only',
      });
      await workerPage.close();
      return;
    }

    for (let index = 0; index < queue.length; index += 1) {
      const task = queue[index];
      console.log(`[browser] [${index + 1}/${queue.length}] ${task.id}`);
      let summary;
      try {
        summary = await processTask(workerPage, task, options);
      } catch (error) {
        summary = {
          id: task.id,
          prompt: task.prompt,
          referenceImagePaths: Array.isArray(task.referenceImagePaths) ? task.referenceImagePaths : [],
          error: String(error),
          completedAt: new Date().toISOString(),
        };
      }

      const logPath = path.join(options.logDir, `${task.id}.json`);
      fs.writeFileSync(logPath, JSON.stringify(sanitizeSummaryForLog(summary), null, 2), 'utf8');
      if (summary.error) {
        console.error(`[browser] failed ${task.id}: ${summary.error}`);
      } else {
        console.log(`[browser] saved ${summary.saved.length} image(s) for ${task.id}`);
      }

      await sleep(1200);
    }

    await workerPage.close();
    writeSessionMetadata(options, {
      checkedAt: new Date().toISOString(),
      conversationUrl: options.conversationUrl || '',
      mode: 'queue',
      taskCount: queue.length,
    });
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error('[browser] fatal:', error);
  process.exitCode = 1;
});
