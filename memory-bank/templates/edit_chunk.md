# Edit Chunk File Template
*Use this template when creating memory-bank/edits/YYYY-MM-DD/HHMMSS-TID-description.md*

```markdown
---
kind: edit_chunk
id: YYYY-MM-DD-HHMMSS
created_at: YYYY-MM-DD HH:MM:SS TZ
task_ids: [Txx, Tyy]
source_branch: [branch]
source_commit: <40-char-sha>
---

#### HH:MM:SS TZ - TaskID: Description
- [Action] `[file/path]` - Specific technical change description
```

**Format Requirements (STRICT):**
- Header: `#### HH:MM:SS TZ - TaskID: Description` (Timezone is MANDATORY)
- Bullets: `- [Action] \`filepath\` - Description`
- **Action** MUST be one of: `Created`, `Modified`, `Updated`, `Deleted`
- **Filepath** MUST be in backticks AND relative to project root
- No summary statements or evaluative content