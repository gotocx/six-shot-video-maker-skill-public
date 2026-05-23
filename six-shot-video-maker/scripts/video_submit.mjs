// 即梦视频模式 - 发送脚本（只发不抓）
// 用法:
//   node jimengVideoSubmit.mjs --image <path> --prompt <text> [--duration 4]
//   node jimengVideoSubmit.mjs --image <path> --prompt-file <file> [--duration 4]
//   node jimengVideoSubmit.mjs --image <p1> --image <p2> ... --prompt <text> [--duration 8] [--model "Seedance 2.0 VIP"]
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const requireFromHere = createRequire(import.meta.url);
const puppeteer = await loadPuppeteerCore();

// ======================== 配置 ========================
const VIDEO_URLS = [
  'https://jimeng.jianying.com/ai-tool/generate?type=video&workspace=0',
  'https://jimeng.jianying.com/ai-tool/home?type=video',
  'https://jimeng.jianying.com/ai-tool/generate?type=seedance&workspace=0',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function runtimeRoots() {
  const roots = [];
  if (process.env.SIX_SHOT_RUNTIME) roots.push(path.resolve(process.env.SIX_SHOT_RUNTIME));
  if (process.env.SIX_SHOT_NODE_MODULES) roots.push(path.dirname(path.resolve(process.env.SIX_SHOT_NODE_MODULES)));
  roots.push(path.resolve(SCRIPT_DIR, '..', '..', '.six-shot-runtime'));
  roots.push(path.resolve(SCRIPT_DIR, 'node_modules', '..'));
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

// ======================== 参数解析 ========================
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    image: '',
    images: [],
    prompt: '',
    promptFile: '',
    duration: '4',
    model: '',
    browser: '',
    profile: '',
    workspace: '0',
    keepOpenMs: 30000,
    headless: false,
    allowClickSelect: false,
  };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const val = args[i + 1];
    if (key === '--image' && val) { opts.image = val; opts.images.push(val); i++; }
    else if (key === '--images' && val) { opts.images.push(...splitImageList(val)); i++; }
    else if (key === '--prompt' && val) { opts.prompt = val; i++; }
    else if (key === '--prompt-file' && val) { opts.promptFile = val; i++; }
    else if (key === '--duration' && val) { opts.duration = val; i++; }
    else if (key === '--model' && val) { opts.model = val; i++; }
    else if (key === '--browser' && val) { opts.browser = val; i++; }
    else if (key === '--profile' && val) { opts.profile = val; i++; }
    else if (key === '--workspace' && val) { opts.workspace = val; i++; }
    else if (key === '--keep-open-ms' && val) { opts.keepOpenMs = Math.max(0, Number(val) || 0); i++; }
    else if (key === '--headless') { opts.headless = true; }
    else if (key === '--allow-click-select') { opts.allowClickSelect = true; }
  }
  if (!opts.prompt && opts.promptFile) {
    opts.prompt = fs.readFileSync(path.resolve(opts.promptFile), 'utf8').trim();
  }
  return opts;
}

function splitImageList(value) {
  return String(value || '')
    .split(/[|;]/)
    .map(s => s.trim())
    .filter(Boolean);
}

function normalizeImagePath(inputPath) {
  return path.resolve(String(inputPath || '').replace(/^\/([a-z]):\//i, '$1:/').replace(/\//g, '\\'));
}

const VIDEO_MODEL_MAP = new Map([
  ['seedance 2.0 vip', { label: 'Seedance 2.0 VIP', key: 'dreamina_seedance_40_pro_vision', defaultKey: 'dreamina_seedance_40_vision' }],
  ['seedance 2.0 fast vip', { label: 'Seedance 2.0 Fast VIP', key: 'dreamina_seedance_40_vision', defaultKey: 'dreamina_seedance_40_vision' }],
  ['dreamina_seedance_40_pro_vision', { label: 'Seedance 2.0 VIP', key: 'dreamina_seedance_40_pro_vision', defaultKey: 'dreamina_seedance_40_vision' }],
  ['dreamina_seedance_40_vision', { label: 'Seedance 2.0 Fast VIP', key: 'dreamina_seedance_40_vision', defaultKey: 'dreamina_seedance_40_vision' }],
]);

function normalizeKey(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function resolveVideoSettings(opts) {
  const durationSec = Number(opts.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error('Invalid duration: ' + opts.duration);
  }

  const modelInput = String(opts.model || '').trim();
  const model = modelInput ? VIDEO_MODEL_MAP.get(normalizeKey(modelInput)) : null;
  if (modelInput && !model) {
    throw new Error('Unknown model "' + modelInput + '". Known: Seedance 2.0 VIP, Seedance 2.0 Fast VIP');
  }

  return {
    modelLabel: model?.label || '',
    modelKey: model?.key || '',
    defaultModelKey: model?.defaultKey || '',
    durationSec,
    durationMs: Math.round(durationSec * 1000),
  };
}

// ======================== 浏览器 ========================
function resolveBrowser(explicitPath) {
  if (explicitPath && fs.existsSync(explicitPath)) return explicitPath;
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ];
  const hit = candidates.find(c => fs.existsSync(c));
  if (!hit) throw new Error('No browser found. Use --browser.');
  return hit;
}

function resolveProfileDir(explicitPath) {
  if (explicitPath && fs.existsSync(explicitPath)) return explicitPath;
  const defaultDir = 'C:/Users/81921/AppData/Local/Google/Chrome/User Data';
  if (fs.existsSync(defaultDir)) return defaultDir;
  throw new Error('No profile dir found. Use --profile.');
}

// ======================== 页面操作 ========================
async function waitForPageReady(page) {
  // 等待几种可能的页面元素出现（SPA 渲染完毕标志）
  const selectors = [
    '[contenteditable="true"]',  // prompt 输入框
    'input[type="file"]',        // 文件上传
    '[role="combobox"]',         // 下拉选择器
    'button',                    // 任意按钮
  ];
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 8000 });
      console.log('[video] page ready: found "' + sel + '"');
      return true;
    } catch {}
  }
  console.warn('[video] page may not be fully loaded (no expected selectors found)');
  return false;
}

async function gotoVideoPage(page, options) {
  for (let i = 0; i < VIDEO_URLS.length; i++) {
    const url = VIDEO_URLS[i];
    console.log('[video] trying URL [' + (i + 1) + '/' + VIDEO_URLS.length + ']: ' + url);
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 40000 });
      console.log('[video] page loaded successfully');
      await sleep(5000);
      return;
    } catch (e) {
      console.warn('[video] URL ' + i + ' failed: ' + String(e).slice(0, 80));
    }
  }
  console.warn('[video] all URLs failed, continuing with current page state');
}

async function installVideoSettingsInit(page, settings) {
  await page.evaluateOnNewDocument(nextSettings => {
    if (location.hostname !== 'jimeng.jianying.com') return;
    try {
      if (nextSettings.modelKey) {
        localStorage.setItem('dreamina__generator_video_modelKey', JSON.stringify(nextSettings.modelKey));
        if (nextSettings.defaultModelKey) {
          localStorage.setItem('dreamina__generator_video_lastDefaultModelKey', JSON.stringify(nextSettings.defaultModelKey));
        }
      }
      localStorage.setItem('dreamina__generator_video_durationMs', String(nextSettings.durationMs));
    } catch {}
  }, settings);
}

async function applyVideoSettings(page, settings) {
  await page.evaluate(nextSettings => {
    if (nextSettings.modelKey) {
      localStorage.setItem('dreamina__generator_video_modelKey', JSON.stringify(nextSettings.modelKey));
      if (nextSettings.defaultModelKey) {
        localStorage.setItem('dreamina__generator_video_lastDefaultModelKey', JSON.stringify(nextSettings.defaultModelKey));
      }
    }
    localStorage.setItem('dreamina__generator_video_durationMs', String(nextSettings.durationMs));
  }, settings);
}

async function initializeVideoSettings(page, settings) {
  console.log('[video] initializing page settings without dropdown clicks...');
  await applyVideoSettings(page, settings);
  await page.reload({ waitUntil: 'networkidle2', timeout: 40000 });
  await sleep(5000);
  await waitForPageReady(page);
}

async function verifyVideoSettings(page, settings) {
  const state = await page.evaluate(() => {
    const combos = Array.from(document.querySelectorAll('[role="combobox"]')).map(el =>
      (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
    );
    return {
      comboboxes: combos,
      modelKey: localStorage.getItem('dreamina__generator_video_modelKey'),
      lastDefaultModelKey: localStorage.getItem('dreamina__generator_video_lastDefaultModelKey'),
      durationMs: localStorage.getItem('dreamina__generator_video_durationMs'),
    };
  });

  const modelOk = !settings.modelLabel || state.comboboxes.includes(settings.modelLabel);
  const modelKeyOk = !settings.modelKey || state.modelKey === JSON.stringify(settings.modelKey);
  const defaultModelKeyOk = !settings.defaultModelKey || state.lastDefaultModelKey === JSON.stringify(settings.defaultModelKey);
  const durationLabel = settings.durationSec + 's';
  const durationOk = state.durationMs === String(settings.durationMs) && state.comboboxes.includes(durationLabel);
  const ok = modelOk && modelKeyOk && defaultModelKeyOk && durationOk;
  console.log('[video] settings verification: ' + JSON.stringify({ ok, modelOk, modelKeyOk, defaultModelKeyOk, durationOk, ...state }));
  return { ok, modelOk, modelKeyOk, defaultModelKeyOk, durationOk, state };
}

async function dumpPageState(page) {
  return page.evaluate(() => ({
    title: document.title,
    url: location.href,
    comboboxes: Array.from(document.querySelectorAll('[role="combobox"]')).map(el => ({
      text: (el.innerText || '').trim(),
      className: (typeof el.className === 'string' ? el.className : '').slice(0, 60),
    })),
    buttons: Array.from(document.querySelectorAll('button')).filter(b => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !b.disabled;
    }).map(b => ({
      text: (b.innerText || '').trim().slice(0, 40),
      className: (typeof b.className === 'string' ? b.className : '').slice(0, 60),
      disabled: b.disabled,
    })),
    fileInputs: Array.from(document.querySelectorAll('input[type="file"]')).length,
    editables: Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 100;
    }).map(el => ({ className: el.className, w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) })),
  }));
}

// ======================== 上传参考图 ========================
async function uploadReferenceImages(page, imagePaths) {
  const existing = imagePaths.filter(p => p && fs.existsSync(p));
  if (!existing.length) {
    console.log('[video] no reference images to upload');
    return false;
  }

  const fileInput = await page.$('input[type="file"]');
  if (!fileInput) {
    console.warn('[video] file input not found, skipping upload');
    return false;
  }

  console.log('[video] uploading references: ' + existing.map(p => path.basename(p)).join(', '));
  const auditPromise = page.waitForResponse(
    r => r.url().includes('/mweb/v1/imagex/submit_audit_job') && r.request().method() === 'POST',
    { timeout: 30000 }
  ).catch(() => null);

  const acceptsMultiple = await page.evaluate(el => !!el.multiple, fileInput).catch(() => false);
  if (existing.length > 1 && !acceptsMultiple) {
    console.warn('[video] file input does not advertise multiple uploads; trying one DOM upload call anyway');
  }

  await fileInput.uploadFile(...existing);

  const auditResp = await auditPromise;
  if (auditResp) {
    try {
      const payload = await auditResp.json();
      if (payload?.ret && payload.ret !== '0') {
        console.error('[video] audit failed: ' + JSON.stringify(payload));
        return false;
      }
    } catch {}
  }

  await sleep(Math.max(2000, existing.length * 1200));
  console.log('[video] references uploaded successfully');
  return true;
}

// ======================== 填写 Prompt ========================
async function resolvePromptHandle(page) {
  const handle = await page.evaluateHandle(() => {
    const candidates = Array.from(
      document.querySelectorAll('[contenteditable="true"]')
    ).filter(el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 100 && rect.height > 20 && style.display !== 'none' && style.visibility !== 'hidden';
    }).sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (br.width * br.height) - (ar.width * ar.height);
    });
    return candidates[0] || null;
  });
  const target = handle.asElement();
  if (!target) throw new Error('Prompt input not found');
  return target;
}

async function writePrompt(page, prompt) {
  const target = await resolvePromptHandle(page);

  // 清空
  await target.click({ clickCount: 1 });
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await sleep(300);

  // DOM 写入
  await page.evaluate((el, text) => {
    el.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = text;
    el.appendChild(p);
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }, target, prompt);
  await sleep(500);

  // 验证
  const actual = await page.evaluate(el => (el.innerText || el.textContent || '').trim(), target);
  console.log('[video] prompt written: "' + actual.slice(0, 60) + (actual.length > 60 ? '...' : '') + '"');
  if (actual !== prompt.trim()) {
    console.warn('[video] prompt mismatch! expected length=' + prompt.length + ' actual length=' + actual.length);
  }
}

// ======================== 设置时长 ========================
async function selectVideoDuration(page, durationSec) {
  console.log('[video] attempting to set duration to ' + durationSec + 's');

  // 策略1: 查找包含"数字+s"格式的 combobox（如 "4s"、"5s"、"10s"）
  const found = await page.evaluate((targetDuration) => {
    // 找所有 combobox
    const combos = Array.from(document.querySelectorAll('[role="combobox"]'));
    for (const combo of combos) {
      const text = (combo.innerText || '').trim();
      // 精确匹配 "数字+s" 格式 (如 "4s", "5s", "10s")，避免误匹配 "Fast" "VIP" 等
      if (/^\d+s$/i.test(text) || text.includes(targetDuration + 's') || text.includes('时长')) {
        combo.click();
        return { found: true, currentText: text, strategy: 'duration-combo' };
      }
    }

    // 策略1b: 备用 - 宽松匹配包含"秒"或"duration"的
    for (const combo of combos) {
      const text = (combo.innerText || '').trim();
      const lower = text.toLowerCase();
      if (lower.includes('秒') || lower.includes('duration')) {
        combo.click();
        return { found: true, currentText: text, strategy: 'combo-seconds' };
      }
    }
    return { found: false };
  }, durationSec);

  console.log('[video] duration selector: ' + JSON.stringify(found));

  if (!found.found) {
    console.warn('[video] could not find duration selector, continuing anyway');
    return;
  }

  // 等待下拉菜单出现
  await sleep(1500);

  // 查找下拉选项并点击目标时长
  const clicked = await page.evaluate((targetDuration) => {
    // 找所有可见的下拉选项
    const allOptions = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], .option-item-selElF'));
    // 也找普通的可点击元素
    const clickables = Array.from(document.querySelectorAll('div, span, li, button')).filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 30 && rect.height > 20 && el.offsetParent !== null;
    });

    // 优先匹配精确时长文字
    const patterns = [
      targetDuration + 's', targetDuration + '秒',
      targetDuration + 'S', 'duration-' + targetDuration,
    ];

    for (const el of allOptions) {
      const text = (el.innerText || el.textContent || '').trim();
      for (const p of patterns) {
        if (text === p || text.startsWith(p) || text.includes(p)) {
          el.click();
          return { clicked: true, text, strategy: 'option-exact' };
        }
      }
    }

    // 宽松匹配
    for (const el of clickables) {
      const text = (el.innerText || el.textContent || '').trim();
      if (text === targetDuration + 's' || text === targetDuration + '秒') {
        el.click();
        return { clicked: true, text, strategy: 'clickable-exact' };
      }
      if (text.includes(targetDuration + 's') || text.includes(targetDuration + '秒')) {
        el.click();
        return { clicked: true, text, strategy: 'clickable-contains' };
      }
    }

    return { clicked: false };
  }, durationSec);

  console.log('[video] duration selection result: ' + JSON.stringify(clicked));

  // 等待选择生效
  await sleep(1000);
}

// ======================== 设置模型 ========================
async function selectVideoModel(page, modelName) {
  const desired = String(modelName || '').trim();
  if (!desired) return true;

  console.log('[video] attempting to set model to "' + desired + '"');
  const opened = await page.evaluate((targetModel) => {
    const normalize = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const target = normalize(targetModel);
    const combos = Array.from(document.querySelectorAll('[role="combobox"]')).filter(el => {
      const rect = el.getBoundingClientRect();
      const text = normalize(el.innerText || el.textContent || '');
      return rect.width > 30 && rect.height > 20 && el.offsetParent !== null &&
        (text.includes('seedance') || text.includes('模型') || text.includes('model') || text.includes('vip'));
    });

    const exact = combos.find(el => normalize(el.innerText || el.textContent || '') === target);
    const partial = combos.find(el => normalize(el.innerText || el.textContent || '').includes('seedance'));
    const targetEl = exact || partial;
    if (!targetEl) return { opened: false };
    targetEl.click();
    return { opened: true, text: (targetEl.innerText || targetEl.textContent || '').trim().slice(0, 80) };
  }, desired);

  console.log('[video] model selector: ' + JSON.stringify(opened));
  if (!opened.opened) {
    console.warn('[video] could not find model selector, continuing anyway');
    return false;
  }

  await sleep(1500);
  const clicked = await page.evaluate((targetModel) => {
    const normalize = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const target = normalize(targetModel);
    const candidates = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], li, button, span')).filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 30 && rect.height > 20 && el.offsetParent !== null;
    }).map(el => ({
      el,
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
    })).filter(item => item.text);

    for (const item of candidates) {
      const text = normalize(item.text);
      if (text === target) {
        item.el.click();
        return { clicked: true, text: item.text.slice(0, 80), strategy: 'exact' };
      }
    }
    for (const item of candidates) {
      const text = normalize(item.text);
      if (text.startsWith(target + ' ') || text.startsWith(target + '　')) {
        item.el.click();
        return { clicked: true, text: item.text.slice(0, 80), strategy: 'prefix' };
      }
    }
    return { clicked: false, options: candidates.map(item => item.text).filter(text => /seedance|vip|fast/i.test(text)).slice(0, 30) };
  }, desired);

  console.log('[video] model selection result: ' + JSON.stringify(clicked));
  await sleep(1000);
  if (!clicked.clicked) return false;

  const verified = await page.evaluate((targetModel) => {
    const normalize = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const target = normalize(targetModel);
    const combos = Array.from(document.querySelectorAll('[role="combobox"]')).map(el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim());
    const matched = combos.find(text => normalize(text) === target) || '';
    return { ok: Boolean(matched), comboboxes: combos };
  }, desired);
  console.log('[video] model verification: ' + JSON.stringify(verified));
  return verified.ok;
}

// ======================== 点击提交 ========================
async function clickSubmitButton(page) {
  console.log('[video] looking for submit button...');

  // 监听生成请求
  const generatePromise = page.waitForResponse(
    r => r.url().includes('/mweb/v1/aigc_draft/generate') && r.request().method() === 'POST',
    { timeout: 15000 }
  ).catch(() => null);

  const clicked = await page.evaluate(() => {
    // 找 submit-button 类的按钮
    const buttons = Array.from(document.querySelectorAll('button')).filter(b => {
      const c = typeof b.className === 'string' ? b.className : '';
      return c.includes('submit-button-') || c.includes('generate');
    });
    const target = buttons.find(b => {
      if (b.disabled) return false;
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!target) {
      // 兜底：找最右边的大按钮
      const allButtons = Array.from(document.querySelectorAll('button')).filter(b => {
        const r = b.getBoundingClientRect();
        return !b.disabled && r.width > 40 && r.height > 30;
      });
      const rightmost = allButtons.sort((a, b) =>
        b.getBoundingClientRect().right - a.getBoundingClientRect().right
      )[0];
      if (rightmost) {
        rightmost.click();
        return true;
      }
      return false;
    }
    target.click();
    return true;
  });

  if (!clicked) {
    console.warn('[video] submit button not found or not clickable');
    return null;
  }

  console.log('[video] submit button clicked, waiting for API response...');
  const response = await generatePromise;

  if (response) {
    try {
      const payload = await response.json();
      console.log('[video] generate API response: ret=' + (payload?.ret || '?'));
      if (payload?.ret && payload.ret !== '0') {
        console.error('[video] generate failed: ' + JSON.stringify(payload));
      } else {
        const aigcData = payload?.data?.aigc_data;
        console.log('[video] ✅ submission accepted! submit_id=' + (aigcData?.submit_id || 'N/A') + ' history_id=' + (aigcData?.history_record_id || 'N/A'));
        return { submitId: aigcData?.submit_id, historyId: String(aigcData?.history_record_id || '') };
      }
    } catch {
      console.log('[video] generate response received (non-JSON)');
    }
  } else {
    console.log('[video] submission done (no API response captured, may have been sent)');
  }

  return null;
}

// ======================== 主流程 ========================
async function main() {
  const opts = parseArgs();
  const videoSettings = resolveVideoSettings(opts);

  // 验证必填参数
  if (!opts.images.length) { console.error('Usage: --image <path> [--image <path> ...] --prompt <text> [--duration 4] [--model <name>]'); process.exit(1); }
  if (!opts.prompt) { console.error('Usage: --image <path> [--image <path> ...] --prompt <text> [--duration 4] [--model <name>]'); process.exit(1); }

  // 处理图片路径（兼容 Linux 风格的路径）
  const imagePaths = opts.images.map(normalizeImagePath);

  for (const imagePath of imagePaths) {
    if (!fs.existsSync(imagePath)) {
      console.error('Image not found: ' + imagePath);
      process.exit(1);
    }
  }

  console.log('========================================');
  console.log(' 即梦视频模式 - 发送脚本');
  console.log('========================================');
  console.log(' Images  : ' + imagePaths.length);
  imagePaths.forEach((p, i) => console.log('   [' + (i + 1) + '] ' + p));
  console.log(' Prompt  : ' + opts.prompt.slice(0, 80) + (opts.prompt.length > 80 ? '...' : ''));
  console.log(' Duration: ' + videoSettings.durationSec + 's');
  if (videoSettings.modelLabel) {
    console.log(' Model   : ' + videoSettings.modelLabel + ' (' + videoSettings.modelKey + ')');
  }
  console.log(' Select  : ' + (opts.allowClickSelect ? 'dropdown fallback enabled' : 'state init only'));
  console.log('========================================');

  const browserPath = resolveBrowser(opts.browser);
  const profileDir = resolveProfileDir(opts.profile);
  console.log('[video] browser: ' + browserPath);
  console.log('[video] profile: ' + profileDir);

  // 启动浏览器
  const browser = await puppeteer.launch({
    headless: opts.headless ? 'new' : false,
    executablePath: browserPath,
    userDataDir: profileDir,
    defaultViewport: null,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
  });

  // 权限
  try {
    const ctx = browser.defaultBrowserContext?.();
    if (ctx?.overridePermissions) {
      await ctx.overridePermissions('https://jimeng.jianying.com', ['clipboard-read', 'clipboard-write']);
    }
  } catch {}

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    await installVideoSettingsInit(page, videoSettings);

    // Step 1: 导航到视频页面
    console.log('\n[video] Step 1/5: Navigating to video page...');
    await gotoVideoPage(page, opts);
    await sleep(3000);
    await waitForPageReady(page);
    await initializeVideoSettings(page, videoSettings);
    const initialSettings = await verifyVideoSettings(page, videoSettings);
    if (!initialSettings.ok) {
      throw new Error('Requested model/duration was not initialized; refusing to upload or submit.');
    }

    // 打印页面状态
    const state = await dumpPageState(page);
    console.log('[video] Page title: ' + state.title);
    console.log('[video] Comboboxes: ' + JSON.stringify(state.comboboxes));
    console.log('[video] Editables: ' + JSON.stringify(state.editables));
    console.log('[video] Submit buttons: ' + JSON.stringify(state.buttons.filter(b => b.className.includes('submit') || b.text.includes('生成')).slice(0, 3)));

    // Step 2: 上传参考图
    console.log('\n[video] Step 2/5: Uploading reference images...');
    await uploadReferenceImages(page, imagePaths);

    // Step 3: 填写 Prompt
    console.log('\n[video] Step 3/5: Writing prompt...');
    await writePrompt(page, opts.prompt);
    await sleep(1000);

    // Step 4: 设置模型和时长（BUG 规避：先设选项，再重新验证 prompt 没被清空）
    console.log('\n[video] Step 4/5: Setting model/duration...');
    if (opts.allowClickSelect) {
      if (opts.model) {
        const modelOk = await selectVideoModel(page, videoSettings.modelLabel || opts.model);
        if (!modelOk) {
          throw new Error('Requested model was not selected exactly: ' + (videoSettings.modelLabel || opts.model));
        }
      }
      console.log('[video] setting duration to ' + videoSettings.durationSec + 's...');
      await selectVideoDuration(page, videoSettings.durationSec);
    } else {
      await applyVideoSettings(page, videoSettings);
    }

    // 再次 dump 状态看变化
    const stateAfter = await dumpPageState(page);
    console.log('[video] Comboboxes after duration: ' + JSON.stringify(stateAfter.comboboxes));
    const finalSettings = await verifyVideoSettings(page, videoSettings);
    if (!finalSettings.ok) {
      throw new Error('Requested model/duration verification failed before submit.');
    }

    // Step 5: 提交
    console.log('\n[video] Step 5/5: Submitting...');
    const result = await clickSubmitButton(page);

    if (result) {
      console.log('\n[video] ========================================');
      console.log('[video] ✅ VIDEO SUBMISSION SUCCESSFUL!');
      console.log('[video] submit_id: ' + result.submitId);
      console.log('[video] history_id: ' + result.historyId);
      console.log('[video] ========================================');
    } else {
      console.log('\n[video] ⚠️  Submission sent (no API confirmation)');
      console.log('[video] Check browser window for result.');
    }

    // 保持浏览器打开，避免页面端任务在刚提交后被取消。
    console.log('\n[video] Browser will stay open for ' + Math.round(opts.keepOpenMs / 1000) + 's for inspection/generation...');
    await sleep(opts.keepOpenMs);

  } catch (err) {
    console.error('[video] ERROR: ' + err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await browser.close();
    console.log('[video] Browser closed. Done.');
  }
}

main();
