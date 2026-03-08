#!/usr/bin/env node
import { printProxyStatus } from '../src/runtime.mjs';
const code = await printProxyStatus();
process.exit(code);
