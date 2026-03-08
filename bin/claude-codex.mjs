#!/usr/bin/env node
import { execClaudeWithProxy } from '../src/runtime.mjs';
await execClaudeWithProxy(process.argv.slice(2));
