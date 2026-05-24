// Hard validation gate for userId strings.
//
// userId is the storage + addressing key everywhere: file paths
// (<HERMES_HOME>/<userId>/, <userId>.conf, mcp-<userId>.sock), supervisord
// program names (hermes-<userId>), shell template substitution
// (sh -c "hermes profile create <userId>"), env var values, and YAML
// substitution sites. Any character outside [a-z0-9_] is a potential
// injection / path-traversal / supervisord-regex break.
//
// Generator: makeUserId() in admin/user-provisioner.ts emits "u_<8hex>".
// This validator is the contract every consumer relies on. Reject early,
// reject loud — never let a malformed userId reach a shell or filesystem.

const USER_ID_RE = /^u_[a-f0-9]{8}$/;

export type UserId = `u_${string}`;

export function isValidUserId(s: string): s is UserId {
  return USER_ID_RE.test(s);
}

export function assertUserId(s: string): asserts s is UserId {
  if (!USER_ID_RE.test(s)) {
    throw new Error(`invalid userId: must match ${USER_ID_RE.source}`);
  }
}
