export interface OFTask {
  id: string;
  name: string;
  note: string | null;
  added: string | null;
  modified: string | null;
  completed: string | null;
  due: string | null;
  defer: string | null; // <start>
  planned: string | null; // OF4.7 <planned>
  flagged: boolean;
  estimatedMinutes: number | null;
  parentId: string | null; // parent task/project (<task idref>)
  isProject: boolean;
  projectFolderId: string | null;
  projectStatus: string | null; // active|inactive|done|dropped
  inInbox: boolean;
  rank: number | null;
  order: string | null; // parallel|sequential
  droppedDate: string | null; // <hidden>
  repetitionRule: string | null;
  repetitionMethod: string | null;
  repetitionScheduleType: string | null;
  repetitionAnchorDate: string | null;
  catchUpAutomatically: boolean;
  // Project review fields (children of <project>).
  nextReview: string | null;
  lastReview: string | null;
  reviewInterval: string | null; // e.g. "@1w", "@2w", "~1m"
  primaryTagId: string | null;
  tagIds: string[];
}

export interface OFFolder {
  id: string;
  name: string;
  parentId: string | null;
  rank: number | null;
  hidden: string | null;
}

export interface OFTag {
  id: string;
  name: string;
  parentId: string | null;
  rank: number | null;
}

export function newTask(id: string): OFTask {
  return {
    id,
    name: "",
    note: null,
    added: null,
    modified: null,
    completed: null,
    due: null,
    defer: null,
    planned: null,
    flagged: false,
    estimatedMinutes: null,
    parentId: null,
    isProject: false,
    projectFolderId: null,
    projectStatus: null,
    inInbox: false,
    rank: null,
    order: null,
    droppedDate: null,
    repetitionRule: null,
    repetitionMethod: null,
    repetitionScheduleType: null,
    repetitionAnchorDate: null,
    catchUpAutomatically: false,
    nextReview: null,
    lastReview: null,
    reviewInterval: null,
    primaryTagId: null,
    tagIds: [],
  };
}

export interface TaskView extends OFTask {
  projectName: string | null;
  tagNames: string[];
  status: "completed" | "dropped" | "active";
}
