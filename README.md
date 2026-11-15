# Shared application delivery

Applications need one small Actions entry point. Builds/images/workloads come from native
manifests and Helm; all delivery implementation stays in this repository.
See the [workflow and onboarding guide](bootstrap/README.md).

The shared workflows validate source, create dev packages and release candidates,
compose existing component versions, and approve an existing candidate as a GitHub Release.
QA/CD remain separate. Workflow execution and artifact verification are maintained centrally.

The `v1` workflow version is maintained by successful platform main CI. Existing
`application.yml` callers retain the legacy behavior documented below.

See [legacy application.yml reference](docs/legacy-application.md) for old callers.
