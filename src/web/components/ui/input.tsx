import * as React from "react";
import { cn } from "@/web/lib/utils";

export function Input({ className, type, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type={type}
      className={cn(
        "flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-none transition-colors placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
