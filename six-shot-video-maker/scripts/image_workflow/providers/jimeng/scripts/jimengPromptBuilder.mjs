export function normalizeText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseScenePrompt(prompt) {
  const block = normalizeText(prompt);
  const sceneMatch = block.match(/环境[:：]\s*(.+?)(?:动作[:：]|$)/u);
  const actionMatch = block.match(/动作[:：]\s*(.+?)$/u);

  return {
    block,
    scene: normalizeText(String(sceneMatch?.[1] ?? '').replace(/[。；;，,\s]+$/u, '')),
    action: normalizeText(String(actionMatch?.[1] ?? '').replace(/[。；;，,\s]+$/u, '')),
  };
}

export function inferCluster(scene, action) {
  const text = `${scene} ${action}`;
  if (/(机房|服务器|告警|链路|数据中心|拓扑|监控|终端)/u.test(text)) return 'server';
  if (/(会议|工位|办公室|高管|评审|汇报|合同|面试|绩效)/u.test(text)) return 'office';
  if (/(黑市|街道|夜市|酒吧|地下|暗网|论坛|网吧|客服|小巷)/u.test(text)) return 'street';
  if (/(法庭|审讯|审计|合规|协议|卷宗|档案|判决)/u.test(text)) return 'tribunal';
  if (/(实验室|研究|公式|模型|引擎|神经网络|炼丹)/u.test(text)) return 'lab';
  if (/(宇宙|虚空|星空|法则|太空|世界尽头)/u.test(text)) return 'cosmos';
  if (/(神殿|王座|天道|天庭|学堂|讲坛)/u.test(text)) return 'temple';
  if (/(工厂|车间|流水线|仓库|码头|集装箱)/u.test(text)) return 'factory';
  if (/(医院|病房|病床|ICU|医疗|濒死)/u.test(text)) return 'hospital';
  if (/(出租屋|卧室|房间|独居|屏幕前|工位前)/u.test(text)) return 'room';
  if (/(废墟|爆炸|燃烧|事故|残骸|烟尘)/u.test(text)) return 'disaster';
  return 'general';
}

const CLUSTER_RULES = {
  server: 'Show racks, cables, alarms, terminals, and obvious failure pressure. Avoid a generic blue-code wallpaper.',
  office: 'Show desks, screens, documents, meeting residue, and rank pressure. Avoid a generic boardroom poster look.',
  street: 'Show wet ground, neon spill, stalls, alleys, underground survival details. Avoid a clean hero shot.',
  tribunal: 'Show files, surveillance, contracts, desk order, and judgment pressure. Avoid abstract symbolic emptiness.',
  lab: 'Show devices, containers, projections, formulas, and an actual experiment-in-progress feel.',
  cosmos: 'Show scale, void, stars, law-like structures, and real spatial depth. Avoid empty floating posing.',
  temple: 'Show ritual space, pillars, screens, stairs, throne or power apparatus. Avoid stage-like symmetry.',
  factory: 'Show machinery, pipes, conveyors, hazard zones, and industrial grime. Avoid clean showroom polish.',
  hospital: 'Show beds, instruments, cold lights, wires, weakness, and medical pressure. Avoid glossy concept art.',
  room: 'Show cramped personal space, worn furniture, screen glow, and traces of life. Avoid luxury apartment vibes.',
  disaster: 'Show smoke, debris, fire, collapse, and aftermath. Avoid cinematic blockbuster polish.',
  general: 'Keep it grounded in one real location with readable depth and atmosphere, not a generic toy poster.',
};

const CLUSTER_AVOIDS = {
  server: ['generic meeting room', 'clean corporate poster'],
  office: ['generic server room', 'empty rooftop posing'],
  street: ['generic office corridor', 'clean showroom floor'],
  tribunal: ['vague floating symbols', 'empty cosmic void'],
  lab: ['generic blue server room', 'corporate stage backdrop'],
  cosmos: ['plain office room', 'plain rooftop posing'],
  temple: ['factory showroom', 'poster symmetry'],
  factory: ['clean office room', 'door-sign splash art'],
  hospital: ['heroic poster pose', 'warm cozy room'],
  room: ['generic rooftop', 'generic boardroom'],
  disaster: ['clean product render', 'toy showcase'],
  general: ['generic server room', 'generic boardroom', 'generic rooftop', 'door-sign splash art'],
};

const RETRY_SAFE_SCENES = {
  server: 'a dim retro server room with cables, warning lights, terminals, and hardware pressure',
  office: 'a crowded overtime office with desks, monitors, paperwork, and corporate pressure',
  street: 'a wet neon backstreet with stalls, alleys, signs, and survival atmosphere',
  tribunal: 'a cold archive chamber with files, contracts, surveillance, and judgment pressure',
  lab: 'a compact experimental lab with devices, glass containers, projections, and active testing',
  cosmos: 'a deep void-like world with stars, giant structures, and strong spatial depth',
  temple: 'a ritual power hall with pillars, stairs, screens, and a ceremonial throne area',
  factory: 'a grimy factory floor with machinery, pipes, conveyors, and hazard lights',
  hospital: 'a cold medical room with beds, monitors, instruments, and emergency tension',
  room: 'a cramped personal room with screen glow, worn furniture, and traces of life',
  disaster: 'a damaged urban ruin with smoke, debris, sparks, and collapse aftermath',
  general: 'a grounded retro pixel-art location with clear depth, atmosphere, and story tension',
};

const RETRY_SAFE_ACTIONS = {
  avatar: 'the robot is in the middle of work, reacting to pressure instead of posing',
  ending: 'the robot is caught in a decisive story moment with visible tension',
  specialEnding: 'the robot is in a climactic story moment with strong atmosphere',
  default: 'the robot is mid-action in a story moment, not posing for the camera',
};

function buildImageDescription(parsed, cluster) {
  const parts = [];
  if (parsed.scene) parts.push(`环境：${parsed.scene}。`);
  if (parsed.action) parts.push(`动作：${parsed.action}。`);
  parts.push(CLUSTER_RULES[cluster]);
  return normalizeText(parts.join(' '));
}

function buildRetrySafeImageDescription(cluster, sourceKind) {
  const scene = RETRY_SAFE_SCENES[cluster] || RETRY_SAFE_SCENES.general;
  const action = RETRY_SAFE_ACTIONS[sourceKind] || RETRY_SAFE_ACTIONS.default;
  return normalizeText(`Scene: ${scene}. Action: ${action}.`);
}

export function buildJimengPrompt(scenePrompt, options = {}) {
  const parsed = parseScenePrompt(scenePrompt);
  const cluster = options.cluster || inferCluster(parsed.scene || parsed.block, parsed.action);
  const composition = options.size === 'landscape_16_9' ? 'wide story frame, still square-safe composition for the character' : 'square composition';
  const promptProfile = options.promptProfile || 'default';
  const avoid = [
    'HD',
    'crisp',
    'polished',
    'cinematic',
    'detailed illustration',
    '3D',
    'splash art',
    'poster layout',
    'character redesign',
    'extra characters',
    'clean UI',
    'readable small text',
    ...(CLUSTER_AVOIDS[cluster] || []),
  ];
  const imageDescription =
    promptProfile === 'retry-safe'
      ? buildRetrySafeImageDescription(cluster, options.sourceKind)
      : buildImageDescription(parsed, cluster);

  return normalizeText(`
Generate 1 images as one retro pixel-art story set with the same fixed character in all images.

Character:

a small black square-head robot, pure black screen face, white diamond-shaped eyes, short red cape, golden double-ring halo.

Same face, same body proportions, same silhouette, no redesign.

Unified style:

pure retro pixel art,
native 128x128 look, not HD pixel art
intentionally blurred sprite edges
tiny screenshot enlarged 8x
low detail, unreadable micro-details
soft pixel blocks, not crisp pixel blocks
extremely blurry
old arcade screenshot feeling
fuzzy, degraded, low-resolution
not sharp, not polished, not 3D

Image 1: ${imageDescription}

Rules:

single character only
full body visible
${composition}
same character design in every frame
story moment, not posing
gameplay screenshot, not poster
strong scene depth
strong atmosphere
low clarity, simplified details

Avoid:

${avoid.join(', ')}.
`);
}
