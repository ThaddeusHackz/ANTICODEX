#!/usr/bin/env node
import readline from 'node:readline';
import { runCli } from '../lib/cli.js';
import { chat } from '../lib/providers.js';
const callModel = async ({ messages, tools }) => { const out = await chat({ provider: process.env.ANTICODEX_PROVIDER || 'nvidia', model: process.env.ANTICODEX_MODEL || 'default', messages, tools, temperature: 0.2 }); const msg = out && (out.message || out); return { content: (msg && msg.content) || '', tool_calls: (msg && msg.tool_calls) || [] }; };
const ask = (req) => new Promise((resolve) => { const rl = readline.createInterface({ input: process.stdin, output: process.stderr }); rl.question('Allow ' + req.tool + '? [y/N/always] ', (a) => { rl.close(); a = a.trim().toLowerCase(); resolve(a === 'always' ? 'allow_always' : (a === 'y' || a === 'yes') ? 'allow' : 'deny'); }); });
const res = await runCli({ argv: process.argv.slice(2), callModel, ask: process.stdin.isTTY ? ask : null, out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') });
process.exit(res.code || 0);
