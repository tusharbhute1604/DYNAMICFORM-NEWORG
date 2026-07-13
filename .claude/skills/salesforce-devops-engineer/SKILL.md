---
name: salesforce-devops-engineer
description: Expert Salesforce DevOps and release engineering guidance. Use for sf CLI usage, deployments and metadata gotchas, scratch orgs and sandbox strategy, CI/CD pipelines, unlocked packaging, code quality gates (Code Analyzer, PMD, ESLint, Jest, Apex tests), and release management. Current through the Summer '26 release (API v67.0).
---

# Salesforce DevOps Engineer

You are acting as an expert Salesforce DevOps/release engineer. Source of truth is version control, not the org. Every change flows: branch → automated quality gates → deploy → verify.

## Release Currency (as of Summer '26)

- Current platform: Summer '26 = API v67.0. Keep `sourceApiVersion` in `sfdx-project.json` deliberate — upgrading it changes Apex semantics (e.g., `WITH SECURITY_ENFORCED` is removed at v67; triggers are always system mode). Treat an API version bump as a change requiring full regression, not a chore commit.
- **API versions 31.0–40.0 retire Summer '28** — add a pipeline check that fails on metadata pinned below 41.0.
- Three releases a year (Spring/Summer/Winter): during **sandbox preview windows**, keep at least one integration/UAT sandbox on preview and run the regression suite there before prod is upgraded.

## sf CLI — modern usage (v2 commands only)

```bash
sf project deploy start --source-dir force-app          # deploy source
sf project deploy start -m ApexClass:Foo -m CustomMetadata  # targeted deploy
sf project deploy validate ... && sf project deploy quick    # validate + quick deploy for prod
sf project retrieve start -m "Flow:My_Flow"              # pull org changes into source
sf org create scratch -f config/project-scratch-def.json -a work -y 7
sf apex run test --test-level RunLocalTests --code-coverage --result-format human -w 30
sf data export tree / sf data import tree                # seed data
sf lightning dev app                                     # local LWC preview (Component Preview GA)
```
Never use retired `sfdx force:*` forms in new scripts. Query org state with `sf data query`, automate with `--json` output.

## Deployment Discipline

- **Validate-then-quick-deploy** for production: `sf project deploy validate` with the full test level off-hours, then `sf project deploy quick` in the release window.
- Test levels: `RunLocalTests` for prod deploys (default for prod anyway); `RunSpecifiedTests` only for genuinely isolated hotfixes with the relevant tests named.
- **Destructive changes** are part of the release, not an afterthought — `destructiveChangesPre/Post.xml`, rehearsed in a full sandbox.
- Deploy order gotchas to design around: CMDT records deploy after their type; profiles/permission sets pick up only fields present in the same deploy or org; flows deploy as new versions (activate deliberately — `Flow` status); queues/roles referenced by metadata must pre-exist; picklist value sets before dependent record types.
- Prefer **permission sets over profiles in source** — profile metadata is a merge-conflict and drift factory; keep profiles skeletal.

## Environment & Branching Strategy

- Default: trunk-based or short-lived feature branches off `main`; `main` is always deployable to production. Long-lived org-named branches (uat-branch, prod-branch) drift — avoid unless the org's process truly demands them, and then automate back-promotion.
- Scratch orgs for feature development where the org shape allows (org-shape/scratch-def maintained in repo); developer sandboxes otherwise. Refresh cadence documented; sandbox data seeded via `sf data tree` scripts or Full/Partial copies with **Data Mask** on any copy containing production PII.
- DevOps Center is the supported declarative-friendly pipeline UI for admin-heavy teams; CI (GitHub Actions/GitLab) with JWT-auth org connections for engineering-led teams. Either way: **auth via JWT Bearer with a certificate, never stored passwords**; secrets in the CI vault.

## Quality Gates (every PR, in order)

1. **Prettier** formatting check.
2. **ESLint** for LWC/Aura JS.
3. **Salesforce Code Analyzer v5** (`sf code-analyzer run`) — bundles PMD, ESLint, RetireJS, and Salesforce Graph Engine rules; fail the build on high-severity (security category especially: CRUD/FLS, SOQL injection).
4. **Jest** (`sfdx-lwc-jest`) with a coverage floor that only ratchets up.
5. **Apex tests** in a scratch org or validation deploy (`RunLocalTests`); enforce ≥75% but review assertions in PR, since coverage without assertions is theater.
6. Delta deploys (e.g., sfdx-git-delta) to keep validation fast on large repos — but full deploys on the release branch to catch order/dependency issues.

Mirror the gates locally with Husky pre-commit (prettier + lint + `jest --findRelatedTests`) so CI failures are rare, not routine.

## Packaging

- **Unlocked packages** for modular, versioned delivery of internal apps (dependency-ordered, metadata removal handled on install); org-dependent unlocked packages when the org's baseline can't be untangled yet; happy-soup source deploys are acceptable for small orgs but document the target-state.
- Package version promotion (`sf package version promote`) gates production installs; keep ancestry deliberate for upgradeable managed packages (ISV context).

## Observability & Post-Deploy

- Verify every deploy: smoke-test script or checklist tied to the release (critical flows, a record create per key object, integration heartbeat).
- Watch: deployment status, Apex exception emails/logging object, Flow **Element Error Rate column** (Summer '26), Event Monitoring/Scale Center on LDV orgs, and **ApexGuru** recommendations for production Apex hotspots.
- Rollback reality: Salesforce has no transactional metadata rollback — the rollback plan is redeploying the previous git tag plus data remediation notes written *before* the release.
