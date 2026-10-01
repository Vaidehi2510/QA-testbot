#!/usr/bin/env node
const { artifactIdentity } = require('./artifact');
const { redact } = require('../ai/context');
async function main(args = process.argv.slice(2)) {
  if (args.length !== 1) throw new Error('Usage: node src/native/hash-artifact.js /absolute/build/App.app');
  const identity = await artifactIdentity(args[0]);
  console.log(JSON.stringify({ artifactSha256: identity.artifactSha256, algorithm: identity.algorithm, bytes: identity.bytes, entries: identity.entries }));
}
if (require.main === module) main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
module.exports = { main };
