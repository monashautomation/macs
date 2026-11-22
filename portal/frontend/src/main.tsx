import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, NavLink, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { ApiError, pendingCount, useApprovals, useAuthConfig, useClusters, useMe } from "./api";
import "./index.css";
import { Activity, AuditLog } from "./infra/Activity";
import Approvals from "./infra/Approvals";
import ImagesAdmin from "./infra/ImagesAdmin";
import Machines from "./infra/Machines";
import Network from "./infra/Network";
import OverviewPage from "./infra/Overview";
import People from "./infra/People";
import Gpus from "./pages/Gpus";
import Images from "./pages/Images";
import Login from "./pages/Login";
import NewVM from "./pages/NewVM";
import Services from "./pages/Services";
import VMDetail from "./pages/VMDetail";
import VMs from "./pages/VMs";
import { cx } from "./ui";

// noVNC is large and only needed on the console page.
const Console = lazy(() => import("./pages/Console"));

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: true, retry: 1 } } });

function Logo({ name }: { name: string }) {
  return (
    <span className="flex items-center gap-2 font-semibold">
      <span className="grid h-7 w-7 place-items-center rounded-md bg-brand text-sm text-brand-ink">M</span>
      {name}
    </span>
  );
}

function Account({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-mute">{name}</span>
      <a href="/auth/logout" className="text-mute underline-offset-2 hover:text-ink hover:underline">Sign out</a>
    </div>
  );
}

/** What everyone sees: their own VMs, the image library, GPU time, services. */
function UserShell() {
  const me = useMe().data!;
  const cfg = useAuthConfig();
  const clusters = useClusters();
  const approvals = useApprovals(me.is_admin);
  const link = ({ isActive }: { isActive: boolean }) =>
    cx("rounded-md px-3 py-1.5 text-sm font-medium", isActive ? "bg-brand-soft text-brand" : "text-mute hover:text-ink");
  const pending = pendingCount(approvals.data);
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-line bg-panel">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
          <Logo name={cfg.data?.app_name ?? "MACS"} />
          <nav className="flex flex-wrap gap-1">
            <NavLink to="/" end className={link}>My VMs</NavLink>
            <NavLink to="/images" className={link}>Images</NavLink>
            {clusters.data?.some((c) => c.has_gpus) && <NavLink to="/gpus" className={link}>GPUs</NavLink>}
            {clusters.data?.some((c) => c.network.services) && <NavLink to="/services" className={link}>Services</NavLink>}
          </nav>
          <div className="ml-auto flex flex-wrap items-center gap-4">
            {me.is_admin && (
              <Link to="/infra" className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-sm font-medium hover:bg-sunken">
                Infrastructure
                {pending > 0 && <span className="rounded-full bg-warn px-1.5 text-xs text-panel">{pending}</span>}
                <span aria-hidden>→</span>
              </Link>
            )}
            <Account name={me.name} />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6"><Outlet /></main>
    </div>
  );
}

const infraNav: [string, string][] = [
  ["", "Overview"], ["approvals", "Approvals"], ["machines", "Virtual machines"], ["gpus", "GPUs"],
  ["images", "Image library"], ["network", "Network & services"], ["people", "People"],
  ["activity", "Activity"], ["audit", "Audit log"],
];

/** The systems & infrastructure team's side: everything, across all users. */
function InfraShell() {
  const me = useMe().data!;
  const approvals = useApprovals(me.is_admin);
  const pending = pendingCount(approvals.data);
  if (!me.is_admin) return <Navigate to="/" />;
  return (
    <div className="min-h-screen md:flex">
      <aside className="shrink-0 border-b border-line bg-ink text-bg md:sticky md:top-0 md:h-screen md:w-56 md:border-b-0">
        <div className="px-4 pt-4 pb-2">
          <p className="text-[11px] font-semibold tracking-widest text-bg/50 uppercase">Systems &amp; infrastructure</p>
          <p className="mt-0.5 font-semibold">MACS console</p>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:block md:space-y-0.5 md:overflow-visible">
          {infraNav.map(([to, label]) => (
            <NavLink key={to} to={to ? `/infra/${to}` : "/infra"} end={to === ""}
              className={({ isActive }) => cx("flex items-center justify-between gap-2 rounded-md px-3 py-1.5 text-sm whitespace-nowrap", isActive ? "bg-bg/15 font-medium text-bg" : "text-bg/65 hover:bg-bg/10 hover:text-bg")}>
              {label}
              {to === "approvals" && pending > 0 && <span className="rounded-full bg-warn px-1.5 text-xs font-medium text-panel">{pending}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="hidden px-4 py-3 md:absolute md:inset-x-0 md:bottom-0 md:block">
          <Link to="/" className="text-sm text-bg/65 hover:text-bg">← My workspace</Link>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex items-center justify-between gap-4 border-b border-line bg-panel px-4 py-2.5 md:px-6">
          <Link to="/" className="text-sm text-mute hover:text-ink md:invisible">← My workspace</Link>
          <Account name={me.name} />
        </header>
        <main className="max-w-6xl px-4 py-6 md:px-6"><Outlet /></main>
      </div>
    </div>
  );
}

function App() {
  const me = useMe();
  if (me.isLoading) return null;
  if (me.error instanceof ApiError && me.error.status === 401) return <Login />;
  if (!me.data) return <p className="p-8 text-sm text-bad">Cannot reach the portal API. Try reloading.</p>;
  return (
    <Routes>
      <Route element={<UserShell />}>
        <Route path="/" element={<VMs />} />
        <Route path="/new" element={<NewVM />} />
        <Route path="/images" element={<Images />} />
        <Route path="/vms/:id" element={<VMDetail />} />
        <Route path="/gpus" element={<Gpus />} />
        <Route path="/services" element={<Services />} />
      </Route>
      <Route path="/vms/:id/console" element={<Suspense fallback={null}><Console /></Suspense>} />
      <Route path="/infra" element={<InfraShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="approvals" element={<Approvals />} />
        <Route path="machines" element={<Machines />} />
        <Route path="gpus" element={<Gpus admin />} />
        <Route path="images" element={<ImagesAdmin />} />
        <Route path="network" element={<Network />} />
        <Route path="people" element={<People />} />
        <Route path="activity" element={<Activity />} />
        <Route path="audit" element={<AuditLog />} />
      </Route>
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
