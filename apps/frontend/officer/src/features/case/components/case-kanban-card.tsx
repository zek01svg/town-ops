import { Clock } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

import type { CaseContent } from "../types";

interface CaseKanbanCardProps {
  id: string;
  content: CaseContent;
  variant?: "officer" | "contractor";
  onClick?: () => void;
}

export function CaseKanbanCard({ id, content, onClick }: CaseKanbanCardProps) {
  const priority = content.priority;
  let urgencyVariant: "destructive" | "secondary" | "outline" | "default" =
    "secondary";

  if (priority === "high" || priority === "emergency") {
    urgencyVariant = "destructive";
  } else if (priority === "medium") {
    urgencyVariant = "default";
  } else {
    urgencyVariant = "outline";
  }

  return (
    <Card
      onClick={onClick}
      className="rounded-none border border-border bg-card shadow-md hover:shadow-lg transition-all group overflow-hidden mb-3 cursor-pointer"
    >
      <CardHeader className="p-3 pb-0">
        <div className="flex justify-between items-start">
          <Badge
            variant={urgencyVariant}
            className="rounded-none text-[10px] uppercase font-label tracking-tighter shrink-0"
          >
            {priority}
          </Badge>
          <span className="text-[10px] font-mono text-muted-foreground group-hover:text-primary transition-colors">
            {id}
          </span>
        </div>
      </CardHeader>
      <CardContent className="p-3 pt-2 space-y-2">
        <p className="text-[11px] font-medium leading-tight line-clamp-2 text-foreground">
          {content.address}
        </p>
        <p className="text-[10px] text-muted-foreground line-clamp-1">
          {content.description}
        </p>
        <div className="flex items-center justify-between pt-2 border-t border-border/50">
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Clock className="h-3 w-3" />
            <span>{content.sla}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
