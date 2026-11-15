# Use the shared delivery workflows

Generate the application Actions entry point:

```sh
node tools/delivery/bootstrap.mjs /tmp/my-app-workflow YOUR_ORG/pipelines v1
```

Review/copy the five files in `.github/workflows`. Each contains only the triggers,
relevant inputs and a call to its one shared pipeline. No delivery scripts, service lists, certificate configuration,
trust lists or extra application descriptor are installed. Existing repositories can
keep their own workflow names/forms and call the same reusable interfaces.

`ci.yml` handles pushes, PRs and main merges only. `dev-package.yml`,
`release-candidate.yml`, `compose-candidate.yml` and `promote-release.yml` are separate
manual workflows, with forms containing only their own inputs. CI never references them.
Composition has no image-build jobs; promotion has no validation/build tree. Dev and
candidate creation reuse the same build implementation because they perform the same
work with different source/publication destinations. Native checks are a shared primitive
without container-proof or manual-delivery jobs.

The platform maintains the compatible `v1` version after main CI passes. Applications
reference that version rather than copying implementation SHAs into multiple settings.
Each run still checks out its exact resolved shared-workflow commit internally.

## Workflow

| Event or manual operation | What happens                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Branch/PR update          | Affected native checks and non-publishing image proofs; duplicate push/PR work is omitted                                                 |
| Merge to main             | Complete validation only                                                                                                                  |
| `dev`                     | Resolve the selected branch, validate it, build images once and publish its complete dev chart                                            |
| `release`                 | Validate current main, build images once and publish a complete candidate                                                                 |
| `compose`                 | Use a complete baseline candidate plus optional component selections from older candidates; publish a new chart without rebuilding images |
| `promote`                 | Verify existing artifacts, check the supplied QA run succeeded, and record human release approval as a normal GitHub Release              |

Always launch manual operations on the application's default branch. Dev branch source
is a separate input, never the workflow execution branch. Nothing here deploys Kubernetes.
QA and deployment stay in the existing CD workflows.

Promotion takes the candidate digest, a release name such as `v1.2.3`, and the successful
QA run URL reviewed by the release owner. GitHub checks that the linked run completed
successfully; the owner is responsible for checking that it tested this candidate.
The workflow does not pretend an arbitrary green run automatically proves compatibility.
To require a second reviewer, configure GitHub's native `release` environment approval.
There is no additional certification service, eligibility ledger or expiring certificate.
The release records the candidate, QA link and approving actor; retry cannot change that
selection. Artifacts are never rebuilt or repackaged during promotion.

## Application declarations

Keep normal build/test commands, the native project graph, Bake's `application` group and
Helm chart. The workflow reads `application.workloads` and `BUILD_OUTPUT` placeholders
from chart values to discover the workload/image mapping. If there is more than one such
chart, supply the ordinary `chart` workflow input. Non-Nx apps can supply native commands
through `project-checks`; chart-only apps get Helm validation automatically.

Composition accepts immutable candidate references. Example override:

```json
{ "api": "ghcr.io/acme/orders-release-packages/orders@sha256:..." }
```

Only `api` comes from that candidate. Original image provenance is preserved, and the new
chart must render the complete expected image inventory. Structural checks do not claim
that arbitrary old/new component combinations are semantically compatible: run the
existing QA process on the assembled candidate before approving its release.

## Platform responsibilities

The shared code owns registry names, safe source/build transfer, digest verification,
artifact signatures, native GitHub release records and limits. Historical artifacts are
accepted only from this shared workflow and pipeline commits merged into its default
branch. Applications do not maintain revision allowlists. Configure retention so images
and evidence referenced by retained candidates/releases are not deleted. Private shared
repositories may need the optional scoped `platform-read-token` read credential.

Builds and inspection run without publication permissions. Fresh publisher jobs upload
validated data without running branch scripts. Shared build caches remain disabled for
these jobs, preventing branch builds from poisoning release caches.

Supported profile: GitHub.com/Enterprise Cloud, hosted Ubuntu, GHCR, Bake, Helm and
linux/amd64. Up to 256 checks/components, 2 GiB per archive and 4 GiB per payload.
Non-Nx and zero-image fixtures exercise onboarding without changing shared implementation.
The legacy `application.yml` interface remains available for existing callers.

The old `delivery.yml` and `package.yml` interfaces remain as compatibility adapters for
already-installed v1 callers during rollout. New entry points do not reference them, and
they cannot add skipped delivery branches to the new CI graph.
