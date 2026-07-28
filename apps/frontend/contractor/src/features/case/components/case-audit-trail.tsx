import { useQuery, queryOptions, useQueryClient } from "@tanstack/react-query";
import { Clock, History, User, CheckCircle, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { z } from "zod/v4";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { env } from "@/env";
import { auth } from "@/libr/auth";
import { fetchWithAuth } from "@/libr/auth-token";

import { auditQueries } from "../api/audit-queries";
import {
  useAcceptJobMutation,
  useNoAccessMutation,
  useStartWorkMutation,
} from "../api/mutations";
import { caseKeys } from "../api/query-keys";
import type { CaseItem } from "../types";
import { CloseJobSheet } from "./close-job-sheet";

// Tolerant schema — status leaves stay `z.string()` so a terminal Appointment
// or Attempt still parses and renders in the timeline; the UI only ever
// compares status against literals.
const gatewayAssignmentSchema = z.object({
  id: z.string(),
  currentAttempt: z
    .object({
      id: z.string(),
      status: z.string(),
      deadlineAt: z.string(),
    })
    .nullish(),
  appointment: z
    .object({
      id: z.string(),
      contractorId: z.string(),
      status: z.string(),
      startTime: z.string(),
      endTime: z.string(),
    })
    .nullish(),
});

const gatewayCaseSchema = z.object({
  data: z.object({ assignment: gatewayAssignmentSchema.nullish() }).nullish(),
});

type GatewayAppointment = NonNullable<
  z.infer<typeof gatewayAssignmentSchema>["appointment"]
>;

/**
 * Why the No Access control is unavailable, or null when it is available.
 * Mirrors the Start Work gate — a report only makes sense for this
 * Contractor's own live visit — so it closes the moment Start Work advances
 * the Appointment past SCHEDULED. Doubles as the disabled button's spoken
 * explanation.
 */
export function noAccessBlocker(
  appointment: GatewayAppointment | null | undefined,
  myContractorId: string | null
): string | null {
  if (!appointment) return "No appointment has been scheduled yet.";
  if (appointment.status !== "SCHEDULED") {
    return `This appointment is ${appointment.status} — only a scheduled visit can be reported as no access.`;
  }
  if (appointment.contractorId !== myContractorId) {
    return "This appointment belongs to another contractor.";
  }
  if (Date.now() < Date.parse(appointment.startTime)) {
    return `Available from ${new Date(appointment.startTime).toLocaleString()}.`;
  }
  if (Date.now() >= Date.parse(appointment.endTime)) {
    return "The appointment window has closed.";
  }
  return null;
}

async function getContractorId(): Promise<string> {
  const session = await auth.getSession();
  const user = session?.data?.user;
  if (
    user &&
    typeof user === "object" &&
    "contractorId" in user &&
    typeof user.contractorId === "string"
  ) {
    return user.contractorId;
  }
  return "unknown";
}

function useGatewayAssignment(caseId: string) {
  return useQuery(
    queryOptions({
      queryKey: ["gateway-case", caseId],
      enabled: !!caseId && !!localStorage.getItem("jwt"),
      retry: false,
      queryFn: async () => {
        const res = await fetchWithAuth(
          `${env.VITE_GATEWAY_URL}/api/cases/${caseId}`,
          {},
          env.VITE_AUTH_URL
        );
        if (!res.ok) return null;
        const parsed = gatewayCaseSchema.safeParse(await res.json());
        return parsed.success ? (parsed.data.data?.assignment ?? null) : null;
      },
    })
  );
}

function useCountdown(targetIso: string | undefined) {
  const [, rerender] = useState(0);
  if (!targetIso) return null;
  const diff = new Date(targetIso).getTime() - Date.now();
  if (diff <= 0) return "OVERDUE";
  const mins = Math.floor(diff / 60000);
  const secs = Math.floor((diff % 60000) / 1000);
  // trigger re-render every second
  setTimeout(() => rerender((n) => n + 1), 1000);
  return `${mins}m ${secs}s`;
}

interface Props {
  caseId: string;
  caseData?: CaseItem;
}

export function CaseAuditTrail({ caseId, caseData }: Props) {
  const { data: events = [], isLoading } = useQuery(
    auditQueries.timeline(caseId)
  );
  const { data: assignment } = useGatewayAssignment(caseId);
  const acceptJob = useAcceptJobMutation();
  const noAccess = useNoAccessMutation();
  const startWork = useStartWorkMutation();
  const qc = useQueryClient();
  const acceptanceKey = useRef<string | undefined>(undefined);
  const startWorkKey = useRef<string | undefined>(undefined);
  const noAccessKey = useRef<string | undefined>(undefined);
  const [myContractorId, setMyContractorId] = useState<string | null>(null);

  useEffect(() => {
    void getContractorId().then(setMyContractorId);
  }, []);

  const [closeJobOpen, setCloseJobOpen] = useState(false);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const attempt = assignment?.currentAttempt;
  const appointment = assignment?.appointment;
  const isPendingAcceptance = attempt?.status === "PENDING_ACCEPTANCE";
  const isAccepted = attempt?.status === "ACCEPTED";
  const isAwaitingResident = caseData?.status === "pending_resident_input";
  const countdown = useCountdown(
    isPendingAcceptance ? attempt?.deadlineAt : undefined
  );
  const isOverdue = countdown === "OVERDUE";
  const isAcceptanceRetry = acceptanceKey.current !== undefined;
  const isValidAppointment =
    !!startTime &&
    !!endTime &&
    Date.parse(endTime) > Date.parse(startTime) &&
    (isAcceptanceRetry || Date.parse(startTime) > Date.now());
  // Ticks every second while now < appointment.endTime (piggybacks the
  // existing countdown timer instead of a second interval) so the window
  // opening/closing is reflected without a manual refetch.
  useCountdown(
    appointment?.status === "SCHEDULED" ? appointment.endTime : undefined
  );
  const canStartWork =
    isAccepted &&
    appointment?.status === "SCHEDULED" &&
    appointment.contractorId === myContractorId &&
    Date.now() >= Date.parse(appointment.startTime) &&
    Date.now() < Date.parse(appointment.endTime);
  const noAccessBlockedFor = noAccessBlocker(appointment, myContractorId);
  const canComplete =
    caseData?.status === "in_progress" &&
    appointment?.status === "IN_PROGRESS" &&
    appointment.contractorId === myContractorId;

  function handleAccept() {
    if (!attempt || !isValidAppointment) return;
    const idempotencyKey = acceptanceKey.current ?? crypto.randomUUID();
    acceptanceKey.current = idempotencyKey;
    acceptJob.mutate(
      {
        caseId,
        attemptId: attempt.id,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        idempotencyKey,
      },
      {
        onSuccess: () => {
          acceptanceKey.current = undefined;
          void qc.invalidateQueries({ queryKey: ["gateway-case", caseId] });
          void qc.invalidateQueries({ queryKey: caseKeys.all });
        },
      }
    );
  }

  function handleStartWork() {
    if (!appointment) return;
    const idempotencyKey = startWorkKey.current ?? crypto.randomUUID();
    startWorkKey.current = idempotencyKey;
    startWork.mutate(
      { caseId, appointmentId: appointment.id, idempotencyKey },
      {
        onSuccess: () => {
          startWorkKey.current = undefined;
          void qc.invalidateQueries({ queryKey: ["gateway-case", caseId] });
          void qc.invalidateQueries({ queryKey: caseKeys.all });
        },
      }
    );
  }

  function handleNoAccess() {
    if (!appointment || noAccessBlockedFor) return;
    const idempotencyKey = noAccessKey.current ?? crypto.randomUUID();
    noAccessKey.current = idempotencyKey;
    noAccess.mutate(
      {
        caseId,
        appointmentId: appointment.id,
        idempotencyKey,
      },
      {
        onSuccess: () => {
          noAccessKey.current = undefined;
          void qc.invalidateQueries({ queryKey: ["gateway-case", caseId] });
          void qc.invalidateQueries({ queryKey: caseKeys.all });
        },
      }
    );
  }

  return (
    <>
      <CloseJobSheet
        open={closeJobOpen}
        onOpenChange={setCloseJobOpen}
        caseId={caseId}
        canComplete={canComplete}
      />
      <div className="flex flex-col gap-6">
        {caseData && (
          <div className="flex flex-col gap-2 border border-border p-4 bg-card">
            <div className="flex justify-between items-center">
              <span className="text-[10px] font-label uppercase tracking-widest text-muted-foreground">
                Case ID
              </span>
              <span className="text-xs font-mono text-primary">
                {caseData.id.slice(0, 8)}...
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

        {isPendingAcceptance && (
          <div
            className={`border p-4 flex flex-col gap-3 ${isOverdue ? "border-destructive/50 bg-destructive/5" : "border-amber-500/50 bg-amber-500/5"}`}
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-label uppercase tracking-widest font-bold text-foreground">
                Job Pending Acknowledgement
              </span>
              <span
                className={`text-xs font-mono font-bold ${isOverdue ? "text-destructive" : "text-amber-500"}`}
              >
                {isOverdue ? "SLA BREACHED" : countdown}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
              Choose the future appointment interval before accepting this
              allocation.
            </p>
            <label className="flex flex-col gap-1 text-[10px] font-label uppercase tracking-widest text-muted-foreground">
              Appointment start
              <input
                type="datetime-local"
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
                className="h-9 border border-border bg-background px-2 text-xs text-foreground"
              />
            </label>
            <label className="flex flex-col gap-1 text-[10px] font-label uppercase tracking-widest text-muted-foreground">
              Appointment end
              <input
                type="datetime-local"
                value={endTime}
                onChange={(event) => setEndTime(event.target.value)}
                className="h-9 border border-border bg-background px-2 text-xs text-foreground"
              />
            </label>
            <Button
              onClick={handleAccept}
              disabled={
                acceptJob.isPending ||
                (!isAcceptanceRetry && isOverdue) ||
                !isValidAppointment
              }
              className="rounded-none uppercase text-[10px] font-label tracking-widest w-full bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              <CheckCircle className="h-3.5 w-3.5 mr-2" />
              {acceptJob.isPending ? "Acknowledging..." : "Acknowledge Job"}
            </Button>
            {acceptJob.isError && (
              <p className="text-[10px] text-destructive uppercase">
                {acceptJob.error?.message}
              </p>
            )}
          </div>
        )}

        {isAccepted && (
          <div className="border border-emerald-500/50 bg-emerald-500/5 p-4 flex flex-col gap-3">
            <span className="text-[10px] font-label uppercase tracking-widest font-bold text-foreground">
              Appointment Scheduled
            </span>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
              {appointment
                ? `${new Date(appointment.startTime).toLocaleString()} — ${new Date(appointment.endTime).toLocaleString()}`
                : "Your appointment is being confirmed."}
            </p>
            <div className="flex flex-col gap-2">
              {canStartWork && (
                <Button
                  onClick={handleStartWork}
                  disabled={startWork.isPending}
                  className="rounded-none uppercase text-[10px] font-label tracking-widest w-full bg-blue-600 hover:bg-blue-700 text-white"
                >
                  <Play className="h-3.5 w-3.5 mr-2" />
                  {startWork.isPending ? "Starting Work..." : "Start Work"}
                </Button>
              )}
              {startWork.isError && (
                <p className="text-[10px] text-destructive uppercase">
                  {startWork.error?.message}
                </p>
              )}
              <Button
                onClick={() => setCloseJobOpen(true)}
                disabled={!canComplete}
                className="rounded-none uppercase text-[10px] font-label tracking-widest w-full bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                <CheckCircle className="h-3.5 w-3.5 mr-2" />
                Complete Job &amp; Submit Report
              </Button>
              <Button
                onClick={handleNoAccess}
                disabled={noAccess.isPending || !!noAccessBlockedFor}
                aria-describedby={
                  noAccessBlockedFor ? "no-access-blocked" : undefined
                }
                variant="outline"
                className="rounded-none uppercase text-[10px] font-label tracking-widest w-full border-destructive/40 text-destructive hover:bg-destructive/10"
              >
                Report No Access
              </Button>
              {noAccessBlockedFor && (
                <p
                  id="no-access-blocked"
                  className="text-[10px] text-muted-foreground"
                >
                  {noAccessBlockedFor}
                </p>
              )}
              {noAccess.isError && (
                <p className="text-[10px] text-destructive uppercase">
                  {noAccess.error?.message}
                </p>
              )}
            </div>
          </div>
        )}

        {isAwaitingResident && (
          <div className="border border-amber-500/50 bg-amber-500/5 p-4 flex flex-col gap-2">
            <span className="text-[10px] font-label uppercase tracking-widest font-bold text-foreground">
              Awaiting Resident Response
            </span>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
              The resident has been notified to reschedule. This job will
              re-open once a new slot is selected.
            </p>
          </div>
        )}

        <div className="flex items-center gap-2 border-b border-border pb-3">
          <History className="h-4 w-4 text-primary" />
          <span className="font-label text-xs uppercase tracking-widest text-foreground font-bold">
            Activity Log
          </span>
        </div>

        {isLoading ? (
          <div className="text-[10px] font-label uppercase tracking-widest text-muted-foreground text-center py-8">
            Loading history...
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
                  className={`absolute left-0 top-1.5 h-4 w-4 rounded-full bg-popover border-2 z-10 flex items-center justify-center ${
                    i === events.length - 1
                      ? "border-emerald-500"
                      : "border-primary"
                  }`}
                >
                  <div
                    className={`h-1.5 w-1.5 rounded-full ${
                      i === events.length - 1 ? "bg-emerald-500" : "bg-primary"
                    }`}
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
    </>
  );
}
