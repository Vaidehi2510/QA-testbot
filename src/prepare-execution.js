// Runs only trusted bot code with credentials. Never extracts or runs PR code.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function prepare({ gh, target, botRepository, requestKey, stateBranch = 'qa-state', outputDir }) {
  if (!/^[a-f0-9]{64}$/.test(requestKey)) throw new Error('Invalid persisted request key.');
  const [owner, repo] = botRepository.split('/');
  const { data } = await gh.rest.repos.getContent({ owner, repo, path: `requests/${requestKey}.json`, ref: stateBranch });
  if (Array.isArray(data) || data.encoding !== 'base64' || data.size > 1024 * 1024) throw new Error('Invalid or oversized execution request.');
  const request = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
  const metadata = request.metadata;
  if (!metadata || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(metadata.repository || '') || !/^[a-f0-9]{40}$/.test(metadata.revision || '') || !Number.isInteger(metadata.prNumber) || !request.plan || !Array.isArray(request.plan.checks) || !Array.isArray(request.config?.runners)) throw new Error('Invalid trusted execution request metadata.');
  if (metadata.repository !== `${process.env.TARGET_OWNER}/${process.env.TARGET_REPO}`) throw new Error('Execution request targets a repository outside this configured installation.');
  const [targetOwner, targetRepo] = metadata.repository.split('/');
  const archive = await target.rest.repos.downloadTarballArchive({ owner: targetOwner, repo: targetRepo, ref: metadata.revision });
  const bytes = Buffer.from(archive.data);
  if (bytes.length > 100 * 1024 * 1024) throw new Error('Source archive exceeds 100 MiB limit.');
  // Force container execution even if a stored local demonstration is supplied.
  request.metadata.fixture = false;
  request.config.execution = { ...request.config.execution, isolation: 'container' };
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'source.tar.gz'), bytes);
  fs.writeFileSync(path.join(outputDir, 'request.json'), JSON.stringify(request, null, 2));
  fs.writeFileSync(path.join(outputDir, 'source.json'), JSON.stringify({ repository: metadata.repository, revision: metadata.revision, requestKey, sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex') }));
  return { requestKey, revision: metadata.revision, bytes: bytes.length };
}

async function main() {
  const { Octokit } = await import('@octokit/rest');
  const { getClient } = require('./github');
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'qa-config.json'), 'utf8'));
  if (!(config.enabled || process.env.QA_ENABLED === 'true') || process.env.DRY_RUN !== 'false') throw new Error('Remote execution is disabled. Explicitly enable QA and disable dry-run first.');
  const gh = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const target = await getClient({ appId: process.env.APP_ID, privateKey: (process.env.APP_PRIVATE_KEY || '').replace(/\\n/g, '\n'), owner: process.env.TARGET_OWNER, repo: process.env.TARGET_REPO });
  console.log(JSON.stringify(await prepare({ gh, target, botRepository: process.env.GITHUB_REPOSITORY, requestKey: process.env.REQUEST_KEY, stateBranch: config.stateBranch || 'qa-state', outputDir: path.resolve(process.env.BUNDLE_DIR || 'qa-bundle') })));
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { prepare };
