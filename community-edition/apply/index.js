const { spawnSync } = require("node:child_process");
const utils = require("../utils");
const { execFileSync } = require("node:child_process");

const cfg = utils.readConfig();

// 4D: not upstream.
//
// gen-hcce writes credentials to hcce-secret.yaml rather than into hcce.yaml, so
// that re-applying hcce.yaml cannot overwrite them. But that means a FIRST install
// has no credentials unless hcce-secret.yaml is applied too -- and every pod would
// come up unable to reach the database, with nothing obvious to say why.
//
// So: apply it automatically when the Secret is absent, and never when it is
// present. Re-applying stays safe, and a first install needs no extra step.
const secretExists = spawnSync("kubectl",
  ["get", "secret", "configs", "-n", cfg.Namespace],
  { stdio: "ignore" }).status === 0;

if (secretExists) {
  console.log("configs Secret already exists - NOT applying hcce-secret.yaml.");
  console.log("  To change credentials deliberately:");
  console.log("    kubectl apply -f hcce-secret.yaml");
  console.log("    kubectl rollout restart deploy/reticulum deploy/dialog -n " + cfg.Namespace);
  console.log("  Restart both, or they disagree about PERMS_KEY and voice stops working.");
} else {
  console.log("configs Secret not found - applying hcce-secret.yaml (first install).");
  const r = spawnSync("kubectl", ["apply", "-f", "hcce-secret.yaml"], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error("error: could not apply hcce-secret.yaml. Run gen-hcce first.");
    process.exit(1);
  }
}

// 4D: not upstream. Show what would change, and make someone agree to it.
//
// On 18 November 2026 a plain `kubectl apply -f hcce.yaml` broke TLS on the live
// site: the template carried an haproxy flag the cluster had never had, which made
// a self-signed certificate the one served to every visitor. The site still
// answered HTTP 200, so nothing looked wrong from inside the cluster.
//
// The template and the cluster drift apart because the cluster gets hand-patched
// (kubectl set image, set env, patch) and the template does not. So apply is NOT a
// no-op, and "it is the normal command" is exactly why it is dangerous.
//
// kubectl diff compares against the LIVE object, so it is not fooled by a stale
// last-applied-configuration annotation the way --dry-run=server is.
const skipConfirm = process.argv.includes("--yes");
const diff = spawnSync("kubectl", ["diff", "-f", "hcce.yaml"], { encoding: "utf8" });
const changes = (diff.stdout || "")
  .split("\n")
  .filter(l => /^[+-]/.test(l) && !/^[+-]{3}/.test(l) && !/^[+-]\s*generation:/.test(l));

if (changes.length === 0) {
  console.log("kubectl diff: no changes. Applying is a no-op.");
} else {
  console.log("");
  console.log("kubectl diff reports " + changes.length + " changed line(s):");
  console.log("");
  changes.forEach(l => console.log("  " + l));
  console.log("");
  console.log("Read EVERY line above and be able to say why you want it. Recognising a");
  console.log("line is not the same as wanting it - that is how TLS broke on 18 Nov 2026.");
  console.log("");
  if (!skipConfirm) {
    console.log("Nothing has been applied. To go ahead:  npm run apply -- --yes");
    process.exit(1);
  }
}

// 4D: check the exit status. Upstream discards it, so a partial apply still
// printed "all deployments ready" further down.
const applied = spawnSync("kubectl", ["apply", "-f", "hcce.yaml"], { stdio: "inherit" });
if (applied.status !== 0) {
  console.error("error: kubectl apply -f hcce.yaml failed. Not waiting for rollout.");
  process.exit(applied.status || 1);
}

const config = cfg;
const cmd = "kubectl";
const args = ["-n", config.Namespace, "get", "deployment", "-o", "json"];
const notReady = [];
checkDeployments();

function checkDeployments() {
  const stdout = execFileSync(cmd, args);
  const output = JSON.parse(stdout);
  notReady.length = 0;
  for (const deployment of output.items) {
    if ((deployment.status.readyReplicas ?? 0) < deployment.status.replicas) {
      notReady.push(deployment.metadata.name);
    }
  }
  if (notReady.length > 0) {
    console.log("waiting on", notReady.join(", "));
    setTimeout(checkDeployments, 1000);
  } else {
    console.log("all deployments ready");
  }
}
