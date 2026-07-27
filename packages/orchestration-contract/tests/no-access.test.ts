import { describe, expect, it } from "vitest";

import {
  AppointmentStatusSchema,
  canonicalReplaceAppointmentPayload,
  canonicalReportNoAccessPayload,
  MarkCaseAppointmentReplacedInputSchema,
  MarkAppointmentMissedInputSchema,
  MarkAppointmentMissedResultSchema,
  MarkCaseNoAccessInputSchema,
  OfficerAttentionKindSchema,
  ReplaceAppointmentInputSchema,
  ReplaceAppointmentSlotInputSchema,
  ReplaceAppointmentSlotResultSchema,
  ReportNoAccessAppointmentInputSchema,
  ReportNoAccessAppointmentResultSchema,
} from "../src/index";
import type { ReplaceAppointmentInput } from "../src/index";

describe("no-access and reschedule contract (PRS-146)", () => {
  const caseId = "123e4567-e89b-12d3-a456-426614174000";
  const appointmentId = "223e4567-e89b-12d3-a456-426614174001";
  const contractorId = "323e4567-e89b-12d3-a456-426614174002";
  const actorId = "423e4567-e89b-12d3-a456-426614174003";
  const input: ReplaceAppointmentInput = {
    startTime: "2030-01-01T10:00:00.000Z",
    endTime: "2030-01-01T12:00:00.000Z",
    reason: "Resident was out",
  };

  it("parses every Appointment status a replaced Case can hold", () => {
    for (const status of [
      "SCHEDULED",
      "IN_PROGRESS",
      "NO_ACCESS",
      "RESCHEDULED",
      "MISSED",
    ]) {
      expect(AppointmentStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(AppointmentStatusSchema.safeParse("no_access").success).toBe(false);
    expect(AppointmentStatusSchema.safeParse("COMPLETED").success).toBe(false);
  });

  it("canonicalizes both retry payloads with a fixed key order", () => {
    expect(canonicalReportNoAccessPayload(caseId, appointmentId)).toBe(
      JSON.stringify({ caseId, appointmentId })
    );
    expect(
      canonicalReplaceAppointmentPayload(caseId, appointmentId, input)
    ).toBe(
      JSON.stringify({
        caseId,
        appointmentId,
        startTime: input.startTime,
        endTime: input.endTime,
        reason: input.reason,
      })
    );
  });

  it("accepts an optional reason and an interval that ends after it starts", () => {
    expect(ReplaceAppointmentInputSchema.safeParse(input).success).toBe(true);
    expect(
      ReplaceAppointmentInputSchema.safeParse({
        startTime: input.startTime,
        endTime: input.endTime,
      }).success
    ).toBe(true);
    expect(
      ReplaceAppointmentInputSchema.safeParse({ ...input, reason: "   " })
        .success
    ).toBe(false);
    expect(
      ReplaceAppointmentInputSchema.safeParse({
        ...input,
        endTime: input.startTime,
      }).success
    ).toBe(false);
    expect(
      ReplaceAppointmentInputSchema.safeParse({ ...input, extra: 1 }).success
    ).toBe(false);
  });

  it("accepts the atom-level slot inputs and rejects a reversed interval", () => {
    const slotInput = {
      operationId: `${caseId}/replace-appointment`,
      caseId,
      appointmentId,
      startTime: input.startTime,
      endTime: input.endTime,
    };
    expect(ReplaceAppointmentSlotInputSchema.safeParse(slotInput).success).toBe(
      true
    );
    expect(
      ReplaceAppointmentSlotInputSchema.safeParse({
        ...slotInput,
        endTime: "2030-01-01T09:00:00.000Z",
      }).success
    ).toBe(false);

    expect(
      ReportNoAccessAppointmentInputSchema.safeParse({
        operationId: `${caseId}/no-access/appointment`,
        appointmentId,
        contractorId,
      }).success
    ).toBe(true);
  });

  it("keeps the Case-write inputs role-scoped", () => {
    const base = {
      caseId,
      operationId: `${caseId}/no-access/case`,
      actorId,
    };
    expect(
      MarkCaseNoAccessInputSchema.safeParse({
        ...base,
        actorRole: "CONTRACTOR",
      }).success
    ).toBe(true);
    expect(
      MarkCaseNoAccessInputSchema.safeParse({ ...base, actorRole: "RESIDENT" })
        .success
    ).toBe(false);
    expect(
      MarkCaseAppointmentReplacedInputSchema.safeParse({
        ...base,
        actorRole: "RESIDENT",
      }).success
    ).toBe(true);
    expect(
      MarkCaseAppointmentReplacedInputSchema.safeParse({
        ...base,
        actorRole: "CONTRACTOR",
      }).success
    ).toBe(false);
  });

  it("discriminates every atom outcome without a payload where none is returned", () => {
    for (const outcome of [
      "NOT_SCHEDULED",
      "WRONG_CONTRACTOR",
      "APPOINTMENT_NOT_FOUND",
    ]) {
      expect(
        ReportNoAccessAppointmentResultSchema.safeParse({ outcome }).success
      ).toBe(true);
    }
    expect(
      ReportNoAccessAppointmentResultSchema.safeParse({ outcome: "NO_ACCESS" })
        .success
    ).toBe(false);

    for (const outcome of [
      "NOT_REPLACEABLE",
      "CONFLICT",
      "CASE_MISMATCH",
      "APPOINTMENT_NOT_FOUND",
    ]) {
      expect(
        ReplaceAppointmentSlotResultSchema.safeParse({ outcome }).success
      ).toBe(true);
    }
    expect(
      ReplaceAppointmentSlotResultSchema.safeParse({ outcome: "REPLACED" })
        .success
    ).toBe(false);
  });

  it("parses the workflow-owned missed transition and its attention kind", () => {
    const missedInput = {
      operationId: `${caseId}/missed-appointment/${appointmentId}`,
      appointmentId,
    };
    expect(
      MarkAppointmentMissedInputSchema.safeParse(missedInput).success
    ).toBe(true);
    expect(
      MarkAppointmentMissedInputSchema.safeParse({
        ...missedInput,
        extra: true,
      }).success
    ).toBe(false);
    expect(
      OfficerAttentionKindSchema.safeParse("MISSED_APPOINTMENT").success
    ).toBe(true);
    for (const outcome of ["NOT_SCHEDULED", "APPOINTMENT_NOT_FOUND"]) {
      expect(
        MarkAppointmentMissedResultSchema.safeParse({ outcome }).success
      ).toBe(true);
    }
    expect(
      MarkAppointmentMissedResultSchema.safeParse({ outcome: "MISSED" }).success
    ).toBe(false);
  });
});
