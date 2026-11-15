# Bootstrap application delivery

Supported profile: GitHub.com/Enterprise Cloud, ephemeral hosted Ubuntu, GHCR, Docker
Bake OCI image exports (linux/amd64), Helm 3, optional Nx/Maven or declared native checks.
This is an implementation profile, not universal registry/build-system support.

1. Retain a reviewed pipeline commit and authorize its use in organization policy.
2. Write `.delivery/application.json` using `schemas/application.schema.json`. Required
   fields define app identity, chart path/name, component-to-workload mappings, compatibility
   labels and the trusted certification issuer. Empty `components: {}` supports chart-only
   packages. The descriptor is trusted control-plane configuration: protect it with CODEOWNERS
   and required review. App authors cannot bypass organization rules through this file.
3. From this checkout, run `node tools/delivery/bootstrap.mjs OUTPUT descriptor.json PIPELINE_SHA`.
   Generate into a clean directory and review the five thin callers before copying them.
   For non-Nx checks, call the exported `scaffold` function with named native command objects,
   or set callers' `project-checks` JSON input. Never copy platform implementation scripts.
4. Run `node tools/delivery/doctor.mjs APP_ROOT` for local preflight. Build recipes need a
   `docker-bake.hcl` application group matching descriptor component keys. Chart values use
   `application.workloads` and BUILD_OUTPUT placeholders. Charts may share an image across
   explicitly mapped workloads. The zero-image profile has no Bake file and empty workloads.
5. Configure protected main and fixed environments `delivery-dev`, `delivery-release` and
   `delivery-promotion`, restricted to protected main. Add required reviewers/separation of
   duties for release and promotion. Configure tag rules protecting `delivery-release/**`
   against update/deletion. Environment names are enforced by shared code, not app inputs.
6. Grant narrowly scoped package/attestation permissions and registry retention. Preserve
   all referenced image manifests, package charts, signatures and OCI referrer evidence.
   Dev and release images/packages use distinct repository paths. Configure organization
   policy/runner controls to prohibit arbitrary workflows writing release package paths;
   workflow token scopes alone are not path-level registry isolation.
7. Configure certification per the protocol below. Private issuer repos require an approved
   read identity; this public reference uses the normal token and fails closed if unreadable.
   Private shared implementation access can use an explicit `platform-read-token` secret
   scoped read-only to the pipeline repository; private certification can use a separate
   `certification-read-token` on promotion only. Tokens should be short-lived. Neither is
   inherited implicitly. Never supply a broad organization token or dependency credential
   to branch builds; the default private-dependency profile remains unsupported.
8. Review actual required-check contexts, then stage platform pins, app callers and
   downstream trust migrations together. Retain old workflow/candidate support for rollback.

Examples: `tests/fixtures/delivery-static` is a non-Nx image/chart application;
`tests/fixtures/delivery-chart-only` is a zero-image application. The regression suite
bootstraps and packages both, checks overwrite refusal and generates an upgraded caller set.

## Human operations

Always dispatch on main. For dev, supply `source-ref` as a same-repository branch name;
that branch is resolved to one SHA. Dev chart/component declarations come from that
exact branch descriptor, while application identity and trust policy remain from main.
This permits testing new components before merging their declarations. Fork packaging is not supported. Release source is
exact dispatch-main SHA; if main moved before resolution, dispatch again. Branch code
runs only in read-only-permission build jobs. Fresh publishers validate data-only OCI
and chart archives before uploads. No packaging workflow accesses Kubernetes.

Create release candidate builds and publishes all components in one operation. Compose
accepts an explicit immutable baseline and optional JSON mapping such as
`{"api":"ghcr.io/acme/orders-release-packages/orders@sha256:..."}`. The override takes
only `api` from that candidate. Equivalent compatibility labels and complete evidence
are required; runtime compatibility is established by new QA, not by the labels alone.
Dev packages are rejected as release baselines. There is deliberately no mutable latest
pointer in v1: explicit digest input is the safe fallback until a conditional discovery
index is implemented. Automatic unchanged-image reuse is deferred.

Promotion consumes a candidate, never rebuilds/repackages it, and verifies certification
before atomically allocating `delivery-release/<release-id>` using Git's create-ref API.
An existing ID can only be retried for the same candidate and policy. The successful
release attestation on the candidate is the completion signal; the tag alone is not.
A failed signing step can be retried without changing the candidate. CD must verify
release evidence, current eligibility, and its separate environment/config pairing.

## Certification integration contract

The configured external issuer signs an attestation on the exact candidate digest with:

```json
{
  "candidate": "ghcr.io/acme/orders-release-packages/orders@sha256:...",
  "status": "certified",
  "policyVersion": "enterprise-v1",
  "revoked": false,
  "issuedAt": "2026-11-15T14:00:00Z",
  "expiresAt": "2026-11-16T14:00:00Z",
  "qa": {
    "status": "passed",
    "candidate": "ghcr.io/acme/orders-release-packages/orders@sha256:..."
  }
}
```

Issuer policy owns QA proof verification, fresh vulnerability scanning and approval.
Promotion verifies its exact workflow/revision, source main, subject, expiry and policy.
The issuer's protected main also maintains the configured `decisionsPath`:

```json
{
  "schemaVersion": 1,
  "candidates": {
    "IMMUTABLE_CANDIDATE": {
      "status": "eligible",
      "policyVersion": "enterprise-v1",
      "expiresAt": "2026-11-16T14:00:00Z"
    }
  }
}
```

Removing, revoking or expiring an entry blocks promotion even if older certificates exist.
No eligible entry is fabricated by bootstrapping. The legacy companion's qualification
predicate is not certification and must not be accepted as such. This source implementation
provides the consumer contract; running QA/certification remains a separate CD integration.

## Recovery, limits and upgrades

No native/BuildKit shared caches are read or written by new package builds; new validation
also disables native/dependency caches. This conservative profile prevents branch cache
poisoning. Cache acceleration can return only with demonstrable trust isolation; namespace
names alone do not isolate runtime cache tokens on the same dispatch ref.

The initial profile caps checks/components at 256 and rejects unsupported inventories with
an actionable error. OCI payload transfer caps each archive at 2 GiB and the entire payload at 4 GiB; archives reject
traversal, symlinks, special files, duplicate paths and excess entries. Larger/multiarch
apps need a separately tested transport adapter. No persistent self-hosted runner support.

Image success followed by chart failure leaves partial outputs, not a complete handoff.
Rerun package creation uses a new run-attempt identity. Once a complete candidate exists,
composition can reuse its images without build. Diagnostics expire; OCI manifests and
attestations are durable and verifiable using `gh attestation verify --bundle-from-oci`.
Keep registry retention and recovery checks in hosted acceptance; never garbage-collect
an image/evidence referenced by a retained package or release.

Descriptor v1 and package v2 are the first supported topology contracts. Legacy application
workflow and candidate v1 stay available, unchanged, for pinned consumers. Pin upgrades are
explicit: generate callers in a fresh directory, extend the reviewed revision allowlist,
review changes, update downstream signer policy, then switch callers. Retain prior pins
for rollback. Breaking schema changes require a new major schema/adapter version.

Hosted acceptance must exercise real dev publication, complete release publication,
composition, signed certification, promotion, conflicts/retries, unauthorized dispatch,
OCI-only recovery and registry retention. Local regression success is not hosted evidence.

Nested reusable validation uses GitHub Cloud's `$/` self-repository syntax to resolve
the pipeline's own reviewed commit, rather than the application's checkout. The linter
exemption is limited to that syntax and the existing exact-self-checkout job contexts.
See [workflow reference syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
and [reusable signer verification](https://cli.github.com/manual/gh_attestation_verify).
