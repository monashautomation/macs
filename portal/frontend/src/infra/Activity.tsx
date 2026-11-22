import { useQuery } from "@tanstack/react-query";
import { type Job, type UserRef, api } from "../api";
import { JobRow } from "../pages/VMDetail";
import { Card, Empty, fmtDateTime } from "../ui";

export function Activity() {
  const q = useQuery({ queryKey: ["jobs", "all"], queryFn: () => api<Job[]>("/api/jobs?scope=all&limit=100"), refetchInterval: 5000 });
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Activity</h1>
      <Card>{q.data?.length ? <ul>{q.data.map((j) => <JobRow key={`${j.id}-${j.status}`} job={j} />)}</ul> : <Empty>No activity yet.</Empty>}</Card>
    </div>
  );
}

interface AuditRow { id: number; at: string; user: UserRef | null; action: string; target: string; detail: string }

export function AuditLog() {
  const q = useQuery({ queryKey: ["audit"], queryFn: () => api<AuditRow[]>("/api/admin/audit"), refetchInterval: 15_000 });
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Audit log</h1>
      <Card>
        <div className="-mx-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <tbody>
              {q.data?.map((a) => (
                <tr key={a.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2 text-xs whitespace-nowrap text-mute">{fmtDateTime(a.at)}</td>
                  <td className="px-4 py-2">{a.user?.username ?? "system"}</td>
                  <td className="px-4 py-2 font-medium">{a.action}</td>
                  <td className="px-4 py-2 text-mute">{a.target}</td>
                  <td className="px-4 py-2 text-xs text-mute">{a.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
