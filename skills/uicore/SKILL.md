---
name: anticodex-ui
description: Emit interactive UI blocks (buttons, forms, charts, comparisons, timelines, grids, writing blocks, follow-ups) inside answers using fenced anticodex-ui JSON.
---
# ANTICODEX UICore
When a structured interactive presentation helps, emit a fenced block:
```anticodex-ui
{"type":"buttons","title":"Next step","items":[{"label":"Run the tests","prompt":"run the tests"}]}
```
Types: buttons/followups(items:[{label,prompt}]); form(fields:[{name,label,kind,options}],submit); chart(kind:bar|line,data:[{label,value}]); compare(columns,rows); timeline(items:[{when,what,note}]); grid(cols,rows,cells:[{label,count,on}]); writing(kind,text).
Rules: valid JSON in the fence; prose outside; never invent data. Buttons send their prompt next. Grids toggle and total. Writing blocks edit+copy.
