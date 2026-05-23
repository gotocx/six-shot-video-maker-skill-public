import { buildCutoutRequirementLine, normalizeCutoutPolicy } from './cutoutPromptPolicy.mjs';

export function normalizeText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeTextList(...values) {
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

export function normalizePositiveNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return numeric;
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

function formatReferenceSizeSummary(reference, index) {
  return `参考图${index + 1} ${reference.width}x${reference.height}（${reference.aspectRatio}，${reference.orientation}）`;
}

function normalizeReferenceImageMeta(item) {
  const source = typeof item === 'string' ? { path: item } : item;
  if (!source || typeof source !== 'object') {
    return null;
  }

  const width = normalizePositiveNumber(source.width);
  const height = normalizePositiveNumber(source.height);
  const orientation = normalizeText(source.orientation) || classifyOrientation(width, height);
  const aspectRatio = normalizeText(source.aspectRatio) || formatAspectRatio(width, height);
  const styleHints = normalizeTextList(source.styleHints);
  const role = normalizeText(source.role);
  const imagePath = normalizeText(source.path);

  return {
    path: imagePath,
    width,
    height,
    orientation,
    aspectRatio,
    styleHints,
    role,
  };
}

function getDominantReferenceAspect(referenceImages) {
  if (!Array.isArray(referenceImages) || referenceImages.length === 0) {
    return null;
  }
  const buckets = new Map();
  for (const reference of referenceImages) {
    const key = `${reference.orientation}|${reference.aspectRatio}`;
    if (!buckets.has(key)) {
      buckets.set(key, { key, reference, count: 0 });
    }
    buckets.get(key).count += 1;
  }
  return [...buckets.values()].sort((left, right) => {
    if (right.count !== left.count) return right.count - left.count;
    return referenceImages.indexOf(left.reference) - referenceImages.indexOf(right.reference);
  })[0]?.reference ?? referenceImages[0];
}

function buildReferenceSummaryLine(referenceImages) {
  if (!Array.isArray(referenceImages) || referenceImages.length === 0) {
    return '';
  }
  const visibleReferences = referenceImages.filter(item => item.width > 0 && item.height > 0);
  if (visibleReferences.length === 0) {
    return '';
  }
  const summary = visibleReferences
    .slice(0, 4)
    .map((reference, index) => formatReferenceSizeSummary(reference, index))
    .join('；');
  return `参考图读取结果：${summary}。`;
}

function buildSizeRequirementLine(task) {
  const explicitSizeRequirement = normalizeText(task.sizeRequirement);
  const outputWidth = normalizePositiveNumber(task.outputWidth);
  const outputHeight = normalizePositiveNumber(task.outputHeight);
  const segments = [];

  if (explicitSizeRequirement) {
    segments.push(explicitSizeRequirement);
  } else {
    const dominantReference = getDominantReferenceAspect(task.referenceImages);
    if (dominantReference?.aspectRatio) {
      segments.push(`输出保持${dominantReference.orientation}${dominantReference.aspectRatio}构图，主体完整，保留安全裁切边距，关键元素不要贴边`);
    }
  }

  if (normalizeText(task.size)) {
    segments.push(`构图尺寸倾向：${normalizeText(task.size)}`);
  }

  if (outputWidth > 0 && outputHeight > 0) {
    segments.push(`最终目标图需兼容 ${outputWidth}x${outputHeight} 像素画布及对应宽高比，主体完整且便于后续裁切`);
  }

  if (segments.length === 0) {
    return '';
  }
  return `尺寸要求：${segments.join('；')}。`;
}

function buildStyleRequirementLine(task) {
  const styleHints = normalizeTextList(task.styleHints);
  if (styleHints.length > 0) {
    if (Array.isArray(task.referenceImages) && task.referenceImages.length > 0) {
      return `风格要求：严格贴近参考图，重点保持${styleHints.join('、')}。`;
    }
    return `风格要求：重点保持${styleHints.join('、')}。`;
  }
  if (Array.isArray(task.referenceImages) && task.referenceImages.length > 0) {
    return '风格要求：严格参考已上传示例图的整体画风、材质、光影、配色和世界观，不要偏成其他画风。';
  }
  return '';
}

function buildContextRequirementLine(task) {
  if (task.backgroundHints.length === 0 && task.effectHints.length === 0) {
    return '';
  }
  const segments = [];
  if (task.backgroundHints.length > 0) {
    segments.push(`背景环境围绕${task.backgroundHints.join('、')}展开`);
  }
  if (task.effectHints.length > 0) {
    segments.push(`画面重点体现${task.effectHints.join('、')}`);
  }
  return `内容语义要求：${segments.join('；')}。`;
}

function buildReferenceUsageLine(task) {
  if (!Array.isArray(task.referenceImages) || task.referenceImages.length === 0) {
    return '';
  }
  const roleHints = task.referenceImages
    .map(reference => normalizeText(reference.role))
    .filter(Boolean);
  if (roleHints.length === 0) {
    return '参考图使用要求：比例先参考上面的尺寸信息，风格严格参考上传示例图，保证最终画面统一。';
  }
  return `参考图使用要求：${roleHints.join('；')}；同时保证比例和整体风格与参考图一致。`;
}

export function normalizeUnifiedTask(rawTask, options = {}) {
  const taskId =
    normalizeText(rawTask?.id || rawTask?.taskId || rawTask?.hash) ||
    normalizeText(options.defaultId) ||
    `task-${Date.now()}`;
  const prompt = normalizeText(rawTask?.prompt);
  const providerPrompt = normalizeText(rawTask?.providerPrompt);
  const referenceImages = (Array.isArray(rawTask?.referenceImages) ? rawTask.referenceImages : [])
    .map(item => normalizeReferenceImageMeta(item))
    .filter(Boolean);
  const styleHints = normalizeTextList(rawTask?.styleHints, referenceImages.flatMap(item => item.styleHints));
  const backgroundHints = normalizeTextList(rawTask?.backgroundHints);
  const effectHints = normalizeTextList(rawTask?.effectHints);
  const sizeRequirement = normalizeText(rawTask?.sizeRequirement);

  return {
    ...rawTask,
    id: taskId,
    hash: taskId,
    prompt,
    providerPrompt,
    referenceImages,
    styleHints,
    backgroundHints,
    effectHints,
    sizeRequirement,
    size: normalizeText(rawTask?.size),
    outputWidth: normalizePositiveNumber(rawTask?.outputWidth || rawTask?.targetOutputWidth),
    outputHeight: normalizePositiveNumber(rawTask?.outputHeight || rawTask?.targetOutputHeight),
    subjectWidthRatio: normalizePositiveNumber(rawTask?.subjectWidthRatio),
    subjectHeightRatio: normalizePositiveNumber(rawTask?.subjectHeightRatio),
    cutoutPolicy: normalizeCutoutPolicy(rawTask?.cutoutPolicy),
    sourceKind: normalizeText(rawTask?.sourceKind),
    cluster: normalizeText(rawTask?.cluster),
  };
}

export function buildUnifiedPrompt(task, options = {}) {
  const provider = options.provider || 'browser';
  const joinWith = options.joinWith ?? '\n';
  const basePrompt = normalizeText(task.providerPrompt || task.prompt);
  const lines = [
    basePrompt,
    buildReferenceSummaryLine(task.referenceImages),
    buildSizeRequirementLine(task),
    buildStyleRequirementLine(task),
    buildContextRequirementLine(task),
    buildCutoutRequirementLine(task, provider),
    buildReferenceUsageLine(task),
  ].filter(Boolean);
  return lines.join(joinWith);
}
