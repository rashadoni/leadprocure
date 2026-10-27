#!/usr/bin/env bash
# A private test CA is trusted only on this disposable GitHub-hosted worker.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
[[ ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ ]]
: "${FRESH_FIXTURE_DIR:?fresh fixture required}"
tls_dir="$FRESH_FIXTURE_DIR/tls"
mkdir -m 700 "$tls_dir"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -sha256 \
  -subj '/CN=Leadprocure isolated acceptance CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -keyout "$tls_dir/ca.key" -out "$tls_dir/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -sha256 -subj '/CN=app.leadprocure.test' \
  -keyout "$tls_dir/server.key" -out "$tls_dir/server.csr" >/dev/null 2>&1
cat > "$tls_dir/server.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:app.leadprocure.test,DNS:api.leadprocure.test,DNS:s3.leadprocure.test,DNS:blocked.leadprocure.test
EOF
openssl x509 -req -in "$tls_dir/server.csr" -CA "$tls_dir/ca.crt" -CAkey "$tls_dir/ca.key" \
  -CAcreateserial -days 1 -sha256 -extfile "$tls_dir/server.ext" \
  -out "$tls_dir/server.crt" >/dev/null 2>&1
chmod 600 "$tls_dir/ca.key" "$tls_dir/server.key"
task_nss_dir="$HOME/.pki/nssdb"
mkdir -p "$task_nss_dir"
if [[ ! -f "$task_nss_dir/cert9.db" ]]; then
  certutil -N -d "sql:$task_nss_dir" --empty-password
fi
certutil -A -d "sql:$task_nss_dir" -n "leadprocure-acceptance-$GITHUB_RUN_ID" \
  -t 'C,,' -i "$tls_dir/ca.crt"
echo '127.0.0.1 app.leadprocure.test api.leadprocure.test s3.leadprocure.test blocked.leadprocure.test' \
  | sudo tee -a /etc/hosts >/dev/null
cat > "$tls_dir/nginx.conf" <<'EOF'
events {}
http {
  ssl_certificate /test-tls/server.crt;
  ssl_certificate_key /test-tls/server.key;
  ssl_protocols TLSv1.2 TLSv1.3;
  client_max_body_size 25m;
  proxy_set_header Host $http_host;
  proxy_set_header X-Forwarded-Proto https;
  server {
    listen 443 ssl;
    server_name api.leadprocure.test;
    location / { proxy_pass http://api:3000; }
  }
  server {
    listen 443 ssl;
    server_name s3.leadprocure.test;
    location / { proxy_pass http://minio:9000; }
  }
  server {
    listen 443 ssl default_server;
    server_name app.leadprocure.test;
    location / { proxy_pass http://web:80; }
  }
  server {
    listen 443 ssl;
    server_name blocked.leadprocure.test;
    default_type text/html;
    location / { return 200 '<!doctype html><title>Untrusted origin</title>'; }
  }
}
EOF
