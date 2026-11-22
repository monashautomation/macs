"use client";

import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type AuditRow, api, type Job, type Person } from "@/lib/client";
import { fmtDateTime, fmtGB, JobRow, Muted, Panel } from "../common";

export function InfraPeople() {
  const q = useQuery({ queryKey: ["people"], queryFn: () => api<Person[]>("/admin/people") });
  return (
    <>
      <PageHeader
        title="People"
        description="Everyone who has signed in. Access comes from their Authentik groups, refreshed at each sign-in."
      />
      <Panel>
        {q.data?.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Person</TableHead>
                <TableHead>Groups</TableHead>
                <TableHead>VMs</TableHead>
                <TableHead>Allocated</TableHead>
                <TableHead>Last sign-in</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <span className="font-semibold">{p.name}</span>{" "}
                    <span className="text-muted-foreground">{p.email}</span>{" "}
                    {p.isAdmin ? <StatusBadge tone="info">infrastructure</StatusBadge> : null}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {p.groups.join(", ") || "—"}
                  </TableCell>
                  <TableCell className="tabular-nums">{p.vms}</TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">
                    {p.vms ? `${p.cores} vCPU · ${fmtGB(p.memoryMb)}` : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {p.lastSignInAt ? fmtDateTime(p.lastSignInAt) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Muted>Nobody yet.</Muted>
        )}
      </Panel>
    </>
  );
}

export function InfraActivity() {
  const q = useQuery({
    queryKey: ["jobs", "all"],
    queryFn: () => api<Job[]>("/jobs?scope=all&limit=100"),
    refetchInterval: 5000,
  });
  return (
    <>
      <PageHeader
        title="Activity"
        description="Operations the portal has run on the clusters, newest first."
      />
      <Panel>
        {q.data?.length ? (
          <ul>
            {q.data.map((j) => (
              <JobRow key={`${j.id}-${j.status}`} job={j} />
            ))}
          </ul>
        ) : (
          <Muted>No activity yet.</Muted>
        )}
      </Panel>
    </>
  );
}

export function InfraAudit() {
  const q = useQuery({
    queryKey: ["audit"],
    queryFn: () => api<AuditRow[]>("/admin/audit"),
    refetchInterval: 15_000,
  });
  return (
    <>
      <PageHeader title="Audit log" description="Who did what." />
      <Panel>
        <Table>
          <TableBody>
            {q.data?.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                  {fmtDateTime(a.at)}
                </TableCell>
                <TableCell>{a.user?.name ?? "system"}</TableCell>
                <TableCell className="font-semibold">{a.action}</TableCell>
                <TableCell className="text-muted-foreground">{a.target}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{a.detail}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
    </>
  );
}
