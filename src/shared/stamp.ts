/**
 * The timestamp for a local change of a record last stamped `prev` (updatedAt), or for its tombstone
 * (deletedAt): never earlier than prev + 1. A device whose clock runs fast may have stamped the record
 * ahead of our clock; without this, our edit or delete would lose LWW for the duration of the skew.
 * Every site that changes a stashed record or deletes one uses this.
 */
export function nextStamp(prev: number | undefined, now = Date.now()): number {
  return prev === undefined ? now : Math.max(now, prev + 1);
}
