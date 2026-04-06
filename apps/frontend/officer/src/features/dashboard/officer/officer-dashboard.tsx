import { useQuery } from "@tanstack/react-query";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Plus, Search, Clock } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { caseQueries } from "@/features/case/api/queries";
import { CaseAuditTrail } from "@/features/case/components/case-audit-trail";
import { CaseKanbanCard } from "@/features/case/components/case-kanban-card";
import { NewCaseForm } from "@/features/case/components/new-case-form";
import type { CaseItem } from "@/features/case/types";

const columnHelper = createColumnHelper<CaseItem>();

const COLUMNS = [
  { id: "pending", label: "Pending", statuses: ["pending"] },
  {
    id: "dispatched",
    label: "Dispatched",
    statuses: ["assigned", "dispatched", "in_progress"],
  },
  { id: "escalated", label: "Escalated", statuses: ["escalated"] },
  { id: "resolved", label: "Resolved", statuses: ["completed", "cancelled"] },
];

export function OfficerDashboard() {
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [isAuditOpen, setIsAuditOpen] = useState(false);
  const [search, setSearch] = useState("");

  const { data: cases = [], isLoading } = useQuery(caseQueries.all());

  const filtered = search
    ? cases.filter(
        (c) =>
          c.id.includes(search) ||
          c.address.toLowerCase().includes(search.toLowerCase()) ||
          c.category.toLowerCase().includes(search.toLowerCase())
      )
    : cases;

  const columns = [
    columnHelper.accessor("id", {
      header: "Case ID",
      cell: (info) => (
        <span className="font-mono font-medium text-primary">
          {info.getValue()}
        </span>
      ),
    }),
    columnHelper.accessor("address", {
      header: "Address",
      cell: (info) => (
        <span className="text-muted-foreground">{info.getValue()}</span>
      ),
    }),
    columnHelper.accessor("priority", {
      header: "Urgency",
      cell: (info) => {
        const urgency = info.getValue();
        let variant: "destructive" | "secondary" | "outline" | "default" =
          "secondary";
        let className = "rounded-none text-xs uppercase";
        if (urgency === "high" || urgency === "emergency")
          variant = "destructive";
        else if (urgency === "medium")
          className += " bg-indigo-500/20 text-indigo-400 border-indigo-500/30";
        else variant = "outline";
        return (
          <Badge variant={variant} className={className}>
            {urgency}
          </Badge>
        );
      },
    }),
    columnHelper.accessor("createdAt", {
      header: "Created At",
      cell: (info) => (
        <span className="flex items-center gap-1 text-muted-foreground text-xs font-mono">
          <Clock className="h-4 w-4" />
          {new Date(info.getValue()).toLocaleTimeString()}
        </span>
      ),
    }),
    columnHelper.accessor("status", {
      header: "Status",
      cell: (info) => (
        <Badge className="rounded-none bg-muted text-foreground border-border uppercase text-[10px]">
          {info.getValue()}
        </Badge>
      ),
    }),
    columnHelper.display({
      id: "actions",
      cell: (info) => (
        <Button
          variant="outline"
          size="sm"
          className="hover:bg-muted rounded-none border-border"
          onClick={() => {
            setSelectedCaseId(info.row.original.id);
            setIsAuditOpen(true);
          }}
        >
          View Audit
        </Button>
      ),
    }),
  ];

  const table = useReactTable({
    data: filtered,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const activeCases = cases.filter(
    (c) => !["completed", "cancelled"].includes(c.status)
  );
  const breachedCases = cases.filter((c) => c.status === "escalated");
  const resolvedCases = cases.filter((c) =>
    ["completed", "cancelled"].includes(c.status)
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Audit Sheet */}
      <Sheet open={isAuditOpen} onOpenChange={setIsAuditOpen}>
        <SheetContent
          side="right"
          className="bg-popover shadow-2xl text-foreground border-border rounded-none sm:max-w-md w-full"
        >
          <SheetHeader>
            <SheetTitle className="text-xl uppercase tracking-widest font-bold font-label border-b-2 border-primary pb-2 w-fit">
              Audit Trail
            </SheetTitle>
          </SheetHeader>
          <div className="mt-8 overflow-auto">
            {selectedCaseId && (
              <CaseAuditTrail
                caseId={selectedCaseId}
                caseData={cases.find((c) => c.id === selectedCaseId)}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-label tracking-tighter text-foreground uppercase border-b-2 border-primary inline-block pb-1">
            Town Council Officer Workspace
          </h1>
          <p className="text-muted-foreground text-sm mt-2">
            Manage incoming reports and SLA compliance.
          </p>
        </div>
        <Sheet open={isSheetOpen} onOpenChange={setIsSheetOpen}>
          <SheetTrigger asChild>
            <Button className="rounded-none bg-primary hover:bg-primary/90 text-primary-foreground font-label uppercase tracking-widest gap-2">
              <Plus className="h-4 w-4" /> Open New Case
            </Button>
          </SheetTrigger>
          <SheetContent
            side="right"
            className="bg-popover border-border rounded-none sm:max-w-md w-full overflow-y-auto"
          >
            <SheetHeader>
              <SheetTitle className="text-primary font-label uppercase tracking-widest border-b border-border pb-2 inline-block">
                Create New Case
              </SheetTitle>
              <SheetDescription className="text-muted-foreground font-sans">
                Fill out the incident details payload carefully.
              </SheetDescription>
            </SheetHeader>
            <NewCaseForm setOpen={setIsSheetOpen} />
          </SheetContent>
        </Sheet>
      </div>

      {/* Stat Cards */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        {[
          {
            t: "Active Cases",
            v: isLoading ? "—" : String(activeCases.length),
            s: "Open reports",
            ic: "text-foreground",
          },
          {
            t: "SLA Breached",
            v: isLoading ? "—" : String(breachedCases.length),
            s: "Action required",
            ic: "text-destructive",
            border: "border-t-4 border-t-destructive",
          },
          {
            t: "Total Cases",
            v: isLoading ? "—" : String(cases.length),
            s: "All time",
            ic: "text-amber-500",
            border: "border-t-4 border-t-amber-500",
          },
          {
            t: "Resolved",
            v: isLoading ? "—" : String(resolvedCases.length),
            s: "Completed or cancelled",
            ic: "text-green-500",
            border: "border-t-4 border-t-green-500",
          },
        ].map((item) => (
          <Card
            key={item.t}
            className={`bg-surface-container border border-border rounded-none ${item.border ?? ""}`}
          >
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-xs font-label uppercase tracking-widest text-muted-foreground">
                {item.t}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-3xl font-bold font-sans ${item.ic}`}>
                {item.v}
              </div>
              <p className="text-xs text-muted-foreground mt-1">{item.s}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tabs */}
      <Tabs defaultValue="kanban" className="flex flex-col w-full">
        <div className="flex items-center justify-between gap-4 mb-4">
          <TabsList className="bg-surface-container border border-border rounded-none p-0 h-10 shrink-0">
            <TabsTrigger
              value="kanban"
              className="rounded-none data-[state=active]:bg-primary data-[state=active]:text-primary-foreground font-label uppercase tracking-widest text-xs h-full px-6 transition-none"
            >
              Kanban
            </TabsTrigger>
            <TabsTrigger
              value="table"
              className="rounded-none data-[state=active]:bg-primary data-[state=active]:text-primary-foreground font-label uppercase tracking-widest text-xs h-full px-6 transition-none"
            >
              Table
            </TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-3 flex-1 max-w-sm">
            <Search className="h-4 w-4 text-primary shrink-0" />
            <Input
              placeholder="Search records..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-surface-container rounded-none border-border h-10 focus-visible:ring-primary"
            />
          </div>
        </div>

        {/* Kanban */}
        <TabsContent value="kanban" className="m-0 focus-visible:outline-none">
          {isLoading ? (
            <div className="border border-border bg-surface-container p-8 text-center text-muted-foreground text-sm font-label uppercase tracking-widest">
              Loading board...
            </div>
          ) : (
            <div className="w-full overflow-x-auto">
              <div className="flex gap-4 min-w-max pb-4">
                {COLUMNS.map((col) => {
                  const cards = filtered.filter((c) =>
                    col.statuses.includes(c.status)
                  );
                  return (
                    <div
                      key={col.id}
                      className="w-72 shrink-0 flex flex-col bg-surface-container/50 border border-border"
                    >
                      <div className="flex items-center justify-between p-4 border-b-2 border-primary bg-surface-container">
                        <span className="font-label uppercase tracking-widest text-sm">
                          {col.label}
                        </span>
                        <Badge
                          variant="secondary"
                          className="rounded-none bg-muted text-foreground border-border h-5 px-1.5 text-[10px]"
                        >
                          {cards.length}
                        </Badge>
                      </div>
                      <div className="flex flex-col gap-2 p-3 flex-1">
                        {cards.length === 0 ? (
                          <div className="text-[10px] text-muted-foreground font-label uppercase tracking-widest text-center py-8">
                            Empty
                          </div>
                        ) : (
                          cards.map((c) => (
                            <CaseKanbanCard
                              key={c.id}
                              id={c.id}
                              content={{
                                address: c.address,
                                priority: c.priority,
                                sla: "—",
                                description: c.description ?? "",
                              }}
                              onClick={() => {
                                setSelectedCaseId(c.id);
                                setIsAuditOpen(true);
                              }}
                            />
                          ))
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </TabsContent>

        {/* Table */}
        <TabsContent value="table" className="m-0 focus-visible:outline-none">
          {isLoading ? (
            <div className="border border-border bg-surface-container p-8 text-center text-muted-foreground text-sm font-label uppercase tracking-widest">
              Loading cases...
            </div>
          ) : (
            <div className="border border-border bg-surface-container overflow-hidden rounded-none">
              <div className="relative w-full overflow-auto">
                <Table>
                  <TableHeader className="border-b-2 border-border bg-surface-container-low">
                    {table.getHeaderGroups().map((hg) => (
                      <TableRow
                        key={hg.id}
                        className="hover:bg-transparent border-none"
                      >
                        {hg.headers.map((h) => (
                          <TableHead
                            key={h.id}
                            className="text-foreground font-label text-xs uppercase tracking-widest h-12"
                          >
                            {h.isPlaceholder
                              ? null
                              : flexRender(
                                  h.column.columnDef.header,
                                  h.getContext()
                                )}
                          </TableHead>
                        ))}
                      </TableRow>
                    ))}
                  </TableHeader>
                  <TableBody>
                    {table.getRowModel().rows.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={columns.length}
                          className="text-center text-muted-foreground py-8 text-sm"
                        >
                          No cases found.
                        </TableCell>
                      </TableRow>
                    ) : (
                      table.getRowModel().rows.map((row) => (
                        <TableRow
                          key={row.id}
                          className="border-b border-border/50 hover:bg-muted transition-colors"
                        >
                          {row.getVisibleCells().map((cell) => (
                            <TableCell key={cell.id} className="py-4">
                              {flexRender(
                                cell.column.columnDef.cell,
                                cell.getContext()
                              )}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
