// The QoderAI repositories, as data.
//
// 49 public repositories, read from the GitHub API (name, language, stars, size)
// and paired with a note saying what each one is and what ANTICODEX took from it.
// `integrated: true` means code in this repository is derived from it — the rest
// are references, release notes, or empty placeholders, and they say so instead
// of padding the list.
//
// Kept as a static table on purpose: it is a survey of a third party, not a live
// feed. `node scripts/sync-qoder-atlas.mjs` regenerates it.

export const QODER_OWNER = 'qoderAI';

/** @type {{name:string,url:string,kind:string,language:string|null,stars:number,size_kb:number,summary:string,use:string,tags:string[],integrated:boolean}[]} */
export const QODER_REPOS = [
  {
    "name": "better-harness",
    "url": "https://github.com/qoderAI/better-harness",
    "kind": "tool",
    "language": "JavaScript",
    "stars": 2407,
    "size_kb": 11327,
    "summary": "Harness Engineering platform: runs through your coding agent and turns session evidence into prioritised improvements.",
    "use": "Reference for ANTICODEX’s own evidence-first loop (REA evidence records, plan → apply).",
    "tags": [
      "harness",
      "insights"
    ],
    "integrated": false
  },
  {
    "name": "qoder-action",
    "url": "https://github.com/qoderAI/qoder-action",
    "kind": "action",
    "language": "JavaScript",
    "stars": 56,
    "size_kb": 24,
    "summary": "GitHub Action that runs qodercli (code review, @qoder chat, custom tasks).",
    "use": "The workflow generator (qoderActionWorkflow) and the qodercli version pin.",
    "tags": [
      "GitHub Actions",
      "qodercli"
    ],
    "integrated": true
  },
  {
    "name": "qodercli-bench-qwen3.8",
    "url": "https://github.com/qoderAI/qodercli-bench-qwen3.8",
    "kind": "bench",
    "language": "JavaScript",
    "stars": 45,
    "size_kb": 868030,
    "summary": "Benchmark corpus for qodercli on Qwen 3.8 (large asset repository, not cloned).",
    "use": "Not needed to run the integration; linked for reference.",
    "tags": [
      "benchmark"
    ],
    "integrated": false
  },
  {
    "name": "Qoderian",
    "url": "https://github.com/qoderAI/Qoderian",
    "kind": "app",
    "language": "TypeScript",
    "stars": 31,
    "size_kb": 4664,
    "summary": "Obsidian plugin that embeds qodercli as a collaborator inside a vault.",
    "use": "Reference for embedding the CLI in a host app; the ACP path here is the general form of it.",
    "tags": [
      "Obsidian",
      "embedding"
    ],
    "integrated": false
  },
  {
    "name": "agentic-coding-durability-evalset",
    "url": "https://github.com/qoderAI/agentic-coding-durability-evalset",
    "kind": "eval",
    "language": null,
    "stars": 17,
    "size_kb": 5,
    "summary": "Evaluation set for long-running agentic coding sessions.",
    "use": "Reference for durability/checkpoint expectations.",
    "tags": [
      "evals"
    ],
    "integrated": false
  },
  {
    "name": "forward-quickstart",
    "url": "https://github.com/qoderAI/forward-quickstart",
    "kind": "app",
    "language": "TypeScript",
    "stars": 14,
    "size_kb": 1179,
    "summary": "Web demo of the Forward API: end-user identity, template, session, SSE, voice relay.",
    "use": "The session lifecycle the Qoder page walks: identity → template → session → events.",
    "tags": [
      "QCA",
      "SSE",
      "voice"
    ],
    "integrated": true
  },
  {
    "name": "qoder-cloud-agents-sdk-go",
    "url": "https://github.com/qoderAI/qoder-cloud-agents-sdk-go",
    "kind": "sdk",
    "language": "Go",
    "stars": 11,
    "size_kb": 940,
    "summary": "Go client for the QCA APIs.",
    "use": "Confirms endpoint paths and error shapes independently of the TypeScript SDK.",
    "tags": [
      "QCA",
      "Go"
    ],
    "integrated": true
  },
  {
    "name": "qoder-agent-sdk-samples",
    "url": "https://github.com/qoderAI/qoder-agent-sdk-samples",
    "kind": "demo",
    "language": "TypeScript",
    "stars": 10,
    "size_kb": 659,
    "summary": "Runnable samples for the Qoder Agent SDK in TypeScript and Python.",
    "use": "Session streaming, checkpoints and error handling references.",
    "tags": [
      "Agent SDK",
      "sessions"
    ],
    "integrated": false
  },
  {
    "name": "cloud-agents",
    "url": "https://github.com/qoderAI/cloud-agents",
    "kind": "docs",
    "language": null,
    "stars": 9,
    "size_kb": 71,
    "summary": "Entry point and documentation for Qoder Cloud Agents.",
    "use": "Vocabulary and links surfaced on the Qoder page.",
    "tags": [
      "QCA"
    ],
    "integrated": false
  },
  {
    "name": "qoder-cloud-agents-sdk-python",
    "url": "https://github.com/qoderAI/qoder-cloud-agents-sdk-python",
    "kind": "sdk",
    "language": "Python",
    "stars": 9,
    "size_kb": 1257,
    "summary": "Python client for the same two APIs.",
    "use": "Second reading of the contract — used to confirm request bodies and pagination.",
    "tags": [
      "QCA",
      "Python"
    ],
    "integrated": true
  },
  {
    "name": "qoder-cloud-agents-sdk-ts",
    "url": "https://github.com/qoderAI/qoder-cloud-agents-sdk-ts",
    "kind": "sdk",
    "language": "TypeScript",
    "stars": 9,
    "size_kb": 1441,
    "summary": "Typed client for the Qoder Cloud Agents Forward and Managed APIs (qca-sdk).",
    "use": "The API contract for lib/qoder.js: base URLs, auth, cursor pages, SSE event stream.",
    "tags": [
      "QCA",
      "TypeScript"
    ],
    "integrated": true
  },
  {
    "name": "qoder-acp-demos",
    "url": "https://github.com/qoderAI/qoder-acp-demos",
    "kind": "demo",
    "language": "TypeScript",
    "stars": 4,
    "size_kb": 21,
    "summary": "Reference ACP client that drives a real qodercli --acp process over stdio NDJSON.",
    "use": "The ACP client in lib/qoder.js: initialize, session/new, session/prompt, permission prompts.",
    "tags": [
      "ACP",
      "stdio"
    ],
    "integrated": true
  },
  {
    "name": "qoder-cloud-agents-opc",
    "url": "https://github.com/qoderAI/qoder-cloud-agents-opc",
    "kind": "app",
    "language": "Python",
    "stars": 4,
    "size_kb": 1730,
    "summary": "Operra — a reference product built on QCA (sessions, GitHub collaboration, deployments).",
    "use": "Product patterns; not copied.",
    "tags": [
      "QCA",
      "reference"
    ],
    "integrated": false
  },
  {
    "name": "changelog-CLI",
    "url": "https://github.com/qoderAI/changelog-CLI",
    "kind": "changelog",
    "language": null,
    "stars": 3,
    "size_kb": 2,
    "summary": "Release notes (EN) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "changelog-QoderWake-zh_CN",
    "url": "https://github.com/qoderAI/changelog-QoderWake-zh_CN",
    "kind": "changelog",
    "language": null,
    "stars": 3,
    "size_kb": 3404,
    "summary": "Release notes (中文) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "changelog-QoderWake",
    "url": "https://github.com/qoderAI/changelog-QoderWake",
    "kind": "changelog",
    "language": null,
    "stars": 2,
    "size_kb": 6271,
    "summary": "Release notes (EN) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "homebrew-qoder",
    "url": "https://github.com/qoderAI/homebrew-qoder",
    "kind": "cli",
    "language": "Ruby",
    "stars": 2,
    "size_kb": 162,
    "summary": "Homebrew cask that installs qodercli on macOS.",
    "use": "Install instructions shown when qodercli is missing.",
    "tags": [
      "install"
    ],
    "integrated": false
  },
  {
    "name": "qoder-cloud-agents-sdk-java",
    "url": "https://github.com/qoderAI/qoder-cloud-agents-sdk-java",
    "kind": "sdk",
    "language": "Java",
    "stars": 2,
    "size_kb": 573,
    "summary": "Java client for the QCA APIs.",
    "use": "Confirms the resource layout (agents, sessions, deployments, skills, vaults).",
    "tags": [
      "QCA",
      "Java"
    ],
    "integrated": true
  },
  {
    "name": "blog-zh_CN",
    "url": "https://github.com/qoderAI/blog-zh_CN",
    "kind": "docs",
    "language": null,
    "stars": 1,
    "size_kb": 0,
    "summary": "Blog content repository.",
    "use": "Reference only.",
    "tags": [
      "blog"
    ],
    "integrated": false
  },
  {
    "name": "changelog-QoderWork-zh_CN",
    "url": "https://github.com/qoderAI/changelog-QoderWork-zh_CN",
    "kind": "changelog",
    "language": null,
    "stars": 1,
    "size_kb": 1,
    "summary": "Release notes (中文) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "changelog-zh_CN",
    "url": "https://github.com/qoderAI/changelog-zh_CN",
    "kind": "changelog",
    "language": null,
    "stars": 1,
    "size_kb": 0,
    "summary": "Release notes (中文) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "cloud-agents-cookbook",
    "url": "https://github.com/qoderAI/cloud-agents-cookbook",
    "kind": "docs",
    "language": "JavaScript",
    "stars": 1,
    "size_kb": 12157,
    "summary": "Recipes for common Qoder Cloud Agents tasks.",
    "use": "Patterns for webhooks, schedules and batches (documented, not yet wired).",
    "tags": [
      "cookbook"
    ],
    "integrated": false
  },
  {
    "name": "qoder-plugins-official",
    "url": "https://github.com/qoderAI/qoder-plugins-official",
    "kind": "empty",
    "language": null,
    "stars": 1,
    "size_kb": 0,
    "summary": "Empty repository reserved for official plugins.",
    "use": "Nothing to integrate yet.",
    "tags": [],
    "integrated": false
  },
  {
    "name": "blog",
    "url": "https://github.com/qoderAI/blog",
    "kind": "docs",
    "language": null,
    "stars": 0,
    "size_kb": 0,
    "summary": "Blog content repository.",
    "use": "Reference only.",
    "tags": [
      "blog"
    ],
    "integrated": false
  },
  {
    "name": "changelog",
    "url": "https://github.com/qoderAI/changelog",
    "kind": "changelog",
    "language": null,
    "stars": 0,
    "size_kb": 0,
    "summary": "Release notes (EN) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "changelog-AgentSDK",
    "url": "https://github.com/qoderAI/changelog-AgentSDK",
    "kind": "changelog",
    "language": null,
    "stars": 0,
    "size_kb": 0,
    "summary": "Release notes (EN) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "changelog-AgentSDK-zh_CN",
    "url": "https://github.com/qoderAI/changelog-AgentSDK-zh_CN",
    "kind": "changelog",
    "language": null,
    "stars": 0,
    "size_kb": 0,
    "summary": "Release notes (中文) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "changelog-app",
    "url": "https://github.com/qoderAI/changelog-app",
    "kind": "changelog",
    "language": null,
    "stars": 0,
    "size_kb": 0,
    "summary": "Release notes (EN) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "changelog-app-CN-zh_CN",
    "url": "https://github.com/qoderAI/changelog-app-CN-zh_CN",
    "kind": "changelog",
    "language": null,
    "stars": 0,
    "size_kb": 0,
    "summary": "Release notes (中文) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "changelog-app-zh_CN",
    "url": "https://github.com/qoderAI/changelog-app-zh_CN",
    "kind": "changelog",
    "language": null,
    "stars": 0,
    "size_kb": 0,
    "summary": "Release notes (中文) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "changelog-CLI-zh_CN",
    "url": "https://github.com/qoderAI/changelog-CLI-zh_CN",
    "kind": "changelog",
    "language": null,
    "stars": 0,
    "size_kb": 0,
    "summary": "Release notes (中文) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "changelog-CloudAgents",
    "url": "https://github.com/qoderAI/changelog-CloudAgents",
    "kind": "changelog",
    "language": null,
    "stars": 0,
    "size_kb": 0,
    "summary": "Release notes (EN) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "changelog-CloudAgents-zh_CN",
    "url": "https://github.com/qoderAI/changelog-CloudAgents-zh_CN",
    "kind": "changelog",
    "language": null,
    "stars": 0,
    "size_kb": 2,
    "summary": "Release notes (中文) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "changelog-Jetbrains",
    "url": "https://github.com/qoderAI/changelog-Jetbrains",
    "kind": "changelog",
    "language": null,
    "stars": 0,
    "size_kb": 0,
    "summary": "Release notes (EN) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "changelog-Jetbrains-zh_CN",
    "url": "https://github.com/qoderAI/changelog-Jetbrains-zh_CN",
    "kind": "changelog",
    "language": null,
    "stars": 0,
    "size_kb": 0,
    "summary": "Release notes (中文) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "changelog-QoderMobile",
    "url": "https://github.com/qoderAI/changelog-QoderMobile",
    "kind": "changelog",
    "language": null,
    "stars": 0,
    "size_kb": 0,
    "summary": "Release notes (EN) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "changelog-QoderMobile-zh_CN",
    "url": "https://github.com/qoderAI/changelog-QoderMobile-zh_CN",
    "kind": "changelog",
    "language": null,
    "stars": 0,
    "size_kb": 0,
    "summary": "Release notes (中文) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "changelog-QoderMobileAndroid",
    "url": "https://github.com/qoderAI/changelog-QoderMobileAndroid",
    "kind": "changelog",
    "language": null,
    "stars": 0,
    "size_kb": 0,
    "summary": "Release notes (EN) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "changelog-QoderMobileAndroid-zh_CN",
    "url": "https://github.com/qoderAI/changelog-QoderMobileAndroid-zh_CN",
    "kind": "changelog",
    "language": null,
    "stars": 0,
    "size_kb": 0,
    "summary": "Release notes (中文) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "changelog-QoderMobileHarmony",
    "url": "https://github.com/qoderAI/changelog-QoderMobileHarmony",
    "kind": "changelog",
    "language": null,
    "stars": 0,
    "size_kb": 0,
    "summary": "Release notes (EN) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "changelog-QoderMobileHarmony-zh_CN",
    "url": "https://github.com/qoderAI/changelog-QoderMobileHarmony-zh_CN",
    "kind": "changelog",
    "language": null,
    "stars": 0,
    "size_kb": 0,
    "summary": "Release notes (中文) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "changelog-QoderMobileIOS",
    "url": "https://github.com/qoderAI/changelog-QoderMobileIOS",
    "kind": "changelog",
    "language": null,
    "stars": 0,
    "size_kb": 0,
    "summary": "Release notes (EN) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "changelog-QoderMobileIOS-zh_CN",
    "url": "https://github.com/qoderAI/changelog-QoderMobileIOS-zh_CN",
    "kind": "changelog",
    "language": null,
    "stars": 0,
    "size_kb": 0,
    "summary": "Release notes (中文) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "changelog-QoderWork",
    "url": "https://github.com/qoderAI/changelog-QoderWork",
    "kind": "changelog",
    "language": null,
    "stars": 0,
    "size_kb": 1,
    "summary": "Release notes (EN) for Qoder products.",
    "use": "Reference only — shown as release notes, not integrated.",
    "tags": [
      "release notes"
    ],
    "integrated": false
  },
  {
    "name": "cloud-agents-cli",
    "url": "https://github.com/qoderAI/cloud-agents-cli",
    "kind": "empty",
    "language": null,
    "stars": 0,
    "size_kb": 0,
    "summary": "Empty repository reserved for a cloud agents CLI.",
    "use": "Nothing to integrate yet.",
    "tags": [],
    "integrated": false
  },
  {
    "name": "cloud-agents-sdk-go",
    "url": "https://github.com/qoderAI/cloud-agents-sdk-go",
    "kind": "empty",
    "language": null,
    "stars": 0,
    "size_kb": 0,
    "summary": "Empty repository (older Go SDK location).",
    "use": "Superseded by qoder-cloud-agents-sdk-go.",
    "tags": [],
    "integrated": false
  },
  {
    "name": "qoder-community",
    "url": "https://github.com/qoderAI/qoder-community",
    "kind": "empty",
    "language": null,
    "stars": 0,
    "size_kb": 0,
    "summary": "Empty community repository.",
    "use": "Nothing to integrate yet.",
    "tags": [],
    "integrated": false
  },
  {
    "name": "qoder-sdk-demos",
    "url": "https://github.com/qoderAI/qoder-sdk-demos",
    "kind": "empty",
    "language": null,
    "stars": 0,
    "size_kb": 0,
    "summary": "Empty repository.",
    "use": "Nothing to integrate yet.",
    "tags": [],
    "integrated": false
  },
  {
    "name": "skills",
    "url": "https://github.com/qoderAI/skills",
    "kind": "empty",
    "language": null,
    "stars": 0,
    "size_kb": 0,
    "summary": "Placeholder for Qoder skills.",
    "use": "Nothing to integrate yet.",
    "tags": [],
    "integrated": false
  }
];

/** Kinds, in the order the page shows them. */
export const QODER_KINDS = ["sdk","demo","action","app","tool","cli","eval","bench","docs","changelog","empty","unknown"];

/** Counts by kind, and how many repositories this app actually builds on. */
export function atlasTally(repos = QODER_REPOS) {
  const byKind = {};
  for (const r of repos) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
  return {
    total: repos.length,
    integrated: repos.filter((r) => r.integrated).length,
    empty: byKind.empty || 0,
    byKind
  };
}
