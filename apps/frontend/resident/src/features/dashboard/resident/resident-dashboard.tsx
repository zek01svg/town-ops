import { useQuery } from "@tanstack/react-query";
import type { ResidentAppointmentDto } from "@townops/orchestration-contract";
import type { FormEvent } from "react";
import { useRef, useState } from "react";
import { z } from "zod/v4";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useReplaceAppointmentMutation } from "@/features/case/api/mutations";
import { getCase } from "@/libr/gateway";

/**
 * Why the Reschedule cannot be submitted, or null when it can. Prose rather
 * than a boolean so the disabled button can say what is missing — the
 * Gateway's own guards should never be the first the Resident hears of it.
 */
export function rescheduleBlocker(
  appointment: ResidentAppointmentDto | null,
  startTime: string,
  endTime: string,
  reason: string,
  isRetry: boolean
): string | null {
  if (!appointment) return "This case has no appointment to reschedule.";
  if (
    appointment.status !== "SCHEDULED" &&
    appointment.status !== "NO_ACCESS"
  ) {
    return `This appointment is ${appointment.status} and can no longer be rescheduled.`;
  }
  if (!startTime || !endTime) return "Choose the new start and end times.";
  if (Date.parse(endTime) <= Date.parse(startTime)) {
    return "The new end time must be after the new start time.";
  }
  // A retry reuses its idempotency key, so the slot it carries may have aged
  // past "now" while the first attempt was in flight — the server still holds
  // the gate.
  if (!isRetry && Date.parse(startTime) <= Date.now()) {
    return "The new appointment must start in the future.";
  }
  // A reason is required while the visit is still going ahead, and optional
  // when it is being rearranged after a failed one.
  if (appointment.status === "SCHEDULED" && !reason.trim()) {
    return "Tell us why you are moving this visit.";
  }
  return null;
}

export function ResidentDashboard() {
  const [caseId, setCaseId] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [reason, setReason] = useState("");
  const replacementKey = useRef<string | undefined>(undefined);

  const isCaseId = z.uuid().safeParse(caseId).success;
  const caseQuery = useQuery({
    queryKey: ["case", caseId],
    queryFn: () => getCase(caseId),
    enabled: isCaseId,
    retry: false,
  });

  const appointment = caseQuery.data?.appointment ?? null;
  const isReasonRequired = appointment?.status === "SCHEDULED";
  const mutation = useReplaceAppointmentMutation();
  const blockedFor = rescheduleBlocker(
    appointment,
    startTime,
    endTime,
    reason,
    replacementKey.current !== undefined
  );

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!appointment || blockedFor) return;
    const idempotencyKey = replacementKey.current ?? crypto.randomUUID();
    replacementKey.current = idempotencyKey;
    mutation.mutate(
      {
        caseId,
        appointmentId: appointment.id,
        input: {
          startTime: new Date(startTime).toISOString(),
          endTime: new Date(endTime).toISOString(),
          reason: reason.trim() || undefined,
        },
        idempotencyKey,
      },
      {
        onSuccess: () => {
          replacementKey.current = undefined;
          setStartTime("");
          setEndTime("");
          setReason("");
        },
      }
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-3xl font-label tracking-tighter text-foreground uppercase border-b-2 border-primary inline-block pb-1">
          Resident Service Desk
        </h1>
        <p className="text-muted-foreground text-sm mt-2">
          Move a visit to a slot that suits you. If your contractor could not
          get in, the reason they gave is shown below.
        </p>
      </div>

      <Card className="bg-surface-container border border-border rounded-none">
        <CardHeader>
          <CardTitle className="text-sm font-label uppercase tracking-widest text-primary">
            Reschedule a Visit
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <label
                htmlFor="case-id"
                className="block text-xs uppercase font-label tracking-widest text-primary"
              >
                Case ID
              </label>
              <Input
                id="case-id"
                value={caseId}
                onChange={(e) => setCaseId(e.target.value)}
                placeholder="e.g. 123e4567-e89b-12d3..."
                className="rounded-none border-border bg-surface-container"
              />
              {caseQuery.isError && (
                <p className="text-xs text-destructive">
                  {caseQuery.error.message}
                </p>
              )}
            </div>

            {appointment && (
              <div className="border border-border p-3 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] uppercase font-label tracking-widest text-muted-foreground">
                    Current visit
                  </span>
                  <Badge
                    variant="outline"
                    className="rounded-none text-[10px] uppercase border-border"
                  >
                    {appointment.status}
                  </Badge>
                </div>
                <p className="text-xs text-foreground">
                  {new Date(appointment.startTime).toLocaleString()} –{" "}
                  {new Date(appointment.endTime).toLocaleTimeString()}
                </p>
                {appointment.reason && (
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {appointment.reason}
                  </p>
                )}
              </div>
            )}

            {isCaseId && !caseQuery.isPending && !appointment && (
              <p className="text-xs text-muted-foreground">
                This case has no visit booked yet.
              </p>
            )}

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label
                  htmlFor="new-start-time"
                  className="block text-xs uppercase font-label tracking-widest text-primary"
                >
                  New Start Time
                </label>
                <Input
                  id="new-start-time"
                  type="datetime-local"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="rounded-none border-border bg-surface-container"
                />
              </div>
              <div className="space-y-2">
                <label
                  htmlFor="new-end-time"
                  className="block text-xs uppercase font-label tracking-widest text-primary"
                >
                  New End Time
                </label>
                <Input
                  id="new-end-time"
                  type="datetime-local"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className="rounded-none border-border bg-surface-container"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label
                htmlFor="reschedule-reason"
                className="block text-xs uppercase font-label tracking-widest text-primary"
              >
                {isReasonRequired
                  ? "Why are you moving this visit?"
                  : "Anything we should know? (optional)"}
              </label>
              <textarea
                id="reschedule-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required={isReasonRequired}
                aria-required={isReasonRequired}
                maxLength={1000}
                rows={3}
                className="w-full rounded-none border border-border bg-surface-container p-2 text-sm"
              />
            </div>

            {mutation.isError && (
              <p className="text-xs text-destructive uppercase tracking-widest">
                {mutation.error.message}
              </p>
            )}

            {mutation.isSuccess && (
              <div className="border border-emerald-500/40 bg-emerald-500/10 p-3">
                <p className="text-xs font-label uppercase tracking-widest text-emerald-400">
                  Visit rescheduled
                </p>
                <p className="text-[10px] text-muted-foreground font-mono mt-1">
                  {new Date(
                    mutation.data.data.appointment.startTime
                  ).toLocaleString()}
                </p>
              </div>
            )}

            <Button
              type="submit"
              disabled={mutation.isPending || !!blockedFor}
              aria-describedby={blockedFor ? "reschedule-blocked" : undefined}
              className="w-full rounded-none tracking-widest font-bold uppercase font-label"
            >
              {mutation.isPending ? "Submitting..." : "Confirm Reschedule"}
            </Button>
            {blockedFor && (
              <p
                id="reschedule-blocked"
                className="text-xs text-muted-foreground"
              >
                {blockedFor}
              </p>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
