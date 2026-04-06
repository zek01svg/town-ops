import { useState } from "react";
import { Clock, Search } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

import type { CaseItem } from "@/features/case/types";
import { caseQueries } from "@/features/case/api/queries";
import { CaseKanbanCard } from "@/features/case/components/case-kanban-card";
import { CaseAuditTrail } from "@/features/case/components/case-audit-trail";

const COLUMNS = [
  { id: "pending", label: "Pending", statuses: ["pending", "pending_resident_input"] },
  { id: "dispatch", label: "Dispatched", statuses: ["assigned", "dispatched"] },
  { id: "inprogress", label: "In Progress", statuses: ["in_progress", "escalated"] },
  { id: "resolved", label: "Resolved", statuses: ["completed", "cancelled"] },
];

const tableColumnHelper = createColumnHelper<CaseItem>();

export function ContractorDashboard() {
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [openAudit, setOpenAudit] = useState(false);
  const [search, setSearch] = useState("");

  const { data: cases = [], isLoading, isError, error } = useQuery(
    caseQueries.all()
  );
  const errorMessage =
    error instanceof Error ? error.message : "Failed to load cases.";

  const filtered = search
    ? cases.filter((c) =>
        c.id.includes(search) ||
        c.address.toLowerCase().includes(search.toLowerCase()) ||
        c.category.toLowerCase().includes(search.toLowerCase())
      )
    : cases;

  const tableColumns = [
    tableColumnHelper.accessor("id", {
      header: "Case ID",
      cell: (info) => (
        <Button
          variant="link"
          className="p-0 h-auto font-mono text-primary font-bold"
          onClick={() => { setSelectedCaseId(info.getValue()); setOpenAudit(true); }}
        >
          {info.getValue()}
        </Button>
      ),
    }),
    tableColumnHelper.accessor("address", {
      header: "Address",
      cell: (info) => <span className="text-muted-foreground">{info.getValue()}</span>,
    }),
    tableColumnHelper.accessor("priority", {
      header: "Urgency",
      cell: (info) => {
        const priority = info.getValue();
        let variant: "destructive" | "secondary" | "outline" | "default" = "secondary";
        let className = "uppercase text-[10px]";
        if (priority === "high" || priority === "emergency") variant = "destructive";
        else if (priority === "medium") className += " bg-amber-500 hover:bg-amber-600 text-white border-transparent";
        else variant = "outline";
        return <Badge variant={variant} className={className}>{priority}</Badge>;
      },
    }),
    tableColumnHelper.accessor("createdAt", {
      header: "Created At",
      cell: (info) => (
        <span className="flex items-center gap-1 text-muted-foreground text-xs font-mono">
          <Clock className="h-4 w-4" />
          {new Date(info.getValue()).toLocaleTimeString()}
        </span>
      ),
    }),
    tableColumnHelper.accessor("status", {
      header: "Status",
      cell: (info) => <Badge variant="outline" className="border-border uppercase text-[10px]">{info.getValue()}</Badge>,
    }),
    tableColumnHelper.display({
      id: "actions",
      cell: (info) => (
        <Button
          variant="outline"
          className="rounded-none border-border h-8 text-[10px] uppercase font-label tracking-widest text-primary font-bold hover:bg-primary/10"
          onClick={() => { setSelectedCaseId(info.row.original.id); setOpenAudit(true); }}
        >
          Audit
        </Button>
      ),
    }),
  ];

  const table = useReactTable({ data: filtered, columns: tableColumns, getCoreRowModel: getCoreRowModel() });

  const backlog = cases.filter((c) => c.status === "pending" || c.status === "pending_resident_input");
  const dispatched = cases.filter((c) => ["assigned", "dispatched"].includes(c.status));
  const inProgress = cases.filter((c) => ["in_progress", "escalated"].includes(c.status));
  const resolved = cases.filter((c) => ["completed", "cancelled"].includes(c.status));

  return (
    <div className="flex flex-col gap-6 h-full relative">
      <Sheet open={openAudit} onOpenChange={setOpenAudit}>
        <SheetContent className="w-[450px] sm:w-[500px] border-l border-border bg-popover p-6 shadow-2xl">
          <SheetHeader className="mb-0">
            <SheetTitle className="text-xl uppercase tracking-widest font-bold font-label border-b-2 border-primary pb-2 w-fit">Audit Trail</SheetTitle>
          </SheetHeader>
          <div className="mt-8 h-full">
            {selectedCaseId && (
              <CaseAuditTrail
                caseId={selectedCaseId}
                caseData={cases.find((c) => c.id === selectedCaseId)}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-label tracking-tighter text-foreground uppercase border-b-2 border-primary inline-block pb-1">Contractor Operations Pipeline</h1>
          <p className="text-muted-foreground text-sm mt-2">Organize and execute dispatched repairs jobs.</p>
        </div>
      </div>

      {isError && (
        <div className="border border-destructive/30 bg-destructive/5 text-destructive text-[10px] font-label uppercase tracking-widest p-3">
          {errorMessage}
        </div>
      )}

      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        {[
          { title: "Backlog",     value: isLoading ? "—" : String(backlog.length),     sub: "Awaiting actions",        vc: "text-foreground" },
          { title: "Dispatched",  value: isLoading ? "—" : String(dispatched.length),  sub: "Allocated mechanics",     vc: "text-blue-500",   border: "border-t-4 border-t-blue-500" },
          { title: "In Progress", value: isLoading ? "—" : String(inProgress.length),  sub: "Active resolution",       vc: "text-amber-500",  border: "border-t-4 border-t-amber-500" },
          { title: "Resolved",    value: isLoading ? "—" : String(resolved.length),    sub: "Completed or cancelled",  vc: "text-green-500",  border: "border-t-4 border-t-green-500" },
        ].map((item) => (
          <Card key={item.title} className={`bg-surface-container border border-border rounded-none ${item.border ?? ""}`}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-xs font-label uppercase tracking-widest text-muted-foreground">{item.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-3xl font-bold font-sans ${item.vc}`}>{item.value}</div>
              <p className="text-xs text-muted-foreground mt-1">{item.sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs defaultValue="kanban" className="flex-1 flex flex-col min-h-0 w-full mt-4">
        <div className="flex items-center justify-between mb-4">
          <TabsList className="bg-surface-container border border-border rounded-none p-0 h-10">
            <TabsTrigger value="kanban" className="rounded-none data-[state=active]:bg-primary data-[state=active]:text-primary-foreground font-label uppercase tracking-widest text-xs h-full px-6 transition-none">Kanban Board</TabsTrigger>
            <TabsTrigger value="table" className="rounded-none data-[state=active]:bg-primary data-[state=active]:text-primary-foreground font-label uppercase tracking-widest text-xs h-full px-6 transition-none">Table View</TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-2 max-w-sm w-full">
            <Search className="h-4 w-4 text-primary shrink-0" />
            <Input
              placeholder="Search cases..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-surface-container rounded-none border-border h-10 focus-visible:ring-primary"
            />
          </div>
        </div>

        <TabsContent value="kanban" className="flex-1 overflow-x-auto min-h-0 m-0">
          {isLoading ? (
            <div className="border border-border bg-surface-container p-8 text-center text-muted-foreground text-sm font-label uppercase tracking-widest">Loading board...</div>
          ) : (
            <div className="w-full overflow-x-auto">
              <div className="flex gap-4 min-w-max pb-4">
                {COLUMNS.map((col) => {
                  const cards = filtered.filter((c) => col.statuses.includes(c.status));
                  return (
                    <div key={col.id} className="w-72 shrink-0 flex flex-col bg-surface-container/50 border border-border">
                      <div className="flex items-center justify-between p-4 border-b-2 border-primary bg-surface-container">
                        <span className="font-label uppercase tracking-widest text-sm">{col.label}</span>
                        <Badge variant="secondary" className="rounded-none bg-muted text-foreground border-border h-5 px-1.5 text-[10px]">{cards.length}</Badge>
                      </div>
                      <div className="flex flex-col gap-2 p-3 flex-1">
                        {cards.length === 0 ? (
                          <div className="text-[10px] text-muted-foreground font-label uppercase tracking-widest text-center py-8">Empty</div>
                        ) : cards.map((c) => (
                          <CaseKanbanCard
                            key={c.id}
                            id={c.id}
                            content={{ address: c.address, priority: c.priority, sla: "-", description: c.description ?? "" }}
                            variant="contractor"
                            onClick={() => { setSelectedCaseId(c.id); setOpenAudit(true); }}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="table" className="flex-1 overflow-auto m-0">
          {isLoading ? (
            <div className="border border-border bg-surface-container p-8 text-center text-muted-foreground text-sm font-label uppercase tracking-widest">Loading cases...</div>
          ) : (
            <div className="border border-border bg-surface-container overflow-hidden rounded-none">
              <Table>
                <TableHeader className="border-b-2 border-border bg-surface-container-low">
                  {table.getHeaderGroups().map((headerGroup) => (
                    <TableRow key={headerGroup.id} className="hover:bg-transparent border-none">
                      {headerGroup.headers.map((header) => (
                        <TableHead key={header.id} className="text-foreground font-label text-xs uppercase tracking-widest h-12">
                          {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                        </TableHead>
                      ))}
                    </TableRow>
                  ))}
                </TableHeader>
                <TableBody>
                  {table.getRowModel().rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={tableColumns.length} className="text-center text-muted-foreground py-8 text-sm">
                        No cases found.
                      </TableCell>
                    </TableRow>
                  ) : (
                    table.getRowModel().rows.map((row) => (
                      <TableRow key={row.id} className="border-b border-border/50 hover:bg-muted transition-colors">
                        {row.getVisibleCells().map((cell) => (
                          <TableCell key={cell.id} className="py-4">
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
