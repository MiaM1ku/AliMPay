import { LoaderCircle } from "lucide-react";

export function Loading({ label = "正在加载" }: { label?: string }) {
  return (
    <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted" role="status">
      <LoaderCircle className="size-4 animate-spin" />
      <span>{label}</span>
    </div>
  );
}
