import { Clock, History, User } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

interface AuditEvent {
  id: string;
  type: string;
  actor: string;
  timestamp: string;
  description: string;
}

const mockAuditTrail: AuditEvent[] = [
  {
    id: "1",
    type: "Created",
    actor: "System",
    timestamp: "2h ago",
    description: "Case automatically routed to Ang Mo Kio TC.",
  },
  {
    id: "2",
    type: "Assigned",
    actor: "Officer Chen",
    timestamp: "1h ago",
    description: "Assigned to Contractor: HDB Care Services.",
  },
  {
    id: "3",
    type: "Acknowledged",
    actor: "Contractor Rep",
    timestamp: "45m ago",
    description: "Job acknowledged and queued for dispatch.",
  },
  {
    id: "4",
    type: "Dispatched",
    actor: "Contractor Rep",
    timestamp: "10m ago",
    description: "Technician Ali (ID: T-442) en-route to location.",
  },
];

export function CaseAuditTrail({ caseId }: { caseId: string }) {
  return (
    <div className="flex flex-col h-full bg-popover">
      <div className="flex items-center gap-2 mb-6 border-b border-border pb-4">
        <History className="h-4 w-4 text-primary" />
        <span className="font-mono text-sm font-bold tracking-tighter text-foreground">
          {caseId} History Log
        </span>
      </div>

      <ScrollArea className="flex-1 -mr-4 pr-4">
        <div className="space-y-8 relative before:absolute before:left-2 before:top-2 before:bottom-2 before:w-px before:bg-border/50">
          {mockAuditTrail.map((event) => (
            <div key={event.id} className="relative pl-8 group">
              <div className="absolute left-0 top-1.5 h-4 w-4 rounded-full bg-popover border-2 border-primary z-10 group-last:border-emerald-500 flex items-center justify-center">
                <div className="h-1.5 w-1.5 rounded-full bg-primary group-last:bg-emerald-500" />
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-label uppercase tracking-widest text-foreground font-bold">
                    {event.type}
                  </span>
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {event.timestamp}
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
      </ScrollArea>

      <div className="mt-8 pt-6 border-t border-border flex flex-col gap-3">
        <div className="flex justify-between items-center bg-card p-3 border border-border/50">
          <span className="text-[10px] uppercase font-label text-muted-foreground">
            Current Status
          </span>
          <Badge
            variant="outline"
            className="rounded-none border-emerald-500/30 bg-emerald-500/10 text-emerald-500 text-[10px] uppercase"
          >
            Dispatched
          </Badge>
        </div>
        <div className="flex justify-between items-center p-3 border border-border/50">
          <span className="text-[10px] uppercase font-label text-muted-foreground">
            SLA Compliance
          </span>
          <div className="flex items-center gap-1.5 text-xs text-primary font-mono">
            <Clock className="h-3.5 w-3.5" />
            <span>01:30:00 Remaining</span>
          </div>
        </div>
      </div>
    </div>
  );
}
