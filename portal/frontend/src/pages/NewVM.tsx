import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type VM, api, useAct, useClusters, useMe } from "../api";
import { Badge, Button, Card, ErrorNote, Field, cx, inputCls } from "../ui";

const pick = (options: number[], max: number) => options.filter((o) => o <= max);

export default function NewVM() {
  const clusters = useClusters();
  const me = useMe();
  const nav = useNavigate();
  const [clusterId, setClusterId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [name, setName] = useState("");
  const [cores, setCores] = useState(2);
  const [memory, setMemory] = useState(4096);
  const [disk, setDisk] = useState(40);
  const [sshKey, setSshKey] = useState("");
  const [wantsGpu, setWantsGpu] = useState(false);
  const [why, setWhy] = useState("");

  const cluster = clusters.data?.find((c) => c.id === clusterId) ?? clusters.data?.[0];
  const template = cluster?.templates.find((t) => t.id === templateId) ?? cluster?.templates[0];

  useEffect(() => {
    if (me.data?.ssh_public_key && !sshKey) setSshKey(me.data.ssh_public_key);
  }, [me.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!cluster) return;
    setCores((v) => Math.min(v, cluster.limits.max_cores));
    setMemory((v) => Math.min(v, cluster.limits.max_memory_mb));
    setDisk((v) => Math.min(v, cluster.limits.max_disk_gb));
  }, [cluster?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = useAct(() =>
    api<VM>("/api/vms", {
      method: "POST",
      body: {
        cluster_id: cluster!.id, template_id: template!.id, name, cores, memory_mb: memory, disk_gb: disk,
        ssh_public_key: template!.os === "linux" ? sshKey : "", wants_gpu: wantsGpu && gpuPossible, justification: why,
      },
    }).then((vm) => nav(`/vms/${vm.id}`)),
  );

  if (!clusters.data) return null;
  if (!cluster) return <p className="text-sm text-mute">You do not have access to any cluster yet.</p>;
  const needsApproval = cluster.approval === "required";
  const gpuPossible = cluster.has_gpus && !!template?.gpu_capable;

  return (
    <form className="mx-auto max-w-2xl space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
      <h1 className="text-xl font-semibold">New VM</h1>

      <Card title="Where">
        <div className="grid gap-3 sm:grid-cols-2">
          {clusters.data.map((c) => (
            <button type="button" key={c.id} onClick={() => { setClusterId(c.id); setTemplateId(""); }}
              className={cx("rounded-lg border p-3 text-left", c.id === cluster.id ? "border-brand bg-brand-soft" : "border-line hover:bg-sunken")}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{c.name}</span>
                {c.has_gpus && <Badge tone="gpu">GPU</Badge>}
              </div>
              <p className="mt-1 text-xs text-mute">{c.approval === "none" ? "Ready in a minute or two, no approval needed." : "An admin reviews each request."}</p>
            </button>
          ))}
        </div>
      </Card>

      <Card title="What">
        <div className="space-y-4">
          <Field label="Name" hint="Becomes the hostname. Lowercase letters, digits and dashes.">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="my-vm" required pattern="[a-z]([a-z0-9\-]{0,38}[a-z0-9])?" />
          </Field>
          <Field label="Image" hint={template?.description}>
            <select className={inputCls} value={template?.id ?? ""} onChange={(e) => setTemplateId(e.target.value)}>
              {cluster.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="vCPUs">
              <select className={inputCls} value={cores} onChange={(e) => setCores(+e.target.value)}>
                {pick([1, 2, 4, 8, 12, 16, 24, 32], cluster.limits.max_cores).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </Field>
            <Field label="Memory">
              <select className={inputCls} value={memory} onChange={(e) => setMemory(+e.target.value)}>
                {pick([1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072], cluster.limits.max_memory_mb).map((n) => <option key={n} value={n}>{n / 1024} GB</option>)}
              </select>
            </Field>
            <Field label="Disk">
              <select className={inputCls} value={disk} onChange={(e) => setDisk(+e.target.value)}>
                {pick([20, 40, 80, 100, 160, 250, 500], cluster.limits.max_disk_gb).map((n) => <option key={n} value={n}>{n} GB</option>)}
              </select>
            </Field>
          </div>
          {template?.os === "linux" && (
            <Field label="SSH public key" hint={<>You will sign in as <code>{template.default_user}</code> with this key. Remembered for next time.</>}>
              <textarea className={cx(inputCls, "font-mono text-xs")} rows={3} value={sshKey} onChange={(e) => setSshKey(e.target.value)} placeholder="ssh-ed25519 AAAA… you@laptop" required />
            </Field>
          )}
        </div>
      </Card>

      {(needsApproval || gpuPossible) && (
        <Card title={needsApproval ? "Approval" : "GPU"}>
          <div className="space-y-4">
            {gpuPossible && (
              <label className="flex items-start gap-3">
                <input type="checkbox" className="mt-1" checked={wantsGpu} onChange={(e) => setWantsGpu(e.target.checked)} />
                <span>
                  <span className="text-sm font-medium">Request GPU access</span>
                  <span className="block text-xs text-mute">Once approved you can book GPU time for this VM. The GPU is attached only during your bookings.</span>
                </span>
              </label>
            )}
            {(needsApproval || wantsGpu) && (
              <Field label="What is it for?" hint="Shown to the admins who approve the request.">
                <textarea className={inputCls} rows={3} value={why} onChange={(e) => setWhy(e.target.value)} required={needsApproval} />
              </Field>
            )}
          </div>
        </Card>
      )}

      <ErrorNote error={create.error} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => nav("/")}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={create.isPending}>
          {create.isPending ? "Submitting…" : needsApproval ? "Request VM" : "Create VM"}
        </Button>
      </div>
    </form>
  );
}
