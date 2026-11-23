
## Persistent Work Checkpoint

`WORK_CHECKPOINT.md` is the persistent memory for the active task.

### Before Work
- Read WORK_CHECKPOINT.md before investigating an ongoing task.
- Continue from confirmed findings instead of repeating completed investigations.

### During Work
- Record inspected files, relevant symbols, confirmed findings, and decisions.
- Distinguish confirmed facts from assumptions.
- Record test commands and actual results.
- Update the checkpoint after meaningful progress.

### Context Compaction / Handoff
- Before compaction or handing off work, update WORK_CHECKPOINT.md.
- Preserve the current objective, completed work, pending work, and next action.
- After compaction, read the checkpoint first.
- Never restart the investigation without a specific reason.

### Reinspection Rules
Reinspect source code only when:
- The file changed after the recorded inspection.
- Existing findings are incomplete or contradictory.
- A specific implementation detail requires verification.

Otherwise, use the recorded findings.

### Scope
- Keep the checkpoint concise.
- Do not copy entire source files into it.
- Do not turn it into permanent project documentation.
- Replace obsolete task information when starting a new task.
