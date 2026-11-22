import { useAuthConfig } from "../api";

export default function Login() {
  const cfg = useAuthConfig();
  if (!cfg.data) return null;
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-line bg-panel p-6 text-center">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-xl bg-brand text-xl font-semibold text-brand-ink">M</div>
        <h1 className="text-lg font-semibold">{cfg.data.app_name}</h1>
        <p className="mt-1 text-sm text-mute">Deploy and manage your VMs and GPU time.</p>
        {cfg.data.mode === "oidc" ? (
          <a href="/auth/login" className="mt-6 block rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-ink hover:opacity-90">
            Sign in with Authentik
          </a>
        ) : (
          <div className="mt-6 space-y-2 text-left">
            <p className="rounded-md bg-warn-soft px-3 py-2 text-xs text-warn">Development sign-in. Set auth.mode to oidc before exposing this.</p>
            {cfg.data.dev_users.map((u) => (
              <a key={u.username} href={`/auth/dev-login?username=${encodeURIComponent(u.username)}`}
                className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-sm hover:bg-sunken">
                <span className="font-medium">{u.name}</span>
                <span className="text-xs text-mute">{u.groups.join(", ")}</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
