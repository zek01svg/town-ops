import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Clock, History, User } from "lucide-react";
import { useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import {
  useCancelCaseMutation,
  useRepairEffectMutation,
  useReplaceAppointmentMutation,
} from "../api/mutations";
import type { GatewayAppointment } from "../api/queries";
import { caseQueries } from "../api/queries";
import type { CaseItem } from "../types";

interface Props {
  caseId: string;
  caseData?: CaseItem;
}

/**
 * Why the Reschedule cannot be submitted, or null when it can. Returned as
 * prose so the disabled button can say what is missing instead of leaving the
 * Officer to guess — and so the Gateway's own guards are never the first
 * feedback they get.
 */
export function rescheduleBlocker(
  appointment: GatewayAppointment | null | undefined,
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
  // AC4: moving a still-live appointment must say why. Recovering one already
  // reported as no access need not.
  if (appointment.status === "SCHEDULED" && !reason.trim()) {
    return "A reason is required to move a scheduled visit.";
  }
  return null;
}

export function isCaseCancellable(status: CaseItem["status"]) {
  return !["in_progress", "completed", "cancelled"].includes(status);
}

export function CaseAuditTrail({ caseId, caseData }: Props) {
  const {
    data: timeline,
    isLoading,
    isError,
  } = useQuery(caseQueries.timeline(caseId));
  const events = timeline?.events ?? [];
  const missingSources = timeline?.missingSources ?? [];
  // Both of these throw on a failed read now rather than suppressing to
  // `null`/`[]`, so their error state has to be rendered — otherwise the
  // Reschedule and Effect Repair panels just don't appear, which is
  // indistinguishable from "no appointment"/"no effects" and is exactly the
  // ambiguity PRS-151-F exists to remove.
  const { data: appointment, isError: isAppointmentError } = useQuery(
    caseQueries.gatewayAppointment(caseId)
  );
  const { data: effects = [], isError: isEffectsError } = useQuery(
    caseQueries.effects(caseId)
  );
  const replaceAppointment = useReplaceAppointmentMutation();
  const cancelCase = useCancelCaseMutation();
  const repairEffect = useRepairEffectMutation();
  const replacementKey = useRef<string | undefined>(undefined);
  const cancellationKey = useRef<string | undefined>(undefined);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [reason, setReason] = useState("");
  const [cancellationReason, setCancellationReason] = useState("");
  // Keyed by effect id — a shared reason field would leave the previous
  // effect's text pre-filled when waiving the next one.
  const [waiverReasons, setWaiverReasons] = useState<Record<string, string>>(
    {}
  );

  const isReasonRequired = appointment?.status === "SCHEDULED";
  const blockedFor = rescheduleBlocker(
    appointment,
    startTime,
    endTime,
    reason,
    replacementKey.current !== undefined
  );

  function handleReschedule() {
    if (!appointment || blockedFor) return;
    const idempotencyKey = replacementKey.current ?? crypto.randomUUID();
    replacementKey.current = idempotencyKey;
    replaceAppointment.mutate(
      {
        caseId,
        appointmentId: appointment.id,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        reason: reason.trim() || undefined,
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

  const cancellable =
    caseData !== undefined && isCaseCancellable(caseData.status);

  function handleCancel() {
    if (!cancellable || !cancellationReason.trim()) return;
    const idempotencyKey = cancellationKey.current ?? crypto.randomUUID();
    cancellationKey.current = idempotencyKey;
    cancelCase.mutate(
      { caseId, reason: cancellationReason, idempotencyKey },
      {
        onSuccess: () => {
          cancellationKey.current = undefined;
          setCancellationReason("");
        },
      }
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Case summary */}
      {caseData && (
        <div className="flex flex-col gap-2 border border-border p-4 bg-card">
          <div className="flex justify-between items-center">
            <span className="text-[10px] font-label uppercase tracking-widest text-muted-foreground">
              Case ID
            </span>
            <span className="text-xs font-mono text-primary">
              {caseData.id.slice(0, 8)}…
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-[10px] font-label uppercase tracking-widest text-muted-foreground">
              Category
            </span>
            <Badge className="rounded-none text-[10px] uppercase bg-muted text-foreground border-border">
              {caseData.category}
            </Badge>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-[10px] font-label uppercase tracking-widest text-muted-foreground">
              Priority
            </span>
            <Badge
              variant={
                caseData.priority === "high" ||
                caseData.priority === "emergency"
                  ? "destructive"
                  : "outline"
              }
              className="rounded-none text-[10px] uppercase"
            >
              {caseData.priority}
            </Badge>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-[10px] font-label uppercase tracking-widest text-muted-foreground">
              Status
            </span>
            <Badge className="rounded-none text-[10px] uppercase bg-muted text-foreground border-border">
              {caseData.status}
            </Badge>
          </div>
          {caseData.address && (
            <div className="pt-2 border-t border-border/50">
              <span className="text-[10px] font-label uppercase tracking-widest text-muted-foreground block mb-1">
                Address
              </span>
              <p className="text-xs text-foreground">{caseData.address}</p>
            </div>
          )}
          {caseData.description && (
            <div className="pt-2 border-t border-border/50">
              <span className="text-[10px] font-label uppercase tracking-widest text-muted-foreground block mb-1">
                Description
              </span>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {caseData.description}
              </p>
            </div>
          )}
          <div className="flex justify-between items-center pt-2 border-t border-border/50">
            <span className="text-[10px] font-label uppercase tracking-widest text-muted-foreground">
              Created
            </span>
            <span className="text-[10px] font-mono text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {new Date(caseData.createdAt).toLocaleString()}
            </span>
          </div>
        </div>
      )}

      {cancellable && (
        <div className="flex flex-col gap-3 border border-border p-4 bg-card">
          <span className="font-label text-xs uppercase tracking-widest text-foreground font-bold">
            Cancel Case
          </span>
          <label
            htmlFor="cancel-case-reason"
            className="flex flex-col gap-1 text-[10px] font-label uppercase tracking-widest text-muted-foreground"
          >
            Reason
            <textarea
              id="cancel-case-reason"
              value={cancellationReason}
              onChange={(event) => setCancellationReason(event.target.value)}
              maxLength={1000}
              rows={2}
              className="border border-border bg-background px-2 py-1 text-xs text-foreground normal-case tracking-normal"
            />
          </label>
          <Button
            onClick={handleCancel}
            disabled={cancelCase.isPending || !cancellationReason.trim()}
            variant="outline"
            className="rounded-none uppercase text-[10px] font-label tracking-widest w-full"
          >
            {cancelCase.isPending ? "Cancelling…" : "Cancel Case"}
          </Button>
          {cancelCase.isError && (
            <p className="text-[10px] text-destructive uppercase">
              {cancelCase.error.message}
            </p>
          )}
        </div>
      )}

      {effects.some(
        (effect) => effect.status === "FAILED" || effect.status === "UNKNOWN"
      ) && (
        <div className="flex flex-col gap-3 border border-border p-4 bg-card">
          <span className="font-label text-xs uppercase tracking-widest text-foreground font-bold">
            Effect Repair
          </span>
          {effects
            // Only FAILED and UNKNOWN are actually repairable (retryEffect
            // rejects everything else as NOT_REPAIRABLE) — PENDING is still
            // in flight, not stuck, so it has no business in this panel.
            .filter(
              (effect) =>
                effect.status === "FAILED" || effect.status === "UNKNOWN"
            )
            .map((effect) => (
              <div
                key={effect.id}
                className="border border-border/50 p-2 text-[10px]"
              >
                <p className="font-mono break-all">{effect.id}</p>
                <p className="text-muted-foreground">
                  {effect.status} · attempts {effect.attempts}
                </p>
                {effect.lastError && (
                  <p className="text-destructive">{effect.lastError}</p>
                )}
                <label className="flex flex-col gap-1 mt-2 text-[10px] font-label uppercase tracking-widest text-muted-foreground">
                  Waiver reason
                  <textarea
                    value={waiverReasons[effect.id] ?? ""}
                    onChange={(event) =>
                      setWaiverReasons((prev) => ({
                        ...prev,
                        [effect.id]: event.target.value,
                      }))
                    }
                    maxLength={1000}
                    rows={2}
                    className="border border-border bg-background px-2 py-1 text-xs text-foreground normal-case tracking-normal"
                  />
                </label>
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={repairEffect.isPending}
                    onClick={() => {
                      const acknowledgeDuplicateRisk =
                        effect.status === "UNKNOWN";
                      if (
                        acknowledgeDuplicateRisk &&
                        !window.confirm(
                          "The provider's deduplication window has expired. Retrying may send a duplicate email. Continue?"
                        )
                      ) {
                        return;
                      }
                      repairEffect.mutate({
                        caseId,
                        effectId: effect.id,
                        action: "retry",
                        acknowledgeDuplicateRisk,
                      });
                    }}
                  >
                    Retry
                    {effect.status === "UNKNOWN" ? " (duplicate risk)" : ""}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      repairEffect.isPending ||
                      !(waiverReasons[effect.id] ?? "").trim()
                    }
                    onClick={() =>
                      repairEffect.mutate({
                        caseId,
                        effectId: effect.id,
                        action: "waive",
                        reason: waiverReasons[effect.id] ?? "",
                      })
                    }
                  >
                    Waive
                  </Button>
                </div>
              </div>
            ))}
          {repairEffect.isError && (
            <p className="text-[10px] text-destructive">
              {repairEffect.error.message}
            </p>
          )}
        </div>
      )}

      {(isAppointmentError || isEffectsError) && (
        <div className="border border-destructive/40 bg-destructive/5 p-4 flex flex-col gap-2">
          <span className="text-[10px] font-label uppercase tracking-widest font-bold text-destructive">
            Could Not Load Case Details
          </span>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
            Reschedule and effect repair are unavailable. Try refreshing this
            page.
          </p>
        </div>
      )}

      {/* Reschedule */}
      {appointment && (
        <div className="flex flex-col gap-3 border border-border p-4 bg-card">
          <div className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-primary" />
            <span className="font-label text-xs uppercase tracking-widest text-foreground font-bold">
              Reschedule
            </span>
          </div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
            {appointment.status} ·{" "}
            {new Date(appointment.startTime).toLocaleString()} –{" "}
            {new Date(appointment.endTime).toLocaleTimeString()}
          </p>
          {appointment.reason && (
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {appointment.reason}
            </p>
          )}

          <label
            htmlFor="reschedule-start"
            className="flex flex-col gap-1 text-[10px] font-label uppercase tracking-widest text-muted-foreground"
          >
            New start
            <input
              id="reschedule-start"
              type="datetime-local"
              value={startTime}
              onChange={(event) => setStartTime(event.target.value)}
              className="h-9 border border-border bg-background px-2 text-xs text-foreground"
            />
          </label>
          <label
            htmlFor="reschedule-end"
            className="flex flex-col gap-1 text-[10px] font-label uppercase tracking-widest text-muted-foreground"
          >
            New end
            <input
              id="reschedule-end"
              type="datetime-local"
              value={endTime}
              onChange={(event) => setEndTime(event.target.value)}
              className="h-9 border border-border bg-background px-2 text-xs text-foreground"
            />
          </label>
          <label
            htmlFor="reschedule-reason"
            className="flex flex-col gap-1 text-[10px] font-label uppercase tracking-widest text-muted-foreground"
          >
            {isReasonRequired
              ? "Why are you moving this visit?"
              : "Anything we should know? (optional)"}
            <textarea
              id="reschedule-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required={isReasonRequired}
              aria-required={isReasonRequired}
              maxLength={1000}
              rows={2}
              className="border border-border bg-background px-2 py-1 text-xs text-foreground normal-case tracking-normal"
            />
          </label>

          <Button
            onClick={handleReschedule}
            disabled={replaceAppointment.isPending || !!blockedFor}
            aria-describedby={blockedFor ? "reschedule-blocked" : undefined}
            className="rounded-none uppercase text-[10px] font-label tracking-widest w-full"
          >
            {replaceAppointment.isPending
              ? "Rescheduling…"
              : "Confirm Reschedule"}
          </Button>
          {blockedFor && (
            <p
              id="reschedule-blocked"
              className="text-[10px] text-muted-foreground"
            >
              {blockedFor}
            </p>
          )}
          {replaceAppointment.isError && (
            <p className="text-[10px] text-destructive uppercase">
              {replaceAppointment.error.message}
            </p>
          )}
        </div>
      )}

      {/* Timeline */}
      <div className="flex items-center gap-2 border-b border-border pb-3">
        <History className="h-4 w-4 text-primary" />
        <span className="font-label text-xs uppercase tracking-widest text-foreground font-bold">
          Activity Log
        </span>
      </div>

      {missingSources.length > 0 && (
        <div className="border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[10px] font-label uppercase tracking-widest text-amber-400">
          Could not load: {missingSources.join(", ")}
        </div>
      )}

      {isLoading ? (
        <div className="text-[10px] font-label uppercase tracking-widest text-muted-foreground text-center py-8">
          Loading history…
        </div>
      ) : isError ? (
        <div className="text-[10px] font-label uppercase tracking-widest text-destructive text-center py-8">
          Could not load activity history.
        </div>
      ) : events.length === 0 ? (
        <div className="text-[10px] font-label uppercase tracking-widest text-muted-foreground text-center py-8">
          No activity recorded yet.
        </div>
      ) : (
        <div className="flex flex-col gap-6 relative before:absolute before:left-2 before:top-2 before:bottom-2 before:w-px before:bg-border/50">
          {events.map((event, i) => (
            <div
              key={`${event.timestamp}-${i}`}
              className="relative pl-8 group"
            >
              <div
                className={`absolute left-0 top-1.5 h-4 w-4 rounded-full bg-popover border-2 z-10 flex items-center justify-center ${i === events.length - 1 ? "border-emerald-500" : "border-primary"}`}
              >
                <div
                  className={`h-1.5 w-1.5 rounded-full ${i === events.length - 1 ? "bg-emerald-500" : "bg-primary"}`}
                />
              </div>
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-label uppercase tracking-widest text-foreground font-bold">
                    {event.type}
                  </span>
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {new Date(event.timestamp).toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-primary">
                  <User className="h-3 w-3" />
                  <span>{event.actor}</span>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed mt-1">
                  {event.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
