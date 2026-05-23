import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'url';
import { buildJimengPrompt, normalizeText } from './jimengPromptBuilder.mjs';
import { buildUnifiedPrompt, normalizeUnifiedTask } from '../../shared/unifiedTask.mjs';

const HOME_URL_BASE = 'https://jimeng.jianying.com/ai-tool/generate?type=image&workspace=';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolveProjectRoot(SCRIPT_DIR);
const DEFAULT_QUEUE_DIR = path.join(PROJECT_ROOT, '.auto-image-workflow-data', 'queues');
const DEFAULT_MANIFEST_FILE = path.join(DEFAULT_QUEUE_DIR, 'image-manifest.json');
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, '.auto-image-workflow-data', 'output');
const DEFAULT_LOG_DIR = path.join(PROJECT_ROOT, '.auto-image-workflow-data', 'logs');
const DEFAULT_PROFILE_DIR = 'C:/local_tmp/jimeng-automation-profile';
const DEFAULT_WORKSPACE_POOL_FILE = path.join(DEFAULT_QUEUE_DIR, 'workspace-pool.json');
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_RESULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS = 5000;
const DEFAULT_MIN_IMAGE_BYTES = 20 * 1024;
const DEFAULT_STABLE_IMAGE_WAIT_MS = 12000;
const DEFAULT_PREVIEW_SETTLE_TIMEOUT_MS = 8000;
const DEFAULT_PREVIEW_POLL_MS = 500;
const DEFAULT_MIN_PREVIEW_IMAGE_AREA = 720 * 720;
const DEFAULT_PREVIEW_CANDIDATE_LIMIT = 4;
const DEFAULT_MIN_STABLE_DOM_RESULT_COUNT = 1;
const DEFAULT_PROGRESS_LOG_INTERVAL_MS = 15000;
const DEFAULT_PRE_SUBMIT_IMAGE_SETTLE_MS = 10000;
const DEFAULT_PRE_SUBMIT_IMAGE_STABLE_MS = 2500;
const DEFAULT_HISTORY_API_POLL_MS = 10000;
const DEFAULT_SUBJECT_TAG = '';
const DEFAULT_PAGE_TIMEOUT_MS = 60 * 1000;
const DEFAULT_SUBMIT_TIMEOUT_MS = 60 * 1000;

let clipboardLock = Promise.resolve();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resolveProjectRoot(startPath) {
  const explicitRoot = normalizeText(process.env.AUTO_IMAGE_PROJECT_ROOT || process.env.WORKSPACE_ROOT || '');
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }

  let cursor = path.resolve(startPath);
  while (true) {
    const marker = path.join(cursor, '.trae');
    if (fs.existsSync(marker)) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (!parent || parent === cursor) {
      return path.resolve(process.cwd());
    }
    cursor = parent;
  }
}

function buildHomeUrl(workspaceId) {
  return `${HOME_URL_BASE}${encodeURIComponent(normalizeWorkspaceId(workspaceId) || '0')}`;
}

async function gotoJimengPage(page, url, options, label = 'page') {
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: options.pageTimeoutMs,
    });
  } catch (error) {
    const message = String(error);
    if (!message.includes('Navigation timeout')) {
      throw error;
    }
    console.warn(`[jimeng] ${label} navigation timeout; continuing with current page state.`);
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
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
  const taskOutDir = path.join(baseOutDir, `${slugify(taskId)}-${makeTimestamp()}`);
  ensureDir(taskOutDir);
  return taskOutDir;
}

function listFilesRecursive(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const output = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
      } else if (entry.isFile()) {
        output.push(absolutePath);
      }
    }
  }
  return output;
}

function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function writeSessionFile(filePath, payload) {
  if (!filePath) return;
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function buildProgressFilePath(entry, options) {
  if (!entry?.hash || !options?.logDir) {
    return '';
  }
  return path.join(options.logDir, `${entry.hash}.progress.json`);
}

function writeProgressSnapshot(entry, options, phase, detail = {}) {
  const progressFile = buildProgressFilePath(entry, options);
  if (!progressFile) {
    return;
  }

  ensureDir(path.dirname(progressFile));
  fs.writeFileSync(
    progressFile,
    JSON.stringify(
      {
        hash: entry.hash,
        phase,
        updatedAt: new Date().toISOString(),
        ...detail,
      },
      null,
      2
    ),
    'utf8'
  );
}

function formatProgressDetail(detail) {
  if (!detail || typeof detail !== 'object') {
    return '';
  }

  const parts = [];
  if (Number.isFinite(detail.referenceCount)) parts.push(`refs=${detail.referenceCount}`);
  if (Number.isFinite(detail.currentReference)) {
    parts.push(`ref=${detail.currentReference}/${detail.referenceCount || '?'}`);
  }
  if (detail.submitId) parts.push(`submit=${detail.submitId}`);
  if (detail.historyRecordId) parts.push(`history=${detail.historyRecordId}`);
  if (Number.isFinite(detail.finishedImageCount) || Number.isFinite(detail.totalImageCount)) {
    parts.push(`images=${detail.finishedImageCount ?? '?'}/${detail.totalImageCount ?? '?'}`);
  }
  if (Number.isFinite(detail.domCandidateCount)) parts.push(`dom=${detail.domCandidateCount}`);
  if (Number.isFinite(detail.newDomCandidateCount)) parts.push(`newDom=${detail.newDomCandidateCount}`);
  if (Number.isFinite(detail.visibleDomCandidateCount)) parts.push(`visibleDom=${detail.visibleDomCandidateCount}`);
  if (Number.isFinite(detail.previewCandidateCount)) parts.push(`preview=${detail.previewCandidateCount}`);
  if (Number.isFinite(detail.downloadableCount)) parts.push(`downloadable=${detail.downloadableCount}`);
  if (Number.isFinite(detail.domStableForMs)) parts.push(`domStableMs=${detail.domStableForMs}`);
  if (Number.isFinite(detail.matchedDomCandidateCount)) parts.push(`matchedDom=${detail.matchedDomCandidateCount}`);
  if (Number.isFinite(detail.expectedItemCount)) parts.push(`expectedItems=${detail.expectedItemCount}`);
  if (Number.isFinite(detail.historyPollAttempts)) parts.push(`historyPolls=${detail.historyPollAttempts}`);
  if (Number.isFinite(detail.candidateIndex) && Number.isFinite(detail.candidateTotal)) {
    parts.push(`candidate=${detail.candidateIndex}/${detail.candidateTotal}`);
  }
  if (detail.variantPath) parts.push(`saved=${path.basename(detail.variantPath)}`);
  if (detail.error) parts.push(`error=${detail.error}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function logEntryProgress(entry, options, phase, message, detail = {}) {
  console.log(`[jimeng] [${entry.hash}] ${message}${formatProgressDetail(detail)}`);
  writeProgressSnapshot(entry, options, phase, detail);
}

function normalizeWorkspaceId(value) {
  const raw = String(value ?? '').trim();
  if (raw === '0') return '0';
  const contextualIds = extractWorkspaceIdsFromText(raw);
  if (contextualIds.length > 0) return contextualIds[0];
  return /^\d{14}$/.test(raw) ? raw : '';
}

function parseWorkspaceIds(value) {
  const raw = String(value ?? '');
  const ids = new Set(extractWorkspaceIdsFromText(raw));
  for (const token of raw
    .split(/[,;\s]+/)
    .map(item => item.trim())
    .filter(Boolean)) {
    if (token === '0' || /^\d{14}$/.test(token)) ids.add(token);
  }
  return [...ids];
}

function extractWorkspaceIdsFromText(value) {
  const text = String(value ?? '');
  const ids = new Set();
  const patterns = [
    /[?&]workspace=(\d{1,20})/gi,
    /\bworkspace(?:Id|_id)?\b["'\s:=?&%-]{0,40}(\d{1,20})/gi,
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(text);
    while (match) {
      const id = match[1];
      if (id === '0' || /^\d{14}$/.test(id)) ids.add(id);
      match = pattern.exec(text);
    }
  }
  return [...ids];
}

function loadWorkspacePool(poolFile) {
  if (!fs.existsSync(poolFile)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(poolFile, 'utf8'));
    const raw = Array.isArray(parsed) ? parsed : parsed.workspaces;
    return (Array.isArray(raw) ? raw : [])
      .map(item => (typeof item === 'string' ? { id: item } : item))
      .map(item => ({
        id: normalizeWorkspaceId(item?.id ?? item?.workspaceId),
        lastSeenAt: item?.lastSeenAt || item?.updatedAt || '',
        source: item?.source || 'pool',
      }))
      .filter(item => item.id);
  } catch {
    return [];
  }
}

function saveWorkspacePool(poolFile, workspaceIds, source = 'scan') {
  ensureDir(path.dirname(poolFile));
  const previous = loadWorkspacePool(poolFile);
  const byId = new Map(previous.map(item => [item.id, item]));
  const now = new Date().toISOString();

  const normalizedIds = workspaceIds.map(normalizeWorkspaceId).filter(Boolean);
  const hasRealWorkspace = normalizedIds.some(id => id !== '0');
  for (const id of normalizedIds.filter(id => !hasRealWorkspace || id !== '0')) {
    byId.set(id, {
      ...(byId.get(id) || {}),
      id,
      lastSeenAt: now,
      source,
    });
  }

  const workspaces = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  fs.writeFileSync(
    poolFile,
    JSON.stringify(
      {
        updatedAt: now,
        workspaces,
      },
      null,
      2
    ),
    'utf8'
  );
  return workspaces;
}

function removeDirSafe(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function copyProfileForWorker(sourceDir, destinationDir) {
  const skipNames = new Set([
    'Cache',
    'Code Cache',
    'GPUCache',
    'GrShaderCache',
    'ShaderCache',
    'Crashpad',
    'DawnGraphiteCache',
    'DawnWebGPUCache',
    'Safe Browsing',
  ]);

  fs.cpSync(sourceDir, destinationDir, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: source => {
      const name = path.basename(source);
      if (skipNames.has(name)) return false;
      if (/^Singleton/i.test(name)) return false;
      if (/\.lock$/i.test(name)) return false;
      if (name === 'LOCK') return false;
      return true;
    },
  });
}

function writeTextToSystemClipboard(text) {
  const tempPath = path.join(os.tmpdir(), `jimeng-prompt-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  fs.writeFileSync(tempPath, String(text ?? ''), 'utf8');

  try {
    const command = `$content = Get-Content -LiteralPath '${tempPath.replace(/'/g, "''")}' -Raw -Encoding UTF8; Set-Clipboard -Value $content`;
    const result = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { encoding: 'utf8' }
    );

    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `Set-Clipboard exited with ${result.status}`);
    }
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function parseArgs(argv) {
  const options = {
    manifest: DEFAULT_MANIFEST_FILE,
    outDir: DEFAULT_OUT_DIR,
    logDir: DEFAULT_LOG_DIR,
    profileDir: DEFAULT_PROFILE_DIR,
    browser: resolveBrowserExecutable(),
    headless: false,
    keepBrowserOpen: true,
    limit: null,
    hashes: null,
    anchor: null,
    subjectTag: DEFAULT_SUBJECT_TAG,
    force: false,
    retryErrorsFrom: null,
    maxRetries: 2,
    promoteFirst: true,
    resultTimeoutMs: DEFAULT_RESULT_TIMEOUT_MS,
    loginTimeoutMs: DEFAULT_LOGIN_TIMEOUT_MS,
    minImageBytes: DEFAULT_MIN_IMAGE_BYTES,
    concurrency: null,
    paceMs: 1500,
    promptProfile: 'default',
    pageTimeoutMs: DEFAULT_PAGE_TIMEOUT_MS,
    submitTimeoutMs: DEFAULT_SUBMIT_TIMEOUT_MS,
    workspaceIds: [],
    workspacePoolFile: path.resolve(DEFAULT_WORKSPACE_POOL_FILE),
    scanWorkspaces: true,
    scanProfileWorkspaces: true,
    scanLogWorkspaces: true,
    scanOnly: false,
    cleanupConversations: false,
    keepConversations: 5,
    sessionOut: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--manifest':
        options.manifest = path.resolve(next);
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
        options.profileDir = next;
        index += 1;
        break;
      case '--browser':
        options.browser = next;
        index += 1;
        break;
      case '--anchor':
        options.anchor = path.resolve(next);
        index += 1;
        break;
      case '--subject-tag':
        options.subjectTag = next;
        index += 1;
        break;
      case '--no-subject-tag':
        options.subjectTag = '';
        break;
      case '--force':
        options.force = true;
        break;
      case '--retry-errors-from':
        options.retryErrorsFrom = path.resolve(next);
        index += 1;
        break;
      case '--max-retries':
        options.maxRetries = Number(next);
        index += 1;
        break;
      case '--limit':
        options.limit = Number(next);
        index += 1;
        break;
      case '--hashes':
        options.hashes = new Set(next.split(',').map(value => value.trim()).filter(Boolean));
        index += 1;
        break;
      case '--headless':
        options.headless = true;
        break;
      case '--keep-browser-open':
        options.keepBrowserOpen = true;
        break;
      case '--close-browser-on-exit':
        options.keepBrowserOpen = false;
        break;
      case '--no-promote-first':
        options.promoteFirst = false;
        break;
      case '--result-timeout-ms':
        options.resultTimeoutMs = Number(next);
        index += 1;
        break;
      case '--login-timeout-ms':
        options.loginTimeoutMs = Number(next);
        index += 1;
        break;
      case '--min-image-bytes':
        options.minImageBytes = Number(next);
        index += 1;
        break;
      case '--concurrency':
        options.concurrency = Number(next);
        index += 1;
        break;
      case '--pace-ms':
        options.paceMs = Number(next);
        index += 1;
        break;
      case '--prompt-profile':
        options.promptProfile = String(next || '').trim() || 'default';
        index += 1;
        break;
      case '--workspace-id':
        options.workspaceIds = [normalizeWorkspaceId(next) || '0'];
        index += 1;
        break;
      case '--workspace-ids':
        options.workspaceIds = parseWorkspaceIds(next);
        index += 1;
        break;
      case '--workspace-pool-file':
        options.workspacePoolFile = path.resolve(next);
        index += 1;
        break;
      case '--no-workspace-scan':
        options.scanWorkspaces = false;
        break;
      case '--no-profile-workspace-scan':
        options.scanProfileWorkspaces = false;
        break;
      case '--no-log-workspace-scan':
        options.scanLogWorkspaces = false;
        break;
      case '--scan-only':
        options.scanOnly = true;
        break;
      case '--cleanup-conversations':
        options.cleanupConversations = true;
        break;
      case '--keep-conversations':
        options.keepConversations = Number(next);
        index += 1;
        break;
      case '--session-out':
        options.sessionOut = path.resolve(next);
        index += 1;
        break;
      case '--page-timeout-ms':
        options.pageTimeoutMs = Number(next);
        index += 1;
        break;
      case '--submit-timeout-ms':
        options.submitTimeoutMs = Number(next);
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

  if (
    options.concurrency !== null &&
    (!Number.isFinite(options.concurrency) || options.concurrency < 1)
  ) {
    throw new Error(`Invalid --concurrency value: ${options.concurrency}`);
  }

  if (!Number.isFinite(options.paceMs) || options.paceMs < 0) {
    throw new Error(`Invalid --pace-ms value: ${options.paceMs}`);
  }

  if (!['default', 'retry-safe'].includes(options.promptProfile)) {
    throw new Error(`Invalid --prompt-profile value: ${options.promptProfile}`);
  }

  if (!Number.isFinite(options.pageTimeoutMs) || options.pageTimeoutMs < 1) {
    throw new Error(`Invalid --page-timeout-ms value: ${options.pageTimeoutMs}`);
  }

  if (!Number.isFinite(options.submitTimeoutMs) || options.submitTimeoutMs < 1) {
    throw new Error(`Invalid --submit-timeout-ms value: ${options.submitTimeoutMs}`);
  }

  if (!Number.isFinite(options.keepConversations) || options.keepConversations < 0) {
    throw new Error(`Invalid --keep-conversations value: ${options.keepConversations}`);
  }

  return options;
}

function printHelp() {
  console.log(`
Usage:
  node scripts/jimengBatchGenerate.mjs [options]

Options:
  --anchor <path>             Optional legacy reference image upload
  --subject-tag <text>        Prefix prompt with subject mention, default: <none>
  --no-subject-tag            Disable automatic subject prefix
  --force                     Regenerate even if hash.jpg already exists
  --retry-errors-from <file>  Only rerun hashes found in a previous stderr log
  --max-retries <n>           Retry attempts per hash on transient browser errors
  --limit <n>                 Max prompt count to process
  --hashes <a,b,c>            Only process selected manifest hashes
  --out-dir <dir>             Output directory for final images
  --log-dir <dir>             JSON log directory
  --manifest <file>           Image manifest JSON
  --profile-dir <dir>         Persistent browser profile for Jimeng
  --browser <path>            Chrome or Edge executable
  --headless                  Run without a visible browser window
  --keep-browser-open         Keep the visible single-session browser open after the run, default on
  --close-browser-on-exit     Close the visible browser after the run
  --concurrency <n>           Number of worker browser instances to run in parallel
  --pace-ms <ms>              Delay after each completed item per worker
  --prompt-profile <name>     Prompt profile: default | retry-safe
  --workspace-id <id>         Use a single Jimeng workspace id
  --workspace-ids <a,b,c>     Explicit reusable Jimeng workspace ids or workspace URLs
  --workspace-pool-file <file> JSON cache for discovered reusable workspace ids
  --no-workspace-scan         Do not scan current account/browser state for workspace ids
  --no-profile-workspace-scan Do not scan Chrome profile history/session files for workspace ids
  --no-log-workspace-scan     Do not scan log-dir JSON/text files for previous workspace ids
  --scan-only                 Login, scan workspace ids, write pool file, then exit
  --cleanup-conversations     Delete old Jimeng conversations before generation
  --keep-conversations <n>    Number of recent conversations to keep when cleaning up
  --session-out <file>        Write resolved workspace session metadata JSON
  --page-timeout-ms <ms>      Page-level wait timeout for selectors/navigation
  --submit-timeout-ms <ms>    Wait timeout for the generate POST request
  --no-promote-first          Keep only variants, do not copy v1 to hash.jpg
  --result-timeout-ms <ms>    Wait time per prompt after submit
  --login-timeout-ms <ms>     Wait time for manual login
  --min-image-bytes <n>       Skip downloaded files smaller than this
`);
}

async function withClipboardLock(fn) {
  const run = clipboardLock.then(fn, fn);
  clipboardLock = run.catch(() => {});
  return run;
}

function resolveBrowserExecutable() {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];

  const hit = candidates.find(candidate => fs.existsSync(candidate));
  if (!hit) {
    throw new Error('Could not find Chrome or Edge executable. Pass --browser explicitly.');
  }
  return hit;
}

function loadManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }

  const raw = fs.readFileSync(manifestPath, 'utf8');
  const parsed = JSON.parse(raw);
  const manifestDir = path.dirname(manifestPath);

  return parsed.map((entry, index) => {
    const prompt = decodePrompt(entry);
    const normalizedTask = normalizeUnifiedTask({
      ...entry,
      id: entry.id || entry.taskId || entry.hash || `jimeng-task-${index + 1}`,
      prompt,
    });
    const resolvedReferenceImages = Array.isArray(normalizedTask.referenceImages)
      ? normalizedTask.referenceImages.map(reference => ({
          ...reference,
          path: reference?.path ? path.resolve(manifestDir, reference.path) : '',
        }))
      : [];
    return {
      ...normalizedTask,
      referenceImages: resolvedReferenceImages,
      hash: normalizedTask.id,
    };
  });
}

function loadHashesFromErrorLog(logPath) {
  if (!fs.existsSync(logPath)) {
    throw new Error(`Retry error log not found: ${logPath}`);
  }

  const text = fs.readFileSync(logPath, 'utf8');
  const hashes = [...text.matchAll(/failed ([0-9a-f]+):/gi)].map(match => match[1]);
  return new Set(hashes);
}

function decodePrompt(entry) {
  if (entry.prompt && typeof entry.prompt === 'string') {
    return entry.prompt;
  }

  if (!entry.url) {
    throw new Error(`Manifest entry ${entry.id ?? entry.taskId ?? entry.hash ?? '<unknown>'} does not contain prompt or url.`);
  }

  const value = new URL(entry.url).searchParams.get('prompt');
  if (!value) {
    throw new Error(`Could not decode prompt for ${entry.id ?? entry.taskId ?? entry.hash ?? '<unknown>'}.`);
  }

  return value;
}

function buildQueue(manifest, options) {
  const base = manifest.filter(entry => {
    if (options.hashes && !options.hashes.has(entry.hash)) {
      return false;
    }

    const existingOutputs = findExistingOutputFiles(options.outDir, entry.hash, options.minImageBytes);
    if (!options.force && existingOutputs.length > 0) {
      return false;
    }

    return true;
  });

  if (options.limit && Number.isFinite(options.limit)) {
    return base.slice(0, options.limit);
  }

  return base;
}

function applyRequestedHashes(options) {
  if (!options.retryErrorsFrom) {
    return options;
  }

  const failedHashes = loadHashesFromErrorLog(options.retryErrorsFrom);
  if (failedHashes.size === 0) {
    throw new Error(`No failed hashes found in ${options.retryErrorsFrom}`);
  }

  if (options.hashes) {
    options.hashes = new Set([...options.hashes].filter(hash => failedHashes.has(hash)));
  } else {
    options.hashes = failedHashes;
  }

  return options;
}

function buildPrompt(entry, options) {
  if (options.promptProfile === 'default' && entry.providerPrompt) {
    return normalizeText([options.subjectTag, entry.providerPrompt].join(' '));
  }

  if (options.promptProfile === 'default') {
    return normalizeText(
      [options.subjectTag, buildUnifiedPrompt(entry, { provider: 'jimeng', joinWith: ' ' })].join(' ')
    );
  }

  const providerPrompt = buildJimengPrompt(entry.scenePrompt || entry.prompt, {
    size: entry.size,
    cluster: entry.cluster,
    sourceKind: entry.sourceKind,
    promptProfile: options.promptProfile,
    subjectTag: options.subjectTag,
  });

  return normalizeText(
    [options.subjectTag, buildUnifiedPrompt({ ...entry, providerPrompt }, { provider: 'jimeng', joinWith: ' ' })].join(' ')
  );
}

async function fetchAccountInfo(page) {
  return page.evaluate(async () => {
    try {
      const query = new URLSearchParams({
        aid: '513695',
        account_sdk_source: 'web',
        sdk_version: '2.2.6',
      });
      const response = await fetch(`/passport/account/info/v2/?${query.toString()}`, {
        credentials: 'include',
      });
      return await response.json();
    } catch (error) {
      return {
        message: 'error',
        error: String(error),
      };
    }
  });
}

function isLoggedIn(accountInfo) {
  return Boolean(
    accountInfo?.message === 'success' ||
      accountInfo?.data?.user_id > 0 ||
      accountInfo?.data?.session_key
  );
}

async function ensureLoggedIn(page, options, workspaceId) {
  await gotoJimengPage(page, buildHomeUrl(workspaceId), options, 'login');
  await sleep(3000);

  let accountInfo = await fetchAccountInfo(page);
  if (isLoggedIn(accountInfo)) {
    console.log(`[jimeng] logged in as user ${accountInfo.data.user_id}`);
    return accountInfo;
  }

  if (options.headless) {
    throw new Error('Jimeng login is required. Re-run without --headless for manual login.');
  }

  console.log('[jimeng] Login required. Complete login in the opened browser window.');
  const deadline = Date.now() + options.loginTimeoutMs;

  while (Date.now() < deadline) {
    await sleep(3000);
    accountInfo = await fetchAccountInfo(page);
    if (isLoggedIn(accountInfo)) {
      console.log(`[jimeng] login detected for user ${accountInfo.data.user_id}`);
      return accountInfo;
    }
  }

  throw new Error('Timed out while waiting for Jimeng login.');
}

async function collectWorkspaceIdsFromPage(page) {
  const candidates = await page.evaluate(() => {
    const values = new Set();
    const addValue = value => {
      if (!value || typeof value !== 'string') return;
      if (/workspace/i.test(value)) values.add(value);
    };

    addValue(location.href);
    for (const element of document.querySelectorAll('a[href]')) {
      addValue(element.getAttribute('href'));
      addValue(element.href);
    }

    for (const storage of [localStorage, sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        addValue(key);
        addValue(storage.getItem(key));
      }
    }

    for (const entry of performance.getEntriesByType('resource')) {
      addValue(entry.name);
    }

    return [...values];
  });

  return parseWorkspaceIds(candidates.join('\n'));
}

function scanWorkspaceIdsFromFile(filePath, maxBytes = 20 * 1024 * 1024) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return [];
    const text = fs.readFileSync(filePath).toString('latin1');
    return parseWorkspaceIds(text);
  } catch {
    return [];
  }
}

function scanWorkspaceIdsFromDirectory(dirPath, options = {}) {
  const ids = new Set();
  const {
    maxFiles = 2000,
    maxBytes = 20 * 1024 * 1024,
    allowedExtensions = null,
  } = options;
  let scanned = 0;

  function walk(currentPath) {
    if (scanned >= maxFiles || !fs.existsSync(currentPath)) return;
    let entries = [];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (scanned >= maxFiles) break;
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const extension = path.extname(entry.name).toLowerCase();
        if (allowedExtensions && !allowedExtensions.has(extension)) continue;
        scanned += 1;
        for (const id of scanWorkspaceIdsFromFile(fullPath, maxBytes)) ids.add(id);
      }
    }
  }

  walk(dirPath);
  return [...ids];
}

function scanWorkspaceIdsFromProfile(profileDir) {
  const ids = new Set();
  const profileRoot = path.resolve(profileDir);
  const candidates = [
    path.join(profileRoot, 'History'),
    path.join(profileRoot, 'Default', 'History'),
    path.join(profileRoot, 'Local State'),
  ];

  for (const candidate of candidates) {
    for (const id of scanWorkspaceIdsFromFile(candidate)) ids.add(id);
  }

  for (const subdir of [
    path.join(profileRoot, 'Default', 'Sessions'),
    path.join(profileRoot, 'Default', 'Session Storage'),
    path.join(profileRoot, 'Default', 'Local Storage'),
  ]) {
    for (const id of scanWorkspaceIdsFromDirectory(subdir, { maxFiles: 500 })) ids.add(id);
  }

  return [...ids];
}

function scanWorkspaceIdsFromLogs(logDir) {
  return scanWorkspaceIdsFromDirectory(logDir, {
    maxFiles: 5000,
    maxBytes: 5 * 1024 * 1024,
    allowedExtensions: new Set(['.json', '.jsonl', '.log', '.txt']),
  });
}

async function scanWorkspacePage(page, workspaceId, options) {
  const responseTexts = new Set();
  const onResponse = async response => {
    const responseUrl = response.url();
    const headers = response.headers();
    const contentType = headers['content-type'] || '';
    const shouldInspect =
      /workspace/i.test(responseUrl) ||
      (/json|text|javascript/i.test(contentType) &&
        /(workspace|space|project|draft|aigc|mweb)/i.test(responseUrl));
    if (!shouldInspect) return;

    try {
      const text = await response.text();
      if (/workspace/i.test(text) || /workspace/i.test(responseUrl)) {
        responseTexts.add(`${responseUrl}\n${text.slice(0, 300000)}`);
      }
    } catch {
      // Some responses are streams or already unavailable; page/localStorage scan still runs.
    }
  };

  page.on('response', onResponse);
  try {
    await gotoJimengPage(page, buildHomeUrl(workspaceId), options, `workspace scan ${workspaceId}`);
    await sleep(3500);
  } finally {
    page.off('response', onResponse);
  }

  return [
    ...parseWorkspaceIds([...responseTexts].join('\n')),
    ...(await collectWorkspaceIdsFromPage(page)),
  ];
}

async function scanWorkspaceIds(page, options) {
  const ids = new Set();
  for (const id of options.workspaceIds) ids.add(id);
  for (const item of loadWorkspacePool(options.workspacePoolFile)) ids.add(item.id);

  if (options.scanProfileWorkspaces) {
    for (const id of scanWorkspaceIdsFromProfile(options.profileDir)) ids.add(id);
  }

  if (options.scanLogWorkspaces) {
    for (const id of scanWorkspaceIdsFromLogs(options.logDir)) ids.add(id);
  }

  if (!options.scanWorkspaces) {
    return [...ids];
  }

  const scanIds = options.workspaceIds.length > 0 ? options.workspaceIds : ['0'];
  for (const workspaceId of scanIds) {
    try {
      for (const id of await scanWorkspacePage(page, workspaceId, options)) {
        ids.add(id);
      }
    } catch (error) {
      console.warn(`[jimeng] workspace scan skipped ${workspaceId}: ${String(error)}`);
    }
  }

  return [...ids].map(normalizeWorkspaceId).filter(Boolean);
}

function resolveConcurrency(maxSlots, options) {
  const fallback = Math.max(1, Math.min(maxSlots, Number(options.concurrency || 1) || 1));
  return fallback;
}

async function resolveWorkspacePlan(page, queue, options) {
  if (options.workspaceIds.length > 0) {
    const configuredIds = [...new Set(options.workspaceIds.map(normalizeWorkspaceId).filter(Boolean))];
    const pool = saveWorkspacePool(options.workspacePoolFile, configuredIds, 'configured');
    const maxSlots = Math.max(1, Math.min(configuredIds.length, queue.length || configuredIds.length));
    const concurrency = options.scanOnly ? 0 : resolveConcurrency(maxSlots, options);
    return {
      scannedIds: configuredIds,
      pool,
      workspaceIds: configuredIds,
      concurrency,
      mode: 'configured',
    };
  }

  if (!options.scanOnly) {
    const ids = ['0'];
    const pool = saveWorkspacePool(options.workspacePoolFile, ids, 'bootstrap');
    return {
      scannedIds: ids,
      pool,
      workspaceIds: ids,
      concurrency: 1,
      mode: 'bootstrap',
    };
  }

  const scannedIds = await scanWorkspaceIds(page, options);
  let pool = saveWorkspacePool(options.workspacePoolFile, scannedIds, 'scan');
  let ids = pool.map(item => item.id);
  if (ids.some(id => id !== '0')) {
    ids = ids.filter(id => id !== '0');
  }

  if (ids.length === 0) {
    ids = ['0'];
    pool = saveWorkspacePool(options.workspacePoolFile, ids, 'fallback');
    console.warn('[jimeng] No reusable workspace id discovered. Falling back to workspace=0.');
  }

  const maxSlots = Math.max(1, Math.min(ids.length, queue.length || ids.length));
  const concurrency = options.scanOnly ? 0 : resolveConcurrency(maxSlots, options);

  return {
    scannedIds,
    pool,
    workspaceIds: ids,
    concurrency,
    mode: 'scan',
  };
}

async function resolveActiveWorkspace(page, fallbackWorkspaceId) {
  const pageUrl = page.url() || '';
  const directIds = parseWorkspaceIds(pageUrl);
  if (directIds.some(id => id !== '0')) {
    const resolvedId = directIds.find(id => id !== '0') || directIds[0];
    return {
      workspaceId: resolvedId,
      workspaceUrl: buildHomeUrl(resolvedId),
    };
  }

  const discoveredIds = await collectWorkspaceIdsFromPage(page);
  if (discoveredIds.some(id => id !== '0')) {
    const resolvedId = discoveredIds.find(id => id !== '0') || discoveredIds[0];
    return {
      workspaceId: resolvedId,
      workspaceUrl: buildHomeUrl(resolvedId),
    };
  }

  const fallbackId = normalizeWorkspaceId(fallbackWorkspaceId) || '0';
  return {
    workspaceId: fallbackId,
    workspaceUrl: buildHomeUrl(fallbackId),
  };
}

async function readImageGenerationModeState(page) {
  return page.evaluate(() => {
    const promptText = document.body.innerText || '';
    const comboTexts = Array.from(document.querySelectorAll('[role="combobox"]')).map(element =>
      (element.innerText || '').trim()
    );

    return {
      title: document.title || '',
      url: location.href,
      promptText,
      comboTexts,
    };
  });
}

function isImageGenerationModeState(state) {
  const isImagePrompt =
    state.promptText.includes('上传参考图') &&
    (state.promptText.includes('描述你想生成的图片') || state.promptText.includes('主体'));
  const hasImageModeCombo = state.comboTexts.some(text => text.includes('图片生成'));
  return isImagePrompt && hasImageModeCombo;
}

async function ensureImageGenerationMode(page, options, workspaceId) {
  let state = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    state = await readImageGenerationModeState(page);
    if (isImageGenerationModeState(state)) {
      return;
    }

    console.warn(
      `[jimeng] image mode check ${attempt}/4 failed in workspace ${workspaceId}: title=${JSON.stringify(
        state?.title ?? ''
      )} url=${JSON.stringify(state?.url ?? '')} combos=${JSON.stringify(state?.comboTexts ?? [])}`
    );

    if (attempt === 2) {
      console.warn(`[jimeng] reloading Jimeng image page for workspace ${workspaceId} after mode mismatch.`);
      await gotoJimengPage(
        page,
        buildHomeUrl(workspaceId),
        options,
        `image mode recovery workspace ${workspaceId}`
      );
    }

    await sleep(2500);
  }

  throw new Error(
    `Jimeng page is not in image generation mode after recovery: title=${JSON.stringify(
      state?.title ?? ''
    )} url=${JSON.stringify(state?.url ?? '')} combos=${JSON.stringify(state?.comboTexts ?? [])}`
  );
}

async function openConversationDropdown(page) {
  const clicked = await page.evaluate(() => {
    const trigger = document.querySelector('.trigger-kW8zSX');
    if (!trigger) return false;
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  });

  if (!clicked) {
    throw new Error('Conversation dropdown trigger not found.');
  }

  await sleep(1200);
}

async function listConversationItems(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.workspace-item-xFLyjC')).map((element, index) => ({
      index,
      text: (element.innerText || '').trim(),
      className: String(element.className || ''),
      title:
        element.querySelector('.title-vbUvV2')?.getAttribute('title') ||
        element.querySelector('.title-vbUvV2')?.textContent ||
        '',
      timestamp: element.querySelector('.timestamp-nlc6sq')?.textContent?.trim() || '',
    }))
  );
}

async function clickConversationMore(page, index) {
  const clicked = await page.evaluate(targetIndex => {
    const items = Array.from(document.querySelectorAll('.workspace-item-xFLyjC'));
    const item = items[targetIndex];
    if (!item) return false;
    const target = Array.from(item.querySelectorAll('button,div,span')).find(el => {
      const cls = String(el.className || '');
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && (cls.includes('more') || cls.includes('button'));
    });
    if (!target) return false;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  }, index);

  if (!clicked) {
    throw new Error(`Conversation more button not found for index ${index}.`);
  }

  await sleep(800);
}

async function deleteConversationAt(page, index) {
  await clickConversationMore(page, index);

  const deleteClicked = await page.evaluate(() => {
    const deleteItem = document.querySelector('.delete-item-ltjYzr');
    if (!deleteItem) return false;
    deleteItem.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  });

  if (!deleteClicked) {
    throw new Error(`Delete menu item not found for conversation index ${index}.`);
  }

  await sleep(800);

  const confirmed = await page.evaluate(() => {
    const modal = document.querySelector('.delete-confirm-modal-SJdNiN');
    if (!modal) return false;
    const buttons = Array.from(modal.querySelectorAll('button,div,span'));
    const target = buttons.find(el => (el.innerText || '').trim() === '删除');
    if (!target) return false;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  });

  if (!confirmed) {
    throw new Error(`Delete confirm button not found for conversation index ${index}.`);
  }

  await sleep(1200);
}

async function cleanupOldConversations(page, options) {
  await openConversationDropdown(page);
  let items = await listConversationItems(page);
  const deletable = items.filter(item => item.className.includes('has-more-button-mqBgwz'));
  const excess = Math.max(0, deletable.length - options.keepConversations);
  if (excess === 0) {
    console.log(`[jimeng] cleanup conversations: nothing to delete (keep ${options.keepConversations})`);
    return;
  }

  console.log(
    `[jimeng] cleanup conversations: deleting ${excess} old conversation(s), keeping ${options.keepConversations}`
  );

  for (let count = 0; count < excess; count += 1) {
    items = await listConversationItems(page);
    const currentDeletable = items
      .map((item, index) => ({ ...item, index }))
      .filter(item => item.className.includes('has-more-button-mqBgwz'));
    const target = currentDeletable[currentDeletable.length - 1];
    if (!target) break;
    console.log(`[jimeng] cleanup deleting: ${target.title || target.text || `conversation-${target.index}`}`);
    await deleteConversationAt(page, target.index);
    await sleep(800);
    await openConversationDropdown(page);
  }
}

function collectReferencePaths(entry, anchorPath) {
  const orderedPaths = [];
  const seen = new Set();

  const appendPath = candidate => {
    const normalized = normalizeText(candidate);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    if (!fs.existsSync(normalized)) {
      console.warn(`[jimeng] reference image not found, skip: ${normalized}`);
      return;
    }
    seen.add(normalized);
    orderedPaths.push(normalized);
  };

  appendPath(anchorPath);
  for (const reference of Array.isArray(entry?.referenceImages) ? entry.referenceImages : []) {
    appendPath(reference?.path);
  }

  return orderedPaths;
}

async function uploadReference(page, referencePath, index, total) {
  const fileInput = await page.$('input[type=file]');
  if (!fileInput) {
    throw new Error('Reference image uploader not found.');
  }

  const auditResponse = page
    .waitForResponse(
      response =>
        response.url().includes('/mweb/v1/imagex/submit_audit_job') &&
        response.request().method() === 'POST',
      { timeout: 30000 }
    )
    .catch(() => null);

  console.log(`[jimeng] uploading reference ${index}/${total}: ${path.basename(referencePath)}`);
  await fileInput.uploadFile(referencePath);

  const response = await auditResponse;
  if (response) {
    const payload = await safeResponseJson(response);
    if (payload?.ret && payload.ret !== '0') {
      throw new Error(`Reference image audit failed: ${JSON.stringify(payload)}`);
    }
  }

  await sleep(1200);
  console.log(`[jimeng] uploaded reference ${index}/${total}: ${path.basename(referencePath)}`);
}

async function uploadReferences(page, entry, anchorPath) {
  const referencePaths = collectReferencePaths(entry, anchorPath);
  for (let index = 0; index < referencePaths.length; index += 1) {
    await uploadReference(page, referencePaths[index], index + 1, referencePaths.length);
  }
  return referencePaths;
}

async function safeResponseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function resolvePromptHandle(page) {
  const handle = await page.evaluateHandle(() => {
    const isVisible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 200 && rect.height > 20 && style.display !== 'none' && style.visibility !== 'hidden';
    };

    const editableCandidates = Array.from(
      document.querySelectorAll('[contenteditable="true"].tiptap.ProseMirror')
    )
      .filter(isVisible)
      .sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return rightRect.width * rightRect.height - leftRect.width * leftRect.height;
      });

    return editableCandidates[0] ?? null;
  });

  const promptTarget = handle.asElement();
  if (!promptTarget) {
    throw new Error('Prompt input not found.');
  }

  return promptTarget;
}

async function clearPrompt(page, promptTarget) {
  await promptTarget.click({ clickCount: 1 });
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await sleep(300);
  await page.evaluate(target => {
    if (!target) return;
    target.innerHTML = '<p><br class="ProseMirror-trailingBreak"></p>';
    target.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
  }, promptTarget);
  await sleep(300);
}

async function readPrompt(page, promptTarget) {
  const text = await page.evaluate(target => {
    if (!target) return '';
    return (target.innerText || target.textContent || '').trim();
  }, promptTarget);

  return normalizeText(text);
}

async function writePromptViaDom(page, promptTarget, prompt) {
  await page.evaluate(
    (target, value) => {
      if (!target) return;
      const safeValue = String(value ?? '');
      target.innerHTML = '';
      const paragraph = document.createElement('p');
      paragraph.textContent = safeValue;
      target.appendChild(paragraph);
      target.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: safeValue }));
    },
    promptTarget,
    prompt
  );
}

async function waitForPromptMatch(page, promptTarget, expectedPrompt, attempts = 4, waitMs = 500) {
  let actual = '';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await sleep(waitMs);
    }
    actual = await readPrompt(page, promptTarget);
    if (actual === expectedPrompt) {
      return { matched: true, actual };
    }
  }
  return { matched: false, actual };
}

async function fillPrompt(page, prompt, options) {
  const promptTarget = await resolvePromptHandle(page);
  await clearPrompt(page, promptTarget);
  await promptTarget.click({ clickCount: 1 });
  const expectedPrompt = normalizeText(prompt);
  let pasted = false;
  if (options.concurrency === 1) {
    try {
      pasted = await withClipboardLock(async () => {
        writeTextToSystemClipboard(prompt);
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyV');
        await page.keyboard.up('Control');
        return true;
      });
    } catch {
      pasted = false;
    }
  }

  if (!pasted) {
    await writePromptViaDom(page, promptTarget, prompt);
  }

  let verification = await waitForPromptMatch(page, promptTarget, expectedPrompt, pasted ? 5 : 4, 450);
  if (verification.matched) {
    return;
  }

  await writePromptViaDom(page, promptTarget, prompt);

  verification = await waitForPromptMatch(page, promptTarget, expectedPrompt, 5, 450);
  if (!verification.matched) {
    throw new Error(`Prompt write verification failed. expected="${expectedPrompt}" actual="${verification.actual}"`);
  }
}

async function clickSubmit(page, options) {
  const pendingResponse = page.waitForResponse(
    response =>
      response.url().includes('/mweb/v1/aigc_draft/generate') &&
      response.request().method() === 'POST',
    { timeout: options.submitTimeoutMs }
  );

  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button')).filter(button => {
      const className = typeof button.className === 'string' ? button.className : '';
      return className.includes('submit-button-');
    });
    const target = buttons.find(button => {
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return (
        !button.disabled &&
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0'
      );
    });

    if (!target) {
      return false;
    }

    target.click();
    return true;
  });

  if (!clicked) {
    throw new Error('Submit button is not clickable.');
  }

  const response = await pendingResponse;
  const payload = await safeResponseJson(response);
  if (payload?.ret && payload.ret !== '0') {
    throw new Error(`Generate request failed: ${JSON.stringify(payload)}`);
  }

  const aigcData = payload?.data?.aigc_data;
  const submitId = aigcData?.submit_id;
  const historyRecordId = String(aigcData?.history_record_id ?? '');
  const expectedItemIds = Array.isArray(aigcData?.pre_gen_item_ids)
    ? aigcData.pre_gen_item_ids.map(item => String(item ?? '')).filter(Boolean)
    : [];
  if (!submitId && !historyRecordId) {
    throw new Error(`Generate response missing submit id: ${JSON.stringify(payload)}`);
  }

  return {
    submitId,
    historyRecordId,
    expectedItemIds,
    payload,
  };
}

function collectImageUrls(value, result = new Set()) {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value) && isLikelyImageUrl(value)) {
      result.add(value);
    }
    return result;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectImageUrls(item, result);
    }
    return result;
  }

  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      collectImageUrls(nested, result);
    }
  }

  return result;
}

function isLikelyImageUrl(url) {
  if (!/(byteimg|jianying|capcut|imagex|tos-cn-i-tb4s082cfz)/i.test(url)) {
    return false;
  }

  return /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url) || /tplv|image|cover|tos-cn-i-tb4s082cfz/i.test(url);
}

function parseResizeDimensions(url) {
  const match = String(url ?? '').match(/(?:aigc_)?resize:(\d+):(\d+)/i);
  if (!match) {
    return null;
  }

  return {
    width: Number(match[1]),
    height: Number(match[2]),
  };
}

function isExplicitOriginalImageUrl(url) {
  return /resize:0:0\.image/i.test(String(url ?? ''));
}

function isLikelyThumbnailImageUrl(url) {
  const resize = parseResizeDimensions(url);
  if (!resize || resize.width <= 0 || resize.height <= 0) {
    return false;
  }

  return resize.width * resize.height < DEFAULT_MIN_PREVIEW_IMAGE_AREA;
}

function isLikelyDownloadableImageUrl(url) {
  if (!isLikelyImageUrl(url)) {
    return false;
  }

  if (isExplicitOriginalImageUrl(url)) {
    return true;
  }

  const resize = parseResizeDimensions(url);
  if (!resize) {
    return true;
  }

  return resize.width > 0 && resize.height > 0 && resize.width * resize.height >= DEFAULT_MIN_PREVIEW_IMAGE_AREA;
}

function scoreImageUrl(url) {
  if (!isLikelyImageUrl(url)) {
    return Number.NEGATIVE_INFINITY;
  }

  const resize = parseResizeDimensions(url);
  const resizeArea = resize ? resize.width * resize.height : 0;
  const originalScore = isExplicitOriginalImageUrl(url) ? 4_000_000 : 0;
  const unresizedScore = resize ? 0 : 3_000_000;
  const largeResizeScore = resizeArea >= DEFAULT_MIN_PREVIEW_IMAGE_AREA ? 1_500_000 : 0;
  const thumbnailPenalty = isLikelyThumbnailImageUrl(url) ? -2_000_000 : 0;
  const nonWebpBonus = /\.webp(\?|$)/i.test(url) ? 0 : 1000;
  return originalScore + unresizedScore + largeResizeScore + resizeArea + thumbnailPenalty + nonWebpBonus;
}

function rankImageUrls(urls) {
  return dedupeStable(urls)
    .filter(Boolean)
    .map((url, index) => ({
      url,
      index,
      score: scoreImageUrl(url),
    }))
    .filter(item => Number.isFinite(item.score))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(item => item.url);
}

function guessExtension(url, contentType) {
  const type = contentType?.toLowerCase() ?? '';
  if (type.includes('png')) return '.png';
  if (type.includes('webp')) return '.webp';
  if (type.includes('gif')) return '.gif';
  if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';

  const match = url.match(/\.(png|jpe?g|webp|gif)(\?|$)/i);
  if (match) {
    const ext = match[1].toLowerCase();
    return ext === 'jpeg' ? '.jpg' : `.${ext}`;
  }

  return '.jpg';
}

async function snapshotPageImages(page) {
  const images = await page.evaluate(() => {
    const isVisible = image => {
      const rect = image.getBoundingClientRect();
      const style = getComputedStyle(image);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };

    return Array.from(document.querySelectorAll('img'))
      .filter(isVisible)
      .map(image => ({
        src: image.currentSrc || image.src || '',
        width: image.naturalWidth || 0,
        height: image.naturalHeight || 0,
        top: image.getBoundingClientRect().top,
        left: image.getBoundingClientRect().left,
      }))
      .filter(item => item.width >= 200 && item.height >= 200 && /^https?:\/\//i.test(item.src));
  });

  return images.filter(item => isLikelyImageUrl(item.src));
}

function normalizeImageAssetKey(url) {
  if (!url) return '';

  const strippedQuery = url.split('?')[0];
  const resizeIndex = strippedQuery.indexOf('~tplv-');
  if (resizeIndex >= 0) {
    return strippedQuery.slice(0, resizeIndex);
  }

  return strippedQuery;
}

function dedupePageImages(images) {
  const bestByKey = new Map();
  for (const image of images) {
    const key = normalizeImageAssetKey(image.src);
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

function pageImageSignature(images) {
  return images.map(item => `${item.key}|${item.width}x${item.height}|${Math.round(item.top)}|${Math.round(item.left)}`).join('\n');
}

async function waitForPageImagesStable(page, timeoutMs = DEFAULT_PRE_SUBMIT_IMAGE_SETTLE_MS, stableMs = DEFAULT_PRE_SUBMIT_IMAGE_STABLE_MS) {
  const deadline = Date.now() + timeoutMs;
  let latestImages = dedupePageImages(await snapshotPageImages(page));
  let lastSignature = pageImageSignature(latestImages);
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    await sleep(DEFAULT_PREVIEW_POLL_MS);
    latestImages = dedupePageImages(await snapshotPageImages(page));
    const nextSignature = pageImageSignature(latestImages);
    if (nextSignature !== lastSignature) {
      lastSignature = nextSignature;
      stableSince = Date.now();
      continue;
    }

    if (Date.now() - stableSince >= stableMs) {
      break;
    }
  }

  return latestImages;
}

async function collectPreviewSurfaceImages(page) {
  return page.evaluate(() => {
    const seen = new Set();
    const results = [];
    const pushUrl = (src, width = 0, height = 0, source = 'dom') => {
      const normalized = String(src ?? '').trim();
      if (!/^https?:\/\//i.test(normalized) || seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      results.push({
        src: normalized,
        width: Number(width) || 0,
        height: Number(height) || 0,
        source,
      });
    };
    const isVisible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const collectSrcset = (value, source) => {
      for (const item of String(value ?? '').split(',')) {
        const [src] = item.trim().split(/\s+/);
        if (src) {
          pushUrl(src, 0, 0, source);
        }
      }
    };
    const collectBackgroundImages = element => {
      const backgroundImage = getComputedStyle(element).backgroundImage || '';
      const matches = backgroundImage.matchAll(/url\((['"]?)(.*?)\1\)/gi);
      for (const match of matches) {
        pushUrl(match[2], 0, 0, 'background-image');
      }
    };

    for (const image of Array.from(document.querySelectorAll('img')).filter(isVisible)) {
      pushUrl(image.currentSrc || image.src || '', image.naturalWidth || 0, image.naturalHeight || 0, 'img');
      collectSrcset(image.getAttribute('srcset'), 'img-srcset');
      const picture = image.closest('picture');
      if (picture) {
        for (const source of picture.querySelectorAll('source[srcset]')) {
          collectSrcset(source.getAttribute('srcset'), 'picture-source');
        }
      }
    }

    for (const element of Array.from(document.querySelectorAll('[style*="background"], [class]')).filter(isVisible)) {
      collectBackgroundImages(element);
    }

    return results;
  });
}

async function openPreviewAndCollectUrls(page, thumbnailSrc) {
  const startedAt = Date.now();
  const responseUrls = new Set();
  const onResponse = response => {
    const url = response.url();
    const contentType = String(response.headers()?.['content-type'] ?? '').toLowerCase();
    if (!isLikelyImageUrl(url) && !contentType.startsWith('image/')) {
      return;
    }
    responseUrls.add(url);
  };

  page.on('response', onResponse);
  const clicked = await page.evaluate(targetSrc => {
    const isVisible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };

    const hit = Array.from(document.querySelectorAll('img'))
      .filter(isVisible)
      .find(image => (image.currentSrc || image.src || '') === targetSrc);

    if (!hit) {
      return false;
    }

    hit.click();
    return true;
  }, thumbnailSrc);

  if (!clicked) {
    page.off('response', onResponse);
    return {
      clicked: false,
      urls: [thumbnailSrc],
      responseUrlCount: 0,
      previewImageCount: 0,
      downloadableCount: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  let previewImages = [];
  const previewDeadline = Date.now() + DEFAULT_PREVIEW_SETTLE_TIMEOUT_MS;
  while (Date.now() < previewDeadline) {
    previewImages = await collectPreviewSurfaceImages(page);
    const observedUrls = prioritizeCandidateUrls([
      ...responseUrls,
      ...previewImages.map(item => item.src),
    ]);
    if (observedUrls.some(isLikelyDownloadableImageUrl)) {
      break;
    }
    await sleep(DEFAULT_PREVIEW_POLL_MS);
  }

  try {
    await page.keyboard.press('Escape');
  } catch {
    // Ignore close failures; next page load resets the UI anyway.
  }
  await sleep(500);

  page.off('response', onResponse);

  const urls = prioritizeCandidateUrls([
    ...responseUrls,
    ...previewImages.map(item => item.src),
    thumbnailSrc,
  ]);
  return {
    clicked: true,
    urls,
    responseUrlCount: responseUrls.size,
    previewImageCount: previewImages.length,
    downloadableCount: urls.filter(isLikelyDownloadableImageUrl).length,
    durationMs: Date.now() - startedAt,
  };
}

function extractHistoryList(payload) {
  const data = payload?.data;
  const directCandidates = [
    data?.history_list,
    data?.list,
    data?.history_list_v2,
    data?.aigc_data_list,
    data?.histories,
  ];

  for (const candidate of directCandidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  if (
    data &&
    typeof data === 'object' &&
    (data.history_record_id || data.history_id || data.submit_id || data.item_list)
  ) {
    return [data];
  }

  if (
    data?.aigc_data &&
    typeof data.aigc_data === 'object' &&
    (data.aigc_data.history_record_id || data.aigc_data.history_id || data.aigc_data.submit_id || data.aigc_data.item_list)
  ) {
    return [data.aigc_data];
  }

  if (data && typeof data === 'object') {
    const mappedItems = Object.values(data).filter(
      value =>
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        (value.history_record_id || value.history_id || value.submit_id || value.item_list)
    );
    if (mappedItems.length > 0) {
      return mappedItems;
    }

    for (const value of Object.values(data)) {
      if (
        Array.isArray(value) &&
        value.some(item => item && typeof item === 'object' && (
          item.history_record_id ||
          item.history_id ||
          item.submit_id ||
          item.item_list
        ))
      ) {
        return value;
      }
    }
  }

  return [];
}

function pickBestImageUrl(urls) {
  return rankImageUrls(urls)[0] ?? null;
}

function extractItemUrls(historyItem) {
  const itemList = Array.isArray(historyItem?.item_list) ? historyItem.item_list : [];
  return itemList
    .map(item => pickBestImageUrl(Array.from(collectImageUrls(item))))
    .filter(Boolean);
}

function extractExpectedItemIds(submitInfo) {
  return Array.isArray(submitInfo?.expectedItemIds)
    ? submitInfo.expectedItemIds.map(item => String(item ?? '')).filter(Boolean)
    : [];
}

function matchesHistoryItem(item, submitInfo) {
  const historyRecordId = String(submitInfo?.historyRecordId ?? '');
  const submitId = String(submitInfo?.submitId ?? '');
  const expectedItemIds = new Set(extractExpectedItemIds(submitInfo));
  const itemList = Array.isArray(item?.item_list) ? item.item_list : [];
  const hasExpectedItem = itemList.some(historyItem => {
    const itemIds = [
      historyItem?.item_id,
      historyItem?.itemId,
      historyItem?.id,
      historyItem?.origin_item_id,
      historyItem?.originItemId,
    ].map(value => String(value ?? '')).filter(Boolean);
    return itemIds.some(itemId => expectedItemIds.has(itemId));
  });

  return (
    (historyRecordId && String(item?.history_record_id ?? '') === historyRecordId) ||
    (historyRecordId && String(item?.history_id ?? '') === historyRecordId) ||
    (submitId && String(item?.submit_id ?? '') === submitId) ||
    hasExpectedItem
  );
}

async function pollHistoryByIds(page, submitInfo) {
  const historyRecordId = String(submitInfo?.historyRecordId ?? '');
  if (!historyRecordId) {
    return null;
  }

  const requestBodies = [
    { history_ids: [historyRecordId] },
    { history_record_ids: [historyRecordId] },
    { history_record_id_list: [historyRecordId] },
    { ids: [historyRecordId] },
    { history_record_id: historyRecordId },
  ];

  return page.evaluate(async bodies => {
    const attempts = [];
    for (const body of bodies) {
      try {
        const response = await fetch('/mweb/v1/get_history_by_ids', {
          method: 'POST',
          credentials: 'include',
          headers: {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        const text = await response.text();
        let payload = null;
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { rawText: text.slice(0, 500) };
        }
        attempts.push({ body, status: response.status, ret: payload?.ret, errmsg: payload?.errmsg, payload });
        const data = payload?.data;
        const list = data?.history_list ?? data?.list ?? data?.history_list_v2 ?? data?.aigc_data_list ?? data?.histories ?? [];
        const mappedItems =
          data && typeof data === 'object'
            ? Object.values(data).filter(
                value =>
                  value &&
                  typeof value === 'object' &&
                  !Array.isArray(value) &&
                  (value.history_record_id || value.history_id || value.submit_id || value.item_list)
              )
            : [];
        const singleton =
          data &&
          typeof data === 'object' &&
          (data.history_record_id || data.history_id || data.submit_id || data.item_list || data.aigc_data);
        if ((Array.isArray(list) && list.length > 0) || mappedItems.length > 0 || singleton) {
          return { ok: true, body, status: response.status, payload, attempts };
        }
      } catch (error) {
        attempts.push({ body, error: String(error) });
      }
    }

    return { ok: false, attempts };
  }, requestBodies);
}

async function waitForGeneratedImages(page, options, submitInfo, beforePageImages, onProgress = () => {}) {
  const debugResponses = [];
  let completed = null;
  let completedUrls = [];
  let completedAt = 0;
  let lastMatchedState = null;
  let fatalError = null;
  let lastProgressAt = 0;
  const beforeKeys = new Set(beforePageImages.map(item => item.key));
  let newestDomUrls = [];
  let lastDomChangeAt = 0;
  let visibleDomUrls = [];
  let lastVisibleDomChangeAt = 0;
  let lastThumbnailOnlyUrls = [];
  let lastHistoryPollAt = 0;
  let historyPollAttempts = 0;
  const expectedItemIds = extractExpectedItemIds(submitInfo);
  const expectsHistoryBackedResult = Boolean(submitInfo.historyRecordId || expectedItemIds.length > 0);

  const processHistoryPayload = (payload, meta = {}) => {
    const historyList = extractHistoryList(payload);
    const matched = historyList.find(item => matchesHistoryItem(item, submitInfo));
    if (!matched) {
      debugResponses.push({
        source: meta.source || 'history',
        url: meta.url,
        status: meta.status,
        ret: payload?.ret,
        errmsg: payload?.errmsg,
        matched: false,
        historyListLength: historyList.length,
      });
      return false;
    }

    const itemList = Array.isArray(matched?.item_list) ? matched.item_list : [];
    lastMatchedState = {
      status: matched?.status,
      totalImageCount: matched?.total_image_count,
      finishedImageCount: matched?.finished_image_count,
      itemListLength: itemList.length,
      failCode: matched?.fail_code,
      failMsg: matched?.fail_msg,
    };
    debugResponses.push({
      source: meta.source || 'history',
      url: meta.url,
      status: meta.status,
      ret: payload?.ret,
      errmsg: payload?.errmsg,
      history: lastMatchedState,
    });

    const matchedUrls = dedupeStable(extractItemUrls(matched));
    if (
      matchedUrls.length !== completedUrls.length ||
      matchedUrls.some((item, index) => item !== completedUrls[index])
    ) {
      completedUrls = matchedUrls;
      debugResponses.push({
        source: `${meta.source || 'history'}-urls`,
        urls: matchedUrls,
      });
    }

    const total = Number(matched?.total_image_count ?? 0);
    const finished = Number(matched?.finished_image_count ?? 0);
    onProgress('history-update', {
      ...lastMatchedState,
      totalImageCount: total,
      finishedImageCount: finished,
      expectedItemCount: expectedItemIds.length,
      historyPollAttempts,
    });
    if (matched?.fail_code && matched.fail_code !== '0') {
      fatalError = new Error(`Jimeng generation failed: ${matched.fail_code} ${matched.fail_msg ?? ''}`.trim());
      return true;
    }

    const status = Number(matched?.status ?? 0);
    const allExpectedItemsMaterialized =
      expectedItemIds.length > 0 &&
      itemList.length >= expectedItemIds.length &&
      completedUrls.length > 0;
    const allReportedImagesFinished =
      total > 0 &&
      finished >= total &&
      itemList.length >= total;
    if (allReportedImagesFinished || allExpectedItemsMaterialized || (status >= 50 && itemList.length > 0)) {
      completed = matched;
      if (completedAt === 0) {
        completedAt = Date.now();
      }
    }

    return true;
  };

  const onResponse = async response => {
    const url = response.url();
    if (!url.includes('/mweb/v1/get_history_by_ids')) {
      return;
    }

    try {
      const payload = await response.json();
      processHistoryPayload(payload, { source: 'history-response', url, status: response.status() });
    } catch (error) {
      debugResponses.push({
        url,
        status: response.status(),
        error: String(error),
      });
    }
  };

  page.on('response', onResponse);

  try {
    const deadline = Date.now() + options.resultTimeoutMs;
    while (Date.now() < deadline) {
      if (fatalError) {
        throw fatalError;
      }

      const now = Date.now();
      if (
        expectsHistoryBackedResult &&
        submitInfo.historyRecordId &&
        now - lastHistoryPollAt >= DEFAULT_HISTORY_API_POLL_MS
      ) {
        lastHistoryPollAt = now;
        historyPollAttempts += 1;
        const pollResult = await pollHistoryByIds(page, submitInfo);
        if (pollResult?.payload) {
          processHistoryPayload(pollResult.payload, {
            source: 'history-poll',
            status: pollResult.status,
          });
        } else if (pollResult) {
          debugResponses.push({
            source: 'history-poll',
            matched: false,
            attempts: pollResult.attempts,
          });
        }
        if (fatalError) {
          throw fatalError;
        }
      }

      const currentPageImages = dedupePageImages(await snapshotPageImages(page));
      const newDomImages = currentPageImages.filter(item => !beforeKeys.has(item.key));
      const newDomUrls = newDomImages.map(item => item.src);
      if (newDomUrls.length !== newestDomUrls.length || newDomUrls.some((url, index) => url !== newestDomUrls[index])) {
        newestDomUrls = newDomUrls;
        lastDomChangeAt = Date.now();
        debugResponses.push({
          source: 'dom',
          uniqueImageCount: newDomImages.length,
          urls: newDomUrls,
        });
      }

      const visibleCandidates = currentPageImages.slice(-4);
      const nextVisibleDomUrls = visibleCandidates.map(item => item.src);
      if (
        nextVisibleDomUrls.length !== visibleDomUrls.length ||
        nextVisibleDomUrls.some((url, index) => url !== visibleDomUrls[index])
      ) {
        visibleDomUrls = nextVisibleDomUrls;
        lastVisibleDomChangeAt = Date.now();
        debugResponses.push({
          source: 'dom-visible',
          uniqueImageCount: visibleCandidates.length,
          urls: nextVisibleDomUrls,
        });
      }

      const completedKeys = new Set(completedUrls.map(item => normalizeImageAssetKey(item)).filter(Boolean));
      const historyMatchedDomImages =
        completedKeys.size > 0 ? newDomImages.filter(item => completedKeys.has(item.key)) : [];
      const allowUnverifiedDomFallback = !expectsHistoryBackedResult;
      const domCandidates =
        historyMatchedDomImages.length > 0
          ? historyMatchedDomImages
          : allowUnverifiedDomFallback
            ? newDomImages
            : [];
      const domStableAt = lastDomChangeAt;
      const domStableForMs = domStableAt > 0 ? Date.now() - domStableAt : 0;
      const stableGeneratedDomSet =
        domCandidates.length >= DEFAULT_MIN_STABLE_DOM_RESULT_COUNT &&
        domStableAt > 0 &&
        domStableForMs >= DEFAULT_STABLE_IMAGE_WAIT_MS;
      const generationLooksComplete =
        Boolean(completed) ||
        Number(lastMatchedState?.finishedImageCount ?? 0) > 0 ||
        (allowUnverifiedDomFallback && stableGeneratedDomSet);

      if (now - lastProgressAt >= DEFAULT_PROGRESS_LOG_INTERVAL_MS) {
        lastProgressAt = now;
        onProgress('waiting-results', {
          totalImageCount: Number(lastMatchedState?.totalImageCount ?? 0),
          finishedImageCount: Number(lastMatchedState?.finishedImageCount ?? 0),
          domCandidateCount: domCandidates.length,
          newDomCandidateCount: newDomImages.length,
          visibleDomCandidateCount: visibleCandidates.length,
          matchedDomCandidateCount: historyMatchedDomImages.length,
          previewCandidateCount: 0,
          domStableForMs,
          expectedItemCount: expectedItemIds.length,
          historyPollAttempts,
        });
      }

      if (
        generationLooksComplete &&
        domCandidates.length > 0 &&
        domStableAt > 0 &&
        Date.now() - domStableAt >= DEFAULT_STABLE_IMAGE_WAIT_MS
      ) {
        const previewCandidates = [];
        const previewTargets = domCandidates.slice(0, DEFAULT_PREVIEW_CANDIDATE_LIMIT);
        if (stableGeneratedDomSet && !completed && Number(lastMatchedState?.finishedImageCount ?? 0) === 0) {
          debugResponses.push({
            source: 'dom-stable-fallback',
            uniqueImageCount: newDomImages.length,
            domStableForMs,
            urls: previewTargets.map(item => item.src),
          });
          onProgress('dom-stable-fallback', {
            domCandidateCount: newDomImages.length,
            newDomCandidateCount: newDomImages.length,
            visibleDomCandidateCount: visibleCandidates.length,
            matchedDomCandidateCount: historyMatchedDomImages.length,
            previewCandidateCount: previewTargets.length,
            domStableForMs,
            expectedItemCount: expectedItemIds.length,
            historyPollAttempts,
          });
        }
        onProgress('preview-start', {
          totalImageCount: Number(lastMatchedState?.totalImageCount ?? 0),
          finishedImageCount: Number(lastMatchedState?.finishedImageCount ?? 0),
          domCandidateCount: domCandidates.length,
          newDomCandidateCount: newDomImages.length,
          visibleDomCandidateCount: visibleCandidates.length,
          matchedDomCandidateCount: historyMatchedDomImages.length,
          previewCandidateCount: previewTargets.length,
          expectedItemCount: expectedItemIds.length,
          historyPollAttempts,
        });
        for (let index = 0; index < previewTargets.length; index += 1) {
          const candidate = previewTargets[index];
          const previewResult = await openPreviewAndCollectUrls(page, candidate.src);
          previewCandidates.push(...previewResult.urls);
          debugResponses.push({
            source: 'preview',
            thumbnailUrl: candidate.src,
            ...previewResult,
          });
          onProgress('preview-candidate', {
            candidateIndex: index + 1,
            candidateTotal: previewTargets.length,
            domCandidateCount: domCandidates.length,
            newDomCandidateCount: newDomImages.length,
            visibleDomCandidateCount: visibleCandidates.length,
            matchedDomCandidateCount: historyMatchedDomImages.length,
            previewCandidateCount: previewTargets.length,
            downloadableCount: previewResult.downloadableCount,
            expectedItemCount: expectedItemIds.length,
            historyPollAttempts,
          });
        }
        const orderedUrls = prioritizeCandidateUrls([
          ...previewCandidates,
          ...completedUrls,
          ...domCandidates.map(item => item.src),
        ]);
        if (orderedUrls.some(isLikelyDownloadableImageUrl)) {
          onProgress('downloadable-results-ready', {
            downloadableCount: orderedUrls.filter(isLikelyDownloadableImageUrl).length,
            domCandidateCount: domCandidates.length,
            newDomCandidateCount: newDomImages.length,
            visibleDomCandidateCount: visibleCandidates.length,
            matchedDomCandidateCount: historyMatchedDomImages.length,
            previewCandidateCount: previewTargets.length,
            expectedItemCount: expectedItemIds.length,
            historyPollAttempts,
          });
          return {
            urls: orderedUrls,
            debugResponses,
            lastMatchedState: {
              ...(lastMatchedState ?? {}),
              domDetected: true,
              uniqueImageCount: domCandidates.length,
            },
          };
        }

        lastThumbnailOnlyUrls = orderedUrls;
        debugResponses.push({
          source: 'preview-thumbnail-only',
          urls: orderedUrls,
        });
      }

      if (
        completed &&
        completedUrls.length > 0 &&
        completedAt > 0 &&
        Date.now() - completedAt >= DEFAULT_STABLE_IMAGE_WAIT_MS
      ) {
        const orderedHistoryUrls = prioritizeCandidateUrls(completedUrls);
        if (orderedHistoryUrls.some(isLikelyDownloadableImageUrl)) {
          onProgress('downloadable-history-ready', {
            downloadableCount: orderedHistoryUrls.filter(isLikelyDownloadableImageUrl).length,
            totalImageCount: Number(lastMatchedState?.totalImageCount ?? 0),
            finishedImageCount: Number(lastMatchedState?.finishedImageCount ?? 0),
            expectedItemCount: expectedItemIds.length,
            historyPollAttempts,
          });
          return {
            urls: orderedHistoryUrls,
            debugResponses,
            lastMatchedState: {
              ...(lastMatchedState ?? {}),
              historyDetected: true,
              uniqueImageCount: completedUrls.length,
            },
          };
        }

        lastThumbnailOnlyUrls = orderedHistoryUrls;
        debugResponses.push({
          source: 'history-thumbnail-only',
          urls: orderedHistoryUrls,
        });
      }

      await sleep(DEFAULT_POLL_MS);
    }
  } finally {
    page.off('response', onResponse);
  }

  const thumbnailSummary =
    lastThumbnailOnlyUrls.length > 0 ? ` thumbnailCandidates=${JSON.stringify(lastThumbnailOnlyUrls)}` : '';
  throw new Error(
    `Timed out while waiting for generated preview/original images. lastState=${JSON.stringify(lastMatchedState)}${thumbnailSummary}`
  );
}

function dedupeStable(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
}

function prioritizeCandidateUrls(urls) {
  return rankImageUrls(urls);
}

function cleanupStaleOutputs(hash, outDir, keepPaths) {
  const keepSet = new Set(keepPaths.map(item => path.resolve(item)));
  const entries = fs.readdirSync(outDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith(hash)) continue;

    const absolutePath = path.resolve(path.join(outDir, entry.name));
    if (keepSet.has(absolutePath)) continue;
    fs.rmSync(absolutePath, { force: true });
  }
}

async function downloadImage(url, destination, minBytes) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < minBytes) {
    throw new Error(`Downloaded file is too small (${buffer.length} bytes)`);
  }

  fs.writeFileSync(destination, buffer);
}

async function saveVariants(entry, resultUrls, options) {
  ensureDir(options.outDir);
  const taskOutDir = buildTaskOutputDir(options.outDir, entry.hash);

  const variants = [];
  const skipped = [];
  if (resultUrls.length === 0) {
    throw new Error(`No generated image URL available for ${entry.hash}.`);
  }

  for (const selectedUrl of resultUrls) {
    try {
      if (!isLikelyDownloadableImageUrl(selectedUrl)) {
        throw new Error('known Jimeng thumbnail candidate');
      }

      const probe = await fetch(selectedUrl, { method: 'GET', redirect: 'follow' });
      if (!probe.ok) {
        throw new Error(`HTTP ${probe.status}`);
      }

      const contentType = probe.headers.get('content-type') ?? '';
      const extension = guessExtension(selectedUrl, contentType);
      const buffer = Buffer.from(await probe.arrayBuffer());
      if (buffer.length < options.minImageBytes) {
        throw new Error(`too small (${buffer.length} bytes)`);
      }

      const variantPath = path.join(taskOutDir, `${entry.hash}-v1${extension}`);
      fs.writeFileSync(variantPath, buffer);
      variants.push(variantPath);

      if (options.promoteFirst) {
        const finalPath = path.join(taskOutDir, `${entry.hash}.jpg`);
        fs.copyFileSync(variantPath, finalPath);
        cleanupStaleOutputs(entry.hash, taskOutDir, [variantPath, finalPath]);
      } else {
        cleanupStaleOutputs(entry.hash, taskOutDir, [variantPath]);
      }
      break;
    } catch (error) {
      skipped.push({
        url: selectedUrl,
        reason: String(error),
      });
    }
  }

  if (variants.length === 0) {
    const error = new Error(
      `No valid variants downloaded for ${entry.hash}. Skipped: ${JSON.stringify(skipped)}`
    );
    error.skipped = skipped;
    error.resultUrls = resultUrls;
    throw error;
  }

  return {
    variants,
    skipped,
    outputDir: taskOutDir,
  };
}

function buildFailedSummary(entry, error) {
  return {
    hash: entry.hash,
    prompt: entry.prompt,
    providerPrompt: entry.providerPrompt || '',
    error: String(error),
    resultUrls: Array.isArray(error?.resultUrls) ? error.resultUrls : [],
    skipped: Array.isArray(error?.skipped) ? error.skipped : [],
    uploadedReferences: Array.isArray(error?.uploadedReferences) ? error.uploadedReferences : [],
    debugResponses: Array.isArray(error?.debugResponses) ? error.debugResponses : [],
    lastMatchedState: error?.lastMatchedState ?? null,
    submitInfo: error?.submitInfo ?? null,
  };
}

async function processEntry(page, entry, anchorPath, options, workspaceId) {
  logEntryProgress(entry, options, 'page-open', `opening workspace ${workspaceId}`);
  await gotoJimengPage(page, buildHomeUrl(workspaceId), options, `generate workspace ${workspaceId}`);
  await sleep(2500);

  await ensureImageGenerationMode(page, options, workspaceId);
  logEntryProgress(entry, options, 'image-mode-ready', `image mode ready in workspace ${workspaceId}`);

  const uploadedReferences = collectReferencePaths(entry, anchorPath);
  if (uploadedReferences.length > 0) {
    logEntryProgress(entry, options, 'references-uploading', 'uploading reference images', {
      referenceCount: uploadedReferences.length,
    });
    await uploadReferences(page, entry, anchorPath);
    logEntryProgress(entry, options, 'references-uploaded', 'reference images uploaded', {
      referenceCount: uploadedReferences.length,
    });
  } else {
    logEntryProgress(entry, options, 'references-skipped', 'no reference images to upload', {
      referenceCount: 0,
    });
  }

  const finalPrompt = buildPrompt(entry, options);
  logEntryProgress(entry, options, 'prompt-writing', 'writing prompt');
  await fillPrompt(page, finalPrompt, options);
  logEntryProgress(entry, options, 'prompt-ready', 'prompt verified');
  logEntryProgress(entry, options, 'pre-submit-snapshot', 'settling existing page images before submit');
  const beforePageImages = await waitForPageImagesStable(page);
  logEntryProgress(entry, options, 'pre-submit-snapshot-ready', 'existing page image snapshot ready', {
    domCandidateCount: beforePageImages.length,
  });
  logEntryProgress(entry, options, 'submit-clicking', 'submitting generation request');
  const submitInfo = await clickSubmit(page, options);
  logEntryProgress(entry, options, 'submitted', 'generation request accepted', {
    submitId: submitInfo.submitId,
    historyRecordId: submitInfo.historyRecordId,
    expectedItemCount: submitInfo.expectedItemIds.length,
  });

  const result = await waitForGeneratedImages(page, options, submitInfo, beforePageImages, (phase, detail) => {
    const messageByPhase = {
      'history-update': 'history state updated',
      'waiting-results': 'waiting for generated result images',
      'dom-stable-fallback': 'history is quiet; switching to stable DOM result fallback',
      'preview-start': 'opening result previews to collect large image urls',
      'preview-candidate': 'preview candidate inspected',
      'downloadable-results-ready': 'downloadable preview/original images ready',
      'downloadable-history-ready': 'downloadable history images ready',
    };
    logEntryProgress(entry, options, phase, messageByPhase[phase] || phase, detail);
  });
  let downloadResult;
  try {
    logEntryProgress(entry, options, 'download-start', 'downloading best result variant', {
      downloadableCount: result.urls.filter(isLikelyDownloadableImageUrl).length,
    });
    downloadResult =
      result.urls.length > 0
        ? await saveVariants(entry, result.urls, options)
        : { variants: [], skipped: [] };
    logEntryProgress(entry, options, 'download-complete', 'result variant saved', {
      downloadableCount: result.urls.filter(isLikelyDownloadableImageUrl).length,
      variantPath: downloadResult.variants[0] || '',
    });
  } catch (error) {
    error.resultUrls = error.resultUrls ?? result.urls;
    error.debugResponses = result.debugResponses;
    error.lastMatchedState = result.lastMatchedState;
    error.submitInfo = submitInfo;
    error.uploadedReferences = uploadedReferences;
    throw error;
  }
  const activeWorkspace = await resolveActiveWorkspace(page, workspaceId);

  return {
    hash: entry.hash,
    workspaceId: activeWorkspace.workspaceId,
    workspaceUrl: activeWorkspace.workspaceUrl,
    prompt: finalPrompt,
    originalPrompt: entry.prompt,
    uploadedReferences,
    resultUrls: result.urls,
    variants: downloadResult.variants,
    skipped: downloadResult.skipped,
    outputDir: downloadResult.outputDir || '',
    debugResponses: result.debugResponses,
    submitInfo,
    lastMatchedState: result.lastMatchedState,
  };
}

function isTransientJimengError(error) {
  const message = String(error ?? '');
  return (
    message.includes('detached Frame') ||
    message.includes('Execution context was destroyed') ||
    message.includes('Cannot find context with specified id') ||
    message.includes('Target closed') ||
    message.includes('Timed out while waiting for generated')
  );
}

async function createWorkerPage(browser, options) {
  const page = await browser.newPage();
  page.setDefaultTimeout(options.pageTimeoutMs);
  return page;
}

async function launchBrowserInstance(options, profileDir) {
  return puppeteer.launch({
    headless: options.headless ? 'new' : false,
    executablePath: options.browser,
    userDataDir: profileDir,
    defaultViewport: null,
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

async function prepareWorkerBrowsers(options, workerCount) {
  const workerRoot = path.join(options.logDir, `worker-profiles-${Date.now()}`);
  ensureDir(workerRoot);
  const workerProfiles = [];
  const browsers = [];
  const workers = [];

  try {
    for (let index = 0; index < workerCount; index += 1) {
      const workerProfileDir = path.join(workerRoot, `worker-${index + 1}`);
      copyProfileForWorker(options.profileDir, workerProfileDir);
      workerProfiles.push(workerProfileDir);

      const browser = await launchBrowserInstance(options, workerProfileDir);
      browsers.push(browser);
      const workspaceId = options.workspaceIds[index % options.workspaceIds.length];
      workers.push({
        browser,
        workspaceId,
      });

      const page = await createWorkerPage(browser, options);
      try {
        await ensureLoggedIn(page, options, workspaceId);
      } finally {
        await page.close().catch(() => {});
      }
    }

    return {
      browsers,
      workers,
      workerRoot,
      workerProfiles,
    };
  } catch (error) {
    await Promise.all(browsers.map(browser => browser.close().catch(() => {})));
    removeDirSafe(workerRoot);
    throw error;
  }
}

async function processEntryWithRetries(worker, entry, anchorPath, options) {
  let lastError = null;
  const { browser, workspaceId } = worker;

  for (let attempt = 1; attempt <= Math.max(1, options.maxRetries); attempt += 1) {
    const page = await createWorkerPage(browser, options);

    try {
      const summary = await processEntry(page, entry, anchorPath, options, workspaceId);
      await page.close();
      return summary;
    } catch (error) {
      lastError = error;
      try {
        await page.close();
      } catch {
        // Ignore page teardown failures during retry handling.
      }

      if (!isTransientJimengError(error) || attempt >= options.maxRetries) {
        break;
      }

      console.log(
        `[jimeng] retry ${attempt}/${options.maxRetries - 1} for ${entry.hash}: ${String(error)}`
      );
      await sleep(3000);
    }
  }

  throw lastError;
}

async function processEntryAndPersist(worker, entry, index, queueSize, anchorPath, options, workerLabel) {
  console.log(
    `[jimeng] [${workerLabel}] [workspace ${worker.workspaceId}] [${index + 1}/${queueSize}] ${entry.hash}`
  );

  let summary;
  try {
    summary = await processEntryWithRetries(worker, entry, anchorPath, options);
  } catch (error) {
    summary = buildFailedSummary(entry, error);
  }

  const logPath = path.join(options.logDir, `${entry.hash}.json`);
  fs.writeFileSync(logPath, JSON.stringify(summary, null, 2), 'utf8');

  if (summary.error) {
    writeProgressSnapshot(entry, options, 'failed', {
      error: summary.error,
      logPath,
    });
    console.error(`[jimeng] [${workerLabel}] failed ${entry.hash}: ${summary.error}`);
  } else {
    writeProgressSnapshot(entry, options, 'completed', {
      variantCount: summary.variants.length,
      logPath,
      variants: summary.variants,
    });
    console.log(
      `[jimeng] [${workerLabel}] saved ${summary.variants.length} variant(s) for ${entry.hash}`
    );
  }

  if (options.paceMs > 0) {
    await sleep(options.paceMs);
  }

  return summary;
}

async function runQueue(workers, queue, anchorPath, options) {
  const workerCount = Math.min(workers.length, queue.length);
  let nextIndex = 0;
  const summaries = [];

  async function worker(workerNumber) {
    const workerTarget = workers[workerNumber - 1];
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= queue.length) {
        return;
      }

      const entry = queue[index];
      const summary = await processEntryAndPersist(
        workerTarget,
        entry,
        index,
        queue.length,
        anchorPath,
        options,
        `w${workerNumber}`
      );
      summaries.push(summary);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, (_, index) => worker(index + 1)));
  return summaries;
}

async function processEntryWithLivePageRetries(pageRef, browser, workspaceId, entry, anchorPath, options) {
  let lastError = null;

  for (let attempt = 1; attempt <= Math.max(1, options.maxRetries); attempt += 1) {
    try {
      if (!pageRef.page || pageRef.page.isClosed()) {
        pageRef.page = await createWorkerPage(browser, options);
        await ensureLoggedIn(pageRef.page, options, workspaceId);
      }
      return await processEntry(pageRef.page, entry, anchorPath, options, workspaceId);
    } catch (error) {
      lastError = error;

      if (!isTransientJimengError(error) || attempt >= options.maxRetries) {
        break;
      }

      console.log(
        `[jimeng] retry ${attempt}/${options.maxRetries - 1} for ${entry.hash}: ${String(error)}`
      );

      try {
        await pageRef.page?.close();
      } catch {
        // Ignore page teardown failures during retry handling.
      }

      pageRef.page = await createWorkerPage(browser, options);
      await ensureLoggedIn(pageRef.page, options, workspaceId);
      await sleep(3000);
    }
  }

  throw lastError;
}

async function runQueueInLivePage(browser, page, workspaceId, queue, anchorPath, options) {
  const pageRef = { page };
  const summaries = [];

  for (let index = 0; index < queue.length; index += 1) {
    const entry = queue[index];
    console.log(`[jimeng] [live] [workspace ${workspaceId}] [${index + 1}/${queue.length}] ${entry.hash}`);

    let summary;
    try {
      summary = await processEntryWithLivePageRetries(pageRef, browser, workspaceId, entry, anchorPath, options);
    } catch (error) {
      summary = buildFailedSummary(entry, error);
    }

    const logPath = path.join(options.logDir, `${entry.hash}.json`);
    fs.writeFileSync(logPath, JSON.stringify(summary, null, 2), 'utf8');

    if (summary.error) {
      writeProgressSnapshot(entry, options, 'failed', {
        error: summary.error,
        logPath,
      });
      console.error(`[jimeng] [live] failed ${entry.hash}: ${summary.error}`);
    } else {
      writeProgressSnapshot(entry, options, 'completed', {
        variantCount: summary.variants.length,
        logPath,
        variants: summary.variants,
      });
      console.log(`[jimeng] [live] saved ${summary.variants.length} variant(s) for ${entry.hash}`);
    }

    summaries.push(summary);

    if (options.paceMs > 0 && index < queue.length - 1) {
      await sleep(options.paceMs);
    }
  }

  return summaries;
}

async function main() {
  const options = applyRequestedHashes(parseArgs(process.argv.slice(2)));
  ensureDir(options.logDir);

  if (!fs.existsSync(options.browser)) {
    throw new Error(`Browser executable not found: ${options.browser}`);
  }

  let anchorPath = options.anchor;
  if (anchorPath && !fs.existsSync(anchorPath)) {
    throw new Error('Reference image not found. Pass --anchor with a valid image path.');
  }

  const manifest = loadManifest(options.manifest);
  const queue = buildQueue(manifest, options);

  console.log(`[jimeng] browser: ${options.browser}`);
  console.log(`[jimeng] profile: ${options.profileDir}`);
  console.log(`[jimeng] anchor: ${anchorPath ?? '<none>'}`);
  console.log(`[jimeng] subject tag: ${options.subjectTag || '<none>'}`);
  console.log(`[jimeng] queue size: ${queue.length}`);
  console.log(`[jimeng] concurrency: ${options.concurrency}`);
  console.log(`[jimeng] pace ms: ${options.paceMs}`);
  console.log(`[jimeng] prompt profile: ${options.promptProfile}`);
  console.log(`[jimeng] keep browser open: ${options.keepBrowserOpen && !options.headless ? 'on' : 'off'}`);
  console.log('[jimeng] keep this worker process alive until it reports completed or failed; terminating the worker also tears down the attached visible browser.');
  console.log(`[jimeng] workspace pool file: ${options.workspacePoolFile}`);
  console.log(`[jimeng] seed workspace ids: ${options.workspaceIds.join(', ') || '<auto-scan>'}`);
  console.log(`[jimeng] cleanup conversations: ${options.cleanupConversations ? `on (keep ${options.keepConversations})` : 'off'}`);

  if (queue.length === 0 && !options.scanOnly) {
    console.log('[jimeng] Nothing to do.');
    return;
  }

  let loginBrowser = null;
  let workerBundle = null;
  let keepLoginBrowserOpen = false;
  try {
    loginBrowser = await launchBrowserInstance(options, options.profileDir);

    const context = loginBrowser.defaultBrowserContext?.();
    if (context?.overridePermissions) {
      await context.overridePermissions('https://jimeng.jianying.com', [
        'clipboard-read',
        'clipboard-write',
      ]);
    }

    const loginPage = await createWorkerPage(loginBrowser, options);
    await ensureLoggedIn(loginPage, options, options.workspaceIds[0] || '0');
    if (options.cleanupConversations) {
      await cleanupOldConversations(loginPage, options);
    }
    const workspacePlan = await resolveWorkspacePlan(loginPage, queue, options);
    options.workspaceIds = workspacePlan.workspaceIds;
    options.concurrency = workspacePlan.concurrency || options.concurrency;
    writeSessionFile(options.sessionOut, {
      provider: 'jimeng',
      mode: workspacePlan.mode,
      workspaceId: options.workspaceIds[0] || '0',
      workspaceUrl: buildHomeUrl(options.workspaceIds[0] || '0'),
      conversationUrl: buildHomeUrl(options.workspaceIds[0] || '0'),
      workspaceIds: workspacePlan.workspaceIds,
    });
    console.log(`[jimeng] reusable workspace slots: ${workspacePlan.pool.length}`);
    console.log(`[jimeng] discovered this run: ${workspacePlan.scannedIds.length}`);
    console.log(`[jimeng] workspace ids: ${workspacePlan.workspaceIds.join(', ') || '<none>'}`);
    if (options.scanOnly) {
      console.log('[jimeng] scan-only complete.');
      await loginPage.close();
      return;
    }
    const workerCount = Math.min(options.concurrency, queue.length, options.workspaceIds.length);
    let summaries;
    if (workerCount <= 1) {
      console.log('[jimeng] continuing in the current logged-in browser session.');
      keepLoginBrowserOpen = options.keepBrowserOpen && !options.headless;
      summaries = await runQueueInLivePage(
        loginBrowser,
        loginPage,
        options.workspaceIds[0] || '0',
        queue,
        anchorPath,
        options
      );
      if (!keepLoginBrowserOpen) {
        await loginPage.close().catch(() => {});
      } else {
        console.log('[jimeng] keeping visible browser open after the run for inspection.');
      }
    } else {
      await loginPage.close();
      await loginBrowser.close();
      loginBrowser = null;
      workerBundle = await prepareWorkerBrowsers(options, workerCount);
      summaries = await runQueue(workerBundle.workers, queue, anchorPath, options);
    }
    const usedWorkspaceIds = summaries
      .map(summary => normalizeWorkspaceId(summary?.workspaceId))
      .filter(Boolean);
    const fallbackWorkspaceIds =
      workerBundle?.workers?.map(worker => worker.workspaceId) ?? [options.workspaceIds[0] || '0'];
    saveWorkspacePool(
      options.workspacePoolFile,
      usedWorkspaceIds.length > 0 ? usedWorkspaceIds : fallbackWorkspaceIds,
      'used'
    );
    const finalWorkspace = summaries.find(summary => summary && !summary.error && summary.workspaceUrl);
    if (finalWorkspace) {
      writeSessionFile(options.sessionOut, {
        provider: 'jimeng',
        mode: workspacePlan.mode,
        workspaceId: finalWorkspace.workspaceId,
        workspaceUrl: finalWorkspace.workspaceUrl,
        conversationUrl: finalWorkspace.workspaceUrl,
        workspaceIds: [...new Set(usedWorkspaceIds)],
      });
    }
  } finally {
    if (loginBrowser) {
      if (keepLoginBrowserOpen) {
        loginBrowser.disconnect();
      } else {
        await loginBrowser.close().catch(() => {});
      }
    }
    if (workerBundle) {
      await Promise.all(workerBundle.browsers.map(browser => browser.close().catch(() => {})));
      removeDirSafe(workerBundle.workerRoot);
    }
  }
}

main().catch(error => {
  console.error('[jimeng] fatal:', error);
  process.exitCode = 1;
});
