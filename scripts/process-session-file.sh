#!/bin/bash
# Process a single session file by finding the correct .jsonl variant
# Usage: process-session-file.sh <session_id_or_file>

SESSIONS_DIR="$HOME/.openclaw/agents/main/sessions"
WRITER="$HOME/.openclaw/workspace/.openclaw_memory/scripts/journal-writer.cjs"

if [ -z "$1" ]; then
    echo "Usage: $0 <session_id_or_file>"
    exit 1
fi

input="$1"

# If it's a full path, use it directly
if [ -f "$input" ]; then
    session_file="$input"
    session_id=$(basename "$session_file" | sed 's/\.jsonl\..*//;s/\.jsonl$//')
else
    # It's a session ID — find the file
    session_id="$input"
    
    # Check for exact match first
    if [ -f "$SESSIONS_DIR/${session_id}.jsonl" ]; then
        session_file="$SESSIONS_DIR/${session_id}.jsonl"
    else
        # Find any file matching this session ID prefix
        session_file=$(ls -1 "$SESSIONS_DIR"/${session_id}.jsonl* 2>/dev/null | grep -v "\.trajectory\." | head -1)
    fi
fi

if [ -z "$session_file" ] || [ ! -f "$session_file" ]; then
    echo "ERROR: No session file found for $session_id"
    exit 1
fi

echo "Processing: $session_file"

# The journal-writer needs --session to match the base ID
# But it constructs the path internally. We need to temporarily symlink or copy.
# Actually, let's just create a temporary symlink with the expected name.

base_file="$SESSIONS_DIR/${session_id}.jsonl"
if [ "$session_file" != "$base_file" ]; then
    # Create temporary symlink
    ln -sf "$session_file" "$base_file.tmp"
    # Move symlink to expected name
    mv "$base_file.tmp" "$base_file"
fi

# Run the writer
node "$WRITER" --session "$session_id" 2>&1

# Clean up temporary symlink if we created one
if [ "$session_file" != "$base_file" ]; then
    # Check if it's a symlink pointing to our file
    if [ -L "$base_file" ] && [ "$(readlink "$base_file")" = "$session_file" ]; then
        rm "$base_file"
    fi
fi
