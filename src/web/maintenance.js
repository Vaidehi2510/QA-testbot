const path = require("node:path");
const crypto = require("node:crypto");
const hash = (value) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function validateFallback(step) {
  if (step.fallback === undefined) return;
  const fallback = step.fallback;
  if (
    !step.selector ||
    !fallback ||
    typeof fallback !== "object" ||
    Array.isArray(fallback) ||
    Object.keys(fallback).some(
      (k) => !["role", "name", "tag", "type"].includes(k),
    ) ||
    typeof fallback.role !== "string" ||
    !/^[a-z]+$/.test(fallback.role) ||
    typeof fallback.name !== "string" ||
    !fallback.name.trim() ||
    fallback.name.length > 300 ||
    (fallback.tag !== undefined &&
      !/^[a-z][a-z0-9-]{0,30}$/.test(fallback.tag)) ||
    (fallback.type !== undefined && !/^[a-z-]{1,30}$/.test(fallback.type))
  )
    throw new Error(
      "Selector fallback requires explicit exact role/name and optional tag/type",
    );
}
async function resolveStepLocator(
  page,
  step,
  {
    repairs = [],
    journey = "",
    stepIndex = 0,
    revision,
    browser,
    viewport,
  } = {},
) {
  const primary = step.selector
    ? page.locator(step.selector)
    : page.getByRole(step.role, { name: step.name, exact: true });
  if (!step.fallback) return primary;
  validateFallback(step);
  // Only an absent original selector may be repaired. An ambiguous or existing
  // selector is never reinterpreted, and an interaction error is never retried.
  const originalCount = await primary.count();
  if (originalCount > 1)
    throw new Error("Original selector is ambiguous; repair refused");
  const fallback = page.getByRole(step.fallback.role, {
    name: step.fallback.name,
    exact: true,
  });
  const checkType = async () => {
    const actual = await fallback.evaluate((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type"),
    }));
    if (
      (step.fallback.tag && actual.tag !== step.fallback.tag) ||
      (step.fallback.type && actual.type !== step.fallback.type)
    )
      throw new Error("Semantic selector target changed its declared type");
  };
  if (originalCount === 1) {
    if ((await fallback.count()) !== 1)
      throw new Error(
        "Original selector no longer matches the declared semantic target",
      );
    // Compare actual handles: a same-named different control must not be clicked.
    const same = await primary.evaluate(
      (el, other) => el === other,
      await fallback.elementHandle(),
    );
    if (!same)
      throw new Error(
        "Original selector targets a different element than its semantic contract",
      );
    await checkType();
    return primary;
  }
  if ((await fallback.count()) !== 1)
    throw new Error("Semantic selector repair requires exactly one target");
  if (!(await fallback.isVisible()))
    throw new Error("Semantic selector target is not visible");
  await checkType();
  const replacement = {
    ...step,
    role: step.fallback.role,
    name: step.fallback.name,
  };
  delete replacement.selector;
  delete replacement.fallback;
  const proposal = {
    id: hash([journey, stepIndex, step, replacement]).slice(0, 24),
    journey,
    stepIndex,
    original: step,
    replacement,
    revision,
    browser,
    viewport,
    status: "proposed",
    persisted: false,
    assertionsChanged: false,
  };
  repairs.push(proposal);
  return fallback;
}
async function approveRepairs({
  originalSuite,
  proposals,
  firstEvidence,
  replayEvidence,
  approvedBy,
  outputPath,
}) {
  if (
    typeof approvedBy !== "string" ||
    !approvedBy.trim() ||
    approvedBy.length > 100
  )
    throw new Error("Explicit repair approval is required");
  for (const evidence of [firstEvidence, replayEvidence]) {
    if (
      !evidence?.revisionVerified ||
      evidence.result?.status !== "passed" ||
      typeof evidence.runId !== "string" ||
      !evidence.runId ||
      !Array.isArray(evidence.repairs)
    )
      throw new Error(
        "Repairs require successful SHA-verified original and independent replay runs",
      );
  }
  if (
    firstEvidence.runId === replayEvidence.runId ||
    ["repository", "prNumber", "revision", "suiteDigest"].some(
      (key) => firstEvidence[key] !== replayEvidence[key],
    )
  )
    throw new Error(
      "Repair replay must be independent and use the same exact revision and suite identity",
    );
  const { validateWebSuite } = require("./audit");
  const normalized = validateWebSuite(originalSuite, firstEvidence);
  if (hash(normalized) !== firstEvidence.suiteDigest)
    throw new Error(
      "Original suite does not match the independently tested suite digest",
    );
  if (!Array.isArray(proposals) || !proposals.length || proposals.length > 120)
    throw new Error("A bounded repair proposal list is required");
  const suite = structuredClone(originalSuite),
    unique = new Map();
  for (const proposal of proposals) {
    const journey = originalSuite.journeys?.find(
        (j) => j.name === proposal.journey,
      ),
      step = journey?.steps?.[proposal.stepIndex];
    if (
      !step ||
      !Number.isInteger(proposal.stepIndex) ||
      proposal.stepIndex < 0 ||
      hash(step) !== hash(proposal.original)
    )
      throw new Error("Repair does not match its original journey step");
    const expected = {
      ...step,
      role: step.fallback?.role,
      name: step.fallback?.name,
    };
    delete expected.selector;
    delete expected.fallback;
    if (!step.fallback || hash(expected) !== hash(proposal.replacement))
      throw new Error("Repair would alter actions or assertions");
    const expectedId = hash([
      proposal.journey,
      proposal.stepIndex,
      step,
      expected,
    ]).slice(0, 24);
    if (
      proposal.id !== expectedId ||
      proposal.revision !== firstEvidence.revision ||
      proposal.status !== "proposed" ||
      proposal.persisted !== false ||
      proposal.assertionsChanged !== false ||
      !normalized.browsers.includes(proposal.browser) ||
      !normalized.viewports.some((v) => v.name === proposal.viewport)
    )
      throw new Error("Repair proposal identity or revision is invalid");
    for (const evidence of [firstEvidence, replayEvidence]) {
      if (!evidence.repairs.some((record) => hash(record) === hash(proposal)))
        throw new Error("Repair is not supported by both replay records");
    }
    // A matrix may propose the same change in several engines and viewports.
    // Validate every observation, then apply each original step only once.
    unique.set(proposal.id, proposal);
  }
  for (const proposal of unique.values())
    suite.journeys.find((j) => j.name === proposal.journey).steps[
      proposal.stepIndex
    ] = structuredClone(proposal.replacement);
  const { safeDirectory, writeExclusive } = require("./visual");
  const directory = await safeDirectory(
    path.dirname(path.resolve(outputPath)),
    true,
  );
  await writeExclusive(
    directory,
    path.basename(outputPath),
    Buffer.from(
      JSON.stringify(
        {
          schemaVersion: 1,
          suite,
          approval: {
            approvedBy,
            repository: firstEvidence.repository,
            prNumber: firstEvidence.prNumber,
            revision: firstEvidence.revision,
            suiteDigest: firstEvidence.suiteDigest,
            runIds: [firstEvidence.runId, replayEvidence.runId],
            approvedAt: new Date().toISOString(),
          },
          proposals: [...unique.values()],
        },
        null,
        2,
      ),
    ),
  );
  return suite;
}
module.exports = { validateFallback, resolveStepLocator, approveRepairs };
