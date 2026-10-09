import fs from "node:fs";
import { spawnSync } from "node:child_process";

/** Both descriptors must already own the kernel locks on these exact open descriptions.
 * flock on the inherited description is reentrant; another open of the inode is not. */
export function verifyInheritedConfigLocks(fenceBase: string): { model: number; owner: number } | null {
  const values = [process.env.GOLEM_CONFIG_MODEL_FD, process.env.GOLEM_CONFIG_OWNER_FD];
  if (values.every(value => value === undefined)) return null;
  const [model, owner] = values.map(Number);
  if (!Number.isInteger(model) || !Number.isInteger(owner) || model < 3 || owner < 3 || model === owner) throw new Error("CONFIG_LOCK_DESCRIPTOR_INVALID");
  for (const [fd, suffix] of [[model, ".model-fence.lock"], [owner, ".owner-write.lock"]] as const) {
    const held = fs.fstatSync(fd), expected = fs.statSync(fenceBase + suffix);
    if (held.dev !== expected.dev || held.ino !== expected.ino) throw new Error("CONFIG_LOCK_IDENTITY_MISMATCH");
    if (!/FLOCK\s+ADVISORY\s+WRITE\s/.test(fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"))) throw new Error("INHERITED_CONFIG_LOCK_NOT_HELD");
  }
  for (const descriptor of ["3", "4"]) {
    const result = spawnSync("flock", ["-n", descriptor], { stdio: ["ignore", "ignore", "ignore", model, owner] });
    if (result.error || result.status !== 0) throw new Error("INHERITED_CONFIG_LOCK_NOT_HELD");
  }
  return { model: model, owner: owner };
}
