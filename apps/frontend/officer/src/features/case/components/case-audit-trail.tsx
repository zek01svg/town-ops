import { useQuery } from "@tanstack/react-query";
import { Clock, History, User } from "lucide-react";

import { Badge } from "@/components/ui/badge";

import { auditQueries } from "../api/audit-queries";
import type { CaseItem } from "../types";

interface Props {
  caseId: string;
  caseData?: CaseItem;
}

export function CaseAuditTrail({ caseId, caseData }: Props) {
  const { data: events = [], isLoading } = useQuery(
    auditQueries.timeline(caseId)
  );

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

      {/* Timeline */}
      <div className="flex items-center gap-2 border-b border-border pb-3">
        <History className="h-4 w-4 text-primary" />
        <span className="font-label text-xs uppercase tracking-widest text-foreground font-bold">
          Activity Log
        </span>
      </div>

      {isLoading ? (
        <div className="text-[10px] font-label uppercase tracking-widest text-muted-foreground text-center py-8">
          Loading history…
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
