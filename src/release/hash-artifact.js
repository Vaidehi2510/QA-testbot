#!/usr/bin/env node
const { hashArtifact } = require('./artifact');
if (process.argv.length !== 3) { console.error('Usage: npm run qa:hash-artifact -- /absolute/build/artifact.zip'); process.exitCode = 1; }
else hashArtifact(process.argv[2]).then(artifactSha256 => console.log(JSON.stringify({ artifactSha256 }))).catch(error => { console.error(error.message); process.exitCode = 1; });
