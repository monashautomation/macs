import { cn } from "@/lib/utils";

export type Program = "robotics" | "manufacturing" | "sustainability" | "medtech";

const programs: Record<Program, { label: string; className: string }> = {
  // Contrast: Onyx text on the light program colours, light text on Manufacturing purple.
  robotics: { label: "Smart Systems & Robotics", className: "bg-program-robotics text-program-ink" },
  manufacturing: { label: "Manufacturing", className: "bg-program-manufacturing text-program-ink-inverse" },
  sustainability: { label: "Sustainability", className: "bg-program-sustainability text-program-ink" },
  medtech: { label: "Medtech", className: "bg-program-medtech text-program-ink" },
};

/** Program identity tag. Program colours are identity, never status. */
export function ProgramTag({ program, short = false }: { program: Program; short?: boolean }) {
  const p = programs[program];
  return (
    <span
      className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold", p.className)}
    >
      {short ? p.label.split(" ")[0] : p.label}
    </span>
  );
}
