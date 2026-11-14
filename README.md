# Shared application delivery

This repository owns the reusable delivery pipeline and its implementation. Application
repositories own source, native build manifests, Docker/Bake declarations, Compose/Helm
runtime configuration, and business tests. They do not copy this repository's scripts.

## Application caller

Create `.github/workflows/ci.yml`, replacing `PIPELINE_COMMIT` with a reviewed full commit SHA:

```yaml
name: Application CI
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
jobs:
  delivery:
    permissions:
      contents: write
      actions: read
      packages: write
      id-token: write
      attestations: write
    uses: RPJWeez/pipelines/.github/workflows/application.yml@PIPELINE_COMMIT
    with:
      chart: charts/my-application
```

The reusable workflow checks out the caller source normally and its own helper code
at `job.workflow_sha` under `.work/delivery`. It installs its own locked dependencies;
it does not resolve helpers from the app or fetch a mutable platform branch. Add `.work`
to application Git/Docker exclusions. No extra access token or inherited secrets are needed
for public platform code. Private enterprise deployments must establish read access first.

This initial profile targets GitHub.com / Enterprise Cloud, hosted Ubuntu runners,
GHCR, a Node 22 verification hook and optional Maven 21 builds. The `job.workflow_*`
identity contexts used for exact self-checkout are not available on Enterprise Server;
that requires a separate tested bootstrap profile. See [GitHub context documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#job-context).

## Application contract

- `npm run verify` runs the app's native source checks (build/test/typecheck/chart lint).
  Override `verify-command` only for a different native entry point. CI validates the
  whole application through this hook; native Nx/Maven/npm caching may select reusable
  outputs. No last-successful-publication range is needed for correctness.
- `docker-bake.hcl` exposes the complete `application` group. `REGISTRY` and `BUILD_TAG`
  variables control output names. Each target publishes exactly one tag.
- `chart` names an app-owned Helm candidate chart with `application.workloads` image
  placeholders (`BUILD_OUTPUT` or `BUILD_OUTPUT:<target>`). Runtime roles may share an image.
- App business tests/fixtures stay in the app. QA consumes these through the qualification
  action's pinned checkout/test hooks; certification and production are separate authorities.
- Private libraries resolve from the same checkout. No independent internal package releases.

PRs validate native source and build all container targets without pushing. A main push
publishes all images, produces/verifies image evidence, binds exact digests into the chart,
checks rendered completeness, publishes the candidate and emits `candidate-handoff`.
The reusable workflow also exposes the complete candidate reference as an output. Successful
publication says **QA pending, certification pending**. Reporting preserves partial outcomes.

Evidence formats and reporting are initially retained for compatibility; simplifying them
is a separate platform change. Legacy report/selection helpers are retained with regression
coverage during extraction but do not become application dependencies.

## Local verification without app tooling scripts

The platform's `verification/Dockerfile` provides the pinned Java/Node/Helm toolchain.
An application can build it from this repository at the same reviewed commit in Compose:

```yaml
services:
  verify:
    profiles: [tools]
    build:
      context: https://github.com/RPJWeez/pipelines.git#PIPELINE_COMMIT
      dockerfile: verification/Dockerfile
    volumes:
      - .:/source:ro
      - nx-cache:/workspace/.nx/cache
volumes:
  nx-cache:
```

The runner copies source into its writable container, excludes host dependencies/caches,
installs locked app dependencies, and runs the same `npm run verify` hook. Outputs remain
inside the container. Keep the caller and toolchain refs together when upgrading. Native
IDE commands remain available; default source verification is not a claim of runtime QA.

## Qualification action

Deployment workflows may reference `RPJWeez/pipelines/.github/actions/qualify@<commit>`.
It keeps the existing Argo two-source/disposable-kind interface. The application supplies
its exact test revision, dependency fixture and business test command. This action is not
an independently universal Job/CronJob or production-health harness.

## Trust migration and activation

Extracting a signer is a trust-contract change. GitHub distinguishes the caller source
repository/ref/digest from the reusable workflow signer. See [reusable workflow attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/increase-security-rating).

Candidate build metadata retains `workflow` for caller identity and adds `delivery.workflow`
and `delivery.revision`. Before accepting new candidates downstream:

1. Pin `RPJWeez/pipelines/.github/workflows/application.yml` and the reviewed pipeline
   commit as the allowed signer. Keep caller repository/ref/source SHA checks. Source CI
   verifies image attestations with both `--signer-workflow` and `--signer-digest`.
2. Update downstream GitHub attestation/Cosign verification to match the observed reusable
   workflow certificate identity; do not simply replace the caller repo everywhere.
   Preserve legacy trust only for retained legacy rollback subjects.
3. Pin QA's exported action and app test-hook paths together. Existing callers pinned to
   old source commits remain intact until deliberately migrated.
4. Observe a real source-main candidate and separate QA/certification run. Inspect build
   evidence and exact attempt identity; neither fixture tests nor a PR grants eligibility.
5. Check required status-check names: caller nesting changes displayed job contexts. Keep
   repository protection changes as an explicit operator activation step.

No certification or production activation is included in this extraction. A source app
migration may be reviewed independently while downstream remains fail-closed.

## Platform development

Run `npm ci`, `npm test` (Node 22+, Helm, git and jq), and `npm run format:check`.
CI also builds the shared verification runner and executes a small app through a read-only
mount. Tests cover candidate completeness, Helm packaging, observed runtime identity,
partial outcomes, attempt isolation, hostile/large metadata, and exact helper checkout.
The FieldSignal chart/cache fixtures are test inputs, not platform runtime assumptions.
Portability build fixtures include a Python API/worker and a standalone frontend; complete
protected second-app governance remains a separate acceptance gate.
