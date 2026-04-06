import { useState } from "react";
import { useQuery, queryOptions, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Clock, History, User, CheckCircle } from "lucide-react";
import { auditQueries } from "../api/audit-queries";
import { useAcceptJobMutation, useNoAccessMutation } from "../api/mutations";
import type { CaseItem } from "../types";
import { CloseJobSheet } from "./close-job-sheet";
import { env } from "@/env";
import { fetchWithAuth } from "@/libr/auth-token";
import { caseKeys } from "../api/query-keys";
import { auth } from "@/libr/auth";

function useAssignment(caseId: string) {
  return useQuery(
    queryOptions({
      queryKey: caseKeys.assignment(caseId),
      enabled: !!caseId && !!localStorage.getItem("jwt"),
      retry: false,
      queryFn: async () => {
        const res = await fetchWithAuth(
          `${env.VITE_ASSIGNMENT_ATOM_URL}/api/assignments/${caseId}`,
          {},
          env.VITE_AUTH_URL
        );
        if (!res.ok) return null;
        const data = await res.json();
        return data.assignments ?? null;
      },
    })
  );
}

async function getContractorId(): Promise<string> {
  const session = await auth.getSession();
  return (session?.data?.user as any)?.contractorId ?? "unknown";
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
  const { data: events = [], isLoading } = useQuery(auditQueries.timeline(caseId));
  const { data: assignment } = useAssignment(caseId);
  const acceptJob = useAcceptJobMutation();
  const noAccess = useNoAccessMutation();
  const qc = useQueryClient();

  const [closeJobOpen, setCloseJobOpen] = useState(false);
  const isPendingAcceptance = assignment?.status === "PENDING_ACCEPTANCE";
  const isAccepted = assignment?.status === "ACCEPTED";
  const isAwaitingResident = caseData?.status === "pending_resident_input";
  const countdown = useCountdown(isPendingAcceptance ? assignment?.responseDueAt : undefined);
  const isOverdue = countdown === "OVERDUE";

  function handleAccept() {
    if (!assignment) return;
    const now = new Date();
    const end = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2h window default
    void getContractorId().then((contractorId) => {
    acceptJob.mutate(
      {
        case_id: caseId,
        assignment_id: assignment.id,
        contractor_id: contractorId,
        start_time: now.toISOString(),
        end_time: end.toISOString(),
      },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: caseKeys.assignment(caseId) });
          qc.invalidateQueries({ queryKey: caseKeys.all });
        },
      }
    );
    });
  }

  function handleNoAccess() {
    if (!assignment) return;
    void getContractorId().then((contractorId) => {
      noAccess.mutate(
        {
          case_id: caseId,
          assignment_id: assignment.id,
          contractor_id: contractorId,
          reason: "Contractor reported no access at site.",
        },
        {
          onSuccess: () => {
            qc.invalidateQueries({ queryKey: caseKeys.assignment(caseId) });
            qc.invalidateQueries({ queryKey: caseKeys.all });
          },
        }
      );
    });
  }

  return (
    <>
    <CloseJobSheet open={closeJobOpen} onOpenChange={setCloseJobOpen} caseId={caseId} />
    <div className="flex flex-col gap-6">
      {caseData && (
        <div className="flex flex-col gap-2 border border-border p-4 bg-card">
          <div className="flex justify-between items-center">
            <span className="text-[10px] font-label uppercase tracking-widest text-muted-foreground">Case ID</span>
            <span className="text-xs font-mono text-primary">{caseData.id.slice(0, 8)}...</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-[10px] font-label uppercase tracking-widest text-muted-foreground">Category</span>
            <Badge className="rounded-none text-[10px] uppercase bg-muted text-foreground border-border">
              {caseData.category}
            </Badge>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-[10px] font-label uppercase tracking-widest text-muted-foreground">Priority</span>
            <Badge
              variant={
                caseData.priority === "high" || caseData.priority === "emergency"
                  ? "destructive"
                  : "outline"
              }
              className="rounded-none text-[10px] uppercase"
            >
              {caseData.priority}
            </Badge>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-[10px] font-label uppercase tracking-widest text-muted-foreground">Status</span>
            <Badge className="rounded-none text-[10px] uppercase bg-muted text-foreground border-border">
              {caseData.status}
            </Badge>
          </div>
          {caseData.address && (
            <div className="pt-2 border-t border-border/50">
              <span className="text-[10px] font-label uppercase tracking-widest text-muted-foreground block mb-1">Address</span>
              <p className="text-xs text-foreground">{caseData.address}</p>
            </div>
          )}
          {caseData.description && (
            <div className="pt-2 border-t border-border/50">
              <span className="text-[10px] font-label uppercase tracking-widest text-muted-foreground block mb-1">Description</span>
              <p className="text-xs text-muted-foreground leading-relaxed">{caseData.description}</p>
            </div>
          )}
          <div className="flex justify-between items-center pt-2 border-t border-border/50">
            <span className="text-[10px] font-label uppercase tracking-widest text-muted-foreground">Created</span>
            <span className="text-[10px] font-mono text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {new Date(caseData.createdAt).toLocaleString()}
            </span>
          </div>
        </div>
      )}

      {isPendingAcceptance && (
        <div className={`border p-4 flex flex-col gap-3 ${isOverdue ? "border-destructive/50 bg-destructive/5" : "border-amber-500/50 bg-amber-500/5"}`}>
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-label uppercase tracking-widest font-bold text-foreground">
              Job Pending Acknowledgement
            </span>
            <span className={`text-xs font-mono font-bold ${isOverdue ? "text-destructive" : "text-amber-500"}`}>
              {isOverdue ? "SLA BREACHED" : countdown}
            </span>
          </div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
            You must acknowledge this job within 15 seconds of assignment or it will be escalated.
          </p>
          <Button
            onClick={handleAccept}
            disabled={acceptJob.isPending || isOverdue}
            className="rounded-none uppercase text-[10px] font-label tracking-widest w-full bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            <CheckCircle className="h-3.5 w-3.5 mr-2" />
            {acceptJob.isPending ? "Acknowledging..." : "Acknowledge Job"}
          </Button>
          {acceptJob.isError && (
            <p className="text-[10px] text-destructive uppercase">{acceptJob.error?.message}</p>
          )}
        </div>
      )}

      {isAccepted && (
        <div className="border border-emerald-500/50 bg-emerald-500/5 p-4 flex flex-col gap-3">
          <span className="text-[10px] font-label uppercase tracking-widest font-bold text-foreground">
            Job In Progress
          </span>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
            When the job is complete, attach before/after photos and submit your report.
          </p>
          <div className="flex flex-col gap-2">
            <Button
              onClick={() => setCloseJobOpen(true)}
              disabled={isAwaitingResident}
              className="rounded-none uppercase text-[10px] font-label tracking-widest w-full bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              <CheckCircle className="h-3.5 w-3.5 mr-2" />
              Close Job &amp; Submit Report
            </Button>
            <Button
              onClick={handleNoAccess}
              disabled={noAccess.isPending || isAwaitingResident}
              variant="outline"
              className="rounded-none uppercase text-[10px] font-label tracking-widest w-full border-destructive/40 text-destructive hover:bg-destructive/10"
            >
              Report No Access
            </Button>
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
            The resident has been notified to reschedule. This job will re-open once a new slot is selected.
          </p>
        </div>
      )}

      <div className="flex items-center gap-2 border-b border-border pb-3">
        <History className="h-4 w-4 text-primary" />
        <span className="font-label text-xs uppercase tracking-widest text-foreground font-bold">Activity Log</span>
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
            <div key={`${event.timestamp}-${i}`} className="relative pl-8 group">
              <div
                className={`absolute left-0 top-1.5 h-4 w-4 rounded-full bg-popover border-2 z-10 flex items-center justify-center ${
                  i === events.length - 1 ? "border-emerald-500" : "border-primary"
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
