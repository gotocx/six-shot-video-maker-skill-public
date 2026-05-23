#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import process from 'process';

const LIMITS = {
  sceneCount: 6,
  imagePromptChars: 100,
  videoPromptChars: 2000,
  totalDurationSec: 15,
  durationTolerance: 0.01,
  imageModes: new Set(['gpt', 'jimeng', 'browser']),
  minImageBytes: 50 * 1024,
  minWidth: 512,
  minHeight: 512,
};

function usage() {
  console.log(`Usage:
  node scripts/asset_state.mjs init --run <run-dir>
  node scripts/asset_state.mjs validate --run <run-dir> --stage storyboard|images|video|ready
  node scripts/asset_state.mjs mark --run <run-dir> --stage <name> [--status <name>]`);
}

function parseArgs(argv) {
  const opts = { command: argv[0] || '' };
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key.startsWith('--')) {
      opts[key.slice(2)] = val || '';
      i++;
    }
  }
  return opts;
}

function charLen(value) {
  return Array.from(String(value || '')).length;
}

function normalizeImageMode(value) {
  const mode = String(value || 'gpt').trim().toLowerCase();
  return mode || 'gpt';
}

function nowIso() {
  return new Date().toISOString();
}

function fail(message, detail = {}) {
  return { ok: false, message, ...detail };
}

function pass(message, detail = {}) {
  return { ok: true, message, ...detail };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function readState(runDir) {
  const stateFile = path.join(runDir, 'state.json');
  if (!fs.existsSync(stateFile)) {
    return {
      runDir,
      stage: 'missing_state',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      checks: {},
    };
  }
  return readJson(stateFile);
}

function writeState(runDir, state) {
  state.runDir = runDir;
  state.updatedAt = nowIso();
  writeJson(path.join(runDir, 'state.json'), state);
}

function recordCheck(runDir, stage, result) {
  const checksDir = path.join(runDir, 'checks');
  fs.mkdirSync(checksDir, { recursive: true });
  writeJson(path.join(checksDir, `${stage}-report.json`), result);
  const state = readState(runDir);
  state.checks ||= {};
  state.checks[stage] = {
    ok: result.ok,
    message: result.message,
    checkedAt: nowIso(),
  };
  if (result.ok) {
    if (stage === 'storyboard') state.stage = 'storyboard_validated';
    if (stage === 'images') state.stage = 'images_validated';
    if (stage === 'video') state.stage = 'video_prompt_validated';
    if (stage === 'ready') state.stage = 'ready_for_submit';
  } else {
    state.stage = `${stage}_failed`;
  }
  writeState(runDir, state);
  return result;
}

function initRun(runDir) {
  fs.mkdirSync(path.join(runDir, 'images'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'checks'), { recursive: true });
  const stateFile = path.join(runDir, 'state.json');
  if (!fs.existsSync(stateFile)) {
    writeState(runDir, {
      runDir,
      stage: 'initialized',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      checks: {},
    });
  }
  return pass('run directory initialized', { runDir });
}

function loadStoryboard(runDir) {
  const storyboardFile = path.join(runDir, 'storyboard.json');
  if (!fs.existsSync(storyboardFile)) {
    return { error: `missing ${storyboardFile}` };
  }
  try {
    return { data: readJson(storyboardFile), file: storyboardFile };
  } catch (error) {
    return { error: `invalid storyboard json: ${error.message}` };
  }
}

function validateStoryboard(runDir) {
  const loaded = loadStoryboard(runDir);
  if (loaded.error) return recordCheck(runDir, 'storyboard', fail(loaded.error));

  const data = loaded.data;
  const errors = [];
  const warnings = [];
  const imageMode = normalizeImageMode(data.imageMode);
  if (!LIMITS.imageModes.has(imageMode)) {
    errors.push('imageMode must be gpt or jimeng');
  }
  if (imageMode === 'browser') {
    warnings.push('imageMode browser is accepted as a legacy alias; use gpt for new storyboards');
  }
  if (!Array.isArray(data.scenes)) {
    errors.push('scenes must be an array');
  } else if (data.scenes.length !== LIMITS.sceneCount) {
    errors.push(`scenes must contain exactly ${LIMITS.sceneCount} items`);
  }

  const seenIds = new Set();
  let durationSum = 0;
  const sceneReports = [];
  for (const [index, scene] of (data.scenes || []).entries()) {
    const expectedId = `scene${String(index + 1).padStart(2, '0')}`;
    const id = String(scene.id || '');
    const prompt = String(scene.imagePrompt || '');
    const duration = Number(scene.durationSec || 0);
    const report = {
      index: index + 1,
      id,
      promptChars: charLen(prompt),
      durationSec: duration,
    };

    if (!id) errors.push(`scene ${index + 1} missing id`);
    if (id && seenIds.has(id)) errors.push(`duplicate scene id: ${id}`);
    seenIds.add(id);
    if (id && id !== expectedId) warnings.push(`scene ${index + 1} id is ${id}, expected ${expectedId}`);
    if (!prompt.trim()) errors.push(`${id || expectedId} missing imagePrompt`);
    if (charLen(prompt) > LIMITS.imagePromptChars) {
      errors.push(`${id || expectedId} imagePrompt has ${charLen(prompt)} chars, max ${LIMITS.imagePromptChars}`);
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      errors.push(`${id || expectedId} durationSec must be positive`);
    } else {
      durationSum += duration;
    }
    if (!scene.imagePath) warnings.push(`${id || expectedId} missing imagePath, default image lookup will be used`);
    sceneReports.push(report);
  }

  if (Number(data.totalDurationSec) !== LIMITS.totalDurationSec) {
    errors.push(`totalDurationSec must be ${LIMITS.totalDurationSec}`);
  }
  if (Math.abs(durationSum - LIMITS.totalDurationSec) > LIMITS.durationTolerance) {
    errors.push(`scene duration sum is ${durationSum}, expected ${LIMITS.totalDurationSec}`);
  }

  const result = errors.length
    ? fail('storyboard validation failed', { errors, warnings, imageMode, scenes: sceneReports })
    : pass('storyboard validation passed', { warnings, imageMode, scenes: sceneReports });
  return recordCheck(runDir, 'storyboard', result);
}

function candidateImagePaths(runDir, scene) {
  const candidates = [];
  if (scene.imagePath) candidates.push(path.resolve(runDir, scene.imagePath));
  const id = scene.id || 'scene';
  for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
    candidates.push(path.join(runDir, 'images', `${id}.${ext}`));
  }
  return [...new Set(candidates)];
}

function findSceneImage(runDir, scene) {
  for (const file of candidateImagePaths(runDir, scene)) {
    if (fs.existsSync(file)) return file;
  }
  return '';
}

function readImageInfo(file) {
  const buffer = fs.readFileSync(file);
  const size = buffer.length;
  if (buffer.length < 12) return { file, size, format: 'unknown' };

  if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return {
      file,
      size,
      format: 'png',
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          file,
          size,
          format: 'jpeg',
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + length;
    }
    return { file, size, format: 'jpeg' };
  }

  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const subtype = buffer.toString('ascii', 12, 16);
    if (subtype === 'VP8X' && buffer.length >= 30) {
      const width = 1 + buffer.readUIntLE(24, 3);
      const height = 1 + buffer.readUIntLE(27, 3);
      return { file, size, format: 'webp', width, height };
    }
    return { file, size, format: 'webp' };
  }

  return { file, size, format: 'unknown' };
}

function latestCheckOk(runDir, stage) {
  const state = readState(runDir);
  return Boolean(state.checks?.[stage]?.ok);
}

function validateImages(runDir) {
  const storyboard = validateStoryboard(runDir);
  if (!storyboard.ok) return recordCheck(runDir, 'images', fail('storyboard must pass before image validation'));

  const data = loadStoryboard(runDir).data;
  const errors = [];
  const images = [];
  for (const scene of data.scenes) {
    const imageFile = findSceneImage(runDir, scene);
    if (!imageFile) {
      errors.push(`${scene.id} image missing`);
      images.push({ id: scene.id, ok: false, file: '' });
      continue;
    }
    let info;
    try {
      info = readImageInfo(imageFile);
    } catch (error) {
      errors.push(`${scene.id} image unreadable: ${error.message}`);
      images.push({ id: scene.id, ok: false, file: imageFile });
      continue;
    }
    const itemErrors = [];
    if (info.size < LIMITS.minImageBytes) itemErrors.push(`size ${info.size} below ${LIMITS.minImageBytes}`);
    if (!info.width || !info.height) itemErrors.push('dimensions not detected');
    if (info.width && info.width < LIMITS.minWidth) itemErrors.push(`width ${info.width} below ${LIMITS.minWidth}`);
    if (info.height && info.height < LIMITS.minHeight) itemErrors.push(`height ${info.height} below ${LIMITS.minHeight}`);
    if (itemErrors.length) errors.push(`${scene.id}: ${itemErrors.join(', ')}`);
    images.push({ id: scene.id, ok: itemErrors.length === 0, ...info });
  }

  const result = errors.length
    ? fail('image validation failed', { errors, images })
    : pass('image validation passed', { images });
  return recordCheck(runDir, 'images', result);
}

function validateVideoPrompt(runDir) {
  if (!latestCheckOk(runDir, 'images')) {
    return recordCheck(runDir, 'video', fail('images must pass before writing or validating video prompt'));
  }

  const promptFile = path.join(runDir, 'video_prompt.txt');
  if (!fs.existsSync(promptFile)) {
    return recordCheck(runDir, 'video', fail(`missing ${promptFile}`));
  }
  const prompt = fs.readFileSync(promptFile, 'utf8').trim();
  const length = charLen(prompt);
  const errors = [];
  if (!prompt) errors.push('video prompt is empty');
  if (length >= LIMITS.videoPromptChars) {
    errors.push(`video prompt has ${length} chars, must be less than ${LIMITS.videoPromptChars}`);
  }
  if (!/\b15\b|十五/.test(prompt)) {
    errors.push('video prompt should state total duration around 15 seconds');
  }

  const result = errors.length
    ? fail('video prompt validation failed', { errors, chars: length })
    : pass('video prompt validation passed', { chars: length });
  return recordCheck(runDir, 'video', result);
}

function validateReady(runDir) {
  const imagesOk = latestCheckOk(runDir, 'images');
  const videoOk = latestCheckOk(runDir, 'video');
  const errors = [];
  if (!imagesOk) errors.push('images check is not passing');
  if (!videoOk) errors.push('video check is not passing');
  const result = errors.length
    ? fail('run is not ready for submit', { errors })
    : pass('run is ready for six-image video submit');
  return recordCheck(runDir, 'ready', result);
}

function markStage(runDir, stage, status) {
  const state = readState(runDir);
  state.stage = status || stage;
  state.marks ||= [];
  state.marks.push({ stage, status: state.stage, markedAt: nowIso() });
  writeState(runDir, state);
  return pass('stage marked', { stage: state.stage });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.command || !opts.run) {
    usage();
    process.exit(1);
  }
  const runDir = path.resolve(opts.run);
  let result;
  if (opts.command === 'init') result = initRun(runDir);
  else if (opts.command === 'validate') {
    if (opts.stage === 'storyboard') result = validateStoryboard(runDir);
    else if (opts.stage === 'images') result = validateImages(runDir);
    else if (opts.stage === 'video') result = validateVideoPrompt(runDir);
    else if (opts.stage === 'ready') result = validateReady(runDir);
    else result = fail('unknown validation stage');
  } else if (opts.command === 'mark') {
    result = markStage(runDir, opts.stage || 'manual', opts.status || '');
  } else {
    usage();
    process.exit(1);
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main();
