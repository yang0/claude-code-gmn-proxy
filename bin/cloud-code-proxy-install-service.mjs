#!/usr/bin/env node
import { getNodeBinary, getPackageRoot } from '../src/runtime.mjs';
import { getConfig, stopDetachedProxyOnly } from '../src/runtime.mjs';
import { installUserService } from '../src/systemd.mjs';

const config = getConfig();
await stopDetachedProxyOnly();
const servicePath = await installUserService({
  repoRoot: getPackageRoot(),
  nodeBinary: getNodeBinary(),
  host: config.host,
  port: config.port,
});
process.stdout.write(`installed ${servicePath}\n`);
