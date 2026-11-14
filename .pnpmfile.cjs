// Loom and loom-ui are prereleases: they publish under the `next` dist-tag, and `latest` can lag behind
// it. pnpm prefers the `latest` version whenever it satisfies a range, so a transitive `^0.1.0` inside a
// @loomwork package would pull an old release beside the new one. Every @loomwork dependency, direct or
// transitive, therefore resolves to `next`.
function readPackage(pkg) {
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (name.startsWith("@loomwork/")) deps[name] = "next";
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
