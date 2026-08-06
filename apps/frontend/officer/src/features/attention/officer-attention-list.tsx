import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { attentionQueries } from "./api/queries";

/** `NO_ELIGIBLE_CONTRACTOR` -> `No Eligible Contractor`. */
function humanizeKind(kind: string) {
  return kind
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

export function OfficerAttentionList() {
  // ponytail: fixed to state=open, no resolved/open toggle in the UI yet —
  // thread `state` through as a control when Officers ask to review
  // resolved history.
  const { data: items = [], isLoading } = useQuery(
    attentionQueries.list("open")
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-label tracking-tighter text-foreground uppercase border-b-2 border-primary inline-block pb-1">
          Officer Attention
        </h1>
        <p className="text-muted-foreground text-sm mt-2">
          Operational exceptions waiting on an Officer decision.
        </p>
      </div>

      <div className="border border-border bg-surface-container overflow-hidden rounded-none">
        {isLoading ? (
          <div className="p-8 text-center text-muted-foreground text-sm font-label uppercase tracking-widest">
            Loading attention items...
          </div>
        ) : (
          <div className="relative w-full overflow-auto">
            <Table>
              <TableHeader className="border-b-2 border-border bg-surface-container-low">
                <TableRow className="hover:bg-transparent border-none">
                  <TableHead className="text-foreground font-label text-xs uppercase tracking-widest h-12">
                    Kind
                  </TableHead>
                  <TableHead className="text-foreground font-label text-xs uppercase tracking-widest h-12">
                    Detail
                  </TableHead>
                  <TableHead className="text-foreground font-label text-xs uppercase tracking-widest h-12">
                    Created
                  </TableHead>
                  <TableHead className="text-foreground font-label text-xs uppercase tracking-widest h-12">
                    State
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="text-center text-muted-foreground py-8 text-sm"
                    >
                      No open attention items.
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((item) => (
                    <TableRow
                      key={item.id}
                      className="border-b border-border/50 hover:bg-muted transition-colors"
                    >
                      <TableCell className="py-4">
                        <Badge className="rounded-none bg-muted text-foreground border-border uppercase text-[10px]">
                          {humanizeKind(item.kind)}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-4 text-muted-foreground text-xs max-w-md whitespace-normal">
                        {item.detail}
                      </TableCell>
                      <TableCell className="py-4 text-xs font-mono text-muted-foreground">
                        {new Date(item.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="py-4">
                        <Badge
                          variant={item.resolvedAt ? "outline" : "destructive"}
                          className="rounded-none text-[10px] uppercase"
                        >
                          {item.resolvedAt ? "Resolved" : "Open"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
