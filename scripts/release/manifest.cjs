const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { readFile, writeFile, stat } = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ARCHIVE = 'leadprocure-images.tar.gz';
const SERVICES = ['api', 'web'];
function validateSource(source) {
  assert.match(source, /^[a-f0-9]{40}$/, 'Full source commit required');
}
function validateEndpoint(endpoint) {
  const url = new URL(endpoint);
  assert(['http:', 'https:'].includes(url.protocol), 'HTTP(S) API URL required');
  assert(!url.username && !url.password && !url.search && !url.hash, 'API URL must not contain credentials, query or fragment');
  assert(!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Public browser API URL required');
  return endpoint;
}
function validateImages(images, source) {
  assert.deepEqual(Object.keys(images).sort(), SERVICES, 'Exactly API and web images required');
  for (const service of SERVICES) {
    const image = images[service];
    assert.equal(image.tag, `leadprocure-${service}:${source}`);
    assert.match(image.id, /^sha256:[a-f0-9]{64}$/);
    assert.equal(image.platform, 'linux/amd64');
    assert.equal(image.revision, source, 'Image revision label mismatch');
  }
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function createManifest(dir, source, endpoint, inspectFiles) {
  validateSource(source);
  validateEndpoint(endpoint);
  const images = {};
  for (const service of SERVICES) {
    const [image] = JSON.parse(await readFile(inspectFiles[service], 'utf8'));
    images[service] = {
      tag: `leadprocure-${service}:${source}`,
      id: image.Id,
      platform: `${image.Os}/${image.Architecture}`,
      revision: image.Config?.Labels?.['org.opencontainers.image.revision'],
    };
    assert(image.RepoTags?.includes(images[service].tag), 'Expected release tag absent');
  }
  validateImages(images, source);
  const archive = path.join(dir, ARCHIVE);
  const manifest = {
    schemaVersion: 1, source, publicApiUrl: endpoint, demoHint: false,
    images,
    archive: { file: ARCHIVE, size: (await stat(archive)).size, sha256: await digest(archive) },
  };
  await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
async function verifyManifest(dir, expectedSource, expectedEndpoint) {
  validateSource(expectedSource);
  validateEndpoint(expectedEndpoint);
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.source, expectedSource, 'Unexpected source commit');
  assert.equal(manifest.publicApiUrl, expectedEndpoint, 'Unexpected browser API URL');
  assert.equal(manifest.demoHint, false);
  validateImages(manifest.images, expectedSource);
  assert.equal(manifest.archive.file, ARCHIVE, 'Unexpected archive path');
  assert.match(manifest.archive.sha256, /^[a-f0-9]{64}$/);
  const archive = path.join(dir, ARCHIVE);
  assert.equal((await stat(archive)).size, manifest.archive.size, 'Archive size mismatch');
  assert.equal(await digest(archive), manifest.archive.sha256, 'Archive checksum mismatch');
  return manifest;
}
function verifyLoadedImages(manifest) {
  for (const service of SERVICES) {
    const expected = manifest.images[service];
    const [actual] = JSON.parse(execFileSync('docker', ['image', 'inspect', expected.tag], { encoding: 'utf8' }));
    assert.equal(actual.Id, expected.id, `Loaded ${service} image ID mismatch`);
    assert.equal(`${actual.Os}/${actual.Architecture}`, expected.platform);
    assert.equal(actual.Config?.Labels?.['org.opencontainers.image.revision'], manifest.source);
  }
}
module.exports = { createManifest, verifyManifest, validateEndpoint, validateSource };
if (require.main === module) {
  const [command, dir, source, endpoint, apiInspect, webInspect] = process.argv.slice(2);
  const task = command === 'create'
    ? createManifest(dir, source, endpoint, { api: apiInspect, web: webInspect })
    : command === 'verify' ? verifyManifest(dir, source, endpoint)
      : command === 'verify-loaded' ? verifyManifest(dir, source, endpoint).then(verifyLoadedImages)
        : Promise.reject(new Error('Use create, verify or verify-loaded'));
  task.then(() => console.log('PASS: release metadata and archive checksums verified'))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
