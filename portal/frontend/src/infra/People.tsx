import { useQuery } from "@tanstack/react-query";
import { type UserRef, api } from "../api";
import { Badge, Card, Empty, fmtDateTime, fmtGB } from "../ui";

interface Person extends UserRef { email: string; groups: string[]; last_login_at: string | null; is_admin: boolean; vms: number; cores: number; memory_mb: number }

export default function People() {
  const q = useQuery({ queryKey: ["people"], queryFn: () => api<Person[]>("/api/admin/people") });
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">People</h1>
        <p className="mt-1 text-sm text-mute">Everyone who has signed in. Access comes from their Authentik groups, refreshed at each sign-in.</p>
      </div>
      <Card>
        {q.data?.length ? (
          <div className="-mx-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-mute">
                  <th className="px-4 py-2 font-medium">Person</th><th className="px-4 py-2 font-medium">Groups</th>
                  <th className="px-4 py-2 font-medium">VMs</th><th className="px-4 py-2 font-medium">Allocated</th><th className="px-4 py-2 font-medium">Last sign-in</th>
                </tr>
              </thead>
              <tbody>
                {q.data.map((p) => (
                  <tr key={p.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2.5"><span className="font-medium">{p.name}</span> <span className="text-mute">{p.username}</span> {p.is_admin && <Badge tone="brand">infrastructure</Badge>}</td>
                    <td className="px-4 py-2.5 text-xs text-mute">{p.groups.join(", ") || "—"}</td>
                    <td className="px-4 py-2.5 tabular-nums">{p.vms}</td>
                    <td className="px-4 py-2.5 text-mute tabular-nums">{p.vms ? `${p.cores} vCPU · ${fmtGB(p.memory_mb)}` : "—"}</td>
                    <td className="px-4 py-2.5 text-xs text-mute">{p.last_login_at ? fmtDateTime(p.last_login_at) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>Nobody yet.</Empty>}
      </Card>
    </div>
  );
}
