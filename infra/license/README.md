The operator supplies `leadprocure.license` in this directory and sets
`LICENSE_PUBLIC_KEY_B64` to the issuer's Ed25519 public key. Compose mounts the
directory read-only. An absent/invalid license keeps production restricted.

Never place the issuer's private key here. License tokens and private keys must
not be committed. Existing installations may set `LICENSE_DIR` to their current
operator-managed license directory instead.
