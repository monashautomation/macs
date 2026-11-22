import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Navigate, Route, Routes } from "react-router-dom";
import { ApiError, useApprovals, useAuthConfig, useMe } from "./api";
import "./index.css";
import Admin from "./pages/Admin";
import Gpus from "./pages/Gpus";
import Login from "./pages/Login";
import NewVM from "./pages/NewVM";
import VMDetail from "./pages/VMDetail";
import VMs from "./pages/VMs";
import { cx } from "./ui";

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: true, retry: 1 } } });

function Shell() {
  const me = useMe();
  const cfg = useAuthConfig();
  const approvals = useApprovals(!!me.data?.is_admin);
  if (me.isLoading) return null;
  if (me.error instanceof ApiError && me.error.status === 401) return <Login />;
  if (!me.data) return <p className="p-8 text-sm text-bad">Cannot reach the portal API. Try reloading.</p>;

  const link = ({ isActive }: { isActive: boolean }) =>
    cx("rounded-md px-3 py-1.5 text-sm font-medium", isActive ? "bg-brand-soft text-brand" : "text-mute hover:text-ink");
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-line bg-panel">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
          <span className="flex items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-brand text-sm text-brand-ink">M</span>
            {cfg.data?.app_name ?? "MACS"}
          </span>
          <nav className="flex gap-1">
            <NavLink to="/" end className={link}>My VMs</NavLink>
            <NavLink to="/gpus" className={link}>GPUs</NavLink>
            {me.data.is_admin && (
              <NavLink to="/admin" className={link}>
                Admin
                {!!approvals.data?.length && <span className="ml-1.5 rounded-full bg-warn px-1.5 text-xs text-panel">{approvals.data.length}</span>}
              </NavLink>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-mute">{me.data.name}</span>
            <a href="/auth/logout" className="text-mute underline-offset-2 hover:text-ink hover:underline">Sign out</a>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Routes>
          <Route path="/" element={<VMs />} />
          <Route path="/new" element={<NewVM />} />
          <Route path="/vms/:id" element={<VMDetail />} />
          <Route path="/gpus" element={<Gpus />} />
          <Route path="/admin" element={me.data.is_admin ? <Admin /> : <Navigate to="/" />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
