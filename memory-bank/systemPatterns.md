# System Patterns

## Pattern: Heartbeat-Driven Graph Updates

**Context**: Graph needs to stay current without manual intervention  
**Solution**: Run graph build on every 2nd heartbeat, alongside journal processing  
**Trade-off**: Delay of ~1 hour between session and graph update  
**Status**: Planned (T1)

## Pattern: Direct JSONL Extraction

**Context**: Journal-based extraction loses semantic content due to truncation  
**Solution**: Read raw session JSONL files, extract full conversation text  
**Trade-off**: More data = slower processing, but richer entities  
**Status**: In progress (T2)

## Pattern: Watermark-Based Incremental Processing

**Context**: 13,702 session files exist; full rebuild is too slow  
**Solution**: Track last-processed file/line in a watermark file, only process new data  
**Trade-off**: Requires careful watermark management to avoid missing data  
**Status**: Planned (T2)

## Pattern: Generic Aliases for Public Release

**Context**: Public repo must not contain personal information  
**Solution**: Replace all real names/institutions with generic placeholders  
**Trade-off**: Users must configure their own aliases before running  
**Status**: Implemented

## Pattern: DB-Native + Text Dual Memory Bank

**Context**: DB-native workflow exists but text files remain canonical for some projects  
**Solution**: Use DB for task tracking and data layer, text files for rich documentation  
**Trade-off**: Two sources of truth; need explicit sync  
**Status**: Active in this repo

## Pattern: Entity Canonicalization

**Context**: Same entity referred to by multiple names (e.g., "Deepak", "D.Vaid", "明达")  
**Solution**: `NAME_ALIASES` map in `entity-extractor.cjs` normalizes to canonical form  
**Trade-off**: Hardcoded list; needs user customization for different workspaces  
**Status**: Implemented, needs generalization
