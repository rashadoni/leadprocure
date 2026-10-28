# API/web release packages

`release-artifacts.yml` builds API and web sequentially on an ephemeral GitHub
worker. It does not contact production, use production secrets, push to a registry,
issue licenses, migrate a database or deploy. PR packages are candidates; after
merge, manually dispatch the workflow on `main` to obtain its exact commit.

The current operator-selected browser API URL is `http://75.119.156.234:3100`.
The application remains on `http://75.119.156.234:8180`. No public TLS claim is
made. A dispatch can specify a future API URL; it is part of the checked manifest.

Download the `leadprocure-release-<full-workflow-sha>` artifact from the private
repository workflow run within seven days. It contains only `manifest.json` and
`leadprocure-images.tar.gz`. The manifest records source, browser API URL, platform,
image IDs and archive checksum. The worker removes its image tags, reloads the
archive and checks both restored image IDs before uploading. Existing full
acceptance remains a separate gate; package creation alone does not pass it.

Before any use, take the expected full SHA from the reviewed GitHub run, not from
an untrusted downloaded manifest, and verify against the intended public URL:

```bash
node scripts/release/manifest.cjs verify /absolute/package/directory FULL_40_CHARACTER_SHA http://75.119.156.234:3100
```

This command only reads the package. Checksums detect corruption; they are not
cryptographic publisher signatures. Check the authenticated repository/run and
artifact provenance before trusting a package. Image IDs identify local Docker
images and must not be presented as registry digest references.

Loading images into the production Docker daemon is a separate authorized action.
After an authorized load, `verify-loaded` with the same arguments additionally
checks the actual Docker image IDs, architecture and revision labels. No command
here starts containers. Use a reviewed existing-runtime manifest and migration/
recovery procedure before deployment; do not run `up --build` on Contabo.

These artifacts intentionally contain API/web only. Existing PostgreSQL, storage,
AV and AI containers/volumes are outside this packaging change. Operator licensing,
historical invoice tax policy and actual-IP post-release smoke remain separate.
