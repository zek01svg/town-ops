import { useState } from "react";
import { Clock, AlertCircle, CheckCircle2, Search } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { Kanban } from "react-kanban-kit";
import type { BoardData, BoardProps } from "react-kanban-kit";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";

import { CaseContent } from "@/features/case/types";
import { CaseKanbanCard } from "@/features/case/components/case-kanban-card";
import { CaseAuditTrail } from "@/features/case/components/case-audit-trail";

type ConfigMap = BoardProps["configMap"] & {
  [key: string]: {
    render: (props: any) => React.ReactNode;
    isDraggable?: boolean;
  };
};

const initialData: BoardData = {
  root: { id: "root", title: "Root", parentId: null, children: ["pending", "dispatch", "inprogress", "resolved"], totalChildrenCount: 4 },
  pending: { id: "pending", title: "Pending", parentId: "root", children: ["case-2001"], totalChildrenCount: 1, type: "default" },
  dispatch: { id: "dispatch", title: "Dispatched", parentId: "root", children: ["case-2002"], totalChildrenCount: 1, type: "default" },
  inprogress: { id: "inprogress", title: "In Progress", parentId: "root", children: ["case-2003"], totalChildrenCount: 1, type: "default" },
  resolved: { id: "resolved", title: "Resolved", parentId: "root", children: [], totalChildrenCount: 0, type: "default" },
  "case-2001": { id: "case-2001", title: "Case 2001", parentId: "pending", children: [], totalChildrenCount: 0, content: { address: "Blk 123 Ang Mo Kio Ave 4", description: "Water pipe bursting", priority: "high", sla: "1h 30m" } as CaseContent },
  "case-2002": { id: "case-2002", title: "Case 2002", parentId: "dispatch", children: [], totalChildrenCount: 0, content: { address: "Blk 456 Jurong West St 41", description: "Corridor light issue", priority: "medium", sla: "4h 15m" } as CaseContent },
  "case-2003": { id: "case-2003", title: "Case 2003", parentId: "inprogress", children: [], totalChildrenCount: 0, content: { address: "Blk 789 Bedok North", description: "Cracks on wall", priority: "low", sla: "22h" } as CaseContent },
};

const tableColumnHelper = createColumnHelper<any>();


export function ContractorDashboard() {
  const [dataSource, setDataSource] = useState<BoardData>(initialData);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [openAudit, setOpenAudit] = useState(false);

  const configMap: ConfigMap = {
    default: {
      render: (props) => (
        <CaseKanbanCard
          id={props.data.id}
          content={props.data.content}
          variant="contractor"
          onClick={() => {
            setSelectedCaseId(props.data.id);
            setOpenAudit(true);
          }}
        />
      ),
    },
  };

  const tableData = Object.values(dataSource)
    .filter((item) => item.id.startsWith("case-"))
    .map((item) => ({
      id: item.id,
      address: item.content?.address || "",
      description: item.content?.description || "",
      priority: item.content?.priority || "low",
      sla: item.content?.sla || "",
      status: dataSource[item.parentId as string]?.title || "Pending",
    }));

  const tableColumns = [
    tableColumnHelper.accessor("id", {
      header: "Case ID",
      cell: (info) => (
        <Button
          variant="link"
          className="p-0 h-auto font-mono text-primary font-bold"
          onClick={() => {
            setSelectedCaseId(info.getValue());
            setOpenAudit(true);
          }}
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
        const priority = info.getValue() as string;
        let variant: "destructive" | "secondary" | "outline" | "default" = "secondary";
        let className = "uppercase text-[10px]";
        if (priority === "high" || priority === "emergency") variant = "destructive";
        else if (priority === "medium") className += " bg-amber-500 hover:bg-amber-600 text-white border-transparent";
        else variant = "outline";
        return <Badge variant={variant} className={className}>{priority}</Badge>;
      },
    }),
    tableColumnHelper.accessor("sla", {
      header: "SLA Time Left",
      cell: (info) => (
        <span className="flex items-center gap-1 text-muted-foreground">
          <Clock className="h-4 w-4" />
          {info.getValue()}
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
          onClick={() => {
            setSelectedCaseId(info.row.original.id);
            setOpenAudit(true);
          }}
        >
          Audit
        </Button>
      ),
    }),
  ];

  const table = useReactTable({
    data: tableData,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
  });

  const onCardMove = ({ cardId, fromColumnId, toColumnId, position }: any) => {
    setDataSource((prev) => {
      const next = { ...prev };
      if (!next[fromColumnId] || !next[toColumnId]) return prev;
      next[fromColumnId] = {
        ...next[fromColumnId],
        children: next[fromColumnId].children.filter((id) => id !== cardId),
      };
      const newChildren = [...next[toColumnId].children];
      newChildren.splice(position, 0, cardId);
      next[toColumnId] = { ...next[toColumnId], children: newChildren };
      if (next[cardId]) next[cardId] = { ...next[cardId], parentId: toColumnId };
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-6 h-full relative">
      <Sheet open={openAudit} onOpenChange={setOpenAudit}>
        <SheetContent className="w-[450px] sm:w-[500px] border-l border-border bg-popover p-6 shadow-2xl">
          <SheetHeader className="mb-0">
            <SheetTitle className="text-xl uppercase tracking-widest font-bold font-label border-b-2 border-primary pb-2 w-fit">Audit Trail</SheetTitle>
          </SheetHeader>
          <div className="mt-8 h-full">
            {selectedCaseId && <CaseAuditTrail caseId={selectedCaseId} />}
          </div>
        </SheetContent>
      </Sheet>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground uppercase border-b-2 border-primary inline-block pb-1">Contractor Operations Pipeline</h1>
          <p className="text-muted-foreground text-sm mt-2">Organize and execute dispatched repairs jobs.</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 gap-1 flex items-center rounded-none uppercase text-[10px]">
            <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" /> LiveSync Active
          </Badge>
          <Button variant="outline" className="rounded-none border-border text-muted-foreground uppercase text-xs">Filters</Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {["Backlog", "Dispatched", "In Progress", "Closed Today"].map((title, i) => (
          <Card key={title} className="bg-surface-container border border-border rounded-none">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-[10px] font-label uppercase tracking-widest text-muted-foreground">{title}</CardTitle>
              {i === 0 ? <AlertCircle className="h-4 w-4 text-muted-foreground" /> : i === 1 ? <Clock className="h-4 w-4 text-blue-500" /> : i === 2 ? <div className="h-2 w-2 rounded-full bg-amber-500" /> : <CheckCircle2 className="h-4 w-4 text-green-500" />}
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-foreground font-sans">{i === 3 ? 0 : 1}</div>
              <p className="text-[10px] text-muted-foreground mt-1 uppercase">{i === 0 ? "Awaiting actions" : i === 1 ? "Allocated mechanics" : i === 2 ? "Active resolution" : "+0 resolved"}</p>
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
            <Input placeholder="Search cases..." className="bg-surface-container rounded-none border-border h-10 focus-visible:ring-primary" />
          </div>
        </div>

        <TabsContent value="kanban" className="flex-1 overflow-x-auto min-h-0 m-0">
          <Kanban
            dataSource={dataSource}
            configMap={configMap}
            onCardMove={onCardMove}
            rootClassName="h-full flex gap-4 overflow-x-auto pb-4 items-start"
            columnClassName={() => "flex flex-col bg-surface-container-low/50 border-r border-border min-w-[300px] h-full"}
            columnHeaderClassName={() => "flex items-center justify-between font-label uppercase tracking-widest text-sm p-4 border-b-2 border-primary bg-surface-container mb-4"}
            columnListContentClassName={() => "flex flex-col gap-3 flex-1 px-3"}
            renderColumnHeader={(col) => (
              <>
                <span>{col.title}</span>
                <Badge variant="secondary" className="rounded-none bg-muted text-foreground border-border h-5 px-1.5 text-[10px]">{col.children.length}</Badge>
              </>
            )}
          />
        </TabsContent>

        <TabsContent value="table" className="flex-1 overflow-auto m-0">
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
                {table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id} className="border-b border-border/50 hover:bg-muted transition-colors">
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className="py-4">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
