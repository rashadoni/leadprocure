# Bundled object storage

The old Docker Hub MinIO server/client images are no longer the installation
source. `Dockerfile` builds the two pinned upstream Git commits with a pinned
Go builder and runtime base digest. Licenses are included in the image;
corresponding source is at the exact public revisions in the Dockerfile.

Upstream MinIO and mc are archived. This snapshot makes the isolated/demo
installation testable; it is not a vendor support/SLA commitment. Operators must
select their storage maintenance/support policy before a client deployment.
See the upstream [distribution notes](https://github.com/minio/minio#source-only-distribution).

Bootstrap creates an existing-or-new bucket and removes anonymous bucket
policies. Failures stop setup. Do not restore anonymous download permissions:
the API grants short-lived presigned access only after its ACL/scan checks.

Existing runtime volumes are not tested by the fresh-install gate. Do not apply
this source snapshot to an existing storage volume without a separate backup,
upgrade/rollback test and deployment authorization.
