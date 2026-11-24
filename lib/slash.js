// Slash commands for the Codex composer, as a pure parser so the contract is
// node-testable and the UI cannot drift from it. Unknown commands are reported,
// never silently sent to the model as prose.
export const SLASH_COMMANDS = Object.freeze([
  { name: '/new', args: '', description: 'Start a fresh agent thread (keeps files).' },
  { name: '/status', args: '', description: 'Show mode, sandbox, approval and workspace state.' },
  { name: '/diff', args: '', description: 'List the pending patch proposals for this thread.' },
  { name: '/approvals', args: 'suggest|auto-edit|auto-run', description: 'Set the approval mode.' },
  { name: '/model', args: '', description: 'Point at the model picker.' },
  { name: '/imp', args: '<figma link or key> [write]', description: 'Import a Figma file: design tokens, components and a build brief into .figma/.' },
  { name: '/help', args: '', description: 'List these commands.' }
]);
const NAMES = new Set(SLASH_COMMANDS.map((c) => c.name));
const MODES = new Set(['suggest', 'auto-edit', 'auto-run']);
export function parseSlash(input) {
  const text = String(input || '').trim();
  if (!text.startsWith('/')) return { kind: 'prompt', text };
  const [name, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ').trim();
  if (!NAMES.has(name)) return { kind: 'unknown', name, text, error: 'Unknown command ' + name + '. Try /help.' };
  if (name === '/approvals') {
    if (!arg) return { kind: 'command', name, arg: '', error: 'Usage: /approvals suggest|auto-edit|auto-run' };
    if (!MODES.has(arg)) return { kind: 'command', name, arg, error: 'Unknown approval mode "' + arg + '". Use suggest, auto-edit or auto-run.' };
  }
  // `/imp` needs a file. It refuses here rather than sending the word "imp" to
  // the model, which is what an unhandled command used to do.
  if (name === '/imp') {
    if (!arg) {
      return {
        kind: 'command', name, arg: '',
        error: 'Usage: /imp <figma link or file key> [write]\n\nPaste the Share link from Figma (figma.com/design/<key>/…). Add `write` to save the tokens into the workspace.'
      };
    }
  }
  return { kind: 'command', name, arg };
}
export function fileMentions(input) {
  const text = String(input || ''); const out = [];
  const re = /(^|\s)@([\w./-][\w./-]*)/g; let m;
  while ((m = re.exec(text))) { if (!out.includes(m[2])) out.push(m[2]); }
  return out.slice(0, 12);
}
