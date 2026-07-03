/**
 * The agent's server-side persistence boundary.
 *
 * Thin re-export of the SHARED, client-agnostic course sync so the agent
 * mutates the DB through the exact same reconcile the browser autosave uses
 * (lib/course/persistenceSync.ts). The agent never writes to Postgres any other
 * way — every change is a Zod-validated CoursePatch applied to the document,
 * then this reconcile.
 */

export {
  loadCourseDoc,
  reconcileCourseDoc,
  reconcileCourseDocScoped,
  upsertBlock,
  type ReconcileScope,
} from "@/lib/course/persistenceSync";
