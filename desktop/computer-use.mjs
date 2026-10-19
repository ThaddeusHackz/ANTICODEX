// Computer-use implementation. Windows uses PowerShell + user32 (no native
// modules required, works inside a packaged .exe). Other platforms fall back to
// xdotool (Linux) or cliclick (macOS). Every action is logged.

import { execFile, exec } from 'node:child_process';
import os from 'node:os';

function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, ...opts }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout?.toString() || '', stderr: stderr?.toString() || error?.message || '' });
    });
  });
}

function ps(script) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

export function createComputerUse() {
  const log = [];

  function record(action, detail, result) {
    log.push({ at: new Date().toISOString(), action, detail, ok: result.ok });
    return { ...result, logged: true };
  }

  async function moveMouse(x, y) {
    if (process.platform === 'win32') {
      const r = await ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y})`);
      return record('move', { x, y }, r);
    }
    if (process.platform === 'linux') return record('move', { x, y }, await run('xdotool', ['mousemove', String(x), String(y)]));
    return record('move', { x, y }, await run('cliclick', [`c:${x},${y}`]));
  }

  async function click(x, y, button = 'left', count = 1) {
    if (process.platform === 'win32') {
      const flag = button === 'right' ? '0x0008' : button === 'middle' ? '0x0020' : '0x0002';
      const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y})
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class M { [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,System.IntPtr e); }'
${Array.from({ length: count }).map(() => `[M]::mouse_event(${flag},0,0,0,[IntPtr]::Zero); [M]::mouse_event(${'0x' + (parseInt(flag) + 1).toString(16).padStart(4, '0')},0,0,0,[IntPtr]::Zero);`).join('; ')}`;
      return record('click', { x, y, button, count }, await ps(script));
    }
    const btn = button === 'right' ? '3' : button === 'middle' ? '2' : '1';
    if (process.platform === 'linux') return record('click', { x, y, button }, await run('xdotool', ['mousemove', String(x), String(y), 'click', '--repeat', String(count), btn]));
    return record('click', { x, y, button }, await run('cliclick', [`c:${x},${y}`]));
  }

  async function type(text) {
    if (process.platform === 'win32') {
      const escaped = text.replace(/'/g, "''");
      const r = await ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`);
      return record('type', { length: text.length }, r);
    }
    if (process.platform === 'linux') return record('type', { length: text.length }, await run('xdotool', ['type', '--delay', '12', text]));
    return record('type', { length: text.length }, await run('cliclick', [`t:${text}`]));
  }

  async function key(combo) {
    if (process.platform === 'win32') {
      const map = { enter: '{ENTER}', tab: '{TAB}', esc: '{ESC}', backspace: '{BS}', ctrl: '^', alt: '%', shift: '+' };
      const keys = combo.split('+').map((k) => map[k.toLowerCase()] || k).join('');
      return record('key', { combo }, await ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys}')`));
    }
    return record('key', { combo }, await run('xdotool', ['key', combo]));
  }

  async function listWindows() {
    if (process.platform === 'win32') {
      const r = await ps('Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object ProcessName,MainWindowTitle | ConvertTo-Json -Compress');
      return record('windows', {}, r);
    }
    return record('windows', {}, await run('bash', ['-lc', 'wmctrl -l 2>/dev/null || true']));
  }

  async function launch(target, args = []) {
    if (process.platform === 'win32') {
      return record('launch', { target }, await run('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${target}'`]));
    }
    return record('launch', { target }, run(target, args, { detached: true, stdio: 'ignore' }).then(() => ({ ok: true })));
  }

  async function shell(command) {
    return new Promise((resolve) => {
      exec(command, { timeout: 60000, shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash' }, (error, stdout, stderr) => {
        resolve(record('shell', { command }, { ok: !error, stdout: String(stdout).slice(0, 8000), stderr: String(stderr).slice(0, 2000) }));
      });
    });
  }

  return {
    moveMouse, click, type, key, listWindows, launch, shell,
    platform: process.platform,
    hostname: os.hostname(),
    getLog: () => [...log]
  };
}
