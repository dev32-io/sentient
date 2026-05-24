// Hermes upstream defaults — do not change without verifying that
// /opt/hermes/hermes_cli/config.py:716-717 still uses the same numbers.
// The hermes-config.yaml.tmpl writes these into every rendered profile,
// and the webui textarea enforces the same caps client-side. Raising
// these would let users write past what Hermes' agent pruner expects to
// keep, causing silent drops of recent memory edits.
export const MEMORY_CHAR_LIMIT = 2200;
export const USER_CHAR_LIMIT = 1375;
