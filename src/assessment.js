// An assessment identifies a real PR or a build/release, never a fabricated PR.
const platforms = ['web', 'api', 'android', 'ios', 'macos', 'windows', 'linux'];
function validateTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['kind', 'name', 'platform', 'artifactSha256'].includes(key))
    || !['build', 'release'].includes(value.kind) || !platforms.includes(value.platform)
    || typeof value.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._+:/-]{0,119}$/.test(value.name)
    || !/^[a-f0-9]{64}$/.test(value.artifactSha256 || '')) throw new Error('Build/release assessments need a name, platform and exact artifact SHA-256');
  return { kind: value.kind, name: value.name, platform: value.platform, artifactSha256: value.artifactSha256 };
}
function identity(value) {
  if (value.target !== undefined) {
    if (value.prNumber !== undefined && value.prNumber !== null) throw new Error('Choose a PR or a build/release target, not both');
    return { target: validateTarget(value.target) };
  }
  if (!Number.isSafeInteger(value.prNumber) || value.prNumber < 1 || value.prNumber > 1e9) throw new Error('Assessment requires a real PR number or a build/release target');
  return { prNumber: value.prNumber };
}
function sameIdentity(left, right) {
  try { return JSON.stringify(identity(left)) === JSON.stringify(identity(right)); } catch { return false; }
}
module.exports = { platforms, validateTarget, identity, sameIdentity };
