# v3 draft verification record

Source implementation verified: `3c1afd8cc2a77bbbfddb625e32621a565e69bd25`.

Observed in [GitHub job 137434703273](https://github.com/ThaddeusHackz/ANTICODEX/actions/runs/45095637975/job/137434703273), on Node 22:

- Production Vite build: passed.
- New backend/transport contracts: 19 groups passed.
- New mounted Teams/Sites UI and real connector-bridge contracts: 12 groups passed; process exits cleanly.
- Complete `npm test`: 33 reported suite summaries, 2,283 reported checks, zero failures. The 19 and 12 v3 groups are included in that full-suite total; they must not be counted twice.

The old preparation job's final status was failure because its post-test `git add web/dist` attempted to stage intentionally ignored generated output. No test failed in that job. The workflow has now been replaced with normal read-only build/test CI; no source downloads, automated commits, workflow edits or force-added build output are performed by the replacement.

The PR's fresh Node 20/22 matrix and read-only full-suite checks must be checked at the final head before merge. jsdom suites run on Node 22, matching the existing mount harness's documented runtime constraint.

Not established by these tests: real model-provider behavior, live OAuth, native Windows/macOS runtime/build acceptance, Vercel production behavior, or application of the Supabase migration. The migration in `supabase/migrations/20261123_v3_mcp_ownership.sql` has NOT been applied by this work. See `RELEASE-3.0.0.md` for rollout and security boundaries.
