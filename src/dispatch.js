async function dispatchExecution({ gh, owner, repo, requestKey, ref = 'main', dryRun = false, enabled = false }) {
  if (!/^[a-f0-9]{64}$/.test(requestKey)) throw new Error('Execution request key must be a SHA-256 digest.');
  const preview = { owner, repo, workflow_id: 'qa-execute.yml', ref, inputs: { request_key: requestKey } };
  if (dryRun || !enabled) return { dispatched: false, dryRun, disabled: !enabled, preview };
  await gh.rest.actions.createWorkflowDispatch(preview);
  return { dispatched: true, requestKey, requestedAt: new Date().toISOString() };
}

module.exports = { dispatchExecution };
