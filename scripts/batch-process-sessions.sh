#!/bin/bash
# Batch process all old session files into journals
# Run from workspace root

SESSIONS_DIR="$HOME/.openclaw/agents/main/sessions"
JOURNAL_DIR="$HOME/.openclaw/workspace/.openclaw_memory/journal"
WRITER="$HOME/.openclaw/workspace/.openclaw_memory/scripts/journal-writer.cjs"
WATERMARK="$HOME/.openclaw/workspace/.openclaw_memory/.watermark"

# Get all non-trajectory, non-reset, non-checkpoint jsonl files
mapfile -t SESSIONS < <(ls -1 "$SESSIONS_DIR"/*.jsonl 2>/dev/null | grep -v "\.trajectory\." | grep -v "\.reset\." | grep -v "\.checkpoint\.")

echo "Found ${#SESSIONS[@]} session files to process"

for session_file in "${SESSIONS[@]}"; do
    session_id=$(basename "$session_file" .jsonl)
    
    # Check if already processed (watermark exists and matches file size)
    file_lines=$(wc -l < "$session_file")
    
    if [ -f "$WATERMARK" ]; then
        watermark_lines=$(python3 -c "import json; d=json.load(open('$WATERMARK')); print(d.get('$session_id', 0))" 2>/dev/null || echo 0)
        if [ "$watermark_lines" -ge "$file_lines" ]; then
            echo "SKIP $session_id — already processed ($watermark_lines >= $file_lines lines)"
            continue
        fi
    fi
    
    echo "PROCESS $session_id ($file_lines lines)..."
    node "$WRITER" --session "$session_id" 2>&1 | tail -3
    echo ""
done

echo "Batch processing complete."
echo "Journals in: $JOURNAL_DIR"
