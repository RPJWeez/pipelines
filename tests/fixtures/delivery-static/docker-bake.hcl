group "application" {
  targets = ["site"]
}
target "site" {
  context = "."
  dockerfile = "Dockerfile"
}
