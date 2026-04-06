import { createColumnHelper } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Clock } from "lucide-react";
import { CaseItem } from "../types";

const columnHelper = createColumnHelper<CaseItem>();

export const getCaseTableColumns = (onViewAudit?: (caseItem: CaseItem) => void) => [
  columnHelper.accessor("id", {
    header: "Case ID",
    cell: (info) => <span className="font-mono font-medium text-primary">{info.getValue()}</span>,
  }),
  columnHelper.accessor("address", {
    header: "Address",
    cell: (info) => <span className="text-muted-foreground">{info.getValue()}</span>,
  }),
  columnHelper.accessor("priority", {
    header: "Urgency",
    cell: (info) => {
      const urgency = info.getValue();
      let variant: "destructive" | "secondary" | "outline" | "default" = "secondary";
      let className = "rounded-none text-xs uppercase";
      if (urgency === "high" || urgency === "emergency") variant = "destructive";
      else if (urgency === "medium") className += " bg-indigo-500/20 text-indigo-400 border-indigo-500/30";
      else variant = "outline";
      return <Badge variant={variant} className={className}>{urgency}</Badge>;
    },
  }),
  columnHelper.accessor("createdAt", {
    header: "Created At",
    cell: (info) => {
      const value = info.getValue();
      return (
        <span className="flex items-center gap-1 text-muted-foreground text-xs font-mono">
          <Clock className="h-4 w-4" />
          {new Date(value).toLocaleTimeString()}
        </span>
      );
    },
  }),
  columnHelper.accessor("status", {
    header: "Status",
    cell: (info) => {
      return <Badge className="rounded-none bg-surface-variant text-foreground border-outline-variant uppercase text-[10px]">{info.getValue()}</Badge>;
    },
  }),
  ...(onViewAudit ? [
    columnHelper.display({
      id: "actions",
      cell: (info) => {
        const rowData = info.row.original;
        return (
          <button
            onClick={() => onViewAudit?.(rowData)}
            className="text-xs text-primary underline hover:text-primary/80 transition-colors"
          >
            View Audit
          </button>
        );
      },
    }),
  ] : []),
];
