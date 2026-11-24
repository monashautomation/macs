import { cn } from "@monashautomation/ui/utils";
import { AppWindow, Box, Disc3 } from "lucide-react";
import {
  siAlmalinux,
  siArchlinux,
  siDebian,
  siFedora,
  siFreebsd,
  siLinux,
  siNixos,
  siOpensuse,
  siRockylinux,
  siUbuntu,
} from "simple-icons";

const MARKS: [RegExp, { path: string; title: string }][] = [
  [/ubuntu|golden-jam/i, siUbuntu],
  [/debian/i, siDebian],
  [/nix/i, siNixos],
  [/fedora/i, siFedora],
  [/arch/i, siArchlinux],
  [/rocky/i, siRockylinux],
  [/alma/i, siAlmalinux],
  [/suse/i, siOpensuse],
  [/bsd/i, siFreebsd],
];

/**
 * The operating system's mark for an image, so people can find theirs by
 * sight. Drawn in the current text colour (no vendor colours: the palette is
 * the brand's). Falls back to a generic icon for anything it doesn't know.
 */
export function OsIcon({
  image,
  className,
}: {
  image: { name: string; id?: string; os: string; kind?: string } | null | undefined;
  className?: string;
}) {
  const cls = cn("size-5 shrink-0 text-muted-foreground", className);
  if (!image) return <Box className={cls} aria-hidden />;
  if (image.os === "windows") return <AppWindow className={cls} aria-hidden />;
  const mark =
    MARKS.find(([re]) => re.test(`${image.name} ${image.id ?? ""}`))?.[1] ??
    (image.os === "linux" ? siLinux : null);
  if (!mark)
    return image.kind === "iso" ? <Disc3 className={cls} aria-hidden /> : <Box className={cls} aria-hidden />;
  return (
    <svg viewBox="0 0 24 24" className={cls} fill="currentColor" aria-hidden>
      <title>{mark.title}</title>
      <path d={mark.path} />
    </svg>
  );
}
