# six-shot-video-maker-skill-public

Public source for the six-shot video maker skill.

## Contents

- `six-shot-video-maker/SKILL.md`
- state and validation scripts
- bundled `gpt` and `jimeng` image workers
- bundled video submission worker
- runtime dependency manifest and lock file

## Local Use

```powershell
cd six-shot-video-maker
npm ci --prefix scripts
node scripts\preflight.mjs --run "<run-dir>"
node scripts\submit_images.mjs --run "<run-dir>"
node scripts\submit_video.mjs --run "<run-dir>"
```

Use `SIX_SHOT_BROWSER` and `SIX_SHOT_PROFILE` to point at the local browser executable and logged-in profile when defaults are not correct.
