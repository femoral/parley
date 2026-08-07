/**
 * Re-export firehose feed from the shared data layer (right rail owns the UI).
 */
export {
  FIREHOSE_CAP,
  emptyFirehoseCursor,
  advanceFirehose,
  firehoseTone,
  type FirehoseCursor,
} from "../../data/projections/firehoseFeed.js";
