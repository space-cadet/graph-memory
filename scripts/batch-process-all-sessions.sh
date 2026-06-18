#!/bin/bash
# Batch process ALL session files including resets and checkpoints
# Uses --file for non-standard filenames

SESSIONS_DIR="$HOME/.openclaw/agents/main/sessions"
JOURNAL_DIR="$HOME/.openclaw/workspace/.openclaw_memory/journal"
WRITER="$HOME/.openclaw/workspace/.openclaw_memory/scripts/journal-writer.cjs"
WATERMARK="$HOME/.openclaw/workspace/.openclaw_memory/.watermark"

# Get ALL jsonl files (active, reset, checkpoint)
mapfile -t SESSION_FILES < <(ls -1 "$SESSIONS_DIR"/*.jsonl* 2>/dev/null | grep -v "\.trajectory\." | sort)

echo "Found ${#SESSION_FILES[@]} total session files to process"

for session_file in "${SESSION_FILES[@]}"; do
    filename=$(basename "$session_file")
    # Extract session ID (everything before .jsonl)
    session_id=$(echo "$filename" | sed 's/\.jsonl\..*//;s/\.jsonl$//')
    
    # Check if already processed
    file_lines=$(wc -l < "$session_file")
    
    if [ -f "$WATERMARK" ]; then
        watermark_lines=$(python3 -c "import json; d=json.load(open('$WATERMARK')); print(d.get('$session_id', 0))" 2>/dev/null || echo 0)
        if [ "$watermark_lines" -ge "$file_lines" ]; then
            echo "SKIP $session_id ($filename) — already processed ($watermark_lines >= $file_lines lines)"
            continue
        fi
    fi
    
    echo "PROCESS $session_id ($filename, $file_lines lines)..."
    
    # Use --file for non-standard filenames, --session for base ID
    if [[ "$filename" =~ \.jsonl$ ]]; then
        # Standard filename
        node "$WRITER" --session "$session_id" 2>&1 | tail -3
    else
        # Reset or checkpoint file
        node "$WRITER" --file "$session_file" --session "$session_id" 2>&1 | tail -3
    fi
    echo ""
done

echo "Batch processing complete."
echo "Journals in: $JOURNAL_DIR"
