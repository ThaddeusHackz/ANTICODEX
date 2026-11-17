---
name: youtube-research
description: Research what a YouTube video or channel actually says, with citations. Use for transcript-based summaries, "what did they claim", comparing talks, or extracting steps from a tutorial. Never invent a timestamp or a quote.
---

# YouTube research

## What you need

- The video URL or id.
- A transcript source. Prefer the video's own captions; if none exist, say so.
  Do not transcribe audio by guessing.
- The upload date and channel, so a stale claim is not presented as current.

## Method

1. Fetch the watch page and confirm the title, channel, and duration.
2. Obtain the transcript (official captions, then an available transcript API or
   a local `yt-dlp --write-auto-subs`). If both fail, report that the transcript
   is unavailable and offer a title/description-only summary, labelled as such.
3. Quote short excerpts with `[mm:ss]` timestamps. A summary without a locator is
   not checkable.
4. Separate what the speaker said from what is true. Claims about products,
   benchmarks, or prices need an independent source.
5. For a tutorial, produce ordered steps with the exact commands shown. Mark
   steps you inferred.
6. For a channel sweep, build a table of video → claim → evidence → date. Stop
   when the requested videos are covered; do not pad with unrelated uploads.

## Refusals

Do not reproduce a paywalled transcript, do not dox a private individual, and do
not present a machine transcript as verbatim when it is auto-generated.
