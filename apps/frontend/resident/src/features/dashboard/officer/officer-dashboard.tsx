import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Plus, Search, Clock } from "lucide-react";
import { useState } from "react";
import { Kanban } from "react-kanban-kit";
import type { BoardData, BoardProps } from "react-kanban-kit";

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
import { mockCases } from "@/features/case/api/mocks";
import { CaseAuditTrail } from "@/features/case/components/case-audit-trail";
import { CaseKanbanCard } from "@/features/case/components/case-kanban-card";
import { NewCaseForm } from "@/features/case/components/new-case-form";
import type { CaseItem } from "@/features/case/types";

const columnHelper = createColumnHelper<CaseItem>();

export function OfficerDashboard() {
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [isAuditOpen, setIsAuditOpen] = useState(false);

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
        return (
          <Badge className="rounded-none bg-muted text-foreground border-border uppercase text-[10px]">
            {info.getValue()}
          </Badge>
        );
      },
    }),
    columnHelper.display({
      id: "actions",
      cell: (info) => {
        const rowData = info.row.original;
        return (
          <Button
            variant="outline"
            size="sm"
            className="hover:bg-muted rounded-none border-border"
            onClick={() => {
              setSelectedCaseId(rowData.id);
              setIsAuditOpen(true);
            }}
          >
            View Audit
          </Button>
        );
      },
    }),
  ];

  const table = useReactTable({
    data: mockCases,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const [boardData] = useState<BoardData>({
    root: {
      id: "root",
      title: "root",
      parentId: null,
      children: ["col1", "col2", "col3", "col4"],
      totalChildrenCount: 4,
    },
    col1: {
      id: "col1",
      title: "Pending",
      parentId: "root",
      children: ["CASE-1001", "CASE-1004"],
      totalChildrenCount: 2,
    },
    col2: {
      id: "col2",
      title: "Dispatched",
      parentId: "root",
      children: ["CASE-1002"],
      totalChildrenCount: 1,
    },
    col3: {
      id: "col3",
      title: "Escalated",
      parentId: "root",
      children: ["CASE-1003"],
      totalChildrenCount: 1,
    },
    col4: {
      id: "col4",
      title: "Resolved",
      parentId: "root",
      children: [],
      totalChildrenCount: 0,
    },
    "CASE-1001": {
      id: "CASE-1001",
      title: "CASE-1001",
      parentId: "col1",
      children: [],
      totalChildrenCount: 0,
      content: {
        address: "Blk 123 Ang Mo Kio Ave 4 #05-12",
        priority: "high",
        sla: "1h 30m",
        description: "Water pipe bursting in kitchen ceilings.",
      },
      type: "card",
    },
    "CASE-1002": {
      id: "CASE-1002",
      title: "CASE-1002",
      parentId: "col2",
      children: [],
      totalChildrenCount: 0,
      content: {
        address: "Blk 456 Jurong West St 41 #12-32",
        priority: "medium",
        sla: "4h 15m",
        description: "Corridor lighting flickering issues.",
      },
      type: "card",
    },
    "CASE-1003": {
      id: "CASE-1003",
      title: "CASE-1003",
      parentId: "col3",
      children: [],
      totalChildrenCount: 0,
      content: {
        address: "Blk 789 Bedok North Rd #02-10",
        priority: "low",
        sla: "22h 00m",
        description: "Slight cracks on void deck pillars surface.",
      },
      type: "card",
    },
    "CASE-1004": {
      id: "CASE-1004",
      title: "CASE-1004",
      parentId: "col1",
      children: [],
      totalChildrenCount: 0,
      content: {
        address: "Blk 101 Tampines St 11 #08-22",
        priority: "high",
        sla: "-15m",
        description: "No water supply reported for the block.",
      },
      type: "card",
    },
  });

  const configMap: BoardProps["configMap"] = {
    card: {
      render: ({ data }) => (
        <CaseKanbanCard
          id={data.id}
          content={data.content}
          variant="officer"
          onClick={() => {
            console.log(`[OfficerDashboard] Kanban card clicked: ${data.id}`);
            setSelectedCaseId(data.id);
            setIsAuditOpen(true);
          }}
        />
      ),
    },
  };

  return (
    <div className="flex flex-col gap-8 relative">
      <Sheet open={isAuditOpen} onOpenChange={setIsAuditOpen}>
        <SheetContent className="bg-popover shadow-2xl text-foreground border-border rounded-none sm:max-w-md w-full">
          <SheetHeader>
            <SheetTitle className="text-xl uppercase tracking-widest font-bold font-label border-b-2 border-primary pb-2 w-fit">
              Audit Trail
            </SheetTitle>
          </SheetHeader>
          <div className="mt-8 h-full">
            {selectedCaseId && <CaseAuditTrail caseId={selectedCaseId} />}
          </div>
        </SheetContent>
      </Sheet>

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
          <SheetContent className="bg-popover border-border rounded-none sm:max-w-md w-full overflow-y-auto">
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

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {[
          {
            t: "Active Cases",
            v: "4",
            s: "+1 since last hour",
            ic: "text-foreground",
          },
          {
            t: "SLA Breached",
            v: "1",
            s: "Action required",
            ic: "text-destructive",
          },
          { t: "Warning", v: "2", s: "Within 30 limit", ic: "text-amber-500" },
          { t: "Resolved", v: "12", s: "Avg: 3h", ic: "text-primary" },
        ].map((item, i) => (
          <Card
            key={i}
            className={`bg-surface-container border border-border rounded-none ${i === 1 ? "border-t-4 border-t-destructive" : i === 2 ? "border-t-4 border-t-amber-500" : ""}`}
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

      <Tabs defaultValue="kanban" className="w-full">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-6 gap-4">
          <TabsList className="bg-surface-container border border-border rounded-none p-0 h-10 w-full sm:w-auto">
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
          <div className="flex items-center gap-4 max-w-sm w-full">
            <Search className="h-4 w-4 text-primary shrink-0" />
            <Input
              placeholder="Search records..."
              className="bg-surface-container rounded-none border-border h-10 focus-visible:ring-primary"
            />
          </div>
        </div>

        <TabsContent value="table" className="m-0 focus-visible:outline-none">
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
                  {table.getRowModel().rows.map((row) => (
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
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="kanban" className="m-0 focus-visible:outline-none">
          <div className="overflow-x-auto pb-4">
            <Kanban
              dataSource={boardData}
              configMap={configMap}
              columnClassName={() =>
                "w-80 shrink-0 flex flex-col bg-surface-container/50 border-r border-border min-h-[500px]"
              }
              columnHeaderClassName={() =>
                "p-4 border-b-2 border-primary mb-4 bg-surface-container-low font-label uppercase tracking-widest text-sm"
              }
              columnListContentClassName={() => "px-3"}
              rootClassName="flex items-start"
            />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
