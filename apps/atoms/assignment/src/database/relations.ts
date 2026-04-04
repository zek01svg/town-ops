import { relations } from "drizzle-orm/relations";

import { assignments, assignmentStatusHistory } from "./schema";

export const assignmentStatusHistoryRelations = relations(
  assignmentStatusHistory,
  ({ one }) => ({
    assignment: one(assignments, {
      fields: [assignmentStatusHistory.assignmentId],
      references: [assignments.id],
    }),
  })
);

export const assignmentsRelations = relations(assignments, ({ one, many }) => ({
  assignmentStatusHistories: many(assignmentStatusHistory),
  assignment: one(assignments, {
    fields: [assignments.reassignedFromAssignmentId],
    references: [assignments.id],
    relationName: "assignments_reassignedFromAssignmentId_assignments_id",
  }),
  assignments: many(assignments, {
    relationName: "assignments_reassignedFromAssignmentId_assignments_id",
  }),
}));
