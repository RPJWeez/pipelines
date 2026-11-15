const escape = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
const status = (value) =>
  ({
    success: "✅ Passed",
    failure: "❌ Failed",
    cancelled: "🚫 Cancelled",
    skipped: "⏭️ Not run",
  })[value] || "❔ Unconfirmed";
export function renderProjectSummary({
  run,
  plan,
  validations,
  jobs,
  jobDetails,
  results,
  candidate,
  artifacts,
  runUrl,
  notices,
}) {
  const selectionAvailable = Boolean(plan);
  plan ||= {
    projectJobs: [],
    skippedProjects: [],
    images: [],
    selected: { images: [] },
  };
  const pr = run.event === "pull_request";
  const validationOnly = pr || run.validationOnly;
  const failed = ["plan", "validate", "publish-images", "ci"].some((k) =>
    ["failure", "cancelled"].includes(jobs[k]?.result),
  );
  const publicationFailed = [
    "collect-images",
    "image-evidence",
    "publish-chart",
  ].some((k) => ["failure", "cancelled"].includes(jobs[k]?.result));
  const headline = failed
    ? "Build/test checks failed"
    : jobs.ci?.result === "success"
      ? "Build/test checks passed"
      : "Build/test checks incomplete";
  const lines = [
    `# Application delivery — ${headline}${validationOnly ? "" : publicationFailed ? "; candidate publication failed" : candidate ? "; candidate published" : "; candidate not confirmed"}`,
    "",
    run.validationOnly
      ? "Validation only. Images are built for verification; nothing is published or deployed."
      : pr
        ? "PR validation only. Images are built for verification; nothing is published or deployed."
        : "Main builds and publishes the complete application image set. Candidate publication, QA and deployment are separate outcomes.",
    "",
    `[Open this run](${runUrl}) · Commit \`${escape(run.sha.slice(0, 12))}\``,
    "",
    "## Projects and checks",
    "",
    "| Project | Work | Result | Details |",
    "|---|---|---|---|",
  ];
  const lookup = (label) => {
    const job = jobDetails.find((j) => j.name === label),
      record = validations.find((v) => v.name === label);
    return { job, record, result: job?.conclusion || record?.outcome };
  };
  const detail = ({ job, record }, fallback = "Logs") => {
    const failure = job?.steps?.find((s) => s.conclusion === "failure");
    const text = record?.failures?.length
      ? record.failures.join("; ")
      : failure
        ? `Failed: ${failure.name}`
        : fallback;
    return `[${escape(text)}](${job?.html_url || runUrl})`;
  };
  for (const task of plan.projectJobs) {
    const observed = lookup(task.label);
    lines.push(
      `| ${escape(task.project)} | ${escape(task.label.split(" - ")[0])} | ${status(observed.result)} | ${detail(observed)} |`,
    );
  }
  for (const task of plan.skippedProjects || [])
    lines.push(
      `| ${escape(task.project)} | ${escape(task.label.split(" - ")[0])} | Not affected; job omitted | ${escape(task.reason)} |`,
    );
  if (!selectionAvailable)
    lines.push(
      "| — | Project discovery | Unconfirmed | Discovery did not complete; no job matrix could be confirmed |",
    );
  else if (!plan.projectJobs.length)
    lines.push(
      "| — | Project checks | No affected executable projects | See selection scope below |",
    );
  lines.push(
    "",
    "## Images",
    "",
    "| Image | Work | Result | Details |",
    "|---|---|---|---|",
  );
  for (const image of plan.images) {
    const observed = lookup(image.label);
    lines.push(
      `| ${escape(image.target)} | ${validationOnly ? "Build image" : "Build and publish image"} | ${status(observed.result)} | ${detail(observed)} |`,
    );
  }
  const omitted = (plan.selected.images || []).filter(
    (name) => !plan.images.some((i) => i.target === name),
  );
  for (const target of omitted)
    lines.push(
      `| ${escape(target)} | Build image | Not affected; job omitted | Not required for this PR |`,
    );
  lines.push(
    "",
    "## Delivery outcome",
    "",
    "| Stage | Result | Details |",
    "|---|---|---|",
  );
  const stage = (name, key) => {
    const job = jobDetails.find((j) => j.name === name);
    lines.push(
      `| ${escape(name)} | ${status(job?.conclusion || jobs[key]?.result)} | ${detail({ job })} |`,
    );
  };
  stage("Discover projects, affected checks and images", "plan");
  stage("Validation complete", "ci");
  if (validationOnly)
    lines.push(
      pr
        ? "| Candidate publication | Not run | PRs never publish candidates |"
        : "| Candidate publication | Not run | Use the separate manual package workflow |",
    );
  else {
    stage("Verify complete published image inventory", "collect-images");
    for (const job of jobDetails.filter((j) =>
      j.name.startsWith("Sign & attest image - "),
    ))
      lines.push(
        `| ${escape(job.name)} | ${status(job.conclusion)} | ${detail({ job })} |`,
      );
    if (!jobDetails.some((j) => j.name.startsWith("Sign & attest image - ")))
      stage("Image signatures, provenance and SBOMs", "image-evidence");
    stage("Publish complete candidate; QA pending", "publish-chart");
    lines.push(
      "",
      candidate
        ? `**Candidate published:** \`${escape(candidate.reference)}\`. QA pending; certification pending.`
        : "**No complete candidate handoff was recorded.** Successful image builds/pushes alone do not establish a complete candidate.",
    );
  }
  lines.push(
    "",
    "QA, certification and deployment are not performed by this CI workflow.",
    "",
    "<details><summary>Selection, native commands and build/test evidence</summary>",
    "",
    validationOnly
      ? "Selected checks include changed projects and their native-graph consumers. Unknown image mappings are built conservatively."
      : "All executable project checks and all application images are selected on main.",
    "",
    run.validationOnly
      ? "Each job builds its required source dependencies. Shared task/dependency caches are disabled in this validation profile."
      : "Each job builds its required source dependencies. Those dependency builds may repeat across jobs; no private-library publication is required. Native tools may reuse cached task outputs.",
    "",
  );
  for (const task of plan.projectJobs) {
    const { record } = lookup(task.label);
    lines.push(
      `**${escape(task.label)}**`,
      "",
      `Command: \`${escape(record?.command || task.command || task.argv?.join(" "))}\``,
      "",
    );
    if (record?.evidence?.length)
      lines.push("<pre>", ...record.evidence.map(escape), "</pre>", "");
  }
  lines.push(
    "</details>",
    "",
    "## Downloads and immutable outputs",
    "",
    `[Browse run artifacts, build records and test reports](${runUrl}#artifacts)`,
    "",
  );
  const primary = artifacts.filter(
    (a) =>
      ["native-build", "candidate-handoff", "run-report"].includes(a.name) ||
      a.name.startsWith("project-"),
  );
  if (primary.length)
    lines.push(
      ...primary.map(
        (a) =>
          `- [${escape(plan.projectJobs.find((t) => a.name === `project-${t.id}`)?.label || a.name)}](${runUrl}/artifacts/${a.id})`,
      ),
      "",
    );
  if (!pr && results.length) {
    lines.push(
      "<details><summary>Published image/chart digests and evidence</summary>",
      "",
      "| Artifact | Digest | Evidence |",
      "|---|---|---|",
    );
    for (const record of results)
      lines.push(
        `| ${escape(record.project)} | \`${escape(record.destination)}${record.destination.includes("@") ? "" : "@" + escape(record.digest)}\` | ${/^https:\/\//.test(record.evidence || "") ? `[Evidence](${record.evidence})` : escape(record.evidence || "Evidence incomplete")} |`,
      );
    lines.push("", "</details>");
  }
  if (notices.length)
    lines.push(
      "",
      "<details><summary>Report diagnostics</summary>",
      "",
      ...[...new Set(notices)].map((n) => `- ${escape(n)}`),
      "",
      "</details>",
    );
  return lines.join("\n") + "\n";
}
