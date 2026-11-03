import type { Group } from '../types.js';
/** Keep assignment provenance on the group so deleting a seat cannot erase it. */
export function recordAssignment(group: Group, index: number, name: string, kind: 'human' | 'ai'): void {
  // Legacy state cannot be retrospectively certified as single-player participation.
  if (!group.roleAssignments) {
    group.roleAssignments = [];
    group.roleAssignmentsComplete = false;
  }
  const records = group.roleAssignments[index] || (group.roleAssignments[index] = []);
  const last = records[records.length - 1];
  if (kind === 'ai' && last?.kind === kind && last.name === name) return;
  records.push({ name, kind, week: Math.max(1, group.week) });
}
