# Enterprise hardening checkpoint — 2026-10-30

Starting revisions: website `4c6cae5`, engine `4b5fac3`, Java Ledger `6a15e90`.
Work is isolated on `enterprise-hardening-20261030`; existing engine `.DS_Store` is unrelated and preserved. Java source remains in the existing repository, not a second Ledger.

Baseline: website 149 tests passed locally. Engine baseline needs loopback-enabled execution (sandbox `listen EPERM` is not a product defect). Previous public TodoMVC measurements are scoped benchmark claims, not enterprise qualification. No authorized real Entra tenant, AWS account, model-paid evaluation, independent reviewer or production restore credentials were supplied.

Audit priorities: exact evidence/release binding; optional Java acknowledgment and durable retries; historical plan/usage/evidence; offboarding and direct object access; unattended recovery and budget accounting; safe network resolution; reproducible supported workflow and isolated restore.

No production data is used for testing. No external notifications, paid devices or inference are authorized. Existing deployment authorization permits the reviewed Patchsentry release after checks; customer enforcement stays opt-in.

Update this checkpoint alongside implementation and acceptance evidence before handoff.

Baseline engine rerun: 326 passed / 9 skipped; final engine with real browser flags:
336 passed / 2 skipped (unenrolled Docker framework test images), zero failures.
Production dependency audit: zero advisories reported on 2026-10-30.

Implemented: per-connection public DNS pinning for hosted browser/API oracles;
public-network policy propagated from trusted enrollment; detected credentials
redacted before execution-summary evidence is written. Private runner enrollment
remains compatible. No product code was edited.

Website work continues in `/private/tmp/patchsentry-web` on the matching branch:
Ledger acknowledgment/reconciliation, versioned definitions, effective offboarding,
opt-in deterministic triage, execution-denominator validation, recovery, operational
health, time logs and temporary exceptions. Full acceptance/operations documents
and exact final release revisions are maintained there.
