export const CUTOUT_POLICY_SOLID_BACKGROUND_HIGH_CONTRAST = 'solid_background_high_contrast';

const CUTOUT_VISUAL_AVOID_TERMS = [
  '波纹、运动弧线、速度线、动作痕迹、残影、模糊或晕染',
  '分离的星星、松散的闪光、漂浮标点、漂浮图标、落下泪滴、分离烟云或松散尘埃',
  '投射阴影、接触阴影、椭圆形地板阴影、地板斑块、落地痕、冲击爆发、发光、光环或柔和透明效果',
  '文本、标签、帧数、可见网格、引导标记、对话气泡、思维气泡、界面面板、代码片段、棋盘格透明、白底、黑底或场景',
  '与色键相邻的 PET、道具、特效、高光或阴影颜色',
  '像素多余、轮廓断开、斑点噪点、裁剪身体部位、重叠姿势或进入邻近帧槽的姿势',
];

export function normalizeCutoutPolicy(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  return normalized === CUTOUT_POLICY_SOLID_BACKGROUND_HIGH_CONTRAST ? normalized : '';
}

export function buildCutoutRequirementLine(taskOrPolicy, provider = 'browser') {
  const rawPolicy =
    typeof taskOrPolicy === 'object' && taskOrPolicy !== null ? taskOrPolicy.cutoutPolicy : taskOrPolicy;
  const cutoutPolicy = normalizeCutoutPolicy(rawPolicy);
  if (!cutoutPolicy) {
    return '';
  }

  const segments = [
    '背景必须保持纯净统一的纯色高对比色键背景，优先使用纯品红 #ff00ff 或纯绿色 #00ff00',
    '背景必须从画布边缘到主体周围完全平涂，不要灰色背景、渐变背景、径向光、背景光斑或任何明暗过渡',
    '主体与背景必须有明显色差，主体内部不要混入接近背景的大片颜色',
    '主体边缘要清晰易分离，主体外部不能有外发光、光晕、柔光边、投影或接触阴影',
    `默认避免：${CUTOUT_VISUAL_AVOID_TERMS.join('；')}`,
  ];

  if (provider === 'jimeng') {
    return `抠图裁切要求：${segments.join('；')}。`;
  }

  return `抠图友好要求：${segments.join('；')}。`;
}
