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

## Project jobs and application contract

The app caller still supplies its candidate chart path and a reviewed platform SHA.
There is no service matrix in the reusable workflow or app caller.

The planner reads the app's native Nx graph and Docker/Bake `application` group:

- A native `ci` target is an explicit per-project check. Its optional
  `metadata.description` supplies a human-readable job name.
- Maven source modules run `./mvnw -pl <project-root> -am verify`, named
  `Build/Test - <project>`. This uses the native reactor, not Nx's experimental Maven
  lifecycle executor. Dependencies build from the same checkout in each isolated job.
- Other Nx projects run their declared `build`, `test`, `typecheck`, and `lint` targets.
  Names describe the work: `Build/Test`, `Build/Typecheck`, `Build`, or `Lint`.
- Repo-wide checks belong in a root native `ci` target, e.g. `Test - Workspace contracts`.
  They remain visible independently of service builds. Local `npm run verify` may retain
  its convenient full-repo command; CI discovers the separate native targets.
- PRs use Nx affected selection against the exact PR base/head, including dependent
  consumers. Root cross-project checks always run. Projects without executable targets
  (such as contract identity nodes) do not get pretend build jobs.
- PR image jobs are `Build Image - <target>`. Dockerfile ownership maps back to affected
  native projects; ambiguous mappings build conservatively. No PR image/cache publication.
- Main runs all native project checks and `Build & Publish Image - <target>` for every
  application image. Matrix metadata is validated and combined before candidate binding;
  publication never carries forward unverified images from unrelated source snapshots.

Adding a service/library/image changes native project/build/runtime declarations and tests,
not the shared pipeline implementation. Matrix jobs may rebuild dependencies locally to
remain self-contained. Caches improve performance without introducing package releases.
The initial auto-discovery profile uses npm/Nx and a root Maven wrapper/reactor. Missing
native graph data or incomplete image metadata fail closed rather than silently skipping work.

### Repositories using other build systems

No app-owned pipeline scripts, Nx install, or Node/Maven app are required. Supply named
native commands through the optional `project-checks` input, for example:

```yaml
with:
  chart: deploy/weather
  project-checks: >-
    [{"name":"weather-api","cwd":"services/weather","command":"python3 -m unittest discover -s source"},
     {"name":"etl-worker","cwd":"workers/etl","command":"make verify"}]
```

These become independent `Build/Test - weather-api` and `Build/Test - etl-worker` jobs.
Without a native dependency graph, all declared checks/images run conservatively.
Commands use the declared repository-contained directory and run without publication
credentials. Additional runtimes/tools can be established by the app's native command;
the default hosted-runner/toolchain profile is documented above. Automatic discovery is
not a claim to infer every possible build system. Up to GitHub's 256 matrix rows per job
are supported. An optional `verify-command` adds a visible whole-app check for migration
or cross-project assertions; it is no longer the default opaque build/test job.

### One run summary

Only `Application delivery summary` writes a job summary. Docker summaries are disabled,
attestation actions set `show-summary: false`, and non-report steps/native child commands
redirect summary output to `/dev/null`. Logs, test artifacts and build records remain
available; they do not create competing summary boxes.

The single report lists project work, unaffected projects, each image build, failed steps,
publication/evidence outcomes, candidate identity, and direct log/artifact links. Native
build/test evidence and cache disclosures sit in one expandable section. A successful
image build is distinct from candidate publication, QA, certification, and deployment.
PRs never publish. Main candidate publication says **QA pending, certification pending**.
Image recipes/Bake must expose one publication tag per target, controlled by `REGISTRY`
and `BUILD_TAG`. The app-owned Helm chart uses `application.workloads` build placeholders
(`BUILD_OUTPUT` or `BUILD_OUTPUT:<target>`). Private libraries resolve from checkout.

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
